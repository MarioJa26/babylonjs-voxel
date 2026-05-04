# Project Footprint

Generated: 2026-05-04T17:45:58.745Z

> **Summary:** 102 classes · 1746 members · 200 module-level functions · 29035 LOC

---

## `Entities/AdvancedBoat.ts` (287 LOC)

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

## `Entities/BouyantObject.ts` (53 LOC)

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

## `Entities/CustomBoat.ts` (711 LOC)

### export class CustomBoat implements IUsable

**Constructor**
- `constructor(scene: Scene, player: Player, waterLevel: number, position?: Vector3, options?: CustomBoatOptions)`

**Properties**
- `static readonly CHUNK_ENTITY_TYPE: unknown`
- `static #chunkReloadContext: {
		scene: Scene;
		player: Player;
		waterLevel: number;
	} | null`
- `static #chunkLoaderRegistered: unknown`
- `static #activeBoats: unknown`
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
- `#boatChunkCollisionProviderHandle?: symbol`
- `#boatChunkBlockChangeUnsubscribe?: () => void`
- `#ignoredDynamicBlockProviders: unknown`
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
- `#tmpBoatSampleWorld: unknown`

**Accessors**
- `public get boatChunk(): BoatChunk | undefined`
- `public get boatYaw(): number`
- `public get boatMesh(): Mesh`
- `public get boatPosition(): Vector3`
- `public get mount(): Mount`
- `public get submergedPoints(): number`
- `public get currentYaw(): number`

**Methods**
- `public static getActiveBoats(): readonly CustomBoat[]`
- `public worldToBoatChunkLocalPoint(worldPoint: Vector3, out: unknown = new Vector3()): Vector3 | null`
- `public boatChunkLocalPointToWorld(localPoint: Vector3, out: unknown = new Vector3()): Vector3 | null`
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
- `#createSerializedPayload(): {
		type: string;
		payload: CustomBoatSerializedPayload;
	}`
- `public use(player: Player): void`
- `public dispose(scene: Scene): void`
- `#subscribeBoatChunkBlockChanges(): void`
- `#syncCollisionFromBoatChunk(): void`
- `#hasOccupiedBoatNeighbor(localX: number, localY: number, localZ: number): boolean`
- `#registerBoatChunkCollisionProvider(): void`
- `#sampleBoatChunkBlock(worldX: number, worldY: number, worldZ: number): DynamicBlockSample | null`
- `#setBoatChunkBlock(worldX: number, worldY: number, worldZ: number, blockId: number, blockState: number): boolean`
- `#worldToBoatLocal(worldX: number, worldY: number, worldZ: number): Vector3 | null`
- `#getWorldBlockForBoatPhysics(x: number, y: number, z: number): number`

**Types / Interfaces / Enums**
- type `CustomBoatOptions`
- type `SerializedBoatChunk`
- type `CustomBoatSerializedPayload`

---

## `Entities/MetaDataContainer.ts` (21 LOC)

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

## `Entities/Mount.ts` (108 LOC)

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
- `mount(user: unknown): boolean`
- `dismount(): boolean`
- `getMountedUser(): Player | null`
- `getKeyBoardControls(): IControls<unknown>`
- `setMountOffset(offset: Vector3): void`
- `setMountRotationOffset(rotationOffset: Quaternion): void`
- `update(): void`
- `#mountVehicle(player: Player): boolean`
- `private updateMountedPosition(): void`
- `private disablePlayerPhysics(player: IPlayerBody): void`
- `private enablePlayerPhysics(playerVehicle: IPlayerBody): void`

---

## `Entities/MountOptions.ts` (6 LOC)

**Types / Interfaces / Enums**
- interface `MountOptions`

---

## `Generation/Biome/Biomes.ts` (376 LOC)

**Module-level functions**
- `export function getBiomeFor(temperature: number, humidity: number, continentalness: number, river: number, terrainShapedHeight: number): Biome`

---

## `Generation/Biome/BiomeTypes.ts` (55 LOC)

**Types / Interfaces / Enums**
- interface `Biome`
- type `TreeDefinition`
- enum `BIOME_ID`

---

## `Generation/Biome/TreeDefinition.ts` (482 LOC)

**Module-level functions**
- `function packXYZ(x: number, y: number, z: number): number`
- `export function generateSlinkyTree(worldX: number, worldY: number, worldZ: number, placeBlock: (
		x: number,
		y: number,
		z: number,
		blockId: number,
		overwrite?: boolean,
	) => void, seedAsInt: number, woodId: number, leavesId: number, baseHeight: number, heightVariance: number): void`
- `function placeWood(x: number, y: number, z: number): void`
- `export function generateBigTopBentOak(worldX: number, worldY: number, worldZ: number, placeBlock: (
		x: number,
		y: number,
		z: number,
		blockId: number,
		overwrite?: boolean,
	) => void, seedAsInt: number, woodId: number, leavesId: number, baseHeight: number, heightVariance: number): void`
- `function placeWood(x: number, y: number, z: number): void`

---

## `Generation/DistantTerrain/DistantTerrain.ts` (379 LOC)

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
- `#sharedPositions: Int16Array`
- `#sharedNormals: Int8Array`
- `#sharedSurfaceTiles: Uint8Array`
- `#gridOrigin: unknown`
- `#positionVB?: VertexBuffer`
- `#normalVB?: VertexBuffer`

**Methods**
- `private createEmptyGridMesh(name: string, scene: Scene): Mesh`
- `private bindDiffuseTexture(): void`
- `private bindCommonUniforms(effect: Effect, scene: Scene): void`
- `public update(centerChunkX: number, centerChunkZ: number): void`
- `private applyTerrainData(positions: Int16Array, normals: Int8Array, surfaceTiles: Uint8Array, centerChunkX: number, centerChunkZ: number): void`

---

## `Generation/DistantTerrain/DistantTerrainGenerator.ts` (375 LOC)

### export class DistantTerrainGenerator

**Properties**
- `private static readonly DEFAULT_TILE_X: unknown`
- `private static readonly DEFAULT_TILE_Y: unknown`
- `private static readonly INSIDE_CLIP_Y: unknown`
- `private static positions?: Int16Array`
- `private static normals?: Int8Array`
- `private static surfaceTiles?: Uint8Array`
- `private static lastGridCenterChunkX: unknown`
- `private static lastGridCenterChunkZ: unknown`
- `private static lastCenterChunkX: unknown`
- `private static lastCenterChunkZ: unknown`
- `private static rowSize: unknown`
- `private static segments: unknown`
- `private static gridStep: unknown`
- `private static radius: unknown`
- `private static usingSharedBuffers: unknown`

**Methods**
- `public static initSharedBuffers(positionsBuffer: SharedArrayBuffer, normalsBuffer: SharedArrayBuffer, surfaceTilesBuffer: SharedArrayBuffer, radius: number, gridStep: number): void`
- `public static generate(centerChunkX: number, centerChunkZ: number, radius: number, renderDistance: number, gridStep: number, forceFullRebuild: unknown = false): { positions: Int16Array<ArrayBufferLike>; normals: Int8Array<ArrayBufferLike>; surfaceTiles: Uint8Array<ArrayBufferLike>; centerChunkX: number; centerChunkZ: number; }`
- `private static ensureBuffers(radius: number, gridStep: number): void`
- `private static configureGrid(radius: number, gridStep: number): void`
- `private static allocateLocalBuffers(): void`
- `private static resetTracking(): void`
- `private static fullGenerate(gridCenterChunkX: number, gridCenterChunkZ: number, centerChunkX: number, centerChunkZ: number, renderDistance: number): void`
- `private static slideArrays(shiftX: number, shiftZ: number): void`
- `private static regenerateEdges(shiftX: number, shiftZ: number, gridCenterChunkX: number, gridCenterChunkZ: number, centerChunkX: number, centerChunkZ: number, renderDistance: number): void`
- `private static rewriteLocalXZ(centerChunkX: number, centerChunkZ: number, gridCenterChunkX: number, gridCenterChunkZ: number): void`
- `private static generateVertex(x: number, z: number, gridCenterChunkX: number, gridCenterChunkZ: number, centerChunkX: number, centerChunkZ: number, renderDistance: number): void`
- `private static getTopTileForBlock(blockId: number): [number, number]`

---

## `Generation/LightGenerator.ts` (366 LOC)

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
- `private static readonly SKYLIGHT_GENERATION_MIN_WORLD_Y: unknown`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, _biome: Biome, blocks: Uint8Array, light: Uint8Array, topSunlightMask?: Uint8Array): void`
- `public seedInitialLight(chunkX: number, chunkY: number, chunkZ: number, _biome: Biome, blocks: Uint8Array, light: Uint8Array, topSunlightMask?: Uint8Array): LightSeedState`
- `public propagateLight(blocks: Uint8Array, light: Uint8Array, seedState: LightSeedState): void`
- `private seedInitialLightIntoSharedQueue(chunkX: number, chunkY: number, chunkZ: number, blocks: Uint8Array, light: Uint8Array, topSunlightMask?: Uint8Array): number`
- `private propagateLightFromQueue(blocks: Uint8Array, light: Uint8Array, queue: Uint16Array, initialTail: number): void`
- `private tryPropagate(nx: number, ny: number, nz: number, targetSky: number, targetBlock: number, sourceBlockId: number, isDown: boolean, blocks: Uint8Array, light: Uint8Array, queue: Uint16Array, tail: number, CHUNK_SIZE: number, CHUNK_SIZE_SQ: number): number`
- `private static isTransparentBlock(blockId: number): boolean`
- `private static filtersFullSunlight(blockId: number): boolean`
- `private columnReceivesDirectSun(worldX: number, worldZ: number, topWorldY: number): boolean`

**Module-level functions**
- `function nextPowerOfTwo(n: number): number`

**Types / Interfaces / Enums**
- type `LightSeedState`

---

## `Generation/NoiseAndParameters/FastNoise/FastNoiseFactory.ts` (77 LOC)

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

## `Generation/NoiseAndParameters/FastNoise/FastNoiseLite.ts` (2834 LOC)

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
- `private _activeSingleR2: SingleNoiseFn2`
- `private _activeSingleR3: SingleNoiseFn3`
- `private _activeR2: NoiseFn2`
- `private _activeR3: NoiseFn3`
- `private readonly F2: unknown`
- `private readonly F3: unknown`
- `private readonly G3: unknown`
- `private readonly H3: unknown`
- `private _Gradients2D: unknown`
- `private _RandVecs2D: unknown`
- `private _Gradients3D: unknown`
- `private _RandVecs3D: unknown`
- `private _PrimeX: unknown`
- `private _PrimeY: unknown`
- `private _PrimeZ: unknown`
- `private readonly S: unknown`
- `private readonly G2: unknown`
- `private readonly G2_2: unknown`
- `private readonly C1: unknown`
- `private readonly C2: unknown`
- `private readonly NORM: unknown`

**Methods**
- `private _updateRuntimeFunctions(): void`
- `private _updateSinglePointers(): void`
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
- `public GetNoise2D(x: number, y: number): number`
- `public GetNoise3D(x: number, y: number, z: number): number`
- `public GetNoise(x: number, y: number, z?: number): number`
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

## `Generation/NoiseAndParameters/GenerationParams.ts` (20 LOC)

**Types / Interfaces / Enums**
- type `GenerationParamsType`

---

## `Generation/NoiseAndParameters/NoiseSampler.ts` (79 LOC)

### export class NoiseSampler

**Constructor**
- `constructor(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number, sampleRate: number, scale: number, xzFactor: number, noiseFunction: (x: number, y: number, z: number) => number)`

**Properties**
- `private noiseSamples: Float32Array`
- `private sampleRate: number`
- `private pointsPerDim: number`

**Methods**
- `public get(localX: number, localY: number, localZ: number): number`

---

## `Generation/NoiseAndParameters/Spline.ts` (30 LOC)

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

## `Generation/NoiseAndParameters/Squirrel13.ts` (28 LOC)

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

## `Generation/RiverGeneration.ts` (58 LOC)

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

## `Generation/Structure/DungeonFeature.ts` (160 LOC)

### export class DungeonFeature implements IWorldFeature

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number): void`
- `private carveCorridor(x1: number, x2: number, z1: number, z2: number, yBase: number, placeBlock: any, floorBlock: number, minX: number, maxX: number, minZ: number, maxZ: number): void`

