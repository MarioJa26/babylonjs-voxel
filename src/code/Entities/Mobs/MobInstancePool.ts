import {
	addToScene,
	createMeshFromData,
	type LiteMetadata,
	loadTexture2D,
	type Mesh,
	onBeforeRender,
	setShaderTexture,
	setThinInstances,
	type Texture2D,
} from "@babylonjs/lite";

import { MetadataContainer } from "@/code/Entities/MetadataContainer";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";

import type { AquaticMob } from "./AquaticMob";
import type { FlyingMob } from "./FlyingMob";
import type { HostileMob } from "./HostileMob";
import type { Mob } from "./Mob";
import {
	buildMobModelGeometry,
	createInstancedMobAtlasMaterial,
	type MobPartSpec,
} from "./MobMesh";
import {
	MOB_BIRD_SKIN_PATH,
	MOB_CHICKEN_SKIN_PATH,
	MOB_COW_SKIN_PATH,
	MOB_FISH_SKIN_PATH,
	MOB_KRAKEN_SKIN_PATH,
	MOB_SHEEP_SKIN_PATH,
	MOB_SKELETON_SKIN_PATH,
	MOB_SONGBIRD_SKIN_PATH,
	MOB_SQUID_SKIN_PATH,
	MOB_ZOMBIE_SKIN_PATH,
} from "./MobSkin";
import type { NeutralMob } from "./NeutralMob";

type MobOwner = Mob | NeutralMob | AquaticMob | HostileMob | FlyingMob;

type PackedThinInstances = {
	matrices: Float32Array;
	colors?: Float32Array | null;
	count: number;

	_capacity?: number;

	_dirtyMin: number;
	_dirtyMax: number;
	_version?: number;

	_colorVersion?: number;
	_colorGpuVersion?: number;
	_colorDirtyMin?: number;
	_colorDirtyMax?: number;
};

/**
 * Mutable slot reference handed to a mob.
 *
 * The pool rewrites `index` when compacting lanes, so callers never need to
 * store raw thin-instance indices.
 */
export type InstanceSlotHandle = {
	pool: MobInstancePool;
	/** Active lane, or -1 once released. */
	index: number;
};

const MAT4_FLOATS = 16;
const COLOR_FLOATS = 4;
const DEFAULT_INITIAL_CAPACITY = 16;

const mobSkins = new Map<string, Texture2D>();
const mobSkinPromises = new Map<string, Promise<void>>();

function loadMobSkin(path: string): Promise<void> {
	const existing = mobSkinPromises.get(path);

	if (existing !== undefined) {
		return existing;
	}

	const promise = loadTexture2D(Map1.engine, path, {
		mipMaps: true,
		magFilter: "nearest",
		minFilter: "nearest",
	})
		.then((texture) => {
			mobSkins.set(path, texture);
			console.debug("[mobs] mob skin bound:", path);
		})
		.catch((error: unknown) => {
			console.error(`[mobs] failed to load ${path}`, error);
		});

	mobSkinPromises.set(path, promise);
	return promise;
}

/**
 * Preload every mob skin before constructing any mob instance pool.
 */
export async function preloadMobSkins(): Promise<void> {
	await Promise.all([
		loadMobSkin(MOB_CHICKEN_SKIN_PATH),
		loadMobSkin(MOB_SHEEP_SKIN_PATH),
		loadMobSkin(MOB_COW_SKIN_PATH),
		loadMobSkin(MOB_SQUID_SKIN_PATH),
		loadMobSkin(MOB_FISH_SKIN_PATH),
		loadMobSkin(MOB_KRAKEN_SKIN_PATH),
		loadMobSkin(MOB_ZOMBIE_SKIN_PATH),
		loadMobSkin(MOB_SKELETON_SKIN_PATH),
		loadMobSkin(MOB_BIRD_SKIN_PATH),
		loadMobSkin(MOB_SONGBIRD_SKIN_PATH),
	]);
}

