import {
	type AbstractMesh,
	type Engine,
	type Scene,
	Vector3,
} from "@babylonjs/core";
import { MetadataContainer } from "@/code/Entities/MetadataContainer";
import { REACH_DISTANCE } from "@/code/Shared/Constants";
import type { Player } from "../../Player";
import { BlockHighlight } from "../BlockHighlight/BlockHighlight";
import type { BlockRaycastHit } from "../BlockHighlight/BlockRaycaster";
import {
	type PlacementHit,
	pickTarget,
	pickWaterTarget,
	getPlacementHit as raycastGetPlacementHit,
	getPlacementPosition as raycastGetPlacementPosition,
	pickBlock as raycastPickBlock,
} from "../BlockHighlight/BlockRaycaster";
import { CrosshairUI } from "./CrosshairUI";

export class Crosshair {
	readonly #ui: CrosshairUI;
	readonly #highlight: BlockHighlight;

	constructor(engine: Engine, scene: Scene) {
		this.#ui = new CrosshairUI();
		this.#highlight = new BlockHighlight(scene);

		engine.enterPointerlock();
	}

	/** Set the pre-computed pick target hit from PlayerLoopController. */
	public setTargetHit(hit: BlockRaycastHit | null): void {
		this.#highlight.setHit(hit);
	}

	// ─── UI delegation ───────────────────────────────────────────────────────

	setCrosshair(id: string): void {
		this.#ui.setCrosshair(id);
	}
	showHitMarker(): void {
		this.#ui.showHitMarker();
	}

	// ─── Static raycasting API (unchanged public surface) ────────────────────

	/** Allocation-free pickTarget — writes into caller-provided vector. Returns true on hit. */
	static pickTargetInto(player: Player, target: Vector3): boolean {
		const hit = pickTarget(player);
		if (!hit) return false;
		target.set(hit.x, hit.y, hit.z);
		return true;
	}

	/** Allocation-free pickWaterPlacementTarget — writes into caller-provided vector. */
	static pickWaterPlacementTargetInto(
		player: Player,
		target: Vector3,
	): boolean {
		const hit = pickWaterTarget(player);
		if (!hit) return false;
		target.set(hit.x, hit.y, hit.z);
		return true;
	}

	static pickBlock(player: Player): number | null {
		return raycastPickBlock(player);
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
		const pos = raycastGetPlacementPosition(player);
		if (!pos) return null;
		// getPlacementPosition returns a shared Vector3 — copy it for the caller.
		return pos.clone();
	}

	static getPlacementHit(player: Player): PlacementHit | null {
		const hit = raycastGetPlacementHit(player);
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
		return Crosshair.#rayMarchFirstMesh(player, maxDistance, (mesh) => {
			const meta = mesh.metadata;
			return meta instanceof MetadataContainer && meta.has("use");
		});
	}

	static pickMobMesh(
		player: Player,
		maxDistance = REACH_DISTANCE,
	): AbstractMesh | null {
		return Crosshair.#rayMarchFirstMesh(player, maxDistance, (mesh) => {
			const meta = mesh.metadata;
			return meta instanceof MetadataContainer && meta.has("mob");
		});
	}

	// ─── Mesh ray pick ──────────────────────────────────────────────────────

	static #rayMarchFirstMesh(
		player: Player,
		maxDistance: number,
		predicate?: (mesh: AbstractMesh) => boolean,
	): AbstractMesh | null {
		const camera = player.playerCamera.playerCamera;
		const tempRay = camera.getForwardRay(maxDistance);
		const hit = player.playerVehicle.scene.pickWithRay(
			tempRay,
			predicate,
			true,
		);
		return hit?.pickedMesh ?? null;
	}
}
