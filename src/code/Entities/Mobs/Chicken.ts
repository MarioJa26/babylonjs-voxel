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
import type { Player } from "../../Player/Player";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";

import { MetadataContainer } from "../MetadataContainer";
import { buildBoxGeometry, createMobColorMaterial } from "./MobMesh";
import { NeutralMob } from "./NeutralMob";

const BODY_WIDTH = 0.5;
const BODY_HEIGHT = 0.4;
const BODY_DEPTH = 0.3;
const HEAD_SIZE = 0.2;

type ChickenSerializedPayload = {
	position: { x: number; y: number; z: number };
	hp: number;
};

export class Chicken extends NeutralMob {
	readonly mobType = "chicken";
	readonly CHUNK_ENTITY_TYPE = "chicken_v1";

	static #chunkLoaderRegistered = false;
	static #chunkReloadScene: SceneContext | null = null;

	#headMesh: Mesh;
	#headMaterial: ReturnType<typeof createMobColorMaterial>;
	#bodyMesh: Mesh;
	#bodyMaterial: ReturnType<typeof createMobColorMaterial>;

	constructor(
		x: number,
		y: number,
		z: number,
		scene: SceneContext,
		hp?: number,
	) {
		super(
			hp ?? 4,
			scene,
			vec3(BODY_WIDTH * 0.5, BODY_HEIGHT * 0.5, BODY_DEPTH * 0.5),
		);

		// Body mesh
		const bodyGeo = buildBoxGeometry(BODY_WIDTH, BODY_HEIGHT, BODY_DEPTH);
		this.#bodyMesh = createMeshFromData(
			Map1.engine,
			"chickenBody",
			bodyGeo.positions,
			bodyGeo.normals,
			bodyGeo.indices,
		);
		this.#bodyMesh.position.set(x, y, z);
		this.#bodyMesh.pickable = true;
		this.#bodyMesh.renderOrder = 1;

		this.#bodyMaterial = createMobColorMaterial(
			Color3.White(),
			"chickenBodyMat",
		);
		this.#bodyMesh.material = this.#bodyMaterial;

		// Head mesh
		const headGeo = buildBoxGeometry(HEAD_SIZE, HEAD_SIZE, HEAD_SIZE);
		this.#headMesh = createMeshFromData(
			Map1.engine,
			"chickenHead",
			headGeo.positions,
			headGeo.normals,
			headGeo.indices,
		);
		this.#headMesh.parent = this.#bodyMesh;
		this.#headMesh.position.set(
			0,
			BODY_HEIGHT * 0.5 + HEAD_SIZE * 0.3,
			BODY_DEPTH * 0.45,
		);
		this.#headMesh.pickable = false;
		this.#headMesh.renderOrder = 1;

		this.#headMaterial = createMobColorMaterial(
			new Color3(0.95, 0.95, 0.85),
			"chickenHeadMat",
		);
		this.#headMesh.material = this.#headMaterial;

		addToScene(Map1.mainScene, this.#bodyMesh);

		// Wire up body mesh to base class
		const meta = new MetadataContainer();
		this.#bodyMesh.metadata = meta as unknown as LiteMetadata;
		this.setBodyMesh(this.#bodyMesh);
		meta.set("use", (player: Player) => this.use(player));
	}

	// --- Abstract implementations ---

	configureChunkLoader(scene: SceneContext): void {
		Chicken.#chunkReloadScene = scene;
		if (Chicken.#chunkLoaderRegistered) return;
		Chicken.#chunkLoaderRegistered = true;

		registerChunkEntityLoader(this.CHUNK_ENTITY_TYPE, (payload: unknown) => {
			const s = Chicken.#chunkReloadScene;
			if (!s) return;
			const data = payload as ChickenSerializedPayload | undefined;
			if (!data?.position) return;
			new Chicken(
				data.position.x,
				data.position.y,
				data.position.z,
				s,
				data.hp,
			);
		});
	}

	getWanderSpeed(): number {
		return 1.8;
	}

	onDeath(): void {
		// No drops
	}

	// --- Cleanup ---

	dispose(): void {
		if (this.isDisposed) return;
		removeFromScene(Map1.mainScene, this.#headMesh);
		removeFromScene(Map1.mainScene, this.#bodyMesh);
		super.dispose();
	}
}
