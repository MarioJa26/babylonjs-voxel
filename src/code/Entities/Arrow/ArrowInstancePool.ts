import {
	addToScene,
	createMeshFromData,
	createShaderMaterial,
	type Mesh,
	onBeforeRender,
	type ShaderMaterial,
	setThinInstances,
} from "@babylonjs/lite";
import type { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import { getBoxGeometry } from "../Mobs/MobMesh";

const ARROW_WIDTH = 0.06;
const ARROW_HEIGHT = 0.06;
const ARROW_LENGTH = 0.55;

const MAT4_FLOATS = 16;
const COLOR_FLOATS = 4;
const DEFAULT_INITIAL_CAPACITY = 32;

/**
 * Per-instance thin-instance pool for every arrow in flight.
 *
 * All arrows (any material type) render through ONE shared box mesh instead of
 * each owning its own mesh. The per-instance color buffer carries each arrow's
 * type tint, so instances are individually recolorable (see `writeColor` /
 * `Arrow.recolor`). Each arrow owns a lane and writes its world matrix (full
 * rotation from a quaternion — arrows point in arbitrary directions) into it; a
 * per-frame sync uploads only dirty lanes.
 *
 * Internal thin-instance fields (`_capacity`, `_dirtyMin`, `_dirtyMax`,
 * `_version`, `_colorVersion`, ...) are not in the public typings — same local
 * shape as MobInstancePool / PackedChunkMesh.
 */
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

/** Mutable slot reference handed to an arrow; the pool rewrites `index` when a
 * lane is compacted on release, so arrows never store raw lane numbers. */
export type InstanceSlotHandle = {
	pool: ArrowInstancePool;
	/** Active lane, or -1 once released. */
	index: number;
};

const ARROW_VERTEX_WGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vNormal : vec3<f32>,
  @location(1) vTint : vec3<f32>,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  let instanceWorld = mat4x4<f32>(input.world0, input.world1, input.world2, input.world3);
  out.pos = shaderSystem.viewProjection * (instanceWorld * vec4<f32>(input.position, 1.0));
  out.vNormal = (instanceWorld * vec4<f32>(input.normal, 0.0)).xyz;
  out.vTint = input.instanceColor.rgb;
  return out;
}
`;

const ARROW_FRAGMENT_WGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vNormal : vec3<f32>,
  @location(1) vTint : vec3<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let n = normalize(in.vNormal);
  let light = clamp(0.45 + 0.55 * n.y, 0.0, 1.0);
  return vec4<f32>(in.vTint * light, 1.0);
}
`;

function createArrowMaterial(): ShaderMaterial {
	return createShaderMaterial({
		name: "arrowInstancedMat",
		vertexSource: ARROW_VERTEX_WGSL,
		fragmentSource: ARROW_FRAGMENT_WGSL,
		attributes: ["position", "normal"],
		uniforms: ["viewProjection"],
		useThinInstanceColors: true,
		backFaceCulling: true,
	});
}

export class ArrowInstancePool {
	readonly mesh: Mesh;

	#material: ShaderMaterial;
	#matrices: Float32Array;
	#colors: Float32Array;
	#laneHolders: (InstanceSlotHandle | null)[];
	#capacity: number;
	#count = 0;
	#dirtyMin = Number.POSITIVE_INFINITY;
	#dirtyMax = Number.NEGATIVE_INFINITY;
	#colorDirtyMin = Number.POSITIVE_INFINITY;
	#colorDirtyMax = Number.NEGATIVE_INFINITY;
	#needsSync = false;

