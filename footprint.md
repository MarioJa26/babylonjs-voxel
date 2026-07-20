# Project Footprint

Generated: 2026-07-20T06:12:32.671Z

> **Summary:** 125 classes · 1708 members · 464 module-level functions · 50940 LOC

---

## `Entities/AdvancedBoat.ts` (327 LOC)

### export class AdvancedBoat implements IUsable

**Constructor**
- `constructor(SceneContext: SceneContext, player: Player, waterLevel: number, position?: Vec3)`

**Properties**
- `public currentYaw`

**Accessors**
- `public get boatMesh(): Mesh`
- `public get boatPosition(): Vec3`
- `public get mount(): Mount`
- `public get submergedPoints(): number`

**Methods**
- `private createBoat(scene: SceneContext, position: Vec3 | undefined, waterLevel: number): void`
- `private setupBuoyancyPoints(): void`
- `private setupAdvancedPhysics(scene: SceneContext): void`
- `private applyForceAtPoint(force: Vec3, worldPoint: Vec3, dt: number): void`
- `private integrateRotation(dt: number): void`
- `private moveAxis(axis: Axis, delta: number): void`
- `private getWaterSubmersionAtPoint(worldPoint: Vec3): number`
- `public applyImpulse(impulse: Vec3, worldPoint: Vec3): void`
- `public applyAngularImpulse(impulse: Vec3): void`
- `public getBoatTopYToRef(out: Vec3): void`
- `public getBoatTopY(): Vec3`
- `use(player: Player): void`

**Types / Interfaces / Enums**
- type `Mesh`
- type `SceneContext`
- type `Vec3`

---

## `Entities/CustomBoat.ts` (774 LOC)

### export class CustomBoat implements IUsable

**Constructor**
- `constructor(player: Player, waterLevel: number, position?: Vec3, options?: CustomBoatOptions)`

**Properties**
- `static readonly CHUNK_ENTITY_TYPE`
- `scene: SceneContext`
- `player: Player`
- `waterLevel: number`
- `mass: 11,`
- `gravity: -9.81,`
- `baseBuoyancyForce: 20,`
- `torqueScale: 0.12,`
- `collisionStepSize: 0.25,`
- `collisionEpsilon: 0.01,`
- `damping: { waterLinear: 0.985, waterAngular: 0.92, airLinear: 0.995, airAngular: 0.98, },`
- `dtClamp: { min: 1 / 600, max: 1 / 24 },`
- `name: ,`
- `position: this.#boat.position,`
- `renderOrder: 1,`
- `getWorldPosition: () => this.#boat.position,`
- `unload: () => this.dispose(),`
- `isAlive: () => !(this.#boat as any).isDisposed?.(),`
- `serializeForChunkReload: () => this.#createSerializedPayload(),`
- `scene: SceneContext,`
- `position: Vec3 | undefined,`
- `waterLevel: number,`
- `dt`
- `fx: number,`
- `fy: number,`
- `fz: number,`
- `worldPoint: Vec3,`
- `dt: number,`
- `type: string`
- `payload: CustomBoatSerializedPayload`
- `position: { x: this.#boat.position.x, y: this.#boat.position.y, z: this.#boat.position.z, },`
- `collisionHalfExtents: { x: this.#collisionHalfExtents.x, y: this.#collisionHalfExtents.y, z: this.#collisionHalfExtents.z, },`
- `initialYaw: this.#currentYaw,`
- `customVisualLocalYaw: this.#customVisualLocalYaw,`
- `blockCount: boatChunkSnapshot?.blocks.length,`
- `boatChunk: boatChunkSnapshot`
- `blocks: boatChunkSnapshot.blocks.map((block) => ({ ...block })),`
- `center: { x: boatChunkSnapshot.center.x, y: boatChunkSnapshot.center.y, z: boatChunkSnapshot.center.z, },`
- `type: CustomBoat.CHUNK_ENTITY_TYPE,`
- `localX: number,`
- `localY: number,`
- `localZ: number,`
- `worldX: number,`
- `worldY: number,`
- `worldZ: number,`
- `blockState: this.#boatChunk.getBlockStateLocal(local.x, local.y, local.z),`
- `lightLevel: this.#boatChunk.getLightLocal(local.x, local.y, local.z),`
- `context: { kind: , boatChunk: this.#boatChunk, localX: local.x, localY: local.y, localZ: local.z, },`
- `worldX: number,`
- `worldY: number,`
- `worldZ: number,`
- `blockId: number,`
- `blockState: number,`
- `worldX: number,`
- `worldY: number,`
- `worldZ: number,`
- `ignoredDynamicBlockProviders: this.#ignoredDynamicBlockProviders,`

**Accessors**
- `public get boatChunk(): BoatChunk | undefined`
- `public get boatYaw(): number`
- `public get boatMesh(): Mesh`
- `public get boatPosition(): Vec3`
- `public get mount(): Mount`
- `public get submergedPoints(): number`
- `public get currentYaw(): number`
- `public get collisionHalfExtents(): Vec3`

**Methods**
- `public static getActiveBoats(): readonly CustomBoat[]`
- `public static tickAllActiveBoats(scene: SceneContext, playerPos?: Vec3): void`
- `public worldToBoatChunkLocalPoint(worldPoint: Vec3, out = vec3Zero()): Vec3 | null`
- `public boatChunkLocalPointToWorld(localPoint: Vec3, out = vec3Zero()): Vec3 | null`
- `public static configureChunkReloadContext(player: Player, waterLevel: number): void`
- `addToScene(scene, hull)`
- `setVec3(bp[0], cox - ox, y, coz - oz)`
- `setVec3(bp[1], cox + ox, y, coz - oz)`
- `setVec3(bp[2], cox - ox, y, coz + oz)`
- `setVec3(bp[3], cox + ox, y, coz + oz)`
- `setVec3(bp[4], cox, y, coz)`
- `setVec3(bp[5], cox - ix, y, coz - iz)`
- `setVec3(bp[6], cox + ix, y, coz - iz)`
- `setVec3(bp[7], cox - ix, y, coz + iz)`
- `setVec3(bp[8], cox + ix, y, coz + iz)`
- `setVec3(this.#tmpWorldPoint, this.#boat.position.x + rx, this.#boat.position.y + lp.y, this.#boat.position.z + rz)`
- `scaleVec3InPlace(this.#linearVelocity, d ** (dt * 60))`
- `scaleVec3InPlace(this.#angularVelocity, ad ** (dt * 60))`
- `setVec3(this.#tmpLever, worldPoint.x - this.#boat.position.x, worldPoint.y - this.#boat.position.y, worldPoint.z - this.#boat.position.z)`
- `setVec3(this.#tmpTorque, this.#tmpLever.y * fz - this.#tmpLever.z * fy, this.#tmpLever.z * fx - this.#tmpLever.x * fz, this.#tmpLever.x * fy - this.#tmpLever.y * fx)`
- `public applyImpulse(impulse: Vec3, point: Vec3)`
- `public applyAngularImpulse(impulse: Vec3): void`
- `public getBoatTopYToRef(out: Vec3): void`
- `public getBoatTopY(): Vec3`
- `public use(player: Player): void`
- `public dispose(): void`
- `setVec3(this.#collisionCenterOffset, (obbMaxX + obbMinX) / 2, 0, (obbMaxZ + obbMinZ) / 2)`
- `setVec3(this.#collisionHalfExtents, halfX + pad, halfY + pad, halfZ + pad)`
- `setVec3(this.#tmpBoatSampleWorld, worldX + 0.5, worldY + 0.5, worldZ + 0.5)`

**Types / Interfaces / Enums**
- type `Mesh`
- type `SceneContext`
- type `Vec3`
- type `DynamicBlockSample`
- type `CustomBoatOptions`
- type `SerializedBoatChunk`
- type `CustomBoatSerializedPayload`

---

## `Entities/MetadataContainer.ts` (18 LOC)

### export class MetadataContainer

**Properties**
- `private entries`

**Methods**
- `has(type: string): boolean`
- `delete(type: string): boolean`
- `getAll()`

---

## `Entities/Mobs/Chicken.ts` (118 LOC)

### export class Chicken extends NeutralMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: SceneContext, hp?: number)`

**Properties**
- `readonly mobType`
- `readonly CHUNK_ENTITY_TYPE`

**Methods**
- `super(hp ?? 4, scene, vec3(BODY_WIDTH * 0.5, BODY_HEIGHT * 0.5, BODY_DEPTH * 0.5))`
- `addToScene(Map1.mainScene, this.#bodyMesh)`
- `configureChunkLoader(scene: SceneContext): void`
- `getWanderSpeed(): number`
- `onDeath(): void`
- `dispose(): void`

**Types / Interfaces / Enums**
- type `LiteMetadata`
- type `Mesh`
- type `SceneContext`
- type `ChickenSerializedPayload`

---

## `Entities/Mobs/Mob.ts` (100 LOC)

### export class MobRegistry

**Properties**
- `private counts`
- `type: config.mobType,`
- `count: this.getCountByType(config.mobType),`
- `max: config.maxCount,`

**Methods**
- `register(config: MobSpawnConfig): void`
- `addMob(mob: Mob): void`
- `removeMob(mob: Mob): void`
- `getAllMobs(): ReadonlySet<Mob>`
- `getConfigs(): IterableIterator<MobSpawnConfig>`
- `getConfig(mobType: string): MobSpawnConfig | undefined`
- `getCountByType(mobType: string): number`
- `getTotalCount(): number`
- `disposeAll(): void`
- `pickSpawnType(): MobSpawnConfig | null`
- `getDebugStats()`

**Types / Interfaces / Enums**
- interface `Mob`
- type `MobSpawnConfig`

---

## `Entities/Mobs/MobMesh.ts` (140 LOC)

**Module-level functions**
- `export function createMobColorMaterial(color: Color3, name: string): ShaderMaterial`
- `export function buildBoxGeometry(width: number, height: number, depth: number)`

**Types / Interfaces / Enums**
- type `ShaderMaterial`

---

## `Entities/Mobs/MobSetup.ts` (32 LOC)

---

## `Entities/Mobs/NeutralMob.ts` (607 LOC)

### abstract export class NeutralMob

**Constructor**
- `constructor(hp: number, scene: SceneContext, halfSize: Vec3)`

**Properties**
- `readonly abstract mobType: string`
- `readonly abstract CHUNK_ENTITY_TYPE: string`
- `type: this.CHUNK_ENTITY_TYPE,`
- `payload: { position: { x: pos.x, y: pos.y, z: pos.z }, hp: this.#hp, ...extra, },`

**Accessors**
- `protected get scene(): SceneContext`
- `get position(): Vec3`
- `get hp(): number`
- `set hp(value: number)`
- `get maxHp(): number`
- `get isDisposed(): boolean`

**Methods**
- `abstract configureChunkLoader(scene: SceneContext): void`
- `abstract getWanderSpeed(): number`
- `abstract onDeath(): void`
- `onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			const dt = deltaMs / 1000;
			if (dt <= 0) return;
			for (const mob of NeutralMob.#allMobs) {
				if (!mob.#bodyMesh) continue;
				const pos = mob.#bodyMesh.position;
				const cx = Math.floor(pos.x / Chunk.SIZE);
				const cy = Math.floor(pos.y / Chunk.SIZE);
				const cz = Math.floor(pos.z / Chunk.SIZE);
				const chunk = getChunk(cx, cy, cz);
				if (!chunk || chunk.lodLevel > 1) continue;
				mob.tick(dt);
			}
		})`
- `static disposeAll(): void`
- `createVoxelColliderBlockSampler((wx, wy, wz) => {
					const blockId = getBlockByWorldCoords(wx, wy, wz);
					if (!isCollidableBlock(blockId)) return null;
					return {
						blockId,
						blockState: getBlockStateByWorldCoords(wx, wy, wz),
					};
				}, {
					getFenceDynamicShape,
					getShapeForBlockId,
					isFenceBlockId,
					computeFenceNeighborMask,
				})`
- `protected setBodyMesh(mesh: Mesh): void`
- `setPlayerPosition(pos: Vec3): void`
- `takeDamage(amount: number): void`
- `serializeForChunkReload(): SavedChunkEntityData | null`
- `use(_player: Player): void`
- `dispose(): void`
- `getBlockByWorldCoords(x, centerY, z)`
- `protected isInWater(): boolean`
- `protected isHeadSubmerged(): boolean`
- `tick(dt: number): void`
- `protected getExtraPayload(): Record<string, unknown>`
- `setVec3(pos, savedX, savedY, savedZ)`
- `copyVec3(probe, this.#bodyMesh.position as unknown as Vec3)`
- `findPathInto(this.#path, sx, sz, sy, tx, tz, this.#requiredHeadroom, 700, land.groundY)`
- `findPathInto(this.#path, sx, sz, startGroundY, tx, tz, this.#requiredHeadroom, 250)`

**Types / Interfaces / Enums**
- type `LiteMetadata`
- type `Mesh`
- type `SceneContext`
- type `Vec3`
- type `PathWaypoint`

---

## `Entities/Mobs/Sheep.ts` (131 LOC)

### export class Sheep extends NeutralMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: SceneContext, hp?: number, color?: Color3)`

**Properties**
- `readonly mobType`
- `readonly CHUNK_ENTITY_TYPE`

**Methods**
- `super(hp ?? 8, scene, vec3(BODY_WIDTH * 0.5, BODY_HEIGHT * 0.5, BODY_DEPTH * 0.5))`
- `addToScene(Map1.mainScene, this.#bodyMesh)`
- `configureChunkLoader(scene: SceneContext): void`
- `getWanderSpeed(): number`
- `onDeath(): void`
- `protected override getExtraPayload(): Record<string, unknown>`
- `dispose(): void`

**Module-level functions**
- `function colorToPayload(c: Color3)`
- `function payloadToColor(p: { r: number; g: number; b: number }): Color3`
- `function randomSheepColor(): Color3`

**Types / Interfaces / Enums**
- type `LiteMetadata`
- type `Mesh`
- type `SceneContext`
- type `SheepSerializedPayload`

---

## `Entities/Mount.ts` (125 LOC)

### export class Mount implements IMountable

**Constructor**
- `constructor(vehicle: Mesh, keyBoardControls: IControls<unknown>, options: MountOptions = {})`

**Properties**
- `public user: IMountableUser | null = null`
- `public vehicle: Mesh`
- `static isMountableUser: (value: unknown) => value is IMountableUser = (( v: unknown, ): v is IMountableUser => false) as ( value: unknown, ) => value is IMountableUser`
- `x: 0,`
- `y: 0,`
- `z: 0,`
- `w: 1,`

**Methods**
- `isMounted(): boolean`
- `mount(user: unknown): boolean`
- `dismount(): boolean`
- `getMountedUser(): IMountableUser | null`
- `getKeyBoardControls(): IControls<unknown>`
- `setMountOffset(offset: Vec3): void`
- `setMountRotationOffset(rotationOffset: Quat): void`
- `update(): void`
- `private updateMountedPosition(): void`
- `private disablePlayerPhysics(player: IPlayerBody): void`
- `private enablePlayerPhysics(playerVehicle: IPlayerBody): void`

**Types / Interfaces / Enums**
- interface `IMountableUser`

---

## `Entities/MountOptions.ts` (7 LOC)

**Types / Interfaces / Enums**
- interface `MountOptions`

---

## `Entities/SpawnCoordinator.ts` (155 LOC)

### export class SpawnCoordinator

**Constructor**
- `constructor(scene: SceneContext, getPlayerPosition: () => Vec3, registry: MobRegistry)`

**Properties**
- `playerPos: Vec3,`
- `config: MobSpawnConfig,`
- `tooClose`
- `x: wx + 0.5,`
- `y: spawnY + (config.spawnYOffset ?? 0.2),`
- `z: wz + 0.5,`

**Accessors**
- `get registry(): MobRegistry`

**Methods**
- `onBeforeRender(this.#scene, () => {
			if (this.#disposed) return;
			this.#tick();
		})`
- `dispose(): void`

---

## `Generation/Biome/BiomeDefinitions/CoastalBiomes/CoastalBiomes.ts` (213 LOC)

---

## `Generation/Biome/BiomeDefinitions/ColdBiomes/ColdBiomes.ts` (195 LOC)

---

## `Generation/Biome/BiomeDefinitions/ColdBiomes/ColdTrees.ts` (62 LOC)

---

## `Generation/Biome/BiomeDefinitions/ExoticBiomes/ExoticBiomes.ts` (69 LOC)

---

## `Generation/Biome/BiomeDefinitions/ExoticBiomes/ExoticTrees.ts` (52 LOC)

---

## `Generation/Biome/BiomeDefinitions/GeologicalBiomes/GeologicalBiomes.ts` (106 LOC)

---

## `Generation/Biome/BiomeDefinitions/GeologicalBiomes/GeologicalTrees.ts` (315 LOC)

**Module-level functions**
- `function heightHash(worldX: number, worldZ: number, seedAsInt: number): number`
- `function leafHash(x: number, y: number, z: number, seedAsInt: number): number`

---

## `Generation/Biome/BiomeDefinitions/HotBiomes/HotBiomes.ts` (255 LOC)

---

## `Generation/Biome/BiomeDefinitions/HotBiomes/HotTrees.ts` (132 LOC)

---

## `Generation/Biome/BiomeDefinitions/MountainBiomes/MountainBiomes.ts` (115 LOC)

---

## `Generation/Biome/BiomeDefinitions/MountainBiomes/MountainTrees.ts` (106 LOC)

---

## `Generation/Biome/BiomeDefinitions/TemperateBiomes/TemperateBiomes.ts` (355 LOC)

---

## `Generation/Biome/BiomeDefinitions/TemperateBiomes/TemperateTrees.ts` (446 LOC)

**Module-level functions**
- `function placeWood(x: number, y: number, z: number): void`

---

## `Generation/Biome/BiomeDefinitions/TropicalBiomes/TropicalBiomes.ts` (108 LOC)

---

## `Generation/Biome/BiomeDefinitions/TropicalBiomes/TropicalTrees.ts` (182 LOC)

---

## `Generation/Biome/Biomes.ts` (408 LOC)

**Module-level functions**
- `export function getBiomeFor(temperature: number, humidity: number, continentalness: number, _river: number, terrainShapedHeight: number): Biome`

---

## `Generation/Biome/BiomeTypes.ts` (110 LOC)

**Types / Interfaces / Enums**
- interface `Biome`
- type `TreeDefinition`

---

## `Generation/Biome/TreeDefinition.ts` (414 LOC)

**Module-level functions**
- `function packLocal(dx: number, dy: number, dz: number): number`
- `function placeWood(x: number, y: number, z: number): void`
- `function placeWood(x: number, y: number, z: number): void`
- `function placeWood(x: number, y: number, z: number): void`

---

## `Generation/CaveCarver.ts` (99 LOC)

**Module-level functions**
- `function clamp01(value: number): number`
- `export function getDepthBelowSurface(surfaceY: number, worldY: number): number`
- `export function getSurfaceCarveBlend(depthBelowSurface: number): number`
- `export function evaluateCaveCarve(params: GenerationParamsType, worldY: number, surfaceY: number, cheese: number, tunnel: number, detail: number, out?: CaveCarveEvaluation): CaveCarveEvaluation`

**Types / Interfaces / Enums**
- type `CaveCarveEvaluation`

---

## `Generation/CaveNoiseGrid.ts` (68 LOC)

### export class CaveNoiseGrid

**Constructor**
- `constructor(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number, sampleRate: number, cheeseFn: (x: number, y: number, z: number) => number, tunnelFn: (x: number, y: number, z: number) => number, detailFn: (x: number, y: number, z: number) => number)`

**Properties**
- `private readonly cheese: NoiseSampler`
- `private readonly tunnel: NoiseSampler`
- `private readonly detail: NoiseSampler`

**Methods**
- `public reset(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number): void`
- `public getCheese(localX: number, localY: number, localZ: number): number`
- `public getTunnel(localX: number, localY: number, localZ: number): number`
- `public getDetail(localX: number, localY: number, localZ: number): number`

---

## `Generation/DistantTerrain/DistantTerrain.ts` (283 LOC)

**Module-level functions**
- `function createEmptyGridMesh(engine: EngineContext, name: string): Mesh`
- `function ensureFloatBuffers()`
- `function updateUniforms()`
- `function applyTerrainData(pos: Int16Array, nrm: Int8Array, tiles: Uint8Array, worldX: number, worldZ: number)`
- `async export function initDistantTerrain(): Promise<void>`
- `export function isInitialized(): boolean`
- `export function update(worldX: number, worldZ: number)`
- `export function dispose(): void`

**Types / Interfaces / Enums**
- type `EngineContext`
- type `Mesh`
- type `SceneContext`

---

## `Generation/DistantTerrain/DistantTerrainGenerator.ts` (365 LOC)

**Module-level functions**
- `function cachedHeight(wx: number, wz: number): number`
- `export function initSharedBuffers(positionsBuffer: SharedArrayBuffer, normalsBuffer: SharedArrayBuffer, surfaceTilesBuffer: SharedArrayBuffer, r: number, gStep: number)`
- `export function generate(centerChunkX: number, centerChunkZ: number, r: number, gStep: number, forceFullRebuild = false)`
- `function ensureBuffers(r: number, gStep: number)`
- `function configureGrid(r: number, gStep: number)`
- `function allocateLocalBuffers()`
- `function resetTracking()`
- `function fullGenerate(gcx: number, gcz: number, ccx: number, ccz: number)`
- `function slideArrays(shiftX: number, shiftZ: number)`
- `function regenerateEdges(shiftX: number, shiftZ: number, gcx: number, gcz: number, ccx: number, ccz: number)`
- `function rewriteLocalXZ(ccx: number, ccz: number, gcx: number, gcz: number)`
- `function generateVertex(x: number, z: number, gcx: number, gcz: number, ccx: number, ccz: number)`
- `function getTopTileForBlock(blockId: number): [number, number]`

---

## `Generation/LightGenerator.ts` (334 LOC)

### export class LightGenerator

**Constructor**
- `constructor(params: GenerationParamsType)`

