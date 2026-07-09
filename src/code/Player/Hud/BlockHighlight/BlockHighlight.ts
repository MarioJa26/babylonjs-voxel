import {
	Color3,
	Color4,
	Mesh,
	MeshBuilder,
	type Scene,
	StandardMaterial,
} from "@babylonjs/core";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import { getTransformedShapeBoxes } from "@/code/World/Shape/BlockShapeTransforms";
import type { BlockRaycastHit } from "./BlockRaycaster";
import type { BoatBlockHitContext } from "./BreakingBlockHandler";

export class BlockHighlight {
	readonly #scene: Scene;
	readonly #material: StandardMaterial;

	#mesh: Mesh;
	#shapeKey = -1;
	#prevVisible = false;
	#prevHitX = 0;
	#prevHitY = 0;
	#prevHitZ = 0;
	readonly #renderHandle: () => void;

	constructor(scene: Scene) {
		this.#scene = scene;
		this.#material = this.#createMaterial();
		this.#mesh = this.#buildUnitCube();
		this.#shapeKey = -1;

		this.#renderHandle = () => this.#update();
		scene.onBeforeRenderObservable.add(this.#renderHandle);
	}

	dispose(): void {
		this.#scene.onBeforeRenderObservable.removeCallback(this.#renderHandle);
		this.#mesh.dispose();
		this.#material.dispose();
	}

	// ─── Per-frame update ────────────────────────────────────────────────────

	#update(): void {
		const hit = this.#currentHit;
		const visible = hit !== null;
		if (visible !== this.#prevVisible) {
			this.#mesh.visibility = visible ? 1 : 0;
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
		const next = this.#buildForBlock(blockId, blockState);
		next.position.copyFrom(this.#mesh.position);
		next.parent = previousParent;
		this.#mesh.dispose();
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
		const inflation = 0.005;
		const parts: Mesh[] = [];
		let idx = 0;

		for (const box of getTransformedShapeBoxes(blockId, blockState)) {
			const w = box.max[0] - box.min[0];
			const h = box.max[1] - box.min[1];
			const d = box.max[2] - box.min[2];
			if (w <= 0 || h <= 0 || d <= 0) continue;

			const part = MeshBuilder.CreateBox(
				`hlPart_${idx++}`,
				{
					width: w + inflation,
					height: h + inflation,
					depth: d + inflation,
				},
				this.#scene,
			);
			part.position.set(
				(box.min[0] + box.max[0]) * 0.5,
				(box.min[1] + box.max[1]) * 0.5,
				(box.min[2] + box.max[2]) * 0.5,
			);
			this.#bakeAndReset(part);
			parts.push(part);
		}

		if (parts.length === 0) return this.#buildUnitCube();

		let mesh: Mesh;
		if (parts.length === 1) {
			mesh = parts[0];
		} else {
			const merged = Mesh.MergeMeshes(
				parts,
				true,
				true,
				undefined,
				false,
				true,
			);
			if (!merged) {
				mesh = parts[0];
				for (let i = 1; i < parts.length; i++) parts[i].dispose();
			} else {
				mesh = merged as Mesh;
			}
		}

		mesh.name = "blockHighlight";
		this.#configure(mesh);
		return mesh;
	}

	#buildUnitCube(): Mesh {
		const mesh = MeshBuilder.CreateBox(
			"blockHighlightUnitCube",
			{ size: 1.012 },
			this.#scene,
		);
		mesh.position.set(0.5, 0.5, 0.5);
		this.#bakeAndReset(mesh);
		this.#configure(mesh);
		return mesh;
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	#bakeAndReset(mesh: Mesh): void {
		mesh.bakeCurrentTransformIntoVertices();
		mesh.position.set(0, 0, 0);
	}

	#configure(mesh: Mesh): void {
		mesh.isPickable = false;
		mesh.renderingGroupId = 1;
		mesh.material = this.#material;
		mesh.visibility = 0;
		mesh.enableEdgesRendering();
		mesh.edgesWidth = SETTING_PARAMS.HIGHLIGHT_EDGE_WIDTH;
		mesh.edgesColor = new Color4(
			SETTING_PARAMS.HIGHLIGHT_EDGE_COLOR[0],
			SETTING_PARAMS.HIGHLIGHT_EDGE_COLOR[1],
			SETTING_PARAMS.HIGHLIGHT_EDGE_COLOR[2],
			SETTING_PARAMS.HIGHLIGHT_EDGE_COLOR[3],
		);
	}

	#createMaterial(): StandardMaterial {
		const mat = new StandardMaterial("highlightMat", this.#scene);
		mat.alpha = SETTING_PARAMS.HIGHLIGHT_ALPHA;
		mat.diffuseColor = new Color3(
			SETTING_PARAMS.HIGHLIGHT_COLOR[0],
			SETTING_PARAMS.HIGHLIGHT_COLOR[1],
			SETTING_PARAMS.HIGHLIGHT_COLOR[2],
		);
		return mat;
	}
}
