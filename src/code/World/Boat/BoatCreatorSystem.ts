import { type Vec3, vec3 } from "@babylonjs/lite";
import { CustomBoat } from "@/code/Entities/CustomBoat";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
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

type HullBounds = {
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
};

type FloodEntry = {
	x: number;
	y: number;
	z: number;
	blockId: number;
};

const LOCAL_CHUNK_PADDING = 1;
const MAX_FLOOD_BLOCKS = 8192;
const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;
const YAW_EPSILON = 0.001;

const FLOOD_DIRECTIONS: ReadonlyArray<readonly [number, number, number]> = [
	[1, 0, 0],
	[-1, 0, 0],
	[0, 1, 0],
	[0, -1, 0],
	[0, 0, 1],
	[0, 0, -1],
];

let sourceBlockIds = new Set<number>([
	6, 10, 12, 37, 41, 42, 60, 61, 62, 63, 22,
]);

let visualMode: VisualMode = "blocks";

export function setSourceBlockIds(ids: Iterable<number>): void {
	const nextIds = new Set<number>();

	for (const id of ids) {
		if (Number.isInteger(id) && id >= 0) {
			nextIds.add(id);
		}
	}

	sourceBlockIds = nextIds;
}

export function addSourceBlockId(id: number): void {
	if (Number.isInteger(id) && id >= 0) {
		sourceBlockIds.add(id);
	}
}

export function removeSourceBlockId(id: number): void {
	sourceBlockIds.delete(id);
}

export function getSourceBlockIds(): number[] {
	return Array.from(sourceBlockIds);
}

export function setVisualMode(mode: VisualMode): void {
	visualMode = mode;
}

export function tryCreateBoatFromMarker(
	player: Player,
	markerX: number,
	markerY: number,
	markerZ: number,
): CustomBoat | null {
	const hullBlocks = collectConnectedHullBlocks(markerX, markerY, markerZ);

	if (hullBlocks.length === 0) {
		return null;
	}

	const bounds = computeBounds(hullBlocks);

	if (visualMode === "blocks") {
		const padding = LOCAL_CHUNK_PADDING * 2;
		const paddedSizeX = bounds.sizeX + padding;
		const paddedSizeY = bounds.sizeY + padding;
		const paddedSizeZ = bounds.sizeZ + padding;

		if (
			paddedSizeX > Chunk.SIZE ||
			paddedSizeY > Chunk.SIZE ||
			paddedSizeZ > Chunk.SIZE
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

			return null;
		}
	}

	const initialYaw = computeForwardYaw(bounds, markerX, markerZ);

	const helmLocal = vec3(
		markerX - bounds.minX + LOCAL_CHUNK_PADDING,
		markerY - bounds.minY + LOCAL_CHUNK_PADDING,
		markerZ - bounds.minZ + LOCAL_CHUNK_PADDING,
	);

	let boatChunk: BoatChunk | undefined;

	if (visualMode === "blocks") {
		const hullCount = hullBlocks.length;
		const localBlocks = new Array<BoatChunkBlock>(hullCount + 1);

		for (let i = 0; i < hullCount; i++) {
			const block = hullBlocks[i];

			localBlocks[i] = {
				x: block.x - bounds.minX + LOCAL_CHUNK_PADDING,
				y: block.y - bounds.minY + LOCAL_CHUNK_PADDING,
				z: block.z - bounds.minZ + LOCAL_CHUNK_PADDING,
				blockId: block.blockId,
				blockState: block.blockState,
				lightLevel: block.lightLevel,
			};
		}

		localBlocks[hullCount] = {
			x: helmLocal.x,
			y: helmLocal.y,
			z: helmLocal.z,
			blockId: getBlockByWorldCoords(markerX, markerY, markerZ),
			blockState: getBlockStateByWorldCoords(markerX, markerY, markerZ),
			lightLevel: getLightByWorldCoords(markerX, markerY, markerZ),
		};

		const localCenter = vec3(
			LOCAL_CHUNK_PADDING + bounds.sizeX * 0.5,
			LOCAL_CHUNK_PADDING + bounds.sizeY * 0.5,
			LOCAL_CHUNK_PADDING + bounds.sizeZ * 0.5,
		);

		boatChunk = new BoatChunk(localBlocks, localCenter);
	}

	/*
	 * Capture everything needed above before mutating the world. This prevents
	 * a partially constructed BoatChunk from reading blocks after removal.
	 */
	for (let i = 0; i < hullBlocks.length; i++) {
		const block = hullBlocks[i];
		setBlock(block.x, block.y, block.z, BlockType.Air, 0);
	}

	setBlock(markerX, markerY, markerZ, BlockType.Air, 0);

	/*
	 * Bounds are expressed in voxel-edge coordinates, so size / 2 is the
	 * correct collision half-extent. Swap horizontal extents when the boat's
	 * initial orientation rotates its local X and Z axes by 90 degrees.
	 */
	let collisionHalfX = bounds.halfExtents.x;
	const collisionHalfY = bounds.halfExtents.y;
	let collisionHalfZ = bounds.halfExtents.z;

	const normalizedYaw = normalizeYaw(initialYaw);

	if (Math.abs(Math.abs(normalizedYaw) - HALF_PI) < YAW_EPSILON) {
		const previousX = collisionHalfX;
		collisionHalfX = collisionHalfZ;
		collisionHalfZ = previousX;
	}

	const collisionHalfExtents = vec3(
		collisionHalfX,
		collisionHalfY,
		collisionHalfZ,
	);

	return new CustomBoat(player, GenerationParams.SEA_LEVEL, bounds.center, {
		collisionHalfExtents,
		customVisualRoot: boatChunk?.visualRoot,
		skipDefaultModel: visualMode === "blocks",
		initialYaw,
		customVisualLocalYaw: -initialYaw,
		blockCount: hullBlocks.length + 1,
		boatChunk,
		helmLocal,
	});
}

