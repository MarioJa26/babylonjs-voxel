# Project Footprint

Generated: 2026-04-03T13:13:23.660Z

> **Summary:** 92 classes · 1603 members · 26 module-level functions

---

## `Entities/AdvancedBoat.ts`

### export class AdvancedBoat implements IUsable

**Constructor**
- `constructor(scene: Scene, player: Player, waterLevel: number, position?: Vector3)`

**Properties**
- `#collisionHalfExtents: unknown`
- `#boat: Mesh`
- `#mount: Mount`
- `#buoyancyPoints: Vector3[]`
- `#baseBuoyancyForce: unknown`
- `#mass: unknown`
- `#gravity: unknown`
- `#collisionStepSize: unknown`
- `#collisionEpsilon: unknown`
- `#buoyancyTorqueScale: unknown`
- `#lockRoll: unknown`
- `#lockPitch: unknown`
- `#linearVelocity: unknown`
- `#angularVelocity: unknown`
- `#voxelCollider: VoxelAabbCollider`
- `static #boatControls: PaddleBoatControls`
- `#submergedPoints: unknown`

**Accessors**
- `public get boatMesh(): Mesh`
- `public get boatPosition(): Vector3`
- `public get mount(): Mount`
- `public get submergedPoints(): number`

**Methods**
- `private createBoat(scene: Scene, position: Vector3 | undefined, waterLevel: number): void`
- `private setupBuoyancyPoints(): void`
- `private setupAdvancedPhysics(scene: Scene): void`
- `private applyForceAtPoint(force: Vector3, worldPoint: Vector3, dt: number): void`
- `private integrateRotation(dt: number): void`
- `private moveAxis(axis: Axis, delta: number): void`
- `private getWaterSubmersionAtPoint(worldPoint: Vector3): number`
- `public applyImpulse(impulse: Vector3, worldPoint: Vector3): void`
- `public applyAngularImpulse(impulse: Vector3): void`
- `public getBoatTopY(): Vector3`
- `use(player: Player): void`

---

## `Entities/BouyantObject.ts`

### export class BouyantObject

**Constructor**
- `constructor(scene: Scene, mesh: Mesh, waterMaterial: WaterMaterial, waterHeight: number)`

**Properties**
- `public scene: Scene`
- `public mesh: Mesh`
- `public waterMaterial: WaterMaterial`
- `public waterHeight: number`
- `private verticalVelocity: unknown`

---

## `Entities/CustomBoat.ts`

### export class CustomBoat implements IUsable

**Constructor**
- `constructor(scene: Scene, player: Player, waterLevel: number, position?: Vector3, options?: CustomBoatOptions)`

**Properties**
- `static readonly CHUNK_ENTITY_TYPE: unknown`
- `static #chunkReloadContext: | { scene: Scene; player: Player; waterLevel: number }
    | null`
- `static #chunkLoaderRegistered: unknown`
- `#cfg: unknown`
- `#collisionHalfExtents: unknown`
- `#boat: Mesh`
- `#voxelCollider: VoxelObbCollider`
- `#mount: Mount`
- `static #boatControls: CustomBoatControls`
- `#customVisualRoot?: Mesh`
- `#customVisualLocalYaw: unknown`
- `#skipDefaultModel: unknown`
- `#boatChunk?: BoatChunk`
- `#currentYaw: unknown`
- `#linearVelocity: unknown`
- `#angularVelocity: unknown`
- `#angularResponseScale: unknown`
- `#buoyancyPoints: Vector3[]`
- `#submergedPoints: unknown`
- `#beforeRenderObs?: Observer<Scene>`
- `#chunkBindingHandle?: symbol`
- `#isDisposed: unknown`
- `#tmpWorldPoint: unknown`
- `#tmpTorque: unknown`
- `#tmpLever: unknown`

**Accessors**
- `public get boatMesh(): Mesh`
- `public get boatPosition(): Vector3`
- `public get mount(): Mount`
- `public get submergedPoints(): number`
- `public get currentYaw(): number`

**Methods**
- `public static configureChunkReloadContext(scene: Scene, player: Player, waterLevel: number): void`
- `#createHull(scene: Scene, position: Vector3 | undefined, waterLevel: number): Mesh`
- `async #loadDefaultModel(scene: Scene): Promise<void>`
- `#attachCustomVisual(visual: Mesh): void`
- `#applyCustomVisualMetadata(root: Mesh): void`
- `#buildBuoyancyPoints(): void`
- `#tick(scene: Scene): void`
- `#applyForceAtPoint(fx: number, fy: number, fz: number, worldPoint: Vector3, dt: number): void`
- `#integrateRotation(dt: number): void`
- `#moveAxis(axis: Axis, delta: number): void`
- `#getWaterSubmersionAtPoint(worldPoint: Vector3): number`
- `public applyImpulse(impulse: Vector3, point: Vector3): void`
- `public applyAngularImpulse(impulse: Vector3): void`
- `public getBoatTopY(): Vector3`
- `#createSerializedPayload(): { type: string; payload: CustomBoatSerializedPayload }`
- `public use(player: Player): void`
- `public dispose(scene: Scene): void`

**Types / Interfaces / Enums**
- type `CustomBoatOptions`
- type `SerializedBoatChunk`
- type `CustomBoatSerializedPayload`

---

## `Entities/MetaDataContainer.ts`

### export class MetadataContainer

**Properties**
- `private entries: unknown`

**Methods**
- `add(type: string, data: T): void`
- `set(type: string, data: T): void`
- `get(type: string): T | undefined`
- `has(type: string): boolean`
- `delete(type: string): boolean`
- `getAll(): { type: string; data: any }[]`

---

## `Entities/Mount.ts`

### export class Mount implements IMountable

**Constructor**
- `constructor(vehicle: TransformNode, keyBoardControls: IControls<unknown>, options: MountOptions = {})`

**Properties**
- `public user: Player | null`
- `public vehicle: TransformNode`
- `#keyBoardControls: IControls<unknown>`
- `#mountOffset: Vector3`
- `#mountRotationOffset: Quaternion`
- `#physicsDisabled: unknown`

**Methods**
- `isMounted(): boolean`
- `mount(user: any): boolean`
- `dismount(): boolean`
- `getMountedUser(): Player | null`
- `getKeyBoardControls(): IControls<any>`
- `setMountOffset(offset: Vector3): void`
- `setMountRotationOffset(rotationOffset: Quaternion): void`
- `update(): void`
- `#mountVehicle(player: Player): boolean`
- `private updateMountedPosition(): void`
- `private disablePlayerPhysics(player: IPlayerBody): void`
- `private enablePlayerPhysics(playerVehicle: IPlayerBody): void`

---

## `Entities/MountOptions.ts`

**Types / Interfaces / Enums**
- interface `MountOptions`

---

## `Generation/Biome/Biomes.ts`

**Module-level functions**
- `export function getBiomeFor(temperature: number, humidity: number, continentalness: number, river: number, terrainShapedHeight: number): Biome`

---

## `Generation/Biome/BiomeTypes.ts`

**Types / Interfaces / Enums**
- interface `Biome`
- type `TreeDefinition`

---

## `Generation/Biome/TreeDefinition.ts`

**Module-level functions**
- `export function generateSlinkyTree(worldX: number, worldY: number, worldZ: number, placeBlock: (
    x: number,
    y: number,
    z: number,
    blockId: number,
    overwrite?: boolean,
  ) => void, seedAsInt: number, woodId: number, leavesId: number, baseHeight: number, heightVariance: number): void`
- `export function generateBigTopBentOak(worldX: number, worldY: number, worldZ: number, placeBlock: (
    x: number,
    y: number,
    z: number,
    blockId: number,
    overwrite?: boolean,
  ) => void, seedAsInt: number, woodId: number, leavesId: number, baseHeight: number, heightVariance: number): void`

---

## `Generation/DistanTerrain/DistantTerrainGenerator.ts`

### export class DistantTerrainGenerator

**Properties**
- `private static readonly DEFAULT_TILE_X: unknown`
- `private static readonly DEFAULT_TILE_Y: unknown`
- `private static readonly INSIDE_CLIP_Y: unknown`

**Methods**
- `public static generate(centerChunkX: number, centerChunkZ: number, radius: number, renderDistance: number, gridStep: number, oldData?: {
      positions: Int16Array;
      normals: Int8Array;
      surfaceTiles: Uint8Array;
    }, oldCenterChunkX?: number, oldCenterChunkZ?: number): { positions: Int16Array<ArrayBuffer>; normals: Int8Array<ArrayBuffer>; surfaceTiles: Uint8Array<ArrayBuffer>; }`
- `private static getTopTileForBlock(blockId: number): [number, number]`

---

## `Generation/DistanTerrain/DistantTerrian.ts`

### export class DistantTerrain

**Constructor**
- `constructor()`

**Properties**
- `private mesh: Mesh`
- `private waterMesh: Mesh`
- `private material: ShaderMaterial`
- `private waterMaterial: ShaderMaterial`
- `private diffuseAtlasTexture: Texture | null`
- `private static readonly USE_LA_TILE_TEXTURE: unknown`
- `#surfaceTileLookupTexture: RawTexture`
- `#surfaceTileLookupData: Uint8Array`
- `#radius: number`
- `#gridStep: unknown`
- `#gridResolution: number`
- `#gridOrigin: unknown`
- `#positionVB?: VertexBuffer`
- `#normalVB?: VertexBuffer`
- `#lastPositions: Int16Array | null`
- `#lastNormals: Int8Array | null`
- `#lastSurfaceTiles: Uint8Array | null`
- `#lastCenterChunkX: number | null`
- `#lastCenterChunkZ: number | null`

**Methods**
- `private createEmptyGridMesh(name: string, scene: Scene): Mesh`
- `private bindDiffuseTexture(): void`
- `private bindCommonUniforms(effect: Effect, scene: Scene): void`
- `public update(centerChunkX: number, centerChunkZ: number): void`
- `private applyTerrainData(positions: Int16Array, normals: Int8Array, surfaceTiles: Uint8Array, centerChunkX: number, centerChunkZ: number): void`

---

## `Generation/LightGenerator.ts`

### export class LightGenerator

**Constructor**
- `constructor(params: GenerationParamsType)`

