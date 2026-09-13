import { type SceneContext, vec3 } from "@babylonjs/lite";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";
import { getMobStats, MobTypeId } from "../MobConfig";
import { MOB_WEAPON_ZOMBIE_CLAWS } from "../WeaponStats";
import { HostileMob } from "./HostileMob";
import { dropMobItemsForType } from "./MobDrops";
import { type InstanceSlotHandle, MobInstancePool } from "./MobInstancePool";
import { registerMobLight, unregisterMobLight } from "./MobLighting";
import type { MobPartSpec } from "./MobMesh";
import {
	MOB_ZOMBIE_SKIN_PATH,
	ZOMBIE_ARM_L_UV,
	ZOMBIE_ARM_R_UV,
	ZOMBIE_BODY_UV,
	ZOMBIE_HEAD_UV,
	ZOMBIE_LEG_L_UV,
	ZOMBIE_LEG_R_UV,
} from "./MobSkin";
import { spawnXpOrbs } from "./XpOrb";

const ZOMBIE_MOB_TYPE = "zombie";
const ZOMBIE_CHUNK_ENTITY_TYPE = "zombie_v1";
const ZOMBIE_STATS = getMobStats(MobTypeId.Zombie);
const ZOMBIE_DEFAULT_HP = ZOMBIE_STATS.hp;
const ZOMBIE_WANDER_SPEED = ZOMBIE_STATS.speed;

// Zombie anatomy: the player mesh (1.8 tall humanoid) in zombie dress —
// same boxes, same pivots, same swing, so it animates exactly like the
// player. Arms carry arm tags (1/2) and swing about the shoulder line;
// legs carry leg tags (3/4) about the hip line.
// Mob-local center origin: legs -0.9..-0.225, torso -0.225..0.45,
// head 0.45..0.9.
const ZOMBIE_PARTS: readonly MobPartSpec[] = [
	{
		width: 0.45,
		height: 0.675,
		depth: 0.225,
		x: 0,
		y: 0.1125,
		z: 0,
		uv: ZOMBIE_BODY_UV,
	},
	{
		width: 0.45,
		height: 0.45,
		depth: 0.45,
		x: 0,
		y: 0.675,
		z: 0,
		uv: ZOMBIE_HEAD_UV,
	},
	{
		width: 0.225,
		height: 0.675,
		depth: 0.225,
		x: -0.3375,
		y: 0.1125,
		z: 0,
		uv: ZOMBIE_ARM_L_UV,
		partId: 1,
	},
	{
		width: 0.225,
		height: 0.675,
		depth: 0.225,
		x: 0.3375,
		y: 0.1125,
		z: 0,
		uv: ZOMBIE_ARM_R_UV,
		partId: 2,
	},
	{
		width: 0.225,
		height: 0.675,
		depth: 0.225,
		x: -0.1125,
		y: -0.5625,
		z: 0,
		uv: ZOMBIE_LEG_L_UV,
		partId: 3,
	},
	{
		width: 0.225,
		height: 0.675,
		depth: 0.225,
		x: 0.1125,
		y: -0.5625,
		z: 0,
		uv: ZOMBIE_LEG_R_UV,
		partId: 4,
	},
];

export const ZOMBIE_HIT_HALF = { x: 0.32, y: 0.9, z: 0.32 };
const ZOMBIE_BODY_HALF_SIZE = vec3(
	ZOMBIE_HIT_HALF.x,
	ZOMBIE_HIT_HALF.y,
	ZOMBIE_HIT_HALF.z,
);
const ZOMBIE_HIP_PIVOT_Y = -0.225;
const ZOMBIE_SHOULDER_PIVOT_Y = 0.45;
const ZOMBIE_WALK_AMP = 0.7;
/**
 * Fixed arm raise (radians) for the attack-pose pool: arms held horizontal
 * while pursuing a target. Negative rotates about the shoulder toward +Z
 * (the facing direction); -1.5 lands just above level.
 */
const ZOMBIE_ATTACK_RAISE = -1.5;

let bodyPool: MobInstancePool | null = null;
function getBodyPool(): MobInstancePool {
	bodyPool ??= new MobInstancePool({
		name: "zombieInstances",
		parts: ZOMBIE_PARTS,
		skinPath: MOB_ZOMBIE_SKIN_PATH,
		instanceColors: true,
		tint: Color3.White(),
		hipPivotY: ZOMBIE_HIP_PIVOT_Y,
		shoulderPivotY: ZOMBIE_SHOULDER_PIVOT_Y,
		walkAmp: ZOMBIE_WALK_AMP,
	});
	return bodyPool;
}
export function getZombieInstancePool(): MobInstancePool {
	return getBodyPool();
}

