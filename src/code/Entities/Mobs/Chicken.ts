import {
	Color3,
	type Mesh,
	MeshBuilder,
	type Scene,
	StandardMaterial,
	Vector3,
} from "@babylonjs/core";
import type { Player } from "../../Player/Player";
import { registerChunkEntityLoader } from "../../World/Chunk/ChunkLoadingSystem";

import { MetadataContainer } from "../MetadataContainer";
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
	static #chunkReloadScene: Scene | null = null;

	#headMesh: Mesh;
	#headMaterial: StandardMaterial;
	#bodyMesh: Mesh;
	#bodyMaterial: StandardMaterial;

	constructor(x: number, y: number, z: number, scene: Scene, hp?: number) {
		super(
			hp ?? 4,
			scene,
			new Vector3(BODY_WIDTH * 0.5, BODY_HEIGHT * 0.5, BODY_DEPTH * 0.5),
		);

		// Body mesh
		this.#bodyMesh = MeshBuilder.CreateBox(
			"chickenBody",
			{ width: BODY_WIDTH, height: BODY_HEIGHT, depth: BODY_DEPTH },
			scene,
		);
		this.#bodyMesh.position = new Vector3(x, y, z);
		this.#bodyMesh.isPickable = true;
		this.#bodyMesh.renderingGroupId = 1;

		this.#bodyMaterial = new StandardMaterial("chickenBodyMat", scene);
		this.#bodyMaterial.diffuseColor = Color3.White();
		this.#bodyMaterial.specularColor = Color3.Black();
		this.#bodyMesh.material = this.#bodyMaterial;

		// Head mesh
		this.#headMesh = MeshBuilder.CreateBox(
			"chickenHead",
			{ width: HEAD_SIZE, height: HEAD_SIZE, depth: HEAD_SIZE },
			scene,
		);
		this.#headMesh.parent = this.#bodyMesh;
		this.#headMesh.position = new Vector3(
			0,
			BODY_HEIGHT * 0.5 + HEAD_SIZE * 0.3,
			BODY_DEPTH * 0.45,
		);
		this.#headMesh.isPickable = false;
		this.#headMesh.renderingGroupId = 1;

		this.#headMaterial = new StandardMaterial("chickenHeadMat", scene);
		this.#headMaterial.diffuseColor = new Color3(0.95, 0.95, 0.85);
		this.#headMaterial.specularColor = Color3.Black();
		this.#headMesh.material = this.#headMaterial;

		// Wire up body mesh to base class
		this.#bodyMesh.metadata = new MetadataContainer();
		this.setBodyMesh(this.#bodyMesh);
		this.#bodyMesh.metadata.set("use", (player: Player) => this.use(player));
	}

	// --- Abstract implementations ---

	configureChunkLoader(scene: Scene): void {
		Chicken.#chunkReloadScene = scene;
		if (Chicken.#chunkLoaderRegistered) return;
		Chicken.#chunkLoaderRegistered = true;

		registerChunkEntityLoader(this.CHUNK_ENTITY_TYPE, (payload: unknown) => {
			const s = Chicken.#chunkReloadScene;
			if (!s || s.isDisposed) return;
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
		this.#headMesh.dispose();
		this.#headMaterial.dispose();
		this.#bodyMesh.dispose();
		this.#bodyMaterial.dispose();
		super.dispose();
	}
}