function getMobSkin(path: string): Texture2D {
	const texture = mobSkins.get(path);

	if (texture === undefined) {
		throw new Error(
			`[mobs] ${path} not loaded; Map1.asyncInit must await ` +
				"preloadMobSkins() before spawning mobs",
		);
	}

	return texture;
}

type MobInstancePoolOptions = {
	name: string;
	skinPath: string;
	parts: readonly MobPartSpec[];
	instanceColors?: boolean;
	tint?: Color3;
	hipPivotY: number;
	shoulderPivotY?: number;
	attackRaise?: number;
	walkAmp: number;
	initialCapacity?: number;
};

export class MobInstancePool {
	readonly mesh: Mesh;

	#material: ReturnType<typeof createInstancedMobAtlasMaterial>;
	#matrices: Float32Array;
	#colors: Float32Array | null;

	#laneHolders: (InstanceSlotHandle | null)[];
	#laneOwners: (MobOwner | null)[];

	#capacity: number;
	#count = 0;

	#dirtyMin = Number.POSITIVE_INFINITY;
	#dirtyMax = Number.NEGATIVE_INFINITY;

	#colorDirtyMin = Number.POSITIVE_INFINITY;
	#colorDirtyMax = Number.NEGATIVE_INFINITY;

	#needsSync = false;
	#countDirty = false;

	constructor(options: MobInstancePoolOptions) {
		const requestedCapacity =
			options.initialCapacity ?? DEFAULT_INITIAL_CAPACITY;

		this.#capacity = Math.max(1, Math.floor(requestedCapacity));

		this.#matrices = new Float32Array(this.#capacity * MAT4_FLOATS);

		this.#colors = options.instanceColors
			? new Float32Array(this.#capacity * COLOR_FLOATS)
			: null;

		this.#laneHolders = new Array<InstanceSlotHandle | null>(
			this.#capacity,
		).fill(null);

		this.#laneOwners = new Array<MobOwner | null>(this.#capacity).fill(null);

		const geometry = buildMobModelGeometry(options.parts);

		const mesh = createMeshFromData(
			Map1.engine,
			options.name,
			geometry.positions,
			geometry.normals,
			geometry.indices,
			geometry.uvs,
			undefined,
			undefined,
			geometry.colors,
		);

		mesh.pickable = true;
		mesh.renderOrder = 1;

		this.#material = createInstancedMobAtlasMaterial(
			`${options.name}Mat`,
			options.instanceColors === true,
			options.tint ?? Color3.White(),
			options.hipPivotY,
			options.walkAmp,
			options.shoulderPivotY,
			options.attackRaise,
		);

		mesh.material = this.#material;

		setShaderTexture(
			this.#material,
			"diffuseTexture",
			getMobSkin(options.skinPath),
		);

		let metadata = mesh.metadata as MetadataContainer | undefined;

		if (metadata === undefined) {
			metadata = new MetadataContainer();
			mesh.metadata = metadata as unknown as LiteMetadata;
		}

		metadata.set("mob", this);

		setThinInstances(mesh, this.#matrices, 0);

		const thinInstances = mesh.thinInstances as PackedThinInstances | undefined;

		if (thinInstances !== undefined) {
			thinInstances._capacity = this.#capacity;
			thinInstances.count = 0;
			thinInstances._dirtyMin = 0;
			thinInstances._dirtyMax = 0;

			if (this.#colors !== null) {
				thinInstances.colors = this.#colors;
				thinInstances._colorVersion = (thinInstances._colorVersion ?? 0) + 1;
				thinInstances._colorDirtyMin = 0;
				thinInstances._colorDirtyMax = 0;
			}
		}

		addToScene(Map1.mainScene, mesh);

		this.mesh = mesh;

		registerPool(this);
		this.#ensureInstancedGroupBuild();
	}

	get activeCount(): number {
		return this.#count;
	}

