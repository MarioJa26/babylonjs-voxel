import {
	addToScene,
	createMeshFromData,
	createShaderMaterial,
	type Mesh,
	type SceneContext,
	type ShaderMaterial,
	setShaderUniform,
	updateMeshNormals,
	updateMeshPositions,
} from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import { getTransformedShapeBoxes } from "@/code/World/Shape/BlockShapeTransforms";
import type { BlockRaycastHit } from "./BlockRaycaster";

const crackVertexWGSL = /* wgsl */ `
struct VSOut { @builtin(position) pos : vec4<f32> };

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  out.pos = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  return out;
}
`;

const crackFragmentWGSL = /* wgsl */ `
@fragment
fn mainFragment() -> @location(0) vec4<f32> {
  let a = shaderUniforms.uCrackStage;
  return vec4<f32>(0.0, 0.0, 0.0, a * 0.6);
}
`;

type BoxLike = { min: readonly number[]; max: readonly number[] };

function addBox(
	positions: number[],
	normals: number[],
	indices: number[],
	x0: number,
	y0: number,
	z0: number,
	x1: number,
	y1: number,
	z1: number,
): void {
	const faces: Array<{
		n: [number, number, number];
		v: Array<[number, number, number]>;
	}> = [
		{
			n: [1, 0, 0],
			v: [
				[x1, y0, z0],
				[x1, y0, z1],
				[x1, y1, z1],
				[x1, y1, z0],
			],
		},
		{
			n: [-1, 0, 0],
			v: [
				[x0, y0, z1],
				[x0, y0, z0],
				[x0, y1, z0],
				[x0, y1, z1],
			],
		},
		{
			n: [0, 1, 0],
			v: [
				[x0, y1, z0],
				[x1, y1, z0],
				[x1, y1, z1],
				[x0, y1, z1],
			],
		},
		{
			n: [0, -1, 0],
			v: [
				[x0, y0, z1],
				[x1, y0, z1],
				[x1, y0, z0],
				[x0, y0, z0],
			],
		},
		{
			n: [0, 0, 1],
			v: [
				[x0, y0, z1],
				[x1, y0, z1],
				[x1, y1, z1],
				[x0, y1, z1],
			],
		},
		{
			n: [0, 0, -1],
			v: [
				[x1, y0, z0],
				[x0, y0, z0],
				[x0, y1, z0],
				[x1, y1, z0],
			],
		},
	];

	for (const face of faces) {
		const base = positions.length / 3;
		for (let i = 0; i < 4; i++) {
			positions.push(face.v[i][0], face.v[i][1], face.v[i][2]);
			normals.push(face.n[0], face.n[1], face.n[2]);
		}
		indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
	}
}

function buildBoxesGeometry(
	boxes: readonly BoxLike[],
	inflation: number,
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
	const positions: number[] = [];
	const normals: number[] = [];
	const indices: number[] = [];
	const h = inflation / 2;
	for (const box of boxes) {
		addBox(
			positions,
			normals,
			indices,
			box.min[0] - h,
			box.min[1] - h,
			box.min[2] - h,
			box.max[0] + h,
			box.max[1] + h,
			box.max[2] + h,
		);
	}
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indices),
	};
}

let scene: SceneContext;

let crackMaterials: ShaderMaterial[] = [];
let crackMeshes: Mesh[] = [];
let _usedCrackMeshes: Mesh[] = [];

let crackGeometryKey = -1;

export function initializeBlockBreakingVisuals(
	targetScene: SceneContext,
): void {
	scene = targetScene;

	crackMaterials = [];
	crackMeshes = [];
	_usedCrackMeshes = [];
	crackGeometryKey = -1;

	const unit = buildBoxesGeometry([{ min: [0, 0, 0], max: [2, 1, 1] }], 0.06);

	for (let i = 0; i < 10; i++) {
		const mat = createShaderMaterial({
			name: `crackMat${i}`,
			vertexSource: crackVertexWGSL,
			fragmentSource: crackFragmentWGSL,
			attributes: ["position"],
			uniforms: ["worldViewProjection", { name: "uCrackStage", type: "f32" }],
			needAlphaBlending: true,
			depthWrite: false,
			backFaceCulling: false,
		});
		setShaderUniform(mat, "uCrackStage", i / 9);
		crackMaterials.push(mat);

		const mesh = createMeshFromData(
			Map1.engine,
			`crackMesh${i}`,
			unit.positions,
			unit.normals,
			unit.indices,
		);
		mesh.material = mat;
		mesh.pickable = false;
		mesh.visible = false;
		addToScene(scene, mesh);
		crackMeshes.push(mesh);
	}
}

