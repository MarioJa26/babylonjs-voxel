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
	MOB_SQUID_SKIN_PATH,
	SQUID_BODY_UV,
	SQUID_HEAD_UV,
	SQUID_TENTACLE_UVS,
} from "./MobSkin";

const SQUID_MOB_TYPE = "squid";
const SQUID_CHUNK_ENTITY_TYPE = "squid_v1";
const SQUID_STATS = getMobStats(MobTypeId.Squid);
const SQUID_DEFAULT_HP = SQUID_STATS.hp;
const SQUID_WANDER_SPEED = SQUID_STATS.speed;

function buildSquidParts(): readonly MobPartSpec[] {
	const parts: MobPartSpec[] = [
		{
			width: 0.6,
			height: 0.45,
			depth: 0.6,
			x: 0,
			y: 0.12,
			z: 0,
			uv: SQUID_BODY_UV,
		},
		{
			width: 0.45,
			height: 0.28,
			depth: 0.45,
			x: 0,
			y: -0.18,
			z: 0,
			uv: SQUID_HEAD_UV,
		},
	];
	// 8 tentacles radiating below head
	const radius = 0.16;
	for (let i = 0; i < 8; i++) {
		const ang = (i / 8) * Math.PI * 2;
		const tx = Math.cos(ang) * radius;
		const tz = Math.sin(ang) * radius;
		parts.push({
			width: 0.07,
			height: 0.45,
			depth: 0.07,
			x: tx,
			y: -0.52,
			z: tz,
			uv: SQUID_TENTACLE_UVS[i]!,
			partId: i % 2 === 0 ? 3 : 4,
		});
	}
	return parts;
}

const SQUID_PARTS = buildSquidParts();

export const SQUID_HIT_HALF = { x: 0.35, y: 0.45, z: 0.35 };
const SQUID_BODY_HALF_SIZE = vec3(
	SQUID_HIT_HALF.x,
	SQUID_HIT_HALF.y,
	SQUID_HIT_HALF.z,
);
const SQUID_HIP_PIVOT_Y = -0.3;
const SQUID_WALK_AMP = 0.55;

let bodyPool: MobInstancePool | null = null;
function getBodyPool(): MobInstancePool {
	bodyPool ??= new MobInstancePool({
		name: "squidInstances",
		parts: SQUID_PARTS,
		skinPath: MOB_SQUID_SKIN_PATH,
		instanceColors: true,
		tint: Color3.White(),
		hipPivotY: SQUID_HIP_PIVOT_Y,
		walkAmp: SQUID_WALK_AMP,
	});
	return bodyPool;
}
export function getSquidInstancePool(): MobInstancePool {
	return getBodyPool();
}

type SquidPayload = {
	position: { x: number; y: number; z: number };
	hp: number;
};

export class Squid extends AquaticMob {
	readonly mobType = SQUID_MOB_TYPE;
	readonly CHUNK_ENTITY_TYPE = SQUID_CHUNK_ENTITY_TYPE;
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
		super(hp ?? SQUID_DEFAULT_HP, scene, SQUID_BODY_HALF_SIZE);
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
		Squid.#chunkReloadScene = scene;
		if (Squid.#chunkLoaderRegistered) return;
		Squid.#chunkLoaderRegistered = true;
		registerChunkEntityLoader(SQUID_CHUNK_ENTITY_TYPE, (payload: unknown) => {
			const reloadScene = Squid.#chunkReloadScene;
			if (!reloadScene) return;
			const data = payload as SquidPayload | undefined;
			const position = data?.position;
			if (!position) return;
			Map1.mobRegistry?.addMob(
				new Squid(position.x, position.y, position.z, reloadScene, data.hp),
			);
		});
	}

	getWanderSpeed(): number {
		return SQUID_WANDER_SPEED;
	}

	protected override getDepthRange(): { min: number; max: number } {
		return SQUID_STATS.depthRange ?? { min: 1, max: 24 };
	}

	onDeath(): void {}

	dispose(): void {
		if (this.isDisposed) return;
		unregisterMobLight(this.#bodySlot);
		getBodyPool().release(this.#bodySlot);
		super.dispose();
	}
}