	/**
	 * Claim a lane for an owner.
	 *
	 * The caller must initialize its matrix before the next render.
	 */
	acquire(owner: MobOwner | null): InstanceSlotHandle {
		if (this.#count === this.#capacity) {
			this.#grow();
		}

		const index = this.#count;
		const holder: InstanceSlotHandle = {
			pool: this,
			index,
		};

		this.#count = index + 1;
		this.#laneHolders[index] = holder;
		this.#laneOwners[index] = owner;

		/*
		 * Mark the matrix because the new lane must be initialized by the
		 * caller. Also mark the count independently so count changes never
		 * depend on matrix dirty-range behavior.
		 */
		this.#markMatrixDirty(index);
		this.#markCountDirty();

		return holder;
	}

	/**
	 * Free a lane, compacting the final active lane into the resulting hole.
	 */
	release(holder: InstanceSlotHandle): void {
		const slot = holder.index;

		if (holder.pool !== this || slot < 0 || slot >= this.#count) {
			return;
		}

		const last = this.#count - 1;

		if (slot !== last) {
			this.#copyLane(last, slot);

			const movedHolder = this.#laneHolders[last];

			if (movedHolder !== null) {
				movedHolder.index = slot;
				this.#laneHolders[slot] = movedHolder;
			}

			this.#laneOwners[slot] = this.#laneOwners[last];
		}

		this.#laneHolders[last] = null;
		this.#laneOwners[last] = null;

		holder.index = -1;
		this.#count = last;

		/*
		 * When removing the last lane, no matrix or color data must be
		 * uploaded. Only the GPU draw count changes.
		 */
		this.#markCountDirty();
	}

	/**
	 * Compose translation and Y rotation into a lane's column-major matrix.
	 */
	writeMatrix(
		holder: InstanceSlotHandle,
		x: number,
		y: number,
		z: number,
		yaw: number,
	): void {
		const index = holder.index;

		if (!this.#isValidHolder(holder, index)) {
			return;
		}

		const cos = Math.cos(yaw);
		const sin = Math.sin(yaw);

		const matrices = this.#matrices;
		const offset = index * MAT4_FLOATS;

		matrices[offset] = cos;
		matrices[offset + 1] = 0;
		matrices[offset + 2] = -sin;
		matrices[offset + 3] = 0;

		matrices[offset + 4] = 0;
		matrices[offset + 5] = 1;
		matrices[offset + 6] = 0;
		matrices[offset + 7] = 0;

		matrices[offset + 8] = sin;
		matrices[offset + 9] = 0;
		matrices[offset + 10] = cos;
		matrices[offset + 11] = 0;

		matrices[offset + 12] = x;
		matrices[offset + 13] = y;
		matrices[offset + 14] = z;
		matrices[offset + 15] = 1;

		this.#markMatrixDirty(index);
	}

	writeColor(
		holder: InstanceSlotHandle,
		r: number,
		g: number,
		b: number,
		a = 1,
	): void {
		const colors = this.#colors;
		const index = holder.index;

		if (colors === null || !this.#isValidHolder(holder, index)) {
			return;
		}

		const offset = index * COLOR_FLOATS;

		colors[offset] = r;
		colors[offset + 1] = g;
		colors[offset + 2] = b;
		colors[offset + 3] = a;

		/*
		 * Color writes do not dirty the matrix buffer. The original code
		 * caused an unnecessary matrix version bump and potential upload.
		 */
		this.#markColorDirty(index);
	}

	/**
	 * Write a walk phase into the per-instance color alpha lane.
	 */
	writeWalkPhase(holder: InstanceSlotHandle, phase: number): void {
		const colors = this.#colors;
		const index = holder.index;

		if (colors === null || !this.#isValidHolder(holder, index)) {
			return;
		}

		colors[index * COLOR_FLOATS + 3] = phase;
		this.#markColorDirty(index);
	}

	/**
	 * Write lit RGB while preserving the walk-phase alpha channel.
	 */
	writeLitColor(
		holder: InstanceSlotHandle,
		r: number,
		g: number,
		b: number,
	): void {
		const colors = this.#colors;
		const index = holder.index;

		if (colors === null || !this.#isValidHolder(holder, index)) {
			return;
		}

		const offset = index * COLOR_FLOATS;

		colors[offset] = r;
		colors[offset + 1] = g;
		colors[offset + 2] = b;

		this.#markColorDirty(index);
	}

