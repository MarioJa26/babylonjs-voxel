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
import { BoatChunk, type BoatChunkBlock } from "@/code/World/Boat/BoatChunk";
import { Chunk } from "@/code/World/Chunk/Chunk";
import { Axis } from "@/code/World/Collision/VoxelAabbCollider";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import type { IUsable } from "../Interface/IUsable";
import { CustomBoatControls } from "../Player/Controls/CustomBoatControls";
import type { Player } from "../Player/Player";
import {
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
};

type SerializedBoatChunk = {
	blocks: BoatChunkBlock[];
	center: { x: number; y: number; z: number };
};

type CustomBoatSerializedPayload = {
	position: { x: number; y: number; z: number };
	collisionHalfExtents: { x: number; y: number; z: number };
	initialYaw: number;
	customVisualLocalYaw: number;
	blockCount?: number;
	boatChunk?: SerializedBoatChunk;
};

export class CustomBoat implements IUsable {
	static readonly CHUNK_ENTITY_TYPE = "custom_boat_v1";
	static #chunkReloadContext: {
		scene: SceneContext;
		player: Player;
		waterLevel: number;
	} | null = null;
	static #chunkLoaderRegistered = false;

	static #activeBoats = new Set<CustomBoat>();
	static #boatsSnapshot: CustomBoat[] = [];

	// PERF: Pre-computed boat cull distance squared — avoids recomputing every tick.
	static #boatCullDistSq =
		(SETTING_PARAMS.RENDER_DISTANCE * Chunk.SIZE * 2) ** 2;

	public static getActiveBoats(): readonly CustomBoat[] {
		if (CustomBoat.#activeBoats.size !== CustomBoat.#boatsSnapshot.length) {
			CustomBoat.#boatsSnapshot.length = 0;
			for (const boat of CustomBoat.#activeBoats) {
				CustomBoat.#boatsSnapshot.push(boat);
			}
		}
		return CustomBoat.#boatsSnapshot;
	}

	public static tickAllActiveBoats(
		scene: SceneContext,
		playerPos?: Vec3,
	): void {
		const cullDistSq =
			playerPos !== undefined ? CustomBoat.#boatCullDistSq : Infinity;
		for (const boat of CustomBoat.#activeBoats) {
			if (cullDistSq < Infinity) {
				const dx = boat.#boat.position.x - playerPos!.x;
				const dz = boat.#boat.position.z - playerPos!.z;
				if (dx * dx + dz * dz > cullDistSq) continue;
			}
			boat.#tick(scene);
		}
	}

	public get boatChunk(): BoatChunk | undefined {
		return this.#boatChunk;
	}

	public get boatYaw(): number {
		return this.#currentYaw;
	}

	public worldToBoatChunkLocalPoint(
		worldPoint: Vec3,
		out = vec3Zero(),
	): Vec3 | null {
		if (!this.#boatChunk) return null;

		const root = this.#boatChunk.visualRoot.position;
		setVec3(
			this.#scratchRootLocal,
			worldPoint.x - root.x,
			worldPoint.y - root.y,
			worldPoint.z - root.z,
		);

		return setVec3(
			out,
			this.#scratchRootLocal.x + this.#boatChunk.center.x,
			this.#scratchRootLocal.y + this.#boatChunk.center.y,
			this.#scratchRootLocal.z + this.#boatChunk.center.z,
		);
	}

	public boatChunkLocalPointToWorld(
		localPoint: Vec3,
		out = vec3Zero(),
	): Vec3 | null {
		if (!this.#boatChunk) return null;

		const root = this.#boatChunk.visualRoot.position;
		return setVec3(
			out,
			localPoint.x - this.#boatChunk.center.x + root.x,
			localPoint.y - this.#boatChunk.center.y + root.y,
			localPoint.z - this.#boatChunk.center.z + root.z,
		);
	}

	public static configureChunkReloadContext(
		player: Player,
		waterLevel: number,
	): void {
		const scene = Map1.mainScene;
		CustomBoat.#chunkReloadContext = { scene, player, waterLevel };
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
				const snapshotBlocks = data.boatChunk.blocks.map((block) => ({
					...block,
				}));
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
				skipDefaultModel: !!restoredBoatChunk,
				initialYaw: data.initialYaw,
				customVisualLocalYaw: data.customVisualLocalYaw,
				blockCount: data.blockCount,
				boatChunk: restoredBoatChunk,
			});
		});
	}

	#cfg = {
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
		dtClamp: { min: 1 / 600, max: 1 / 24 },
	} as const;

	#collisionHalfExtents = vec3(1.15, 0.6, 1.15);
	#collisionCenterOffset = vec3Zero();
	#boat!: Mesh;
	#voxelCollider!: VoxelObbCollider;

	#mount!: Mount;
	static #boatControls: CustomBoatControls;

	#customVisualRoot?: Mesh;
	#customVisualLocalYaw = 0;
	#skipDefaultModel = false;

	#boatChunk?: BoatChunk;
	#boatChunkCollisionProviderHandle?: symbol;
	#boatChunkBlockChangeUnsubscribe?: () => void;
	#ignoredDynamicBlockProviders = new Set<symbol>();

	#currentYaw = 0;
	// PERF: Cache cos/sin to avoid recomputing when yaw is unchanged.
	#cachedYaw = NaN;
	#cachedCos = 0;
	#cachedSin = 0;
	#linearVelocity = vec3Zero();
	#angularVelocity = vec3Zero();
	#angularResponseScale = 1;

	#buoyancyPoints: Vec3[] = [];
	#submergedPoints = 0;

	#chunkBindingHandle?: symbol;
	#isDisposed = false;
	#lastTickTime = performance.now();

	#tmpWorldPoint = vec3Zero();
	#tmpTorque = vec3Zero();
	#tmpLever = vec3Zero();
	#tmpBoatSampleWorld = vec3Zero();
	#scratchRootLocal = vec3Zero();
	#scratchQuat = Quaternion.Identity();

	constructor(
		player: Player,
		waterLevel: number,
		position?: Vec3,
		options?: CustomBoatOptions,
	) {
		const scene = Map1.mainScene;
		CustomBoat.configureChunkReloadContext(player, waterLevel);

		// 1) Options
		if (options?.collisionHalfExtents) {
			this.#collisionHalfExtents = vec3(
				options.collisionHalfExtents.x,
				options.collisionHalfExtents.y,
				options.collisionHalfExtents.z,
			);
		}
		this.#customVisualRoot = options?.customVisualRoot;
		this.#boatChunk = options?.boatChunk;
		this.#skipDefaultModel = Boolean(options?.skipDefaultModel);

		if (typeof options?.initialYaw === "number")
			this.#currentYaw = options.initialYaw;
		if (typeof options?.customVisualLocalYaw === "number")
			this.#customVisualLocalYaw = options.customVisualLocalYaw;

		if (typeof options?.blockCount === "number" && options.blockCount > 1) {
			this.#angularResponseScale = Math.max(
				0.08,
				1 / Math.sqrt(options.blockCount),
			);
		}

		// 2) Create hull & collider
		this.#boat = this.#createHull(scene, position, waterLevel);
		this.#registerBoatChunkCollisionProvider();

		this.#voxelCollider = new VoxelObbCollider(
			this.#collisionHalfExtents,
			(x, y, z) => {
				const id = this.#getWorldBlockForBoatPhysics(x, y, z);
				return isCollidableBlock(id);
			},
			this.#cfg.collisionEpsilon,
			{
				scene,
				name: "boatOBB",
				position: this.#boat.position,
				renderOrder: 1,
			},
		);
		this.#subscribeBoatChunkBlockChanges();
		this.#syncCollisionFromBoatChunk();

		// 3) Metadata
		(this.#boat as any).metadata = new MetadataContainer();
		(this.#boat.metadata as any).set("use", (p: Player) => this.use(p));

		if (this.#boatChunk) {
			(this.#boat.metadata as any).set("boatChunk", this.#boatChunk);
		}

		// 4) Visuals
		if (this.#customVisualRoot) {
			this.#attachCustomVisual(this.#customVisualRoot);
			this.#applyCustomVisualMetadata(this.#customVisualRoot);
		}

		// 5) Buoyancy points
		this.#buildBuoyancyPoints();

		// 6) Controls
		CustomBoat.#boatControls = new CustomBoatControls(this, player);
		this.#mount = new Mount(this.#boat, CustomBoat.#boatControls);

		// 7) Tick loop (centralized via tickAllActiveBoats)

		this.#chunkBindingHandle = registerChunkBoundEntity({
			getWorldPosition: () => this.#boat.position,
			unload: () => this.dispose(),
			isAlive: () => !(this.#boat as any).isDisposed?.(),
			serializeForChunkReload: () => this.#createSerializedPayload(),
		});

		// 8) Cleanup
		(this.#boat as any).onDisposeObservable?.add?.(() => this.dispose());
		CustomBoat.#activeBoats.add(this);
	}

	#createHull(
		scene: SceneContext,
		position: Vec3 | undefined,
		waterLevel: number,
	): Mesh {
		// The hull is a real, rendered box mesh (not a TransformNode) so the GPU
		// ray picker used by the USE interaction can hit it. In the Lite port the
		// picker skips `visible = false` meshes (they aren't drawn to the pick
		// buffer), so instead of hiding it we make it fully transparent (alpha 0)
		// — it still renders (and is pickable) but is invisible to the eye. The
		// Mount vehicle drives from this mesh's transform.
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

		const mat = createStandardMaterial();
		mat.diffuseColor = [0.8, 0.6, 0.2];
		mat.alpha = 0; // Invisible but still rendered → pickable by GPU picker.
		hull.material = mat;

		hull.pickable = true;

		addToScene(scene, hull);

		return hull;
	}

	#attachCustomVisual(visual: Mesh): void {
		visual.position.copyFrom(this.#boat.position);
		const q = Quaternion.RotationYawPitchRoll(
			this.#currentYaw + this.#customVisualLocalYaw,
			0,
			0,
		);
		visual.rotationQuaternion.copyFrom(q);
		visual.scaling.set(1, 1, 1);
	}

	#applyCustomVisualMetadata(root: Mesh): void {
		for (const mesh of [
			root,
			...((root as any).getChildMeshes?.(false) ?? []),
		]) {
			mesh.pickable = true;
			mesh.renderOrder = 1;
			mesh.metadata = this.#boat.metadata;
		}
	}

	#buildBuoyancyPoints(): void {
		const y = -this.#collisionHalfExtents.y - 0.3;
		const ox = this.#collisionHalfExtents.x * 0.85;
		const oz = this.#collisionHalfExtents.z * 0.85;
		const ix = this.#collisionHalfExtents.x * 0.45;
		const iz = this.#collisionHalfExtents.z * 0.45;
		const cox = this.#collisionCenterOffset.x;
		const coz = this.#collisionCenterOffset.z;

		if (this.#buoyancyPoints.length === 0) {
			// PERF: Pre-allocate array once, update in-place on subsequent calls.
			for (let i = 0; i < 9; i++) this.#buoyancyPoints.push(vec3Zero());
		}
		const bp = this.#buoyancyPoints;

		setVec3(bp[0], cox - ox, y, coz - oz);
		setVec3(bp[1], cox + ox, y, coz - oz);
		setVec3(bp[2], cox - ox, y, coz + oz);
		setVec3(bp[3], cox + ox, y, coz + oz);
		setVec3(bp[4], cox, y, coz);
		setVec3(bp[5], cox - ix, y, coz - iz);
		setVec3(bp[6], cox + ix, y, coz - iz);
		setVec3(bp[7], cox - ix, y, coz + iz);
		setVec3(bp[8], cox + ix, y, coz + iz);
	}

	#tick(_scene: SceneContext): void {
		const now = performance.now();
		let dt = (now - this.#lastTickTime) / 1000;
		this.#lastTickTime = now;
		if (dt <= 0) return;
		dt = Math.min(Math.max(dt, this.#cfg.dtClamp.min), this.#cfg.dtClamp.max);

		this.#submergedPoints = 0;

		// PERF: Only recompute cos/sin when yaw has changed.
		if (this.#currentYaw !== this.#cachedYaw) {
			this.#cachedYaw = this.#currentYaw;
			this.#cachedCos = Math.cos(this.#currentYaw);
			this.#cachedSin = Math.sin(this.#currentYaw);
		}
		const cos = this.#cachedCos;
		const sin = this.#cachedSin;

		this.#linearVelocity.y += this.#cfg.gravity * dt;

		for (const lp of this.#buoyancyPoints) {
			const rx = lp.x * cos - lp.z * sin;
			const rz = lp.x * sin + lp.z * cos;

			setVec3(
				this.#tmpWorldPoint,
				this.#boat.position.x + rx,
				this.#boat.position.y + lp.y,
				this.#boat.position.z + rz,
			);

			const sub = this.#getWaterSubmersionAtPoint(this.#tmpWorldPoint);
			if (sub > 0) {
				this.#applyForceAtPoint(
					0,
					sub * this.#cfg.baseBuoyancyForce,
					0,
					this.#tmpWorldPoint,
					dt,
				);
				this.#submergedPoints++;
			}
		}

		// Drag
		{
			const d =
				this.#submergedPoints > 0
					? this.#cfg.damping.waterLinear
					: this.#cfg.damping.airLinear;
			const ad =
				this.#submergedPoints > 0
					? this.#cfg.damping.waterAngular
					: this.#cfg.damping.airAngular;

			scaleVec3InPlace(this.#linearVelocity, d ** (dt * 60));
			scaleVec3InPlace(this.#angularVelocity, ad ** (dt * 60));
		}

		// Move
		this.#moveAxis(Axis.X, this.#linearVelocity.x * dt);
		this.#moveAxis(Axis.Y, this.#linearVelocity.y * dt);
		this.#moveAxis(Axis.Z, this.#linearVelocity.z * dt);

		// Rotate
		this.#integrateRotation(dt);

		// Sync visuals (if any)
		if (this.#customVisualRoot) {
			this.#customVisualRoot.position.copyFrom(this.#boat.position);
			this.#scratchQuat = Quaternion.RotationYawPitchRoll(
				this.#currentYaw + this.#customVisualLocalYaw,
				0,
				0,
			);
			(this.#customVisualRoot.rotationQuaternion as any).copyFrom(
				this.#scratchQuat,
			);
		}

		// Always update collider orientation
		this.#voxelCollider.setYaw(this.#currentYaw);

		// Sync mounted player to new position
		this.#mount.update();

		// Sync boat chunk visuals
		this.#boatChunk?.syncVisualMeshes();

		// Debug
		this.#voxelCollider.syncDebugMesh(this.#boat.position);
	}

	#applyForceAtPoint(
		fx: number,
		fy: number,
		fz: number,
		worldPoint: Vec3,
		dt: number,
	): void {
		const invMass = 1 / this.#cfg.mass;

		this.#linearVelocity.x += fx * invMass * dt;
		this.#linearVelocity.y += fy * invMass * dt;
		this.#linearVelocity.z += fz * invMass * dt;

		setVec3(
			this.#tmpLever,
			worldPoint.x - this.#boat.position.x,
			worldPoint.y - this.#boat.position.y,
			worldPoint.z - this.#boat.position.z,
		);

		setVec3(
			this.#tmpTorque,
			this.#tmpLever.y * fz - this.#tmpLever.z * fy,
			this.#tmpLever.z * fx - this.#tmpLever.x * fz,
			this.#tmpLever.x * fy - this.#tmpLever.y * fx,
		);

		const torqueScale =
			this.#cfg.torqueScale * this.#angularResponseScale * invMass * dt;

		this.#angularVelocity.x += this.#tmpTorque.x * torqueScale;
		this.#angularVelocity.y += this.#tmpTorque.y * torqueScale;
		this.#angularVelocity.z += this.#tmpTorque.z * torqueScale;
	}

	#integrateRotation(dt: number) {
		this.#currentYaw += this.#angularVelocity.y * dt;
		this.#angularVelocity.y *= 0.985;

		this.#angularVelocity.x = 0;
		this.#angularVelocity.z = 0;

		if (this.#currentYaw > Math.PI || this.#currentYaw < -Math.PI) {
			this.#currentYaw =
				((this.#currentYaw + Math.PI) % (2 * Math.PI)) - Math.PI;
		}
	}

	#moveAxis(axis: Axis, delta: number) {
		this.#voxelCollider.moveAxis(
			this.#boat.position,
			this.#linearVelocity,
			axis,
			delta,
			this.#cfg.collisionStepSize,
		);
	}

	#getWaterSubmersionAtPoint(worldPoint: Vec3): number {
		const x = Math.floor(worldPoint.x);
		const y = Math.floor(worldPoint.y);
		const z = Math.floor(worldPoint.z);

		const id = this.#getWorldBlockForBoatPhysics(x, y, z);
		if (id !== BlockType.Water) return 0;

		const above = this.#getWorldBlockForBoatPhysics(x, y + 1, z);
		if (above === BlockType.Water) return 1;

		return Math.max(0, Math.min(1, y + 1 - worldPoint.y));
	}

	public applyImpulse(impulse: Vec3, point: Vec3) {
		this.#applyForceAtPoint(impulse.x, impulse.y, impulse.z, point, 1);
	}

	public applyAngularImpulse(impulse: Vec3): void {
		const scale = (1 / this.#cfg.mass) * this.#angularResponseScale;

		this.#angularVelocity.x += impulse.x * scale;
		this.#angularVelocity.y += impulse.y * scale;
		this.#angularVelocity.z += impulse.z * scale;
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

	public get collisionHalfExtents(): Vec3 {
		return this.#collisionHalfExtents;
	}

	public getBoatTopYToRef(out: Vec3): void {
		const b = (this.#boat as any).getBoundingInfo?.();
		out.x = this.#boat.position.x;
		out.y = b ? b.boundingBox.maximumWorld.y : this.#boat.position.y;
		out.z = this.#boat.position.z;
	}

	public getBoatTopY(): Vec3 {
		const b = (this.#boat as any).getBoundingInfo?.();
		return vec3(
			this.#boat.position.x,
			b ? b.boundingBox.maximumWorld.y : this.#boat.position.y,
			this.#boat.position.z,
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
			boatChunk: boatChunkSnapshot
				? {
						blocks: boatChunkSnapshot.blocks.map((block) => ({ ...block })),
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

	public use(player: Player): void {
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
		this.#boatChunk?.dispose();
		this.#boatChunk = undefined;
		CustomBoat.#activeBoats.delete(this);
		removeFromScene(Map1.mainScene, this.#boat);
	}

	#subscribeBoatChunkBlockChanges(): void {
		if (!this.#boatChunk) return;
		this.#boatChunkBlockChangeUnsubscribe?.();
		this.#boatChunkBlockChangeUnsubscribe = this.#boatChunk.onBlockChanged(
			() => {
				this.#syncCollisionFromBoatChunk();
			},
		);
	}

	#syncCollisionFromBoatChunk(): void {
		if (!this.#boatChunk) return;
		const occupied = this.#boatChunk.getOccupiedBoundsLocal();
		if (!occupied) return;

		const center = this.#boatChunk.center;
		const pad = 0.05;
		const minX = occupied.minX - center.x;
		const maxX = occupied.maxX + 1 - center.x;
		const minZ = occupied.minZ - center.z;
		const maxZ = occupied.maxZ + 1 - center.z;

		// Boat chunk visuals may have a fixed local yaw offset relative to the boat
		// collider frame, so project occupied XZ bounds into boat-local space first.
		const c = Math.cos(this.#customVisualLocalYaw);
		const s = Math.sin(this.#customVisualLocalYaw);
		const corners: readonly [number, number][] = [
			[minX, minZ],
			[minX, maxZ],
			[maxX, minZ],
			[maxX, maxZ],
		];
		let obbMinX = Infinity;
		let obbMaxX = -Infinity;
		let obbMinZ = Infinity;
		let obbMaxZ = -Infinity;
		for (const [x, z] of corners) {
			const bx = x * c + z * s;
			const bz = -x * s + z * c;
			if (bx < obbMinX) obbMinX = bx;
			if (bx > obbMaxX) obbMaxX = bx;
			if (bz < obbMinZ) obbMinZ = bz;
			if (bz > obbMaxZ) obbMaxZ = bz;
		}

		setVec3(
			this.#collisionCenterOffset,
			(obbMaxX + obbMinX) / 2,
			0,
			(obbMaxZ + obbMinZ) / 2,
		);

		const halfX = (obbMaxX - obbMinX) / 2;
		const halfZ = (obbMaxZ - obbMinZ) / 2;

		const halfY = Math.max(
			center.y - occupied.minY,
			occupied.maxY + 1 - center.y,
		);

		setVec3(this.#collisionHalfExtents, halfX + pad, halfY + pad, halfZ + pad);

		this.#voxelCollider.setHalfExtents(this.#collisionHalfExtents);
		this.#voxelCollider.setCenterOffset(this.#collisionCenterOffset);
		this.#buildBuoyancyPoints();
	}

	#hasOccupiedBoatNeighbor(
		localX: number,
		localY: number,
		localZ: number,
	): boolean {
		if (!this.#boatChunk) return false;

		const dirs: readonly [number, number, number][] = [
			[1, 0, 0],
			[-1, 0, 0],
			[0, 1, 0],
			[0, -1, 0],
			[0, 0, 1],
			[0, 0, -1],
		];

		for (const [dx, dy, dz] of dirs) {
			const nx = localX + dx;
			const ny = localY + dy;
			const nz = localZ + dz;
			if (!this.#boatChunk.isInsideLocalBounds(nx, ny, nz)) continue;
			if (this.#boatChunk.getBlockLocal(nx, ny, nz) !== BlockType.Air) {
				return true;
			}
		}

		return false;
	}

	#registerBoatChunkCollisionProvider(): void {
		if (!this.#boatChunk) {
			return;
		}

		this.#boatChunkCollisionProviderHandle = registerDynamicBlockProvider(
			(worldX, worldY, worldZ) =>
				this.#sampleBoatChunkBlock(worldX, worldY, worldZ),
			(worldX, worldY, worldZ, blockId, blockState) =>
				this.#setBoatChunkBlock(worldX, worldY, worldZ, blockId, blockState),
		);
		this.#ignoredDynamicBlockProviders.add(
			this.#boatChunkCollisionProviderHandle,
		);
	}

	#sampleBoatChunkBlock(
		worldX: number,
		worldY: number,
		worldZ: number,
	): DynamicBlockSample | null {
		const local = this.#worldToBoatLocal(worldX, worldY, worldZ);
		if (!local || !this.#boatChunk) {
			return null;
		}

		const blockId = this.#boatChunk.getBlockLocal(local.x, local.y, local.z);
		if (blockId === BlockType.Air) {
			return null;
		}

		return {
			blockId,
			blockState: this.#boatChunk.getBlockStateLocal(local.x, local.y, local.z),
			lightLevel: this.#boatChunk.getLightLocal(local.x, local.y, local.z),
			context: {
				kind: "boatChunk",
				boatChunk: this.#boatChunk,
				localX: local.x,
				localY: local.y,
				localZ: local.z,
			},
		};
	}

	#setBoatChunkBlock(
		worldX: number,
		worldY: number,
		worldZ: number,
		blockId: number,
		blockState: number,
	): boolean {
		const local = this.#worldToBoatLocal(worldX, worldY, worldZ);
		if (!local || !this.#boatChunk) {
			return false;
		}

		const existing = this.#boatChunk.getBlockLocal(local.x, local.y, local.z);
		const targetIsOccupied = existing !== BlockType.Air;
		const wantsDelete = blockId === BlockType.Air;
		const isAttachToBoat =
			!targetIsOccupied &&
			!wantsDelete &&
			this.#hasOccupiedBoatNeighbor(local.x, local.y, local.z);

		if (!targetIsOccupied && !isAttachToBoat) {
			return false;
		}

		this.#boatChunk.setBlockLocal(
			local.x,
			local.y,
			local.z,
			blockId,
			blockState,
		);
		return true;
	}

	#worldToBoatLocal(
		worldX: number,
		worldY: number,
		worldZ: number,
	): Vec3 | null {
		if (!this.#boatChunk) {
			return null;
		}

		setVec3(this.#tmpBoatSampleWorld, worldX + 0.5, worldY + 0.5, worldZ + 0.5);

		this.#boatChunk.worldToLocalBlockToRef(
			this.#tmpBoatSampleWorld,
			this.#scratchRootLocal,
		);
		if (
			!this.#boatChunk.isInsideLocalBounds(
				this.#scratchRootLocal.x,
				this.#scratchRootLocal.y,
				this.#scratchRootLocal.z,
			)
		) {
			return null;
		}

		return this.#scratchRootLocal;
	}

	#getWorldBlockForBoatPhysics(x: number, y: number, z: number): number {
		return getBlockByWorldCoords(x, y, z, {
			ignoredDynamicBlockProviders: this.#ignoredDynamicBlockProviders,
		});
	}
}
