import { type SceneContext, vec3 } from "@babylonjs/lite";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";
import { getMobStats, MobTypeId } from "../MobConfig";
import { MOB_WEAPON_SKELETON_CLUB } from "../WeaponStats";
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

const SKELETON_MOB_TYPE = "skeleton";
const SKELETON_CHUNK_ENTITY_TYPE = "skeleton_v1";
const SKELETON_STATS = getMobStats(MobTypeId.Skeleton);
const SKELETON_DEFAULT_HP = SKELETON_STATS.hp;
const SKELETON_WANDER_SPEED = SKELETON_STATS.speed;

// Skeleton anatomy: same humanoid rig as the zombie (own skin). Slightly
// leaner boxes; the long bone club out-reaches zombie claws even though
// both share the HostileMob melee routine.
const SKELETON_PARTS: readonly MobPartSpec[] = [
	{
		width: 0.55,
		height: 0.7,
		depth: 0.32,
		x: 0,
		y: 0.15,
		z: 0,
		uv: SKELETON_BODY_UV,
	},
	{
		width: 0.46,
		height: 0.46,
		depth: 0.46,
		x: 0,
		y: 0.73,
		z: 0,
		uv: SKELETON_HEAD_UV,
	},
	{
		width: 0.14,
		height: 0.65,
		depth: 0.14,
		x: -0.36,
		y: 0.12,
		z: 0,
		uv: SKELETON_ARM_L_UV,
		partId: 3,
	},
	{
		width: 0.14,
		height: 0.65,
		depth: 0.14,
		x: 0.36,
		y: 0.12,
		z: 0,
		uv: SKELETON_ARM_R_UV,
		partId: 4,
	},
	{
		width: 0.16,
		height: 0.75,
		depth: 0.16,
		x: -0.12,
		y: -0.575,
		z: 0,
		uv: SKELETON_LEG_L_UV,
		partId: 3,
	},
	{
		width: 0.16,
		height: 0.75,
		depth: 0.16,
		x: 0.12,
		y: -0.575,
		z: 0,
		uv: SKELETON_LEG_R_UV,
		partId: 4,
	},
];

export const SKELETON_HIT_HALF = { x: 0.3, y: 0.95, z: 0.3 };
const SKELETON_BODY_HALF_SIZE = vec3(
	SKELETON_HIT_HALF.x,
	SKELETON_HIT_HALF.y,
	SKELETON_HIT_HALF.z,
);
const SKELETON_HIP_PIVOT_Y = -0.2;
const SKELETON_WALK_AMP = 0.7;

let bodyPool: MobInstancePool | null = null;
function getBodyPool(): MobInstancePool {
	bodyPool ??= new MobInstancePool({
		name: "skeletonInstances",
		parts: SKELETON_PARTS,
		skinPath: MOB_SKELETON_SKIN_PATH,
		instanceColors: true,
		tint: Color3.White(),
		hipPivotY: SKELETON_HIP_PIVOT_Y,
		walkAmp: SKELETON_WALK_AMP,
	});
	return bodyPool;
}
export function getSkeletonInstancePool(): MobInstancePool {
	return getBodyPool();
}

type SkeletonSerializedPayload = {
	position: { x: number; y: number; z: number };
	hp: number;
};

export class Skeleton extends HostileMob {
	readonly mobType = SKELETON_MOB_TYPE;
	readonly CHUNK_ENTITY_TYPE = SKELETON_CHUNK_ENTITY_TYPE;
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
			hp ?? SKELETON_DEFAULT_HP,
			scene,
			SKELETON_BODY_HALF_SIZE,
			SKELETON_STATS.feetHeight,
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

	protected override syncToInstances(): void {
		const pos = this.position;
		const pool = getBodyPool();
		pool.writeMatrix(this.#bodySlot, pos.x, pos.y, pos.z, this.facingYaw);
		pool.writeWalkPhase(this.#bodySlot, this.walkPhase);
	}

	configureChunkLoader(scene: SceneContext): void {
		Skeleton.#chunkReloadScene = scene;
		if (Skeleton.#chunkLoaderRegistered) return;
		Skeleton.#chunkLoaderRegistered = true;
		registerChunkEntityLoader(
			SKELETON_CHUNK_ENTITY_TYPE,
			(payload: unknown) => {
				const reloadScene = Skeleton.#chunkReloadScene;
				if (!reloadScene) return;
				const data = payload as SkeletonSerializedPayload | undefined;
				const position = data?.position;
				if (!position) return;
				Map1.mobRegistry?.addMob(
					new Skeleton(
						position.x,
						position.y,
						position.z,
						reloadScene,
						data.hp,
					),
				);
			},
		);
	}

	getWanderSpeed(): number {
		return SKELETON_WANDER_SPEED;
	}

	// Reach and damage come from the bone club, not the mob (WeaponStats).
	protected override getWeaponId(): number {
		return MOB_WEAPON_SKELETON_CLUB;
	}

	onDeath(): void {
		const pos = this.position;
		dropMobItemsForType("skeleton", pos.x, pos.y, pos.z);
		spawnXpOrbs(pos.x, pos.y, pos.z, 3, 6);
	}

	dispose(): void {
		if (this.isDisposed) return;
		unregisterMobLight(this.#bodySlot);
		getBodyPool().release(this.#bodySlot);
		super.dispose();
	}
}
