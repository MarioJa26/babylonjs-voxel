import { type SceneContext, type Vec3, vec3 } from "@babylonjs/lite";
import { Color3 } from "@/code/Lib/Math";
import { resolveBlockAtWorldCoords } from "../../World/Chunk/ChunkLoadingSystem";
import { BlockType, isCollidableBlock } from "../../World/Texture/BlockType";
import { getMobStats, LEAF_BLOCK_IDS, MobTypeId } from "../MobConfig";
import { FlyingMob } from "./FlyingMob";
import { dropMobItemsForType } from "./MobDrops";
import { type InstanceSlotHandle, MobInstancePool } from "./MobInstancePool";
import { registerMobLight, unregisterMobLight } from "./MobLighting";
import type { MobPartSpec } from "./MobMesh";
import {
	MOB_SONGBIRD_SKIN_PATH,
	SONGBIRD_BEAK_UV,
	SONGBIRD_BODY_UV,
	SONGBIRD_HEAD_UV,
	SONGBIRD_LEG_L_UV,
	SONGBIRD_LEG_R_UV,
	SONGBIRD_TAIL_UV,
	SONGBIRD_WING_L_UV,
	SONGBIRD_WING_R_UV,
} from "./MobSkin";
import { spawnXpOrbs } from "./XpOrb";

const SONGBIRD_MOB_TYPE = "songbird";
const SONGBIRD_STATS = getMobStats(MobTypeId.Songbird);
const SONGBIRD_DEFAULT_HP = SONGBIRD_STATS.hp;
const SONGBIRD_WANDER_SPEED = SONGBIRD_STATS.speed;

// Songbird anatomy: same small-flier plan as the bird, slightly smaller.
// Wings (partIds 5/6) flap in flight and fold when perched as the flap
// phase decays; legs (3/4) stand on the leaf while perched.
const SONGBIRD_PARTS: readonly MobPartSpec[] = [
	{
		width: 0.24,
		height: 0.18,
		depth: 0.32,
		x: 0,
		y: 0,
		z: 0,
		uv: SONGBIRD_BODY_UV,
	},
	{
		width: 0.15,
		height: 0.15,
		depth: 0.15,
		x: 0,
		y: 0.13,
		z: 0.18,
		uv: SONGBIRD_HEAD_UV,
	},
	{
		width: 0.06,
		height: 0.05,
		depth: 0.08,
		x: 0,
		y: 0.12,
		z: 0.29,
		uv: SONGBIRD_BEAK_UV,
	},
	{
		width: 0.12,
		height: 0.04,
		depth: 0.18,
		x: 0,
		y: 0.01,
		z: -0.23,
		uv: SONGBIRD_TAIL_UV,
	},
	{
		width: 0.26,
		height: 0.03,
		depth: 0.16,
		x: -0.25,
		y: 0.05,
		z: -0.02,
		uv: SONGBIRD_WING_L_UV,
		partId: 5,
	},
	{
		width: 0.26,
		height: 0.03,
		depth: 0.16,
		x: 0.25,
		y: 0.05,
		z: -0.02,
		uv: SONGBIRD_WING_R_UV,
		partId: 6,
	},
	{
		width: 0.04,
		height: 0.08,
		depth: 0.04,
		x: -0.05,
		y: -0.11,
		z: 0.02,
		uv: SONGBIRD_LEG_L_UV,
		partId: 3,
	},
	{
		width: 0.04,
		height: 0.08,
		depth: 0.04,
		x: 0.05,
		y: -0.11,
		z: 0.02,
		uv: SONGBIRD_LEG_R_UV,
		partId: 4,
	},
];

export const SONGBIRD_HIT_HALF = { x: 0.2, y: 0.15, z: 0.2 };
const SONGBIRD_BODY_HALF_SIZE = vec3(
	SONGBIRD_HIT_HALF.x,
	SONGBIRD_HIT_HALF.y,
	SONGBIRD_HIT_HALF.z,
);

const SONGBIRD_SHOULDER_PIVOT_Y = 0.05;
const SONGBIRD_HIP_PIVOT_Y = -0.09;
const SONGBIRD_WALK_AMP = 0.9;

