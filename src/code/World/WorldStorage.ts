import { Chunk } from "./Chunk/Chunk";
import { GLOBAL_VALUES } from "./GLOBAL_VALUES";
import type { SpawnPosition } from "./SpawnPoint";
import {
	isCacheResetError,
	LevelDbChunkStore,
} from "./Storage/LevelDbChunkStore";
import {
	deserializeEntities,
	deserializeVoxelData,
	type SavedChunkData,
	type SavedChunkEntityData,
	serializeEntities,
	serializeVoxelData,
} from "./Storage/VoxelSerializer";
import {
	getServerNameFromUrl,
	getWorldNameFromUrl,
	mpLocalCacheName,
} from "./WorldContext";

export type { SavedChunkData, SavedChunkEntityData };

export type LoadChunkOptions = {
	includeVoxelData?: boolean;
};

const ENTITY_PREFIX = "entity:";

// Hoisted singletons — constructing a TextEncoder/TextDecoder is not free,
// and both are stateless, so there's no reason to allocate a fresh one on
// every entity save/load.
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class WorldStorageImpl {
	private store: LevelDbChunkStore | null = null;
	private initPromise: Promise<void> | null = null;

	initialize(storeNameOverride?: string): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = (async () => {
			// In multiplayer the page is /server/<nick>; use a fresh ephemeral
			// cache name per session so the connect-time IndexedDB clear() is
			// instant (the old fixed "__mp__" store accumulated server chunks
			// across sessions and made clear() take ~45s).
			const worldName =
				storeNameOverride ??
				(getServerNameFromUrl() ? mpLocalCacheName() : getWorldNameFromUrl()) ??
				"default";
			console.log(`[WorldStorage] Initializing for world: ${worldName}`);
			this.store = new LevelDbChunkStore(worldName, "./saves");
			await this.store.open();
			console.log(
				`[WorldStorage] Initialized successfully, isReady=${this.store.isReady}`,
			);
		})();
		return this.initPromise;
	}

	private async getStore(): Promise<LevelDbChunkStore | null> {
		// Once initialized, `this.store` is set — skip the extra await on
		// `initPromise` (an `await` on an already-resolved promise still
		// costs a microtask hop) on this called-per-chunk hot path.
		if (this.store) return this.store;
		await this.initialize();
		return this.store;
	}

	async saveChunk(chunk: Chunk): Promise<void> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_SAVING) return;
		if (chunk.isBoatChunk) return;
		if (!chunk.isModified && !chunk.isLightDirty) return;

		const store = await this.getStore();
		if (!store) return;

		const blob = packChunkBlob(chunk);
		void store
			.writeChunk(chunk.chunkX, chunk.chunkY, chunk.chunkZ, blob)
			.catch((error) => {
				if (isCacheResetError(error)) return;
				console.warn("[WorldStorage] chunk save failed:", error);
			});

		chunk.isModified = false;
		chunk.isLightDirty = false;
	}

	async saveChunks(chunks: Chunk[]): Promise<void> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_SAVING) return;

		const toSave: Chunk[] = [];
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			if (chunk.isBoatChunk) continue;
			if (chunk.isModified || chunk.isLightDirty) {
				toSave.push(chunk);
			}
		}

		if (toSave.length === 0) return;

		const store = await this.getStore();
		if (!store) return;

		for (const chunk of toSave) {
			const blob = packChunkBlob(chunk);
			void store
				.writeChunk(chunk.chunkX, chunk.chunkY, chunk.chunkZ, blob)
				.catch((error) => {
					if (isCacheResetError(error)) return;
					console.warn("[WorldStorage] chunk save failed:", error);
				});
			chunk.isModified = false;
			chunk.isLightDirty = false;
		}

		await store.flush();
	}

	async saveAllModifiedChunks(): Promise<void> {
		const modified: Chunk[] = [];
		for (const chunk of Chunk.chunkInstances.values()) {
			if (chunk.needsPersistence() && !chunk.isBoatChunk) {
				modified.push(chunk);
			}
		}
		if (modified.length > 0) {
			await this.saveChunks(modified);
		}
	}

	async saveChunkEntities(
		chunkId: bigint,
		entities: SavedChunkEntityData[],
	): Promise<void> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_SAVING) return;
		const store = await this.getStore();
		if (!store) return;

		const [cx, cy, cz] = chunkIdToCoords(chunkId);
		const key = `${ENTITY_PREFIX}${cx},${cy},${cz}`;

		if (entities.length === 0) {
			// entities removed — nothing to do, they won't be read back
			return;
		}

		const bytes = serializeEntities(entities);
		await store.setMeta(key, textDecoder.decode(bytes));
	}

	async loadChunkEntities(chunkId: bigint): Promise<SavedChunkEntityData[]> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_LOADING) return [];
		const store = await this.getStore();
		if (!store) return [];

		const [cx, cy, cz] = chunkIdToCoords(chunkId);
		const key = `${ENTITY_PREFIX}${cx},${cy},${cz}`;
		const value = await store.getMeta(key);
		if (!value) return [];
		try {
			return deserializeEntities(textEncoder.encode(value));
		} catch {
			return [];
		}
	}

	async loadChunk(
		chunkId: bigint,
		options?: LoadChunkOptions,
	): Promise<SavedChunkData | null> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_LOADING) return null;
		const store = await this.getStore();
		if (!store) return null;

		const [cx, cy, cz] = chunkIdToCoords(chunkId);
		const includeVoxelData = options?.includeVoxelData ?? true;

		if (!includeVoxelData) {
			const exists = await store.hasChunk(cx, cy, cz);
			return exists ? { blocks: null } : null;
		}

		const blob = await store.readChunk(cx, cy, cz);
		if (!blob) return null;
		return deserializeVoxelData(blob);
	}

	async loadChunks(
		chunkIds: bigint[],
		options?: LoadChunkOptions,
		outMap?: Map<bigint, SavedChunkData>,
	): Promise<Map<bigint, SavedChunkData>> {
		const result = outMap ?? new Map<bigint, SavedChunkData>();

		if (GLOBAL_VALUES.DISABLE_CHUNK_LOADING || chunkIds.length === 0) {
			return result;
		}

		const store = await this.getStore();
		if (!store) return result;

		const includeVoxelData = options?.includeVoxelData ?? true;

		// Decode every chunk id once into exactly the shape downstream needs,
		// including the "cx,cy,cz" string key up front. LevelDbChunkStore's
		// readChunks/hasChunks accept an optional pre-computed `key` per
		// coord specifically so callers can avoid rebuilding it — without
		// this, the key gets built once inside the store (cache miss path)
		// and *again* out here just to probe the returned Map/Set. Building
		// it once here and passing it through both eliminates the duplicate
		// and replaces what was previously three allocations per chunk
		// ([cx,cy,cz] array, {cx,cy,cz} object, spread into {id,cx,cy,cz})
		// with one.
		const n = chunkIds.length;
		const coords: {
			id: bigint;
			cx: number;
			cy: number;
			cz: number;
			key: string;
		}[] = new Array(n);
		for (let i = 0; i < n; i++) {
			const id = chunkIds[i];
			const [cx, cy, cz] = chunkIdToCoords(id);
			coords[i] = { id, cx, cy, cz, key: `${cx},${cy},${cz}` };
		}

		if (!includeVoxelData) {
			const existing = await store.hasChunks(coords);
			for (let i = 0; i < n; i++) {
				const c = coords[i];
				if (existing.has(c.key)) result.set(c.id, { blocks: null });
			}
			return result;
		}

		const readResults = await store.readChunks(coords);
		for (let i = 0; i < n; i++) {
			const c = coords[i];
			const blob = readResults.get(c.key);
			if (blob) {
				result.set(c.id, deserializeVoxelData(blob));
			}
		}

		return result;
	}

	async flush(): Promise<void> {
		const store = await this.getStore();
		if (!store) return;
		await store.flush();
	}

	/**
	 * Persist the prepared world spawn point so the spawn search/prepare step
	 * never runs again for this world.
	 */
	async saveSpawnPoint(p: SpawnPosition): Promise<void> {
		const store = await this.getStore();
		if (!store) return;
		await store.setMeta("spawn", JSON.stringify(p));
	}

	/**
	 * Load a previously prepared spawn point, or null if the world has not
	 * had one prepared yet.
	 */
	async loadSpawnPoint(): Promise<SpawnPosition | null> {
		const store = await this.getStore();
		if (!store) return null;
		const v = await store.getMeta("spawn");
		if (!v) return null;
		try {
			const p = JSON.parse(v) as Partial<SpawnPosition>;
			if (
				typeof p.x === "number" &&
				typeof p.y === "number" &&
				typeof p.z === "number"
			) {
				return { x: p.x, y: p.y, z: p.z };
			}
		} catch {
			// ignore malformed payloads
		}
		return null;
	}

	/**
	 * Wipe the local chunk store (IndexedDB + memory cache). Used on
	 * connecting to a server so saved terrain from previous sessions can
	 * never be served back as if it were server data.
	 */
	async clearLocalChunkCache(): Promise<void> {
		const store = await this.getStore();
		if (!store) return;
		// discardPendingWrites: queued local saves are wiped anyway, so
		// commit-then-erase would be wasted I/O on reconnect.
		await store.clear({ discardPendingWrites: true });
	}
}

