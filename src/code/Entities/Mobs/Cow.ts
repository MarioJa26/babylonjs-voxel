import { type SceneContext, vec3 } from "@babylonjs/lite";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import { dropWorldItem } from "../../Player/Inventory/dropWorldItem";
import { Item } from "../../Player/Inventory/Item";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";
import { getMobStats, MobTypeId } from "../MobConfig";
import { type InstanceSlotHandle, MobInstancePool } from "./MobInstancePool";
import type { MobPartSpec } from "./MobMesh";
import {
	COW_BODY_UV,
	COW_HEAD_UV,
	COW_HORN_L_UV,
	COW_HORN_R_UV,
	COW_LEG_BL_UV,
	COW_LEG_BR_UV,
	COW_LEG_FL_UV,
	COW_LEG_FR_UV,
	MOB_COW_SKIN_PATH,
} from "./MobSkin";
import { NeutralMob } from "./NeutralMob";

const COW_MOB_TYPE = "cow";
const COW_CHUNK_ENTITY_TYPE = "cow_v1";
const COW_STATS = getMobStats(MobTypeId.Cow);
const COW_DEFAULT_HP = COW_STATS.hp;
const COW_WANDER_SPEED = COW_STATS.speed;
const LEATHER_DROP_BLOCK_ID = 1;

const COW_PARTS: readonly MobPartSpec[] = [
	{ width: 0.8, height: 0.7, depth: 1.15, x: 0, y: 0, z: 0, uv: COW_BODY_UV },
	{
		width: 0.42,
		height: 0.42,
		depth: 0.45,
		x: 0,
		y: 0.18,
		z: 0.68,
		uv: COW_HEAD_UV,
	},
	{
		width: 0.08,
		height: 0.08,
		depth: 0.16,
		x: -0.18,
		y: 0.32,
		z: 0.75,
		uv: COW_HORN_L_UV,
	},
	{
		width: 0.08,
		height: 0.08,
		depth: 0.16,
		x: 0.18,
		y: 0.32,
		z: 0.75,
		uv: COW_HORN_R_UV,
	},
	{
		width: 0.17,
		height: 0.48,
		depth: 0.17,
		x: -0.24,
		y: -0.36,
		z: -0.34,
		uv: COW_LEG_FL_UV,
		partId: 3,
	},
	{
		width: 0.17,
		height: 0.48,
		depth: 0.17,
		x: 0.24,
		y: -0.36,
		z: -0.34,
		uv: COW_LEG_FR_UV,
		partId: 4,
	},
	{
		width: 0.17,
		height: 0.48,
		depth: 0.17,
		x: -0.24,
		y: -0.36,
		z: 0.34,
		uv: COW_LEG_BL_UV,
		partId: 3,
	},
	{
		width: 0.17,
		height: 0.48,
		depth: 0.17,
		x: 0.24,
		y: -0.36,
		z: 0.34,
		uv: COW_LEG_BR_UV,
		partId: 4,
	},
];

export const COW_HIT_HALF = { x: 0.45, y: 0.7, z: 0.62 };
const COW_BODY_HALF_SIZE = vec3(COW_HIT_HALF.x, COW_HIT_HALF.y, COW_HIT_HALF.z);
const COW_HIP_PIVOT_Y = -0.12;
const COW_WALK_AMP = 0.6;

let bodyPool: MobInstancePool | null = null;
function getBodyPool(): MobInstancePool {
	bodyPool ??= new MobInstancePool({
		name: "cowInstances",
		parts: COW_PARTS,
		skinPath: MOB_COW_SKIN_PATH,
		instanceColors: true,
		tint: Color3.White(),
		hipPivotY: COW_HIP_PIVOT_Y,
		walkAmp: COW_WALK_AMP,
	});
	return bodyPool;
}
export function getCowInstancePool(): MobInstancePool {
	return getBodyPool();
}

type CowSerializedPayload = {
	position: { x: number; y: number; z: number };
	hp: number;
};

export class Cow extends NeutralMob {
	readonly mobType = COW_MOB_TYPE;
	readonly CHUNK_ENTITY_TYPE = COW_CHUNK_ENTITY_TYPE;
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
		super(hp ?? COW_DEFAULT_HP, scene, COW_BODY_HALF_SIZE);
		this.setPosition(x, y, z);
		this.#bodySlot = getBodyPool().acquire(this);
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
		Cow.#chunkReloadScene = scene;
		if (Cow.#chunkLoaderRegistered) return;
		Cow.#chunkLoaderRegistered = true;
		registerChunkEntityLoader(COW_CHUNK_ENTITY_TYPE, (payload: unknown) => {
			const reloadScene = Cow.#chunkReloadScene;
			if (!reloadScene) return;
			const data = payload as CowSerializedPayload | undefined;
			const position = data?.position;
			if (!position) return;
			Map1.mobRegistry?.addMob(
				new Cow(position.x, position.y, position.z, reloadScene, data.hp),
			);
		});
	}

	getWanderSpeed(): number {
		return COW_WANDER_SPEED;
	}

	protected override getPanicRadiusSq(): number {
		return 0;
	}
	protected override onDamaged(): void {
		this.triggerPanic(4);
	}

	onDeath(): void {
		const pos = this.position;
		const item = Item.createById(LEATHER_DROP_BLOCK_ID);
		item.stackSize = 1 + (Math.random() < 0.5 ? 1 : 0);
		dropWorldItem(
			item,
			pos.x,
			pos.y + 0.5,
			pos.z,
			0,
			0,
			0,
			Map1.mainPlayer ?? undefined,
		);
	}

	dispose(): void {
		if (this.isDisposed) return;
		getBodyPool().release(this.#bodySlot);
		super.dispose();
	}
}
