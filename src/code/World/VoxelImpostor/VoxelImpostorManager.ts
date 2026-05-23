import {
	Effect,
	type Mesh,
	MeshBuilder,
	RawTexture,
	type Scene,
	ShaderMaterial,
	Texture,
	Vector2,
	Vector3,
} from "@babylonjs/core";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { getFinalTerrainHeight } from "@/code/Generation/TerrainHeightMap";
import { BlockType } from "../Texture/BlockType";
import { Chunk } from "../Chunk/Chunk";
import { GLOBAL_VALUES } from "../GLOBAL_VALUES";
import { COLOR_PALETTE, getBlockColorIndex } from "../MeshPipeline/core/BlockColorPalette";
import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
import {
	BRICK_POOL_SIZE,
	BRICK_RESOLUTION,
	MAX_BRICKS,
	REGION_CHUNK_EXTENT,
	REGION_VOXEL_SIZE,
	VoxelImpostorRegion,
} from "./VoxelImpostorRegion";
import { VoxelImpostorShader } from "./VoxelImpostorShader";

const VERTICAL_EXTENT = 4;
const Y_LAYERS = VERTICAL_EXTENT * 2 + 1; // 9

export class VoxelImpostorManager {
	private static instance: VoxelImpostorManager | undefined;

	private scene: Scene;

	private regions = new Map<string, VoxelImpostorRegion>();
	// BUG FIX 1: activeRegions was rebuilt every tick from scratch in
	// updateRegionMeshes(), which meant its contents changed every 500ms
	// throttle cycle even when nothing actually changed. The mesh array was
	// then re-matched by index, so any reordering of the map iteration caused
	// a different region to be assigned to each mesh slot → instant pop.
	// Fix: keep a stable Map<key, Mesh> instead of parallel arrays so each
	// region always owns the same mesh object regardless of iteration order.
	private regionMeshMap = new Map<string, Mesh>();

	private material: ShaderMaterial | null = null;

	private voxelPoolTexture: RawTexture | null = null;
	private voxelPoolData: Uint8Array;
	private voxelPoolWidth = 8192;
	private voxelPoolHeight = 4096;

	private indirectionTexture: RawTexture | null = null;
	private indirectionData: Uint8Array;
	private readonly indirectionXZ = 256;
	private readonly indirectionTotalHeight: number;
	private indirectionRyBase = 0;

	private brickPool = new Uint8Array(MAX_BRICKS * BRICK_POOL_SIZE);
	private brickFreeList: number[] = [];
	private brickAllocation = new Int16Array(MAX_BRICKS).fill(-1);
	private brickRegionMap = new Map<number, string>();
	private dirtyBricks = new Set<number>();

	private impostorRangeMin: number;
	private impostorRangeMax: number;

	private lastCameraChunkX = 0;
	private lastCameraChunkY = 0;
	private lastCameraChunkZ = 0;
	// BUG FIX 2: the 500ms throttle caused the whole update() call to return
	// early, so processPendingBuilds / updateGPUBuffers / updateRegionMeshes
	// were also skipped. Regions would finish building mid-throttle window but
	// their meshes wouldn't appear until the next tick that passed the gate.
	// More importantly the throttle was shared between the movement check AND
	// the mesh/GPU update, so standing still meant meshes never updated at all
	// after the initial build. Fix: only throttle the expensive updateRegions
	// scan; always run the cheap mesh/GPU steps every call.
	private regionScanThrottleMs = 500;
	private lastRegionScanMs = 0;

	private pendingBuilds: VoxelImpostorRegion[] = [];
	private isBuilding = false;
	private indirectionDirty = false;

	constructor(scene: Scene) {
		this.scene = scene;

		this.indirectionTotalHeight = this.indirectionXZ * Y_LAYERS;

		this.voxelPoolData = new Uint8Array(
			this.voxelPoolWidth * this.voxelPoolHeight * 4,
		);
		this.indirectionData = new Uint8Array(
			this.indirectionXZ * this.indirectionTotalHeight * 4,
		);

		for (let i = 0; i < MAX_BRICKS; i++) {
			this.brickFreeList.push(i);
		}

		this.impostorRangeMin = 5;
		this.impostorRangeMax = 300;

		this.createIndirectionTexture();
		this.createVoxelPoolTexture();
		this.createMaterial();
	}

