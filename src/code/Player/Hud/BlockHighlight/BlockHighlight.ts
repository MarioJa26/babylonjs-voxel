import {
	Color3,
	Color4,
	Mesh,
	MeshBuilder,
	type Scene,
	StandardMaterial,
} from "@babylonjs/core";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import { getTransformedShapeBoxes } from "@/code/World/Shape/BlockShapeTransforms";
import type { BlockRaycastHit } from "./BlockRaycaster";

export class BlockHighlight {
	readonly #scene: Scene;
	readonly #material: StandardMaterial;

	#mesh: Mesh;
	#shapeKey = "";

	constructor(scene: Scene) {
		this.#scene = scene;
		this.#material = this.#createMaterial();
		this.#mesh = this.#buildUnitCube();
		this.#shapeKey = "default";

		scene.onBeforeRenderObservable.add(() => this.#update());
	}

	// ─── Per-frame update ────────────────────────────────────────────────────

	#update(): void {
		// Note: pickTarget returns a shared object — read all fields immediately.
		const hit = this.#currentHit;
		if (hit) {
			const blockId = ChunkLoadingSystem.getBlockByWorldCoords(
				hit.x,
				hit.y,
				hit.z,
			);
			const blockState = ChunkLoadingSystem.getBlockStateByWorldCoords(
				hit.x,
				hit.y,
				hit.z,
			);
			this.#ensureShape(blockId, blockState);
			this.#mesh.position.set(hit.x, hit.y, hit.z);
			this.#mesh.visibility = 1;
		} else {
			this.#mesh.visibility = 0;
		}
	}

	/** Injected each frame by CrossHair so this class stays decoupled from Player. */
	#currentHit: BlockRaycastHit | null = null;
	setHit(hit: BlockRaycastHit | null): void {
		this.#currentHit = hit;
	}

	// ─── Shape management ────────────────────────────────────────────────────

	#ensureShape(blockId: number, blockState: number): void {
		const key = `${blockId}:${blockState}`;
		if (key === this.#shapeKey) return;

		const next = this.#buildForBlock(blockId, blockState);
		next.position.copyFrom(this.#mesh.position);
		this.#mesh.dispose();
		this.#mesh = next;
		this.#shapeKey = key;
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
