const _rwOpts = { at: 0 };

const SLOT_SIZE_U = 32;
const HEADER_SIZE_U = 4096;
const SLOT_FLAG_DIRTY = 0x01;
const SLOT_FLAG_OCCUPIED = 0x02;
const SLOT_FLAG_REMOVED = 0x04;

const COMPACT_MIN_ORPHANED = 4 * 1024 * 1024; // 4 MB minimum before compacting
const COMPACT_RATIO_THRESHOLD = 0.5; // compact when live < 50% of file

export class OpfsChunkStore {
	private _fileHandle: FileSystemFileHandle | null = null;
	private _accessHandle: FileSystemSyncAccessHandle | null = null;
	private _tableBuffer: ArrayBuffer = new ArrayBuffer(0);
	private _tableView: DataView = new DataView(new ArrayBuffer(0));
	private _size: number = 0;
	private _capacity: number = 0;
	private _dataSize: bigint = 0n;
	private _liveDataSize: bigint = 0n;
	private _dirty = false;

	private readonly _scratch: ArrayBuffer;
	private readonly _scratchDv: DataView;
	private readonly _scratchU8: Uint8Array;
	private readonly _readSlab: Uint8Array;
	private readonly _headerBuf: Uint8Array;

	private _fileSize = 0;

	private _hitCount = 0;
	private _missCount = 0;
	private _evictionCount = 0;

	constructor() {
		this._scratch = new ArrayBuffer(SLOT_SIZE_U);
		this._scratchDv = new DataView(this._scratch);
		this._scratchU8 = new Uint8Array(this._scratch);
		this._readSlab = new Uint8Array(256 * 1024);
		this._headerBuf = new Uint8Array(HEADER_SIZE_U);
	}

	private get _dataStartOffset(): number {
		return HEADER_SIZE_U + this._capacity * SLOT_SIZE_U;
	}

	async open(name: string): Promise<void> {
		const root = await navigator.storage.getDirectory();
		this._fileHandle = await root.getFileHandle(name, { create: true });
		const file = await this._fileHandle.getFile();
		this._accessHandle = await this._fileHandle.createSyncAccessHandle();

		try {
			if (file.size === 0) {
				this._init();
			} else {
				this._load();
			}
		} catch (err) {
			if (this._accessHandle) {
				this._accessHandle.close();
				this._accessHandle = null;
			}
			this._fileHandle = null;
			throw err;
		}
	}

	close(): void {
		if (this._accessHandle) {
			this._accessHandle.close();
			this._accessHandle = null;
		}
		this._fileHandle = null;
	}

	write(keyHi: number, keyLo: number, lod: number, data: Uint8Array): void {
		const index = this._findSlot(keyHi, keyLo, lod);
		const dv = this._tableView;
		const off = index * SLOT_SIZE_U;
		const existingFlags = dv.getUint8(off + 9);
		const existingSize = dv.getUint32(off + 16, true);

		const wasLive =
			existingSize > 0 &&
			(existingFlags & SLOT_FLAG_REMOVED) === 0 &&
			(existingFlags & SLOT_FLAG_OCCUPIED) !== 0;

		const diskOffset = this._dataSize;
		const size = data.length;

		this._scratchU8.fill(0);
		this._scratchDv.setUint32(0, keyHi, true);
		this._scratchDv.setUint32(4, keyLo, true);
		this._scratchDv.setUint8(8, lod);
		this._scratchDv.setUint8(9, SLOT_FLAG_DIRTY | SLOT_FLAG_OCCUPIED);
		this._scratchDv.setUint32(16, size, true);
		this._scratchDv.setBigUint64(20, diskOffset, true);

		const slotAt = HEADER_SIZE_U + off;
		const dataAt = this._dataStartOffset + Number(diskOffset);
		const neededEnd = Math.max(slotAt + SLOT_SIZE_U, dataAt + size);

		if (neededEnd > this._fileSize) {
			const headroom = Math.max(size, 1024 * 1024);
			const newSize = neededEnd + headroom;
			this._accessHandle?.truncate(newSize);
			this._fileSize = newSize;
		}

		_rwOpts.at = slotAt;
		this._accessHandle?.write(this._scratchU8, _rwOpts);
		_rwOpts.at = dataAt;
		this._accessHandle?.write(data, _rwOpts);
		this._accessHandle?.flush();

		new Uint8Array(this._tableBuffer, off, SLOT_SIZE_U).set(this._scratchU8);

		if (!wasLive) {
			this._size++;
		} else {
			this._liveDataSize -= BigInt(existingSize);
		}
		this._dataSize += BigInt(size);
		this._liveDataSize += BigInt(size);
		this._dirty = true;
	}

