# Project Footprint

Generated: 2026-06-21T09:50:57.684Z

> **Summary:** 119 classes · 2270 members · 379 module-level functions · 44145 LOC

---

## `Entities/AdvancedBoat.ts` (325 LOC)

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
- `readonly #_worldPt: unknown`
- `readonly #_buoyVec: unknown`
- `readonly #_accel: unknown`
- `readonly #_lever: unknown`
- `readonly #_torque: unknown`
- `readonly #_deltaRot: unknown`
- `readonly #_nextRot: unknown`
- `readonly #_euler: unknown`
- `#renderObserver: Observer<Scene> | null`
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
- `public getBoatTopYToRef(out: Vector3): void`
- `public getBoatTopY(): Vector3`
- `use(player: Player): void`

---

## `Entities/BuoyantObject.ts` (60 LOC)

### export class BuoyantObject

**Constructor**
- `constructor(scene: Scene, mesh: Mesh, waterMaterial: WaterMaterial, waterHeight: number)`

**Properties**
- `public scene: Scene`
- `public mesh: Mesh`
- `public waterMaterial: WaterMaterial`
- `public waterHeight: number`
- `private verticalVelocity: unknown`
- `readonly #renderHandle: () => void`

**Methods**
- `dispose(): void`

---

## `Entities/CustomBoat.ts` (759 LOC)

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
- `static #boatsSnapshot: CustomBoat[]`
- `static #boatCullDistSq: unknown`
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
- `#cachedYaw: unknown`
- `#cachedCos: unknown`
- `#cachedSin: unknown`
- `#linearVelocity: unknown`
- `#angularVelocity: unknown`
- `#angularResponseScale: unknown`
- `#buoyancyPoints: Vector3[]`
- `#submergedPoints: unknown`
- `#chunkBindingHandle?: symbol`
- `#isDisposed: unknown`
- `#tmpWorldPoint: unknown`
- `#tmpTorque: unknown`
- `#tmpLever: unknown`
- `#tmpBoatSampleWorld: unknown`
- `#scratchInverse: unknown`
- `#scratchRootLocal: unknown`
- `#scratchQuat: unknown`

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
- `public static tickAllActiveBoats(scene: Scene, playerPos?: Vector3): void`
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
- `public getBoatTopYToRef(out: Vector3): void`
- `public getBoatTopY(): Vector3`
- `#createSerializedPayload(): {
		type: string;
		payload: CustomBoatSerializedPayload;
	}`
- `public use(player: Player): void`
- `public dispose(): void`
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

## `Entities/MetadataContainer.ts` (18 LOC)

### export class MetadataContainer

**Properties**
- `private entries: unknown`

**Methods**
- `set(type: string, data: T): void`
- `get(type: string): T | undefined`
- `has(type: string): boolean`
- `delete(type: string): boolean`
- `getAll(): { type: string; data: any }[]`

---

## `Entities/Mobs/Chicken.ts` (100 LOC)

### export class Chicken extends NeutralMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: Scene, hp?: number)`

**Properties**
- `readonly mobType: unknown`
- `readonly CHUNK_ENTITY_TYPE: unknown`
- `static #chunkLoaderRegistered: unknown`
- `static #chunkReloadScene: Scene | null`
- `#headMesh: Mesh`
- `#headMaterial: StandardMaterial`
- `#bodyMesh: Mesh`
- `#bodyMaterial: StandardMaterial`

**Methods**
- `configureChunkLoader(scene: Scene): void`
- `getWanderSpeed(): number`
- `onDeath(): void`
- `dispose(): void`

**Types / Interfaces / Enums**
- type `ChickenSerializedPayload`

---

## `Entities/Mobs/Mob.ts` (100 LOC)

### export class MobRegistry

**Properties**
- `#configs: unknown`
- `#allMobs: unknown`
- `private counts: unknown`

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
- `getDebugStats(): {
		total: number;
		cap: number;
		perType: { type: string; count: number; max: number }[];
	}`

**Types / Interfaces / Enums**
- interface `Mob`
- type `MobSpawnConfig`

---

## `Entities/Mobs/MobSetup.ts` (32 LOC)

**Module-level functions**
- `export function createMobCoordinator(scene: Scene, getPlayerPosition: () => Vector3): SpawnCoordinator`

---

## `Entities/Mobs/NeutralMob.ts` (624 LOC)

### export abstract class NeutralMob

**Constructor**
- `constructor(hp: number, scene: Scene, halfSize: Vector3)`

**Properties**
- `abstract readonly mobType: string`
- `abstract readonly CHUNK_ENTITY_TYPE: string`
- `#hp: number`
- `#maxHp: number`
- `#bodyMesh: Mesh`
- `#velocity: unknown`
- `#collider: VoxelAabbCollider`
- `#state: NeutralMobState`
- `#stateTimer: unknown`
- `#facingAngle: unknown`
- `#scene: Scene`
- `#playerPosition: Vector3 | null`
- `#isDisposed: unknown`
- `#chunkBindingHandle?: symbol`
- `#fleeTimer: unknown`
- `#breathTimer: unknown`
- `#wanderSpeed: number`
- `#halfHeight: number`
- `#tmpUp: unknown`
- `#tmpFwd: unknown`
- `#tmpGround: unknown`
- `#tmpAway: unknown`
- `#tmpProbe: unknown`
- `#path: PathWaypoint[]`
- `#pathIndex: unknown`
- `#shoreSearchTimer: unknown`
- `#waterWanderTimer: unknown`
- `readonly #requiredHeadroom: number`
- `#inWaterCached: unknown`
- `#headSubmergedCached: unknown`
- `#waterSurfaceY: unknown`
- `static #observer: Observer<Scene> | null`
- `static readonly #allMobs: unknown`

**Accessors**
- `protected get scene(): Scene`
- `get position(): Vector3`
- `get hp(): number`
- `set hp(value: number)`
- `get maxHp(): number`
- `get isDisposed(): boolean`

**Methods**
- `abstract configureChunkLoader(scene: Scene): void`
- `abstract getWanderSpeed(): number`
- `abstract onDeath(): void`
- `static #ensureObserver(): void`
- `static disposeAll(): void`
- `protected setBodyMesh(mesh: Mesh): void`
- `setPlayerPosition(pos: Vector3): void`
- `takeDamage(amount: number): void`
- `serializeForChunkReload(): SavedChunkEntityData | null`
- `use(_player: Player): void`
- `dispose(): void`
- `#updateWaterState(): boolean`
- `protected isInWater(): boolean`
- `protected isHeadSubmerged(): boolean`
- `tick(dt: number): void`
- `#serializeForChunkReload(): SavedChunkEntityData | null`
- `protected getExtraPayload(): Record<string, unknown>`
- `#moveAxis(axis: Axis, delta: number, canStepUp: boolean): void`
- `#attemptStepUp(pos: Vector3, axis: Axis.X | Axis.Z, delta: number): boolean`
- `#isGrounded(): boolean`
- `#findNearestShore(): void`
- `#pickWanderTarget(): void`
- `#waterWander(dt: number): void`
- `#advanceOnPath(speed: number, dt: number): void`

**Types / Interfaces / Enums**
- enum `NeutralMobState`

---

## `Entities/Mobs/Sheep.ts` (122 LOC)

### export class Sheep extends NeutralMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: Scene, hp?: number, color?: Color3)`

**Properties**
- `readonly mobType: unknown`
- `readonly CHUNK_ENTITY_TYPE: unknown`
- `static #chunkLoaderRegistered: unknown`
- `static #chunkReloadScene: Scene | null`
- `#bodyMesh: Mesh`
- `#bodyMaterial: StandardMaterial`
- `#color: Color3`

**Methods**
- `configureChunkLoader(scene: Scene): void`
- `getWanderSpeed(): number`
- `onDeath(): void`
- `protected getExtraPayload(): Record<string, unknown>`
- `#dropWool(): void`
- `dispose(): void`

**Module-level functions**
- `function colorToPayload(c: Color3): { r: number; g: number; b: number }`
- `function payloadToColor(p: { r: number; g: number; b: number }): Color3`
- `function randomSheepColor(): Color3`

**Types / Interfaces / Enums**
- type `SheepSerializedPayload`

---

## `Entities/Mount.ts` (110 LOC)

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
- `#scratchPos: unknown`
- `#scratchRot: unknown`

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

## `Entities/Sheep.ts` (122 LOC)

### export class Sheep extends NeutralMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: Scene, hp?: number, color?: Color3)`

**Properties**
- `readonly mobType: unknown`
- `readonly CHUNK_ENTITY_TYPE: unknown`
- `static #chunkLoaderRegistered: unknown`
- `static #chunkReloadScene: Scene | null`
- `#bodyMesh: Mesh`
- `#bodyMaterial: StandardMaterial`
- `#color: Color3`

**Methods**
- `configureChunkLoader(scene: Scene): void`
- `getWanderSpeed(): number`
- `onDeath(): void`
- `protected getExtraPayload(): Record<string, unknown>`
- `#dropWool(): void`
- `dispose(): void`

**Module-level functions**
- `function colorToPayload(c: Color3): { r: number; g: number; b: number }`
- `function payloadToColor(p: { r: number; g: number; b: number }): Color3`
- `function randomSheepColor(): Color3`

**Types / Interfaces / Enums**
- type `SheepSerializedPayload`

---

## `Entities/SpawnCoordinator.ts` (147 LOC)

### export class SpawnCoordinator

**Constructor**
- `constructor(scene: Scene, getPlayerPosition: () => Vector3, registry: MobRegistry)`

**Properties**
- `#scene: Scene`
- `#getPlayerPosition: () => Vector3`
- `#lastSpawnCheck: unknown`
- `#disposed: unknown`
- `#observer: ReturnType<Scene["onBeforeRenderObservable"]["add"]> | null`
- `readonly #registry: MobRegistry`

**Accessors**
- `get registry(): MobRegistry`

**Methods**
- `dispose(): void`
- `#tick(): void`
- `#updatePlayerPositions(playerPos: Vector3): void`
- `#despawnDistant(playerPos: Vector3): void`
- `#trySpawn(playerPos: Vector3): void`
- `#getTotalCap(): number`
- `#findSpawnPosition(playerPos: Vector3, config: MobSpawnConfig): { x: number; y: number; z: number } | null`

---

## `Generation/Biome/BiomeDefenitions/CoastalBiomes/CoastalBiomes.ts` (209 LOC)

---

## `Generation/Biome/BiomeDefenitions/ColdBiomes/ColdBiomes.ts` (193 LOC)

---

## `Generation/Biome/BiomeDefenitions/ColdBiomes/ColdTrees.ts` (62 LOC)

---

## `Generation/Biome/BiomeDefenitions/ExoticBiomes/ExoticBiomes.ts` (69 LOC)

---

## `Generation/Biome/BiomeDefenitions/ExoticBiomes/ExoticTrees.ts` (52 LOC)

---

## `Generation/Biome/BiomeDefenitions/GeologicalBiomes/GeologicalBiomes.ts` (106 LOC)

---

## `Generation/Biome/BiomeDefenitions/GeologicalBiomes/GeologicalTrees.ts` (315 LOC)

**Module-level functions**
- `function heightHash(worldX: number, worldZ: number, seedAsInt: number): number`
- `function leafHash(x: number, y: number, z: number, seedAsInt: number): number`
- `function placedisc(cx: number, cy: number, cz: number, r: number, blockId: number, overwrite: boolean, placeBlock: (
		x: number,
		y: number,
		z: number,
		id: number,
		ow?: boolean,
	) => void): void`
- `function placeDiscHoley(cx: number, cy: number, cz: number, r: number, blockId: number, skip: number, seedAsInt: number, placeBlock: (
		x: number,
		y: number,
		z: number,
		id: number,
		ow?: boolean,
	) => void): void`

---

## `Generation/Biome/BiomeDefenitions/HotBiomes/HotBiomes.ts` (255 LOC)

---

## `Generation/Biome/BiomeDefenitions/HotBiomes/HotTrees.ts` (132 LOC)

---

## `Generation/Biome/BiomeDefenitions/MountainBiomes/MountainBiomes.ts` (115 LOC)

---

## `Generation/Biome/BiomeDefenitions/MountainBiomes/MountainTrees.ts` (106 LOC)

---

## `Generation/Biome/BiomeDefenitions/TemperateBiomes/TemperateBiomes.ts` (355 LOC)

---

## `Generation/Biome/BiomeDefenitions/TemperateBiomes/TemperateTrees.ts` (428 LOC)

**Module-level functions**
- `function placeWood(x: number, y: number, z: number): void`

---

## `Generation/Biome/BiomeDefenitions/TropicalBiomes/TropicalBiomes.ts` (108 LOC)

---

## `Generation/Biome/BiomeDefenitions/TropicalBiomes/TropicalTrees.ts` (108 LOC)

---

## `Generation/Biome/BiomeDefinitions/CoastalBiomes/CoastalBiomes.ts` (209 LOC)

---

## `Generation/Biome/BiomeDefinitions/ColdBiomes/ColdBiomes.ts` (193 LOC)

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
- `function placedisc(cx: number, cy: number, cz: number, r: number, blockId: number, overwrite: boolean, placeBlock: (
		x: number,
		y: number,
		z: number,
		id: number,
		ow?: boolean,
	) => void): void`
- `function placeDiscHoley(cx: number, cy: number, cz: number, r: number, blockId: number, skip: number, seedAsInt: number, placeBlock: (
		x: number,
		y: number,
		z: number,
		id: number,
		ow?: boolean,
	) => void): void`

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

## `Generation/Biome/BiomeDefinitions/TemperateBiomes/TemperateTrees.ts` (428 LOC)

**Module-level functions**
- `function placeWood(x: number, y: number, z: number): void`

---

## `Generation/Biome/BiomeDefinitions/TropicalBiomes/TropicalBiomes.ts` (108 LOC)

---

## `Generation/Biome/BiomeDefinitions/TropicalBiomes/TropicalTrees.ts` (108 LOC)

---

## `Generation/Biome/Biomes.ts` (415 LOC)

**Module-level functions**
- `export function getBiomeFor(temperature: number, humidity: number, continentalness: number, river: number, terrainShapedHeight: number): Biome`

---

