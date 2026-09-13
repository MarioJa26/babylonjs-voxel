import {
	addToScene,
	createMeshFromData,
	createShaderMaterial,
	type Mesh,
	resizeMeshGeometry,
	type SceneContext,
	type ShaderMaterial,
	setShaderUniform,
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

type BoxesGeometry = {
	positions: Float32Array;
	normals: Float32Array;
	indices: Uint32Array;
};

type BoatBlockContext = {
	boatChunk: {
		visualRoot: unknown;
		center: { x: number; y: number; z: number };
	};
	localX: number;
	localY: number;
	localZ: number;
};

const CRACK_STAGE_COUNT = 10;
const CRACK_INFLATION = 0.06;

let scene: SceneContext;

let crackMaterials: ShaderMaterial[] = [];
let crackMesh: Mesh | null = null;

let crackGeometryBlockId = -1;
let crackGeometryBlockState = -1;

const scratchHit = {
	x: 0,
	y: 0,
	z: 0,
	nx: 0,
	ny: 0,
	nz: 0,
	t: 0,
	blockId: 0,
	blockState: 0,
	dynamicContext: undefined as unknown,
} as BlockRaycastHit;

function buildBoxesGeometry(
	boxes: readonly BoxLike[],
	inflation: number,
): BoxesGeometry {
	const boxCount = boxes.length;
	const positions = new Float32Array(boxCount * 24 * 3);
	const normals = new Float32Array(boxCount * 24 * 3);
	const indices = new Uint32Array(boxCount * 36);

	const h = inflation * 0.5;

	let p = 0;
	let n = 0;
	let ii = 0;
	let base = 0;

	function writeVertex(
		x: number,
		y: number,
		z: number,
		nx: number,
		ny: number,
		nz: number,
	): void {
		positions[p++] = x;
		positions[p++] = y;
		positions[p++] = z;

		normals[n++] = nx;
		normals[n++] = ny;
		normals[n++] = nz;
	}

	function writeFace(
		nx: number,
		ny: number,
		nz: number,
		x0: number,
		y0: number,
		z0: number,
		x1: number,
		y1: number,
		z1: number,
		x2: number,
		y2: number,
		z2: number,
		x3: number,
		y3: number,
		z3: number,
	): void {
		const b = base;

		writeVertex(x0, y0, z0, nx, ny, nz);
		writeVertex(x1, y1, z1, nx, ny, nz);
		writeVertex(x2, y2, z2, nx, ny, nz);
		writeVertex(x3, y3, z3, nx, ny, nz);

		indices[ii++] = b;
		indices[ii++] = b + 1;
		indices[ii++] = b + 2;
		indices[ii++] = b;
		indices[ii++] = b + 2;
		indices[ii++] = b + 3;

		base += 4;
	}

	for (let b = 0; b < boxCount; b++) {
		const box = boxes[b];

		const x0 = box.min[0] - h;
		const y0 = box.min[1] - h;
		const z0 = box.min[2] - h;
		const x1 = box.max[0] + h;
		const y1 = box.max[1] + h;
		const z1 = box.max[2] + h;

		writeFace(1, 0, 0, x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0);

		writeFace(-1, 0, 0, x0, y0, z1, x0, y0, z0, x0, y1, z0, x0, y1, z1);

		writeFace(0, 1, 0, x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1);

		writeFace(0, -1, 0, x0, y0, z1, x1, y0, z1, x1, y0, z0, x0, y0, z0);

		writeFace(0, 0, 1, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);

		writeFace(0, 0, -1, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0);
	}

	return { positions, normals, indices };
}

export function initializeBlockBreakingVisuals(
	targetScene: SceneContext,
): void {
	scene = targetScene;

	crackMaterials = [];
	crackMesh = null;
	crackGeometryBlockId = -1;
	crackGeometryBlockState = -1;

	for (let i = 0; i < CRACK_STAGE_COUNT; i++) {
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

		setShaderUniform(mat, "uCrackStage", i / (CRACK_STAGE_COUNT - 1));
		crackMaterials.push(mat);
	}

	const unit = buildBoxesGeometry(
		[{ min: [0, 0, 0], max: [2, 1, 1] }],
		CRACK_INFLATION,
	);

	const mesh = createMeshFromData(
		Map1.engine,
		"crackMesh",
		unit.positions,
		unit.normals,
		unit.indices,
	);

	mesh.material = crackMaterials[0];
	mesh.pickable = false;
	mesh.visible = false;

	addToScene(scene, mesh);
	crackMesh = mesh;
}

function ensureCrackGeometry(blockId: number, blockState: number): void {
	const mesh = crackMesh;
	if (!mesh) return;

	if (
		blockId === crackGeometryBlockId &&
		blockState === crackGeometryBlockState
	) {
		return;
	}

	const transformedBoxes = getTransformedShapeBoxes(blockId, blockState);
	const boxes: BoxLike[] = [];

	for (let i = 0; i < transformedBoxes.length; i++) {
		const box = transformedBoxes[i];

		const w = box.max[0] - box.min[0];
		const h = box.max[1] - box.min[1];
		const d = box.max[2] - box.min[2];

		if (w > 0 && h > 0 && d > 0) {
			boxes.push({ min: box.min, max: box.max });
		}
	}

	const geo =
		boxes.length > 0
			? buildBoxesGeometry(boxes, CRACK_INFLATION)
			: buildBoxesGeometry(
					[{ min: [0, 0, 0], max: [1, 1, 1] }],
					CRACK_INFLATION,
				);

	resizeMeshGeometry(
		Map1.engine,
		mesh,
		geo.positions,
		geo.normals,
		geo.indices,
	);

	crackGeometryBlockId = blockId;
	crackGeometryBlockState = blockState;
}

export function updateBlockBreakingVisuals(
	progress: number,
	targetBlock: BlockRaycastHit,
): void {
	const mesh = crackMesh;
	if (!mesh) return;

	const stage = Math.max(
		0,
		Math.min(CRACK_STAGE_COUNT - 1, Math.floor(progress * CRACK_STAGE_COUNT)),
	);

	ensureCrackGeometry(targetBlock.blockId, targetBlock.blockState);

	mesh.material = crackMaterials[stage];
	mesh.visible = true;

	const boatContext = asBoatBlockContext(targetBlock.dynamicContext);
	if (boatContext) {
		mesh.parent = boatContext.boatChunk.visualRoot as never;
		mesh.position.set(
			boatContext.localX - boatContext.boatChunk.center.x,
			boatContext.localY - boatContext.boatChunk.center.y,
			boatContext.localZ - boatContext.boatChunk.center.z,
		);
	} else {
		mesh.parent = null;
		mesh.position.set(targetBlock.x, targetBlock.y, targetBlock.z);
	}
}

function asBoatBlockContext(context: unknown): BoatBlockContext | null {
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

	return {
		boatChunk: {
			visualRoot: value.boatChunk.visualRoot,
			center: value.boatChunk.center,
		},
		localX: value.localX,
		localY: value.localY,
		localZ: value.localZ,
	};
}

export function resetBlockBreakingVisuals(): void {
	if (crackMesh) {
		crackMesh.visible = false;
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

	scratchHit.x = block.x;
	scratchHit.y = block.y;
	scratchHit.z = block.z;
	scratchHit.blockId = blockId;
	scratchHit.blockState = blockState;
	scratchHit.dynamicContext = dynamicContext;

	updateBlockBreakingVisuals(progress, scratchHit);
}