**Properties**
- `private static chunkSize: number`
- `private static chunkSizeSq: number`
- `private lightQueue: Uint16Array`
- `private static queueCapacity: number`
- `private static queueMask: number`
- `private static readonly DENSITY_INFLUENCE_RANGE: unknown`
- `private static readonly WATER_BLOCK_ID: unknown`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, _biome: Biome, blocks: Uint8Array, light: Uint8Array, topSunlightMask?: Uint8Array): void`
- `private tryPropagate(nx: number, ny: number, nz: number, targetSky: number, targetBlock: number, blocks: Uint8Array, light: Uint8Array, tail: number, CHUNK_SIZE: number, CHUNK_SIZE_SQ: number): number`
- `private static isTransparentBlock(blockId: number): boolean`
- `private static isWaterBlock(blockId: number): boolean`
- `private columnReceivesDirectSun(worldX: number, worldZ: number, topWorldY: number): boolean`

**Module-level functions**
- `function nextPowerOfTwo(n: number): number`

---

## `Generation/NoiseAndParameters/FastNoise/FastNoiseFactory.ts`

**Module-level functions**
- `export function createFastNoise(seed: number, fractalType?: FractalType, frequency?: number): FastNoiseLite`
- `export function createFastNoise(options: FastNoiseOptions): FastNoiseLite`
- `export function createFastNoise(seedOrOptions: number | FastNoiseOptions, fractalType?: FractalType, frequency?: number): FastNoiseLite`
- `export function createFastNoise2D(seed: number, fractalType?: FractalType, frequency?: number): (x: number, z: number) => number`
- `export function createFastNoise2D(options: FastNoiseOptions): (x: number, z: number) => number`
- `export function createFastNoise2D(seedOrOptions: number | FastNoiseOptions, fractalType?: FractalType, frequency?: number): (x: number, z: number) => number`
- `export function createFastNoise3D(options: FastNoiseOptions): (x: number, y: number, z: number) => number`
- `export function createFastNoise3D(seedOrOptions: number | FastNoiseOptions, fractalType?: FractalType, frequency?: number): (x: number, y: number, z: number) => number`

**Types / Interfaces / Enums**
- interface `FastNoiseOptions`

---

## `Generation/NoiseAndParameters/FastNoise/FastNoiseLite.ts`

### export class FastNoiseLite

**Constructor**
- `constructor(seed?: number)`

**Properties**
- `static NoiseType: unknown`
- `static RotationType3D: unknown`
- `static FractalType: unknown`
- `static CellularDistanceFunction: unknown`
- `static CellularReturnType: unknown`
- `static DomainWarpType: unknown`
- `static TransformType3D: unknown`
- `private _Seed: unknown`
- `private _Frequency: unknown`
- `private _NoiseType: unknown`
- `private _RotationType3D: unknown`
- `private _TransformType3D: unknown`
- `private _DomainWarpAmp: unknown`
- `private _FractalType: unknown`
- `private _Octaves: unknown`
- `private _Lacunarity: unknown`
- `private _Gain: unknown`
- `private _WeightedStrength: unknown`
- `private _PingPongStrength: unknown`
- `private _FractalBounding: unknown`
- `private SQRT3: unknown`
- `private _CellularDistanceFunction: unknown`
- `private _CellularReturnType: unknown`
- `private _CellularJitterModifier: unknown`
- `private _DomainWarpType: unknown`
- `private _WarpTransformType3D: unknown`
- `private _Gradients2D: unknown`
- `private _RandVecs2D: unknown`
- `private _Gradients3D: unknown`
- `private _RandVecs3D: unknown`
- `private _PrimeX: unknown`
- `private _PrimeY: unknown`
- `private _PrimeZ: unknown`

**Methods**
- `SetSeed(seed: number): void`
- `SetFrequency(frequency: number): void`
- `SetNoiseType(noiseType: NoiseType): void`
- `SetRotationType3D(rotationType3D: RotationType3D): void`
- `SetFractalType(fractalType: FractalType): void`
- `SetFractalOctaves(octaves: number): void`
- `SetFractalLacunarity(lacunarity: number): void`
- `SetFractalGain(gain: number): void`
- `SetFractalWeightedStrength(weightedStrength: number): void`
- `SetFractalPingPongStrength(pingPongStrength: number): void`
- `SetCellularDistanceFunction(cellularDistanceFunction: CellularDistanceFunction): void`
- `SetCellularReturnType(cellularReturnType: CellularReturnType): void`
- `SetCellularJitter(cellularJitter: number): void`
- `SetDomainWarpType(domainWarpType: DomainWarpType): void`
- `SetDomainWarpAmp(domainWarpAmp: number): void`
- `GetNoise(x: number, y: number, z?: number): number`
- `DomainWarp(coord: Vector2 | Vector3): void`
- `private static _Lerp(a: number, b: number, t: number): number`
- `private static _InterpHermite(t: number): number`
- `private static _InterpQuintic(t: number): number`
- `private static _CubicLerp(a: number, b: number, c: number, d: number, t: number): number`
- `private static _PingPong(t: number): number`
- `private _CalculateFractalBounding(): void`
- `private _HashR2(seed: number, xPrimed: number, yPrimed: number): number`
- `private _HashR3(seed: number, xPrimed: number, yPrimed: number, zPrimed: number): number`
- `private _ValCoordR2(seed: number, xPrimed: number, yPrimed: number): number`
- `private _ValCoordR3(seed: number, xPrimed: number, yPrimed: number, zPrimed: number): number`
- `private _GradCoordR2(seed: number, xPrimed: number, yPrimed: number, xd: number, yd: number): number`
- `private _GradCoordR3(seed: number, xPrimed: number, yPrimed: number, zPrimed: number, xd: number, yd: number, zd: number): number`
- `private _GenNoiseSingleR2(seed: number, x: number, y: number): number`
- `private _GenNoiseSingleR3(seed: number, x: number, y: number, z: number): number`
- `private _UpdateTransformType3D(): void`
- `private _UpdateWarpTransformType3D(): void`
- `private _GenFractalFBmR2(x: number, y: number): number`
- `private _GenFractalFBmR3(x: number, y: number, z: number): number`
- `private _GenFractalRidgedR2(x: number, y: number): number`
- `private _GenFractalRidgedR3(x: number, y: number, z: number): number`
- `private _GenFractalPingPongR2(x: number, y: number): number`
- `private _GenFractalPingPongR3(x: number, y: number, z: number): number`
- `private _SingleOpenSimplex2R2(seed: number, x: number, y: number): number`
- `private _SingleOpenSimplex2R3(seed: number, x: number, y: number, z: number): number`
- `private _SingleOpenSimplex2SR2(seed: number, x: number, y: number): number`
- `private _SingleOpenSimplex2SR3(seed: number, x: number, y: number, z: number): number`
- `private _SingleCellularR2(seed: number, x: number, y: number): number`
- `private _SingleCellularR3(seed: number, x: number, y: number, z: number): number`
- `private _SinglePerlinR2(seed: number, x: number, y: number): number`
- `private _SinglePerlinR3(seed: number, x: number, y: number, z: number): number`
- `private _SingleValueCubicR2(seed: number, x: number, y: number): number`
- `private _SingleValueCubicR3(seed: number, x: number, y: number, z: number): number`
- `private _SingleValueR2(seed: number, x: number, y: number): number`
- `private _SingleValueR3(seed: number, x: number, y: number, z: number): number`
- `private _DoSingleDomainWarp(seed: number, amp: number, freq: number, coord: Vector2 | Vector3, x: number, y: number, z?: number): void`
- `private _DomainWarpSingle(coord: Vector2 | Vector3): void`
- `private _DomainWarpFractalProgressive(coord: Vector2 | Vector3): void`
- `private _DomainWarpFractalIndependent(coord: Vector2 | Vector3): void`
- `private _SingleDomainWarpBasicGrid(seed: number, warpAmp: number, frequency: number, coord: Vector2 | Vector3, x: number, y: number, z?: number): void`
- `private _SingleDomainWarpOpenSimplex2Gradient(seed: number, warpAmp: number, frequency: number, coord: Vector2 | Vector3, outGradOnly: boolean, x: number, y: number, z?: number): void`

**Types / Interfaces / Enums**
- interface `Vector2`
- interface `Vector3`
- enum `NoiseType`
- enum `RotationType3D`
- enum `FractalType`
- enum `CellularDistanceFunction`
- enum `CellularReturnType`
- enum `DomainWarpType`
- enum `TransformType3D`

---

## `Generation/NoiseAndParameters/GenerationParams.ts`

**Types / Interfaces / Enums**
- type `GenerationParamsType`

---

## `Generation/NoiseAndParameters/NoiseSampler.ts`

### export class NoiseSampler

**Constructor**
- `constructor(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number, sampleRate: number, scale: number, xzFactor: number, noiseFunction: ReturnType<typeof createNoise3D>)`

**Properties**
- `private noiseSamples: Float32Array`
- `private sampleRate: number`
- `private pointsPerDim: number`

**Methods**
- `public get(localX: number, localY: number, localZ: number): number`

---

## `Generation/NoiseAndParameters/Spline.ts`

### export class Spline

**Constructor**
- `constructor(points: SplinePoint[])`

**Properties**
- `private points: SplinePoint[]`

**Methods**
- `public getValue(t: number): number`

**Types / Interfaces / Enums**
- interface `SplinePoint`

---

## `Generation/NoiseAndParameters/Squirrel13.ts`

### export class Squirrel3

**Properties**
- `private static readonly NOISE1: unknown`
- `private static readonly NOISE2: unknown`
- `private static readonly NOISE3: unknown`
- `private static HASH: unknown`

**Methods**
- `public static get(position: number, seed: number): number`
- `public static getPRNG(position: number): number`

---

## `Generation/RiverGeneration.ts`

### export class RiverGenerator

**Constructor**
- `constructor(params: GenerationParamsType)`

**Properties**
- `private params: GenerationParamsType`
- `private readonly TUNNEL_RADIUS: unknown`
- `private readonly TUNNEL_CENTER_Y: number`
- `private static riverNoise: (x: number, z: number) => number`
- `private static wallNoise: (x: number, y: number, z: number) => number`
- `private riverSpline: Spline`
- `private riverDepthSpline: Spline`

**Methods**
- `public isRiver(worldX: number, worldY: number, worldZ: number, riverNoise: number): boolean`
- `public getRiverNoise(x: number, z: number): number`
- `public getRiverDepth(riverValue: number): number`

---

## `Generation/Structure/DungeonFeature.ts`

### export class DungeonFeature implements IWorldFeature

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean,
    ) => void, seed: number, chunkSize: number, getTerrainHeight: (x: number, z: number, biome: Biome) => number, generatingChunkX: number, generatingChunkZ: number): void`
- `private carveCorridor(x1: number, x2: number, z1: number, z2: number, yBase: number, placeBlock: any, floorBlock: number, minX: number, maxX: number, minZ: number, maxZ: number): void`

---

## `Generation/Structure/IWorldFeature.ts`

**Types / Interfaces / Enums**
- interface `IWorldFeature`

---

## `Generation/Structure/LavaPoolFeature.ts`

### export class LavaPoolFeature implements IWorldFeature

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean,
    ) => void, seed: number, chunkSize: number, getTerrainHeight: (x: number, z: number, biome: Biome) => number, generatingChunkX: number, generatingChunkZ: number): void`
- `private generateLavaPool(chunkX: number, chunkY: number, chunkZ: number, poolCenterX: number, poolCenterY: number, poolCenterZ: number, placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean,
    ) => void, seed: number): void`

---

## `Generation/Structure/Structure.ts`

### export class Structure

**Constructor**
- `constructor(data: StructureData)`

**Properties**
- `public readonly width: number`
- `public readonly height: number`
- `public readonly depth: number`
- `private blocks: Uint8Array`

**Methods**
- `public place(originX: number, originY: number, originZ: number, placeBlock: PlaceBlockFunction): void`

**Types / Interfaces / Enums**
- interface `StructureData`
- type `PlaceBlockFunction`

---

## `Generation/Structure/StructureFeature.ts`

### export class StructureSpawnerFeature implements IWorldFeature

**Constructor**
- `constructor()`

**Properties**
- `private static structures: Map<string, Structure>`

**Methods**
- `private loadStructures(): void`
- `public generate(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean,
    ) => void, seed: number, chunkSize: number, getTerrainHeight: (x: number, z: number, biome: Biome) => number, generatingChunkX: number, generatingChunkZ: number): void`

---

## `Generation/Structure/TowerFeature.ts`

### export class TowerFeature implements IWorldFeature

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean,
    ) => void, seed: number, chunkSize: number, getTerrainHeight: (x: number, z: number, biome: Biome) => number, generatingChunkX: number, generatingChunkZ: number): void`
- `private generateCylinderTower(chunkX: number, chunkY: number, chunkZ: number, towerCenterX: number, towerCenterZ: number, towerRadius: number, groundHeight: number, biome: Biome, placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean,
    ) => void, chunkSize: number, seed: number, getTerrainHeight: (x: number, z: number, biome: Biome) => number): void`
- `private generateUndergroundCylinderTower(chunkX: number, chunkY: number, chunkZ: number, towerCenterX: number, towerCenterZ: number, towerRadius: number, groundHeight: number, placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean,
    ) => void, chunkSize: number): void`
- `private findMinGroundHeightForTower(towerCenterX: number, towerCenterZ: number, towerRadius: number, biome: Biome, getTerrainHeight: (x: number, z: number, biome: Biome) => number): number`

---

## `Generation/SurfaceGenerator.ts`

### export class SurfaceGenerator

**Constructor**
- `constructor(params: GenerationParamsType, treeNoise: (x: number, z: number) => number, densityNoise: (x: number, y: number, z: number) => number, seedAsInt: number)`

**Properties**
- `private params: GenerationParamsType`
- `private static treeNoise: (x: number, z: number) => number`
- `private static densityNoise: (x: number, y: number, z: number) => number`
- `private static readonly DENSITY_BASE_AMPLITUDE: unknown`
- `private static readonly DENSITY_OVERHANG_AMPLITUDE: unknown`
- `private static readonly DENSITY_CLIFF_AMPLITUDE: unknown`
- `private static readonly DENSITY_INFLUENCE_RANGE: unknown`
- `private static readonly DENSITY_VERTICAL_SCAN_RANGE: unknown`
- `private static readonly SUBSURFACE_LAYER_DEPTH: unknown`
- `private static readonly SURFACE_RESET_AIR_GAP: unknown`
- `private static readonly NO_SURFACE_Y: unknown`
- `private static seedAsInt: number`
- `private chunk_size: number`
- `private riverGenerator: RiverGenerator`
- `private features: IWorldFeature[]`
- `private readonly getFinalTerrainHeightBound: (
    worldX: number,
    worldZ: number,
  ) => number`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow?: boolean,
    ) => void): SurfaceGenerationResult`
- `private generateTerrain(chunkX: number, chunkY: number, chunkZ: number, currentBiome: Biome, placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean,
    ) => void): SurfaceGenerationResult`
- `private generateFlora(chunkX: number, chunkY: number, chunkZ: number, _biome: Biome, placeBlock: (x: number, y: number, z: number, id: number) => void, topSurfaceYMap: Int16Array): void`
- `private generateStructures(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean,
    ) => void): void`
- `private getFinalTerrainHeight(worldX: number, worldZ: number): number`
- `private isBeachLocation(worldX: number, worldZ: number, terrainHeight: number): boolean`
- `private isNearWater(x: number, z: number): boolean`
- `private getDensity(x: number, y: number, z: number, baseHeight: number, yFreq: number): number`
- `private findTopSurfaceY(worldX: number, worldZ: number, baseHeight: number, yFreq: number): number`

**Types / Interfaces / Enums**
- type `SurfaceGenerationResult`

---

## `Generation/TerrainHeightMap.ts`

### export class TerrainHeightMap

**Properties**
- `private static params: GenerationParamsType`
- `private static riverGenerator: RiverGenerator`
- `private static temperatureNoise: (x: number, z: number) => number`
- `private static humidityNoise: (x: number, z: number) => number`
- `private static continentalnessNoise: (x: number, z: number) => number`
- `private static erosionNoise: (x: number, z: number) => number`
- `private static peaksAndValleysNoise: (x: number, z: number) => number`
- `private static continentalnessSpline: Spline`
- `private static erosionSpline: Spline`
- `private static peaksAndValleysSpline: Spline`
- `private static sampleCache: unknown`
- `private static readonly MAX_CACHE_SIZE: unknown`

**Methods**
- `private static encodeKey(x: number, z: number): number`
- `public static getTerrainSample(worldX: number, worldZ: number): TerrainSample`
- `public static getBiome(x: number, z: number): Biome`
- `public static getFinalTerrainHeight(worldX: number, worldZ: number): number`
- `public static getCachedRiverNoise(worldX: number, worldZ: number): number`
- `private static computeDetail(x: number, z: number, baseHeight: number, riverAbs: number): number`
- `public static getOctaveNoise(x: number, z: number): number`

**Types / Interfaces / Enums**
- type `TerrainSample`

---

## `Generation/UndergroundGenerator.ts`

### export class UndergroundGenerator

**Constructor**
- `constructor(params: GenerationParamsType, caveNoise: ReturnType<typeof createNoise3D>)`

**Properties**
- `private params: GenerationParamsType`
- `private caveNoise: (x: number, y: number, z: number) => number`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow?: boolean,
    ) => void): void`

---

## `Generation/WorldGenerator.ts`

### export class WorldGenerator

**Constructor**
- `constructor(params: GenerationParamsType)`

**Properties**
- `private params: GenerationParamsType`
- `private prng: ReturnType<typeof Alea>`
- `private seedAsInt: number`
- `private chunkSizeSq: number`
- `private chunk_size: number`
- `private surfaceGenerator: SurfaceGenerator`
- `private undergroundGenerator: UndergroundGenerator`
- `private lightGenerator: LightGenerator`

**Methods**
- `private createBuffer(size: number): Uint8Array`
- `public generateChunkData(chunkX: number, chunkY: number, chunkZ: number): { blocks: Uint8Array<ArrayBufferLike>; light: Uint8Array<ArrayBufferLike>; }`
- `#getBiome(x: number, z: number): Biome`

---

## `Inferface/IControls.ts`

**Types / Interfaces / Enums**
- interface `IControls`

---

## `Inferface/IMountable.ts`

**Types / Interfaces / Enums**
- interface `IMountable`

---

## `Inferface/IUsable.ts`

**Types / Interfaces / Enums**
- interface `IUsable`

---

## `Maps/BlockBreakParticles.ts`

### export class BlockBreakParticles

**Properties**
- `private static particleSystem: ParticleSystem`

**Methods**
- `public static play(scene: Scene, position: Vector3, blockId: number, packedLight: number): void`
- `private static init(scene: Scene): void`
- `public static setAtlasTexture(texture: Texture): void`
- `private static computeLightTint(packedLight: number): {
    r: number;
    g: number;
    b: number;
  }`

---

## `Maps/Map1.ts`

### export class Map1

**Constructor**
- `constructor(scene: Scene, player: Player)`