## `Generation/Biome/BiomeTypes.ts` (108 LOC)

**Types / Interfaces / Enums**
- interface `Biome`
- type `TreeDefinition`
- enum `BIOME_ID`

---

## `Generation/Biome/TreeDefinition.ts` (414 LOC)

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
- `export function generateBaobab(worldX: number, worldY: number, worldZ: number, placeBlock: (
		x: number,
		y: number,
		z: number,
		blockId: number,
		overwrite?: boolean,
	) => void, seedAsInt: number, woodId: number, leavesId: number, baseHeight: number, heightVariance: number): void`
- `function placeWood(x: number, y: number, z: number): void`

---

## `Generation/CaveCarver.ts` (93 LOC)

**Module-level functions**
- `function clamp01(value: number): number`
- `export function getDepthBelowSurface(surfaceY: number, worldY: number): number`
- `export function getSurfaceCarveBlend(depthBelowSurface: number): number`
- `export function evaluateCaveCarve(params: GenerationParamsType, worldY: number, surfaceY: number, cheese: number, tunnel: number, detail: number): CaveCarveEvaluation`

**Types / Interfaces / Enums**
- type `CaveCarveEvaluation`

---

## `Generation/CaveNoiseGrid.ts` (58 LOC)

### export class CaveNoiseGrid

**Constructor**
- `constructor(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number, sampleRate: number, cheeseFn: (x: number, y: number, z: number) => number, tunnelFn: (x: number, y: number, z: number) => number, detailFn: (x: number, y: number, z: number) => number)`

**Properties**
- `private readonly cheese: NoiseSampler`
- `private readonly tunnel: NoiseSampler`
- `private readonly detail: NoiseSampler`

**Methods**
- `public getCheese(localX: number, localY: number, localZ: number): number`
- `public getTunnel(localX: number, localY: number, localZ: number): number`
- `public getDetail(localX: number, localY: number, localZ: number): number`

---

## `Generation/DistantTerrain/DistantTerrain.ts` (388 LOC)

### export class DistantTerrain

**Constructor**
- `constructor()`

**Properties**
- `public static instance: DistantTerrain`
- `private mesh: Mesh`
- `private waterMesh: Mesh`
- `private material: ShaderMaterial`
- `private waterMaterial: ShaderMaterial`
- `private diffuseAtlasTexture: Texture | null`
- `private static readonly USE_LA_TILE_TEXTURE: unknown`
- `private static readonly _cachedZeroVec: unknown`
- `#surfaceTileLookupTexture: RawTexture`
- `#surfaceTileLookupData: Uint8Array`
- `#radius: number`
- `#gridStep: unknown`
- `#gridResolution: number`
- `#sharedPositions: Int16Array`
- `#sharedNormals: Int8Array`
- `#sharedSurfaceTiles: Uint8Array`
- `#gridOrigin: unknown`
- `lastChunkX: number`
- `lastChunkZ: number`
- `#positionVB?: VertexBuffer`
- `#normalVB?: VertexBuffer`

**Methods**
- `public static getInstance(): DistantTerrain`
- `public static checkInstance(): boolean`
- `private createEmptyGridMesh(name: string, scene: Scene): Mesh`
- `private bindDiffuseTexture(): void`
- `private bindCommonUniforms(effect: Effect, scene: Scene): void`
- `public update(worldX: number, worldZ: number): void`
- `private applyTerrainData(positions: Int16Array, normals: Int8Array, surfaceTiles: Uint8Array, worldX: number, worldZ: number): void`
- `public static resetInstance(): void`

---

## `Generation/DistantTerrain/DistantTerrainGenerator.ts` (379 LOC)

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
- `private static regenerateEdges(shiftX: number, shiftZ: number, gridCenterChunkX: number, gridCenterChunkZ: number, centerChunkX: number, centerChunkZ: number): void`
- `private static rewriteLocalXZ(centerChunkX: number, centerChunkZ: number, gridCenterChunkX: number, gridCenterChunkZ: number): void`
- `private static generateVertex(x: number, z: number, gridCenterChunkX: number, gridCenterChunkZ: number, centerChunkX: number, centerChunkZ: number): void`
- `private static getTopTileForBlock(blockId: number): [number, number]`

---

## `Generation/LightGenerator.ts` (330 LOC)

### export class LightGenerator

**Constructor**
- `constructor(params: GenerationParamsType)`

**Properties**
- `private static chunkSize: number`
- `private static chunkSizeSq: number`
- `private lightQueue: Uint16Array`
- `private static queueMask: number`
- `private static scratchQueue: Uint16Array | null`
- `private static readonly SKYLIGHT_GENERATION_MIN_WORLD_Y: unknown`

**Methods**
- `public seedInitialLight(chunkX: number, chunkY: number, chunkZ: number, _biome: Biome, blocks: Uint8Array, light: Uint8Array, topSunlightMask?: Uint8Array): LightSeedState`
- `public propagateLight(blocks: Uint8Array, light: Uint8Array, seedState: LightSeedState): void`
- `private seedInitialLightIntoSharedQueue(chunkX: number, chunkY: number, chunkZ: number, blocks: Uint8Array, light: Uint8Array, topSunlightMask?: Uint8Array): number`
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
- `export function createFastNoise(seed: number, fractalType?: FractalType, frequency?: number): FastNoiseLite`
- `export function createFastNoise(options: FastNoiseOptions): FastNoiseLite`
- `export function createFastNoise(seedOrOptions: number | FastNoiseOptions, fractalType?: FractalType, frequency?: number): FastNoiseLite`
- `export function createFastNoise2D(seed: number, fractalType?: FractalType, frequency?: number): (x: number, z: number) => number`
- `export function createFastNoise2D(options: FastNoiseOptions): (x: number, z: number) => number`
- `export function createFastNoise2D(seedOrOptions: number | FastNoiseOptions, fractalType?: FractalType, frequency?: number): (x: number, z: number) => number`
- `export function createFastNoise3D(options: FastNoiseOptions): (x: number, y: number, z: number) => number`
- `export function createFastNoise3D(seedOrOptions: number | FastNoiseOptions, fractalType?: FractalType, frequency?: number): (x: number, y: number, z: number) => number`
- `export function createFastNoise2DWithInstance(seedOrOptions: number | FastNoiseOptions, fractalType?: FractalType, frequency?: number): FastNoise2DResult`
- `export function createFastNoise3DWithInstance(seedOrOptions: number | FastNoiseOptions, fractalType?: FractalType, frequency?: number): FastNoise3DResult`

**Types / Interfaces / Enums**
- interface `FastNoiseOptions`
- type `FastNoise2DResult`
- type `FastNoise3DResult`

---

## `Generation/NoiseAndParameters/FastNoise/FastNoiseLite.ts` (2922 LOC)

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
- `public FillNoise2D(out: Float32Array, width: number, height: number, offsetX: unknown = 0, offsetY: unknown = 0): void`
- `public FillNoise3D(out: Float32Array, width: number, height: number, depth: number, offsetX: unknown = 0, offsetY: unknown = 0, offsetZ: unknown = 0): void`

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

## `Generation/OreGenerator.ts` (163 LOC)

### export class OreGenerator

**Constructor**
- `constructor(params: GenerationParamsType, oreNoise: (x: number, y: number, z: number) => number, seedAsInt: number)`

**Properties**
- `private params: GenerationParamsType`
- `private oreNoise: (x: number, y: number, z: number) => number`
- `private seedAsInt: number`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, blocks: Uint8Array): void`

**Types / Interfaces / Enums**
- type `OreDefinition`

---

## `Generation/RiverGeneration.ts` (77 LOC)

### export class RiverGenerator

**Constructor**
- `constructor(params: GenerationParamsType)`

**Properties**
- `private params: GenerationParamsType`
- `private readonly TUNNEL_RADIUS: unknown`
- `private readonly TUNNEL_CENTER_Y: number`
- `private static riverNoise: (x: number, z: number) => number`
- `private static riverNoiseInst: FastNoiseLite`
- `private static wallNoise: (x: number, y: number, z: number) => number`
- `private riverSpline: Spline`
- `private riverDepthSpline: Spline`

**Methods**
- `public isRiver(worldX: number, worldY: number, worldZ: number, riverNoise: number): boolean`
- `public getRiverNoise(x: number, z: number): number`
- `public getRiverDepth(riverValue: number): number`
- `public fillRiverNoise2D(out: Float32Array, width: number, height: number, offsetX: number, offsetY: number): void`

---

## `Generation/Structure/DungeonFeature.ts` (166 LOC)

### export class DungeonFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds: unknown`

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

## `Generation/Structure/GeodeFeature.ts` (79 LOC)

### export class GeodeFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds: unknown`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, _biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number): void`

---

## `Generation/Structure/InfernalPitFeature.ts` (76 LOC)

### export class InfernalPitFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds: unknown`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, _biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number): void`

---

## `Generation/Structure/IWorldFeature.ts` (25 LOC)

**Types / Interfaces / Enums**
- interface `IWorldFeature`
- type `FeatureVerticalBounds`

---

## `Generation/Structure/LavaPoolFeature.ts` (142 LOC)

### export class LavaPoolFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds: unknown`

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

## `Generation/Structure/MineshaftFeature.ts` (129 LOC)

### export class MineshaftFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds: unknown`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, _biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number): void`
- `private carveTunnel(x1: number, x2: number, y: number, zCenter: number, minX: number, maxX: number, minZ: number, maxZ: number, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void): void`

---

## `Generation/Structure/RavineFeature.ts` (112 LOC)

### export class RavineFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds: unknown`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, _biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number): void`

---

## `Generation/Structure/RegionFeature.ts` (70 LOC)

**Module-level functions**
- `export function computeRegion(chunkX: number, chunkZ: number, chunkSize: number, seed: number, config: RegionConfig): RegionResult | null`
- `export function chunkWorldBounds(genChunkX: number, genChunkZ: number, chunkSize: number): { minX: number; maxX: number; minZ: number; maxZ: number }`
- `export function aabbOverlaps(fMinX: number, fMaxX: number, fMinZ: number, fMaxZ: number, cMinX: number, cMaxX: number, cMinZ: number, cMaxZ: number): boolean`

**Types / Interfaces / Enums**
- interface `RegionConfig`
- interface `RegionResult`

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

## `Generation/Structure/StructureFeature.ts` (107 LOC)

### export class StructureSpawnerFeature implements IWorldFeature

**Constructor**
- `constructor()`

**Properties**
- `public readonly verticalBounds: unknown`
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

## `Generation/Structure/TowerFeature.ts` (206 LOC)

### export class TowerFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds: unknown`

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

## `Generation/SurfaceGenerator.ts` (888 LOC)

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
- `private static readonly DENSITY_BASE_AMPLITUDE: unknown`
- `private static readonly DENSITY_OVERHANG_AMPLITUDE: unknown`
- `private static readonly DENSITY_CLIFF_AMPLITUDE: unknown`
- `private static readonly DENSITY_INFLUENCE_RANGE: unknown`
- `private static readonly DENSITY_VERTICAL_SCAN_RANGE: unknown`
- `private static readonly SUBSURFACE_LAYER_DEPTH: unknown`
- `private static readonly SURFACE_RESET_AIR_GAP: unknown`
- `private static readonly MAX_TREE_HEIGHT: unknown`
- `private static readonly MAX_STRUCTURE_ABOVE_SURFACE: unknown`
- `private static readonly MAX_STRUCTURE_BELOW_SURFACE: unknown`
- `private static seedAsInt: number`
- `private static readonly MAX_COLUMN_PREPASS_CACHE: unknown`
- `private static readonly columnPrepassCache: unknown`
- `private static readonly MAX_FLORA_COLUMN_CACHE: unknown`
- `private static readonly floraColumnCache: unknown`
- `private chunk_size: number`
- `private riverGenerator: RiverGenerator`
- `private features: IWorldFeature[]`

**Methods**
- `private packXZKey(x: number, z: number): number`
- `private getColumnPrepassKey(chunkX: number, chunkZ: number): number`
- `private resolveColumnPrepassForWorld(worldX: number, worldZ: number): {
		entry: ColumnPrepassCacheEntry;
		localX: number;
		localZ: number;
	}`
- `private getOrBuildColumnPrepass(chunkX: number, chunkZ: number): ColumnPrepassCacheEntry`
- `private getFloraColumnKey(worldX: number, worldZ: number): number`
- `private getOrBuildFloraColumnInfo(worldX: number, worldZ: number, knownTopSurfaceY?: number): FloraColumnCacheEntry`
- `private chunkIntersectsVerticalBand(chunkMinY: number, chunkMaxY: number, bandMinY: number, bandMaxY: number): boolean`
- `public generate(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow?: boolean,
		) => void): SurfaceGenerationResult`
- `private resolveSolidBlockId(currentBiome: Biome, worldY: number, depthBelowSurface: number, isBeach: boolean): number`
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
- `private getDensity(x: number, y: number, z: number, baseHeight: number, yFreq: number, cachedCliffNoise: number): number`
- `private computeCaveModifier(x: number, y: number, z: number, surfaceY: number): number`
- `private sampleCliffNoise(x: number, baseHeight: number, z: number): number`
- `private findTopSurfaceY(worldX: number, worldZ: number, baseHeight: number, yFreq: number): number`

**Types / Interfaces / Enums**
- type `SurfaceGenerationResult`
- type `ColumnPrepassCacheEntry`
- type `FloraColumnCacheEntry`

---

## `Generation/TerrainHeightMap.ts` (410 LOC)

**Module-level functions**
- `function applyRidged(raw: number): number`
- `function fillChunkCache(cx: number, cz: number, idx: number): void`
- `function getChunkCacheIdx(worldX: number, worldZ: number): number`
- `export function getFinalTerrainHeight(x: number, z: number): number`
- `export function getBiome(x: number, z: number): Biome`
- `export function getCachedRiverNoise(x: number, z: number): number`
- `export function getOctaveNoise(x: number, z: number): number`
- `function getBiomeBase(b: Biome): number`
- `function getBiomeAmp(b: Biome): number`
- `function getBiomeScale(b: Biome): number`
- `function getBiomeExp(b: Biome): number`
- `function getBiomePvScale(b: Biome): number`
- `function getBiomeErosionScale(b: Biome): number`
- `function fillCorner(gx: number, gz: number, worldX: number, worldZ: number, out: Float32Array): void`
- `export function prefetchChunkCorners(chunkWorldX: number, chunkWorldZ: number): void`

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

