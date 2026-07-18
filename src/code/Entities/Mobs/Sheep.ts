import { Color3, type Mesh } from "@babylonjs/core";
import {
	addToScene,
	createMeshFromData,
	type LiteMetadata,
	removeFromScene,
	type SceneContext,
	vec3,
} from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import { DroppedItem } from "../../Player/Inventory/DroppedItem";
import { Item } from "../../Player/Inventory/Item";
import type { Player } from "../../Player/Player";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";
import { MetadataContainer } from "../MetadataContainer";
import { buildBoxGeometry, createMobColorMaterial } from "./MobMesh";
import { NeutralMob } from "./NeutralMob";

const BODY_WIDTH = 0.6;
const BODY_HEIGHT = 0.6;
const BODY_DEPTH = 0.9;
const WOOL_DROP_BLOCK_ID = 1;

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
	const entry = SHEEP_COLORS[Math.floor(Math.random() * SHEEP_COLORS.length)];
	return entry.color.clone();
}

export class Sheep extends NeutralMob {
	readonly mobType = "sheep";
	readonly CHUNK_ENTITY_TYPE = "sheep_v1";

	static #chunkLoaderRegistered = false;
	static #chunkReloadScene: SceneContext | null = null;

	#bodyMesh: Mesh;
	#bodyMaterial: ReturnType<typeof createMobColorMaterial>;
	#color: Color3;

	constructor(
		x: number,
		y: number,
		z: number,
		scene: SceneContext,
		hp?: number,
		color?: Color3,
	) {
		super(
			hp ?? 8,
			scene,
			vec3(BODY_WIDTH * 0.5, BODY_HEIGHT * 0.5, BODY_DEPTH * 0.5),
		);

		this.#color = color ?? randomSheepColor();

		// Body mesh
		const bodyGeo = buildBoxGeometry(BODY_WIDTH, BODY_HEIGHT, BODY_DEPTH);
		this.#bodyMesh = createMeshFromData(
			Map1.engine,
			"sheepBody",
			bodyGeo.positions,
			bodyGeo.normals,
			bodyGeo.indices,
		);
		this.#bodyMesh.position.set(x, y, z);
		this.#bodyMesh.pickable = true;
		this.#bodyMesh.renderOrder = 1;

		this.#bodyMaterial = createMobColorMaterial(
			this.#color.clone(),
			"sheepBodyMat",
		);
		this.#bodyMesh.material = this.#bodyMaterial;

		addToScene(Map1.mainScene, this.#bodyMesh);

		// Wire up body mesh to base class
		const meta = new MetadataContainer();
		this.#bodyMesh.metadata = meta as unknown as LiteMetadata;
		this.setBodyMesh(this.#bodyMesh);
		meta.set("use", (player: Player) => this.use(player));
	}

	// --- Abstract implementations ---

	configureChunkLoader(scene: SceneContext): void {
		Sheep.#chunkReloadScene = scene;
		if (Sheep.#chunkLoaderRegistered) return;
		Sheep.#chunkLoaderRegistered = true;

		registerChunkEntityLoader(this.CHUNK_ENTITY_TYPE, (payload: unknown) => {
			const s = Sheep.#chunkReloadScene;
			if (!s) return;
			const data = payload as SheepSerializedPayload | undefined;
			if (!data?.position) return;
			const color = data.color
				? payloadToColor(data.color)
				: randomSheepColor();
			new Sheep(
				data.position.x,
				data.position.y,
				data.position.z,
				s,
				data.hp,
				color,
			);
		});
	}

	getWanderSpeed(): number {
		return 1.5;
	}

	onDeath(): void {
		this.#dropWool();
	}

	protected override getExtraPayload(): Record<string, unknown> {
		return { color: colorToPayload(this.#color) };
	}

	// --- Sheep-specific ---

	#dropWool(): void {
		const pos = this.#bodyMesh.position;
		const item = Item.createById(WOOL_DROP_BLOCK_ID);
		item.stackSize = 1;
		new DroppedItem(item, pos.x, pos.y + 0.5, pos.z);
	}

	// --- Cleanup ---

	dispose(): void {
		if (this.isDisposed) return;
		removeFromScene(Map1.mainScene, this.#bodyMesh);
		super.dispose();
	}
}
