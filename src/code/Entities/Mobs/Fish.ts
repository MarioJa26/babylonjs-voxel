import { type SceneContext, vec3 } from "@babylonjs/lite";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";
import { getMobStats, MobTypeId } from "../MobConfig";
import { AquaticMob } from "./AquaticMob";
import { type InstanceSlotHandle, MobInstancePool } from "./MobInstancePool";
import type { MobPartSpec } from "./MobMesh";
import {
	FISH_BODY_UV,
	FISH_FIN_L_UV,
	FISH_FIN_R_UV,
	FISH_FIN_TOP_UV,
	FISH_TAIL_UV,
	MOB_FISH_SKIN_PATH,
} from "./MobSkin";

const FISH_MOB_TYPE = "fish";
const FISH_CHUNK_ENTITY_TYPE = "fish_v1";
const FISH_STATS = getMobStats(MobTypeId.Fish);
const FISH_DEFAULT_HP = FISH_STATS.hp;
const FISH_WANDER_SPEED = FISH_STATS.speed;

export const FISH_COLORS = [
	new Color3(0.9, 0.6, 0.2),
	new Color3(0.9, 0.3, 0.2),
	new Color3(0.2, 0.6, 0.9),
	new Color3(0.9, 0.9, 0.3),
	new Color3(0.95, 0.95, 0.95),
] as const;

const FISH_PARTS: readonly MobPartSpec[] = [
	{
		width: 0.28,
		height: 0.22,
		depth: 0.55,
		x: 0,
		y: 0,
		z: 0,
		uv: FISH_BODY_UV,
	},
	{
		width: 0.18,
		height: 0.2,
		depth: 0.12,
		x: 0,
		y: 0,
		z: -0.33,
		uv: FISH_TAIL_UV,
		partId: 3,
	},
	{
		width: 0.06,
		height: 0.12,
		depth: 0.22,
		x: 0,
		y: 0.14,
		z: 0.05,
		uv: FISH_FIN_TOP_UV,
	},
	{
		width: 0.08,
		height: 0.08,
		depth: 0.14,
		x: -0.17,
		y: -0.02,
		z: 0.05,
		uv: FISH_FIN_L_UV,
		partId: 4,
	},
	{
		width: 0.08,
		height: 0.08,
		depth: 0.14,
		x: 0.17,
		y: -0.02,
		z: 0.05,
		uv: FISH_FIN_R_UV,
		partId: 3,
	},
];

export const FISH_HIT_HALF = { x: 0.2, y: 0.15, z: 0.32 };
const FISH_BODY_HALF_SIZE = vec3(
	FISH_HIT_HALF.x,
	FISH_HIT_HALF.y,
	FISH_HIT_HALF.z,
);
const FISH_HIP_PIVOT_Y = 0;
const FISH_WALK_AMP = 0.9;

let bodyPool: MobInstancePool | null = null;
function getBodyPool(): MobInstancePool {
	bodyPool ??= new MobInstancePool({
		name: "fishInstances",
		parts: FISH_PARTS,
		skinPath: MOB_FISH_SKIN_PATH,
		instanceColors: true,
		hipPivotY: FISH_HIP_PIVOT_Y,
		walkAmp: FISH_WALK_AMP,
	});
	return bodyPool;
}
export function getFishInstancePool(): MobInstancePool {
	return getBodyPool();
}

function randomFishColor(): Color3 {
	const c = FISH_COLORS[(Math.random() * FISH_COLORS.length) | 0]!;
	return c.clone();
}

type FishPayload = {
	position: { x: number; y: number; z: number };
	hp: number;
	color: { r: number; g: number; b: number };
};

export class Fish extends AquaticMob {
	readonly mobType = FISH_MOB_TYPE;
	readonly CHUNK_ENTITY_TYPE = FISH_CHUNK_ENTITY_TYPE;
	static #chunkLoaderRegistered = false;
	static #chunkReloadScene: SceneContext | null = null;
	#bodySlot: InstanceSlotHandle;
	#color: Color3;

	constructor(
		x: number,
		y: number,
		z: number,
		scene: SceneContext,
		hp?: number,
		color?: Color3,
	) {
		super(hp ?? FISH_DEFAULT_HP, scene, FISH_BODY_HALF_SIZE);
		this.#color = color ?? randomFishColor();
		this.setPosition(x, y, z);
		this.#bodySlot = getBodyPool().acquire(this);
		getBodyPool().writeColor(
			this.#bodySlot,
			this.#color.r,
			this.#color.g,
			this.#color.b,
			0,
		);
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
		Fish.#chunkReloadScene = scene;
		if (Fish.#chunkLoaderRegistered) return;
		Fish.#chunkLoaderRegistered = true;
		registerChunkEntityLoader(FISH_CHUNK_ENTITY_TYPE, (payload: unknown) => {
			const reloadScene = Fish.#chunkReloadScene;
			if (!reloadScene) return;
			const data = payload as FishPayload | undefined;
			const position = data?.position;
			if (!position) return;
			const color = data?.color
				? new Color3(data.color.r, data.color.g, data.color.b)
				: undefined;
			Map1.mobRegistry?.addMob(
				new Fish(
					position.x,
					position.y,
					position.z,
					reloadScene,
					data.hp,
					color,
				),
			);
		});
	}

	getWanderSpeed(): number {
		return FISH_WANDER_SPEED;
	}

	protected override getDepthRange(): { min: number; max: number } {
		return FISH_STATS.depthRange ?? { min: 1, max: 16 };
	}

	protected override getExtraPayload(): Record<string, unknown> {
		return { color: { r: this.#color.r, g: this.#color.g, b: this.#color.b } };
	}

	onDeath(): void {}

	dispose(): void {
		if (this.isDisposed) return;
		getBodyPool().release(this.#bodySlot);
		super.dispose();
	}
}