## `Generation/UndergroundGenerator.ts` (136 LOC)

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

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, topSurfaceYMap: Int16Array, placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow?: boolean,
		) => void, blocks?: Uint8Array): void`

---

## `Generation/WorldGenerator.ts` (263 LOC)

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

## `Interface/IUsable.ts` (4 LOC)

**Types / Interfaces / Enums**
- interface `IUsable`

---

## `Maps/BlockBreakParticles.ts` (117 LOC)

**Module-level functions**
- `export function play(scene: Scene, position: Vector3, blockId: number, packedLight: number): void`
- `function init(scene: Scene): void`
- `export function setAtlasTexture(texture: Texture): void`

---

## `Maps/Map1.ts` (131 LOC)

### export class Map1

**Constructor**
- `constructor(scene: Scene, player: Player)`

**Properties**
- `public static mainScene: Scene`
- `public static environment: WorldEnvironment`
- `public static mobRegistry: MobRegistry | null`
- `#player: Player`
- `#playerStatePersistence: PlayerStatePersistence | null`
- `#playerLoadingGate: PlayerLoadingGate | null`
- `#spawnCoordinator: SpawnCoordinator | null`
- `#renderObs: Observer<Scene> | null`
- `public readonly initPromise: Promise<void>`

**Accessors**
- `public static get timeScale(): number`
- `public static set timeScale(v: number)`
- `public static get isPaused(): boolean`
- `public static set isPaused(v: boolean)`

**Methods**
- `async asyncInit(): Promise<void>`
- `async loadTextures(): Promise<void>`
- `public static setTime(time: number): void`
- `public static setDebug(enabled: boolean): void`

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

## `Maps/WorldEnvironment.ts` (168 LOC)

### export class WorldEnvironment

**Constructor**
- `constructor(scene: Scene)`

**Properties**
- `public static instance: WorldEnvironment`
- `private scene: Scene`
- `private dirLight: DirectionalLight`
- `private hemiLight: HemisphericLight`
- `private skybox: Mesh`
- `private timeSlider: HTMLInputElement | null`
- `private negateScratch: unknown`
- `private timeOfDay: unknown`
- `public timeScale: unknown`
- `public isPaused: unknown`
- `public wetness: unknown`
- `private static readonly HUD_UPDATE_INTERVAL_MS: unknown`
- `private lastHudUpdateMs: unknown`
- `private lastDebugTimeText: unknown`
- `private lastDebugTimeScaleText: unknown`
- `private lastSliderValue: unknown`

**Methods**
- `public initSSAO(): void`
- `private createLights(): void`
- `private createSkybox(): void`
- `public update(): void`
- `public setTime(time: number): void`
- `public dispose(): void`

---

## `Player/Controls/CustomBoatControls.ts` (175 LOC)

### export class CustomBoatControls implements IControls<BoatControlEntity>

**Constructor**
- `constructor(paddleBoat: BoatControlEntity, player: Player)`

**Properties**
- `readonly controlType: unknown`
- `public pressedKeys: unknown`
- `#controlledEntity: BoatControlEntity`
- `#inputDirection: Vector3`
- `#player: Player`
- `readonly #_angularLeft: unknown`
- `readonly #_angularRight: unknown`
- `readonly #_forward: unknown`
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
- `static readonly #_localForward: unknown`

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

## `Player/Controls/DebugControlHelper.ts` (25 LOC)

**Module-level functions**
- `export function handleDebugKey(key: string): boolean`

---

## `Player/Controls/InventoryControls.ts` (79 LOC)

### export class InventoryControls implements IControls<unknown>

**Constructor**
- `constructor(controlledEntity: unknown, underlyingControls: IControls<unknown>, player: Player)`

**Properties**
- `readonly controlType: unknown`
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

## `Player/Controls/JetSkiControls.ts` (186 LOC)

### export class JetSkiControls implements IControls<BoatControlEntity>

**Constructor**
- `constructor(paddleBoat: BoatControlEntity, player: Player)`

**Properties**
- `readonly controlType: unknown`
- `public pressedKeys: unknown`
- `#controlledEntity: BoatControlEntity`
- `#inputDirection: unknown`
- `#player: Player`
- `readonly #_angularLeft: unknown`
- `readonly #_angularRight: unknown`
- `readonly #_forward: unknown`
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
- `static readonly #_localForward: unknown`

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

## `Player/Controls/PaddleBoatControls.ts` (194 LOC)

### export class PaddleBoatControls implements IControls<BoatControlEntity>

**Constructor**
- `constructor(paddleBoat: BoatControlEntity, player: Player)`

**Properties**
- `readonly controlType: unknown`
- `public pressedKeys: unknown`
- `#controlledEntity: BoatControlEntity`
- `#inputDirection: unknown`
- `#player: Player`
- `readonly #_angularLeft: unknown`
- `readonly #_angularRight: unknown`
- `readonly #_forward: unknown`
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
- `static readonly #_localForward: unknown`

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

## `Player/Controls/WalkingControls.ts` (277 LOC)

### export class WalkingControls implements IControls<PlayerVehicle>

**Constructor**
- `constructor(player: Player)`

**Properties**
- `readonly controlType: unknown`
- `public pressedKeys: unknown`
- `#controlledEntity: PlayerVehicle`
- `#inputDirection: Vector3`
- `#player: Player`
- `#blockBreaking: BlockBreakingHandler`
- `#lastJumpTapMs: unknown`
- `static readonly DOUBLE_TAP_MS: unknown`
- `static readonly #HOTBAR_KEY_MAP: unknown`
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
- `public static KEY_F5: unknown`
- `public static KEY_F6: unknown`

**Accessors**
- `public get controlledEntity(): PlayerVehicle`
- `public get inputDirection(): Vector3`

**Methods**
- `public handleKeyEvent(key: string, isKeyDown: boolean): void`
- `public handleMouseEvent(mouseEvent: MouseEvent, isKeyDown: boolean): void`
- `public update(hit?: BlockRaycastHit | null): void`
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

## `Player/Hud/BlockHighlight/BlockBreakingVisuals.ts` (224 LOC)

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

## `Player/Hud/BlockHighlight/BlockHighlight.ts` (206 LOC)

### export class BlockHighlight

**Constructor**
- `constructor(scene: Scene)`

**Properties**
- `readonly #scene: Scene`
- `readonly #material: StandardMaterial`
- `#mesh: Mesh`
- `#shapeKey: unknown`
- `#prevVisible: unknown`
- `#prevHitX: unknown`
- `#prevHitY: unknown`
- `#prevHitZ: unknown`
- `#prevIsBoat: unknown`
- `readonly #renderHandle: () => void`
- `#currentHit: BlockRaycastHit | null`

**Methods**
- `dispose(): void`
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

## `Player/Hud/BlockHighlight/BlockRaycaster.ts` (725 LOC)

**Module-level functions**
- `function getForwardRay(player: Player, length: number): Ray`
- `function isTargetableBlock(blockId: number): boolean`
- `function isFullBlockShape(blockId: number, blockState: number): boolean`
- `function intersectRayAabb(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, tMin: number, tMax: number, fallbackNx: number, fallbackNy: number, fallbackNz: number): FaceHit | null`
- `function raycastShapeInVoxel(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, vx: number, vy: number, vz: number, blockId: number, blockState: number, tEnter: number, tExit: number, fallbackNx: number, fallbackNy: number, fallbackNz: number): FaceHit | null`
- `function raycastFirstBlock(player: Player, shouldHit: (x: number, y: number, z: number, blockId: number) => boolean): BlockRaycastHit | null`
- `function traceRayDda(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, startX: number, startY: number, startZ: number, tStart: number, maxDist: number, checkStart: boolean, visit: (
		x: number,
		y: number,
		z: number,
		t: number,
		nx: number,
		ny: number,
		nz: number,
		tExit: number,
	) => DdaVisitResult): void`
- `function raycastFirstTerrainBlock(ray: Ray, shouldHit: (x: number, y: number, z: number, blockId: number) => boolean): BlockRaycastHit | null`
- `function raycastFirstBoatBlock(ray: Ray, shouldHit: (x: number, y: number, z: number, blockId: number) => boolean): BlockRaycastHit | null`
- `function raycastSingleBoatChunk(ray: Ray, boatChunk: BoatChunk, shouldHit: (x: number, y: number, z: number, blockId: number) => boolean): boolean`
- `export function pickTarget(player: Player): BlockRaycastHit | null`
- `export function pickWaterTarget(player: Player): BlockRaycastHit | null`
- `export function pickBlock(player: Player): number | null`
- `export function getPlacementPosition(player: Player): Vector3 | null`
- `export function getPlacementHit(player: Player): PlacementHit | null`

**Types / Interfaces / Enums**
- type `BlockRaycastHit`
- type `FaceHit`
- type `PlacementHit`
- enum `DdaVisitResult`

---

## `Player/Hud/BlockHighlight/BreakingBlockHandler.ts` (176 LOC)

### export class BlockBreakingHandler

**Constructor**
- `constructor(player: Player)`

**Properties**
- `#player: Player`
- `#active: unknown`
- `#cachedX: unknown`
- `#cachedY: unknown`
- `#cachedZ: unknown`
- `#hasCachedBlock: unknown`
- `#breakTimer: unknown`

**Methods**
- `public start(): void`
- `public stop(): void`
- `public reset(): void`
- `public update(hit?: BlockRaycastHit | null): void`
- `#asBoatBlockContext(context: unknown): BoatBlockHitContext | null`
- `#breakBlock(x: number, y: number, z: number, blockId: number, packedLight: number, dynamicContext: unknown): void`

**Types / Interfaces / Enums**
- type `BoatBlockHitContext`

---

## `Player/Hud/Crosshair/Crosshair.ts` (117 LOC)

### export class Crosshair

**Constructor**
- `constructor(engine: Engine, scene: Scene, player: Player)`

**Properties**
- `readonly #ui: CrosshairUI`
- `readonly #highlight: BlockHighlight`
- `readonly #player: Player`

**Methods**
- `public setTargetHit(hit: BlockRaycastHit | null): void`
- `setCrosshair(id: string): void`
- `showHitMarker(): void`
- `static pickTargetInto(player: Player, target: Vector3): boolean`
- `static pickWaterPlacementTargetInto(player: Player, target: Vector3): boolean`
- `static pickBlock(player: Player): number | null`
- `static pickTarget(player: Player): Vector3 | null`
- `static pickWaterPlacementTarget(player: Player): Vector3 | null`
- `static getPlacementPosition(player: Player): Vector3 | null`
- `static getPlacementHit(player: Player): PlacementHit | null`
- `static pickUsableMesh(player: Player, maxDistance: unknown = REACH_DISTANCE): AbstractMesh | null`
- `static pickMobMesh(player: Player, maxDistance: unknown = REACH_DISTANCE): AbstractMesh | null`
- `static #rayMarchFirstMesh(player: Player, maxDistance: number, predicate?: (mesh: AbstractMesh) => boolean): AbstractMesh | null`

---

## `Player/Hud/Crosshair/CrosshairUI.ts` (57 LOC)

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

## `Player/Hud/DebugPanel.ts` (45 LOC)

### export class DebugPanel

**Constructor**
- `constructor()`

**Properties**
- `static instance: DebugPanel`
- `static div: HTMLDivElement`
- `private static infoLines: { [key: string]: string }`
- `private static elements: unknown`

**Methods**
- `static getInstance(): DebugPanel`
- `public static show(): void`
- `public static hide(): void`
- `public static updateInfo(key: string, value: string | number): void`

---

## `Player/Hud/PauseMenu.ts` (336 LOC)

### export class PauseMenu

**Constructor**
- `constructor(onResume: () => void, player: Player)`

**Properties**
- `private menuContainer: HTMLElement`
- `private mainButtonsContainer: HTMLElement`
- `private settingsContainer: HTMLElement`
- `private onResume: () => void`
- `private player: Player`
- `private ssaoPipeline: SSAO2RenderingPipeline | null`

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

## `Player/Hud/PlayerHud.ts` (614 LOC)

### export class PlayerHud

**Constructor**
- `constructor(engine: Engine, scene: Scene, player: Player)`

**Properties**
- `#engine: Engine`
- `#scene: Scene`
- `readonly #player: Player`
- `public readonly crossHair: Crosshair`
- `static #inventory: PlayerInventory`
- `#inventoryOpen: unknown`
- `#craftingRecipeDivs: { recipe: Recipe; div: HTMLDivElement }[]`
- `#selectedHotbarSlot: unknown`
- `#hotbarSlots: HTMLDivElement[]`
- `static #heldItemNameDiv: HTMLDivElement`
- `#heldItemNameTimeout?: number`
- `#heldItemNameDivCachedWidth: unknown`
- `#prevHealthPct: unknown`
- `#prevHungerPct: unknown`
- `#prevStaminaPct: unknown`
- `#prevManaPct: unknown`
- `#overlayDiv: HTMLDivElement`
- `static debugPanelDiv: HTMLDivElement`
- `private static infoRows: {
		[key: string]: {
			container: HTMLDivElement;
			valueNode: Text;
			valueSpan?: HTMLSpanElement;
			keySpan?: HTMLSpanElement;
		};
	}`
- `private static itemTooltipDiv: HTMLDivElement`
- `private static itemTooltipMouseMove?: (e: MouseEvent) => void`
- `#healthBarFill: HTMLDivElement`
- `#hungerBarFill: HTMLDivElement`
- `#staminaBarFill: HTMLDivElement`
- `#manaBarFill: HTMLDivElement`

**Accessors**
- `public get player(): Player`
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
- `public static updateDebugInfo(key: string, value: string | number, category?: string): void`
- `private initializeTooltip(): void`
- `public static showItemTooltip(text: string, event: MouseEvent): void`
- `public static hideItemTooltip(): void`
- `public updateStats(): void`

---

