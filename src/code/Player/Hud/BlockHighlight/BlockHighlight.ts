import {
	addToScene,
	createMeshFromData,
	createShaderMaterial,
	type Mesh,
	onBeforeRender,
	removeFromScene,
	type SceneContext,
	type ShaderMaterial,
	setShaderUniform,
} from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import { getScene } from "@/code/Shared/GameRuntimeState";
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

export class BlockHighlight {
	readonly #scene: SceneContext;
	readonly #material: ShaderMaterial;

	#mesh: Mesh;
	#shapeKey = -1;
	#prevVisible = false;
	#prevHitX = 0;
	#prevHitY = 0;
	#prevHitZ = 0;

	constructor() {
		this.#scene = getScene()!;
		this.#material = this.#createMaterial();
		this.#mesh = this.#buildUnitCube();
		this.#shapeKey = -1;

		onBeforeRender(this.#scene, () => this.#update());
	}

	dispose(): void {
		removeFromScene(this.#scene, this.#mesh);
	}

	// ─── Per-frame update ────────────────────────────────────────────────────

	#update(): void {
		const hit = this.#currentHit;
		const visible = hit !== null;
		if (visible !== this.#prevVisible) {
			this.#mesh.visible = visible;
			this.#prevVisible = visible;
		}
		if (hit) {
			this.#ensureShape(hit.blockId, hit.blockState);
			if (
				hit.x !== this.#prevHitX ||
				hit.y !== this.#prevHitY ||
				hit.z !== this.#prevHitZ
			) {
				this.#applyHitTransform(hit);
				this.#prevHitX = hit.x;
				this.#prevHitY = hit.y;
				this.#prevHitZ = hit.z;
			}
		}
	}

	/** Injected each frame by CrossHair so this class stays decoupled from Player. */
	#currentHit: BlockRaycastHit | null = null;
	setHit(hit: BlockRaycastHit | null): void {
		this.#currentHit = hit;
	}

	// ─── Shape management ────────────────────────────────────────────────────

	#ensureShape(blockId: number, blockState: number): void {
		const key = (blockId << 6) | blockState;
		if (key === this.#shapeKey) return;

		const previousParent = this.#mesh.parent;
		const px = this.#mesh.position.x;
		const py = this.#mesh.position.y;
		const pz = this.#mesh.position.z;
		const visible = this.#mesh.visible ?? false;
		const next = this.#buildForBlock(blockId, blockState);
		next.position.set(px, py, pz);
		next.parent = previousParent;
		next.visible = visible;
		removeFromScene(this.#scene, this.#mesh);
		this.#mesh = next;
		this.#shapeKey = key;
	}

	#applyHitTransform(hit: BlockRaycastHit): void {
		const boatContext = this.#asBoatBlockContext(hit.dynamicContext);
		if (boatContext) {
			const center = boatContext.boatChunk.center;
			this.#mesh.parent = boatContext.boatChunk.visualRoot;
			this.#mesh.position.set(
				boatContext.localX - center.x,
				boatContext.localY - center.y,
				boatContext.localZ - center.z,
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

	#buildForBlock(blockId: number, blockState: number): Mesh {
		const boxes: BoxLike[] = [];
		for (const box of getTransformedShapeBoxes(blockId, blockState)) {
			const w = box.max[0] - box.min[0];
			const h = box.max[1] - box.min[1];
			const d = box.max[2] - box.min[2];
			if (w <= 0 || h <= 0 || d <= 0) continue;
			boxes.push({ min: box.min, max: box.max });
		}

		if (boxes.length === 0) return this.#buildUnitCube();

		const geo = buildBoxesGeometry(boxes, 0.005);
		return this.#createMesh("blockHighlight", geo);
	}

	#buildUnitCube(): Mesh {
		const geo = buildBoxesGeometry([{ min: [0, 0, 0], max: [1, 1, 1] }], 0.012);
		return this.#createMesh("blockHighlightUnitCube", geo);
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	#createMesh(
		name: string,
		geo: {
			positions: Float32Array;
			normals: Float32Array;
			indices: Uint32Array;
		},
	): Mesh {
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
