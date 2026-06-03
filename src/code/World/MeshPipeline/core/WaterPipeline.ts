// MeshPipeline/core/WaterPipeline.ts

import { WATER_BLOCK_ID } from "../../Chunk/Worker/ChunkMesherConstants";
import { FaceName } from "../../Texture/FaceName";
import {
	MaterialType,
	type MeshContext,
	type WorkerInternalMeshData,
} from "../types/MeshTypes";
import { emitQuad } from "./FaceEmitter";

/**
 * Water cell sample used for LOD water surface merging.
 */
export interface WaterSurfaceSample {
	worldX: number;
	worldY: number;
	worldZ: number;
	width: number; // cells in X-local
	depth: number; // cells in Z-local
	packedLight: number;
}

/**
 * Water sample grid passed in from a worker's precomputation.
 */
export interface WaterSampleGrid {
	samples: Array<WaterSurfaceSample | null>;
	cellsX: number;
	cellsY: number;
	cellsZ: number;
	step: number;
	chunkSize: number;
	hasAnyWaterSurface: boolean;
}

/**
 * Build a merged water-surface mesh using greedy merging on top faces.
 *
 * IMPORTANT:
 * - Water uses the transparent render path
 * - Water top faces should use the "top" texture face
 * - We do NOT hardcode texX/texY anymore; FaceEmitter resolves atlas tiles
 */

// PERF: Version-stamp tracking array — reused across builds to avoid
// allocating + zeroing a new Uint8Array per water mesh build.
let _waterUsedStamp: Uint8Array | null = null;
let _waterVersion = 0;

export function buildWaterMesh(
	_ctx: MeshContext,
	grid: WaterSampleGrid,
	out: WorkerInternalMeshData,
): void {
	if (!grid.hasAnyWaterSurface) return;

	const { samples, cellsX, cellsY, cellsZ } = grid;

	// PERF: Use version stamp instead of allocating + zeroing a Uint8Array per build.
	// Each build increments the stamp; cells are "used" if their stamp matches.
	if (!_waterUsedStamp || _waterUsedStamp.length < samples.length) {
		_waterUsedStamp = new Uint8Array(samples.length);
	}
	_waterVersion++;
	const version = _waterVersion;
	const used = _waterUsedStamp;

	for (let cellY = 0; cellY < cellsY; cellY++) {
		for (let cellZ = 0; cellZ < cellsZ; cellZ++) {
			for (let cellX = 0; cellX < cellsX; cellX++) {
				const idx = cellX + cellZ * cellsX + cellY * cellsX * cellsZ;
				if (used[idx] === version) continue;

				const baseSample = samples[idx];
				if (!baseSample) continue;

				const baseY = baseSample.worldY;
				const baseLight = baseSample.packedLight;
				const baseWidth = baseSample.width;
				const baseDepth = baseSample.depth;

				// ---------------------------------
				// Merge across X in coarse grid space
				// ---------------------------------
				let mergeW = 1;
				while (cellX + mergeW < cellsX) {
					const nextIdx =
						cellX + mergeW + cellZ * cellsX + cellY * cellsX * cellsZ;

					if (used[nextIdx] === version) break;

					const s = samples[nextIdx];
					if (
						!s ||
						s.worldY !== baseY ||
						s.packedLight !== baseLight ||
						s.width !== baseWidth ||
						s.depth !== baseDepth
					) {
						break;
					}

					mergeW++;
				}

				// ---------------------------------
				// Merge across Z in coarse grid space
				// ---------------------------------
				let mergeH = 1;
				outer: while (cellZ + mergeH < cellsZ) {
					const rowZ = cellZ + mergeH;

					for (let dx = 0; dx < mergeW; dx++) {
						const checkIdx =
							cellX + dx + rowZ * cellsX + cellY * cellsX * cellsZ;

						if (used[checkIdx] === version) break outer;

						const s = samples[checkIdx];
						if (
							!s ||
							s.worldY !== baseY ||
							s.packedLight !== baseLight ||
							s.width !== baseWidth ||
							s.depth !== baseDepth
						) {
							break outer;
						}
					}

					mergeH++;
				}

				// Mark merged region as consumed
				for (let dz = 0; dz < mergeH; dz++) {
					for (let dx = 0; dx < mergeW; dx++) {
						const markIdx =
							cellX + dx + (cellZ + dz) * cellsX + cellY * cellsX * cellsZ;
						used[markIdx] = version;
					}
				}

				/**
				 * Emit the merged top-water quad.
				 *
				 * axis = 1  => Y axis top face
				 * width  = Z span
				 * height = X span
				 *
				 * This matches the orientation used by your original water mesh code.
				 */
				emitQuad(out, {
					x: baseSample.worldX,
					y: baseSample.worldY,
					z: baseSample.worldZ,

					axis: 1,
					width: baseDepth * mergeH,
					height: baseWidth * mergeW,

					blockId: WATER_BLOCK_ID,
					isBackFace: false,

					light: baseSample.packedLight,
					ao: 0,

					//Let FaceEmitter resolve the atlas tile from BlockTextures
					faceName: FaceName.Top,

					materialType: MaterialType.WaterOrGlass,
					flip: false,
				});
			}
		}
	}
}
