import {
	addToScene,
	createMeshFromData,
	type Mesh,
	removeFromScene,
	type SceneContext,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import {
	copyVec3,
	Matrix,
	setVec3,
	transformCoordinatesVec3ToRef,
	vec3Zero,
} from "@/code/Lib/Math";
import { Map1 } from "../../Maps/Map1";
import { Chunk } from "../Chunk/Chunk";
import { ChunkWorkerPool } from "../Chunk/ChunkWorkerPool";
import {
	packBlockValue,
	unpackBlockId,
	unpackBlockState,
} from "../Chunk/DataStructures/BlockEncoding";

export type BoatChunkBlock = {
	x: number;
	y: number;
	z: number;
	blockId: number;
	blockState?: number;
	packedBlock?: number;
	lightLevel?: number;
};

type ChunkCoords = {
	x: number;
	y: number;
	z: number;
};

type BoatChunkBlockChangeListener = (
	chunk: BoatChunk,
	localX: number,
	localY: number,
	localZ: number,
	blockId: number,
	blockState: number,
) => void;

export class BoatChunk {
	private static activeChunks = new Set<BoatChunk>();
	private static readonly CHUNK_Y_BASE = 670_000;
	private static readonly CHUNK_COORD_GRID_WIDTH = 256;
	private static readonly CHUNK_COORD_SPACING = 4;
	private static nextChunkSlot = 0;

	#scene: SceneContext;
	#center = vec3Zero();
	#visualRoot: Mesh;
	#centerChunk: Chunk;
	#scratchWorldMatrix = new Matrix();
	#scratchLocal = vec3Zero();
	#neighborChunks: Chunk[] = [];
	#attachedOpaqueMesh: Mesh | null = null;
	#attachedTransparentMesh: Mesh | null = null;
	#blockChangeListeners = new Set<BoatChunkBlockChangeListener>();

	constructor(blocks: BoatChunkBlock[], center: Vec3) {
		BoatChunk.activeChunks.add(this);
		this.#scene = Map1.mainScene;
		copyVec3(this.#center, center);
		this.#visualRoot = createMeshFromData(
			Map1.engine,
			"boatChunkRoot",
			new Float32Array(9),
			new Float32Array(9),
			new Uint32Array([0, 1, 2]),
		);
		addToScene(this.#scene, this.#visualRoot);
		this.#visualRoot.pickable = false;
		this.#visualRoot.renderOrder = 1;

		const chunkCoords = BoatChunk.allocateChunkCoords();
		this.#centerChunk = new Chunk(chunkCoords.x, chunkCoords.y, chunkCoords.z);
		this.#centerChunk.isBoatChunk = true;

		this.createNeighborChunks(chunkCoords);

		// Important: neighbor chunks must exist and be populated first so the center
		// chunk can derive correct skylight from its surroundings.
		this.populateNeighborChunks();
		this.populateCenterChunk(blocks);
		this.initializeCenterChunkLighting(blocks);

		this.remesh();
	}
	private initializeCenterChunkLighting(blocks: BoatChunkBlock[]): void {
		// Rebuild skylight properly using the actual boat blocks plus the already
		// populated empty neighbor chunks around it.  initializeSunlight now
		// posts its BFS seed queue to the worker pool.
		this.#centerChunk.initializeSunlight();

		// Collect all emission / explicit light sources so we can dispatch a
		// single batched LightAddEmission message per block instead of
		// running an inline BFS per cell.
		const emissions: Array<{ x: number; y: number; z: number; level: number }> =
			[];
		const pool = Chunk._lightPool;

		for (const block of blocks) {
			const bx = Math.floor(block.x);
			const by = Math.floor(block.y);
			const bz = Math.floor(block.z);

			if (!this.isInsideChunkBounds(bx, by, bz)) {
				continue;
			}

			const packed =
				typeof block.packedBlock === "number"
					? block.packedBlock
					: packBlockValue(block.blockId, block.blockState ?? 0);

			if (typeof block.lightLevel === "number") {
				const packedLight = block.lightLevel & 0xff;

				const skyLight =
					(packedLight >> Chunk.SKY_LIGHT_SHIFT) & Chunk.BLOCK_LIGHT_MASK;
				const blockLight = packedLight & Chunk.BLOCK_LIGHT_MASK;

				if (skyLight > 0) {
					const currentSky = this.#centerChunk.getSkyLight(bx, by, bz);
					if (skyLight > currentSky) {
						this.#centerChunk.setSkyLight(bx, by, bz, skyLight);
					}
				}

				if (blockLight > 0) {
					emissions.push({ x: bx, y: by, z: bz, level: blockLight });
				}

				continue;
			}

			const emission = Chunk.getLightEmission(unpackBlockId(packed));
			if (emission > 0) {
				emissions.push({ x: bx, y: by, z: bz, level: emission });
			}
		}

		if (pool && emissions.length > 0) {
			for (const e of emissions) {
				pool.postLightAddEmission({
					chunkId: this.#centerChunk.id,
					headerSlot: this.#centerChunk.lightHeaderSlot,
					x: e.x,
					y: e.y,
					z: e.z,
					level: e.level,
					seq: pool.nextLightSeq(),
				});
			}
		}

		// Initial setup should not mark the boat chunk as modified.
		this.#centerChunk.isModified = false;
	}

	private static allocateChunkCoords(): ChunkCoords {
		const slot = BoatChunk.nextChunkSlot++;
		const gx = slot % BoatChunk.CHUNK_COORD_GRID_WIDTH;
		const gz = Math.floor(slot / BoatChunk.CHUNK_COORD_GRID_WIDTH);
		return {
			x: gx * BoatChunk.CHUNK_COORD_SPACING,
			y: BoatChunk.CHUNK_Y_BASE + gz * BoatChunk.CHUNK_COORD_SPACING,
			z: 0,
		};
	}

	private createSharedBuffer(byteLength: number): ArrayBufferLike {
		if (typeof SharedArrayBuffer !== "undefined") {
			return new SharedArrayBuffer(byteLength);
		}
		return new ArrayBuffer(byteLength);
	}

	private createSkyLightArray(): Uint8Array {
		const light = new Uint8Array(this.createSharedBuffer(Chunk.SIZE3));
		light.fill(15 << Chunk.SKY_LIGHT_SHIFT);
		return light;
	}

	private isInsideChunkBounds(x: number, y: number, z: number): boolean {
		return (
			x >= 0 &&
			y >= 0 &&
			z >= 0 &&
			x < Chunk.SIZE &&
			y < Chunk.SIZE &&
			z < Chunk.SIZE
		);
	}

	private getIndex(x: number, y: number, z: number): number {
		return x + y * Chunk.SIZE + z * Chunk.SIZE2;
	}

	private createBlockArray(): Uint16Array {
		return new Uint16Array(this.createSharedBuffer(Chunk.SIZE3 * 2));
	}

	private createNeighborChunks(center: ChunkCoords): void {
		for (let dz = -1; dz <= 1; dz++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (dx === 0 && dy === 0 && dz === 0) continue;
					const neighbor = new Chunk(
						center.x + dx,
						center.y + dy,
						center.z + dz,
					);
					neighbor.isBoatChunk = true;
					this.#neighborChunks.push(neighbor);
				}
			}
		}
	}

	private populateNeighborChunks(): void {
		for (const neighbor of this.#neighborChunks) {
			neighbor.loadFromStorage(
				null,
				null,
				true,
				0,
				this.createSkyLightArray(),
				false,
			);
			neighbor.isModified = false;
		}
	}

	private populateCenterChunk(blocks: BoatChunkBlock[]): void {
		const blockArray = this.createBlockArray();
		const lightArray = this.createEmptyLightArray();

		for (const block of blocks) {
			const bx = Math.floor(block.x);
			const by = Math.floor(block.y);
			const bz = Math.floor(block.z);

			if (!this.isInsideChunkBounds(bx, by, bz)) {
				continue;
			}

			const index = this.getIndex(bx, by, bz);
			const packed =
				typeof block.packedBlock === "number"
					? block.packedBlock
					: packBlockValue(block.blockId, block.blockState ?? 0);

			blockArray[index] = packed;
		}

		// Start dark; skylight/block light are initialized in initializeCenterChunkLighting().
		this.#centerChunk.loadFromStorage(
			blockArray,
			null,
			false,
			0,
			lightArray,
			false,
		);
	}

	private isAliveMesh(mesh: Mesh | null): mesh is Mesh {
		return !!mesh;
	}

	private configureAttachedMesh(mesh: Mesh): void {
		mesh.parent = this.#visualRoot;
		mesh.position.set(-this.#center.x, -this.#center.y, -this.#center.z);
		mesh.rotation.set(0, 0, 0);
		mesh.scaling.set(1, 1, 1);
		mesh.pickable = true;
		// Keep transparent and opaque boat chunk meshes in the same rendering group
		// so depth from opaque is preserved for transparent pass.
		mesh.renderOrder = 1;
		mesh.metadata = this.#visualRoot.metadata;
	}

	private syncMeshRef(
		source: Mesh | null,
		attachedRef: Mesh | null,
	): Mesh | null {
		if (!this.isAliveMesh(source)) {
			return null;
		}
		if (source === attachedRef) {
			return attachedRef;
		}
		this.configureAttachedMesh(source);
		return source;
	}

	private updateAttachedMeshTransform(mesh: Mesh | null): void {
		if (!this.isAliveMesh(mesh)) return;
		mesh.position.set(-this.#center.x, -this.#center.y, -this.#center.z);
	}

	public syncVisualMeshes(): void {
		this.#attachedOpaqueMesh = this.syncMeshRef(
			this.#centerChunk.mesh,
			this.#attachedOpaqueMesh,
		);
		this.#attachedTransparentMesh = this.syncMeshRef(
			this.#centerChunk.transparentMesh,
			this.#attachedTransparentMesh,
		);
		this.updateAttachedMeshTransform(this.#attachedOpaqueMesh);
		this.updateAttachedMeshTransform(this.#attachedTransparentMesh);
	}

	public remesh(priority = true): void {
		ChunkWorkerPool.getInstance().scheduleRemesh(this.#centerChunk, priority);
	}

	public attachTo(parent: Mesh): void {
		this.#visualRoot.parent = parent;
	}

	public getBlockLocal(x: number, y: number, z: number): number {
		if (!this.isInsideChunkBounds(x, y, z)) return 0;
		return this.#centerChunk.getBlock(x, y, z);
	}

	public isInsideLocalBounds(x: number, y: number, z: number): boolean {
		return this.isInsideChunkBounds(x, y, z);
	}

	public getBlockStateLocal(x: number, y: number, z: number): number {
		if (!this.isInsideChunkBounds(x, y, z)) return 0;
		return this.#centerChunk.getBlockState(x, y, z);
	}

	public getBlockPackedLocal(x: number, y: number, z: number): number {
		if (!this.isInsideChunkBounds(x, y, z)) return 0;
		return this.#centerChunk.getBlockPacked(x, y, z);
	}

	public getLightLocal(x: number, y: number, z: number): number {
		if (!this.isInsideChunkBounds(x, y, z)) return 0;
		return this.#centerChunk.getLight(x, y, z);
	}

	public setBlockPackedLocal(
		x: number,
		y: number,
		z: number,
		packedBlock: number,
	): void {
		const blockId = unpackBlockId(packedBlock);
		const blockState = unpackBlockState(packedBlock);
		this.setBlockLocal(x, y, z, blockId, blockState);
	}

	public setBlockLocal(
		x: number,
		y: number,
		z: number,
		blockId: number,
		blockState = 0,
	): void {
		if (!this.isInsideChunkBounds(x, y, z)) return;
		const nextPacked = packBlockValue(blockId, blockState);
		const prevPacked = this.#centerChunk.getBlockPacked(x, y, z);
		if (prevPacked === nextPacked) return;
		this.#centerChunk.setBlock(x, y, z, blockId, blockState);
		this.#emitBlockChanged(x, y, z, blockId, blockState);
	}

	public setLightLocal(
		x: number,
		y: number,
		z: number,
		packedLight: number,
	): void {
		if (!this.isInsideChunkBounds(x, y, z)) return;

		const value = packedLight & 0xff;
		const skyLight = (value >> Chunk.SKY_LIGHT_SHIFT) & Chunk.BLOCK_LIGHT_MASK;
		const blockLight = value & Chunk.BLOCK_LIGHT_MASK;

		this.#centerChunk.setSkyLight(x, y, z, skyLight);
		this.#centerChunk.setBlockLight(x, y, z, blockLight);
		this.#centerChunk.scheduleRemesh();
	}

	public worldToLocalBlock(worldPosition: Vec3): Vec3 {
		this.worldToLocalBlockToRef(worldPosition, this.#scratchLocal);
		return vec3(
			Math.floor(this.#scratchLocal.x),
			Math.floor(this.#scratchLocal.y),
			Math.floor(this.#scratchLocal.z),
		);
	}

	public worldToLocalBlockToRef(worldPosition: Vec3, ref: Vec3): void {
		const root = this.#visualRoot.position;
		setVec3(
			ref,
			worldPosition.x - root.x + this.#center.x,
			worldPosition.y - root.y + this.#center.y,
			worldPosition.z - root.z + this.#center.z,
		);
	}

	public localToWorldCenter(x: number, y: number, z: number): Vec3 {
		const ref = vec3(0, 0, 0);
		this.localToWorldCenterToRef(x, y, z, ref);
		return ref;
	}

	public localToWorldCenterToRef(
		x: number,
		y: number,
		z: number,
		ref: Vec3,
	): void {
		const lx = x + 0.5 - this.#center.x;
		const ly = y + 0.5 - this.#center.y;
		const lz = z + 0.5 - this.#center.z;
		const wm = this.#visualRoot.worldMatrix;
		const sm = this.#scratchWorldMatrix.m;
		for (let i = 0; i < 16; i++) sm[i] = wm[i];
		transformCoordinatesVec3ToRef(
			vec3(lx, ly, lz),
			this.#scratchWorldMatrix,
			ref,
		);
	}

	public getOccupiedBoundsLocal(): {
		minX: number;
		minY: number;
		minZ: number;
		maxX: number;
		maxY: number;
		maxZ: number;
	} | null {
		let minX = Infinity;
		let minY = Infinity;
		let minZ = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let maxZ = -Infinity;
		let found = false;

		for (let y = 0; y < Chunk.SIZE; y++) {
			for (let z = 0; z < Chunk.SIZE; z++) {
				for (let x = 0; x < Chunk.SIZE; x++) {
					if (this.#centerChunk.getBlock(x, y, z) === 0) continue;
					found = true;
					if (x < minX) minX = x;
					if (y < minY) minY = y;
					if (z < minZ) minZ = z;
					if (x > maxX) maxX = x;
					if (y > maxY) maxY = y;
					if (z > maxZ) maxZ = z;
				}
			}
		}

		if (!found) return null;
		return { minX, minY, minZ, maxX, maxY, maxZ };
	}

	public onBlockChanged(listener: BoatChunkBlockChangeListener): () => void {
		this.#blockChangeListeners.add(listener);
		return () => {
			this.#blockChangeListeners.delete(listener);
		};
	}

	public toSnapshot(): { blocks: BoatChunkBlock[]; center: Vec3 } {
		const blocks: BoatChunkBlock[] = [];

		for (let y = 0; y < Chunk.SIZE; y++) {
			for (let z = 0; z < Chunk.SIZE; z++) {
				for (let x = 0; x < Chunk.SIZE; x++) {
					const packedBlock = this.#centerChunk.getBlockPacked(x, y, z);
					const blockId = unpackBlockId(packedBlock);
					if (blockId === 0) {
						continue;
					}

					blocks.push({
						x,
						y,
						z,
						blockId,
						blockState: unpackBlockState(packedBlock),
						packedBlock,
						lightLevel: this.#centerChunk.getLight(x, y, z),
					});
				}
			}
		}

		return {
			blocks,
			center: vec3(this.#center.x, this.#center.y, this.#center.z),
		};
	}

	public dispose(): void {
		BoatChunk.activeChunks.delete(this);
		this.#blockChangeListeners.clear();

		this.#centerChunk.dispose();
		Chunk.chunkInstances.delete(this.#centerChunk.id);

		for (const neighborChunk of this.#neighborChunks) {
			neighborChunk.dispose();
			Chunk.chunkInstances.delete(neighborChunk.id);
		}
		this.#neighborChunks.length = 0;

		removeFromScene(this.#scene, this.#visualRoot);
	}
	private createEmptyLightArray(): Uint8Array {
		return new Uint8Array(this.createSharedBuffer(Chunk.SIZE3));
	}

	public get visualRoot(): Mesh {
		return this.#visualRoot;
	}

	public get center(): Vec3 {
		return this.#center;
	}

	public static getActiveChunks(): ReadonlySet<BoatChunk> {
		return BoatChunk.activeChunks;
	}

	#emitBlockChanged(
		localX: number,
		localY: number,
		localZ: number,
		blockId: number,
		blockState: number,
	): void {
		for (const listener of this.#blockChangeListeners) {
			listener(this, localX, localY, localZ, blockId, blockState);
		}
	}
}
