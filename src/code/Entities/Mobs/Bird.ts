import { type SceneContext, type Vec3, vec3 } from "@babylonjs/lite";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import { getMobStats, MobTypeId } from "../MobConfig";
import { FlyingMob } from "./FlyingMob";
import type { MobRegistry } from "./Mob";
import { dropMobItemsForType } from "./MobDrops";
import { type InstanceSlotHandle, MobInstancePool } from "./MobInstancePool";
import { registerMobLight, unregisterMobLight } from "./MobLighting";
import type { MobPartSpec } from "./MobMesh";
import {
	BIRD_BEAK_UV,
	BIRD_BODY_UV,
	BIRD_HEAD_UV,
	BIRD_LEG_L_UV,
	BIRD_LEG_R_UV,
	BIRD_TAIL_UV,
	BIRD_WING_L_UV,
	BIRD_WING_R_UV,
	MOB_BIRD_SKIN_PATH,
} from "./MobSkin";
import { spawnXpOrbs } from "./XpOrb";

const BIRD_MOB_TYPE = "bird";
const BIRD_STATS = getMobStats(MobTypeId.Bird);
const BIRD_DEFAULT_HP = BIRD_STATS.hp;
const BIRD_WANDER_SPEED = BIRD_STATS.speed;

// Bird anatomy: plump body + head + beak + tail + two flapping wings
// (partIds 5/6, Z-axis flap in the mob shader) + tiny dangling legs.
// Every bird renders through this ONE shared thin-instanced mesh.
const BIRD_PARTS: readonly MobPartSpec[] = [
	{
		width: 0.3,
		height: 0.22,
		depth: 0.38,
		x: 0,
		y: 0,
		z: 0,
		uv: BIRD_BODY_UV,
	},
	{
		width: 0.18,
		height: 0.18,
		depth: 0.18,
		x: 0,
		y: 0.16,
		z: 0.22,
		uv: BIRD_HEAD_UV,
	},
	{
		width: 0.07,
		height: 0.06,
		depth: 0.1,
		x: 0,
		y: 0.14,
		z: 0.35,
		uv: BIRD_BEAK_UV,
	},
	{
		width: 0.14,
		height: 0.04,
		depth: 0.22,
		x: 0,
		y: 0.02,
		z: -0.28,
		uv: BIRD_TAIL_UV,
	},
	{
		width: 0.32,
		height: 0.03,
		depth: 0.2,
		x: -0.31,
		y: 0.06,
		z: -0.02,
		uv: BIRD_WING_L_UV,
		partId: 5,
	},
	{
		width: 0.32,
		height: 0.03,
		depth: 0.2,
		x: 0.31,
		y: 0.06,
		z: -0.02,
		uv: BIRD_WING_R_UV,
		partId: 6,
	},
	{
		width: 0.04,
		height: 0.08,
		depth: 0.04,
		x: -0.06,
		y: -0.15,
		z: 0.02,
		uv: BIRD_LEG_L_UV,
		partId: 3,
	},
	{
		width: 0.04,
		height: 0.08,
		depth: 0.04,
		x: 0.06,
		y: -0.15,
		z: 0.02,
		uv: BIRD_LEG_R_UV,
		partId: 4,
	},
];

export const BIRD_HIT_HALF = { x: 0.25, y: 0.2, z: 0.25 };
const BIRD_BODY_HALF_SIZE = vec3(
	BIRD_HIT_HALF.x,
	BIRD_HIT_HALF.y,
	BIRD_HIT_HALF.z,
);

// Wing roots sit at the wing boxes' inner edge height; legs dangle below.
const BIRD_SHOULDER_PIVOT_Y = 0.06;
const BIRD_HIP_PIVOT_Y = -0.11;
const BIRD_WALK_AMP = 0.9;

/** Shared flock route: one waypoint + heading flown by every member. */
interface BirdFlock {
	waypoint: { x: number; y: number; z: number };
	heading: number;
	baseY: number;
}

/** Distance a flock leg covers before the route turns. */
const FLOCK_LEG_LENGTH = 25;
/** Vertical wander of the flock waypoint around its base altitude. */
const FLOCK_ALTITUDE_WANDER = 3;
/** Solo birds (spawn eggs) wander this far per leg instead of flocking. */
const SOLO_LEG_MIN = 10;
const SOLO_LEG_MAX = 20;

let bodyPool: MobInstancePool | null = null;
function getBodyPool(): MobInstancePool {
	bodyPool ??= new MobInstancePool({
		name: "birdInstances",
		parts: BIRD_PARTS,
		skinPath: MOB_BIRD_SKIN_PATH,
		instanceColors: true,
		tint: Color3.White(),
		hipPivotY: BIRD_HIP_PIVOT_Y,
		shoulderPivotY: BIRD_SHOULDER_PIVOT_Y,
		walkAmp: BIRD_WALK_AMP,
	});
	return bodyPool;
}

