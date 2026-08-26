import {
	addToScene,
	createMeshFromData,
	type LiteMetadata,
	loadTexture2D,
	type Mesh,
	onBeforeRender,
	setShaderTexture,
	setThinInstances,
} from "@babylonjs/lite";
import { MetadataContainer } from "@/code/Entities/MetadataContainer";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import {
	buildMobModelGeometry,
	createInstancedMobAtlasMaterial,
	MOB_SKIN_PATH,
	type MobPartSpec,
} from "./MobMesh";
import type { NeutralMob } from "./NeutralMob";

/**
 * Per-species thin-instance pools for mob rendering.
 *
 * Every chicken/sheep renders through ONE shared mesh per body part instead of
 * owning individual meshes: all chickens share a single instanced body mesh
 * (plus one for heads), all sheep share a single instanced body mesh whose
 * wool color comes from the per-instance color buffer. Each mob owns slots in
 * the pools and writes its world matrix into its slot; a per-frame sync
 * uploads only dirty lanes.
 *
 * Internal thin-instance fields (`_capacity`, `_dirtyMin`, `_dirtyMax`) are
 * not in the public typings — same local shape as PackedChunkMesh's PackedMesh.
 */
type PackedThinInstances = {
	matrices: Float32Array;
	colors?: Float32Array | null;
	count: number;
	_capacity?: number;
	_dirtyMin: number;
	_dirtyMax: number;
	/** Instance-data versioning — lite's own mutator helpers bump _version on
	 * every write; direct array mutation must do the same or the GPU uploader
	 * (which only runs when _version !== _gpuVersion) freezes after the first
	 * upload. Same protocol for colors via _colorVersion. */
	_version?: number;
	_colorVersion?: number;
	_colorGpuVersion?: number;
	_colorDirtyMin?: number;
	_colorDirtyMax?: number;
};

/** Mutable slot reference handed to a mob; the pool rewrites `index` when a
 * lane is compacted on release, so mobs never store raw lane numbers. */
export type InstanceSlotHandle = {
	pool: MobInstancePool;
	/** Active lane, or -1 once released. */
	index: number;
};

const MAT4_FLOATS = 16;
const COLOR_FLOATS = 4;
const DEFAULT_INITIAL_CAPACITY = 16;

type MobInstancePoolOptions = {
	name: string;
	/** Boxes making up the animal model (body, head, legs, wings...). */
	parts: readonly MobPartSpec[];
	/**
	 * Tint each instance from the per-instance color buffer (e.g. sheep wool
	 * colors). When false, `tint` (default white) multiplies the texture.
	 */
	instanceColors?: boolean;
	tint?: Color3;
	initialCapacity?: number;
};

export class MobInstancePool {
	readonly mesh: Mesh;

	#material: ReturnType<typeof createInstancedMobAtlasMaterial>;
	#matrices: Float32Array;
	#colors: Float32Array | null;
	#laneHolders: (InstanceSlotHandle | null)[];
	#laneOwners: (NeutralMob | null)[];
	#capacity: number;
	#count = 0;
	#dirtyMin = Number.POSITIVE_INFINITY;
	#dirtyMax = Number.NEGATIVE_INFINITY;
	#colorDirtyMin = Number.POSITIVE_INFINITY;
	#colorDirtyMax = Number.NEGATIVE_INFINITY;
	#needsSync = false;

