import {
	addToScene,
	createBox,
	createStandardMaterial,
	type Mesh,
	removeFromScene,
	type SceneContext,
	scaleVec3InPlace,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import { Quaternion, setVec3, vec3Zero } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import {
	BoatChunk,
	type BoatChunkBlock,
	type BoatChunkBounds,
} from "@/code/World/Boat/BoatChunk";
import { Chunk } from "@/code/World/Chunk/Chunk";
import { Axis } from "@/code/World/Collision/VoxelAabbCollider";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import type { IUsable } from "../Interface/IUsable";
import { CustomBoatControls } from "../Player/Controls/CustomBoatControls";
import type { Player } from "../Player/Player";
import {
	type DynamicBlockQueryOptions,
	type DynamicBlockSample,
	getBlockByWorldCoords,
	registerChunkBoundEntity,
	registerChunkEntityLoader,
	registerDynamicBlockProvider,
	unregisterChunkBoundEntity,
	unregisterDynamicBlockProvider,
} from "../World/Chunk/ChunkEntityAPI";
import { VoxelObbCollider } from "../World/Collision/VoxelObbCollider";
import { BlockType, isCollidableBlock } from "../World/Texture/BlockType";
import { MetadataContainer } from "./MetadataContainer";
import { Mount } from "./Mount";

export type CustomBoatOptions = {
	collisionHalfExtents?: Vec3;
	customVisualRoot?: Mesh;
	skipDefaultModel?: boolean;
	initialYaw?: number;
	customVisualLocalYaw?: number;
	blockCount?: number;
	boatChunk?: BoatChunk;

	/**
	 * BoatChunk-local coordinates of the wheel/BoatCreator block.
	 */
	helmLocal?: Vec3;
};

type SerializedBoatChunk = {
	blocks: BoatChunkBlock[];
	center: {
		x: number;
		y: number;
		z: number;
	};
};

type CustomBoatSerializedPayload = {
	position: {
		x: number;
		y: number;
		z: number;
	};
	collisionHalfExtents: {
		x: number;
		y: number;
		z: number;
	};
	initialYaw: number;
	customVisualLocalYaw: number;
	blockCount?: number;
	boatChunk?: SerializedBoatChunk;
	helmLocal?: {
		x: number;
		y: number;
		z: number;
	};
};

export class CustomBoat implements IUsable {
	public static readonly CHUNK_ENTITY_TYPE = "custom_boat_v1";

	static #chunkReloadContext: {
		scene: SceneContext;
		player: Player;
		waterLevel: number;
	} | null = null;

	static #chunkLoaderRegistered = false;

	static #activeBoats = new Set<CustomBoat>();
	static #boatsSnapshot: CustomBoat[] = [];
	static #boatsSnapshotDirty = true;

	static #boatsByChunk = new Map<BoatChunk, CustomBoat>();

	static readonly #boatCullDistSq =
		(SETTING_PARAMS.RENDER_DISTANCE * Chunk.SIZE * 2) ** 2;

	/**
	 * Packed xyz neighbor offsets. This avoids allocating an array and six
	 * tuples every time a boat block is changed.
	 */
	static readonly #neighborOffsets = new Int8Array([
		1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1,
	]);

	/**
	 * Shared synchronous provider result.
	 *
	 * Dynamic block consumers must read this object immediately and must not
	 * retain the reference.
	 */
	static readonly #sampleScratch: DynamicBlockSample = {
		blockId: 0,
		blockState: 0,
		lightLevel: 0,
	};

	#cachedTotalYaw = Number.NaN;
	#cachedTotalCos = 1;
	#cachedTotalSin = 0;

	readonly #cfg = {
		mass: 11,
		gravity: -9.81,
		baseBuoyancyForce: 20,
		torqueScale: 0.12,
		collisionStepSize: 0.25,
		collisionEpsilon: 0.01,
		damping: {
			waterLinear: 0.985,
			waterAngular: 0.92,
			airLinear: 0.995,
			airAngular: 0.98,
		},
		dtClamp: {
			min: 1 / 600,
			max: 1 / 24,
		},
	} as const;

	#collisionHalfExtents = vec3(1.15, 0.6, 1.15);
	#collisionCenterOffset = vec3Zero();

	#boat!: Mesh;
	#voxelCollider!: VoxelObbCollider;

	#mount!: Mount;
	#boatControls!: CustomBoatControls;

	#customVisualRoot?: Mesh;
	#customVisualLocalYaw = 0;
	#skipDefaultModel = false;

	#boatChunk?: BoatChunk;
	#boatChunkCollisionProviderHandle?: symbol;
	#boatChunkBlockChangeUnsubscribe?: () => void;

	#ignoredDynamicBlockProviders = new Set<symbol>();

	/**
	 * BoatChunk-local coordinates of the helm block.
	 */
	#helmLocal: Vec3 | null = null;

	/**
	 * BoatChunk-local Y coordinate of the top of the occupied deck.
	 */
	#deckTopLocalY = Number.NEGATIVE_INFINITY;

	/**
	 * Mount owns these object references, so they are updated in place.
	 */
	#helmMountOffset = vec3Zero();
	#helmMountRot = Quaternion.Identity();

	/**
	 * Reused by every world voxel query made by this boat.
	 */
	#worldQueryOptions: DynamicBlockQueryOptions = {
		ignoredDynamicBlockProviders: this.#ignoredDynamicBlockProviders,
	};

	#currentYaw = 0;

	#linearVelocity = vec3Zero();
	#angularVelocity = vec3Zero();
	#angularResponseScale = 1;

	#buoyancyPoints: Vec3[] = [];
	#submergedPoints = 0;

	#chunkBindingHandle?: symbol;
	#isDisposed = false;

	#tmpTorque = vec3Zero();
	#tmpLever = vec3Zero();
	#scratchRootLocal = vec3Zero();
	#scratchQuat = Quaternion.Identity();

	#scratchBounds: BoatChunkBounds = {
		minX: 0,
		minY: 0,
		minZ: 0,
		maxX: 0,
		maxY: 0,
		maxZ: 0,
	};

	public static getBoatForChunk(chunk: BoatChunk): CustomBoat | null {
		return CustomBoat.#boatsByChunk.get(chunk) ?? null;
	}

	public static getActiveBoats(): readonly CustomBoat[] {
		if (CustomBoat.#boatsSnapshotDirty) {
			const snapshot = CustomBoat.#boatsSnapshot;
			snapshot.length = 0;

			for (const boat of CustomBoat.#activeBoats) {
				snapshot.push(boat);
			}

			CustomBoat.#boatsSnapshotDirty = false;
		}

		return CustomBoat.#boatsSnapshot;
	}

	public static tickAllActiveBoats(
		scene: SceneContext,
		deltaMs: number,
		playerPos?: Vec3,
	): void {
		const useCulling = playerPos !== undefined;
		const cullDistSq = CustomBoat.#boatCullDistSq;

		for (const boat of CustomBoat.#activeBoats) {
			if (useCulling) {
				const dx = boat.#boat.position.x - playerPos.x;
				const dz = boat.#boat.position.z - playerPos.z;

				if (dx * dx + dz * dz > cullDistSq) {
					continue;
				}
			}

			boat.#tick(scene, deltaMs);
		}
	}

	public static configureChunkReloadContext(
		player: Player,
		waterLevel: number,
	): void {
		const scene = Map1.mainScene;

		CustomBoat.#chunkReloadContext = {
			scene,
			player,
			waterLevel,
		};

		if (CustomBoat.#chunkLoaderRegistered) {
			return;
		}

		CustomBoat.#chunkLoaderRegistered = true;

		registerChunkEntityLoader(CustomBoat.CHUNK_ENTITY_TYPE, (payload) => {
			const context = CustomBoat.#chunkReloadContext;

			if (!context) {
				return;
			}

			const data = payload as CustomBoatSerializedPayload | undefined;

			if (!data?.position || !data.collisionHalfExtents) {
				return;
			}

			const spawnPosition = vec3(
				data.position.x,
				data.position.y,
				data.position.z,
			);

			const collisionHalfExtents = vec3(
				data.collisionHalfExtents.x,
				data.collisionHalfExtents.y,
				data.collisionHalfExtents.z,
			);

			let restoredBoatChunk: BoatChunk | undefined;
			let restoredCustomVisualRoot: Mesh | undefined;

			if (data.boatChunk) {
				const snapshotBlocks = data.boatChunk.blocks.slice();

				restoredBoatChunk = new BoatChunk(
					snapshotBlocks,
					vec3(
						data.boatChunk.center.x,
						data.boatChunk.center.y,
						data.boatChunk.center.z,
					),
				);

				restoredCustomVisualRoot = restoredBoatChunk.visualRoot;
			}

			new CustomBoat(context.player, context.waterLevel, spawnPosition, {
				collisionHalfExtents,
				customVisualRoot: restoredCustomVisualRoot,
				skipDefaultModel: restoredBoatChunk !== undefined,
				initialYaw: data.initialYaw,
				customVisualLocalYaw: data.customVisualLocalYaw,
				blockCount: data.blockCount,
				boatChunk: restoredBoatChunk,
				helmLocal: data.helmLocal
					? vec3(data.helmLocal.x, data.helmLocal.y, data.helmLocal.z)
					: undefined,
			});
		});
	}

	public constructor(
		player: Player,
		waterLevel: number,
		position?: Vec3,
		options?: CustomBoatOptions,
	) {
		const scene = Map1.mainScene;

		CustomBoat.configureChunkReloadContext(player, waterLevel);

		if (options?.collisionHalfExtents) {
			this.#collisionHalfExtents = vec3(
				options.collisionHalfExtents.x,
				options.collisionHalfExtents.y,
				options.collisionHalfExtents.z,
			);
		}

		this.#customVisualRoot = options?.customVisualRoot;
		this.#boatChunk = options?.boatChunk;
		this.#skipDefaultModel = options?.skipDefaultModel === true;

		if (typeof options?.initialYaw === "number") {
			this.#currentYaw = options.initialYaw;
		}

		if (typeof options?.customVisualLocalYaw === "number") {
			this.#customVisualLocalYaw = options.customVisualLocalYaw;
		}

		if (typeof options?.blockCount === "number" && options.blockCount > 1) {
			this.#angularResponseScale = Math.max(
				0.08,
				1 / Math.sqrt(options.blockCount),
			);
		}

		if (options?.helmLocal) {
			this.#helmLocal = vec3(
				options.helmLocal.x,
				options.helmLocal.y,
				options.helmLocal.z,
			);
		}

		this.#boat = this.#createHull(scene, position, waterLevel);

		this.#registerBoatChunkCollisionProvider();

		this.#voxelCollider = new VoxelObbCollider(
			this.#collisionHalfExtents,
			(x, y, z) => {
				const blockId = this.#getWorldBlockForBoatPhysics(x, y, z);

				return isCollidableBlock(blockId);
			},
			this.#cfg.collisionEpsilon,
			{
				scene,
				name: "boatOBB",
				position: this.#boat.position,
				renderOrder: 1,
			},
		);

		this.#ensureTotalYawCache();
		this.#voxelCollider.setYaw(this.#cachedTotalYaw);

		this.#subscribeBoatChunkBlockChanges();
		this.#syncCollisionFromBoatChunk();

		(this.#boat as any).metadata = new MetadataContainer();

		(this.#boat.metadata as any).set("use", (targetPlayer: Player) =>
			this.use(targetPlayer),
		);

		if (this.#boatChunk) {
			(this.#boat.metadata as any).set("boatChunk", this.#boatChunk);
		}

		if (this.#customVisualRoot) {
			this.#attachCustomVisual(this.#customVisualRoot);

			this.#applyCustomVisualMetadata(this.#customVisualRoot);
		}

		this.#buildBuoyancyPoints();

		this.#boatControls = new CustomBoatControls(this, player);

		this.#mount = new Mount(this.#boat, this.#boatControls);

		if (this.#helmLocal && this.#boatChunk) {
			this.#mount.setMountOffset(this.#helmMountOffset);

			this.#mount.setMountRotationOffset(this.#helmMountRot);

			this.#computeHelmMountOffset();
		}

		if (this.#boatChunk) {
			CustomBoat.#boatsByChunk.set(this.#boatChunk, this);
		}

		this.#chunkBindingHandle = registerChunkBoundEntity({
			getWorldPosition: () => this.#boat.position,
			unload: () => this.dispose(),
			isAlive: () => !this.#isDisposed && !(this.#boat as any).isDisposed?.(),
			serializeForChunkReload: () => this.#createSerializedPayload(),
		});

		(this.#boat as any).onDisposeObservable?.add?.(() => this.dispose());

		CustomBoat.#activeBoats.add(this);
		CustomBoat.#boatsSnapshotDirty = true;
	}

	public get boatChunk(): BoatChunk | undefined {
		return this.#boatChunk;
	}

	public get boatYaw(): number {
		return this.#currentYaw;
	}

	public get totalYaw(): number {
		return this.#currentYaw + this.#customVisualLocalYaw;
	}

	public get boatMesh(): Mesh {
		return this.#boat;
	}

	public get boatPosition(): Vec3 {
		return vec3(
			this.#boat.position.x,
			this.#boat.position.y,
			this.#boat.position.z,
		);
	}

	public get mount(): Mount {
		return this.#mount;
	}

	public get submergedPoints(): number {
		return this.#submergedPoints;
	}

	public get currentYaw(): number {
		return this.#currentYaw;
	}

	public get rawYaw(): number {
		return this.#currentYaw;
	}

	public get collisionHalfExtents(): Vec3 {
		return this.#collisionHalfExtents;
	}

	public getBoatPositionToRef(out: Vec3): void {
		out.x = this.#boat.position.x;
		out.y = this.#boat.position.y;
		out.z = this.#boat.position.z;
	}

	public getBoatTopYToRef(out: Vec3): void {
		const bounds = (this.#boat as any).getBoundingInfo?.();

		out.x = this.#boat.position.x;
		out.y = bounds ? bounds.boundingBox.maximumWorld.y : this.#boat.position.y;
		out.z = this.#boat.position.z;
	}

	public getBoatTopY(): Vec3 {
		const bounds = (this.#boat as any).getBoundingInfo?.();

		return vec3(
			this.#boat.position.x,
			bounds ? bounds.boundingBox.maximumWorld.y : this.#boat.position.y,
			this.#boat.position.z,
		);
	}

	public worldToBoatChunkLocalPoint(
		worldPoint: Vec3,
		out = vec3Zero(),
	): Vec3 | null {
		const boatChunk = this.#boatChunk;

		if (!boatChunk) {
			return null;
		}

		this.#ensureTotalYawCache();

		const root = boatChunk.visualRoot.position;
		const center = boatChunk.center;
		const c = this.#cachedTotalCos;
		const s = this.#cachedTotalSin;

		const dx = worldPoint.x - root.x;
		const dy = worldPoint.y - root.y;
		const dz = worldPoint.z - root.z;

		return setVec3(
			out,
			dx * c - dz * s + center.x,
			dy + center.y,
			dx * s + dz * c + center.z,
		);
	}

	public boatChunkLocalPointToWorld(
		localPoint: Vec3,
		out = vec3Zero(),
	): Vec3 | null {
		const boatChunk = this.#boatChunk;

		if (!boatChunk) {
			return null;
		}

		this.#ensureTotalYawCache();

		const root = boatChunk.visualRoot.position;
		const center = boatChunk.center;
		const c = this.#cachedTotalCos;
		const s = this.#cachedTotalSin;

		const localX = localPoint.x - center.x;
		const localY = localPoint.y - center.y;
		const localZ = localPoint.z - center.z;

		return setVec3(
			out,
			root.x + localX * c + localZ * s,
			root.y + localY,
			root.z - localX * s + localZ * c,
		);
	}

	public applyImpulse(impulse: Vec3, point: Vec3): void {
		this.#applyForceAtPoint(impulse.x, impulse.y, impulse.z, point, 1);
	}

	public applyAngularImpulse(impulse: Vec3): void {
		const scale = (1 / this.#cfg.mass) * this.#angularResponseScale;

		this.#angularVelocity.x += impulse.x * scale;
		this.#angularVelocity.y += impulse.y * scale;
		this.#angularVelocity.z += impulse.z * scale;
	}

	public use(player: Player): void {
		if (this.#isDisposed) {
			return;
		}

		this.#computeHelmMountOffset();
		this.#mount.mount(player);
	}

	public dispose(): void {
		if (this.#isDisposed) {
			return;
		}

		this.#isDisposed = true;

		unregisterChunkBoundEntity(this.#chunkBindingHandle);

		this.#chunkBindingHandle = undefined;

		unregisterDynamicBlockProvider(this.#boatChunkCollisionProviderHandle);

		this.#boatChunkCollisionProviderHandle = undefined;

		this.#boatChunkBlockChangeUnsubscribe?.();
		this.#boatChunkBlockChangeUnsubscribe = undefined;

		this.#ignoredDynamicBlockProviders.clear();

		if (this.#mount?.isMounted()) {
			this.#mount.dismount();
		}

		this.#voxelCollider?.dispose();

		const boatChunk = this.#boatChunk;

		if (boatChunk) {
			CustomBoat.#boatsByChunk.delete(boatChunk);

			boatChunk.dispose();
			this.#boatChunk = undefined;
		}

		if (CustomBoat.#activeBoats.delete(this)) {
			CustomBoat.#boatsSnapshotDirty = true;
		}

		removeFromScene(Map1.mainScene, this.#boat);
	}

	#createHull(
		scene: SceneContext,
		position: Vec3 | undefined,
		waterLevel: number,
	): Mesh {
		const px = position?.x ?? 0;
		const py = position?.y ?? waterLevel + 10;
		const pz = position?.z ?? 0;

		const hull = createBox(Map1.engine, 1);

		hull.name = "boatHull";
		hull.position.set(px, py, pz);

		hull.scaling.set(
			this.#collisionHalfExtents.x * 2,
			this.#collisionHalfExtents.y * 2,
			this.#collisionHalfExtents.z * 2,
		);

		const material = createStandardMaterial();

		material.diffuseColor = [0.8, 0.6, 0.2];

		// It must remain rendered for the GPU picking buffer, but it should
		// not be visible to the player.
		material.alpha = 0;

		hull.material = material;
		hull.pickable = true;

		addToScene(scene, hull);

		return hull;
	}

	#attachCustomVisual(visual: Mesh): void {
		visual.position.copyFrom(this.#boat.position);

		Quaternion.FromEulerAnglesToRef(0, this.totalYaw, 0, this.#scratchQuat);

		visual.rotationQuaternion.copyFrom(this.#scratchQuat);

		visual.scaling.set(1, 1, 1);
	}

	#applyCustomVisualMetadata(root: Mesh): void {
		root.pickable = true;
		root.renderOrder = 1;
		root.metadata = this.#boat.metadata;

		const childMeshes = (root as any).getChildMeshes?.(false) ?? [];

		for (let index = 0; index < childMeshes.length; index++) {
			const mesh = childMeshes[index];

			mesh.pickable = true;
			mesh.renderOrder = 1;
			mesh.metadata = this.#boat.metadata;
		}
	}

	#buildBuoyancyPoints(): void {
		const halfExtents = this.#collisionHalfExtents;

		const localY = -halfExtents.y - 0.3;
		const outerX = halfExtents.x * 0.85;
		const outerZ = halfExtents.z * 0.85;
		const innerX = halfExtents.x * 0.45;
		const innerZ = halfExtents.z * 0.45;
		const centerX = this.#collisionCenterOffset.x;
		const centerZ = this.#collisionCenterOffset.z;

		if (this.#buoyancyPoints.length === 0) {
			for (let index = 0; index < 9; index++) {
				this.#buoyancyPoints.push(vec3Zero());
			}
		}

		const points = this.#buoyancyPoints;

		setVec3(points[0], centerX - outerX, localY, centerZ - outerZ);

		setVec3(points[1], centerX + outerX, localY, centerZ - outerZ);

		setVec3(points[2], centerX - outerX, localY, centerZ + outerZ);

		setVec3(points[3], centerX + outerX, localY, centerZ + outerZ);

		setVec3(points[4], centerX, localY, centerZ);

		setVec3(points[5], centerX - innerX, localY, centerZ - innerZ);

		setVec3(points[6], centerX + innerX, localY, centerZ - innerZ);

		setVec3(points[7], centerX - innerX, localY, centerZ + innerZ);

		setVec3(points[8], centerX + innerX, localY, centerZ + innerZ);
	}

	/**
	 * Refreshes the cached total yaw and trigonometric values without
	 * allocating a temporary result object.
	 */
	#ensureTotalYawCache(): void {
		const totalYaw = this.#currentYaw + this.#customVisualLocalYaw;

		if (totalYaw === this.#cachedTotalYaw) {
			return;
		}

		this.#cachedTotalYaw = totalYaw;
		this.#cachedTotalCos = Math.cos(totalYaw);
		this.#cachedTotalSin = Math.sin(totalYaw);
	}

	#tick(_scene: SceneContext, deltaMs: number): void {
		if (deltaMs <= 0 || this.#isDisposed) {
			return;
		}

		const cfg = this.#cfg;

		const dt = Math.min(
			cfg.dtClamp.max,
			Math.max(cfg.dtClamp.min, deltaMs * 0.001),
		);

		const boatPosition = this.#boat.position;
		const linearVelocity = this.#linearVelocity;
		const angularVelocity = this.#angularVelocity;

		linearVelocity.y += cfg.gravity * dt;

		const inverseMass = 1 / cfg.mass;

		const angularForceScale =
			cfg.torqueScale * this.#angularResponseScale * inverseMass * dt;

		this.#ensureTotalYawCache();

		const cosYaw = this.#cachedTotalCos;
		const sinYaw = this.#cachedTotalSin;

		const boatX = boatPosition.x;
		const boatY = boatPosition.y;
		const boatZ = boatPosition.z;

		const buoyancyPoints = this.#buoyancyPoints;

		let submergedPoints = 0;

		for (let index = 0; index < buoyancyPoints.length; index++) {
			const localPoint = buoyancyPoints[index];

			const localX = localPoint.x;
			const localZ = localPoint.z;

			const worldX = boatX + localX * cosYaw + localZ * sinYaw;

			const worldY = boatY + localPoint.y;

			const worldZ = boatZ - localX * sinYaw + localZ * cosYaw;

			const voxelX = Math.floor(worldX);
			const voxelY = Math.floor(worldY);
			const voxelZ = Math.floor(worldZ);

			if (
				this.#getWorldBlockForBoatPhysics(voxelX, voxelY, voxelZ) !==
				BlockType.Water
			) {
				continue;
			}

			const blockAbove = this.#getWorldBlockForBoatPhysics(
				voxelX,
				voxelY + 1,
				voxelZ,
			);

			const submersion =
				blockAbove === BlockType.Water
					? 1
					: Math.max(0, Math.min(1, voxelY + 1 - worldY));

			if (submersion <= 0) {
				continue;
			}

			this.#applyVerticalBuoyancyForce(
				submersion * cfg.baseBuoyancyForce,
				worldX,
				worldZ,
				dt,
				inverseMass,
				angularForceScale,
			);

			submergedPoints++;
		}

		this.#submergedPoints = submergedPoints;

		const isInWater = submergedPoints !== 0;
		const dampingTimeScale = dt * 60;

		const linearDamping = isInWater
			? cfg.damping.waterLinear
			: cfg.damping.airLinear;

		const angularDamping = isInWater
			? cfg.damping.waterAngular
			: cfg.damping.airAngular;

		scaleVec3InPlace(linearVelocity, linearDamping ** dampingTimeScale);

		scaleVec3InPlace(angularVelocity, angularDamping ** dampingTimeScale);

		this.#integrateRotation(dt);
		this.#ensureTotalYawCache();

		const totalYaw = this.#cachedTotalYaw;

		this.#voxelCollider.setYaw(totalYaw);

		const moveX = linearVelocity.x * dt;
		const moveY = linearVelocity.y * dt;
		const moveZ = linearVelocity.z * dt;

		if (moveX !== 0) {
			this.#moveAxis(Axis.X, moveX);
		}

		if (moveY !== 0) {
			this.#moveAxis(Axis.Y, moveY);
		}

		if (moveZ !== 0) {
			this.#moveAxis(Axis.Z, moveZ);
		}

		const customVisualRoot = this.#customVisualRoot;

		if (customVisualRoot) {
			customVisualRoot.position.copyFrom(boatPosition);

			Quaternion.FromEulerAnglesToRef(0, totalYaw, 0, this.#scratchQuat);

			customVisualRoot.rotationQuaternion.copyFrom(this.#scratchQuat);
		}

		this.#syncHelmMount();
		this.#mount.update();
		this.#boatChunk?.syncVisualMeshes();

		this.#voxelCollider.syncDebugMesh(boatPosition);
	}

	/**
	 * Applies vertical buoyancy without constructing temporary force vectors.
	 */
	#applyVerticalBuoyancyForce(
		forceY: number,
		worldX: number,
		worldZ: number,
		dt: number,
		inverseMass: number,
		angularScale: number,
	): void {
		this.#linearVelocity.y += forceY * inverseMass * dt;

		const boatPosition = this.#boat.position;
		const leverX = worldX - boatPosition.x;
		const leverZ = worldZ - boatPosition.z;

		this.#angularVelocity.x -= leverZ * forceY * angularScale;

		this.#angularVelocity.z += leverX * forceY * angularScale;
	}

	#applyForceAtPoint(
		forceX: number,
		forceY: number,
		forceZ: number,
		worldPoint: Vec3,
		dt: number,
	): void {
		const inverseMass = 1 / this.#cfg.mass;

		this.#linearVelocity.x += forceX * inverseMass * dt;

		this.#linearVelocity.y += forceY * inverseMass * dt;

		this.#linearVelocity.z += forceZ * inverseMass * dt;

		const boatPosition = this.#boat.position;

		setVec3(
			this.#tmpLever,
			worldPoint.x - boatPosition.x,
			worldPoint.y - boatPosition.y,
			worldPoint.z - boatPosition.z,
		);

		const lever = this.#tmpLever;

		setVec3(
			this.#tmpTorque,
			lever.y * forceZ - lever.z * forceY,
			lever.z * forceX - lever.x * forceZ,
			lever.x * forceY - lever.y * forceX,
		);

		const torqueScale =
			this.#cfg.torqueScale * this.#angularResponseScale * inverseMass * dt;

		const torque = this.#tmpTorque;

		this.#angularVelocity.x += torque.x * torqueScale;

		this.#angularVelocity.y += torque.y * torqueScale;

		this.#angularVelocity.z += torque.z * torqueScale;
	}

	#integrateRotation(dt: number): void {
		this.#currentYaw += this.#angularVelocity.y * dt;

		this.#angularVelocity.y *= 0.985;

		// Pitch and roll are not currently integrated into the boat transform.
		this.#angularVelocity.x = 0;
		this.#angularVelocity.z = 0;

		if (this.#currentYaw > Math.PI || this.#currentYaw < -Math.PI) {
			const fullTurn = Math.PI * 2;

			this.#currentYaw =
				((((this.#currentYaw + Math.PI) % fullTurn) + fullTurn) % fullTurn) -
				Math.PI;
		}
	}

	#moveAxis(axis: Axis, delta: number): void {
		this.#voxelCollider.moveAxis(
			this.#boat.position,
			this.#linearVelocity,
			axis,
			delta,
			this.#cfg.collisionStepSize,
		);
	}

	#createSerializedPayload(): {
		type: string;
		payload: CustomBoatSerializedPayload;
	} {
		const boatChunkSnapshot = this.#boatChunk?.toSnapshot();

		const payload: CustomBoatSerializedPayload = {
			position: {
				x: this.#boat.position.x,
				y: this.#boat.position.y,
				z: this.#boat.position.z,
			},
			collisionHalfExtents: {
				x: this.#collisionHalfExtents.x,
				y: this.#collisionHalfExtents.y,
				z: this.#collisionHalfExtents.z,
			},
			initialYaw: this.#currentYaw,
			customVisualLocalYaw: this.#customVisualLocalYaw,
			blockCount: boatChunkSnapshot?.blocks.length,
			helmLocal: this.#helmLocal
				? {
						x: this.#helmLocal.x,
						y: this.#helmLocal.y,
						z: this.#helmLocal.z,
					}
				: undefined,
			boatChunk: boatChunkSnapshot
				? {
						blocks: boatChunkSnapshot.blocks.slice(),
						center: {
							x: boatChunkSnapshot.center.x,
							y: boatChunkSnapshot.center.y,
							z: boatChunkSnapshot.center.z,
						},
					}
				: undefined,
		};

		return {
			type: CustomBoat.CHUNK_ENTITY_TYPE,
			payload,
		};
	}

	#syncHelmMount(): void {
		if (!this.#mount.isMounted()) {
			return;
		}

		this.#computeHelmMountOffset();
	}

	#computeHelmMountOffset(): void {
		const helmLocal = this.#helmLocal;
		const boatChunk = this.#boatChunk;

		if (!helmLocal || !boatChunk) {
			return;
		}

		this.#ensureTotalYawCache();

		const center = boatChunk.center;
		const boatPosition = this.#boat.position;

		const cosTotalYaw = this.#cachedTotalCos;
		const sinTotalYaw = this.#cachedTotalSin;

		const localX = helmLocal.x + 0.5 - center.x;

		const localY = helmLocal.y + 0.5 - center.y;

		const localZ = helmLocal.z + 0.5 - center.z;

		const helmOffsetX = localX * cosTotalYaw + localZ * sinTotalYaw;

		const helmOffsetZ = -localX * sinTotalYaw + localZ * cosTotalYaw;

		const helmWorldY = boatPosition.y + localY;

		const behindDistance = 1;
		const forwardX = Math.sin(this.#currentYaw);
		const forwardZ = Math.cos(this.#currentYaw);

		const deckTopWorldY = boatPosition.y + this.#deckTopLocalY - center.y;

		const feetY = Math.max(helmWorldY - 0.45, deckTopWorldY + 0.02);

		setVec3(
			this.#helmMountOffset,
			helmOffsetX - forwardX * behindDistance,
			feetY - boatPosition.y,
			helmOffsetZ - forwardZ * behindDistance,
		);

		Quaternion.FromEulerAnglesToRef(0, this.#currentYaw, 0, this.#helmMountRot);
	}

	#subscribeBoatChunkBlockChanges(): void {
		const boatChunk = this.#boatChunk;

		if (!boatChunk) {
			return;
		}

		this.#boatChunkBlockChangeUnsubscribe?.();

		this.#boatChunkBlockChangeUnsubscribe = boatChunk.onBlockChanged(() => {
			this.#syncCollisionFromBoatChunk();
		});
	}

	#syncCollisionFromBoatChunk(): void {
		const boatChunk = this.#boatChunk;

		if (!boatChunk) {
			return;
		}

		const occupied = boatChunk.getOccupiedBoundsLocalToRef(this.#scratchBounds);

		if (!occupied) {
			return;
		}

		this.#deckTopLocalY = occupied.maxY + 1;

		const center = boatChunk.center;
		const padding = 0.05;

		const obbMinX = occupied.minX - center.x;

		const obbMaxX = occupied.maxX + 1 - center.x;

		const obbMinZ = occupied.minZ - center.z;

		const obbMaxZ = occupied.maxZ + 1 - center.z;

		setVec3(
			this.#collisionCenterOffset,
			(obbMaxX + obbMinX) * 0.5,
			0,
			(obbMaxZ + obbMinZ) * 0.5,
		);

		const halfX = (obbMaxX - obbMinX) * 0.5;

		const halfZ = (obbMaxZ - obbMinZ) * 0.5;

		const halfY = Math.max(
			center.y - occupied.minY,
			occupied.maxY + 1 - center.y,
		);

		setVec3(
			this.#collisionHalfExtents,
			halfX + padding,
			halfY + padding,
			halfZ + padding,
		);

		this.#voxelCollider.setHalfExtents(this.#collisionHalfExtents);

		this.#voxelCollider.setCenterOffset(this.#collisionCenterOffset);

		this.#buildBuoyancyPoints();
	}

	#hasOccupiedBoatNeighbor(
		localX: number,
		localY: number,
		localZ: number,
	): boolean {
		const boatChunk = this.#boatChunk;

		if (!boatChunk) {
			return false;
		}

		const offsets = CustomBoat.#neighborOffsets;

		for (let index = 0; index < offsets.length; index += 3) {
			const neighborX = localX + offsets[index];

			const neighborY = localY + offsets[index + 1];

			const neighborZ = localZ + offsets[index + 2];

			if (!boatChunk.isInsideLocalBounds(neighborX, neighborY, neighborZ)) {
				continue;
			}

			if (
				boatChunk.getBlockLocal(neighborX, neighborY, neighborZ) !==
				BlockType.Air
			) {
				return true;
			}
		}

		return false;
	}

	#registerBoatChunkCollisionProvider(): void {
		if (!this.#boatChunk) {
			return;
		}

		const handle = registerDynamicBlockProvider(
			(worldX, worldY, worldZ) =>
				this.#sampleBoatChunkBlock(worldX, worldY, worldZ),
			(worldX, worldY, worldZ, blockId, blockState) =>
				this.#setBoatChunkBlock(worldX, worldY, worldZ, blockId, blockState),
		);

		this.#boatChunkCollisionProviderHandle = handle;

		this.#ignoredDynamicBlockProviders.add(handle);
	}

	#sampleBoatChunkBlock(
		worldX: number,
		worldY: number,
		worldZ: number,
	): DynamicBlockSample | null {
		const boatChunk = this.#boatChunk;

		if (!boatChunk) {
			return null;
		}

		const root = boatChunk.visualRoot.position;

		const center = boatChunk.center;
		const originY = root.y - center.y;

		if (worldY < originY || worldY >= originY + Chunk.SIZE) {
			return null;
		}

		const deltaX = worldX + 0.5 - root.x;

		const deltaZ = worldZ + 0.5 - root.z;

		if (deltaX < -48 || deltaX > 48 || deltaZ < -48 || deltaZ > 48) {
			return null;
		}

		this.#ensureTotalYawCache();

		const cosYaw = this.#cachedTotalCos;
		const sinYaw = this.#cachedTotalSin;

		const localX = Math.floor(deltaX * cosYaw - deltaZ * sinYaw + center.x);

		const localY = Math.floor(worldY + 0.5 - root.y + center.y);

		const localZ = Math.floor(deltaX * sinYaw + deltaZ * cosYaw + center.z);

		if (!boatChunk.isInsideLocalBounds(localX, localY, localZ)) {
			return null;
		}

		const blockId = boatChunk.getBlockLocal(localX, localY, localZ);

		if (blockId === BlockType.Air) {
			return null;
		}

		const sample = CustomBoat.#sampleScratch;

		sample.blockId = blockId;

		sample.blockState = boatChunk.getBlockStateLocal(localX, localY, localZ);

		sample.lightLevel = boatChunk.getLightLocal(localX, localY, localZ);

		return sample;
	}

	#setBoatChunkBlock(
		worldX: number,
		worldY: number,
		worldZ: number,
		blockId: number,
		blockState: number,
	): boolean {
		const boatChunk = this.#boatChunk;

		if (!boatChunk) {
			return false;
		}

		const local = this.#worldToBoatLocal(worldX, worldY, worldZ);

		if (!local) {
			return false;
		}

		const existing = boatChunk.getBlockLocal(local.x, local.y, local.z);

		const targetIsOccupied = existing !== BlockType.Air;

		const wantsDelete = blockId === BlockType.Air;

		const canAttachToBoat =
			!targetIsOccupied &&
			!wantsDelete &&
			this.#hasOccupiedBoatNeighbor(local.x, local.y, local.z);

		if (!targetIsOccupied && !canAttachToBoat) {
			return false;
		}

		boatChunk.setBlockLocal(local.x, local.y, local.z, blockId, blockState);

		return true;
	}

	#worldToBoatLocal(
		worldX: number,
		worldY: number,
		worldZ: number,
	): Vec3 | null {
		const boatChunk = this.#boatChunk;

		if (!boatChunk) {
			return null;
		}

		this.#ensureTotalYawCache();

		const root = boatChunk.visualRoot.position;

		const center = boatChunk.center;
		const cosYaw = this.#cachedTotalCos;
		const sinYaw = this.#cachedTotalSin;

		const deltaX = worldX + 0.5 - root.x;

		const deltaY = worldY + 0.5 - root.y;

		const deltaZ = worldZ + 0.5 - root.z;

		const localX = Math.floor(deltaX * cosYaw - deltaZ * sinYaw + center.x);

		const localY = Math.floor(deltaY + center.y);

		const localZ = Math.floor(deltaX * sinYaw + deltaZ * cosYaw + center.z);

		if (!boatChunk.isInsideLocalBounds(localX, localY, localZ)) {
			return null;
		}

		return setVec3(this.#scratchRootLocal, localX, localY, localZ);
	}

	#getWorldBlockForBoatPhysics(x: number, y: number, z: number): number {
		return getBlockByWorldCoords(x, y, z, this.#worldQueryOptions);
	}
}