**Properties**
- `public static mainScene: Scene`
- `public static environment: WorldEnvironment`
- `#player: Player`
- `#playerStatePersistence: PlayerStatePersistence | null`
- `#playerLoadingGate: PlayerLoadingGate | null`
- `public readonly initPromise: Promise<void>`
- `static #crackingMesh: Mesh | null`
- `static #crackMaterials: StandardMaterial[]`
- `static #crackingShapeKey: unknown`

**Accessors**
- `public static get timeScale(): number`
- `public static set timeScale(v: number)`
- `public static get isPaused(): boolean`
- `public static set isPaused(v: boolean)`

**Methods**
- `async asyncInit(): Promise<void>`
- `public static setTime(time: number): void`
- `public static setDebug(enabled: boolean): void`
- `async loadTextures(): Promise<void>`
- `public static updateCrackingState(block: { x: number; y: number; z: number } | null, progress: number, blockId?: number, blockState: unknown = 0): void`
- `private static async initCrackingMesh(): Promise<void>`
- `static #createUnitCrackingMesh(): Mesh`
- `static #bakeLocalOffset(mesh: Mesh): void`
- `static #buildCrackingMeshForBlock(blockId: number, blockState: number): Mesh`
- `static #ensureCrackingShape(blockId: number, blockState: number): void`

---

## `Maps/MapFog.ts`

### export class MapFog

**Constructor**
- `constructor(scene: Scene)`

**Properties**
- `public static readonly fogStartUnderWater: unknown`
- `public static readonly fogEndUnderWater: unknown`
- `public static readonly fogStartAboveWater: unknown`
- `public static readonly fogEndAboveWater: unknown`
- `private static fogStartOverride: number | null`
- `private static fogEndOverride: number | null`

**Methods**
- `public static setFogStartOverride(value: number | null): void`
- `public static setFogEndOverride(value: number | null): void`
- `public static getFogStart(isUnderWater: boolean): number`
- `public static getFogEnd(isUnderWater: boolean): number`
- `public static applyToScene(scene: Scene, isUnderWater: boolean): void`

---

## `Maps/UnderWaterEffect.ts`

### export class UnderWaterEffect

**Constructor**
- `constructor(scene: BABYLON.Scene, camera: BABYLON.Camera, player: Player, baseTexture: BABYLON.Texture)`

**Properties**
- `public material: BABYLON.ShaderMaterial`
- `public postProcess: BABYLON.PostProcess`
- `private scene: BABYLON.Scene`
- `private camera: BABYLON.Camera`
- `private player: Player`
- `private depthRenderer: BABYLON.DepthRenderer`
- `private time: unknown`
- `private rate: unknown`
- `private static readonly VERTEX_SHADER: string`
- `private static readonly FRAGMENT_SHADER: string`
- `private static readonly BACKGROUND_POST_PROCESS_SHADER: string`
- `private update: unknown`

**Methods**
- `private registerShaders(): void`
- `private createShaderMaterial(baseTexture: BABYLON.Texture): BABYLON.ShaderMaterial`
- `private createPostProcess(): BABYLON.PostProcess`
- `public dispose(): void`

---

## `Maps/WorldEnvironment.ts`

### export class WorldEnvironment

**Constructor**
- `constructor(scene: Scene)`

**Properties**
- `public static instance: WorldEnvironment`
- `private scene: Scene`
- `private dirLight: DirectionalLight`
- `private hemiLight: HemisphericLight`
- `private skybox: Mesh`
- `private timeOfDay: unknown`
- `public timeScale: unknown`
- `public isPaused: unknown`
- `public wetness: unknown`

**Methods**
- `public initSSAO(): void`
- `private createLights(): void`
- `private createSkybox(): void`
- `public update(): void`
- `public setTime(time: number): void`

---

## `Player/Controls/CustomBoatControls.ts`

### export class CustomBoatControls implements IControls<BoatControlEntity>

**Constructor**
- `constructor(paddleBoat: BoatControlEntity, player: Player)`

**Properties**
- `public pressedKeys: unknown`
- `#controlledEntity: BoatControlEntity`
- `#inputDirection: unknown`
- `#player: Player`
- `public static KEY_LEFT: unknown`
- `public static KEY_RIGHT: unknown`
- `public static KEY_UP: unknown`
- `public static KEY_DOWN: unknown`
- `public static KEY_USE: unknown`
- `public static KEY_JUMP: unknown`
- `public static KEY_SPRINT: unknown`
- `public static KEY_FLASH: unknown`
- `public static MOUSE_WHEEL_UP: unknown`
- `public static MOUSE_WHEEL_DOWN: unknown`
- `#pushVectorUp: unknown`
- `#pushVectorDown: unknown`
- `#pushStrength: unknown`
- `#pushNoseUpStrength: unknown`
- `#angularPushStrength: unknown`
- `#angularRotationStrength: unknown`
- `#pushAngularVectorLeft: unknown`
- `#pushAngularVectorRight: unknown`
- `static readonly #rotationMatrix: unknown`

**Accessors**
- `public get controlledEntity(): BoatControlEntity`
- `public get inputDirection(): Vector3`

**Methods**
- `public handleKeyEvent(key: string, isKeyDown: boolean): void`
- `public onKeyDown(key: string): void`
- `public onKeyUp(key: string): void`
- `#tick(): void`
- `#handleUpDown(forward: Vector3, position: Vector3): void`
- `#handleLeftRight(forward: Vector3, position: Vector3, angularLeftWorld: Vector3, angularRightWorld: Vector3): void`
- `#pressedKeysHas(keys: string[]): boolean`
- `public update(): void`

**Types / Interfaces / Enums**
- type `BoatControlEntity`

---

## `Player/Controls/DebugControlHelper.ts`

### export class DebugControlHelper

**Properties**
- `public static KEY_F2: unknown`
- `public static KEY_F3: unknown`
- `public static KEY_F4: unknown`

**Methods**
- `public static handleKey(key: string): boolean`

---

## `Player/Controls/InventoryControls.ts`

### export class InventoryControls implements IControls<unknown>

**Constructor**
- `constructor(controlledEntity: unknown, underlyingControls: IControls<unknown>, player: Player)`

**Properties**
- `controlledEntity: unknown`
- `pressedKeys: Set<string>`
- `inputDirection: Vector3`
- `#underlyingControls: IControls<unknown>`
- `#player: Player`
- `public static KEY_INVENTORY: unknown`
- `public static KEY_DROP: unknown`
- `public static KEY_CTRL: unknown`
- `public static MOUSE1_INVENTORY: unknown`

**Accessors**
- `public get underlyingControls(): IControls<unknown>`
- `public set underlyingControls(value: IControls<unknown>)`

**Methods**
- `handleKeyEvent(key: string, isKeyDown: boolean): void`
- `handleMouseEvent(mouseEvent: MouseEvent): void`
- `#moveItemToHotbar(): void`
- `onKeyUp(key: string): void`
- `onKeyDown(key: string): void`
- `#pressedKeysHas(keys: string[]): boolean`

---

## `Player/Controls/JetSkiControls.ts`

### export class JetSkiControls implements IControls<BoatControlEntity>

**Constructor**
- `constructor(paddleBoat: BoatControlEntity, player: Player)`

**Properties**
- `public pressedKeys: unknown`
- `#controlledEntity: BoatControlEntity`
- `#inputDirection: unknown`
- `#player: Player`
- `public static KEY_LEFT: unknown`
- `public static KEY_RIGHT: unknown`
- `public static KEY_UP: unknown`
- `public static KEY_DOWN: unknown`
- `public static KEY_USE: unknown`
- `public static KEY_JUMP: unknown`
- `public static KEY_SPRINT: unknown`
- `public static KEY_FLASH: unknown`
- `public static MOUSE_WHEEL_UP: unknown`
- `public static MOUSE_WHEEL_DOWN: unknown`
- `#pushVectorUp: unknown`
- `#pushVectorDown: unknown`
- `#pushStrength: unknown`
- `#pushNoseUpStrength: unknown`
- `#angularPushStrength: unknown`
- `#angularRotationStrength: unknown`
- `#pushAngularVectorLeft: unknown`
- `#pushAngularVectorRight: unknown`
- `static readonly #rotationMatrix: unknown`

**Accessors**
- `public get controlledEntity(): BoatControlEntity`
- `public get inputDirection(): Vector3`

**Methods**
- `public handleKeyEvent(key: string, isKeyDown: boolean): void`
- `public onKeyDown(key: string): void`
- `public onKeyUp(key: string): void`
- `#tick(): void`
- `#handleUpDown(forward: Vector3, position: Vector3): void`
- `#handleLeftRight(forward: Vector3, position: Vector3, angularLeftWorld: Vector3, angularRightWorld: Vector3): void`
- `#pressedKeysHas(keys: string[]): boolean`
- `public update(): void`

---

## `Player/Controls/PaddleBoatControls.ts`

### export class PaddleBoatControls implements IControls<BoatControlEntity>

**Constructor**
- `constructor(paddleBoat: BoatControlEntity, player: Player)`

**Properties**
- `public pressedKeys: unknown`
- `#controlledEntity: BoatControlEntity`
- `#inputDirection: unknown`
- `#player: Player`
- `public static KEY_LEFT: unknown`
- `public static KEY_RIGHT: unknown`
- `public static KEY_UP: unknown`
- `public static KEY_DOWN: unknown`
- `public static KEY_USE: unknown`
- `public static KEY_JUMP: unknown`
- `public static KEY_SPRINT: unknown`
- `public static KEY_FLASH: unknown`
- `public static MOUSE_WHEEL_UP: unknown`
- `public static MOUSE_WHEEL_DOWN: unknown`
- `#pushVectorUp: unknown`
- `#pushVectorDown: unknown`
- `#pushStrength: unknown`
- `#pushNoseUpStrength: unknown`
- `#angularPushStrength: unknown`
- `#angularRotationStrength: unknown`
- `#pushAngularVectorLeft: unknown`
- `#pushAngularVectorRight: unknown`
- `static readonly #rotationMatrix: unknown`

**Accessors**
- `public get controlledEntity(): BoatControlEntity`
- `public get inputDirection(): Vector3`

**Methods**
- `public handleKeyEvent(key: string, isKeyDown: boolean): void`
- `public onKeyDown(key: string): void`
- `public onKeyUp(key: string): void`
- `#tick(): void`
- `#handleUpDown(forward: Vector3, position: Vector3): void`
- `#handleLeftRight(forward: Vector3, position: Vector3, angularLeftWorld: Vector3, angularRightWorld: Vector3): void`
- `#pressedKeysHas(keys: string[]): boolean`
- `public update(): void`

**Types / Interfaces / Enums**
- type `BoatControlEntity`

---

## `Player/Controls/WalkingControls.ts`

### export class WalkingControls implements IControls<PlayerVehicle>

**Constructor**
- `constructor(player: Player)`

**Properties**
- `public pressedKeys: unknown`
- `#controlledEntity: PlayerVehicle`
- `#inputDirection: Vector3`
- `#player: Player`
- `#isBreaking: unknown`
- `#breakingBlock: { x: number; y: number; z: number } | null`
- `#breakTimer: unknown`
- `#lastJumpTapMs: unknown`
- `static readonly DOUBLE_TAP_MS: unknown`
- `public static KEY_LEFT: unknown`
- `public static KEY_RIGHT: unknown`
- `public static KEY_UP: unknown`
- `public static KEY_DOWN: unknown`
- `public static KEY_USE: unknown`
- `public static KEY_PICK_BLOCK: unknown`
- `public static KEY_PICK_BLOCK_EXACT: unknown`
- `public static KEY_JUMP: unknown`
- `public static KEY_SPRINT: unknown`
- `public static KEY_FLASH: unknown`
- `public static KEY_INVENTORY: unknown`
- `public static KEY_DROP: unknown`
- `public static KEY_CTRL: unknown`
- `public static KEY_ALT: unknown`
- `public static MOUSE_WHEEL_UP: unknown`
- `public static MOUSE_WHEEL_DOWN: unknown`
- `public static MOUSE1: unknown`
- `public static MOUSE2: unknown`
- `public static KEY_1: unknown`
- `public static KEY_2: unknown`
- `public static KEY_3: unknown`
- `public static KEY_4: unknown`
- `public static KEY_5: unknown`
- `public static KEY_6: unknown`
- `public static KEY_7: unknown`
- `public static KEY_8: unknown`
- `public static KEY_9: unknown`
- `public static KEY_0: unknown`
- `public static KEY_F5: unknown`
- `public static KEY_F6: unknown`

**Accessors**
- `public get controlledEntity(): PlayerVehicle`
- `public get inputDirection(): Vector3`

**Methods**
- `public handleKeyEvent(key: string, isKeyDown: boolean): void`
- `public handleMouseEvent(mouseEvent: MouseEvent, isKeyDown: boolean): void`
- `public update(): void`
- `public onKeyDown(key: string): void`
- `public onKeyUp(key: string): void`
- `#pressedKeysHas(keys: string[]): boolean`
- `#updateMovementAxesFromPressedKeys(): void`
- `#breakBlock(x: number, y: number, z: number, blockId: number, packedLight: number): void`

---

## `Player/Crafting/CraftingManager.ts`

**Types / Interfaces / Enums**
- interface `Ingredient`
- interface `Recipe`

---

## `Player/Hud/CrossHair.ts`

### export class CrossHair

**Constructor**
- `constructor(engine: Engine, playerCamera: PlayerCamera, scene: Scene, player: Player)`

**Properties**
- `static readonly #meshRayMarchStep: unknown`
- `static readonly #meshBoundsEpsilon: unknown`
- `static readonly #sharedPoint: unknown`
- `readonly #scene: Scene`
- `readonly #engine: Engine`
- `readonly #ui: GUI.AdvancedDynamicTexture`
- `readonly #player: Player`
- `#crosshair: unknown`
- `#hitMarker: unknown`
- `#highlightMaterial: StandardMaterial`
- `#highlightShapeKey: unknown`
- `#blockHighlightMesh: Mesh`
- `static #sharedRay: Ray | null`
- `static readonly #sharedHit: BlockRaycastHit`

**Methods**
- `#createCrosshair(hitMarkerId: string): GUI.Image`
- `#createHitMarker(): GUI.Image`
- `#showHitMarker(): void`
- `#createBlockHighlight(): Mesh`
- `#createHighlightMaterial(): StandardMaterial`
- `#configureHighlightMesh(mesh: Mesh): void`
- `#createUnitCubeHighlightMesh(): Mesh`
- `#bakeLocalOffset(mesh: Mesh): void`
- `#buildHighlightMeshForBlock(blockId: number, blockState: number): Mesh`
- `#ensureHighlightShape(blockId: number, blockState: number): void`
- `#updateBlockHighlight(): void`
- `static #getSharedForwardRay(player: Player, length: number): Ray`
- `static #raycastFirstBlock(player: Player, shouldHitBlockId: (
      x: number,
      y: number,
      z: number,
      blockId: number,
    ) => boolean): BlockRaycastHit | null`