function ensureCrackGeometry(blockId: number, blockState: number): void {
	const key = (blockId << 6) | blockState;
	if (key === crackGeometryKey) return;

	const boxes: BoxLike[] = [];
	for (const box of getTransformedShapeBoxes(blockId, blockState)) {
		const w = box.max[0] - box.min[0];
		const h = box.max[1] - box.min[1];
		const d = box.max[2] - box.min[2];
		if (w <= 0 || h <= 0 || d <= 0) continue;
		boxes.push({ min: box.min, max: box.max });
	}

	const geo =
		boxes.length > 0
			? buildBoxesGeometry(boxes, 0.06)
			: buildBoxesGeometry([{ min: [0, 0, 0], max: [1, 1, 1] }], 0.06);

	for (const mesh of crackMeshes) {
		updateMeshPositions(Map1.engine, mesh, geo.positions);
		updateMeshNormals(Map1.engine, mesh, geo.normals);
	}

	crackGeometryKey = key;
}

export function updateBlockBreakingVisuals(
	progress: number,
	targetBlock: BlockRaycastHit,
): void {
	const stage = Math.max(0, Math.min(9, Math.floor(progress * 10)));

	ensureCrackGeometry(targetBlock.blockId, targetBlock.blockState);

	for (let i = 0; i < crackMeshes.length; i++) {
		crackMeshes[i].visible = i === stage;
	}

	const target = crackMeshes[stage];

	const boatContext = asBoatBlockContext(targetBlock.dynamicContext);
	if (boatContext) {
		// Parent the crack overlay to the boat's visual root so it inherits the
		// boat's full transform (rotation + translation). Position it at the
		// block's LOCAL center (un-floored) so it is not clamped to the world grid
		// and rotates naturally with the boat.
		target.parent = boatContext.boatChunk.visualRoot as never;
		target.position.set(
			boatContext.localX - boatContext.boatChunk.center.x,
			boatContext.localY - boatContext.boatChunk.center.y,
			boatContext.localZ - boatContext.boatChunk.center.z,
		);
	} else {
		target.parent = null;
		target.position.set(targetBlock.x, targetBlock.y, targetBlock.z);
	}

	_usedCrackMeshes = [target];
}

function asBoatBlockContext(context: unknown): {
	boatChunk: {
		visualRoot: unknown;
		center: { x: number; y: number; z: number };
	};
	localX: number;
	localY: number;
	localZ: number;
} | null {
	if (!context || typeof context !== "object") return null;
	const value = context as {
		kind?: string;
		boatChunk?: {
			visualRoot: unknown;
			center?: { x: number; y: number; z: number };
		};
		localX?: number;
		localY?: number;
		localZ?: number;
	};
	if (value.kind !== "boatChunk" || !value.boatChunk?.center) return null;
	if (
		typeof value.localX !== "number" ||
		typeof value.localY !== "number" ||
		typeof value.localZ !== "number"
	) {
		return null;
	}
	const center = value.boatChunk.center;
	const boatChunk = value.boatChunk;
	return {
		boatChunk: { visualRoot: boatChunk.visualRoot, center },
		localX: value.localX,
		localY: value.localY,
		localZ: value.localZ,
	};
}

export function resetBlockBreakingVisuals(): void {
	_usedCrackMeshes = [];
	for (const mesh of crackMeshes) {
		mesh.visible = false;
	}
}

/** Backwards-compatible entry point used by BreakingBlockHandler. */
export function updateCrackingState(
	block: { x: number; y: number; z: number } | null,
	progress: number,
	blockId?: number,
	blockState?: number,
	dynamicContext?: unknown,
): void {
	if (block === null || blockId === undefined || blockState === undefined) {
		resetBlockBreakingVisuals();
		return;
	}
	updateBlockBreakingVisuals(progress, {
		x: block.x,
		y: block.y,
		z: block.z,
		nx: 0,
		ny: 0,
		nz: 0,
		t: 0,
		blockId,
		blockState,
		dynamicContext,
	} as BlockRaycastHit);
}
