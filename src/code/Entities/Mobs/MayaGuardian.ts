import { type SceneContext, vec3 } from "@babylonjs/lite";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";
import { getMobStats, MobTypeId } from "../MobConfig";
import { MOB_WEAPON_GUARDIAN_MAUL } from "../WeaponStats";
import { HostileMob } from "./HostileMob";
import { dropMobItemsForType } from "./MobDrops";
import { type InstanceSlotHandle, MobInstancePool } from "./MobInstancePool";
import { registerMobLight, unregisterMobLight } from "./MobLighting";
import type { MobPartSpec } from "./MobMesh";
import {
	MOB_SKELETON_SKIN_PATH,
	SKELETON_ARM_L_UV,
	SKELETON_ARM_R_UV,
	SKELETON_BODY_UV,
	SKELETON_HEAD_UV,
	SKELETON_LEG_L_UV,
	SKELETON_LEG_R_UV,
} from "./MobSkin";
import { spawnXpOrbs } from "./XpOrb";

export const MAYA_GUARDIAN_MOB_TYPE = "maya_guardian";
const MAYA_GUARDIAN_CHUNK_ENTITY_TYPE = "maya_guardian_v1";
const GUARDIAN_STATS = getMobStats(MobTypeId.Guardian);
const GUARDIAN_DEFAULT_HP = GUARDIAN_STATS.hp;
const GUARDIAN_WANDER_SPEED = GUARDIAN_STATS.speed;

/**
 * The Guardian is a 1.7x-scaled skeleton rig on the same skin.
 *
 * `buildMobModelGeometry` sizes boxes independently of their UV texel rects,
 * and `MobInstancePool` has no scale parameter at all — `writeMatrix` writes a
 * pure translation + Y rotation — so the size difference has to be baked into
 * the part specs. Reusing the skeleton skin keeps `preloadMobSkins` unchanged
 * and means the boss needs no new art.
 */
const GUARDIAN_SCALE = 1.7;

const MAYA_GUARDIAN_PARTS: readonly MobPartSpec[] = [
	{
		width: 0.55 * GUARDIAN_SCALE,
		height: 0.7 * GUARDIAN_SCALE,
		depth: 0.32 * GUARDIAN_SCALE,
		x: 0,
		y: 0.15 * GUARDIAN_SCALE,
		z: 0,
		uv: SKELETON_BODY_UV,
	},
	{
		width: 0.46 * GUARDIAN_SCALE,
		height: 0.46 * GUARDIAN_SCALE,
		depth: 0.46 * GUARDIAN_SCALE,
		x: 0,
		y: 0.73 * GUARDIAN_SCALE,
		z: 0,
		uv: SKELETON_HEAD_UV,
	},
	{
		width: 0.2 * GUARDIAN_SCALE,
		height: 0.65 * GUARDIAN_SCALE,
		depth: 0.2 * GUARDIAN_SCALE,
		x: -0.36 * GUARDIAN_SCALE,
		y: 0.12 * GUARDIAN_SCALE,
		z: 0,
		uv: SKELETON_ARM_L_UV,
		partId: 3,
	},
	{
		width: 0.2 * GUARDIAN_SCALE,
		height: 0.65 * GUARDIAN_SCALE,
		depth: 0.2 * GUARDIAN_SCALE,
		x: 0.36 * GUARDIAN_SCALE,
		y: 0.12 * GUARDIAN_SCALE,
		z: 0,
		uv: SKELETON_ARM_R_UV,
		partId: 4,
	},
	{
		width: 0.16 * GUARDIAN_SCALE,
		height: 0.75 * GUARDIAN_SCALE,
		depth: 0.16 * GUARDIAN_SCALE,
		x: -0.12 * GUARDIAN_SCALE,
		y: -0.575 * GUARDIAN_SCALE,
		z: 0,
		uv: SKELETON_LEG_L_UV,
		partId: 3,
	},
	{
		width: 0.16 * GUARDIAN_SCALE,
		height: 0.75 * GUARDIAN_SCALE,
		depth: 0.16 * GUARDIAN_SCALE,
		x: 0.12 * GUARDIAN_SCALE,
		y: -0.575 * GUARDIAN_SCALE,
		z: 0,
		uv: SKELETON_LEG_R_UV,
		partId: 4,
	},
];

export const GUARDIAN_HIT_HALF = { x: 0.5, y: 1.6, z: 0.5 };
const GUARDIAN_BODY_HALF_SIZE = vec3(
	GUARDIAN_HIT_HALF.x,
	GUARDIAN_HIT_HALF.y,
	GUARDIAN_HIT_HALF.z,
);
const GUARDIAN_HIP_PIVOT_Y = -0.2 * GUARDIAN_SCALE;
const GUARDIAN_WALK_AMP = 0.7;

