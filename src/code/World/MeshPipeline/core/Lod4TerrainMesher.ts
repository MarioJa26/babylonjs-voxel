import { unpackBlockId } from "../../Chunk/DataStructures/BlockEncoding";
import {
	BLOCK_TYPE,
	BLOCK_TYPE_TRANSPARENT,
	POS_SCALE,
} from "../../Chunk/Worker/ChunkMesherConstants";
import {
	type GreedyFaceDescriptor,
	MaterialType,
	type MeshContext,
	type WorkerInternalMeshData,
} from "../types/MeshTypes";
import { COLOR_PALETTE, getBlockColorIndex } from "./BlockColorPalette";

const SUPER_BLOCK_SIZES = [1, 1, 1, 1, 2, 4, 8];

const BACK_FACE_MASK = 0x80000000;
const PACKED_ID_STATE_MASK = 0x0000ffff;

const LIGHT_QUANTIZE_MASK = 0xc0;

type WritableNumberArray = number[] | Int32Array | Uint16Array | Uint32Array;

let SCRATCH_MASK = new Int32Array(0);
let SCRATCH_LIGHTS = new Uint16Array(0);

function ensureScratchCapacity(area: number): {
	mask: Int32Array;
	lights: Uint16Array;
} {
	if (SCRATCH_MASK.length < area) {
		SCRATCH_MASK = new Int32Array(area);
	}
	if (SCRATCH_LIGHTS.length < area) {
		SCRATCH_LIGHTS = new Uint16Array(area);
	}
	return { mask: SCRATCH_MASK, lights: SCRATCH_LIGHTS };
}

function getSuperBlockSize(lod: number): number {
	if (lod < 0 || lod >= SUPER_BLOCK_SIZES.length) return 1;
	return SUPER_BLOCK_SIZES[lod];
}

function isWaterGlass(packed: number): boolean {
	if (!packed) return false;
	const blockId = unpackBlockId(packed);
	return BLOCK_TYPE[blockId] === BLOCK_TYPE_TRANSPARENT;
}

