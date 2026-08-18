import { Chunk } from "./Chunk/Chunk";
import { GLOBAL_VALUES } from "./GLOBAL_VALUES";
import type { SpawnPosition } from "./SpawnPoint";
import {
	type ChunkReadCoord,
	type ChunkWrite,
	isCacheResetError,
	LevelDbChunkStore,
} from "./Storage/LevelDbChunkStore";
import {
	deserializeEntities,
	deserializeVoxelDataShared,
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

/**
 * Existence marker for loadChunk/loadChunks with includeVoxelData: false.
 * Never mutated by any consumer (only used as a truthy signal that the chunk
 * exists in storage), so a single shared instance avoids one allocation per
 * found chunk on pure existence checks.
 */
const CHUNK_EXISTS_WITHOUT_BLOCKS: SavedChunkData = { blocks: null };

class WorldStorageImpl {
	private store: LevelDbChunkStore | null = null;
	private initPromise: Promise<void> | null = null;

	initialize(storeNameOverride?: string): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = (async () => {
			try {
				// In multiplayer the page is /server/<nick>; use a fresh ephemeral
				// cache name per session so the connect-time IndexedDB clear() is
				// instant (the old fixed "__mp__" store accumulated server chunks
				// across sessions and made clear() take ~45s).
				const worldName =
					storeNameOverride ??
					(getServerNameFromUrl()
						? mpLocalCacheName()
						: getWorldNameFromUrl()) ??
					"default";
				console.log(`[WorldStorage] Initializing for world: ${worldName}`);

				const store = new LevelDbChunkStore(worldName, "./saves");
				await store.open();

				this.store = store;

				console.log(
					`[WorldStorage] Initialized successfully, isReady=${store.isReady}`,
				);
			} catch (error) {
				// Drop the cached promise so a failed open can be retried by a
				// later call instead of poisoning every future getStore().
				this.store = null;
				this.initPromise = null;
				throw error;
			}
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

		try {
			await store.writeChunk(chunk.chunkX, chunk.chunkY, chunk.chunkZ, blob);
			chunk.isModified = false;
			chunk.isLightDirty = false;
		} catch (error) {
			if (isCacheResetError(error)) return;
			console.warn("[WorldStorage] chunk save failed:", error);
		}
	}

	async saveChunks(chunks: Chunk[]): Promise<void> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_SAVING) return;

		const store = await this.getStore();
		if (!store) return;

		const writes: ChunkWrite[] = [];
		const savedChunks: Chunk[] = [];

		for (let i = 0, n = chunks.length; i < n; i++) {
			const chunk = chunks[i];

			if (chunk.isBoatChunk) continue;
			if (!chunk.isModified && !chunk.isLightDirty) continue;

			writes.push({
				cx: chunk.chunkX,
				cy: chunk.chunkY,
				cz: chunk.chunkZ,
				blob: packChunkBlob(chunk),
			});
			savedChunks.push(chunk);
		}

		if (writes.length === 0) return;

		try {
			await store.writeChunks(writes);
			await store.flush();

			for (let i = 0, n = savedChunks.length; i < n; i++) {
				const chunk = savedChunks[i];
				chunk.isModified = false;
				chunk.isLightDirty = false;
			}
		} catch (error) {
			if (isCacheResetError(error)) return;
			console.warn("[WorldStorage] chunk batch save failed:", error);
		}
	}

	async saveAllModifiedChunks(): Promise<void> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_SAVING) return;

		const store = await this.getStore();
		if (!store) return;

		const writes: ChunkWrite[] = [];
		const savedChunks: Chunk[] = [];

		for (const chunk of Chunk.chunkInstances.values()) {
			if (!chunk.needsPersistence()) continue;
			if (chunk.isBoatChunk) continue;

			writes.push({
				cx: chunk.chunkX,
				cy: chunk.chunkY,
				cz: chunk.chunkZ,
				blob: packChunkBlob(chunk),
			});
			savedChunks.push(chunk);
		}

		if (writes.length === 0) return;

		try {
			await store.writeChunks(writes);
			await store.flush();

			for (let i = 0, n = savedChunks.length; i < n; i++) {
				const chunk = savedChunks[i];
				chunk.isModified = false;
				chunk.isLightDirty = false;
			}
		} catch (error) {
			if (isCacheResetError(error)) return;
			console.warn("[WorldStorage] save all modified chunks failed:", error);
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
			// All entities removed — delete the stored payload so a later
			// load cannot resurrect stale entities.
			await store.deleteMeta(key);
			return;
		}

		const bytes = serializeEntities(entities);
		await store.setMetaBytes(key, bytes);
	}

	async loadChunkEntities(chunkId: bigint): Promise<SavedChunkEntityData[]> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_LOADING) return [];
		const store = await this.getStore();
		if (!store) return [];

		const [cx, cy, cz] = chunkIdToCoords(chunkId);
		const key = `${ENTITY_PREFIX}${cx},${cy},${cz}`;
		const bytes = await store.getMetaBytes(key);

		if (!bytes) return [];

		try {
			return deserializeEntities(bytes);
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
			return exists ? CHUNK_EXISTS_WITHOUT_BLOCKS : null;
		}

		const blob = await store.readChunk(cx, cy, cz);
		if (!blob) return null;
		return deserializeVoxelDataShared(blob);
	}

	async loadChunks(
		chunkIds: bigint[],
		options?: LoadChunkOptions,
		outMap?: Map<bigint, SavedChunkData>,
	): Promise<Map<bigint, SavedChunkData>> {
		const result = outMap ?? new Map<bigint, SavedChunkData>();
		const n = chunkIds.length;

		if (GLOBAL_VALUES.DISABLE_CHUNK_LOADING || n === 0) {
			return result;
		}

		const store = await this.getStore();
		if (!store) return result;

		const includeVoxelData = options?.includeVoxelData ?? true;
		const coords: ChunkReadCoord[] = new Array(n);
		const out: ChunkCoordsOut = { cx: 0, cy: 0, cz: 0 };

		for (let i = 0; i < n; i++) {
			const id = chunkIds[i];
			chunkIdToCoordsOut(id, out);

			const cx = out.cx;
			const cy = out.cy;
			const cz = out.cz;
			const key = `${cx},${cy},${cz}`;

			coords[i] = { id, cx, cy, cz, key };
		}

		if (!includeVoxelData) {
			const existing = await store.hasChunks(coords);
			for (let i = 0; i < n; i++) {
				const c = coords[i];
				if (existing.has(c.key!)) {
					result.set(c.id!, CHUNK_EXISTS_WITHOUT_BLOCKS);
				}
			}
			return result;
		}

		const readResults = await store.readChunks(coords);

		for (let i = 0; i < n; i++) {
			const c = coords[i];
			const blob = readResults.get(c.key!);
			if (blob) {
				result.set(c.id!, deserializeVoxelDataShared(blob));
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
	const palette = chunk.palette;
	const light = chunk.light_array;

	const blockBytes = blocks
		? new Uint8Array(blocks.buffer, blocks.byteOffset, blocks.byteLength)
		: null;

	const paletteWords = palette
		? new Uint16Array(
				palette.buffer,
				palette.byteOffset,
				palette.byteLength >> 1,
			)
		: null;

	const lightBytes = light
		? new Uint8Array(light.buffer, light.byteOffset, light.byteLength)
		: null;

	return serializeVoxelData(
		blockBytes,
		paletteWords,
		chunk.isUniform,
		chunk.uniformBlockId,
		lightBytes,
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
const Z_SHIFT = COORD_BITS * 2n;
const SIGN_BIT_X = 1n << 20n;
const SIGN_BIT_Y = SIGN_BIT_X << COORD_BITS;
const SIGN_BIT_Z = SIGN_BIT_X << Z_SHIFT;
const BIAS_NUM = 1_048_576; // 2^20 — bias is applied in Number space now

function chunkIdToCoords(chunkId: bigint): [number, number, number] {
	const rawX = Number(chunkId & COORD_MASK);
	const rawY = Number((chunkId >> COORD_BITS) & COORD_MASK);
	const rawZ = Number((chunkId >> Z_SHIFT) & COORD_MASK);

	return [
		(chunkId & SIGN_BIT_X) !== 0n ? rawX - BIAS_NUM : rawX,
		(chunkId & SIGN_BIT_Y) !== 0n ? rawY - BIAS_NUM : rawY,
		(chunkId & SIGN_BIT_Z) !== 0n ? rawZ - BIAS_NUM : rawZ,
	];
}

interface ChunkCoordsOut {
	cx: number;
	cy: number;
	cz: number;
}

/**
 * Tuple-free variant of chunkIdToCoords for bulk decode loops: writes into a
 * reusable out object instead of allocating a fresh tuple per chunk id.
 */
function chunkIdToCoordsOut(
	chunkId: bigint,
	out: ChunkCoordsOut,
): ChunkCoordsOut {
	const rawX = Number(chunkId & COORD_MASK);
	const rawY = Number((chunkId >> COORD_BITS) & COORD_MASK);
	const rawZ = Number((chunkId >> Z_SHIFT) & COORD_MASK);

	out.cx = (chunkId & SIGN_BIT_X) !== 0n ? rawX - BIAS_NUM : rawX;
	out.cy = (chunkId & SIGN_BIT_Y) !== 0n ? rawY - BIAS_NUM : rawY;
	out.cz = (chunkId & SIGN_BIT_Z) !== 0n ? rawZ - BIAS_NUM : rawZ;

	return out;
}

export const WorldStorage = new WorldStorageImpl();