- `static #isFullBlockShape(blockId: number, blockState: number): boolean`
- `static #intersectRayAabbSegment(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, tMin: number, tMax: number, fallbackNx: number, fallbackNy: number, fallbackNz: number): { t: number; nx: number; ny: number; nz: number } | null`
- `static #raycastShapeInVoxel(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, vx: number, vy: number, vz: number, blockId: number, blockState: number, tEnter: number, tExit: number, fallbackNx: number, fallbackNy: number, fallbackNz: number): { t: number; nx: number; ny: number; nz: number } | null`
- `static #isInsideMeshBounds(mesh: AbstractMesh, point: Vector3): boolean`
- `static #rayMarchFirstMesh(player: Player, maxDistance: number, predicate?: (mesh: AbstractMesh) => boolean): AbstractMesh | null`
- `public static pickUsableMesh(player: Player, maxDistance: unknown = Player.REACH_DISTANCE): AbstractMesh | null`
- `public static pickBlock(player: Player): number | null`
- `public static pickTarget(player: Player): Vector3 | null`
- `public static pickWaterPlacementTarget(player: Player): Vector3 | null`
- `public static getPlacementPosition(player: Player): Vector3 | null`
- `public static getPlacementHit(player: Player): {
    pos: Vector3;
    nx: number;
    ny: number;
    nz: number;
    hitFracX: number;
    hitFracY: number;
    hitFracZ: number;
  } | null`
- `setCrosshair(number: string): void`

**Types / Interfaces / Enums**
- type `BlockRaycastHit`

---

## `Player/Hud/PauseMenu.ts`

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
- `private createSlider(container: HTMLElement, labelText: string, min: number, max: number, initialValue: number, onInput: (value: number) => string): void`
- `private createSeparator(text: string): HTMLElement`
- `private toggleSSAO(enabled: boolean): void`
- `public show(): void`
- `public hide(): void`
- `private showSettings(show: boolean): void`
- `private addStyles(): void`

---

## `Player/Hud/PlayerHud.ts`

### export class PlayerHud

**Constructor**
- `constructor(engine: Engine, scene: Scene, player: Player, playerCamera: PlayerCamera)`

**Properties**
- `#engine: Engine`
- `#scene: Scene`
- `#player: Player`
- `static #inventory: PlayerInventory`
- `#inventoryOpen: unknown`
- `#craftingRecipeDivs: { recipe: Recipe; div: HTMLDivElement }[]`
- `#selectedHotbarSlot: unknown`
- `#hotbarSlots: HTMLDivElement[]`
- `static #heldItemNameDiv: HTMLDivElement`
- `#heldItemNameTimeout?: number`
- `#overlayDiv: HTMLDivElement`
- `static debugPanelDiv: HTMLDivElement`
- `private static infoRows: {
    [key: string]: {
      container: HTMLDivElement;
      valueNode: Text;
    };
  }`
- `private static itemTooltipDiv: HTMLDivElement`
- `private static itemTooltipMouseMove?: (e: MouseEvent) => void`
- `#healthBarFill: HTMLDivElement`
- `#hungerBarFill: HTMLDivElement`
- `#staminaBarFill: HTMLDivElement`
- `#manaBarFill: HTMLDivElement`

**Accessors**
- `public get selectedHotbarSlot(): number`
- `public set selectedHotbarSlot(slot: number)`

**Methods**
- `private initializeHUD(): HTMLDivElement`
- `private createCraftingUI(): HTMLDivElement`
- `public updateCraftingAvailability(): void`
- `private createInventoryUI(): HTMLDivElement`
- `private createHotbarUI(): HTMLDivElement`
- `private createStatsUI(): void`
- `private getSlot(column: number, row: number): HTMLDivElement | null`
- `public toggleInventory(): void`
- `private updateHotbarSelection(): void`
- `private initializeDebugPanel(): void`
- `public static toggleDebugInfo(): void`
- `public static showDebugPanel(): void`
- `public static hideDebugPanel(): void`
- `public static updateDebugInfo(key: string, value: string | number): void`
- `private initializeTooltip(): void`
- `public static showItemTooltip(text: string, event: MouseEvent): void`
- `public static hideItemTooltip(): void`
- `public updateStats(): void`

---

## `Player/Inventory/DroppedItem.ts`

### export class DroppedItem implements IUsable

**Constructor**
- `constructor(item: Item, x: number, y: number, z: number)`

**Properties**
- `#boxMesh: Mesh`
- `#material: StandardMaterial`
- `#item: Item`
- `#velocity: unknown`
- `#halfSize: unknown`
- `#voxelCollider: VoxelAabbCollider`
- `#observer: Observer<Scene> | null`
- `static readonly GRAVITY: unknown`
- `static readonly STEP_SIZE: unknown`
- `static readonly EPSILON: unknown`
- `static readonly AIR_DAMPING_PER_SEC: unknown`
- `static readonly GROUND_DAMPING_PER_SEC: unknown`
- `static readonly MIN_SPEED: unknown`
- `static readonly SKY_LIGHT_COLOR: unknown`
- `static readonly BLOCK_LIGHT_COLOR: unknown`

**Accessors**
- `get boxMesh(): Mesh`
- `get item(): Item`

**Methods**
- `pushItem(direction: Vector3): void`
- `use(player: Player): void`
- `#dispose(): void`
- `#updatePhysics(): void`
- `#moveAxis(axis: Axis, delta: number): void`
- `#overlapsSolid(position: Vector3): boolean`
- `#isGrounded(): boolean`
- `#updateLighting(): void`

---

## `Player/Inventory/Item.ts`

### export class Item implements IUsable

**Constructor**
- `constructor(name: string, description: string, icon: string, row: number, col: number, materialFolder?: string, maxStack?: number)`

**Properties**
- `private static readonly SLICE_SHAPE_ROTATION_POLICY: Record<
    string,
    { rotateVerticalByYaw: boolean }
  >`
- `name: string`
- `description: string`
- `icon: string`
- `materialFolder: string | undefined`
- `material: StandardMaterial | undefined`
- `itemId: unknown`
- `blockId: number | null`
- `blockState: unknown`
- `#maxStack: unknown`
- `#stackSize: unknown`
- `#div: HTMLDivElement`
- `#stackLabel: HTMLSpanElement`
- `row: number`
- `col: number`

**Accessors**
- `public set stackSize(value: number)`
- `public get stackSize(): number`
- `get div(): HTMLDivElement`

**Methods**
- `private static createFromDefinition(def: ItemDefinition, row: number, col: number): Item`
- `static createById(itemId: number, row: unknown = -1, col: unknown = -1): Item`
- `use(player: Player): void`
- `static place(player: Player): void`
- `createDiv(): HTMLDivElement`
- `private static getWallRotationFromYaw(yaw: number): number`
- `public refreshIconStyle(): void`
- `private getAtlasTile(): [number, number] | null`
- `public static stackItemAtoB(itemA: Item, itemB: Item): number`

---

## `Player/Inventory/ItemRegistry.ts`

### export class ItemRegistry

**Properties**
- `private static initialized: unknown`
- `private static loadPromise: Promise<void> | null`
- `private static definitions: unknown`
- `private static variantsInitialized: unknown`
- `private static readonly SLAB_VARIANTS: unknown`

**Methods**
- `private static toDisplayName(rawName: string): string`
- `static initDefaults(): void`
- `static async ensureLoaded(url: unknown = DEFAULT_ITEMS_URL): Promise<void>`
- `static async loadFromUrl(url: string): Promise<void>`
- `static register(def: ItemDefinition): void`
- `static get(id: number): ItemDefinition | undefined`
- `static getAll(): ItemDefinition[]`
- `private static ensureBlockStateVariants(): void`
- `private static isValidDefinition(value: unknown): value is ItemDefinition`

**Types / Interfaces / Enums**
- type `ItemDefinition`

---

## `Player/Inventory/ItemSlot.ts`

### export class ItemSlot

**Constructor**
- `constructor(row: number, col: number)`

**Properties**
- `#item: Item | null`
- `#divItemSlot: HTMLDivElement`
- `row: number`
- `col: number`

**Accessors**
- `public get divItemSlot(): HTMLDivElement`
- `public set divItemSlot(div: HTMLDivElement)`
- `public set item(item: Item | null)`
- `public get item(): Item | null`

**Methods**
- `public swapSlots(slot: ItemSlot): void`
- `public clearItemSlots(): void`
- `public initalize(): void`

---

## `Player/Inventory/ItemUseActions.ts`

**Types / Interfaces / Enums**
- type `ItemUseAction`

---

## `Player/Inventory/PlayerInventory.ts`

### export class PlayerInventory

**Constructor**
- `constructor(scene: Scene, player: Player, x: number, y: number)`

**Properties**
- `scene: Scene`
- `#player: Player`
- `#x: number`
- `#y: number`
- `#inventorySlots: ItemSlot[][]`
- `public onInventoryChangedObservable: unknown`
- `#inventoryControls: InventoryControls`
- `public static currentlyHoveredSlot: ItemSlot | null`

**Accessors**
- `public get inventoryControls(): InventoryControls`
- `public set inventoryControls(value: InventoryControls)`
- `public get inventory(): ItemSlot[][]`
- `get x(): number`
- `get y(): number`

**Methods**
- `#generateInventorySlots(): void`
- `async #loadInitialItems(): Promise<void>`
- `private static getCobbleVariantRank(def: ItemDefinition): number`
- `private static getCobbleDefinitions(definitions: ItemDefinition[]): ItemDefinition[]`
- `#generateFakeItems(): void`
- `#ensureCobbleVariantsPresent(): void`
- `#createItemById(itemId: number, row: number, col: number): Item | null`
- `public getSavedInventoryState(): SavedInventoryState`
- `public restoreSavedInventoryState(savedState: unknown): boolean`
- `#clearInventory(): void`
- `#isValidSavedInventoryState(savedState: unknown): savedState is SavedInventoryState`
- `#isValidSavedInventoryItem(value: unknown): value is SavedInventoryItem`
- `public addItem(item: Item): number`
- `public hasItem(itemId: number, count: number): boolean`
- `public removeItems(itemId: number, count: number): void`
- `public createAndAddItem(itemId: number, count: number): void`
- `public dropItemFromHotbar(): void`
- `public dropItem(item: Item, quantity?: number): void`
- `public moveItemToHotbar(slotFocused: ItemSlot): void`
- `public moveItemToInventory(slotFocused: ItemSlot): void`
- `public moveItem(slotFocused: ItemSlot, targetBarIndexRange: [number, number]): void`
- `public deleteItem(item: Item): void`

**Types / Interfaces / Enums**
- type `SavedInventoryItem`
- type `SavedInventoryState`

---

## `Player/IPlayerBody.ts`

**Types / Interfaces / Enums**
- interface `IPlayerBody`
- type `SavedBodyPosition`

---

## `Player/Player.ts`

### export class Player implements IUsable

**Constructor**
- `constructor(engine: Engine, scene: Scene, playerCam: PlayerCamera, canvas: HTMLCanvasElement)`

**Properties**
- `#playerCamera: PlayerCamera`
- `#playerVehicle: PlayerVehicle`
- `#playerInventory: PlayerInventory`
- `#playerHud: PlayerHud`
- `#defaultKeyboardControls: WalkingControls`
- `#keyboardControls: IControls<unknown>`
- `public flashlight: PlayerFlashLight`
- `public stats: PlayerStats`
- `static readonly REACH_DISTANCE: unknown`
- `#pauseMenu: PauseMenu`

**Accessors**
- `public get playerVehicle(): PlayerVehicle`
- `public get playerBody(): IPlayerBody`
- `public get playerCamera(): PlayerCamera`
- `public get keyboardControls(): IControls<unknown>`
- `public set keyboardControls(keyboardControls: IControls<unknown>)`
- `public get playerHud(): PlayerHud`
- `public get playerInventory(): PlayerInventory`
- `public get defaultKeyboardControls(): WalkingControls`
- `public get position(): Vector3`

**Methods**
- `private pauseGame(): void`
- `private resumeGame(): void`
- `use(): void`

---

## `Player/PlayerBodyControlState.ts`

### export class PlayerBodyControlState

**Properties**
- `public readonly inputDirection: unknown`
- `public wantJump: unknown`
- `public isSprinting: unknown`
- `public isFlying: unknown`
- `public isJumpHeld: unknown`

**Methods**
- `public reset(): void`

---

## `Player/PlayerCamera.ts`

### export class PlayerCamera

**Constructor**
- `constructor(playerCamera: FreeCamera, scene: Scene)`

**Properties**
- `#playerCamera: FreeCamera`
- `#isUnderWater: boolean | null`
- `#followDistance: unknown`
- `#eyeHeight: unknown`
- `#cameraPitch: unknown`
- `#cameraYaw: unknown`
- `readonly #maxPitch: unknown`
- `public mouseSensitivity: unknown`
- `readonly #minZoom: unknown`
- `readonly #maxZoom: unknown`
- `readonly #zoomSpeed: unknown`

**Accessors**
- `public get cameraYaw(): number`
- `public get cameraPitch(): number`
- `public get playerCamera(): FreeCamera`
- `public set fov(value: number)`
- `get position(): Vector3`
- `set position(position: Vector3)`
- `set target(target: Vector3)`

**Methods**
- `public moveWithPlayer(characterPosition: Vector3): void`
- `public handleMouseMovement(deltaX: number, deltaY: number): void`
- `public zoomIn(): void`
- `public zoomOut(): void`

---

## `Player/PlayerFlashLight.ts`

### export class PlayerFlashLight

**Constructor**
- `constructor(scene: Scene, playerCamera: FreeCamera)`

**Properties**
- `#flashlight: SpotLight`
- `#camera: FreeCamera`

**Methods**
- `public toggle(): void`

---

## `Player/PlayerInputController.ts`

### export class PlayerInputController

**Constructor**
- `constructor(scene: Scene, canvas: HTMLCanvasElement, playerCamera: PlayerCamera, onKeyEvent: KeyEventHandler, getKeyboardControls: () => IControls<unknown>, onPauseRequested: () => void)`

**Methods**
- `public bind(): void`
- `private bindKeyboardInput(): void`
- `private bindPointerLock(): void`
- `private bindMouseButtons(): void`
- `private bindPointerObserver(): void`

**Types / Interfaces / Enums**
- type `KeyEventHandler`

---

## `Player/PlayerLoadingGate.ts`

### export class PlayerLoadingGate

**Constructor**
- `constructor(scene: Scene, player: Player)`