let attackBodyPool: MobInstancePool | null = null;
/**
 * Attack-pose variant of the zombie pool: identical geometry and skin,
 * but the material holds both arms up. Zombies swap their lane here while
 * holding in melee reach (and back when they leave it).
 */
function getAttackBodyPool(): MobInstancePool {
	attackBodyPool ??= new MobInstancePool({
		name: "zombieAttackInstances",
		parts: ZOMBIE_PARTS,
		skinPath: MOB_ZOMBIE_SKIN_PATH,
		instanceColors: true,
		tint: Color3.White(),
		hipPivotY: ZOMBIE_HIP_PIVOT_Y,
		shoulderPivotY: ZOMBIE_SHOULDER_PIVOT_Y,
		attackRaise: ZOMBIE_ATTACK_RAISE,
		walkAmp: ZOMBIE_WALK_AMP,
	});
	return attackBodyPool;
}
export function getZombieAttackPool(): MobInstancePool {
	return getAttackBodyPool();
}

type ZombieSerializedPayload = {
	position: { x: number; y: number; z: number };
	hp: number;
};

export class Zombie extends HostileMob {
	readonly mobType = ZOMBIE_MOB_TYPE;
	readonly CHUNK_ENTITY_TYPE = ZOMBIE_CHUNK_ENTITY_TYPE;
	static #chunkLoaderRegistered = false;
	static #chunkReloadScene: SceneContext | null = null;
	#bodySlot: InstanceSlotHandle;
	/** Pool currently owning #bodySlot (normal or attack-pose). */
	#lanePool: MobInstancePool;

	constructor(
		x: number,
		y: number,
		z: number,
		scene: SceneContext,
		hp?: number,
	) {
		super(
			hp ?? ZOMBIE_DEFAULT_HP,
			scene,
			ZOMBIE_BODY_HALF_SIZE,
			ZOMBIE_STATS.feetHeight,
		);

		this.setPosition(x, y, z);
		this.#lanePool = getBodyPool();
		this.#bodySlot = this.#lanePool.acquire(this);
		this.#lanePool.writeColor(this.#bodySlot, 1, 1, 1, 0);
		this.syncToInstances();
		this.finalizeRegistration();
		registerMobLight({
			pool: this.#lanePool,
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [1, 1, 1],
			owner: this,
		});
	}

	protected override syncToInstances(): void {
		const pos = this.position;
		const pool = this.#lanePool;
		pool.writeMatrix(this.#bodySlot, pos.x, pos.y, pos.z, this.facingYaw);
		pool.writeWalkPhase(this.#bodySlot, this.walkPhase);
	}

	/**
	 * Move the render lane between the normal and attack-pose pools.
	 * Light registration follows the lane (unregister → release → acquire
	 * → re-register), so voxel lighting never dangles at either pool.
	 */
	#setAttackPool(attacking: boolean): void {
		if (this.isDisposed) return;
		const want = attacking ? getAttackBodyPool() : getBodyPool();
		if (want === this.#lanePool) return;

		unregisterMobLight(this.#bodySlot);
		this.#lanePool.release(this.#bodySlot);
		this.#lanePool = want;
		this.#bodySlot = want.acquire(this);
		want.writeColor(this.#bodySlot, 1, 1, 1, 0);
		this.syncToInstances();
		registerMobLight({
			pool: want,
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [1, 1, 1],
			owner: this,
		});
	}

	protected override onAttackPoseChanged(attacking: boolean): void {
		this.#setAttackPool(attacking);
	}

	configureChunkLoader(scene: SceneContext): void {
		Zombie.#chunkReloadScene = scene;
		if (Zombie.#chunkLoaderRegistered) return;
		Zombie.#chunkLoaderRegistered = true;
		registerChunkEntityLoader(ZOMBIE_CHUNK_ENTITY_TYPE, (payload: unknown) => {
			const reloadScene = Zombie.#chunkReloadScene;
			if (!reloadScene) return;
			const data = payload as ZombieSerializedPayload | undefined;
			const position = data?.position;
			if (!position) return;
			Map1.mobRegistry?.addMob(
				new Zombie(position.x, position.y, position.z, reloadScene, data.hp),
			);
		});
	}

	getWanderSpeed(): number {
		return ZOMBIE_WANDER_SPEED;
	}

	// Reach and damage come from the claws, not the mob (WeaponStats).
	protected override getWeaponId(): number {
		return MOB_WEAPON_ZOMBIE_CLAWS;
	}

	onDeath(): void {
		const pos = this.position;
		dropMobItemsForType("zombie", pos.x, pos.y, pos.z);
		spawnXpOrbs(pos.x, pos.y, pos.z, 3, 6);
	}

	dispose(): void {
		if (this.isDisposed) return;
		unregisterMobLight(this.#bodySlot);
		this.#lanePool.release(this.#bodySlot);
		super.dispose();
	}
}
