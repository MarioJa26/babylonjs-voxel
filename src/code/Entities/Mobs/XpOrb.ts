import {
	addToScene,
	createMeshFromData,
	type LiteMetadata,
	loadTexture2D,
	type Mesh,
	onBeforeRender,
	removeFromScene,
	type ShaderMaterial,
	setShaderTexture,
	setShaderUniform,
	type Texture2D,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import { MetadataContainer } from "@/code/Entities/MetadataContainer";
import { isUiOpen, UiFocus } from "@/code/Lib/GameRuntimeState";
import { vec3Zero } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import {
	acquireSpriteMaterial,
	getBillboardQuadGeometry,
	releaseSpriteMaterial,
} from "@/code/Player/Inventory/DroppedItem";
import { resolveBlockAtWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	_voxelResolveScratch,
	Axis as ColliderAxis,
	createVoxelColliderBlockSampler,
	UNLOADED_SOLID_RESOLVE,
	VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import { getShapeForBlockId } from "@/code/World/Shape/BlockShapes";
import {
	computeFenceNeighborMask,
	getFenceDynamicShape,
	isFenceBlockId,
} from "@/code/World/Shape/FenceConnect";
import { isCollidableBlock } from "@/code/World/Texture/BlockType";

/**
 * XP orb, a souls-like violet/teal wisp dropped by hostile mobs.
 *
 * Deliberately local-only, like a particle with physics. Each client spawns
 * and collects its own orbs, so no network protocol is required.
 */
export const XP_ORB_ICON_URL = "/texture/items/xp_orb.png";

const GRAVITY = -18;
const STEP_SIZE = 0.2;
const EPSILON = 0.001;

const MAGNET_RADIUS_SQ = 4.5 * 4.5;
const PICKUP_RADIUS_SQ = 1.3 * 1.3;
const MIN_MAGNET_DISTANCE_SQ = 0.0001;

const MAGNET_ACCEL = 22;
const MAX_ORBS = 150;
const ORB_LIFETIME_SEC = 300;

const AIR_DAMPING = 1.8;
const GROUND_DAMPING = 8;
const BOB_SPEED = 3;
const BOB_HEIGHT = 0.05;

const ORB_SAMPLER = createVoxelColliderBlockSampler(
	(x, y, z) => {
		const result = resolveBlockAtWorldCoords(x, y, z);

		if (result.unloaded) {
			return UNLOADED_SOLID_RESOLVE;
		}

		if (!isCollidableBlock(result.blockId)) {
			return null;
		}

		_voxelResolveScratch.blockId = result.blockId;
		_voxelResolveScratch.blockState = result.blockState;

		return _voxelResolveScratch;
	},
	{
		getFenceDynamicShape,
		getShapeForBlockId,
		isFenceBlockId,
		computeFenceNeighborMask,
	},
);

let orbTexturePromise: Promise<Texture2D | null> | null = null;

function getOrbTexture(): Promise<Texture2D | null> {
	if (orbTexturePromise === null) {
		orbTexturePromise = loadTexture2D(Map1.engine, XP_ORB_ICON_URL, {
			mipMaps: true,
			magFilter: "nearest",
			minFilter: "nearest",
		}).catch(() => null);
	}

	return orbTexturePromise;
}

export class XpOrb {
	// Definite assignment permits the capacity check to happen before any
	// GPU, material, collider, or promise allocation.
	#mesh!: Mesh;
	#material!: ShaderMaterial;
	#collider!: VoxelAabbCollider;

	#position: Vec3;
	#velocity = vec3Zero();

	#materialEpoch = 0;
	#disposed = false;
	#value: number;
	#age = 0;
	#bobPhase = Math.random() * Math.PI * 2;
	#sceneAdded = false;
	#grounded = false;
	#initialized = false;

	static #allOrbs: XpOrb[] = [];
	static #observerRegistered = false;

	static #ensureObserver(): void {
		if (XpOrb.#observerRegistered) {
			return;
		}

		XpOrb.#observerRegistered = true;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			const dt = deltaMs * 0.001;

			if (dt <= 0 || isUiOpen(UiFocus.pauseMenu)) {
				return;
			}

			const scene = Map1.mainScene;
			const cameraMatrix = scene.camera?.worldMatrix;

			let cameraX = 0;
			let cameraZ = 0;
			let hasCamera = false;

			if (cameraMatrix !== undefined) {
				cameraX = cameraMatrix[12];
				cameraZ = cameraMatrix[14];
				hasCamera = true;
			}

			const orbs = XpOrb.#allOrbs;

			// Iterate backward because #tick can call #dispose, which removes
			// the current orb with splice(). Forward iteration would then skip
			// the orb shifted into the removed index.
			for (let i = orbs.length - 1; i >= 0; i--) {
				orbs[i].#tick(dt, hasCamera, cameraX, cameraZ);
			}
		});
	}

	constructor(x: number, y: number, z: number, value: number) {
		this.#value = Math.max(1, Math.floor(value));
		this.#position = vec3(x, y, z);

		// Enforce the cap before allocating GPU resources, a collider, a
		// material reference, metadata, or a texture-promise callback.
		if (XpOrb.#allOrbs.length >= MAX_ORBS) {
			const oldest = XpOrb.#allOrbs[0];

			if (oldest !== undefined && !oldest.#disposed) {
				oldest.#value += this.#value;
			}

			this.#disposed = true;
			return;
		}

		const geometry = getBillboardQuadGeometry();

		this.#mesh = createMeshFromData(
			Map1.engine,
			"xpOrb",
			geometry.positions,
			geometry.normals,
			geometry.indices,
			geometry.uvs,
		);

		const metadata = new MetadataContainer();

		this.#mesh.metadata = metadata as unknown as LiteMetadata;
		this.#mesh.pickable = false;
		this.#mesh.position.set(x, y, z);
		this.#mesh.scaling.set(0.35, 0.35, 0.35);
		this.#mesh.visible = false;

		this.#material = acquireSpriteMaterial(XP_ORB_ICON_URL);
		this.#mesh.material = this.#material;

		this.#collider = new VoxelAabbCollider(
			vec3(0.15, 0.15, 0.15),
			ORB_SAMPLER,
			EPSILON,
		);

		this.#initialized = true;

		setShaderUniform(this.#material, "uScale", 1);
		setShaderUniform(this.#material, "uOffset", [0, 0]);
		setShaderUniform(this.#material, "tintColor", [0.82, 0.78, 1]);

		const material = this.#material;
		const materialEpoch = this.#materialEpoch;

		void getOrbTexture().then((texture) => {
			if (
				this.#disposed ||
				texture === null ||
				this.#material !== material ||
				this.#materialEpoch !== materialEpoch
			) {
				return;
			}

			setShaderTexture(material, "diffuseTexture", texture);

			if (!this.#sceneAdded) {
				this.#sceneAdded = true;
				addToScene(Map1.mainScene, this.#mesh);
			}

			this.#mesh.visible = true;
		});

		// Random initial impulse so stacked orbs scatter like item drops.
		this.#velocity.x = (Math.random() - 0.5) * 3;
		this.#velocity.y = 3 + Math.random() * 2;
		this.#velocity.z = (Math.random() - 0.5) * 3;

		XpOrb.#allOrbs.push(this);
		XpOrb.#ensureObserver();
	}

	#tick(
		dt: number,
		hasCamera: boolean,
		cameraX: number,
		cameraZ: number,
	): void {
		if (this.#disposed) {
			return;
		}

		const age = this.#age + dt;
		this.#age = age;

		if (age >= ORB_LIFETIME_SEC) {
			this.#dispose();
			return;
		}

		const position = this.#position;
		const velocity = this.#velocity;
		const player = Map1.mainPlayer;

		if (player !== undefined && player !== null) {
			const playerPosition = player.position;

			const dx = playerPosition.x - position.x;
			const dy = playerPosition.y + 0.5 - position.y;
			const dz = playerPosition.z - position.z;

			const distSq = dx * dx + dy * dy + dz * dz;

			if (distSq <= PICKUP_RADIUS_SQ) {
				player.stats.addXp(this.#value);
				this.#dispose();
				return;
			}

			if (distSq <= MAGNET_RADIUS_SQ && distSq > MIN_MAGNET_DISTANCE_SQ) {
				// One reciprocal square root replaces three divisions by the
				// same distance.
				const pullScale = (MAGNET_ACCEL * dt) / Math.sqrt(distSq);

				velocity.x += dx * pullScale;
				velocity.y += dy * pullScale;
				velocity.z += dz * pullScale;
			}
		}

		velocity.y += GRAVITY * dt;

		this.#moveAxis(ColliderAxis.X, velocity.x * dt);

		const previousY = position.y;

		this.#moveAxis(ColliderAxis.Y, velocity.y * dt);

		const grounded = position.y === previousY && velocity.y < 0;

		this.#grounded = grounded;

		this.#moveAxis(ColliderAxis.Z, velocity.z * dt);

		const damping = grounded ? GROUND_DAMPING : AIR_DAMPING;

		const velocityRetention = Math.exp(-damping * dt);

		velocity.x *= velocityRetention;
		velocity.y *= velocityRetention;
		velocity.z *= velocityRetention;

		if (grounded && velocity.y < 0) {
			velocity.y = 0;
		}

		const bobPhase = this.#bobPhase + dt * BOB_SPEED;

		this.#bobPhase = bobPhase;

		this.#mesh.position.set(
			position.x,
			position.y + Math.sin(bobPhase) * BOB_HEIGHT,
			position.z,
		);

		if (hasCamera) {
			this.#mesh.rotation.y = Math.atan2(
				cameraX - position.x,
				cameraZ - position.z,
			);
		}
	}

	#moveAxis(axis: ColliderAxis, delta: number): void {
		if (delta === 0) {
			return;
		}

		this.#collider.moveAxis(
			this.#position,
			this.#velocity,
			axis,
			delta,
			STEP_SIZE,
		);
	}

	#dispose(): void {
		if (this.#disposed) {
			return;
		}

		this.#disposed = true;

		const orbs = XpOrb.#allOrbs;
		const index = orbs.indexOf(this);

		if (index >= 0) {
			orbs.splice(index, 1);
		}

		// Capacity-rejected instances never initialize native resources.
		if (!this.#initialized) {
			return;
		}

		this.#collider.dispose();

		if (this.#sceneAdded) {
			this.#sceneAdded = false;
			removeFromScene(Map1.mainScene, this.#mesh);
		}

		// Invalidate any pending texture continuation before releasing the
		// pooled material.
		this.#materialEpoch++;
		releaseSpriteMaterial(XP_ORB_ICON_URL, this.#material);
	}

	static disposeAll(): void {
		const orbs = XpOrb.#allOrbs;

		// Remove from the end so every splice is O(1). The previous copied
		// array allocated memory and each disposal searched the live array.
		while (orbs.length > 0) {
			orbs[orbs.length - 1].#dispose();
		}
	}
}

/** Spawn 1 to 3 orbs splitting `min..max` total XP at a death position. */
export function spawnXpOrbs(
	x: number,
	y: number,
	z: number,
	min: number,
	max: number,
): void {
	const lo = Math.floor(min);
	const hi = Math.floor(max);

	const total = hi <= lo ? lo : lo + Math.floor(Math.random() * (hi - lo + 1));

	const orbCount = 1 + Math.floor(Math.random() * 3);

	const baseValue = Math.floor(total / orbCount);

	for (let i = 0; i < orbCount; i++) {
		const value = i === orbCount - 1 ? total - baseValue * i : baseValue;

		if (value <= 0) {
			continue;
		}

		try {
			new XpOrb(
				x + (Math.random() - 0.5) * 0.6,
				y + 0.5,
				z + (Math.random() - 0.5) * 0.6,
				value,
			);
		} catch (error) {
			// Orb failures must not interrupt the caller's remaining death
			// handling.
			console.warn("XpOrb: failed to spawn orb:", error);
		}
	}
}