## `Player/Inventory/DroppedItem.ts` (266 LOC)

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
- `#scratchProbe: unknown`
- `static readonly #allItems: unknown`
- `static #observer: Observer<Scene> | null`
- `static readonly GRAVITY: unknown`
- `static readonly STEP_SIZE: unknown`
- `static readonly EPSILON: unknown`
- `static readonly AIR_DAMPING_PER_SEC: unknown`
- `static readonly GROUND_DAMPING_PER_SEC: unknown`
- `static readonly MIN_SPEED: unknown`
- `static readonly SKY_LIGHT_COLOR: unknown`
- `static readonly BLOCK_LIGHT_COLOR: unknown`
- `static readonly #tileTextures: unknown`

**Accessors**
- `get boxMesh(): Mesh`
- `get item(): Item`

**Methods**
- `static #ensureObserver(): void`
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
- `static disposeAll(): void`
- `static disposeTileTextures(): void`

---

## `Player/Inventory/Item.ts` (315 LOC)

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
- `#useAction: ((player: Player) => void) | null`
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

## `Player/Inventory/ItemRegistry.ts` (100 LOC)

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

## `Player/Inventory/ItemSlot.ts` (104 LOC)

### export class ItemSlot

**Constructor**
- `constructor(row: number, col: number)`

**Properties**
- `#item: Item | null`
- `#divItemSlot: HTMLDivElement`
- `#onDragStart: () => void`
- `#onDragOver: (e: DragEvent) => void`
- `#onDrop: (e: DragEvent) => void`
- `#onMouseOver: (e: MouseEvent) => void`
- `#onMouseOut: () => void`
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
- `public initialize(): void`
- `public dispose(): void`

---

## `Player/Inventory/ItemUseActions.ts` (43 LOC)

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

## `Player/Player.ts` (155 LOC)

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
- `#inputController: PlayerInputController`
- `#loopController: PlayerLoopController`
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
- `public dispose(): void`
- `public wouldBlockOverlapPlayer(blockX: number, blockY: number, blockZ: number, blockShape: {
			boxes: Array<{
				min: [number, number, number];
				max: [number, number, number];
			}>;
			rotateY: boolean;
			usesSliceState: boolean;
		}, rotation: number, slice: number, flipY: boolean): boolean`
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

## `Player/PlayerCamera.ts` (93 LOC)

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
- `readonly #_forward: unknown`
- `readonly #_eyeOffset: unknown`
- `readonly #_tmp1: unknown`

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

## `Player/PlayerFlashLight.ts` (48 LOC)

### export class PlayerFlashLight

**Constructor**
- `constructor(scene: Scene, playerCamera: FreeCamera)`

**Properties**
- `#flashlight: SpotLight`
- `#camera: FreeCamera`
- `#viewMatrixObs: Observer<Camera> | null`

**Methods**
- `public toggle(): void`
- `public dispose(): void`

---

## `Player/PlayerInputController.ts` (108 LOC)

### export class PlayerInputController

**Constructor**
- `constructor(scene: Scene, canvas: HTMLCanvasElement, playerCamera: PlayerCamera, onKeyEvent: KeyEventHandler, getKeyboardControls: () => IControls<unknown>, onPauseRequested: () => void)`

**Properties**
- `#onKeyDown: (event: KeyboardEvent) => void`
- `#onKeyUp: (event: KeyboardEvent) => void`
- `#onCanvasClick: () => void`
- `#onPointerLockChange: () => void`
- `#onMouseDown: (event: MouseEvent) => void`
- `#onMouseUp: (event: MouseEvent) => void`
- `#pointerObs: Observer<PointerInfo> | null`

**Methods**
- `public bind(): void`
- `public dispose(): void`
- `private bindPointerObserver(): void`

**Types / Interfaces / Enums**
- type `KeyEventHandler`

---

## `Player/PlayerLoadingGate.ts` (96 LOC)

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

## `Player/PlayerLoopController.ts` (379 LOC)

### export class PlayerLoopController

**Constructor**
- `constructor(engine: Engine, scene: Scene, playerVehicle: IPlayerBody, playerStats: PlayerStats, playerHud: PlayerHud, playerCamera: PlayerCamera, getKeyboardControls: () => IControls<unknown>, getPlayerPosition: () => Vector3)`

**Properties**
- `#loadLastCx: unknown`
- `#loadLastCy: unknown`
- `#loadLastCz: unknown`
- `#amLastCx: unknown`
- `#amLastCy: unknown`
- `#amLastCz: unknown`
- `#prevCameraYaw: unknown`
- `#prevCameraPitch: unknown`
- `#rebuildActiveMeshes: unknown`
- `#lastCaveState: unknown`
- `#occlusionCuller: unknown`
- `#lastOcclusionStats: unknown`
- `#lastDebugHudUpdateMs: unknown`
- `static readonly DEBUG_HUD_INTERVAL_MS: unknown`
- `#onBeforeRenderObs: Observer<Scene> | null`
- `#onAfterRenderObs: Observer<Scene> | null`
- `#frozenOnce: unknown`
- `#cameraStillFrames: unknown`
- `static readonly FREEZE_DELAY_FRAMES: unknown`
- `static readonly #DIRECTION_NAMES: unknown`

**Methods**
- `public bind(): void`
- `public dispose(): void`
- `#updateControls(hit?: BlockRaycastHit | null): void`
- `#updateCaveState(playerY: number): boolean`
- `#updateChunksAroundPlayer(cx: number, cy: number, cz: number, playerPos: { x: number; z: number }): void`
- `#updateActiveMeshSelection(cx: number, cy: number, cz: number): void`
- `#freezeActiveMeshes(): void`
- `#updateDebugHud(): void`
- `#directionFromYaw(yaw: number): string`

---

## `Player/PlayerStatePersistence.ts` (168 LOC)

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

## `Player/PlayerVehicle.ts` (121 LOC)

### export class PlayerVehicle implements IPlayerBody

**Constructor**
- `constructor(scene: Scene, camera: PlayerCamera, playerStats: PlayerStats)`

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
- `public wouldBlockOverlapPlayer(blockX: number, blockY: number, blockZ: number, blockShape: {
			boxes: Array<{
				min: [number, number, number];
				max: [number, number, number];
			}>;
			rotateY: boolean;
			usesSliceState: boolean;
		}, rotation: number, slice: number, flipY: boolean): boolean`

**Types / Interfaces / Enums**
- type `SavedPlayerPosition`

---

## `Player/PlayerVehicleMotor.ts` (1081 LOC)

### export class PlayerVehicleMotor

**Constructor**
- `constructor(options: PlayerVehicleMotorOptions)`

**Properties**
- `readonly #scene: Scene`
- `readonly #camera: PlayerCamera`
- `readonly #controls: PlayerBodyControlState`
- `readonly #getMount: () => Mount | null`
- `readonly #playerStats: PlayerStats`
- `#displayCapsule: Mesh`
- `#characterController: SimpleCharacterController`
- `#characterOrientation: unknown`
- `#characterGravity: unknown`
- `#characterGravityLen: unknown`
- `readonly #upX: unknown`
- `readonly #upY: unknown`
- `readonly #upZ: unknown`
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
- `private now: unknown`
- `private readonly deceleration: unknown`
- `private readonly inAirSpeed: unknown`
- `private readonly onGroundSpeed: unknown`
- `private readonly jumpHeight: unknown`
- `private readonly jumpStaminaCost: unknown`
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
- `public wouldBlockOverlapPlayer(blockX: number, blockY: number, blockZ: number, blockShape: {
			boxes: Array<{
				min: [number, number, number];
				max: [number, number, number];
			}>;
			rotateY: boolean;
			usesSliceState: boolean;
		}, rotation: number, slice: number, flipY: boolean): boolean`
- `#applyBoatMotion(): void`
- `#tryBoatSupport(boat: CustomBoat, chunk: BoatChunk, footY: number): boolean`
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

**Module-level functions**
- `function _rotateVec3ByQuat(vx: number, vy: number, vz: number, qx: number, qy: number, qz: number, qw: number, out: Vector3): void`

**Types / Interfaces / Enums**
- type `PlayerVehicleMotorOptions`
- enum `PlayerState`

---

## `Player/SimpleCharacterController.ts` (63 LOC)

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
- `static readonly #cachedSurfaceNormal: unknown`
- `static readonly #cachedSurfaceVelocity: unknown`
- `static readonly #cachedSurfaceInfo: CharacterSurfaceInfo`

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

## `TestScene.ts` (78 LOC)

### export class TestScene

**Constructor**
- `constructor(document: Document, canvas: HTMLCanvasElement)`

**Properties**
- `document: Document`
- `scene?: Scene`
- `engine: Engine`
- `public readonly initPromise: Promise<void>`
- `private frameCounter: unknown`
- `readonly #onKeyDown: (ev: KeyboardEvent) => void`

**Methods**
- `async init(): Promise<void>`
- `async createScene(): Promise<Scene>`
- `public dispose(): void`

---

## `World/Boat/BoatChunk.ts` (463 LOC)

### export class BoatChunk

**Constructor**
- `constructor(scene: Scene, blocks: BoatChunkBlock[], center: Vector3)`

**Properties**
- `private static activeChunks: unknown`
- `private static readonly CHUNK_Y_BASE: unknown`
- `private static readonly CHUNK_COORD_GRID_WIDTH: unknown`
- `private static readonly CHUNK_COORD_SPACING: unknown`
- `private static nextChunkSlot: unknown`
- `#scene: Scene`
- `#center: Vector3`
- `#visualRoot: Mesh`
- `#centerChunk: Chunk`
- `#scratchInverse: unknown`
- `#scratchLocal: unknown`
- `#neighborChunks: Chunk[]`
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
- `public syncVisualMeshes(): void`
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
- `public worldToLocalBlockToRef(worldPosition: Vector3, ref: Vector3): void`
- `public localToWorldCenter(x: number, y: number, z: number): Vector3`
- `public localToWorldCenterToRef(x: number, y: number, z: number, ref: Vector3): void`
- `public getOccupiedBoundsLocal(): {
		minX: number;
		minY: number;
		minZ: number;
		maxX: number;
		maxY: number;
		maxZ: number;
	} | null`
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

## `World/Boat/BoatCreatorSystem.ts` (279 LOC)

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

## `World/Chunk/Chunk.ts` (1199 LOC)

### export class Chunk

**Constructor**
- `constructor(chunkX: number, chunkY: number, chunkZ: number)`

**Properties**
- `public readonly id: bigint`
- `public readonly neighborIds: readonly bigint[]`
- `public lodLevel: unknown`
- `public static readonly SIZE: unknown`
- `public static readonly SIZE2: unknown`
- `public static readonly SIZE3: unknown`
- `public static readonly chunkInstances: unknown`
- `public static readonly loadedChunks: unknown`
- `public static readonly loadedChunkIndex: unknown`
- `public isModified: unknown`
- `public isBoatChunk: unknown`
- `public isDirty: unknown`
- `public isLoaded: unknown`
- `public isTerrainScheduled: unknown`
- `public isLightDirty: unknown`
- `public remeshQueued: unknown`
- `public static DEBUG_REMESH: unknown`
- `public static onRequestRemesh: | ((chunk: Chunk, priority: boolean) => void)
		| null`
- `public static onChunkLoaded: ((chunk: Chunk) => void) | null`
- `public static lightHeaderBuffer: SharedArrayBuffer | null`
- `public static lightHeaderView: LightHeaderView | null`
- `private static _lightHeaderNextSlot: unknown`
- `private static _lightHeaderFreeSlots: number[]`
- `public static onLightChunkLoaded: ((chunk: Chunk) => void) | null`
- `public static onLightChunkLayoutChanged: ((chunk: Chunk) => void) | null`
- `public static onLightChunkDisposed: ((chunk: Chunk) => void) | null`
- `private _block_array: Uint8Array | Uint16Array | null`
- `private _isUniform: unknown`
- `private _uniformBlockId: unknown`
- `private _palette: Uint16Array | null`
- `private _paletteIndexMap: Map<number, number> | null`
- `private _hasVoxelData: unknown`
- `public chunkY: number`
- `public chunkX: number`
- `public chunkZ: number`
- `public mesh: Mesh | null`
- `public transparentMesh: Mesh | null`
- `public opaqueMeshData: MeshData | null`
- `public transparentMeshData: MeshData | null`
- `public mergedGroupKey: string | null`
- `public faceConnectivity: unknown`
- `public connectivityDirty: unknown`
- `_isDarkCached: boolean | undefined`
- `public _fSteps: Uint8Array`
- `light_array: Uint8Array`
- `public readonly numericId: number`
- `private static _nextNumericId: unknown`
- `public lightHeaderSlot: number`
- `public bfsQueryId: number`
- `public bfsVisitedFaces: number`
- `public bfsQueuedForConnectivity: boolean`
- `public readonly neighborRefs: (Chunk | null)[]`
- `public static readonly SKY_LIGHT_SHIFT: unknown`
- `public static readonly BLOCK_LIGHT_MASK: unknown`
- `private static readonly SKYLIGHT_GENERATION_MIN_WORLD_Y: unknown`
- `private static readonly GLASS_01_BLOCK_ID: unknown`
- `private static readonly GLASS_02_BLOCK_ID: unknown`
- `private static readonly EPS: unknown`
- `private static readonly CLOSED_FACE_MASK_CACHE: unknown`
- `private static readonly EMPTY_LIGHT_ARRAY: unknown`
- `public cachedLODMeshes: unknown`
- `private static readonly _lightEmissionLUT: unknown`
- `public static _lightPool: {
		postLightMutate(req: any): void;
		postLightAddEmission(req: any): void;
		nextLightSeq(): number;
		enqueueDeferredLightFromSunlightInit?(
			chunk: Chunk,
			queue: Uint16Array,
			length: number,
		): void;
	} | null`
- `private static readonly _faceScratch: number[]`
- `private static readonly FACE_CONNECT_THRESHOLD: unknown`

**Accessors**
- `public get isSolidOccluder(): boolean`
- `get block_array(): Uint8Array | Uint16Array | null`
- `get palette(): Uint16Array | null`
- `get isUniform(): boolean`
- `get uniformBlockId(): number`
- `get hasVoxelData(): boolean`

**Methods**
- `public static initLightHeader(): SharedArrayBuffer`
- `private static allocLightHeaderSlot(): number`
- `public getLightStorageSnapshot(): {
		lightSAB: SharedArrayBuffer | null;
		blockSAB: SharedArrayBuffer | null;
		paletteSAB: SharedArrayBuffer | null;
		blockStorageBytesPerElement: 1 | 2;
	}`
