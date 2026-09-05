import { onBeforeRender } from "@babylonjs/lite";
import {
	getArrowInstancePool,
	type InstanceSlotHandle,
} from "@/code/Entities/Arrow/ArrowInstancePool";
import {
	type ArrowTypeDef,
	getArrowTypeDef,
} from "@/code/Entities/Arrow/ArrowTypes";
import type { Mob } from "@/code/Entities/Mobs/Mob";
import { segmentMobHit } from "@/code/Entities/Mobs/MobHitTest";
import { getCachedLightColorForOwner } from "@/code/Entities/Mobs/MobLighting";
import { igniteChainedTnt } from "@/code/Entities/PrimedTnt";
import { getPRNGUnit2 } from "@/code/Generation/NoiseAndParameters/Squirrel13";
import { isUiOpen, UiFocus } from "@/code/Lib/GameRuntimeState";
import type { Color3 } from "@/code/Lib/Math";
import {
	MOB_DRIP_INTERVAL_MS,
	playArrowHit,
	playMobDamage,
	playMobDrip,
} from "@/code/Maps/BlockBreakParticles";
import { Map1 } from "@/code/Maps/Map1";
import type { NetClient } from "@/code/Network/NetClient";
import {
	BinaryDecoder,
	decodeArrowSpawnInto,
} from "@/code/Network/protocol/encoder";
import { MessageType } from "@/code/Network/protocol/messages";
import { dropWorldItem } from "@/code/Player/Inventory/dropWorldItem";
import { Item } from "@/code/Player/Inventory/Item";
import { packedLightToLightColor } from "@/code/Player/PlayerModel";
import {
	getBlockByWorldCoords,
	getLightByWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import { explode } from "@/code/World/Explosion";
import { isCollidableBlock } from "@/code/World/Texture/BlockType";
import type { Player } from "../../Player/Player";

const ARROW_LENGTH = 0.55;
const ARROW_TIP_OFFSET = ARROW_LENGTH * 0.2;

const GRAVITY = -18;
const MAX_LIFETIME_S = 25;
const MAX_TICK_DT = 0.1;

const MIN_DIRECTION_LENGTH_SQ = 1e-6;
const VERTICAL_DIRECTION_THRESHOLD = 0.99;
const BASIS_EPSILON_SQ = 1e-18;

const BLOCK_EMBED_DEPTH = 0.1;
const MAX_DDA_STEPS = 128;

const BLEED_FLUSH_INTERVAL_S = 0.5;
const MOB_DRIP_INTERVAL_S = MOB_DRIP_INTERVAL_MS * 0.001;

const FOLLOW_NONE = 0;
const FOLLOW_REMOTE = 1;
const FOLLOW_LOCAL = 2;

/**
 * Stationary arrows (stuck in a block) resample at most this often when
 * their voxel has not changed, so torch placement and day/night lighting
 * still update them. Mirrors MobLighting's DAY_NIGHT_FORCE_MS.
 */
const STUCK_LIGHT_FORCE_MS = 1000;

export class Arrow {
	readonly #pool: ReturnType<typeof getArrowInstancePool>;
	readonly #slot: InstanceSlotHandle;
	readonly #shooter: Player | null;
	readonly #arrowDef: ArrowTypeDef;

	#px = 0;
	#py = 0;
	#pz = 0;

	#qx = 0;
	#qy = 0;
	#qz = 0;
	#qw = 1;

	#dx = 0;
	#dy = 0;
	#dz = 1;

	#tx = 0;
	#ty = 0;
	#tz = 0;

	#vx: number;
	#vy: number;
	#vz: number;

	#stuck = false;
	#stuckTimer = 0;
	#age = 0;
	#disposed = false;
	#dripTimer = 0;

	#followMode = FOLLOW_NONE;
	#followRemoteId = -1;
	#followLocalMob: Mob | null = null;

	#fX = 0;
	#fY = 0;
	#fZ = 0;
	#fYaw = 0;

	#followYawCache = Number.NaN;
	#followCos = 1;
	#followSin = 0;

	#ox = 0;
	#oy = 0;
	#oz = 0;

	#lx = 0;
	#ly = 1;
	#lz = 0;

	#bleedMobId = -1;
	#bleedMobLocal: Mob | null = null;
	#bleedAccumulator = 0;
	#bleedFlushTimer = 0;

	/*
	 * Voxel of the last self-sampled light value. Flying arrows cross
	 * voxels every tick so they resample; stationary arrows skip the query
	 * until they cross into a new voxel or STUCK_LIGHT_FORCE_MS elapses.
	 * NaN initials force the first sample.
	 */
	#lightLX = Number.NaN;
	#lightLY = Number.NaN;
	#lightLZ = Number.NaN;
	#lastLightSampleMs = 0;

	#hitNX = 0;
	#hitNY = 1;
	#hitNZ = 0;
	#hitBlockId = 0;

	#tmpIsRemote = false;
	#tmpRemoteId = -1;
	#tmpLocalMob: Mob | null = null;
	#tmpHX = 0;
	#tmpHY = 0;
	#tmpHZ = 0;

	#arrayIndex = -1;

	static readonly #allArrows: Arrow[] = [];
	static #observerRegistered = false;
	static readonly #networkClients = new WeakSet<NetClient>();

	static #frameRemote: NonNullable<typeof Map1.remoteMobManager> | null = null;

	static #frameMobs: Iterable<Mob> | null = null;

	private static readonly _arrowSpawnScratch = {
		x: 0,
		y: 0,
		z: 0,
		vx: 0,
		vy: 0,
		vz: 0,
		arrowType: 0,
	};
	private static readonly _arrowDecoder = new BinaryDecoder(new Uint8Array(0));

	static ensureNetworkHandler(net: NetClient): void {
		if (Arrow.#networkClients.has(net)) {
			return;
		}

		Arrow.#networkClients.add(net);

		net.addBinaryHandler((data) => {
			if (data.byteLength === 0 || data[0] !== MessageType.ArrowSpawn) {
				return;
			}

			const dec = Arrow._arrowDecoder;
			dec.setBuffer(data);
			dec.readUint8();
			const spawn = decodeArrowSpawnInto(dec, Arrow._arrowSpawnScratch);

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
		if (Arrow.#observerRegistered) {
			return;
		}

		Arrow.#observerRegistered = true;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			const arrows = Arrow.#allArrows;

			if (deltaMs > 0 && arrows.length > 0 && !isUiOpen(UiFocus.pauseMenu)) {
				Arrow.#frameRemote = Map1.remoteMobManager;

				const registry = Map1.mobRegistry;
				Arrow.#frameMobs = registry === null ? null : registry.getAllMobs();

				const dt = Math.min(deltaMs * 0.001, MAX_TICK_DT);

				for (let index = arrows.length - 1; index >= 0; index--) {
					arrows[index].tick(dt);
				}
			}

			/*
			 * Sync even while paused or when the array became empty during this
			 * frame. A release may have changed the visible instance count.
			 */
			getArrowInstancePool().sync();
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

		const pool = getArrowInstancePool();
		this.#pool = pool;
		this.#slot = pool.acquire(this.#arrowDef.color);

		this.#px = x;
		this.#py = y;
		this.#pz = z;

		this.#setLookQuat(vx, vy, vz);
		this.#writeTransform();
		this.#updateLightingSelf(true);

		const arrows = Arrow.#allArrows;
		this.#arrayIndex = arrows.length;
		arrows.push(this);

		Arrow.#ensureObserver();
	}

	/**
	 * Normalizes an arbitrary direction once, then delegates to the normalized
	 * path used by the flight loop.
	 */
	#setLookQuat(dx: number, dy: number, dz: number): void {
		const lengthSq = dx * dx + dy * dy + dz * dz;

		if (lengthSq < MIN_DIRECTION_LENGTH_SQ) {
			return;
		}

		const invLength = 1 / Math.sqrt(lengthSq);

		this.#setLookQuatNormalized(dx * invLength, dy * invLength, dz * invLength);
	}

	/**
	 * Sets direction and orientation from an already normalized direction.
	 * This avoids performing a second square root in every flight tick.
	 */
	#setLookQuatNormalized(fx: number, fy: number, fz: number): void {
		this.#dx = fx;
		this.#dy = fy;
		this.#dz = fz;

		let rx: number;
		let ry: number;
		let rz: number;

		if (
			fy > VERTICAL_DIRECTION_THRESHOLD ||
			fy < -VERTICAL_DIRECTION_THRESHOLD
		) {
			// cross((0,0,1), forward)
			rx = -fy;
			ry = fx;
			rz = 0;
		} else {
			// cross((0,1,0), forward)
			rx = fz;
			ry = 0;
			rz = -fx;
		}

		const rightLengthSq = rx * rx + ry * ry + rz * rz;

		if (rightLengthSq > BASIS_EPSILON_SQ) {
			const invRightLength = 1 / Math.sqrt(rightLengthSq);
			rx *= invRightLength;
			ry *= invRightLength;
			rz *= invRightLength;
		} else {
			rx = 1;
			ry = 0;
			rz = 0;
		}

		const yx = fy * rz - fz * ry;
		const yy = fz * rx - fx * rz;
		const yz = fx * ry - fy * rx;

		const m00 = rx;
		const m11 = yy;
		const m22 = fz;
		const trace = m00 + m11 + m22;

		if (trace > 0) {
			const scale = Math.sqrt(trace + 1) * 2;

			this.#qw = 0.25 * scale;
			this.#qx = (yz - fy) / scale;
			this.#qy = (fx - rz) / scale;
			this.#qz = (ry - yx) / scale;
		} else if (m00 > m11 && m00 > m22) {
			const scale = Math.sqrt(1 + m00 - m11 - m22) * 2;

			this.#qw = (yz - fy) / scale;
			this.#qx = 0.25 * scale;
			this.#qy = (ry + yx) / scale;
			this.#qz = (rz + fx) / scale;
		} else if (m11 > m22) {
			const scale = Math.sqrt(1 + m11 - m00 - m22) * 2;

			this.#qw = (fx - rz) / scale;
			this.#qx = (ry + yx) / scale;
			this.#qy = 0.25 * scale;
			this.#qz = (yz + fy) / scale;
		} else {
			const scale = Math.sqrt(1 + m22 - m00 - m11) * 2;

			this.#qw = (ry - yx) / scale;
			this.#qx = (rz + fx) / scale;
			this.#qy = (yz + fy) / scale;
			this.#qz = 0.25 * scale;
		}
	}

	applyLookOrientation(dx: number, dy: number, dz: number): void {
		this.#setLookQuat(dx, dy, dz);
	}

	#writeTransform(): void {
		this.#pool.writeMatrix(
			this.#slot,
			this.#px,
			this.#py,
			this.#pz,
			this.#qx,
			this.#qy,
			this.#qz,
			this.#qw,
		);
	}

	recolor(color: Color3): void {
		this.#pool.writeColor(this.#slot, color.r, color.g, color.b, 1);
	}

	#applyLightColor(lightR: number, lightG: number, lightB: number): void {
		const base = this.#arrowDef.color;

		this.#pool.writeColor(
			this.#slot,
			base.r * lightR,
			base.g * lightG,
			base.b * lightB,
			1,
		);
	}

	/**
	 * Sample voxel light at the arrow's own position (sky + block light,
	 * same mix the mobs use). Skips the query while stationary in a cached
	 * voxel unless forced.
	 */
	#updateLightingSelf(force = false): void {
		const px = this.#px;
		const py = this.#py;
		const pz = this.#pz;

		const lx = Math.floor(px);
		const ly = Math.floor(py);
		const lz = Math.floor(pz);

		const now = performance.now();

		if (
			!force &&
			lx === this.#lightLX &&
			ly === this.#lightLY &&
			lz === this.#lightLZ &&
			now - this.#lastLightSampleMs < STUCK_LIGHT_FORCE_MS
		) {
			return;
		}

		const packedLight = getLightByWorldCoords(px, py, pz);
		const lightColor = packedLightToLightColor(packedLight);

		this.#applyLightColor(lightColor[0], lightColor[1], lightColor[2]);

		this.#lightLX = lx;
		this.#lightLY = ly;
		this.#lightLZ = lz;
		this.#lastLightSampleMs = now;
	}

	/**
	 * Reuse the host mob's already-computed light so an embedded arrow
	 * matches its carrier with no second voxel query. Falls back to a
	 * self-sample when the host has no live lighting entry.
	 */
	#updateLightingFromHost(): void {
		let cached: readonly [number, number, number] | null = null;

		if (this.#followMode === FOLLOW_LOCAL) {
			const mob = this.#followLocalMob;

			if (mob !== null && !mob.isDisposed) {
				cached = getCachedLightColorForOwner(mob);
			}
		} else if (this.#followMode === FOLLOW_REMOTE) {
			const manager = Arrow.#frameRemote;

			if (manager !== null && this.#followRemoteId >= 0) {
				cached = manager.getMobLightColor(this.#followRemoteId);
			}
		}

		if (cached !== null) {
			this.#applyLightColor(cached[0], cached[1], cached[2]);
			return;
		}

		this.#updateLightingSelf(true);
	}

	tick(dt: number): void {
		if (this.#disposed) {
			return;
		}

		if (dt > MAX_TICK_DT) {
			dt = MAX_TICK_DT;
		}

		this.#age += dt;

		if (this.#age > MAX_LIFETIME_S) {
			this.dispose();
			return;
		}

		if (this.#stuck) {
			this.#tickStuck(dt);
			return;
		}

		this.#vy += GRAVITY * dt;

		const vx = this.#vx;
		const vy = this.#vy;
		const vz = this.#vz;
		const speedSq = vx * vx + vy * vy + vz * vz;

		if (speedSq < MIN_DIRECTION_LENGTH_SQ) {
			/*
			 * Position and orientation did not change, so there is no reason
			 * to dirty and upload the instance matrix again. Lighting still
			 * gets a (cache-throttled) refresh for day/night changes.
			 */
			this.#updateLightingSelf();
			return;
		}

		const invSpeed = 1 / Math.sqrt(speedSq);

		this.#setLookQuatNormalized(vx * invSpeed, vy * invSpeed, vz * invSpeed);

		const stepX = vx * dt;
		const stepY = vy * dt;
		const stepZ = vz * dt;

		const sx = this.#px + this.#dx * ARROW_TIP_OFFSET;
		const sy = this.#py + this.#dy * ARROW_TIP_OFFSET;
		const sz = this.#pz + this.#dz * ARROW_TIP_OFFSET;

		const blockT = this.#sweepBlocks(sx, sy, sz, stepX, stepY, stepZ);

		const mobSpan = blockT >= 0 ? blockT : 1;

		if (
			this.#sweepMobs(
				sx,
				sy,
				sz,
				sx + stepX * mobSpan,
				sy + stepY * mobSpan,
				sz + stepZ * mobSpan,
			)
		) {
			if (this.#stickToMobHit()) {
				return;
			}
		}

		if (blockT >= 0) {
			const blastRadius = this.#arrowDef.blastRadius;
			if (blastRadius !== undefined) {
				// Explosive arrow: detonate at the impact point instead of
				// embedding. Never sticks, never drops as an item.
				this.#detonateAt(
					sx + stepX * blockT,
					sy + stepY * blockT,
					sz + stepZ * blockT,
					blastRadius,
				);
				return;
			}
			this.#stickInBlock(sx, sy, sz, stepX, stepY, stepZ, blockT);
			return;
		}

		this.#px += stepX;
		this.#py += stepY;
		this.#pz += stepZ;

		this.#writeTransform();
		this.#updateLightingSelf();
	}

	#sweepBlocks(
		sx: number,
		sy: number,
		sz: number,
		dx: number,
		dy: number,
		dz: number,
	): number {
		let ix = Math.floor(sx);
		let iy = Math.floor(sy);
		let iz = Math.floor(sz);

		let blockId = getBlockByWorldCoords(ix, iy, iz);

		if (isCollidableBlock(blockId)) {
			this.#hitBlockId = blockId;
			// Best available normal: oppose the dominant motion axis.
			const ax = dx < 0 ? -dx : dx;
			const ay = dy < 0 ? -dy : dy;
			const az = dz < 0 ? -dz : dz;

			if (ax >= ay && ax >= az) {
				this.#hitNX = dx > 0 ? -1 : 1;
				this.#hitNY = 0;
				this.#hitNZ = 0;
			} else if (ay >= az) {
				this.#hitNX = 0;
				this.#hitNY = dy > 0 ? -1 : 1;
				this.#hitNZ = 0;
			} else {
				this.#hitNX = 0;
				this.#hitNY = 0;
				this.#hitNZ = dz > 0 ? -1 : 1;
			}

			return 0;
		}

		const voxelStepX = dx > 0 ? 1 : -1;
		const voxelStepY = dy > 0 ? 1 : -1;
		const voxelStepZ = dz > 0 ? 1 : -1;

		const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
		const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
		const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

		let tMaxX =
			dx > 0 ? (ix + 1 - sx) / dx : dx < 0 ? (ix - sx) / dx : Infinity;

		let tMaxY =
			dy > 0 ? (iy + 1 - sy) / dy : dy < 0 ? (iy - sy) / dy : Infinity;

		let tMaxZ =
			dz > 0 ? (iz + 1 - sz) / dz : dz < 0 ? (iz - sz) / dz : Infinity;

		for (let visit = 0; visit < MAX_DDA_STEPS; visit++) {
			let t: number;
			let axis: number;

			if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
				t = tMaxX;
				axis = 0;
				tMaxX += tDeltaX;
				ix += voxelStepX;
			} else if (tMaxY <= tMaxZ) {
				t = tMaxY;
				axis = 1;
				tMaxY += tDeltaY;
				iy += voxelStepY;
			} else {
				t = tMaxZ;
				axis = 2;
				tMaxZ += tDeltaZ;
				iz += voxelStepZ;
			}

			if (t > 1) {
				return -1;
			}

			blockId = getBlockByWorldCoords(ix, iy, iz);

			if (!isCollidableBlock(blockId)) {
				continue;
			}

			this.#hitBlockId = blockId;

			if (axis === 0) {
				this.#hitNX = -voxelStepX;
				this.#hitNY = 0;
				this.#hitNZ = 0;
			} else if (axis === 1) {
				this.#hitNX = 0;
				this.#hitNY = -voxelStepY;
				this.#hitNZ = 0;
			} else {
				this.#hitNX = 0;
				this.#hitNY = 0;
				this.#hitNZ = -voxelStepZ;
			}

			return t;
		}

		return -1;
	}

	#sweepMobs(
		sx: number,
		sy: number,
		sz: number,
		ex: number,
		ey: number,
		ez: number,
	): boolean {
		/*
		 * Reset target references before every query. This prevents a failed
		 * or changed query from leaving an old Mob strongly referenced.
		 */
		this.#tmpIsRemote = false;
		this.#tmpRemoteId = -1;
		this.#tmpLocalMob = null;

		const remote = Arrow.#frameRemote;

		if (remote !== null) {
			const hit = remote.findSegmentHit(sx, sy, sz, ex, ey, ez);

			if (hit === null || hit === undefined) {
				return false;
			}

			this.#tmpIsRemote = true;
			this.#tmpRemoteId = hit.id;
			this.#tmpHX = hit.x;
			this.#tmpHY = hit.y;
			this.#tmpHZ = hit.z;

			return true;
		}

		const mobs = Arrow.#frameMobs;

		if (mobs === null) {
			return false;
		}

		const minX = Math.min(sx, ex);
		const minY = Math.min(sy, ey);
		const minZ = Math.min(sz, ez);
		const maxX = Math.max(sx, ex);
		const maxY = Math.max(sy, ey);
		const maxZ = Math.max(sz, ez);

		let bestT = Number.POSITIVE_INFINITY;
		let bestMob: Mob | null = null;

		for (const mob of mobs) {
			if (mob.isDisposed) {
				continue;
			}

			const position = mob.position;
			const halfExtents = mob.hitHalfExtents;

			const mx = position.x;
			const my = position.y;
			const mz = position.z;

			const hx = halfExtents.x;
			const hy = halfExtents.y;
			const hz = halfExtents.z;

			if (
				mx + hx < minX ||
				mx - hx > maxX ||
				my + hy < minY ||
				my - hy > maxY ||
				mz + hz < minZ ||
				mz - hz > maxZ
			) {
				continue;
			}

			const t = segmentMobHit(
				sx,
				sy,
				sz,
				ex,
				ey,
				ez,
				mx,
				my,
				mz,
				mob.facingYaw,
				hx,
				hy,
				hz,
			);

			if (t !== null && t < bestT) {
				bestT = t;
				bestMob = mob;
			}
		}

		if (bestMob === null) {
			return false;
		}

		this.#tmpLocalMob = bestMob;
		this.#tmpHX = sx + (ex - sx) * bestT;
		this.#tmpHY = sy + (ey - sy) * bestT;
		this.#tmpHZ = sz + (ez - sz) * bestT;

		return true;
	}

	/**
	 * Returns false if the selected local target ceased to be valid between
	 * the sweep and hit application.
	 */
	#stickToMobHit(): boolean {
		const hx = this.#tmpHX;
		const hy = this.#tmpHY;
		const hz = this.#tmpHZ;
		const shooter = this.#shooter;
		const blastRadius = this.#arrowDef.blastRadius;

		if (this.#tmpIsRemote) {
			const remoteId = this.#tmpRemoteId;

			if (remoteId < 0) {
				return false;
			}

			shooter?.playerHud.crossHair.showHitMarker();
			shooter?.networkManager?.netClient?.sendMobDamage(
				remoteId,
				this.#arrowDef.damage,
			);

			if (blastRadius !== undefined) {
				// Explosive arrow: direct hit plus detonation, no sticking.
				this.#detonateAt(hx, hy, hz, blastRadius);
				return true;
			}

			if (shooter !== null) {
				this.#bleedMobId = remoteId;
			}

			this.#followMode = FOLLOW_REMOTE;
			this.#followRemoteId = remoteId;
		} else {
			const mob = this.#tmpLocalMob;
			this.#tmpLocalMob = null;

			if (mob === null || mob.isDisposed) {
				return false;
			}

			mob.takeDamage(this.#arrowDef.damage, { x: hx, y: hy, z: hz });

			shooter?.playerHud.crossHair.showHitMarker();

			if (blastRadius !== undefined) {
				// Explosive arrow: direct hit plus detonation, no sticking.
				this.#detonateAt(hx, hy, hz, blastRadius);
				return true;
			}

			if (shooter !== null) {
				this.#bleedMobLocal = mob;
			}

			this.#followMode = FOLLOW_LOCAL;
			this.#followLocalMob = mob;
		}

		this.#tx = hx;
		this.#ty = hy;
		this.#tz = hz;

		this.#px = hx - this.#dx * ARROW_TIP_OFFSET;
		this.#py = hy - this.#dy * ARROW_TIP_OFFSET;
		this.#pz = hz - this.#dz * ARROW_TIP_OFFSET;

		this.#writeTransform();
		this.#beginStickInMob();
		this.#updateLightingFromHost();

		return true;
	}

	/**
	 * Detonate an explosive arrow at the impact point and dispose it.
	 * Only the shooter's own client syncs the crater to the server;
	 * relayed arrows explode FX-locally (same pattern as remote PrimedTnt).
	 */
	#detonateAt(x: number, y: number, z: number, blastRadius: number): void {
		explode(x, y, z, {
			radius: blastRadius,
			chainIgniter: igniteChainedTnt,
			syncExplosion: this.#shooter !== null,
		});
		this.dispose();
	}

	#stickInBlock(
		sx: number,
		sy: number,
		sz: number,
		stepX: number,
		stepY: number,
		stepZ: number,
		t: number,
	): void {
		const faceX = sx + stepX * t;
		const faceY = sy + stepY * t;
		const faceZ = sz + stepZ * t;

		const nx = this.#hitNX;
		const ny = this.#hitNY;
		const nz = this.#hitNZ;

		playArrowHit(
			faceX + nx * 0.3,
			faceY + ny * 0.3,
			faceZ + nz * 0.3,
			nx,
			ny,
			nz,
			this.#hitBlockId,
		);

		const tipX = faceX + this.#dx * BLOCK_EMBED_DEPTH;
		const tipY = faceY + this.#dy * BLOCK_EMBED_DEPTH;
		const tipZ = faceZ + this.#dz * BLOCK_EMBED_DEPTH;

		this.#tx = tipX;
		this.#ty = tipY;
		this.#tz = tipZ;

		this.#px = tipX - this.#dx * ARROW_TIP_OFFSET;
		this.#py = tipY - this.#dy * ARROW_TIP_OFFSET;
		this.#pz = tipZ - this.#dz * ARROW_TIP_OFFSET;

		this.#vx = 0;
		this.#vy = 0;
		this.#vz = 0;

		this.#stuck = true;
		this.#stuckTimer = this.#arrowDef.stickTime;

		this.#writeTransform();
		this.#updateLightingSelf(true);
	}

	#tickStuck(dt: number): void {
		if (this.#followMode !== FOLLOW_NONE) {
			if (!this.#resolveFollowTarget()) {
				this.dropAsItem();
				this.dispose();
				return;
			}

			this.#applyBleed(dt);

			const yaw = this.#fYaw;

			if (yaw !== this.#followYawCache) {
				this.#followYawCache = yaw;
				this.#followCos = Math.cos(yaw);
				this.#followSin = Math.sin(yaw);
			}

			const cosYaw = this.#followCos;
			const sinYaw = this.#followSin;

			const tipX = this.#fX + cosYaw * this.#ox + sinYaw * this.#oz;

			const tipY = this.#fY + this.#oy;

			const tipZ = this.#fZ - sinYaw * this.#ox + cosYaw * this.#oz;

			const directionX = cosYaw * this.#lx + sinYaw * this.#lz;

			const directionZ = -sinYaw * this.#lx + cosYaw * this.#lz;

			/*
			 * Rotating a unit vector around Y preserves its length, so the
			 * normalized path avoids another square root.
			 */
			this.#setLookQuatNormalized(directionX, this.#ly, directionZ);

			this.#tx = tipX;
			this.#ty = tipY;
			this.#tz = tipZ;

			this.#px = tipX - this.#dx * ARROW_TIP_OFFSET;
			this.#py = tipY - this.#dy * ARROW_TIP_OFFSET;
			this.#pz = tipZ - this.#dz * ARROW_TIP_OFFSET;

			this.#writeTransform();
			this.#updateLightingFromHost();

			this.#dripTimer -= dt;

			if (this.#dripTimer <= 0) {
				/*
				 * The frame delta is capped below the drip interval in normal
				 * configurations. The loop also remains correct if that
				 * relationship changes later.
				 */
				do {
					this.#dripTimer += MOB_DRIP_INTERVAL_S;
				} while (this.#dripTimer <= 0);

				playMobDrip(tipX, tipY, tipZ, this.#arrowDef.bleedPerSecond);
			}
		} else {
			/*
			 * Stuck in a block and stationary: the throttled self-sample
			 * keeps torch and day/night changes updating the tint.
			 */
			this.#updateLightingSelf();
		}

		this.#stuckTimer -= dt;

		if (this.#stuckTimer <= 0) {
			this.dropAsItem();
			this.dispose();
		}
	}

	#resolveFollowTarget(): boolean {
		if (this.#followMode === FOLLOW_REMOTE) {
			/*
			 * Use the same manager snapshot that collision detection used for
			 * this frame rather than re-reading mutable global state.
			 */
			const manager = Arrow.#frameRemote;

			if (manager === null) {
				return false;
			}

			const position = manager.getMobPosition(this.#followRemoteId);

			if (position === null || position === undefined) {
				return false;
			}

			this.#fX = position.x;
			this.#fY = position.y;
			this.#fZ = position.z;
			this.#fYaw = position.yaw;

			return true;
		}

		const mob = this.#followLocalMob;

		if (mob === null || mob.isDisposed) {
			return false;
		}

		const position = mob.position;

		this.#fX = position.x;
		this.#fY = position.y;
		this.#fZ = position.z;
		this.#fYaw = mob.facingYaw;

		return true;
	}

	#beginStickInMob(): void {
		if (this.#resolveFollowTarget()) {
			playMobDamage(this.#tx, this.#ty, this.#tz, this.#arrowDef.damage);

			const yaw = this.#fYaw;
			const cosYaw = Math.cos(yaw);
			const sinYaw = Math.sin(yaw);

			const relX = this.#tx - this.#fX;
			const relZ = this.#tz - this.#fZ;

			this.#ox = cosYaw * relX - sinYaw * relZ;
			this.#oy = this.#ty - this.#fY;
			this.#oz = sinYaw * relX + cosYaw * relZ;

			this.#lx = cosYaw * this.#dx - sinYaw * this.#dz;

			this.#ly = this.#dy;

			this.#lz = sinYaw * this.#dx + cosYaw * this.#dz;

			this.#followYawCache = yaw;
			this.#followCos = cosYaw;
			this.#followSin = sinYaw;
		}

		this.#vx = 0;
		this.#vy = 0;
		this.#vz = 0;

		this.#stuck = true;
		this.#stuckTimer = this.#arrowDef.stickTime;
		this.#dripTimer = 0;
	}

	#applyBleed(dt: number): void {
		if (this.#bleedMobId < 0 && this.#bleedMobLocal === null) {
			return;
		}

		this.#bleedAccumulator += dt * this.#arrowDef.bleedPerSecond;

		if (this.#bleedMobId >= 0) {
			this.#bleedFlushTimer += dt;

			if (this.#bleedFlushTimer >= BLEED_FLUSH_INTERVAL_S) {
				/*
				 * Preserve residual elapsed time without a potentially growing
				 * loop if tick clamping or the interval is changed.
				 */
				this.#bleedFlushTimer %= BLEED_FLUSH_INTERVAL_S;

				const amount = this.#bleedAccumulator;
				this.#bleedAccumulator = 0;

				if (amount > 0) {
					this.#shooter?.networkManager?.netClient?.sendMobDamage(
						this.#bleedMobId,
						amount,
					);
				}
			}

			return;
		}

		const mob = this.#bleedMobLocal;

		if (mob === null || mob.isDisposed) {
			this.#bleedMobLocal = null;
			this.#bleedAccumulator = 0;
			return;
		}

		const amount = this.#bleedAccumulator;
		this.#bleedAccumulator = 0;

		if (amount > 0) {
			mob.takeDamage(amount);
		}
	}

	#flushBleed(): void {
		if (this.#bleedMobId < 0 || this.#bleedAccumulator <= 0) {
			return;
		}

		const amount = this.#bleedAccumulator;
		this.#bleedAccumulator = 0;

		this.#shooter?.networkManager?.netClient?.sendMobDamage(
			this.#bleedMobId,
			amount,
		);
	}

	dropAsItem(): void {
		if (this.#disposed) {
			return;
		}

		if (
			this.#shooter === null &&
			Map1.mainPlayer?.networkManager?.netClient?.isConnected
		) {
			return;
		}

		const item = Item.createById(this.#arrowDef.itemId);
		item.stackSize = 1;

		dropWorldItem(
			item,
			this.#px,
			this.#py,
			this.#pz,
			(getPRNGUnit2() - 0.5) * 1.5,
			2,
			(getPRNGUnit2() - 0.5) * 1.5,
			Map1.mainPlayer ?? undefined,
		);
	}

	dispose(): void {
		if (this.#disposed) {
			return;
		}

		this.#disposed = true;

		/*
		 * Flush while the remote bleed target and shooter reference are still
		 * intact.
		 */
		this.#flushBleed();

		this.#followMode = FOLLOW_NONE;
		this.#followRemoteId = -1;
		this.#followLocalMob = null;

		this.#tmpRemoteId = -1;
		this.#tmpLocalMob = null;

		this.#bleedMobId = -1;
		this.#bleedMobLocal = null;

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
		this.#pool.release(this.#slot);
	}
}
