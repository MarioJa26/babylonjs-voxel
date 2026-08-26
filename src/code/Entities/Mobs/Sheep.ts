import { type SceneContext, vec3 } from "@babylonjs/lite";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import { dropWorldItem } from "../../Player/Inventory/dropWorldItem";
import { Item } from "../../Player/Inventory/Item";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";
import { type InstanceSlotHandle, MobInstancePool } from "./MobInstancePool";
import type { MobPartSpec } from "./MobMesh";
import {
	MOB_SHEEP_SKIN_PATH,
	SHEEP_BODY_UV,
	SHEEP_HEAD_UV,
	SHEEP_LEG_BL_UV,
	SHEEP_LEG_BR_UV,
	SHEEP_LEG_FL_UV,
	SHEEP_LEG_FR_UV,
} from "./MobSkin";
import { NeutralMob } from "./NeutralMob";

const SHEEP_MOB_TYPE = "sheep";
const SHEEP_CHUNK_ENTITY_TYPE = "sheep_v1";
const SHEEP_DEFAULT_HP = 8;
const SHEEP_WANDER_SPEED = 1.5;

const WOOL_DROP_BLOCK_ID = 1;

// Sheep anatomy: wool body + wool head + four legs. The whole herd renders
// through this ONE shared thin-instanced mesh (1 draw call total); wool color
// comes from the per-instance color buffer. UVs reference the editable skin
// layout in MobSkin.ts (each leg has its own region).
const SHEEP_PARTS: readonly MobPartSpec[] = [
	{
		width: 0.7,
		height: 0.65,
		depth: 1.0,
		x: 0,
		y: 0,
		z: 0,
		uv: SHEEP_BODY_UV,
	},
	{
		width: 0.38,
		height: 0.42,
		depth: 0.42,
		x: 0,
		y: 0.16,
		z: 0.6,
		uv: SHEEP_HEAD_UV,
	},
	{
		width: 0.16,
		height: 0.45,
		depth: 0.16,
		x: -0.21,
		y: -0.33,
		z: -0.32,
		uv: SHEEP_LEG_FL_UV,
	},
	{
		width: 0.16,
		height: 0.45,
		depth: 0.16,
		x: 0.21,
		y: -0.33,
		z: -0.32,
		uv: SHEEP_LEG_FR_UV,
	},
	{
		width: 0.16,
		height: 0.45,
		depth: 0.16,
		x: -0.21,
		y: -0.33,
		z: 0.32,
		uv: SHEEP_LEG_BL_UV,
	},
	{
		width: 0.16,
		height: 0.45,
		depth: 0.16,
		x: 0.21,
		y: -0.33,
		z: 0.32,
		uv: SHEEP_LEG_BR_UV,
	},
];

// Collider spans the whole animal so feet rest exactly on the ground.
// Arrow hit box matches the WOOL BODY only (±0.325 vertically, centered on
// the body) — not the full model extent, so arrows flying over the back or
// under the belly don't register.
export const SHEEP_HIT_HALF = { x: 0.36, y: 0.325, z: 0.52 };
const SHEEP_BODY_HALF_SIZE = vec3(
	SHEEP_HIT_HALF.x,
	SHEEP_HIT_HALF.y,
	SHEEP_HIT_HALF.z,
);
const SHEEP_COLORS = [
	{ name: "white", color: new Color3(0.95, 0.95, 0.95) },
	{ name: "black", color: new Color3(0.15, 0.15, 0.15) },
	{ name: "brown", color: new Color3(0.45, 0.25, 0.1) },
	{ name: "gray", color: new Color3(0.5, 0.5, 0.5) },
	{ name: "pink", color: new Color3(0.9, 0.5, 0.6) },
] as const;

let bodyPool: MobInstancePool | null = null;

function getBodyPool(): MobInstancePool {
	bodyPool ??= new MobInstancePool({
		name: "sheepInstances",
		parts: SHEEP_PARTS,
		instanceColors: true,
		skinPath: MOB_SHEEP_SKIN_PATH,
	});
	return bodyPool;
}

/** Shared instance pool — remote (server-authoritative) sheep render through
 * the same textured instanced mesh as local ones. */
export function getSheepInstancePool(): MobInstancePool {
	return getBodyPool();
}

type SheepSerializedPayload = {
	position: { x: number; y: number; z: number };
	hp: number;
	color: { r: number; g: number; b: number };
};

function colorToPayload(c: Color3): { r: number; g: number; b: number } {
	return { r: c.r, g: c.g, b: c.b };
}

function payloadToColor(p: { r: number; g: number; b: number }): Color3 {
	return new Color3(p.r, p.g, p.b);
}

function randomSheepColor(): Color3 {
	const entry = SHEEP_COLORS[(Math.random() * SHEEP_COLORS.length) | 0];
	return entry.color.clone();
}

export class Sheep extends NeutralMob {
	readonly mobType = SHEEP_MOB_TYPE;
	readonly CHUNK_ENTITY_TYPE = SHEEP_CHUNK_ENTITY_TYPE;

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
		super(hp ?? SHEEP_DEFAULT_HP, scene, SHEEP_BODY_HALF_SIZE);

		this.#color = color ?? randomSheepColor();

		this.setPosition(x, y, z);

		this.#bodySlot = getBodyPool().acquire(this);
		getBodyPool().writeColor(
			this.#bodySlot,
			this.#color.r,
			this.#color.g,
			this.#color.b,
		);
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
		Sheep.#chunkReloadScene = scene;

		if (Sheep.#chunkLoaderRegistered) return;
		Sheep.#chunkLoaderRegistered = true;

		registerChunkEntityLoader(SHEEP_CHUNK_ENTITY_TYPE, (payload: unknown) => {
			const reloadScene = Sheep.#chunkReloadScene;
			if (!reloadScene) return;

			const data = payload as SheepSerializedPayload | undefined;
			const position = data?.position;
			if (!position) return;

			const color = data.color
				? payloadToColor(data.color)
				: randomSheepColor();

			Map1.mobRegistry?.addMob(
				new Sheep(
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
		return SHEEP_WANDER_SPEED;
	}

	onDeath(): void {
		this.#dropWool();
	}

	protected override getExtraPayload(): Record<string, unknown> {
		return { color: colorToPayload(this.#color) };
	}

	#dropWool(): void {
		const pos = this.position;
		const item = Item.createById(WOOL_DROP_BLOCK_ID);

		item.stackSize = 1;

		// Pass the local player so the drop routes through ItemDrop in
		// multiplayer instead of spawning a server-unaware local item.
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