**Properties**
- `private static readonly SPAWN_CHUNK_RADIUS: unknown`
- `private static readonly SPAWN_READY_FRAME_THRESHOLD: unknown`
- `private static readonly SPAWN_PROTECTION_TIMEOUT_MS: unknown`
- `private spawnReadyFrames: unknown`
- `private isActive: unknown`
- `private readonly startMs: number`
- `private beforeRenderObserver: Observer<Scene> | null`

**Methods**
- `public dispose(): void`
- `private update(): void`
- `private isSpawnColliderReady(chunkX: number, chunkY: number, chunkZ: number): boolean`

---

## `Player/PlayerLoopController.ts`

### export class PlayerLoopController

**Constructor**
- `constructor(engine: Engine, scene: Scene, playerVehicle: IPlayerBody, playerStats: PlayerStats, playerHud: PlayerHud, playerCamera: PlayerCamera, getKeyboardControls: () => IControls<unknown>, getPlayerPosition: () => Vector3)`

**Properties**
- `#lastChunkX: unknown`
- `#lastChunkY: unknown`
- `#lastChunkZ: unknown`

**Methods**
- `public bind(): void`
- `private updateControls(): void`
- `private updateChunksAroundPlayer(): void`
- `private updateDebugHud(): void`
- `private getDirectionFromYaw(yaw: number): string`

---

## `Player/PlayerStatePersistence.ts`

### export class PlayerStatePersistence

**Constructor**
- `constructor(scene: Scene, player: Player)`

**Properties**
- `private static readonly PLAYER_POSITION_STORAGE_KEY: unknown`
- `private static readonly PLAYER_INVENTORY_STORAGE_KEY: unknown`
- `private static readonly PLAYER_STATE_SAVE_INTERVAL_MS: unknown`
- `private static readonly CHUNK_SAVE_BATCH_SIZE: unknown`
- `private static readonly CHUNK_SAVE_NOW_BATCH_SIZE: unknown`
- `private lastPositionSaveMs: unknown`
- `private inventoryObserver: Observer<void> | null`
- `private sceneDisposeObserver: Observer<Scene> | null`
- `private isDisposed: unknown`
- `private readonly onBeforeUnload: unknown`
- `private readonly onVisibilityChange: unknown`

**Methods**
- `public update(): void`
- `public saveNow(): void`
- `public dispose(): void`
- `private setupPersistence(): void`
- `private requestChunkSave(batchSize: number): void`
- `private savePosition(): void`
- `private saveInventory(): void`
- `private restoreFromLocalStorage(): void`
- `private restorePosition(): void`
- `private restoreInventory(): void`

---

## `Player/PlayerStats.ts`

### export class PlayerStats

**Properties**
- `public gamemode: Gamemodes`
- `public maxHealth: unknown`
- `public health: unknown`
- `public maxHunger: unknown`
- `public hunger: unknown`
- `public maxStamina: unknown`
- `public stamina: unknown`
- `public maxMana: unknown`
- `public mana: unknown`
- `public healthRegenRate: unknown`
- `public staminaRegenRate: unknown`
- `public manaRegenRate: unknown`
- `public hungerDepletionRate: unknown`

**Methods**
- `public update(deltaTime: number, isSprinting: boolean): void`
- `public takeDamage(amount: number): void`
- `public heal(amount: number): void`
- `public consumeStamina(amount: number): boolean`
- `public consumeMana(amount: number): boolean`
- `public eat(amount: number): void`

**Types / Interfaces / Enums**
- enum `Gamemodes`

---

## `Player/PlayerVehicle.ts`

### export class PlayerVehicle implements IPlayerBody

**Constructor**
- `constructor(scene: Scene, camera: PlayerCamera)`

**Properties**
- `public scene: Scene`
- `public camera: PlayerCamera`
- `public isMounted: unknown`
- `public DASH: unknown`
- `public mount: Mount | null`
- `private readonly controlState: unknown`
- `private readonly motor: PlayerVehicleMotor`

**Accessors**
- `public get inputDirection(): Vector3`
- `public get wantJump(): number`
- `public set wantJump(value: number)`
- `public get isSprinting(): boolean`
- `public set isSprinting(value: boolean)`
- `public get isFlying(): boolean`
- `public set isFlying(value: boolean)`
- `public get isJumpHeld(): boolean`
- `public set isJumpHeld(value: boolean)`
- `public get isMovementLocked(): boolean`
- `public get characterController(): SimpleCharacterController`
- `public get displayCapsule(): Mesh`

**Methods**
- `public toggleFlying(): void`
- `public clearControlState(): void`
- `public update(deltaTime: number): void`
- `public updateCameraAndVisuals(): void`
- `public lockMovementAtCurrentPosition(): void`
- `public unlockMovement(): void`
- `public getSavedPosition(): SavedPlayerPosition`
- `public restoreSavedPosition(position: unknown): boolean`
- `public setMount(mount: Mount): void`

**Types / Interfaces / Enums**
- type `SavedPlayerPosition`

---

## `Player/PlayerVehicleMotor.ts`

### export class PlayerVehicleMotor

**Constructor**
- `constructor(options: PlayerVehicleMotorOptions)`

**Properties**
- `readonly #scene: Scene`
- `readonly #camera: PlayerCamera`
- `readonly #controls: PlayerBodyControlState`
- `readonly #getMount: () => Mount | null`
- `#displayCapsule: Mesh`
- `#characterController: SimpleCharacterController`
- `readonly #forwardLocalSpace: unknown`
- `#characterOrientation: unknown`
- `#characterGravity: unknown`
- `#movementLocked: unknown`
- `#lockedPosition: Vector3 | null`
- `readonly #zeroVelocity: unknown`
- `private state: PlayerState`
- `private readonly deacceleration: unknown`
- `private readonly inAirSpeed: unknown`
- `private readonly onGroundSpeed: unknown`
- `private readonly jumpHeight: unknown`
- `private readonly accelRateGround: unknown`
- `private readonly sprintMultiplier: unknown`
- `private readonly penetrationRecoveryEps: unknown`
- `private readonly airJumpForwardBoost: unknown`
- `private readonly minFloorNormalDot: unknown`
- `private readonly useVoxelCollision: unknown`
- `private readonly colliderHalfWidth: unknown`
- `private readonly colliderHalfHeight: unknown`
- `private readonly voxelStepSize: unknown`
- `private readonly collisionEpsilon: unknown`
- `private readonly swimSpeed: unknown`
- `private readonly swimAcceleration: unknown`
- `private readonly swimSinkSpeed: unknown`
- `private readonly swimRiseSpeed: unknown`
- `private readonly swimVerticalAcceleration: unknown`
- `private readonly swimHorizontalDrag: unknown`
- `private readonly stepUpHeight: unknown`
- `private readonly stepUpCooldown: unknown`
- `private readonly voxelCollider: VoxelAabbCollider`
- `private voxelPosition: unknown`
- `private voxelVelocity: unknown`
- `private voxelIsGrounded: unknown`
- `private lastStepUpTime: unknown`

**Accessors**
- `public get characterController(): SimpleCharacterController`
- `public get displayCapsule(): Mesh`
- `public get isMovementLocked(): boolean`
- `private get inputDirection(): Vector3`
- `private get wantJump(): number`
- `private set wantJump(value: number)`
- `private get isSprinting(): boolean`
- `private get isFlying(): boolean`
- `private get isJumpHeld(): boolean`

**Methods**
- `public updateCameraAndVisuals(): void`
- `public update(deltaTime: number): void`
- `public lockMovementAtCurrentPosition(): void`
- `public unlockMovement(): void`
- `public getSavedPosition(): SavedBodyPosition`
- `public restoreSavedPosition(position: unknown): boolean`
- `private initializeCharacter(): void`
- `private configureCharacterController(): void`
- `private createCharacterMesh(height: number, width: number): Mesh`
- `private integrateMovement(deltaTime: number): void`
- `private integrateMovementStep(deltaTime: number): void`
- `private calculateFlyingVelocity(deltaTime: number): Vector3`
- `private calculateDesiredVelocity(deltaTime: number, supportInfo: CharacterSurfaceInfo): Vector3`
- `private updatePlayerState(supportInfo: CharacterSurfaceInfo): void`
- `private determineNextState(supportInfo: CharacterSurfaceInfo): PlayerState`
- `private calculateInAirVelocity(deltaTime: number, currentVelocity: Vector3): Vector3`
- `private calculateOnGroundVelocity(deltaTime: number, currentVelocity: Vector3, supportInfo: CharacterSurfaceInfo): Vector3`
- `private applyHorizontalProjectionCorrection(velocity: Vector3, supportInfo: CharacterSurfaceInfo, upWorld: Vector3): Vector3`
- `private calculateJumpVelocity(currentVelocity: Vector3, previousState: PlayerState): Vector3`
- `private calculateVerticalJumpVelocity(currentVelocity: Vector3, upWorld: Vector3): number`
- `private getInputVelocity(speed: number): Vector3`
- `private accelerate(current: Vector3, target: Vector3, maxAccel: number, dt: number): Vector3`
- `private getUpVector(): Vector3`
- `private getForwardVector(): Vector3`
- `private isValidSavedPosition(position: unknown): position is SavedBodyPosition`
- `private getPositionInternal(): Vector3`
- `private getVelocityInternal(): Vector3`
- `private setVelocityInternal(velocity: Vector3): void`
- `private integrateVoxelMovement(deltaTime: number): void`
- `private integrateVoxelMovementStep(deltaTime: number): void`
- `private moveVoxelAxis(axis: Axis, delta: number): void`
- `private attemptStepUp(axis: Axis.X | Axis.Z, delta: number): boolean`
- `private overlapsSolidVoxel(position: Vector3): boolean`
- `private checkVoxelGrounded(): boolean`
- `private isInWater(): boolean`

**Types / Interfaces / Enums**
- type `PlayerVehicleMotorOptions`
- enum `PlayerState`

---

## `Player/SimpleCharacterController.ts`

### export class SimpleCharacterController

**Constructor**
- `constructor(startPosition: Vector3)`

**Properties**
- `public keepDistance: unknown`
- `public keepContactTolerance: unknown`
- `public maxCastIterations: unknown`
- `public penetrationRecoverySpeed: unknown`
- `public maxSlopeCosine: unknown`
- `#position: Vector3`
- `#velocity: unknown`

**Methods**
- `public getPosition(): Vector3`
- `public setPosition(position: Vector3): void`
- `public getVelocity(): Vector3`
- `public setVelocity(velocity: Vector3): void`
- `public checkSupport(_deltaTime: number, _downDirection: Vector3): CharacterSurfaceInfo`
- `public integrate(deltaTime: number, _supportInfo: CharacterSurfaceInfo, gravity: Vector3): void`

**Types / Interfaces / Enums**
- type `CharacterSurfaceInfo`
- enum `CharacterSupportedState`

---

## `Server/MyConnection.ts`

### export class MyConnection

**Constructor**
- `constructor()`

**Properties**
- `client: Client`
- `room?: Room`

**Methods**
- `async connect(): Promise<void>`
- `disconnect(): void`

---

## `TestScene.ts`

### export class TestScene

**Constructor**
- `constructor(document: Document, canvas: HTMLCanvasElement)`

**Properties**
- `document: Document`
- `scene?: Scene`
- `engine: Engine`
- `public readonly initPromise: Promise<void>`
- `private frameCounter: unknown`

**Methods**
- `async init(): Promise<void>`
- `async createScene(): Promise<Scene>`

---

## `World/BlockEncoding.ts`

**Module-level functions**
- `export function packBlockValue(blockId: number, state: unknown = 0): number`
- `export function unpackBlockId(value: number): number`
- `export function unpackBlockState(value: number): number`
- `export function packRotationSlice(rotation: number, slice: number): number`
- `export function unpackRotation(state: number): number`
- `export function unpackSlice(state: number): number`

---

## `World/BlockType.ts`

**Types / Interfaces / Enums**
- enum `BlockType`

---

## `World/Boat/BoatChunk.ts`

### export class BoatChunk

**Constructor**
- `constructor(scene: Scene, blocks: BoatChunkBlock[], center: Vector3)`

**Properties**
- `private static readonly CHUNK_COORD_BASE: unknown`
- `private static readonly CHUNK_COORD_GRID_WIDTH: unknown`
- `private static readonly CHUNK_COORD_SPACING: unknown`
- `private static nextChunkSlot: unknown`
- `#scene: Scene`
- `#center: Vector3`
- `#visualRoot: Mesh`
- `#centerChunk: Chunk`
- `#neighborChunks: Chunk[]`
- `#beforeRenderObserver: Observer<Scene> | null`
- `#attachedOpaqueMesh: Mesh | null`
- `#attachedTransparentMesh: Mesh | null`

**Accessors**
- `public get visualRoot(): Mesh`
- `public get center(): Vector3`

**Methods**
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
- `#syncVisualMeshes(): void`
- `public remesh(priority: unknown = true): void`
- `public attachTo(parent: Mesh): void`
- `public getBlockLocal(x: number, y: number, z: number): number`
- `public getBlockStateLocal(x: number, y: number, z: number): number`
- `public getBlockPackedLocal(x: number, y: number, z: number): number`
- `public setBlockPackedLocal(x: number, y: number, z: number, packedBlock: number): void`
- `public setBlockLocal(x: number, y: number, z: number, blockId: number, blockState: unknown = 0): void`
- `public setLightLocal(x: number, y: number, z: number, packedLight: number): void`
- `public worldToLocalBlock(worldPosition: Vector3): Vector3`
- `public localToWorldCenter(x: number, y: number, z: number): Vector3`
- `public toSnapshot(): { blocks: BoatChunkBlock[]; center: Vector3 }`
- `public dispose(): void`
- `private createEmptyLightArray(): Uint8Array`

**Types / Interfaces / Enums**
- type `BoatChunkBlock`
- type `ChunkCoords`

---

## `World/Boat/BoatCreatorSystem.ts`

### export class BoatCreatorSystem

**Properties**
- `private static readonly LOCAL_CHUNK_PADDING: unknown`
- `private static readonly FLOOD_DIRECTIONS: ReadonlyArray<
    [number, number, number]
  >`
- `private static sourceBlockIds: unknown`
- `private static maxFloodBlocks: unknown`
- `private static visualMode: VisualMode`

**Methods**
- `public static setSourceBlockIds(ids: Iterable<number>): void`
- `public static addSourceBlockId(id: number): void`
- `public static removeSourceBlockId(id: number): void`
- `public static getSourceBlockIds(): number[]`
- `public static setVisualMode(mode: VisualMode): void`
- `public static tryCreateBoatFromMarker(player: Player, markerX: number, markerY: number, markerZ: number): boolean`
- `private static collectConnectedHullBlocks(markerX: number, markerY: number, markerZ: number): VoxelBlock[]`
- `private static computeBounds(blocks: VoxelBlock[]): {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    sizeX: number;
    sizeY: number;
    sizeZ: number;
    center: Vector3;
    halfExtents: Vector3;
  }`
