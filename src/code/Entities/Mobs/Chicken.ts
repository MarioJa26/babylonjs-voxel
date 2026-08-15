import {
	addToScene,
	createMeshFromData,
	type LiteMetadata,
	type Mesh,
	removeFromScene,
	type SceneContext,
	vec3,
} from "@babylonjs/lite";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import type { Player } from "../../Player/Player";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";

import { MetadataContainer } from "../MetadataContainer";
import { buildBoxGeometry, createMobColorMaterial } from "./MobMesh";
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

const CHICKEN_BODY_GEOMETRY = buildBoxGeometry(
	BODY_WIDTH,
	BODY_HEIGHT,
	BODY_DEPTH,
);

const CHICKEN_HEAD_GEOMETRY = buildBoxGeometry(HEAD_SIZE, HEAD_SIZE, HEAD_SIZE);

const CHICKEN_HEAD_COLOR = new Color3(0.95, 0.95, 0.85);

let chickenBodyMaterial: ReturnType<typeof createMobColorMaterial> | null =
	null;
let chickenHeadMaterial: ReturnType<typeof createMobColorMaterial> | null =
	null;

function getChickenBodyMaterial(): ReturnType<typeof createMobColorMaterial> {
	if (!chickenBodyMaterial) {
		chickenBodyMaterial = createMobColorMaterial(
			Color3.White(),
			"chickenBodyMat",
		);
	}

	return chickenBodyMaterial;
}

function getChickenHeadMaterial(): ReturnType<typeof createMobColorMaterial> {
	if (!chickenHeadMaterial) {
		chickenHeadMaterial = createMobColorMaterial(
			CHICKEN_HEAD_COLOR,
			"chickenHeadMat",
		);
	}

	return chickenHeadMaterial;
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

	#headMesh: Mesh;
	#bodyMesh: Mesh;

	constructor(
		x: number,
		y: number,
		z: number,
		scene: SceneContext,
		hp?: number,
	) {
		super(hp ?? CHICKEN_DEFAULT_HP, scene, CHICKEN_BODY_HALF_SIZE);

		this.#bodyMesh = createMeshFromData(
			Map1.engine,
			"chickenBody",
			CHICKEN_BODY_GEOMETRY.positions,
			CHICKEN_BODY_GEOMETRY.normals,
			CHICKEN_BODY_GEOMETRY.indices,
		);

		this.#bodyMesh.position.set(x, y, z);
		this.#bodyMesh.pickable = true;
		this.#bodyMesh.renderOrder = 1;
		this.#bodyMesh.material = getChickenBodyMaterial();

		this.#headMesh = createMeshFromData(
			Map1.engine,
			"chickenHead",
			CHICKEN_HEAD_GEOMETRY.positions,
			CHICKEN_HEAD_GEOMETRY.normals,
			CHICKEN_HEAD_GEOMETRY.indices,
		);

		this.#headMesh.parent = this.#bodyMesh;
		this.#headMesh.position.set(0, HEAD_OFFSET_Y, HEAD_OFFSET_Z);
		this.#headMesh.pickable = false;
		this.#headMesh.renderOrder = 1;
		this.#headMesh.material = getChickenHeadMaterial();

		addToScene(Map1.mainScene, this.#bodyMesh);

		const meta = new MetadataContainer();
		this.#bodyMesh.metadata = meta as unknown as LiteMetadata;

		this.setBodyMesh(this.#bodyMesh);
		meta.set("use", (player: Player) => this.use(player));
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
		removeFromScene(Map1.mainScene, this.#headMesh);
		removeFromScene(Map1.mainScene, this.#bodyMesh);
		super.dispose();
	}
}
