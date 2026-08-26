import { type SceneContext, vec3 } from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";
import { type InstanceSlotHandle, MobInstancePool } from "./MobInstancePool";
import type { MobPartSpec } from "./MobMesh";
import { NeutralMob } from "./NeutralMob";

const CHICKEN_MOB_TYPE = "chicken";
const CHICKEN_CHUNK_ENTITY_TYPE = "chicken_v1";
const CHICKEN_DEFAULT_HP = 4;
const CHICKEN_WANDER_SPEED = 1.8;

// Mob skin cells (/texture/mobs/skin.png): 0 feathers, 1 beak/legs.
const FEATHER_TILE = 0;
const BEAK_TILE = 1;

// Model space: origin = body center, feet on the ground at y = -GROUND_Y.
const GROUND_Y = 0.45;

// Chicken anatomy: body + head + beak + two wings + two legs. Every chicken
// renders through this ONE shared thin-instanced mesh (1 draw call total).
const CHICKEN_PARTS: readonly MobPartSpec[] = [
	{
		width: 0.5,
		height: 0.4,
		depth: 0.3,
		x: 0,
		y: 0,
		z: 0,
		tile: FEATHER_TILE,
	},
	{
		width: 0.22,
		height: 0.28,
		depth: 0.24,
		x: 0,
		y: 0.3,
		z: 0.13,
		tile: FEATHER_TILE,
	},
	{
		width: 0.1,
		height: 0.08,
		depth: 0.12,
		x: 0,
		y: 0.28,
		z: 0.3,
		tile: BEAK_TILE,
	},
	{
		width: 0.06,
		height: 0.26,
		depth: 0.34,
		x: -0.285,
		y: 0.03,
		z: -0.02,
		tile: FEATHER_TILE,
	},
	{
		width: 0.06,
		height: 0.26,
		depth: 0.34,
		x: 0.285,
		y: 0.03,
		z: -0.02,
		tile: FEATHER_TILE,
	},
	{
		width: 0.07,
		height: 0.25,
		depth: 0.07,
		x: -0.09,
		y: -0.325,
		z: 0,
		tile: BEAK_TILE,
	},
	{
		width: 0.07,
		height: 0.25,
		depth: 0.07,
		x: 0.09,
		y: -0.325,
		z: 0,
		tile: BEAK_TILE,
	},
];

// Collider spans the whole animal so feet rest exactly on the ground.
const CHICKEN_BODY_HALF_SIZE = vec3(0.31, GROUND_Y, 0.3);

let bodyPool: MobInstancePool | null = null;

function getBodyPool(): MobInstancePool {
	bodyPool ??= new MobInstancePool({
		name: "chickenInstances",
		parts: CHICKEN_PARTS,
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
		this.syncToInstances();
		this.finalizeRegistration();
	}

	protected override syncToInstances(): void {
		const pos = this.position;

		getBodyPool().writeMatrix(
			this.#bodySlot,
			pos.x,
			pos.y,
			pos.z,
			this.facingYaw,
		);
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