---

## `Generation/Structure/IWorldFeature.ts` (20 LOC)

**Types / Interfaces / Enums**
- interface `IWorldFeature`

---

## `Generation/Structure/LavaPoolFeature.ts` (132 LOC)

### export class LavaPoolFeature implements IWorldFeature

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number): void`
- `private generateLavaPool(chunkX: number, chunkY: number, chunkZ: number, poolCenterX: number, poolCenterY: number, poolCenterZ: number, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number): void`

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
- `public place(originX: number, originY: number, originZ: number, placeBlock: PlaceBlockFunction): void`

**Types / Interfaces / Enums**
- interface `StructureData`
- type `PlaceBlockFunction`

---

## `Generation/Structure/StructureFeature.ts` (108 LOC)

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
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number): void`

---

## `Generation/Structure/TowerFeature.ts` (207 LOC)

### export class TowerFeature implements IWorldFeature

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number): void`
- `private generateCylinderTower(chunkX: number, chunkY: number, chunkZ: number, towerCenterX: number, towerCenterZ: number, towerRadius: number, groundHeight: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, chunkSize: number, seed: number): void`
- `private generateUndergroundCylinderTower(chunkX: number, chunkY: number, chunkZ: number, towerCenterX: number, towerCenterZ: number, towerRadius: number, groundHeight: number, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, chunkSize: number): void`
- `private findMinGroundHeightForTower(towerCenterX: number, towerCenterZ: number, towerRadius: number, biome: Biome): number`

---

## `Generation/SurfaceGenerator.ts` (764 LOC)

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
- `private static readonly MAX_TREE_HEIGHT: unknown`
- `private static readonly MAX_STRUCTURE_ABOVE_SURFACE: unknown`
- `private static readonly MAX_STRUCTURE_BELOW_SURFACE: unknown`
- `private static seedAsInt: number`
- `private static readonly MAX_COLUMN_PREPASS_CACHE: unknown`
- `private static readonly columnPrepassCache: unknown`
- `private static readonly columnPrepassFifo: bigint[]`
- `private static readonly MAX_FLORA_COLUMN_CACHE: unknown`
- `private static readonly floraColumnCache: unknown`
- `private static readonly floraColumnCacheFifo: bigint[]`
- `private chunk_size: number`
- `private riverGenerator: RiverGenerator`
- `private features: IWorldFeature[]`

**Methods**
- `private packXZKey(x: number, z: number): bigint`
- `private getColumnPrepassKey(chunkX: number, chunkZ: number): bigint`
- `private getOrBuildColumnPrepass(chunkX: number, chunkZ: number): ColumnPrepassCacheEntry`
- `private getFloraColumnKey(worldX: number, worldZ: number): bigint`
- `private getOrBuildFloraColumnInfo(worldX: number, worldZ: number, knownTopSurfaceY?: number): FloraColumnCacheEntry`
- `private chunkIntersectsVerticalBand(chunkMinY: number, chunkMaxY: number, bandMinY: number, bandMaxY: number): boolean`
- `public generate(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow?: boolean,
		) => void): SurfaceGenerationResult`
- `private resolveSolidBlockId(currentBiome: Biome, worldX: number, worldZ: number, worldY: number, depthBelowSurface: number): number`
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
- `private isBeachLocation(worldX: number, worldZ: number, terrainHeight: number): boolean`
- `private isNearWater(x: number, z: number): boolean`
- `private getDensity(x: number, y: number, z: number, baseHeight: number, yFreq: number, cachedCliffNoise: number): number`
- `private sampleCliffNoise(x: number, baseHeight: number, z: number): number`
- `private findTopSurfaceY(worldX: number, worldZ: number, baseHeight: number, yFreq: number): number`

**Types / Interfaces / Enums**
- type `SurfaceGenerationResult`
- type `ColumnPrepassCacheEntry`
- type `FloraColumnCacheEntry`

---

## `Generation/TerrainHeightMap.ts` (177 LOC)

### class LRUCache

**Constructor**
- `constructor(maxSize: number)`

**Properties**
- `private map: unknown`

**Methods**
- `get(key: K): V | undefined`
- `set(key: K, value: V): void`

**Module-level functions**
- `function getChunkSample(worldX: number, worldZ: number): ChunkTerrainSample`
- `export function getFinalTerrainHeight(x: number, z: number): number`
- `export function getBiome(x: number, z: number): Biome`
- `export function getCachedRiverNoise(x: number, z: number): number`
- `export function getOctaveNoise(x: number, z: number): number`
- `function computeDetail(x: number, z: number, riverAbs: number): number`

**Types / Interfaces / Enums**
- type `ChunkTerrainSample`

---

## `Generation/UndergroundGenerator.ts` (50 LOC)

### export class UndergroundGenerator

**Constructor**
- `constructor(params: GenerationParamsType, caveNoise: (x: number, y: number, z: number) => number)`

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

## `Generation/WorldGenerator.ts` (164 LOC)

### export class WorldGenerator

**Constructor**
- `constructor(params: GenerationParamsType)`

**Properties**
- `private static readonly FLOOR_Y: unknown`
- `private static readonly FLOOR_BLOCK_ID: unknown`
- `private params: GenerationParamsType`
- `private prng: ReturnType<typeof Alea>`
- `private seedAsInt: number`
- `private chunkSizeSq: number`
- `private chunk_size: number`
- `private chunkVolume: number`
- `private surfaceGenerator: SurfaceGenerator`
- `private undergroundGenerator: UndergroundGenerator`
- `private lightGenerator: LightGenerator`

**Methods**
- `private createBuffer(size: number): Uint8Array`
- `private enforceGlobalFloor(chunkWorldY: number, blocks: Uint8Array, chunkSize: number, chunkSizeSq: number): void`
- `public generateChunkData(chunkX: number, chunkY: number, chunkZ: number, options: GenerateChunkOptions = {}): GenerateChunkResult`

**Types / Interfaces / Enums**
- type `GenerateChunkOptions`
- type `GenerateChunkResult`

---

## `Inferface/IControls.ts` (9 LOC)

**Types / Interfaces / Enums**
- interface `IControls`

---

## `Inferface/IMountable.ts` (6 LOC)

**Types / Interfaces / Enums**
- interface `IMountable`

---

## `Inferface/IUsable.ts` (4 LOC)

**Types / Interfaces / Enums**
- interface `IUsable`

---

## `Maps/BlockBreakParticles.ts` (147 LOC)

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

## `Maps/Map1.ts` (103 LOC)

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

---

## `Maps/MapFog.ts` (34 LOC)

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

## `Maps/UnderWaterEffect.ts` (330 LOC)

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
- `private static readonly BACKGROUND_POST_PROCESS_VERTEX_SHADER: string`
- `private update: unknown`

**Methods**
- `private registerShaders(): void`
- `private createShaderMaterial(baseTexture: BABYLON.Texture): BABYLON.ShaderMaterial`
- `private createPostProcess(): BABYLON.PostProcess`
- `public dispose(): void`

---

## `Maps/WorldEnvironment.ts` (147 LOC)

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

## `Player/Controls/CustomBoatControls.ts` (163 LOC)

### export class CustomBoatControls implements IControls<BoatControlEntity>

**Constructor**
- `constructor(paddleBoat: BoatControlEntity, player: Player)`

**Properties**
- `public pressedKeys: unknown`
- `#controlledEntity: BoatControlEntity`
- `#inputDirection: Vector3`
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
- `#updateMovementAxesFromPressedKeys(): void`
- `#tick(): void`
- `#handleForwardBack(forward: Vector3, position: Vector3): void`
- `#handleLeftRight(forward: Vector3, position: Vector3, angularLeftWorld: Vector3, angularRightWorld: Vector3): void`
- `#pressedKeysHas(keys: string[]): boolean`
- `public update(): void`

**Types / Interfaces / Enums**
- type `BoatControlEntity`

---

## `Player/Controls/DebugControlHelper.ts` (27 LOC)

### export class DebugControlHelper

**Properties**
- `public static KEY_F2: unknown`
- `public static KEY_F3: unknown`
- `public static KEY_F4: unknown`

**Methods**
- `public static handleKey(key: string): boolean`

---

## `Player/Controls/InventoryControls.ts` (78 LOC)

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

## `Player/Controls/JetSkiControls.ts` (173 LOC)

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

## `Player/Controls/PaddleBoatControls.ts` (181 LOC)

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

## `Player/Controls/WalkingControls.ts` (283 LOC)

### export class WalkingControls implements IControls<PlayerVehicle>

**Constructor**
- `constructor(player: Player)`

**Properties**
- `public pressedKeys: unknown`
- `#controlledEntity: PlayerVehicle`
- `#inputDirection: Vector3`
- `#player: Player`
- `#blockBreaking: BlockBreakingHandler`
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
- `public static KEY_PRINT_TRACE: unknown`
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
- `#handlePickBlock(key: string): void`
- `#pressedKeysHas(keys: string[]): boolean`
- `#updateMovementAxesFromPressedKeys(): void`

---

## `Player/Crafting/CraftingManager.ts` (21 LOC)

**Types / Interfaces / Enums**
- interface `Ingredient`
- interface `Recipe`

---

## `Player/Hud/BlockHighlight/BlockBreakingVisuals.ts` (204 LOC)

**Module-level functions**
- `export function initializeBlockBreakingVisuals(targetScene: Scene): void`
- `export function disposeBlockBreakingVisuals(): void`
- `export function updateCrackingState(block: { x: number; y: number; z: number } | null, progress: number, blockId?: number, blockState: unknown = 0, dynamicContext: unknown = null): void`
- `function createUnitCrackingMesh(): Mesh`
- `function bakeLocalOffset(mesh: Mesh): void`
- `function buildCrackingMeshForBlock(blockId: number, blockState: number): Mesh`
- `function ensureCrackingShape(blockId: number, blockState: number): void`
- `function applyCrackingTransform(block: { x: number; y: number; z: number }, dynamicContext: unknown): void`
- `function asBoatBlockContext(context: unknown): BoatBlockHitContext | null`

