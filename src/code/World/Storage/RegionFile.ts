const REGION_DIM = 16;
const SLOTS_PER_LAYER = REGION_DIM * REGION_DIM * REGION_DIM; // 4096
const SLOT_ENTRIES = SLOTS_PER_LAYER * 2; // 8192 (voxels + entities)
const HEADER_SIZE = 4096;
const SLOT_SIZE = 8; // dataOffset(u32) + size(u32)
const SLOTS_BYTES = SLOT_ENTRIES * SLOT_SIZE; // 65536
const DATA_START = HEADER_SIZE + SLOTS_BYTES; // 69632

const _rfAtOpts = { at: 0 };
const _rfReadSlab = new Uint8Array(64 * 1024);

const MAGIC = 0x5245474e; // "REGN"
const VERSION = 2;

const H_MAGIC = 0;
const H_VERSION = 4;
const H_REGION_X = 8;
const H_REGION_Y = 12;
const H_REGION_Z = 16;
const H_USED_BYTES = 20;
const H_OCCUPIED = 24;
const H_FREE_LIST_HEAD = 28;

const FREE_LIST_NONE = 0xffffffff;
const HEADROOM_MIN = 1024 * 1024;

// Compaction threshold: compact on open when orphaned bytes exceed this fraction.
// 0.5 means compact when live data is less than half of usedBytes.
const COMPACT_RATIO_THRESHOLD = 0.5;
// Minimum orphaned bytes before bothering to compact (avoid work on tiny files).
const COMPACT_MIN_ORPHANED_BYTES = 256 * 1024; // 256 KB

// Pre-allocated typed arrays for _compact — reused across all compaction calls.
const _compactIdx = new Int32Array(SLOT_ENTRIES);
const _compactOff = new Uint32Array(SLOT_ENTRIES);
const _compactSize = new Uint32Array(SLOT_ENTRIES);

// PERF: inline slot index — branchless for both voxel and entity layers.
function slotIndex(
	lx: number,
	ly: number,
	lz: number,
	isEntity: boolean,
): number {
	return lx * 256 + lz * 16 + ly + (isEntity ? SLOTS_PER_LAYER : 0);
}

export class RegionFile {
	private accessHandle: FileSystemSyncAccessHandle;
	private headerU8: Uint8Array;
	private headerDv: DataView;
	private slotDv: DataView;
	private readonly _slotTableU8: Uint8Array;
	private usedBytes: number;
	private occupiedCount: number;
	private freeListHead: number;
	private fileSize: number;
	private headerDirty = false;

	// MEMORY: Uint8Array bitfield instead of Set<number> — 1 KB vs O(n) boxed ints.
	private readonly _dirtyBits = new Uint8Array(Math.ceil(SLOT_ENTRIES / 8));

	private constructor(
		accessHandle: FileSystemSyncAccessHandle,
		headerU8: Uint8Array,
		headerDv: DataView,
		slotDv: DataView,
		slotTableU8: Uint8Array,
		usedBytes: number,
		occupiedCount: number,
		freeListHead: number,
		fileSize: number,
	) {
		this.accessHandle = accessHandle;
		this.headerU8 = headerU8;
		this.headerDv = headerDv;
		this.slotDv = slotDv;
		this._slotTableU8 = slotTableU8;
		this.usedBytes = usedBytes;
		this.occupiedCount = occupiedCount;
		this.freeListHead = freeListHead;
		this.fileSize = fileSize;
	}

