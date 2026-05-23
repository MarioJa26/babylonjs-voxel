import { Chunk } from "../Chunk/Chunk";

export const BRICK_RESOLUTION = 32;
export const BRICK_POOL_SIZE =
	BRICK_RESOLUTION * BRICK_RESOLUTION * BRICK_RESOLUTION;
export const REGION_CHUNK_EXTENT = 8;
export const REGION_VOXEL_SIZE = Chunk.SIZE * REGION_CHUNK_EXTENT;
export const MAX_BRICKS = 1024;

export type RegionKey = string;

export function makeRegionKey(rx: number, ry: number, rz: number): RegionKey {
	return `${rx},${ry},${rz}`;
}

export function parseRegionKey(key: RegionKey): [number, number, number] {
	const parts = key.split(",");
	return [parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2])];
}

export function worldToRegionCoord(
	worldX: number,
	worldY: number,
	worldZ: number,
): [number, number, number] {
	const rx = Math.floor(worldX / REGION_VOXEL_SIZE);
	const ry = Math.floor(worldY / REGION_VOXEL_SIZE);
	const rz = Math.floor(worldZ / REGION_VOXEL_SIZE);
	return [rx, ry, rz];
}

export function regionToWorldMin(
	rx: number,
	ry: number,
	rz: number,
): [number, number, number] {
	return [
		rx * REGION_VOXEL_SIZE,
		ry * REGION_VOXEL_SIZE,
		rz * REGION_VOXEL_SIZE,
	];
}

export class VoxelImpostorRegion {
	public readonly key: RegionKey;
	public readonly rx: number;
	public readonly ry: number;
	public readonly rz: number;
	public readonly worldMinX: number;
	public readonly worldMinY: number;
	public readonly worldMinZ: number;
	public readonly worldMaxX: number;
	public readonly worldMaxY: number;
	public readonly worldMaxZ: number;

	public brickIndex = -1;
	public isDirty = true;
	public isLoaded = false;
	public lastUpdateMs = 0;
	public dist = 0;

	public voxelData: Uint8Array | null = null;

	constructor(rx: number, ry: number, rz: number) {
		this.rx = rx;
		this.ry = ry;
		this.rz = rz;
		this.key = makeRegionKey(rx, ry, rz);

		const [wx, wy, wz] = regionToWorldMin(rx, ry, rz);
		this.worldMinX = wx;
		this.worldMinY = wy;
		this.worldMinZ = wz;
		this.worldMaxX = wx + REGION_VOXEL_SIZE;
		this.worldMaxY = wy + REGION_VOXEL_SIZE;
		this.worldMaxZ = wz + REGION_VOXEL_SIZE;
	}

	public get centerWorld(): [number, number, number] {
		return [
			this.worldMinX + REGION_VOXEL_SIZE * 0.5,
			this.worldMinY + REGION_VOXEL_SIZE * 0.5,
			this.worldMinZ + REGION_VOXEL_SIZE * 0.5,
		];
	}

	public allocateVoxelData(): Uint8Array {
		if (!this.voxelData) {
			this.voxelData = new Uint8Array(BRICK_POOL_SIZE);
		}
		return this.voxelData;
	}
}