/** Shared instance pool — remote (server-authoritative) birds render
 * through the same textured instanced mesh as local ones. */
export function getBirdInstancePool(): MobInstancePool {
	return getBodyPool();
}

export class Bird extends FlyingMob {
	readonly mobType = BIRD_MOB_TYPE;

	// Flock membership. Egg-spawned loners keep flockId null and wander solo.
	static #nextFlockId = 1;
	static readonly #flocks = new Map<number, BirdFlock>();

	#flockId: number | null = null;
	readonly #offset = { x: 0, y: 0, z: 0 };

	#bodySlot: InstanceSlotHandle;

	constructor(
		x: number,
		y: number,
		z: number,
		scene: SceneContext,
		hp?: number,
	) {
		super(
			hp ?? BIRD_DEFAULT_HP,
			scene,
			BIRD_BODY_HALF_SIZE,
			BIRD_STATS.feetHeight,
		);

		this.setPosition(x, y, z);
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

	/**
	 * Spawn a whole flock at once: members share one route object so the
	 * formation holds instead of scattering. Each member is registered so
	 * caps, lighting, and chunk binding all behave like solo spawns.
	 */
	static createFlock(
		x: number,
		y: number,
		z: number,
		scene: SceneContext,
		count: number,
		registry: MobRegistry,
	): Bird[] {
		const flockId = Bird.#nextFlockId++;
		const heading = Math.random() * Math.PI * 2;
		const flock: BirdFlock = {
			waypoint: { x, y, z },
			heading,
			baseY: y,
		};
		Bird.#flocks.set(flockId, flock);

		const members: Bird[] = [];
		for (let i = 0; i < count; i++) {
			const bird = new Bird(x, y, z, scene);
			const slotAngle = (i / Math.max(1, count)) * Math.PI * 2;
			const slotRadius = 1.5 + (i % 3);
			bird.#flockId = flockId;
			bird.#offset.x = Math.cos(slotAngle) * slotRadius;
			bird.#offset.y = (i % 2) * 1.2;
			bird.#offset.z = Math.sin(slotAngle) * slotRadius;
			registry.addMob(bird);
			members.push(bird);
		}
		return members;
	}

	/** Drop empty flocks so the map never grows across a long session. */
	static #pruneFlock(flockId: number, registry: MobRegistry | null): void {
		if (!registry) return;
		for (const mob of registry.getAllMobs()) {
			if (mob instanceof Bird && mob.#flockId === flockId) return;
		}
		Bird.#flocks.delete(flockId);
	}

	protected override syncToInstances(): void {
		const pos = this.position;
		const pool = getBodyPool();
		pool.writeMatrix(this.#bodySlot, pos.x, pos.y, pos.z, this.facingYaw);
		pool.writeWalkPhase(this.#bodySlot, this.walkPhase);
	}

	getWanderSpeed(): number {
		return BIRD_WANDER_SPEED;
	}

	protected override pickWaypoint(pos: Vec3): Vec3 | null {
		const flock =
			this.#flockId !== null ? Bird.#flocks.get(this.#flockId) : undefined;
		if (!flock) {
			// Loner (spawn egg or pruned flock): wander a solo leg.
			const angle = Math.random() * Math.PI * 2;
			const dist = SOLO_LEG_MIN + Math.random() * (SOLO_LEG_MAX - SOLO_LEG_MIN);
			return vec3(
				pos.x + Math.sin(angle) * dist,
				pos.y + (Math.random() * 4 - 2),
				pos.z + Math.cos(angle) * dist,
			);
		}
		return vec3(
			flock.waypoint.x + this.#offset.x,
			flock.waypoint.y + this.#offset.y,
			flock.waypoint.z + this.#offset.z,
		);
	}

	protected override onWaypointReached(): void {
		// First member to arrive turns the shared route; the rest follow
		// the new waypoint instead of scattering.
		if (this.#flockId === null) return;
		const flock = Bird.#flocks.get(this.#flockId);
		if (!flock) return;
		flock.heading += (Math.random() - 0.5) * 0.6;
		flock.waypoint.x += Math.sin(flock.heading) * FLOCK_LEG_LENGTH;
		flock.waypoint.z += Math.cos(flock.heading) * FLOCK_LEG_LENGTH;
		flock.waypoint.y = Math.max(
			2,
			flock.baseY + (Math.random() * 2 - 1) * FLOCK_ALTITUDE_WANDER,
		);
	}

	onDeath(): void {
		const pos = this.position;
		dropMobItemsForType("bird", pos.x, pos.y, pos.z);
		spawnXpOrbs(pos.x, pos.y, pos.z, 1, 1);
	}

	dispose(): void {
		if (this.isDisposed) return;
		unregisterMobLight(this.#bodySlot);
		getBodyPool().release(this.#bodySlot);
		const flockId = this.#flockId;
		this.#flockId = null;
		super.dispose();
		if (flockId !== null) {
			Bird.#pruneFlock(flockId, Map1.mobRegistry);
		}
	}
}