	static async open(
		accessHandle: FileSystemSyncAccessHandle,
		regionX: number,
		regionY: number,
		regionZ: number,
	): Promise<RegionFile> {
		let fileSize = accessHandle.getSize() as number;
		const isNew = fileSize === 0;

		const headerBuf = new ArrayBuffer(HEADER_SIZE);
		const headerU8 = new Uint8Array(headerBuf);
		const headerDv = new DataView(headerBuf);
		const slotTable = new ArrayBuffer(SLOTS_BYTES);
		const slotDv = new DataView(slotTable);
		const slotTableU8 = new Uint8Array(slotTable);

		let usedBytes = 0;
		let occupiedCount = 0;
		let freeListHead = FREE_LIST_NONE;

		if (isNew) {
			headerDv.setUint32(H_MAGIC, MAGIC, true);
			headerDv.setUint32(H_VERSION, VERSION, true);
			headerDv.setInt32(H_REGION_X, regionX, true);
			headerDv.setInt32(H_REGION_Y, regionY, true);
			headerDv.setInt32(H_REGION_Z, regionZ, true);
			headerDv.setUint32(H_USED_BYTES, 0, true);
			headerDv.setUint32(H_OCCUPIED, 0, true);
			headerDv.setUint32(H_FREE_LIST_HEAD, FREE_LIST_NONE, true);

			_rfAtOpts.at = 0;
			accessHandle.write(headerU8, _rfAtOpts);
			_rfAtOpts.at = HEADER_SIZE;
			accessHandle.write(slotTableU8, _rfAtOpts);
			accessHandle.truncate(DATA_START);
			accessHandle.flush();
			fileSize = DATA_START;
		} else {
			_rfAtOpts.at = 0;
			accessHandle.read(headerU8, _rfAtOpts);

			const magic = headerDv.getUint32(H_MAGIC, true);
			if (magic !== MAGIC) {
				throw new Error(
					`[RegionFile] Bad magic 0x${magic.toString(16)}, expected 0x${MAGIC.toString(16)}`,
				);
			}
			const version = headerDv.getUint32(H_VERSION, true);
			if (version !== VERSION) {
				throw new Error(
					`[RegionFile] Unsupported version ${version}, expected ${VERSION}`,
				);
			}

			_rfAtOpts.at = HEADER_SIZE;
			accessHandle.read(slotTableU8, _rfAtOpts);

			// FIX: free list is unused in the fixed-index design — always reset.
			freeListHead = FREE_LIST_NONE;
			headerDv.setUint32(H_FREE_LIST_HEAD, FREE_LIST_NONE, true);

			// FIX: recompute usedBytes and occupiedCount from the slot table,
			// validating each slot's data range against the actual file size.
			// Clear any slots whose data extends beyond the file.
			let computedUsedBytes = 0;
			let liveBytes = 0;
			let computedOccupied = 0;
			let repairedSlots = false;
			for (let i = 0; i < SLOT_ENTRIES; i++) {
				const off = i * SLOT_SIZE;
				const dataOffset = slotDv.getUint32(off, true);
				const size = slotDv.getUint32(off + 4, true);
				if (size > 0) {
					const absoluteEnd = DATA_START + dataOffset + size;
					if (absoluteEnd <= fileSize) {
						computedOccupied++;
						liveBytes += size;
						if (dataOffset + size > computedUsedBytes) {
							computedUsedBytes = dataOffset + size;
						}
					} else {
						// Corrupted slot — clear it.
						slotDv.setUint32(off, 0, true);
						slotDv.setUint32(off + 4, 0, true);
						repairedSlots = true;
					}
				}
			}
			usedBytes = computedUsedBytes;
			occupiedCount = computedOccupied;
			headerDv.setUint32(H_USED_BYTES, usedBytes, true);
			headerDv.setUint32(H_OCCUPIED, occupiedCount, true);

			// Collapse into a single construction; mark dirty and compact if needed.
			const rf = new RegionFile(
				accessHandle,
				headerU8,
				headerDv,
				slotDv,
				slotTableU8,
				usedBytes,
				occupiedCount,
				freeListHead,
				fileSize,
			);
			rf.headerDirty = true;
			if (repairedSlots) rf.markAllSlotsDirty();

			// Compact if there is significant orphaned space from old append-only writes.
			const orphanedBytes = usedBytes - liveBytes;
			if (
				orphanedBytes >= COMPACT_MIN_ORPHANED_BYTES &&
				liveBytes < usedBytes * (1 - COMPACT_RATIO_THRESHOLD)
			) {
				RegionFile._compact(rf, accessHandle);
			}

			return rf;
		}

		return new RegionFile(
			accessHandle,
			headerU8,
			headerDv,
			slotDv,
			slotTableU8,
			usedBytes,
			occupiedCount,
			freeListHead,
			fileSize,
		);
	}

	// ── Slot helpers (inline, no function call overhead in hot path) ──

	private readSlotSize(idx: number): number {
		return this.slotDv.getUint32(idx * SLOT_SIZE + 4, true);
	}

	private readSlotOffset(idx: number): number {
		return this.slotDv.getUint32(idx * SLOT_SIZE, true);
	}

	private markDirty(idx: number): void {
		this._dirtyBits[idx >>> 3] |= 1 << (idx & 7);
	}

	private writeSlotInMemory(idx: number, offset: number, size: number): void {
		const off = idx * SLOT_SIZE;
		this.slotDv.setUint32(off, offset, true);
		this.slotDv.setUint32(off + 4, size, true);
		this.markDirty(idx);
	}

