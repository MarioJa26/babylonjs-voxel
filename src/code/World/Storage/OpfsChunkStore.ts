interface PendingOp {
	execute: () => Promise<void>;
	resolve: () => void;
	reject: (err: unknown) => void;
}

const SLOT_SIZE_U = 32;
const HEADER_SIZE_U = 4096;
const SLOT_FLAG_DIRTY = 0x01;
const SLOT_FLAG_REMOVED = 0x04;

export class OpfsChunkStore {
	private _fileHandle: FileSystemFileHandle | null = null;
	private _accessHandle: FileSystemSyncAccessHandle | null = null;
	private _tableBuffer: ArrayBuffer = new ArrayBuffer(0);
	private _tableView: DataView = new DataView(new ArrayBuffer(0));
	private _size: number = 0;
	private _capacity: number = 0;
	private _dataSize: bigint = 0n;
	private _dirty = false;

	private _opQueue: PendingOp[] = [];
	private _processing = false;

	// Per-instance scratch buffers — avoids sharing mutable state across instances
	// (module-level shared scratch caused stale-byte bugs in remove() / write()).
	private readonly _scratch = new ArrayBuffer(SLOT_SIZE_U);
	private readonly _scratchDv = new DataView(new ArrayBuffer(SLOT_SIZE_U));
	private readonly _scratchU8 = new Uint8Array(new ArrayBuffer(SLOT_SIZE_U));

	constructor() {
		// Wire up the per-instance scratch views to the same buffer.
		Object.assign(this, {
			_scratchDv: new DataView(this._scratch),
			_scratchU8: new Uint8Array(this._scratch),
		});
	}

	private get _dataStartOffset(): number {
		return HEADER_SIZE_U + this._capacity * SLOT_SIZE_U;
	}

	async open(name: string): Promise<void> {
		const root = await navigator.storage.getDirectory();
		this._fileHandle = await root.getFileHandle(name, { create: true });
		const file = await this._fileHandle.getFile();
		this._accessHandle = await (
			this._fileHandle as any
		).createSyncAccessHandle();

		try {
			if (file.size === 0) {
				await this._init();
			} else {
				await this._load();
			}
		} catch (err) {
			// Close the access handle so it doesn't block a future
			// createSyncAccessHandle() call for the same file.
			if (this._accessHandle) {
				this._accessHandle.close();
				this._accessHandle = null;
			}
			this._fileHandle = null;
			throw err;
		}
	}

	async close(): Promise<void> {
		await this.enqueue(async () => {
			if (this._accessHandle) {
				this._accessHandle.close();
				this._accessHandle = null;
			}
			this._fileHandle = null;
		});
	}

	async write(
		keyHi: number,
		keyLo: number,
		lod: number,
		data: Uint8Array,
	): Promise<void> {
		await this.enqueue(async () => {
			const { dv, index } = this._findSlot(keyHi, keyLo, lod);
			const off = index * SLOT_SIZE_U;
			const existingFlags = dv.getUint8(off + 9);
			const existingSize = dv.getUint32(off + 16, true);
			const storedHi = dv.getUint32(off, true);
			const storedLo = dv.getUint32(off + 4, true);

			const wasLive =
				existingSize > 0 &&
				(existingFlags & SLOT_FLAG_REMOVED) === 0 &&
				!(storedHi === 0 && storedLo === 0);

			const diskOffset = this._dataSize;
			const size = data.length;

			// FIX: zero the scratch before use so reserved / checksum fields are clean.
			this._scratchU8.fill(0);
			this._scratchDv.setUint32(0, keyHi, true);
			this._scratchDv.setUint32(4, keyLo, true);
			this._scratchDv.setUint8(8, lod);
			this._scratchDv.setUint8(9, SLOT_FLAG_DIRTY);
			// bytes 10-11: reserved = 0 (already zeroed)
			this._scratchDv.setUint32(16, size, true);
			this._scratchDv.setBigUint64(20, diskOffset, true);
			// bytes 28-31: checksum = 0 (already zeroed)

			const slotAt = HEADER_SIZE_U + off;
			const dataAt = this._dataStartOffset + Number(diskOffset);
			const neededEnd = Math.max(slotAt + SLOT_SIZE_U, dataAt + size);
			const fileSize = (this._accessHandle as any).getSize() as number;
			if (neededEnd > fileSize) {
				const headroom = Math.max(size, 1024 * 1024);
				(this._accessHandle as any).truncate(neededEnd + headroom);
				(this._accessHandle as any).flush();
			}

			// Also update the in-memory table view so subsequent findSlot probes work.
			new Uint8Array(this._tableBuffer, off, SLOT_SIZE_U).set(this._scratchU8);

			(this._accessHandle as any).write(this._scratchU8, { at: slotAt });
			(this._accessHandle as any).write(data, { at: dataAt });

			// FIX: only increment _size when slot was previously empty/removed.
			// Never decrement _dataSize — it's an append-only bump pointer.
			if (!wasLive) {
				this._size++;
			}
			this._dataSize += BigInt(size);
			this._dirty = true;
		});
	}

