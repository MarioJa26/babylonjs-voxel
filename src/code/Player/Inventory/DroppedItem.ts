import type { ShaderMaterial } from "@babylonjs/lite";
import {
	addToScene,
	createMeshFromData,
	createShaderMaterial,
	type LiteMetadata,
	loadTexture2D,
	type Mesh,
	onBeforeRender,
	removeFromScene,
	setShaderTexture,
	setShaderUniform,
	setShaderVector3,
	type Texture2D,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import { MetadataContainer } from "@/code/Entities/MetadataContainer";
import type { IUsable } from "@/code/Interface/IUsable";
import { isUiOpen, UiFocus } from "@/code/Lib/GameRuntimeState";
import { vec3Zero } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import {
	getBlockByWorldCoords,
	getBlockStateByWorldCoords,
	getLightByWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	_voxelResolveScratch,
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
import { REACH_AURA } from "../PlayerStats";
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
		backFaceCulling: true,
	});
}

// --------------------------------------------------------------------------
// OPTIMIZATION: Cache geometry arrays globally. Creating these arrays on
// every DroppedItem instance causes massive GC spikes in dense worlds.
// --------------------------------------------------------------------------
let unitCubeGeometryCache: {
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	indices: Uint32Array;
} | null = null;

function getUnitCubeGeometry() {
	if (unitCubeGeometryCache) return unitCubeGeometryCache;

	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const indices: number[] = [];

	const faces: Array<{
		normal: [number, number, number];
		verts: Array<[number, number, number]>;
	}> = [
		// East: +X
		{
			normal: [1, 0, 0],
			verts: [
				[0.5, -0.5, 0.5],
				[0.5, -0.5, -0.5],
				[0.5, 0.5, -0.5],
				[0.5, 0.5, 0.5],
			],
		},

		// West: -X
		{
			normal: [-1, 0, 0],
			verts: [
				[-0.5, -0.5, -0.5],
				[-0.5, -0.5, 0.5],
				[-0.5, 0.5, 0.5],
				[-0.5, 0.5, -0.5],
			],
		},

		// Top: +Y
		{
			normal: [0, 1, 0],
			verts: [
				[-0.5, 0.5, 0.5],
				[0.5, 0.5, 0.5],
				[0.5, 0.5, -0.5],
				[-0.5, 0.5, -0.5],
			],
		},

		// Bottom: -Y
		{
			normal: [0, -1, 0],
			verts: [
				[-0.5, -0.5, -0.5],
				[0.5, -0.5, -0.5],
				[0.5, -0.5, 0.5],
				[-0.5, -0.5, 0.5],
			],
		},

		// South/front: +Z — already correct
		{
			normal: [0, 0, 1],
			verts: [
				[-0.5, -0.5, 0.5],
				[0.5, -0.5, 0.5],
				[0.5, 0.5, 0.5],
				[-0.5, 0.5, 0.5],
			],
		},

		// North/back: -Z — already correct
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

	for (let f = 0; f < faces.length; f++) {
		const face = faces[f];
		const base = positions.length / 3;
		for (let i = 0; i < 4; i++) {
			positions.push(face.verts[i][0], face.verts[i][1], face.verts[i][2]);
			normals.push(face.normal[0], face.normal[1], face.normal[2]);
			uvs.push(faceUV[i][0], faceUV[i][1]);
		}
		indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
	}

	unitCubeGeometryCache = {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		uvs: new Float32Array(uvs),
		indices: new Uint32Array(indices),
	};
	return unitCubeGeometryCache;
}

const ITEM_NAME: string = "droppedItem";
const ITEM_NAME_AABB: string = "droppedItemAABB";

// Pre-compute constants
const REACH_DISTANCE_SQ = REACH_AURA;
const LIGHT_NORMALIZE_MUL = 1.0 / 15.0;

// OPTIMIZATION: Share a single block sampler to prevent function closures per item
const SHARED_BLOCK_SAMPLER = createVoxelColliderBlockSampler(
	(x, y, z) => {
		const blockId = getBlockByWorldCoords(x, y, z);
		if (!isCollidableBlock(blockId)) return null;
		_voxelResolveScratch.blockId = blockId;
		_voxelResolveScratch.blockState = getBlockStateByWorldCoords(x, y, z);
		return _voxelResolveScratch;
	},
	{
		getFenceDynamicShape,
		getShapeForBlockId,
		isFenceBlockId,
		computeFenceNeighborMask,
	},
);

export class DroppedItem implements IUsable {
	#boxMesh: Mesh;
	#material: ShaderMaterial;
	#item: Item;
	#velocity = vec3Zero();
	#position: Vec3;
	#halfSize = 0.25;
	#voxelCollider: VoxelAabbCollider;
	#disposed = false;
	#itemIndex = -1;

	// Only update lighting when item crosses a voxel boundary.
	#lastLightX = Number.NaN;
	#lastLightY = Number.NaN;
	#lastLightZ = Number.NaN;

	// Reused tint tuple to avoid per-frame/per-light allocations.
	#tint: [number, number, number] = [1, 1, 1];

	// Track last synced position.
	#oldPositionX = Number.NaN;
	#oldPositionY = Number.NaN;
	#oldPositionZ = Number.NaN;

	// Grounded is inferred from Y collision.
	#grounded = false;

	// PERF: settled items do not need physics every frame.
	#sleeping = false;

	// Remote (server-authoritative) items: the server owns position +
	// lifetime. The client only renders + interpolates, so local physics is
	// disabled (kept "sleeping") and position is driven via setRemotePosition().
	#remoteInstanceId: number | null = null;
	#remotePickup: ((instanceId: number) => void) | null = null;

	// Optimistic pickup bookkeeping: what was granted locally while waiting
	// for the server's despawn/rejection. Cleared on success (despawn) or
	// rolled back on ItemPickupRejected.
	#remotePendingPickup: {
		player: Player;
		itemId: number;
		granted: number;
	} | null = null;

	static readonly #allItems: DroppedItem[] = [];
	static #observerRegistered = false;

	static #ensureObserver(): void {
		if (DroppedItem.#observerRegistered) return;
		DroppedItem.#observerRegistered = true;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			const dt = deltaMs * 0.001;
			if (dt <= 0) return;

			// PERF: skip item physics while any UI overlay owns the mouse.
			if (isUiOpen(UiFocus.pauseMenu)) return;

			const items = DroppedItem.#allItems;
			for (let i = 0, len = items.length; i < len; i++) {
				const item = items[i];
				if (!item.#sleeping) {
					item.#updatePhysics(dt);
				}
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

	static #sizeFor(stackSize: number): number {
		return 0.25 + stackSize * 0.009;
	}

	static #atlasPromise: Promise<Texture2D | null> | null = null;

	static #getAtlasTexture(): Promise<Texture2D | null> {
		if (!DroppedItem.#atlasPromise) {
			DroppedItem.#atlasPromise = loadTexture2D(
				Map1.engine,
				"/texture/diffuse_atlas.png",
				{
					mipMaps: true,
					magFilter: "nearest",
					minFilter: "nearest",
				},
			).catch(() => null);
		}

		return DroppedItem.#atlasPromise;
	}

	static preloadAtlas(): void {
		void DroppedItem.#getAtlasTexture();
	}

	constructor(item: Item, x: number, y: number, z: number) {
		const geometry = getUnitCubeGeometry();

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
		meta.set("use", this.use);
		this.#boxMesh.metadata = meta as unknown as LiteMetadata;

		this.#boxMesh.pickable = true;

		this.#position = vec3(x, y, z);
		this.#boxMesh.position.set(x, y, z);

		this.#material = createDroppedItemMaterial();
		this.#boxMesh.material = this.#material;
		this.#boxMesh.visible = false;

		this.#item = item;

		const size = DroppedItem.#sizeFor(item.stackSize);
		this.#boxMesh.scaling.set(size, size, size);
		this.#halfSize = size * 0.5;

		this.#voxelCollider = new VoxelAabbCollider(
			vec3(this.#halfSize, this.#halfSize, this.#halfSize),
			SHARED_BLOCK_SAMPLER,
			DroppedItem.EPSILON,
			{
				scene: Map1.mainScene,
				name: ITEM_NAME_AABB,
				position: this.#position,
				renderOrder: 1,
			},
		);

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

		this.#itemIndex = DroppedItem.#allItems.length;
		DroppedItem.#allItems.push(this);

		this.#syncTransformAndLightingIfMoved();
	}

	addVelocity(x: number, y: number, z: number): void {
		this.#velocity.x += x;
		this.#velocity.y += y;
		this.#velocity.z += z;

		if (x !== 0 || y !== 0 || z !== 0) {
			this.#sleeping = false;
		}
	}

	use = (player: Player): void => {
		// Remote (server-authoritative) items: optimistically add the stack to
		// the inventory and keep the mesh until the server confirms. The
		// server broadcasts ItemDespawn on success (RemoteItemManager then
		// disposes us) or ItemPickupRejected on failure (rollbackRemotePickup
		// removes the phantom stack again).
		if (this.#remoteInstanceId !== null && this.#remotePickup) {
			// A pickup is already in flight for this item — ignore repeats
			// so a double-click cannot grant two phantom stacks.
			if (this.#remotePendingPickup) return;

			this.#remotePickup(this.#remoteInstanceId);

			// addItem() drains item.stackSize into existing stacks, so the
			// granted amount is captured BEFORE the call.
			const requestedCount = this.#item.stackSize;
			const remainder = player.playerInventory.addItem(this.#item);
			this.#remotePendingPickup = {
				player,
				itemId: this.#item.itemId,
				granted: Math.max(0, requestedCount - remainder),
			};
			return;
		}

		const remainder = player.playerInventory.addItem(this.#item);
		if (remainder <= 0) {
			this.#dispose();
		} else {
			this.#resize();
		}
	};

	#resize(): void {
		const size = DroppedItem.#sizeFor(this.#item.stackSize);
		this.#boxMesh.scaling.set(size, size, size);
		this.#halfSize = size * 0.5;
		this.#voxelCollider.HalfExtents = vec3(
			this.#halfSize,
			this.#halfSize,
			this.#halfSize,
		);
	}

	#dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;

		// If we vanish while a pickup is in flight (ItemDespawn arrived =
		// success, or scene teardown), cancel rollback bookkeeping so a late
		// rejection can never remove stacks the server actually confirmed.
		this.#remotePendingPickup = null;

		const items = DroppedItem.#allItems;
		const last = items.pop();

		if (last !== undefined && last !== this) {
			items[this.#itemIndex] = last;
			last.#itemIndex = this.#itemIndex;
		}

		this.#voxelCollider.dispose();
		removeFromScene(Map1.mainScene, this.#boxMesh);
	}

	#updatePhysics(dt: number): void {
		this.#velocity.y += DroppedItem.GRAVITY * dt;

		this.#moveAxis(ColliderAxis.X, this.#velocity.x * dt);

		this.#grounded = false;
		const preY = this.#position.y;
		this.#moveAxis(ColliderAxis.Y, this.#velocity.y * dt);

		if (this.#position.y === preY && this.#velocity.y < 0) {
			this.#grounded = true;
		}

		this.#moveAxis(ColliderAxis.Z, this.#velocity.z * dt);

		const damping = this.#grounded
			? DroppedItem.GROUND_DAMPING_PER_SEC
			: DroppedItem.AIR_DAMPING_PER_SEC;

		const keep = Math.exp(-damping * dt);

		this.#velocity.x *= keep;
		this.#velocity.y *= keep;
		this.#velocity.z *= keep;

		if (this.#grounded && this.#velocity.y < 0) {
			this.#velocity.y = 0;
		}

		if (
			this.#velocity.x > -DroppedItem.MIN_SPEED &&
			this.#velocity.x < DroppedItem.MIN_SPEED
		) {
			this.#velocity.x = 0;
		}

		if (
			this.#velocity.y > -DroppedItem.MIN_SPEED &&
			this.#velocity.y < DroppedItem.MIN_SPEED
		) {
			this.#velocity.y = 0;
		}

		if (
			this.#velocity.z > -DroppedItem.MIN_SPEED &&
			this.#velocity.z < DroppedItem.MIN_SPEED
		) {
			this.#velocity.z = 0;
		}

		this.#syncTransformAndLightingIfMoved();

		// PERF: once settled on the ground, stop spending collision/light work every frame.
		if (
			this.#grounded &&
			this.#velocity.x === 0 &&
			this.#velocity.y === 0 &&
			this.#velocity.z === 0
		) {
			this.#sleeping = true;
		}
	}

	#moveAxis(axis: ColliderAxis, delta: number): void {
		if (delta === 0) return;

		this.#voxelCollider.moveAxis(
			this.#position,
			this.#velocity,
			axis,
			delta,
			DroppedItem.STEP_SIZE,
		);
	}

	#syncTransformAndLightingIfMoved(): void {
		const px = this.#position.x;
		const py = this.#position.y;
		const pz = this.#position.z;

		if (
			px === this.#oldPositionX &&
			py === this.#oldPositionY &&
			pz === this.#oldPositionZ
		) {
			return;
		}

		this.#oldPositionX = px;
		this.#oldPositionY = py;
		this.#oldPositionZ = pz;

		this.#boxMesh.position.set(px, py, pz);
		this.#voxelCollider.syncDebugMesh(this.#position);
		this.#updateLightingIfNeeded();
	}

	#updateLightingIfNeeded(): void {
		const lx = this.#position.x | 0;
		const ly = this.#position.y | 0;
		const lz = this.#position.z | 0;

		if (
			lx === this.#lastLightX &&
			ly === this.#lastLightY &&
			lz === this.#lastLightZ
		) {
			return;
		}

		this.#lastLightX = lx;
		this.#lastLightY = ly;
		this.#lastLightZ = lz;

		this.#applyTintFromPackedLight(
			getLightByWorldCoords(
				this.#position.x,
				this.#position.y,
				this.#position.z,
			),
		);
	}

	/**
	 * One-shot tint from a pre-sampled packed light value.
	 * Does not touch the per-voxel cache.
	 */
	public setInitialLight(packedLight: number): void {
		this.#applyTintFromPackedLight(packedLight);
	}

	/**
	 * Mark this item as server-authoritative. Disables local physics (the
	 * global observer skips sleeping items) and registers the pickup callback
	 * invoked when the local player interacts with it.
	 */
	public setRemote(
		instanceId: number,
		onPickup: (instanceId: number) => void,
	): void {
		this.#remoteInstanceId = instanceId;
		this.#remotePickup = onPickup;
		this.#sleeping = true;
	}

	get isRemote(): boolean {
		return this.#remoteInstanceId !== null;
	}

	/**
	 * The server rejected our optimistic pickup (ItemPickupRejected). Undo
	 * the local inventory grant so no phantom stack lingers. The mesh stays
	 * visible and pickable — for TooFar rejections the player can simply walk
	 * closer and try again.
	 */
	public rollbackRemotePickup(instanceId: number): void {
		if (this.#remoteInstanceId !== instanceId) return;

		const pending = this.#remotePendingPickup;
		if (!pending) return;
		this.#remotePendingPickup = null;

		if (pending.granted > 0) {
			pending.player.playerInventory.removeItems(
				pending.itemId,
				pending.granted,
			);
		}
	}

	/**
	 * Drive the rendered position from the server's authoritative state.
	 * Reused transform + lighting sync keeps the item lit correctly as it
	 * moves between voxels.
	 */
	public setRemotePosition(x: number, y: number, z: number): void {
		this.#position.x = x;
		this.#position.y = y;
		this.#position.z = z;
		this.#syncTransformAndLightingIfMoved();
	}

	/** Public dispose (idempotent) for the RemoteItemManager. */
	public dispose(): void {
		this.#dispose();
	}

	#applyTintFromPackedLight(packedLight: number): void {
		const skyLight = ((packedLight >> 4) & 0xf) * LIGHT_NORMALIZE_MUL;
		const blockLight = (packedLight & 0xf) * LIGHT_NORMALIZE_MUL;

		const sunElevation = -GLOBAL_VALUES.skyLightDirection.y + 0.1;
		const sunLightIntensity = Math.min(1.0, Math.max(0.0, sunElevation * 4.0));
		const skyScale = sunLightIntensity + 0.3;

		const skyR = skyLight * DroppedItem.SKY_LIGHT_COLOR.x * skyScale;
		const skyG = skyLight * DroppedItem.SKY_LIGHT_COLOR.y * skyScale;
		const skyB = skyLight * DroppedItem.SKY_LIGHT_COLOR.z * skyScale;

		const blockR = blockLight * DroppedItem.BLOCK_LIGHT_COLOR.x;
		const blockG = blockLight * DroppedItem.BLOCK_LIGHT_COLOR.y;
		const blockB = blockLight * DroppedItem.BLOCK_LIGHT_COLOR.z;

		this.#tint[0] = Math.min(1.0, Math.max(0.3, skyR + blockR));
		this.#tint[1] = Math.min(1.0, Math.max(0.3, skyG + blockG));
		this.#tint[2] = Math.min(1.0, Math.max(0.3, skyB + blockB));

		setShaderVector3(this.#material, "tintColor", this.#tint);
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

	get position(): Vec3 {
		return this.#position;
	}

	get item(): Item {
		return this.#item;
	}

	static disposeAll(): void {
		while (DroppedItem.#allItems.length > 0) {
			DroppedItem.#allItems[0].#dispose();
		}
	}

	static nearestTo(player: Player): DroppedItem | null {
		const p = player.position;
		let best: DroppedItem | null = null;
		let bestSq = REACH_DISTANCE_SQ;

		const items = DroppedItem.#allItems;

		for (let i = 0, len = items.length; i < len; i++) {
			const item = items[i];
			const m = item.#position;

			const dx = m.x - p.x;
			const dy = m.y - p.y;
			const dz = m.z - p.z;

			const dSq = dx * dx + dy * dy + dz * dz;
			if (dSq <= bestSq) {
				bestSq = dSq;
				best = item;
			}
		}

		return best;
	}

	static get activeItems(): ReadonlyArray<DroppedItem> {
		return DroppedItem.#allItems;
	}

	get halfExtent(): number {
		return this.#halfSize;
	}
}