/** Warm ochre tint, so the boss does not read as a reskinned skeleton. */
const GUARDIAN_TINT = new Color3(1, 0.72, 0.36);

let bodyPool: MobInstancePool | null = null;
function getBodyPool(): MobInstancePool {
	bodyPool ??= new MobInstancePool({
		name: "mayaGuardianInstances",
		parts: MAYA_GUARDIAN_PARTS,
		skinPath: MOB_SKELETON_SKIN_PATH,
		instanceColors: true,
		tint: GUARDIAN_TINT,
		hipPivotY: GUARDIAN_HIP_PIVOT_Y,
		walkAmp: GUARDIAN_WALK_AMP,
	});
	return bodyPool;
}

export function getGuardianInstancePool(): MobInstancePool {
	return getBodyPool();
}

type GuardianSerializedPayload = {
	position: { x: number; y: number; z: number };
	hp: number;
};

export class MayaGuardian extends HostileMob {
	readonly mobType = MAYA_GUARDIAN_MOB_TYPE;
	readonly CHUNK_ENTITY_TYPE = MAYA_GUARDIAN_CHUNK_ENTITY_TYPE;
	static #chunkLoaderRegistered = false;
	static #chunkReloadScene: SceneContext | null = null;
	#bodySlot: InstanceSlotHandle;

	constructor(
		x: number,
		y: number,
		z: number,
		scene: SceneContext,
		hp?: number,
	) {
		super(
			hp ?? GUARDIAN_DEFAULT_HP,
			scene,
			GUARDIAN_BODY_HALF_SIZE,
			GUARDIAN_STATS.feetHeight,
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
			baseColor: [1, 0.72, 0.36],
			owner: this,
		});
	}

	protected override syncToInstances(): void {
		const pos = this.position;
		const pool = getBodyPool();
		pool.writeMatrix(this.#bodySlot, pos.x, pos.y, pos.z, this.facingYaw);
		pool.writeWalkPhase(this.#bodySlot, this.walkPhase);
	}

	configureChunkLoader(scene: SceneContext): void {
		MayaGuardian.#chunkReloadScene = scene;
		if (MayaGuardian.#chunkLoaderRegistered) return;
		MayaGuardian.#chunkLoaderRegistered = true;
		registerChunkEntityLoader(
			MAYA_GUARDIAN_CHUNK_ENTITY_TYPE,
			(payload: unknown) => {
				const reloadScene = MayaGuardian.#chunkReloadScene;
				if (!reloadScene) return;
				const data = payload as GuardianSerializedPayload | undefined;
				const position = data?.position;
				if (!position) return;
				const guardian = new MayaGuardian(
					position.x,
					position.y,
					position.z,
					reloadScene,
					data.hp,
				);
				// Dungeon mobs are not natural spawns, so they must not eat into
				// the natural mob cap the surface spawner enforces.
				guardian.countsTowardMobCap = false;
				Map1.mobRegistry?.addMob(guardian);
			},
		);
	}

	getWanderSpeed(): number {
		return GUARDIAN_WANDER_SPEED;
	}

	protected override getWeaponId(): number {
		return MOB_WEAPON_GUARDIAN_MAUL;
	}

	/**
	 * A boss fight is long enough that a wider aggro leash than a zombie's
	 * 16/32 makes the arena feel like a fight rather than a bump.
	 */
	protected override getAggroRadiusSq(): number {
		return 28 * 28;
	}

	protected override getDeaggroRadiusSq(): number {
		return 56 * 56;
	}

	protected override getAttackIntervalSec(): number {
		return 1.4;
	}

	/**
	 * The arena is a sealed room with no skylight, but the cenote above it can
	 * still expose the boss to a high sun angle. Opting out of daylight burning
	 * is mandatory here: HostileMob kills burning mobs outright, silently, with
	 * no drops.
	 */
	protected override getBurnsInDaylight(): boolean {
		return false;
	}

	onDeath(): void {
		const pos = this.position;
		dropMobItemsForType(MAYA_GUARDIAN_MOB_TYPE, pos.x, pos.y, pos.z);
		spawnXpOrbs(pos.x, pos.y, pos.z, 40, 70);
	}

	dispose(): void {
		if (this.isDisposed) return;
		unregisterMobLight(this.#bodySlot);
		getBodyPool().release(this.#bodySlot);
		super.dispose();
	}
}
