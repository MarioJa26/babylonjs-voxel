import {
	Color3,
	type Mesh,
	MeshBuilder,
	type Observer,
	type Scene,
	StandardMaterial,
	Texture,
	Vector3,
} from "@babylonjs/core";
import { MetadataContainer } from "@/code/Entities/MetaDataContainer";
import type { IUsable } from "@/code/Inferface/IUsable";
import { Map1 } from "@/code/Maps/Map1";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	Axis,
	VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import { getAtlasTile } from "@/code/World/Texture/BlockTextures";
import { TextureAtlasFactory } from "@/code/World/Texture/TextureAtlasFactory";
import type { Player } from "../Player";
import type { Item } from "./Item";

export class DroppedItem implements IUsable {
	#boxMesh: Mesh;
	#material: StandardMaterial;
	#item: Item;
	#velocity = Vector3.Zero();
	#halfSize = 0.25;
	#voxelCollider!: VoxelAabbCollider;
	#observer: Observer<Scene> | null = null;
	#atlasTileTexture: Texture | null = null;
	static readonly GRAVITY = -18;
	static readonly STEP_SIZE = 0.2;
	static readonly EPSILON = 0.001;
	static readonly AIR_DAMPING_PER_SEC = 1.8;
	static readonly GROUND_DAMPING_PER_SEC = 8.0;
	static readonly MIN_SPEED = 0.03;
	static readonly SKY_LIGHT_COLOR = new Vector3(0.8, 0.8, 0.8);
	static readonly BLOCK_LIGHT_COLOR = new Vector3(0.9, 0.6, 0.2);

	constructor(item: Item, x: number, y: number, z: number) {
		const size = 0.5 + item.stackSize * 0.005;
		this.#boxMesh = MeshBuilder.CreateBox(
			"box",
			{ width: size, height: size, depth: size },
			Map1.mainScene,
		);
		this.#boxMesh.metadata = new MetadataContainer();
		this.#boxMesh.metadata.add("use", (player: Player) => this.use(player));

		this.#boxMesh.isPickable = true;
		this.#boxMesh.position = new Vector3(x, y, z);

