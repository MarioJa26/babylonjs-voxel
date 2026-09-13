import {
	addToScene,
	createMeshFromData,
	createShaderMaterial,
	type Mesh,
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

type PackedThinInstances = {
	matrices: Float32Array;
	colors?: Float32Array | null;
	count: number;
	_capacity?: number;

	_dirtyMin?: number;
	_dirtyMax?: number;
	_version?: number;
	_gpuVersion?: number;

	_colorVersion?: number;
	_colorGpuVersion?: number;
	_colorDirtyMin?: number;
	_colorDirtyMax?: number;
};

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
  let instanceWorld = mat4x4<f32>(
    input.world0,
    input.world1,
    input.world2,
    input.world3
  );

  out.pos =
    shaderSystem.viewProjection *
    (instanceWorld * vec4<f32>(input.position, 1.0));

  out.vNormal =
    (instanceWorld * vec4<f32>(input.normal, 0.0)).xyz;

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
		this.#matrices = new Float32Array(DEFAULT_INITIAL_CAPACITY * MAT4_FLOATS);
		this.#colors = new Float32Array(DEFAULT_INITIAL_CAPACITY * COLOR_FLOATS);
		this.#laneHolders = new Array<InstanceSlotHandle | null>(
			DEFAULT_INITIAL_CAPACITY,
		).fill(null);

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

		setThinInstances(mesh, this.#matrices, 0);

		const thinInstances = mesh.thinInstances as PackedThinInstances | undefined;

		if (thinInstances) {
			thinInstances.colors = this.#colors;
			thinInstances.count = 0;
			thinInstances._capacity = this.#capacity;

			thinInstances._dirtyMin = 0;
			thinInstances._dirtyMax = 0;

			thinInstances._colorDirtyMin = 0;
			thinInstances._colorDirtyMax = 0;
			thinInstances._colorVersion = (thinInstances._colorVersion ?? 0) + 1;
		}

		addToScene(Map1.mainScene, mesh);

		this.mesh = mesh;

		this.#ensureInstancedGroupBuild(mesh);
	}

	#ensureInstancedGroupBuild(mesh: Mesh): void {
		const buildGroup = (
			this.#material as unknown as {
				_buildGroup?: (scene: unknown, meshes: unknown[]) => Promise<unknown>;
			}
		)._buildGroup;

		if (typeof buildGroup === "function") {
			void buildGroup(Map1.mainScene, [mesh]).catch(() => {
				// Preserve the existing non-fatal deferred build behavior.
			});
		}
	}

	get activeCount(): number {
		return this.#count;
	}

	acquire(color: Color3): InstanceSlotHandle {
		if (this.#count >= this.#capacity) {
			this.#grow();
		}

		const index = this.#count;
		this.#count = index + 1;

		const holder: InstanceSlotHandle = {
			pool: this,
			index,
		};

		this.#laneHolders[index] = holder;

		const colorOffset = index * COLOR_FLOATS;
		const colors = this.#colors;

		colors[colorOffset] = color.r;
		colors[colorOffset + 1] = color.g;
		colors[colorOffset + 2] = color.b;
		colors[colorOffset + 3] = 1;

		this.#markColorDirty(index);
		this.#markMatrixDirty(index);

		return holder;
	}

	release(holder: InstanceSlotHandle): void {
		if (holder.pool !== this) {
			return;
		}

		const slot = holder.index;
		const count = this.#count;

		if (slot < 0 || slot >= count) {
			return;
		}

		const last = count - 1;

		if (slot !== last) {
			this.#copyLane(last, slot);

			const movedHolder = this.#laneHolders[last];

			if (movedHolder !== null) {
				movedHolder.index = slot;
				this.#laneHolders[slot] = movedHolder;
			}
		}

		this.#laneHolders[last] = null;
		holder.index = -1;
		this.#count = last;

		/*
		 * A release must schedule a sync even when the removed instance was
		 * already the final lane. In that case no matrix or color data needs
		 * uploading, but the GPU-visible instance count must still change.
		 */
		this.#needsSync = true;
	}

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
		if (holder.pool !== this) {
			return;
		}

		const index = holder.index;

		if (index < 0 || index >= this.#count) {
			return;
		}

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

		const offset = index * MAT4_FLOATS;
		const matrices = this.#matrices;

		/*
		 * Column-major affine rotation and translation matrix.
		 *
		 * col0
		 */
		matrices[offset] = 1 - (yy + zz);
		matrices[offset + 1] = xy + wz;
		matrices[offset + 2] = xz - wy;
		matrices[offset + 3] = 0;

		// col1
		matrices[offset + 4] = xy - wz;
		matrices[offset + 5] = 1 - (xx + zz);
		matrices[offset + 6] = yz + wx;
		matrices[offset + 7] = 0;

		// col2
		matrices[offset + 8] = xz + wy;
		matrices[offset + 9] = yz - wx;
		matrices[offset + 10] = 1 - (xx + yy);
		matrices[offset + 11] = 0;

		// col3
		matrices[offset + 12] = px;
		matrices[offset + 13] = py;
		matrices[offset + 14] = pz;
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
		if (holder.pool !== this) {
			return;
		}

		const index = holder.index;

		if (index < 0 || index >= this.#count) {
			return;
		}

		const offset = index * COLOR_FLOATS;
		const colors = this.#colors;

		colors[offset] = r;
		colors[offset + 1] = g;
		colors[offset + 2] = b;
		colors[offset + 3] = a;

		this.#markColorDirty(index);
	}

	sync(): void {
		if (!this.#needsSync) {
			return;
		}

		const thinInstances = this.mesh.thinInstances as
			| PackedThinInstances
			| undefined;

		if (!thinInstances) {
			/*
			 * Keep the sync pending in case the thin-instance object becomes
			 * available on a later frame.
			 */
			return;
		}

		this.#needsSync = false;

		const count = this.#count;

		if (this.#dirtyMin !== Number.POSITIVE_INFINITY) {
			const low = Math.max(0, this.#dirtyMin);
			const high = Math.min(count, this.#dirtyMax);

			if (high > low) {
				thinInstances.matrices = this.#matrices;
				thinInstances._dirtyMin = Math.min(
					thinInstances._dirtyMin ?? Number.POSITIVE_INFINITY,
					low,
				);
				thinInstances._dirtyMax = Math.max(
					thinInstances._dirtyMax ?? Number.NEGATIVE_INFINITY,
					high,
				);
				thinInstances._version = (thinInstances._version ?? 0) + 1;
			}

			this.#dirtyMin = Number.POSITIVE_INFINITY;
			this.#dirtyMax = Number.NEGATIVE_INFINITY;
		}

		if (this.#colorDirtyMin !== Number.POSITIVE_INFINITY) {
			const low = Math.max(0, this.#colorDirtyMin);
			const high = Math.min(count, this.#colorDirtyMax);

			if (high > low) {
				thinInstances.colors = this.#colors;
				thinInstances._colorDirtyMin = Math.min(
					thinInstances._colorDirtyMin ?? Number.POSITIVE_INFINITY,
					low,
				);
				thinInstances._colorDirtyMax = Math.max(
					thinInstances._colorDirtyMax ?? Number.NEGATIVE_INFINITY,
					high,
				);
				thinInstances._colorVersion = (thinInstances._colorVersion ?? 0) + 1;
			}

			this.#colorDirtyMin = Number.POSITIVE_INFINITY;
			this.#colorDirtyMax = Number.NEGATIVE_INFINITY;
		}

		/*
		 * Update count last so copied data and buffer versions are visible
		 * before the mesh is rendered with the new active range.
		 */
		thinInstances.count = count;
	}

	#copyLane(from: number, to: number): void {
		const matrixFrom = from * MAT4_FLOATS;
		const matrixTo = to * MAT4_FLOATS;

		this.#matrices.copyWithin(matrixTo, matrixFrom, matrixFrom + MAT4_FLOATS);

		const colorFrom = from * COLOR_FLOATS;
		const colorTo = to * COLOR_FLOATS;

		this.#colors.copyWithin(colorTo, colorFrom, colorFrom + COLOR_FLOATS);

		this.#markMatrixDirty(to);
		this.#markColorDirty(to);
	}

	#grow(): void {
		const oldCapacity = this.#capacity;
		const newCapacity = oldCapacity * 2;

		const newMatrices = new Float32Array(newCapacity * MAT4_FLOATS);
		newMatrices.set(this.#matrices);
		this.#matrices = newMatrices;

		const newColors = new Float32Array(newCapacity * COLOR_FLOATS);
		newColors.set(this.#colors);
		this.#colors = newColors;

		/*
		 * Avoid Array.splice(...largeArray), which materializes arguments and
		 * can eventually hit an engine's maximum argument count.
		 */
		const newLaneHolders = new Array<InstanceSlotHandle | null>(
			newCapacity,
		).fill(null);

		for (let index = 0; index < oldCapacity; index++) {
			newLaneHolders[index] = this.#laneHolders[index];
		}

		this.#laneHolders = newLaneHolders;
		this.#capacity = newCapacity;

		setThinInstances(this.mesh, newMatrices, this.#count);

		const thinInstances = this.mesh.thinInstances as
			| PackedThinInstances
			| undefined;

		if (thinInstances) {
			thinInstances.matrices = newMatrices;
			thinInstances.colors = newColors;
			thinInstances.count = this.#count;
			thinInstances._capacity = newCapacity;

			thinInstances._dirtyMin = 0;
			thinInstances._dirtyMax = this.#count;
			thinInstances._version = (thinInstances._version ?? 0) + 1;

			thinInstances._colorDirtyMin = 0;
			thinInstances._colorDirtyMax = this.#count;
			thinInstances._colorVersion = (thinInstances._colorVersion ?? 0) + 1;
		}

		if (this.#count > 0) {
			this.#dirtyMin = 0;
			this.#dirtyMax = this.#count;
			this.#colorDirtyMin = 0;
			this.#colorDirtyMax = this.#count;
		}

		this.#needsSync = true;
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
}

let arrowPool: ArrowInstancePool | null = null;

/** Lazily creates and reuses the shared arrow instance pool. */
export function getArrowInstancePool(): ArrowInstancePool {
	arrowPool ??= new ArrowInstancePool();
	return arrowPool;
}