	public static getInstance(scene: Scene): VoxelImpostorManager {
		if (!VoxelImpostorManager.instance) {
			VoxelImpostorManager.instance = new VoxelImpostorManager(scene);
		}
		return VoxelImpostorManager.instance;
	}

	public static checkInstance(): boolean {
		return !!VoxelImpostorManager.instance;
	}

	private createMaterial(): void {
		Effect.ShadersStore["voxelImpostorVertexShader"] =
			VoxelImpostorShader.vertexShader;
		Effect.ShadersStore["voxelImpostorFragmentShader"] =
			VoxelImpostorShader.fragmentShader;

		try {
			this.material = new ShaderMaterial(
				"voxelImpostorMat",
				this.scene,
				{ vertex: "voxelImpostor", fragment: "voxelImpostor" },
				{
					attributes: ["position"],
					uniforms: [
						"world",
						"worldViewProjection",
						"uRegionWorldMin",
						"uRegionWorldMax",
						"uCameraPosition",
						"uLightDirection",
						"uSunLightIntensity",
						"uFogInfos",
						"uFogColor",
						"uIndirectionXZ",
						"uIndirectionTotalHeight",
						"uIndirectionRyBase",
						"uVoxelPoolSize",
						"uBrickPoolSize",
						"uBrickResolution",
						"uRegionVoxelSize",
						"uBlockColors",
					],
					samplers: ["uVoxelPool", "uIndirectionTable"],
				},
			);

			this.material.setFloat("uBrickPoolSize", BRICK_POOL_SIZE);
			this.material.setFloat("uBrickResolution", BRICK_RESOLUTION);
			this.material.setFloat("uRegionVoxelSize", REGION_VOXEL_SIZE);
			this.material.setFloat("uIndirectionXZ", this.indirectionXZ);
			this.material.setFloat(
				"uIndirectionTotalHeight",
				this.indirectionTotalHeight,
			);
			this.material.setFloat("uIndirectionRyBase", this.indirectionRyBase);
			this.material.setVector2(
				"uVoxelPoolSize",
				new Vector2(this.voxelPoolWidth, this.voxelPoolHeight),
			);
			this.material.setTexture("uVoxelPool", this.voxelPoolTexture!);
			this.material.setTexture("uIndirectionTable", this.indirectionTexture!);

			const bc = new Float32Array(256 * 3);
			for (let i = 0; i < 256; i++) {
				const palIdx = getBlockColorIndex(i);
				bc[i * 3] = COLOR_PALETTE[palIdx * 3];
				bc[i * 3 + 1] = COLOR_PALETTE[palIdx * 3 + 1];
				bc[i * 3 + 2] = COLOR_PALETTE[palIdx * 3 + 2];
			}
			this.material.setArray3("uBlockColors", Array.from(bc));

			this.material.onBindObservable.add((mesh) => {
				const effect = this.material?.getEffect();
				if (!effect) return;

				const region = mesh.metadata?._impostorRegion as
					| VoxelImpostorRegion
					| undefined as VoxelImpostorRegion | undefined;
				if (region) {
					effect.setVector3(
						"uRegionWorldMin",
						new Vector3(region.worldMinX, region.worldMinY, region.worldMinZ),
					);
					effect.setVector3(
						"uRegionWorldMax",
						new Vector3(region.worldMaxX, region.worldMaxY, region.worldMaxZ),
					);
				}

				const camPos = this.scene.activeCamera?.position;
				if (camPos) {
					effect.setVector3("uCameraPosition", camPos);
				}

				const lightDir = GLOBAL_VALUES.skyLightDirection.clone().negate();
				effect.setVector3("uLightDirection", lightDir);

				const sunElevation = lightDir.y + 0.1;
				const sunIntensity =
					sunElevation < 0.1 ? 0.1 : sunElevation > 1.0 ? 1.0 : sunElevation;
				effect.setFloat("uSunLightIntensity", sunIntensity);

				effect.setFloat4(
					"uFogInfos",
					this.scene.fogMode,
					this.scene.fogStart,
					this.scene.fogEnd,
					this.scene.fogDensity,
				);
				effect.setColor3("uFogColor", this.scene.fogColor);
				effect.setFloat("uIndirectionRyBase", this.indirectionRyBase);
			});

			this.material.onError = (effect, message: string) => {
				console.error("[Impostor] Shader compilation error:", message);
				console.error("[Impostor] Effect:", effect);
			};

			console.log("[Impostor] Shader material created successfully");
		} catch (e) {
			console.error("[Impostor] Failed to create shader material:", e);
			this.material = null;
		}
	}

