import { type Mesh, type Vec3, vec3 } from "@babylonjs/lite";
import { MetadataContainer } from "@/code/Entities/MetadataContainer";
import { setVec3 } from "@/code/Lib/Math";
import type { Player } from "../../Player";
import { REACH_DISTANCE } from "../../PlayerStats";
import { BlockHighlight } from "../BlockHighlight/BlockHighlight";
import type { BlockRaycastHit } from "../BlockHighlight/BlockRaycaster";
import {
	type PlacementHit,
	getPlacementHit as raycastGetPlacementHit,
	getPlacementPosition as raycastGetPlacementPosition,
	pickBlock as raycastPickBlock,
	pickTarget as raycastPickTarget,
	pickWaterTarget as raycastPickWaterTarget,
} from "../BlockHighlight/BlockRaycaster";
import { CrosshairUI } from "./CrosshairUI";

type LiteForwardRayCamera = {
	getForwardRay?: (distance: number) => unknown;
};

type LiteRayPickScene = {
	pickWithRay?: (
		ray: unknown,
		predicate?: (mesh: Mesh) => boolean,
		fast?: boolean,
	) => {
		pickedMesh?: Mesh | null;
		thinInstanceIndex?: number;
	} | null;
};

export class Crosshair {
	readonly #ui: CrosshairUI;
	readonly #highlight: BlockHighlight;

	static readonly #usableMeshPredicate = (mesh: Mesh): boolean => {
		const meta = mesh.metadata;
		return meta instanceof MetadataContainer && meta.has("use");
	};

	static readonly #mobMeshPredicate = (mesh: Mesh): boolean => {
		const meta = mesh.metadata;
		return meta instanceof MetadataContainer && meta.has("mob");
	};

	constructor() {
		this.#ui = new CrosshairUI();
		this.#highlight = new BlockHighlight();

		// Pointer lock requires a user gesture; at startup it will reject — ignore.
		document
			.querySelector("canvas")
			?.requestPointerLock?.()
			?.catch?.(() => {});
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

	// ─── Static raycasting API ───────────────────────────────────────────────

	/** Allocation-free pickTarget — writes into caller-provided vector. Returns true on hit. */
	static pickTargetInto(player: Player, target: Vec3): boolean {
		const hit = raycastPickTarget(player);
		if (!hit) return false;

		setVec3(target, hit.x, hit.y, hit.z);
		return true;
	}

	/** Allocation-free pickWaterPlacementTarget — writes into caller-provided vector. */
	static pickWaterPlacementTargetInto(player: Player, target: Vec3): boolean {
		const hit = raycastPickWaterTarget(player);
		if (!hit) return false;

		setVec3(target, hit.x, hit.y, hit.z);
		return true;
	}

	static pickBlock(player: Player): number | null {
		return raycastPickBlock(player);
	}

	static pickTarget(player: Player): Vec3 | null {
		const hit = raycastPickTarget(player);
		if (!hit) return null;

		// Caller gets a fresh Vector3 — raycastPickTarget's shared object must not escape.
		return vec3(hit.x, hit.y, hit.z);
	}

	static pickWaterPlacementTarget(player: Player): Vec3 | null {
		const hit = raycastPickWaterTarget(player);
		if (!hit) return null;

		// Caller gets a fresh Vector3 — raycastPickWaterTarget's shared object must not escape.
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
		return (
			Crosshair.#rayMarchFirstInfo(
				player,
				maxDistance,
				Crosshair.#usableMeshPredicate,
			)?.pickedMesh ?? null
		);
	}

	/** Pick a mob, resolving thin-instanced meshes to the owning instance. */
	static pickMobTarget(
		player: Player,
		maxDistance = REACH_DISTANCE,
	): { mesh: Mesh; thinInstanceIndex: number } | null {
		const info = Crosshair.#rayMarchFirstInfo(
			player,
			maxDistance,
			Crosshair.#mobMeshPredicate,
		);

		if (!info?.pickedMesh) return null;

		return {
			mesh: info.pickedMesh,
			thinInstanceIndex: info.thinInstanceIndex ?? -1,
		};
	}

	// ─── Mesh ray pick ──────────────────────────────────────────────────────

	static #rayMarchFirstInfo(
		player: Player,
		maxDistance: number,
		predicate?: (mesh: Mesh) => boolean,
	): { pickedMesh?: Mesh | null; thinInstanceIndex?: number } | null {
		// TODO(Lite API): mesh ray picking (getForwardRay / pickWithRay) is not
		// available in Lite yet; kept as a best-effort dynamic dispatch.
		const camera = player.playerCamera
			.playerCamera as unknown as LiteForwardRayCamera;
		const scene = player.sceneRef as unknown as LiteRayPickScene;

		const ray = camera.getForwardRay?.(maxDistance);
		if (!ray || !scene.pickWithRay) return null;

		return scene.pickWithRay(ray, predicate, true) ?? null;
	}
}
