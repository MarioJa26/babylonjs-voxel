import { Chunk } from "./Chunk/Chunk";
import { GLOBAL_VALUES } from "./GLOBAL_VALUES";
import { LevelDbChunkStore } from "./Storage/LevelDbChunkStore";
import {
	deserializeEntities,
	deserializeVoxelData,
	type SavedChunkData,
	type SavedChunkEntityData,
	serializeEntities,
	serializeVoxelData,
} from "./Storage/VoxelSerializer";
import { getWorldNameFromUrl } from "./WorldContext";

export type { SavedChunkData, SavedChunkEntityData };

export type LoadChunkOptions = {
	includeVoxelData?: boolean;
};

const ENTITY_PREFIX = "entity:";

class WorldStorageImpl {
	private store: LevelDbChunkStore | null = null;
	private initPromise: Promise<void> | null = null;

	initialize(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = (async () => {
			const worldName = getWorldNameFromUrl() ?? "default";
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
		await this.initialize();
		return this.store;
	}

	async saveChunk(chunk: Chunk): Promise<void> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_SAVING) return;
		if (chunk.isBoatChunk) return;
		if (!chunk.isModified && !chunk.isLightDirty) return;

		const store = await this.getStore();
		if (!store) return;

		const blocks = chunk.block_array;
		const light = chunk.light_array;

		const blob = serializeVoxelData(
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

		store.writeChunk(chunk.chunkX, chunk.chunkY, chunk.chunkZ, blob);

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
			const blocks = chunk.block_array;
			const light = chunk.light_array;

			const blob = serializeVoxelData(
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

			store.writeChunk(chunk.chunkX, chunk.chunkY, chunk.chunkZ, blob);
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
		await store.setMeta(key, new TextDecoder().decode(bytes));
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
			return deserializeEntities(new TextEncoder().encode(value));
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
		const coords = chunkIds.map((id) => ({
			id,
			...chunkIdToCoordsObj(id),
		}));

		if (!includeVoxelData) {
			const existing = await store.hasChunks(
				coords.map((c) => ({ cx: c.cx, cy: c.cy, cz: c.cz })),
			);
			for (const c of coords) {
				const key = `${c.cx},${c.cy},${c.cz}`;
				if (existing.has(key)) result.set(c.id, { blocks: null });
			}
			return result;
		}

		const readResults = await store.readChunks(
			coords.map((c) => ({ cx: c.cx, cy: c.cy, cz: c.cz })),
		);
		for (const c of coords) {
			const key = `${c.cx},${c.cy},${c.cz}`;
			const blob = readResults.get(key);
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
	 * Wipe the local chunk store (IndexedDB + memory cache). Used on
	 * connecting to a server so saved terrain from previous sessions can
	 * never be served back as if it were server data.
	 */
	async clearLocalChunkCache(): Promise<void> {
		const store = await this.getStore();
		if (!store) return;
		await store.clear();
	}
}

function chunkIdToCoords(chunkId: bigint): [number, number, number] {
	const SIGN_BIT = 1n << 20n;
	const COORD_MASK = (1n << 21n) - 1n;
	const BIAS = 1n << 20n;

	const cx = Number(
		((chunkId >> 0n) & COORD_MASK) - (chunkId & SIGN_BIT ? BIAS : 0n),
	);
	const cy = Number(
		((chunkId >> 21n) & COORD_MASK) - (chunkId & (SIGN_BIT << 21n) ? BIAS : 0n),
	);
	const cz = Number(
		((chunkId >> 42n) & COORD_MASK) - (chunkId & (SIGN_BIT << 42n) ? BIAS : 0n),
	);

	return [cx, cy, cz];
}

function chunkIdToCoordsObj(chunkId: bigint): {
	cx: number;
	cy: number;
	cz: number;
} {
	const [cx, cy, cz] = chunkIdToCoords(chunkId);
	return { cx, cy, cz };
}

export const WorldStorage = new WorldStorageImpl();