	private commitHeader(): void {
		this.headerDv.setUint32(H_USED_BYTES, this.usedBytes, true);
		this.headerDv.setUint32(H_OCCUPIED, this.occupiedCount, true);
		this.headerDv.setUint32(H_FREE_LIST_HEAD, this.freeListHead, true);
		this.headerDirty = true;
	}

	private markAllSlotsDirty(): void {
		this._dirtyBits.fill(0xff);
	}

	// ── Compaction ────────────────────────────────────────────────────────────
	//
	// Rewrites all live slot data contiguously from DATA_START, eliminating
	// orphaned bytes left by the append-only write strategy.  Called on open
	// when the orphaned fraction exceeds COMPACT_RATIO_THRESHOLD.
	//
	// Algorithm: collect live slots sorted by current disk offset, then slide
	// each slot's data down to the current write head using a small copy
	// window.  Update slot offsets in-memory; flush is deferred to the normal
	// flush() path (headerDirty + markAllSlotsDirty are set before returning).

	private static _compact(
		rf: RegionFile,
		accessHandle: FileSystemSyncAccessHandle,
	): void {
		// Parallel typed arrays — zero heap allocation vs LiveSlot[].
		const idxBuf = _compactIdx;
		const offBuf = _compactOff;
		const sizeBuf = _compactSize;
		let liveCount = 0;

		for (let i = 0; i < SLOT_ENTRIES; i++) {
			const size = rf.slotDv.getUint32(i * SLOT_SIZE + 4, true);
			if (size === 0) continue;
			idxBuf[liveCount] = i;
			offBuf[liveCount] = rf.slotDv.getUint32(i * SLOT_SIZE, true);
			sizeBuf[liveCount] = size;
			liveCount++;
		}

		// Insertion sort by offset — faster than Array.sort for small N,
		// avoids closure allocation.
		for (let i = 1; i < liveCount; i++) {
			const oi = offBuf[i];
			const si = sizeBuf[i];
			const ii = idxBuf[i];
			let j = i - 1;
			while (j >= 0 && offBuf[j] > oi) {
				offBuf[j + 1] = offBuf[j];
				sizeBuf[j + 1] = sizeBuf[j];
				idxBuf[j + 1] = idxBuf[j];
				j--;
			}
			offBuf[j + 1] = oi;
			sizeBuf[j + 1] = si;
			idxBuf[j + 1] = ii;
		}

		// 64 KB copy window — small enough to avoid GC pressure, large enough
		// to amortise per-read/write overhead.
		const copyBuf = new Uint8Array(64 * 1024);
		let writeHead = 0;

		for (let k = 0; k < liveCount; k++) {
			const slotOff = offBuf[k];
			const slotSize = sizeBuf[k];
			const slotIdx = idxBuf[k];

			if (slotOff === writeHead) {
				writeHead += slotSize;
				continue;
			}

			// Copy slot data down in chunks.
			let remaining = slotSize;
			let srcOff = slotOff;
			let dstOff = writeHead;
			while (remaining > 0) {
				const chunk = Math.min(remaining, copyBuf.length);
				_rfAtOpts.at = DATA_START + srcOff;
				accessHandle.read(copyBuf.subarray(0, chunk), _rfAtOpts);
				_rfAtOpts.at = DATA_START + dstOff;
				accessHandle.write(copyBuf.subarray(0, chunk), _rfAtOpts);
				srcOff += chunk;
				dstOff += chunk;
				remaining -= chunk;
			}

			// Update the in-memory slot offset.
			rf.slotDv.setUint32(slotIdx * SLOT_SIZE, writeHead, true);
			writeHead += slotSize;
		}

		// Truncate the file to remove the now-orphaned tail.
		const newDataEnd = DATA_START + writeHead;
		if (newDataEnd < rf.fileSize) {
			accessHandle.truncate(newDataEnd);
			rf.fileSize = newDataEnd;
		}

		rf.usedBytes = writeHead;
		rf.headerDv.setUint32(H_USED_BYTES, writeHead, true);
		rf.markAllSlotsDirty();
		rf.headerDirty = true;
	}