- `public static getLightEmission(blockId: number): number`
- `private getNibble(index: number): number`
- `private setNibble(index: number, value: number): void`
- `public loadFromStorage(blocks: Uint8Array | Uint16Array | null, palette: Uint16Array | null | undefined, isUniform: boolean | undefined, uniformBlockId: number | undefined, light_array?: Uint8Array, scheduleRemesh: unknown = true): void`
- `private writeLightHeaderRow(): void`
- `private ensureSharedBacking(): void`
- `public loadLodOnlyFromStorage(scheduleRemesh: unknown = false): void`
- `public getCachedLODMesh(lod: number): CachedLODMesh | null`
- `public hasCachedLODMesh(lod: number): boolean`
- `public setCachedLODMesh(lod: number, mesh: CachedLODMesh): void`
- `public clearCachedLODMeshes(): void`
- `public getSerializableLODMeshCache(): SerializedLODMeshCache | undefined`
- `public restoreLODMeshCache(cache?: SerializedLODMeshCache): void`
- `public initializeSunlight(): void`
- `public getBlockLight(lx: number, ly: number, lz: number): number`
- `public getSkyLight(lx: number, ly: number, lz: number): number`
- `public getLight(lx: number, ly: number, lz: number): number`
- `public setLight(x: number, y: number, z: number, level: number): void`
- `public recomputeDarkCache(): void`
- `public setBlockLight(x: number, y: number, z: number, level: number): void`
- `public setSkyLight(x: number, y: number, z: number, level: number): void`
- `public getBlock(lx: number, ly: number, lz: number): number`
- `public getBlockState(lx: number, ly: number, lz: number): number`
- `public getBlockPacked(lx: number, ly: number, lz: number): number`
- `public setBlock(localX: number, localY: number, localZ: number, blockId: number, state: unknown = 0): void`
- `private dispatchLightMutate(localX: number, localY: number, localZ: number, oldPacked: number, newPacked: number): void`
- `public deleteBlock(localX: number, localY: number, localZ: number): void`
- `public scheduleRemesh(priority: unknown = false, includeNeighbors: unknown = false): void`
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
- `private static applySliceStateToBoxForLight(min: [number, number, number], max: [number, number, number], state: number): { min: [number, number, number]; max: [number, number, number] }`
- `public static facePairIndex(i: number, j: number): number`
- `private static isBlockOpaque(packed: number): boolean`
- `private static connectFacesMask(faceMask: number): number`
- `public computeFaceConnectivity(): number`
- `public dispose(): void`

**Module-level functions**
- `export function addChunkDisposeHook(hook: ChunkDisposeHook): void`
- `function runChunkDisposeHooks(chunk: Chunk): void`
- `export function getChunk(cx: number, cy: number, cz: number): Chunk | undefined`

**Types / Interfaces / Enums**
- type `CachedLODMesh`
- type `SerializedLODMeshCache`
- type `ChunkDisposeHook`

---

## `World/Chunk/chunk.worker.ts` (158 LOC)

**Module-level functions**
- `function compressBlocks(blocks: Uint8Array): {
	isUniform: boolean;
	uniformBlockId: number;
	palette: Uint16Array | null;
	packedBlocks: Uint8Array | Uint16Array | null;
}`

---

## `World/Chunk/ChunkLoadingSystem.ts` (792 LOC)

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
- `function applyMeshToChunk(chunk: Chunk, mesh: SelectedSavedMesh | null): void`
- `function refreshQueueDebugSnapshot(): void`
- `export function getDebugStats(): ChunkLoadingDebugStats`
- `export async function refreshOpfsDebugStats(): Promise<void>`
- `function refreshOpfsPrefetchSnapshot(): void`
- `function buildQueuedIdSet(): Set<bigint>`
- `function ensureChunkLoadedHook(): void`
- `export function validateChunksAround(centerChunkX: number, centerChunkY: number, centerChunkZ: number, horizontalRadius: unknown = SETTING_PARAMS.RENDER_DISTANCE, verticalRadius: unknown = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE): void`
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
- `export async function updateChunksAround(chunkX: number, chunkY: number, chunkZ: number, renderDistance: unknown = SETTING_PARAMS.RENDER_DISTANCE, verticalRadius: unknown = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE, prevChunkX?: number, prevChunkY?: number, prevChunkZ?: number, playerWorldX?: number, playerWorldZ?: number): Promise<void>`
- `function updateSliceDebugStats(state: InFlightProcessState): void`
- `function finalizeProcessState(state: InFlightProcessState): void`
- `function applyHydratedChunkFromSavedData(chunk: Chunk, savedData: SavedChunkData): void`
- `function loadFarLodChunk(state: InFlightProcessState, chunk: Chunk, selectedMesh: SelectedSavedMesh | null, hasDesiredMesh: boolean): void`
- `function loadNearLodChunk(chunk: Chunk, savedData: SavedChunkData, selectedMesh: SelectedSavedMesh | null, hasDesiredMesh: boolean, targetLod: number): void`
- `function applyLoadedChunkFromSavedData(state: InFlightProcessState, request: QueuedChunkRequest, savedData: SavedChunkData): void`
- `async function prefetchOpfsMeshes(requests: QueuedChunkRequest[]): Promise<void>`
- `function resetCycleOpfsCache(): void`
- `export function deleteBlock(worldX: number, worldY: number, worldZ: number): void`
- `export function setBlock(worldX: number, worldY: number, worldZ: number, blockId: number, state: unknown = 0): void`
- `export function getBlockByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): number`
- `export function getTerrainBlockByWorldCoords(worldX: number, worldY: number, worldZ: number): number`
- `export function getBlockStateByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): number`
- `export function getBlockAndStateByWorldCoordsInto(worldX: number, worldY: number, worldZ: number, out: BlockAndStateOut, options?: DynamicBlockQueryOptions): BlockAndStateOut`
- `export function getBlockAndStateByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): BlockAndStateOut`
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
- type `DynamicBlockSample`
- type `DynamicBlockProvider`
- type `DynamicBlockMutator`
- type `DynamicBlockProviderEntry`
- type `DynamicBlockQueryOptions`
- type `BlockAndStateOut`

---

## `World/Chunk/ChunkMesher.ts` (1135 LOC)

### class LodMeshMeta

**Properties**
- `__lodLevel: unknown`
- `__lodCrossFade: LodCrossFadeState | null`

**Module-level functions**
- `function ensureMeshMetadata(mesh: Mesh): LodMeshMeta`
- `function getMeshLodLevel(mesh: Mesh | null): number | null`
- `function setMeshLodLevel(mesh: Mesh, lod: number): void`
- `function getMeshFadeState(mesh: Mesh): LodCrossFadeState | null`
- `function clearMeshFadeState(mesh: Mesh): void`
- `function setMeshFadeState(mesh: Mesh, state: LodCrossFadeState): void`
- `function makeFadeSeed(chunk: Chunk): number`
- `function beginLodCrossFade(chunk: Chunk, oldMesh: Mesh | null, newMesh: Mesh | null): void`
- `function shouldUseLodCrossFade(previousLod: number | null, nextLod: number): boolean`
- `function getMeshFadeUniforms(mesh: Mesh | undefined, nowMs?: number): typeof scratchFadeUniforms`
- `function updateLodCrossFades(nowMs: number): void`
- `function applyLodShaderBindings(material: ShaderMaterial): void`
- `function applyMergedMeshBindings(material: ShaderMaterial): void`
- `function ensureSharedFacePositionBuffer(): void`
- `function upsertFaceVertexBufferMerged(mesh: Mesh, engine: AbstractEngine, kind: string, data: Uint8Array, itemSize: number): void`
- `function getOpaqueMaterialForLodBucket(lod: number): Material`
- `function getTransparentMaterialForLodBucket(lod: number): Material`
- `function beginGroupLodCrossFadeIfNeeded(group: {
		membersArray: { chunk: Chunk }[];
	}, previousLod: number | null, nextLod: number, oldMesh: Mesh | null, newMesh: Mesh | null): void`
- `function upsertMergedMesh(group: {
		gridX: number;
		gridY: number;
		gridZ: number;
		groupKey: string;
		chunkOffsets: Float32Array;
	}, existingMesh: Mesh | null, mergedData: {
		faceDataA: Uint8Array;
		faceDataB: Uint8Array;
		faceDataC: Uint8Array;
		chunkIndex: Uint8Array;
		faceCount: number;
	}, name: string, material: Material): Mesh`
- `function createCachedTexture(url: string, scene: Scene, args: any): Texture`
- `async function loadTextureToCache(url: string): Promise<string>`
- `export async function initAtlas(): Promise<void>`
- `function createBoatChunkStandaloneMesh(name: string, material: Material, faceData: {
		faceDataA: Uint8Array;
		faceDataB: Uint8Array;
		faceDataC: Uint8Array;
		chunkIndex: Uint8Array;
		faceCount: number;
	}): Mesh`
- `function createBoatChunkMesh(chunk: Chunk, opaqueData: MeshData | null, transparentData: MeshData | null): void`
- `export function createMeshFromData(chunk: Chunk, meshData: { opaque: MeshData | null; transparent: MeshData | null }): void`
- `export function updateGlobalUniforms(frameId: number): void`
- `export function disposeSharedResources(): void`

**Types / Interfaces / Enums**
- type `LodCrossFadeState`

---

## `World/Chunk/chunkWorker.ts` (394 LOC)

### export class ChunkWorker

**Constructor**
- `constructor(workerIndex: number, onMessageTerrain: (event: MessageEvent<WorkerResponseData>) => void, onMessageMesh: (event: MessageEvent<MeshWorkerResponse>) => void)`

**Properties**
- `private terrainWorker: Worker`
- `private voxelWorker: Worker`
- `private warnedNonSharedRemeshPayload: unknown`
- `private distantTerrainSharedInitialized: unknown`
- `private lightSharedInitialized: unknown`
- `private readonly _neighborScratch: (
		| Uint8Array
		| Uint16Array
		| null
		| undefined
	)[]`
- `private readonly _neighborLightScratch: (Uint8Array | undefined)[]`
- `private readonly _neighborUniformIdScratch: (number | undefined)[]`
- `private readonly _neighborPaletteScratch: (
		| Uint8Array
		| Uint16Array
		| null
		| undefined
	)[]`
- `private static readonly EMPTY_NEIGHBOR_BLOCKS: unknown`
- `private static readonly EMPTY_NEIGHBOR_LIGHTS: unknown`
- `readonly #lightMutateMsg: LightMutateRequest`
- `readonly #lightEmissionMsg: LightAddEmissionRequest`
- `readonly #lightSkyReconcileMsg: LightSkyReconcileRequest`
- `readonly #lightPropagateMsg: LightPropagateDeferredRequest`
- `private readonly paletteToTyped: unknown`
- `private static readonly _REMESH_OFFSETS: readonly {
		readonly dx: number;
		readonly dy: number;
		readonly dz: number;
		readonly faceIdx: number;
	}[]`

**Methods**
- `public setOnError(handler: (ev: ErrorEvent | Event) => void): void`
- `public terminate(): void`
- `public postFullRemesh(chunk: Chunk, forcedLod?: number): void`
- `public postTerrainGeneration(chunk: Chunk, deferLighting: boolean = true): void`
- `public initDistantTerrainShared(positionsBuffer: SharedArrayBuffer, normalsBuffer: SharedArrayBuffer, surfaceTilesBuffer: SharedArrayBuffer, radius: number, gridStep: number): void`
- `public postGenerateDistantTerrain(requestId: number, centerChunkX: number, centerChunkZ: number, radius: number, renderDistance: number, gridStep: number): void`
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

---

## `World/Chunk/ChunkWorkerPool.ts` (1739 LOC)

### export class ChunkWorkerPool

**Constructor**
- `constructor(poolSize: number)`

**Properties**
- `private static instance: ChunkWorkerPool | undefined`
- `private static readonly WORKER_ERROR_COOLDOWN_MS: unknown`
- `private static readonly MIN_AUTO_POOL_SIZE: unknown`
- `private static readonly MAX_AUTO_POOL_SIZE: unknown`
- `private static readonly DEFERRED_LIGHTING_BUDGET_MS: unknown`
- `private static readonly DEFERRED_LIGHTING_MAX_CHUNKS_PER_FRAME: unknown`
- `private static readonly LAST_DISPATCH_RING_SIZE: unknown`
- `private workers: ChunkWorker[]`
- `private workerTaskContext: WorkerTaskContext[]`
- `private distantTerrainSharedInit: {
		positionsBuffer: SharedArrayBuffer;
		normalsBuffer: SharedArrayBuffer;
		surfaceTilesBuffer: SharedArrayBuffer;
		radius: number;
		gridStep: number;
	} | null`
- `private workerRestartAtMs: number[]`
- `private taskQueue: Chunk[]`
- `private taskQueueReadIdx: unknown`
- `private taskQueuePriority: Map<Chunk, boolean>`
- `private workerDispatchCounts: number[]`
- `private _lastHeartbeatSeq: number[]`
- `private lastDispatchRing: unknown`
- `private pendingRemeshMap: Map<Chunk, boolean>`
- `private terrainTaskDeferLighting: unknown`
- `private terrainTaskQueue: Set<Chunk>`
- `private deferredLightingQueue: Chunk[]`
- `private deferredLightingQueueReadIdx: unknown`
- `private deferredLightingQueuedIds: unknown`
- `private deferredLightingSeedStates: unknown`
- `private deferredLightingPumpScheduled: unknown`
- `private distantTerrainReadyWorkers: unknown`
- `private distantTerrainTaskQueue: DistantTerrainTask[]`
- `private distantTerrainTaskQueueReadIdx: unknown`
- `private lodPrecomputeQueue: Array<{ chunk: Chunk; lod: number }>`
- `private lodPrecomputeQueueReadIdx: unknown`
- `private pendingLodPrecomputeKeys: unknown`
- `private lastPrecomputeScheduleTs: unknown`
- `private idleWorkerSet: Set<number>`
- `private idleWorkerIndices: number[]`
- `private idleWorkerIndexPositions: Map<number, number>`
- `private _idleReadIdx: unknown`
- `private _processQueueCallCount: unknown`
- `private meshResultQueue: FullMeshMessage[]`
- `private meshResultQueueReadIdx: unknown`
- `private remeshFlushScheduled: unknown`
- `private processQueuePumpScheduled: unknown`
- `private pendingRemeshSaveIds: unknown`
- `private pendingRemeshSaveTimer: ReturnType<typeof setTimeout> | null`
- `private readonly REMESH_SAVE_DEBOUNCE_MS: unknown`
- `private inFlightRemeshKeys: unknown`
- `private rerunRemeshAfterInflight: unknown`
- `private distantTerrainInFlight: unknown`
- `private nextDistantTerrainRequestId: unknown`
- `private opfsClient: OpfsClient | null`
- `private opfsReady: unknown`
- `private opfsInitPromise: Promise<void> | null`
- `private static readonly _flushPendingScratch: Array<[Chunk, boolean]>`
- `private static readonly _queryScratch: Chunk[]`
- `private static readonly _lodCandidateScratch: Array<{
		chunk: Chunk;
		lod: number;
		score: number;
	}>`