---

## `Player/Hud/BlockHighlight/BlockHighlight.ts` (183 LOC)

### export class BlockHighlight

**Constructor**
- `constructor(scene: Scene)`

**Properties**
- `readonly #scene: Scene`
- `readonly #material: StandardMaterial`
- `#mesh: Mesh`
- `#shapeKey: unknown`
- `#currentHit: BlockRaycastHit | null`

**Methods**
- `#update(): void`
- `setHit(hit: BlockRaycastHit | null): void`
- `#ensureShape(blockId: number, blockState: number): void`
- `#applyHitTransform(hit: BlockRaycastHit): void`
- `#asBoatBlockContext(context: unknown): BoatBlockHitContext | null`
- `#buildForBlock(blockId: number, blockState: number): Mesh`
- `#buildUnitCube(): Mesh`
- `#bakeAndReset(mesh: Mesh): void`
- `#configure(mesh: Mesh): void`
- `#createMaterial(): StandardMaterial`

---

## `Player/Hud/BlockHighlight/BlockRaycaster.ts` (630 LOC)

**Module-level functions**
- `function getForwardRay(player: Player, length: number): Ray`
- `function isTargetableBlock(blockId: number): boolean`
- `function isFullBlockShape(blockId: number, blockState: number): boolean`
- `function intersectRayAabb(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, tMin: number, tMax: number, fallbackNx: number, fallbackNy: number, fallbackNz: number): FaceHit | null`
- `function raycastShapeInVoxel(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, vx: number, vy: number, vz: number, blockId: number, blockState: number, tEnter: number, tExit: number, fallbackNx: number, fallbackNy: number, fallbackNz: number): FaceHit | null`
- `function raycastFirstBlock(player: Player, shouldHit: (x: number, y: number, z: number, blockId: number) => boolean): BlockRaycastHit | null`
- `function raycastFirstTerrainBlock(player: Player, shouldHit: (x: number, y: number, z: number, blockId: number) => boolean): BlockRaycastHit | null`
- `function raycastFirstBoatBlock(player: Player, shouldHit: (x: number, y: number, z: number, blockId: number) => boolean): BlockRaycastHit | null`
- `function raycastSingleBoatChunk(ray: Ray, boatChunk: BoatChunk, shouldHit: (x: number, y: number, z: number, blockId: number) => boolean): {
	t: number;
	x: number;
	y: number;
	z: number;
	nx: number;
	ny: number;
	nz: number;
	blockId: number;
	blockState: number;
	context: unknown;
} | null`
- `export function pickTarget(player: Player): BlockRaycastHit | null`
- `export function pickWaterTarget(player: Player): BlockRaycastHit | null`
- `export function pickBlock(player: Player): number | null`
- `export function getPlacementPosition(player: Player): Vector3 | null`
- `export function getPlacementHit(player: Player): PlacementHit | null`

**Types / Interfaces / Enums**
- type `BlockRaycastHit`
- type `FaceHit`
- type `PlacementHit`

---

## `Player/Hud/BlockHighlight/BreakinBlockHandler.ts` (186 LOC)

### export class BlockBreakingHandler

**Constructor**
- `constructor(player: Player)`

**Properties**
- `#player: Player`
- `#active: unknown`
- `#breakingBlock: { x: number; y: number; z: number } | null`
- `#breakingTargetKey: unknown`
- `#breakTimer: unknown`

**Methods**
- `public start(): void`
- `public stop(): void`
- `public reset(): void`
- `public update(): void`
- `#asBoatBlockContext(context: unknown): BoatBlockHitContext | null`
- `#getBreakingTargetKey(hit: {
		x: number;
		y: number;
		z: number;
		dynamicContext?: unknown;
	}): string`
- `#breakBlock(x: number, y: number, z: number, blockId: number, packedLight: number, dynamicContext: unknown): void`

**Types / Interfaces / Enums**
- type `BoatBlockHitContext`

---

## `Player/Hud/Crosshair/CrossHair.ts` (116 LOC)

### export class CrossHair

**Constructor**
- `constructor(engine: Engine, scene: Scene, player: Player)`

**Properties**
- `readonly #ui: CrosshairUI`
- `readonly #highlight: BlockHighlight`
- `readonly #player: Player`

**Methods**
- `setCrosshair(id: string): void`
- `showHitMarker(): void`
- `static pickBlock(player: Player): number | null`
- `static pickTarget(player: Player): Vector3 | null`
- `static pickWaterPlacementTarget(player: Player): Vector3 | null`
- `static getPlacementPosition(player: Player): Vector3 | null`
- `static getPlacementHit(player: Player): PlacementHit | null`
- `static pickUsableMesh(player: Player, maxDistance: unknown = REACH_DISTANCE): AbstractMesh | null`
- `static #rayMarchFirstMesh(player: Player, maxDistance: number, predicate?: (mesh: AbstractMesh) => boolean): AbstractMesh | null`

**Module-level functions**
- `function isInsideBounds(mesh: AbstractMesh, point: Vector3): boolean`

---

## `Player/Hud/Crosshair/CrosshairUI.ts` (42 LOC)

### export class CrosshairUI

**Constructor**
- `constructor(engine: Engine, scene: Scene, initialCrosshairId: unknown = "179")`

**Properties**
- `readonly #engine: Engine`
- `readonly #scene: Scene`
- `readonly #ui: GUI.AdvancedDynamicTexture`
- `#crosshair: GUI.Image`
- `#hitMarker: GUI.Image`

**Methods**
- `setCrosshair(id: string): void`
- `showHitMarker(): void`
- `#addImage(name: string, source: string, size: string, alpha: number): GUI.Image`

---

## `Player/Hud/DebugPanel.ts` (43 LOC)

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

## `Player/Hud/PauseMenu.ts` (330 LOC)

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

## `Player/Hud/PlayerHud.ts` (503 LOC)

### export class PlayerHud

**Constructor**
- `constructor(engine: Engine, scene: Scene, player: Player)`

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

## `Player/Inventory/DroppedItem.ts` (231 LOC)

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
- `#atlasTileTexture: Texture | null`
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
- `#getOrCreateAtlasTexture(): Texture`
- `#applyAtlasTexture(item: Item): void`

---

## `Player/Inventory/Item.ts` (277 LOC)

### export class Item implements IUsable

**Constructor**
- `constructor(name: string, description: string, icon: string, row: number, col: number, maxStack?: number)`

**Properties**
- `private static readonly SLICE_SHAPE_ROTATION_POLICY: Record<
		string,
		{ rotateVerticalByYaw: boolean }
	>`
- `name: string`
- `description: string`
- `icon: string`
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
- `static #asBoatPlacementContext(context: unknown): BoatPlacementContext | null`
- `createDiv(): HTMLDivElement`
- `private static getWallRotationFromYaw(yaw: number): number`
- `public refreshIconStyle(): void`
- `public static stackItemAtoB(itemA: Item, itemB: Item): number`

**Types / Interfaces / Enums**
- type `BoatPlacementContext`

---

## `Player/Inventory/ItemRegistry.ts` (96 LOC)

### export class ItemRegistry

**Properties**
- `private static initialized: unknown`
- `private static loadPromise: Promise<void> | null`
- `private static definitions: unknown`

**Methods**
- `private static toDisplayName(rawName: string): string`
- `static initDefaults(): void`
- `static async ensureLoaded(url: unknown = DEFAULT_ITEMS_URL): Promise<void>`
- `static async loadFromUrl(url: string): Promise<void>`
- `static register(def: ItemDefinition): void`
- `static get(id: number): ItemDefinition | undefined`
- `static getAll(): ItemDefinition[]`
- `private static isValidDefinition(value: unknown): value is ItemDefinition`

**Types / Interfaces / Enums**
- type `ItemDefinition`

---

## `Player/Inventory/ItemSlot.ts` (85 LOC)

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

## `Player/Inventory/ItemUseActions.ts` (53 LOC)

**Types / Interfaces / Enums**
- type `ItemUseAction`

---

## `Player/Inventory/PlayerInventory.ts` (354 LOC)

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
- `#generateFakeItems(): void`
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

## `Player/Player.ts` (120 LOC)

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

## `Player/PlayerBody.ts` (44 LOC)

### export class PlayerBodyControlState

**Properties**
- `public readonly inputDirection: unknown`
- `public wantJump: unknown`
- `public isSprinting: unknown`
- `public isFlying: unknown`
- `public isJumpHeld: unknown`

**Methods**
- `public reset(): void`

**Types / Interfaces / Enums**
- interface `IPlayerBody`
- type `SavedBodyPosition`

---

## `Player/PlayerCamera.ts` (88 LOC)

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

## `Player/PlayerFlashLight.ts` (38 LOC)

### export class PlayerFlashLight

**Constructor**
- `constructor(scene: Scene, playerCamera: FreeCamera)`

**Properties**
- `#flashlight: SpotLight`
- `#camera: FreeCamera`

**Methods**
- `public toggle(): void`

---

## `Player/PlayerInputController.ts` (83 LOC)

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

## `Player/PlayerLoadingGate.ts` (90 LOC)

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

## `Player/PlayerLoopController.ts` (177 LOC)

### export class PlayerLoopController

**Constructor**
- `constructor(engine: Engine, scene: Scene, playerVehicle: IPlayerBody, playerStats: PlayerStats, playerHud: PlayerHud, playerCamera: PlayerCamera, getKeyboardControls: () => IControls<unknown>, getPlayerPosition: () => Vector3)`

**Properties**
- `#lastChunkX: unknown`
- `#lastChunkY: unknown`
- `#lastChunkZ: unknown`
- `static readonly DEBUG_HUD_INTERVAL_MS: unknown`

**Methods**
- `public bind(): void`
- `private updateControls(): void`
- `private updateChunksAroundPlayer(): void`
- `private updateDebugHud(): void`
- `private getDirectionFromYaw(yaw: number): string`

---

## `Player/PlayerStatePersistence.ts` (165 LOC)

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

## `Player/PlayerStats.ts` (74 LOC)

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

## `Player/PlayerVehicle.ts` (93 LOC)

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