function createTerrainSuperBlockContext(
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

		sampleSuperBlock(x, y, z, (bx, by, bz) => {
			const value = originalCtx.getLight(bx, by, bz, 0);
			if (value > maxLight) {
				maxLight = value;
			}
			return value;
		});

		if (maxLight !== 0) {
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

function terrainGreedyMesh(
	ctx: MeshContext,
	extractMask: (
		slice: number,
		mask: WritableNumberArray,
		light: WritableNumberArray,
	) => void,
	emitFace: (desc: GreedyFaceDescriptor) => void,
): void {
	const size = ctx.size;
	const area = size * size;
	const sliceStart = -1;

	const scratch = ensureScratchCapacity(area);
	const mask = scratch.mask;
	const lights = scratch.lights;

	for (let slice = sliceStart; slice < size; slice++) {
		extractMask(slice, mask, lights);

		for (let v = 0; v < size; v++) {
			const rowBase = v * size;

			for (let u = 0; u < size; ) {
				const index = rowBase + u;
				const idState = mask[index];

				if (idState === 0) {
					u++;
					continue;
				}

				const light = lights[index];
				const quantizedLight = light & LIGHT_QUANTIZE_MASK;

				let width = 1;
				while (u + width < size) {
					const idx = index + width;
					if (
						mask[idx] !== idState ||
						(lights[idx] & LIGHT_QUANTIZE_MASK) !== quantizedLight
					) {
						break;
					}
					width++;
				}

				let height = 1;
				outer: while (v + height < size) {
					const testRowBase = index + height * size;
					for (let k = 0; k < width; k++) {
						const idx = testRowBase + k;
						if (
							mask[idx] !== idState ||
							(lights[idx] & LIGHT_QUANTIZE_MASK) !== quantizedLight
						) {
							break outer;
						}
					}
					height++;
				}

				emitFace({
					slice,
					uStart: u,
					vStart: v,
					width,
					height,
					idState,
					light,
				});

				for (let dv = 0; dv < height; dv++) {
					const clearRowBase = index + dv * size;
					mask.fill(0, clearRowBase, clearRowBase + width);
					lights.fill(0, clearRowBase, clearRowBase + width);
				}

				u += width;
			}
		}
	}
}

function extractTerrainSliceMaskX(
	ctx: MeshContext,
	slice: number,
	mask: WritableNumberArray,
	lightMask: WritableNumberArray,
): void {
	const size = ctx.size;
	const dx = 1;
	const dy = 0;
	const dz = 0;
	const uAxis = 1;
	const vAxis = 2;

	let idx = 0;

	for (let v = 0; v < size; v++) {
		for (let u = 0; u < size; u++) {
			const bx = slice;
			const by = u;
			const bz = v;

			const nx = bx + dx;
			const ny = by + dy;
			const nz = bz + dz;

			const currentPacked = ctx.getBlock(bx, by, bz, 0);
			const neighborPacked = ctx.getBlock(nx, ny, nz, 0);

			if (!currentPacked && !neighborPacked) {
				mask[idx] = 0;
				lightMask[idx] = 0;
				idx++;
				continue;
			}

			const currSolid = currentPacked !== 0;
			const nbrSolid = neighborPacked !== 0;

			if (!currSolid && !nbrSolid) {
				mask[idx] = 0;
				lightMask[idx] = 0;
				idx++;
				continue;
			}

			const currTransparent = isWaterGlass(currentPacked);
			const nbrTransparent = isWaterGlass(neighborPacked);

			let preserveInterface = 0;
			if (
				currSolid &&
				nbrSolid &&
				currTransparent &&
				nbrTransparent &&
				unpackBlockId(currentPacked) !== unpackBlockId(neighborPacked)
			) {
				preserveInterface = 1;
			}

			if (!preserveInterface && currSolid && nbrSolid) {
				mask[idx] = 0;
				lightMask[idx] = 0;
				idx++;
				continue;
			}

			const currLight = ctx.getLight(bx, by, bz, 0);
			const nbrLight = ctx.getLight(nx, ny, nz, currLight);
			const maxLight = currLight > nbrLight ? currLight : nbrLight;
			const packedLightOnly = maxLight & 0xff;

			let packedMask = 0;

			if (currSolid) {
				packedMask = currentPacked & PACKED_ID_STATE_MASK;
			} else {
				packedMask = (neighborPacked & PACKED_ID_STATE_MASK) | BACK_FACE_MASK;
			}

			mask[idx] = packedMask;
			lightMask[idx] = packedLightOnly;

			idx++;
		}
	}
}

function extractTerrainSliceMaskY(
	ctx: MeshContext,
	slice: number,
	mask: WritableNumberArray,
	lightMask: WritableNumberArray,
): void {
	const size = ctx.size;
	const dx = 0;
	const dy = 1;
	const dz = 0;
	const uAxis = 2;
	const vAxis = 0;

	let idx = 0;

	for (let v = 0; v < size; v++) {
		for (let u = 0; u < size; u++) {
			const bx = v;
			const by = slice;
			const bz = u;

			const nx = bx + dx;
			const ny = by + dy;
			const nz = bz + dz;

			const currentPacked = ctx.getBlock(bx, by, bz, 0);
			const neighborPacked = ctx.getBlock(nx, ny, nz, 0);

			if (!currentPacked && !neighborPacked) {
				mask[idx] = 0;
				lightMask[idx] = 0;
				idx++;
				continue;
			}

			const currSolid = currentPacked !== 0;
			const nbrSolid = neighborPacked !== 0;

			if (!currSolid && !nbrSolid) {
				mask[idx] = 0;
				lightMask[idx] = 0;
				idx++;
				continue;
			}

			const currTransparent = isWaterGlass(currentPacked);
			const nbrTransparent = isWaterGlass(neighborPacked);

			let preserveInterface = 0;
			if (
				currSolid &&
				nbrSolid &&
				currTransparent &&
				nbrTransparent &&
				unpackBlockId(currentPacked) !== unpackBlockId(neighborPacked)
			) {
				preserveInterface = 1;
			}

			if (!preserveInterface && currSolid && nbrSolid) {
				mask[idx] = 0;
				lightMask[idx] = 0;
				idx++;
				continue;
			}

			const currLight = ctx.getLight(bx, by, bz, 0);
			const nbrLight = ctx.getLight(nx, ny, nz, currLight);
			const maxLight = currLight > nbrLight ? currLight : nbrLight;
			const packedLightOnly = maxLight & 0xff;

			let packedMask = 0;

			if (currSolid) {
				packedMask = currentPacked & PACKED_ID_STATE_MASK;
			} else {
				packedMask = (neighborPacked & PACKED_ID_STATE_MASK) | BACK_FACE_MASK;
			}

			mask[idx] = packedMask;
			lightMask[idx] = packedLightOnly;

			idx++;
		}
	}
}

function extractTerrainSliceMaskZ(
	ctx: MeshContext,
	slice: number,
	mask: WritableNumberArray,
	lightMask: WritableNumberArray,
): void {
	const size = ctx.size;
	const dx = 0;
	const dy = 0;
	const dz = 1;
	const uAxis = 0;
	const vAxis = 1;

	let idx = 0;

	for (let v = 0; v < size; v++) {
		for (let u = 0; u < size; u++) {
			const bx = u;
			const by = v;
			const bz = slice;

			const nx = bx + dx;
			const ny = by + dy;
			const nz = bz + dz;

			const currentPacked = ctx.getBlock(bx, by, bz, 0);
			const neighborPacked = ctx.getBlock(nx, ny, nz, 0);

			if (!currentPacked && !neighborPacked) {
				mask[idx] = 0;
				lightMask[idx] = 0;
				idx++;
				continue;
			}

			const currSolid = currentPacked !== 0;
			const nbrSolid = neighborPacked !== 0;

			if (!currSolid && !nbrSolid) {
				mask[idx] = 0;
				lightMask[idx] = 0;
				idx++;
				continue;
			}

			const currTransparent = isWaterGlass(currentPacked);
			const nbrTransparent = isWaterGlass(neighborPacked);

			let preserveInterface = 0;
			if (
				currSolid &&
				nbrSolid &&
				currTransparent &&
				nbrTransparent &&
				unpackBlockId(currentPacked) !== unpackBlockId(neighborPacked)
			) {
				preserveInterface = 1;
			}

			if (!preserveInterface && currSolid && nbrSolid) {
				mask[idx] = 0;
				lightMask[idx] = 0;
				idx++;
				continue;
			}

			const currLight = ctx.getLight(bx, by, bz, 0);
			const nbrLight = ctx.getLight(nx, ny, nz, currLight);
			const maxLight = currLight > nbrLight ? currLight : nbrLight;
			const packedLightOnly = maxLight & 0xff;

			let packedMask = 0;

			if (currSolid) {
				packedMask = currentPacked & PACKED_ID_STATE_MASK;
			} else {
				packedMask = (neighborPacked & PACKED_ID_STATE_MASK) | BACK_FACE_MASK;
			}

			mask[idx] = packedMask;
			lightMask[idx] = packedLightOnly;

			idx++;
		}
	}
}

function emitTerrainQuad(
	out: WorkerInternalMeshData,
	x: number,
	y: number,
	z: number,
	axis: number,
	width: number,
	height: number,
	blockId: number,
	isBackFace: boolean,
	light: number,
	materialType: MaterialType,
): void {
	const colorIndex = getBlockColorIndex(blockId);
	const axisFace = axis * 2 + (isBackFace ? 1 : 0);

	const sx = Math.round(x * POS_SCALE);
	const sy = Math.round(y * POS_SCALE);
	const sz = Math.round(z * POS_SCALE);
	const sw = Math.round(width * POS_SCALE);
	const sh = Math.round(height * POS_SCALE);

	out.faceDataA.push4(sx, sy, sz, axisFace);
	out.faceDataB.push4(sw, sh, colorIndex, 0);

	const meta = (materialType & 0x3) << 1;
	out.faceDataC.push4(0, light, 0, meta);

	out.faceCount++;
}

function emitTerrainCubeFace(
	out: WorkerInternalMeshData,
	axis: number,
	desc: GreedyFaceDescriptor,
	blockId: number,
	materialType: MaterialType,
	isBackFace: boolean,
	light: number,
): void {
	const faceBlockCoord = isBackFace ? desc.slice + 1 : desc.slice;

	let ox: number;
	let oy: number;
	let oz: number;

	if (axis === 0) {
		ox = faceBlockCoord + (isBackFace ? 0 : 1);
		oy = desc.uStart;
		oz = desc.vStart;
	} else if (axis === 1) {
		ox = desc.vStart;
		oy = faceBlockCoord + (isBackFace ? 0 : 1);
		oz = desc.uStart;
	} else {
		ox = desc.uStart;
		oy = desc.vStart;
		oz = faceBlockCoord + (isBackFace ? 0 : 1);
	}

	emitTerrainQuad(
		out,
		ox,
		oy,
		oz,
		axis,
		desc.width,
		desc.height,
		blockId,
		isBackFace,
		light,
		materialType,
	);
}

function processTerrainFace(
	axis: number,
	desc: GreedyFaceDescriptor,
	opaqueOut: WorkerInternalMeshData,
	transparentOut: WorkerInternalMeshData,
): void {
	const rawMask = desc.idState | 0;
	const isBackFace = (rawMask & BACK_FACE_MASK) !== 0;
	const packedBlock = rawMask & PACKED_ID_STATE_MASK;

	if (!packedBlock) {
		return;
	}

	const blockId = unpackBlockId(packedBlock);
	const light = desc.light;

	emitTerrainCubeFace(
		opaqueOut,
		axis,
		desc,
		blockId,
		MaterialType.Default,
		isBackFace,
		light,
	);
}

function scaleMeshCoordinates(
	meshData: WorkerInternalMeshData,
	factor: number,
): void {
	if (factor <= 1) return;

	const stride = 4;

	{
		const arr = (meshData.faceDataA as any).array as Uint8Array;
		const len = meshData.faceDataA.length;
		for (let i = 0; i < len; i += stride) {
			arr[i + 0] = Math.min(255, arr[i + 0] * factor);
			arr[i + 1] = Math.min(255, arr[i + 1] * factor);
			arr[i + 2] = Math.min(255, arr[i + 2] * factor);
		}
	}

	{
		const arr = (meshData.faceDataB as any).array as Uint8Array;
		const len = meshData.faceDataB.length;
		for (let i = 0; i < len; i += stride) {
			arr[i + 0] = Math.min(255, arr[i + 0] * factor);
			arr[i + 1] = Math.min(255, arr[i + 1] * factor);
		}
	}
}

export function buildLod4TerrainMesh(
	originalCtx: MeshContext,
	lod: number,
	opaqueOut: WorkerInternalMeshData,
	transparentOut: WorkerInternalMeshData,
): void {
	const superSize = getSuperBlockSize(lod);
	const terrainCtx = createTerrainSuperBlockContext(originalCtx, lod);

	for (let axis = 0; axis < 3; axis++) {
		let extractMask: (
			slice: number,
			mask: WritableNumberArray,
			light: WritableNumberArray,
		) => void;

		if (axis === 0) {
			extractMask = (slice, maskBuf, lightBuf) =>
				extractTerrainSliceMaskX(terrainCtx, slice, maskBuf, lightBuf);
		} else if (axis === 1) {
			extractMask = (slice, maskBuf, lightBuf) =>
				extractTerrainSliceMaskY(terrainCtx, slice, maskBuf, lightBuf);
		} else {
			extractMask = (slice, maskBuf, lightBuf) =>
				extractTerrainSliceMaskZ(terrainCtx, slice, maskBuf, lightBuf);
		}

		const emitFace = (desc: GreedyFaceDescriptor) => {
			processTerrainFace(axis, desc, opaqueOut, transparentOut);
		};

		terrainGreedyMesh(terrainCtx, extractMask, emitFace);
	}

	scaleMeshCoordinates(opaqueOut, superSize);
	scaleMeshCoordinates(transparentOut, superSize);
}

export { COLOR_PALETTE };
