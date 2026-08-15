import {
	addToScene,
	createMeshFromData,
	createShaderMaterial,
	type Mesh,
	onBeforeRender,
	removeFromScene,
	resizeMeshGeometry,
	type SceneContext,
	type ShaderMaterial,
	setShaderUniform,
} from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import { getTransformedShapeBoxes } from "@/code/World/Shape/BlockShapeTransforms";
import type { BlockRaycastHit } from "./BlockRaycaster";
import type { BoatBlockHitContext } from "./BreakingBlockHandler";

const highlightVertexWGSL = /* wgsl */ `
struct VSOut { @builtin(position) pos : vec4<f32> };

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  out.pos = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  return out;
}
`;

const highlightFragmentWGSL = /* wgsl */ `
@fragment
fn mainFragment() -> @location(0) vec4<f32> {
  return shaderUniforms.uColor;
}
`;

type BoxLike = { min: readonly number[]; max: readonly number[] };

type BoxesGeometry = {
	positions: Float32Array;
	normals: Float32Array;
	indices: Uint32Array;
};

const HIGHLIGHT_SHAPE_INFLATION = 0.005;
const HIGHLIGHT_UNIT_INFLATION = 0.012;

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

	for (let i = 0; i < boxCount; i++) {
		const box = boxes[i];

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

export class BlockHighlight {
	readonly #scene: SceneContext;
	readonly #material: ShaderMaterial;

	#mesh: Mesh;

	#shapeBlockId = -1;
	#shapeBlockState = -1;

	#prevVisible = false;
	#prevHitX = Number.NaN;
	#prevHitY = Number.NaN;
	#prevHitZ = Number.NaN;
	#prevDynamicContext: unknown = undefined;

	/** Injected each frame by CrossHair so this class stays decoupled from Player. */
	#currentHit: BlockRaycastHit | null = null;

	constructor() {
		this.#scene = Map1.mainScene;
		this.#material = this.#createMaterial();

		const geo = buildBoxesGeometry(
			[{ min: [0, 0, 0], max: [1, 1, 1] }],
			HIGHLIGHT_UNIT_INFLATION,
		);

		this.#mesh = this.#createMesh("blockHighlight", geo);

		onBeforeRender(this.#scene, () => this.#update());
	}

	dispose(): void {
		removeFromScene(this.#scene, this.#mesh);
	}

	setHit(hit: BlockRaycastHit | null): void {
		this.#currentHit = hit;
	}

	// ─── Per-frame update ────────────────────────────────────────────────────

	#update(): void {
		const hit = this.#currentHit;
		const visible = hit !== null;

		if (visible !== this.#prevVisible) {
			this.#mesh.visible = visible;
			this.#prevVisible = visible;
		}

		if (!hit) {
			return;
		}

		this.#ensureShape(hit.blockId, hit.blockState);

		if (
			hit.x !== this.#prevHitX ||
			hit.y !== this.#prevHitY ||
			hit.z !== this.#prevHitZ ||
			hit.dynamicContext !== this.#prevDynamicContext
		) {
			this.#applyHitTransform(hit);
			this.#prevHitX = hit.x;
			this.#prevHitY = hit.y;
			this.#prevHitZ = hit.z;
			this.#prevDynamicContext = hit.dynamicContext;
		}
	}

	// ─── Shape management ────────────────────────────────────────────────────

	#ensureShape(blockId: number, blockState: number): void {
		if (
			blockId === this.#shapeBlockId &&
			blockState === this.#shapeBlockState
		) {
			return;
		}

		const geo = this.#buildGeometryForBlock(blockId, blockState);

		resizeMeshGeometry(
			Map1.engine,
			this.#mesh,
			geo.positions,
			geo.normals,
			geo.indices,
		);

		this.#shapeBlockId = blockId;
		this.#shapeBlockState = blockState;
	}

	#buildGeometryForBlock(blockId: number, blockState: number): BoxesGeometry {
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

		if (boxes.length === 0) {
			return buildBoxesGeometry(
				[{ min: [0, 0, 0], max: [1, 1, 1] }],
				HIGHLIGHT_UNIT_INFLATION,
			);
		}

		return buildBoxesGeometry(boxes, HIGHLIGHT_SHAPE_INFLATION);
	}

	#applyHitTransform(hit: BlockRaycastHit): void {
		const boatContext = this.#asBoatBlockContext(hit.dynamicContext);

		if (boatContext) {
			// Parent the highlight to the boat's visual root so it inherits the
			// boat's full transform: rotation + translation.
			this.#mesh.parent = boatContext.boatChunk.visualRoot as never;
			this.#mesh.position.set(
				boatContext.localX + 0.5 - boatContext.boatChunk.center.x,
				boatContext.localY + 0.5 - boatContext.boatChunk.center.y,
				boatContext.localZ + 0.5 - boatContext.boatChunk.center.z,
			);
			return;
		}

		this.#mesh.parent = null;
		this.#mesh.position.set(hit.x, hit.y, hit.z);
	}

	#asBoatBlockContext(context: unknown): BoatBlockHitContext | null {
		if (!context || typeof context !== "object") {
			return null;
		}

		const value = context as Partial<BoatBlockHitContext>;

		if (value.kind !== "boatChunk") {
			return null;
		}

		if (
			typeof value.localX !== "number" ||
			typeof value.localY !== "number" ||
			typeof value.localZ !== "number"
		) {
			return null;
		}

		const boatChunk = value.boatChunk as
			| BoatBlockHitContext["boatChunk"]
			| undefined;

		if (!boatChunk?.visualRoot || !boatChunk?.center) {
			return null;
		}

		return {
			kind: "boatChunk",
			boatChunk,
			localX: value.localX,
			localY: value.localY,
			localZ: value.localZ,
		};
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	#createMesh(name: string, geo: BoxesGeometry): Mesh {
		const mesh = createMeshFromData(
			Map1.engine,
			name,
			geo.positions,
			geo.normals,
			geo.indices,
		);

		mesh.material = this.#material;
		mesh.pickable = false;
		mesh.visible = false;

		addToScene(this.#scene, mesh);
		return mesh;
	}

	#createMaterial(): ShaderMaterial {
		const mat = createShaderMaterial({
			name: "highlightMat",
			vertexSource: highlightVertexWGSL,
			fragmentSource: highlightFragmentWGSL,
			attributes: ["position"],
			uniforms: ["worldViewProjection", { name: "uColor", type: "vec4<f32>" }],
			needAlphaBlending: true,
			depthWrite: false,
			backFaceCulling: false,
		});

		setShaderUniform(mat, "uColor", [
			SETTING_PARAMS.HIGHLIGHT_COLOR[0],
			SETTING_PARAMS.HIGHLIGHT_COLOR[1],
			SETTING_PARAMS.HIGHLIGHT_COLOR[2],
			SETTING_PARAMS.HIGHLIGHT_ALPHA,
		]);

		return mat;
	}
}