	private createIndirectionTexture(): void {
		this.indirectionTexture = RawTexture.CreateRGBATexture(
			this.indirectionData,
			this.indirectionXZ,
			this.indirectionTotalHeight,
			this.scene,
			false,
			false,
			Texture.NEAREST_SAMPLINGMODE,
		);
		this.indirectionTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
		this.indirectionTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
	}

	private createVoxelPoolTexture(): void {
		this.voxelPoolTexture = RawTexture.CreateRGBATexture(
			this.voxelPoolData,
			this.voxelPoolWidth,
			this.voxelPoolHeight,
			this.scene,
			false,
			false,
			Texture.NEAREST_SAMPLINGMODE,
		);
		this.voxelPoolTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
		this.voxelPoolTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
	}

	public update(
		cameraWorldX: number,
		cameraWorldY: number,
		cameraWorldZ: number,
	): void {
		const now = performance.now();

		// Only throttle the region scan (expensive). Always run builds + GPU + meshes.
		const shouldScan = now - this.lastRegionScanMs >= this.regionScanThrottleMs;

		if (shouldScan) {
			this.lastRegionScanMs = now;

			const cameraChunkX = Math.floor(cameraWorldX / Chunk.SIZE);
			const cameraChunkY = Math.floor(cameraWorldY / Chunk.SIZE);
			const cameraChunkZ = Math.floor(cameraWorldZ / Chunk.SIZE);

			const hasMoved =
				cameraChunkX !== this.lastCameraChunkX ||
				cameraChunkY !== this.lastCameraChunkY ||
				cameraChunkZ !== this.lastCameraChunkZ;

			if (hasMoved) {
				this.lastCameraChunkX = cameraChunkX;
				this.lastCameraChunkY = cameraChunkY;
				this.lastCameraChunkZ = cameraChunkZ;
				this.updateRegions(cameraChunkX, cameraChunkY, cameraChunkZ);
			}
		}

		// These always run so built regions appear immediately and GPu stays current.
		this.processPendingBuilds();
		this.updateGPUBuffers();
		this.updateRegionMeshes();
	}

