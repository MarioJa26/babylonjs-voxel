import {
	copyVec3,
	type Mesh,
	type ShaderMaterial,
	vec3Zero,
} from "@babylonjs/core";
import {
	addToScene,
	addVec3InPlace,
	createMeshFromData,
	createShaderMaterial,
	type LiteMetadata,
	loadTexture2D,
	onBeforeRender,
	removeFromScene,
	scaleVec3InPlace,
	setShaderTexture,
	setShaderUniform,
	setShaderVector3,
	type Texture2D,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import { MetadataContainer } from "@/code/Entities/MetadataContainer";
import type { IUsable } from "@/code/Interface/IUsable";
import { Map1 } from "@/code/Maps/Map1";
import {
	getBlockByWorldCoords,
	getBlockStateByWorldCoords,
	getLightByWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	Axis as ColliderAxis,
	createVoxelColliderBlockSampler,
	VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import { getShapeForBlockId } from "@/code/World/Shape/BlockShapes";
import {
	computeFenceNeighborMask,
	getFenceDynamicShape,
	isFenceBlockId,
} from "@/code/World/Shape/FenceConnect";
import { getAtlasTile } from "@/code/World/Texture/BlockTextures";
import { isCollidableBlock } from "@/code/World/Texture/BlockType";
import {
	atlasSize,
	atlasTileSize,
	getDiffuseTexture2D,
} from "@/code/World/Texture/TextureAtlasFactory";
import type { Player } from "../Player";
import type { Item } from "./Item";

const droppedItemVertexWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vNormal : vec3<f32>,
  @location(2) vWorldPos : vec3<f32>,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  let worldPos = shaderSystem.world * vec4<f32>(input.position, 1.0);
  out.pos = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.vUV = input.uv;
  out.vNormal = input.normal;
  out.vWorldPos = worldPos.xyz;
  return out;
}
`;

const droppedItemFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vNormal : vec3<f32>,
  @location(2) vWorldPos : vec3<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let atlasUV = in.vUV * shaderUniforms.uScale + shaderUniforms.uOffset;
  let tex = textureSample(diffuseTexture, diffuseTextureSampler, atlasUV);
  let tint = shaderUniforms.tintColor;
  return vec4<f32>(tex.rgb * tint, 1.0);
}
`;

function createDroppedItemMaterial(): ShaderMaterial {
	return createShaderMaterial({
		name: "droppedItemMaterial",
		vertexSource: droppedItemVertexWGSL,
		fragmentSource: droppedItemFragmentWGSL,
		attributes: ["position", "normal", "uv"],
		uniforms: [
			"world",
			"worldViewProjection",
			{ name: "uScale", type: "f32" },
			{ name: "uOffset", type: "vec2<f32>" },
			{ name: "tintColor", type: "vec3<f32>" },
		],
		samplers: ["diffuseTexture"],
		backFaceCulling: false,
	});
}

function buildUnitCube(): {
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	indices: Uint32Array;
} {
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const indices: number[] = [];

	const faces: Array<{
		normal: [number, number, number];
		verts: Array<[number, number, number]>;
	}> = [
		{
			normal: [1, 0, 0],
			verts: [
				[0.5, -0.5, -0.5],
				[0.5, -0.5, 0.5],
				[0.5, 0.5, 0.5],
				[0.5, 0.5, -0.5],
			],
		},
		{
			normal: [-1, 0, 0],
			verts: [
				[-0.5, -0.5, 0.5],
				[-0.5, -0.5, -0.5],
				[-0.5, 0.5, -0.5],
				[-0.5, 0.5, 0.5],
			],
		},
		{
			normal: [0, 1, 0],
			verts: [
				[-0.5, 0.5, -0.5],
				[0.5, 0.5, -0.5],
				[0.5, 0.5, 0.5],
				[-0.5, 0.5, 0.5],
			],
		},
		{
			normal: [0, -1, 0],
			verts: [
				[-0.5, -0.5, 0.5],
				[0.5, -0.5, 0.5],
				[0.5, -0.5, -0.5],
				[-0.5, -0.5, -0.5],
			],
		},
		{
			normal: [0, 0, 1],
			verts: [
				[-0.5, -0.5, 0.5],
				[0.5, -0.5, 0.5],
				[0.5, 0.5, 0.5],
				[-0.5, 0.5, 0.5],
			],
		},
		{
			normal: [0, 0, -1],
			verts: [
				[0.5, -0.5, -0.5],
				[-0.5, -0.5, -0.5],
				[-0.5, 0.5, -0.5],
				[0.5, 0.5, -0.5],
			],
		},
	];

	const faceUV: Array<[number, number]> = [
		[0, 0],
		[1, 0],
		[1, 1],
		[0, 1],
	];

	faces.forEach((face) => {
		const base = positions.length / 3;
		for (let i = 0; i < 4; i++) {
			positions.push(...face.verts[i]);
			normals.push(...face.normal);
			uvs.push(...faceUV[i]);
		}
		indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
	});

	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		uvs: new Float32Array(uvs),
		indices: new Uint32Array(indices),
	};
}