## `Player/PlayerVehicleMotor.ts` (986 LOC)

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
- `#characterOrientation: unknown`
- `#characterGravity: unknown`
- `#characterGravityLen: unknown`
- `#movementLocked: unknown`
- `#lockedPosition: Vector3 | null`
- `readonly #zeroVelocity: unknown`
- `private state: PlayerState`
- `#collisionBoat: CustomBoat | null`
- `readonly #boatLocalPos: unknown`
- `readonly #boatLocalVel: unknown`
- `readonly #boatSupportLocal: unknown`
- `#supportBoat: CustomBoat | null`
- `#lastBoatSupportMs: unknown`
- `private readonly boatSupportGraceMs: unknown`
- `readonly #tmp0: unknown`
- `readonly #tmp1: unknown`
- `readonly #tmp2: unknown`
- `readonly #tmp3: unknown`
- `readonly #tmp4: unknown`
- `readonly #tmp5: unknown`
- `readonly #tmp6: unknown`
- `readonly #tmp7: unknown`
- `readonly #tmp8: unknown`
- `readonly #tmpDesiredH: unknown`
- `readonly #tmpCurH: unknown`
- `readonly #tmpNextH: unknown`
- `readonly #tmpDv: unknown`
- `readonly #tmpV: unknown`
- `readonly #tmpInv: unknown`
- `readonly boatVoxelCollider: VoxelAabbCollider`
- `private readonly voxelCollider: VoxelAabbCollider`
- `private voxelPosition: unknown`
- `private voxelVelocity: unknown`
- `private voxelIsGrounded: unknown`
- `private lastStepUpTime: unknown`
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
- `private readonly colliderHalfWidthProbe: number`
- `private readonly colliderHalfWidthWater: number`
- `private readonly stepUpCooldownMs: number`
- `private readonly jumpImpulse: number`
- `private readonly _groundProbeOffsets: ReadonlyArray<
		readonly [number, number]
	>`
- `private readonly _waterYOffsets: ReadonlyArray<number>`
- `private readonly _waterXZOffsets: ReadonlyArray<readonly [number, number]>`

**Accessors**
- `public get characterController(): SimpleCharacterController`
- `public get displayCapsule(): Mesh`
- `public get isMovementLocked(): boolean`
- `private get inputDirection(): Vector3`
- `private get wantJump(): number`
- `private set wantJump(v: number)`
- `private get isSprinting(): boolean`
- `private get isFlying(): boolean`
- `private get isJumpHeld(): boolean`

**Methods**
- `private isOnBoat(): boolean`
- `#toBoatLocal(world: Vector3, _yaw: number, out: Vector3): void`
- `#toWorld(local: Vector3, _yaw: number, out: Vector3): void`
- `#resolveEntryOverlap(): void`
- `#flushToWorld(): void`
- `#applyBoatMotion(): void`
- `#updateSupportBoat(): void`
- `#syncBoatMode(): void`
- `#getDesiredVelocity(speed: number, boatYaw: number | null, out: Vector3): void`
- `#sweepAxis(pos: Vector3, vel: Vector3, collider: VoxelAabbCollider, axis: Axis, delta: number): void`
- `#attemptStepUp(pos: Vector3, vel: Vector3, collider: VoxelAabbCollider, axis: Axis.X | Axis.Z, delta: number): boolean`
- `#moveAxis(pos: Vector3, vel: Vector3, collider: VoxelAabbCollider, axis: Axis, delta: number): void`
- `#checkGrounded(pos: Vector3, collider: VoxelAabbCollider): boolean`
- `#isInsideBoatObb(boat: CustomBoat): boolean`
- `private integrateVoxelMovementStep(deltaTime: number): void`
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
- `private integrateVoxelMovement(deltaTime: number): void`
- `private calculateFlyingVelocity(deltaTime: number): Vector3`
- `private calculateDesiredVelocity(deltaTime: number, supportInfo: CharacterSurfaceInfo): Vector3`
- `private determineNextState(si: CharacterSurfaceInfo): PlayerState`
- `private calculateInAirVelocity(dt: number, cur: Vector3): Vector3`
- `private calculateOnGroundVelocity(cur: Vector3, si: CharacterSurfaceInfo): Vector3`
- `private calculateJumpVelocity(cur: Vector3, prev: PlayerState): Vector3`
- `private accelerateInto(cur: Vector3, tgt: Vector3, maxA: number, dt: number, out: Vector3): Vector3`
- `private isInWater(): boolean`
- `private isValidSavedPosition(p: unknown): p is SavedBodyPosition`
- `private getPositionInternal(): Vector3`
- `private getVelocityInternal(): Vector3`
- `private setVelocityInternal(v: Vector3): void`

**Types / Interfaces / Enums**
- type `PlayerVehicleMotorOptions`
- enum `PlayerState`

---

## `Player/SimpleCharacterController.ts` (54 LOC)

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
- `public checkSupport(): CharacterSurfaceInfo`
- `public integrate(deltaTime: number, gravity: Vector3): void`

**Types / Interfaces / Enums**
- type `CharacterSurfaceInfo`
- enum `CharacterSupportedState`

---

## `Server/MyConnection.ts` (30 LOC)

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

## `TestScene.ts` (57 LOC)

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

## `World/BlockEncoding.ts` (26 LOC)

**Module-level functions**
- `export function packBlockValue(blockId: number, state: unknown = 0): number`
- `export function unpackBlockId(value: number): number`
- `export function unpackBlockState(value: number): number`
- `export function packRotationSlice(rotation: number, slice: number): number`
- `export function unpackRotation(state: number): number`
- `export function unpackSlice(state: number): number`

---

## `World/BlockType.ts` (87 LOC)

**Module-level functions**
- `export function isPassThroughBlock(blockId: number): boolean`
- `export function isCollidableBlock(blockId: number): boolean`

**Types / Interfaces / Enums**
- enum `BlockType`

---

## `World/Boat/BoatChunk.ts` (414 LOC)

### export class BoatChunk

**Constructor**
- `constructor(scene: Scene, blocks: BoatChunkBlock[], center: Vector3)`

**Properties**
- `private static activeChunks: unknown`
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
- `#blockChangeListeners: unknown`

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
- `public isInsideLocalBounds(x: number, y: number, z: number): boolean`
- `public getBlockStateLocal(x: number, y: number, z: number): number`
- `public getBlockPackedLocal(x: number, y: number, z: number): number`
- `public getLightLocal(x: number, y: number, z: number): number`
- `public setBlockPackedLocal(x: number, y: number, z: number, packedBlock: number): void`
- `public setBlockLocal(x: number, y: number, z: number, blockId: number, blockState: unknown = 0): void`
- `public setLightLocal(x: number, y: number, z: number, packedLight: number): void`
- `public worldToLocalBlock(worldPosition: Vector3): Vector3`
- `public localToWorldCenter(x: number, y: number, z: number): Vector3`
- `public getOccupiedBoundsLocal(): | {
				minX: number;
				minY: number;
				minZ: number;
				maxX: number;
				maxY: number;
				maxZ: number;
		  }
		| null`
- `public onBlockChanged(listener: BoatChunkBlockChangeListener): () => void`
- `public toSnapshot(): { blocks: BoatChunkBlock[]; center: Vector3 }`
- `public dispose(): void`
- `private createEmptyLightArray(): Uint8Array`
- `public static getActiveChunks(): ReadonlySet<BoatChunk>`
- `#emitBlockChanged(localX: number, localY: number, localZ: number, blockId: number, blockState: number): void`

**Types / Interfaces / Enums**
- type `BoatChunkBlock`
- type `ChunkCoords`
- type `BoatChunkBlockChangeListener`

---

## `World/Boat/BoatCreatorSystem.ts` (282 LOC)

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

## `World/Chunk/ChunckMesher.ts` (758 LOC)

**Module-level functions**
- `function ensureMeshMetadata(mesh: Mesh): Record<string, unknown>`
- `function getMeshLodLevel(mesh: Mesh | null): number | null`
- `function setMeshLodLevel(mesh: Mesh, lod: number): void`
- `function getMeshFadeState(mesh: Mesh): LodCrossFadeState | null`
- `function clearMeshFadeState(mesh: Mesh): void`
- `function setMeshFadeState(mesh: Mesh, state: LodCrossFadeState): void`
- `function makeFadeSeed(chunk: Chunk): number`
- `function beginLodCrossFade(chunk: Chunk, oldMesh: Mesh | null, newMesh: Mesh | null): void`
- `function shouldUseLodCrossFade(previousLod: number | null, nextLod: number): boolean`
- `function getMeshFadeUniforms(mesh: Mesh | undefined): typeof scratchFadeUniforms`
- `function updateLodCrossFades(nowMs: number): void`
- `function applyLodShaderBindings(material: ShaderMaterial): void`
- `function ensureSharedFacePositionBuffer(): void`
- `function getFaceBufferLengths(mesh: Mesh): Record<string, number>`
- `function upsertFaceVertexBuffer(mesh: Mesh, engine: ReturnType<typeof Map1.mainScene.getEngine>, kind: string, data: Uint8Array): void`
- `function upsertMesh(chunk: Chunk, existingMesh: Mesh | null, meshData: MeshData, name: string, material: Material, renderingGroupId: unknown = 1): Mesh`
- `function createCachedTexture(url: string, scene: Scene, args: any): Texture`
- `async function loadTextureToCache(url: string): Promise<string>`
- `export function initAtlas(): void`
- `export function createMeshFromData(chunk: Chunk, meshData: { opaque: MeshData | null; transparent: MeshData | null }): void`
- `export function updateGlobalUniforms(frameId: number): void`
- `export function disposeSharedResources(): void`

**Types / Interfaces / Enums**
- type `LodCrossFadeState`

---

## `World/Chunk/Chunk.ts` (1243 LOC)

### class LightQueue

**Properties**
- `readonly chunks: unknown`
- `readonly coords: unknown`
- `readonly levels: unknown`
- `head: unknown`
- `tail: unknown`

**Accessors**
- `get length(): number`

**Methods**
- `clear(): void`
- `push(chunk: Chunk, x: number, y: number, z: number, level: number): void`

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
- `public isLightDirty: unknown`
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
- `private static readonly EMPTY_LIGHT_ARRAY: unknown`
- `public cachedLODMeshes: unknown`
- `public isLODMeshCacheDirty: unknown`
- `private static remeshFlushScheduled: unknown`
- `private static remeshQueue: unknown`
- `private static remeshQueueSet: unknown`
- `public static readonly LIGHT_EMISSION: Record<number, number>`

**Accessors**
- `get block_array(): Uint8Array | Uint16Array | null`
- `get palette(): Uint16Array | null`
- `get isUniform(): boolean`
- `get uniformBlockId(): number`
- `get hasVoxelData(): boolean`
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
- `public getBlockLight(lx: number, ly: number, lz: number): number`
- `public getSkyLight(lx: number, ly: number, lz: number): number`
- `public getLight(lx: number, ly: number, lz: number): number`
- `public setLight(x: number, y: number, z: number, level: number): void`
- `public setBlockLight(x: number, y: number, z: number, level: number): void`
- `public setSkyLight(x: number, y: number, z: number, level: number): void`
- `public getBlock(lx: number, ly: number, lz: number): number`
- `public getBlockState(lx: number, ly: number, lz: number): number`
- `public getBlockPacked(lx: number, ly: number, lz: number): number`
- `private static flushRemeshQueue(): void`
- `public setBlock(localX: number, localY: number, localZ: number, blockId: number, state: unknown = 0): void`
- `public deleteBlock(localX: number, localY: number, localZ: number): void`
- `public addLight(x: number, y: number, z: number, level: number): void`
- `public propagateLight(queue: Array<{
			chunk: Chunk;
			x: number;
			y: number;
			z: number;
			level: number;
		}>, isSkyLight: unknown = true): void`
- `public propagateDeferredLight(seedState: {
		queue: Uint16Array;
		length: number;
	}): void`