	constructor() {
		this.#capacity = DEFAULT_INITIAL_CAPACITY;
		this.#matrices = new Float32Array(this.#capacity * MAT4_FLOATS);
		this.#colors = new Float32Array(this.#capacity * COLOR_FLOATS);
		this.#laneHolders = new Array(this.#capacity).fill(null);

		const geometry = getBoxGeometry(ARROW_WIDTH, ARROW_HEIGHT, ARROW_LENGTH);

		const mesh = createMeshFromData(
			Map1.engine,
			"arrowMesh",
			geometry.positions,
			geometry.normals,
			geometry.indices,
		);
		mesh.pickable = false;
		mesh.renderOrder = 1;

		this.#material = createArrowMaterial();
		mesh.material = this.#material;

		// Seed thin instances at count 0 — lanes sync in per frame.
		setThinInstances(mesh, this.#matrices, 0);
		const ti = mesh.thinInstances as PackedThinInstances | undefined;
		if (ti) {
			ti.colors = this.#colors;
			ti._colorVersion = (ti._colorVersion ?? 0) + 1;
			ti._capacity = this.#capacity;
			ti.count = 0;
			ti._dirtyMin = 0;
			ti._dirtyMax = 0;
		}

		addToScene(Map1.mainScene, mesh);
		this.mesh = mesh;

		registerPool(this);
		this.#ensureInstancedGroupBuild(mesh);
	}

	/**
	 * Scene-registered ShaderMaterial groups only run their deferred builder
	 * once; later meshes fall back to a `_rebuildSingle` that is only captured
	 * by an instanced group build. Without this force-build, the pooled mesh
	 * silently never renders (same fix as MobInstancePool /
	 * PackedChunkMesh.ensureInstancedBuild).
	 */
	#ensureInstancedGroupBuild(mesh: Mesh): void {
		const bg = (
			this.#material as unknown as {
				_buildGroup?: (scene: unknown, meshes: unknown[]) => Promise<unknown>;
			}
		)._buildGroup;
		if (typeof bg === "function") {
			void bg(Map1.mainScene, [mesh]).catch(() => {});
		}
	}

	get activeCount(): number {
		return this.#count;
	}

	/** Claim a lane for an arrow of the given tint. Call `writeMatrix` before
	 * first render (the constructor does this). */
	acquire(color: Color3): InstanceSlotHandle {
		if (this.#count === this.#capacity) {
			this.#grow();
		}

		const index = this.#count++;
		const holder: InstanceSlotHandle = { pool: this, index };
		this.#laneHolders[index] = holder;
		this.#writeColor(holder, color.r, color.g, color.b, 1);
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
		}

		this.#laneHolders[last] = null;
		holder.index = -1;
		this.#count--;
		this.#markDirty(slot);
	}

	/**
	 * Compose translation + full rotation (from a unit quaternion) into the
	 * lane's matrix. Arrows point in arbitrary directions, so a Y-rotation-only
	 * matrix is not enough — the quaternion is expanded into a 3x3 rotation.
	 */
	writeMatrix(
		holder: InstanceSlotHandle,
		px: number,
		py: number,
		pz: number,
		qx: number,
		qy: number,
		qz: number,
		qw: number,
	): void {
		const index = holder.index;
		if (holder.pool !== this || index < 0 || index >= this.#count) return;

		const x2 = qx + qx;
		const y2 = qy + qy;
		const z2 = qz + qz;
		const xx = qx * x2;
		const xy = qx * y2;
		const xz = qx * z2;
		const yy = qy * y2;
		const yz = qy * z2;
		const zz = qz * z2;
		const wx = qw * x2;
		const wy = qw * y2;
		const wz = qw * z2;

		const r00 = 1 - (yy + zz);
		const r01 = xy - wz;
		const r02 = xz + wy;
		const r10 = xy + wz;
		const r11 = 1 - (xx + zz);
		const r12 = yz - wx;
		const r20 = xz - wy;
		const r21 = yz + wx;
		const r22 = 1 - (xx + yy);

		const m = this.#matrices;
		const o = index * MAT4_FLOATS;

		// Column-major: col0, col1, col2, col3 (translation).
		m[o] = r00;
		m[o + 1] = r10;
		m[o + 2] = r20;
		m[o + 3] = 0;

		m[o + 4] = r01;
		m[o + 5] = r11;
		m[o + 6] = r21;
		m[o + 7] = 0;

		m[o + 8] = r02;
		m[o + 9] = r12;
		m[o + 10] = r22;
		m[o + 11] = 0;

		m[o + 12] = px;
		m[o + 13] = py;
		m[o + 14] = pz;
		m[o + 15] = 1;

		this.#markDirty(index);
	}

	/** Recolor an instance (per-instance color buffer). Enables live recolor. */
	writeColor(
		holder: InstanceSlotHandle,
		r: number,
		g: number,
		b: number,
		a = 1,
	): void {
		const index = holder.index;
		if (holder.pool !== this || index < 0 || index >= this.#count) return;
		this.#writeColor(holder, r, g, b, a);
	}

	#writeColor(
		holder: InstanceSlotHandle,
		r: number,
		g: number,
		b: number,
		a: number,
	): void {
		const index = holder.index;
		if (index < 0 || index >= this.#count) return;

		const o = index * COLOR_FLOATS;
		this.#colors[o] = r;
		this.#colors[o + 1] = g;
		this.#colors[o + 2] = b;
		this.#colors[o + 3] = a;
		this.#markColorDirty(index);
	}

	sync(): void {
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
			// _gpuVersion. Direct array mutation must bump it or the snapshot
			// freezes after the first upload.
			ti._version = (ti._version ?? 0) + 1;
		}
		this.#dirtyMin = Number.POSITIVE_INFINITY;
		this.#dirtyMax = Number.NEGATIVE_INFINITY;

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
			// never refreshes the color buffer.
			ti._colorVersion = (ti._colorVersion ?? 0) + 1;
		}
		this.#colorDirtyMin = Number.POSITIVE_INFINITY;
		this.#colorDirtyMax = Number.NEGATIVE_INFINITY;

		ti.count = this.#count;
	}

	#copyLane(from: number, to: number): void {
		this.#matrices.copyWithin(
			to * MAT4_FLOATS,
			from * MAT4_FLOATS,
			from * MAT4_FLOATS + MAT4_FLOATS,
		);

		this.#colors.copyWithin(
			to * COLOR_FLOATS,
			from * COLOR_FLOATS,
			from * COLOR_FLOATS + COLOR_FLOATS,
		);

		this.#markDirty(to);
		this.#markColorDirty(to);
	}

	#grow(): void {
		const newCapacity = this.#capacity * 2;

		const matrices = new Float32Array(newCapacity * MAT4_FLOATS);
		matrices.set(this.#matrices);
		this.#matrices = matrices;

		const colors = new Float32Array(newCapacity * COLOR_FLOATS);
		colors.set(this.#colors);
		this.#colors = colors;

		const laneHolders: (InstanceSlotHandle | null)[] = new Array(
			newCapacity,
		).fill(null);
		laneHolders.splice(0, this.#laneHolders.length, ...this.#laneHolders);
		this.#laneHolders = laneHolders;

		this.#capacity = newCapacity;

		// Rebind the CPU arrays; the version bumps force full GPU re-uploads
		// of every active lane into the resized buffers.
		setThinInstances(this.mesh, this.#matrices, this.#count);
		const ti = this.mesh.thinInstances as PackedThinInstances | undefined;
		if (ti) {
			ti.colors = this.#colors;
			ti._colorVersion = (ti._colorVersion ?? 0) + 1;
			ti._colorDirtyMin = 0;
			ti._colorDirtyMax = this.#count;
			ti._capacity = newCapacity;
		}

		this.#dirtyMin = 0;
		this.#dirtyMax = this.#count;
		this.#colorDirtyMin = 0;
		this.#colorDirtyMax = this.#count;
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
}

// ─── Registry + per-frame sync ──────────────────────────────────────────────

const livePools = new Set<ArrowInstancePool>();
let syncObserverRegistered = false;

function registerPool(pool: ArrowInstancePool): void {
	livePools.add(pool);

	if (syncObserverRegistered) return;
	syncObserverRegistered = true;

	onBeforeRender(Map1.mainScene, () => {
		for (const pool of livePools) {
			pool.sync();
		}
	});
}

let arrowPool: ArrowInstancePool | null = null;

/** Lazily create (and reuse) the single shared arrow instance pool. */
export function getArrowInstancePool(): ArrowInstancePool {
	if (arrowPool === null) {
		arrowPool = new ArrowInstancePool();
	}
	return arrowPool;
}