	read(keyHi: number, keyLo: number, lod: number): Uint8Array | null {
		const index = this._findSlot(keyHi, keyLo, lod);
		const dv = this._tableView;
		const off = index * SLOT_SIZE_U;
		const flags = dv.getUint8(off + 9);
		const size = dv.getUint32(off + 16, true);
		const offset = dv.getBigUint64(off + 20, true);

		if (
			size === 0 ||
			(flags & SLOT_FLAG_REMOVED) !== 0 ||
			(flags & SLOT_FLAG_OCCUPIED) === 0
		) {
			this._missCount++;
			return null;
		}

		const at = this._dataStartOffset + Number(offset);
		// NOTE: slice() is intentional here — _readSlab is reused across reads,
		// so returning a subarray would silently corrupt previous results.
		if (size <= this._readSlab.byteLength) {
			_rwOpts.at = at;
			const got = this._accessHandle?.read(this._readSlab, _rwOpts);
			if (got !== size) {
				this._missCount++;
				return null;
			}
			this._hitCount++;
			return this._readSlab.slice(0, size);
		}
		const buf = new Uint8Array(size);
		_rwOpts.at = at;
		const got = this._accessHandle?.read(buf, _rwOpts);
		if (got !== size) {
			this._missCount++;
			return null;
		}
		this._hitCount++;
		return buf;
	}

	remove(keyHi: number, keyLo: number, lod: number): boolean {
		const index = this._findSlot(keyHi, keyLo, lod);
		const dv = this._tableView;
		const off = index * SLOT_SIZE_U;
		const existingFlags = dv.getUint8(off + 9);
		if (existingFlags & SLOT_FLAG_REMOVED) return false;
		if ((existingFlags & SLOT_FLAG_OCCUPIED) === 0) return false;

		const existingSize = dv.getUint32(off + 16, true);

		// Write flag byte and zeroed size via existing scratch buffer.
		this._scratchU8[0] = SLOT_FLAG_REMOVED;
		_rwOpts.at = HEADER_SIZE_U + off + 9;
		this._accessHandle?.write(this._scratchU8.subarray(0, 1), _rwOpts);

		this._scratchDv.setUint32(0, 0, true);
		_rwOpts.at = HEADER_SIZE_U + off + 16;
		this._accessHandle?.write(this._scratchU8.subarray(0, 4), _rwOpts);

		dv.setUint8(off + 9, SLOT_FLAG_REMOVED);
		dv.setUint32(off + 16, 0, true);

		this._size--;
		this._liveDataSize -= BigInt(existingSize);
		this._evictionCount++;
		return true;
	}

	flush(): void {
		this.compactIfNeeded();
		if (!this._dirty) return;
		this._writeHeader();
		this._accessHandle?.flush();
		this._dirty = false;
	}

	getStats(): {
		slotCount: number;
		usedBytes: number;
		totalBytes: number;
		capacity: number;
		hitCount: number;
		missCount: number;
		evictionCount: number;
	} {
		return {
			slotCount: this._size,
			usedBytes: Number(this._dataSize),
			totalBytes: this._fileSize,
			capacity: this._capacity,
			hitCount: this._hitCount,
			missCount: this._missCount,
			evictionCount: this._evictionCount,
		};
	}