**Properties**
- `private static chunkSize: number`
- `private static chunkSizeSq: number`
- `private lightQueue: Uint16Array`
- `private static queueMask: number`
- `private static scratchQueue: Uint16Array | null = null`
- `private static readonly SKYLIGHT_GENERATION_MIN_WORLD_Y`
- `private static readonly _transparentLUT: Uint8Array = (() => { const lut = new Uint8Array(128); lut[0] = 1; lut[WATER_BLOCK_ID] = 1; lut[60] = 1; lut[61] = 1; lut[64] = 1; lut[66] = 1; return lut; })()`

**Methods**
- `public seedInitialLight(chunkX: number, chunkY: number, chunkZ: number, _biome: Biome, blocks: Uint8Array, light: Uint8Array, topSunlightMask?: Uint8Array): LightSeedState`
- `public propagateLight(blocks: Uint8Array, light: Uint8Array, seedState: LightSeedState): void`
- `private seedInitialLightIntoSharedQueue(_chunkX: number, chunkY: number, _chunkZ: number, blocks: Uint8Array, light: Uint8Array, topSunlightMask?: Uint8Array): number`
- `private propagateLightFromQueue(blocks: Uint8Array, light: Uint8Array, queue: Uint16Array, initialTail: number): void`
- `private tryPropagate(nx: number, ny: number, nz: number, targetSky: number, targetBlock: number, sourceBlockId: number, isDown: boolean, blocks: Uint8Array, light: Uint8Array, queue: Uint16Array, tail: number, CHUNK_SIZE: number, CHUNK_SIZE_SQ: number): number`
- `private static isTransparentBlock(blockId: number): boolean`

**Module-level functions**
- `function nextPowerOfTwo(n: number): number`

**Types / Interfaces / Enums**
- type `LightSeedState`

---

## `Generation/NoiseAndParameters/FastNoise/FastNoiseFactory.ts` (109 LOC)

**Module-level functions**
- `export function createFastNoise(seed: number, fractalType?: FractalType, frequency?: number): FastNoiseLite;
export function createFastNoise(options: FastNoiseOptions): FastNoiseLite;
export function createFastNoise(
	seedOrOptions: number | FastNoiseOptions,
	fractalType?: FractalType,
	frequency?: number,
): FastNoiseLite`
- `export function createFastNoise2D(seed: number, fractalType?: FractalType, frequency?: number): (x: number, z: number) => number;
export function createFastNoise2D(
	options: FastNoiseOptions,
): (x: number, z: number) => number;
export function createFastNoise2D(
	seedOrOptions: number | FastNoiseOptions,
	fractalType?: FractalType,
	frequency?: number,
): (x: number, z: number) => number`
- `export function createFastNoise3D(options: FastNoiseOptions): (x: number, y: number, z: number) => number;
export function createFastNoise3D(
	seedOrOptions: number | FastNoiseOptions,
	fractalType?: FractalType,
	frequency?: number,
): (x: number, y: number, z: number) => number`
- `export function createFastNoise2DWithInstance(seedOrOptions: number | FastNoiseOptions, fractalType?: FractalType, frequency?: number): FastNoise2DResult`
- `export function createFastNoise3DWithInstance(seedOrOptions: number | FastNoiseOptions, fractalType?: FractalType, frequency?: number): FastNoise3DResult`

**Types / Interfaces / Enums**
- interface `FastNoiseOptions`
- type `FastNoise2DResult`
- type `FastNoise3DResult`

---

## `Generation/NoiseAndParameters/FastNoise/FastNoiseLite.ts` (2922 LOC)

**Types / Interfaces / Enums**
- interface `Vector2`
- interface `Vector3`
- type `SingleNoiseFn2`
- type `SingleNoiseFn3`
- type `NoiseFn2`
- type `NoiseFn3`
- enum `NoiseType`
- enum `RotationType3D`
- enum `FractalType`
- enum `CellularDistanceFunction`
- enum `CellularReturnType`
- enum `DomainWarpType`
- enum `TransformType3D`

---

## `Generation/NoiseAndParameters/GenerationParams.ts` (37 LOC)

**Types / Interfaces / Enums**
- type `GenerationParamsType`

---

## `Generation/NoiseAndParameters/NoiseSampler.ts` (131 LOC)

### export class NoiseSampler

**Constructor**
- `constructor(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number, sampleRate: number, scale: number, xzFactor: number, noiseFunction: (x: number, y: number, z: number) => number)`

**Properties**
- `private noiseSamples: Float32Array`
- `private sampleRate: number`
- `private pointsPerDim: number`
- `private noiseFunction: (x: number, y: number, z: number) => number`
- `private scale: number`
- `private xzFactor: number`
- `private readonly isPow2: boolean`
- `private readonly rateShift: number`
- `private readonly rateMask: number`
- `private readonly invSampleRate: number`

**Methods**
- `public reset(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number): void`
- `private sampleNoise(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number): void`
- `public get(localX: number, localY: number, localZ: number): number`

---

## `Generation/NoiseAndParameters/Spline.ts` (63 LOC)

### export class Spline

**Constructor**
- `constructor(points: SplinePoint[])`

**Properties**
- `private points: SplinePoint[]`
- `private tMin: number`
- `private tMax: number`
- `private lut: Float32Array`
- `private static readonly LUT_SIZE`

**Methods**
- `private evaluate(t: number): number`
- `public getValue(t: number): number`

**Types / Interfaces / Enums**
- interface `SplinePoint`

---

## `Generation/NoiseAndParameters/Squirrel13.ts` (26 LOC)

**Module-level functions**
- `export function getPRNGBySeed(position: number, seed: number): number`
- `export function getPRNG(position: number): number`

---

## `Generation/OreGenerator.ts` (163 LOC)

### export class OreGenerator

**Constructor**
- `constructor(params: GenerationParamsType, oreNoise: (x: number, y: number, z: number) => number, seedAsInt: number)`

**Properties**
- `private params: GenerationParamsType`
- `private oreNoise: (x: number, y: number, z: number) => number`
- `private seedAsInt: number`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, blocks: Uint8Array)`

**Types / Interfaces / Enums**
- type `OreDefinition`

---

## `Generation/RiverGeneration.ts` (77 LOC)

### export class RiverGenerator

**Constructor**
- `constructor(params: GenerationParamsType)`

**Properties**
- `private params: GenerationParamsType`
- `private readonly TUNNEL_RADIUS`
- `private readonly TUNNEL_CENTER_Y: number`
- `private static riverNoise: (x: number, z: number) => number`
- `private static riverNoiseInst: FastNoiseLite`
- `private static wallNoise: (x: number, y: number, z: number) => number`
- `private riverSpline: Spline`
- `private riverDepthSpline: Spline`
- `frequency: 0.1,`
- `frequency: GenerationParams.RIVER_SCALE,`

**Methods**
- `public isRiver(worldX: number, worldY: number, worldZ: number, riverNoise: number): boolean`
- `public getRiverNoise(x: number, z: number): number`
- `public getRiverDepth(riverValue: number): number`
- `public fillRiverNoise2D(out: Float32Array, width: number, height: number, offsetX: number, offsetY: number): void`

**Types / Interfaces / Enums**
- type `GenerationParamsType`

---

## `Generation/Structure/AbandonedCabinFeature.ts` (92 LOC)

### export class AbandonedCabinFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/AbyssalTempleFeature.ts` (109 LOC)

### export class AbyssalTempleFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number)`

---

## `Generation/Structure/BadlandsSpireFeature.ts` (303 LOC)

### export class BadlandsSpireFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`
- `private generateSpire(_chunkX: number, chunkY: number, _chunkZ: number, spireX: number, spireZ: number, groundHeight: number, spireHeight: number, tierHeight: number, halfFp: number, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, chunkSize: number, seed: number)`
- `private generateTierSlice(worldY: number, groundHeight: number, tierHeight: number, centerX: number, centerZ: number, noiseOffX: number, noiseOffZ: number, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number)`
- `private getLayerBlock(spireLocalY: number, seed: number): number`
- `private findGroundHeight(x: number, z: number, halfFp: number, columnPrepassResolver?: ColumnPrepassResolver): number`

---

## `Generation/Structure/BambooShrineFeature.ts` (93 LOC)

### export class BambooShrineFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/CaravanCampFeature.ts` (93 LOC)

### export class CaravanCampFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/CliffDwellingFeature.ts` (101 LOC)

### export class CliffDwellingFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/CrystalShrineFeature.ts` (77 LOC)

### export class CrystalShrineFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/DesertOasisFeature.ts` (80 LOC)

### export class DesertOasisFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/DockFeature.ts` (106 LOC)

### export class DockFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/DungeonFeature.ts` (173 LOC)

### export class DungeonFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number)`
- `private carveCorridor(x1: number, x2: number, z1: number, z2: number, yBase: number, placeBlock: PlaceBlockFn, floorBlock: number, minX: number, maxX: number, minZ: number, maxZ: number)`

**Types / Interfaces / Enums**
- type `PlaceBlockFn`

---

## `Generation/Structure/FossilBedFeature.ts` (103 LOC)

### export class FossilBedFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number)`

---

## `Generation/Structure/FrozenShrineFeature.ts` (80 LOC)

### export class FrozenShrineFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/GeodeFeature.ts` (79 LOC)

### export class GeodeFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number)`

---

## `Generation/Structure/IglooFeature.ts` (86 LOC)

### export class IglooFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/InfernalPitFeature.ts` (85 LOC)

### export class InfernalPitFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number)`

---

## `Generation/Structure/IWorldFeature.ts` (36 LOC)

**Types / Interfaces / Enums**
- interface `IWorldFeature`
- type `FeatureVerticalBounds`
- type `ColumnPrepassResolver`

---

## `Generation/Structure/LavaPoolFeature.ts` (152 LOC)

### export class LavaPoolFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`
- `private generateLavaPool(poolCenterX: number, poolCenterY: number, poolCenterZ: number, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number)`

---

## `Generation/Structure/LighthouseFeature.ts` (111 LOC)

### export class LighthouseFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/MineshaftFeature.ts` (129 LOC)

### export class MineshaftFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number)`
- `private carveTunnel(x1: number, x2: number, y: number, zCenter: number, minX: number, maxX: number, minZ: number, maxZ: number, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void)`

---

## `Generation/Structure/MountainCabinFeature.ts` (88 LOC)

### export class MountainCabinFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/MushroomHutFeature.ts` (83 LOC)

### export class MushroomHutFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/ObservatoryFeature.ts` (77 LOC)

### export class ObservatoryFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/PetrifiedShrineFeature.ts` (78 LOC)

### export class PetrifiedShrineFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/PyramidFeature.ts` (97 LOC)

### export class PyramidFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/RavineFeature.ts` (112 LOC)

### export class RavineFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number)`

---

## `Generation/Structure/RegionFeature.ts` (70 LOC)

**Module-level functions**
- `export function computeRegion(chunkX: number, chunkZ: number, chunkSize: number, seed: number, config: RegionConfig): RegionResult | null`
- `export function chunkWorldBounds(genChunkX: number, genChunkZ: number, chunkSize: number)`
- `export function aabbOverlaps(fMinX: number, fMaxX: number, fMinZ: number, fMaxZ: number, cMinX: number, cMaxX: number, cMinZ: number, cMaxZ: number): boolean`

**Types / Interfaces / Enums**
- interface `RegionConfig`
- interface `RegionResult`

---

## `Generation/Structure/RuinFeature.ts` (109 LOC)

### export class RuinFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/ShipwreckFeature.ts` (110 LOC)

### export class ShipwreckFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/SnowFortFeature.ts` (118 LOC)

### export class SnowFortFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/StoneCircleFeature.ts` (100 LOC)

### export class StoneCircleFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/Structure.ts` (53 LOC)

### export class Structure

**Constructor**
- `constructor(data: StructureData)`

**Properties**
- `public readonly width: number`
- `public readonly height: number`
- `public readonly depth: number`
- `private blocks: Uint8Array`

**Methods**
- `public place(originX: number, originY: number, originZ: number, placeBlock: PlaceBlockFunction)`

**Types / Interfaces / Enums**
- interface `StructureData`
- type `PlaceBlockFunction`

---

## `Generation/Structure/StructureBuilder.ts` (282 LOC)

### export class StructureBuilder

**Constructor**
- `constructor(place: PlaceFn, resolver: ColumnPrepassResolver | undefined, seed: number)`

**Properties**
- `public readonly place: PlaceFn`
- `public readonly resolver: ColumnPrepassResolver | undefined`
- `public readonly seed: number`

**Methods**
- `ground(wx: number, wz: number): number`
- `footprintGround(cx: number, cz: number, hx: number, hz: number)`
- `set(x: number, y: number, z: number, id: number, ow = true): void`
- `air(x: number, y: number, z: number): void`
- `column(x: number, baseY: number, z: number, height: number, id: number, ow = true): void`
- `box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number, ow = true): void`
- `foundation(cx: number, cz: number, hx: number, hz: number, baseY: number, id: number, ow = true): void`
- `shell(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number, door?: DoorSpec, ow = true): void`
- `private inDoor(x: number, y: number, z: number, x0: number, y0: number, z0: number, x1: number, _y1: number, z1: number, door: DoorSpec, dw: number, dh: number, off: number): boolean`
- `windowPair(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, glass: number): void`
- `disc(cx: number, y: number, cz: number, radius: number, id: number, ow = true): void`
- `ring(cx: number, y: number, cz: number, radius: number, id: number, ow = true): void`
- `static rotate(dx: number, dz: number, rot: number): [number, number]`
- `buildHouse(o: HouseOptions): void`

**Types / Interfaces / Enums**
- interface `DoorSpec`
- interface `HouseOptions`
- type `PlaceFn`
- type `DoorSide`

---

## `Generation/Structure/StructureFeature.ts` (116 LOC)

### export class StructureSpawnerFeature implements IWorldFeature

**Constructor**
- `constructor()`

**Properties**
- `public readonly verticalBounds`
- `private static structures: Map<string, Structure> = new Map()`
- `private static structureNames: string[] = []`

**Methods**
- `private loadStructures()`
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/TowerFeature.ts` (229 LOC)

### export class TowerFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`
- `private generateCylinderTower(_chunkX: number, chunkY: number, _chunkZ: number, towerCenterX: number, towerCenterZ: number, towerRadius: number, groundHeight: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, chunkSize: number, seed: number, columnPrepassResolver?: ColumnPrepassResolver)`
- `private generateUndergroundCylinderTower(_chunkX: number, chunkY: number, _chunkZ: number, towerCenterX: number, towerCenterZ: number, towerRadius: number, groundHeight: number, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, chunkSize: number)`
- `private findMinGroundHeightForTower(towerCenterX: number, towerCenterZ: number, towerRadius: number, _biome: Biome, columnPrepassResolver?: ColumnPrepassResolver): number`

---

## `Generation/Structure/TreehouseFeature.ts` (104 LOC)

### export class TreehouseFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/TropicalTempleFeature.ts` (116 LOC)

### export class TropicalTempleFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/WatchtowerFeature.ts` (107 LOC)

### export class WatchtowerFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/WellFeature.ts` (108 LOC)

### export class WellFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/Structure/WindmillFeature.ts` (99 LOC)

### export class WindmillFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

---

## `Generation/SurfaceGenerator.ts` (1198 LOC)

### export class SurfaceGenerator

**Constructor**
- `constructor(params: GenerationParamsType, treeNoise: (x: number, z: number) => number, densityNoise: (x: number, y: number, z: number) => number, seedAsInt: number, cheeseNoise: (x: number, y: number, z: number) => number, tunnelNoise: (x: number, y: number, z: number) => number, detailNoise: (x: number, y: number, z: number) => number)`

**Properties**
- `private params: GenerationParamsType`
- `private static treeNoise: (x: number, z: number) => number`
- `private static densityNoise: (x: number, y: number, z: number) => number`
- `private cheeseNoise: (x: number, y: number, z: number) => number`
- `private tunnelNoise: (x: number, y: number, z: number) => number`
- `private detailNoise: (x: number, y: number, z: number) => number`
- `private static readonly DENSITY_BASE_AMPLITUDE`
- `private static readonly DENSITY_OVERHANG_AMPLITUDE`
- `private static readonly DENSITY_CLIFF_AMPLITUDE`
- `private static readonly DENSITY_INFLUENCE_RANGE`
- `private static readonly DENSITY_VERTICAL_SCAN_RANGE`
- `private static readonly MAX_TREE_HEIGHT`
- `private static readonly MAX_STRUCTURE_ABOVE_SURFACE`
- `private static readonly MAX_STRUCTURE_BELOW_SURFACE`
- `private readonly maxStructureAboveSurface: number`
- `private static seedAsInt: number`
- `private static readonly COLUMN_CACHE_SIZE`
- `private static readonly COLUMN_CACHE_MASK`
- `private static readonly columnCacheKeys`
- `private static readonly columnCacheEntries: (ColumnPrepassCacheEntry | null)[] =`
- `private static readonly FLORA_CACHE_SIZE`
- `private static readonly FLORA_CACHE_MASK`
- `private static readonly floraCacheKeys`
- `private static readonly floraCacheEntries: (FloraColumnCacheEntry | null)[] =`
- `private chunk_size: number`
- `private riverGenerator: RiverGenerator`
- `private features: IWorldFeature[]`
- `private readonly caveGrid: CaveNoiseGrid`
- `private caveGridReady`
- `private caveGridChunkX`
- `private caveGridChunkY`
- `private caveGridChunkZ`
- `private curChunkWorldX`
- `private curChunkWorldY`
- `private curChunkWorldZ`

**Methods**
- `private packXZKey(x: number, z: number): number`
- `private getColumnPrepassKey(chunkX: number, chunkZ: number): number`
- `private static evalSurfaceDensity(y: number, baseNoiseX: number, yFreq: number, baseNoiseZ: number, baseHeight: number, baseAmp: number, overhangBaseX: number, overhangBaseZ: number, overhangAmp: number, cliffContribution: number): number`
- `private hashColumn(x: number, z: number, seed: number): number`

**Types / Interfaces / Enums**
- type `GenerationParamsType`
- type `SurfaceGenerationResult`
- type `ColumnPrepassCacheEntry`
- type `FloraColumnCacheEntry`

---

## `Generation/Terrain/StructurePlacer.ts` (70 LOC)

---

## `Generation/Terrain/SurfaceBlockResolver.ts` (27 LOC)

**Module-level functions**
- `export function resolveSolidBlockId(currentBiome: Biome, worldY: number, depthBelowSurface: number, isBeach: boolean, seaLevel: number): number`

---

## `Generation/TerrainHeightMap.ts` (434 LOC)

**Module-level functions**
- `function applyRidged(raw: number): number`
- `function fillChunkCache(cx: number, cz: number, idx: number): void`
- `function getChunkCacheIdx(worldX: number, worldZ: number): number`
- `export function getFinalTerrainHeight(x: number, z: number): number`
- `export function getBiome(x: number, z: number): Biome`
- `export function getCachedRiverNoise(x: number, z: number): number`
- `export function getOctaveNoise(x: number, z: number): number`
- `export function getTerrainNoiseDebug(x: number, z: number)`
- `function getBiomeBase(b: Biome): number`
- `function getBiomeAmp(b: Biome): number`
- `function getBiomeScale(b: Biome): number`
- `function getBiomeExp(b: Biome): number`
- `function getBiomePvScale(b: Biome): number`
- `function getBiomeErosionScale(b: Biome): number`
- `function fillCorner(gx: number, gz: number, worldX: number, worldZ: number, out: Float32Array): void`
- `export function prefetchChunkCorners(chunkWorldX: number, chunkWorldZ: number): void`

**Types / Interfaces / Enums**
- type `GenerationParamsType`

---

## `Generation/UndergroundBiomes.ts` (125 LOC)

### export class UndergroundBiomeSelector

**Constructor**
- `constructor(biomeNoise: (x: number, z: number) => number, seedAsInt: number)`

**Properties**
- `private readonly biomeNoise: (x: number, z: number) => number`
- `private readonly seedAsInt: number`

**Methods**
- `public getBiome(worldX: number, worldY: number, worldZ: number): UndergroundBiome`
- `public getStoneReplacement(blockId: number, biome: UndergroundBiome): number`

**Types / Interfaces / Enums**
- type `UndergroundBiome`

---

## `Generation/UndergroundGenerator.ts` (138 LOC)

### export class UndergroundGenerator

**Constructor**
- `constructor(params: GenerationParamsType, cheeseNoise: (x: number, y: number, z: number) => number, tunnelNoise: (x: number, y: number, z: number) => number, detailNoise: (x: number, y: number, z: number) => number)`

