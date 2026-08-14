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
	for (const candidate of candidates) {
		const approximateGround = Math.floor(
			getFinalTerrainHeight(candidate.x, candidate.z),
		);
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
					Math.floor(
						getFinalTerrainHeight(candidate.x + dx, candidate.z + dz),
					) - approximateGround,
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
		const band = [];
		for (let chunkY = chunkLow; chunkY <= chunkHigh; chunkY++) {
			band.push({ chunkX, chunkY, chunkZ });
		}
		await chunkGen.generateChunksBatch(band);

		const top = chunkHigh * CHUNK_SIZE + CHUNK_SIZE - 1;
		const bottom = chunkLow * CHUNK_SIZE;
		const surfaces: number[] = [];
		let invalid = false;
		for (let dx = -1; dx <= 1 && !invalid; dx++) {
			for (let dz = -1; dz <= 1; dz++) {
				const surface = await worldStorage.getTopSolidY(
					candidate.x + dx,
					candidate.z + dz,
					top + 16,
					bottom,
				);
				if (surface === -Infinity || surface <= seaLevel) {
					invalid = true;
					break;
				}
				surfaces.push(surface);
				if (
					surface -
						Math.floor(
							getFinalTerrainHeight(candidate.x + dx, candidate.z + dz),
						) >
					treeRejectGap
				) {
					invalid = true;
					break;
				}
			}
		}
		if (invalid || Math.max(...surfaces) - Math.min(...surfaces) > 2) continue;
		chosen = candidate;
		break;
	}

	if (!chosen) {
		throw new Error("Unable to find a safe world spawn above sea level");
	}

	const approximateGround = Math.floor(
		getFinalTerrainHeight(chosen.x, chosen.z),
	);
	const chunkX = Math.floor(chosen.x / CHUNK_SIZE);
	const chunkZ = Math.floor(chosen.z / CHUNK_SIZE);
	const chunkLow = Math.max(
		-1,
		Math.floor((approximateGround - 8) / CHUNK_SIZE),
	);
	const chunkHigh = Math.floor((approximateGround + 16) / CHUNK_SIZE);
	const band = [];
	for (let chunkY = chunkLow; chunkY <= chunkHigh; chunkY++) {
		band.push({ chunkX, chunkY, chunkZ });
	}
	await chunkGen.generateChunksBatch(band);

	let surfaceY = -Infinity;
	for (let dx = -1; dx <= 1; dx++) {
		for (let dz = -1; dz <= 1; dz++) {
			const surface = await worldStorage.getTopSolidY(
				chosen.x + dx,
				chosen.z + dz,
				chunkHigh * CHUNK_SIZE + CHUNK_SIZE - 1,
				chunkLow * CHUNK_SIZE,
			);
			if (surface > surfaceY) surfaceY = surface;
		}
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
	prewarmSpawnArea(chunkX, chunkZ);

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
	return spawn;
}