- `private nextLightSeqCounter: unknown`
- `private lightDirtyQueue: { seq: number; dirtySlots: Uint32Array }[]`
- `private lightDirtyQueueReadIdx: unknown`
- `private lightDirtyPumpScheduled: unknown`
- `private lightSlotPendingSeq: Map<number, number>`
- `private lightChunkByHeaderSlot: Map<number, Chunk>`
- `private lightHeaderBuffer: SharedArrayBuffer | null`
- `private closedFaceMaskBuffer: SharedArrayBuffer | null`
- `private debugStats: ChunkWorkerPoolDebugStats`
- `public onDistantTerrainGenerated: | ((data: DistantTerrainGeneratedMessage) => void)
		| null`
- `private processLightDirtyQueue: unknown`
- `private processMeshQueueLoop: unknown`
- `private static readonly UNDERGROUND_MAX_LOD: unknown`
- `private static readonly MAX_MESH_QUEUE: unknown`

**Methods**
- `private getDispatchBudgetPerTick(): number`
- `private hasPendingTasks(): boolean`
- `private getEffectiveIdleWorkerCount(): number`
- `private scheduleProcessQueuePump(): void`
- `private updateQueueDebugStats(): void`
- `public getDebugStats(): ChunkWorkerPoolDebugStats`
- `private recordWorkerDispatch(workerIndex: number): void`
- `private setWorkerTaskContext(workerIndex: number, context: WorkerTaskContext): void`
- `private resolveChunkByMessageId(chunkId: bigint): Chunk | undefined`
- `private isSameLodRemeshInflight(chunk: Chunk): boolean`
- `private clearInflightRemeshByMessage(chunkId: bigint, lod: number): void`
- `private _markWorkerIdle(workerIndex: number): void`
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
- `private scheduleLightDirtyPump(): void`
- `public async ensureOpfsReady(): Promise<OpfsClient | null>`
- `public getOpfsClient(): OpfsClient | null`
- `private isCompletelyEmptyChunk(chunk: Chunk): boolean`
- `private clearChunkMeshIfPresent(chunk: Chunk): void`
- `private enqueueDeferredLightingRefinement(chunk: Chunk, seedQueue: Uint16Array, seedLength: number): void`
- `private scheduleDeferredLightingPump(): void`
- `private processDeferredLightingQueue(): void`
- `private queuePostRemeshSave(chunk: Chunk): void`
- `private static resolvePoolSize(explicitPoolSize?: number): number`
- `public static getInstance(poolSize?: number): ChunkWorkerPool`
- `public scheduleRemesh(chunk: Chunk | undefined, priority: unknown = false): void`
- `private scheduleRemeshFlush(): void`
- `private flushPendingRemeshQueue(): void`
- `public scheduleDistantTerrain(centerChunkX: number, centerChunkZ: number, radius: number, renderDistance: number, gridStep: number): void`
- `private tryApplyCachedLODMesh(chunk: Chunk, allowDirtyReuse: unknown = false): boolean`
- `private makeTerrainMessageHandler(workerIndex: number, getWorker: () => ChunkWorker | undefined): (event: MessageEvent<WorkerResponseData>) => void`
- `private makeMeshMessageHandler(workerIndex: number, getWorker: () => ChunkWorker | undefined): (event: MessageEvent<MeshWorkerResponse>) => void`
- `private compareRemeshPriority(aChunk: Chunk, aPriority: boolean, bChunk: Chunk, bPriority: boolean): number`
- `private dequeueNextTerrainChunk(): Chunk | undefined`
- `private compactTaskQueue(): void`
- `private insertChunkIntoRemeshQueue(chunk: Chunk, priority: boolean): void`
- `public scheduleTerrainGeneration(chunk: Chunk, deferLighting: unknown = true): void`
- `public scheduleTerrainGenerationBatch(chunks: Chunk[], deferLighting: unknown = true): void`
- `private getQueuedTerrainDeferLighting(chunk: Chunk): boolean`
- `private dispatchTerrainTaskToWorker(workerIndex: number, worker: ChunkWorker, chunk: Chunk): boolean`
- `public scheduleBackgroundLodPrecompute(centerChunkX: number, centerChunkY: number, centerChunkZ: number): void`
- `private scheduleChunkAndNeighborsRemesh(chunk: Chunk): void`
- `private hasStableVoxelNeighborsForCachedMesh(chunk: Chunk): boolean`
- `private maybeRemeshNeighborsNowStable(chunk: Chunk): void`
- `public initDistantTerrainShared(positionsBuffer: SharedArrayBuffer, normalsBuffer: SharedArrayBuffer, surfaceTilesBuffer: SharedArrayBuffer, radius: number, gridStep: number): void`
- `private processQueue(): void`
- `public onChunkDisposed(chunk: Chunk): void`
- `public static async teardownForHmr(): Promise<void>`
- `private static shouldSkipLodForChunk(chunk: Chunk, lod: number): boolean`
- `private static clampLodForChunk(chunk: Chunk, lod: number): number`
- `private static normalizeChunkLod(chunk: Chunk): void`

**Module-level functions**
- `function packInflightKey(chunkId: bigint, lod: number): bigint`
- `function chunkDist(chunkX: number, chunkY: number, chunkZ: number, centerX: number, centerY: number, centerZ: number): { hDist: number; vDist: number }`

**Types / Interfaces / Enums**
- type `WorkerMessageData`
- type `ChunkWorkerPoolDebugStats`
- type `WorkerTaskContext`

---

## `World/Chunk/DataStructures/BlockEncoding.ts` (26 LOC)

**Module-level functions**
- `export function packBlockValue(blockId: number, state: unknown = 0): number`
- `export function unpackBlockId(value: number): number`
- `export function unpackBlockState(value: number): number`
- `export function packRotationSlice(rotation: number, slice: number): number`
- `export function unpackRotation(state: number): number`
- `export function unpackSlice(state: number): number`

---

## `World/Chunk/DataStructures/ChunkCoords.ts` (23 LOC)

**Module-level functions**
- `export function packCoords(x: number, y: number, z: number): bigint`
- `export function unpackChunkCoords(id: bigint): {
	x: number;
	y: number;
	z: number;
}`

---

## `World/Chunk/DataStructures/MeshData.ts` (28 LOC)

### export class MeshData

**Properties**
- `faceDataA: Uint8Array`
- `faceDataB: Uint8Array`
- `faceDataC: Uint8Array`
- `faceCount: unknown`

**Methods**
- `public static deserialize(data: any): MeshData`

**Module-level functions**
- `function toU8(raw: unknown): Uint8Array`

---

## `World/Chunk/DataStructures/PaletteExpander.ts` (37 LOC)

### export class PaletteExpander

**Methods**
- `expandPalette(packed: Uint8Array, palette: ArrayLike<number>, totalBlocks: number): Uint8Array | Uint16Array`
- `isUint16(palette: ArrayLike<number> | null | undefined): boolean`

---

## `World/Chunk/DataStructures/ResizableTypedArray.ts` (142 LOC)

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
- `pushFrom(other: ResizableTypedArray<T>): void`

---

## `World/Chunk/DataStructures/RingBuffer.ts` (50 LOC)

### export class RingBuffer

**Constructor**
- `constructor(capacity: number)`

**Properties**
- `private buf: (T | undefined)[]`
- `private head: unknown`
- `private tail: unknown`
- `private _size: unknown`
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
- enum `TaskType`
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

## `World/Chunk/Loading/ChunkPersistenceCoordinator.ts` (128 LOC)

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
- `private getChunkSaveBatchSize(): number`
- `private getChunkEntitySaveBatchSize(): number`
- `private async flushModifiedChunksInternal(maxChunks: number): Promise<void>`
- `private async flushChunkBoundEntitiesInternal(maxChunks: number): Promise<void>`

**Types / Interfaces / Enums**
- interface `ChunkPersistenceCoordinatorAdapter`

---

## `World/Chunk/Loading/ChunkProcessScheduler.ts` (434 LOC)

### export class ChunkProcessScheduler

**Constructor**
- `constructor(adapter: ChunkProcessSchedulerAdapter)`

**Properties**
- `private isProcessing: unknown`
- `private inFlightProcessState: InFlightProcessState | null`
- `private _state: InFlightProcessState`
- `private processContinuationScheduled: unknown`
- `private _saveScratch: Chunk[]`
- `private _nearIdScratch: bigint[]`
- `private _farIdScratch: bigint[]`

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

## `World/Chunk/Loading/ChunkStreamingController.ts` (833 LOC)

### export class ChunkStreamingController

**Constructor**
- `constructor(adapter: ChunkStreamingControllerAdapter)`

**Properties**
- `private static readonly DESIRED_STATE_REVISION_RETENTION: unknown`
- `private streamRevision: unknown`
- `private desiredStates: unknown`
- `private _needsDesiredStatePrune: unknown`
- `private loadQueueRequestMap: Map<bigint, QueuedChunkRequest>`
- `private loadedRefreshQueue: Chunk[]`
- `private loadedRefreshQueueSet: Set<bigint>`
- `private loadedRefreshQueueHead: unknown`
- `private _cachedCaveLodRuleSet: ChunkLodRuleSet | null`
- `private _cachedOutdoorLodRuleSet: ChunkLodRuleSet | null`
- `private _ruleSetGeneration: unknown`
- `private _lastRefreshDecision: Map<
		bigint,
		{
			playerX: number;
			playerY: number;
			playerZ: number;
			ruleRev: number;
			chunkLod: number;
			decisionLod: number;
		}
	>`
- `private _lastCaveState: boolean | null`
- `private _lastRenderDistance: unknown`
- `private _lastVerticalRadius: unknown`

**Methods**
- `public getDesiredState(chunkId: bigint): DesiredChunkState | undefined`
- `public async updateChunksAround(chunkX: number, chunkY: number, chunkZ: number, renderDistance: unknown = SETTING_PARAMS.RENDER_DISTANCE, verticalRadius: unknown = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE, prevChunkX?: number, prevChunkY?: number, prevChunkZ?: number, playerWorldX?: number, playerWorldZ?: number): Promise<void>`
- `private enqueueLoadedChunksForRefresh(chunkX: number, chunkY: number, chunkZ: number, lodRuleSet: ChunkLodRuleSet): void`
- `public processLoadedRefreshQueue(playerChunkX: number, playerChunkY: number, playerChunkZ: number, renderDistance: unknown = SETTING_PARAMS.RENDER_DISTANCE, verticalRadius: unknown = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE, maxChunks: unknown = SETTING_PARAMS.CHUNK_LOAD_BATCH_LIMIT): void`
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

**Module-level functions**
- `function chunkDist(chunkX: number, chunkY: number, chunkZ: number, centerX: number, centerY: number, centerZ: number): { hDist: number; vDist: number }`
- `function chunkDistScratch(chunkX: number, chunkY: number, chunkZ: number, centerX: number, centerY: number, centerZ: number): { hDist: number; vDist: number }`

**Types / Interfaces / Enums**
- interface `ChunkStreamingControllerAdapter`
- type `QueuedChunkRequest`
- type `DesiredChunkState`

---

## `World/Chunk/Loading/ChunkTypes.ts` (75 LOC)

**Types / Interfaces / Enums**
- type `ChunkBoundEntity`
- type `InFlightProcessState`
- type `ChunkLoadingDebugStats`
- enum `ProcessStage`

---

## `World/Chunk/Loading/ChunkWorldMutations.ts` (238 LOC)

### class ResolvedChunkCoords

**Properties**
- `chunkX: unknown`
- `chunkY: unknown`
- `chunkZ: unknown`
- `localX: unknown`
- `localY: unknown`
- `localZ: unknown`
- `chunk: Chunk | undefined`

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
- `private readonly cells: unknown`
- `private readonly chunkCellKeys: unknown`

**Methods**
- `register(chunk: Chunk): void`
- `unregister(chunk: Chunk): void`
- `query(centerX: number, centerY: number, centerZ: number, horizontalRadius: number, verticalRadius: number): IterableIterator<Chunk>`
- `queryCollect(centerX: number, centerY: number, centerZ: number, horizontalRadius: number, verticalRadius: number, out: Chunk[]): void`
- `all(): IterableIterator<Chunk>`

**Module-level functions**
- `function hashCellKey(cx: number, cy: number, cz: number): number`
- `function chunkToCellKey(chunk: Chunk): number`

---

## `World/Chunk/LOD/ChunkLodRules.ts` (233 LOC)

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
- `constructor(radii: ChunkLodRadii, rules: ChunkLodCreationRule[], revision: number = 0)`

**Methods**
- `public static fromRenderRadii(renderDistance: number, verticalRadius: number, revision: number = 0): ChunkLodRuleSet`
- `private resolveWithDistance(distance: ChunkLodDistance): ChunkLodDecision`
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

## `World/Chunk/MergedMeshManager.ts` (430 LOC)

### export class MergedMeshMeta

**Properties**
- `chunkOffsets: Float32Array | null`
- `chunkOffsetsArray: number[] | null`
- `isMerged: unknown`
- `__lodLevel: unknown`