	async read(
		keyHi: number,
		keyLo: number,
		lod: number,
	): Promise<Uint8Array | null> {
		let result: Uint8Array | null = null;
		await this.enqueue(async () => {
			const { dv, index } = this._findSlot(keyHi, keyLo, lod);
			const off = index * SLOT_SIZE_U;
			const flags = dv.getUint8(off + 9);
			const size = dv.getUint32(off + 16, true);
			const offset = dv.getBigUint64(off + 20, true);

			if (size === 0 || (flags & SLOT_FLAG_REMOVED) !== 0) {
				result = null;
				return;
			}

			const buf = new Uint8Array(size);
			const at = this._dataStartOffset + Number(offset);
			const got = (this._accessHandle as any).read(buf, { at });
			if (got !== size) {
				result = null;
				return;
			}

			result = buf;
		});
		return result;
	}

	async remove(keyHi: number, keyLo: number, lod: number): Promise<boolean> {
		let removed = false;
		await this.enqueue(async () => {
			const { dv, index } = this._findSlot(keyHi, keyLo, lod);
			const off = index * SLOT_SIZE_U;
			const existingFlags = dv.getUint8(off + 9);
			if (existingFlags & SLOT_FLAG_REMOVED) return;

			// Check it's actually an occupied slot (not an empty probe stop).
			const storedHi = dv.getUint32(off, true);
			const storedLo = dv.getUint32(off + 4, true);
			if (storedHi === 0 && storedLo === 0) return;

			const existingSize = dv.getUint32(off + 16, true);

			// FIX: write only the two fields we're changing; zero scratch first so
			// no stale bytes from a prior write() call bleed into the disk write.
			// We write flag byte and size field independently — minimal I/O.
			const flagByte = new Uint8Array(1);
			flagByte[0] = SLOT_FLAG_REMOVED;
			(this._accessHandle as any).write(flagByte, {
				at: HEADER_SIZE_U + off + 9,
			});

			const sizeBuf = new Uint8Array(4);
			new DataView(sizeBuf.buffer).setUint32(0, 0, true);
			(this._accessHandle as any).write(sizeBuf, {
				at: HEADER_SIZE_U + off + 16,
			});

			// Mirror into in-memory table.
			dv.setUint8(off + 9, SLOT_FLAG_REMOVED);
			dv.setUint32(off + 16, 0, true);

			this._size--;
			// FIX: do NOT subtract from _dataSize — it's an append-only bump pointer.
			removed = true;
		});
		return removed;
	}

	async flush(): Promise<void> {
		await this.enqueue(async () => {
			if (!this._dirty) return;
			this._writeHeader();
			(this._accessHandle as any).flush();
			this._dirty = false;
		});
	}

	// ── Private ──────────────────────────────────────────────────────

	private static readonly INITIAL_CAPACITY = 1 << 20; // 1,048,576 slots, ~32MB table

