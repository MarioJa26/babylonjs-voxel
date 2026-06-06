const REGION_DIM = 16;
const SLOTS_PER_LAYER = REGION_DIM * REGION_DIM * REGION_DIM; // 4096
const SLOT_ENTRIES = SLOTS_PER_LAYER * 2; // 8192 (voxels + entities)
const HEADER_SIZE = 4096;
const SLOT_SIZE = 8; // dataOffset(u32) + size(u32)
const SLOTS_BYTES = SLOT_ENTRIES * SLOT_SIZE; // 65536
const DATA_START = HEADER_SIZE + SLOTS_BYTES; // 69632

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
	private headerBuf: ArrayBuffer;
	private headerU8: Uint8Array;
	private headerDv: DataView;
	private slotTable: ArrayBuffer;
	private slotDv: DataView;
	private regionX: number;
	private regionY: number;
	private regionZ: number;
	private usedBytes: number;
	private occupiedCount: number;
	private freeListHead: number;
	private fileSize: number;
	private headerDirty = false;

	// FIX: per-instance scratch (was module-level, causing flush() cross-instance clobber).
	private readonly _slotScratch = new Uint8Array(SLOT_SIZE);

	// MEMORY: Uint8Array bitfield instead of Set<number> — 1 KB vs O(n) boxed ints.
	private readonly _dirtyBits = new Uint8Array(Math.ceil(SLOT_ENTRIES / 8));

	private constructor(
		accessHandle: FileSystemSyncAccessHandle,
		headerBuf: ArrayBuffer,
		headerU8: Uint8Array,
		headerDv: DataView,
		slotTable: ArrayBuffer,
		slotDv: DataView,
		regionX: number,
		regionY: number,
		regionZ: number,
		usedBytes: number,
		occupiedCount: number,
		freeListHead: number,
		fileSize: number,
	) {
		this.accessHandle = accessHandle;
		this.headerBuf = headerBuf;
		this.headerU8 = headerU8;
		this.headerDv = headerDv;
		this.slotTable = slotTable;
		this.slotDv = slotDv;
		this.regionX = regionX;
		this.regionY = regionY;
		this.regionZ = regionZ;
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
		let fileSize = (accessHandle as any).getSize() as number;
		const isNew = fileSize === 0;

		const headerBuf = new ArrayBuffer(HEADER_SIZE);
		const headerU8 = new Uint8Array(headerBuf);
		const headerDv = new DataView(headerBuf);
		const slotTable = new ArrayBuffer(SLOTS_BYTES);
		const slotDv = new DataView(slotTable);

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
			// For the fixed-index scheme the free list is unused for slot allocation,
			// but we keep it for compatibility with the format.
			headerDv.setUint32(H_FREE_LIST_HEAD, FREE_LIST_NONE, true);

			(accessHandle as any).write(headerU8, { at: 0 });
			(accessHandle as any).write(new Uint8Array(slotTable), {
				at: HEADER_SIZE,
			});
			(accessHandle as any).truncate(DATA_START);
			(accessHandle as any).flush();
			fileSize = DATA_START;
		} else {
			(accessHandle as any).read(headerU8, { at: 0 });

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

			(accessHandle as any).read(new Uint8Array(slotTable), {
				at: HEADER_SIZE,
			});

			// FIX: free list is unused in the fixed-index design — always reset.
			freeListHead = FREE_LIST_NONE;
			headerDv.setUint32(H_FREE_LIST_HEAD, FREE_LIST_NONE, true);

			// FIX: recompute usedBytes and occupiedCount from the slot table,
			// validating each slot's data range against the actual file size.
			// Clear any slots whose data extends beyond the file.
			let computedUsedBytes = 0;
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

			// Mark dirty so the corrected header + any repaired slots get written.
			if (repairedSlots) {
				const rf = new RegionFile(
					accessHandle,
					headerBuf,
					headerU8,
					headerDv,
					slotTable,
					slotDv,
					regionX,
					regionY,
					regionZ,
					usedBytes,
					occupiedCount,
					freeListHead,
					fileSize,
				);
				rf.headerDirty = true;
				rf.markAllSlotsDirty();
				return rf;
			}

			// Old file without repair — still rewrite header with corrected values.
			const rf = new RegionFile(
				accessHandle,
				headerBuf,
				headerU8,
				headerDv,
				slotTable,
				slotDv,
				regionX,
				regionY,
				regionZ,
				usedBytes,
				occupiedCount,
				freeListHead,
				fileSize,
			);
			rf.headerDirty = true;
			return rf;
		}

		return new RegionFile(
			accessHandle,
			headerBuf,
			headerU8,
			headerDv,
			slotTable,
			slotDv,
			regionX,
			regionY,
			regionZ,
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
		const got = (this.accessHandle as any).read(buf, { at: readAt });
		return got === size ? buf : null;
	}

	/**
	 * FIX: Each chunk has a *fixed* slot index (slotIndex(lx, ly, lz, isEntity)).
	 * The original code freed the old slot, pushed it to the free list, then
	 * called allocSlot() — which returned the same slot it just freed, then
	 * immediately overwrote the offset field with dataOffset, clobbering the
	 * free-list pointer it had just written.
	 *
	 * The correct approach: each chunk always lives at its fixed slot index.
	 * Only the data region (bump pointer) uses the usedBytes counter.
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
		const wasOccupied = oldSize > 0;

		if (data.length === 0) {
			this.removeChunk(lx, ly, lz, isEntity);
			return;
		}

		if (this.usedBytes + data.length > 0xffffffff) {
			throw new Error("[RegionFile] Region data exceeds 4GB u32 offset limit");
		}

		const dataOffset = this.usedBytes;
		this.writeSlotInMemory(idx, dataOffset, data.length);
		this.usedBytes += data.length;

		if (!wasOccupied) {
			this.occupiedCount++;
		}
		this.commitHeader();

		const neededEnd = DATA_START + this.usedBytes;
		if (neededEnd > this.fileSize) {
			const headroom = Math.max(data.length, HEADROOM_MIN);
			const newSize = neededEnd + headroom;
			(this.accessHandle as any).truncate(newSize);
			this.fileSize = newSize;
		}

		(this.accessHandle as any).write(data, { at: DATA_START + dataOffset });
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
			(this.accessHandle as any).write(this.headerU8, { at: 0 });
			this.headerDirty = false;
		}

		// Walk the dirty bitfield, collecting runs of contiguous dirty slots.
		let runStart = -1;
		const bits = this._dirtyBits;

		for (let i = 0; i <= SLOT_ENTRIES; i++) {
			const isDirty =
				i < SLOT_ENTRIES && (bits[i >>> 3]! & (1 << (i & 7))) !== 0;

			if (isDirty && runStart === -1) {
				runStart = i;
			} else if (!isDirty && runStart !== -1) {
				// Flush the contiguous run [runStart, i) in one write.
				const byteOffset = runStart * SLOT_SIZE;
				const byteLen = (i - runStart) * SLOT_SIZE;
				(this.accessHandle as any).write(
					new Uint8Array(this.slotTable, byteOffset, byteLen),
					{ at: HEADER_SIZE + byteOffset },
				);
				runStart = -1;
			}
		}

		bits.fill(0);
		(this.accessHandle as any).flush();
	}

	close(): void {
		this.flush();
		if (typeof (this.accessHandle as any).close === "function") {
			(this.accessHandle as any).close();
		}
	}
}