**Module-level functions**
- `function markGroupDirty(group: MergedMeshGroup): void`
- `function copyFaceBytes(dst: Uint8Array, src: Uint8Array, byteCount: number, writeByte: number): void`
- `export function setOnGroupMeshNeedsRebuild(cb: GroupMeshRebuildCallback): void`
- `function getGroupGridCoords(chunkX: number, chunkY: number, chunkZ: number): { gx: number; gy: number; gz: number }`
- `function getLodRenderBucket(lod: number): number`
- `function makeGroupKey(gx: number, gy: number, gz: number, lodBucket: number): string`
- `function getLocalIndex(chunkX: number, chunkY: number, chunkZ: number): number`
- `export function getGroupKeyForChunk(chunk: Chunk): string`
- `export function getGroup(groupKey: string): MergedMeshGroup | undefined`
- `export function getAllGroups(): MergedMeshGroup[]`
- `export function assignChunkToGroup(chunk: Chunk, opaqueData: MeshData | null, transparentData: MeshData | null): MergedMeshGroup`
- `export function removeChunkFromGroup(chunk: Chunk): void`
- `export function flushDirtyMergedGroups(): void`
- `export function disposeAll(): void`
- `function ensureOpaqueMergedCapacity(group: MergedMeshGroup, faceCount: number): MergedBuffers`
- `function ensureTransparentMergedCapacity(group: MergedMeshGroup, faceCount: number): MergedBuffers`
- `function rebuildGroupData(group: MergedMeshGroup): void`

**Types / Interfaces / Enums**
- interface `ChunkMemberData`
- interface `MergedVertexData`
- interface `MergedBuffers`
- interface `MergedMeshGroup`
- type `GroupMeshRebuildCallback`

---

## `World/Chunk/voxel.worker.ts` (117 LOC)

**Module-level functions**
- `function expandCenterOnly(request: VoxelWorkerRequest): Uint8Array | Uint16Array`

**Types / Interfaces / Enums**
- interface `VoxelWorkerRequest`

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

## `World/Chunk/Worker/ChunkMesherConstants.ts` (54 LOC)

**Module-level functions**
- `export function filtersFullSunlight(blockId: number): boolean`

---

## `World/Chunk/Worker/LightCore.ts` (1062 LOC)

### class LightQueue

**Properties**
- `readonly chunks: (bigint | 0)[]`
- `readonly coords: unknown`
- `readonly levels: unknown`
- `head: unknown`
- `tail: unknown`

**Accessors**
- `get length(): number`

**Methods**
- `clear(): void`
- `push(chunkId: bigint, x: number, y: number, z: number, level: number): void`

**Module-level functions**
- `function getLightEmission(blockId: number): number`
- `function getFaceBit(axis: number, dir: number): number`
- `function getClosedFaceMaskForPacked(packed: number): number`
- `export function applyClosedFaceMaskLUT(lut: Uint8Array): void`
- `function isSourceTransparent(packed: number, axis: number, dir: number): boolean`
- `function isTargetTransparent(packed: number, axis: number, dir: number): boolean`
- `export function createRegistry(header: LightHeaderView): ChunkViewRegistry`
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
- `function addAdjacentBorderSlots(registry: ChunkViewRegistry, dirtySlots: Set<number>, view: ChunkView, x: number, y: number, z: number): void`
- `function _tryAddNeighbour(registry: ChunkViewRegistry, dirtySlots: Set<number>, view: ChunkView, dx: number, dy: number, dz: number): void`
- `function getViewBlockPacked(view: ChunkView, x: number, y: number, z: number): number`
- `function getBlockLight(view: ChunkView, idx: number): number`
- `function getSkyLight(view: ChunkView, idx: number): number`
- `function casLightByte(view: ChunkView, idx: number, isSky: boolean, nextLevel: number): WriteResult`
- `function clearLightByte(view: ChunkView, idx: number, isSky: boolean): boolean`
- `function processQueue(registry: ChunkViewRegistry, q: LightQueue, isSkyLight: boolean, dirtySlots: Set<number>): void`
- `function processRemoveQueue(registry: ChunkViewRegistry, q: LightQueue, isSkyLight: boolean, dirtySlots: Set<number>, initialOldPacked?: number): void`
- `export function lightMutate(registry: ChunkViewRegistry, chunkId: bigint, x: number, y: number, z: number, oldPacked: number, _newPacked: number): Set<number>`
- `function removeLightAt(registry: ChunkViewRegistry, view: ChunkView, x: number, y: number, z: number, startLevel: number, isSkyLight: boolean, dirtySlots: Set<number>, oldPacked?: number): void`
- `function updateLightFromNeighborsAt(registry: ChunkViewRegistry, view: ChunkView, x: number, y: number, z: number, isSkyLight: boolean, dirtySlots: Set<number>): void`
- `export function addLightAt(registry: ChunkViewRegistry, view: ChunkView, x: number, y: number, z: number, level: number, dirtySlots: Set<number>): void`
- `function cutSkyLightBelowAt(registry: ChunkViewRegistry, view: ChunkView, x: number, y: number, z: number, dirtySlots: Set<number>): void`
- `export function lightSkyReconcile(registry: ChunkViewRegistry, chunkId: bigint): Set<number>`
- `function batchPropagate(registry: ChunkViewRegistry, chunks: bigint[], coords: Int32Array, levels: Uint8Array, count: number, dirty: Set<number>): Set<number>`
- `export function lightBlockReconcile(registry: ChunkViewRegistry, chunkId: bigint): Set<number>`
- `export function propagateDeferred(registry: ChunkViewRegistry, chunkId: bigint, seedState: { queue: Uint16Array; length: number }): Set<number>`
- `export function bumpLightVersion(registry: ChunkViewRegistry, slot: number): void`

**Types / Interfaces / Enums**
- type `ChunkView`
- type `ChunkViewRegistry`
- enum `WriteResult`

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
- type `LightState`

---

## `World/Chunk/Worker/WorkerTaskHandlers.ts` (155 LOC)

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

## `World/Collision/VoxelAabbCollider.ts` (392 LOC)

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
- `public wouldOverlapBlock(position: Vector3, blockX: number, blockY: number, blockZ: number, blockShape: {
			boxes: Array<{
				min: [number, number, number];
				max: [number, number, number];
			}>;
			rotateY: boolean;
			usesSliceState: boolean;
		}, rotation: number, slice: number, flipY: boolean): boolean`
- `public moveAxis(position: Vector3, velocity: Vector3, axis: Axis, delta: number, stepSize: number): void`
- `public syncDebugMesh(position: Vector3): void`
- `public dispose(): void`
- `public static toggleDebugEnabled(): void`
- `public static setDebugEnabled(enabled: boolean): void`

**Module-level functions**
- `function rotateShapeBoxY(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, rotation: number, out: [number, number, number, number, number, number]): void`
- `function testShapeBoxOverlap(aMinX: number, aMaxX: number, aMinY: number, aMaxY: number, aMinZ: number, aMaxZ: number, eps: number, shape: ShapeDefinition, rotation: number, slice: number, flipY: boolean, blockX: number, blockY: number, blockZ: number): boolean`

**Types / Interfaces / Enums**
- type `BlockShapeInfo`
- type `IsSolidBlockAt`
- type `VoxelAabbDebugOptions`
- enum `Axis`

---

## `World/Collision/VoxelObbCollider.ts` (217 LOC)

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
- `#debugRot: unknown`
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

---

## `World/GLOBAL_VALUES.ts` (12 LOC)

---

## `World/Light/DistantTerrainShader.ts` (164 LOC)

### export class DistantTerrainShader

**Properties**
- `static readonly distantTerrainVertexShader: unknown`
- `static readonly distantTerrainFragmentShader: unknown`
- `static readonly distantWaterVertexShader: unknown`
- `static readonly distantWaterFragmentShader: unknown`

---

## `World/Light/Lod2Shader.ts` (293 LOC)

### export class Lod2Shader

**Properties**
- `static readonly chunkVertexShader: unknown`
- `static readonly opaqueFragmentShader: unknown`
- `static readonly transparentFragmentShader: unknown`

---

## `World/Light/Lod3Shader.ts` (237 LOC)

### export class Lod3Shader

**Properties**
- `public static readonly chunkVertexShader: unknown`
- `public static readonly opaqueFragmentShader: unknown`
- `public static readonly transparentFragmentShader: unknown`

---

## `World/Light/OpaqueShader.ts` (203 LOC)

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

## `World/Light/TransparentShader.ts` (262 LOC)

### export class TransparentShader

**Properties**
- `public static readonly chunkVertexShader: unknown`
- `public static readonly chunkFragmentShader: unknown`

---

## `World/MeshPipeline/core/AOPipeline.ts` (88 LOC)

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

## `World/MeshPipeline/core/CustomShapeEmitter.ts` (552 LOC)

**Module-level functions**
- `function parseBlockInto(packed: number, out: ParsedBlock): void`
- `function getFaceBit(axis: number, isBackFace: boolean): number`
- `function isWaterGlassInterface(curr: ParsedBlock, nbr: ParsedBlock): boolean`
- `export function emitCustomShapes(ctx: MeshContext, opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`
- `function emitCrossShapeAtBlock(x: number, y: number, z: number, blockId: number, baseLight: number, materialType: MaterialType = MaterialType.Cutout, out: WorkerInternalMeshData): void`
- `function emitCrossDiagonalAtBlock(x: number, y: number, z: number, blockId: number, baseLight: number, materialType: MaterialType = MaterialType.Cutout, out: WorkerInternalMeshData): void`
- `function emitLOD2CrossBillboard(x: number, y: number, z: number, blockId: number, baseLight: number, materialType: MaterialType, out: WorkerInternalMeshData): void`
- `function emitBoxFace(ctx: MeshContext, voxelX: number, voxelY: number, voxelZ: number, blockId: number, packedBlock: number, box: {
		min: [number, number, number];
		max: [number, number, number];
		faceMask: number;
	}, axis: number, isBackFace: boolean, baseLight: number, out: WorkerInternalMeshData): void`

**Types / Interfaces / Enums**
- type `ParsedBlock`
- type `FaceDescriptor`

---

## `World/MeshPipeline/core/FaceEmitter.ts` (59 LOC)

**Module-level functions**
- `export function emitQuad(out: WorkerInternalMeshData, params: EmitQuadParams): void`

---