- `private static computeForwardYaw(bounds: {
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

## `World/Chunk/ChunckMesher.ts`

### export class ChunkMesher

**Properties**
- `static #atlasMaterial: Material | null`
- `static #transparentMaterial: Material | null`
- `static #lod3OpaqueMaterial: Material | null`
- `static #lod3TransparentMaterial: Material | null`
- `static #lod2OpaqueMaterial: Material | null`
- `static #lod2TransparentMaterial: Material | null`
- `static #globalUniformBuffer: UniformBuffer | null`
- `static #sharedFacePositionBuffer: Buffer | null`
- `static #activeLodFadeMeshes: unknown`
- `static readonly #LOD_FADE_DURATION_MS: unknown`
- `static #cachedUniforms: unknown`
- `private static _tmpLightDir: unknown`
- `private static lastUpdateFrame: unknown`
- `private static readonly FACE_VERTEX_TEMPLATE: unknown`
- `private static readonly FACE_INDEX_TEMPLATE: unknown`

**Methods**
- `private static ensureMeshMetadata(mesh: Mesh): Record<string, unknown>`
- `private static getMeshLodLevel(mesh: Mesh | null): number | null`
- `private static setMeshLodLevel(mesh: Mesh, lod: number): void`
- `private static getMeshFadeState(mesh: Mesh): LodCrossFadeState | null`
- `private static clearMeshFadeState(mesh: Mesh): void`
- `private static setMeshFadeState(mesh: Mesh, state: LodCrossFadeState): void`
- `private static makeFadeSeed(chunk: Chunk): number`
- `private static beginLodCrossFade(chunk: Chunk, oldMesh: Mesh | null, newMesh: Mesh | null): void`
- `private static shouldUseLodCrossFade(previousLod: number | null, nextLod: number): boolean`
- `private static getMeshFadeUniforms(mesh: Mesh | undefined): {
    progress: number;
    direction: number;
    seed: number;
  }`
- `private static updateLodCrossFades(nowMs: number): void`
- `private static applyLodShaderBindings(material: ShaderMaterial): void`
- `static initAtlas(): void`
- `private static ensureSharedFacePositionBuffer(): void`
- `public static createMeshFromData(chunk: Chunk, meshData: {
      opaque: MeshData | null;
      transparent: MeshData | null;
    }): void`
- `private static upsertMesh(chunk: Chunk, existingMesh: Mesh | null, meshData: MeshData, name: string, material: Material, renderingGroupId: unknown = 1): Mesh`
- `private static upsertFaceVertexBuffer(mesh: Mesh, engine: ReturnType<typeof Map1.mainScene.getEngine>, kind: string, data: Uint8Array): void`
- `private static getFaceBufferLengths(mesh: Mesh): Record<string, number>`
- `static updateGlobalUniforms(frameId: number): void`
- `private static createCachedTexture(url: string, scene: any, args: any): Texture`
- `private static async loadTextureToCache(url: string): Promise<string>`
- `public static disposeSharedResources(): void`

**Types / Interfaces / Enums**
- type `LodCrossFadeState`

---

## `World/Chunk/Chunk.ts`

### export class Chunk

**Constructor**
- `constructor(chunkX: number, chunkY: number, chunkZ: number)`

**Properties**
- `public readonly id: bigint`
- `public lodLevel: unknown`
- `public static readonly SIZE: unknown`
- `public static readonly SIZE2: unknown`
- `public static readonly SIZE3: unknown`
- `public static readonly chunkInstances: unknown`
- `public isModified: unknown`
- `public isPersistent: unknown`
- `public isDirty: unknown`
- `public isLoaded: unknown`
- `public isTerrainScheduled: unknown`
- `public colliderDirty: unknown`
- `private remeshQueued: unknown`
- `private remeshQueuedPriority: unknown`
- `public static onRequestRemesh: | ((chunk: Chunk, priority: boolean) => void)
    | null`
- `public static onChunkLoaded: ((chunk: Chunk) => void) | null`
- `private _block_array: Uint8Array | Uint16Array | null`
- `private _isUniform: unknown`
- `private _uniformBlockId: unknown`
- `private _palette: Uint16Array | null`
- `private _hasVoxelData: unknown`
- `#chunkY: number`
- `#chunkX: number`
- `#chunkZ: number`
- `public mesh: Mesh | null`
- `public transparentMesh: Mesh | null`
- `public opaqueMeshData: MeshData | null`
- `public transparentMeshData: MeshData | null`
- `light_array: Uint8Array`
- `public static readonly SKY_LIGHT_SHIFT: unknown`
- `public static readonly BLOCK_LIGHT_MASK: unknown`
- `private static readonly SKYLIGHT_GENERATION_MIN_WORLD_Y: unknown`
- `private static readonly WATER_BLOCK_ID: unknown`
- `private static readonly GLASS_01_BLOCK_ID: unknown`
- `private static readonly GLASS_02_BLOCK_ID: unknown`
- `private static readonly EPS: unknown`
- `private static readonly CLOSED_FACE_MASK_CACHE: unknown`
- `public cachedLODMeshes: unknown`
- `public isLODMeshCacheDirty: unknown`
- `public static readonly LIGHT_EMISSION: Record<number, number>`
- `private static readonly BITS: unknown`
- `private static readonly MASK: unknown`
- `private static readonly Y_SHIFT: unknown`
- `private static readonly Z_SHIFT: unknown`

**Accessors**
- `get block_array(): Uint8Array | Uint16Array | null`
- `get palette(): Uint16Array | null`
- `get isUniform(): boolean`
- `get uniformBlockId(): number`
- `public get hasVoxelData(): boolean`
- `get chunkX(): number`
- `get chunkY(): number`
- `get chunkZ(): number`

**Methods**
- `public static getLightEmission(blockId: number): number`
- `private getNibble(index: number): number`
- `private setNibble(index: number, value: number): void`
- `public populate(blocks: Uint8Array | Uint16Array | null, palette: Uint16Array | null, isUniform: boolean, uniformBlockId: number, light_array?: Uint8Array, scheduleRemesh: unknown = true): void`
- `public loadFromStorage(blocks: Uint8Array | Uint16Array | null, palette: Uint16Array | null | undefined, isUniform: boolean | undefined, uniformBlockId: number | undefined, light_array?: Uint8Array, scheduleRemesh: unknown = true): void`
- `public loadLodOnlyFromStorage(scheduleRemesh: unknown = false): void`
- `public unload(): void`
- `public getCachedLODMesh(lod: number): CachedLODMesh | null`
- `public hasCachedLODMesh(lod: number): boolean`
- `public setCachedLODMesh(lod: number, mesh: CachedLODMesh): void`
- `public clearCachedLODMeshes(): void`
- `public invalidateLODMeshCaches(): void`
- `public getSerializableLODMeshCache(): SerializedLODMeshCache | undefined`
- `public restoreLODMeshCache(cache?: SerializedLODMeshCache): void`
- `public initializeSunlight(): void`
- `public getBlockLight(localX: number, localY: number, localZ: number): number`
- `public getSkyLight(localX: number, localY: number, localZ: number): number`
- `public setBlockLight(x: number, y: number, z: number, level: number): void`
- `public setSkyLight(x: number, y: number, z: number, level: number): void`
- `public getBlock(localX: number, localY: number, localZ: number): number`
- `public getBlockState(localX: number, localY: number, localZ: number): number`
- `public getBlockPacked(localX: number, localY: number, localZ: number): number`
- `public setBlock(localX: number, localY: number, localZ: number, blockId: number, state: unknown = 0): void`
- `public deleteBlock(localX: number, localY: number, localZ: number): void`
- `public getLight(localX: number, localY: number, localZ: number): number`
- `public setLight(x: number, y: number, z: number, level: number): void`
- `public propagateLight(queue: LightNode[], isSkyLight: unknown = true): void`
- `public updateLightFromNeighbors(x: number, y: number, z: number, isSkyLight: unknown = false): void`
- `private static clamp01(value: number): number`
- `private static uniqueSortedEdges(values: number[]): number[]`
- `private static doesRectUnionCoverUnitSquare(rects: FaceRect[]): boolean`
- `private static pushRect(rects: FaceRect[], u0: number, u1: number, v0: number, v1: number): void`
- `private static applySliceStateToBoxForLight(min: [number, number, number], max: [number, number, number], state: number): {
    min: [number, number, number];
    max: [number, number, number];
  }`
- `private static getClosedFaceMaskForPacked(blockPacked: number): number`
- `private static getFaceBit(axis: number, dir: number): number`
- `private isTransparent(blockPacked: number, axis?: number, dir?: number): boolean`
- `private static isWaterBlock(blockId: number): boolean`
- `private cutSkyLightBelow(localX: number, localY: number, localZ: number): void`
- `public addLight(x: number, y: number, z: number, level: number): void`
- `public removeLight(x: number, y: number, z: number, isSkyLight: unknown = false, sourcePackedOverride?: number): void`
- `public scheduleRemesh(priority: unknown = false): void`
- `public getNeighbor(dx: number, dy: number, dz: number): Chunk | undefined`
- `public static getChunk(chunkX: number, chunkY: number, chunkZ: number): Chunk | undefined`
- `public static packCoords(x: number, y: number, z: number): bigint`
- `public dispose(): void`

**Types / Interfaces / Enums**
- type `LightDirection`
- type `LightNode`
- type `FaceRect`
- type `CachedLODMesh`
- type `SerializedLODMeshCache`

---

## `World/Chunk/chunk.worker.ts`

**Module-level functions**
- `function compressBlocks(blocks: Uint8Array): {
  isUniform: boolean;
  uniformBlockId: number;
  palette: Uint16Array | null;
  packedBlocks: Uint8Array | Uint16Array | null;
}`
- `function toTransferable(data: WorkerInternalMeshData): MeshData`
- `function postFullMeshResult(chunkId: bigint, lod: number, opaque: WorkerInternalMeshData, transparent: WorkerInternalMeshData): void`

---

## `World/Chunk/ChunkLoadingSystem.ts`

### export class ChunkLoadingSystem

**Properties**
- `private static distantTerrain: DistantTerrain`
- `private static loadQueue: Chunk[]`
- `private static unloadQueueSet: Set<Chunk>`
- `private static chunkBoundEntities: Map<symbol, ChunkBoundEntity>`
- `private static pendingChunkEntityReloads: Map<
    bigint,
    SavedChunkEntityData[]
  >`
- `private static chunkEntityLoaders: Map<
    string,
    (payload: unknown, chunk: Chunk) => void
  >`
- `private static restoringChunkEntities: unknown`
- `private static chunkLoadedHookInstalled: unknown`
- `private static flushPromise: Promise<void> | null`
- `private static entityFlushPromise: Promise<void> | null`
- `private static lastPersistedEntityChunkIds: unknown`
- `private static isProcessing: unknown`
- `private static debugStats: ChunkLoadingDebugStats`

**Methods**
- `private static getLoadBatchSize(): number`
- `private static getUnloadBatchSize(): number`
- `private static getProcessFrameBudgetMs(): number`
- `private static refreshQueueDebugSnapshot(): void`
- `public static getDebugStats(): ChunkLoadingDebugStats`
- `private static ensureChunkLoadedHook(): void`
- `public static registerChunkEntityLoader(type: string, loader: (payload: unknown, chunk: Chunk) => void): void`
- `public static registerChunkBoundEntity(entity: ChunkBoundEntity): symbol`
- `public static unregisterChunkBoundEntity(handle: symbol | undefined): void`
- `private static async unloadChunkBoundEntitiesForChunk(chunk: Chunk): Promise<void>`
- `private static spawnSerializedEntities(serializedEntities: SavedChunkEntityData[], chunk: Chunk): SavedChunkEntityData[]`
- `private static async restoreChunkBoundEntitiesForChunk(chunk: Chunk): Promise<void>`
- `public static flushModifiedChunks(maxChunks: unknown = ChunkLoadingSystem.getUnloadBatchSize()): Promise<void>`
- `public static flushChunkBoundEntities(): Promise<void>`
- `private static scheduleChunkAndNeighborsRemesh(chunk: Chunk): void`
- `public static async updateChunksAround(chunkX: number, chunkY: number, chunkZ: number, renderDistance: unknown = SettingParams.RENDER_DISTANCE, verticalRadius: unknown = SettingParams.VERTICAL_RENDER_DISTANCE): Promise<void>`
- `private static queueUnloading(chunkX: number, chunkY: number, chunkZ: number, renderDistance: number, verticalRadius: number): void`
- `private static getSavedMeshForLod(savedData: SavedChunkData, lod: number): { opaque: MeshData | null; transparent: MeshData | null } | null`
- `private static pickBestSavedMesh(savedData: SavedChunkData, desiredLod: number): { opaque: MeshData | null; transparent: MeshData | null } | null`
- `private static async processQueues(): Promise<void>`
- `public static deleteBlock(worldX: number, worldY: number, worldZ: number): void`
- `public static setBlock(worldX: number, worldY: number, worldZ: number, blockId: number, state: unknown = 0): void`
- `public static getBlockByWorldCoords(worldX: number, worldY: number, worldZ: number): number`
- `public static getBlockStateByWorldCoords(worldX: number, worldY: number, worldZ: number): number`
- `public static getLightByWorldCoords(worldX: number, worldY: number, worldZ: number): number`
- `public static worldToChunkCoord(value: number): number`
- `public static worldToBlockCoord(value: number): number`
- `public static areChunksLoadedAround(chunkX: number, chunkY: number, chunkZ: number, horizontalRadius: unknown = 1, verticalRadius: unknown = 0): boolean`
- `public static areChunksLod0ReadyAround(chunkX: number, chunkY: number, chunkZ: number, horizontalRadius: unknown = 1, verticalRadius: unknown = 0): boolean`

**Types / Interfaces / Enums**
- type `ChunkBoundEntity`
- type `ChunkLoadingDebugStats`

---

## `World/Chunk/chunkWorker.ts`

### export class ChunkWorker

**Constructor**
- `constructor(onMessage: (event: MessageEvent<WorkerResponseData>) => void)`

**Properties**
- `private worker: Worker`
- `private warnedNonSharedRemeshPayload: unknown`
- `private readonly paletteToTyped: unknown`

**Methods**
- `public setOnError(handler: (ev: ErrorEvent | Event) => void): void`
- `public terminate(): void`
- `public postFullRemesh(chunk: Chunk, forcedLod?: number): void`
- `public postTerrainGeneration(chunk: Chunk): void`
- `public postGenerateDistantTerrain(centerChunkX: number, centerChunkZ: number, radius: number, renderDistance: number, gridStep: number, oldData?: {
      positions: Int16Array;
      normals: Int8Array;
      surfaceTiles: Uint8Array;
    }, oldCenterChunkX?: number, oldCenterChunkZ?: number): void`