	// ── Private ──────────────────────────────────────────────────────

	private static readonly INITIAL_CAPACITY = 1 << 20; // 1,048,576 slots, ~32MB table

	private _init(): void {
		this._capacity = OpfsChunkStore.INITIAL_CAPACITY;
		this._size = 0;
		this._dataSize = 0n;
		this._liveDataSize = 0n;
		this._tableBuffer = new ArrayBuffer(this._capacity * SLOT_SIZE_U);
		this._tableView = new DataView(this._tableBuffer);
		this._writeHeader(); // writes 4 KB header
		// Use truncate to extend the file to the full table region.
		// The OS zero-fills implicitly — avoids writing a 32 MB zero buffer
		// through JS, which is slow on some OPFS implementations.
		this._accessHandle?.truncate(this._dataStartOffset);
		this._fileSize = this._dataStartOffset;
		this._accessHandle?.flush();
	}

	private _load(): void {
		_rwOpts.at = 0;
		this._accessHandle?.read(this._headerBuf, _rwOpts);
		const dv = new DataView(this._headerBuf.buffer);
		this._capacity = dv.getUint32(12, true);

		if (this._capacity < OpfsChunkStore.INITIAL_CAPACITY) {
			this._init();
			return;
		}

		const tableBytes = this._capacity * SLOT_SIZE_U;
		this._tableBuffer = new ArrayBuffer(tableBytes);
		const tableU8 = new Uint8Array(this._tableBuffer);
		_rwOpts.at = HEADER_SIZE_U;
		this._accessHandle?.read(tableU8, _rwOpts);
		this._tableView = new DataView(this._tableBuffer);

		let liveCount = 0;
		let dataEnd = 0n;
		let liveDataSize = 0n;
		for (let i = 0; i < this._capacity; i++) {
			const off = i * SLOT_SIZE_U;
			const flags = this._tableView.getUint8(off + 9);
			const size = this._tableView.getUint32(off + 16, true);
			const diskOffset = this._tableView.getBigUint64(off + 20, true);
			if (
				size === 0 ||
				(flags & SLOT_FLAG_REMOVED) !== 0 ||
				(flags & SLOT_FLAG_OCCUPIED) === 0
			)
				continue;
			liveCount++;
			liveDataSize += BigInt(size);
			const end = diskOffset + BigInt(size);
			if (end > dataEnd) dataEnd = end;
		}
		this._size = liveCount;
		this._dataSize = dataEnd;
		this._liveDataSize = liveDataSize;

		this._fileSize = this._accessHandle?.getSize() as number;

		this._dirty = true;
	}

	private _findSlot(keyHi: number, keyLo: number, lod: number): number {
		if (this._capacity === 0) {
			this._grow();
			return this._findSlot(keyHi, keyLo, lod);
		}

		if (this._size * 100 > this._capacity * 70) {
			throw new Error(
				`[OpfsChunkStore] Mesh table too full (${this._size}/${this._capacity})`,
			);
		}

		const capacity = this._capacity;
		const mask = capacity - 1;
		const isPow2 = (capacity & mask) === 0;

		const hash =
			(keyHi ^ Math.imul(keyLo, 0x9e3779b9) ^ Math.imul(lod, 0x517c1b)) >>> 0;
		const start = isPow2 ? hash & mask : hash % capacity;
		const dv = this._tableView;

		let firstRemoved = -1;

		for (let i = 0; i < capacity; i++) {
			const index = isPow2 ? (start + i) & mask : (start + i) % capacity;
			const off = index * SLOT_SIZE_U;
			const h = dv.getUint32(off, true);
			const l = dv.getUint32(off + 4, true);
			const ld = dv.getUint8(off + 8);
			const f = dv.getUint8(off + 9);

			const isRemoved = (f & SLOT_FLAG_REMOVED) !== 0;
			const isEmpty = (f & SLOT_FLAG_OCCUPIED) === 0 && !isRemoved;

			if (
				!isRemoved &&
				(f & SLOT_FLAG_OCCUPIED) !== 0 &&
				h === keyHi &&
				l === keyLo &&
				ld === lod
			) {
				return index;
			}
			if (isRemoved && firstRemoved === -1) {
				firstRemoved = index;
			}
			if (isEmpty) {
				return firstRemoved !== -1 ? firstRemoved : index;
			}
		}

		this._grow();
		return this._findSlot(keyHi, keyLo, lod);
	}