	private async _init(): Promise<void> {
		this._capacity = OpfsChunkStore.INITIAL_CAPACITY;
		this._size = 0;
		this._dataSize = 0n;
		this._tableBuffer = new ArrayBuffer(this._capacity * SLOT_SIZE_U);
		this._tableView = new DataView(this._tableBuffer);
		this._writeHeader();
		// Write empty slot table.
		(this._accessHandle as any).write(new Uint8Array(this._tableBuffer), {
			at: HEADER_SIZE_U,
		});
		(this._accessHandle as any).truncate(this._dataStartOffset);
		(this._accessHandle as any).flush();
	}

	private async _load(): Promise<void> {
		const header = new Uint8Array(HEADER_SIZE_U);
		(this._accessHandle as any).read(header, { at: 0 });
		const dv = new DataView(header.buffer);
		// Ignore stored _size and _dataSize — recompute from table.
		this._capacity = dv.getUint32(12, true);

		// Force reinit for old/incompatible files (wrong capacity, corrupted data).
		if (this._capacity < OpfsChunkStore.INITIAL_CAPACITY) {
			await this._init();
			return;
		}

		const tableBytes = this._capacity * SLOT_SIZE_U;
		this._tableBuffer = new ArrayBuffer(tableBytes);
		const tableU8 = new Uint8Array(this._tableBuffer);
		(this._accessHandle as any).read(tableU8, { at: HEADER_SIZE_U });
		this._tableView = new DataView(this._tableBuffer);

		// FIX: recompute _size and _dataSize from the slot table to recover
		// from any corruption caused by old append-pointer bugs.
		let liveCount = 0;
		let dataEnd = 0n;
		for (let i = 0; i < this._capacity; i++) {
			const off = i * SLOT_SIZE_U;
			const flags = this._tableView.getUint8(off + 9);
			const size = this._tableView.getUint32(off + 16, true);
			const diskOffset = this._tableView.getBigUint64(off + 20, true);
			if (size === 0 || (flags & SLOT_FLAG_REMOVED) !== 0) continue;
			liveCount++;
			const end = diskOffset + BigInt(size);
			if (end > dataEnd) dataEnd = end;
		}
		this._size = liveCount;
		this._dataSize = dataEnd;
		this._dirty = true;
	}

	private _findSlot(
		keyHi: number,
		keyLo: number,
		lod: number,
	): { dv: DataView; index: number } {
		if (this._capacity === 0) {
			this._grow();
			return this._findSlot(keyHi, keyLo, lod);
		}

		const capacity = this._capacity;
		// PERF: use bitwise AND for power-of-two capacities (always true after _grow).
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
			const isEmpty = h === 0 && l === 0 && !isRemoved;

			if (!isRemoved && h === keyHi && l === keyLo && ld === lod) {
				// Found the live slot.
				return { dv, index };
			}
			if (isRemoved && firstRemoved === -1) {
				firstRemoved = index;
			}
			if (isEmpty) {
				// Key not present; return the first removed slot (for reuse) or this empty slot.
				return { dv, index: firstRemoved !== -1 ? firstRemoved : index };
			}
		}

		// Table full — grow and retry.
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
		const header = new Uint8Array(HEADER_SIZE_U);
		const dv = new DataView(header.buffer);
		dv.setUint32(0, this._size, true);
		dv.setBigUint64(4, this._dataSize, true);
		dv.setUint32(12, this._capacity, true);
		(this._accessHandle as any).write(header, { at: 0 });
	}

	/**
	 * PERF: The queue drainer avoids re-scheduling via microtasks when there are
	 * already items waiting — it just continues the while loop inline.
	 */
	private async enqueue(fn: () => Promise<void>): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this._opQueue.push({ execute: fn, resolve, reject });
			if (!this._processing) {
				void this._drainQueue();
			}
		});
	}

	private async _drainQueue(): Promise<void> {
		this._processing = true;
		while (this._opQueue.length > 0) {
			const op = this._opQueue.shift()!;
			try {
				await op.execute();
				op.resolve();
			} catch (err) {
				op.reject(err);
			}
		}
		this._processing = false;
	}
}