**Properties**
- `private readonly params: GenerationParamsType`
- `private readonly CHUNK_SIZE: number`
- `private readonly LAVA_LEVEL: number`
- `private readonly cheeseNoise: (x: number, y: number, z: number) => number`
- `private readonly tunnelNoise: (x: number, y: number, z: number) => number`
- `private readonly detailNoise: (x: number, y: number, z: number) => number`
- `private readonly caveGrid: CaveNoiseGrid`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, topSurfaceYMap: Int16Array, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow?: boolean,
		) => void, blocks?: Uint8Array): void`

---

## `Generation/WorldGenerator.ts` (267 LOC)

### export class WorldGenerator

**Constructor**
- `constructor(params: GenerationParamsType)`

**Properties**
- `private params: GenerationParamsType`
- `private prng: ReturnType<typeof Alea>`
- `private seedAsInt: number`
- `private chunkSizeSq: number`
- `private chunk_size: number`
- `private chunkVolume: number`
- `private surfaceGenerator: SurfaceGenerator`
- `private undergroundGenerator: UndergroundGenerator`
- `private oreGenerator: OreGenerator`
- `private undergroundBiomeSelector: UndergroundBiomeSelector`
- `private lightGenerator: LightGenerator`
- `private cheeseNoise: (x: number, y: number, z: number) => number`
- `private tunnelNoise: (x: number, y: number, z: number) => number`
- `private detailNoise: (x: number, y: number, z: number) => number`
- `seed: getPRNGBySeed(21, this.seedAsInt),`
- `frequency: 1,`
- `seed: getPRNGBySeed(2, this.seedAsInt),`
- `frequency: this.params.CAVE_CHEESE_FREQ,`
- `seed: getPRNGBySeed(22, this.seedAsInt),`
- `frequency: this.params.CAVE_TUNNEL_FREQ,`
- `seed: getPRNGBySeed(24, this.seedAsInt),`
- `frequency: this.params.CAVE_DETAIL_FREQ,`
- `seed: getPRNGBySeed(23, this.seedAsInt),`
- `frequency: 0.33333,`
- `seed: getPRNGBySeed(25, this.seedAsInt),`
- `frequency: 1,`
- `seed: getPRNGBySeed(26, this.seedAsInt),`
- `frequency: 0.001,`

**Methods**
- `private createBuffer(size: number): Uint8Array`
- `private applyUndergroundBiomes(blocks: Uint8Array, chunkWorldX: number, chunkWorldY: number, chunkWorldZ: number, chunkSize: number, chunkSizeSq: number): void`
- `public refineBlocks(blocks: Uint8Array, chunkX: number, chunkY: number, chunkZ: number): void`
- `public generateChunkData(chunkX: number, chunkY: number, chunkZ: number, options: GenerateChunkOptions = {}): GenerateChunkResult`

**Types / Interfaces / Enums**
- type `GenerateChunkOptions`
- type `GenerateChunkResult`

---

## `Interface/IControls.ts` (10 LOC)

**Types / Interfaces / Enums**
- interface `IControls`

---

## `Interface/IMountable.ts` (6 LOC)

**Types / Interfaces / Enums**
- interface `IMountable`

---

## `Interface/IPlayerContext.ts` (7 LOC)

**Types / Interfaces / Enums**
- interface `IPlayerContext`

---

## `Interface/IUsable.ts` (4 LOC)

**Types / Interfaces / Enums**
- interface `IUsable`

---

## `Lib/Math.ts` (1312 LOC)

### export class Color3

**Constructor**
- `constructor(public r: number = 0, public g: number = 0, public b: number = 0)`

**Methods**
- `static Black(): Color3`
- `static White(): Color3`
- `static Red(): Color3`
- `static Green(): Color3`
- `static Blue(): Color3`
- `static Gray(): Color3`
- `static Purple(): Color3`
- `static Yellow(): Color3`
- `static Teal(): Color3`
- `static Magenta(): Color3`
- `static FromArray(arr: ArrayLike<number>, offset = 0): Color3`
- `static FromInts(r: number, g: number, b: number): Color3`
- `static Lerp(left: Color3, right: Color3, amount: number): Color3`
- `static Random(): Color3`
- `clone(): Color3`
- `copyFrom(src: Color3): Color3`
- `copyFromFloats(r: number, g: number, b: number): Color3`
- `toArray(arr: number[] | Float32Array, offset = 0): number[] | Float32Array`
- `toColor4(alpha = 1): Color4`
- `scale(scale: number): Color3`
- `scaleToRef(scale: number, result: Color3): Color3`
- `add(other: Color3): Color3`
- `subtract(other: Color3): Color3`
- `multiply(other: Color3): Color3`
- `equals(other: Color3): boolean`
- `toString(): string`

### export class Color4

**Constructor**
- `constructor(public r: number = 0, public g: number = 0, public b: number = 0, public a: number = 1)`

**Methods**
- `static Black(): Color4`
- `static White(): Color4`
- `static FromArray(arr: ArrayLike<number>, offset = 0): Color4`
- `static Lerp(left: Color4, right: Color4, amount: number): Color4`
- `clone(): Color4`
- `copyFrom(src: Color4): Color4`
- `copyFromFloats(r: number, g: number, b: number, a: number): Color4`
- `toArray(arr: number[] | Float32Array, offset = 0): number[] | Float32Array`
- `asArray(): [number, number, number, number]`
- `toColor3(): Color3`
- `scale(scale: number): Color4`
- `add(other: Color4): Color4`
- `multiply(other: Color4): Color4`
- `equals(other: Color4): boolean`

### export class Quaternion

**Constructor**
- `constructor(public x: number = 0, public y: number = 0, public z: number = 0, public w: number = 1)`

**Methods**
- `static Identity(): Quaternion`
- `static FromEulerAngles(x: number, y: number, z: number): Quaternion`
- `static FromEulerAnglesToRef(x: number, y: number, z: number, result: Quaternion): Quaternion`
- `static RotationAxis(axis: Vec3, angle: number): Quaternion`
- `static RotationYawPitchRoll(yaw: number, pitch: number, roll: number): Quaternion`
- `static RotationQuaternionFromAxis(axis1: Vec3, axis2: Vec3, axis3: Vec3): Quaternion`
- `static FromRotationMatrix(matrix: Matrix): Quaternion`
- `static FromRotationMatrixToRef(matrix: Matrix, result: Quaternion): Quaternion`
- `static Slerp(left: Quaternion, right: Quaternion, amount: number): Quaternion`
- `static Dot(left: Quaternion, right: Quaternion): number`
- `static Normalize(q: Quaternion): Quaternion`
- `static NormalizeToRef(q: Quaternion, result: Quaternion): Quaternion`
- `static RotateVectorToRef(q: Quaternion, v: Vec3, result: Vec3): Vec3`
- `clone(): Quaternion`
- `copyFrom(src: Quaternion): Quaternion`
- `copyFromFloats(x: number, y: number, z: number, w: number): Quaternion`
- `set(x: number, y: number, z: number, w: number): Quaternion`
- `toEulerAngles(): Vec3`
- `toRotationMatrix(): Matrix`
- `static ToRotationMatrixToRef(q: Quaternion, result: Matrix): Matrix`
- `normalize(): Quaternion`
- `conjugateInPlace(): Quaternion`
- `conjugate(): Quaternion`
- `invert(): Quaternion`
- `multiply(q: Quaternion): Quaternion`
- `multiplyToRef(q: Quaternion, result: Quaternion): Quaternion`
- `static MultiplyToRef(left: Quaternion, right: Quaternion, result: Quaternion): Quaternion`
- `scale(scale: number): Quaternion`
- `scaleToRef(scale: number, result: Quaternion): Quaternion`
- `add(other: Quaternion): Quaternion`
- `subtract(other: Quaternion): Quaternion`
- `dot(other: Quaternion): number`
- `length(): number`
- `equals(other: Quaternion): boolean`
- `toArray(arr: number[] | Float32Array, offset = 0): number[] | Float32Array`

### export class Matrix

**Constructor**
- `constructor(public m: number[] = Matrix.Identity().m.slice())`

**Methods**
- `static Identity(): Matrix`
- `static Zero(): Matrix`
- `static Translation(x: number, y: number, z: number): Matrix`
- `static Scaling(x: number, y: number, z: number): Matrix`
- `static RotationX(angle: number): Matrix`
- `static RotationY(angle: number): Matrix`
- `static RotationZ(angle: number): Matrix`
- `static RotationYawPitchRoll(yaw: number, pitch: number, roll: number): Matrix`
- `static FromEulerAngles(x: number, y: number, z: number): Matrix`
- `static FromXYZAxesToRef(axis1: Vec3, axis2: Vec3, axis3: Vec3, result: Matrix): Matrix`
- `static LookAtLH(eye: Vec3, target: Vec3, up: Vec3): Matrix`
- `static ComposeToRef(scale: Vec3, rotation: Quaternion, translation: Vec3, result: Matrix): Matrix`
- `clone(): Matrix`
- `copyFrom(src: Matrix): Matrix`
- `multiply(other: Matrix): Matrix`
- `multiplyToRef(other: Matrix, result: Matrix): Matrix`
- `static MultiplyToRef(left: Matrix, right: Matrix, result: Matrix): Matrix`
- `invert(): Matrix`
- `static InvertToRef(matrix: Matrix, result: Matrix): Matrix`
- `getTranslation(): Vec3`
- `setTranslation(translation: Vec3): Matrix`
- `decompose(scale?: Vec3, rotation?: Quaternion, translation?: Vec3): boolean`
- `determinant(): number`
- `toEulerAngles(): Vec3`
- `toArray(): number[]`

### export class Observable

**Accessors**
- `get hasObservers(): boolean`

**Methods**
- `add(observer: (data: T) => void): number`
- `addOnce(observer: (data: T) => void): number`
- `remove(id: number): boolean`
- `removeCallback(observer: (data: T) => void): boolean`
- `clear(): void`
- `notifyObservers(data: T): void`

**Module-level functions**
- `export function rotateVec3ByQuaternionToRef(q: Quaternion, v: Vec3, result: Vec3): Vec3`
- `export function rotateVec3ByQuaternionAroundPointToRef(q: Quaternion, v: Vec3, point: Vec3, result: Vec3): Vec3`
- `export function vec4(x: number, y: number, z: number, w: number): Vec4`

---

## `lite-spike.ts` (133 LOC)

**Module-level functions**
- `function buildSpikeGeometry()`
- `async export function runLiteSpike(canvas: HTMLCanvasElement): Promise<`
- `function setChunkUniforms(material: ShaderMaterial): void`

**Types / Interfaces / Enums**
- type `EngineContext`
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`

---

## `Maps/BlockBreakParticles.ts` (105 LOC)

**Module-level functions**
- `export function play(scene: SceneContext, position: Vec3, blockId: number, packedLight: number)`
- `function init(_scene: SceneContext)`

---

## `Maps/Map1.ts` (67 LOC)

### export class Map1

**Constructor**
- `constructor(engine: EngineContext, scene: SceneContext, player: Player)`

**Properties**
- `public static mainScene: SceneContext`
- `public static engine: EngineContext`
- `public static environment: WorldEnvironment`
- `public static mobRegistry: MobRegistry | null = null`
- `public readonly initPromise: Promise<void>`

**Accessors**
- `public static get timeScale()`
- `public static set timeScale(v: number)`
- `public static get isPaused()`
- `public static set isPaused(v: boolean)`

**Methods**
- `initEngineContext(engine, scene)`
- `async asyncInit()`
- `public static update(deltaMs: number = 16.67): void`
- `public static setTime(time: number): void`
- `public static setDebug(_enabled: boolean): void`
- `public static disposeAll(): void`

---

## `Maps/MapFog.ts` (48 LOC)

---

## `Maps/UnderWaterEffect.ts` (127 LOC)

**Module-level functions**
- `export function isEyeUnderwater(eyeX: number, eyeY: number, eyeZ: number): boolean`

**Types / Interfaces / Enums**
- interface `EyeCamera`

---

## `Maps/WorldEnvironment.ts` (88 LOC)

### export class WorldEnvironment

**Constructor**
- `constructor(engine: EngineContext, scene: SceneContext)`

**Properties**
- `public static instance: WorldEnvironment`
- `private engine: EngineContext`
- `private scene: SceneContext`
- `private dirLight: DirectionalLight | null = null`
- `private skybox: Mesh | null = null`
- `private skyMaterial: ShaderMaterial | null = null`
- `private timeOfDay`
- `public timeScale`
- `public isPaused`
- `public wetness`

**Methods**
- `private createLights(): void`
- `private createSkybox(): void`
- `public update(deltaMs: number): void`
- `public setTime(time: number): void`
- `public dispose(): void`

