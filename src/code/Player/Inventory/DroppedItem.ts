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
	getLightByWorldCoords,
	resolveBlockAtWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	_voxelResolveScratch,
	Axis as ColliderAxis,
	createVoxelColliderBlockSampler,
	UNLOADED_SOLID_RESOLVE,
	VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import {
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
	getShapeForBlockId,
	isRegisteredBlockId,
} from "@/code/World/Shape/BlockShapes";
import { getTransformedShapeBoxes } from "@/code/World/Shape/BlockShapeTransforms";
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
  // Alpha test for billboard item sprites (block atlas texels are opaque).
  if (tex.a < 0.5) { discard; }
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

// PERF: ShaderMaterials are pooled per blockId instead of built per item.
// uScale/uOffset are fixed by blockId, so a pooled instance only needs the
// tint refresh it gets on every light crossing anyway. Pooling removes
// pipeline/bind-group churn per spawn AND fixes the old leak where _dispose
// never released the material at all. Cap bounds worst-case VRAM; overflow
// materials are disposed outright.
const MATERIAL_POOL_MAX = 64;
const droppedItemMaterialPool = new Map<number, ShaderMaterial[]>();

// Lite's ShaderMaterial type exposes no dispose — call it structurally
// (same pattern as MaterialFactory's local dispose? interface).
function disposeItemMaterial(mat: ShaderMaterial): void {
	(mat as unknown as { dispose?: () => void }).dispose?.();
}

export function acquireDroppedItemMaterial(blockId: number): ShaderMaterial {
	const pool = droppedItemMaterialPool.get(blockId);
	const reused = pool?.pop();
	if (reused) return reused;
	return createDroppedItemMaterial();
}

export function releaseDroppedItemMaterial(
	blockId: number,
	mat: ShaderMaterial,
): void {
	let total = 0;
	for (const stack of droppedItemMaterialPool.values()) total += stack.length;
	if (total >= MATERIAL_POOL_MAX) {
		disposeItemMaterial(mat);
		return;
	}
	let pool = droppedItemMaterialPool.get(blockId);
	if (!pool) {
		pool = [];
		droppedItemMaterialPool.set(blockId, pool);
	}
	pool.push(mat);
}

function disposeAllPooledItemMaterials(): void {
	for (const stack of droppedItemMaterialPool.values()) {
		for (const mat of stack) disposeItemMaterial(mat);
	}
	droppedItemMaterialPool.clear();

	for (const stack of spriteMaterialPool.values()) {
		for (const mat of stack) disposeItemMaterial(mat);
	}
	spriteMaterialPool.clear();
}

// ─── Billboard sprites (non-block items) ──────────────────────────────────────
// Items without a block shape (tools, ingots, eggs, ...) drop as a single
// camera-facing quad textured with the item's icon PNG — far cheaper than a
// textured cube and visually correct for flat item art.

const spriteMaterialPool = new Map<string, ShaderMaterial[]>();
const spriteTextureCache = new Map<string, Promise<Texture2D | null>>();

export function acquireSpriteMaterial(iconUrl: string): ShaderMaterial {
	const reused = spriteMaterialPool.get(iconUrl)?.pop();
	if (reused) return reused;
	return createDroppedItemMaterial();
}

export function releaseSpriteMaterial(
	iconUrl: string,
	mat: ShaderMaterial,
): void {
	let total = 0;
	for (const stack of spriteMaterialPool.values()) total += stack.length;
	if (total >= MATERIAL_POOL_MAX) {
		disposeItemMaterial(mat);
		return;
	}
	let pool = spriteMaterialPool.get(iconUrl);
	if (!pool) {
		pool = [];
		spriteMaterialPool.set(iconUrl, pool);
	}
	pool.push(mat);
}

/** Fallback sprite when an item icon PNG is missing (art not created yet). */
export const PLACEHOLDER_ICON_URL = "/texture/placeholder.png";