- `public updateLightFromNeighbors(x: number, y: number, z: number, isSkyLight: unknown = false): void`
- `private processLightPropagationQueue(q: LightQueue, isSkyLight: boolean): void`
- `public removeLight(x: number, y: number, z: number, isSkyLight: unknown = false, sourcePackedOverride?: number): void`
- `private cutSkyLightBelow(localX: number, localY: number, localZ: number): void`
- `public scheduleRemesh(priority: unknown = false, includeNeighbors: unknown = false): void`
- `public getNeighbor(dx: number, dy: number, dz: number): Chunk | undefined`
- `public markLightChanged(): void`
- `public needsPersistence(): boolean`
- `private static filtersFullSunlight(blockId: number): boolean`
- `private static getClosedFaceMaskForPacked(blockPacked: number): number`
- `private static pushRectFlat(f: number, u0: number, u1: number, v0: number, v1: number): void`
- `private static doesFlatRectsCoverUnitSquare(f: number): boolean`
- `private static insertionSortEdges(start: number, len: number): void`
- `private static dedupeEdges(start: number, len: number): number`
- `private static getFaceBit(axis: number, dir: number): number`
- `private isTransparent(blockPacked: number, axis?: number, dir?: number): boolean`
- `private static applySliceStateToBoxForLight(min: [number, number, number], max: [number, number, number], state: number): { min: [number, number, number]; max: [number, number, number] }`
- `public dispose(): void`

**Module-level functions**
- `export function packCoords(x: number, y: number, z: number): bigint`
- `export function getChunk(cx: number, cy: number, cz: number): Chunk | undefined`

**Types / Interfaces / Enums**
- type `CachedLODMesh`
- type `SerializedLODMeshCache`

---

## `World/Chunk/chunk.worker.ts` (110 LOC)

**Module-level functions**
- `function compressBlocks(blocks: Uint8Array): {
	isUniform: boolean;
	uniformBlockId: number;
	palette: Uint16Array | null;
	packedBlocks: Uint8Array | Uint16Array | null;
}`

---

## `World/Chunk/ChunkLoadingSystem.ts` (834 LOC)

**Module-level functions**
- `function isEntityAlive(entity: ChunkBoundEntity): boolean`
- `function getEntityChunkId(entity: ChunkBoundEntity): bigint | null`
- `function serializeEntityForReload(entity: ChunkBoundEntity): SavedChunkEntityData | null`
- `function getConfiguredBatchSize(configuredValue: number, fallbackValue: number): number`
- `function getLoadBatchSize(): number`
- `function getUnloadBatchSize(): number`
- `function getProcessFrameBudgetMs(): number`
- `function getNeighbors(chunk: Chunk): (Chunk | undefined)[]`
- `function getReusableMeshData(opaque: MeshData | null, transparent: MeshData | null): { opaque: MeshData | null; transparent: MeshData | null }`
- `function resolveSavedMeshSelection(savedData: SavedChunkData, targetLod: number): ResolvedSavedMeshSelection`
- `function applyMeshToChunk(chunk: Chunk, mesh: SelectedSavedMesh | null): void`
- `function restoreChunkLodCache(chunk: Chunk, savedData: SavedChunkData): void`
- `function refreshQueueDebugSnapshot(): void`
- `export function getDebugStats(): ChunkLoadingDebugStats`
- `function buildQueuedIdSet(): Set<bigint>`
- `function ensureChunkLoadedHook(): void`
- `export function validateChunksAround(centerChunkX: number, centerChunkY: number, centerChunkZ: number, horizontalRadius: unknown = SETTING_PARAMS.RENDER_DISTANCE, verticalRadius: unknown = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE): void`
- `function scheduleChunkBorderRemeshOnLoad(chunk: Chunk): void`
- `export function enqueueChunkRemesh(chunk: Chunk): void`
- `export function processPendingRemeshes(maxChunks: unknown = 12): void`
- `export function processFrameBudgetedStreamingWork(playerChunkX: number, playerChunkY: number, playerChunkZ: number): void`
- `export function registerChunkEntityLoader(type: string, loader: (payload: unknown, chunk: Chunk) => void): void`
- `export function registerChunkBoundEntity(entity: ChunkBoundEntity): symbol`
- `export function unregisterChunkBoundEntity(handle: symbol | undefined): void`
- `export function registerDynamicBlockProvider(provider: DynamicBlockProvider, mutator?: DynamicBlockMutator): symbol`
- `export function unregisterDynamicBlockProvider(handle: symbol | undefined): void`
- `function sampleDynamicBlock(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): DynamicBlockSample | null`
- `function tryMutateDynamicBlock(worldX: number, worldY: number, worldZ: number, blockId: number, blockState: number): boolean`
- `async function unloadChunkBoundEntitiesForChunkImpl(chunk: Chunk): Promise<void>`
- `export function flushModifiedChunks(maxChunks: unknown = getUnloadBatchSize()): Promise<void>`
- `export function flushChunkBoundEntities(): Promise<void>`
- `function scheduleChunkAndNeighborsRemesh(chunk: Chunk): void`
- `export async function updateChunksAround(chunkX: number, chunkY: number, chunkZ: number, renderDistance: unknown = SETTING_PARAMS.RENDER_DISTANCE, verticalRadius: unknown = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE, prevChunkX?: number, prevChunkY?: number, prevChunkZ?: number): Promise<void>`
- `function updateSliceDebugStats(state: InFlightProcessState): void`
- `function finalizeProcessState(state: InFlightProcessState): void`
- `function applyHydratedChunkFromSavedData(chunk: Chunk, savedData: SavedChunkData): void`
- `function loadFarLodChunk(state: InFlightProcessState, chunk: Chunk, selectedMesh: SelectedSavedMesh | null, hasDesiredMesh: boolean): void`
- `function loadNearLodChunk(chunk: Chunk, savedData: SavedChunkData, selectedMesh: SelectedSavedMesh | null, hasDesiredMesh: boolean, hasExactDesiredMesh: boolean, targetLod: number): void`
- `function applyLoadedChunkFromSavedData(state: InFlightProcessState, request: QueuedChunkRequest, savedData: SavedChunkData): void`
- `export function deleteBlock(worldX: number, worldY: number, worldZ: number): void`
- `export function setBlock(worldX: number, worldY: number, worldZ: number, blockId: number, state: unknown = 0): void`
- `export function getBlockByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): number`
- `export function getTerrainBlockByWorldCoords(worldX: number, worldY: number, worldZ: number): number`
- `export function getBlockStateByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): number`
- `export function getLightByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): number`
- `export function areChunksLoadedAround(chunkX: number, chunkY: number, chunkZ: number, horizontalRadius: unknown = 1, verticalRadius: unknown = 0): boolean`
- `export function areChunksLod0ReadyAround(chunkX: number, chunkY: number, chunkZ: number, horizontalRadius: unknown = 1, verticalRadius: unknown = 0): boolean`
- `function collectChunkEntityPayloads(): ReadonlyMap<
	bigint,
	SavedChunkEntityData[]
>`
- `export function worldToChunkCoord(value: number): number`
- `export function worldToBlockCoord(value: number): number`

**Types / Interfaces / Enums**
- type `ResolvedSavedMeshSelection`
- type `DynamicBlockSample`
- type `DynamicBlockProvider`
- type `DynamicBlockMutator`
- type `DynamicBlockProviderEntry`
- type `DynamicBlockQueryOptions`

---

## `World/Chunk/chunkWorker.ts` (189 LOC)

### export class ChunkWorker

**Constructor**
- `constructor(onMessageTerrain: (event: MessageEvent<WorkerResponseData>) => void, onMessageMesh: (event: MessageEvent<MeshWorkerResponse>) => void)`

**Properties**
- `private terrainWorker: Worker`
- `private voxelWorker: Worker`
- `private waterWorker: Worker`
- `private warnedNonSharedRemeshPayload: unknown`
- `private distantTerrainSharedInitialized: unknown`
- `private static readonly EMPTY_NEIGHBOR_BLOCKS: unknown`
- `private static readonly EMPTY_NEIGHBOR_LIGHTS: unknown`
- `private readonly paletteToTyped: unknown`

**Methods**
- `public setOnError(handler: (ev: ErrorEvent | Event) => void): void`
- `public terminate(): void`
- `public postFullRemesh(chunk: Chunk, forcedLod?: number): void`
- `public postTerrainGeneration(chunk: Chunk, deferLighting: boolean = true): void`
- `public initDistantTerrainShared(positionsBuffer: SharedArrayBuffer, normalsBuffer: SharedArrayBuffer, surfaceTilesBuffer: SharedArrayBuffer, radius: number, gridStep: number): void`
- `public postGenerateDistantTerrain(requestId: number, centerChunkX: number, centerChunkZ: number, radius: number, renderDistance: number, gridStep: number): void`

---

## `World/Chunk/ChunkWorkerPool.ts` (1054 LOC)

### export class ChunkWorkerPool

**Constructor**
- `constructor(poolSize: number)`

**Properties**
- `private static instance: ChunkWorkerPool`
- `private static readonly WORKER_ERROR_COOLDOWN_MS: unknown`
- `private workers: ChunkWorker[]`
- `private workerTaskContext: Array<{
		taskType: "terrain" | "remesh" | "lodPrecompute" | "distantTerrain";
		chunk?: Chunk;
		lod?: number;
		distantTask?: DistantTerrainTask;
		terrainDeferLighting?: boolean;
	} | null>`
- `private distantTerrainSharedInit: {
		positionsBuffer: SharedArrayBuffer;
		normalsBuffer: SharedArrayBuffer;
		surfaceTilesBuffer: SharedArrayBuffer;
		radius: number;
		gridStep: number;
	} | null`