## `World/MeshPipeline/core/GreedyPipeline.ts` (97 LOC)

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
}): Omit<MeshContext, "getBlock" | "getLight" | "hasNeighborChunk">`

---

## `World/MeshPipeline/core/MeshEmitters.ts` (37 LOC)

**Module-level functions**
- `export function createEmptyMeshData(): WorkerInternalMeshData`
- `export function buildVoxelMesh(ctx: MeshContext, opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`
- `export function buildWaterSurfaceMesh(ctx: MeshContext, grid: WaterSampleGrid, out: WorkerInternalMeshData): void`

---

## `World/MeshPipeline/core/ShapePipeline.ts` (324 LOC)

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
- type `FaceRect`

---

## `World/MeshPipeline/core/VoxelFaceEmitterAdapter.ts` (230 LOC)

### export class VoxelFaceEmitterAdapter

**Methods**
- `public emitVoxelFace(axis: number, desc: GreedyFaceDescriptor, opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`
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

## `World/MeshPipeline/core/VoxelGreedyAdapter.ts` (47 LOC)

### export class VoxelGreedyAdapter

**Constructor**
- `constructor(ctx: MeshContext)`

**Properties**
- `private ctx: MeshContext`
- `private maskExtractor: VoxelMaskExtractor`
- `private faceEmitter: VoxelFaceEmitterAdapter`

**Methods**
- `public setCtx(ctx: MeshContext): void`
- `public build(opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`
- `private runForAxis(axis: number, opaqueOut: WorkerInternalMeshData, transparentOut: WorkerInternalMeshData): void`

---

## `World/MeshPipeline/core/VoxelMaskExtractor.ts` (545 LOC)

### export class VoxelMaskExtractor

**Constructor**
- `constructor(ctx: MeshContext)`

**Properties**
- `private ctx: MeshContext`

**Methods**
- `public setCtx(ctx: MeshContext): void`
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
- `function getCachedIsCube(packed: number): boolean`
- `function getCachedFlags(packed: number): number`

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

## `World/MeshPipeline/core/WaterPipeline.ts` (114 LOC)

**Module-level functions**
- `export function buildWaterMesh(_ctx: MeshContext, grid: WaterSampleGrid, out: WorkerInternalMeshData): void`

**Types / Interfaces / Enums**
- interface `WaterSurfaceSample`
- interface `WaterSampleGrid`

---

## `World/MeshPipeline/core/WorkerMeshHelpers.ts` (201 LOC)

**Module-level functions**
- `function readPackedNibble(packed: Uint8Array, index: number): number`
- `function readNeighborBlock(neighbor: Uint8Array | Uint16Array | undefined, palette: Uint8Array | Uint16Array | null | undefined, uniformId: number | undefined, index: number, totalBlocks: number, fallback: number): number`
- `export function createEmptyWorkerInternalMeshData(): WorkerInternalMeshData`
- `export function toTransferableMeshData(data: WorkerInternalMeshData): MeshData`
- `function getNeighborIndex(dx: number, dy: number, dz: number): number`
- `export function createMeshContextFromPayload(base: WorkerMeshBaseContext, input: WorkerMeshInput): MeshContext`

**Types / Interfaces / Enums**
- type `WorkerMeshBaseContext`
- type `WorkerMeshInput`
- type `NeighborSample`

---

## `World/MeshPipeline/types/MeshTypes.ts` (48 LOC)

**Types / Interfaces / Enums**
- interface `MeshContext`
- interface `EmitQuadParams`
- interface `BlockShapeInfo`
- interface `GreedyFaceDescriptor`
- type `WorkerInternalMeshData`
- enum `MaterialType`

---

## `World/Occlusion/OcclusionCuller.ts` (707 LOC)

### export class OcclusionCuller

**Properties**
- `private _topoVisibleChunks: Chunk[]`
- `private _prevTopoChunks: Chunk[]`
- `private _currentQueryId: unknown`
- `private _lastCompletedQueryId: unknown`
- `private _lastCamCX: unknown`
- `private _lastCamCY: unknown`
- `private _lastCamCZ: unknown`
- `private _topologyDirty: unknown`
- `private _topoDirtyFrameCount: unknown`
- `private static readonly TOPO_THROTTLE_FRAMES: unknown`
- `private _dirtyConnectivityChunks: Chunk[]`
- `private _bfsInProgress: unknown`
- `private _bfsQHead: unknown`
- `private _bfsQTail: unknown`

**Methods**
- `update(_scene: Scene, out: OcclusionStats): OcclusionStats`
- `incrementalAdd(newChunk: Chunk): void`
- `private _startBFS(camCX: number, camCY: number, camCZ: number, SIZE: number): void`
- `private _stepBFS(budget: number): void`

**Module-level functions**
- `function initFacePairTable(): void`
- `function cacheFrustumPlanes(vp: Matrix): void`
- `function aabbInFrustum(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean`
- `function resetChunkBfs(chunk: Chunk, queryId: number): void`
- `function minFSteps(fs: Uint8Array): number`
- `function hasConnectivity(neighborVisited: number, exitFace: number, fc: number): boolean`

**Types / Interfaces / Enums**
- interface `OcclusionStats`

---

## `World/Pathfinding/Pathfinding.ts` (389 LOC)

### class AStarHeap

**Properties**
- `private items: AStarNode[]`

**Accessors**
- `get size(): number`

**Methods**
- `clear(): void`
- `push(item: AStarNode): void`
- `pop(): AStarNode | undefined`

**Module-level functions**
- `function hasClearance(x: number, z: number, groundY: number, headroom: number, allowWater: boolean): boolean`
- `function findWaterSurface(x: number, z: number, startY: number, searchUp: number, searchDown: number): SurfaceResult | null`
- `export function findSurface(x: number, z: number, startGroundY: number, stepUp: number, stepDown: number, headroom: number, allowWater: unknown = true): SurfaceResult | null`
- `export function findLandSurface(x: number, z: number, startY: number, headroom: number): { groundY: number } | null`
- `export function isLandAt(x: number, z: number, startY: number, headroom: number): boolean`
- `function nodeKey(x: number, z: number, y: number, kind: PathNodeKind): number`
- `function allocNode(x: number, z: number, groundY: number, kind: PathNodeKind, g: number, h: number, parent: AStarNode | null): AStarNode`
- `function releaseUsedNodes(): void`
- `function buildPathInto(outPath: PathWaypoint[], endNode: AStarNode): void`
- `export function findPathInto(outPath: PathWaypoint[], startX: number, startZ: number, startGroundY: number, targetX: number, targetZ: number, headroom: number, maxExpansions: unknown = 300, requiredTargetGroundY?: number): boolean`

**Types / Interfaces / Enums**
- interface `PathWaypoint`
- interface `AStarNode`
- interface `SurfaceResult`
- enum `PathNodeKind`

---

## `World/SETTINGS_PARAMS.ts` (37 LOC)

---

## `World/Shape/BlockShapes.ts` (204 LOC)

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
- type `GetBlockFn`

---

## `World/Storage/ChunkKey.ts` (39 LOC)

**Module-level functions**
- `function validateAxis(v: number, name: string): void`
- `export function packChunkKey(chunkX: number, chunkY: number, chunkZ: number): bigint`
- `export function unpackChunkKey(key: bigint): {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
}`

---

## `World/Storage/MeshSerializer.ts` (104 LOC)

**Module-level functions**
- `export function serializeMesh(mesh: MeshData | null | undefined): Uint8Array | null`
- `export function deserializeMesh(bytes: Uint8Array): MeshData`
- `export function serializeMeshPair(opaque: MeshData | null | undefined, transparent: MeshData | null | undefined): Uint8Array | null`
- `export function deserializeMeshPair(bytes: Uint8Array, lod: number): DeserializedMeshPair`

**Types / Interfaces / Enums**
- type `DeserializedMeshPair`

---

## `World/Storage/opfs.worker.ts` (277 LOC)

**Module-level functions**
- `function _enqueueOp(fn: () => Promise<void>): Promise<void>`
- `async function _drainOpQueue(): Promise<void>`
- `function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array`
- `function localCoord(chunk: number): number`
- `function regionKey(rx: number, ry: number, rz: number): string`
- `async function ensureRegionsDir(): Promise<FileSystemDirectoryHandle>`
- `async function getRegionFile(rx: number, ry: number, rz: number): Promise<RegionFile>`
- `function markDirty(): void`
- `function flushAllRegions(): void`
- `async function ensureMeshStore(): Promise<OpfsChunkStore>`
- `function resetMeshStore(): void`
- `async function withMeshRetry(fn: (s: OpfsChunkStore) => Promise<T>): Promise<T>`
- `async function openStores(): Promise<void>`

**Types / Interfaces / Enums**
- type `QueuedOp`

---

## `World/Storage/OpfsChunkStore.ts` (287 LOC)

### export class OpfsChunkStore

**Constructor**
- `constructor()`

**Properties**
- `private _fileHandle: FileSystemFileHandle | null`
- `private _accessHandle: FileSystemSyncAccessHandle | null`
- `private _tableBuffer: ArrayBuffer`
- `private _tableView: DataView`
- `private _size: number`
- `private _capacity: number`
- `private _dataSize: bigint`
- `private _dirty: unknown`
- `private _opQueue: PendingOp[]`
- `private _processing: unknown`
- `private readonly _scratch: ArrayBuffer`
- `private readonly _scratchDv: DataView`
- `private readonly _scratchU8: Uint8Array`
- `private _fileSize: unknown`
- `private static readonly INITIAL_CAPACITY: unknown`

**Accessors**
- `private get _dataStartOffset(): number`

**Methods**
- `async open(name: string): Promise<void>`
- `async close(): Promise<void>`
- `async write(keyHi: number, keyLo: number, lod: number, data: Uint8Array): Promise<void>`
- `async read(keyHi: number, keyLo: number, lod: number): Promise<Uint8Array | null>`
- `async remove(keyHi: number, keyLo: number, lod: number): Promise<boolean>`
- `async flush(): Promise<void>`
- `private async _init(): Promise<void>`
- `private async _load(): Promise<void>`
- `private _findSlot(keyHi: number, keyLo: number, lod: number): { dv: DataView; index: number }`
- `private _grow(): void`
- `private _writeHeader(): void`
- `private async enqueue(fn: () => Promise<void>): Promise<void>`
- `private async _drainQueue(): Promise<void>`

**Types / Interfaces / Enums**
- interface `PendingOp`

---

## `World/Storage/OpfsClient.ts` (145 LOC)

### export class OpfsClient

**Constructor**
- `constructor()`

**Properties**
- `private _worker: Worker`
- `private _ops: unknown`
- `private _nextId: unknown`
- `private _ready: Promise<void>`

**Methods**
- `async ready(): Promise<void>`
- `private _postMessage(type: OpfsMsg, payload: Record<string, any> = {}, transfer: Transferable[] = []): Promise<any>`
- `private _onMessage(msg: { id: number; error?: string; result?: any }): void`
- `private _packKey(key: bigint): { hi: number; lo: number }`
- `private _unpackKey(key: bigint): {
		chunkX: number;
		chunkY: number;
		chunkZ: number;
	}`
- `async readMesh(key: bigint, lod: number): Promise<Uint8Array | null>`
- `async writeMesh(key: bigint, lod: number, data: Uint8Array): Promise<void>`
- `async removeMesh(key: bigint, lod: number): Promise<boolean>`
- `async readVoxel(key: bigint, lod: number): Promise<Uint8Array | null>`
- `async writeVoxel(key: bigint, lod: number, data: Uint8Array): Promise<void>`
- `async removeVoxel(key: bigint, lod: number): Promise<void>`
- `async flush(): Promise<void>`
- `getStats(): any`
- `static async create(): Promise<OpfsClient>`
- `async close(): Promise<void>`

**Types / Interfaces / Enums**
- interface `PendingOp`

---

## `World/Storage/OpfsMessageTypes.ts` (12 LOC)

**Types / Interfaces / Enums**
- enum `OpfsMsg`

---

## `World/Storage/RegionFile.ts` (361 LOC)

### export class RegionFile

**Constructor**
- `constructor(accessHandle: FileSystemSyncAccessHandle, headerBuf: ArrayBuffer, headerU8: Uint8Array, headerDv: DataView, slotTable: ArrayBuffer, slotDv: DataView, regionX: number, regionY: number, regionZ: number, usedBytes: number, occupiedCount: number, freeListHead: number, fileSize: number)`

**Properties**
- `private accessHandle: FileSystemSyncAccessHandle`
- `private headerBuf: ArrayBuffer`
- `private headerU8: Uint8Array`
- `private headerDv: DataView`
- `private slotTable: ArrayBuffer`
- `private slotDv: DataView`
- `private regionX: number`
- `private regionY: number`
- `private regionZ: number`
- `private usedBytes: number`
- `private occupiedCount: number`
- `private freeListHead: number`
- `private fileSize: number`
- `private headerDirty: unknown`
- `private readonly _dirtyBits: unknown`

**Methods**
- `static async open(accessHandle: FileSystemSyncAccessHandle, regionX: number, regionY: number, regionZ: number): Promise<RegionFile>`
- `private readSlotSize(idx: number): number`
- `private readSlotOffset(idx: number): number`
- `private markDirty(idx: number): void`
- `private writeSlotInMemory(idx: number, offset: number, size: number): void`
- `private commitHeader(): void`
- `private markAllSlotsDirty(): void`
- `private static _compact(rf: RegionFile, accessHandle: FileSystemSyncAccessHandle): void`
- `readChunk(lx: number, ly: number, lz: number, isEntity: boolean): Uint8Array | null`
- `writeChunk(lx: number, ly: number, lz: number, isEntity: boolean, data: Uint8Array): void`
- `removeChunk(lx: number, ly: number, lz: number, isEntity: boolean): void`
- `flush(): void`
- `close(): void`

**Module-level functions**
- `function slotIndex(lx: number, ly: number, lz: number, isEntity: boolean): number`

**Types / Interfaces / Enums**
- type `LiveSlot`

---

## `World/Storage/VoxelSerializer.ts` (167 LOC)

**Module-level functions**
- `export function serializeVoxelData(blocks: Uint8Array | Uint16Array | null, palette: Uint16Array | null | undefined, isUniform: boolean | undefined, uniformBlockId: number | undefined, lightArray: Uint8Array | null | undefined, compressed: boolean | undefined): Uint8Array`
- `export function deserializeVoxelData(data: Uint8Array): SavedChunkData`
- `export function serializeEntities(entities: SavedChunkEntityData[]): Uint8Array`
- `export function deserializeEntities(data: Uint8Array): SavedChunkEntityData[]`

**Types / Interfaces / Enums**
- type `SavedChunkData`
- type `SavedChunkEntityData`

---

## `World/Texture/BlockTextures.ts` (54 LOC)

**Module-level functions**
- `function buildBlockTextures(): (BlockTextureDef | null)[]`
- `function getMaxBlockTypeId(): number`
- `export function updateBlockTexturesUV(uvMap: Record<string, { u: number; v: number; tileSize: number }>, textureDefinitions: TextureDefinition[]): void`
- `export function getAtlasTile(blockId: number | null): [number, number] | null`

**Types / Interfaces / Enums**
- type `BlockTextureDef`

---

## `World/Texture/BlockType.ts` (112 LOC)

**Module-level functions**
- `export function isPassThroughBlock(blockId: number): boolean`
- `export function isCollidableBlock(blockId: number): boolean`
- `export function getMovementCost(blockId: number): number`

**Types / Interfaces / Enums**
- enum `BlockType`

---

## `World/Texture/FaceName.ts` (24 LOC)

**Module-level functions**
- `export function getFaceName(axis: number, isBackFace: boolean): FaceName`

**Types / Interfaces / Enums**
- enum `FaceName`

---

## `World/Texture/MaterialFactory.ts` (118 LOC)

### export class MaterialFactory

**Properties**
- `private static materialCache: unknown`

**Methods**
- `private static createTexture(scene: Scene, path: string, uvScale: number): Texture`
- `static createMaterialByFolder(scene: Scene, folder: string, uvScale: unknown = 1, extension: unknown = ".png", diff: unknown = true, nor: unknown = false, ao: unknown = false, spec: unknown = false): StandardMaterial`
- `private static buildMaterial(scene: Scene, mat: StandardMaterial, directory: string, baseName: string, resolution: string, extension: string, uvScale: number, diff: boolean, nor: boolean, ao: boolean, spec: boolean, cacheKey: string): StandardMaterial`
- `public static getTexturePathFromFolder(folder: string, type: unknown = "diff", extension: unknown = ".png"): string | null`
- `static disposeAll(): void`

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

## `World/WorldStorage.ts` (378 LOC)

### class WorldStorageImpl

**Properties**
- `private initPromise: Promise<void> | null`

**Methods**
- `initialize(): Promise<void>`
- `private async getClient(): Promise<OpfsClient | null>`
- `private async compress(data: Uint8Array | Uint16Array): Promise<Uint8Array>`
- `private async decompressToShared(data: Uint8Array): Promise<Uint8Array | Uint16Array>`
- `private getGzipISize(data: Uint8Array): number`
- `private isUint8Array(value: Uint8Array | Uint16Array | null | undefined): value is Uint8Array`
- `private detachSharedArrayBuffer(view: T): T`
- `private packKey(chunkX: number, chunkY: number, chunkZ: number): bigint`
- `async saveChunk(chunk: Chunk): Promise<void>`
- `async saveChunks(chunks: Chunk[]): Promise<void>`
- `async saveAllModifiedChunks(): Promise<void>`
- `async saveChunkEntities(chunkId: bigint, entities: SavedChunkEntityData[]): Promise<void>`
- `async loadChunkEntities(chunkId: bigint): Promise<SavedChunkEntityData[]>`
- `async loadChunk(chunkId: bigint, options?: LoadChunkOptions): Promise<SavedChunkData | null>`
- `async loadChunks(chunkIds: bigint[], options?: LoadChunkOptions): Promise<Map<bigint, SavedChunkData>>`
- `async clearWorldData(): Promise<void>`
- `private async clearOldOpfsData(): Promise<void>`

**Types / Interfaces / Enums**
- type `LoadChunkOptions`

---
