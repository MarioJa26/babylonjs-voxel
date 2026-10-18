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
import { resolveBoatBlockContext } from "./BoatBlockContext";
import {
	type BoxesGeometry,
	type BoxLike,
	buildBoxesGeometry,
} from "./BoxesGeometry";

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

const HIGHLIGHT_SHAPE_INFLATION = 0.005;
const HIGHLIGHT_UNIT_INFLATION = 0.012;

export class BlockHighlight {
	readonly #scene: SceneContext;
	readonly #material: ShaderMaterial;

	#isDisposed = false;
	readonly #beforeRender = (): void => {
		if (this.#isDisposed) return;
		this.#update();
	};

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

		onBeforeRender(this.#scene, this.#beforeRender);
	}

	dispose(): void {
		if (this.#isDisposed) return;
		this.#isDisposed = true;

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
		const boatContext = resolveBoatBlockContext(hit.dynamicContext);

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