	private updateRegions(
		cameraChunkX: number,
		cameraChunkY: number,
		cameraChunkZ: number,
	): void {
		const desiredRegions = new Set<string>();

		const impostorMinRegion = Math.floor(
			(cameraChunkX - this.impostorRangeMax) / REGION_CHUNK_EXTENT,
		);
		const impostorMaxRegion = Math.floor(
			(cameraChunkX + this.impostorRangeMax) / REGION_CHUNK_EXTENT,
		);
		const impostorMinRegionZ = Math.floor(
			(cameraChunkZ - this.impostorRangeMax) / REGION_CHUNK_EXTENT,
		);
		const impostorMaxRegionZ = Math.floor(
			(cameraChunkZ + this.impostorRangeMax) / REGION_CHUNK_EXTENT,
		);

		const cameraRegionY = Math.floor(cameraChunkY / REGION_CHUNK_EXTENT);

		const newRyBase = cameraRegionY - VERTICAL_EXTENT;
		if (newRyBase !== this.indirectionRyBase) {
			this.indirectionData.fill(0);
			this.indirectionRyBase = newRyBase;
			this.material?.setFloat("uIndirectionRyBase", this.indirectionRyBase);
			// Re-register all still-loaded regions under the new Y window.
			for (const region of this.regions.values()) {
				if (region.isLoaded && region.brickIndex >= 0) {
					this.updateIndirectionTable(region);
				}
			}
		}

		let createdCount = 0;
		for (let rz = impostorMinRegionZ; rz <= impostorMaxRegionZ; rz++) {
			for (let rx = impostorMinRegion; rx <= impostorMaxRegion; rx++) {
				for (
					let ry = cameraRegionY - VERTICAL_EXTENT;
					ry <= cameraRegionY + VERTICAL_EXTENT;
					ry++
				) {
					const regionWorldCenterX = (rx + 0.5) * REGION_VOXEL_SIZE;
					const regionWorldCenterZ = (rz + 0.5) * REGION_VOXEL_SIZE;

					const dx =
						Math.abs(regionWorldCenterX - cameraChunkX * Chunk.SIZE) /
						Chunk.SIZE;
					const dz =
						Math.abs(regionWorldCenterZ - cameraChunkZ * Chunk.SIZE) /
						Chunk.SIZE;

					const maxDist = Math.max(dx, dz);
					if (
						maxDist < this.impostorRangeMin ||
						maxDist > this.impostorRangeMax
					) {
						continue;
					}

					const key = `${rx},${ry},${rz}`;
					desiredRegions.add(key);

					if (!this.regions.has(key)) {
						const region = new VoxelImpostorRegion(rx, ry, rz);
						region.dist = maxDist;
						this.regions.set(key, region);
						this.pendingBuilds.push(region);
						createdCount++;
					}
				}
			}
		}

		if (createdCount > 0) {
			console.log(`[Impostor] Created ${createdCount} new regions`);
			this.pendingBuilds.sort((a, b) => a.dist - b.dist);
		}

		const keysToRemove: string[] = [];
		for (const [key, region] of this.regions) {
			if (!desiredRegions.has(key)) {
				if (region.brickIndex >= 0) {
					this.freeBrick(region.brickIndex);
					region.brickIndex = -1;
				}
				region.isLoaded = false;
				keysToRemove.push(key);
			}
		}
		for (const key of keysToRemove) {
			this.regions.delete(key);
			// BUG FIX 3: meshes for evicted regions were left in regionMeshes[]
			// with stale _impostorRegion pointers. On the next updateRegionMeshes
			// call the slot count was recomputed from activeRegions.length and the
			// stale meshes could get reassigned to a different region at a
			// different position — causing a visible one-frame pop to the wrong
			// location before being hidden. Fix: dispose the mesh immediately when
			// the region is evicted so there is no stale slot.
			const mesh = this.regionMeshMap.get(key);
			if (mesh) {
				mesh.dispose();
				this.regionMeshMap.delete(key);
			}
		}

		if (keysToRemove.length > 0) {
			const removedSet = new Set(keysToRemove);
			this.pendingBuilds = this.pendingBuilds.filter(
				(r) => !removedSet.has(r.key),
			);
		}
	}

	private processPendingBuilds(): void {
		if (this.isBuilding || this.pendingBuilds.length === 0) {
			return;
		}

		const buildCount = Math.min(8, this.pendingBuilds.length);
		for (let i = 0; i < buildCount; i++) {
			const region = this.pendingBuilds[i];
			if (!region) continue;
			this.buildRegionBrick(region);
		}

		this.pendingBuilds.splice(0, buildCount);
	}

	private buildRegionBrick(region: VoxelImpostorRegion): void {
		const brickIndex = this.allocateBrick();
		if (brickIndex < 0) return;

		const brickData = this.generateRegionVoxels(region);

		const isEmpty = this.copyBrickToPool(brickIndex, brickData);

		region.brickIndex = brickIndex;
		region.isDirty = false;
		region.isLoaded = !isEmpty;
		region.lastUpdateMs = performance.now();

		this.updateIndirectionTable(region);
	}

