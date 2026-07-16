import { addVec3ToRef, type Vec3, vec3 } from "@babylonjs/lite";
import { CustomBoat } from "@/code/Entities/CustomBoat";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { Map1 } from "@/code/Maps/Map1";
import type { Player } from "@/code/Player/Player";
import { BoatChunk, type BoatChunkBlock } from "@/code/World/Boat/BoatChunk";
import { Chunk } from "@/code/World/Chunk/Chunk";
import {
	getBlockByWorldCoords,
	getBlockStateByWorldCoords,
	getLightByWorldCoords,
	setBlock,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import { BlockType } from "@/code/World/Texture/BlockType";

type VoxelBlock = {
	x: number;
	y: number;
	z: number;
	blockId: number;
	blockState: number;
	lightLevel: number;
};

type VisualMode = "blocks" | "aabb";

const LOCAL_CHUNK_PADDING = 1;
const FLOOD_DIRECTIONS: ReadonlyArray<[number, number, number]> = [
	[1, 0, 0],
	[-1, 0, 0],
	[0, 1, 0],
	[0, -1, 0],
	[0, 0, 1],
	[0, 0, -1],
];

// Expand this set with any additional block IDs that should be treated as hull.
let sourceBlockIds = new Set<number>([6, 10, 12, 37, 41, 42, 60, 61, 22]);
const maxFloodBlocks = 8192;
let visualMode: VisualMode = "blocks";

export function setSourceBlockIds(ids: Iterable<number>): void {
	sourceBlockIds = new Set<number>();
	for (const id of ids) {
		if (Number.isInteger(id) && id >= 0) sourceBlockIds.add(id);
	}
}

export function addSourceBlockId(id: number): void {
	if (!Number.isInteger(id) || id < 0) return;
	sourceBlockIds.add(id);
}

export function removeSourceBlockId(id: number): void {
	sourceBlockIds.delete(id);
}

export function getSourceBlockIds(): number[] {
	return [...sourceBlockIds.values()];
}

export function setVisualMode(mode: VisualMode): void {
	visualMode = mode;
}

export function tryCreateBoatFromMarker(
	player: Player,
	markerX: number,
	markerY: number,
	markerZ: number,
): boolean {
	const hullBlocks = collectConnectedHullBlocks(markerX, markerY, markerZ);
	if (hullBlocks.length === 0) return false;

	const bounds = computeBounds(hullBlocks);
	const paddedSizeX = bounds.sizeX + LOCAL_CHUNK_PADDING * 2;
	const paddedSizeY = bounds.sizeY + LOCAL_CHUNK_PADDING * 2;
	const paddedSizeZ = bounds.sizeZ + LOCAL_CHUNK_PADDING * 2;
	if (
		visualMode === "blocks" &&
		(paddedSizeX > Chunk.SIZE ||
			paddedSizeY > Chunk.SIZE ||
			paddedSizeZ > Chunk.SIZE)
	) {
		console.warn(
			"Boat creator hull exceeds single chunk size and cannot be converted yet.",
			{
				sizeX: bounds.sizeX,
				sizeY: bounds.sizeY,
				sizeZ: bounds.sizeZ,
				paddedSizeX,
				paddedSizeY,
				paddedSizeZ,
				max: Chunk.SIZE,
			},
		);
		return false;
	}

	const center = bounds.center;
	const initialYaw = computeForwardYaw(bounds, markerX, markerZ);

	let hx = bounds.sizeX * 0.5;
	const hy = bounds.sizeY * 0.5;
	let hz = bounds.sizeZ * 0.5;

	const yaw = initialYaw % (Math.PI * 2);

	// If yaw is ±90° → swap X and Z extents
	if (
		Math.abs(yaw - Math.PI / 2) < 0.001 ||
		Math.abs(yaw + Math.PI / 2) < 0.001
	) {
		[hx, hz] = [hz, hx];
	}

	const halfExtents = vec3(hx, hy, hz);

	const scene = Map1.mainScene;

	let boatChunk: BoatChunk | undefined;
	if (visualMode === "blocks") {
		const localBlocks: BoatChunkBlock[] = hullBlocks.map((block) => ({
			x: block.x - bounds.minX + LOCAL_CHUNK_PADDING,
			y: block.y - bounds.minY + LOCAL_CHUNK_PADDING,
			z: block.z - bounds.minZ + LOCAL_CHUNK_PADDING,
			blockId: block.blockId,
			blockState: block.blockState,
			lightLevel: block.lightLevel,
		}));
		const localCenter = vec3(
			LOCAL_CHUNK_PADDING + bounds.sizeX * 0.5,
			LOCAL_CHUNK_PADDING + bounds.sizeY * 0.5,
			LOCAL_CHUNK_PADDING + bounds.sizeZ * 0.5,
		);
		boatChunk = new BoatChunk(scene, localBlocks, localCenter);
	}

	const customVisual = boatChunk?.visualRoot;

	// Consume source blocks and the marker block from the world.
	for (const block of hullBlocks) {
		setBlock(block.x, block.y, block.z, BlockType.Air, 0);
	}
	setBlock(markerX, markerY, markerZ, BlockType.Air, 0);

	const paddedHalfExtents = vec3(0, 0, 0);
	addVec3ToRef(center, vec3(0.5, 0.5, 0.5), paddedHalfExtents);
	new CustomBoat(scene, player, GenerationParams.SEA_LEVEL, center, {
		collisionHalfExtents: paddedHalfExtents,
		customVisualRoot: customVisual,
		skipDefaultModel: visualMode === "blocks",
		initialYaw,
		customVisualLocalYaw: -initialYaw,
		blockCount: hullBlocks.length,
		boatChunk,
	});

	return true;
}

function collectConnectedHullBlocks(
	markerX: number,
	markerY: number,
	markerZ: number,
): VoxelBlock[] {
	const queue: Array<{ x: number; y: number; z: number }> = [];
	const visited = new Set<string>();
	const out: VoxelBlock[] = [];

	for (const [dx, dy, dz] of FLOOD_DIRECTIONS) {
		const nx = markerX + dx;
		const ny = markerY + dy;
		const nz = markerZ + dz;
		const neighborId = getBlockByWorldCoords(nx, ny, nz);
		if (!sourceBlockIds.has(neighborId)) continue;
		queue.push({ x: nx, y: ny, z: nz });
	}

	while (queue.length > 0 && out.length < maxFloodBlocks) {
		const current = queue.pop()!;
		const key = `${current.x}|${current.y}|${current.z}`;
		if (visited.has(key)) continue;
		visited.add(key);

		const blockId = getBlockByWorldCoords(current.x, current.y, current.z);
		if (!sourceBlockIds.has(blockId)) continue;

		const blockState = getBlockStateByWorldCoords(
			current.x,
			current.y,
			current.z,
		);
		const lightLevel = getLightByWorldCoords(current.x, current.y, current.z);

		out.push({
			x: current.x,
			y: current.y,
			z: current.z,
			blockId,
			blockState,
			lightLevel,
		});

		for (const [dx, dy, dz] of FLOOD_DIRECTIONS) {
			queue.push({
				x: current.x + dx,
				y: current.y + dy,
				z: current.z + dz,
			});
		}
	}

	return out;
}

function computeBounds(blocks: VoxelBlock[]): {
	minX: number;
	minY: number;
	minZ: number;
	maxX: number;
	maxY: number;
	maxZ: number;
	sizeX: number;
	sizeY: number;
	sizeZ: number;
	center: Vec3;
	halfExtents: Vec3;
} {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let minZ = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let maxZ = Number.NEGATIVE_INFINITY;

	for (const block of blocks) {
		if (block.x < minX) minX = block.x;
		if (block.y < minY) minY = block.y;
		if (block.z < minZ) minZ = block.z;
		if (block.x > maxX) maxX = block.x;
		if (block.y > maxY) maxY = block.y;
		if (block.z > maxZ) maxZ = block.z;
	}

	const sizeX = maxX - minX + 1;
	const sizeY = maxY - minY + 1;
	const sizeZ = maxZ - minZ + 1;

	const halfExtents = vec3(sizeX * 0.5, sizeY * 0.5, sizeZ * 0.5);
	const center = vec3(
		minX + halfExtents.x,
		minY + halfExtents.y,
		minZ + halfExtents.z,
	);

	return {
		minX,
		minY,
		minZ,
		maxX,
		maxY,
		maxZ,
		sizeX,
		sizeY,
		sizeZ,
		center,
		halfExtents,
	};
}

function computeForwardYaw(
	bounds: {
		minX: number;
		minZ: number;
		maxX: number;
		maxZ: number;
		sizeX: number;
		sizeZ: number;
	},
	markerX: number,
	markerZ: number,
): number {
	// Long-side axis decides orientation axis, marker proximity to short edge
	// decides forward sign. Tie-breaker: prefer X axis and min edge.
	const useXAxis = bounds.sizeX >= bounds.sizeZ;

	if (useXAxis) {
		const markerCenterX = markerX + 0.5;
		const minEdge = bounds.minX;
		const maxEdge = bounds.maxX + 1;
		const distToMin = Math.abs(markerCenterX - minEdge);
		const distToMax = Math.abs(maxEdge - markerCenterX);
		const forwardPositiveX = distToMax < distToMin;
		return forwardPositiveX ? Math.PI * 0.5 : -Math.PI * 0.5;
	}

	const markerCenterZ = markerZ + 0.5;
	const minEdge = bounds.minZ;
	const maxEdge = bounds.maxZ + 1;
	const distToMin = Math.abs(markerCenterZ - minEdge);
	const distToMax = Math.abs(maxEdge - markerCenterZ);
	const forwardPositiveZ = distToMax < distToMin;
	return forwardPositiveZ ? 0 : Math.PI;
}