- `private workerRestartAtMs: number[]`
- `private taskQueue: Chunk[]`
- `private pendingRemeshQueue: Map<Chunk, boolean>`
- `private pendingRemeshSet: Set<Chunk>`
- `private terrainTaskDeferLighting: unknown`
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
- `private inFlightRemeshKeys: unknown`
- `private rerunRemeshAfterInflight: unknown`
- `private distantTerrainInFlight: unknown`
- `private nextDistantTerrainRequestId: unknown`
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
- `private normalizeChunkIdToBigInt(chunkId: unknown): bigint | undefined`
- `private getRemeshInflightKey(chunkId: bigint, lod: number): string`
- `private isSameLodRemeshInflight(chunk: Chunk): boolean`
- `private clearInflightRemeshByMessage(chunkId: unknown, lod: number): void`
- `private handleWorkerFailure(workerIndex: number, reason: unknown): void`
- `private isCompletelyEmptyChunk(chunk: Chunk): boolean`
- `private clearChunkMeshIfPresent(chunk: Chunk): void`
- `public static getInstance(poolSize: unknown = navigator.hardwareConcurrency || 4): ChunkWorkerPool`
- `public scheduleRemesh(chunk: Chunk | undefined, priority: unknown = false): void`
- `private scheduleRemeshFlush(): void`
- `private flushPendingRemeshQueue(): void`
- `private storeReturnedLODMesh(chunk: Chunk, lod: number, opaque: MeshData | null, transparent: MeshData | null): void`
- `public scheduleDistantTerrain(centerChunkX: number, centerChunkZ: number, radius: number, renderDistance: number, gridStep: number): void`
- `private tryApplyCachedLODMesh(chunk: Chunk, allowDirtyReuse: unknown = false): boolean`
- `private makeTerrainMessageHandler(workerIndex: number, getWorker: () => ChunkWorker | undefined): (event: MessageEvent<WorkerResponseData>) => void`
- `private makeMeshMessageHandler(workerIndex: number, getWorker: () => ChunkWorker | undefined): (event: MessageEvent<MeshWorkerResponse>) => void`
- `private getChunkLodLevel(chunk: Chunk | undefined): number`
- `private compareRemeshPriority(aChunk: Chunk, aPriority: boolean, bChunk: Chunk, bPriority: boolean): number`
- `private dequeueNextTerrainChunk(): Chunk | undefined`
- `private insertChunkIntoRemeshQueue(chunk: Chunk, priority: boolean): void`
- `public scheduleTerrainGeneration(chunk: Chunk, deferLighting: boolean = true): void`
- `public scheduleTerrainGenerationBatch(chunks: Chunk[], deferLighting: boolean = true): void`
- `private getQueuedTerrainDeferLighting(chunk: Chunk): boolean`
- `private getLodPrecomputeKey(chunk: Chunk, lod: number): string`
- `private dispatchTerrainTaskToWorker(workerIndex: number, worker: ChunkWorker, chunk: Chunk): boolean`
- `public scheduleBackgroundLodPrecompute(centerChunkX: number, centerChunkY: number, centerChunkZ: number): void`
- `private scheduleChunkAndNeighborsRemesh(chunk: Chunk): void`
- `private hasStableVoxelNeighborsForCachedMesh(chunk: Chunk): boolean`
- `private maybeRemeshNeighborsNowStable(chunk: Chunk): void`
- `public initDistantTerrainShared(positionsBuffer: SharedArrayBuffer, normalsBuffer: SharedArrayBuffer, surfaceTilesBuffer: SharedArrayBuffer, radius: number, gridStep: number): void`
- `private processQueue(): void`

**Types / Interfaces / Enums**
- type `WorkerMessageData`
- type `ChunkWorkerPoolDebugStats`

---

## `World/Chunk/DataStructures/MeshData.ts` (41 LOC)

### export class MeshData

**Properties**
- `faceDataA: Uint8Array`
- `faceDataB: Uint8Array`
- `faceDataC: Uint8Array`
- `faceCount: unknown`

**Methods**
- `public static deserialize(data: any): MeshData`

---

## `World/Chunk/DataStructures/PaletteExpander.ts` (37 LOC)

### export class PaletteExpander

**Methods**
- `expandPalette(packed: Uint8Array, palette: ArrayLike<number>, totalBlocks: number): Uint8Array | Uint16Array`
- `isUint16(palette: ArrayLike<number> | null | undefined): boolean`

---

## `World/Chunk/DataStructures/ResizableTypedArray.ts` (131 LOC)

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
- `bulkPush(src: T): void`

---

## `World/Chunk/DataStructures/SparseVoxelOctree.ts` (147 LOC)

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

## `World/Chunk/DataStructures/WorkerInternalMeshData.ts` (7 LOC)

**Types / Interfaces / Enums**
- type `WorkerInternalMeshData`

---

## `World/Chunk/DataStructures/WorkerMessageType.ts` (102 LOC)

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
- type `FullMeshMessage`
- type `TerrainGeneratedMessage`
- type `DistantTerrainGeneratedMessage`
- type `WorkerResponseData`
- type `MeshWorkerResponse`
- enum `WorkerTaskType`

---

## `World/Chunk/Loading/ChunkEntityRegistry.ts` (127 LOC)

### export class ChunkEntityRegistry

**Constructor**
- `constructor(adapter: ChunkBoundEntityAdapter<TEntity>)`

**Properties**
- `private readonly entities: unknown`
- `private readonly pendingReloads: unknown`
- `private readonly loaders: unknown`
- `private restoringChunkEntities: unknown`
- `private chunkLoadedHookInstalled: unknown`
- `private previousChunkLoadedHook: ((chunk: Chunk) => void) | null`

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

## `World/Chunk/Loading/ChunkHydration.ts` (159 LOC)

### export class ChunkHydration

**Constructor**
- `constructor(adapter: ChunkHydrationAdapter)`

**Methods**
- `public tryGetSavedMeshForLod(savedData: SavedChunkData, lod: number, out: SelectedSavedMesh): boolean`
- `public getSavedMeshForLod(savedData: SavedChunkData, lod: number): SelectedSavedMesh | null`
- `private pickBestAvailableLod(availableLods: readonly number[], desiredLod: number): number`
- `public tryPickBestSavedMesh(savedData: SavedChunkData, desiredLod: number, out: SelectedSavedMesh): boolean`
- `public pickBestSavedMesh(savedData: SavedChunkData, desiredLod: number): SelectedSavedMesh | null`
- `public applyHydratedChunkFromSavedData(chunk: Chunk, savedData: SavedChunkData, scheduleRemesh: unknown = false): void`
- `public applyLoadedChunkFromSavedData(chunk: Chunk, savedData: SavedChunkData, desiredLod: number, scheduleRemesh: unknown = false): SelectedSavedMesh | null`
- `public applySelectedMeshDataToChunk(chunk: Chunk, selectedMesh: SelectedSavedMesh | null): void`

**Types / Interfaces / Enums**
- interface `SelectedSavedMesh`
- interface `HydrationStoragePayload`
- interface `ChunkHydrationAdapter`

---

## `World/Chunk/Loading/ChunkLoadingDebug.ts` (120 LOC)

### export class ChunkLoadingDebug

**Constructor**
- `constructor(adapter: ChunkLoadingDebugAdapter = {})`

**Properties**
- `private stats: ChunkLoadingDebugStats`

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

## `World/Chunk/Loading/ChunkPersistenceCoordinator.ts` (136 LOC)

### export class ChunkPersistenceCoordinator

**Constructor**
- `constructor(adapter: ChunkPersistenceCoordinatorAdapter)`

**Properties**
- `private flushPromise: Promise<void> | null`
- `private pendingFlushRequested: unknown`
- `private entityFlushPromise: Promise<void> | null`
- `private pendingEntityFlushRequested: unknown`
- `private readonly lastPersistedEntityChunkIds: unknown`
- `private readonly _modifiedChunksScratch: Chunk[]`
- `private readonly _candidateChunkIdsScratch: bigint[]`
- `private readonly _seenChunkIdsScratch: unknown`

**Methods**
- `public async flushModifiedChunks(maxChunks: number = this.getChunkSaveBatchSize()): Promise<void>`
- `public async flushChunkBoundEntities(maxChunks: number = this.getChunkEntitySaveBatchSize()): Promise<void>`
- `public getLastPersistedEntityChunkIds(): ReadonlySet<bigint>`
- `private getChunkSaveBatchSize(): number`
- `private getChunkEntitySaveBatchSize(): number`
- `private async flushModifiedChunksInternal(maxChunks: number): Promise<void>`
- `private async flushChunkBoundEntitiesInternal(maxChunks: number): Promise<void>`

**Types / Interfaces / Enums**
- interface `ChunkPersistenceCoordinatorAdapter`

---

## `World/Chunk/Loading/ChunkProcessScheduler.ts` (424 LOC)

### export class ChunkProcessScheduler

**Constructor**
- `constructor(adapter: ChunkProcessSchedulerAdapter)`

**Properties**
- `private isProcessing: unknown`
- `private inFlightProcessState: InFlightProcessState | null`
- `private _state: InFlightProcessState`
- `private processContinuationScheduled: unknown`

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
- `constructor(adapter: ChunkQueueManagerAdapter = {})`

**Properties**
- `private readonly loadQueue: Chunk[]`
- `private readonly loadQueueSet: unknown`
- `private readonly unloadQueueSet: unknown`

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
- `public snapshot(): {
		loadQueue: readonly Chunk[];
		unloadQueue: readonly Chunk[];
	}`
- `public refreshQueueDebugSnapshot(): void`

**Types / Interfaces / Enums**
- interface `ChunkQueueManagerAdapter`
- interface `ChunkQueueBatch`

---

## `World/Chunk/Loading/ChunkReadinessAdapter.ts` (63 LOC)

### export class ChunkReadiness

**Constructor**
- `constructor(adapter: ChunkReadinessAdapter = {})`

**Methods**
- `public areChunksLoadedAround(chunkX: number, chunkY: number, chunkZ: number, horizontalRadius: number = 1, verticalRadius: number = 0): boolean`
- `public areChunksLod0ReadyAround(chunkX: number, chunkY: number, chunkZ: number, horizontalRadius: number = 1, verticalRadius: number = 0): boolean`
- `private isLoaded(chunk: Chunk): boolean`
- `private isLod0Ready(chunk: Chunk): boolean`

**Types / Interfaces / Enums**
- interface `ChunkReadinessAdapter`

---

## `World/Chunk/Loading/ChunkStreamingController.ts` (594 LOC)

### export class ChunkStreamingController

**Constructor**
- `constructor(adapter: ChunkStreamingControllerAdapter)`

**Properties**
- `private distantTerrain: DistantTerrain | null`
- `private static readonly DESIRED_STATE_REVISION_RETENTION: unknown`
- `private streamRevision: unknown`
- `private desiredStates: unknown`
- `private loadQueueRequestMap: Map<bigint, QueuedChunkRequest>`
- `private loadedRefreshQueue: Chunk[]`
- `private loadedRefreshQueueSet: Set<bigint>`
- `private loadedRefreshQueueHead: unknown`

**Methods**
- `public getDesiredState(chunkId: bigint): DesiredChunkState | undefined`
- `public async updateChunksAround(chunkX: number, chunkY: number, chunkZ: number, renderDistance: unknown = SETTING_PARAMS.RENDER_DISTANCE, verticalRadius: unknown = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE, prevChunkX?: number, prevChunkY?: number, prevChunkZ?: number): Promise<void>`
- `private enqueueLoadedChunksForRefresh(chunkX: number, chunkY: number, chunkZ: number, lodRuleSet: ChunkLodRuleSet): void`
- `public processLoadedRefreshQueue(playerChunkX: number, playerChunkY: number, playerChunkZ: number, renderDistance: unknown = SETTING_PARAMS.RENDER_DISTANCE, verticalRadius: unknown = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE, maxChunks: unknown = 8): void`
- `private dequeueLoadedRefreshChunk(): Chunk | undefined`
- `public processTargetChunkCoordinate(x: number, y: number, z: number, playerChunkX: number, playerChunkY: number, playerChunkZ: number, lodRuleSet: ChunkLodRuleSet): void`
- `private processMovementRings(chunkX: number, chunkY: number, chunkZ: number, prevChunkX: number, prevChunkY: number, prevChunkZ: number, lodRuleSet: ChunkLodRuleSet): void`
- `private processInitialShell(chunkX: number, chunkY: number, chunkZ: number, lodRuleSet: ChunkLodRuleSet): void`
- `public queueUnloading(chunkX: number, chunkY: number, chunkZ: number, renderDistance: number, verticalRadius: number): void`
- `public tryApplyCachedLodTransitionMesh(chunk: Chunk, targetLod: number): boolean`
- `public ensureChunkQueuedForLoad(chunk: Chunk, desiredLod: number, revision: number, includeVoxelData: unknown = desiredLod <= 1): void`
- `public onLoadRequestsDequeued(requests: ReadonlyArray<QueuedChunkRequest>): void`
- `public onChunkDisposed(chunkId: bigint): void`
- `private sortLoadQueue(playerChunkX: number, playerChunkY: number, playerChunkZ: number): void`
- `private computePriority(chunk: Chunk, desiredLod: number, playerChunkX: number, playerChunkY: number, playerChunkZ: number): number`