	private generateRegionVoxels(region: VoxelImpostorRegion): Uint8Array {
		const brickSize = BRICK_RESOLUTION;
		const voxelData = new Uint8Array(brickSize * brickSize * brickSize);
		const downsampleFactor = Math.floor(REGION_VOXEL_SIZE / brickSize);
		const seaLevel = GenerationParams.SEA_LEVEL;

		for (let bz = 0; bz < brickSize; bz++) {
			for (let bx = 0; bx < brickSize; bx++) {
				const worldX =
					region.worldMinX + bx * downsampleFactor + downsampleFactor * 0.5;
				const worldZ =
					region.worldMinZ + bz * downsampleFactor + downsampleFactor * 0.5;

				const terrainHeight = getFinalTerrainHeight(worldX, worldZ);
				const surfaceY = Math.max(Math.floor(terrainHeight), seaLevel);

				const startY = 0;
				const endY = Math.min(
					Math.ceil((surfaceY - region.worldMinY) / downsampleFactor),
					brickSize - 1,
				);

				for (let by = startY; by <= endY; by++) {
					const worldY = region.worldMinY + by * downsampleFactor;
					let blockId = BlockType.Cobble;

					if (worldY === surfaceY) {
						blockId = surfaceY <= seaLevel ? BlockType.GravellySand : BlockType.RockyTerrain02;
					} else if (worldY > surfaceY - 4) {
						blockId = BlockType.RocksGround02;
					} else {
						blockId = BlockType.AncientCrackedStone;
					}

					const idx = bx + by * brickSize + bz * brickSize * brickSize;
					voxelData[idx] = blockId;
				}
			}
		}

		return voxelData;
	}

	private copyBrickToPool(brickIndex: number, brickData: Uint8Array): boolean {
		const offset = brickIndex * BRICK_POOL_SIZE;
		let isEmpty = true;

		for (let i = 0; i < BRICK_POOL_SIZE; i++) {
			const val = brickData[i];
			this.brickPool[offset + i] = val;
			if (val > 0) isEmpty = false;
		}

		this.dirtyBricks.add(brickIndex);
		return isEmpty;
	}

	private allocateBrick(): number {
		if (this.brickFreeList.length === 0) {
			return -1;
		}
		return this.brickFreeList.pop() ?? -1;
	}

	private freeBrick(brickIndex: number): void {
		if (brickIndex < 0 || brickIndex >= MAX_BRICKS) return;

		const oldRegionKey = this.brickRegionMap.get(brickIndex);
		if (oldRegionKey) {
			this.brickRegionMap.delete(brickIndex);
			const oldRegion = this.regions.get(oldRegionKey);
			if (oldRegion && oldRegion.brickIndex === brickIndex) {
				oldRegion.brickIndex = -1;
				oldRegion.isLoaded = false;
			}
		}

		this.brickAllocation[brickIndex] = -1;
		this.brickFreeList.push(brickIndex);
		this.dirtyBricks.delete(brickIndex);
	}

	private indirectionRowForRy(ry: number): number {
		const ySlot = ry - this.indirectionRyBase;
		if (ySlot < 0 || ySlot >= Y_LAYERS) return -1;
		return ySlot * this.indirectionXZ;
	}

	private updateIndirectionTable(region: VoxelImpostorRegion): void {
		if (region.brickIndex < 0) return;

		const yRowBase = this.indirectionRowForRy(region.ry);
		if (yRowBase < 0) return;

		const texX =
			((region.rx % this.indirectionXZ) + this.indirectionXZ) %
			this.indirectionXZ;
		const texY =
			yRowBase +
			(((region.rz % this.indirectionXZ) + this.indirectionXZ) %
				this.indirectionXZ);

		const idx = (texY * this.indirectionXZ + texX) * 4;
		const encoded = region.brickIndex + 1;
		this.indirectionData[idx] = encoded & 0xff;
		this.indirectionData[idx + 1] = (encoded >> 8) & 0xff;
		this.indirectionData[idx + 2] = 0;
		this.indirectionData[idx + 3] = 255;
		this.indirectionDirty = true;

		this.brickAllocation[region.brickIndex] = region.ry;
		this.brickRegionMap.set(region.brickIndex, region.key);
	}

