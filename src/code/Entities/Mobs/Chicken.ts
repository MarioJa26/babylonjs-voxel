import { type SceneContext, vec3 } from "@babylonjs/lite";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";
import { type InstanceSlotHandle, MobInstancePool } from "./MobInstancePool";
import { NeutralMob } from "./NeutralMob";

const BODY_WIDTH = 0.5;
const BODY_HEIGHT = 0.4;
const BODY_DEPTH = 0.3;
const HEAD_SIZE = 0.2;

const CHICKEN_MOB_TYPE = "chicken";
const CHICKEN_CHUNK_ENTITY_TYPE = "chicken_v1";
const CHICKEN_DEFAULT_HP = 4;
const CHICKEN_WANDER_SPEED = 1.8;

const BODY_HALF_WIDTH = BODY_WIDTH * 0.5;
const BODY_HALF_HEIGHT = BODY_HEIGHT * 0.5;
const BODY_HALF_DEPTH = BODY_DEPTH * 0.5;

const HEAD_OFFSET_Y = BODY_HEIGHT * 0.5 + HEAD_SIZE * 0.3;
const HEAD_OFFSET_Z = BODY_DEPTH * 0.45;

const CHICKEN_BODY_HALF_SIZE = vec3(
	BODY_HALF_WIDTH,
	BODY_HALF_HEIGHT,
	BODY_HALF_DEPTH,
);

const CHICKEN_BODY_COLOR = Color3.White();
const CHICKEN_HEAD_COLOR = new Color3(0.95, 0.95, 0.85);

// Shared thin-instanced meshes — every chicken draws through these two pools
// (2 draw calls total regardless of flock size).
let bodyPool: MobInstancePool | null = null;
let headPool: MobInstancePool | null = null;

function getBodyPool(): MobInstancePool {
	bodyPool ??= new MobInstancePool({
		name: "chickenBodyInstances",
		width: BODY_WIDTH,
		height: BODY_HEIGHT,
		depth: BODY_DEPTH,
		color: CHICKEN_BODY_COLOR,
	});
	return bodyPool;
}

function getHeadPool(): MobInstancePool {
	headPool ??= new MobInstancePool({
		name: "chickenHeadInstances",
		width: HEAD_SIZE,
		height: HEAD_SIZE,
		depth: HEAD_SIZE,
		color: CHICKEN_HEAD_COLOR,
	});
	return headPool;
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
	#headSlot: InstanceSlotHandle;

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
		this.#headSlot = getHeadPool().acquire(this);
		this.syncToInstances();
		this.finalizeRegistration();
	}

	protected override syncToInstances(): void {
		const pos = this.position;
		const yaw = this.facingYaw;

		getBodyPool().writeMatrix(this.#bodySlot, pos.x, pos.y, pos.z, yaw);

		// Head rides the body's yaw at its local +Z offset.
		const sinYaw = Math.sin(yaw);
		const cosYaw = Math.cos(yaw);
		getHeadPool().writeMatrix(
			this.#headSlot,
			pos.x + sinYaw * HEAD_OFFSET_Z,
			pos.y + HEAD_OFFSET_Y,
			pos.z + cosYaw * HEAD_OFFSET_Z,
			yaw,
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
		getHeadPool().release(this.#headSlot);
		getBodyPool().release(this.#bodySlot);
		super.dispose();
	}
}
