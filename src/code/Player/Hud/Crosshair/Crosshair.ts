import { type Mesh, type Vec3, vec3 } from "@babylonjs/lite";
import { MetadataContainer } from "@/code/Entities/MetadataContainer";
import { setVec3 } from "@/code/Lib/Math";
import type { Player } from "../../Player";
import { REACH_DISTANCE } from "../../PlayerStats";
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

	constructor() {
		this.#ui = new CrosshairUI();
		this.#highlight = new BlockHighlight();

		// Pointer lock requires a user gesture; at startup it will reject — ignore.
		const canvasEl = document.querySelector("canvas");
		canvasEl?.requestPointerLock?.()?.catch?.(() => {});
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
	static pickTargetInto(player: Player, target: Vec3): boolean {
		const hit = pickTarget(player);
		if (!hit) return false;
		setVec3(target, hit.x, hit.y, hit.z);
		return true;
	}

	/** Allocation-free pickWaterPlacementTarget — writes into caller-provided vector. */
	static pickWaterPlacementTargetInto(player: Player, target: Vec3): boolean {
		const hit = pickWaterTarget(player);
		if (!hit) return false;
		setVec3(target, hit.x, hit.y, hit.z);
		return true;
	}

	static pickBlock(player: Player): number | null {
		return raycastPickBlock(player);
	}

	static pickTarget(player: Player): Vec3 | null {
		const hit = pickTarget(player);
		if (!hit) return null;
		// Caller gets a fresh Vector3 — pickTarget's shared object must not escape.
		return vec3(hit.x, hit.y, hit.z);
	}

	static pickWaterPlacementTarget(player: Player): Vec3 | null {
		const hit = pickWaterTarget(player);
		if (!hit) return null;
		return vec3(hit.x, hit.y, hit.z);
	}

	static getPlacementPosition(player: Player): Vec3 | null {
		const pos = raycastGetPlacementPosition(player);
		if (!pos) return null;
		// getPlacementPosition returns a shared Vector3 — copy it for the caller.
		return vec3(pos.x, pos.y, pos.z);
	}

	static getPlacementHit(player: Player): PlacementHit | null {
		const hit = raycastGetPlacementHit(player);
		if (!hit) return null;
		// Clone mutable fields so callers retain a stable snapshot.
		return {
			pos: vec3(hit.pos.x, hit.pos.y, hit.pos.z),
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
	): Mesh | null {
		return Crosshair.#rayMarchFirstMesh(player, maxDistance, (mesh) => {
			const meta = mesh.metadata;
			return meta instanceof MetadataContainer && meta.has("use");
		});
	}

	static pickMobMesh(
		player: Player,
		maxDistance = REACH_DISTANCE,
	): Mesh | null {
		return Crosshair.#rayMarchFirstMesh(player, maxDistance, (mesh) => {
			const meta = mesh.metadata;
			return meta instanceof MetadataContainer && meta.has("mob");
		});
	}

	// ─── Mesh ray pick ──────────────────────────────────────────────────────

	static #rayMarchFirstMesh(
		player: Player,
		maxDistance: number,
		predicate?: (mesh: Mesh) => boolean,
	): Mesh | null {
		// TODO(Lite API): mesh ray picking (getForwardRay / pickWithRay) is not
		// available in Lite yet; kept as a best-effort dynamic dispatch.
		const camera = player.playerCamera.playerCamera as unknown as {
			getForwardRay?: (d: number) => unknown;
		};
		const scene = player.sceneRef as unknown as {
			pickWithRay?: (
				ray: unknown,
				predicate?: (mesh: Mesh) => boolean,
				fast?: boolean,
			) => { pickedMesh?: Mesh | null } | null;
		};
		const tempRay = camera.getForwardRay?.(maxDistance);
		if (!tempRay || !scene.pickWithRay) return null;
		const hit = scene.pickWithRay(tempRay, predicate, true);
		return hit?.pickedMesh ?? null;
	}
}