	/**
	 * FIX: disabled dynamic growth — _dataStartOffset depends on capacity,
	 * and growing shifts the data start without moving existing data.
	 * Use a large fixed capacity from _init() instead.
	 */
	private _grow(): void {
		throw new Error(
			"[OpfsChunkStore] Mesh table full; increase INITIAL_CAPACITY",
		);
	}

	private _writeHeader(): void {
		const dv = new DataView(this._headerBuf.buffer);
		dv.setUint32(0, this._size, true);
		dv.setBigUint64(4, this._dataSize, true);
		dv.setUint32(12, this._capacity, true);
		_rwOpts.at = 0;
		this._accessHandle?.write(this._headerBuf, _rwOpts);
	}

	compactIfNeeded(): void {
		const orphanedBytes = this._dataSize - this._liveDataSize;
		if (
			orphanedBytes >= BigInt(COMPACT_MIN_ORPHANED) &&
			this._liveDataSize < this._dataSize - BigInt(COMPACT_MIN_ORPHANED) &&
			this._liveDataSize * 100n <
				this._dataSize * BigInt((1 - COMPACT_RATIO_THRESHOLD) * 100)
		) {
			this.compact();
		}
	}

	compact(): void {
		if (!this._accessHandle) return;

		type LiveEntry = { index: number; offset: bigint; size: number };
		const liveEntries: LiveEntry[] = [];

		for (let i = 0; i < this._capacity; i++) {
			const off = i * SLOT_SIZE_U;
			const flags = this._tableView.getUint8(off + 9);
			const size = this._tableView.getUint32(off + 16, true);
			const offset = this._tableView.getBigUint64(off + 20, true);
			if (
				size === 0 ||
				(flags & SLOT_FLAG_REMOVED) !== 0 ||
				(flags & SLOT_FLAG_OCCUPIED) === 0
			)
				continue;
			liveEntries.push({ index: i, offset, size });
		}

		liveEntries.sort((a, b) => Number(a.offset) - Number(b.offset));

		const dataStart = this._dataStartOffset;
		const copyBuf = new Uint8Array(64 * 1024);
		let writeHead = 0n;

		for (const entry of liveEntries) {
			const srcOff = dataStart + Number(entry.offset);
			const dstOff = dataStart + Number(writeHead);

			if (Number(writeHead) !== Number(entry.offset)) {
				let remaining = entry.size;
				let src = srcOff;
				let dst = dstOff;
				while (remaining > 0) {
					const chunk = Math.min(remaining, copyBuf.length);
					_rwOpts.at = src;
					this._accessHandle.read(copyBuf.subarray(0, chunk), _rwOpts);
					_rwOpts.at = dst;
					this._accessHandle.write(copyBuf.subarray(0, chunk), _rwOpts);
					src += chunk;
					dst += chunk;
					remaining -= chunk;
				}
			}

			const slotOff = entry.index * SLOT_SIZE_U;
			this._tableView.setBigUint64(slotOff + 20, writeHead, true);
			writeHead += BigInt(entry.size);
		}

		const newDataEnd = this._dataStartOffset + Number(writeHead);
		if (newDataEnd < this._fileSize) {
			this._accessHandle.truncate(newDataEnd);
			this._fileSize = newDataEnd;
		}

		this._dataSize = writeHead;
		this._liveDataSize = writeHead;
		this._dirty = true;
	}
}