export function getIconTexture(url: string): Promise<Texture2D | null> {
	let promise = spriteTextureCache.get(url);
	if (!promise) {
		promise = loadTexture2D(Map1.engine, url, {
			mipMaps: true,
			magFilter: "nearest",
			minFilter: "nearest",
		}).catch(() => null);
		spriteTextureCache.set(url, promise);
	}
	return promise;
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

type ItemGeometry = {
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	indices: Uint32Array;
};

const shapeGeometryCache = new Map<string, ItemGeometry>();

const SHAPE_FACES: Array<{
	bit: number;
	normal: [number, number, number];
	verts: (
		min: [number, number, number],
		max: [number, number, number],
	) => Array<[number, number, number]>;
}> = [
	{
		bit: FACE_PX,
		normal: [1, 0, 0],
		verts: (min, max) => [
			[max[0], min[1], max[2]],
			[max[0], min[1], min[2]],
			[max[0], max[1], min[2]],
			[max[0], max[1], max[2]],
		],
	},
	{
		bit: FACE_NX,
		normal: [-1, 0, 0],
		verts: (min, max) => [
			[min[0], min[1], min[2]],
			[min[0], min[1], max[2]],
			[min[0], max[1], max[2]],
			[min[0], max[1], min[2]],
		],
	},
	{
		bit: FACE_PY,
		normal: [0, 1, 0],
		verts: (min, max) => [
			[min[0], max[1], max[2]],
			[max[0], max[1], max[2]],
			[max[0], max[1], min[2]],
			[min[0], max[1], min[2]],
		],
	},
	{
		bit: FACE_NY,
		normal: [0, -1, 0],
		verts: (min, max) => [
			[min[0], min[1], min[2]],
			[max[0], min[1], min[2]],
			[max[0], min[1], max[2]],
			[min[0], min[1], max[2]],
		],
	},
	{
		bit: FACE_PZ,
		normal: [0, 0, 1],
		verts: (min, max) => [
			[min[0], min[1], max[2]],
			[max[0], min[1], max[2]],
			[max[0], max[1], max[2]],
			[min[0], max[1], max[2]],
		],
	},
	{
		bit: FACE_NZ,
		normal: [0, 0, -1],
		verts: (min, max) => [
			[max[0], min[1], min[2]],
			[min[0], min[1], min[2]],
			[min[0], max[1], min[2]],
			[max[0], max[1], min[2]],
		],
	},
];

export function getBlockItemGeometry(
	blockId: number,
	blockState: number,
): ItemGeometry {
	const shape = getShapeForBlockId(blockId);
	const cacheKey = `${blockId}:${blockState & 63}`;
	const cached = shapeGeometryCache.get(cacheKey);
	if (cached) return cached;

	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const indices: number[] = [];

	const addQuad = (
		verts: Array<[number, number, number]>,
		normal: [number, number, number],
	): void => {
		const base = positions.length / 3;
		for (let i = 0; i < 4; i++) {
			positions.push(verts[i][0] - 0.5, verts[i][1] - 0.5, verts[i][2] - 0.5);
			normals.push(normal[0], normal[1], normal[2]);
		}
		uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
		indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
	};

	if (shape.name === "cross_diagonal") {
		// Cross-diagonal foliage is intentionally represented by two diagonal
		// planes rather than box faces. Add both windings because the shared
		// dropped-item material keeps back-face culling enabled.
		const a: Array<[number, number, number]> = [
			[0, 0, 0],
			[1, 0, 1],
			[1, 1, 1],
			[0, 1, 0],
		];
		const b: Array<[number, number, number]> = [
			[1, 0, 0],
			[0, 0, 1],
			[0, 1, 1],
			[1, 1, 0],
		];
		const na: [number, number, number] = [Math.SQRT1_2, 0, -Math.SQRT1_2];
		const nb: [number, number, number] = [Math.SQRT1_2, 0, Math.SQRT1_2];
		addQuad(a, na);
		addQuad([...a].reverse(), [-na[0], -na[1], -na[2]]);
		addQuad(b, nb);
		addQuad([...b].reverse(), [-nb[0], -nb[1], -nb[2]]);
	} else {
		for (const box of getTransformedShapeBoxes(blockId, blockState)) {
			for (const face of SHAPE_FACES) {
				if ((box.faceMask & face.bit) !== 0) {
					addQuad(face.verts(box.min, box.max), face.normal);
				}
			}
		}
	}

	const geometry = {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		uvs: new Float32Array(uvs),
		indices: new Uint32Array(indices),
	};
	shapeGeometryCache.set(cacheKey, geometry);
	return geometry;
}

// Exported for PrimedTnt: same cached unit cube (full 0-1 face UVs) so the
// primed entity renders the TNT atlas tile with zero extra geometry cost.
export function getUnitCubeGeometry() {
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

// Single +Z-facing quad (same winding/UV layout as the cube's front face, so
// the shared shader + texture-v convention apply unchanged). Billboarding is
// yaw-only: _faceCamera rotates the mesh toward the camera every frame.
let billboardQuadGeometryCache: {
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	indices: Uint32Array;
} | null = null;

export function getBillboardQuadGeometry() {
	if (billboardQuadGeometryCache) return billboardQuadGeometryCache;

	billboardQuadGeometryCache = {
		positions: new Float32Array([
			-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
		]),
		normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
		uvs: new Float32Array([1, 0, 0, 0, 0, 1, 1, 1]),
		indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
	};
	return billboardQuadGeometryCache;
}

const ITEM_NAME: string = "droppedItem";
const ITEM_NAME_AABB: string = "droppedItemAABB";

// Pre-compute constants
const REACH_DISTANCE_SQ = REACH_AURA;
const LIGHT_NORMALIZE_MUL = 1.0 / 15.0;

// OPTIMIZATION: Share a single block sampler to prevent function closures per item
const SHARED_BLOCK_SAMPLER = createVoxelColliderBlockSampler(
	(x, y, z) => {
		// Mirrors PlayerVehicleMotor: when the chunk under a probe is still
		// streaming in (missing / not loaded / no voxel data) we hold the
		// item up on a solid cobble sentinel instead of letting it fall
		// through into the void. Without this, dropped items fall
		// indefinitely at the render-distance edge and at every newly
		// discovered chunk seam.
		const r = resolveBlockAtWorldCoords(x, y, z);
		if (r.unloaded) return UNLOADED_SOLID_RESOLVE;
		if (!isCollidableBlock(r.blockId)) return null;
		_voxelResolveScratch.blockId = r.blockId;
		_voxelResolveScratch.blockState = r.blockState;
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
	private _boxMesh: Mesh;
	private _material: ShaderMaterial;
	/** Bumped whenever the material leaves this item (dispose→pool) so the
	 *  async atlas-bind callback can detect a stale acquisition. */
	private _materialEpoch = 0;
	private _item: Item;
	// Non-block items render as a camera-facing icon sprite instead of a cube.
	private _isSprite = false;
	private _velocity = vec3Zero();
	private _position: Vec3;
	private _halfSize = 0.25;
	private _voxelCollider: VoxelAabbCollider;
	private _disposed = false;
	private _itemIndex = -1;

	// Only update lighting when item crosses a voxel boundary.
	private _lastLightX = Number.NaN;
	private _lastLightY = Number.NaN;
	private _lastLightZ = Number.NaN;

	// Reused tint tuple to avoid per-frame/per-light allocations.
	private _tint: [number, number, number] = [1, 1, 1];

	// Track last synced position.
	private _oldPositionX = Number.NaN;
	private _oldPositionY = Number.NaN;
	private _oldPositionZ = Number.NaN;

	// Grounded is inferred from Y collision.
	_grounded = false;

	// PERF: settled items do not need physics every frame.
	private _sleeping = false;

	// Sprite bob phase (radians) — randomized per item so stacked drops
	// don't pulse in sync. Visual-only; physics position is untouched.
	private _bobPhase = Math.random() * Math.PI * 2;
	// Seconds since spawn — the bob amplitude ramps in over the first
	// second so the mesh eases out of its rest position instead of
	// jumping mid-swing on the first frame.
	private _bobAge = 0;

	// Remote (server-authoritative) items: the server owns position +
	// lifetime. The client only renders + interpolates, so local physics is
	// disabled (kept "sleeping") and position is driven via setRemotePosition().
	private _remoteInstanceId: number | null = null;
	private _remotePickup: ((instanceId: number) => void) | null = null;

	// Optimistic pickup bookkeeping: what was granted locally while waiting
	// for the server's despawn/rejection. Cleared on success (despawn) or
	// rolled back on ItemPickupRejected.
	private _remotePendingPickup: {
		player: Player;
		itemId: number;
		granted: number;
	} | null = null;

	private static readonly _allItems: DroppedItem[] = [];
	private static _observerRegistered = false;

	private static _ensureObserver(): void {
		if (DroppedItem._observerRegistered) return;
		DroppedItem._observerRegistered = true;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			const dt = deltaMs * 0.001;
			if (dt <= 0) return;

			// PERF: skip item physics while any UI overlay owns the mouse.
			if (isUiOpen(UiFocus.pauseMenu)) return;

			const items = DroppedItem._allItems;
			for (let i = 0, len = items.length; i < len; i++) {
				const item = items[i];
				if (!item._sleeping) {
					item._updatePhysics(dt);
				}
				// Sprites keep facing the camera and bob gently even while
				// settled, like XP orbs (visual-only: physics stays asleep).
				if (item._isSprite) {
					item._faceCamera();
					item._applyBob(dt);
				}
			}
		});
	}

	static readonly GRAVITY = -18;
	static readonly STEP_SIZE = 0.2;
	static readonly EPSILON = 0.001;
	/** Sprite bob amplitude in blocks (visual-only, matches XpOrb). */
	static readonly SPRITE_BOB_AMPLITUDE = 0.05;
	/** Sprite bob angular speed in radians per second (matches XpOrb). */
	static readonly SPRITE_BOB_SPEED = 3.0;
	static readonly AIR_DAMPING_PER_SEC = 1.8;
	static readonly GROUND_DAMPING_PER_SEC = 8.0;
	static readonly MIN_SPEED = 0.03;
	static readonly SKY_LIGHT_COLOR = vec3(0.8, 0.8, 0.8);
	static readonly BLOCK_LIGHT_COLOR = vec3(0.9, 0.6, 0.2);

	static sizeFor(stackSize: number): number {
		return 0.25 + stackSize * 0.009;
	}

	private static _atlasPromise: Promise<Texture2D | null> | null = null;

	private static _getAtlasTexture(): Promise<Texture2D | null> {
		if (!DroppedItem._atlasPromise) {
			DroppedItem._atlasPromise = loadTexture2D(
				Map1.engine,
				"/texture/diffuse_atlas.png",
				{
					mipMaps: true,
					magFilter: "nearest",
					minFilter: "nearest",
				},
			).catch(() => null);
		}

		return DroppedItem._atlasPromise;
	}

	static preloadAtlas(): void {
		void DroppedItem._getAtlasTexture();
	}

	constructor(item: Item, x: number, y: number, z: number) {
		this._item = item;

		// Items without a block shape drop as a cheap billboard sprite of
		// their icon; block items use their registered voxel shape.
		this._isSprite = !isRegisteredBlockId(item.blockId) && item.icon !== "";

		const geometry = this._isSprite
			? getBillboardQuadGeometry()
			: getBlockItemGeometry(item.blockId ?? -1, item.blockState ?? 0);

		this._boxMesh = createMeshFromData(
			Map1.engine,
			ITEM_NAME,
			geometry.positions,
			geometry.normals,
			geometry.indices,
			geometry.uvs,
		);

		const meta = new MetadataContainer();
		meta.set("use", this.use);
		this._boxMesh.metadata = meta as unknown as LiteMetadata;

		this._boxMesh.pickable = true;

		this._position = vec3(x, y, z);
		this._boxMesh.position.set(x, y, z);

		this._material = this._isSprite
			? acquireSpriteMaterial(item.icon)
			: acquireDroppedItemMaterial(item.blockId ?? -1);
		this._boxMesh.material = this._material;
		this._boxMesh.visible = false;

		const size = DroppedItem.sizeFor(item.stackSize);
		this._boxMesh.scaling.set(size, size, size);
		this._halfSize = size * 0.5;

		this._voxelCollider = new VoxelAabbCollider(
			vec3(this._halfSize, this._halfSize, this._halfSize),
			SHARED_BLOCK_SAMPLER,
			DroppedItem.EPSILON,
			{
				scene: Map1.mainScene,
				name: ITEM_NAME_AABB,
				position: this._position,
				renderOrder: 1,
			},
		);

		if (this._isSprite) {
			// Full-texture quad: uScale/uOffset are the identity transform.
			setShaderUniform(this._material, "uScale", 1);
			setShaderUniform(this._material, "uOffset", [0, 0]);
			this._bindIconTexture(item.icon);
		} else {
			const sharedAtlas = getDiffuseTexture2D();
			if (sharedAtlas) {
				setShaderTexture(this._material, "diffuseTexture", sharedAtlas);
				this._applyAtlasTile(item);
				this._boxMesh.visible = true;
				this._ensureAddedToScene();
			} else {
				// Capture the material identity: if this item is disposed before
				// the atlas resolves, its material returns to the pool and may be
				// reacquired by another item — a late bind must not retarget it.
				const mat = this._material;
				const epoch = this._materialEpoch;
				void DroppedItem._getAtlasTexture().then((atlas) => {
					if (
						this._disposed ||
						!atlas ||
						this._material !== mat ||
						this._materialEpoch !== epoch
					)
						return;

					setShaderTexture(this._material, "diffuseTexture", atlas);
					this._applyAtlasTile(item);
					this._ensureAddedToScene();
					this._boxMesh.visible = true;
				});
			}
		}

		DroppedItem._ensureObserver();

		this._itemIndex = DroppedItem._allItems.length;
		DroppedItem._allItems.push(this);

		this._syncTransformAndLightingIfMoved();
	}

	/**
	 * Bind this sprite's icon PNG to its material (async, epoch-guarded so a
	 * disposed/recycled item never receives a late bind).
	 *
	 * If the icon is missing (e.g. art not created yet), fall back to the
	 * placeholder texture so the drop is still visible and pickable instead
	 * of silently never entering the scene.
	 */
	private _bindIconTexture(iconUrl: string): void {
		const mat = this._material;
		const epoch = this._materialEpoch;
		void getIconTexture(iconUrl)
			.then((tex) => {
				if (tex) return tex;
				if (iconUrl === PLACEHOLDER_ICON_URL) return null;
				return getIconTexture(PLACEHOLDER_ICON_URL);
			})
			.then((tex) => {
				if (
					this._disposed ||
					!tex ||
					this._material !== mat ||
					this._materialEpoch !== epoch
				)
					return;

				setShaderTexture(this._material, "diffuseTexture", tex);
				this._ensureAddedToScene();
				// Restart the bob ramp on first show: the icon may have
				// loaded long after spawn, so the swing could otherwise
				// reveal the sprite mid-bob instead of at rest.
				this._bobAge = 0;
				this._boxMesh.visible = true;
			});
	}

	/**
	 * Add the mesh to the scene only AFTER its material's sampler has a bound
	 * texture. Lite builds the shader bind group whenever a mesh (re)enters a
	 * material group, and an unbound sampler throws (_241) — so the previous
	 * add-early/bind-later order crashed on every first-of-a-kind drop.
	 */
	private _sceneAdded = false;
	private _ensureAddedToScene(): void {
		if (this._sceneAdded) return;
		this._sceneAdded = true;
		addToScene(Map1.mainScene, this._boxMesh);
	}

	/** Yaw-only billboarding: keep the sprite quad facing the camera. */
	private _faceCamera(): void {
		const cam = Map1.mainScene.camera;
		if (!cam) return;

		// The lite Camera type exposes no position — read the translation
		// column of its world matrix instead.
		const m = cam.worldMatrix;
		this._boxMesh.rotation.y = Math.atan2(
			m[12] - this._position.x,
			m[14] - this._position.z,
		);
	}

	/**
	 * Gentle vertical bob for 2D sprite drops (tools, food, eggs, ...),
	 * matching the XP orb motion. Writes the mesh transform only — the
	 * physics position, pickup checks, and lighting stay on the true
	 * resting spot, and the ±0.05 amplitude never leaves the voxel the
	 * light was sampled from.
	 */
	private _applyBob(dt: number): void {
		this._bobPhase += dt * DroppedItem.SPRITE_BOB_SPEED;
		this._bobAge += dt;
		const ampScale = Math.min(1, this._bobAge);
		this._boxMesh.position.set(
			this._position.x,
			this._position.y +
				Math.sin(this._bobPhase) * DroppedItem.SPRITE_BOB_AMPLITUDE * ampScale,
			this._position.z,
		);
	}

	addVelocity(x: number, y: number, z: number): void {
		this._velocity.x += x;
		this._velocity.y += y;
		this._velocity.z += z;

		if (x !== 0 || y !== 0 || z !== 0) {
			this._sleeping = false;
		}
	}

	use = (player: Player): void => {
		// Remote (server-authoritative) items: optimistically add the stack to
		// the inventory and keep the mesh until the server confirms. The
		// server broadcasts ItemDespawn on success (RemoteItemManager then
		// disposes us) or ItemPickupRejected on failure (rollbackRemotePickup
		// removes the phantom stack again).
		if (this._remoteInstanceId !== null && this._remotePickup) {
			// A pickup is already in flight for this item — ignore repeats
			// so a double-click cannot grant two phantom stacks.
			if (this._remotePendingPickup) return;

			this._remotePickup(this._remoteInstanceId);

			// addItem() drains item.stackSize into existing stacks, so the
			// granted amount is captured BEFORE the call.
			const requestedCount = this._item.stackSize;
			const remainder = player.playerInventory.addItem(this._item);
			this._remotePendingPickup = {
				player,
				itemId: this._item.itemId,
				granted: Math.max(0, requestedCount - remainder),
			};
			return;
		}

		const remainder = player.playerInventory.addItem(this._item);
		if (remainder <= 0) {
			this._dispose();
		} else {
			this._resize();
		}
	};

	private _resize(): void {
		const size = DroppedItem.sizeFor(this._item.stackSize);
		this._boxMesh.scaling.set(size, size, size);
		this._halfSize = size * 0.5;
		this._voxelCollider.HalfExtents = vec3(
			this._halfSize,
			this._halfSize,
			this._halfSize,
		);
	}

	private _dispose(): void {
		if (this._disposed) return;
		this._disposed = true;

		// If we vanish while a pickup is in flight (ItemDespawn arrived =
		// success, or scene teardown), cancel rollback bookkeeping so a late
		// rejection can never remove stacks the server actually confirmed.
		this._remotePendingPickup = null;

		const items = DroppedItem._allItems;
		const last = items.pop();

		if (last !== undefined && last !== this) {
			items[this._itemIndex] = last;
			last._itemIndex = this._itemIndex;
		}

		this._voxelCollider.dispose();
		if (this._sceneAdded) {
			removeFromScene(Map1.mainScene, this._boxMesh);
		}

		// PERF/LEAKFIX: return the material to its pool instead of leaking
		// one ShaderMaterial (pipeline + bind groups) per despawn. The epoch
		// bump invalidates any in-flight texture bind for this item.
		this._materialEpoch++;
		if (this._isSprite) {
			releaseSpriteMaterial(this._item.icon, this._material);
		} else {
			releaseDroppedItemMaterial(this._item.blockId ?? -1, this._material);
		}
	}

	private _updatePhysics(dt: number): void {
		this._velocity.y += DroppedItem.GRAVITY * dt;

		this._moveAxis(ColliderAxis.X, this._velocity.x * dt);

		this._grounded = false;
		const preY = this._position.y;
		this._moveAxis(ColliderAxis.Y, this._velocity.y * dt);

		if (this._position.y === preY && this._velocity.y < 0) {
			this._grounded = true;
		}

		this._moveAxis(ColliderAxis.Z, this._velocity.z * dt);

		const damping = this._grounded
			? DroppedItem.GROUND_DAMPING_PER_SEC
			: DroppedItem.AIR_DAMPING_PER_SEC;

		const keep = Math.exp(-damping * dt);

		this._velocity.x *= keep;
		this._velocity.y *= keep;
		this._velocity.z *= keep;

		if (this._grounded && this._velocity.y < 0) {
			this._velocity.y = 0;
		}

		if (
			this._velocity.x > -DroppedItem.MIN_SPEED &&
			this._velocity.x < DroppedItem.MIN_SPEED
		) {
			this._velocity.x = 0;
		}

		if (
			this._velocity.y > -DroppedItem.MIN_SPEED &&
			this._velocity.y < DroppedItem.MIN_SPEED
		) {
			this._velocity.y = 0;
		}

		if (
			this._velocity.z > -DroppedItem.MIN_SPEED &&
			this._velocity.z < DroppedItem.MIN_SPEED
		) {
			this._velocity.z = 0;
		}

		this._syncTransformAndLightingIfMoved();

		// PERF: once settled on the ground, stop spending collision/light work every frame.
		if (
			this._grounded &&
			this._velocity.x === 0 &&
			this._velocity.y === 0 &&
			this._velocity.z === 0
		) {
			this._sleeping = true;
		}
	}

	private _moveAxis(axis: ColliderAxis, delta: number): void {
		if (delta === 0) return;

		this._voxelCollider.moveAxis(
			this._position,
			this._velocity,
			axis,
			delta,
			DroppedItem.STEP_SIZE,
		);
	}

	private _syncTransformAndLightingIfMoved(): void {
		const px = this._position.x;
		const py = this._position.y;
		const pz = this._position.z;

		if (
			px === this._oldPositionX &&
			py === this._oldPositionY &&
			pz === this._oldPositionZ
		) {
			return;
		}

		this._oldPositionX = px;
		this._oldPositionY = py;
		this._oldPositionZ = pz;

		this._boxMesh.position.set(px, py, pz);
		this._voxelCollider.syncDebugMesh(this._position);
		this._updateLightingIfNeeded();
	}

	private _updateLightingIfNeeded(): void {
		const lx = this._position.x | 0;
		const ly = this._position.y | 0;
		const lz = this._position.z | 0;

		if (
			lx === this._lastLightX &&
			ly === this._lastLightY &&
			lz === this._lastLightZ
		) {
			return;
		}

		this._lastLightX = lx;
		this._lastLightY = ly;
		this._lastLightZ = lz;

		this._applyTintFromPackedLight(
			getLightByWorldCoords(
				this._position.x,
				this._position.y,
				this._position.z,
			),
		);
	}

	/**
	 * One-shot tint from a pre-sampled packed light value.
	 * Does not touch the per-voxel cache.
	 */
	public setInitialLight(packedLight: number): void {
		this._applyTintFromPackedLight(packedLight);
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
		this._remoteInstanceId = instanceId;
		this._remotePickup = onPickup;
		this._sleeping = true;
	}

	get isRemote(): boolean {
		return this._remoteInstanceId !== null;
	}

	/**
	 * The server rejected our optimistic pickup (ItemPickupRejected). Undo
	 * the local inventory grant so no phantom stack lingers. The mesh stays
	 * visible and pickable — for TooFar rejections the player can simply walk
	 * closer and try again.
	 */
	public rollbackRemotePickup(instanceId: number): void {
		if (this._remoteInstanceId !== instanceId) return;

		const pending = this._remotePendingPickup;
		if (!pending) return;
		this._remotePendingPickup = null;

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
		this._position.x = x;
		this._position.y = y;
		this._position.z = z;
		this._syncTransformAndLightingIfMoved();
	}

	/** Public dispose (idempotent) for the RemoteItemManager. */
	public dispose(): void {
		this._dispose();
	}

	private _applyTintFromPackedLight(packedLight: number): void {
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

		this._tint[0] = Math.min(1.0, Math.max(0.3, skyR + blockR));
		this._tint[1] = Math.min(1.0, Math.max(0.3, skyG + blockG));
		this._tint[2] = Math.min(1.0, Math.max(0.3, skyB + blockB));

		setShaderVector3(this._material, "tintColor", this._tint);
	}

	private _applyAtlasTile(item: Item): void {
		const tile = getAtlasTile(item.blockId) ?? [0, 0];
		const tileSize = atlasTileSize;
		const clampedX = Math.max(0, Math.min(atlasSize - 1, tile[0]));
		const clampedY = Math.max(0, Math.min(atlasSize - 1, tile[1]));
		const atlasRow = atlasSize - 1 - clampedY;

		setShaderUniform(this._material, "uScale", tileSize);
		setShaderUniform(this._material, "uOffset", [
			clampedX * tileSize,
			atlasRow * tileSize,
		]);
	}

	get boxMesh(): Mesh {
		return this._boxMesh;
	}

	get position(): Vec3 {
		return this._position;
	}

	get item(): Item {
		return this._item;
	}

	static disposeAll(): void {
		while (DroppedItem._allItems.length > 0) {
			DroppedItem._allItems[0]._dispose();
		}
		disposeAllPooledItemMaterials();
	}

	static nearestTo(player: Player): DroppedItem | null {
		const p = player.position;
		let best: DroppedItem | null = null;
		let bestSq = REACH_DISTANCE_SQ;

		const items = DroppedItem._allItems;

		for (let i = 0, len = items.length; i < len; i++) {
			const item = items[i];
			const m = item._position;

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
		return DroppedItem._allItems;
	}

	get halfExtent(): number {
		return this._halfSize;
	}
}
