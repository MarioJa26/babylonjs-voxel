import { type SceneContext, vec3 } from "@babylonjs/lite";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";
import { getMobStats, MobTypeId } from "../MobConfig";
import { AquaticMob } from "./AquaticMob";
import { type InstanceSlotHandle, MobInstancePool } from "./MobInstancePool";
import { registerMobLight, unregisterMobLight } from "./MobLighting";
import type { MobPartSpec } from "./MobMesh";
import {
	KRAKEN_BEAK_UV,
	KRAKEN_BODY_UV,
	KRAKEN_HEAD_UV,
	KRAKEN_TENTACLE_UVS,
	MOB_KRAKEN_SKIN_PATH,
} from "./MobSkin";

const KRAKEN_MOB_TYPE = "kraken";
const KRAKEN_CHUNK_ENTITY_TYPE = "kraken_v1";
const KRAKEN_STATS = getMobStats(MobTypeId.Kraken);
const KRAKEN_DEFAULT_HP = KRAKEN_STATS.hp;
const KRAKEN_WANDER_SPEED = KRAKEN_STATS.speed;

function buildKrakenParts(): readonly MobPartSpec[] {
	const parts: MobPartSpec[] = [
		{
			width: 1.4,
			height: 0.9,
			depth: 1.4,
			x: 0,
			y: 0.35,
			z: 0,
			uv: KRAKEN_BODY_UV,
		},
		{
			width: 1.0,
			height: 0.6,
			depth: 1.0,
			x: 0,
			y: -0.32,
			z: 0,
			uv: KRAKEN_HEAD_UV,
		},
		{
			width: 0.22,
			height: 0.18,
			depth: 0.22,
			x: 0,
			y: -0.68,
			z: 0.18,
			uv: KRAKEN_BEAK_UV,
		},
	];
	const radius = 0.42;
	for (let i = 0; i < 8; i++) {
		const ang = (i / 8) * Math.PI * 2;
		const tx = Math.cos(ang) * radius;
		const tz = Math.sin(ang) * radius;
		parts.push({
			width: 0.2,
			height: 1.05,
			depth: 0.2,
			x: tx,
			y: -1.12,
			z: tz,
			uv: KRAKEN_TENTACLE_UVS[i]!,
			partId: i % 2 === 0 ? 3 : 4,
		});
	}
	return parts;
}

const KRAKEN_PARTS = buildKrakenParts();

export const KRAKEN_HIT_HALF = { x: 0.85, y: 1.0, z: 0.85 };
const KRAKEN_BODY_HALF_SIZE = vec3(
	KRAKEN_HIT_HALF.x,
	KRAKEN_HIT_HALF.y,
	KRAKEN_HIT_HALF.z,
);
const KRAKEN_HIP_PIVOT_Y = -0.6;
const KRAKEN_WALK_AMP = 0.65;

let bodyPool: MobInstancePool | null = null;
function getBodyPool(): MobInstancePool {
	bodyPool ??= new MobInstancePool({
		name: "krakenInstances",
		parts: KRAKEN_PARTS,
		skinPath: MOB_KRAKEN_SKIN_PATH,
		instanceColors: true,
		tint: Color3.White(),
		hipPivotY: KRAKEN_HIP_PIVOT_Y,
		walkAmp: KRAKEN_WALK_AMP,
	});
	return bodyPool;
}
export function getKrakenInstancePool(): MobInstancePool {
	return getBodyPool();
}

type KrakenPayload = {
	position: { x: number; y: number; z: number };
	hp: number;
};

export class Kraken extends AquaticMob {
	readonly mobType = KRAKEN_MOB_TYPE;
	readonly CHUNK_ENTITY_TYPE = KRAKEN_CHUNK_ENTITY_TYPE;
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
		super(hp ?? KRAKEN_DEFAULT_HP, scene, KRAKEN_BODY_HALF_SIZE);
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
		});
	}

	protected override syncToInstances(): void {
		const pos = this.position;
		const pool = getBodyPool();
		pool.writeMatrix(this.#bodySlot, pos.x, pos.y, pos.z, this.facingYaw);
		pool.writeWalkPhase(this.#bodySlot, this.walkPhase);
	}

	configureChunkLoader(scene: SceneContext): void {
		Kraken.#chunkReloadScene = scene;
		if (Kraken.#chunkLoaderRegistered) return;
		Kraken.#chunkLoaderRegistered = true;
		registerChunkEntityLoader(KRAKEN_CHUNK_ENTITY_TYPE, (payload: unknown) => {
			const reloadScene = Kraken.#chunkReloadScene;
			if (!reloadScene) return;
			const data = payload as KrakenPayload | undefined;
			const position = data?.position;
			if (!position) return;
			Map1.mobRegistry?.addMob(
				new Kraken(position.x, position.y, position.z, reloadScene, data.hp),
			);
		});
	}

	getWanderSpeed(): number {
		return KRAKEN_WANDER_SPEED;
	}

	protected override getDepthRange(): { min: number; max: number } {
		return KRAKEN_STATS.depthRange ?? { min: 6, max: 32 };
	}

	/** Kraken does not despawn when beached — it's a boss. */
	protected override shouldStrandedDespawn(): boolean {
		return false;
	}

	onDeath(): void {}

	dispose(): void {
		if (this.isDisposed) return;
		unregisterMobLight(this.#bodySlot);
		getBodyPool().release(this.#bodySlot);
		super.dispose();
	}
}
