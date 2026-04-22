import {
	type AbstractMesh,
	type Engine,
	type Scene,
	Vector3,
} from "@babylonjs/core";
import { MetadataContainer } from "@/code/Entities/MetaDataContainer";
import { type Player, REACH_DISTANCE } from "../../Player";
import { BlockHighlight } from "../BlockHighlight/BlockHighlight";
import {
	type PlacementHit,
	pickTarget,
	pickWaterTarget,
} from "../BlockHighlight/BlockRaycaster";
import { CrosshairUI } from "./CrosshairUI";

const MESH_MARCH_STEP = 0.25;
const MESH_BOUNDS_EPS = 0.001;

/** Shared point reused for mesh ray-march to avoid per-step allocation. */
const _marchPoint = new Vector3(0, 0, 0);

export class CrossHair {
	readonly #ui: CrosshairUI;
	readonly #highlight: BlockHighlight;
	readonly #player: Player;

	constructor(engine: Engine, scene: Scene, player: Player) {
		this.#player = player;
		this.#ui = new CrosshairUI(engine, scene);
		this.#highlight = new BlockHighlight(scene);

		engine.enterPointerlock();

		scene.onBeforeRenderObservable.add(() => {
			// pickTarget returns a shared object; BlockHighlight reads it synchronously.
			this.#highlight.setHit(pickTarget(this.#player));
		});
	}

	// ─── UI delegation ───────────────────────────────────────────────────────

	setCrosshair(id: string): void {
		this.#ui.setCrosshair(id);
	}
	showHitMarker(): void {
		this.#ui.showHitMarker();
	}

	// ─── Static raycasting API (unchanged public surface) ────────────────────

	static pickBlock(player: Player): number | null {
		return CrossHair.pickBlock(player);
	}

	static pickTarget(player: Player): Vector3 | null {
		const hit = pickTarget(player);
		if (!hit) return null;
		// Caller gets a fresh Vector3 — pickTarget's shared object must not escape.
		return new Vector3(hit.x, hit.y, hit.z);
	}

	static pickWaterPlacementTarget(player: Player): Vector3 | null {
		const hit = pickWaterTarget(player);
		if (!hit) return null;
		return new Vector3(hit.x, hit.y, hit.z);
	}

	static getPlacementPosition(player: Player): Vector3 | null {
		const pos = CrossHair.getPlacementPosition(player);
		if (!pos) return null;
		// getPlacementPosition returns a shared Vector3 — copy it for the caller.
		return pos.clone();
	}

	static getPlacementHit(player: Player): PlacementHit | null {
		const hit = CrossHair.getPlacementHit(player);
		if (!hit) return null;
		// Clone mutable fields so callers retain a stable snapshot.
		return {
			pos: hit.pos.clone(),
			nx: hit.nx,
			ny: hit.ny,
			nz: hit.nz,
			hitFracX: hit.hitFracX,
			hitFracY: hit.hitFracY,
			hitFracZ: hit.hitFracZ,
		};
	}

	static pickUsableMesh(
		player: Player,
		maxDistance = REACH_DISTANCE,
	): AbstractMesh | null {
		return CrossHair.#rayMarchFirstMesh(player, maxDistance, (mesh) => {
			const meta = mesh.metadata;
			return meta instanceof MetadataContainer && meta.has("use");
		});
	}

	// ─── Mesh ray-march ──────────────────────────────────────────────────────

	static #rayMarchFirstMesh(
		player: Player,
		maxDistance: number,
		predicate?: (mesh: AbstractMesh) => boolean,
	): AbstractMesh | null {
		// Reuse the shared ray from BlockRaycaster — import the helper directly.
		// We reconstruct it here via the player camera to stay self-contained.
		const camera = player.playerCamera.playerCamera;
		const tempRay = camera.getForwardRay(maxDistance);

		const candidates = player.playerVehicle.scene.meshes.filter(
			(m) => m.isPickable && m.isEnabled() && (!predicate || predicate(m)),
		);
		if (candidates.length === 0) return null;

		const { origin, direction, length } = tempRay;

		for (let t = 0; t <= length; t += MESH_MARCH_STEP) {
			_marchPoint.set(
				origin.x + direction.x * t,
				origin.y + direction.y * t,
				origin.z + direction.z * t,
			);
			for (const mesh of candidates) {
				if (!mesh.isDisposed() && isInsideBounds(mesh, _marchPoint))
					return mesh;
			}
		}
		return null;
	}
}

function isInsideBounds(mesh: AbstractMesh, point: Vector3): boolean {
	const { minimumWorld: mn, maximumWorld: mx } =
		mesh.getBoundingInfo().boundingBox;
	const e = MESH_BOUNDS_EPS;
	return (
		point.x >= mn.x - e &&
		point.x <= mx.x + e &&
		point.y >= mn.y - e &&
		point.y <= mx.y + e &&
		point.z >= mn.z - e &&
		point.z <= mx.z + e
	);
}