		this.#material = new StandardMaterial(
			`droppedItemMaterial_${item.itemId}}`,
			Map1.mainScene,
		);
		this.#material.specularColor = Color3.Black();
		this.#applyAtlasTexture(item);
		this.#boxMesh.material = this.#material;

		this.#boxMesh.renderingGroupId = 1;
		this.#halfSize = size * 0.5;
		this.#item = item;
		this.#voxelCollider = new VoxelAabbCollider(
			new Vector3(this.#halfSize, this.#halfSize, this.#halfSize),
			(x, y, z) => {
				const blockId = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
				return blockId !== 0 && blockId !== 30;
			},
			DroppedItem.EPSILON,
			{
				scene: Map1.mainScene,
				name: "droppedItemAABB",
				position: this.#boxMesh.position,
				renderingGroupId: 1,
			},
		);

		this.#observer = Map1.mainScene.onBeforeRenderObservable.add(() => {
			this.#updatePhysics();
		});
		this.#updateLighting();
	}

	pushItem(direction: Vector3): void {
		this.#velocity.addInPlace(direction);
	}

	use(player: Player): void {
		const remainder = player.playerInventory.addItem(this.#item);
		if (remainder <= 0) {
			this.#dispose();
		}
	}
	#dispose(): void {
		if (this.#observer) {
			Map1.mainScene.onBeforeRenderObservable.remove(this.#observer);
			this.#observer = null;
		}
		this.#voxelCollider.dispose();
		this.#boxMesh.dispose();
		this.#atlasTileTexture?.dispose();
		this.#material.dispose();
	}

	#updatePhysics(): void {
		if (this.#boxMesh.isDisposed()) {
			if (this.#observer) {
				Map1.mainScene.onBeforeRenderObservable.remove(this.#observer);
				this.#observer = null;
			}
			return;
		}

		const dt = Map1.mainScene.getEngine().getDeltaTime() / 1000;
		if (dt <= 0) return;

		this.#velocity.y += DroppedItem.GRAVITY * dt;
		this.#moveAxis(Axis.X, this.#velocity.x * dt);
		this.#moveAxis(Axis.Y, this.#velocity.y * dt);
		this.#moveAxis(Axis.Z, this.#velocity.z * dt);

		const grounded = this.#isGrounded();
		const damping = grounded
			? DroppedItem.GROUND_DAMPING_PER_SEC
			: DroppedItem.AIR_DAMPING_PER_SEC;
		const keep = Math.max(0, 1 - damping * dt);
		this.#velocity.scaleInPlace(keep);

		if (grounded && this.#velocity.y < 0) {
			this.#velocity.y = 0;
		}

		if (Math.abs(this.#velocity.x) < DroppedItem.MIN_SPEED) {
			this.#velocity.x = 0;
		}
		if (Math.abs(this.#velocity.y) < DroppedItem.MIN_SPEED) {
			this.#velocity.y = 0;
		}
		if (Math.abs(this.#velocity.z) < DroppedItem.MIN_SPEED) {
			this.#velocity.z = 0;
		}

		// Sync debug AABB once per frame (not per collision sub-step).
		this.#voxelCollider.syncDebugMesh(this.#boxMesh.position);
		//this.#updateLighting();
	}

	#moveAxis(axis: Axis, delta: number): void {
		this.#voxelCollider.moveAxis(
			this.#boxMesh.position,
			this.#velocity,
			axis,
			delta,
			DroppedItem.STEP_SIZE,
		);
	}

	#overlapsSolid(position: Vector3): boolean {
		return this.#voxelCollider.overlaps(position);
	}

	#isGrounded(): boolean {
		const probe = this.#boxMesh.position.clone();
		probe.y -= 0.01;
		return this.#overlapsSolid(probe);
	}

	#updateLighting(): void {
		const packedLight = ChunkLoadingSystem.getLightByWorldCoords(
			this.#boxMesh.position.x,
			this.#boxMesh.position.y,
			this.#boxMesh.position.z,
		);

		const skyLight = ((packedLight >> 4) & 0xf) / 15;
		const blockLight = (packedLight & 0xf) / 15;

		const sunElevation = -GLOBAL_VALUES.skyLightDirection.y + 0.1;
		const sunLightIntensity = Math.min(1.0, Math.max(0.1, sunElevation * 4.0));
		const skyScale = sunLightIntensity + 0.3;

		const skyR = skyLight * DroppedItem.SKY_LIGHT_COLOR.x * skyScale;
		const skyG = skyLight * DroppedItem.SKY_LIGHT_COLOR.y * skyScale;
		const skyB = skyLight * DroppedItem.SKY_LIGHT_COLOR.z * skyScale;

		const blockR = blockLight * DroppedItem.BLOCK_LIGHT_COLOR.x;
		const blockG = blockLight * DroppedItem.BLOCK_LIGHT_COLOR.y;
		const blockB = blockLight * DroppedItem.BLOCK_LIGHT_COLOR.z;

		const finalR = Math.min(1, Math.max(0.3, skyR + blockR));
		const finalG = Math.min(1, Math.max(0.3, skyG + blockG));
		const finalB = Math.min(1, Math.max(0.3, skyB + blockB));

		this.#material.diffuseColor.set(finalR, finalG, finalB);
	}

	#getOrCreateAtlasTexture(): Texture {
		let atlas = TextureAtlasFactory.getDiffuse();
		if (!atlas) {
			console.warn("error atlas not saved");
			atlas = new Texture("/texture/diffuse_atlas.png", Map1.mainScene, {
				noMipmap: false,
				samplingMode: Texture.NEAREST_SAMPLINGMODE,
			});
			atlas.wrapU = Texture.CLAMP_ADDRESSMODE;
			atlas.wrapV = Texture.CLAMP_ADDRESSMODE;
			TextureAtlasFactory.setDiffuse(atlas);
		}
		return atlas;
	}

	#applyAtlasTexture(item: Item): void {
		const atlasTexture = this.#getOrCreateAtlasTexture();
		const tile = getAtlasTile(item.blockId) ?? [0, 0];
		const atlasSize = TextureAtlasFactory.atlasSize;
		const tileSize = TextureAtlasFactory.atlasTileSize;
		const clampedX = Math.max(0, Math.min(atlasSize - 1, tile[0]));
		const clampedY = Math.max(0, Math.min(atlasSize - 1, tile[1]));
		const atlasRow = atlasSize - 1 - clampedY;

		this.#atlasTileTexture = atlasTexture.clone();
		if (!this.#atlasTileTexture) {
			this.#material.diffuseColor = Color3.White();
			return;
		}

		this.#atlasTileTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
		this.#atlasTileTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
		this.#atlasTileTexture.uScale = tileSize;
		this.#atlasTileTexture.vScale = tileSize;
		this.#atlasTileTexture.uOffset = clampedX * tileSize;
		this.#atlasTileTexture.vOffset = atlasRow * tileSize;
		this.#material.diffuseTexture = this.#atlasTileTexture;
	}

	get boxMesh(): Mesh {
		return this.#boxMesh;
	}

	get item(): Item {
		return this.#item;
	}
}