	readChunk(
		lx: number,
		ly: number,
		lz: number,
		isEntity: boolean,
	): Uint8Array | null {
		const idx = slotIndex(lx, ly, lz, isEntity);
		const size = this.readSlotSize(idx);
		if (size === 0) return null;

		const dataOffset = this.readSlotOffset(idx);
		const readAt = DATA_START + dataOffset;
		if (readAt < DATA_START || readAt + size > this.fileSize) {
			return null;
		}

		const buf = new Uint8Array(size);
		_rfAtOpts.at = readAt;
		const got = this.accessHandle.read(buf, _rfAtOpts);

		return got === size ? buf : null;
	}

	/**
	 * Each chunk has a *fixed* slot index (slotIndex(lx, ly, lz, isEntity)).
	 *
	 * Write strategy (in priority order):
	 *   1. In-place reuse — if the new data fits within the old allocation,
	 *      overwrite it at the same offset.  This is the common case for
	 *      repeated edits to the same chunk and produces zero orphaned bytes.
	 *   2. Append — otherwise bump the usedBytes pointer and write at the end.
	 *      Orphaned bytes from the old allocation are reclaimed at the next
	 *      compaction (triggered on open when the orphaned fraction is large).
	 */
	writeChunk(
		lx: number,
		ly: number,
		lz: number,
		isEntity: boolean,
		data: Uint8Array,
	): void {
		const idx = slotIndex(lx, ly, lz, isEntity);
		const oldSize = this.readSlotSize(idx);
		const oldOffset = this.readSlotOffset(idx);
		const wasOccupied = oldSize > 0;

		if (data.length === 0) {
			this.removeChunk(lx, ly, lz, isEntity);
			return;
		}

		if (this.usedBytes + data.length > 0xffffffff) {
			throw new Error("[RegionFile] Region data exceeds 4GB u32 offset limit");
		}

		// Reuse the existing allocation if the new data fits — avoids orphaning.
		const canReuse = wasOccupied && data.length <= oldSize;
		const dataOffset = canReuse ? oldOffset : this.usedBytes;

		this.writeSlotInMemory(idx, dataOffset, data.length);
		if (!canReuse) this.usedBytes += data.length;
		if (!wasOccupied) this.occupiedCount++;
		this.commitHeader();

		// Only extend the file if the write would go past the current end.
		// For in-place rewrites this is almost always a no-op.
		const neededEnd =
			DATA_START + (canReuse ? oldOffset + oldSize : this.usedBytes);
		if (neededEnd > this.fileSize) {
			const headroom = Math.max(data.length, HEADROOM_MIN);
			const newSize = neededEnd + headroom;
			this.accessHandle.truncate(newSize);
			this.fileSize = newSize;
		}

		_rfAtOpts.at = DATA_START + dataOffset;
		this.accessHandle.write(data, _rfAtOpts);
	}

	removeChunk(lx: number, ly: number, lz: number, isEntity: boolean): void {
		const idx = slotIndex(lx, ly, lz, isEntity);
		const size = this.readSlotSize(idx);
		if (size === 0) return;

		// Mark the slot as free in memory (offset=0, size=0).
		// Do NOT subtract from usedBytes — it's an append-only bump pointer.
		this.writeSlotInMemory(idx, 0, 0);
		this.occupiedCount--;
		this.commitHeader();
	}

	/**
	 * PERF: batches contiguous dirty slot ranges into a single write() call
	 * instead of one write() per dirty slot.
	 */
	flush(): void {
		if (this.headerDirty) {
			_rfAtOpts.at = 0;
			this.accessHandle.write(this.headerU8, _rfAtOpts);
			this.headerDirty = false;
		}

		// Walk the dirty bitfield, collecting runs of contiguous dirty slots.
		let runStart = -1;
		const bits = this._dirtyBits;

		for (let i = 0; i <= SLOT_ENTRIES; i++) {
			const isDirty =
				i < SLOT_ENTRIES && (bits[i >>> 3] & (1 << (i & 7))) !== 0;

			if (isDirty && runStart === -1) {
				runStart = i;
			} else if (!isDirty && runStart !== -1) {
				// Flush the contiguous run [runStart, i) in one write.
				const byteOffset = runStart * SLOT_SIZE;
				const byteLen = (i - runStart) * SLOT_SIZE;
				_rfAtOpts.at = HEADER_SIZE + byteOffset;
				this.accessHandle.write(
					this._slotTableU8.subarray(byteOffset, byteOffset + byteLen),
					_rfAtOpts,
				);
				runStart = -1;
			}
		}

		bits.fill(0);
		this.accessHandle.flush();
	}

	close(): void {
		this.flush();
		if (typeof this.accessHandle.close === "function") {
			this.accessHandle.close();
		}
	}
}
