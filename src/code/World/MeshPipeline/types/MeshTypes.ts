// MeshPipeline/types/MeshTypes.ts

import type { WorkerInternalMeshData as WIMD } from "../../Chunk/DataStructures/WorkerInternalMeshData";
import type { FaceName } from "../../Texture/FaceName";

export type WorkerInternalMeshData = WIMD;

/**
 * Core meshing context used by all pipelines.
 */
export interface MeshContext {
	size: number;
	lod: number;
	disableAO: boolean;
	getBlock(x: number, y: number, z: number, fallback?: number): number;
	getLight(x: number, y: number, z: number, fallback?: number): number;
	hasNeighborChunk(dx: number, dy: number, dz: number): boolean;
}

/**
 * Description of a quad to emit (internal pipeline)
 */
export interface EmitQuadParams {
	x: number;
	y: number;
	z: number;
	axis: number;
	width: number;
	height: number;
	blockId: number;
	isBackFace: boolean;
	light: number;
	ao: number;
	faceName: FaceName;
	materialType: number;
	flip: boolean;
	diagonal?: 0 | 1 | 2;
}

/**
 * Shape info extracted from packed block
 */
export interface BlockShapeInfo {
	isCube: boolean;
	isSliceCompatible: boolean;
	sliceMask: number;
	closedFaceMask: number;
}

/**
 * Greedy face descriptor used internally by the greedy merger
 */
export interface GreedyFaceDescriptor {
	slice: number;
	uStart: number;
	vStart: number;
	width: number;
	height: number;
	idState: number;
	light: number;
}

/**
 * Enum for material types (blockId → material bucket)
 */
export enum MaterialType {
	Default = 0,
	WaterOrGlass = 1,
	Cutout = 2,
}