**Types / Interfaces / Enums**
- interface `ChunkStreamingControllerAdapter`
- type `QueuedChunkRequest`
- type `DesiredChunkState`

---

## `World/Chunk/Loading/ChunkTypes.ts` (70 LOC)

**Types / Interfaces / Enums**
- type `ChunkBoundEntity`
- type `InFlightProcessState`
- type `ChunkLoadingDebugStats`
- enum `ProcessStage`

---

## `World/Chunk/Loading/ChunkWorldMutations.ts` (187 LOC)

### export class ChunkWorldMutations

**Constructor**
- `constructor(adapter: ChunkWorldMutationsAdapter = {})`

**Methods**
- `public getBlockByWorldCoords(worldX: number, worldY: number, worldZ: number): number`
- `public getLightByWorldCoords(worldX: number, worldY: number, worldZ: number): number`
- `public setBlock(worldX: number, worldY: number, worldZ: number, blockId: number, state: number = 0): boolean`
- `public deleteBlock(worldX: number, worldY: number, worldZ: number): boolean`
- `private isBoundaryLocalCoord(localX: number, localY: number, localZ: number): boolean`

**Module-level functions**
- `export function toLocalBlockCoordinates(worldX: number, worldY: number, worldZ: number): LocalBlockCoordinates`
- `export function getBlockStateByWorldCoords(worldX: number, worldY: number, worldZ: number): number`

**Types / Interfaces / Enums**
- interface `WorldBlockCoordinates`
- interface `LocalBlockCoordinates`
- interface `BlockMutationContext`
- interface `ChunkWorldMutationsAdapter`

---

## `World/Chunk/LOD/ChunkLodRules.ts` (223 LOC)

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
- `public resolveWithHysteresis(target: ChunkLodCoordinates, player: ChunkLodCoordinates, previousLod: number | null | undefined): ChunkLodDecision`

**Types / Interfaces / Enums**
- interface `ChunkLodCreationRule`
- type `ChunkLodCoordinates`
- type `ChunkLodRadii`
- type `ChunkLodDistance`
- type `ChunkLodDecision`

---

## `World/Chunk/LOD/LodCacheVersion.ts` (11 LOC)

**Module-level functions**
- `export function getCurrentLodCacheVersion(): string`

---

## `World/Chunk/voxel.worker.ts` (140 LOC)

**Module-level functions**
- `function expandBlockPayload(raw: Uint8Array | Uint16Array | null | undefined, palette: Uint8Array | Uint16Array | null | undefined, uniformBlockId: number | undefined, totalBlocks: number, paletteExpander: PaletteExpander): Uint8Array | Uint16Array`
- `function expandVoxelPayload(request: VoxelWorkerRequest): WorkerMeshInput`

**Types / Interfaces / Enums**
- interface `VoxelWorkerRequest`

---

## `World/Chunk/water.worker.ts` (42 LOC)

**Types / Interfaces / Enums**
- interface `WaterWorkerRequest`

---

## `World/Chunk/Worker/ChunkMesherConstants.ts` (51 LOC)

---

## `World/Chunk/Worker/WorkerTaskHandlers.ts` (152 LOC)

### export class WorkerTaskHandlers

**Methods**
- `public static handleGenerateTerrain(request: GenerateTerrainRequest, deps: { generator: WorldGenerator; compressBlocks: CompressBlocksFn }): { payload: TerrainGeneratedMessage; transferables: Transferable[] }`
- `public static handleInitDistantTerrainShared(request: {
		positionsBuffer: SharedArrayBuffer;
		normalsBuffer: SharedArrayBuffer;
		surfaceTilesBuffer: SharedArrayBuffer;
		radius: number;
		gridStep: number;
	}): { payload: { type: number }; transferables: Transferable[] }`
- `public static handleGenerateDistantTerrain(request: GenerateDistantTerrainRequest): {
		payload: {
			type: number;
			requestId: number;
			centerChunkX: number;
			centerChunkZ: number;
		};
		transferables: Transferable[];
	}`

**Module-level functions**
- `function pushTransferable(transferables: Transferable[], view: ArrayBufferView | null | undefined, label: string): void`

**Types / Interfaces / Enums**
- type `MeshBuilderLike`
- type `CompressBlocksFn`

---

## `World/Collision/VoxelAabbCollider.ts` (272 LOC)

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

**Module-level functions**
- `function rotateShapeBoxY(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, rotation: number, out: [number, number, number, number, number, number]): void`

**Types / Interfaces / Enums**
- type `BlockShapeInfo`
- type `IsSolidBlockAt`
- type `VoxelAabbDebugOptions`
- enum `Axis`

---

## `World/Collision/VoxelObbCollider.ts` (223 LOC)

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
- `public setHalfExtents(halfExtents: Vector3): void`
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

## `World/GLOBAL_VALUES.ts` (13 LOC)

---

## `World/Light/DistantTerrainShader.ts` (163 LOC)

### export class DistantTerrainShader

**Properties**
- `static readonly distantTerrainVertexShader: unknown`
- `static readonly distantTerrainFragmentShader: unknown`
- `static readonly distantWaterVertexShader: unknown`
- `static readonly distantWaterFragmentShader: unknown`

---

## `World/Light/Lod2Shader.ts` (338 LOC)

### export class Lod2Shader

**Properties**
- `static readonly chunkVertexShader: unknown`
- `static readonly opaqueFragmentShader: unknown`
- `static readonly transparentFragmentShader: unknown`

---

## `World/Light/Lod3Shader.ts` (307 LOC)

### export class Lod3Shader

**Properties**
- `public static readonly chunkVertexShader: unknown`
- `public static readonly opaqueFragmentShader: unknown`
- `public static readonly transparentFragmentShader: unknown`

---

## `World/Light/OpaqueShader.ts` (211 LOC)

### export class OpaqueShader

**Properties**
- `static readonly chunkVertexShader: unknown`
- `static readonly chunkFragmentShader: unknown`

---

## `World/Light/SkyShader.ts` (35 LOC)

### export class SkyShader

**Properties**
- `static readonly skyVertexShader: unknown`
- `static readonly skyFragmentShader: unknown`

---

## `World/Light/TransparentShader.ts` (268 LOC)

### export class TransparentShader

**Properties**
- `public static readonly chunkVertexShader: unknown`
- `public static readonly chunkFragmentShader: unknown`

---

## `World/MeshPipeline/core/AOPipeline.ts` (111 LOC)

**Module-level functions**
- `export function isOccluder(packedBlock: number, shape: BlockShapeInfo): boolean`
- `export function computeAO(ctx: MeshContext, faceX: number, faceY: number, faceZ: number, uAxis: number, vAxis: number): number`

---

## `World/MeshPipeline/core/BlockFlags.ts` (69 LOC)

**Module-level functions**
- `function canUseDenseCache(packed: number): boolean`
- `export function getCachedBlockId(packed: number): number`
- `export function getCachedFlags(packed: number): number`

---

## `World/MeshPipeline/core/CustomShapeEmitter.ts` (431 LOC)

**Module-level functions**
- `function parseBlock(packed: number): ParsedBlock`
- `function getFaceName(axis: number, isBackFace: boolean): string`
- `function getFaceBit(axis: number, isBackFace: boolean): number`
- `function isWaterGlassInterface(curr: ParsedBlock, nbr: ParsedBlock): boolean`
- `export function emitCustomShapes(ctx: MeshContext, opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`
- `function emitCrossShapeAtBlock(x: number, y: number, z: number, blockId: number, baseLight: number, materialType: MaterialType = MaterialType.Cutout, out: WorkerInternalMeshData): void`
- `function emitCrossDiagonalAtBlock(x: number, y: number, z: number, blockId: number, baseLight: number, materialType: MaterialType = MaterialType.Cutout, out: WorkerInternalMeshData): void`
- `function emitBoxFace(ctx: MeshContext, voxelX: number, voxelY: number, voxelZ: number, blockId: number, packedBlock: number, box: {
		min: [number, number, number];
		max: [number, number, number];
		faceMask: number;
	}, axis: number, isBackFace: boolean, baseLight: number, out: WorkerInternalMeshData): void`

**Types / Interfaces / Enums**
- type `ParsedBlock`
- type `FaceDescriptor`

---

## `World/MeshPipeline/core/FaceEmitter.ts` (56 LOC)

**Module-level functions**
- `export function emitQuad(out: WorkerInternalMeshData, params: EmitQuadParams): void`

---

## `World/MeshPipeline/core/GreedyPipeline.ts` (91 LOC)

**Module-level functions**
- `function ensureScratchCapacity(area: number): {
	mask: Int32Array;
	lights: Uint16Array;
}`
- `export function greedyMesh(ctx: MeshContext, extractMask: MaskExtractor, emitFace: FaceEmitterCallback): void`

**Types / Interfaces / Enums**
- type `WritableNumberArray`
- type `MaskExtractor`
- type `FaceEmitterCallback`

---

## `World/MeshPipeline/core/LightPipeline.ts` (36 LOC)

**Module-level functions**
- `export function quantizeNibble(v: number): number`
- `export function quantizeLightForLOD(packed: number, disableAO: boolean): number`
- `export function mergeLight(currLight: number, neighborLight: number, isPartialCurrent: boolean, isPartialNeighbor: boolean): number`
- `export function getPackedLightByte(ctx: MeshContext, x: number, y: number, z: number): number`

---

## `World/MeshPipeline/core/MeshAssembler.ts` (14 LOC)

**Module-level functions**
- `export function mergeMeshData(target: WorkerInternalMeshData, source: WorkerInternalMeshData): void`

---

## `World/MeshPipeline/core/MeshContext.ts` (12 LOC)

**Module-level functions**
- `export function createMeshContext(params: {
	size: number;
	lod: number;
}): Omit<MeshContext, "getBlock" | "getLight" | "hasNeighborChunk">`

---

## `World/MeshPipeline/core/MeshEmitters.ts` (36 LOC)

**Module-level functions**
- `export function createEmptyMeshData(): WorkerInternalMeshData`
- `export function buildVoxelMesh(ctx: MeshContext, opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`
- `export function buildWaterSurfaceMesh(ctx: MeshContext, grid: WaterSampleGrid, out: WorkerInternalMeshData): void`

---

## `World/MeshPipeline/core/ShapePipeline.ts` (330 LOC)

