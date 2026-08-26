/**
 * Arrow — client-side bow projectile.
 *
 * Flies along an initial velocity with gravity, sticks into the first solid
 * block and despawns shortly after, and damages the first mob it touches.
 *
 * Mob damage is mode-aware:
 * - Multiplayer: hits are resolved against server-authoritative mobs
 *   (RemoteMobManager) and reported via the MobDamage message; the server
 *   applies HP and broadcasts the despawn on death.
 * - Singleplayer: hits call takeDamage() on local MobRegistry mobs directly.
 */

import {
	addToScene,
	type Mesh,
	onBeforeRender,
	quatFromLookDirectionRH,
	removeFromScene,
} from "@babylonjs/lite";
import { createBoxMobMesh } from "@/code/Entities/Mobs/MobMesh";
import { isUiOpen, UiFocus } from "@/code/Lib/GameRuntimeState";
import { Color3 } from "@/code/Lib/Math";
import { playArrowHit } from "@/code/Maps/BlockBreakParticles";
import { Map1 } from "@/code/Maps/Map1";
import type { NetClient } from "@/code/Network/NetClient";
import { decodeArrowSpawn } from "@/code/Network/protocol/encoder";
import { MessageType } from "@/code/Network/protocol/messages";
import { getBlockByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import type { Player } from "../Player/Player";

const ARROW_MESH_NAME = "arrow";
const ARROW_MATERIAL_NAME = "arrowMat";
const ARROW_COLOR = new Color3(0.45, 0.32, 0.18);

// Physics.
const GRAVITY = -18;
const MAX_LIFETIME_S = 25;
const STICK_TIME_S = 15;
const MAX_SUBSTEP = 0.5;
const INV_MAX_SUBSTEP = 1 / MAX_SUBSTEP;

// Avoid repeated multiplication and square-root thresholds.
const MIN_DIRECTION_LENGTH_SQ = 1e-6;
const VERTICAL_DIRECTION_THRESHOLD = 0.99;

// Hit-scan radius around the arrow tip.
const MOB_HIT_RADIUS = 0.55;
const MOB_HIT_RADIUS_SQ = MOB_HIT_RADIUS * MOB_HIT_RADIUS;

// Shared immutable orientation vectors avoid allocating an up vector each tick.
const WORLD_UP = Object.freeze({ x: 0, y: 1, z: 0 });
const VERTICAL_UP = Object.freeze({ x: 0, y: 0, z: 1 });

/** Damage dealt per arrow hit. */
export const ARROW_DAMAGE = 2;

export class Arrow {
	readonly #mesh: Mesh;
	readonly #shooter: Player | null;

	#vx: number;
	#vy: number;
	#vz: number;

	#stuck = false;
	#stuckTimer = 0;
	#age = 0;
	#disposed = false;

	/**
	 * Index inside #allArrows.
	 *
	 * This lets dispose() use O(1) swap-removal instead of calling indexOf(),
	 * which becomes expensive when many arrows expire in the same frame.
	 */
	#arrayIndex = -1;

	/**
	 * Reused direction object for orientation. quatFromLookDirectionRH reads
	 * this synchronously, so no per-frame direction object is required.
	 */
	readonly #lookDirection = { x: 0, y: 0, z: 1 };

	static readonly #allArrows: Arrow[] = [];
	static #observerRegistered = false;
	static readonly #networkClients = new WeakSet<NetClient>();

	/**
	 * Register the ArrowSpawn relay handler on a NetClient.
	 * Registration is idempotent for each live NetClient.
	 */
	static ensureNetworkHandler(net: NetClient): void {
		if (Arrow.#networkClients.has(net)) return;

		Arrow.#networkClients.add(net);

		net.addBinaryHandler((data) => {
			if (data.byteLength === 0 || data[0] !== MessageType.ArrowSpawn) {
				return;
			}

			const spawn = decodeArrowSpawn(data);

			new Arrow(null, spawn.x, spawn.y, spawn.z, spawn.vx, spawn.vy, spawn.vz);
		});
	}

	static #ensureObserver(): void {
		if (Arrow.#observerRegistered) return;

		Arrow.#observerRegistered = true;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			if (deltaMs <= 0 || isUiOpen(UiFocus.pauseMenu)) return;

			const dt = deltaMs * 0.001;
			const arrows = Arrow.#allArrows;

			/*
			 * Iterate backward because tick() can remove the current arrow by
			 * swapping the last element into its array position.
			 */
			for (let i = arrows.length - 1; i >= 0; i--) {
				arrows[i].tick(dt);
			}
		});
	}

	constructor(
		shooter: Player | null,
		x: number,
		y: number,
		z: number,
		vx: number,
		vy: number,
		vz: number,
	) {
		this.#shooter = shooter;
		this.#vx = vx;
		this.#vy = vy;
		this.#vz = vz;

		// Long axis is Z; tick() orients the mesh along the velocity.
		const mesh = createBoxMobMesh(
			ARROW_MESH_NAME,
			0.06,
			0.06,
			0.55,
			ARROW_COLOR,
			ARROW_MATERIAL_NAME,
		);

		this.#mesh = mesh;

		mesh.pickable = false;
		mesh.position.set(x, y, z);

		this.#orient();
		addToScene(Map1.mainScene, mesh);

		const arrows = Arrow.#allArrows;
		this.#arrayIndex = arrows.length;
		arrows.push(this);

		Arrow.#ensureObserver();
	}

	#orient(): void {
		const vx = this.#vx;
		const vy = this.#vy;
		const vz = this.#vz;
		const lengthSq = vx * vx + vy * vy + vz * vz;

		if (lengthSq < MIN_DIRECTION_LENGTH_SQ) return;

		const invLength = 1 / Math.sqrt(lengthSq);
		const direction = this.#lookDirection;

		direction.x = vx * invLength;
		direction.y = vy * invLength;
		direction.z = vz * invLength;

		/*
		 * Near-vertical flight needs an up vector that is not parallel to the
		 * flight direction.
		 */
		const up =
			Math.abs(direction.y) > VERTICAL_DIRECTION_THRESHOLD
				? VERTICAL_UP
				: WORLD_UP;

		this.#mesh.rotationQuaternion.copyFrom(
			quatFromLookDirectionRH(direction, up),
		);
	}

	tick(dt: number): void {
		if (this.#disposed) return;

		const age = this.#age + dt;
		this.#age = age;

		if (age > MAX_LIFETIME_S) {
			this.dispose();
			return;
		}

		if (this.#stuck) {
			const remaining = this.#stuckTimer - dt;
			this.#stuckTimer = remaining;

			if (remaining <= 0) {
				this.dispose();
			}

			return;
		}

		// Apply gravity once per rendered simulation interval.
		const vy = this.#vy + GRAVITY * dt;
		this.#vy = vy;

		const vx = this.#vx;
		const vz = this.#vz;
		const speedSq = vx * vx + vy * vy + vz * vz;
		const travel = Math.sqrt(speedSq) * dt;

		// Multiplication is slightly cheaper than division in this hot path.
		const steps = Math.max(1, Math.ceil(travel * INV_MAX_SUBSTEP));
		const stepDt = dt / steps;

		const stepX = vx * stepDt;
		const stepY = vy * stepDt;
		const stepZ = vz * stepDt;

		const position = this.#mesh.position;

		for (let i = 0; i < steps; i++) {
			position.x += stepX;
			position.y += stepY;
			position.z += stepZ;

			// Preserve the original collision priority: blocks before mobs.
			if (this.#checkBlockHit() || this.#checkMobHit()) {
				return;
			}
		}

		this.#orient();
	}

	#checkBlockHit(): boolean {
		const position = this.#mesh.position;
		const blockId = getBlockByWorldCoords(
			Math.floor(position.x),
			Math.floor(position.y),
			Math.floor(position.z),
		);

		if (!isCollidableBlock(blockId)) return false;

		const vx = this.#vx;
		const vy = this.#vy;
		const vz = this.#vz;
		const lengthSq = vx * vx + vy * vy + vz * vz;

		if (lengthSq > MIN_DIRECTION_LENGTH_SQ) {
			const invLength = 1 / Math.sqrt(lengthSq);

			let nx = -vx * invLength;
			let ny = -vy * invLength;
			let nz = -vz * invLength;

			const ax = Math.abs(nx);
			const ay = Math.abs(ny);
			const az = Math.abs(nz);

			if (ax >= ay && ax >= az) {
				nx = Math.sign(nx);
				ny = 0;
				nz = 0;
			} else if (ay >= az) {
				nx = 0;
				ny = Math.sign(ny);
				nz = 0;
			} else {
				nx = 0;
				ny = 0;
				nz = Math.sign(nz);
			}

			playArrowHit(
				Map1.mainScene,
				position.x + nx * 0.3,
				position.y + ny * 0.3,
				position.z + nz * 0.3,
				nx,
				ny,
				nz,
				blockId,
			);
		}

		this.#vx = 0;
		this.#vy = 0;
		this.#vz = 0;
		this.#stuck = true;
		this.#stuckTimer = STICK_TIME_S;

		return true;
	}

	#checkMobHit(): boolean {
		const position = this.#mesh.position;
		const x = position.x;
		const y = position.y;
		const z = position.z;

		// Multiplayer targets are authoritative server mobs.
		const remoteManager = Map1.remoteMobManager;

		if (remoteManager != null) {
			const mobId = remoteManager.getMobIdNear(x, y, z, MOB_HIT_RADIUS_SQ);

			if (mobId === null) return false;

			this.emitMobHitParticles();

			this.#shooter?.networkManager?.netClient?.sendMobDamage(
				mobId,
				ARROW_DAMAGE,
			);

			this.dispose();
			return true;
		}

		const registry = Map1.mobRegistry;
		if (registry == null) return false;

		for (const mob of registry.getAllMobs()) {
			const mobPosition = mob.position;
			const dx = mobPosition.x - x;
			const dy = mobPosition.y - y;
			const dz = mobPosition.z - z;

			if (dx * dx + dy * dy + dz * dz > MOB_HIT_RADIUS_SQ) {
				continue;
			}

			this.emitMobHitParticles();

			mob.takeDamage(ARROW_DAMAGE);
			this.dispose();
			return true;
		}

		return false;
	}

	/**
	 * Red impact burst when an arrow lands on a mob. Uses the coral block
	 * texture as a stand-in "blood" tile; particles spray back along the
	 * arrow's incoming direction. Called before dispose() so velocity is
	 * still intact.
	 */
	private emitMobHitParticles(): void {
		const vx = this.#vx;
		const vy = this.#vy;
		const vz = this.#vz;
		const lengthSq = vx * vx + vy * vy + vz * vz;
		if (lengthSq <= MIN_DIRECTION_LENGTH_SQ) return;

		const invLength = 1 / Math.sqrt(lengthSq);
		const position = this.#mesh.position;

		playArrowHit(
			Map1.mainScene,
			position.x,
			position.y,
			position.z,
			-vx * invLength,
			-vy * invLength,
			-vz * invLength,
			BlockType.CoralBlock,
		);
	}

	dispose(): void {
		if (this.#disposed) return;

		this.#disposed = true;

		const arrows = Arrow.#allArrows;
		const index = this.#arrayIndex;
		const lastIndex = arrows.length - 1;

		if (index >= 0 && index <= lastIndex) {
			if (index !== lastIndex) {
				const movedArrow = arrows[lastIndex];
				arrows[index] = movedArrow;
				movedArrow.#arrayIndex = index;
			}

			arrows.pop();
		}

		this.#arrayIndex = -1;
		removeFromScene(Map1.mainScene, this.#mesh);
	}
}