	private updateGPUBuffers(): void {
		if (this.voxelPoolTexture && this.dirtyBricks.size > 0) {
			for (const brickIndex of this.dirtyBricks) {
				const srcOffset = brickIndex * BRICK_POOL_SIZE;
				const dstOffset = brickIndex * BRICK_POOL_SIZE * 4;
				for (let i = 0; i < BRICK_POOL_SIZE; i++) {
					const val = this.brickPool[srcOffset + i];
					const dst = dstOffset + i * 4;
					this.voxelPoolData[dst] = val;
					this.voxelPoolData[dst + 1] = 0;
					this.voxelPoolData[dst + 2] = 0;
					this.voxelPoolData[dst + 3] = 255;
				}
			}
			this.dirtyBricks.clear();
			this.voxelPoolTexture.update(this.voxelPoolData);
		}

		if (this.indirectionTexture && this.indirectionDirty) {
			this.indirectionTexture.update(this.indirectionData);
			this.indirectionDirty = false;
		}
	}

	private updateRegionMeshes(): void {
		if (!this.material) {
			for (const mesh of this.regionMeshMap.values()) {
				mesh.isVisible = false;
				mesh.material = null;
			}
			return;
		}

		const shaderReady = this.material.isReady();

		for (const [key, region] of this.regions) {
			if (!region.isLoaded || region.brickIndex < 0) {
				// Hide the mesh if it exists but region isn't ready.
				const mesh = this.regionMeshMap.get(key);
				if (mesh) {
					mesh.isVisible = false;
					mesh.material = null;
				}
				continue;
			}

			// Get or create a stable mesh for this region key.
			let mesh = this.regionMeshMap.get(key);
			if (!mesh) {
				mesh = this.createRegionMesh();
				this.regionMeshMap.set(key, mesh);
			}

			// Position and scale the mesh to match the region's world bounds
			// so the vertex shader can use the standard world transform.
			const regionSize = region.worldMaxX - region.worldMinX;
			mesh.position.set(
				region.worldMinX + regionSize * 0.5,
				region.worldMinY + regionSize * 0.5,
				region.worldMinZ + regionSize * 0.5,
			);
			mesh.scaling.set(regionSize, regionSize, regionSize);

			if (shaderReady) {
				// Only update region pointer if something actually changed.
				if (mesh.metadata?._impostorRegion !== region) {
					if (!mesh.metadata) {
						mesh.metadata = {};
					}
					(mesh.metadata as Record<string, unknown>)._impostorRegion = region;
					mesh.material = this.material;
				}
				mesh.isVisible = true;
			} else {
				mesh.isVisible = false;
			}
		}
	}

	private createRegionMesh(): Mesh {
		const mesh = MeshBuilder.CreateBox(
			"impostorRegion",
			{ width: 1, height: 1, depth: 1 },
			this.scene,
		);

		mesh.isPickable = false;
		mesh.checkCollisions = false;
		mesh.receiveShadows = false;
		mesh.alwaysSelectAsActiveMesh = true;

		return mesh;
	}

	public getDebugStats(): {
		regions: number;
		loaded: number;
		pending: number;
		bricksUsed: number;
		bricksTotal: number;
		meshes: number;
		rangeMin: number;
		rangeMax: number;
	} {
		let loadedCount = 0;
		for (const region of this.regions.values()) {
			if (region.isLoaded && region.brickIndex >= 0) loadedCount++;
		}
		return {
			regions: this.regions.size,
			loaded: loadedCount,
			pending: this.pendingBuilds.length,
			bricksUsed: MAX_BRICKS - this.brickFreeList.length,
			bricksTotal: MAX_BRICKS,
			meshes: this.regionMeshMap.size,
			rangeMin: this.impostorRangeMin,
			rangeMax: this.impostorRangeMax,
		};
	}

	public dispose(): void {
		for (const mesh of this.regionMeshMap.values()) {
			mesh.dispose();
		}
		this.regionMeshMap.clear();

		this.material?.dispose();
		this.material = null;

		this.voxelPoolTexture?.dispose();
		this.voxelPoolTexture = null;

		this.indirectionTexture?.dispose();
		this.indirectionTexture = null;

		this.regions.clear();
		this.pendingBuilds = [];
		this.dirtyBricks.clear();

		VoxelImpostorManager.instance = undefined;
	}

	public static resetInstance(): void {
		VoxelImpostorManager.instance = undefined;
	}
}