---

## `World/Chunk/ChunkWorkerPool.ts`

### export class ChunkWorkerPool

**Constructor**
- `constructor(poolSize: number)`

**Properties**
- `private static instance: ChunkWorkerPool`
- `private static readonly WORKER_ERROR_COOLDOWN_MS: unknown`
- `private workers: ChunkWorker[]`
- `private workerTaskContext: Array<
    | {
        taskType: "terrain" | "remesh" | "lodPrecompute" | "distantTerrain";
        chunk?: Chunk;
        lod?: number;
        distantTask?: DistantTerrainTask;
      }
    | null
  >`
- `private workerRestartAtMs: number[]`
- `private taskQueue: Chunk[]`
- `private pendingRemeshQueue: Map<Chunk, boolean>`
- `private terrainTaskQueue: Set<Chunk>`
- `private distantTerrainTaskQueue: DistantTerrainTask[]`
- `private lodPrecomputeQueue: Array<{ chunk: Chunk; lod: number }>`
- `private pendingLodPrecomputeKeys: unknown`
- `private lastPrecomputeScheduleTs: unknown`
- `private idleWorkerIndices: number[]`
- `private meshResultQueue: FullMeshMessage[]`
- `private remeshFlushScheduled: unknown`
- `private processQueuePumpScheduled: unknown`
- `private debugStats: ChunkWorkerPoolDebugStats`
- `public onDistantTerrainGenerated: | ((data: DistantTerrainGeneratedMessage) => void)
    | null`
- `private processMeshQueueLoop: unknown`

**Methods**
- `private getDispatchBudgetPerTick(): number`
- `private hasPendingTasks(): boolean`
- `private scheduleProcessQueuePump(): void`
- `private updateQueueDebugStats(): void`
- `public getDebugStats(): ChunkWorkerPoolDebugStats`
- `private resolveChunkByMessageId(chunkId: unknown): Chunk | undefined`
- `private handleWorkerFailure(workerIndex: number, reason: unknown): void`
- `private isCompletelyEmptyChunk(chunk: Chunk): boolean`
- `private clearChunkMeshIfPresent(chunk: Chunk): void`
- `public static getInstance(poolSize: unknown = navigator.hardwareConcurrency || 4): ChunkWorkerPool`
- `public scheduleRemesh(chunk: Chunk | undefined, priority: unknown = false): void`
- `private scheduleRemeshFlush(): void`
- `private flushPendingRemeshQueue(): void`
- `private storeReturnedLODMesh(chunk: Chunk, lod: number, opaque: MeshData | null, transparent: MeshData | null): void`
- `private tryApplyCachedLODMesh(chunk: Chunk, allowDirtyReuse: unknown = false): boolean`
- `private getChunkLodLevel(chunk: Chunk | undefined): number`
- `private compareRemeshPriority(aChunk: Chunk, aPriority: boolean, bChunk: Chunk, bPriority: boolean): number`
- `private insertChunkIntoRemeshQueue(chunk: Chunk, priority: boolean): void`
- `public scheduleTerrainGeneration(chunk: Chunk): void`
- `public scheduleTerrainGenerationBatch(chunks: Chunk[]): void`
- `private getLodPrecomputeKey(chunk: Chunk, lod: number): string`
- `public scheduleBackgroundLodPrecompute(centerChunkX: number, centerChunkY: number, centerChunkZ: number): void`
- `private scheduleChunkAndNeighborsRemesh(chunk: Chunk): void`
- `public scheduleDistantTerrain(centerChunkX: number, centerChunkZ: number, radius: number, renderDistance: number, gridStep: number, oldData?: {
      positions: Int16Array;
      normals: Int8Array;
      surfaceTiles: Uint8Array;
    }, oldCenterChunkX?: number, oldCenterChunkZ?: number): void`
- `private processQueue(): void`

**Types / Interfaces / Enums**
- type `WorkerMessageData`
- type `ChunkWorkerPoolDebugStats`

---

## `World/Chunk/DataStructures/MeshData.ts`

### export class MeshData

**Properties**
- `faceDataA: Uint8Array`
- `faceDataB: Uint8Array`
- `faceDataC: Uint8Array`
- `faceCount: unknown`

**Methods**
- `public static deserialize(data: any): MeshData`

---

## `World/Chunk/DataStructures/PaletteExpander.ts`

### export class PaletteExpander

**Methods**
- `expandPalette(packed: Uint8Array, palette: ArrayLike<number>, totalBlocks: number): Uint8Array | Uint16Array`
- `isUint16(palette: ArrayLike<number> | null | undefined): boolean`

---

## `World/Chunk/DataStructures/ResizableTypedArray.ts`

### export class ResizableTypedArray

**Constructor**
- `constructor(ctor: new (capacity: number) => T, initialCapacity: unknown = 512)`

**Properties**
- `private array: T`
- `private capacity: number`
- `public length: unknown`

**Accessors**
- `get finalArray(): T`

**Methods**
- `push4(a: number, b: number, c: number, d: number): void`
- `push6(a: number, b: number, c: number, d: number, e: number, f: number): void`
- `push8(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number): void`
- `push12(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i1: number, j: number, k: number, l: number): void`
- `private grow(minCapacity: number): void`

---

## `World/Chunk/DataStructures/SparseVoxelOctree.ts`

### export class SparseVoxelOctree

**Properties**
- `static readonly LEAF_MASK: unknown`
- `static readonly DATA_MASK: unknown`

**Methods**
- `public static compress(blocks: Uint8Array, size: number): Uint32Array`
- `public static getBlock(svo: Uint32Array, size: number, x: number, y: number, z: number): number`
- `public static getBlockFromNode(svo: Uint32Array, nodeValue: number, size: number, x: number, y: number, z: number): number`
- `public static traverse(svo: Uint32Array, size: number, callback: (
      x: number,
      y: number,
      z: number,
      size: number,
      depth: number,
      isLeaf: boolean,
      blockId: number,
      nodeValue: number,
    ) => boolean | void): void`

---

## `World/Chunk/DataStructures/WorkerInternalMeshData.ts`

**Types / Interfaces / Enums**
- type `WorkerInternalMeshData`

---

## `World/Chunk/DataStructures/WorkerMessageType.ts`

**Types / Interfaces / Enums**
- interface `DistantTerrainTask`
- type `PackedBlockArray`
- type `PackedPalette`
- type `NeighborBlockArray`
- type `NeighborLightArray`
- type `GenerateTerrainRequest`
- type `GenerateFullMeshRequest`
- type `GenerateDistantTerrainRequest`
- type `WorkerRequestData`
- type `FullMeshMessage`
- type `TerrainGeneratedMessage`
- type `DistantTerrainGeneratedMessage`
- type `WorkerResponseData`
- enum `WorkerTaskType`

---

## `World/Chunk/LOD/ChunkLodRules.ts`

### export class Lod0ChunkCreationRule implements ChunkLodCreationRule

**Constructor**
- `constructor(horizontalRadius: number, verticalRadius: number)`

**Properties**
- `public readonly lodLevel: unknown`
- `public readonly allowsChunkCreation: unknown`

**Methods**
- `public matches(distance: ChunkLodDistance): boolean`

### export class Lod1ChunkCreationRule implements ChunkLodCreationRule

**Constructor**
- `constructor(horizontalRadius: number, verticalRadius: number)`

**Properties**
- `public readonly lodLevel: unknown`
- `public readonly allowsChunkCreation: unknown`

**Methods**
- `public matches(distance: ChunkLodDistance): boolean`

### export class Lod2ChunkCreationRule implements ChunkLodCreationRule

**Constructor**
- `constructor(horizontalRadius: number, verticalRadius: number)`

**Properties**
- `public readonly lodLevel: unknown`
- `public readonly allowsChunkCreation: unknown`

**Methods**
- `public matches(distance: ChunkLodDistance): boolean`

### export class Lod3ChunkCreationRule implements ChunkLodCreationRule

**Constructor**
- `constructor(horizontalRadius: number, verticalRadius: number)`

**Properties**
- `public readonly lodLevel: unknown`
- `public readonly allowsChunkCreation: unknown`

**Methods**
- `public matches(distance: ChunkLodDistance): boolean`

### export class DistantOnlyChunkCreationRule implements ChunkLodCreationRule

**Constructor**
- `constructor(lodLevel: unknown = 4)`

**Properties**
- `public readonly allowsChunkCreation: unknown`

**Methods**
- `public matches(_distance: ChunkLodDistance): boolean`

### export class ChunkLodRuleSet

**Constructor**
- `constructor(radii: ChunkLodRadii, rules: ChunkLodCreationRule[])`

**Methods**
- `public static fromRenderRadii(renderDistance: number, verticalRadius: number): ChunkLodRuleSet`
- `public resolve(target: ChunkLodCoordinates, player: ChunkLodCoordinates): ChunkLodDecision`
- `private measureDistance(target: ChunkLodCoordinates, player: ChunkLodCoordinates): ChunkLodDistance`

**Types / Interfaces / Enums**
- interface `ChunkLodCreationRule`
- type `ChunkLodCoordinates`
- type `ChunkLodRadii`
- type `ChunkLodDistance`
- type `ChunkLodDecision`

---

## `World/Chunk/LOD/LodCacheVersion.ts`

**Module-level functions**
- `export function getCurrentLodCacheVersion(): string`

---

## `World/Chunk/Worker/ChunkMeshBuilder.ts`

### export class ChunkMeshBuilder

**Methods**
- `public static createEmptyMeshData(): WorkerInternalMeshData`
- `private static calculateAOPacked(ax: number, ay: number, az: number, u: number, v: number, getBlock: (x: number, y: number, z: number) => number): number`
- `private static isAOOccluder(value: number): boolean`
- `private static isFullCubeOccluder(value: number): boolean`
- `private static isGreedyCompatibleShape(shapeIndex: number): boolean`
- `private static isFaceFull(state: number, axis: number, isBackFace: boolean): boolean`
- `public static generateMesh(data: GenerateMeshInput): {
    opaque: WorkerInternalMeshData;
    transparent: WorkerInternalMeshData;
  }`
- `private static chunkHasCustomShapes(block_array: SamplingBlockArray): boolean`
- `private static computeSliceMask(size: number, axis: number, slice: number, direction: number[], block_array: SamplingBlockArray, getBlock: (x: number, y: number, z: number, fallback?: number) => number, getLight: (x: number, y: number, z: number, fallback?: number) => number, mask: Uint32Array, maskLight: Uint16Array, maskBack: Uint32Array, maskBackLight: Uint16Array, lod: number, disableAO: boolean): void`
- `private static meshSlice(size: number, axis: number, axisSlice: number, mask: Uint32Array, maskLight: Uint16Array, opaqueMeshData: WorkerInternalMeshData, transparentMeshData: WorkerInternalMeshData, faceNamePositive: string, faceNameNegative: string): void`
- `private static transformFaceMask(faceMask: number, rotation: number, flipY: boolean): number`
- `private static applySliceStateToBox(min: [number, number, number], max: [number, number, number], state: number): {
    min: [number, number, number];
    max: [number, number, number];
  }`
- `private static emitCustomShapes(size: number, block_array: SamplingBlockArray, getBlock: (x: number, y: number, z: number, fallback?: number) => number, getLight: (x: number, y: number, z: number, fallback?: number) => number, opaqueMeshData: WorkerInternalMeshData, transparentMeshData: WorkerInternalMeshData, disableAO: boolean): void`
- `private static getFaceName(dir: number[], isBackFace: boolean): string`
- `private static getMaterialTintBucket(blockId: number): number`
- `public static addQuad(x: number, y: number, z: number, axis: number, width: number, height: number, blockId: number, isBackFace: boolean, faceName: string, lightLevel: number, packedAO: number, meshData: WorkerInternalMeshData): void`
- `private static quantizeLightNibble(value: number): number`
- `private static quantizePackedLightForLod(packedLight: number, disableAO: boolean): number`

**Types / Interfaces / Enums**
- type `GenerateMeshInput`

---

## `World/Chunk/Worker/ChunkSamplingContext.ts`

### export class ChunkSamplingContext

**Constructor**
- `constructor(args: ChunkSamplingContextArgs)`

**Properties**
- `public readonly size: number`
- `public readonly size2: number`
- `public readonly fullBright: number`
- `private readonly block_array: SamplingBlockArray`
- `private readonly light_array?: Uint8Array`
- `private readonly neighbors: (SamplingBlockArray | undefined)[]`
- `private readonly neighborLights?: (Uint8Array | undefined)[]`
- `public getBlock: unknown`
- `public getLight: unknown`

**Methods**
- `public static toCompactNeighborIndex(fullIndex: number): number`

**Types / Interfaces / Enums**
- type `SamplingBlockArray`
- type `ChunkSamplingContextArgs`

---

## `World/Chunk/Worker/WaterLODBuilder.ts`

### export class WaterLODBuilder

**Methods**
- `public static createEmptyMeshData(): WorkerInternalMeshData`
- `public static isWaterPacked(packed: number): boolean`
- `public static waterGridIndex(cellX: number, cellY: number, cellZ: number, cellsX: number, cellsZ: number): number`
- `public static packMaxLightInCell(getLight: (x: number, y: number, z: number, fallback?: number) => number, baseX: number, baseY: number, baseZ: number, step: number, size: number): number`
- `public static sampleCoarseWaterSurface(args: WaterLODArgs, coarseX: number, coarseY: number, coarseZ: number): WaterSurfaceSample | null`
- `public static buildCoarseWaterSampleGrid(args: WaterLODArgs): WaterSampleGrid`
- `public static generateLODWaterMeshFromGrid(grid: WaterSampleGrid, addQuad: AddQuadFn): WorkerInternalMeshData`
- `public static appendMeshData(target: WorkerInternalMeshData, source: WorkerInternalMeshData): void`

**Types / Interfaces / Enums**
- type `WaterSurfaceSample`
- type `WaterLODArgs`
- type `WaterSampleGrid`
- type `AddQuadFn`

---

## `World/Chunk/Worker/WorkerPayloadExpander.ts`

### export class WorkerPayloadExpander

**Methods**
- `public static detectNeedsUint16(request: GenerateFullMeshRequest, paletteExpander: PaletteExpander): boolean`
- `public static expandCenterChunkPayload(request: GenerateFullMeshRequest, totalBlocks: number, needsUint16: boolean, paletteExpander: PaletteExpander): void`
- `public static expandNeighborPayloads(request: GenerateFullMeshRequest, totalBlocks: number, needsUint16: boolean, paletteExpander: PaletteExpander): void`
- `public static expandFullMeshRequest(request: GenerateFullMeshRequest, paletteExpander: PaletteExpander): ExpandedFullMeshContext`
- `public static clearLargeReferences(request: GenerateFullMeshRequest): void`

