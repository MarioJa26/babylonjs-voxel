import {
	addToScene,
	type Mesh,
	removeFromScene,
	type SceneContext,
	vec3,
} from "@babylonjs/lite";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import { DroppedItem } from "../../Player/Inventory/DroppedItem";
import { Item } from "../../Player/Inventory/Item";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";
import { createBoxMobMesh } from "./MobMesh";
import { NeutralMob } from "./NeutralMob";

const BODY_WIDTH = 0.6;
const BODY_HEIGHT = 0.6;
const BODY_DEPTH = 0.9;

const SHEEP_MOB_TYPE = "sheep";
const SHEEP_CHUNK_ENTITY_TYPE = "sheep_v1";
const SHEEP_DEFAULT_HP = 8;
const SHEEP_WANDER_SPEED = 1.5;

const WOOL_DROP_BLOCK_ID = 1;

const BODY_HALF_WIDTH = BODY_WIDTH * 0.5;
const BODY_HALF_HEIGHT = BODY_HEIGHT * 0.5;
const BODY_HALF_DEPTH = BODY_DEPTH * 0.5;

const SHEEP_BODY_HALF_SIZE = vec3(
	BODY_HALF_WIDTH,
	BODY_HALF_HEIGHT,
	BODY_HALF_DEPTH,
);

const SHEEP_COLORS = [
	{ name: "white", color: new Color3(0.95, 0.95, 0.95) },
	{ name: "black", color: new Color3(0.15, 0.15, 0.15) },
	{ name: "brown", color: new Color3(0.45, 0.25, 0.1) },
	{ name: "gray", color: new Color3(0.5, 0.5, 0.5) },
	{ name: "pink", color: new Color3(0.9, 0.5, 0.6) },
] as const;

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

	#bodyMesh: Mesh;
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

		this.#bodyMesh = createBoxMobMesh(
			"sheepBody",
			BODY_WIDTH,
			BODY_HEIGHT,
			BODY_DEPTH,
			this.#color,
			"sheepBodyMat",
		);
		this.#bodyMesh.position.set(x, y, z);

		addToScene(Map1.mainScene, this.#bodyMesh);

		this.setBodyMesh(this.#bodyMesh);
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
		const pos = this.#bodyMesh.position;
		const item = Item.createById(WOOL_DROP_BLOCK_ID);

		item.stackSize = 1;

		new DroppedItem(item, pos.x, pos.y + 0.5, pos.z);
	}

	dispose(): void {
		if (this.isDisposed) return;
		removeFromScene(Map1.mainScene, this.#bodyMesh);
		super.dispose();
	}
}