/** Leaf-search tuning (all in blocks). */
const PERCH_SCAN_RADIUS = 20;
const PERCH_SCAN_ATTEMPTS = 8;
const PERCH_SCAN_BELOW = 10;
const PERCH_SCAN_ABOVE = 12;
/** Perch rest duration range (seconds). */
const PERCH_REST_MIN = 4;
const PERCH_REST_MAX = 10;
/** Ground-sit rest duration range (seconds) between hops. */
const SIT_REST_MIN = 2;
const SIT_REST_MAX = 6;
/** Hop distance range (blocks) for ground-to-ground movement. */
const HOP_MIN = 1.5;
const HOP_MAX = 6;
/** Chance a grounded songbird takes off instead of hopping. */
const TAKEOFF_CHANCE = 0.45;
/** Chance a flying songbird lands on the ground instead of perching. */
const LANDING_CHANCE = 0.22;
/** Fallback circle legs when no leaves are nearby. */
const CIRCLE_MIN = 10;
const CIRCLE_MAX = 18;

let bodyPool: MobInstancePool | null = null;
function getBodyPool(): MobInstancePool {
	bodyPool ??= new MobInstancePool({
		name: "songbirdInstances",
		parts: SONGBIRD_PARTS,
		skinPath: MOB_SONGBIRD_SKIN_PATH,
		instanceColors: true,
		tint: Color3.White(),
		hipPivotY: SONGBIRD_HIP_PIVOT_Y,
		shoulderPivotY: SONGBIRD_SHOULDER_PIVOT_Y,
		walkAmp: SONGBIRD_WALK_AMP,
	});
	return bodyPool;
}

/** Shared instance pool — remote (server-authoritative) songbirds render
 * through the same textured instanced mesh as local ones. */
export function getSongbirdInstancePool(): MobInstancePool {
	return getBodyPool();
}

export class Songbird extends FlyingMob {
	readonly mobType = SONGBIRD_MOB_TYPE;

	/** What the last picked waypoint was (rest behavior on arrival). */
	#lastKind: "perch" | "ground" | "air" = "air";
	/** True while sitting on the ground (hopping between rests). */
	#grounded = false;

	#bodySlot: InstanceSlotHandle;

