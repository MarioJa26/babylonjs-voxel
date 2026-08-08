/**
 * LevelDbChunkStore — LevelDB-backed chunk storage for the server.
 *
 * Same VoxelSerializer blob format as singleplayer, but stored in LevelDB
 * instead of OPFS region files. Key = chunk coords, Value = serialized blob.
 *
 * Key layout (binary, little-endian):
 *   \x00 + cx:i32 + cy:i32 + cz:i32  ← chunk data (13 bytes)
 *   \x01 + key:string                 → metadata (e.g. seed)
 *
 * LevelDB's LSM-tree is ideal for write-heavy block-edit workloads and
 * auto-compacts to reclaim space — no manual LRU or compaction logic needed.
 */
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const CHUNK_PREFIX = "\x00";
const META_PREFIX = "\x01";

function chunkKey(cx: number, cy: number, cz: number): Uint8Array {
	const key = new Uint8Array(13);
	key[0] = CHUNK_PREFIX.charCodeAt(0);
	const dv = new DataView(key.buffer);
	dv.setInt32(1, cx, true);
	dv.setInt32(5, cy, true);
	dv.setInt32(9, cz, true);
	return key;
}

function metaKey(name: string): string {
	return META_PREFIX + name;
}

interface LevelDb {
	get(key: Uint8Array | string): Promise<Uint8Array | string | void>;
	put(key: Uint8Array | string, value: Uint8Array | string): Promise<void>;
	batch(): LevelBatch;
	open(): Promise<void>;
	close(): Promise<void>;
}

interface LevelBatch {
	put(key: Uint8Array | string, value: Uint8Array | string): void;
	write(): Promise<void>;
}

export class LevelDbChunkStore {
	private db: LevelDb | null = null;
	private readonly dbPath: string;
	private batch: LevelBatch | null = null;
	private batchCount = 0;
	private readonly maxBatchSize = 64;

	constructor(worldName: string, basePath: string) {
		this.dbPath = resolve(basePath, "worlds", worldName, "db");
	}

	async open(): Promise<void> {
		const { Level } = await import("level");
		if (!existsSync(this.dbPath)) {
			mkdirSync(this.dbPath, { recursive: true });
		}
		this.db = new Level(this.dbPath, {
			valueEncoding: "buffer",
			keyEncoding: "buffer",
		});
		await this.db.open();
	}

	async close(): Promise<void> {
		await this.flush();
		if (this.db) {
			await this.db.close();
			this.db = null;
		}
	}

	/**
	 * Read a chunk from the database.
	 * Returns the serialized blob, or null if not found.
	 */
	async readChunk(cx: number, cy: number, cz: number): Promise<Uint8Array | null> {
		if (!this.db) return null;
		try {
			const value = await this.db.get(chunkKey(cx, cy, cz));
			if (!value) return null;
			return value instanceof Uint8Array
				? value
				: new Uint8Array(value as unknown as ArrayBuffer);
		} catch {
			return null;
		}
	}

	/**
	 * Write a chunk to the database (batched for efficiency).
	 * Call flush() to ensure all pending writes are persisted.
	 */
	writeChunk(cx: number, cy: number, cz: number, data: Uint8Array): void {
		if (!this.db) return;
		if (!this.batch) {
			this.batch = this.db.batch();
			this.batchCount = 0;
		}
		this.batch.put(chunkKey(cx, cy, cz), Buffer.from(data));
		this.batchCount++;

		if (this.batchCount >= this.maxBatchSize) {
			// Reset reference immediately so the next writeChunk creates a
			// fresh batch — the old batch is no longer writable after this point.
			const pending = this.batch;
			this.batch = null;
			this.batchCount = 0;
			void pending.write();
		}
	}

	/**
	 * Flush all pending writes to the database.
	 */
	async flush(): Promise<void> {
		if (this.batch && this.batchCount > 0) {
			const pending = this.batch;
			this.batch = null;
			this.batchCount = 0;
			await pending.write();
		}
	}

	/**
	 * Store metadata (seed, version, etc.)
	 */
	async setMeta(key: string, value: string): Promise<void> {
		if (!this.db) return;
		await this.db.put(metaKey(key), value);
	}

	/**
	 * Read metadata. Returns null if not found.
	 */
	async getMeta(key: string): Promise<string | null> {
		if (!this.db) return null;
		try {
			const value = await this.db.get(metaKey(key));
			return value != null ? String(value) : null;
		} catch {
			return null;
		}
	}

	/**
	 * Check if a chunk exists in the database.
	 */
	async hasChunk(cx: number, cy: number, cz: number): Promise<boolean> {
		if (!this.db) return false;
		try {
			await this.db.get(chunkKey(cx, cy, cz));
			return true;
		} catch {
			return false;
		}
	}

	get isReady(): boolean {
		return this.db !== null;
	}
}