	readAlpha(holder: InstanceSlotHandle): number {
		const colors = this.#colors;
		const index = holder.index;

		if (colors === null || !this.#isValidHolder(holder, index)) {
			return 0;
		}

		return colors[index * COLOR_FLOATS + 3];
	}

	ownerAt(instanceIndex: number): MobOwner | null {
		if (
			!Number.isInteger(instanceIndex) ||
			instanceIndex < 0 ||
			instanceIndex >= this.#count
		) {
			return null;
		}

		return this.#laneOwners[instanceIndex];
	}

	/**
	 * Publish dirty CPU ranges to the thin-instance GPU uploader.
	 */
	sync(): void {
		if (!this.#needsSync) {
			return;
		}

		const thinInstances = this.mesh.thinInstances as
			| PackedThinInstances
			| undefined;

		if (thinInstances === undefined) {
			/*
			 * Keep the dirty state so a later sync can retry if the thin
			 * instance object is temporarily unavailable.
			 */
			return;
		}

		const matrixDirty = this.#dirtyMin < this.#dirtyMax;

		const colorDirty =
			this.#colors !== null && this.#colorDirtyMin < this.#colorDirtyMax;

		if (matrixDirty) {
			thinInstances.matrices = this.#matrices;

			const lo = Math.max(0, this.#dirtyMin);
			const hi = Math.min(this.#count, this.#dirtyMax);

			if (lo < hi) {
				thinInstances._dirtyMin = Math.min(thinInstances._dirtyMin, lo);

				thinInstances._dirtyMax = Math.max(thinInstances._dirtyMax, hi);

				thinInstances._version = (thinInstances._version ?? 0) + 1;
			}
		}

		if (colorDirty && this.#colors !== null) {
			thinInstances.colors = this.#colors;

			const lo = Math.max(0, this.#colorDirtyMin);
			const hi = Math.min(this.#count, this.#colorDirtyMax);

			if (lo < hi) {
				thinInstances._colorDirtyMin = Math.min(
					thinInstances._colorDirtyMin ?? Number.POSITIVE_INFINITY,
					lo,
				);

				thinInstances._colorDirtyMax = Math.max(
					thinInstances._colorDirtyMax ?? Number.NEGATIVE_INFINITY,
					hi,
				);

				thinInstances._colorVersion = (thinInstances._colorVersion ?? 0) + 1;
			}
		}

		if (this.#countDirty) {
			thinInstances.count = this.#count;
		}

		this.#dirtyMin = Number.POSITIVE_INFINITY;
		this.#dirtyMax = Number.NEGATIVE_INFINITY;

		this.#colorDirtyMin = Number.POSITIVE_INFINITY;
		this.#colorDirtyMax = Number.NEGATIVE_INFINITY;

		this.#countDirty = false;
		this.#needsSync = false;
	}

	#isValidHolder(holder: InstanceSlotHandle, index: number): boolean {
		return (
			holder.pool === this &&
			index >= 0 &&
			index < this.#count &&
			this.#laneHolders[index] === holder
		);
	}

	#copyLane(from: number, to: number): void {
		const matrixFrom = from * MAT4_FLOATS;
		const matrixTo = to * MAT4_FLOATS;

		this.#matrices.copyWithin(matrixTo, matrixFrom, matrixFrom + MAT4_FLOATS);

		this.#markMatrixDirty(to);

		const colors = this.#colors;

		if (colors !== null) {
			const colorFrom = from * COLOR_FLOATS;
			const colorTo = to * COLOR_FLOATS;

			colors.copyWithin(colorTo, colorFrom, colorFrom + COLOR_FLOATS);

			this.#markColorDirty(to);
		}
	}

	#grow(): void {
		const oldCapacity = this.#capacity;
		const newCapacity = Math.max(oldCapacity + 1, oldCapacity * 2);

		const matrices = new Float32Array(newCapacity * MAT4_FLOATS);
		matrices.set(this.#matrices);
		this.#matrices = matrices;

		if (this.#colors !== null) {
			const colors = new Float32Array(newCapacity * COLOR_FLOATS);
			colors.set(this.#colors);
			this.#colors = colors;
		}

		/*
		 * Adjusting length preserves existing entries without allocating a
		 * second null-filled array or spreading every lane as function
		 * arguments. Newly created array slots are assigned explicitly.
		 */
		this.#laneHolders.length = newCapacity;
		this.#laneOwners.length = newCapacity;

		for (let index = oldCapacity; index < newCapacity; index++) {
			this.#laneHolders[index] = null;
			this.#laneOwners[index] = null;
		}

		this.#capacity = newCapacity;

		setThinInstances(this.mesh, this.#matrices, this.#count);

		const thinInstances = this.mesh.thinInstances as
			| PackedThinInstances
			| undefined;

		if (thinInstances !== undefined) {
			thinInstances.matrices = this.#matrices;
			thinInstances._capacity = newCapacity;
			thinInstances.count = this.#count;

			thinInstances._dirtyMin = 0;
			thinInstances._dirtyMax = this.#count;
			thinInstances._version = (thinInstances._version ?? 0) + 1;

			if (this.#colors !== null) {
				thinInstances.colors = this.#colors;
				thinInstances._colorDirtyMin = 0;
				thinInstances._colorDirtyMax = this.#count;
				thinInstances._colorVersion = (thinInstances._colorVersion ?? 0) + 1;
			}
		}

		/*
		 * The resized arrays were already rebound above. Clear local dirty
		 * ranges rather than forcing the next sync to upload them again.
		 */
		this.#dirtyMin = Number.POSITIVE_INFINITY;
		this.#dirtyMax = Number.NEGATIVE_INFINITY;

		this.#colorDirtyMin = Number.POSITIVE_INFINITY;
		this.#colorDirtyMax = Number.NEGATIVE_INFINITY;

		this.#countDirty = false;
	}

	#markMatrixDirty(index: number): void {
		if (index < this.#dirtyMin) {
			this.#dirtyMin = index;
		}

		const end = index + 1;

		if (end > this.#dirtyMax) {
			this.#dirtyMax = end;
		}

		this.#needsSync = true;
	}

	#markColorDirty(index: number): void {
		if (index < this.#colorDirtyMin) {
			this.#colorDirtyMin = index;
		}

		const end = index + 1;

		if (end > this.#colorDirtyMax) {
			this.#colorDirtyMax = end;
		}

		this.#needsSync = true;
	}

	#markCountDirty(): void {
		this.#countDirty = true;
		this.#needsSync = true;
	}

	#ensureInstancedGroupBuild(): void {
		const buildGroup = (
			this.#material as unknown as {
				_buildGroup?: (scene: unknown, meshes: unknown[]) => Promise<unknown>;
			}
		)._buildGroup;

		if (typeof buildGroup !== "function") {
			return;
		}

		void buildGroup(Map1.mainScene, [this.mesh]).catch((error: unknown) => {
			console.error("[mobs] instanced material group build failed", error);
		});
	}
}

// Registry and per-frame synchronization

const livePools = new Set<MobInstancePool>();
const poolByMesh = new Map<Mesh, MobInstancePool>();

let syncObserverRegistered = false;

function registerPool(pool: MobInstancePool): void {
	livePools.add(pool);
	poolByMesh.set(pool.mesh, pool);

	if (syncObserverRegistered) {
		return;
	}

	syncObserverRegistered = true;

	onBeforeRender(Map1.mainScene, () => {
		for (const livePool of livePools) {
			livePool.sync();
		}
	});
}

/**
 * Map a GPU thin-instance pick result back to its owning mob.
 */
export function resolveMobFromPick(
	mesh: Mesh,
	thinInstanceIndex: number,
): MobOwner | null {
	const pool = poolByMesh.get(mesh);

	return pool?.ownerAt(thinInstanceIndex) ?? null;
}