interface PlayerDroppedItemApi {
	playerInventory: { addItem: (item: Item) => number };
}

const ITEM_NAME: string = "droppedItem";
const ITEM_NAME_AABB: string = "droppedItemAABB";
export class DroppedItem implements IUsable {
	#boxMesh: Mesh;
	#material: ShaderMaterial;
	#item: Item;
	#velocity = vec3Zero();
	#position: Vec3;
	#halfSize = 0.25;
	#voxelCollider!: VoxelAabbCollider;
	#scratchProbe = vec3Zero();
	#disposed = false;

	static readonly #allItems = new Set<DroppedItem>();
	static #observerRegistered = false;
	static #ensureObserver(): void {
		if (DroppedItem.#observerRegistered) return;
		DroppedItem.#observerRegistered = true;
		// TODO: physics relies on the Lite scene driving `onBeforeRender`.
		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			for (const item of DroppedItem.#allItems) {
				item.#updatePhysics(deltaMs);
			}
		});
	}

	static readonly GRAVITY = -18;
	static readonly STEP_SIZE = 0.2;
	static readonly EPSILON = 0.001;
	static readonly AIR_DAMPING_PER_SEC = 1.8;
	static readonly GROUND_DAMPING_PER_SEC = 8.0;
	static readonly MIN_SPEED = 0.03;
	static readonly SKY_LIGHT_COLOR = vec3(0.8, 0.8, 0.8);
	static readonly BLOCK_LIGHT_COLOR = vec3(0.9, 0.6, 0.2);

	static #atlasPromise: Promise<Texture2D | null> | null = null;
	static #getAtlasTexture(): Promise<Texture2D | null> {
		if (!DroppedItem.#atlasPromise) {
			DroppedItem.#atlasPromise = loadTexture2D(
				Map1.engine,
				"/texture/diffuse_atlas.png",
				{
					mipMaps: false,
					magFilter: "nearest",
					minFilter: "nearest",
				},
			).catch(() => null);
		}
		return DroppedItem.#atlasPromise;
	}

	/** Warm the atlas texture at startup so the first dropped item binds it
	 *  synchronously (cached promise) instead of rendering an unbound sampler. */
	static preloadAtlas(): void {
		void DroppedItem.#getAtlasTexture();
	}

	constructor(item: Item, x: number, y: number, z: number) {
		const size = 0.5 + item.stackSize * 0.005;
		const geometry = buildUnitCube();
		this.#boxMesh = createMeshFromData(
			Map1.engine,
			ITEM_NAME,
			geometry.positions,
			geometry.normals,
			geometry.indices,
			geometry.uvs,
		);
		addToScene(Map1.mainScene, this.#boxMesh);

		const meta = new MetadataContainer();
		meta.set("use", (player: Player) => this.use(player));
		this.#boxMesh.metadata = meta as unknown as LiteMetadata;

		this.#boxMesh.pickable = true;
		this.#boxMesh.scaling.set(size, size, size);
		this.#position = vec3(x, y, z);
		this.#boxMesh.position.set(x, y, z);

		this.#material = createDroppedItemMaterial();
		this.#boxMesh.material = this.#material;
		// Stay hidden until the atlas texture is bound — the ShaderMaterial
		// declares a `diffuseTexture` sampler, and the Lite renderer rejects an
		// unbound sampler, so we must not render before setShaderTexture() runs.
		this.#boxMesh.visible = false;

		this.#halfSize = size * 0.5;
		this.#item = item;
		this.#voxelCollider = new VoxelAabbCollider(
			vec3(this.#halfSize, this.#halfSize, this.#halfSize),
			createVoxelColliderBlockSampler(
				(x, y, z) => {
					const blockId = getBlockByWorldCoords(x, y, z);
					if (!isCollidableBlock(blockId)) return null;
					return { blockId, blockState: getBlockStateByWorldCoords(x, y, z) };
				},
				{
					getFenceDynamicShape,
					getShapeForBlockId,
					isFenceBlockId,
					computeFenceNeighborMask,
				},
			),
			DroppedItem.EPSILON,
			{
				scene: Map1.mainScene,
				name: ITEM_NAME_AABB,
				position: this.#position,
				renderingGroupId: 1,
			},
		);

		// Prefer the already-loaded shared atlas (set in initAtlas, same
		// Texture2D the chunk materials use) so we bind synchronously with no
		// async gap where an unbound `diffuseTexture` sampler could be rendered.
		const sharedAtlas = getDiffuseTexture2D();
		if (sharedAtlas) {
			setShaderTexture(this.#material, "diffuseTexture", sharedAtlas);
			this.#applyAtlasTile(item);
			this.#boxMesh.visible = true;
		} else {
			void DroppedItem.#getAtlasTexture().then((atlas) => {
				if (this.#disposed || !atlas) return;
				setShaderTexture(this.#material, "diffuseTexture", atlas);
				this.#applyAtlasTile(item);
				this.#boxMesh.visible = true;
			});
		}

		DroppedItem.#ensureObserver();
		DroppedItem.#allItems.add(this);
		this.#updateLighting();
	}

	pushItem(direction: Vec3): void {
		addVec3InPlace(this.#position, direction);
	}

	use(player: Player): void {
		const api = player as unknown as PlayerDroppedItemApi;
		const remainder = api.playerInventory.addItem(this.#item);
		if (remainder <= 0) {
			this.#dispose();
		}
	}
	#dispose(): void {
		this.#disposed = true;
		DroppedItem.#allItems.delete(this);
		this.#voxelCollider.dispose();
		removeFromScene(Map1.mainScene, this.#boxMesh);
	}

	#updatePhysics(deltaMs: number): void {
		if (this.#disposed) {
			DroppedItem.#allItems.delete(this);
			return;
		}

		const dt = deltaMs / 1000;
		if (dt <= 0) return;

		this.#velocity.y += DroppedItem.GRAVITY * dt;
		this.#moveAxis(ColliderAxis.X, this.#velocity.x * dt);
		this.#moveAxis(ColliderAxis.Y, this.#velocity.y * dt);
		this.#moveAxis(ColliderAxis.Z, this.#velocity.z * dt);

		const grounded = this.#isGrounded();
		const damping = grounded
			? DroppedItem.GROUND_DAMPING_PER_SEC
			: DroppedItem.AIR_DAMPING_PER_SEC;
		const keep = Math.max(0, 1 - damping * dt);
		scaleVec3InPlace(this.#velocity, keep);

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

		this.#boxMesh.position.set(
			this.#position.x,
			this.#position.y,
			this.#position.z,
		);
		this.#voxelCollider.syncDebugMesh(this.#position);
		//this.#updateLighting();
	}

	#moveAxis(axis: ColliderAxis, delta: number): void {
		this.#voxelCollider.moveAxis(
			this.#position,
			this.#velocity,
			axis,
			delta,
			DroppedItem.STEP_SIZE,
		);
	}

	#overlapsSolid(position: Vec3): boolean {
		return this.#voxelCollider.overlaps(position);
	}

	#isGrounded(): boolean {
		copyVec3(this.#scratchProbe, this.#position);
		this.#scratchProbe.y -= 0.01;
		return this.#overlapsSolid(this.#scratchProbe);
	}

	#updateLighting(): void {
		const packedLight = getLightByWorldCoords(
			this.#position.x,
			this.#position.y,
			this.#position.z,
		);

		const skyLight = ((packedLight >> 4) & 0xf) / 15;
		const blockLight = (packedLight & 0xf) / 15;

		const sunElevation = -GLOBAL_VALUES.skyLightDirection.y + 0.1;
		const sunLightIntensity = Math.min(1.0, Math.max(0.0, sunElevation * 4.0));
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

		setShaderVector3(this.#material, "tintColor", [finalR, finalG, finalB]);
	}

	#applyAtlasTile(item: Item): void {
		const tile = getAtlasTile(item.blockId) ?? [0, 0];
		const tileSize = atlasTileSize;
		const clampedX = Math.max(0, Math.min(atlasSize - 1, tile[0]));
		const clampedY = Math.max(0, Math.min(atlasSize - 1, tile[1]));
		const atlasRow = atlasSize - 1 - clampedY;

		setShaderUniform(this.#material, "uScale", tileSize);
		setShaderUniform(this.#material, "uOffset", [
			clampedX * tileSize,
			atlasRow * tileSize,
		]);
	}

	get boxMesh(): Mesh {
		return this.#boxMesh;
	}

	get item(): Item {
		return this.#item;
	}

	static disposeAll(): void {
		for (const item of [...DroppedItem.#allItems]) {
			item.#dispose();
		}
	}
}
