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
import { type ArrowTypeDef, getArrowTypeDef } from "@/code/Entities/ArrowTypes";
import type { Mob } from "@/code/Entities/Mobs/Mob";
import { segmentMobHit } from "@/code/Entities/Mobs/MobHitTest";
import { createBoxMobMesh } from "@/code/Entities/Mobs/MobMesh";
import { getPRNGUnit2 } from "@/code/Generation/NoiseAndParameters/Squirrel13";
import { isUiOpen, UiFocus } from "@/code/Lib/GameRuntimeState";
import {
	MOB_DRIP_INTERVAL_MS,
	playArrowHit,
	playMobDrip,
} from "@/code/Maps/BlockBreakParticles";
import { Map1 } from "@/code/Maps/Map1";
import type { NetClient } from "@/code/Network/NetClient";
import { decodeArrowSpawn } from "@/code/Network/protocol/encoder";
import { MessageType } from "@/code/Network/protocol/messages";
import { dropWorldItem } from "@/code/Player/Inventory/dropWorldItem";
import { Item } from "@/code/Player/Inventory/Item";
import { getBlockByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import type { Player } from "../Player/Player";

const ARROW_MESH_NAME = "arrow";
const ARROW_MATERIAL_NAME = "arrowMat";

const ARROW_LENGTH = 0.55;
const ARROW_HALF_LENGTH = ARROW_LENGTH * 0.5;
const ARROW_TIP_OFFSET = ARROW_HALF_LENGTH - ARROW_LENGTH * 0.2;

const GRAVITY = -18;
const MAX_LIFETIME_S = 25;
const MAX_SUBSTEP = 0.5;
const INV_MAX_SUBSTEP = 1 / MAX_SUBSTEP;
/** Frame-spike guard: never simulate more than this in one tick. */
const MAX_TICK_DT = 0.1;

const MIN_DIRECTION_LENGTH_SQ = 1e-6;
const VERTICAL_DIRECTION_THRESHOLD = 0.99;

const WORLD_UP = Object.freeze({ x: 0, y: 1, z: 0 });
const VERTICAL_UP = Object.freeze({ x: 0, y: 0, z: 1 });

/** How often buffered remote bleed damage is flushed (seconds). */
const BLEED_FLUSH_INTERVAL_S = 0.5;

interface ArrowMobTransform {
	x: number;
	y: number;
	z: number;
	yaw: number;
}

type ArrowMobFollow = () => ArrowMobTransform | null;

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

	#stuckMobFollow: ArrowMobFollow | null = null;

	/** Ammunition stats for this arrow's material type. */
	readonly #arrowDef: ArrowTypeDef;

	/**
	 * Bleed target. Only the firing client tracks bleed so damage is reported
	 * once (received/relayed arrows let the shooter's client own the damage).
	 */
	#bleedMobId = -1;
	#bleedMobLocal: Mob | null = null;
	#bleedAccumulator = 0;
	#bleedFlushTimer = 0;

	readonly #stuckLocalOffset = { x: 0, y: 0, z: 0 };
	readonly #stuckDirLocal = { x: 0, y: 1, z: 0 };

	#lastDripEmitMs = 0;
	#arrayIndex = -1;

	readonly #lookDirection = { x: 0, y: 0, z: 1 };
	readonly #tip = { x: 0, y: 0, z: 0 };

	static readonly #allArrows: Arrow[] = [];
	static #observerRegistered = false;
	static readonly #networkClients = new WeakSet<NetClient>();

	static ensureNetworkHandler(net: NetClient): void {
		if (Arrow.#networkClients.has(net)) return;

		Arrow.#networkClients.add(net);

		net.addBinaryHandler((data) => {
			if (data.byteLength === 0 || data[0] !== MessageType.ArrowSpawn) {
				return;
			}

			const spawn = decodeArrowSpawn(data);

			new Arrow(
				null,
				spawn.x,
				spawn.y,
				spawn.z,
				spawn.vx,
				spawn.vy,
				spawn.vz,
				spawn.arrowType,
			);
		});
	}

	static #ensureObserver(): void {
		if (Arrow.#observerRegistered) return;

		Arrow.#observerRegistered = true;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			if (
				deltaMs <= 0 ||
				Arrow.#allArrows.length === 0 ||
				isUiOpen(UiFocus.pauseMenu)
			) {
				return;
			}

			const dt = deltaMs * 0.001;
			const arrows = Arrow.#allArrows;

			/*
			 * The moved arrow in a swap-removal came from a larger index and
			 * has therefore already been updated during this reverse pass.
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
		arrowTypeIndex = 0,
	) {
		this.#shooter = shooter;
		this.#vx = vx;
		this.#vy = vy;
		this.#vz = vz;
		this.#arrowDef = getArrowTypeDef(arrowTypeIndex);

		const mesh = createBoxMobMesh(
			ARROW_MESH_NAME,
			0.06,
			0.06,
			ARROW_LENGTH,
			this.#arrowDef.color,
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

	#orient(): boolean {
		const vx = this.#vx;
		const vy = this.#vy;
		const vz = this.#vz;
		const lengthSq = vx * vx + vy * vy + vz * vz;

		if (lengthSq < MIN_DIRECTION_LENGTH_SQ) return false;

		const invLength = 1 / Math.sqrt(lengthSq);

		this.applyLookOrientation(vx * invLength, vy * invLength, vz * invLength);

		return true;
	}

	applyLookOrientation(dx: number, dy: number, dz: number): void {
		const direction = this.#lookDirection;

		direction.x = dx;
		direction.y = dy;
		direction.z = dz;

		const up =
			Math.abs(dy) > VERTICAL_DIRECTION_THRESHOLD ? VERTICAL_UP : WORLD_UP;

		this.#mesh.rotationQuaternion.copyFrom(
			quatFromLookDirectionRH(direction, up),
		);
	}

	#updateTip(): void {
		const position = this.#mesh.position;
		const direction = this.#lookDirection;

		this.#tip.x = position.x + direction.x * ARROW_TIP_OFFSET;
		this.#tip.y = position.y + direction.y * ARROW_TIP_OFFSET;
		this.#tip.z = position.z + direction.z * ARROW_TIP_OFFSET;
	}

	tick(dt: number): void {
		if (this.#disposed) return;

		// Clamp frame spikes so a hitch never turns into a substep storm.
		dt = Math.min(dt, MAX_TICK_DT);

		this.#age += dt;

		if (this.#age > MAX_LIFETIME_S) {
			this.dispose();
			return;
		}

		if (this.#stuck) {
			this.#tickStuck(dt);
			return;
		}

		/*
		 * Semi-implicit Euler integration. Orient immediately after gravity so
		 * the swept tip and rendered shaft use the same current velocity.
		 *
		 * Previously, collision sweeps used the preceding frame's direction
		 * and orientation was updated only after all movement had completed.
		 */
		this.#vy += GRAVITY * dt;
		this.#orient();

		const vx = this.#vx;
		const vy = this.#vy;
		const vz = this.#vz;

		const speedSq = vx * vx + vy * vy + vz * vz;
		const travel = Math.sqrt(speedSq) * dt;
		const steps = Math.max(1, Math.ceil(travel * INV_MAX_SUBSTEP));
		const stepDt = dt / steps;

		const stepX = vx * stepDt;
		const stepY = vy * stepDt;
		const stepZ = vz * stepDt;

		const position = this.#mesh.position;
		const tip = this.#tip;

		for (let i = 0; i < steps; i++) {
			this.#updateTip();

			const startX = tip.x;
			const startY = tip.y;
			const startZ = tip.z;

			position.x += stepX;
			position.y += stepY;
			position.z += stepZ;

			this.#updateTip();

			if (this.#checkBlockHit() || this.#checkMobHit(startX, startY, startZ)) {
				return;
			}
		}
	}

	#tickStuck(dt: number): void {
		const follow = this.#stuckMobFollow;

		if (follow !== null) {
			const mob = follow();

			if (mob === null) {
				this.dropAsItem();
				this.dispose();
				return;
			}

			this.#applyBleed(dt);

			const cosYaw = Math.cos(mob.yaw);
			const sinYaw = Math.sin(mob.yaw);
			const offset = this.#stuckLocalOffset;
			const localDirection = this.#stuckDirLocal;

			const tipX = mob.x + cosYaw * offset.x + sinYaw * offset.z;
			const tipY = mob.y + offset.y;
			const tipZ = mob.z - sinYaw * offset.x + cosYaw * offset.z;

			this.applyLookOrientation(
				cosYaw * localDirection.x + sinYaw * localDirection.z,
				localDirection.y,
				-sinYaw * localDirection.x + cosYaw * localDirection.z,
			);

			const direction = this.#lookDirection;
			const position = this.#mesh.position;

			position.x = tipX - direction.x * ARROW_TIP_OFFSET;
			position.y = tipY - direction.y * ARROW_TIP_OFFSET;
			position.z = tipZ - direction.z * ARROW_TIP_OFFSET;

			const now = performance.now();

			if (now - this.#lastDripEmitMs >= MOB_DRIP_INTERVAL_MS) {
				this.#lastDripEmitMs = now;
				playMobDrip(tipX, tipY, tipZ);
			}
		}

		this.#stuckTimer -= dt;

		if (this.#stuckTimer <= 0) {
			this.dropAsItem();
			this.dispose();
		}
	}

	#checkBlockHit(): boolean {
		const tip = this.#tip;
		const tipX = tip.x;
		const tipY = tip.y;
		const tipZ = tip.z;

		const blockId = getBlockByWorldCoords(
			Math.floor(tipX),
			Math.floor(tipY),
			Math.floor(tipZ),
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
				tipX + nx * 0.3,
				tipY + ny * 0.3,
				tipZ + nz * 0.3,
				nx,
				ny,
				nz,
				blockId,
			);
		}

		const direction = this.#lookDirection;
		const position = this.#mesh.position;

		position.x -= direction.x * ARROW_TIP_OFFSET;
		position.y -= direction.y * ARROW_TIP_OFFSET;
		position.z -= direction.z * ARROW_TIP_OFFSET;

		this.#vx = 0;
		this.#vy = 0;
		this.#vz = 0;
		this.#stuck = true;
		this.#stuckTimer = this.#arrowDef.stickTime;

		return true;
	}

	#checkMobHit(startX: number, startY: number, startZ: number): boolean {
		const tip = this.#tip;
		const endX = tip.x;
		const endY = tip.y;
		const endZ = tip.z;

		const remoteManager = Map1.remoteMobManager;

		if (remoteManager !== null) {
			const hit = remoteManager.findSegmentHit(
				startX,
				startY,
				startZ,
				endX,
				endY,
				endZ,
			);

			if (hit === null || hit === undefined) return false;

			const shooter = this.#shooter;

			shooter?.networkManager?.netClient?.sendMobDamage(
				hit.id,
				this.#arrowDef.damage,
			);

			// Bleed is owned by the firing client; relayed arrows (no shooter)
			// let the originator report the damage.
			if (shooter !== null) {
				this.#bleedMobId = hit.id;
			}

			this.#stickTipAt(hit.x, hit.y, hit.z, () =>
				remoteManager.getMobPosition(hit.id),
			);

			return true;
		}

		const registry = Map1.mobRegistry;

		if (registry === null) return false;

		let bestT = Number.POSITIVE_INFINITY;
		let bestMob: Mob | null = null;

		for (const mob of registry.getAllMobs()) {
			const t = segmentMobHit(
				startX,
				startY,
				startZ,
				endX,
				endY,
				endZ,
				mob.position.x,
				mob.position.y,
				mob.position.z,
				mob.facingYaw,
				mob.hitHalfExtents.x,
				mob.hitHalfExtents.y,
				mob.hitHalfExtents.z,
			);

			if (t !== null && t < bestT) {
				bestT = t;
				bestMob = mob;
			}
		}

		if (bestMob === null) return false;

		// `t` is invariant under the mob's yaw rotation, so the world impact
		// point is simply the segment lerp at t — no local→world round trip.
		const hitX = startX + (endX - startX) * bestT;
		const hitY = startY + (endY - startY) * bestT;
		const hitZ = startZ + (endZ - startZ) * bestT;

		bestMob.takeDamage(this.#arrowDef.damage);

		const hitMob = bestMob;

		if (this.#shooter !== null) {
			this.#bleedMobLocal = hitMob;
		}

		this.#stickTipAt(hitX, hitY, hitZ, () =>
			hitMob.isDisposed
				? null
				: {
						x: hitMob.position.x,
						y: hitMob.position.y,
						z: hitMob.position.z,
						yaw: hitMob.facingYaw,
					},
		);

		return true;
	}

	#applyBleed(dt: number): void {
		if (this.#bleedMobId < 0 && this.#bleedMobLocal === null) return;

		this.#bleedAccumulator += dt * this.#arrowDef.bleedPerSecond;

		if (this.#bleedMobId >= 0) {
			// Network: flush accumulated fractional bleed on a fixed cadence to
			// bound message volume while still applying sub-integer damage.
			this.#bleedFlushTimer += dt;
			if (this.#bleedFlushTimer >= BLEED_FLUSH_INTERVAL_S) {
				this.#bleedFlushTimer -= BLEED_FLUSH_INTERVAL_S;
				const amount = this.#bleedAccumulator;
				this.#bleedAccumulator = 0;
				if (amount > 0) {
					this.#shooter?.networkManager?.netClient?.sendMobDamage(
						this.#bleedMobId,
						amount,
					);
				}
			}
		} else if (this.#bleedMobLocal !== null) {
			// Local: apply the fractional bleed every frame for smooth damage.
			const amount = this.#bleedAccumulator;
			this.#bleedAccumulator = 0;
			if (amount > 0) this.#bleedMobLocal.takeDamage(amount);
		}
	}

	/** Send any residual bleed damage still buffered for a remote mob. */
	#flushBleed(): void {
		if (this.#bleedMobId >= 0 && this.#bleedAccumulator > 0) {
			const amount = this.#bleedAccumulator;
			this.#bleedAccumulator = 0;
			this.#shooter?.networkManager?.netClient?.sendMobDamage(
				this.#bleedMobId,
				amount,
			);
		}
	}

	#stickTipAt(x: number, y: number, z: number, follow: ArrowMobFollow): void {
		const tip = this.#tip;

		tip.x = x;
		tip.y = y;
		tip.z = z;

		const direction = this.#lookDirection;
		const position = this.#mesh.position;

		position.x = x - direction.x * ARROW_TIP_OFFSET;
		position.y = y - direction.y * ARROW_TIP_OFFSET;
		position.z = z - direction.z * ARROW_TIP_OFFSET;

		this.#beginStickInMob(follow);
	}

	#beginStickInMob(follow: ArrowMobFollow): void {
		this.emitMobHitParticles();

		const mob = follow();

		if (mob !== null) {
			const tip = this.#tip;
			const relativeX = tip.x - mob.x;
			const relativeZ = tip.z - mob.z;
			const cosYaw = Math.cos(mob.yaw);
			const sinYaw = Math.sin(mob.yaw);

			const localOffset = this.#stuckLocalOffset;

			localOffset.x = cosYaw * relativeX - sinYaw * relativeZ;
			localOffset.y = tip.y - mob.y;
			localOffset.z = sinYaw * relativeX + cosYaw * relativeZ;

			const vx = this.#vx;
			const vy = this.#vy;
			const vz = this.#vz;
			const lengthSq = vx * vx + vy * vy + vz * vz;

			if (lengthSq > MIN_DIRECTION_LENGTH_SQ) {
				const invLength = 1 / Math.sqrt(lengthSq);
				const dx = vx * invLength;
				const dy = vy * invLength;
				const dz = vz * invLength;
				const localDirection = this.#stuckDirLocal;

				localDirection.x = cosYaw * dx - sinYaw * dz;
				localDirection.y = dy;
				localDirection.z = sinYaw * dx + cosYaw * dz;
			} else {
				/*
				 * Defensive fallback. In normal operation velocity is nonzero
				 * because this method is entered during an active flight hit.
				 */
				const direction = this.#lookDirection;
				const localDirection = this.#stuckDirLocal;

				localDirection.x = cosYaw * direction.x - sinYaw * direction.z;
				localDirection.y = direction.y;
				localDirection.z = sinYaw * direction.x + cosYaw * direction.z;
			}
		}

		this.#stuckMobFollow = follow;
		this.#vx = 0;
		this.#vy = 0;
		this.#vz = 0;
		this.#stuck = true;
		this.#stuckTimer = this.#arrowDef.stickTime;
	}

	dropAsItem(): void {
		if (this.#disposed) return;

		const position = this.#mesh.position;
		const item = Item.createById(this.#arrowDef.itemId);

		item.stackSize = 1;

		dropWorldItem(
			item,
			position.x,
			position.y,
			position.z,
			(getPRNGUnit2() - 0.5) * 1.5,
			2,
			(getPRNGUnit2() - 0.5) * 1.5,
			Map1.mainPlayer ?? undefined,
		);
	}

	private emitMobHitParticles(): void {
		const vx = this.#vx;
		const vy = this.#vy;
		const vz = this.#vz;
		const lengthSq = vx * vx + vy * vy + vz * vz;

		if (lengthSq <= MIN_DIRECTION_LENGTH_SQ) return;

		const invLength = 1 / Math.sqrt(lengthSq);
		const tip = this.#tip;

		playArrowHit(
			tip.x,
			tip.y,
			tip.z,
			-vx * invLength,
			-vy * invLength,
			-vz * invLength,
			BlockType.CoralBlock,
		);
	}

	dispose(): void {
		if (this.#disposed) return;

		this.#disposed = true;
		this.#stuckMobFollow = null;
		this.#flushBleed();

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
