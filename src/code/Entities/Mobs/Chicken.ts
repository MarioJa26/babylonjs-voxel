import { type SceneContext, vec3 } from "@babylonjs/lite";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";
import { type InstanceSlotHandle, MobInstancePool } from "./MobInstancePool";
import type { MobPartSpec } from "./MobMesh";
import {
	CHICKEN_BEAK_UV,
	CHICKEN_BODY_UV,
	CHICKEN_HEAD_UV,
	CHICKEN_LEG_L_UV,
	CHICKEN_LEG_R_UV,
	CHICKEN_WING_L_UV,
	CHICKEN_WING_R_UV,
	MOB_CHICKEN_SKIN_PATH,
} from "./MobSkin";
import { NeutralMob } from "./NeutralMob";

const CHICKEN_MOB_TYPE = "chicken";
const CHICKEN_CHUNK_ENTITY_TYPE = "chicken_v1";
const CHICKEN_DEFAULT_HP = 4;
const CHICKEN_WANDER_SPEED = 1.8;

// Chicken anatomy: body + head + beak + two wings + two legs. Every chicken
// renders through this ONE shared thin-instanced mesh (1 draw call total).
// UVs reference the editable skin layout in MobSkin.ts.
const CHICKEN_PARTS: readonly MobPartSpec[] = [
	{
		width: 0.5,
		height: 0.4,
		depth: 0.3,
		x: 0,
		y: 0,
		z: 0,
		uv: CHICKEN_BODY_UV,
	},
	{
		width: 0.22,
		height: 0.28,
		depth: 0.24,
		x: 0,
		y: 0.3,
		z: 0.13,
		uv: CHICKEN_HEAD_UV,
	},
	{
		width: 0.1,
		height: 0.08,
		depth: 0.12,
		x: 0,
		y: 0.28,
		z: 0.3,
		uv: CHICKEN_BEAK_UV,
	},
	{
		width: 0.06,
		height: 0.26,
		depth: 0.34,
		x: -0.285,
		y: 0.03,
		z: -0.02,
		uv: CHICKEN_WING_L_UV,
	},
	{
		width: 0.06,
		height: 0.26,
		depth: 0.34,
		x: 0.285,
		y: 0.03,
		z: -0.02,
		uv: CHICKEN_WING_R_UV,
	},
	{
		width: 0.07,
		height: 0.25,
		depth: 0.07,
		x: -0.09,
		y: -0.325,
		z: 0,
		uv: CHICKEN_LEG_L_UV,
		partId: 3,
	},
	{
		width: 0.07,
		height: 0.25,
		depth: 0.07,
		x: 0.09,
		y: -0.325,
		z: 0,
		uv: CHICKEN_LEG_R_UV,
		partId: 4,
	},
];

// Collider spans the whole animal so feet rest exactly on the ground.
export const CHICKEN_HIT_HALF = { x: 0.31, y: 0.45, z: 0.3 };
const CHICKEN_BODY_HALF_SIZE = vec3(
	CHICKEN_HIT_HALF.x,
	CHICKEN_HIT_HALF.y,
	CHICKEN_HIT_HALF.z,
);

// Hip pivot Y: legs span y ∈ [-0.45, -0.2]; the body underside is at y = -0.2,
// so the leg-body joint (rotation pivot) sits at y = -0.2.
const CHICKEN_HIP_PIVOT_Y = -0.2;
const CHICKEN_WALK_AMP = 0.7;

let bodyPool: MobInstancePool | null = null;

function getBodyPool(): MobInstancePool {
	bodyPool ??= new MobInstancePool({
		name: "chickenInstances",
		parts: CHICKEN_PARTS,
		skinPath: MOB_CHICKEN_SKIN_PATH,
		// Instance colors required: walk phase is packed into the alpha channel.
		instanceColors: true,
		tint: Color3.White(),
		hipPivotY: CHICKEN_HIP_PIVOT_Y,
		walkAmp: CHICKEN_WALK_AMP,
	});
	return bodyPool;
}

/** Shared instance pool — remote (server-authoritative) chickens render
 * through the same textured instanced mesh as local ones. */
export function getChickenInstancePool(): MobInstancePool {
	return getBodyPool();
}

type ChickenSerializedPayload = {
	position: { x: number; y: number; z: number };
	hp: number;
};

export class Chicken extends NeutralMob {
	readonly mobType = CHICKEN_MOB_TYPE;
	readonly CHUNK_ENTITY_TYPE = CHICKEN_CHUNK_ENTITY_TYPE;

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
		super(hp ?? CHICKEN_DEFAULT_HP, scene, CHICKEN_BODY_HALF_SIZE);

		this.setPosition(x, y, z);

		this.#bodySlot = getBodyPool().acquire(this);
		// White tint (texture shows as-is); alpha channel carries walk phase.
		getBodyPool().writeColor(this.#bodySlot, 1, 1, 1, 0);
		this.syncToInstances();
		this.finalizeRegistration();
	}

	protected override syncToInstances(): void {
		const pos = this.position;
		const pool = getBodyPool();

		pool.writeMatrix(this.#bodySlot, pos.x, pos.y, pos.z, this.facingYaw);
		pool.writeWalkPhase(this.#bodySlot, this.walkPhase);
	}

	configureChunkLoader(scene: SceneContext): void {
		Chicken.#chunkReloadScene = scene;

		if (Chicken.#chunkLoaderRegistered) return;
		Chicken.#chunkLoaderRegistered = true;

		registerChunkEntityLoader(CHICKEN_CHUNK_ENTITY_TYPE, (payload: unknown) => {
			const reloadScene = Chicken.#chunkReloadScene;
			if (!reloadScene) return;

			const data = payload as ChickenSerializedPayload | undefined;
			const position = data?.position;
			if (!position) return;

			Map1.mobRegistry?.addMob(
				new Chicken(position.x, position.y, position.z, reloadScene, data.hp),
			);
		});
	}

	getWanderSpeed(): number {
		return CHICKEN_WANDER_SPEED;
	}

	onDeath(): void {
		// No drops
	}

	dispose(): void {
		if (this.isDisposed) return;
		getBodyPool().release(this.#bodySlot);
		super.dispose();
	}
}