/**
 * Build the storage blob for a chunk. Shared by saveChunk/saveChunks so
 * there's a single implementation to keep correct (and a single call site
 * for the JIT to specialize).
 */
function packChunkBlob(chunk: Chunk): Uint8Array {
	const blocks = chunk.block_array;
	const light = chunk.light_array;

	return serializeVoxelData(
		blocks
			? new Uint8Array(blocks.buffer, blocks.byteOffset, blocks.byteLength)
			: null,
		chunk.palette
			? new Uint16Array(
					chunk.palette.buffer,
					chunk.palette.byteOffset,
					chunk.palette.byteLength >> 1,
				)
			: null,
		chunk.isUniform,
		chunk.uniformBlockId,
		light
			? new Uint8Array(light.buffer, light.byteOffset, light.byteLength)
			: null,
		false,
	);
}

// Hoisted once — BigInt shifts/allocations are considerably more expensive
// than plain Number ops. The old code recomputed `SIGN_BIT << 21n` and
// `SIGN_BIT << 42n` (each a fresh BigInt allocation) on every single call
// to chunkIdToCoords. Precomputing them here means each call only pays for
// the unavoidable mask/shift extraction from the packed id.
const COORD_BITS = 21n;
const COORD_MASK = (1n << COORD_BITS) - 1n;
const SIGN_BIT_X = 1n << 20n;
const SIGN_BIT_Y = SIGN_BIT_X << COORD_BITS;
const SIGN_BIT_Z = SIGN_BIT_X << (COORD_BITS * 2n);
const BIAS_NUM = 1_048_576; // 2^20 — bias is applied in Number space now

function chunkIdToCoords(chunkId: bigint): [number, number, number] {
	// Extraction still needs BigInt (chunkId can carry 63 bits, beyond what
	// JS's 32-bit bitwise operators support), but the bias subtraction that
	// used to happen in BigInt space now happens on plain Numbers, which is
	// materially cheaper.
	const rawX = Number(chunkId & COORD_MASK);
	const rawY = Number((chunkId >> COORD_BITS) & COORD_MASK);
	const rawZ = Number((chunkId >> (COORD_BITS * 2n)) & COORD_MASK);

	const cx = (chunkId & SIGN_BIT_X) !== 0n ? rawX - BIAS_NUM : rawX;
	const cy = (chunkId & SIGN_BIT_Y) !== 0n ? rawY - BIAS_NUM : rawY;
	const cz = (chunkId & SIGN_BIT_Z) !== 0n ? rawZ - BIAS_NUM : rawZ;

	return [cx, cy, cz];
}

export const WorldStorage = new WorldStorageImpl();
