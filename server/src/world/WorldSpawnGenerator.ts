import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import {
	getFinalTerrainHeight,
	setTerrainSeed,
} from "@/code/Generation/TerrainHeightMap";
import { CHUNK_SIZE } from "@/code/Lib/VoxelMath";
import type { ChunkGenerationService } from "./ChunkGenerationService.ts";
import type { ServerWorldStorage } from "./ServerWorldStorage.ts";

export interface WorldSpawn {
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
}

export interface WorldSpawnGeneratorContext {
	seed: string;
	chunkGen: ChunkGenerationService;
	worldStorage: ServerWorldStorage;
	prewarmSpawnArea: (chunkX: number, chunkZ: number) => void;
}

/** Find, prepare, and persist the world's spawn exactly once. */
export async function createWorldSpawn(
	context: WorldSpawnGeneratorContext,
): Promise<WorldSpawn> {
	const { seed, chunkGen, worldStorage, prewarmSpawnArea } = context;

	const cached = await worldStorage.loadWorldSpawn();
	if (cached) {
		prewarmSpawnArea(
			Math.floor(cached.x / CHUNK_SIZE),
			Math.floor(cached.z / CHUNK_SIZE),
		);
		return cached;
	}

	setTerrainSeed(seed);

	const seaLevel = GenerationParams.SEA_LEVEL;
	const playerHalfHeight = 0.9;
	const maxSearchRadius = 32;
	const treeRejectGap = 4;

	// Simple height cache so we don't recompute terrain noise repeatedly.
	const heightCache = new Map<string, number>();
	const terrainHeight = (x: number, z: number): number => {
		const key = `${x},${z}`;
		let h = heightCache.get(key);
		if (h === undefined) {
			h = Math.floor(getFinalTerrainHeight(x, z));
			heightCache.set(key, h);
		}
		return h;
	};

	const candidates: Array<{ x: number; z: number }> = [];
	for (let radius = 0; radius <= maxSearchRadius; radius++) {
		for (let ox = -radius; ox <= radius; ox++) {
			for (let oz = -radius; oz <= radius; oz++) {
				if (Math.max(Math.abs(ox), Math.abs(oz)) !== radius) continue;
				candidates.push({ x: ox * CHUNK_SIZE, z: oz * CHUNK_SIZE });
			}
		}
	}

	let chosen: { x: number; z: number } | null = null;
	let chosenBand: Array<{
		chunkX: number;
		chunkY: number;
		chunkZ: number;
	}> | null = null;
	let chosenChunkX = 0;
	let chosenChunkZ = 0;
	let chosenChunkLow = 0;
	let chosenChunkHigh = 0;

	for (const candidate of candidates) {
		const approximateGround = terrainHeight(candidate.x, candidate.z);
		if (approximateGround <= seaLevel) continue;

		let approximatelyFlat = true;
		for (const [dx, dz] of [
			[-1, 0],
			[1, 0],
			[0, -1],
			[0, 1],
		] as const) {
			if (
				Math.abs(
					terrainHeight(candidate.x + dx, candidate.z + dz) - approximateGround,
				) > 2
			) {
				approximatelyFlat = false;
				break;
			}
		}
		if (!approximatelyFlat) continue;

		const chunkX = Math.floor(candidate.x / CHUNK_SIZE);
		const chunkZ = Math.floor(candidate.z / CHUNK_SIZE);
		const chunkLow = Math.max(
			-1,
			Math.floor((approximateGround - 8) / CHUNK_SIZE),
		);
		const chunkHigh = Math.floor((approximateGround + 16) / CHUNK_SIZE);

		const band: Array<{ chunkX: number; chunkY: number; chunkZ: number }> = [];
		for (let chunkY = chunkLow; chunkY <= chunkHigh; chunkY++) {
			band.push({ chunkX, chunkY, chunkZ });
		}

		await chunkGen.generateChunksBatch(band);

		const top = chunkHigh * CHUNK_SIZE + CHUNK_SIZE - 1;
		const bottom = chunkLow * CHUNK_SIZE;

		// Parallelize the 3x3 surface queries.
		const surfaceResults = await Promise.all(
			Array.from({ length: 9 }, (_, i) => {
				const dx = (i % 3) - 1;
				const dz = Math.floor(i / 3) - 1;
				return worldStorage.getTopSolidY(
					candidate.x + dx,
					candidate.z + dz,
					top + 16,
					bottom,
				);
			}),
		);

		let invalid = false;
		const surfaces: number[] = [];

		for (let i = 0; i < surfaceResults.length; i++) {
			const surface = surfaceResults[i];
			const dx = (i % 3) - 1;
			const dz = Math.floor(i / 3) - 1;

			if (surface === -Infinity || surface <= seaLevel) {
				invalid = true;
				break;
			}

			surfaces.push(surface);

			if (
				surface - terrainHeight(candidate.x + dx, candidate.z + dz) >
				treeRejectGap
			) {
				invalid = true;
				break;
			}
		}

		if (invalid || Math.max(...surfaces) - Math.min(...surfaces) > 2) continue;

		chosen = candidate;
		chosenBand = band;
		chosenChunkX = chunkX;
		chosenChunkZ = chunkZ;
		chosenChunkLow = chunkLow;
		chosenChunkHigh = chunkHigh;
		break;
	}

	if (!chosen || !chosenBand) {
		throw new Error("Unable to find a safe world spawn above sea level");
	}

	// We already generated this band during validation, so don't generate it again.
	const surfaceResults = await Promise.all(
		Array.from({ length: 9 }, (_, i) => {
			const dx = (i % 3) - 1;
			const dz = Math.floor(i / 3) - 1;
			return worldStorage.getTopSolidY(
				chosen.x + dx,
				chosen.z + dz,
				chosenChunkHigh * CHUNK_SIZE + CHUNK_SIZE - 1,
				chosenChunkLow * CHUNK_SIZE,
			);
		}),
	);

	let surfaceY = -Infinity;
	for (const surface of surfaceResults) {
		if (surface > surfaceY) surfaceY = surface;
	}

	if (surfaceY === -Infinity) {
		throw new Error("Chosen world spawn surface could not be read");
	}

	const edits: Array<{ x: number; y: number; z: number; blockId: number }> = [];

	for (let dx = -1; dx <= 1; dx++) {
		for (let dz = -1; dz <= 1; dz++) {
			edits.push({
				x: chosen.x + dx,
				y: surfaceY + 1,
				z: chosen.z + dz,
				blockId: 1,
			});
		}
	}

	for (let y = surfaceY + 2; y <= surfaceY + 4; y++) {
		edits.push({ x: chosen.x, y, z: chosen.z, blockId: 0 });
	}

	const editsByChunk = new Map<string, typeof edits>();

	for (const edit of edits) {
		const key = `${Math.floor(edit.x / CHUNK_SIZE)},${Math.floor(edit.y / CHUNK_SIZE)},${Math.floor(edit.z / CHUNK_SIZE)}`;
		const chunkEdits = editsByChunk.get(key) ?? [];
		chunkEdits.push(edit);
		editsByChunk.set(key, chunkEdits);
	}

	await chunkGen.generateChunksBatch(
		[...editsByChunk.keys()].map((key) => {
			const [chunkX, chunkY, chunkZ] = key.split(",").map(Number);
			return { chunkX, chunkY, chunkZ };
		}),
	);

	for (const [key, chunkEdits] of editsByChunk) {
		const [chunkX, chunkY, chunkZ] = key.split(",").map(Number);
		await worldStorage.applyBlockEdits(chunkX, chunkY, chunkZ, chunkEdits);
	}

	await worldStorage.flush();

	prewarmSpawnArea(chosenChunkX, chosenChunkZ);

	const spawn = {
		x: chosen.x + 0.5,
		y: surfaceY + 2 + playerHalfHeight,
		z: chosen.z + 0.5,
		yaw: 0,
		pitch: 0,
	};

	await worldStorage.saveWorldSpawn(spawn);

	console.log(
		`[VoxelRoom] Generated world spawn at (${spawn.x}, ${spawn.y.toFixed(1)}, ${spawn.z})`,
	);
	heightCache.clear();
	return spawn;
}