function collectConnectedHullBlocks(
	markerX: number,
	markerY: number,
	markerZ: number,
): VoxelBlock[] {
	const stack: FloodEntry[] = [];
	const visited = new Set<string>();
	const blocks: VoxelBlock[] = [];

	/*
	 * Mark a coordinate visited before checking or enqueueing it. Boundary air
	 * blocks can otherwise be queried repeatedly from several hull blocks.
	 */
	const tryEnqueue = (x: number, y: number, z: number): void => {
		const key = `${x}|${y}|${z}`;

		if (visited.has(key)) {
			return;
		}

		visited.add(key);

		/*
		 * The marker is a separate helm block and must not be absorbed into
		 * the hull if its ID is also present in sourceBlockIds.
		 */
		if (x === markerX && y === markerY && z === markerZ) {
			return;
		}

		const blockId = getBlockByWorldCoords(x, y, z);

		if (!sourceBlockIds.has(blockId)) {
			return;
		}

		stack.push({ x, y, z, blockId });
	};

	for (let i = 0; i < FLOOD_DIRECTIONS.length; i++) {
		const direction = FLOOD_DIRECTIONS[i];

		tryEnqueue(
			markerX + direction[0],
			markerY + direction[1],
			markerZ + direction[2],
		);
	}

	while (stack.length > 0 && blocks.length < MAX_FLOOD_BLOCKS) {
		const current = stack.pop()!;

		blocks.push({
			x: current.x,
			y: current.y,
			z: current.z,
			blockId: current.blockId,
			blockState: getBlockStateByWorldCoords(current.x, current.y, current.z),
			lightLevel: getLightByWorldCoords(current.x, current.y, current.z),
		});

		for (let i = 0; i < FLOOD_DIRECTIONS.length; i++) {
			const direction = FLOOD_DIRECTIONS[i];

			tryEnqueue(
				current.x + direction[0],
				current.y + direction[1],
				current.z + direction[2],
			);
		}
	}

	if (stack.length > 0) {
		console.warn(
			`Boat hull flood fill reached the ${MAX_FLOOD_BLOCKS}-block limit.`,
		);
	}

	return blocks;
}

function computeBounds(blocks: readonly VoxelBlock[]): HullBounds {
	const first = blocks[0];

	let minX = first.x;
	let minY = first.y;
	let minZ = first.z;
	let maxX = first.x;
	let maxY = first.y;
	let maxZ = first.z;

	for (let i = 1; i < blocks.length; i++) {
		const block = blocks[i];

		if (block.x < minX) minX = block.x;
		else if (block.x > maxX) maxX = block.x;

		if (block.y < minY) minY = block.y;
		else if (block.y > maxY) maxY = block.y;

		if (block.z < minZ) minZ = block.z;
		else if (block.z > maxZ) maxZ = block.z;
	}

	const sizeX = maxX - minX + 1;
	const sizeY = maxY - minY + 1;
	const sizeZ = maxZ - minZ + 1;

	const halfX = sizeX * 0.5;
	const halfY = sizeY * 0.5;
	const halfZ = sizeZ * 0.5;

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
		center: vec3(minX + halfX, minY + halfY, minZ + halfZ),
		halfExtents: vec3(halfX, halfY, halfZ),
	};
}

function computeForwardYaw(
	bounds: Pick<
		HullBounds,
		"minX" | "minZ" | "maxX" | "maxZ" | "sizeX" | "sizeZ"
	>,
	markerX: number,
	markerZ: number,
): number {
	if (bounds.sizeX >= bounds.sizeZ) {
		const markerCenterX = markerX + 0.5;
		const distToMin = markerCenterX - bounds.minX;
		const distToMax = bounds.maxX + 1 - markerCenterX;

		return distToMax < distToMin ? HALF_PI : -HALF_PI;
	}

	const markerCenterZ = markerZ + 0.5;
	const distToMin = markerCenterZ - bounds.minZ;
	const distToMax = bounds.maxZ + 1 - markerCenterZ;

	return distToMax < distToMin ? 0 : Math.PI;
}

function normalizeYaw(yaw: number): number {
	let normalized = yaw % TWO_PI;

	if (normalized > Math.PI) {
		normalized -= TWO_PI;
	} else if (normalized < -Math.PI) {
		normalized += TWO_PI;
	}

	return normalized;
}