	constructor(
		x: number,
		y: number,
		z: number,
		scene: SceneContext,
		hp?: number,
	) {
		super(
			hp ?? SONGBIRD_DEFAULT_HP,
			scene,
			SONGBIRD_BODY_HALF_SIZE,
			SONGBIRD_STATS.feetHeight,
		);

		this.setPosition(x, y, z);
		// Natural and egg spawns both start on the ground: sit first, then
		// hop around or take off once the opening rest expires.
		this.#grounded = true;
		this.holdStill(1.5 + Math.random() * 2);
		this.#bodySlot = getBodyPool().acquire(this);
		getBodyPool().writeColor(this.#bodySlot, 1, 1, 1, 0);
		this.syncToInstances();
		this.finalizeRegistration();
		registerMobLight({
			pool: getBodyPool(),
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [1, 1, 1],
			owner: this,
		});
	}

	protected override syncToInstances(): void {
		const pos = this.position;
		const pool = getBodyPool();
		pool.writeMatrix(this.#bodySlot, pos.x, pos.y, pos.z, this.facingYaw);
		pool.writeWalkPhase(this.#bodySlot, this.walkPhase);
	}

	getWanderSpeed(): number {
		return SONGBIRD_WANDER_SPEED;
	}

	protected override pickWaypoint(pos: Vec3): Vec3 | null {
		// Grounded: mostly hop to a nearby ground spot, sometimes take off.
		if (this.#grounded) {
			if (Math.random() >= TAKEOFF_CHANCE) {
				const hop = this.#findGroundSpot(pos, HOP_MIN, HOP_MAX);
				if (hop) {
					this.#lastKind = "ground";
					return hop;
				}
			}
			this.#grounded = false;
		}

		// Airborne: land nearby, perch on a leaf, or circle — in that order.
		if (Math.random() < LANDING_CHANCE) {
			const landing = this.#findGroundSpot(pos, HOP_MIN, HOP_MAX + 4);
			if (landing) {
				this.#lastKind = "ground";
				return landing;
			}
		}

		const perch = this.#findPerch(pos);
		if (perch) {
			this.#lastKind = "perch";
			return perch;
		}

		// No leaves nearby: circle at cruise altitude instead of landing.
		this.#lastKind = "air";
		const angle = Math.random() * Math.PI * 2;
		const dist = CIRCLE_MIN + Math.random() * (CIRCLE_MAX - CIRCLE_MIN);
		return vec3(
			pos.x + Math.sin(angle) * dist,
			pos.y + (Math.random() * 4 - 2),
			pos.z + Math.cos(angle) * dist,
		);
	}

	protected override onWaypointReached(): void {
		if (this.#lastKind === "perch") {
			this.#lastKind = "air";
			this.holdStill(
				PERCH_REST_MIN + Math.random() * (PERCH_REST_MAX - PERCH_REST_MIN),
			);
		} else if (this.#lastKind === "ground") {
			this.#lastKind = "air";
			this.#grounded = true;
			this.holdStill(
				SIT_REST_MIN + Math.random() * (SIT_REST_MAX - SIT_REST_MIN),
			);
		}
	}

	protected override onDamaged(): void {
		// Flushed off the ground (or leaf) like everything else is flushed
		// out of a hold: panic clears the hold timer in the base tick.
		this.#grounded = false;
		super.onDamaged();
	}

	/**
	 * Scan nearby columns for solid ground with headroom. Returns the rest
	 * center (ground top + feet) or null when nothing suitable is around.
	 */
	#findGroundSpot(pos: Vec3, minDist: number, maxDist: number): Vec3 | null {
		const baseY = Math.floor(pos.y);

		for (let attempt = 0; attempt < PERCH_SCAN_ATTEMPTS; attempt++) {
			const angle = Math.random() * Math.PI * 2;
			const dist = minDist + Math.random() * (maxDist - minDist);
			const cx = Math.floor(pos.x + Math.sin(angle) * dist);
			const cz = Math.floor(pos.z + Math.cos(angle) * dist);

			for (let y = baseY + 2; y >= baseY - 8; y--) {
				const below = resolveBlockAtWorldCoords(cx, y, cz);
				if (!below.loaded) break;
				const head = resolveBlockAtWorldCoords(cx, y + 1, cz);
				if (!head.loaded) break;
				const head2 = resolveBlockAtWorldCoords(cx, y + 2, cz);
				if (!head2.loaded) break;

				if (
					isCollidableBlock(below.blockId) &&
					head.blockId === BlockType.Air &&
					head2.blockId === BlockType.Air
				) {
					return vec3(cx + 0.5, y + 1 + SONGBIRD_STATS.feetHeight, cz + 0.5);
				}
			}
		}

		return null;
	}

	/**
	 * Scan nearby columns for a leaf top with headroom. Returns the perch
	 * center (leaf top + feet) or null when nothing suitable is around.
	 */
	#findPerch(pos: Vec3): Vec3 | null {
		const baseY = Math.floor(pos.y);

		for (let attempt = 0; attempt < PERCH_SCAN_ATTEMPTS; attempt++) {
			const angle = Math.random() * Math.PI * 2;
			const dist = 6 + Math.random() * (PERCH_SCAN_RADIUS - 6);
			const cx = Math.floor(pos.x + Math.sin(angle) * dist);
			const cz = Math.floor(pos.z + Math.cos(angle) * dist);

			for (
				let y = baseY + PERCH_SCAN_ABOVE;
				y >= baseY - PERCH_SCAN_BELOW;
				y--
			) {
				const below = resolveBlockAtWorldCoords(cx, y, cz);
				if (!below.loaded) break;
				const head = resolveBlockAtWorldCoords(cx, y + 1, cz);
				if (!head.loaded) break;
				const head2 = resolveBlockAtWorldCoords(cx, y + 2, cz);
				if (!head2.loaded) break;

				if (
					LEAF_BLOCK_IDS.has(below.blockId) &&
					head.blockId === BlockType.Air &&
					head2.blockId === BlockType.Air
				) {
					return vec3(cx + 0.5, y + 1 + SONGBIRD_STATS.feetHeight, cz + 0.5);
				}
			}
		}

		return null;
	}

	onDeath(): void {
		const pos = this.position;
		dropMobItemsForType("songbird", pos.x, pos.y, pos.z);
		spawnXpOrbs(pos.x, pos.y, pos.z, 1, 1);
	}

	dispose(): void {
		if (this.isDisposed) return;
		unregisterMobLight(this.#bodySlot);
		getBodyPool().release(this.#bodySlot);
		super.dispose();
	}
}