	constructor(options: MobInstancePoolOptions) {
		this.#capacity = options.initialCapacity ?? DEFAULT_INITIAL_CAPACITY;
		this.#matrices = new Float32Array(this.#capacity * MAT4_FLOATS);
		this.#colors = options.instanceColors
			? new Float32Array(this.#capacity * COLOR_FLOATS)
			: null;
		this.#laneHolders = new Array(this.#capacity).fill(null);
		this.#laneOwners = new Array(this.#capacity).fill(null);

		const geometry = buildMobModelGeometry(options.parts);

		const mesh = createMeshFromData(
			Map1.engine,
			options.name,
			geometry.positions,
			geometry.normals,
			geometry.indices,
			geometry.uvs,
		);
		mesh.pickable = true;
		mesh.renderOrder = 1;

		this.#material = createInstancedMobAtlasMaterial(
			`${options.name}Mat`,
			!!options.instanceColors,
			options.tint ?? Color3.White(),
		);
		mesh.material = this.#material;
		this.#bindDiffuseTexture();

		let meta = mesh.metadata as MetadataContainer | undefined;
		if (!meta) {
			meta = new MetadataContainer();
			mesh.metadata = meta as unknown as LiteMetadata;
		}
		meta.set("mob", this);

		// Seed count-0 instances so an empty pool draws nothing (without
		// thinInstances the base box itself would render at the origin).
		setThinInstances(mesh, this.#matrices, 0);
		const ti = mesh.thinInstances as PackedThinInstances | undefined;
		if (ti) {
			if (this.#colors) {
				ti.colors = this.#colors;
				// Bump the color version or the GPU uploader never creates the
				// color buffer → its vertex slot goes unset → WebGPU draw error.
				ti._colorVersion = (ti._colorVersion ?? 0) + 1;
			}
			ti._capacity = this.#capacity;
			ti.count = 0;
			ti._dirtyMin = 0;
			ti._dirtyMax = 0;
		}

		addToScene(Map1.mainScene, mesh);
		this.mesh = mesh;

		registerPool(this);
		this.#ensureInstancedGroupBuild();
	}

	/** Scene-registered ShaderMaterial groups only run their deferred builder
	 * once; later meshes fall back to a `_rebuildSingle` that is only captured
	 * by an instanced group build. Without this force-build, every pooled mesh
	 * AFTER the first one silently never renders (same fix as
	 * PackedChunkMesh.ensureInstancedBuild). */
	#ensureInstancedGroupBuild(): void {
		const bg = (
			this.#material as unknown as {
				_buildGroup?: (scene: unknown, meshes: unknown[]) => Promise<unknown>;
			}
		)._buildGroup;
		if (typeof bg === "function") {
			void bg(Map1.mainScene, [this.mesh]).catch(() => {});
		}
	}

	get activeCount(): number {
		return this.#count;
	}

	/** Claim a lane for `owner` (null for non-interactive remote mobs).
	 * Call {@link writeMatrix} before first render. */
	acquire(owner: NeutralMob | null): InstanceSlotHandle {
		if (this.#count === this.#capacity) {
			this.#grow();
		}

		const index = this.#count++;
		const holder: InstanceSlotHandle = { pool: this, index };
		this.#laneHolders[index] = holder;
		this.#laneOwners[index] = owner;
		this.#markDirty(index);

		return holder;
	}

	/** Free a lane, compacting the last active lane into the hole. */
	release(holder: InstanceSlotHandle): void {
		if (holder.pool !== this) return;

		const slot = holder.index;
		if (slot < 0 || slot >= this.#count) return;

		const last = this.#count - 1;

		if (slot !== last) {
			this.#copyLane(last, slot);

			const movedHolder = this.#laneHolders[last];
			if (movedHolder) {
				movedHolder.index = slot;
				this.#laneHolders[slot] = movedHolder;
			}
			this.#laneOwners[slot] = this.#laneOwners[last];
		}

		this.#laneHolders[last] = null;
		this.#laneOwners[last] = null;
		holder.index = -1;
		this.#count--;
		this.#markDirty(slot);
	}

	/** Compose translation + Y rotation into the lane's matrix (column-major:
	 * local +Z maps to (sin yaw, 0, cos yaw) — matches NeutralMob facing). */
	writeMatrix(
		holder: InstanceSlotHandle,
		x: number,
		y: number,
		z: number,
		yaw: number,
	): void {
		const index = holder.index;
		if (holder.pool !== this || index < 0 || index >= this.#count) return;

		const cos = Math.cos(yaw);
		const sin = Math.sin(yaw);
		const m = this.#matrices;
		const o = index * MAT4_FLOATS;

		m[o] = cos;
		m[o + 1] = 0;
		m[o + 2] = -sin;
		m[o + 3] = 0;

		m[o + 4] = 0;
		m[o + 5] = 1;
		m[o + 6] = 0;
		m[o + 7] = 0;

		m[o + 8] = sin;
		m[o + 9] = 0;
		m[o + 10] = cos;
		m[o + 11] = 0;

		m[o + 12] = x;
		m[o + 13] = y;
		m[o + 14] = z;
		m[o + 15] = 1;

		this.#markDirty(index);
	}

	writeColor(
		holder: InstanceSlotHandle,
		r: number,
		g: number,
		b: number,
		a = 1,
	): void {
		if (!this.#colors) return;

		const index = holder.index;
		if (holder.pool !== this || index < 0 || index >= this.#count) return;

		const o = index * COLOR_FLOATS;
		this.#colors[o] = r;
		this.#colors[o + 1] = g;
		this.#colors[o + 2] = b;
		this.#colors[o + 3] = a;
		this.#markDirty(index);
		this.#markColorDirty(index);
	}

	ownerAt(instanceIndex: number): NeutralMob | null {
		if (instanceIndex < 0 || instanceIndex >= this.#count) return null;
		return this.#laneOwners[instanceIndex] ?? null;
	}

	sync(): void {
		// Retry until the async atlas pack has finished; cheap null check.
		this.#bindDiffuseTexture();

		if (!this.#needsSync) return;
		this.#needsSync = false;

		const ti = this.mesh.thinInstances as PackedThinInstances | undefined;
		if (!ti) return;

		ti.matrices = this.#matrices;
		if (Number.isFinite(this.#dirtyMin)) {
			const lo = Math.max(0, this.#dirtyMin);
			const hi = Math.min(this.#count, this.#dirtyMax);
			if (hi > lo) {
				ti._dirtyMin = Math.min(ti._dirtyMin, lo);
				ti._dirtyMax = Math.max(ti._dirtyMax, hi);
			}
			// MANDATORY: the GPU uploader only runs while _version differs from
			// _gpuVersion (thin-instance-gpu.js). Lite's own mutator helpers bump
			// it on every write; direct array mutation must do the same or the
			// GPU snapshot freezes after the first upload.
			ti._version = (ti._version ?? 0) + 1;
		}
		this.#dirtyMin = Number.POSITIVE_INFINITY;
		this.#dirtyMax = Number.NEGATIVE_INFINITY;

		if (this.#colors) {
			ti.colors = this.#colors;

			if (Number.isFinite(this.#colorDirtyMin)) {
				const lo = Math.max(0, this.#colorDirtyMin);
				const hi = Math.min(this.#count, this.#colorDirtyMax);
				if (hi > lo) {
					ti._colorDirtyMin = Math.min(
						ti._colorDirtyMin ?? Number.POSITIVE_INFINITY,
						lo,
					);
					ti._colorDirtyMax = Math.max(
						ti._colorDirtyMax ?? Number.NEGATIVE_INFINITY,
						hi,
					);
				}
				// Same protocol as matrices: without a version bump the uploader
				// never creates/refreshes the color buffer (slot-4 error).
				ti._colorVersion = (ti._colorVersion ?? 0) + 1;
			}
			this.#colorDirtyMin = Number.POSITIVE_INFINITY;
			this.#colorDirtyMax = Number.NEGATIVE_INFINITY;
		}

		ti.count = this.#count;
	}

	#copyLane(from: number, to: number): void {
		this.#matrices.copyWithin(
			to * MAT4_FLOATS,
			from * MAT4_FLOATS,
			from * MAT4_FLOATS + MAT4_FLOATS,
		);

		if (this.#colors) {
			this.#colors.copyWithin(
				to * COLOR_FLOATS,
				from * COLOR_FLOATS,
				from * COLOR_FLOATS + COLOR_FLOATS,
			);
		}

		this.#markDirty(to);
		this.#markColorDirty(to);
	}

	#grow(): void {
		const newCapacity = this.#capacity * 2;

		const matrices = new Float32Array(newCapacity * MAT4_FLOATS);
		matrices.set(this.#matrices);
		this.#matrices = matrices;

		if (this.#colors) {
			const colors = new Float32Array(newCapacity * COLOR_FLOATS);
			colors.set(this.#colors);
			this.#colors = colors;
		}

		const laneHolders: (InstanceSlotHandle | null)[] = new Array(
			newCapacity,
		).fill(null);
		laneHolders.splice(0, this.#laneHolders.length, ...this.#laneHolders);
		this.#laneHolders = laneHolders;

		const laneOwners: (NeutralMob | null)[] = new Array(newCapacity).fill(null);
		laneOwners.splice(0, this.#laneOwners.length, ...this.#laneOwners);
		this.#laneOwners = laneOwners;

		this.#capacity = newCapacity;

		// Rebind the CPU arrays; the version bumps force full GPU re-uploads
		// of every active lane into the resized buffers.
		setThinInstances(this.mesh, this.#matrices, this.#count);
		const ti = this.mesh.thinInstances as PackedThinInstances | undefined;
		if (ti) {
			if (this.#colors) {
				ti.colors = this.#colors;
				ti._colorVersion = (ti._colorVersion ?? 0) + 1;
				ti._colorDirtyMin = 0;
				ti._colorDirtyMax = this.#count;
			}
			ti._capacity = newCapacity;
		}

		this.#dirtyMin = 0;
		this.#dirtyMax = this.#count;
		this.#markColorDirtyRange();
	}

	#markDirty(index: number): void {
		if (index < this.#dirtyMin) this.#dirtyMin = index;
		if (index + 1 > this.#dirtyMax) this.#dirtyMax = index + 1;
		this.#needsSync = true;
	}

	#markColorDirty(index: number): void {
		if (index < this.#colorDirtyMin) this.#colorDirtyMin = index;
		if (index + 1 > this.#colorDirtyMax) this.#colorDirtyMax = index + 1;
		this.#needsSync = true;
	}

	#markColorDirtyRange(): void {
		this.#colorDirtyMin = 0;
		this.#colorDirtyMax = this.#count;
		this.#needsSync = true;
	}

	/** Load and bind the dedicated mob skin exactly once (same pattern as
	 * PlayerModel's skin loading). Bind EXACTLY once — rebinding bumps lite's
	 * visibility epoch and forces mesh rebuilds (see PackedChunkMesh). */
	#diffuseBound = false;
	#skinLoadStarted = false;
	#bindDiffuseTexture(): void {
		if (this.#diffuseBound || this.#skinLoadStarted) return;
		this.#skinLoadStarted = true;

		const material = this.#material;
		void loadTexture2D(Map1.engine, MOB_SKIN_PATH, {
			mipMaps: true,
			magFilter: "nearest",
			minFilter: "nearest",
		})
			.catch(() => null)
			.then((tex) => {
				if (!tex) {
					console.error(`[mobs] failed to load ${MOB_SKIN_PATH}`);
					return;
				}
				setShaderTexture(material, "diffuseTexture", tex);
				this.#diffuseBound = true;
				console.debug("[mobs] mob skin bound:", MOB_SKIN_PATH);
			});
	}
}

// ─── Registry + per-frame sync ──────────────────────────────────────────────

const livePools = new Set<MobInstancePool>();
const poolByMesh = new Map<Mesh, MobInstancePool>();
let syncObserverRegistered = false;

function registerPool(pool: MobInstancePool): void {
	livePools.add(pool);
	poolByMesh.set(pool.mesh, pool);

	if (syncObserverRegistered) return;
	syncObserverRegistered = true;

	// Registered after NeutralMob's tick observer (first mob construction
	// precedes first pool construction), so lanes sync after AI updates.
	onBeforeRender(Map1.mainScene, () => {
		for (const pool of livePools) {
			pool.sync();
		}
	});
}

/** Map a GPU pick result on a pooled mob mesh back to its owning mob. */
export function resolveMobFromPick(
	mesh: Mesh,
	thinInstanceIndex: number,
): NeutralMob | null {
	const pool = poolByMesh.get(mesh);
	if (!pool) return null;
	return pool.ownerAt(thinInstanceIndex);
}
