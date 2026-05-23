import type { MeshContext, WorkerInternalMeshData } from "../types/MeshTypes";
import { SuperBlockFaceEmitter } from "./VoxelFaceEmitterAdapter";
import { VoxelPipeline } from "./VoxelPipeline";

const SUPER_BLOCK_SIZES = [1, 1, 1, 1, 2, 4, 8];

function getSuperBlockSize(lod: number): number {
	if (lod < 0 || lod >= SUPER_BLOCK_SIZES.length) return 1;
	return SUPER_BLOCK_SIZES[lod];
}

function createSuperBlockContext(
	originalCtx: MeshContext,
	lod: number,
): MeshContext {
	const superSize = getSuperBlockSize(lod);
	const originalSize = originalCtx.size;
	const reducedSize = Math.ceil(originalSize / superSize);

	const sampleSuperBlock = (
		x: number,
		y: number,
		z: number,
		reader: (bx: number, by: number, bz: number) => number,
	): number => {
		const worldX = x * superSize;
		const worldY = y * superSize;
		const worldZ = z * superSize;

		for (let dx = 0; dx < superSize; dx++) {
			for (let dy = 0; dy < superSize; dy++) {
				for (let dz = 0; dz < superSize; dz++) {
					const sample = reader(worldX + dx, worldY + dy, worldZ + dz);
					if (sample !== 0) {
						return sample;
					}
				}
			}
		}

		return 0;
	};

	const getBlock = (x: number, y: number, z: number, fallback = 0): number => {
		const id = sampleSuperBlock(x, y, z, (bx, by, bz) =>
			originalCtx.getBlock(bx, by, bz, 0),
		);
		return id !== 0 ? id : fallback;
	};

	const getLight = (x: number, y: number, z: number, fallback = 0): number => {
		let maxLight = 0;

		const light = sampleSuperBlock(x, y, z, (bx, by, bz) => {
			const value = originalCtx.getLight(bx, by, bz, 0);
			if (value > maxLight) {
				maxLight = value;
			}
			return value;
		});

		if (light !== 0 || maxLight !== 0) {
			return maxLight;
		}

		return fallback;
	};

	return {
		size: reducedSize,
		lod,
		disableAO: true,
		getBlock,
		getLight,
		hasNeighborChunk: (dx, dy, dz) => originalCtx.hasNeighborChunk(dx, dy, dz),
	};
}

function scaleMeshCoordinates(
	meshData: WorkerInternalMeshData,
	factor: number,
): void {
	if (factor <= 1) return;

	const stride = 4;

	// faceDataA: [x, y, z, axisFace]
	// Scale x/y/z only — axisFace must not be touched
	{
		const arr = (meshData.faceDataA as any).array as Uint8Array;
		const len = meshData.faceDataA.length;
		for (let i = 0; i < len; i += stride) {
			arr[i + 0] = Math.min(255, arr[i + 0] * factor);
			arr[i + 1] = Math.min(255, arr[i + 1] * factor);
			arr[i + 2] = Math.min(255, arr[i + 2] * factor);
			// arr[i + 3] = axisFace — unchanged
		}
	}

	// faceDataB: [width, height, uvX, uvY]
	// Scale width/height only — uvX/uvY are texture coords, must not be touched
	{
		const arr = (meshData.faceDataB as any).array as Uint8Array;
		const len = meshData.faceDataB.length;
		for (let i = 0; i < len; i += stride) {
			arr[i + 0] = Math.min(255, arr[i + 0] * factor);
			arr[i + 1] = Math.min(255, arr[i + 1] * factor);
			// arr[i + 2] = uvX — unchanged
			// arr[i + 3] = uvY — unchanged
		}
	}
}

export function buildSuperBlockMesh(
	originalCtx: MeshContext,
	lod: number,
	opaqueOut: WorkerInternalMeshData,
	transparentOut: WorkerInternalMeshData,
): void {
	const superSize = getSuperBlockSize(lod);
	const superCtx = createSuperBlockContext(originalCtx, lod);
	const faceEmitter = new SuperBlockFaceEmitter(superSize);
	const pipeline = new VoxelPipeline(superCtx, faceEmitter);
	pipeline.build(opaqueOut, transparentOut);
	scaleMeshCoordinates(opaqueOut, superSize);
	scaleMeshCoordinates(transparentOut, superSize);
}