**Module-level functions**
- `function canUseDenseCache(packedBlock: number): boolean`
- `export function getMaterialTintBucket(blockId: number): number`
- `export function getMaterialType(blockId: number): MaterialType`
- `export function getMaterialTypeForPackedBlock(packedBlock: number): MaterialType`
- `export function getPackedBlockParts(packedBlock: number): {
	blockId: number;
	blockState: number;
}`
- `export function getShapeNameForPackedBlock(packedBlock: number): string`
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
- type `FaceRect`

---

## `World/MeshPipeline/core/VoxelFaceEmitterAdapter.ts` (241 LOC)

### export class VoxelFaceEmitterAdapter

**Methods**
- `public emitVoxelFace(axis: number, desc: GreedyFaceDescriptor, opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`
- `public getFaceName(axis: number, isBackFace: boolean): string`
- `private emitCubeFace(out: WorkerInternalMeshData, axis: number, desc: GreedyFaceDescriptor, blockId: number, materialType: MaterialType, isBackFace: boolean, light: number, ao: number): void`
- `private emitCustomShapeFace(out: WorkerInternalMeshData, axis: number, desc: GreedyFaceDescriptor, packedBlock: number, blockId: number, materialType: MaterialType, isBackFace: boolean, light: number, ao: number): void`
- `private toWorldBlockOrigin(axis: number, desc: GreedyFaceDescriptor, isBackFace: boolean): { x: number; y: number; z: number }`
- `private getFaceBit(axis: number, isBackFace: boolean): number`
- `private computeFaceRect(axis: number, isBackFace: boolean, box: {
			min: [number, number, number];
			max: [number, number, number];
			faceMask: number;
		}, baseX: number, baseY: number, baseZ: number, greedyWidth: number, greedyHeight: number): FaceRect3D | null`

**Types / Interfaces / Enums**
- type `FaceRect3D`

---

## `World/MeshPipeline/core/VoxelGreedyAdapter.ts` (43 LOC)

### export class VoxelGreedyAdapter

**Constructor**
- `constructor(ctx: MeshContext)`

**Properties**
- `private ctx: MeshContext`
- `private maskExtractor: VoxelMaskExtractor`
- `private faceEmitter: VoxelFaceEmitterAdapter`

**Methods**
- `public build(opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`
- `private runForAxis(axis: number, opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`

---

## `World/MeshPipeline/core/VoxelMaskExtractor.ts` (439 LOC)

### export class VoxelMaskExtractor

**Constructor**
- `constructor(ctx: MeshContext)`

**Properties**
- `private ctx: MeshContext`

**Methods**
- `private getCurrentFaceBit(axis: number): number`
- `private getNeighborFaceBit(axis: number): number`
- `private clearSlice(mask: WritableNumberArray, lightMask: WritableNumberArray, size: number): void`
- `private processCell(bx: number, by: number, bz: number, dx: number, dy: number, dz: number, uAxis: number, vAxis: number, currentFaceBit: number, neighborFaceBit: number, outIndex: number, mask: WritableNumberArray, lightMask: WritableNumberArray): void`
- `private extractSliceMaskX(slice: number, mask: WritableNumberArray, lightMask: WritableNumberArray): void`
- `private extractSliceMaskY(slice: number, mask: WritableNumberArray, lightMask: WritableNumberArray): void`
- `private extractSliceMaskZ(slice: number, mask: WritableNumberArray, lightMask: WritableNumberArray): void`
- `public extractSliceMask(axis: number, slice: number, mask: WritableNumberArray, lightMask: WritableNumberArray): void`

**Module-level functions**
- `function getCachedBlockId(packed: number): number`
- `function getCachedFlags(packed: number): number`

**Types / Interfaces / Enums**
- type `WritableNumberArray`

---

## `World/MeshPipeline/core/VoxelPipeline.ts` (23 LOC)

### export class VoxelPipeline

**Constructor**
- `constructor(ctx: MeshContext)`

**Properties**
- `private ctx: MeshContext`

**Methods**
- `public build(opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`

**Types / Interfaces / Enums**
- interface `VoxelPipelineInput`

---

## `World/MeshPipeline/core/WaterPipeline.ts` (105 LOC)

**Module-level functions**
- `export function buildWaterMesh(_ctx: MeshContext, grid: WaterSampleGrid, out: WorkerInternalMeshData): void`

**Types / Interfaces / Enums**
- interface `WaterSurfaceSample`
- interface `WaterSampleGrid`

---

## `World/MeshPipeline/core/WorkerMeshHelpers.ts` (177 LOC)

**Module-level functions**
- `export function createEmptyWorkerInternalMeshData(): WorkerInternalMeshData`
- `export function toTransferableMeshData(data: WorkerInternalMeshData): MeshData`
- `function getNeighborIndex(dx: number, dy: number, dz: number): number`
- `export function createMeshContextFromPayload(base: WorkerMeshBaseContext, input: WorkerMeshInput): MeshContext`

**Types / Interfaces / Enums**
- type `WorkerMeshBaseContext`
- type `WorkerMeshInput`
- type `NeighborSample`

---

## `World/MeshPipeline/types/MeshTypes.ts` (87 LOC)

**Types / Interfaces / Enums**
- interface `WorkerInternalMeshData`
- interface `ResizableTypedArray`
- interface `MeshContext`
- interface `EmitQuadParams`
- interface `BlockShapeInfo`
- interface `GreedyFaceDescriptor`
- enum `MaterialType`

---

## `World/SETTINGS_PARAMS.ts` (24 LOC)

---

## `World/Shape/BlockShapes.ts` (161 LOC)

**Types / Interfaces / Enums**
- type `ShapeBox`
- type `ShapeDefinition`
- type `RawShapeBox`
- type `RawShapeDefinition`
- type `RawBlockDefinition`

---

## `World/Shape/BlockShapeTransforms.ts` (216 LOC)

**Types / Interfaces / Enums**
- type `ShapeBounds`

---

## `World/Texture/BlockTextures.ts` (86 LOC)

**Module-level functions**
- `export function getAtlasTile(blockId: number | null): [number, number] | null`

**Types / Interfaces / Enums**
- type `BlockTextureDef`

---

## `World/Texture/MaterialFactory.ts` (111 LOC)

### export class MaterialFactory

**Properties**
- `private static materialCache: unknown`

**Methods**
- `private static createTexture(scene: Scene, path: string, uvScale: number): Texture`
- `static createMaterialByFolder(scene: Scene, folder: string, uvScale: unknown = 1, extension: unknown = ".png", diff: unknown = true, nor: unknown = false, ao: unknown = false, spec: unknown = false): StandardMaterial`
- `private static buildMaterial(scene: Scene, mat: StandardMaterial, directory: string, baseName: string, resolution: string, extension: string, uvScale: number, diff: boolean, nor: boolean, ao: boolean, spec: boolean, cacheKey: string): StandardMaterial`
- `public static getTexturePathFromFolder(folder: string, type: unknown = "diff", extension: unknown = ".png"): string | null`

---

## `World/Texture/TextureAtlasFactory.ts` (131 LOC)

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

## `World/Texture/TextureCache.ts` (49 LOC)

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

## `World/Texture/TextureDefinitions.ts` (79 LOC)

**Module-level functions**
- `async function loadBlockDefinitions(): Promise<TextureDefinition[]>`
- `function normalizeBlockId(id: number | string): BlockType | null`
- `export function getBlockBreakTime(id: number, toolItemId?: number): number`
- `export function getBlockInfo(id: number): TextureDefinition | undefined`

**Types / Interfaces / Enums**
- interface `TextureDefinition`
- type `RawBlockDefinition`

---

## `World/WorldStorage.ts` (614 LOC)

### class PersistenceQueue

**Properties**
- `private queues: Record<PersistenceLane, PersistenceJob[]>`
- `private isRunning: unknown`

**Methods**
- `enqueue(lane: PersistenceLane, run: () => Promise<void>): Promise<void>`
- `private drain(): void`

### class WorldStorageImpl

**Properties**
- `private db: IDBDatabase | null`
- `private initPromise: Promise<void> | null`
- `private pendingChunkSaves: unknown`
- `private pendingLodInvalidationIds: unknown`
- `private queue: unknown`
- `private static readonly CONCURRENCY: unknown`

**Methods**
- `initialize(): Promise<void>`
- `private async ensureInitialized(): Promise<boolean>`
- `private trackPendingChunkSaves(chunkIds: string[], savePromise: Promise<void>): Promise<void>`
- `private async awaitPendingChunkSaves(chunkIds: string[]): Promise<void>`
- `private enqueuePersistenceJob(lane: PersistenceLane, chunkIds: string[], run: () => Promise<void>): Promise<void>`
- `private async persistFullChunks(prepared: PreparedFullChunkSave[]): Promise<void>`
- `private async persistLodOnlyChunks(prepared: PreparedLodOnlySave[]): Promise<void>`
- `private async persistLodCacheInvalidation(chunkId: string, targetVersion: string): Promise<void>`
- `private applyLodCacheVersionPolicy(chunkId: string, data: SavedChunkData): SavedChunkData`
- `private scheduleLodCacheInvalidation(chunkId: string, targetVersion: string): void`
- `private async processLoadedChunk(chunkId: bigint, data: SavedChunkData, options?: LoadChunkOptions): Promise<SavedChunkData>`
- `async saveChunk(chunk: Chunk): Promise<void>`
- `async saveChunks(chunks: Chunk[]): Promise<void>`
- `async saveAllModifiedChunks(): Promise<void>`
- `async saveChunkEntities(chunkId: bigint, entities: SavedChunkEntityData[]): Promise<void>`
- `async loadChunkEntities(chunkId: bigint): Promise<SavedChunkEntityData[]>`
- `async loadChunk(chunkId: bigint, options?: LoadChunkOptions): Promise<SavedChunkData | null>`
- `async loadChunks(chunkIds: bigint[], options?: LoadChunkOptions): Promise<Map<bigint, SavedChunkData>>`
- `async clearWorldData(): Promise<void>`

**Module-level functions**
- `function idbRequest(req: IDBRequest<T>): Promise<T>`
- `function idbTransaction(tx: IDBTransaction): Promise<void>`
- `function openDatabase(): Promise<IDBDatabase>`
- `async function compress(data: Uint8Array | Uint16Array): Promise<Uint8Array>`
- `function getGzipISize(data: Uint8Array): number`
- `async function decompressToShared(data: Uint8Array): Promise<Uint8Array | Uint16Array>`
- `function isUint8Array(value: Uint8Array | Uint16Array | null | undefined): value is Uint8Array`
- `async function prepareFullChunkSave(chunk: Chunk): Promise<PreparedFullChunkSave>`
- `function prepareLodOnlySave(chunk: Chunk): PreparedLodOnlySave`

**Types / Interfaces / Enums**
- type `SavedChunkData`
- type `LoadChunkOptions`
- type `SavedChunkEntityData`
- type `PersistenceLane`
- type `PersistenceJob`
- type `PreparedFullChunkSave`
- type `PreparedLodOnlySave`
- type `Hit`

---