**Types / Interfaces / Enums**
- type `ExpandedFullMeshContext`

---

## `World/Chunk/Worker/WorkerTaskHandlers.ts`

### export class WorkerTaskHandlers

**Methods**
- `public static handleGenerateFullMesh(request: GenerateFullMeshRequest, deps: {
      paletteExpander: PaletteExpander;
      meshBuilder: MeshBuilderLike;
      postFullMeshResult: PostFullMeshResultFn;
    }): void`
- `public static handleGenerateTerrain(request: GenerateTerrainRequest, deps: {
      generator: WorldGenerator;
      compressBlocks: CompressBlocksFn;
    }): {
    payload: {
      chunkId: bigint;
      type: number;
      block_array: Uint8Array | Uint16Array | null;
      light_array: Uint8Array;
      isUniform: boolean;
      uniformBlockId: number;
      palette: Uint16Array | null;
    };
    transferables: Transferable[];
  }`
- `public static handleGenerateDistantTerrain(request: GenerateDistantTerrainRequest): {
    payload: {
      type: number;
      centerChunkX: number;
      centerChunkZ: number;
      positions: Int16Array;
      normals: Int8Array;
      surfaceTiles: Uint8Array;
    };
    transferables: Transferable[];
  }`

**Types / Interfaces / Enums**
- type `MeshBuilderLike`
- type `PostFullMeshResultFn`
- type `CompressBlocksFn`

---

## `World/Collision/VoxelAabbCollider.ts`

### export class VoxelAabbCollider

**Constructor**
- `constructor(halfExtents: Vector3, isSolidBlockAt: IsSolidBlockAt, epsilon: unknown = 0.001, debugOptions?: VoxelAabbDebugOptions)`

**Properties**
- `#halfExtents: Vector3`
- `#epsilon: number`
- `#isSolidBlockAt: IsSolidBlockAt`
- `#tmpCandidate: unknown`
- `#debugMesh: Mesh | null`
- `#debugOptions: VoxelAabbDebugOptions | null`
- `static #debugEnabled: unknown`
- `static readonly #debugColliders: unknown`

**Accessors**
- `public set HalfExtents(halfExtents: Vector3)`

**Methods**
- `#createDebugMesh(options: VoxelAabbDebugOptions): void`
- `#ensureDebugMesh(): void`
- `public overlaps(position: Vector3): boolean`
- `public moveAxis(position: Vector3, velocity: Vector3, axis: Axis, delta: number, stepSize: number): void`
- `public syncDebugMesh(position: Vector3): void`
- `public dispose(): void`
- `public static toggleDebugEnabled(): void`
- `public static setDebugEnabled(enabled: boolean): void`

**Types / Interfaces / Enums**
- type `IsSolidBlockAt`
- type `VoxelAabbDebugOptions`
- enum `Axis`

---

## `World/Collision/VoxelObbCollider.ts`

### export class VoxelObbCollider

**Constructor**
- `constructor(halfExtents: Vector3, isSolidBlockAt: IsSolidBlockAt, epsilon: unknown = 0.001, debugOptions?: VoxelObbDebugOptions)`

**Properties**
- `#halfExtents: Vector3`
- `#epsilon: number`
- `#isSolidBlockAt: IsSolidBlockAt`
- `#yaw: unknown`
- `#rotX: unknown`
- `#rotZ: unknown`
- `#tmpCandidate: unknown`
- `#debugMesh: Mesh | null`
- `#debugOptions: VoxelObbDebugOptions | null`
- `static #debugEnabled: unknown`
- `static readonly #debugColliders: unknown`

**Methods**
- `public setYaw(yaw: number): void`
- `#updateRotAxes(): void`
- `#createDebugMesh(options: VoxelObbDebugOptions): void`
- `#ensureDebugMesh(): void`
- `public overlaps(position: Vector3): boolean`
- `#obbIntersectsVoxel(px: number, py: number, pz: number, hx: number, hy: number, hz: number, vx: number, vy: number, vz: number): boolean`
- `public moveAxis(position: Vector3, velocity: Vector3, axis: Axis, delta: number, stepSize: number): void`
- `public syncDebugMesh(position: Vector3): void`
- `public dispose(): void`
- `public static toggleDebugEnabled(): void`
- `public static setDebugEnabled(enabled: boolean): void`

**Types / Interfaces / Enums**
- type `IsSolidBlockAt`
- type `VoxelObbDebugOptions`
- enum `Axis`

---

## `World/DebugPanel.ts`

### export class DebugPanel

**Constructor**
- `constructor()`

**Properties**
- `static instance: DebugPanel`
- `static div: HTMLDivElement`
- `private static infoLines: { [key: string]: string }`

**Methods**
- `static getInstance(): DebugPanel`
- `public static show(): void`
- `public static hide(): void`
- `public static updateInfo(key: string, value: string | number): void`
- `private static render(): void`

---

## `World/GlobalValues.ts`

### export class GlobalValues

**Properties**
- `public static DEBUG: unknown`
- `public static readonly CREATE_ATLAS: unknown`
- `public static readonly INIT_CONNECTION: unknown`
- `public static readonly CACHE_TEXTURES: unknown`
- `public static readonly TEXTURE_VERSION: unknown`
- `public static readonly DISABLE_CHUNK_SAVING: unknown`
- `public static readonly DISABLE_CHUNK_LOADING: unknown`
- `public static skyLightDirection: unknown`
- `public static GLOBAL_TIME: unknown`
- `public static DAY_DURATION_MS: unknown`

---

## `World/Light/DistantTerrainShader.ts`

### export class DistantTerrainShader

**Properties**
- `static readonly distantTerrainVertexShader: unknown`
- `static readonly distantTerrainFragmentShader: unknown`
- `static readonly distantWaterVertexShader: unknown`
- `static readonly distantWaterFragmentShader: unknown`

---

## `World/Light/Lod2Shader.ts`

### export class Lod2Shader

**Properties**
- `static readonly chunkVertexShader: unknown`
- `static readonly opaqueFragmentShader: unknown`
- `static readonly transparentFragmentShader: unknown`

---

## `World/Light/Lod3Shader.ts`

### export class Lod3Shader

**Properties**
- `public static readonly chunkVertexShader: unknown`
- `public static readonly opaqueFragmentShader: unknown`
- `public static readonly transparentFragmentShader: unknown`

---

## `World/Light/OpaqueShader.ts`

### export class OpaqueShader

**Properties**
- `static readonly chunkVertexShader: unknown`
- `static readonly chunkFragmentShader: unknown`

---

## `World/Light/SkyShader.ts`

### export class SkyShader

**Properties**
- `static readonly skyVertexShader: unknown`
- `static readonly skyFragmentShader: unknown`

---

## `World/Light/TransparentShader.ts`

### export class TransparentShader

**Properties**
- `public static readonly chunkFragmentShader: unknown`

---

## `World/SettingParams.ts`

### export class SettingParams

**Properties**
- `public static RENDER_DISTANCE: unknown`
- `public static VERTICAL_RENDER_DISTANCE: unknown`
- `public static MAX_CHUNK_HEIGHT: unknown`
- `public static CHUNK_UNLOAD_DISTANCE_BUFFER: unknown`
- `public static CHUNK_LOAD_BATCH_LIMIT: unknown`
- `public static CHUNK_UNLOAD_BATCH_LIMIT: unknown`
- `public static CHUNK_LOADING_FRAME_BUDGET_MS: unknown`
- `public static VERTICAL_CHUNK_CULLING_FACTOR: unknown`
- `public static CAMERA_FOV: unknown`
- `public static DISTANT_RENDER_DISTANCE: unknown`
- `public static LOD_PRECOMPUTE_SCHEDULE_THROTTLE_MS: unknown`
- `public static LOD_PRECOMPUTE_MAX_ENQUEUE_PER_UPDATE: unknown`
- `public static CHUNK_WORKER_DISPATCH_BUDGET_PER_TICK: unknown`
- `public static DAY_DURATION_MS: unknown`
- `public static ENABLE_SSAO: unknown`
- `public static SSAO_RATIO: unknown`
- `public static SSAO_COMBINE_RATIO: unknown`
- `public static HIGHLIGHT_ALPHA: unknown`
- `public static HIGHLIGHT_COLOR: unknown`
- `public static HIGHLIGHT_EDGE_WIDTH: unknown`
- `public static HIGHLIGHT_EDGE_COLOR: unknown`
- `public static HEMISPHERIC_LIGHT_INTENSITY: unknown`

---

## `World/Shape/BlockShapes.ts`

**Types / Interfaces / Enums**
- type `ShapeBox`
- type `ShapeDefinition`
- type `RawShapeBox`
- type `RawShapeDefinition`
- type `RawBlockDefinition`

---

## `World/Shape/BlockShapeTransforms.ts`

**Types / Interfaces / Enums**
- type `ShapeBounds`

---

## `World/Texture/BlockTextures.ts`

**Types / Interfaces / Enums**
- type `BlockTextureDef`

---

## `World/Texture/MaterialFactory.ts`

### export class MaterialFactory

**Properties**
- `private static materialCache: unknown`

**Methods**
- `private static createTexture(scene: Scene, path: string, uvScale: number): Texture`
- `static createMaterialByFolder(scene: Scene, folder: string, uvScale: unknown = 1, extension: unknown = ".png", diff: unknown = true, nor: unknown = false, ao: unknown = false, spec: unknown = false): StandardMaterial`
- `private static buildMaterial(scene: Scene, mat: StandardMaterial, directory: string, baseName: string, resolution: string, extension: string, uvScale: number, diff: boolean, nor: boolean, ao: boolean, spec: boolean, cacheKey: string): StandardMaterial`
- `public static getTexturePathFromFolder(folder: string, type: unknown = "diff", extension: unknown = ".png"): string | null`

---

## `World/Texture/TextureAtlasFactory.ts`

### export class TextureAtlasFactory

**Properties**
- `private static diffuseAtlas: Texture | null`
- `private static normalAtlas: Texture | null`
- `private static uvMap: Record<string, TileUV>`
- `public static readonly tileSize: unknown`
- `public static readonly atlasSize: unknown`
- `public static readonly atlasTileSize: unknown`

**Methods**
- `static async buildAtlas(scene: Scene, images: { name: string; path: string }[], tileSize: unknown = TextureAtlasFactory.tileSize, atlasSize: unknown = TextureAtlasFactory.atlasSize): Promise<{ diffuse: Texture; normal: Texture; uvMap: Record<string, TileUV>; } | undefined>`
- `private static saveCanvasAsImage(canvas: HTMLCanvasElement, filename: string): void`
- `private static async loadImageSafe(src: string): Promise<HTMLImageElement | null>`
- `private static loadImage(src: string): Promise<HTMLImageElement>`
- `static getUV(name: string): TileUV | undefined`
- `static getDiffuse(): Texture | null`
- `static setDiffuse(texture: Texture): void`
- `static getNormal(): Texture | null`
- `static setNormal(texture: Texture): void`

**Types / Interfaces / Enums**
- type `TileUV`

---

## `World/Texture/TextureCache.ts`

### export class TextureCache

**Properties**
- `private static dbName: unknown`
- `private static storeName: unknown`
- `private static dbPromise: Promise<IDBDatabase> | null`

**Methods**
- `private static getDB(): Promise<IDBDatabase>`
- `static async get(url: string): Promise<Blob | undefined>`
- `static async put(url: string, blob: Blob): Promise<void>`

---

## `World/Texture/TextureDefinitions.ts`

**Module-level functions**
- `async function loadBlockDefinitions(): Promise<TextureDefinition[]>`
- `function normalizeBlockId(id: number | string): BlockType | null`
- `export function getBlockBreakTime(id: number, toolItemId?: number): number`
- `export function getBlockInfo(id: number): TextureDefinition | undefined`

**Types / Interfaces / Enums**
- interface `TextureDefinition`
- type `RawBlockDefinition`

---

## `World/WorldStorage.ts`

### export class WorldStorage

**Properties**
- `private static db: IDBDatabase`
- `private static initPromise: Promise<void> | null`
- `private static pendingChunkSaves: unknown`
- `private static persistenceQueues: Record<PersistenceLane, PersistenceJob[]>`
- `private static isProcessingPersistenceQueues: unknown`
- `private static pendingLodInvalidationChunkIds: unknown`

**Methods**
- `private static async ensureInitialized(): Promise<boolean>`
- `private static trackPendingChunkSaves(chunkIds: string[], savePromise: Promise<void>): Promise<void>`
- `private static async awaitPendingChunkSaves(chunkIds: string[]): Promise<void>`
- `private static enqueuePersistenceJob(lane: PersistenceLane, chunkIds: string[], run: () => Promise<void>): Promise<void>`
- `private static processPersistenceQueues(): void`
- `private static async persistPreparedFullChunks(prepared: PreparedFullChunkSave[]): Promise<void>`
- `private static async persistPreparedLodOnlyChunks(prepared: PreparedLodOnlySave[]): Promise<void>`
- `private static async persistLodCacheInvalidation(chunkId: string, targetVersion: string): Promise<void>`
- `private static applyLodCacheVersionPolicy(chunkId: string, data: SavedChunkData): SavedChunkData`
- `private static scheduleLodCacheInvalidation(chunkId: string, targetVersion: string): void`
- `public static initialize(): Promise<void>`
- `public static async saveChunk(chunk: Chunk): Promise<void>`
- `public static async saveChunks(chunks: Chunk[]): Promise<void>`
- `public static async saveAllModifiedChunks(): Promise<void>`
- `public static async saveChunkEntities(chunkId: bigint, entities: SavedChunkEntityData[]): Promise<void>`
- `public static async loadChunkEntities(chunkId: bigint): Promise<SavedChunkEntityData[]>`
- `public static async clearWorldData(): Promise<void>`
- `public static async loadChunk(chunkId: bigint, options?: LoadChunkOptions): Promise<SavedChunkData | null>`
- `public static async loadChunks(chunkIds: bigint[], options?: LoadChunkOptions): Promise<Map<bigint, SavedChunkData>>`
- `private static async compress(data: Uint8Array | Uint16Array): Promise<Uint8Array>`
- `private static async decompress(data: Uint8Array): Promise<Uint8Array | Uint16Array>`

**Types / Interfaces / Enums**
- type `SavedChunkData`
- type `LoadChunkOptions`
- type `SavedChunkEntityData`
- type `PersistenceLane`
- type `PersistenceJob`
- type `PreparedFullChunkSave`
- type `PreparedLodOnlySave`

---