**Types / Interfaces / Enums**
- type `DirectionalLight`
- type `EngineContext`
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`

---

## `Player/Controls/CustomBoatControls.ts` (184 LOC)

### export class CustomBoatControls implements IControls<BoatControlEntity>

**Constructor**
- `constructor(paddleBoat: BoatControlEntity, player: Player)`

**Properties**
- `readonly controlType`
- `public pressedKeys`
- `public static KEY_LEFT`
- `public static KEY_RIGHT`
- `public static KEY_UP`
- `public static KEY_DOWN`
- `public static KEY_USE`
- `public static KEY_JUMP`
- `public static KEY_SPRINT`
- `public static KEY_FLASH`
- `public static MOUSE_WHEEL_UP`
- `public static MOUSE_WHEEL_DOWN`
- `playerVehicle: { inputDirection: Vec3 }`
- `forward: Vec3,`
- `position: Vec3,`
- `angularLeftWorld: Vec3,`
- `angularRightWorld: Vec3,`

**Accessors**
- `public get controlledEntity(): BoatControlEntity`
- `public get inputDirection(): Vec3`

**Methods**
- `setVec3(this.#inputDirection, 0, 0, 0)`
- `public handleKeyEvent(key: string, isKeyDown: boolean)`
- `public onKeyDown(key: string)`
- `public onKeyUp(key: string)`
- `transformNormalVec3ToRef(this.#pushAngularVectorLeft, CustomBoatControls.#rotationMatrix, this.#_angularLeft)`
- `transformNormalVec3ToRef(this.#pushAngularVectorRight, CustomBoatControls.#rotationMatrix, this.#_angularRight)`
- `transformNormalVec3ToRef(CustomBoatControls.#_localForward, CustomBoatControls.#rotationMatrix, this.#_forward)`
- `scaleVec3InPlace(this.#_forward, this.#pushStrength)`
- `scaleVec3InPlace(forward, 0.4)`
- `scaleVec3InPlace(forward, 0.4)`
- `public update(): void`

**Types / Interfaces / Enums**
- type `BoatControlEntity`

---

## `Player/Controls/DebugControlHelper.ts` (27 LOC)

**Module-level functions**
- `export function handleDebugKey(key: string): boolean`

---

## `Player/Controls/InventoryControls.ts` (80 LOC)

### export class InventoryControls implements IControls<unknown>

**Constructor**
- `constructor(controlledEntity: unknown, underlyingControls: IControls<unknown>, player: Player)`

**Properties**
- `readonly controlType`
- `controlledEntity: unknown`
- `pressedKeys: Set<string>`
- `inputDirection: Vec3`
- `public static KEY_INVENTORY`
- `public static KEY_DROP`
- `public static KEY_CTRL`
- `public static MOUSE1_INVENTORY`

**Accessors**
- `public get underlyingControls(): IControls<unknown>`
- `public set underlyingControls(value: IControls<unknown>)`

**Methods**
- `handleKeyEvent(key: string, isKeyDown: boolean): void`
- `handleMouseEvent(mouseEvent: MouseEvent): void`
- `onKeyUp(key: string): void`
- `onKeyDown(key: string): void`

---

## `Player/Controls/JetSkiControls.ts` (191 LOC)

### export class JetSkiControls implements IControls<BoatControlEntity>

**Constructor**
- `constructor(paddleBoat: BoatControlEntity, player: Player)`

**Properties**
- `readonly controlType`
- `public pressedKeys`
- `public static KEY_LEFT`
- `public static KEY_RIGHT`
- `public static KEY_UP`
- `public static KEY_DOWN`
- `public static KEY_USE`
- `public static KEY_JUMP`
- `public static KEY_SPRINT`
- `public static KEY_FLASH`
- `public static MOUSE_WHEEL_UP`
- `public static MOUSE_WHEEL_DOWN`
- `playerVehicle: { inputDirection: Vec3 }`
- `forward: Vec3,`
- `position: Vec3,`
- `angularLeftWorld: Vec3,`
- `angularRightWorld: Vec3,`

**Accessors**
- `public get controlledEntity(): BoatControlEntity`
- `public get inputDirection(): Vec3`

**Methods**
- `public handleKeyEvent(key: string, isKeyDown: boolean)`
- `public onKeyDown(key: string)`
- `public onKeyUp(key: string)`
- `transformNormalVec3ToRef(this.#pushAngularVectorLeft, JetSkiControls.#rotationMatrix, this.#_angularLeft)`
- `transformNormalVec3ToRef(this.#pushAngularVectorRight, JetSkiControls.#rotationMatrix, this.#_angularRight)`
- `transformNormalVec3ToRef(JetSkiControls.#_localForward, JetSkiControls.#rotationMatrix, this.#_forward)`
- `scaleVec3(this.#_forward, this.#pushStrength)`
- `scaleVec3(forward, 0.4)`
- `scaleVec3(forward, 0.4)`
- `public update(): void`

---

## `Player/Controls/PaddleBoatControls.ts` (200 LOC)

### export class PaddleBoatControls implements IControls<BoatControlEntity>

**Constructor**
- `constructor(paddleBoat: BoatControlEntity, player: Player)`

**Properties**
- `readonly controlType`
- `public pressedKeys`
- `public static KEY_LEFT`
- `public static KEY_RIGHT`
- `public static KEY_UP`
- `public static KEY_DOWN`
- `public static KEY_USE`
- `public static KEY_JUMP`
- `public static KEY_SPRINT`
- `public static KEY_FLASH`
- `public static MOUSE_WHEEL_UP`
- `public static MOUSE_WHEEL_DOWN`
- `playerVehicle: { inputDirection: Vec3 }`
- `forward: Vec3,`
- `position: Vec3,`
- `angularLeftWorld: Vec3,`
- `angularRightWorld: Vec3,`

**Accessors**
- `public get controlledEntity(): BoatControlEntity`
- `public get inputDirection(): Vec3`

**Methods**
- `public handleKeyEvent(key: string, isKeyDown: boolean)`
- `public onKeyDown(key: string)`
- `public onKeyUp(key: string)`
- `transformNormalVec3ToRef(this.#pushAngularVectorLeft, PaddleBoatControls.#rotationMatrix, this.#_angularLeft)`
- `transformNormalVec3ToRef(this.#pushAngularVectorRight, PaddleBoatControls.#rotationMatrix, this.#_angularRight)`
- `transformNormalVec3ToRef(PaddleBoatControls.#_localForward, PaddleBoatControls.#rotationMatrix, this.#_forward)`
- `scaleVec3(this.#_forward, this.#pushStrength)`
- `scaleVec3(forward, 0.4)`
- `scaleVec3(forward, 0.4)`
- `public update(): void`

**Types / Interfaces / Enums**
- type `BoatControlEntity`

---

## `Player/Controls/WalkingControls.ts` (285 LOC)

### export class WalkingControls implements IControls<PlayerVehicleMotor>

**Constructor**
- `constructor(player: Player)`

**Properties**
- `readonly controlType`
- `public pressedKeys`
- `static readonly DOUBLE_TAP_MS`
- `public static KEY_LEFT`
- `public static KEY_RIGHT`
- `public static KEY_UP`
- `public static KEY_DOWN`
- `public static KEY_USE`
- `public static KEY_PICK_BLOCK`
- `public static KEY_PICK_BLOCK_EXACT`
- `public static KEY_JUMP`
- `public static KEY_SPRINT`
- `public static KEY_SNEAK`
- `public static KEY_FLASH`
- `public static KEY_INVENTORY`
- `public static KEY_DROP`
- `public static KEY_CTRL`
- `public static KEY_ALT`
- `public static KEY_PRINT_TRACE`
- `public static MOUSE_WHEEL_UP`
- `public static MOUSE_WHEEL_DOWN`
- `public static MOUSE1`
- `public static MOUSE2`
- `public static KEY_F5`
- `public static KEY_F6`
- `item: Item | null | undefined,`
- `requireExactState: boolean,`
- `requireExactState: boolean,`

**Accessors**
- `public get controlledEntity(): PlayerVehicleMotor`
- `public get inputDirection(): Vec3`

**Methods**
- `public handleKeyEvent(key: string, isKeyDown: boolean)`
- `public handleMouseEvent(mouseEvent: MouseEvent, isKeyDown: boolean): void`
- `public update(hit?: BlockRaycastHit | null): void`
- `public stopBlockBreaking(): void`
- `public onKeyDown(key: string)`
- `public onKeyUp(key: string)`

---

## `Player/Crafting/CraftingManager.ts` (37 LOC)

**Types / Interfaces / Enums**
- interface `Ingredient`
- interface `Recipe`
- interface `MasonRecipe`

---

## `Player/Crafting/CraftMenu/CraftMenu.ts` (412 LOC)

### export class CraftMenu

**Constructor**
- `constructor(inventory: PlayerInventory)`

**Methods**
- `async build(container: HTMLDivElement): Promise<void>`
- `private createCraftingUI(container: HTMLDivElement): void`
- `private craftRecipe(recipeDiv: HTMLDivElement, recipe: Recipe): void`
- `private createRecipeCard(recipe: Recipe): HTMLDivElement | null`
- `private createRecipeSearchPanel(): HTMLDivElement`
- `private renderRecipeSearchSlot(index: number): void`
- `addItemToFirstFreeSearchSlot(itemId: number): void`
- `private openRecipeSearchPicker(slotIndex: number): void`
- `private closeRecipeSearchPicker(): void`
- `private readDroppedItemId(e: DragEvent): number | null`
- `private updateRecipeSearchResults(): void`
- `updateCraftingAvailability(): void`
- `refreshAvailability(): void`
- `closePicker(): void`

---

## `Player/Crafting/ShapeVariantGenerator.ts` (82 LOC)

**Module-level functions**
- `async export function generateShapeVariants(): Promise<void>`

**Types / Interfaces / Enums**
- type `TextureDefinition`

---

## `Player/Hud/BlockHighlight/BlockBreakingVisuals.ts` (290 LOC)

**Module-level functions**
- `function addBox(positions: number[], normals: number[], indices: number[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void`
- `function buildBoxesGeometry(boxes: readonly BoxLike[], inflation: number)`
- `export function initializeBlockBreakingVisuals(targetScene: SceneContext): void`
- `function ensureCrackGeometry(blockId: number, blockState: number): void`
- `export function updateBlockBreakingVisuals(progress: number, targetBlock: BlockRaycastHit): void`
- `function asBoatBlockContext(context: unknown)`
- `export function resetBlockBreakingVisuals(): void`
- `export function updateCrackingState(block: { x: number; y: number; z: number } | null, progress: number, blockId?: number, blockState?: number, dynamicContext?: unknown): void`

**Types / Interfaces / Enums**
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`
- type `BoxLike`

---

## `Player/Hud/BlockHighlight/BlockHighlight.ts` (299 LOC)

### export class BlockHighlight

**Constructor**
- `constructor()`

**Properties**
- `kind: ,`
- `localX: value.localX,`
- `localY: value.localY,`
- `localZ: value.localZ,`
- `name: string,`
- `geo: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; },`
- `name: ,`
- `vertexSource: highlightVertexWGSL,`
- `fragmentSource: highlightFragmentWGSL,`
- `attributes: [ ],`
- `uniforms: [ , { name: , type: }],`
- `needAlphaBlending: true,`
- `depthWrite: false,`
- `backFaceCulling: false,`

**Methods**
- `onBeforeRender(this.#scene, () => this.#update())`
- `dispose(): void`
- `setHit(hit: BlockRaycastHit | null): void`
- `removeFromScene(this.#scene, this.#mesh)`
- `addToScene(this.#scene, mesh)`
- `setShaderUniform(mat, [
			SETTING_PARAMS.HIGHLIGHT_COLOR[0],
			SETTING_PARAMS.HIGHLIGHT_COLOR[1],
			SETTING_PARAMS.HIGHLIGHT_COLOR[2],
			SETTING_PARAMS.HIGHLIGHT_ALPHA,
		])`

**Module-level functions**
- `function addBox(positions: number[], normals: number[], indices: number[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void`
- `function buildBoxesGeometry(boxes: readonly BoxLike[], inflation: number)`

**Types / Interfaces / Enums**
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`
- type `BoxLike`

---

## `Player/Hud/BlockHighlight/BlockRaycaster.ts` (797 LOC)

**Module-level functions**
- `function getForwardRay(player: Player, length: number): RayLike`
- `function isTargetableBlock(blockId: number): boolean`
- `function isFullBlockShape(blockId: number, blockState: number): boolean`
- `function intersectRayAabb(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, tMin: number, tMax: number, fallbackNx: number, fallbackNy: number, fallbackNz: number): FaceHit | null`
- `function raycastShapeInVoxel(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, vx: number, vy: number, vz: number, blockId: number, blockState: number, tEnter: number, tExit: number, fallbackNx: number, fallbackNy: number, fallbackNz: number): FaceHit | null`
- `export function pickTarget(player: Player): BlockRaycastHit | null`
- `export function pickDroppedItem(player: Player): DroppedItem | null`
- `export function pickWaterTarget(player: Player): BlockRaycastHit | null`
- `export function pickBlock(player: Player): number | null`
- `export function getPlacementPosition(player: Player): Vec3 | null`
- `export function getPlacementHit(player: Player): PlacementHit | null`

**Types / Interfaces / Enums**
- type `Vec3`
- type `ShapeBounds`
- type `BlockRaycastHit`
- type `FaceHit`
- type `RayLike`
- type `PlacementHit`

---

## `Player/Hud/BlockHighlight/BreakingBlockHandler.ts` (182 LOC)

### export class BlockBreakingHandler

**Constructor**
- `constructor(player: Player)`

**Properties**
- `kind: ,`
- `boatChunk: value.boatChunk,`
- `localX: value.localX,`
- `localY: value.localY,`
- `localZ: value.localZ,`
- `x: number,`
- `y: number,`
- `z: number,`
- `blockId: number,`
- `packedLight: number,`
- `dynamicContext: unknown,`

**Methods**
- `public start(): void`
- `public stop(): void`
- `public reset(): void`
- `public update(hit?: BlockRaycastHit | null): void`
- `setVec3(particlePos, x + 0.5, y + 0.5, z + 0.5)`
- `play(this.#player.sceneRef, particlePos, blockId, packedLight)`
- `deleteBlock(x, y, z)`

**Types / Interfaces / Enums**
- type `BoatBlockHitContext`

---

## `Player/Hud/Crosshair/Crosshair.ts` (116 LOC)

### export class Crosshair

**Constructor**
- `constructor()`

**Properties**
- `player: Player,`
- `maxDistance: number,`
- `predicate?: (mesh: Mesh) => boolean,`
- `getForwardRay?: (d: number) => unknown`
- `pickWithRay?: ( ray: unknown, predicate?: (mesh: Mesh) => boolean, fast?: boolean, ) => { pickedMesh?: Mesh | null } | null`

**Methods**
- `public setTargetHit(hit: BlockRaycastHit | null): void`
- `setCrosshair(id: string): void`
- `showHitMarker(): void`
- `static pickTargetInto(player: Player, target: Vec3): boolean`
- `static pickWaterPlacementTargetInto(player: Player, target: Vec3): boolean`
- `static pickBlock(player: Player): number | null`
- `static pickTarget(player: Player): Vec3 | null`
- `static pickWaterPlacementTarget(player: Player): Vec3 | null`
- `static getPlacementPosition(player: Player): Vec3 | null`
- `static getPlacementHit(player: Player): PlacementHit | null`
- `static pickUsableMesh(player: Player, maxDistance = REACH_DISTANCE): Mesh | null`
- `static pickMobMesh(player: Player, maxDistance = REACH_DISTANCE): Mesh | null`

**Types / Interfaces / Enums**
- type `PlacementHit`

---

## `Player/Hud/Crosshair/CrosshairUI.ts` (28 LOC)

### export class CrosshairUI

**Constructor**
- `constructor(initialCrosshairId =)`

**Methods**
- `setCrosshair(id: string): void`
- `showHitMarker(): void`

---

## `Player/Hud/DebugPanel.ts` (45 LOC)

### export class DebugPanel

**Constructor**
- `constructor()`

**Properties**
- `static instance: DebugPanel`
- `static div: HTMLDivElement = document.createElement( )`
- `private static infoLines: { [key: string]: string } = {}`
- `private static elements`

**Methods**
- `static getInstance(): DebugPanel`
- `public static show(): void`
- `public static hide(): void`
- `public static updateInfo(key: string, value: string | number): void`

---

## `Player/Hud/PauseMenu.ts` (430 LOC)

### export class PauseMenu

**Constructor**
- `constructor(onResume: () => void, player: Player)`

**Properties**
- `private menuContainer: HTMLElement`
- `private mainButtonsContainer: HTMLElement`
- `private settingsContainer: HTMLElement`
- `private onResume: () => void`
- `private player: Player`

**Methods**
- `private createMenuElement(): HTMLElement`
- `private createMainButtons(): HTMLElement`
- `private createSettingsPanel(): HTMLElement`
- `private createSlider(container: HTMLElement, labelText: string, min: number, max: number, initialValue: number, onInput: (value: number) => string)`
- `private createSeparator(text: string): HTMLElement`
- `public show()`
- `public hide()`
- `private showSettings(show: boolean)`
- `private addStyles()`

---

## `Player/Hud/PlayerHud.ts` (762 LOC)

### export class PlayerHud

**Constructor**
- `constructor(scene: SceneContext, player: Player)`

**Properties**
- `public readonly crossHair: Crosshair`
- `static debugPanelDiv: HTMLDivElement`
- `private static infoRows: { [key: string]: { container: HTMLDivElement; valueNode: Text; valueSpan?: HTMLSpanElement; keySpan?: HTMLSpanElement; }; } = {}`
- `private static itemTooltipDiv: HTMLDivElement`
- `private static itemTooltipMouseMove?: (e: MouseEvent) => void`

**Accessors**
- `public get player(): Player`
- `public get isMasonTableOpen(): boolean`
- `public get selectedHotbarSlot(): number`
- `public set selectedHotbarSlot(slot: number)`

**Methods**
- `private initializeHUD(): HTMLDivElement`
- `private createInventoryUI(): HTMLDivElement`
- `private createHotbarUI(): HTMLDivElement`
- `private createStatsUI(): void`
- `private getSlot(column: number, row: number): HTMLDivElement | null`
- `public toggleInventory(): void`
- `public showMasonTableUI(): void`
- `public hideMasonTableUI(): void`
- `private createMasonTableUI(): HTMLDivElement`
- `private getMasonSourceBlocks()`
- `public updateMasonTableAvailability(): void`
- `private craftMasonRecipe(): void`
- `private updateHotbarSelection(): void`
- `private initializeDebugPanel(): void`
- `public static toggleDebugInfo(): void`
- `public static showDebugPanel(): void`
- `public static hideDebugPanel(): void`
- `public static updateDebugInfo(key: string, value: string | number, category?: string): void`
- `private initializeTooltip(): void`
- `public static showItemTooltip(text: string, event: MouseEvent): void`
- `public static hideItemTooltip(): void`
- `public updateStats(): void`

---

## `Player/Inventory/DroppedItem.ts` (471 LOC)

### export class DroppedItem implements IUsable

**Constructor**
- `constructor(item: Item, x: number, y: number, z: number)`

**Properties**
- `static readonly GRAVITY`
- `static readonly STEP_SIZE`
- `static readonly EPSILON`
- `static readonly AIR_DAMPING_PER_SEC`
- `static readonly GROUND_DAMPING_PER_SEC`
- `static readonly MIN_SPEED`
- `static readonly SKY_LIGHT_COLOR`
- `static readonly BLOCK_LIGHT_COLOR`
- `mipMaps: false,`
- `magFilter: ,`
- `minFilter: ,`
- `scene: Map1.mainScene,`
- `name: ITEM_NAME_AABB,`
- `position: this.#position,`
- `renderOrder: 1,`
- `use`

**Accessors**
- `get boxMesh(): Mesh`
- `get position(): Vec3`
- `get item(): Item`
- `static get activeItems(): ReadonlyArray<DroppedItem>`
- `get halfExtent(): number`

**Methods**
- `onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			const dt = deltaMs * 0.001; 
			if (dt <= 0) return;

			const items = DroppedItem.#allItems;
			const len = items.length;
			for (let i = 0; i < len; i++) {
				items[i].#updatePhysics(dt);
			}
		})`
- `static preloadAtlas(): void`
- `addToScene(Map1.mainScene, this.#boxMesh)`
- `vec3(this.#halfSize, this.#halfSize, this.#halfSize)`
- `setShaderTexture(this.#material, sharedAtlas)`
- `setShaderTexture(this.#material, atlas)`
- `pushItem(direction: Vec3): void`
- `removeFromScene(Map1.mainScene, this.#boxMesh)`
- `copyVec3(this.#scratchProbe, this.#position)`
- `setShaderVector3(this.#material, [finalR, finalG, finalB])`
- `setShaderUniform(this.#material, tileSize)`
- `setShaderUniform(this.#material, [
			clampedX * tileSize,
			atlasRow * tileSize,
		])`
- `static disposeAll(): void`
- `static nearestTo(player: Player): DroppedItem | null`

**Module-level functions**
- `function createDroppedItemMaterial(): ShaderMaterial`
- `function getUnitCubeGeometry()`

**Types / Interfaces / Enums**
- interface `PlayerDroppedItemApi`
- type `LiteMetadata`
- type `Mesh`
- type `Texture2D`
- type `Vec3`

---

## `Player/Inventory/Item.ts` (316 LOC)

### export class Item implements IUsable

**Constructor**
- `constructor(name: string, description: string, icon: string, row: number, col: number, maxStack?: number)`

**Properties**
- `private static readonly SLICE_SHAPE_ROTATION_POLICY: Record<`
- `cube: { rotateVerticalByYaw: true },`
- `slab: { rotateVerticalByYaw: true },`
- `name: string`
- `description: string`
- `icon: string`
- `material: ShaderMaterial | undefined`
- `itemId`
- `blockId: number | null = null`
- `blockState`
- `row: number`
- `col: number`
- `context: unknown,`
- `kind: ,`
- `boatChunk: value.boatChunk,`
- `localX: value.localX,`
- `localY: value.localY,`
- `localZ: value.localZ,`
- `localHitNx: value.localHitNx,`
- `localHitNy: value.localHitNy,`
- `localHitNz: value.localHitNz,`

**Accessors**
- `public set stackSize(value: number)`
- `public get stackSize(): number`
- `get div(): HTMLDivElement`

**Methods**
- `private static createFromDefinition(def: ItemDefinition, row: number, col: number): Item`
- `static createById(itemId: number, row = -1, col = -1): Item`
- `use(player: Player): void`
- `static place(player: Player)`
- `createDiv(): HTMLDivElement`
- `private static getWallRotationFromYaw(yaw: number): number`
- `public refreshIconStyle(): void`
- `public static stackItemAtoB(itemA: Item, itemB: Item): number`

**Types / Interfaces / Enums**
- type `BoatPlacementContext`

---

## `Player/Inventory/ItemRegistry.ts` (135 LOC)

**Module-level functions**
- `function blockKey(blockId: number, blockState: number): string`
- `export function registerItemToDisplayName(rawName: string): string`
- `function initDefaults(): void`
- `async export function ensureItemRegistryLoaded(url = DEFAULT_ITEMS_URL): Promise<void>`
- `async function loadRegisteredItemFromUrl(url: string): Promise<void>`
- `export function registerItem(def: ItemDefinition): void`
- `export function getRegisteredItemById(id: number): ItemDefinition | undefined`
- `export function getItemByBlock(blockId: number, blockState = 0): ItemDefinition | undefined`
- `export function getAllRegisteredItems(): ItemDefinition[]`
- `function isValidDefinition(value: unknown): value is ItemDefinition`

**Types / Interfaces / Enums**
- type `ItemDefinition`

---

## `Player/Inventory/ItemSlot.ts` (104 LOC)

### export class ItemSlot

**Constructor**
- `constructor(row: number, col: number)`

**Properties**
- `row: number`
- `col: number`
- `draggedItem`

**Accessors**
- `public get divItemSlot(): HTMLDivElement`
- `public set divItemSlot(div: HTMLDivElement)`
- `public set item(item: Item | null)`
- `public get item(): Item | null`

**Methods**
- `public swapSlots(slot: ItemSlot)`
- `public clearItemSlots()`
- `public initialize()`
- `public dispose(): void`

---

## `Player/Inventory/ItemUseActions.ts` (37 LOC)

**Types / Interfaces / Enums**
- type `ItemUseAction`

---

## `Player/Inventory/PlayerInventory.ts` (374 LOC)

### export class PlayerInventory

**Constructor**
- `constructor(scene: SceneContext, player: Player, x: number, y: number)`

**Properties**
- `scene: SceneContext`
- `public onInventoryChangedObservable`
- `public static currentlyHoveredSlot: ItemSlot | null = null`
- `def: (typeof definitions)[number],`
- `row: number,`
- `col: number,`
- `savedState: unknown,`

**Accessors**
- `public get inventoryControls(): InventoryControls`
- `public set inventoryControls(value: InventoryControls)`
- `public get inventory(): ItemSlot[][]`
- `get x(): number`
- `get y(): number`

**Methods**
- `placeItem(def, row, col)`
- `placeItem(def, row, col)`
- `public getSavedInventoryState(): SavedInventoryState`
- `public restoreSavedInventoryState(savedState: unknown): boolean`
- `public addItem(item: Item): number`
- `public hasItem(itemId: number, count: number): boolean`
- `public removeItems(itemId: number, count: number): void`
- `public createAndAddItem(itemId: number, count: number): void`
- `public dropItemFromHotbar()`
- `public dropItem(item: Item, quantity?: number)`
- `public moveItemToHotbar(slotFocused: ItemSlot): void`
- `public moveItemToInventory(slotFocused: ItemSlot): void`
- `public moveItem(slotFocused: ItemSlot, targetBarIndexRange: [number, number]): void`
- `public deleteItem(item: Item)`

**Types / Interfaces / Enums**
- type `SavedInventoryItem`
- type `SavedInventoryState`

---

## `Player/Player.ts` (207 LOC)

### export class Player

**Constructor**
- `constructor(private engine: EngineContext, private scene: SceneContext, playerCam: PlayerCamera, private canvas: HTMLCanvasElement)`

**Properties**
- `keyboardControls: IControls<unknown>`
- `camera: playerCam,`
- `controls: new PlayerBodyControlState(),`
- `playerStats: this.#stats,`

**Accessors**
- `public get position(): Vec3`
- `public get velocity(): Vec3`
- `public get playerVehicle(): PlayerVehicleMotor`
- `public get playerHud(): PlayerHud`
- `public get playerInventory(): PlayerInventory`
- `public get playerCamera(): PlayerCamera`
- `public get stats(): PlayerStats`
- `public get flashlight(): PlayerFlashLight`
- `public get defaultKeyboardControls(): WalkingControls`
- `public get sceneRef(): SceneContext`

**Methods**
- `public createHud(scene: SceneContext): void`
- `addToScene(scene, body)`
- `public respawn(): void`
- `public tick(deltaMs: number): void`
- `setIsPaused(true)`
- `setIsPaused(false)`
- `public onKeyEvent(key: string, isKeyDown: boolean): void`
- `public use(): void`
- `public disposePicker(): void`

---

## `Player/PlayerBody.ts` (43 LOC)

### export class PlayerBodyControlState

**Properties**
- `public inputDirection`
- `public wantJump`
- `public isSprinting`
- `public isFlying`
- `public isJumpHeld`
- `public isSneaking`

**Methods**
- `public reset(): void`

**Types / Interfaces / Enums**
- interface `IPlayerBody`

---

## `Player/PlayerCamera.ts` (93 LOC)

### export class PlayerCamera

**Constructor**
- `constructor()`

**Properties**
- `public mouseSensitivity`

**Accessors**
- `public get cameraYaw(): number`
- `public get cameraPitch(): number`
- `public get isThirdPerson(): boolean`
- `public get playerCamera(): FreeCamera`
- `public set fov(value: number)`
- `public get position(): Vec3`
- `public set position(position: Vec3)`
- `public set target(target: Vec3)`

**Methods**
- `public moveWithPlayer(characterPosition: Vec3): void`
- `public handleMouseMovement(deltaX: number, deltaY: number): void`
- `public zoomIn(): void`
- `public zoomOut(): void`
- `public getForwardDirection(): Vec3`

**Types / Interfaces / Enums**
- type `FreeCamera`
- type `Vec3`

---

## `Player/PlayerFlashLight.ts` (43 LOC)

### export class PlayerFlashLight

**Constructor**
- `constructor(scene: SceneContext, playerCamera: FreeCamera)`

**Methods**
- `setEnabled(v: boolean): void`
- `dispose(): void`
- `public toggle()`
- `public dispose(): void`

**Types / Interfaces / Enums**
- type `FreeCamera`
- type `SceneContext`
- type `SpotLight`

---

## `Player/PlayerInputController.ts` (92 LOC)

### export class PlayerInputController

**Constructor**
- `constructor(private readonly canvas: HTMLCanvasElement, private readonly playerCamera: PlayerCamera, private readonly onKeyEvent: KeyEventHandler, private readonly getKeyboardControls: () => IControls<unknown>, private readonly onPauseRequested: () => void)`

**Methods**
- `public bind(): void`
- `public dispose(): void`

**Types / Interfaces / Enums**
- type `KeyEventHandler`

---

## `Player/PlayerLoadingGate.ts` (90 LOC)

### export class PlayerLoadingGate

**Constructor**
- `constructor(private readonly scene: SceneContext, private readonly player: Player)`

**Properties**
- `private static readonly SPAWN_CHUNK_RADIUS`
- `private static readonly SPAWN_READY_FRAME_THRESHOLD`
- `private static readonly SPAWN_PROTECTION_TIMEOUT_MS`
- `private spawnReadyFrames`
- `private isActive`
- `private readonly startMs: number`

**Methods**
- `onBeforeRender(this.scene, () => {
			this.update();
		})`
- `public dispose(): void`
- `private update(): void`
- `private isSpawnColliderReady(chunkX: number, chunkY: number, chunkZ: number): boolean`

---

## `Player/PlayerLoopController.ts` (461 LOC)

### export class PlayerLoopController

**Constructor**
- `constructor(scene: SceneContext, private readonly playerVehicle: {
			isSprinting: boolean;
			isClimbing: boolean;
			update(dt: number): void;
			updateCameraAndVisuals(): void;
		}, private readonly playerStats: PlayerStats, private readonly playerHud: PlayerHud, private readonly playerCamera: PlayerCamera, private readonly getKeyboardControls: () => IControls<unknown>, private readonly getPlayerPosition: () => Vec3)`

**Properties**
- `static readonly DEBUG_HUD_INTERVAL_MS`
- `private readonly scene: SceneContext`
- `stopBlockBreaking?: () => void`

**Methods**
- `public bind(): void`

**Types / Interfaces / Enums**
- type `BlockRaycastHit`

---

## `Player/PlayerStatePersistence.ts` (185 LOC)

### export class PlayerStatePersistence

**Constructor**
- `constructor(private readonly scene: SceneContext, private readonly player: Player)`

**Properties**
- `private static readonly PLAYER_POSITION_STORAGE_KEY`
- `private static readonly PLAYER_INVENTORY_STORAGE_KEY`
- `private static readonly PLAYER_STATE_SAVE_INTERVAL_MS`
- `private static readonly CHUNK_SAVE_BATCH_SIZE`
- `private static readonly CHUNK_SAVE_NOW_BATCH_SIZE`
- `private lastPositionSaveMs`
- `private inventoryObserver: any = null`
- `private sceneDisposeObserver: any = null`
- `private isDisposed`
- `private readonly onBeforeUnload`
- `private readonly onVisibilityChange`

**Methods**
- `public update(): void`
- `public async saveNow(): Promise<void>`
- `public dispose(): void`
- `private setupPersistence(): void`
- `private requestChunkSave(batchSize: number): void`
- `private savePosition(): void`
- `private saveInventory(): void`
- `private restoreFromLocalStorage(): void`
- `private restorePosition(): void`
- `private restoreInventory(): void`

---

## `Player/PlayerStats.ts` (85 LOC)

### export class PlayerStats

**Properties**
- `public gamemode: Gamemodes = Gamemodes.Creative`
- `public maxHealth`
- `public health`
- `public maxHunger`
- `public hunger`
- `public maxStamina`
- `public stamina`
- `public maxMana`
- `public mana`
- `public healthRegenRate`
- `public staminaRegenRate`
- `public manaRegenRate`
- `public hungerDepletionRate`
- `public climbingStaminaRegenMultiplier`

**Methods**
- `public update(deltaTime: number, isSprinting: boolean, staminaRegenScale = 1): void`
- `public takeDamage(amount: number): void`
- `public heal(amount: number): void`
- `public consumeStamina(amount: number): boolean`
- `public consumeMana(amount: number): boolean`
- `public eat(amount: number): void`

---

## `Player/PlayerVehicle.ts` (215 LOC)

### export class PlayerVehicle

**Constructor**
- `constructor(scene: SceneContext, camera: PlayerCamera)`

**Properties**
- `public scene: SceneContext`
- `public camera: PlayerCamera`
- `public isMounted`
- `public mount: Mount | null = null`
- `private readonly controlState`
- `x: 0,`
- `z: 0,`

**Accessors**
- `public get position(): Vec3`
- `public get inputDirection(): Vec3`
- `public get wantJump(): number`
- `public set wantJump(value: number)`
- `public get isSprinting(): boolean`
- `public set isSprinting(value: boolean)`
- `public get isFlying(): boolean`
- `public set isFlying(value: boolean)`
- `public get isJumpHeld(): boolean`
- `public set isJumpHeld(value: boolean)`
- `public get isSneaking(): boolean`
- `public set isSneaking(value: boolean)`
- `public get isClimbing(): boolean`
- `public get isMovementLocked(): boolean`

**Methods**
- `copyFrom(v: Vec3)`
- `public clearControlState(): void`
- `public toggleFlying(): void`
- `public lockMovementAtCurrentPosition(): void`
- `public unlockMovement(): void`
- `public getSavedPosition(): Vec3`
- `public restoreSavedPosition(position: unknown): boolean`
- `public setMount(mount: Mount | null): void`
- `public respawn(): void`
- `public update(deltaTime: number): void`
- `public updateCameraAndVisuals(): void`

**Types / Interfaces / Enums**
- type `BlockShapeInfo`

---

## `Player/PlayerVehicleMotor.ts` (1134 LOC)

**Types / Interfaces / Enums**
- type `EngineContext`
- type `Mesh`
- type `SceneContext`
- type `Vec3`
- type `PlayerVehicleMotorOptions`

---

## `Player/SimpleCharacterController.ts` (64 LOC)

### export class SimpleCharacterController

**Constructor**
- `constructor(startPosition: Vec3)`

**Properties**
- `public keepDistance`
- `public keepContactTolerance`
- `public maxCastIterations`
- `public penetrationRecoverySpeed`
- `public maxSlopeCosine`
- `supportedState: CharacterSupportedState.UNSUPPORTED,`
- `averageSurfaceNormal: SimpleCharacterController.#cachedSurfaceNormal,`
- `averageSurfaceVelocity: SimpleCharacterController.#cachedSurfaceVelocity,`

**Methods**
- `public getPosition(): Vec3`
- `public setPosition(position: Vec3): void`
- `public getVelocity(): Vec3`
- `public setVelocity(velocity: Vec3): void`
- `public checkSupport(): CharacterSurfaceInfo`
- `public integrate(deltaTime: number, gravity: Vec3): void`

**Types / Interfaces / Enums**
- type `CharacterSurfaceInfo`
- enum `CharacterSupportedState`

---

## `Shared/EventBus.ts` (26 LOC)

**Types / Interfaces / Enums**
- type `EventMap`
- type `EventKey`
- type `Listener`

---

## `Shared/GameRuntimeState.ts` (36 LOC)

**Module-level functions**
- `export function isInCave(): boolean`
- `export function setInCave(value: boolean): void`
- `export function getGameTimeScale(): number`
- `export function setGameTimeScale(value: number): void`
- `export function openUi(focus: UiFocus): void`
- `export function closeUi(focus: UiFocus): void`
- `export function isUiOpen(focus?: UiFocus): boolean`
- `export function getIsPaused(): boolean`
- `export function setIsPaused(value: boolean): void`

---

## `Shared/VoxelMath.ts` (32 LOC)

**Module-level functions**
- `export function worldToChunkCoord(value: number): number`
- `export function worldToBlockCoord(value: number): number`
- `export function idx3(x: number, y: number, z: number, size: number): number`
- `export function idx2(x: number, z: number, size: number): number`
- `export function getSkyLight(packed: number): number`
- `export function getBlockLight(packed: number): number`
- `export function packLight(sky: number, block: number): number`

---

## `TestScene.ts` (82 LOC)

**Types / Interfaces / Enums**
- type `EngineContext`
- type `SceneContext`

---

## `World/Boat/BoatChunk.ts` (474 LOC)

### export class BoatChunk

**Constructor**
- `constructor(blocks: BoatChunkBlock[], center: Vec3)`

**Properties**
- `private static activeChunks`
- `private static readonly CHUNK_Y_BASE`
- `private static readonly CHUNK_COORD_GRID_WIDTH`
- `private static readonly CHUNK_COORD_SPACING`
- `private static nextChunkSlot`
- `found`
- `blockState: unpackBlockState(packedBlock),`
- `lightLevel: this.#centerChunk.getLight(x, y, z),`
- `center: vec3(this.#center.x, this.#center.y, this.#center.z),`
- `localX: number,`
- `localY: number,`
- `localZ: number,`
- `blockId: number,`
- `blockState: number,`

**Accessors**
- `public get visualRoot(): Mesh`
- `public get center(): Vec3`

**Methods**
- `copyVec3(this.#center, center)`
- `addToScene(this.#scene, this.#visualRoot)`
- `private initializeCenterChunkLighting(blocks: BoatChunkBlock[]): void`
- `private static allocateChunkCoords(): ChunkCoords`
- `private createSharedBuffer(byteLength: number): ArrayBufferLike`
- `private createSkyLightArray(): Uint8Array`
- `private isInsideChunkBounds(x: number, y: number, z: number): boolean`
- `private getIndex(x: number, y: number, z: number): number`
- `private createBlockArray(): Uint16Array`
- `private createNeighborChunks(center: ChunkCoords): void`
- `private populateNeighborChunks(): void`
- `private populateCenterChunk(blocks: BoatChunkBlock[]): void`
- `private isAliveMesh(mesh: Mesh | null): mesh is Mesh`
- `private configureAttachedMesh(mesh: Mesh): void`
- `private syncMeshRef(source: Mesh | null, attachedRef: Mesh | null): Mesh | null`
- `private updateAttachedMeshTransform(mesh: Mesh | null): void`
- `public syncVisualMeshes(): void`
- `public remesh(priority = true): void`
- `public attachTo(parent: Mesh): void`
- `public getBlockLocal(x: number, y: number, z: number): number`
- `public isInsideLocalBounds(x: number, y: number, z: number): boolean`
- `public getBlockStateLocal(x: number, y: number, z: number): number`
- `public getBlockPackedLocal(x: number, y: number, z: number): number`
- `public getLightLocal(x: number, y: number, z: number): number`
- `public setBlockPackedLocal(x: number, y: number, z: number, packedBlock: number): void`
- `public setBlockLocal(x: number, y: number, z: number, blockId: number, blockState = 0): void`
- `public setLightLocal(x: number, y: number, z: number, packedLight: number): void`
- `public worldToLocalBlock(worldPosition: Vec3): Vec3`
- `public worldToLocalBlockToRef(worldPosition: Vec3, ref: Vec3): void`
- `public localToWorldCenter(x: number, y: number, z: number): Vec3`
- `public localToWorldCenterToRef(x: number, y: number, z: number, ref: Vec3): void`
- `public getOccupiedBoundsLocal()`
- `public onBlockChanged(listener: BoatChunkBlockChangeListener): () => void`
- `public toSnapshot()`
- `public dispose(): void`
- `private createEmptyLightArray(): Uint8Array`
- `public static getActiveChunks(): ReadonlySet<BoatChunk>`
- `listener(this, localX, localY, localZ, blockId, blockState)`

**Types / Interfaces / Enums**
- type `Mesh`
- type `SceneContext`
- type `Vec3`
- type `BoatChunkBlock`
- type `ChunkCoords`
- type `BoatChunkBlockChangeListener`

---

## `World/Boat/BoatCreatorSystem.ts` (261 LOC)

**Module-level functions**
- `export function setSourceBlockIds(ids: Iterable<number>): void`
- `export function addSourceBlockId(id: number): void`
- `export function removeSourceBlockId(id: number): void`
- `export function getSourceBlockIds(): number[]`
- `export function setVisualMode(mode: VisualMode): void`
- `export function tryCreateBoatFromMarker(player: Player, markerX: number, markerY: number, markerZ: number): boolean`
- `function collectConnectedHullBlocks(markerX: number, markerY: number, markerZ: number): VoxelBlock[]`
- `function computeBounds(blocks: VoxelBlock[])`
- `function computeForwardYaw(bounds: {
		minX: number;
		minZ: number;
		maxX: number;
		maxZ: number;
		sizeX: number;
		sizeZ: number;
	}, markerX: number, markerZ: number): number`

**Types / Interfaces / Enums**
- type `VoxelBlock`
- type `VisualMode`

---

## `World/Chunk/Chunk.ts` (1277 LOC)

### export class Chunk

**Constructor**
- `constructor(chunkX: number, chunkY: number, chunkZ: number)`

**Properties**
- `public readonly id: bigint`
- `public readonly neighborRefs: (Chunk | null)[] = [ null, null, null, null, null, null, ]`
- `public static readonly SKY_LIGHT_SHIFT`
- `public static readonly BLOCK_LIGHT_MASK`
- `private static readonly SKYLIGHT_GENERATION_MIN_WORLD_Y`
- `private static readonly GLASS_01_BLOCK_ID`
- `private static readonly GLASS_02_BLOCK_ID`
- `private static readonly EPS`
- `private static readonly CLOSED_FACE_MASK_CACHE`
- `private static readonly EMPTY_LIGHT_ARRAY`
- `public cachedLODMeshes`
- `private static readonly _lightEmissionLUT`
- `public static _lightPool: { postLightMutate(req: any): void; postLightAddEmission(req: any): void; nextLightSeq(): number; enqueueDeferredLightFromSunlightInit?( chunk: Chunk, queue: Uint16Array, length: number, ): void; } | null = null`
- `private static readonly _faceBitLUT`
- `private static readonly _faceScratch: number[] = []`
- `private static readonly FACE_CONNECT_THRESHOLD`

**Accessors**
- `get block_array(): Uint8Array | Uint16Array | null`
- `get palette(): Uint16Array | null`
- `get isUniform(): boolean`
- `get uniformBlockId(): number`
- `get hasVoxelData(): boolean`
- `public get neighborIds(): readonly bigint[]`

**Methods**
- `public static getLightEmission(blockId: number): number`
- `_setByCoords(this)`
- `private getNibble(index: number): number`
- `private setNibble(index: number, value: number): void`
- `public loadFromStorage(blocks: Uint8Array | Uint16Array | null, palette: Uint16Array | null | undefined, isUniform: boolean | undefined, uniformBlockId: number | undefined, light_array?: Uint8Array, scheduleRemesh = true): void`
- `private writeLightHeaderRow(): void`
- `private isOpaqueAtIndex(i: number): number`
- `public setBlock(localX: number, localY: number, localZ: number, blockId: number, state = 0): void`
- `public deleteBlock(localX: number, localY: number, localZ: number): void`
- `public scheduleRemesh(priority = false, includeNeighbors = false): void`
- `public getNeighbor(dx: number, dy: number, dz: number): Chunk | undefined`
- `public markLightChanged(): void`
- `public needsPersistence(): boolean`
- `private static getClosedFaceMaskForPacked(blockPacked: number): number`
- `public static precomputeClosedFaceMasks(): Uint8Array`
- `private static pushRectFlat(f: number, u0: number, u1: number, v0: number, v1: number): void`
- `private static doesFlatRectsCoverUnitSquare(f: number): boolean`
- `private static insertionSortEdges(start: number, len: number): void`
- `private static dedupeEdges(start: number, len: number): number`
- `private static getFaceBit(axis: number, dir: number): number`
- `private isTransparent(blockPacked: number, axis?: number, dir?: number): boolean`
- `private static applySliceStateToBoxForLight(min: [number, number, number], max: [number, number, number], state: number)`
- `public static facePairIndex(i: number, j: number): number`
- `private static connectFacesMask(faceMask: number): number`
- `public computeFaceConnectivity(): number`
- `public dispose(): void`

**Module-level functions**
- `export function addChunkDisposeHook(hook: ChunkDisposeHook): void`
- `function runChunkDisposeHooks(chunk: Chunk): void`
- `export function getChunk(cx: number, cy: number, cz: number): Chunk | undefined`
- `function _setByCoords(c: Chunk): void`
- `function _deleteByCoords(c: Chunk): void`

**Types / Interfaces / Enums**
- type `LightHeaderView`
- type `CachedLODMesh`
- type `SerializedLODMeshCache`
- type `ChunkDisposeHook`

---

## `World/Chunk/chunk.worker.ts` (184 LOC)

**Module-level functions**
- `function sharedU8(len: number): Uint8Array`
- `function sharedU16(len: number): Uint16Array`
- `function compressBlocks(blocks: Uint8Array)`

**Types / Interfaces / Enums**
- type `WorkerRequestData`

---

## `World/Chunk/ChunkEntityAPI.ts` (13 LOC)

**Types / Interfaces / Enums**
- type `DynamicBlockSample`

---

## `World/Chunk/ChunkLoadingSystem.ts` (831 LOC)

**Module-level functions**
- `function _prefetchOnReadOk(idx: number, bytes: Uint8Array | null | undefined): void`
- `function _prefetchOnReadErr(idx: number, err: unknown): void`
- `function isEntityAlive(entity: ChunkBoundEntity): boolean`
- `function getEntityChunkId(entity: ChunkBoundEntity): bigint | null`
- `export function processFrameBudgetedStreamingWork(playerChunkX: number, playerChunkY: number, playerChunkZ: number): void`
- `export function registerChunkBoundEntity(entity: ChunkBoundEntity): symbol`
- `export function unregisterChunkBoundEntity(handle: symbol | undefined): void`
- `export function registerDynamicBlockProvider(provider: DynamicBlockProvider, mutator?: DynamicBlockMutator): symbol`
- `export function unregisterDynamicBlockProvider(handle: symbol | undefined): void`
- `function sampleDynamicBlock(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): DynamicBlockSample | null`
- `function tryMutateDynamicBlock(worldX: number, worldY: number, worldZ: number, blockId: number, blockState: number): boolean`
- `async function unloadChunkBoundEntitiesForChunkImpl(chunk: Chunk): Promise<void>`
- `export function flushChunkBoundEntities(): Promise<void>`
- `async export function flushOpfsStorage(): Promise<void>`
- `function scheduleChunkAndNeighborsRemesh(chunk: Chunk): void`
- `function scheduleNeighborsOnlyRemesh(chunk: Chunk): void`
- `async export function updateChunksAround(chunkX: number, chunkY: number, chunkZ: number, renderDistance = SETTING_PARAMS.RENDER_DISTANCE, verticalRadius = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE, prevChunkX?: number, prevChunkY?: number, prevChunkZ?: number, playerWorldX?: number, playerWorldZ?: number): Promise<void>`
- `function updateSliceDebugStats(state: InFlightProcessState): void`
- `function finalizeProcessState(state: InFlightProcessState): void`
- `function applyHydratedChunkFromSavedData(chunk: Chunk, savedData: SavedChunkData): void`
- `function loadFarLodChunk(state: InFlightProcessState, chunk: Chunk, selectedMesh: SelectedSavedMesh | null, hasDesiredMesh: boolean): void`
- `function loadNearLodChunk(chunk: Chunk, savedData: SavedChunkData, selectedMesh: SelectedSavedMesh | null, hasDesiredMesh: boolean, targetLod: number): void`
- `function applyLoadedChunkFromSavedData(state: InFlightProcessState, request: QueuedChunkRequest, savedData: SavedChunkData): void`
- `async function prefetchOpfsMeshes(requests: QueuedChunkRequest[]): Promise<void>`
- `function resetCycleOpfsCache(): void`
- `export function deleteBlock(worldX: number, worldY: number, worldZ: number)`
- `export function setBlock(worldX: number, worldY: number, worldZ: number, blockId: number, state = 0)`
- `export function getBlockByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): number`
- `export function getTerrainBlockByWorldCoords(worldX: number, worldY: number, worldZ: number): number`
- `export function getBlockStateByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): number`
- `export function getBlockAndStateByWorldCoordsInto(worldX: number, worldY: number, worldZ: number, out: BlockAndStateOut, options?: DynamicBlockQueryOptions): BlockAndStateOut`
- `export function getBlockAndStateByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): BlockAndStateOut`
- `export function getLightByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): number`
- `export function areChunksLoadedAround(chunkX: number, chunkY: number, chunkZ: number, horizontalRadius = 1, verticalRadius = 0): boolean`
- `export function areChunksLod0ReadyAround(chunkX: number, chunkY: number, chunkZ: number, horizontalRadius = 1, verticalRadius = 0): boolean`
- `function collectChunkEntityPayloads(): ReadonlyMap<
	bigint,
	SavedChunkEntityData[]
>`

**Types / Interfaces / Enums**
- interface `SelectedSavedMesh`
- type `SavedChunkData`
- type `SavedChunkEntityData`
- type `QueuedChunkRequest`
- type `DynamicBlockSample`
- type `DynamicBlockProvider`
- type `DynamicBlockMutator`
- type `DynamicBlockProviderEntry`
- type `DynamicBlockQueryOptions`
- type `BlockAndStateOut`

---

## `World/Chunk/ChunkMesher.ts` (517 LOC)

**Module-level functions**
- `function getBoatChunkIndex(size: number): Uint8Array`
- `function getOpaqueMaterialForLodBucket(lod: number): ShaderMaterial`
- `function getTransparentMaterialForLodBucket(lod: number): ShaderMaterial`
- `function uploadTintLUT(): void`
- `function setMaterialGroupUniforms(m: ShaderMaterial): void`
- `function createBoatChunkMesh(chunk: Chunk, opaqueData: MeshData | null, transparentData: MeshData | null): void`
- `export function createMeshFromData(chunk: Chunk, opaqueMeshData: MeshData | null, transparentMeshData: MeshData | null): void`
- `export function initEngineContext(engine: EngineContext, scene: SceneContext): void`
- `export function updateGlobalUniforms(frameId: number): void`
- `export function disposeSharedResources(): void`

**Types / Interfaces / Enums**
- type `EngineContext`
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`
- type `Texture2D`
- type `MergedMeshGroup`
- type `PackedMeshInput`

---

## `World/Chunk/chunkWorker.ts` (468 LOC)

### export class ChunkWorker

**Constructor**
- `constructor(workerIndex: number, onMessageTerrain: (event: MessageEvent<WorkerResponseData>) => void, onMessageMesh: (event: MessageEvent<MeshWorkerResponse>) => void)`

**Properties**
- `private terrainWorker: Worker`
- `private voxelWorker: Worker`
- `private distantTerrainSharedInitialized`
- `private lightSharedInitialized`
- `type: WorkerTaskType.GenerateFullMesh`
- `chunkId: bigint`
- `meshRevision: number`
- `lod: number`
- `chunk_size: number`
- `block_array: Uint8Array | Uint16Array | null`
- `uniformBlockId: number | undefined`
- `palette: Uint8Array | Uint16Array | null | undefined`
- `light_array: Uint8Array | undefined`
- `neighbors: (Uint16Array | undefined)[]`
- `neighborLights: (Uint8Array | undefined)[]`
- `type: WorkerTaskType.GenerateFullMesh,`
- `chunkId: 0n,`
- `meshRevision: 0,`
- `lod: 0,`
- `chunk_size: Chunk.SIZE,`
- `block_array: new Uint8Array(0),`
- `uniformBlockId: undefined,`
- `palette: undefined,`
- `light_array: undefined,`
- `neighbors: this._neighborScratch,`
- `neighborLights: this._neighborLightScratch,`
- `private static readonly _REMESH_OFFSETS: readonly { readonly dx: number; readonly dy: number; readonly dz: number; readonly faceIdx: number; }[] = (() => { const out: { dx: number; dy: number; dz: number; faceIdx: number }[] = []; for (let z = -1; z <= 1; z++) { for (let y = -1; y <= 1; y++) { for (let x = -1; x <= 1; x++) { if (x === 0 && y === 0 && z === 0) continue; const nz = (x !== 0 ? 1 : 0) + (y !== 0 ? 1 : 0) + (z !== 0 ? 1 : 0); let faceIdx = -1; if (nz === 1) faceIdx = x === 1 ? 0 : x === -1 ? 1 : y === 1 ? 2 : y === -1 ? 3 : z === 1 ? 4 : 5; out.push({ dx: x, dy: y, dz: z, faceIdx }); } } } return out; })()`

**Methods**
- `public setOnError(handler: (ev: ErrorEvent | Event) => void): void`
- `public terminate(): void`
- `public postFullRemesh(chunk: Chunk, forcedLod?: number): void`
- `public postTerrainGeneration(chunk: Chunk, deferLighting: boolean = true): void`
- `public initDistantTerrainShared(positionsBuffer: SharedArrayBuffer, normalsBuffer: SharedArrayBuffer, surfaceTilesBuffer: SharedArrayBuffer, radius: number, gridStep: number): void`
- `public postGenerateDistantTerrain(requestId: number, centerChunkX: number, centerChunkZ: number, radius: number, gridStep: number): void`
- `public initLightShared(headerBuffer: SharedArrayBuffer): void`
- `public postLightSetClosedFaceMask(maskBuffer: SharedArrayBuffer): void`
- `public postLightRegisterChunk(req: {
		seq: number;
		chunkId: bigint;
		chunkX: number;
		chunkY: number;
		chunkZ: number;
		headerSlot: number;
		blockSAB: SharedArrayBuffer | null;
		lightSAB: SharedArrayBuffer | null;
		paletteSAB: SharedArrayBuffer | null;
		blockStorageBytesPerElement: 1 | 2;
	}): void`
- `public postLightUnregisterChunk(chunkId: bigint): void`
- `public postLightUpdateBuffers(req: {
		chunkId: bigint;
		headerSlot: number;
		blockSAB: SharedArrayBuffer | null;
		paletteSAB: SharedArrayBuffer | null;
		lightSAB: SharedArrayBuffer | null;
		blockStorageBytesPerElement: 1 | 2;
	}): void`
- `public postLightMutate(req: {
		chunkId: bigint;
		headerSlot: number;
		x: number;
		y: number;
		z: number;
		oldPacked: number;
		newPacked: number;
		seq: number;
	}): void`
- `public postLightAddEmission(req: {
		chunkId: bigint;
		headerSlot: number;
		x: number;
		y: number;
		z: number;
		level: number;
		seq: number;
	}): void`
- `public postLightSkyReconcile(req: {
		chunkId: bigint;
		headerSlot: number;
		seq: number;
	}): void`
- `public postLightPropagateDeferred(req: {
		chunkId: bigint;
		headerSlot: number;
		seedQueue: Uint16Array;
		seedLength: number;
		seq: number;
	}): void`

**Types / Interfaces / Enums**
- type `GenerateDistantTerrainRequest`
- type `InitDistantTerrainSharedRequest`
- type `InitLightSharedRequest`
- type `LightAddEmissionRequest`
- type `LightMutateRequest`
- type `LightPropagateDeferredRequest`
- type `LightSetClosedFaceMaskRequest`
- type `LightSkyReconcileRequest`
- type `MeshWorkerResponse`
- type `WorkerResponseData`

---

## `World/Chunk/ChunkWorkerPool.ts` (1782 LOC)

### export class ChunkWorkerPool

**Properties**
- `private static instance: ChunkWorkerPool | undefined`
- `private static readonly WORKER_ERROR_COOLDOWN_MS`
- `private static readonly MIN_AUTO_POOL_SIZE`
- `private static readonly MAX_AUTO_POOL_SIZE`
- `private static readonly DEFERRED_LIGHTING_BUDGET_MS`
- `private static readonly DEFERRED_LIGHTING_MAX_CHUNKS_PER_FRAME`
- `private static readonly LAST_DISPATCH_RING_SIZE`
- `private workers: ChunkWorker[] = []`
- `private workerTaskContext: WorkerTaskContext[] = []`
- `private distantTerrainSharedInit: { positionsBuffer: SharedArrayBuffer; normalsBuffer: SharedArrayBuffer; surfaceTilesBuffer: SharedArrayBuffer; radius: number; gridStep: number; } | null = null`
- `private workerRestartAtMs: number[] = []`
- `private idleWorkerSet: Set<number> = new Set()`
- `private idleWorkerIndices: number[] = []`
- `private idleWorkerIndexPositions: Map<number, number> = new Map()`
- `private _idleReadIdx`
- `private meshResultQueue: FullMeshMessage[] = []`
- `private meshResultQueueReadIdx`
- `private remeshFlushScheduled`
- `private processQueuePumpScheduled`
- `private meshDrainScheduled`
- `private pendingRemeshSaveIds`
- `private pendingRemeshSaveTimer: ReturnType<typeof setTimeout> | null = null`
- `private readonly REMESH_SAVE_DEBOUNCE_MS`
- `private inFlightRemeshKeys`
- `private rerunRemeshAfterInflight`
- `private distantTerrainInFlight`
- `private nextDistantTerrainRequestId`
- `private opfsClient: OpfsClient | null = null`
- `private opfsReady`
- `private opfsInitPromise: Promise<void> | null = null`
- `private opfsFlushCounter`
- `private static readonly _flushPendingScratch: Array<[Chunk, boolean]> = []`
- `private static readonly _queryScratch: Chunk[] = []`
- `private static readonly _dedupScratch: Set<number> = new Set()`
- `private readonly _boundScheduleRemesh`
- `private static readonly _lodCandidateChunks: Chunk[] = []`
- `private static readonly _lodCandidateLods: number[] = []`
- `private static readonly _lodCandidateScores: number[] = []`
- `private static readonly _lodCandidateIndices: number[] = []`
- `private nextLightSeqCounter`
- `private lightDirtyQueue: { seq: number; dirtySlots: Uint32Array }[] = []`
- `private lightDirtyQueueReadIdx`
- `private lightDirtyPumpScheduled`

**Methods**
- `public static getLodCandidateScore(idx: number): number`
- `private _removeWorkerFromIdle(workerIndex: number): void`
- `private _consumeNextIdleWorker(): number`
- `private _compactIdleWorkers(): void`
- `private handleWorkerFailure(workerIndex: number, reason: unknown): void`
- `public nextLightSeq(): number`
- `public postLightMutate(req: {
		chunkId: bigint;
		headerSlot: number;
		x: number;
		y: number;
		z: number;
		oldPacked: number;
		newPacked: number;
		seq: number;
	}): void`
- `public postLightAddEmission(req: {
		chunkId: bigint;
		headerSlot: number;
		x: number;
		y: number;
		z: number;
		level: number;
		seq: number;
	}): void`
- `public postLightSkyReconcile(req: {
		chunkId: bigint;
		headerSlot: number;
		seq: number;
	}): void`
- `public postLightPropagateDeferred(req: {
		chunkId: bigint;
		headerSlot: number;
		seedQueue: Uint16Array;
		seedLength: number;
		seq: number;
	}): void`
- `public enqueueDeferredLightFromSunlightInit(chunk: Chunk, seedQueue: Uint16Array, seedLength: number): void`
- `private getLightWorker(): ChunkWorker`
- `private broadcastLightRegister(chunk: Chunk): void`
- `private broadcastLightUpdateBuffers(chunk: Chunk): void`
- `private broadcastLightUnregister(chunk: Chunk): void`
- `private onLightChunkLoaded(chunk: Chunk): void`
- `private onLightChunkLayoutChanged(chunk: Chunk): void`
- `private onLightChunkDisposed(chunk: Chunk): void`

**Module-level functions**
- `function compareLodCandidateScores(a: number, b: number): number`
- `function packInflightKey(chunkId: bigint, lod: number): bigint`

**Types / Interfaces / Enums**
- type `DistantTerrainGeneratedMessage`
- type `DistantTerrainTask`
- type `FullMeshMessage`
- type `LightDirtyMessage`
- type `MeshWorkerResponse`
- type `TerrainGeneratedMessage`
- type `WorkerResponseData`
- type `WorkerMessageData`
- type `ChunkWorkerPoolDebugStats`
- type `WorkerTaskContext`

---

## `World/Chunk/DataStructures/BlockEncoding.ts` (26 LOC)

**Module-level functions**
- `export function packBlockValue(blockId: number, state = 0): number`
- `export function unpackBlockId(value: number): number`
- `export function unpackBlockState(value: number): number`
- `export function packRotationSlice(rotation: number, slice: number): number`
- `export function unpackRotation(state: number): number`
- `export function unpackSlice(state: number): number`

---

## `World/Chunk/DataStructures/ChunkCoords.ts` (23 LOC)

**Module-level functions**
- `export function packCoords(x: number, y: number, z: number): bigint`
- `export function unpackChunkCoords(id: bigint)`

---

## `World/Chunk/DataStructures/MeshData.ts` (7 LOC)

### export class MeshData

**Properties**
- `faceDataA: Uint8Array = EMPTY_U8`
- `faceDataB: Uint8Array = EMPTY_U8`
- `faceDataC: Uint8Array = EMPTY_U8`
- `faceCount`

---

## `World/Chunk/DataStructures/PaletteExpander.ts` (37 LOC)

### export class PaletteExpander

**Methods**
- `expandPalette(packed: Uint8Array, palette: ArrayLike<number>, totalBlocks: number): Uint8Array | Uint16Array`
- `isUint16(palette: ArrayLike<number> | null | undefined): boolean`

---

## `World/Chunk/DataStructures/ResizableTypedArray.ts` (156 LOC)

### export class ResizableTypedArray

**Constructor**
- `constructor(private ctor: new (capacity: number) => T, initialCapacity = 512)`

**Properties**
- `private array: T`
- `private capacity: number`
- `public length`

**Accessors**
- `get backingArray(): T`
- `get currentCapacity(): number`
- `get finalArray(): T`

**Methods**
- `push4(a: number, b: number, c: number, d: number): void`
- `push6(a: number, b: number, c: number, d: number, e: number, f: number): void`
- `push8(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number): void`
- `push12(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i1: number, j: number, k: number, l: number): void`
- `private grow(minCapacity: number): void`
- `ensureCapacity(minCapacity: number): void`
- `reset(): void`
- `bulkPush(src: T): void`
- `pushFrom(other: ResizableTypedArray<T>): void`

---

## `World/Chunk/DataStructures/RingBuffer.ts` (50 LOC)

### export class RingBuffer

**Constructor**
- `constructor(capacity: number)`

**Properties**
- `private buf: (T | undefined)[]`
- `private head`
- `private tail`
- `private _size`
- `readonly capacity: number`

**Accessors**
- `get size(): number`

**Methods**
- `push(value: T): void`
- `shift(): T | undefined`
- `toArray(): T[]`
- `forEach(fn: (value: T) => void): void`
- `forEachInto(dest: T[]): void`

---

## `World/Chunk/DataStructures/WorkerInternalMeshData.ts` (7 LOC)

**Types / Interfaces / Enums**
- type `WorkerInternalMeshData`

---

## `World/Chunk/DataStructures/WorkerMessageType.ts` (208 LOC)

**Types / Interfaces / Enums**
- interface `SerializedLightSeedState`
- type `PackedBlockArray`
- type `PackedPalette`
- type `NeighborBlockArray`
- type `NeighborLightArray`
- type `GenerateTerrainRequest`
- type `GenerateFullMeshRequest`
- type `DistantTerrainTask`
- type `InitDistantTerrainSharedRequest`
- type `GenerateDistantTerrainRequest`
- type `WorkerRequestData`
- type `InitLightSharedRequest`
- type `LightSetClosedFaceMaskRequest`
- type `LightRegisterChunkRequest`
- type `LightUnregisterChunkRequest`
- type `LightUpdateChunkBuffersRequest`
- type `LightMutateRequest`
- type `LightAddEmissionRequest`
- type `LightSkyReconcileRequest`
- type `LightPropagateDeferredRequest`
- type `LightDirtyMessage`
- type `FullMeshMessage`
- type `TerrainGeneratedMessage`
- type `DistantTerrainGeneratedMessage`
- type `WorkerResponseData`
- type `MeshWorkerResponse`

---

## `World/Chunk/Loading/ChunkEntityRegistry.ts` (127 LOC)

### export class ChunkEntityRegistry

**Constructor**
- `constructor(private readonly adapter: ChunkBoundEntityAdapter<TEntity>)`

**Properties**
- `private readonly entities`
- `private readonly pendingReloads`
- `private readonly loaders`
- `private restoringChunkEntities`
- `private chunkLoadedHookInstalled`
- `private previousChunkLoadedHook: ((chunk: Chunk) => void) | null = null`

**Methods**
- `public registerLoader(type: string, loader: ChunkEntityLoader): void`
- `public registerEntity(entity: TEntity): symbol`
- `public unregisterEntity(handle: symbol | undefined): void`
- `public ensureChunkLoadedHook(): void`
- `public async unloadEntitiesForChunk(chunk: Chunk): Promise<void>`
- `public async restoreEntitiesForChunk(chunk: Chunk): Promise<void>`
- `public spawnSerializedEntities(serializedEntities: SavedChunkEntityData[], chunk: Chunk): SavedChunkEntityData[]`
- `public getRegisteredEntities(): ReadonlyMap<symbol, TEntity>`
- `public getPendingReloadCount(): number`
- `public getRegisteredEntityCount(): number`

**Types / Interfaces / Enums**
- interface `ChunkBoundEntityAdapter`
- type `ChunkEntityLoader`

---

## `World/Chunk/Loading/ChunkHydration.ts` (39 LOC)

### export class ChunkHydration

**Constructor**
- `constructor(private readonly adapter: ChunkHydrationAdapter)`

**Methods**
- `public applyHydratedChunkFromSavedData(chunk: Chunk, savedData: SavedChunkData, scheduleRemesh = false): void`

**Types / Interfaces / Enums**
- interface `HydrationStoragePayload`
- interface `ChunkHydrationAdapter`

---

## `World/Chunk/Loading/ChunkLoadingDebug.ts` (120 LOC)

### export class ChunkLoadingDebug

**Constructor**
- `constructor(private readonly adapter: ChunkLoadingDebugAdapter = {})`

**Properties**
- `private stats: ChunkLoadingDebugStats = { loadQueueLength: 0, unloadQueueLength: 0, pendingChunkEntityReloadCount: 0, registeredChunkEntityCount: 0, isProcessing: false, currentStage: null, processedLoadsThisSlice: 0, processedUnloadsThisSlice: 0, processedLoadsTotal: 0, processedUnloadsTotal: 0, sliceStartedAtMs: null, sliceElapsedMs: 0, frameBudgetMs: 0, continuationScheduled: false, }`

**Methods**
- `public getStats(): ChunkLoadingDebugStats`
- `public refreshQueueSnapshot(params: {
		loadQueueLength: number;
		unloadQueueLength: number;
		pendingChunkEntityReloadCount?: number;
		registeredChunkEntityCount?: number;
	}): void`
- `public beginProcessing(frameBudgetMs: number, stage: string | null = null): void`
- `public endProcessing(): void`
- `public setStage(stage: string | null): void`
- `public markContinuationScheduled(value: boolean): void`
- `public recordLoadProcessed(count: number = 1): void`
- `public recordUnloadProcessed(count: number = 1): void`
- `public updateSlice(frameBudgetMs?: number): void`
- `public resetTotals(): void`
- `private updateSliceElapsed(): void`
- `private now(): number`

**Types / Interfaces / Enums**
- interface `ChunkQueueDebugSnapshot`
- interface `ChunkProcessDebugSnapshot`
- interface `ChunkLoadingDebugStats`
- interface `ChunkLoadingDebugAdapter`

---

## `World/Chunk/Loading/ChunkPersistenceCoordinator.ts` (128 LOC)

### export class ChunkPersistenceCoordinator

**Constructor**
- `constructor(private readonly adapter: ChunkPersistenceCoordinatorAdapter)`

**Properties**
- `private flushPromise: Promise<void> | null = null`
- `private pendingFlushRequested`
- `private entityFlushPromise: Promise<void> | null = null`
- `private pendingEntityFlushRequested`
- `private readonly lastPersistedEntityChunkIds`
- `private readonly _modifiedChunksScratch: Chunk[] = []`
- `private readonly _candidateChunkIdsScratch: bigint[] = []`
- `private readonly _seenChunkIdsScratch`

**Methods**
- `public async flushModifiedChunks(maxChunks: number = this.getChunkSaveBatchSize()): Promise<void>`
- `public async flushChunkBoundEntities(maxChunks: number = this.getChunkEntitySaveBatchSize()): Promise<void>`
- `private getChunkSaveBatchSize(): number`
- `private getChunkEntitySaveBatchSize(): number`
- `private async flushModifiedChunksInternal(maxChunks: number): Promise<void>`
- `private async flushChunkBoundEntitiesInternal(maxChunks: number): Promise<void>`

**Types / Interfaces / Enums**
- interface `ChunkPersistenceCoordinatorAdapter`

---

## `World/Chunk/Loading/ChunkProcessScheduler.ts` (414 LOC)

### export class ChunkProcessScheduler

**Constructor**
- `constructor(private readonly adapter: ChunkProcessSchedulerAdapter)`

**Properties**
- `private isProcessing`
- `private inFlightProcessState: InFlightProcessState | null = null`
- `private _state: InFlightProcessState = this.createReusableProcessState()`
- `private processContinuationScheduled`
- `private _saveScratch: Chunk[] = []`
- `private _nearIdScratch: bigint[] = []`
- `private _farIdScratch: bigint[] = []`

**Accessors**
- `public get processing(): boolean`

**Methods**
- `private createReusableProcessState(): InFlightProcessState`
- `private resetState(state: InFlightProcessState): void`
- `public async processQueues(): Promise<void>`
- `public beginSlice(state: InFlightProcessState): void`
- `public hasBudget(state: InFlightProcessState): boolean`
- `public scheduleProcessContinuation(): void`

**Types / Interfaces / Enums**
- interface `ChunkProcessSchedulerAdapter`

---

## `World/Chunk/Loading/ChunkQueueManager.ts` (154 LOC)

### export class ChunkQueueManager

**Constructor**
- `constructor(private readonly adapter: ChunkQueueManagerAdapter = {})`

**Properties**
- `private readonly loadQueue: Chunk[] = []`
- `private readonly loadQueueSet`
- `private readonly unloadQueueSet`
- `loadQueue: [...this.loadQueue],`
- `unloadQueue: [...this.unloadQueueSet],`

**Methods**
- `public getLoadBatchSize(): number`
- `public getUnloadBatchSize(): number`
- `public getLoadQueueLength(): number`
- `public getUnloadQueueLength(): number`
- `public hasPendingLoads(): boolean`
- `public hasPendingUnloads(): boolean`
- `public hasPendingWork(): boolean`
- `public ensureChunkQueuedForLoad(chunk: Chunk): boolean`
- `public queueChunkForUnload(chunk: Chunk): boolean`
- `public dequeueLoadBatch(maxChunks: number = this.getLoadBatchSize()): ChunkQueueBatch`
- `public dequeueUnloadBatch(maxChunks: number = this.getUnloadBatchSize()): ChunkQueueBatch`
- `public removeChunk(chunk: Chunk): void`
- `public clear(): void`
- `public snapshot()`
- `public refreshQueueDebugSnapshot(): void`

**Types / Interfaces / Enums**
- interface `ChunkQueueManagerAdapter`
- interface `ChunkQueueBatch`

---

## `World/Chunk/Loading/ChunkReadinessAdapter.ts` (63 LOC)

### export class ChunkReadiness

**Constructor**
- `constructor(private readonly adapter: ChunkReadinessAdapter = {})`

**Methods**
- `public areChunksLoadedAround(chunkX: number, chunkY: number, chunkZ: number, horizontalRadius: number = 1, verticalRadius: number = 0): boolean`
- `public areChunksLod0ReadyAround(chunkX: number, chunkY: number, chunkZ: number, horizontalRadius: number = 1, verticalRadius: number = 0): boolean`
- `private isLoaded(chunk: Chunk): boolean`
- `private isLod0Ready(chunk: Chunk): boolean`

**Types / Interfaces / Enums**
- interface `ChunkReadinessAdapter`

---

## `World/Chunk/Loading/ChunkStreamingController.ts` (806 LOC)

**Module-level functions**
- `function compareQueuedChunkRequestPriority(a: QueuedChunkRequest, b: QueuedChunkRequest): number`
- `function chunkDistScratch(chunkX: number, chunkY: number, chunkZ: number, centerX: number, centerY: number, centerZ: number)`

**Types / Interfaces / Enums**
- type `QueuedChunkRequest`

---

## `World/Chunk/Loading/ChunkTypes.ts` (75 LOC)

**Types / Interfaces / Enums**
- type `ChunkBoundEntity`
- type `InFlightProcessState`
- type `ChunkLoadingDebugStats`

---

## `World/Chunk/Loading/ChunkWorldMutations.ts` (257 LOC)

### class ResolvedChunkCoords

**Properties**
- `chunkX`
- `chunkY`
- `chunkZ`
- `localX`
- `localY`
- `localZ`
- `chunk: Chunk | undefined`

### export class ChunkWorldMutations

**Constructor**
- `constructor(private readonly adapter: ChunkWorldMutationsAdapter = {})`

**Methods**
- `public getBlockByWorldCoords(worldX: number, worldY: number, worldZ: number): number`
- `public getLightByWorldCoords(worldX: number, worldY: number, worldZ: number): number`
- `public setBlock(worldX: number, worldY: number, worldZ: number, blockId: number, state: number = 0): boolean`
- `public deleteBlock(worldX: number, worldY: number, worldZ: number): boolean`
- `private isBoundaryLocalCoord(localX: number, localY: number, localZ: number): boolean`

**Module-level functions**
- `function resolveCoords(worldX: number, worldY: number, worldZ: number): ResolvedChunkCoords`
- `export function toLocalBlockCoordinates(worldX: number, worldY: number, worldZ: number): LocalBlockCoordinates`
- `export function getBlockStateByWorldCoords(worldX: number, worldY: number, worldZ: number): number`

**Types / Interfaces / Enums**
- interface `WorldBlockCoordinates`
- interface `LocalBlockCoordinates`
- interface `BlockMutationContext`
- interface `ChunkWorldMutationsAdapter`

---

## `World/Chunk/Loading/LoadedChunkIndex.ts` (94 LOC)

### export class LoadedChunkIndex

**Properties**
- `private readonly cells`
- `private readonly chunkCellKeys`
- `centerX: number,`
- `centerY: number,`
- `centerZ: number,`
- `horizontalRadius: number,`
- `verticalRadius: number,`

**Methods**
- `register(chunk: Chunk): void`
- `unregister(chunk: Chunk): void`
- `queryCollect(centerX: number, centerY: number, centerZ: number, horizontalRadius: number, verticalRadius: number, out: Chunk[]): void`

**Module-level functions**
- `function hashCellKey(cx: number, cy: number, cz: number): number`
- `function chunkToCellKey(chunk: Chunk): number`

---

## `World/Chunk/LOD/ChunkLodRules.ts` (246 LOC)

### export class Lod0ChunkCreationRule implements ChunkLodCreationRule

**Constructor**
- `constructor(private readonly horizontalRadius: number, private readonly verticalRadius: number)`

**Properties**
- `public readonly lodLevel`
- `public readonly allowsChunkCreation`

**Methods**
- `public matches(distance: ChunkLodDistance): boolean`

### export class Lod1ChunkCreationRule implements ChunkLodCreationRule

**Constructor**
- `constructor(private readonly horizontalRadius: number, private readonly verticalRadius: number)`

**Properties**
- `public readonly lodLevel`
- `public readonly allowsChunkCreation`

**Methods**
- `public matches(distance: ChunkLodDistance): boolean`

### export class Lod2ChunkCreationRule implements ChunkLodCreationRule

**Constructor**
- `constructor(private readonly horizontalRadius: number, private readonly verticalRadius: number)`

**Properties**
- `public readonly lodLevel`
- `public readonly allowsChunkCreation`

**Methods**
- `public matches(distance: ChunkLodDistance): boolean`

### export class Lod3ChunkCreationRule implements ChunkLodCreationRule

**Constructor**
- `constructor(private readonly horizontalRadius: number, private readonly verticalRadius: number)`

**Properties**
- `public readonly lodLevel`
- `public readonly allowsChunkCreation`

**Methods**
- `public matches(distance: ChunkLodDistance): boolean`

### export class DistantOnlyChunkCreationRule implements ChunkLodCreationRule

**Constructor**
- `constructor(public readonly lodLevel = 4)`

**Properties**
- `public readonly allowsChunkCreation`

**Methods**
- `public matches(_distance: ChunkLodDistance): boolean`

### export class ChunkLodRuleSet

**Constructor**
- `constructor(public readonly radii: ChunkLodRadii, private readonly rules: ChunkLodCreationRule[], public readonly revision: number = 0)`

**Methods**
- `public static fromRenderRadii(renderDistance: number, verticalRadius: number, revision: number = 0): ChunkLodRuleSet`
- `private resolveWithDistance(horizontalDist: number, verticalDist: number): ChunkLodDecision`
- `public resolve(target: ChunkLodCoordinates, player: ChunkLodCoordinates): ChunkLodDecision`
- `public resolveWithHysteresis(targetX: number, targetY: number, targetZ: number, playerX: number, playerY: number, playerZ: number, previousLod: number | null | undefined): ChunkLodDecision`

**Types / Interfaces / Enums**
- interface `ChunkLodCreationRule`
- type `ChunkLodCoordinates`
- type `ChunkLodRadii`
- type `ChunkLodDistance`
- type `ChunkLodDecision`

---

## `World/Chunk/MergedMeshManager.ts` (515 LOC)

**Module-level functions**
- `function disposeGroupMesh(mesh: Mesh): void`
- `export function assignChunkToGroup(chunk: Chunk, opaqueData: MeshData | null, transparentData: MeshData | null): MergedMeshGroup`
- `export function removeChunkFromGroup(chunk: Chunk): void`

**Types / Interfaces / Enums**
- interface `ChunkMemberData`

---

## `World/Chunk/PackedChunkMesh.ts` (730 LOC)

**Module-level functions**
- `function acquireInterval(base: number, count: number)`
- `function releaseInterval(node: { base: number; count: number }): void`
- `function ensureInstancedBuild(material: ShaderMaterial, mesh: Mesh): void`
- `export function initPackedChunkArenas(engine: EngineContext, scene: SceneContext): void`
- `export function getFaceArenaCount(): number`
- `function ensureArenas(): void`
- `function createFaceArena(initialCapacity: number): FaceArena`
- `function writeBufferChunked(buffer: StorageBuffer, data: Uint32Array | Float32Array, dstByteOffset: number, srcElementOffset: number, elementCount: number): void`
- `export function registerPackedMaterial(material: ShaderMaterial): void`
- `export function disposePackedMesh(mesh: Mesh): void`
- `export function destroyPackedArenas(): void`

**Types / Interfaces / Enums**
- type `EngineContext`
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`
- type `StorageBuffer`
- type `BuildGroupFn`

---

## `World/Chunk/voxel.worker.ts` (136 LOC)

**Module-level functions**
- `function expandCenterOnly(request: VoxelWorkerRequest): Uint8Array | Uint16Array`
- `function ensureShapesReady(): Promise<void>`
- `function resetMeshOut(): void`

**Types / Interfaces / Enums**
- interface `VoxelWorkerRequest`
- type `WorkerMeshBaseContext`
- type `WorkerMeshInput`
- type `FullMeshMessage`

---

## `World/Chunk/Worker/BlockTickScheduler.ts` (112 LOC)

---

## `World/Chunk/Worker/ChunkLightHeader.ts` (78 LOC)

**Module-level functions**
- `function rowBase(slot: number): number`
- `export function wrapLightHeader(buffer: SharedArrayBuffer): LightHeaderView`
- `export function readHeaderMeta(view: LightHeaderView, slot: number): number`
- `export function readHeaderFlags(view: LightHeaderView, slot: number): number`
- `export function readHeaderUniformId(view: LightHeaderView, slot: number): number`
- `export function bumpHeaderLightSeq(view: LightHeaderView, slot: number): number`
- `export function writeHeaderRow(view: LightHeaderView, slot: number, opts: {
		chunkId: bigint;
		isUniform: boolean;
		uniformBlockId: number;
		storageIsUint16: boolean;
		hasPalette: boolean;
		isLoaded: boolean;
	}): void`
- `export function clearHeaderRow(view: LightHeaderView, slot: number): void`

**Types / Interfaces / Enums**
- type `LightHeaderView`

---

## `World/Chunk/Worker/ChunkMesherConstants.ts` (62 LOC)

**Module-level functions**
- `export function filtersFullSunlight(blockId: number): boolean`

---

## `World/Chunk/Worker/LightCore.ts` (1132 LOC)

### class LightQueue

**Properties**
- `readonly chunks: (bigint | 0)[] = new Array(BFS_CAPACITY).fill(0)`
- `readonly coords`
- `readonly levels`
- `head`
- `tail`

**Accessors**
- `get length(): number`

**Methods**
- `clear(): void`
- `push(chunkId: bigint, x: number, y: number, z: number, level: number): void`

**Module-level functions**
- `function getLightEmission(blockId: number): number`
- `function getFaceBit(axis: number, dir: number): number`
- `function resolveNeighborView(startView: ChunkView, tx: number, ty: number, tz: number, size: number)`
- `export function refreshLayout(registry: ChunkViewRegistry, view: ChunkView): void`
- `export function registerChunk(registry: ChunkViewRegistry, args: {
		chunkId: bigint;
		chunkX: number;
		chunkY: number;
		chunkZ: number;
		headerSlot: number;
		block_array: Uint8Array | Uint16Array | null;
		palette: Uint16Array | null;
		light_array: Uint8Array;
	}): ChunkView`
- `export function updateChunkBuffers(registry: ChunkViewRegistry, chunkId: bigint, updates: {
		block_array?: Uint8Array | Uint16Array | null;
		palette?: Uint16Array | null;
		light_array?: Uint8Array;
	}): void`
- `export function unregisterChunk(registry: ChunkViewRegistry, chunkId: bigint): void`
- `function addAdjacentBorderSlots(dirtySlots: Set<number>, view: ChunkView, x: number, y: number, z: number): void`
- `function _tryAddNeighbour(dirtySlots: Set<number>, view: ChunkView, dx: number, dy: number, dz: number): void`
- `function getViewBlockPacked(view: ChunkView, x: number, y: number, z: number): number`
- `function getBlockLight(view: ChunkView, idx: number): number`
- `function getSkyLight(view: ChunkView, idx: number): number`
- `export function lightMutate(registry: ChunkViewRegistry, chunkId: bigint, x: number, y: number, z: number, oldPacked: number, _newPacked: number): Set<number>`
- `function removeLightAt(registry: ChunkViewRegistry, view: ChunkView, x: number, y: number, z: number, startLevel: number, isSkyLight: boolean, dirtySlots: Set<number>, oldPacked?: number): void`
- `function updateLightFromNeighborsAt(registry: ChunkViewRegistry, view: ChunkView, x: number, y: number, z: number, isSkyLight: boolean, dirtySlots: Set<number>): void`
- `export function addLightAt(registry: ChunkViewRegistry, view: ChunkView, x: number, y: number, z: number, level: number, dirtySlots: Set<number>): void`
- `function cutSkyLightBelowAt(registry: ChunkViewRegistry, view: ChunkView, x: number, y: number, z: number, dirtySlots: Set<number>): void`
- `export function lightSkyReconcile(registry: ChunkViewRegistry, chunkId: bigint): Set<number>`
- `function batchPropagate(registry: ChunkViewRegistry, chunks: BigInt64Array, coords: Int32Array, levels: Uint8Array, count: number, dirty: Set<number>): Set<number>`
- `export function lightBlockReconcile(registry: ChunkViewRegistry, chunkId: bigint): Set<number>`
- `export function propagateDeferred(registry: ChunkViewRegistry, chunkId: bigint, seedState: { queue: Uint16Array; length: number }): Set<number>`
- `export function bumpLightVersion(registry: ChunkViewRegistry, slot: number): void`

**Types / Interfaces / Enums**
- type `LightHeaderView`

---

## `World/Chunk/Worker/LightTaskHandlers.ts` (223 LOC)

**Module-level functions**
- `function viewForBuffer(sab: SharedArrayBuffer, bytesPerElement: 1 | 2, length: number): Uint8Array | Uint16Array`
- `function ensureState(req: InitLightSharedRequest | null): ChunkViewRegistry`
- `function postDirty(seq: number, dirtySlots: Set<number>): void`
- `function handleInitLightShared(req: InitLightSharedRequest): void`
- `function handleSetClosedFaceMask(req: LightSetClosedFaceMaskRequest): void`
- `function handleRegisterChunk(req: LightRegisterChunkRequest): void`
- `function handleUnregisterChunk(req: LightUnregisterChunkRequest): void`
- `function handleUpdateBuffers(req: LightUpdateChunkBuffersRequest): void`
- `function handleMutate(req: LightMutateRequest): void`
- `function handleAddEmission(req: LightAddEmissionRequest): void`
- `function handleSkyReconcile(req: LightSkyReconcileRequest): void`
- `function handlePropagateDeferred(req: LightPropagateDeferredRequest): void`

**Types / Interfaces / Enums**
- type `ChunkViewRegistry`
- type `LightState`

---

## `World/Chunk/Worker/LODUtilities.ts` (17 LOC)

**Module-level functions**
- `export function shouldSkipLodForChunk(chunk: Chunk, lod: number): boolean`
- `export function clampLodForChunk(chunk: Chunk, lod: number): number`
- `export function normalizeChunkLod(chunk: Chunk): void`

---

## `World/Chunk/Worker/NeighborHelpers.ts` (56 LOC)

**Module-level functions**
- `export function hasStableVoxelNeighborsForCachedMesh(chunk: Chunk): boolean`

---

## `World/Chunk/Worker/WaterSimulation.ts` (386 LOC)

**Module-level functions**
- `function scheduleNeighborUpdates(worldX: number, worldY: number, worldZ: number, scheduler: BlockTickScheduler, excludeDx = 0, excludeDy = 0, excludeDz = 0): void`
- `function isSolidBlock(blockId: number): boolean`
- `function canWaterPass(x: number, y: number, z: number): boolean`
- `function isHole(x: number, y: number, z: number): boolean`
- `function findFlowCosts(worldX: number, worldY: number, worldZ: number): void`
- `function getFlowDirectionMask(worldX: number, worldY: number, worldZ: number): number`
- `function placeWaterSource(worldX: number, worldY: number, worldZ: number): void`
- `function placeWaterFlowing(worldX: number, worldY: number, worldZ: number, level: number): void`
- `function removeWater(worldX: number, worldY: number, worldZ: number): void`
- `function flowInto(worldX: number, worldY: number, worldZ: number, newLevel: number, scheduler: BlockTickScheduler, excludeDx: number, excludeDy: number, excludeDz: number): boolean`
- `function checkRetract(worldX: number, worldY: number, worldZ: number, level: number, scheduler: BlockTickScheduler): boolean`
- `function checkInfiniteSource(worldX: number, worldY: number, worldZ: number): boolean`
- `export function processWaterUpdate(worldX: number, worldY: number, worldZ: number): void`
- `function scheduleWaterNeighbors(worldX: number, worldY: number, worldZ: number, scheduler: BlockTickScheduler): void`
- `export function scheduleWaterNeighborUpdate(worldX: number, worldY: number, worldZ: number): void`
- `export function scheduleBlockBreakWaterUpdates(worldX: number, worldY: number, worldZ: number): void`
- `export function scheduleBlockPlaceWaterUpdates(worldX: number, worldY: number, worldZ: number, blockId: number): void`
- `export function checkNewInfiniteSource(worldX: number, worldY: number, worldZ: number): void`

---

## `World/Chunk/Worker/WorkerTaskHandlers.ts` (143 LOC)

**Module-level functions**
- `export function handleGenerateTerrain(request: GenerateTerrainRequest, deps: { generator: WorldGenerator; compressBlocks: CompressBlocksFn })`
- `export function handleInitDistantTerrainShared(request: {
	positionsBuffer: SharedArrayBuffer;
	normalsBuffer: SharedArrayBuffer;
	surfaceTilesBuffer: SharedArrayBuffer;
	radius: number;
	gridStep: number;
})`
- `export function handleGenerateDistantTerrain(request: GenerateDistantTerrainRequest)`
- `function pushTransferable(transferables: Transferable[], view: ArrayBufferView | null | undefined, label: string): void`

**Types / Interfaces / Enums**
- type `GenerateDistantTerrainRequest`
- type `GenerateTerrainRequest`
- type `TerrainGeneratedMessage`
- type `MeshBuilderLike`
- type `CompressBlocksFn`

---

## `World/Collision/VoxelAabbCollider.ts` (538 LOC)

**Module-level functions**
- `function rotateShapeBoxY(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, rotation: number, out: [number, number, number, number, number, number]): void`

**Types / Interfaces / Enums**
- type `Mesh`
- type `SceneContext`
- type `Vec3`
- type `BlockShapeInfo`
- type `IsSolidBlockAt`
- type `VoxelAabbDebugOptions`

---

## `World/Collision/VoxelObbCollider.ts` (228 LOC)

### export class VoxelObbCollider

**Constructor**
- `constructor(halfExtents: Vec3, isSolidBlockAt: IsSolidBlockAt, epsilon = 0.001, debugOptions?: VoxelObbDebugOptions)`

**Properties**
- `px: number,`
- `py: number,`
- `pz: number,`
- `hx: number,`
- `hy: number,`
- `hz: number,`
- `vx: number,`
- `vy: number,`
- `vz: number,`

**Methods**
- `copyVec3(this.#halfExtents, halfExtents)`
- `public setYaw(yaw: number)`
- `public setHalfExtents(halfExtents: Vec3): void`
- `public setCenterOffset(offset: Vec3): void`
- `setVec3(this.#rotX, c, 0, -s)`
- `setVec3(this.#rotZ, s, 0, c)`
- `addToScene(options.scene, this.#debugMesh)`
- `public overlaps(position: Vec3): boolean`
- `public moveAxis(position: Vec3, velocity: Vec3, axis: Axis, delta: number, stepSize: number): void`
- `public syncDebugMesh(position: Vec3): void`
- `public dispose(): void`
- `public static toggleDebugEnabled(): void`
- `public static setDebugEnabled(enabled: boolean): void`

**Types / Interfaces / Enums**
- type `Mesh`
- type `SceneContext`
- type `Vec3`
- type `IsSolidBlockAt`
- type `VoxelObbDebugOptions`

---

## `World/GLOBAL_VALUES.ts` (11 LOC)

---

## `World/Light/DistantTerrainShader.ts` (162 LOC)

---

## `World/Light/DistantTerrainShaderLite.ts` (213 LOC)

**Types / Interfaces / Enums**
- type `EngineContext`
- type `SceneContext`
- type `ShaderMaterial`
- type `Texture2D`

---

## `World/Light/liteGpuBuffer.ts` (15 LOC)

**Module-level functions**
- `function deviceOf(engine: EngineContext): GPUDevice`
- `export function onGpuWorkDone(engine: EngineContext): Promise<void>`

**Types / Interfaces / Enums**
- interface `EngineWithDevice`

---

## `World/Light/Lod2Shader.ts` (287 LOC)

---

## `World/Light/Lod2ShaderLite.ts` (247 LOC)

**Module-level functions**
- `function baseUniforms(): readonly ShaderUniformOption[]`
- `export function createLod2OpaqueMaterial(opts: Lod2MaterialOptions): ShaderMaterial`
- `export function createLod2TransparentMaterial(opts: Lod2MaterialOptions): ShaderMaterial`

**Types / Interfaces / Enums**
- interface `Lod2MaterialOptions`
- type `EngineContext`
- type `SceneContext`
- type `ShaderMaterial`
- type `ShaderUniformOption`
- type `Texture2D`

---

## `World/Light/Lod3Shader.ts` (237 LOC)

---

## `World/Light/Lod3ShaderLite.ts` (251 LOC)

**Module-level functions**
- `export function createLod3OpaqueMaterial(opts: Lod3MaterialOptions): ShaderMaterial`
- `export function createLod3TransparentMaterial(opts: Lod3MaterialOptions): ShaderMaterial`

**Types / Interfaces / Enums**
- interface `Lod3MaterialOptions`
- type `EngineContext`
- type `SceneContext`
- type `ShaderMaterial`
- type `Texture2D`

---

## `World/Light/OpaqueShader.ts` (203 LOC)

---

## `World/Light/OpaqueShaderLite.ts` (228 LOC)

**Module-level functions**
- `function buildChunkMaterial(name: string, fragmentSource: string, useNormal: boolean, opts: ChunkMaterialOptions): ShaderMaterial`
- `export function createChunkOpaqueMaterial(opts: ChunkMaterialOptions): ShaderMaterial`
- `export function createChunkTransparentMaterial(opts: ChunkMaterialOptions): ShaderMaterial`

**Types / Interfaces / Enums**
- interface `ChunkMaterialOptions`
- type `EngineContext`
- type `SceneContext`
- type `ShaderMaterial`
- type `Texture2D`

---

## `World/Light/PackedChunkShaderWGSL.ts` (187 LOC)

**Module-level functions**
- `export function buildPackedVertexWGSL(arenaCount: number = 1): string`

---

## `World/Light/SkyShader.ts` (33 LOC)

---

## `World/Light/SkyShaderLite.ts` (56 LOC)

**Module-level functions**
- `export function createSkyMaterial(): ShaderMaterial`

**Types / Interfaces / Enums**
- type `ShaderMaterial`

---

## `World/Light/TransparentShader.ts` (223 LOC)

---

## `World/MeshPipeline/core/AOPipeline.ts` (92 LOC)

**Module-level functions**
- `export function isOccluder(packedBlock: number, shape: BlockShapeInfo): boolean`
- `export function computeAO(blockArr: Uint16Array, faceX: number, faceY: number, faceZ: number, uAxis: number, vAxis: number): number`

---

## `World/MeshPipeline/core/BlockFlags.ts` (124 LOC)

**Module-level functions**
- `export function isGlassBlock(blockId: number): boolean`
- `function canUseDenseCache(packed: number): boolean`
- `export function getCachedBlockId(packed: number): number`
- `function buildEntry(packed: number, id: number): number`
- `export function getCachedFlagsAndId(packed: number): number`
- `export function getFlagsFromCombined(combined: number): number`
- `export function getIdFromCombined(combined: number): number`
- `export function getCachedIsCube(packed: number): boolean`
- `function computeFlags(packed: number, id: number): number`
- `export function getCachedFlags(packed: number): number`

---

## `World/MeshPipeline/core/CustomShapeEmitter.ts` (574 LOC)

**Module-level functions**
- `function parseBlockInto(packed: number, out: ParsedBlock): void`
- `function getFaceBit(axis: number, isBackFace: boolean): number`
- `function isWaterGlassInterface(curr: ParsedBlock, nbr: ParsedBlock): boolean`
- `function isBorderOutwardFace(x: number, y: number, z: number, size: number, axis: number, isBackFace: boolean): boolean`
- `function emitCrossShapeAtBlock(x: number, y: number, z: number, blockId: number, baseLight: number, materialType: MaterialType = MaterialType.Cutout, out: WorkerInternalMeshData): void`
- `function emitCrossDiagonalAtBlock(x: number, y: number, z: number, blockId: number, baseLight: number, materialType: MaterialType = MaterialType.Cutout, out: WorkerInternalMeshData): void`
- `function emitLOD2CrossBillboard(x: number, y: number, z: number, blockId: number, baseLight: number, materialType: MaterialType, out: WorkerInternalMeshData): void`
- `function emitBoxFace(ctx: MeshContext, voxelX: number, voxelY: number, voxelZ: number, blockId: number, packedBlock: number, box: {
		min: [number, number, number];
		max: [number, number, number];
		faceMask: number;
	}, axis: number, isBackFace: boolean, baseLight: number, out: WorkerInternalMeshData): void`

**Types / Interfaces / Enums**
- type `MeshContext`
- type `WorkerInternalMeshData`
- type `ParsedBlock`
- type `FaceDescriptor`

---

## `World/MeshPipeline/core/FaceEmitter.ts` (146 LOC)

**Module-level functions**
- `export function emitQuadFast(out: WorkerInternalMeshData, x: number, y: number, z: number, axis: number, width: number, height: number, blockId: number, backFace: number, light: number, ao: number, faceName: FaceName, materialType: number, flip: number, diagonal: number, rawDim: number): void`
- `export function emitWaterQuad(out: WorkerInternalMeshData, x: number, y: number, z: number, axis: number, width: number, height: number, blockId: number, backFace: number, light: number, ao: number, faceName: FaceName, materialType: number, packedBlock: number): void`

---

## `World/MeshPipeline/core/GreedyPipeline.ts` (103 LOC)

**Module-level functions**
- `function ensureScratchCapacity(area: number)`
- `export function greedyMesh(ctx: MeshContext, extractMask: MaskExtractor, emitFace: FaceEmitterCallback): void`

**Types / Interfaces / Enums**
- type `WritableNumberArray`
- type `MaskExtractor`
- type `FaceEmitterCallback`

---

## `World/MeshPipeline/core/LightPipeline.ts` (35 LOC)

**Module-level functions**
- `export function quantizeNibble(v: number): number`
- `export function quantizeLightForLOD(packed: number, disableAO: boolean): number`
- `export function mergeLight(currLight: number, neighborLight: number, isPartialCurrent: boolean, isPartialNeighbor: boolean): number`
- `export function getPackedLightByte(ctx: MeshContext, x: number, y: number, z: number): number`

---

## `World/MeshPipeline/core/MeshAssembler.ts` (11 LOC)

**Module-level functions**
- `export function mergeMeshData(target: WorkerInternalMeshData, source: WorkerInternalMeshData): void`

---

## `World/MeshPipeline/core/MeshContext.ts` (12 LOC)

**Module-level functions**
- `export function createMeshContext(params: {
	size: number;
	lod: number;
}): Omit<MeshContext,            |            |                   >`

---

## `World/MeshPipeline/core/MeshEmitters.ts` (48 LOC)

**Module-level functions**
- `export function reserveMeshCapacity(out: WorkerInternalMeshData, maxQuads: number): void`
- `export function createEmptyMeshData(): WorkerInternalMeshData`
- `export function buildVoxelMesh(ctx: MeshContext, opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`

---

## `World/MeshPipeline/core/ShapePipeline.ts` (334 LOC)

**Module-level functions**
- `function obtainFaceRect(): FaceRect`
- `function resetFaceRectPool(): void`
- `function canUseDenseCache(packedBlock: number): boolean`
- `export function getMaterialTintBucket(blockId: number): number`
- `export function getMaterialType(blockId: number): MaterialType`
- `export function getMaterialTypeForPackedBlock(packedBlock: number): MaterialType`
- `export function isCrossShapePackedBlock(packedBlock: number): boolean`
- `export function isCrossDiagonalShapePackedBlock(packedBlock: number): boolean`
- `function clamp01(v: number): number`
- `function pushRect(rects: FaceRect[], u0: number, u1: number, v0: number, v1: number): void`
- `function doesRectUnionCoverUnitSquare(rects: FaceRect[]): boolean`
- `function buildRuntimeShapeBoxes(packedBlock: number): readonly ShapeBounds[]`
- `export function getRuntimeShapeBoxes(packedBlock: number): readonly ShapeBounds[]`
- `function computeClosedFaceMaskFromBoxes(boxes: readonly ShapeBounds[]): number`
- `function isFullCubeFromBoxes(shapeBoxCount: number, boxes: readonly ShapeBounds[]): boolean`
- `function buildShapeInfo(packedBlock: number): BlockShapeInfo`
- `export function getShapeInfo(packedBlock: number): BlockShapeInfo`
- `export function isGreedyCompatiblePackedBlock(packedBlock: number): boolean`
- `function buildGreedyCompatible(packedBlock: number): boolean`

**Types / Interfaces / Enums**
- type `ShapeBounds`
- type `FaceRect`

---

## `World/MeshPipeline/core/VoxelFaceEmitterAdapter.ts` (378 LOC)

### export class VoxelFaceEmitterAdapter

**Methods**
- `public emitVoxelFace(axis: number, desc: GreedyFaceDescriptor, opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`
- `private emitCubeFace(out: WorkerInternalMeshData, axis: number, desc: GreedyFaceDescriptor, blockId: number, back: number, light: number, ao: number, faceName: FaceName): void`
- `private emitWaterFace(out: WorkerInternalMeshData, axis: number, desc: GreedyFaceDescriptor, blockId: number, packedBlock: number, back: number, light: number, ao: number, faceName: FaceName): void`
- `private emitCustomShapeFace(out: WorkerInternalMeshData, axis: number, desc: GreedyFaceDescriptor, packedBlock: number, blockId: number, back: number, light: number, ao: number, faceName: FaceName, faceBit: number): void`
- `private emitWaterCustomShapeFace(out: WorkerInternalMeshData, axis: number, desc: GreedyFaceDescriptor, packedBlock: number, blockId: number, back: number, light: number, ao: number, faceName: FaceName, faceBit: number): void`

**Module-level functions**
- `function needsRawDim(blockId: number, width: number, height: number): boolean`
- `function inlineOrigin(axis: number, back: number, desc: GreedyFaceDescriptor)`
- `function emitCubeWrap(a: VoxelFaceEmitterAdapter, out: WorkerInternalMeshData, axis: number, desc: GreedyFaceDescriptor, _packed: number, blockId: number, back: number, light: number, ao: number, faceName: FaceName, _faceBit: number): void`
- `function emitWaterWrap(a: VoxelFaceEmitterAdapter, out: WorkerInternalMeshData, axis: number, desc: GreedyFaceDescriptor, packedBlock: number, blockId: number, back: number, light: number, ao: number, faceName: FaceName, _faceBit: number): void`
- `function emitCustomWrap(a: VoxelFaceEmitterAdapter, out: WorkerInternalMeshData, axis: number, desc: GreedyFaceDescriptor, packedBlock: number, blockId: number, back: number, light: number, ao: number, faceName: FaceName, faceBit: number): void`
- `function emitWaterCustomWrap(a: VoxelFaceEmitterAdapter, out: WorkerInternalMeshData, axis: number, desc: GreedyFaceDescriptor, packedBlock: number, blockId: number, back: number, light: number, ao: number, faceName: FaceName, faceBit: number): void`

**Types / Interfaces / Enums**
- type `GreedyFaceDescriptor`
- type `WorkerInternalMeshData`
- type `EmitFn`

---

## `World/MeshPipeline/core/VoxelGreedyAdapter.ts` (62 LOC)

### export class VoxelGreedyAdapter

**Constructor**
- `constructor(ctx: MeshContext)`

**Properties**
- `private ctx: MeshContext`
- `private maskExtractor: VoxelMaskExtractor`
- `private faceEmitter: VoxelFaceEmitterAdapter`
- `private readonly _extractMask: ( slice: number, maskBuf: WritableNumberArray, lightBuf: WritableNumberArray, ) => void`
- `private readonly _emitFace: (desc: GreedyFaceDescriptor) => void`
- `slice: number,`
- `maskBuf: WritableNumberArray,`
- `lightBuf: WritableNumberArray,`
- `private _currentAxis`

**Methods**
- `public setCtx(ctx: MeshContext): void`
- `public build(opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`

---

## `World/MeshPipeline/core/VoxelMaskExtractor.ts` (455 LOC)

### export class VoxelMaskExtractor

**Constructor**
- `constructor(ctx: MeshContext)`

**Properties**
- `private ctx: MeshContext`
- `private static readonly _bxPerm`
- `private static readonly _byPerm`
- `private static readonly _bzPerm`
- `private static readonly _ndxDx`
- `private static readonly _ndyDy`
- `private static readonly _ndzDz`
- `private static readonly _negNbrDx`
- `private static readonly _negNbrDy`
- `private static readonly _negNbrDz`

**Methods**
- `public setCtx(ctx: MeshContext): void`
- `private getCurrentFaceBit(axis: number): number`
- `private getNeighborFaceBit(axis: number): number`
- `private clearSlice(mask: WritableNumberArray, lightMask: WritableNumberArray, size: number): void`
- `public extractSliceMask(axis: number, slice: number, mask: WritableNumberArray, lightMask: WritableNumberArray): void`

**Module-level functions**
- `function processCell(blockArr: Uint16Array, lightArr: Uint8Array, disableAO: boolean, bx: number, by: number, bz: number, nx: number, ny: number, nz: number, curIdx: number, nbrIdx: number, uAxis: number, vAxis: number, currentFaceBit: number, neighborFaceBit: number, outIndex: number, mask: WritableNumberArray, lightMask: WritableNumberArray): void`

**Types / Interfaces / Enums**
- type `WritableNumberArray`

---

## `World/MeshPipeline/core/VoxelPipeline.ts` (25 LOC)

### export class VoxelPipeline

**Constructor**
- `constructor(ctx: MeshContext)`

**Properties**
- `private ctx: MeshContext`
- `private greedy: VoxelGreedyAdapter`

**Methods**
- `public build(opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`

**Types / Interfaces / Enums**
- interface `VoxelPipelineInput`

---

## `World/MeshPipeline/core/WorkerMeshHelpers.ts` (234 LOC)

**Module-level functions**
- `export function createEmptyWorkerInternalMeshData(): WorkerInternalMeshData`
- `export function toTransferableMeshData(data: WorkerInternalMeshData): MeshData`
- `export function paddedIndex(x: number, y: number, z: number): number`
- `function buildOpaqueClassification(padded: Uint16Array, psVol: number): Uint8Array`
- `export function createMeshContextFromPayload(base: WorkerMeshBaseContext, input: WorkerMeshInput): MeshContext`

**Types / Interfaces / Enums**
- type `WorkerMeshBaseContext`
- type `WorkerMeshInput`
- type `NeighborOffset`

---

## `World/MeshPipeline/types/MeshTypes.ts` (50 LOC)

**Types / Interfaces / Enums**
- interface `MeshContext`
- interface `EmitQuadParams`
- interface `BlockShapeInfo`
- interface `GreedyFaceDescriptor`
- type `WorkerInternalMeshData`

---

## `World/Occlusion/OcclusionCuller.ts` (784 LOC)

**Module-level functions**
- `function initFacePairTable(): void`
- `function resetChunkBfs(chunk: Chunk, queryId: number): void`

**Types / Interfaces / Enums**
- interface `OcclusionStats`

---

## `World/Pathfinding/Pathfinding.ts` (389 LOC)

### class AStarHeap

**Properties**
- `private items: AStarNode[] = []`

**Accessors**
- `get size(): number`

**Methods**
- `clear(): void`
- `push(item: AStarNode): void`
- `pop(): AStarNode | undefined`

**Module-level functions**
- `function hasClearance(x: number, z: number, groundY: number, headroom: number, allowWater: boolean): boolean`
- `function findWaterSurface(x: number, z: number, startY: number, searchUp: number, searchDown: number): SurfaceResult | null`
- `export function findSurface(x: number, z: number, startGroundY: number, stepUp: number, stepDown: number, headroom: number, allowWater = true): SurfaceResult | null`
- `export function findLandSurface(x: number, z: number, startY: number, headroom: number)`
- `export function isLandAt(x: number, z: number, startY: number, headroom: number): boolean`
- `function nodeKey(x: number, z: number, y: number, kind: PathNodeKind): number`
- `function allocNode(x: number, z: number, groundY: number, kind: PathNodeKind, g: number, h: number, parent: AStarNode | null): AStarNode`
- `function releaseUsedNodes(): void`
- `function buildPathInto(outPath: PathWaypoint[], endNode: AStarNode): void`
- `export function findPathInto(outPath: PathWaypoint[], startX: number, startZ: number, startGroundY: number, targetX: number, targetZ: number, headroom: number, maxExpansions = 300, requiredTargetGroundY?: number): boolean`

**Types / Interfaces / Enums**
- interface `PathWaypoint`
- interface `AStarNode`
- interface `SurfaceResult`

---

## `World/SETTINGS_PARAMS.ts` (34 LOC)

---

## `World/Shape/BlockShapes.ts` (225 LOC)

**Module-level functions**
- `function ensureShapeInit(): Promise<void>`
- `export function getShapeDefinitions(): ShapeDefinition[]`
- `export function getShapeByBlockId(): Uint16Array`
- `export function areShapesInitialized(): boolean`
- `export function getCubeShapeIndex(): number`
- `export function isCrossBlockId(blockId: number): boolean`
- `export function isCrossDiagonalBlockId(blockId: number): boolean`

**Types / Interfaces / Enums**
- type `ShapeBox`
- type `ShapeDefinition`
- type `RawShapeBox`
- type `RawShapeDefinition`
- type `RawBlockDefinition`

---

## `World/Shape/BlockShapeTransforms.ts` (276 LOC)

**Module-level functions**
- `function getRelevantStateForShape(blockState: number, shape: {
		rotateY: boolean;
		allowFlipY: boolean;
		usesSliceState: boolean;
	}): number`

**Types / Interfaces / Enums**
- type `ShapeBounds`

---

## `World/Shape/FenceConnect.ts` (105 LOC)

**Module-level functions**
- `export function isFenceBlockId(blockId: number): boolean`
- `export function isFencePackedBlock(packed: number): boolean`
- `export function computeFenceNeighborMask(x: number, y: number, z: number, getBlock: GetBlockFn): number`
- `export function getFenceArmBoxes(mask: number): ShapeBox[]`
- `export function getFenceDynamicShape(mask: number): ShapeDefinition`

**Types / Interfaces / Enums**
- type `ShapeBox`
- type `ShapeDefinition`
- type `GetBlockFn`

---

## `World/Storage/ChunkKey.ts` (33 LOC)

**Module-level functions**
- `function validateAxis(v: number, name: string): void`
- `export function packChunkKey(chunkX: number, chunkY: number, chunkZ: number): bigint`
- `export function unpackChunkKey(key: bigint)`

---

## `World/Storage/MeshSerializer.ts` (115 LOC)

**Module-level functions**
- `function writeU32LE(buf: Uint8Array, off: number, val: number): void`
- `export function serializeMesh(mesh: MeshData | null | undefined): Uint8Array | null`
- `export function deserializeMesh(bytes: Uint8Array): MeshData`
- `export function serializeMeshPair(opaque: MeshData | null | undefined, transparent: MeshData | null | undefined): Uint8Array | null`
- `export function deserializeMeshPair(bytes: Uint8Array, lod: number): DeserializedMeshPair | null`

**Types / Interfaces / Enums**
- type `DeserializedMeshPair`

---

## `World/Storage/opfs.worker.ts` (479 LOC)

**Module-level functions**
- `async function _drainOpQueue(): Promise<void>`
- `function _lruTouch(key: number): void`
- `function _lruEvict(): number | null`
- `function packRegionKey(rx: number, ry: number, rz: number): number`
- `function regionFileName(rx: number, ry: number, rz: number): string`
- `function resolveVoxelLocation(cx: number, cy: number, cz: number): void`
- `function viewOf(data: ArrayBuffer | Uint8Array): Uint8Array`
- `async function compressGzip(data: Uint8Array): Promise<Uint8Array>`
- `async function decompressGzip(data: Uint8Array): Promise<Uint8Array>`
- `function queueFlush(): void`
- `async function _flushOp(): Promise<void>`
- `function _scheduleFlush(): void`
- `function markDirty(): void`
- `function _flushAllRegions(): void`
- `async function _closeRegionFile(rf: RegionFile): Promise<void>`
- `async function ensureMeshStore(): Promise<OpfsChunkStore>`
- `function resetMeshStore(): void`
- `async function ensureRegionsDir(): Promise<FileSystemDirectoryHandle>`
- `async function getRegionFile(rx: number, ry: number, rz: number): Promise<RegionFile>`
- `async function openStores(): Promise<void>`
- `function postResult(id: number, result: unknown): void`
- `function postTransferResult(id: number, result: Uint8Array | null): void`
- `function postError(id: number, message: string): void`

**Types / Interfaces / Enums**
- type `QueuedOp`
- type `LruNode`

---

## `World/Storage/OpfsChunkStore.ts` (366 LOC)

### export class OpfsChunkStore

**Constructor**
- `constructor()`

**Properties**
- `private _fileHandle: FileSystemFileHandle | null = null`
- `private _accessHandle: FileSystemSyncAccessHandle | null = null`
- `private _tableBuffer: ArrayBuffer = new ArrayBuffer(0)`
- `private _tableView: DataView = new DataView(new ArrayBuffer(0))`
- `private _size: number = 0`
- `private _capacity: number = 0`
- `private _dataSize: number = 0`
- `private _liveDataSize: number = 0`
- `private _dirty`
- `private readonly _scratch: ArrayBuffer`
- `private readonly _scratchDv: DataView`
- `private readonly _scratchU8: Uint8Array`
- `private readonly _readSlab: Uint8Array`
- `private readonly _headerBuf: Uint8Array`
- `private _fileSize`
- `private _hitCount`
- `private _missCount`
- `private _evictionCount`
- `slotCount: this._size,`
- `usedBytes: this._dataSize,`
- `totalBytes: this._fileSize,`
- `capacity: this._capacity,`
- `hitCount: this._hitCount,`
- `missCount: this._missCount,`
- `evictionCount: this._evictionCount,`
- `private static readonly INITIAL_CAPACITY`

**Accessors**
- `private get _dataStartOffset(): number`

**Methods**
- `async open(name: string): Promise<void>`
- `close(): void`
- `write(keyHi: number, keyLo: number, lod: number, data: Uint8Array): void`
- `read(keyHi: number, keyLo: number, lod: number): Uint8Array | null`
- `remove(keyHi: number, keyLo: number, lod: number): boolean`
- `flush(): void`
- `getStats()`
- `private _init(): void`
- `private _load(): void`
- `private _findSlot(keyHi: number, keyLo: number, lod: number): number`
- `private _grow(): void`
- `private _writeHeader(): void`
- `compactIfNeeded(): void`
- `compact(): void`

**Types / Interfaces / Enums**
- type `LiveEntry`

---

## `World/Storage/OpfsClient.ts` (217 LOC)

### export class OpfsClient

**Constructor**
- `constructor()`

**Properties**
- `private _worker: Worker`
- `private _opResolves: (((v: any) => void) | null)[]`
- `private _opRejects: (((e: any) => void) | null)[]`
- `private _nextId`
- `private _ready: Promise<void>`
- `type: ,`
- `chunkX: decode(key),`
- `chunkY: decode(key >> AXIS_BITS),`
- `chunkZ: decode(key >> (AXIS_BITS * 2n)),`
- `slotCount: number`
- `usedBytes: number`
- `totalBytes: number`
- `capacity: number`
- `hitCount: number`
- `missCount: number`
- `evictionCount: number`

**Methods**
- `resolve()`
- `async ready(): Promise<void>`
- `private _onMessage(msg: { id: number; error?: string; result?: any }): void`
- `private _packKey(key: bigint)`
- `private _unpackKey(key: bigint)`
- `async readMesh(key: bigint, lod: number): Promise<Uint8Array | null>`
- `async writeMesh(key: bigint, lod: number, data: Uint8Array): Promise<void>`
- `async removeMesh(key: bigint, lod: number): Promise<boolean>`
- `async readVoxel(key: bigint, lod: number): Promise<Uint8Array | null>`
- `async writeVoxel(key: bigint, lod: number, data: Uint8Array): Promise<void>`
- `async removeVoxel(key: bigint, lod: number): Promise<void>`
- `async flush(): Promise<void>`
- `async getStats(): Promise<`
- `_resetWire(OpfsMsg.GetStats)`
- `static async create(): Promise<OpfsClient>`
- `async close(): Promise<void>`

**Module-level functions**
- `function _resetWire(type: OpfsMsg): void`
- `function transferableBytes(data: Uint8Array): Uint8Array`

**Types / Interfaces / Enums**
- interface `WireMsg`

---

## `World/Storage/OpfsMessageTypes.ts` (13 LOC)

---

## `World/Storage/RegionFile.ts` (383 LOC)

### export class RegionFile

**Module-level functions**
- `function slotIndex(lx: number, ly: number, lz: number, isEntity: boolean): number`

---

## `World/Storage/VoxelSerializer.ts` (174 LOC)

**Module-level functions**
- `export function serializeVoxelData(blocks: Uint8Array | Uint16Array | null, palette: Uint16Array | null | undefined, isUniform: boolean | undefined, uniformBlockId: number | undefined, lightArray: Uint8Array | null | undefined, compressed: boolean | undefined): Uint8Array`
- `export function deserializeVoxelData(data: Uint8Array): SavedChunkData`
- `export function serializeEntities(entities: SavedChunkEntityData[]): Uint8Array`
- `export function deserializeEntities(data: Uint8Array): SavedChunkEntityData[]`

**Types / Interfaces / Enums**
- type `SavedChunkData`
- type `SavedChunkEntityData`

---

## `World/Texture/BlockTextures.ts` (123 LOC)

**Module-level functions**
- `function buildBlockTextures(): (BlockTextureDef | null)[]`
- `function createTileDef(col: number, row: number): BlockTextureDef`
- `function getMaxBlockTypeId(): number`
- `function getAtlasTileForBlockId(id: number): [number, number] | null`
- `export function getVirtualBlockId(sourceBlockId: number, shape: string): number | null`
- `function getVirtualBlockIdSync(sourceBlockId: number, shape: string): number`
- `export function setBlockAtlasTile(blockId: number, col: number, row: number): void`
- `export function getAtlasTile(blockId: number | null): [number, number] | null`

**Types / Interfaces / Enums**
- type `BlockTextureDef`
- type `MasonShape`

---

## `World/Texture/BlockType.ts` (125 LOC)

**Module-level functions**
- `export function isPassThroughBlock(blockId: number): boolean`
- `export function isCollidableBlock(blockId: number): boolean`
- `export function getMovementCost(blockId: number): number`
- `export function getWaterLevel(blockId: number, state: number): number`
- `export function isWaterSource(blockId: number, state: number): boolean`

**Types / Interfaces / Enums**
- enum `BlockType`

---

## `World/Texture/FaceName.ts` (23 LOC)

**Module-level functions**
- `export function getFaceName(axis: number, isBackFace: boolean): FaceName`

---

## `World/Texture/MaterialFactory.ts` (132 LOC)

**Module-level functions**
- `function createTexture(_scene: SceneContext, _path: string, uvScale: number): RawTexture`
- `export function createMaterialByFolder(scene: SceneContext, folder: string, uvScale = 1, extension =, diff = true, nor = false, ao = false, spec = false): RawMaterial`
- `function buildMaterial(scene: SceneContext, mat: RawMaterial, directory: string, baseName: string, resolution: string, extension: string, uvScale: number, diff: boolean, nor: boolean, ao: boolean, spec: boolean, cacheKey: string): RawMaterial`
- `export function getTexturePathFromFolder(folder: string, type =, extension =): string | null`
- `export function disposeAll(): void`

**Types / Interfaces / Enums**
- interface `RawMaterial`
- interface `RawTexture`

---

## `World/Texture/TextureAtlasFactory.ts` (29 LOC)

**Module-level functions**
- `export function getDiffuse(): Texture2D | null`
- `export function setDiffuse(texture: Texture2D)`
- `export function getNormal(): Texture2D | null`
- `export function setNormal(texture: Texture2D)`
- `export function getDiffuseTexture2D(): Texture2D | null`
- `export function setDiffuseTexture2D(texture: Texture2D)`

**Types / Interfaces / Enums**
- type `TileUV`

---

## `World/Texture/TextureCache.ts` (47 LOC)

**Module-level functions**
- `function getDB(): Promise<IDBDatabase>`
- `async export function getTextureCache(url: string): Promise<Blob | undefined>`
- `async export function putTextureCache(url: string, blob: Blob): Promise<void>`

---

## `World/Texture/TextureDefinitions.ts` (88 LOC)

**Module-level functions**
- `async function loadBlockDefinitions(): Promise<TextureDefinition[]>`
- `function normalizeBlockId(id: number | string): BlockType | null`
- `export function getBlockBreakTime(id: number, toolItemId?: number): number`
- `export function getBlockInfo(id: number): TextureDefinition | undefined`

**Types / Interfaces / Enums**
- interface `TextureDefinition`
- type `RawBlockDefinition`

---

## `World/WorldStorage.ts` (408 LOC)

**Types / Interfaces / Enums**
- type `SavedChunkData`
- type `SavedChunkEntityData`
- type `LoadChunkOptions`

---
