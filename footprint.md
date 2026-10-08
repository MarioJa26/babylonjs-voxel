# Project Footprint

Generated: 2026-10-08T23:33:55.816Z

> **Summary:** 157 classes · 2395 members · 1177 module-level functions · 100567 LOC

---

## `Audio/AudioManager.ts` (152 LOC)

**Module-level functions**
- `function clamp01(value: number): number`
- `function loadPersistedAudio(): void`
- `function persistAudio(): void`
- `function getEffectiveVolume(): number`
- `function applyGain(): void`
- `function ensureContext(): AudioContext | null`
- `export function getMasterVolume(): number`
- `export function isMuted(): boolean`
- `export function setMasterVolume(value: number): void`
- `export function setMuted(value: boolean): void`
- `export function applyAudioSettings(settings: {
	masterVolume: number;
	muted: boolean;
}): void`
- `export function getAudioOutput(): GainNode | null`
- `export function makeNoiseBuffer(seconds: number): AudioBuffer | null`

---

## `Audio/SurfaceAudio.ts` (402 LOC)

**Module-level functions**
- `export function surfaceKindForDef(blockId: number, def: SurfaceBlockInfo | undefined): SurfaceKind`
- `export function surfaceKindForBlock(blockId: number): SurfaceKind`
- `function playTap(preset: TapPreset, intensity: number): void`
- `export function playFootstep(blockId: number, intensity = 1): boolean`
- `export function playMineHit(blockId: number): void`
- `export function playBlockBreak(blockId: number): void`
- `export function playBlockPlace(blockId: number, intensity = 1): void`
- `export function playLand(blockId: number, fallDistance: number): void`

**Types / Interfaces / Enums**
- interface `SurfaceBlockInfo`
- interface `TapPreset`
- interface `KindTaps`
- type `SurfaceKind`

---

## `Audio/TntAudio.ts` (113 LOC)

**Module-level functions**
- `function getContextBuffers(ctx: BaseAudioContext): NoiseBuffers`
- `function getExplosionBuffer(ctx: BaseAudioContext): AudioBuffer | null`
- `function getFuseBuffer(ctx: BaseAudioContext): AudioBuffer | null`
- `export function playExplosionSound(intensity = 1): void`
- `export function playFuseHiss(): void`

**Types / Interfaces / Enums**
- type `NoiseBuffers`

---

## `Entities/AdvancedBoat.ts` (342 LOC)

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
- `public getBoatPositionToRef(out: Vec3): void`
- `public getBoatTopYToRef(out: Vec3): void`
- `public getBoatTopY(): Vec3`
- `use(player: Player): void`

**Types / Interfaces / Enums**
- type `Mesh`
- type `SceneContext`
- type `Vec3`

---

## `Entities/Arrow/Arrow.ts` (896 LOC)

**Types / Interfaces / Enums**
- type `InstanceSlotHandle`
- type `ArrowTypeDef`

---

## `Entities/Arrow/ArrowInstancePool.ts` (387 LOC)

### export class ArrowInstancePool

**Constructor**
- `constructor()`

**Properties**
- `readonly mesh: Mesh`
- `_buildGroup?: (scene: unknown, meshes: unknown[]) => Promise<unknown>`

**Accessors**
- `get activeCount(): number`

**Methods**
- `setThinInstances(mesh, this.#matrices, 0)`
- `addToScene(Map1.mainScene, mesh)`
- `acquire(color: Color3): InstanceSlotHandle`
- `release(holder: InstanceSlotHandle): void`
- `writeMatrix(holder: InstanceSlotHandle, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number): void`
- `writeColor(holder: InstanceSlotHandle, r: number, g: number, b: number, a = 1): void`
- `sync(): void`
- `setThinInstances(this.mesh, newMatrices, this.#count)`

**Module-level functions**
- `function createArrowMaterial(): ShaderMaterial`
- `export function getArrowInstancePool(): ArrowInstancePool`

**Types / Interfaces / Enums**
- type `Mesh`
- type `ShaderMaterial`
- type `PackedThinInstances`
- type `InstanceSlotHandle`

---

## `Entities/Arrow/ArrowTypes.ts` (119 LOC)

**Module-level functions**
- `export function getArrowTooltipStats(itemId: number): string | null`

**Types / Interfaces / Enums**
- interface `ArrowTypeDef`
- type `ArrowTypeName`

---

## `Entities/CustomBoat.ts` (872 LOC)

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
- `ignoredDynamicBlockProviders: this.#ignoredDynamicBlockProviders,`
- `blockId: 0,`
- `blockState: 0,`
- `lightLevel: 0,`
- `minX: 0,`
- `minY: 0,`
- `minZ: 0,`
- `maxX: 0,`
- `maxY: 0,`
- `maxZ: 0,`
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
- `helmLocal: this.#helmLocal`
- `boatChunk: boatChunkSnapshot`
- `blocks: boatChunkSnapshot.blocks.slice(),`
- `center: { x: boatChunkSnapshot.center.x, y: boatChunkSnapshot.center.y, z: boatChunkSnapshot.center.z, },`
- `type: CustomBoat.CHUNK_ENTITY_TYPE,`
- `localX: number,`
- `localY: number,`
- `localZ: number,`
- `worldX: number,`
- `worldY: number,`
- `worldZ: number,`
- `worldX: number,`
- `worldY: number,`
- `worldZ: number,`
- `blockId: number,`
- `blockState: number,`
- `worldX: number,`
- `worldY: number,`
- `worldZ: number,`

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
- `public static getBoatForChunk(chunk: BoatChunk): CustomBoat | null`
- `public static getActiveBoats(): readonly CustomBoat[]`
- `public static tickAllActiveBoats(scene: SceneContext, deltaMs: number, playerPos?: Vec3): void`
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
- `scaleVec3InPlace(this.#linearVelocity, d ** k)`
- `scaleVec3InPlace(this.#angularVelocity, ad ** k)`
- `setVec3(this.#tmpLever, worldPoint.x - this.#boat.position.x, worldPoint.y - this.#boat.position.y, worldPoint.z - this.#boat.position.z)`
- `setVec3(this.#tmpTorque, this.#tmpLever.y * fz - this.#tmpLever.z * fy, this.#tmpLever.z * fx - this.#tmpLever.x * fz, this.#tmpLever.x * fy - this.#tmpLever.y * fx)`
- `public applyImpulse(impulse: Vec3, point: Vec3)`
- `public applyAngularImpulse(impulse: Vec3): void`
- `public getBoatPositionToRef(out: Vec3): void`
- `public getBoatTopYToRef(out: Vec3): void`
- `public getBoatTopY(): Vec3`
- `public use(player: Player): void`
- `setVec3(this.#helmMountOffset, helmX - fx * behindDistance - this.#boat.position.x, feetY - this.#boat.position.y, helmZ - fz * behindDistance - this.#boat.position.z)`
- `public dispose(): void`
- `setVec3(this.#collisionCenterOffset, (obbMaxX + obbMinX) / 2, 0, (obbMaxZ + obbMinZ) / 2)`
- `setVec3(this.#collisionHalfExtents, halfX + pad, halfY + pad, halfZ + pad)`
- `setVec3(this.#tmpBoatSampleWorld, worldX + 0.5, worldY + 0.5, worldZ + 0.5)`

**Types / Interfaces / Enums**
- type `Mesh`
- type `SceneContext`
- type `Vec3`
- type `DynamicBlockQueryOptions`
- type `DynamicBlockSample`
- type `CustomBoatOptions`
- type `SerializedBoatChunk`
- type `CustomBoatSerializedPayload`

---

## `Entities/MayaDungeonEncounter.ts` (210 LOC)

### export class MayaDungeonEncounter

**Properties**
- `templeId: resolved.templeId,`
- `layout: buildTempleLayout(resolved, this.#seedAsInt),`
- `mobs: new Map(),`
- `mob`
- `mob`
- `mob`

**Methods**
- `dispose(): void`
- `getLiveGuardianCount(templeId: number): number`
- `getLiveBoss(): MayaGuardian | null`

**Module-level functions**
- `export function getMayaDungeonEncounter(): MayaDungeonEncounter | null`

**Types / Interfaces / Enums**
- type `MayaGuardianPost`
- type `MayaTempleLayout`
- type `ActiveTemple`

---

## `Entities/MayaTempleGlyphs.ts` (166 LOC)

**Module-level functions**
- `export function findGlyphAt(worldX: number, worldY: number, worldZ: number, seedAsInt: number)`
- `export function countChargedSanctums(layout: MayaTempleLayout, seedAsInt: number): number`
- `export function sanctumCount(layout: MayaTempleLayout): number`
- `export function hasGlyphRing(glyph: MayaGlyph): boolean`

**Types / Interfaces / Enums**
- type `MayaGlyph`
- type `MayaTempleLayout`
- type `GlyphInteraction`
- type `BlockWriteSink`

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

## `Entities/MobConfig.ts` (261 LOC)

**Module-level functions**
- `export function getMobStats(typeId: number): MobStats`
- `export function getMobSpawnConfig(typeId: number): MobSpawnConfig`
- `export function isHostileTypeId(typeId: number): boolean`
- `export function isBirdTypeId(typeId: number): boolean`
- `export function isNightTimeFraction(fraction: number): boolean`

**Types / Interfaces / Enums**
- interface `MobStats`

---

## `Entities/Mobs/AquaticMob.ts` (688 LOC)

---

## `Entities/Mobs/Bird.ts` (265 LOC)

### export class Bird extends FlyingMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: SceneContext, hp?: number)`

**Properties**
- `readonly mobType`

**Methods**
- `super(hp ?? BIRD_DEFAULT_HP, scene, BIRD_BODY_HALF_SIZE, BIRD_STATS.feetHeight)`
- `getBodyPool()`
- `registerMobLight({
			pool: getBodyPool(),
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [1, 1, 1],
			owner: this,
		})`
- `static createFlock(x: number, y: number, z: number, scene: SceneContext, count: number, registry: MobRegistry): Bird[]`
- `protected override syncToInstances(): void`
- `getWanderSpeed(): number`
- `protected override pickWaypoint(pos: Vec3): Vec3 | null`
- `protected override onWaypointReached(): void`
- `onDeath(): void`
- `dispose(): void`

**Module-level functions**
- `function getBodyPool(): MobInstancePool`
- `export function getBirdInstancePool(): MobInstancePool`

**Types / Interfaces / Enums**
- interface `BirdFlock`

---

## `Entities/Mobs/Chicken.ts` (189 LOC)

### export class Chicken extends NeutralMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: SceneContext, hp?: number)`

**Properties**
- `readonly mobType`
- `readonly CHUNK_ENTITY_TYPE`

**Methods**
- `super(hp ?? CHICKEN_DEFAULT_HP, scene, CHICKEN_BODY_HALF_SIZE, CHICKEN_STATS.feetHeight)`
- `getBodyPool()`
- `registerMobLight({
			pool: getBodyPool(),
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [1, 1, 1],
			owner: this,
		})`
- `protected override syncToInstances(): void`
- `configureChunkLoader(scene: SceneContext): void`
- `getWanderSpeed(): number`
- `onDeath(): void`
- `dispose(): void`

**Module-level functions**
- `function getBodyPool(): MobInstancePool`
- `export function getChickenInstancePool(): MobInstancePool`

**Types / Interfaces / Enums**
- type `ChickenSerializedPayload`

---

## `Entities/Mobs/Cow.ts` (210 LOC)

### export class Cow extends NeutralMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: SceneContext, hp?: number)`

**Properties**
- `readonly mobType`
- `readonly CHUNK_ENTITY_TYPE`

**Methods**
- `super(hp ?? COW_DEFAULT_HP, scene, COW_BODY_HALF_SIZE, COW_STATS.feetHeight)`
- `getBodyPool()`
- `registerMobLight({
			pool: getBodyPool(),
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [1, 1, 1],
			owner: this,
		})`
- `protected override syncToInstances(): void`
- `configureChunkLoader(scene: SceneContext): void`
- `getWanderSpeed(): number`
- `protected override getPanicRadiusSq(): number`
- `protected override onDamaged(): void`
- `onDeath(): void`
- `dispose(): void`

**Module-level functions**
- `function getBodyPool(): MobInstancePool`
- `export function getCowInstancePool(): MobInstancePool`

**Types / Interfaces / Enums**
- type `CowSerializedPayload`

---

## `Entities/Mobs/Fish.ts` (207 LOC)

### export class Fish extends AquaticMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: SceneContext, hp?: number, color?: Color3)`

**Properties**
- `readonly mobType`
- `readonly CHUNK_ENTITY_TYPE`

**Methods**
- `super(hp ?? FISH_DEFAULT_HP, scene, FISH_BODY_HALF_SIZE)`
- `getBodyPool()`
- `registerMobLight({
			pool: getBodyPool(),
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [this.#color.r, this.#color.g, this.#color.b],
			owner: this,
		})`
- `protected override syncToInstances(): void`
- `configureChunkLoader(scene: SceneContext): void`
- `getWanderSpeed(): number`
- `protected override getDepthRange()`
- `protected override getWaterSearchBias(): number`
- `protected override getIdleChance(): number`
- `protected override getExtraPayload(): Record<string, unknown>`
- `onDeath(): void`
- `dispose(): void`

**Module-level functions**
- `function getBodyPool(): MobInstancePool`
- `export function getFishInstancePool(): MobInstancePool`
- `function randomFishColor(): Color3`

**Types / Interfaces / Enums**
- type `FishPayload`

---

## `Entities/Mobs/FlyingMob.ts` (403 LOC)

### abstract export class FlyingMob

**Constructor**
- `constructor(hp: number, scene: SceneContext, halfSize: Vec3, _feetHeight?: number)`

**Properties**
- `readonly abstract mobType: string`
- `countsTowardMobCap`

**Accessors**
- `protected get isHolding(): boolean`
- `get facingYaw(): number`
- `protected get walkPhase(): number`
- `get hitHalfExtents(): Vec3`
- `protected get scene(): SceneContext`
- `get position(): Vec3`
- `get hp(): number`
- `set hp(value: number)`
- `get maxHp(): number`
- `get isDisposed(): boolean`

**Methods**
- `abstract getWanderSpeed(): number`
- `abstract onDeath(): void`
- `protected abstract syncToInstances(): void`
- `protected abstract pickWaypoint(pos: Vec3): Vec3 | null`
- `protected onWaypointReached(): void`
- `protected getPanicRadiusSq(): number`
- `protected onDamaged(): void`
- `protected triggerPanic(duration: number): void`
- `protected holdStill(seconds: number): void`
- `onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			const dt = deltaMs * 0.001;
			if (dt <= 0 || isUiOpen()) return;

			
			
			const night = isNightNow();

			frameProfiler.begin(       );
			for (const mob of FlyingMob.#allMobs) {
				const pos = mob.#position;
				const chunk = getChunk(
					Math.floor(pos.x / Chunk.SIZE),
					Math.floor(pos.y / Chunk.SIZE),
					Math.floor(pos.z / Chunk.SIZE),
				);

				
				
				if (
					!chunk?.isLoaded ||
					!chunk?.hasVoxelData ||
					(chunk?.lodLevel ?? 2) > 1
				) {
					continue;
				}

				mob.tick(dt, night);
			}
			frameProfiler.end(       );
		})`
- `static disposeAll(): void`
- `createVoxelColliderBlockSampler((wx, wy, wz) => {
					const r = resolveBlockAtWorldCoords(wx, wy, wz);
					if (r.unloaded) return UNLOADED_SOLID_RESOLVE;
					if (!isCollidableBlock(r.blockId)) return null;

					_voxelResolveScratch.blockId = r.blockId;
					_voxelResolveScratch.blockState = r.blockState;
					return _voxelResolveScratch;
				}, {
					getFenceDynamicShape,
					getShapeForBlockId,
					isFenceBlockId,
					computeFenceNeighborMask,
				})`
- `protected setPosition(x: number, y: number, z: number): void`
- `protected finalizeRegistration(): void`
- `setPlayerPosition(pos: Vec3): void`
- `takeDamage(amount: number, impactPosition?: Vec3): void`
- `serializeForChunkReload(): SavedChunkEntityData | null`
- `use(_player: Player): void`
- `dispose(): void`
- `tick(dt: number, night: boolean): void`

**Module-level functions**
- `function isNightNow(): boolean`

---

## `Entities/Mobs/HostileMob.ts` (778 LOC)

### abstract export class HostileMob

**Properties**
- `readonly abstract mobType: string`
- `readonly abstract CHUNK_ENTITY_TYPE: string`
- `countsTowardMobCap`
- `revB`
- `px`
- `feetY`
- `pz`
- `revA`
- `revB`

**Methods**
- `abstract configureChunkLoader(scene: SceneContext): void`
- `abstract getWanderSpeed(): number`
- `abstract onDeath(): void`
- `tick(dt: number): void`
- `findPathInto(this.#path, sx, sz, startGroundY, tx, tz, this.#requiredHeadroom, 250)`
- `findPathInto(this.#path, sx, sz, startGroundY, tx, tz, this.#requiredHeadroom, 300)`

**Types / Interfaces / Enums**
- type `PathWaypoint`

---

## `Entities/Mobs/Kraken.ts` (175 LOC)

### export class Kraken extends AquaticMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: SceneContext, hp?: number)`

**Properties**
- `readonly mobType`
- `readonly CHUNK_ENTITY_TYPE`

**Methods**
- `super(hp ?? KRAKEN_DEFAULT_HP, scene, KRAKEN_BODY_HALF_SIZE)`
- `getBodyPool()`
- `registerMobLight({
			pool: getBodyPool(),
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [1, 1, 1],
			owner: this,
		})`
- `protected override syncToInstances(): void`
- `configureChunkLoader(scene: SceneContext): void`
- `getWanderSpeed(): number`
- `protected override getDepthRange()`
- `protected override getWaterSearchBias(): number`
- `protected override getIdleChance(): number`
- `protected override shouldStrandedDespawn(): boolean`
- `onDeath(): void`
- `dispose(): void`

**Module-level functions**
- `function buildKrakenParts(): readonly MobPartSpec[]`
- `function getBodyPool(): MobInstancePool`
- `export function getKrakenInstancePool(): MobInstancePool`

**Types / Interfaces / Enums**
- type `KrakenPayload`

---

## `Entities/Mobs/MayaGuardian.ts` (208 LOC)

### export class MayaGuardian extends HostileMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: SceneContext, hp?: number)`

**Properties**
- `readonly mobType`
- `readonly CHUNK_ENTITY_TYPE`

**Methods**
- `super(hp ?? GUARDIAN_DEFAULT_HP, scene, GUARDIAN_BODY_HALF_SIZE, GUARDIAN_STATS.feetHeight)`
- `getBodyPool()`
- `registerMobLight({
			pool: getBodyPool(),
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [1, 0.72, 0.36],
			owner: this,
		})`
- `protected override syncToInstances(): void`
- `configureChunkLoader(scene: SceneContext): void`
- `getWanderSpeed(): number`
- `protected override getWeaponId(): number`
- `protected override getAggroRadiusSq(): number`
- `protected override getDeaggroRadiusSq(): number`
- `protected override getAttackIntervalSec(): number`
- `protected override getBurnsInDaylight(): boolean`
- `onDeath(): void`
- `dispose(): void`

**Module-level functions**
- `function getBodyPool(): MobInstancePool`
- `export function getGuardianInstancePool(): MobInstancePool`

**Types / Interfaces / Enums**
- type `GuardianSerializedPayload`

---

## `Entities/Mobs/Mob.ts` (210 LOC)

### export class MobRegistry

**Properties**
- `type: string`
- `count: number`
- `natural: number`
- `max: number`
- `type: config.mobType,`
- `count: this.#countsByType.get(config.mobType) || 0,`
- `natural: this.#naturalCountsByType.get(config.mobType) || 0,`
- `max: config.maxCount,`
- `total: this.#allMobs.size,`
- `naturalTotal: this.#naturalTotal,`

**Methods**
- `register(config: MobSpawnConfig): void`
- `addMob(mob: Mob): void`
- `removeMob(mob: Mob): void`
- `getMobsInRegion(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Mob[]`
- `getAllMobs(): ReadonlySet<Mob>`
- `getConfigs(): IterableIterator<MobSpawnConfig>`
- `getConfig(mobType: string): MobSpawnConfig | undefined`
- `getCountByType(mobType: string): number`
- `getTotalCount(): number`
- `getNaturalTotal(): number`
- `disposeAll(): void`
- `pickSpawnType(): MobSpawnConfig | null`
- `getDebugStats()`

**Module-level functions**
- `function spatialHash(x: number, y: number, z: number): number`

**Types / Interfaces / Enums**
- interface `Mob`
- type `MobSpawnConfig`

---

## `Entities/Mobs/MobDrops.ts` (116 LOC)

**Module-level functions**
- `export function rollDropCount(min: number, max: number): number`
- `export function dropMobFood(x: number, y: number, z: number, itemId: number, min: number, max: number, player?: Player): void`
- `export function dropMobFoodForType(mobType: string, x: number, y: number, z: number, player?: Player): void`
- `export function dropMobItemsForType(mobType: string, x: number, y: number, z: number, player?: Player): void`

---

## `Entities/Mobs/MobHitTest.ts` (69 LOC)

**Module-level functions**
- `export function segmentMobHit(startX: number, startY: number, startZ: number, endX: number, endY: number, endZ: number, centerX: number, centerY: number, centerZ: number, yaw: number, halfX: number, halfY: number, halfZ: number): number | null`

---

## `Entities/Mobs/MobInstancePool.ts` (442 LOC)

### export class MobInstancePool

**Module-level functions**
- `function loadMobSkin(path: string): Promise<void>`
- `async export function preloadMobSkins(): Promise<void>`
- `function getMobSkin(path: string): Texture2D`
- `export function resolveMobFromPick(mesh: Mesh, thinInstanceIndex: number): MobOwner | null`

**Types / Interfaces / Enums**
- type `LiteMetadata`
- type `Mesh`
- type `Texture2D`
- type `MobPartSpec`
- type `MobOwner`
- type `InstanceSlotHandle`
- type `MobInstancePoolOptions`

---

## `Entities/Mobs/MobLighting.ts` (323 LOC)

**Module-level functions**
- `function refreshEntry(entry: Entry, now: number, force: boolean): boolean`
- `function tick(now: number): void`
- `function appendEntry(entry: Entry): void`
- `function removeEntry(entry: Entry): void`
- `export function getCachedLightColorForOwner(owner: object, out?: [number, number, number]): readonly [number, number, number] | null`
- `export function getCachedLightColor(slot: InstanceSlotHandle, out?: [number, number, number]): readonly [number, number, number] | null`
- `export function updateMobBaseColor(slot: InstanceSlotHandle, newBase: BaseColor): void`
- `export function forceRefreshAll(): void`
- `export function getMobLightingStats()`

**Types / Interfaces / Enums**
- type `MobPosition`
- type `BaseColor`
- type `Entry`

---

## `Entities/Mobs/MobMesh.ts` (498 LOC)

**Module-level functions**
- `function makeInstancedMobAtlasVertexWgsl(useInstanceColor: boolean): string`
- `function makeInstancedMobAtlasFragmentWgsl(): string`
- `function boxGeometryKey(width: number, height: number, depth: number): string`
- `function colorMaterialKey(name: string, color: Color3): string`
- `export function createMobColorMaterial(color: Color3, name: string): ShaderMaterial`
- `export function getMobColorMaterial(color: Color3, name: string): ShaderMaterial`
- `export function createInstancedMobAtlasMaterial(name: string, instanceColors: boolean, tint: Color3, hipPivotY: number, walkAmp: number, shoulderPivotY?: number, attackRaise?: number): ShaderMaterial`
- `export function buildBoxGeometry(width: number, height: number, depth: number): BoxGeometry`
- `export function getBoxGeometry(width: number, height: number, depth: number): BoxGeometry`
- `export function createBoxMobMesh(name: string, width: number, height: number, depth: number, color: Color3, materialName: string): Mesh`
- `export function buildMobModelGeometry(parts: readonly MobPartSpec[]): MobModelGeometry`

**Types / Interfaces / Enums**
- type `Mesh`
- type `ShaderMaterial`
- type `BoxGeometry`
- type `MobPartSpec`
- type `MobModelGeometry`

---

## `Entities/Mobs/MobSetup.ts` (116 LOC)

**Module-level functions**
- `function buildClientSpawnConfigs(): readonly MobSpawnConfig[]`

**Types / Interfaces / Enums**
- type `MobFactoryEntry`

---

## `Entities/Mobs/MobSkin.ts` (116 LOC)

**Module-level functions**
- `export function boxUvSet(ox: number, oy: number, width: number, height: number, depth: number): MobUvSet`

**Types / Interfaces / Enums**
- interface `MobUvSet`
- type `UvRect`

---

## `Entities/Mobs/NeutralMob.ts` (836 LOC)

### abstract export class NeutralMob

**Types / Interfaces / Enums**
- type `PathWaypoint`

---

## `Entities/Mobs/Sheep.ts` (245 LOC)

---

## `Entities/Mobs/Skeleton.ts` (194 LOC)

### export class Skeleton extends HostileMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: SceneContext, hp?: number)`

**Properties**
- `readonly mobType`
- `readonly CHUNK_ENTITY_TYPE`

**Methods**
- `super(hp ?? SKELETON_DEFAULT_HP, scene, SKELETON_BODY_HALF_SIZE, SKELETON_STATS.feetHeight)`
- `getBodyPool()`
- `registerMobLight({
			pool: getBodyPool(),
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [1, 1, 1],
			owner: this,
		})`
- `protected override syncToInstances(): void`
- `configureChunkLoader(scene: SceneContext): void`
- `getWanderSpeed(): number`
- `protected override getWeaponId(): number`
- `onDeath(): void`
- `dispose(): void`

**Module-level functions**
- `function getBodyPool(): MobInstancePool`
- `export function getSkeletonInstancePool(): MobInstancePool`

**Types / Interfaces / Enums**
- type `SkeletonSerializedPayload`

---

## `Entities/Mobs/Songbird.ts` (302 LOC)

### export class Songbird extends FlyingMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: SceneContext, hp?: number)`

**Properties**
- `readonly mobType`

**Methods**
- `super(hp ?? SONGBIRD_DEFAULT_HP, scene, SONGBIRD_BODY_HALF_SIZE, SONGBIRD_STATS.feetHeight)`
- `getBodyPool()`
- `registerMobLight({
			pool: getBodyPool(),
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [1, 1, 1],
			owner: this,
		})`
- `protected override syncToInstances(): void`
- `getWanderSpeed(): number`
- `protected override pickWaypoint(pos: Vec3): Vec3 | null`
- `protected override onWaypointReached(): void`
- `protected override onDamaged(): void`
- `isCollidableBlock(below.blockId)`
- `onDeath(): void`
- `dispose(): void`

**Module-level functions**
- `function getBodyPool(): MobInstancePool`
- `export function getSongbirdInstancePool(): MobInstancePool`

---

## `Entities/Mobs/Squid.ts` (162 LOC)

### export class Squid extends AquaticMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: SceneContext, hp?: number)`

**Properties**
- `readonly mobType`
- `readonly CHUNK_ENTITY_TYPE`

**Methods**
- `super(hp ?? SQUID_DEFAULT_HP, scene, SQUID_BODY_HALF_SIZE)`
- `getBodyPool()`
- `registerMobLight({
			pool: getBodyPool(),
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [1, 1, 1],
			owner: this,
		})`
- `protected override syncToInstances(): void`
- `configureChunkLoader(scene: SceneContext): void`
- `getWanderSpeed(): number`
- `protected override getDepthRange()`
- `protected override getWaterSearchBias(): number`
- `protected override getIdleChance(): number`
- `onDeath(): void`
- `dispose(): void`

**Module-level functions**
- `function buildSquidParts(): readonly MobPartSpec[]`
- `function getBodyPool(): MobInstancePool`
- `export function getSquidInstancePool(): MobInstancePool`

**Types / Interfaces / Enums**
- type `SquidPayload`

---

## `Entities/Mobs/XpOrb.ts` (321 LOC)

### export class XpOrb

**Constructor**
- `constructor(x: number, y: number, z: number, value: number)`

**Properties**
- `texture`
- `dt: number,`
- `hasCamera: boolean,`
- `cameraX: number,`
- `cameraZ: number,`

**Methods**
- `onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			const dt = deltaMs * 0.001;

			if (dt <= 0 || isUiOpen(UiFocus.pauseMenu)) {
				return;
			}

			const scene = Map1.mainScene;
			const cameraMatrix = scene.camera?.worldMatrix;

			let cameraX = 0;
			let cameraZ = 0;
			let hasCamera = false;

			if (cameraMatrix !== undefined) {
				cameraX = cameraMatrix[12];
				cameraZ = cameraMatrix[14];
				hasCamera = true;
			}

			const orbs = XpOrb.#allOrbs;

			
			
			
			for (let i = orbs.length - 1; i >= 0; i--) {
				orbs[i].#tick(dt, hasCamera, cameraX, cameraZ);
			}
		})`
- `vec3(0.15, 0.15, 0.15)`
- `setShaderUniform(this.#material, 1)`
- `setShaderUniform(this.#material, [0, 0])`
- `setShaderUniform(this.#material, [0.82, 0.78, 1])`
- `setShaderTexture(material, texture)`
- `addToScene(Map1.mainScene, this.#mesh)`
- `removeFromScene(Map1.mainScene, this.#mesh)`
- `releaseSpriteMaterial(XP_ORB_ICON_URL, this.#material)`
- `static disposeAll(): void`

**Module-level functions**
- `function getOrbTexture(): Promise<Texture2D | null>`
- `export function spawnXpOrbs(x: number, y: number, z: number, min: number, max: number): void`

**Types / Interfaces / Enums**
- type `LiteMetadata`
- type `Mesh`
- type `ShaderMaterial`
- type `Texture2D`
- type `Vec3`

---

## `Entities/Mobs/Zombie.ts` (229 LOC)

### export class Zombie extends HostileMob

**Constructor**
- `constructor(x: number, y: number, z: number, scene: SceneContext, hp?: number)`

**Properties**
- `readonly mobType`
- `readonly CHUNK_ENTITY_TYPE`

**Methods**
- `super(hp ?? ZOMBIE_DEFAULT_HP, scene, ZOMBIE_BODY_HALF_SIZE, ZOMBIE_STATS.feetHeight)`
- `registerMobLight({
			pool: this.#lanePool,
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [1, 1, 1],
			owner: this,
		})`
- `protected override syncToInstances(): void`
- `unregisterMobLight(this.#bodySlot)`
- `registerMobLight({
			pool: want,
			slot: this.#bodySlot,
			getPos: () => this.position,
			baseColor: [1, 1, 1],
			owner: this,
		})`
- `protected override onAttackPoseChanged(attacking: boolean): void`
- `configureChunkLoader(scene: SceneContext): void`
- `getWanderSpeed(): number`
- `protected override getWeaponId(): number`
- `onDeath(): void`
- `dispose(): void`

**Module-level functions**
- `function getBodyPool(): MobInstancePool`
- `export function getZombieInstancePool(): MobInstancePool`
- `function getAttackBodyPool(): MobInstancePool`
- `export function getZombieAttackPool(): MobInstancePool`

**Types / Interfaces / Enums**
- type `ZombieSerializedPayload`

---

## `Entities/Mount.ts` (134 LOC)

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

## `Entities/PrimedTnt.ts` (563 LOC)

### export class PrimedTnt

**Constructor**
- `constructor(x: number, y: number, z: number, fuseSeconds: number, remote = false, blastRadius: number = TNT_BLAST_RADIUS)`

**Properties**
- `mipMaps: true,`
- `magFilter: ,`
- `minFilter: ,`
- `lx`
- `ly`
- `lz`

**Methods**
- `onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			if (isUiOpen(UiFocus.pauseMenu)) {
				return;
			}

			const dt = Math.min(MAX_TICK_DT, deltaMs * 0.001);

			if (dt <= 0) {
				return;
			}

			const snapshot = PrimedTnt.#tickSnapshot;
			snapshot.length = 0;

			for (const tnt of PrimedTnt.#all) {
				snapshot.push(tnt);
			}

			const count = snapshot.length;

			for (let i = 0; i < count; i++) {
				snapshot[i].#tick(dt);
			}

			
			snapshot.length = 0;
		})`
- `static disposeAll(): void`
- `vec3(HALF_EXTENT, HALF_EXTENT, HALF_EXTENT)`
- `addVelocity(x: number, y: number, z: number): void`
- `explode(x, y, z, {
				radius: this.#blastRadius,
				chainIgniter: spawnRemoteChainTnt,
				syncExplosion: false,
			})`
- `explode(x, y, z, {
			radius: this.#blastRadius,
			chainIgniter: igniteChainedTnt,
		})`
- `setShaderUniform(this.#material, flash)`
- `setShaderUniform(this.#material, tileSize)`
- `setShaderUniform(this.#material, [
			clampedX * tileSize,
			atlasRow * tileSize,
		])`
- `setShaderTexture(this.#material, sharedAtlas)`
- `setShaderTexture(this.#material, atlas)`
- `addToScene(Map1.mainScene, this.#mesh)`
- `getLightByWorldCoords(this.#position.x, this.#position.y, this.#position.z)`
- `setShaderVector3(this.#material, this.#tint)`
- `removeFromScene(Map1.mainScene, this.#mesh)`
- `deferTntGpuDisposal(this.#mesh, this.#material)`

**Module-level functions**
- `function disposeTntMaterial(mat: ShaderMaterial): void`
- `function randomSignedMagnitude(magnitude: number): number`
- `function randomChainFuse(): number`
- `export function igniteTnt(x: number, y: number, z: number, fuseSeconds: number = TNT_FUSE_SECONDS, sendBreak = true): boolean`
- `export function igniteChainedTnt(x: number, y: number, z: number): void`
- `export function spawnPrimedTnt(x: number, y: number, z: number, fuseSeconds: number, remote: boolean, blastRadius: number = TNT_BLAST_RADIUS): PrimedTnt`
- `export function spawnRemotePrimedTnt(x: number, y: number, z: number, fuseSeconds: number, blastRadius?: number): void`
- `function spawnRemoteChainTnt(x: number, y: number, z: number): void`
- `function deferTntGpuDisposal(mesh: Mesh, mat: ShaderMaterial): void`

**Types / Interfaces / Enums**
- type `Mesh`
- type `ShaderMaterial`
- type `Vec3`

---

## `Entities/SpawnCoordinator.ts` (261 LOC)

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
			frameProfiler.begin(          );
			this.#tick();
			frameProfiler.end(          );
		})`
- `dispose(): void`

**Module-level functions**
- `function isNightNow(): boolean`

---

## `Entities/TempleLootTable.ts` (214 LOC)

**Module-level functions**
- `export function rollTempleCrate(templeId: number, seed: number, tier: MayaLootTier, x: number, y: number, z: number): SavedBlockInventory`
- `export function findTempleCacheAt(worldX: number, worldY: number, worldZ: number, seedAsInt: number): TempleCacheLookup | null`
- `export function currentWorldSeedAsInt(worldName: string): number`
- `export function activeWorldSeedAsInt(): number`
- `export function resetActiveWorldSeed(): void`

**Types / Interfaces / Enums**
- type `MayaLootTier`
- type `MayaTempleLayout`
- type `LootEntry`
- type `LootTable`
- type `SavedBlockInventoryItem`
- type `TempleCacheLookup`

---

## `Entities/WeaponStats.ts` (73 LOC)

**Module-level functions**
- `export function getMeleeDamage(itemId?: number | null): number`
- `export function getMeleeRange(itemId?: number | null): number`
- `export function getMobWeaponId(mobType: string): number | undefined`
- `export function getMobWeaponIdByTypeId(typeId: number): number | undefined`

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

## `Generation/Biome/BiomeDefinitions/GeologicalBiomes/GeologicalTrees.ts` (304 LOC)

**Module-level functions**
- `function heightHash(worldX: number, worldZ: number, seedAsInt: number): number`
- `function leafHash(x: number, y: number, z: number, seedAsInt: number): number`
- `function placedisc(cx: number, cy: number, cz: number, r: number, blockId: number, overwrite: boolean, placeBlock: PlaceBlockFn): void`
- `function placeDiscHoley(cx: number, cy: number, cz: number, r: number, blockId: number, skip: number, seedAsInt: number, placeBlock: PlaceBlockFn): void`

---

## `Generation/Biome/BiomeDefinitions/HotBiomes/HotBiomes.ts` (255 LOC)

---

## `Generation/Biome/BiomeDefinitions/HotBiomes/HotTrees.ts` (127 LOC)

---

## `Generation/Biome/BiomeDefinitions/MountainBiomes/MountainBiomes.ts` (115 LOC)

---

## `Generation/Biome/BiomeDefinitions/MountainBiomes/MountainTrees.ts` (95 LOC)

---

## `Generation/Biome/BiomeDefinitions/TemperateBiomes/TemperateBiomes.ts` (355 LOC)

---

## `Generation/Biome/BiomeDefinitions/TemperateBiomes/TemperateTrees.ts` (443 LOC)

**Module-level functions**
- `function placeWood(x: number, y: number, z: number): void`

---

## `Generation/Biome/BiomeDefinitions/TropicalBiomes/TropicalBiomes.ts` (108 LOC)

---

## `Generation/Biome/BiomeDefinitions/TropicalBiomes/TropicalTrees.ts` (177 LOC)

**Module-level functions**
- `function placeFaceConnected(fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number, blockId: number, replace: boolean, placeBlock: PlaceBlockFn): void`

---

## `Generation/Biome/Biomes.ts` (404 LOC)

**Module-level functions**
- `export function getBiomeFor(temperature: number, humidity: number, continentalness: number, _river: number, terrainShapedHeight: number): Biome`

---

## `Generation/Biome/BiomeTypes.ts` (144 LOC)

**Module-level functions**
- `export function createTreeDefinition(woodId: number, leavesId: number, baseHeight: number, heightVariance: number, generator: RawTreeGenerator): TreeDefinition`

**Types / Interfaces / Enums**
- interface `Biome`
- type `TreeDefinition`
- type `RawTreeGenerator`

---

## `Generation/Biome/TreeDefinition.ts` (407 LOC)

**Module-level functions**
- `function packLocal(dx: number, dy: number, dz: number): number`
- `export function generateSlinkyTree(worldX: number, worldY: number, worldZ: number, placeBlock: PlaceBlockFn, seedAsInt: number, woodId: number, leavesId: number, baseHeight: number, heightVariance: number): void`
- `function placeWood(x: number, y: number, z: number): void`
- `export function generateBigTopBentOak(worldX: number, worldY: number, worldZ: number, placeBlock: PlaceBlockFn, seedAsInt: number, woodId: number, leavesId: number, baseHeight: number, heightVariance: number): void`
- `function placeWood(x: number, y: number, z: number): void`
- `export function generateBaobab(worldX: number, worldY: number, worldZ: number, placeBlock: PlaceBlockFn, seedAsInt: number, woodId: number, leavesId: number, baseHeight: number, heightVariance: number): void`
- `function placeWood(x: number, y: number, z: number): void`

---

## `Generation/CaveCarver.ts` (127 LOC)

**Module-level functions**
- `export function clamp01(value: number): number`
- `export function getDepthBelowSurface(surfaceY: number, worldY: number): number`
- `export function getSurfaceCarveBlend(depthBelowSurface: number): number`
- `function rejectNearSurface(out: CaveCarveEvaluation, depthBelowSurface: number): CaveCarveEvaluation`
- `export function evaluateCaveCarve(params: GenerationParamsType, worldY: number, surfaceY: number, cheese: number, tunnel: number, detail: number, out?: CaveCarveEvaluation, precomputedCaveDensity?: number): CaveCarveEvaluation`

**Types / Interfaces / Enums**
- type `CaveCarveEvaluation`

---

## `Generation/CaveNoiseGrid.ts` (98 LOC)

### export class CaveNoiseGrid

**Constructor**
- `constructor(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number, sampleRate: number, cheeseFn: (x: number, y: number, z: number) => number, tunnelFn: (x: number, y: number, z: number) => number, detailFn: (x: number, y: number, z: number) => number, cheeseInstance?: NoiseInstance, tunnelInstance?: NoiseInstance, detailInstance?: NoiseInstance)`

**Properties**
- `private readonly cheese: NoiseSampler`
- `private readonly tunnel: NoiseSampler`
- `private readonly detail: NoiseSampler`
- `private readonly _cellScratch: NoiseCellParams = { cellX: 0, cellY: 0, cellZ: 0, fx: 0, fy: 0, fz: 0, }`

**Methods**
- `public reset(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number): void`
- `public getCheese(localX: number, localY: number, localZ: number): number`
- `public getTunnel(localX: number, localY: number, localZ: number): number`
- `public getDetail(localX: number, localY: number, localZ: number): number`
- `public get3(localX: number, localY: number, localZ: number, out: Float32Array): void`

**Types / Interfaces / Enums**
- type `NoiseCellParams`

---

## `Generation/DistantTerrain/DistantTerrain.ts` (491 LOC)

**Module-level functions**
- `function setUniformBoth(name: string, value: number | Float32Array): void`
- `function createDistantWaterMesh(): Mesh`
- `function rebuildClipMeshes(): void`
- `function createEmptyGridMesh(engine: EngineContext, name: string): Mesh`
- `function applyDistantTerrainVisibility(): void`
- `function updateUniforms()`
- `function applyTerrainData(pos: Float32Array, nrm: Float32Array, tiles: Uint8Array, worldX: number, worldZ: number)`
- `async export function initDistantTerrain(): Promise<void>`
- `export function isInitialized(): boolean`
- `export function resetDistantTerrain(): void`
- `export function update(worldX: number, worldZ: number)`
- `export function dispose(): void`

**Types / Interfaces / Enums**
- type `EngineContext`
- type `Mesh`
- type `SceneContext`

---

## `Generation/DistantTerrain/DistantTerrainGenerator.ts` (404 LOC)

**Module-level functions**
- `function cachedHeight(wx: number, wz: number): number`
- `export function setRenderDistance(value: number): void`
- `export function initSharedBuffers(positionsBuffer: SharedArrayBuffer, normalsBuffer: SharedArrayBuffer, surfaceTilesBuffer: SharedArrayBuffer, r: number, gStep: number): void`
- `export function generate(centerChunkX: number, centerChunkZ: number, r: number, gStep: number, out: DistantTerrainGenerateOutput): void`
- `function ensureBuffers(r: number, gStep: number): void`
- `function configureGrid(r: number, gStep: number): void`
- `function allocateLocalBuffers(): void`
- `function resetTracking(): void`
- `export function resetCacheAndTracking(): void`
- `function fullGenerate(gcx: number, gcz: number, ccx: number, ccz: number): void`
- `function slideArrays(shiftX: number, shiftZ: number): void`
- `function regenerateEdges(shiftX: number, shiftZ: number, gcx: number, gcz: number, ccx: number, ccz: number): void`
- `function rewriteLocalXZ(ccx: number, ccz: number, gcx: number, gcz: number): void`
- `function generateVertex(x: number, z: number, gcx: number, gcz: number, ccx: number, ccz: number): void`

---

## `Generation/LightGenerator.ts` (636 LOC)

### export class LightGenerator

**Constructor**
- `constructor(params: GenerationParamsType)`

**Properties**
- `private static readonly SKYLIGHT_GENERATION_MIN_WORLD_Y`
- `private static readonly _transparentLUT: Uint8Array = (() => { const lut = new Uint8Array(1024); lut[0] = 1; lut[WATER_BLOCK_ID] = 1; lut[60] = 1; lut[61] = 1; lut[64] = 1; lut[66] = 1; lut[91] = 1; for (const source of [WATER_BLOCK_ID, 60, 61, 64, 66, 91]) { const base = 500 + (source - 1) * 5; for (let i = 0; i < 5; i++) { const virtualId = base + i; if (virtualId >= 0 && virtualId < lut.length) lut[virtualId] = 1; } } return lut; })()`
- `private static readonly _filtersFullSunLUT: Uint8Array = (() => { const lut = new Uint8Array(1024); for (let blockId = 0; blockId < lut.length; blockId++) { lut[blockId] = filtersFullSunlight(blockId) ? 1 : 0; } return lut; })()`
- `private static readonly _emissionLUT: Uint8Array = (() => { const lut = new Uint8Array(1024); lut[10] = 15; lut[11] = 15; lut[24] = 15; lut[94] = 15; return lut; })()`
- `private static closedFaceMaskLUT: Uint8Array | null = null`
- `private readonly chunkSize: number`
- `private readonly chunkSizeSq: number`
- `private readonly chunkVolume: number`
- `private readonly csShift: number`
- `private readonly csShift2: number`
- `private readonly queueCapacity: number`
- `private readonly queueMask: number`
- `private readonly lightQueue: Uint16Array`
- `private scratchQueue: Uint16Array | null = null`
- `public static readonly EMISSION_MIN_WORLD_Y`
- `public static readonly SEALED_EMISSION_MIN_WORLD_Y`

**Methods**
- `public static setClosedFaceMaskLUT(lut: Uint8Array | null): void`
- `public static getClosedFaceMaskLUT(): Uint8Array | null`
- `public seedInitialLight(chunkX: number, chunkY: number, chunkZ: number, _biome: Biome, blocks: Uint8Array | Uint16Array, light: Uint8Array, topSunlightMask?: Uint8Array, emissionMinWorldY: number = LightGenerator.EMISSION_MIN_WORLD_Y): LightSeedState`
- `public propagateLight(blocks: Uint8Array | Uint16Array, light: Uint8Array, seedState: LightSeedState): void`
- `public seedAndPropagateLightImmediate(chunkX: number, chunkY: number, chunkZ: number, blocks: Uint8Array | Uint16Array, light: Uint8Array, topSunlightMask?: Uint8Array, emissionMinWorldY: number = LightGenerator.EMISSION_MIN_WORLD_Y): void`
- `public seedAndPropagateLightWithNeighbors(chunkX: number, chunkY: number, chunkZ: number, blocks: Uint8Array | Uint16Array, light: Uint8Array, topSunlightMask: Uint8Array | undefined, neighborLight: ReadonlyArray<Uint8Array | null>, emissionMinWorldY: number = LightGenerator.EMISSION_MIN_WORLD_Y): void`
- `private seedFromNeighborBorders(blocks: Uint8Array | Uint16Array, light: Uint8Array, neighborLight: ReadonlyArray<Uint8Array | null>, tail: number): number`
- `private seedInitialLightIntoSharedQueue(chunkX: number, chunkY: number, chunkZ: number, blocks: Uint8Array | Uint16Array, light: Uint8Array, topSunlightMask: Uint8Array | undefined, emissionMinWorldY: number = LightGenerator.EMISSION_MIN_WORLD_Y): number`
- `private propagateLightFromQueue(blocks: Uint8Array | Uint16Array, light: Uint8Array, queue: Uint16Array, initialTail: number): void`
- `public static getLightEmission(blockId: number): number`
- `public static isBlockTransparent(blockId: number): boolean`
- `public static blockFiltersFullSunlight(blockId: number): boolean`

**Module-level functions**
- `function tryPropagate(targetIndex: number, targetSky: number, targetBlock: number, sourceFiltersFullSun: number, isDown: boolean, enterBit: number, exitBit: number, sourcePacked: number, blocks: Uint8Array | Uint16Array, light: Uint8Array, queue: Uint16Array, tail: number, queueMask: number, transparentLUT: Uint8Array, filtersFullSunLUT: Uint8Array, emissionLUT: Uint8Array, closedFaceMaskLUT: Uint8Array | null): number`
- `function nextPowerOfTwo(n: number): number`

**Types / Interfaces / Enums**
- type `LightSeedState`

---

## `Generation/NoiseAndParameters/FastNoise/FastNoiseFactory.ts` (193 LOC)

**Module-level functions**
- `export function setNoiseBackend(backend: NoiseBackend): void`
- `export function getNoiseBackend(): NoiseBackend`
- `function resolveSeed(seedOrOptions: number | FastNoiseOptions): number`
- `export function createFastNoise(seed: number, fractalType?: FractalType, frequency?: number): NoiseInstance;
export function createFastNoise(options: FastNoiseOptions): NoiseInstance;
export function createFastNoise(
	seedOrOptions: number | FastNoiseOptions,
	fractalType?: FractalType,
	frequency?: number,
): NoiseInstance`
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
	seed: number,
	fractalType?: FractalType,
	frequency?: number,
): (x: number, y: number, z: number) => number;
export function createFastNoise3D(
	seedOrOptions: number | FastNoiseOptions,
	fractalType?: FractalType,
	frequency?: number,
): (x: number, y: number, z: number) => number`
- `export function createFastNoise2DWithInstance(seedOrOptions: number | FastNoiseOptions, fractalType?: FractalType, frequency?: number): FastNoise2DResult`
- `export function createFastNoise3DWithInstance(seedOrOptions: number | FastNoiseOptions, fractalType?: FractalType, frequency?: number): FastNoise3DResult`

**Types / Interfaces / Enums**
- interface `FastNoiseOptions`
- interface `NoiseInstance`
- interface `NoiseBackend`
- type `FractalType`
- type `NoiseType`
- type `RotationType3D`
- type `FastNoise2DResult`
- type `FastNoise3DResult`

---

## `Generation/NoiseAndParameters/FastNoise/FastNoiseLite.ts` (3016 LOC)

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

## `Generation/NoiseAndParameters/NoiseSampler.ts` (176 LOC)

### export class NoiseSampler

**Constructor**
- `constructor(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number, sampleRate: number, scale: number, xzFactor: number, noiseFunction: (x: number, y: number, z: number) => number, instance?: NoiseInstance)`

**Properties**
- `private noiseSamples: Float32Array`
- `private sampleRate: number`
- `private pointsPerDim: number`
- `private noiseFunction: (x: number, y: number, z: number) => number`
- `private instance?: NoiseInstance`
- `private scale: number`
- `private xzFactor: number`
- `private readonly isPow2: boolean`
- `private readonly rateShift: number`
- `private readonly rateMask: number`
- `private readonly invSampleRate: number`
- `private readonly pointsPerDimSq: number`

**Methods**
- `public reset(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number): void`
- `private sampleNoise(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number): void`

**Types / Interfaces / Enums**
- type `NoiseCellParams`

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

## `Generation/NoiseAndParameters/Squirrel13.ts` (49 LOC)

**Module-level functions**
- `export function getPRNGBySeed(position: number, seed: number): number`
- `export function getPRNG(position: number): number`
- `export function getPRNGUnit(position: number): number`
- `export function getPRNGUnit2(): number`

---

## `Generation/OreGenerator.ts` (286 LOC)

### export class OreGenerator

**Constructor**
- `constructor(params: GenerationParamsType, oreNoise: (x: number, y: number, z: number) => number, seedAsInt: number)`

**Properties**
- `private params: GenerationParamsType`
- `private oreNoise: (x: number, y: number, z: number) => number`
- `private seedAsInt: number`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, blocks: Uint8Array, biome: Biome)`

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
- `private static riverNoiseInst: NoiseInstance`
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

## `Generation/Structure/AbandonedCabinFeature.ts` (99 LOC)

### export class AbandonedCabinFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/AbyssalTempleFeature.ts` (116 LOC)

### export class AbyssalTempleFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/BadlandsSpireFeature.ts` (298 LOC)

### export class BadlandsSpireFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`
- `private generateSpire(_chunkX: number, chunkY: number, _chunkZ: number, spireX: number, spireZ: number, groundHeight: number, spireHeight: number, tierHeight: number, halfFp: number, placeBlock: PlaceBlockFn, chunkSize: number, seed: number)`
- `private generateTierSlice(worldY: number, groundHeight: number, tierHeight: number, centerX: number, centerZ: number, noiseOffX: number, noiseOffZ: number, placeBlock: PlaceBlockFn, seed: number)`
- `private getLayerBlock(spireLocalY: number, seed: number): number`
- `private findGroundHeight(x: number, z: number, halfFp: number, columnPrepassResolver?: ColumnPrepassResolver): number`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/BambooShrineFeature.ts` (100 LOC)

### export class BambooShrineFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/CaravanCampFeature.ts` (100 LOC)

### export class CaravanCampFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/CliffDwellingFeature.ts` (108 LOC)

### export class CliffDwellingFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/CrystalShrineFeature.ts` (84 LOC)

### export class CrystalShrineFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/DesertOasisFeature.ts` (87 LOC)

### export class DesertOasisFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/DockFeature.ts` (107 LOC)

### export class DockFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/DungeonFeature.ts` (167 LOC)

### export class DungeonFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number)`
- `private carveCorridor(x1: number, x2: number, z1: number, z2: number, yBase: number, placeBlock: PlaceBlockFn, floorBlock: number, minX: number, maxX: number, minZ: number, maxZ: number)`

**Types / Interfaces / Enums**
- type `PlaceBlockFn`

---

## `Generation/Structure/FossilBedFeature.ts` (110 LOC)

### export class FossilBedFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/FrozenShrineFeature.ts` (87 LOC)

### export class FrozenShrineFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/GeodeFeature.ts` (84 LOC)

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/IglooFeature.ts` (87 LOC)

### export class IglooFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/InfernalPitFeature.ts` (100 LOC)

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/IWorldFeature.ts` (26 LOC)

**Types / Interfaces / Enums**
- interface `IWorldFeature`
- type `FeatureVerticalBounds`
- type `ColumnPrepassResolver`

---

## `Generation/Structure/LavaPoolFeature.ts` (168 LOC)

### export class LavaPoolFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`
- `private generateLavaPool(poolCenterX: number, poolCenterY: number, poolCenterZ: number, placeBlock: PlaceBlockFn, seed: number)`

**Module-level functions**
- `export function resolveLavaPoolCentre(regionX: number, regionZ: number, regionHash: number, chunkSize: number, seed: number)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/LighthouseFeature.ts` (118 LOC)

### export class LighthouseFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/MayaTempleFeature.ts` (768 LOC)

**Types / Interfaces / Enums**
- type `MayaChamber`
- type `MayaCorridor`
- type `MayaRamp`
- type `MayaTempleLayout`

---

## `Generation/Structure/MayaTempleLayout.ts` (879 LOC)

### class TempleRandom

**Constructor**
- `constructor(templeId: number, private readonly seed: number, salt: number)`

**Properties**
- `private cursor: number`

**Methods**
- `private advance(): number`
- `int(maxExclusive: number): number`
- `range(min: number, maxInclusive: number): number`
- `unit(): number`
- `chance(probability: number): boolean`

**Module-level functions**
- `export function computeMayaSealBox(centerX: number, centerZ: number, ground: GroundSampler): MayaSealBox`
- `function rectCentre(rect: MayaRect)`
- `function rectWidth(rect: MayaRect): number`
- `function rectDepth(rect: MayaRect): number`
- `function cellRect(gridX0: number, gridZ0: number, cx: number, cz: number): MayaRect`
- `function cellOfRect(gridX0: number, gridZ0: number, rect: MayaRect)`
- `function rectDistSq(a: MayaRect, b: MayaRect): number`
- `function rectContains(rect: MayaRect, x: number, z: number): boolean`
- `function makeLevelY(plazaY: number): (level: number) => number`
- `function scatterGuards(rng: TempleRandom, w: number, d: number, level: number): (readonly [number, number, MayaGuardKind])[]`
- `function buildCorridors(rooms: readonly MayaChamber[], gridX0: number, gridZ0: number): MayaCorridor[]`
- `function roomInCell(rooms: readonly MayaChamber[], gridX0: number, gridZ0: number, level: number, cx: number, cz: number): MayaChamber | undefined`
- `function buildCenoteRamp(centerX: number, centerZ: number, plazaY: number, entryFloorY: number, entryRoom: MayaChamber | undefined): MayaRamp[]`
- `export function buildMayaTempleLayout(templeId: number, seed: number, centerX: number, centerZ: number, ground: GroundSampler): MayaTempleLayout`
- `function ensureBossApproach(rooms: readonly MayaChamber[], corridors: MayaCorridor[], boss: MayaChamber, rampCell: MayaRect): void`
- `function makeGlyph(room: MayaChamber): MayaGlyph`
- `function makeBossGate(rooms: readonly MayaChamber[], corridors: readonly MayaCorridor[], rampCell: MayaRect): MayaGlyph | null`
- `function buildGateWall(x: number, z: number, across:     |, width: number, y0: number, y1: number): [number, number, number][]`
- `function pointDistSq(ax: number, az: number, bx: number, bz: number): number`

**Types / Interfaces / Enums**
- type `MayaRamp`
- type `MayaCorridor`
- type `MayaGuardianPost`
- type `MayaLootCache`
- type `MayaGlyph`
- type `MayaPyramidTier`
- type `MayaTempleLayout`
- type `MayaSealBox`
- type `GroundSampler`

---

## `Generation/Structure/MineshaftFeature.ts` (201 LOC)

### export class MineshaftFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number): void`
- `fill(placeBlock, rect, floorY, FLOOR)`
- `fill(placeBlock, rect, ceilingY, WALL)`
- `place(placeBlock, x, y, rect.z0, WALL)`
- `place(placeBlock, x, y, rect.z1, WALL)`
- `place(placeBlock, rect.x0, y, z, WALL)`
- `place(placeBlock, rect.x1, y, z, WALL)`
- `place(placeBlock, rect.x0, y, rect.z0, TIMBER)`
- `fill(placeBlock, interior, y, AIR)`
- `place(placeBlock, x, corridor.floorY, z, FLOOR)`
- `place(placeBlock, x, corridor.floorY + CORRIDOR_HEADROOM + 1, z, WALL)`
- `place(placeBlock, x, corridor.floorY + h, z, AIR)`
- `place(placeBlock, x, surface - 1, z, FLOOR)`
- `place(placeBlock, x, surface + h, z, AIR)`
- `fill(placeBlock, deck, y, AIR)`
- `place(placeBlock, x, deckY, z, PLANK)`
- `place(placeBlock, px, y, pz, POST)`
- `fill(placeBlock, deck, roofY, PLANK)`
- `fill(placeBlock, deck, roofY + 1, WALL)`
- `place(placeBlock, crate.x, crate.y, crate.z, CRATE)`

**Module-level functions**
- `function place(placeBlock: PlaceBlockFn, x: number, y: number, z: number, blockId: number): void`
- `function fill(placeBlock: PlaceBlockFn, rect: MineshaftRect, y: number, blockId: number): void`

**Types / Interfaces / Enums**
- type `MineshaftLayout`
- type `MineshaftRect`

---

## `Generation/Structure/MineshaftLayout.ts` (485 LOC)

**Module-level functions**
- `function buildLevelCorridors(level: number, mask: readonly boolean[], floorY: number, centerX: number, centerZ: number): MineshaftCorridor[]`
- `function buildCorridor(level: number, axis:     |, gx: number, gz: number, centerX: number, centerZ: number, floorY: number): MineshaftCorridor`
- `function buildDescentStair(level: number, centerX: number, centerZ: number, floorY: number): MineshaftStair`
- `function buildEntrance(centerX: number, centerZ: number, site: MineshaftSite): MineshaftEntrance`
- `function tierForLevel(level: number): MineshaftLootTier`
- `function buildCrates(cells: readonly MineshaftCell[], shaftId: number, seed: number): MineshaftCrate[]`
- `export function computeMineshaftSealBox(centerX: number, centerZ: number, ground: GroundSampler): MineshaftSealBox | null`
- `export function buildMineshaftLayout(shaftId: number, seed: number, centerX: number, centerZ: number, ground: GroundSampler): MineshaftLayout | null`

---

## `Generation/Structure/MineshaftSeal.ts` (148 LOC)

**Module-level functions**
- `export function mineshaftSealOverlaps(seal: MineshaftSealBox, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean`
- `export function fillMineshaftSealMask(chunkX: number, chunkZ: number, chunkSize: number, seed: number, out: Uint8Array): MineshaftSealMask`

**Types / Interfaces / Enums**
- type `MineshaftLayout`
- type `MineshaftSealBox`
- type `MineshaftSealMask`

---

## `Generation/Structure/MountainCabinFeature.ts` (95 LOC)

### export class MountainCabinFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/MushroomHutFeature.ts` (90 LOC)

### export class MushroomHutFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/ObservatoryFeature.ts` (84 LOC)

### export class ObservatoryFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/PetrifiedShrineFeature.ts` (85 LOC)

### export class PetrifiedShrineFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/PondFeature.ts` (203 LOC)

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/PyramidFeature.ts` (104 LOC)

### export class PyramidFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/RavineFeature.ts` (119 LOC)

### export class RavineFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/RegionFeature.ts` (75 LOC)

**Module-level functions**
- `export function computeRegion(chunkX: number, chunkZ: number, chunkSize: number, seed: number, config: RegionConfig): RegionResult | null`
- `export function chunkWorldBounds(genChunkX: number, genChunkZ: number, chunkSize: number)`
- `export function aabbOverlaps(fMinX: number, fMaxX: number, fMinZ: number, fMaxZ: number, cMinX: number, cMaxX: number, cMinZ: number, cMaxZ: number): boolean`

**Types / Interfaces / Enums**
- interface `RegionConfig`
- interface `RegionResult`

---

## `Generation/Structure/RuinFeature.ts` (110 LOC)

### export class RuinFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/ShipwreckFeature.ts` (117 LOC)

### export class ShipwreckFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/SnowFortFeature.ts` (125 LOC)

### export class SnowFortFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/StoneCircleFeature.ts` (107 LOC)

### export class StoneCircleFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

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

## `Generation/Structure/StructureBuilder.ts` (276 LOC)

### export class StructureBuilder

**Constructor**
- `constructor(place: PlaceBlockFn, resolver: ColumnPrepassResolver | undefined, seed: number)`

**Properties**
- `public readonly place: PlaceBlockFn`
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
- type `DoorSide`

---

## `Generation/Structure/StructureFeature.ts` (123 LOC)

### export class StructureSpawnerFeature implements IWorldFeature

**Constructor**
- `constructor()`

**Properties**
- `public readonly verticalBounds`
- `private static structures: Map<string, Structure> = new Map()`
- `private static structureNames: string[] = []`

**Methods**
- `private loadStructures()`
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, _biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/StructureSeal.ts` (137 LOC)

**Module-level functions**
- `export function resolveTempleInRegion(chunkX: number, chunkZ: number, chunkSize: number, seed: number): ResolvedTemple | null`
- `export function buildTempleLayout(resolved: ResolvedTemple, seed: number): MayaTempleLayout`
- `export function fillSealColumnMask(chunkX: number, chunkZ: number, chunkSize: number, seed: number, out: Uint8Array): SealColumnMask`

**Types / Interfaces / Enums**
- type `MayaSealBox`
- type `MayaTempleLayout`
- type `ResolvedTemple`
- type `SealColumnMask`

---

## `Generation/Structure/TowerFeature.ts` (328 LOC)

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/TreehouseFeature.ts` (111 LOC)

### export class TreehouseFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/TropicalTempleFeature.ts` (123 LOC)

### export class TropicalTempleFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/WatchtowerFeature.ts` (114 LOC)

### export class WatchtowerFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/WellFeature.ts` (109 LOC)

### export class WellFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/Structure/WindmillFeature.ts` (106 LOC)

### export class WindmillFeature implements IWorldFeature

**Properties**
- `public readonly verticalBounds`
- `public readonly maxAboveSurface`

**Methods**
- `public generate(chunkX: number, _chunkY: number, chunkZ: number, biome: Biome, placeBlock: PlaceBlockFn, seed: number, chunkSize: number, generatingChunkX: number, generatingChunkZ: number, columnPrepassResolver?: ColumnPrepassResolver)`

**Types / Interfaces / Enums**
- type `RegionConfig`

---

## `Generation/StructureLocator.ts` (322 LOC)

**Module-level functions**
- `function normaliseName(name: string): string`
- `export function findLocatableStructure(name: string): LocatableStructure | null`
- `export function suggestLocatableStructures(name: string, limit = 5): LocatableStructure[]`
- `export function locateStructure(structure: LocatableStructure, options: LocateOptions): LocateMatch | null`
- `export function formatLocateResult(match: LocateMatch, originX: number, originZ: number): string`
- `function compassDirection(dx: number, dz: number): string`
- `export function locateAll(options: LocateOptions): LocateMatch[]`

**Types / Interfaces / Enums**
- type `LocatableStructure`
- type `LocateOptions`

---

## `Generation/SurfaceGenerator.ts` (1390 LOC)

**Types / Interfaces / Enums**
- type `GenerationParamsType`
- type `TerrainNoiseGrid`
- type `PlaceBlockFn`
- type `SurfaceGenerationResult`
- type `ColumnPrepassCacheEntry`

---

## `Generation/Terrain/StructurePlacer.ts` (58 LOC)

**Module-level functions**
- `export function generateStructures(chunkX: number, chunkY: number, chunkZ: number, chunkSize: number, biome: Biome, features: IWorldFeature[], seedAsInt: number, placeBlock: PlaceBlockFn, columnPrepassResolver?: ColumnPrepassResolver): void`

---

## `Generation/Terrain/SurfaceBlockResolver.ts` (27 LOC)

**Module-level functions**
- `export function resolveSolidBlockId(currentBiome: Biome, worldY: number, depthBelowSurface: number, isBeach: boolean, seaLevel: number): number`

---

## `Generation/TerrainHeightMap.ts` (600 LOC)

**Module-level functions**
- `function hash2(x: number, z: number, mask: number): number`
- `function createTerrainNoise(seed: string): TerrainNoiseSet`
- `export function setTerrainSeed(seed: string): void`
- `function applyRidged(raw: number): number`
- `function fillChunkCache(cx: number, cz: number, idx: number): void`
- `function getChunkCacheIdx(worldX: number, worldZ: number): number`
- `function fhcSlot(x: number, z: number): number`
- `function getBiomeBase(b: Biome): number`
- `function getBiomeAmp(b: Biome): number`
- `function getBiomeScale(b: Biome): number`
- `function getBiomeExp(b: Biome): number`
- `function getBiomePvScale(b: Biome): number`
- `function getBiomeErosionScale(b: Biome): number`
- `function getCornerSlot(gx: number, gz: number): number`
- `function writeCornerSlot(slot: number, gx: number, gz: number, base: number, amp: number, scale: number, exp: number, pvScale: number, erosionScale: number): void`
- `function writeCornerFromSignals(gx: number, gz: number, rawContinent: number, rawTemperature: number, rawHumidity: number, rawRiver: number): number`
- `function ensureCorner(gx: number, gz: number, worldX: number, worldZ: number): number`
- `function shapeHeightNoise(rawNoise: number, exp: number): number`
- `function computeFinalTerrainHeight(x: number, z: number, riverAbs: number, erosion: number, pv: number, rawContinent: number): number`
- `export function effectiveColumnTopChunkY(terrainHeight: number): number`
- `export function columnMinHeight(chunkX: number, chunkZ: number): number`
- `export function isOceanFloorBandChunk(chunkX: number, chunkY: number, chunkZ: number): boolean`
- `export function getFinalTerrainHeight(x: number, z: number): number`
- `export function fillTerrainNoiseGrid(chunkWorldX: number, chunkWorldZ: number, halo: number, chunkSize: number, out: TerrainNoiseGrid): void`
- `export function getFinalTerrainHeightFromGrid(x: number, z: number, grid: TerrainNoiseGrid): number`
- `export function getBiome(x: number, z: number): Biome`
- `export function getCachedRiverNoise(x: number, z: number): number`
- `export function getOctaveNoise(x: number, z: number): number`
- `export function getTerrainNoiseDebug(x: number, z: number)`
- `export function prefetchChunkCorners(chunkWorldX: number, chunkWorldZ: number): void`

**Types / Interfaces / Enums**
- type `GenerationParamsType`
- type `TerrainNoiseSet`
- type `TerrainNoiseGrid`

---

## `Generation/UndergroundBiomes.ts` (141 LOC)

### export class UndergroundBiomeSelector

**Constructor**
- `constructor(biomeNoise: (x: number, z: number) => number, seedAsInt: number)`

**Properties**
- `private readonly biomeNoise: (x: number, z: number) => number`
- `private readonly seedAsInt: number`

**Methods**
- `public getBiome(worldX: number, worldY: number, worldZ: number): UndergroundBiome`
- `public sampleBiomeNoise(worldX: number, worldZ: number): number`
- `public getBiomeWithNoise(worldX: number, worldY: number, worldZ: number, noiseVal: number): UndergroundBiome`
- `public getStoneReplacement(blockId: number, biome: UndergroundBiome): number`

**Types / Interfaces / Enums**
- type `UndergroundBiome`

---

## `Generation/UndergroundGenerator.ts` (237 LOC)

### export class UndergroundGenerator

**Constructor**
- `constructor(params: GenerationParamsType, cheeseNoise: (x: number, y: number, z: number) => number, tunnelNoise: (x: number, y: number, z: number) => number, detailNoise: (x: number, y: number, z: number) => number, cheeseInstance?: NoiseInstance, tunnelInstance?: NoiseInstance, detailInstance?: NoiseInstance)`

**Properties**
- `private readonly params: GenerationParamsType`
- `private readonly CHUNK_SIZE: number`
- `private readonly LAVA_LEVEL: number`
- `private readonly cheeseNoise: (x: number, y: number, z: number) => number`
- `private readonly tunnelNoise: (x: number, y: number, z: number) => number`
- `private readonly detailNoise: (x: number, y: number, z: number) => number`
- `private readonly caveGrid: CaveNoiseGrid`

**Methods**
- `public generate(chunkX: number, chunkY: number, chunkZ: number, topSurfaceYMap: Int16Array, placeBlockLocal: (
			lx: number,
			ly: number,
			lz: number,
			id: number,
			ow?: boolean,
		) => void, blocks?: Uint8Array, seedAsInt?: number): boolean`

---

## `Generation/WorldGenerator.ts` (401 LOC)

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
- `seed: getPRNGBySeed(52253100808, this.seedAsInt),`
- `frequency: 1,`
- `seed: getPRNGBySeed(4912491002, this.seedAsInt),`
- `frequency: this.params.CAVE_CHEESE_FREQ,`
- `seed: getPRNGBySeed(251251516119, this.seedAsInt),`
- `frequency: this.params.CAVE_TUNNEL_FREQ,`
- `seed: getPRNGBySeed(242319705330, this.seedAsInt),`
- `frequency: this.params.CAVE_DETAIL_FREQ,`
- `seed: getPRNGBySeed(25, this.seedAsInt),`
- `frequency: 1,`
- `seed: getPRNGBySeed(26, this.seedAsInt),`
- `frequency: 0.001,`

**Methods**
- `createFastNoise3DWithInstance({
				seed: getPRNGBySeed(100002313119477, this.seedAsInt),
				frequency: 0.33333,
			})`
- `private createBuffer(size: number): Uint8Array`
- `private applyUndergroundBiomes(blocks: Uint8Array, chunkWorldX: number, chunkWorldY: number, chunkWorldZ: number, chunkSize: number, chunkSizeSq: number): void`
- `public refineBlocks(blocks: Uint8Array, chunkX: number, chunkY: number, chunkZ: number): void`
- `public generateChunkData(chunkX: number, chunkY: number, chunkZ: number, options: GenerateChunkOptions = {}): GenerateChunkResult`
- `public relightChunk(chunkX: number, chunkY: number, chunkZ: number, blocks: Uint8Array | Uint16Array, topSunlightMask?: Uint8Array, neighborLight?: ReadonlyArray<Uint8Array | null>): Uint8Array`

**Types / Interfaces / Enums**
- type `GenerateChunkOptions`
- type `GenerateChunkResult`

---

## `Generation/WorldSeed.ts` (5 LOC)

**Module-level functions**
- `export function computeSeedAsInt(seed: string): number`

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

## `Lib/ChatHistory.ts` (25 LOC)

### export class ChatHistory

**Methods**
- `add(entry: string): void`
- `reset(): void`
- `previous(): string | null`
- `next(): string | null`

---

## `Lib/debugLog.ts` (15 LOC)

**Module-level functions**
- `function isDebugEnabled(): boolean`
- `export function debugLog(...args: unknown[]): void`

---

## `Lib/FrameProfiler.ts` (362 LOC)

---

## `Lib/GameRuntimeState.ts` (39 LOC)

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

## `Lib/Math.ts` (1063 LOC)

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
- `static FromRotationMatrix(matrix: Matrix): Quaternion`
- `static FromRotationMatrixToRef(matrix: Matrix, result: Quaternion): Quaternion`
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
- `static RotationYToRef(angle: number, result: Matrix): Matrix`
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
- `toEulerAnglesToRef(result: Vec3): Vec3`
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

## `Lib/VoxelMath.ts` (32 LOC)

**Module-level functions**
- `export function worldToChunkCoord(value: number): number`
- `export function worldToBlockCoord(value: number): number`
- `export function idx3(x: number, y: number, z: number, size: number): number`
- `export function idx2(x: number, z: number, size: number): number`
- `export function getSkyLight(packed: number): number`
- `export function getBlockLight(packed: number): number`
- `export function packLight(sky: number, block: number): number`

---

## `Lib/WasmKernels.ts` (411 LOC)

### export class WasmFastNoise implements NoiseInstance

**Constructor**
- `constructor(private kernels: WasmKernelsExports, seed: number)`

**Properties**
- `private seed: number`
- `private noiseType: NoiseType = 1`
- `private rotationType3D: RotationType3D = 0`
- `private transformType: number = transformTypeFor(1, 0)`
- `private frequency`
- `private fractalType: FractalType = 2`
- `private octaves`
- `private lacunarity`
- `private gain`
- `private weightedStrength`
- `private pingPongStrength`
- `private memF32: Float32Array | null = null`
- `private memByteLength`

**Methods**
- `private readBatch(ptr: number, out: Float32Array): void`
- `GetNoise2D(x: number, y: number): number`
- `GetNoise3D(x: number, y: number, z: number): number`
- `FillNoise2D(out: Float32Array, width: number, height: number, offsetX = 0, offsetY = 0): void`
- `FillNoise3D(out: Float32Array, width: number, height: number, depth: number, offsetX = 0, offsetY = 0, offsetZ = 0): void`
- `FillNoise3DAffine(out: Float32Array, width: number, height: number, depth: number, x0: number, y0: number, z0: number, ax: number, bx: number, ay: number, az: number, bz: number): void`
- `SurfaceDensity(out: Float32Array, count: number, startY: number, step: number, baseNoiseX: number, baseNoiseZ: number, overhangBaseX: number, overhangBaseZ: number, baseHeight: number, yFreq: number, cliffContribution: number, baseAmp: number, overhangAmp: number, influenceRange: number): void`
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

**Module-level functions**
- `export function transformTypeFor(noiseType: NoiseType, rotationType3D: RotationType3D): number`
- `export function createWasmNoiseBackend(bytes: Uint8Array): NoiseBackend`

**Types / Interfaces / Enums**
- interface `WasmKernelsExports`
- interface `WasmEnvImports`

---

## `Lib/WasmNoise.ts` (74 LOC)

**Module-level functions**
- `function isWasmNoiseDisabled(): boolean`
- `export function enableWasmNoise(url: string = KERNELS_WASM_URL): Promise<boolean>`
- `async function loadWasmNoise(url: string): Promise<boolean>`
- `async export function loadWasmNoiseFromFile(filePath: string = KERNELS_WASM_PATH): Promise<boolean>`

---

## `Lib/yieldToEventLoop.ts` (41 LOC)

**Module-level functions**
- `export function yieldToEventLoop(): Promise<void>`

---

## `Maps/BlockBreakParticles.ts` (1188 LOC)

**Module-level functions**
- `function buildBlockFrameLUT(): Uint16Array`
- `export function play(position: Vec3, blockId: number, packedLight: number): void`
- `export function playDebris(x: number, y: number, z: number, blockId: number, packedLight: number): void`
- `export function playPlace(x: number, y: number, z: number, blockId: number, packedLight: number): void`
- `export function playExplosionDebris(x: number, y: number, z: number, blockId: number, packedLight: number, power = 1): void`
- `export function playMining(x: number, y: number, z: number, nx: number, ny: number, nz: number, blockId: number): void`
- `export function playArrowHit(x: number, y: number, z: number, nx: number, ny: number, nz: number, blockId: number): void`
- `export function playMobDrip(x: number, y: number, z: number, damage = 0.5): void`
- `export function playMobDamage(x: number, y: number, z: number, damage: number): void`
- `export function playMobDamageDirected(x: number, y: number, z: number, damage: number, dirX: number, dirZ: number): void`
- `function spawnBloodBurst(x: number, y: number, z: number, damage: number, dirX: number, dirZ: number, directed: boolean): void`
- `export function playMobDeath(x: number, y: number, z: number): void`
- `export function playSprint(emitter: SprintEmitterState, x: number, y: number, z: number, velX: number, velZ: number): void`
- `export function playLandingDust(x: number, y: number, z: number, fallDistance: number): void`
- `export function playExplosion(x: number, y: number, z: number, radius: number, packedLight: number): void`
- `function spawnFireShell(x: number, y: number, z: number, frame: number, count: number, r: number, g: number, b: number, minSpeed: number, maxSpeed: number, minLife: number, maxLife: number, minSize: number, maxSize: number, grav: number, speedScale: number): void`
- `async export function initBlockBreakParticles(scene: SceneContext): Promise<void>`
- `function flushDeferredRenderables(scene: SceneContext): Promise<void>`
- `function tick(deltaMs: number): void`
- `function spawnBurst(x: number, y: number, z: number, frame: number, r: number, g: number, b: number): void`
- `function spawnDebrisBurst(x: number, y: number, z: number, frame: number, r: number, g: number, b: number): void`
- `function collideParticle(i: number, dt: number): void`
- `function moveDebrisAxis(i: number, axis: number, delta: number): void`
- `function onDebrisHit(i: number, axis: number, dir: number): void`
- `function addParticle(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, angle: number, spin: number, frame: number, r: number, g: number, b: number, a: number, gravityScale: number, collide: 0 | 1 = 0): void`
- `function removeParticle(i: number): void`
- `function getBlockFrame(blockId: number): number`
- `function computeLight(packedLight: number)`

**Types / Interfaces / Enums**
- type `FacingBillboardSpriteSystem`
- type `SceneContext`
- type `Vec3`

---

## `Maps/Map1.ts` (80 LOC)

### export class Map1

**Constructor**
- `constructor(engine: EngineContext, scene: SceneContext, player: Player)`

**Properties**
- `public static mainScene: SceneContext`
- `public static engine: EngineContext`
- `public static environment: WorldEnvironment`
- `public static mobRegistry: MobRegistry | null = null`
- `public static remoteMobManager: RemoteMobManager | null = null`
- `public static mainPlayer: Player | null = null`
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

## `Maps/MapFog.ts` (54 LOC)

---

## `Maps/UnderWaterEffect.ts` (220 LOC)

### export class UnderWaterEffect

**Constructor**
- `constructor(scene: SceneContext, camera: EyeCamera, baseTexture: unknown)`

**Properties**
- `public material: object | null = null`
- `public postProcess: object | null = null`
- `private readonly scene: SceneContext`
- `private readonly camera: EyeCamera`
- `private isUnderwater`
- `private wasUnderwater`
- `private overlay: HTMLDivElement | null = null`
- `private hideTimer: number | null = null`
- `private styleAcquired`
- `private disposed`
- `onDisposeObservable?: { addOnce?: (callback: () => void) => void; }`

**Accessors**
- `public get isUnderwaterState(): boolean`

**Methods**
- `acquireUnderwaterStyle()`
- `public updateFromCamera(): boolean`
- `public dispose(): void`

**Module-level functions**
- `function acquireUnderwaterStyle(): void`
- `function releaseUnderwaterStyle(): void`
- `export function isEyeUnderwater(eyeX: number, eyeY: number, eyeZ: number): boolean`

**Types / Interfaces / Enums**
- interface `EyeCamera`

---

## `Maps/WorldEnvironment.ts` (270 LOC)

---

## `Network/chunk/RemoteChunkProvider.ts` (1090 LOC)

---

## `Network/MultiplayerHUD.ts` (159 LOC)

### export class MultiplayerHUD

**Constructor**
- `constructor(private onSendChat: (message: string) => void, private onToggleChat: (open: boolean) => void)`

**Properties**
- `private container: HTMLElement`
- `private statusEl: HTMLElement`
- `private playerCountEl: HTMLElement`
- `private playerListEl: HTMLElement`
- `private chatMessagesEl: HTMLElement`
- `private chatInput: HTMLInputElement`
- `private chatOpen`
- `private history`
- `private messageCount`
- `private _lastNamesKey`

**Methods**
- `setConnected(connected: boolean): void`
- `setPlayerCount(count: number): void`
- `setPlayerNames(names: string[]): void`
- `dispose(): void`

---

## `Network/NetClient.ts` (866 LOC)

### export class NetClient

**Constructor**
- `constructor(private serverUrl: string = NetClient.defaultServerUrl())`

**Properties**
- `private client: ColyseusSDK | null = null`
- `private room: any = null`
- `private readonly encoder`
- `private readonly decoder`
- `private connected`
- `private callbacks: NetClientCallbacks = {}`
- `private readonly remotePlayers`
- `private playersByIndex: (RemotePlayer | undefined)[] = []`
- `private ownIndex`
- `private playerName`
- `private readonly binaryHandlers: BinaryHandler[] = []`
- `private readonly disconnectListeners: (() => void)[] = []`
- `private readonly batchScratch: PlayerStateBatchEntry[] = []`
- `private readonly warnedUnknownIndices`
- `private readonly playerHeldItemScratch: PlayerHeldItemData = { index: 0, itemId: 0, blockState: 0, }`
- `private readonly playerJoinScratch: PlayerJoinData = { index: 0, sessionId: , name: , }`
- `private readonly blockEditBroadcastScratch: BlockEditData = { sessionId: , x: 0, y: 0, z: 0, blockId: 0, blockState: 0, action: 0, }`
- `private readonly blockEditRejectedScratch: BlockEditRejectedData = { x: 0, y: 0, z: 0, blockId: 0, blockState: 0, action: 0, reason: 0, }`
- `private readonly tntIgniteScratch: TntIgniteData = { x: 0, y: 0, z: 0, fuse: 0, radius: 0, }`
- `private readonly chatMessageScratch: ChatMessageData = { sessionId: , name: , message: , }`
- `private readonly worldConfigScratch: WorldConfigData = { seed: , dayDurationMs: 0, dayCycle: false, }`
- `private readonly spawnPositionScratch`
- `private readonly blockEditScratch: BlockEditData = { sessionId: , x: 0, y: 0, z: 0, blockId: 0, blockState: 0, action: 0, }`
- `private roomGeneration`
- `worldName`

**Accessors**
- `get isConnected(): boolean`
- `get sessionId(): string`

**Methods**
- `private static defaultServerUrl(): string`
- `setCallbacks(callbacks: NetClientCallbacks): void`
- `async connect(playerName: string, worldName: string, seed: string): Promise<void>`
- `private setupRoomHandlers(room: any, generation: number): void`
- `addBinaryHandler(handler: BinaryHandler): void`
- `removeBinaryHandler(handler: BinaryHandler): void`
- `addDisconnectListener(listener: () => void): void`
- `removeDisconnectListener(listener: () => void): void`
- `private handleBinaryMessage(data: Uint8Array): void`
- `private handlePlayerStateBatch(dec: BinaryDecoder): void`
- `private handlePlayerJoin(dec: BinaryDecoder): void`
- `private handlePlayerLeave(dec: BinaryDecoder): void`
- `sendHeldItemSelection(itemId: number, blockState = 0): boolean`
- `sendPlayerState(x: number, y: number, z: number, yaw: number, pitch: number, animation: number): void`
- `sendBlockEdit(x: number, y: number, z: number, blockId: number, action: number, blockState = 0): void`
- `sendChat(message: string): void`
- `sendChunkRequest(cx: number, cy: number, cz: number, lod: number, cachedVersion = 0): void`
- `sendChunkRequestBatch(requests: ChunkRequest[]): void`
- `sendItemDrop(itemId: number, stackSize: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): void`
- `sendItemPickup(instanceId: number): void`
- `sendContainerOpen(x: number, y: number, z: number): void`
- `sendContainerSetSlot(x: number, y: number, z: number, row: number, col: number, itemId: number, stackSize: number): void`
- `sendContainerClose(x: number, y: number, z: number): void`
- `sendStationOpen(x: number, y: number, z: number): void`
- `sendStationSetSlot(x: number, y: number, z: number, slot: number, itemId: number, stackSize: number): void`
- `sendStationUpgrade(x: number, y: number, z: number, capTier: number): void`
- `sendStationClaimResult(x: number, y: number, z: number): void`
- `sendMobSpawnRequest(typeId: number, x: number, y: number, z: number): void`
- `sendMobDamage(mobId: number, damage: number): void`
- `sendArrowShoot(x: number, y: number, z: number, vx: number, vy: number, vz: number, arrowType: number): void`
- `sendExplosion(x: number, y: number, z: number, radius: number): void`
- `sendTntIgnite(x: number, y: number, z: number, fuse: number, radius: number): void`
- `uploadSkin(png: Uint8Array): void`
- `private async uploadOwnSkin(): Promise<void>`
- `getRemotePlayers(): Map<string, RemotePlayer>`
- `getRemotePlayer(sessionId: string): RemotePlayer | undefined`
- `updateRemotePlayerInterpolation(dt: number): void`
- `disconnect(): void`
- `private detachCurrentRoom(): void`
- `private resetRemoteState(): void`
- `private isCurrentRoom(room: any, generation: number): boolean`
- `private getConnectedRoom(): any | null`
- `static encodeYawByte(yaw: number): number`
- `static encodePitchByte(pitch: number): number`

**Types / Interfaces / Enums**
- interface `RemotePlayer`
- interface `NetClientCallbacks`
- type `WorldConfigData`
- type `BlockEditData`
- type `BlockEditRejectedData`
- type `ChatMessageData`
- type `PlayerHeldItemData`
- type `PlayerJoinData`
- type `PlayerStateBatchEntry`
- type `TntIgniteData`
- type `BinaryHandler`
- type `ChunkRequest`

---

## `Network/NetworkManager.ts` (593 LOC)

### export class NetworkManager

**Constructor**
- `constructor(player: Player, serverUrl?: string)`

**Properties**
- `private client: NetClient`
- `private renderer: RemotePlayerRenderer`
- `private hud: MultiplayerHUD`
- `private chunkProvider: RemoteChunkProvider`
- `readonly containers: RemoteContainerManager`
- `readonly stations: RemoteStationManager`
- `private player: Player`
- `private sendAccum`
- `private lastSentHeldItemId`
- `private lastSentHeldItemBlockState`
- `private lastSentState: { x: number; y: number; z: number; yawByte: number; pitchByte: number; } | null = null`
- `private _scratchVec: Vec3 = vec3Zero()`
- `private serverSeed: string | null = null`
- `private _lastPlayerCount`
- `private _canvas: HTMLCanvasElement | null = null`
- `private _canvasWidth`
- `private _canvasHeight`
- `private readonly _onCanvasResize`
- `onBlockPlaced`
- `onBlockBroken`
- `onExplosion`
- `onTntIgnite`

**Accessors**
- `get netClient(): NetClient`
- `get isConnected(): boolean`
- `get remotePlayers(): Map<string, RemotePlayer>`

**Methods**
- `async connect(playerName: string, worldName: string): Promise<void>`
- `tick(deltaMs: number): void`
- `toggleChat(): void`
- `private onToggleChat(open: boolean): void`
- `private sendHeldItemSelection(): void`
- `private sendPlayerState(): void`
- `private applyRemoteBlockEdit(x: number, y: number, z: number, blockId: number, action: number, blockState = 0): void`
- `private revertRejectedBlockEdit(rejection: {
		x: number;
		y: number;
		z: number;
		blockId: number;
		blockState: number;
		action: number;
		reason: number;
	}): void`
- `private sampleBreakLight(x: number, y: number, z: number): number`
- `sendChat(message: string): void`
- `private handleCommand(raw: string): void`
- `private parseGamemode(input: string | undefined): Gamemodes | null`
- `private handleTeleport(args: string[]): void`
- `disconnect(): void`
- `notifySystemMessage(text: string): void`

**Module-level functions**
- `function gamemodeName(gm: Gamemodes): string`
- `function parseRelativeCoord(input: string, current: number): number | null`

---

## `Network/protocol/encoder.ts` (1757 LOC)

### export class BinaryEncoder

**Constructor**
- `constructor(initialCapacity = 1024)`

**Properties**
- `private buffer: Uint8Array`
- `private view: DataView`
- `private offset: number`

**Methods**
- `private ensure(needed: number): void`
- `writeUint8(value: number): void`
- `writeInt16(value: number): void`
- `writeInt32(value: number): void`
- `writeFloat32(value: number): void`
- `writeUint16(value: number): void`
- `writeUint32(value: number): void`
- `writeString(str: string): void`
- `writeBytes(bytes: Uint8Array): void`
- `writeCoords(x: number, y: number, z: number): void`
- `writePlayerState(data: PlayerStateData): void`
- `writePlayerStateRaw(x: number, y: number, z: number, yaw: number, pitch: number, animation: number): void`
- `writeBlockEdit(data: BlockEditData): void`
- `writeChatMessage(data: ChatMessageData): void`
- `writeChunkRequest(cx: number, cy: number, cz: number, lod: number, cachedVersion = 0): void`
- `writeChunkRequestBatch(requests: Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedVersion: number;
		}>): void`
- `getBytes(): Uint8Array`
- `reset(): void`

**Module-level functions**
- `export function writePlayerStateBatch(enc: BinaryEncoder, states: PlayerStateBatchEntry[]): void`
- `export function encodePlayerStateBatch(states: PlayerStateBatchEntry[]): Uint8Array`
- `export function decodePlayerStateBatchInto(buffer: Uint8Array, target: PlayerStateBatchEntry[]): number`
- `export function decodePlayerStateBatchEntriesInto(dec: BinaryDecoder, target: PlayerStateBatchEntry[]): number`
- `export function encodeBlockEditBatch(edits: BlockEditData[]): Uint8Array`
- `export function decodeBlockEditBatch(buffer: Uint8Array): BlockEditData[]`
- `export function encodePlayerJoin(data: PlayerJoinData): Uint8Array`
- `export function decodePlayerJoinInto(dec: BinaryDecoder, target: PlayerJoinData): typeof target`
- `export function encodePlayerLeave(data: PlayerLeaveData): Uint8Array`
- `export function decodePlayerLeave(buffer: Uint8Array): number`
- `export function encodeHeldItemSelect(data: HeldItemSelectionData): Uint8Array`
- `export function decodeHeldItemSelectInto(dec: BinaryDecoder, target: HeldItemSelectionData): typeof target`
- `export function encodePlayerHeldItem(data: PlayerHeldItemData): Uint8Array`
- `export function decodePlayerHeldItemInto(dec: BinaryDecoder, target: PlayerHeldItemData): typeof target`
- `export function encodePlayerSkin(data: PlayerSkinData): Uint8Array`
- `export function decodePlayerSkinInto(dec: BinaryDecoder, target: PlayerSkinData): typeof target`
- `export function encodeWorldConfig(seed: string, dayDurationMs: number, dayCycle: boolean): Uint8Array`
- `export function decodeWorldConfigInto(dec: BinaryDecoder, target: WorldConfigData): typeof target`
- `export function encodeChunkData(data: {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blocks: Uint8Array | Uint16Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
	version: number;
}): Uint8Array`
- `export function decodeChunkData(buffer: Uint8Array, allocSAB = false): RemoteChunkData`
- `function decodeChunkDataEntry(dec: BinaryDecoder, allocSAB: boolean): RemoteChunkData`
- `export function encodeChunkUnchanged(cx: number, cy: number, cz: number, version: number): Uint8Array`
- `export function decodeChunkUnchangedInto(dec: BinaryDecoder, target: { cx: number; cy: number; cz: number; version: number }): typeof target`
- `export function decodeChunkUnchangedBatchInto(dec: BinaryDecoder, target: Array<{ cx: number; cy: number; cz: number; version: number }>): number`
- `export function encodeChunkRequestBatch(requests: Array<{
		cx: number;
		cy: number;
		cz: number;
		lod: number;
		cachedVersion: number;
	}>): Uint8Array`
- `export function encodeChunkDataBatch(chunks: Array<{
		chunkX: number;
		chunkY: number;
		chunkZ: number;
		blocks: Uint8Array;
		light: Uint8Array;
		palette?: number[];
		isUniform: boolean;
		uniformBlockId: number;
		version: number;
	}>): Uint8Array`
- `function encodeChunkDataBatchMeasure(chunks: Array<{
		blocks: Uint8Array;
		light: Uint8Array;
		palette?: number[];
		isUniform: boolean;
	}>, count: number): number`
- `export function decodeChunkDataBatch(buffer: Uint8Array, allocSAB = false): Array<RemoteChunkData>`
- `async export function encodeChunkDataDeflated(data: {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	version: number;
	blob: Uint8Array;
}): Promise<Uint8Array>`
- `export function encodeChunkDataDeflatedPayload(data: DeflatedChunk): Uint8Array`
- `export function decodeChunkDataDeflated(buffer: Uint8Array): DeflatedChunk`
- `export function decodeChunkDataDeflatedFrom(dec: BinaryDecoder): DeflatedChunk`
- `export function decodeChunkDataDeflatedInto(dec: BinaryDecoder, target: DeflatedChunk): DeflatedChunk`
- `function decodeDeflatedChunkEntry(dec: BinaryDecoder): DeflatedChunk`
- `export function decodeDeflatedChunkEntryFrom(dec: BinaryDecoder): DeflatedChunk`
- `export function decodeDeflatedChunkEntryInto(dec: BinaryDecoder, target: DeflatedChunk): DeflatedChunk`
- `export function decodeChunkDataDeflatedBatch(buffer: Uint8Array): DeflatedChunk[]`
- `export function decodeChunkDataDeflatedBatchFrom(dec: BinaryDecoder): DeflatedChunk[]`
- `export function decodeChunkDataDeflatedBatchInto(dec: BinaryDecoder, target: DeflatedChunk[]): number`
- `export function encodeYawByte(yaw: number): number`
- `export function encodePitchByte(pitch: number): number`
- `export function decodeYawByte(byte: number): number`
- `export function decodePitchByte(byte: number): number`
- `export function encodeSpawnPosition(x: number, y: number, z: number, yaw: number, pitch: number): Uint8Array`
- `export function decodeSpawnPosition(buffer: Uint8Array)`
- `export function decodeSpawnPositionFrom(dec: BinaryDecoder)`
- `export function decodeSpawnPositionInto(dec: BinaryDecoder, target: { x: number; y: number; z: number; yaw: number; pitch: number }): typeof target`
- `export function encodeMobSpawn(mobId: number, mobType: number, x: number, y: number, z: number, yaw: number): Uint8Array`
- `export function decodeMobSpawn(buffer: Uint8Array)`
- `export function decodeMobSpawnFrom(dec: BinaryDecoder)`
- `export function decodeMobSpawnInto(dec: BinaryDecoder, target: {
		mobId: number;
		mobType: number;
		x: number;
		y: number;
		z: number;
		yaw: number;
	}): typeof target`
- `export function writeMobUpdateBatch(enc: BinaryEncoder, entries: MobUpdateBatchEntry[]): void`
- `export function encodeMobDespawn(mobId: number): Uint8Array`
- `export function decodeMobDespawn(buffer: Uint8Array): number`
- `export function encodeMobSpawnRequest(data: MobSpawnRequestData): Uint8Array`
- `export function decodeMobSpawnRequestInto(dec: BinaryDecoder, target: MobSpawnRequestData): typeof target`
- `export function encodeMobDamage(data: MobDamageData): Uint8Array`
- `export function decodeMobDamageInto(dec: BinaryDecoder, target: MobDamageData): typeof target`
- `export function encodeMobImpact(data: MobImpactData): Uint8Array`
- `export function decodeMobImpactInto(dec: BinaryDecoder, target: MobImpactData): typeof target`
- `export function encodeArrowShoot(data: ArrowTrajectoryData): Uint8Array`
- `export function decodeArrowShootInto(dec: BinaryDecoder, target: ArrowTrajectoryData): typeof target`
- `export function encodeArrowSpawn(data: ArrowTrajectoryData): Uint8Array`
- `export function decodeArrowSpawnInto(dec: BinaryDecoder, target: ArrowTrajectoryData): typeof target`
- `function encodeArrowTrajectory(type: number, data: ArrowTrajectoryData): Uint8Array`
- `export function decodeArrowTrajectoryInto(dec: BinaryDecoder, target: ArrowTrajectoryData): typeof target`
- `export function encodeExplosion(data: ExplosionData): Uint8Array`
- `export function decodeExplosionInto(dec: BinaryDecoder, target: ExplosionData): typeof target`
- `export function encodeTntIgnite(data: TntIgniteData): Uint8Array`
- `export function decodeTntIgniteInto(dec: BinaryDecoder, target: TntIgniteData): typeof target`
- `export function encodeItemDrop(data: ItemDropData): Uint8Array`
- `export function decodeItemDropInto(dec: BinaryDecoder, target: ItemDropData): typeof target`
- `export function encodeItemPickup(data: ItemPickupData): Uint8Array`
- `export function decodeItemPickupInto(dec: BinaryDecoder, target: ItemPickupData): typeof target`
- `export function encodeItemSpawn(data: ItemSpawnData): Uint8Array`
- `export function decodeItemSpawnInto(dec: BinaryDecoder, target: ItemSpawnData): typeof target`
- `export function writeItemUpdateBatch(enc: BinaryEncoder, entries: ItemUpdateBatchEntry[]): void`
- `export function encodeItemDespawn(id: number): Uint8Array`
- `export function decodeItemDespawn(buffer: Uint8Array): number`
- `export function encodeItemPickupRejected(data: ItemPickupRejectedData): Uint8Array`
- `export function decodeItemPickupRejectedInto(dec: BinaryDecoder, target: ItemPickupRejectedData): typeof target`
- `export function encodeContainerOpen(data: ContainerOpenData): Uint8Array`
- `export function decodeContainerOpenInto(dec: BinaryDecoder, target: ContainerOpenData): typeof target`
- `export function encodeContainerState(data: ContainerStateData): Uint8Array`
- `export function decodeContainerStateInto(dec: BinaryDecoder, target: ContainerStateData): typeof target`
- `export function encodeContainerSetSlot(data: ContainerSetSlotData): Uint8Array`
- `export function decodeContainerSetSlotInto(dec: BinaryDecoder, target: ContainerSetSlotData): typeof target`
- `export function encodeContainerSlotUpdate(data: ContainerSlotUpdateData): Uint8Array`
- `export function decodeContainerSlotUpdateInto(dec: BinaryDecoder, target: ContainerSlotUpdateData): typeof target`
- `export function encodeContainerClose(data: ContainerCloseData): Uint8Array`
- `export function decodeContainerCloseInto(dec: BinaryDecoder, target: ContainerCloseData): typeof target`
- `export function encodeContainerRejected(data: ContainerRejectedData): Uint8Array`
- `export function decodeContainerRejectedInto(dec: BinaryDecoder, target: ContainerRejectedData): typeof target`
- `export function encodeStationOpen(data: StationOpenData): Uint8Array`
- `export function decodeStationOpenInto(dec: BinaryDecoder, target: StationOpenData): typeof target`
- `export function encodeStationState(data: StationStateData): Uint8Array`
- `export function decodeStationStateInto(dec: BinaryDecoder, target: StationStateData): typeof target`
- `export function encodeStationSetSlot(data: StationSetSlotData): Uint8Array`
- `export function decodeStationSetSlotInto(dec: BinaryDecoder, target: StationSetSlotData): typeof target`
- `export function encodeStationUpgrade(data: StationUpgradeData): Uint8Array`
- `export function decodeStationUpgradeInto(dec: BinaryDecoder, target: StationUpgradeData): typeof target`
- `export function encodeStationResultClaimed(data: StationResultClaimedData): Uint8Array`
- `export function decodeStationResultClaimedInto(dec: BinaryDecoder, target: StationResultClaimedData): typeof target`
- `export function encodeStationClaimResult(data: StationClaimResultData): Uint8Array`
- `export function decodeStationClaimResultInto(dec: BinaryDecoder, target: StationClaimResultData): typeof target`
- `export function encodeStationSlotUpdate(data: StationSlotUpdateData): Uint8Array`
- `export function decodeStationSlotUpdateInto(dec: BinaryDecoder, target: StationSlotUpdateData): typeof target`
- `export function encodeStationRejected(data: StationRejectedData): Uint8Array`
- `export function decodeStationRejectedInto(dec: BinaryDecoder, target: StationRejectedData): typeof target`

**Types / Interfaces / Enums**
- interface `WorldConfigData`
- interface `DeflatedChunk`
- type `ArrowTrajectoryData`
- type `BlockEditData`
- type `BlockEditRejectedData`
- type `ChatMessageData`
- type `ContainerCloseData`
- type `ContainerOpenData`
- type `ContainerRejectedData`
- type `ContainerSetSlotData`
- type `ContainerSlotData`
- type `ContainerSlotUpdateData`
- type `ContainerStateData`
- type `ExplosionData`
- type `HeldItemSelectionData`
- type `ItemDropData`
- type `ItemPickupData`
- type `ItemPickupRejectedData`
- type `ItemSpawnData`
- type `ItemUpdateBatchEntry`
- type `MobDamageData`
- type `MobImpactData`
- type `MobSpawnRequestData`
- type `MobUpdateBatchEntry`
- type `PlayerHeldItemData`
- type `PlayerJoinData`
- type `PlayerLeaveData`
- type `PlayerSkinData`
- type `PlayerStateBatchEntry`
- type `PlayerStateData`
- type `StationClaimResultData`
- type `StationOpenData`
- type `StationRejectedData`
- type `StationResultClaimedData`
- type `StationSetSlotData`
- type `StationSlotUpdateData`
- type `StationStateData`
- type `StationUpgradeData`
- type `TntIgniteData`

---

## `Network/protocol/messages.ts` (367 LOC)

**Types / Interfaces / Enums**
- interface `BlockEditRejectedData`
- interface `PlayerStateData`
- interface `PlayerStateBatchEntry`
- interface `BlockEditData`
- interface `PlayerJoinData`
- interface `PlayerLeaveData`
- interface `HeldItemSelectionData`
- interface `PlayerHeldItemData`
- interface `MobDamageData`
- interface `TntIgniteData`
- interface `MobImpactData`
- interface `ArrowTrajectoryData`
- interface `ItemPickupRejectedData`
- interface `ContainerSlotData`
- interface `ContainerOpenData`
- interface `ContainerStateData`
- interface `ContainerSetSlotData`
- interface `ContainerSlotUpdateData`
- interface `ContainerCloseData`
- interface `StationSlotData`
- interface `StationOpenData`
- interface `StationStateData`
- interface `StationSetSlotData`
- interface `StationClaimResultData`
- interface `StationUpgradeData`
- interface `StationSlotUpdateData`
- interface `StationResultClaimedData`
- interface `StationRejectedData`
- interface `ContainerRejectedData`
- type `MessageType`
- type `BlockActionType`
- type `BlockEditRejectReason`
- type `ContainerRejectReason`
- type `StationRejectReason`
- type `StationSlotIndex`
- enum `ChunkResultKind`

---

## `Network/RemoteContainerManager.ts` (199 LOC)

### export class RemoteContainerManager

**Constructor**
- `constructor(private readonly client: NetClient)`

**Properties**
- `private readonly decoder`
- `private readonly stateScratch`
- `private readonly slotUpdateScratch`
- `private readonly rejectedScratch`
- `private readonly handler: (data: Uint8Array) => void`
- `private readonly onDisconnected: () => void`
- `private callbacks: RemoteContainerCallbacks = {}`
- `private pendingOpen: { key: string; resolve: (state: RemoteContainerState) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; } | null = null`

**Methods**
- `setCallbacks(callbacks: RemoteContainerCallbacks): void`
- `open(x: number, y: number, z: number): Promise<RemoteContainerState>`
- `sendSetSlot(x: number, y: number, z: number, row: number, col: number, itemId: number, stackSize: number): void`
- `sendClose(x: number, y: number, z: number): void`
- `private failPendingOpen(reason: string): void`
- `private handleBinaryMessage(data: Uint8Array): void`
- `dispose(): void`

**Module-level functions**
- `function posKey(x: number, y: number, z: number): string`

**Types / Interfaces / Enums**
- interface `RemoteContainerSlot`
- interface `RemoteContainerState`
- interface `RemoteContainerSlotUpdate`
- interface `RemoteContainerRejection`
- interface `RemoteContainerCallbacks`

---

## `Network/RemoteItemManager.ts` (222 LOC)

### export class RemoteItemManager

**Types / Interfaces / Enums**
- interface `RemoteItemInstance`

---

## `Network/RemoteMobManager.ts` (649 LOC)

### export class RemoteMobManager

**Types / Interfaces / Enums**
- interface `MutablePosition`
- interface `RemoteMobInstance`

---

## `Network/RemotePlayerRenderer.ts` (873 LOC)

### export class RemotePlayerVisual

**Constructor**
- `constructor(private readonly engine: EngineContext, private readonly scene: SceneContext, private readonly player: RemotePlayer, requestFlush?: () => void)`

**Properties**
- `readonly mesh: Mesh`
- `private readonly mat: ReturnType<typeof createRigShaderMaterial>`
- `private readonly heldItem`
- `private readonly tex: DynamicTexture2D`
- `private readonly atlas: SpriteAtlas`
- `private readonly billboard: FacingBillboardSpriteSystem`
- `private skinPromise: Promise<Texture2D> | null = null`
- `private skinArrived: ((texture: Texture2D) => void) | null = null`
- `private skinBound`
- `private alive`
- `private culled`
- `private billboardActive`
- `private lastX`
- `private lastY`
- `private lastZ`
- `private lastYaw`
- `private lastLightX`
- `private lastLightY`
- `private lastLightZ`
- `private lastLightSampleMs`
- `private walkPhase`
- `private walkAmp`
- `private smoothedSpeed`
- `private walkSampleX`
- `private walkSampleZ`
- `private walkSampleMs`
- `private sentWalkPhase`
- `private sentWalkAmp`
- `private headPitch`
- `private headPitchTarget`
- `private lastPitchByte`
- `private readonly billboardPosition: [number, number, number] = [0, 0, 0]`
- `private readonly sprintEmitter: SprintEmitterState = makeSprintEmitterState()`
- `private sprintPrevX`
- `private sprintPrevZ`
- `private sprintPrevMs`
- `private landingPrevY`
- `private landingPrevX`
- `private landingPrevZ`
- `private landingPrevMs`
- `private landingFallPeakY`
- `private lastFlushMs`
- `private needsForcedRefresh`
- `private needsBillboardSync`
- `private readonly requestFlush: () => void`
- `private readonly billboardOptions: { position: [number, number, number]; sizeWorld: [number, number]; color: [number, number, number, number]; }`
- `private static readonly VISUAL_REFRESH_MS`
- `_buildGroup?: (scene: unknown, meshes: unknown[]) => Promise<unknown>`
- `magFilter: ,`
- `minFilter: ,`
- `srgb: true,`
- `cellWidthPx: nameTag.width,`
- `cellHeightPx: nameTag.height,`
- `capacity: 1,`
- `blendMode: billboardBlendAlpha,`
- `position: this.billboardPosition,`
- `sizeWorld: [widthWorld, NAME_TAG_HEIGHT_WORLD],`
- `color: WHITE_COLOR,`
- `private readonly handleInitialSkinBound`
- `private readonly isAlive`
- `private readonly getSkinTexture`

**Methods**
- `addToScene(scene, this.mesh)`
- `applyRigSkin(engine, this.mat, this.handleInitialSkinBound, this.isAlive, this.getSkinTexture)`
- `updateDynamicTexture(engine, this.tex, nameTag.canvas, {
			invertY: false,
		})`
- `addFacingBillboardSystem(scene, this.billboard)`
- `private syncBillboardIfNeeded(x: number, y: number, z: number): void`
- `onSkinPng(png: Uint8Array): void`
- `notifyStateChanged(): void`
- `private syncLight(now: number): void`
- `private syncWalk(now: number): void`
- `private syncHeadPitch(): void`
- `private updateLandingDust(x: number, y: number, z: number, now: number): void`
- `dispose(): void`

### export class RemotePlayerRenderer

**Constructor**
- `constructor(private readonly engine: EngineContext, private readonly scene: SceneContext)`

**Properties**
- `private readonly list: RemotePlayerVisual[] = []`
- `private readonly ids: string[] = []`
- `private readonly indexById`
- `private pendingFlush`
- `private rebuildInFlight`
- `private disposed`
- `private readonly finishRenderableRebuild`

**Methods**
- `private requestSceneRenderableFlush(): void`
- `private flushSceneRenderablesIfNeeded(): void`
- `onPlayerJoin(player: RemotePlayer): void`
- `notifyPlayerStatesChanged(): void`
- `onPlayerSkin(sessionId: string, png: Uint8Array): void`
- `onPlayerLeave(sessionId: string): void`
- `update(camera: FreeCamera, _screenW: number, _screenH: number): void`
- `dispose(): void`

**Module-level functions**
- `function pngToBlobPart(png: Uint8Array): BlobPart`
- `async function decodeSkinToTexture(engine: EngineContext, png: Uint8Array): Promise<Texture2D>`
- `function clampInt(value: number, min: number, max: number): number`
- `function isHighSurrogate(codeUnit: number): boolean`
- `function isLowSurrogate(codeUnit: number): boolean`
- `function adjustCodePointBoundary(text: string, index: number): number`
- `function fitTextWithEllipsis(ctx: OffscreenCanvasRenderingContext2D, text: string, maxTextWidthPx: number): string`
- `export function rasteriseNameTag(name: string, scale = 0.575)`

**Types / Interfaces / Enums**
- type `DynamicTexture2D`
- type `FacingBillboardSpriteSystem`
- type `SpriteAtlas`
- type `SprintEmitterState`

---

## `Network/RemoteStationManager.ts` (258 LOC)

### export class RemoteStationManager

**Constructor**
- `constructor(private readonly client: NetClient)`

**Properties**
- `private readonly decoder`
- `private readonly stateScratch: RemoteStationState = { x: 0, y: 0, z: 0, version: 0, kind: 0, capTier: 0, input: { itemId: 0, stackSize: 0 }, fuel: { itemId: 0, stackSize: 0 }, output: { itemId: 0, stackSize: 0 }, smeltProgress: 0, burnRemaining: 0, lit: false, }`
- `private readonly slotUpdateScratch: RemoteStationSlotUpdate = { x: 0, y: 0, z: 0, version: 0, slot: -1, itemId: 0, stackSize: 0, smeltProgress: 0, burnRemaining: 0, lit: false, }`
- `private readonly rejectedScratch`
- `private readonly claimedScratch`
- `private readonly handler: (data: Uint8Array) => void`
- `private readonly onDisconnected: () => void`
- `private callbacks: RemoteStationCallbacks = {}`
- `private pendingOpen: { key: string; resolve: (state: RemoteStationState) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; } | null = null`
- `private readonly latestVersion`

**Methods**
- `setCallbacks(callbacks: RemoteStationCallbacks): void`
- `open(x: number, y: number, z: number): Promise<RemoteStationState>`
- `sendSetSlot(x: number, y: number, z: number, slot: number, itemId: number, stackSize: number): void`
- `sendUpgrade(x: number, y: number, z: number, capTier: number): void`
- `sendClaimResult(x: number, y: number, z: number): void`
- `private failPendingOpen(reason: string): void`
- `private handleBinaryMessage(data: Uint8Array): void`
- `dispose(): void`

**Module-level functions**
- `function posKey(x: number, y: number, z: number): string`

**Types / Interfaces / Enums**
- interface `RemoteStationStack`
- interface `RemoteStationState`
- interface `RemoteStationSlotUpdate`
- interface `RemoteStationRejection`
- interface `RemoteStationResultClaimed`
- interface `RemoteStationCallbacks`

---

## `Network/serverList.ts` (36 LOC)

**Module-level functions**
- `export function getPlayerName(): string`
- `export function setPlayerName(name: string): void`
- `export function getSavedServers(): SavedServer[]`
- `export function saveServer(server: SavedServer): void`
- `export function removeServer(url: string): void`
- `export function findSavedServerByName(name: string): SavedServer | undefined`

**Types / Interfaces / Enums**
- interface `SavedServer`

---

## `Network/serverStatus.ts` (93 LOC)

**Module-level functions**
- `async export function fetchServerStatus(serverUrl: string, timeoutMs = 3000): Promise<ServerStatus>`
- `async export function fetchAllStatuses(servers: ReadonlyArray<{ url: string }>): Promise<ServerStatus[]>`

---

## `Player/Controls/CustomBoatControls.ts` (196 LOC)

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
- `public static KEY_CROUCH`
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

## `Player/Controls/DebugControlHelper.ts` (30 LOC)

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

## `Player/Controls/JetSkiControls.ts` (199 LOC)

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

## `Player/Controls/PaddleBoatControls.ts` (208 LOC)

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

## `Player/Controls/WalkingControls.ts` (539 LOC)

### export class WalkingControls implements IControls<PlayerVehicleMotor>

**Constructor**
- `constructor(player: Player)`

**Properties**
- `readonly controlType`
- `public pressedKeys`
- `static readonly DOUBLE_TAP_MS`
- `static readonly PUNCH_REPEAT_MS`
- `public static KEY_LEFT`
- `public static KEY_RIGHT`
- `public static KEY_UP`
- `public static KEY_DOWN`
- `public static KEY_USE`
- `public static KEY_PICK_BLOCK`
- `public static KEY_CHAT`
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
- `reach: getMeleeRange(this.selectedItem?.getToolLookupId()),`
- `bestT`
- `bestMob`
- `kind: ,`
- `mob: bestMob,`
- `distance: bestT * ray.reach,`
- `x: ray.startX + (endX - ray.startX) * bestT,`
- `y: ray.startY + (endY - ray.startY) * bestT,`
- `z: ray.startZ + (endZ - ray.startZ) * bestT,`
- `kind: ,`
- `id: hit.id,`
- `distance: Math.sqrt( (hit.x - ray.startX) ** 2 + (hit.y - ray.startY) ** 2 + (hit.z - ray.startZ) ** 2, ),`
- `x: hit.x,`
- `y: hit.y,`
- `z: hit.z,`
- `target`
- `target`

**Accessors**
- `get selectedItem(): Item | null`
- `public get controlledEntity(): PlayerVehicleMotor`
- `public get inputDirection(): Vec3`

**Methods**
- `public handleKeyEvent(key: string, isKeyDown: boolean)`
- `swingHeldItemView()`
- `public handleMouseEvent(mouseEvent: MouseEvent, isKeyDown: boolean): void`
- `useBow(this.#player, this.#drawProgress)`
- `playMobDamage(target.x, target.y, target.z, damage)`
- `public update(hit?: BlockRaycastHit | null): void`
- `public cancelDraw(): void`
- `public stopBlockBreaking(): void`
- `public setOnBlockBroken(callback: (x: number, y: number, z: number, blockId: number) => void): void`
- `public onKeyDown(key: string)`
- `public onKeyUp(key: string)`

**Types / Interfaces / Enums**
- type `MeleeRay`
- type `LocalMeleeHit`
- type `RemoteMeleeHit`
- type `MeleeHit`

---

## `Player/Crafting/CraftingManager.ts` (263 LOC)

**Module-level functions**
- `export function isHandRecipe(recipe: Recipe): boolean`

**Types / Interfaces / Enums**
- interface `Ingredient`
- interface `Recipe`
- interface `MasonRecipe`

---

## `Player/Crafting/CraftMenu/CraftMenu.ts` (529 LOC)

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

**Module-level functions**
- `function ensureTextureCache(): Map<number, CachedTextureInfo>`
- `function resolveIconSource(itemId: number): string | null`
- `function resolveDisplayName(itemId: number): string`
- `function isFiniteItemId(value: string): number | null`
- `function ensureRecipeSearchIndex(): RecipeSearchIndexEntry[]`
- `export function findNearbyStation(player: Player, kind: string, radius = 5): StationKind | null`

**Types / Interfaces / Enums**
- type `TextureDefinition`
- type `CachedTextureInfo`
- type `RecipeSearchIndexEntry`
- type `ScoredRecipe`

---

## `Player/Crafting/ShapeVariantGenerator.ts` (113 LOC)

**Module-level functions**
- `function toDisplayName(value: string): string`
- `async export function generateShapeVariants(): Promise<void>`

**Types / Interfaces / Enums**
- type `TextureDefinition`

---

## `Player/Hud/ArmorPanel.ts` (67 LOC)

### export class ArmorPanel

**Constructor**
- `constructor()`

**Properties**
- `readonly container: HTMLDivElement`

**Methods**
- `public adoptSlots(slots: readonly ItemSlot[]): void`
- `dispose(): void`

---

## `Player/Hud/BlockHighlight/BlockBreakingVisuals.ts` (294 LOC)

**Module-level functions**
- `function buildBoxesGeometry(boxes: readonly BoxLike[], inflation: number): BoxesGeometry`
- `function writeVertex(x: number, y: number, z: number, nx: number, ny: number, nz: number): void`
- `function writeFace(nx: number, ny: number, nz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, x3: number, y3: number, z3: number): void`
- `export function initializeBlockBreakingVisuals(targetScene: SceneContext): void`
- `function ensureCrackGeometry(blockId: number, blockState: number): void`
- `export function updateBlockBreakingVisuals(progress: number, targetBlock: BlockRaycastHit): void`
- `function asBoatBlockContext(context: unknown): BoatBlockContext | null`
- `export function resetBlockBreakingVisuals(): void`
- `export function updateCrackingState(block: { x: number; y: number; z: number } | null, progress: number, blockId?: number, blockState?: number, dynamicContext?: unknown): void`

**Types / Interfaces / Enums**
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`
- type `BoxLike`
- type `BoxesGeometry`
- type `BoatBlockContext`

---

## `Player/Hud/BlockHighlight/BlockHighlight.ts` (289 LOC)

### export class BlockHighlight

**Constructor**
- `constructor()`

**Properties**
- `blockId`
- `blockState`
- `kind: ,`
- `localX: value.localX,`
- `localY: value.localY,`
- `localZ: value.localZ,`
- `name: ,`
- `vertexSource: highlightVertexWGSL,`
- `fragmentSource: highlightFragmentWGSL,`
- `attributes: [ ],`
- `uniforms: [ , { name: , type: }],`
- `needAlphaBlending: true,`
- `depthWrite: false,`
- `backFaceCulling: false,`

**Methods**
- `onBeforeRender(this.#scene, this.#beforeRender)`
- `dispose(): void`
- `setHit(hit: BlockRaycastHit | null): void`
- `resizeMeshGeometry(Map1.engine, this.#mesh, geo.positions, geo.normals, geo.indices)`
- `addToScene(this.#scene, mesh)`
- `setShaderUniform(mat, [
			SETTING_PARAMS.HIGHLIGHT_COLOR[0],
			SETTING_PARAMS.HIGHLIGHT_COLOR[1],
			SETTING_PARAMS.HIGHLIGHT_COLOR[2],
			SETTING_PARAMS.HIGHLIGHT_ALPHA,
		])`

**Module-level functions**
- `function buildBoxesGeometry(boxes: readonly BoxLike[], inflation: number): BoxesGeometry`
- `function writeVertex(x: number, y: number, z: number, nx: number, ny: number, nz: number): void`
- `function writeFace(nx: number, ny: number, nz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, x3: number, y3: number, z3: number): void`

**Types / Interfaces / Enums**
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`
- type `BoxLike`
- type `BoxesGeometry`

---

## `Player/Hud/BlockHighlight/BlockRaycaster.ts` (1018 LOC)

**Module-level functions**
- `function fenceNeighborIdLookup(wx: number, wy: number, wz: number): number`
- `function copyBlockRaycastHit(from: BlockRaycastHit, to: BlockRaycastHit): BlockRaycastHit`
- `function copyBoatContext(from: typeof _sharedBoatContext, to: typeof _sharedBestBoatContext): void`
- `function getForwardRay(player: Player, length: number): RayLike`
- `function isTargetableBlock(blockId: number): boolean`
- `function isFullBlockShape(blockId: number, blockState: number): boolean`
- `function intersectRayAabb(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, tMin: number, tMax: number, fallbackNx: number, fallbackNy: number, fallbackNz: number): FaceHit | null`
- `function raycastShapeInVoxel(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, vx: number, vy: number, vz: number, blockId: number, blockState: number, tEnter: number, tExit: number, fallbackNx: number, fallbackNy: number, fallbackNz: number): FaceHit | null`
- `export function pickDroppedItem(player: Player): DroppedItem | null`
- `export function pickWaterTarget(player: Player): BlockRaycastHit | null`
- `export function pickBlock(player: Player): number | null`
- `export function getPlacementPosition(player: Player): Vec3 | null`
- `export function getPlacementHit(player: Player): PlacementHit | null`

**Types / Interfaces / Enums**
- type `ShapeBounds`
- type `BlockRaycastHit`
- type `FaceHit`
- type `RayLike`
- type `PlacementHit`

---

## `Player/Hud/BlockHighlight/BreakingBlockHandler.ts` (514 LOC)

### export class BlockBreakingHandler

**Constructor**
- `constructor(player: Player)`

**Properties**
- `hit: BlockRaycastHit,`
- `boatContext: BoatBlockHitContext | null,`
- `hit: BlockRaycastHit,`
- `boatContext: BoatBlockHitContext | null,`
- `x: number,`
- `y: number,`
- `z: number,`
- `progress: number,`
- `blockId: number,`
- `blockState: number,`
- `dynamicContext: unknown,`
- `hit: BlockRaycastHit,`
- `x: number,`
- `y: number,`
- `z: number,`
- `blockId: number,`
- `x: number,`
- `y: number,`
- `z: number,`
- `blockId: number,`
- `packedLight: number,`
- `boatContext: BoatBlockHitContext | null,`
- `worldItem`
- `worldItem`

**Accessors**
- `public get isActive(): boolean`

**Methods**
- `setOnBlockBroken(callback: (x: number, y: number, z: number, blockId: number) => void): void`
- `public start(): void`
- `public stop(): void`
- `public reset(): void`
- `public update(hit?: BlockRaycastHit | null): void`
- `updateCrackingState(crackBlock, progress, blockId, blockState, dynamicContext)`
- `setVec3(miningPos, x + 0.5 + hit.nx * 0.5, y + 0.5 + hit.ny * 0.5, z + 0.5 + hit.nz * 0.5)`
- `playMining(miningPos.x, miningPos.y, miningPos.z, hit.nx, hit.ny, hit.nz, blockId)`
- `playMineHit(blockId)`
- `getToolKind(item.itemId)`
- `dropWorldItem(item, x + 0.5, y + 0.5, z + 0.5, v.x, v.y, v.z, this.#player)`
- `setVec3(particlePos, x + 0.5, y + 0.5, z + 0.5)`
- `play(particlePos, blockId, packedLight)`
- `playDebris(particlePos.x, particlePos.y, particlePos.z, blockId, packedLight)`
- `playBlockBreak(blockId)`
- `deleteBlock(x, y, z)`
- `notifyStationBlockBroken(x, y, z)`
- `saveBlockInventory(x, y, z, emptyInv)`

**Module-level functions**
- `export function getOnBlockBroken(): | ((x: number, y: number, z: number, blockId: number) => void)
	| undefined`
- `export function getOnExplosion(): | ((x: number, y: number, z: number, radius: number) => void)
	| undefined`
- `export function getOnTntIgnite(): | ((x: number, y: number, z: number, fuse: number, radius: number) => void)
	| undefined`
- `function getDroppedBlockId(blockId: number, toolLookupId: number): number`
- `function stirVariation(seed: number): void`
- `export function computeDeterministicDropVelocity(seed: number, baseY: number)`
- `function isBoatBlockContext(context: unknown): context is BoatBlockHitContext`

**Types / Interfaces / Enums**
- type `BoatBlockHitContext`
- type `CrackBlockPosition`

---

## `Player/Hud/Chat.ts` (360 LOC)

### export class Chat

**Constructor**
- `constructor(player: Player)`

**Properties**
- `default`

**Accessors**
- `get isOpen(): boolean`

**Methods**
- `runLocateCommand(args, {
			originX: Math.floor(pos.x),
			originZ: Math.floor(pos.z),
			seed: currentWorldSeed(),
			
			
			onTeleport: (x, z) => {
				pos.x = x;
				pos.z = z;
			},
			reply: (text) => this.#addSystem(text),
		})`
- `setTimeout(() => {
			el.classList.add(                    );
			setTimeout(() => {
				if (el.parentNode) el.parentNode.removeChild(el);
			}, 1000);
		}, delay)`
- `open(): void`
- `close(): void`
- `toggle(): void`
- `addSystemMessage(text: string): void`

**Module-level functions**
- `function gamemodeName(gm: Gamemodes): string`

**Types / Interfaces / Enums**
- interface `ChatMessage`

---

## `Player/Hud/Crosshair/Crosshair.ts` (159 LOC)

### export class Crosshair

**Constructor**
- `constructor(options?: Partial<CrosshairVisualOptions>)`

**Properties**
- `mesh: info.pickedMesh,`
- `thinInstanceIndex: info.thinInstanceIndex ?? -1,`
- `player: Player,`
- `maxDistance: number,`
- `predicate?: (mesh: Mesh) => boolean,`

**Methods**
- `public setTargetHit(hit: BlockRaycastHit | null): void`
- `setCrosshair(id: string): void`
- `getCrosshairId(): string`
- `setCrosshairSize(sizePx: number): void`
- `setCrosshairColor(hex: string): void`
- `setCrosshairVisible(visible: boolean): void`
- `setHitmarkerEnabled(enabled: boolean): void`
- `applyCrosshairOptions(options: Partial<CrosshairVisualOptions>): void`
- `showHitMarker(): void`
- `static pickTargetInto(player: Player, target: Vec3): boolean`
- `static pickWaterPlacementTargetInto(player: Player, target: Vec3): boolean`
- `static pickBlock(player: Player): number | null`
- `static pickTarget(player: Player): Vec3 | null`
- `static getPlacementPosition(player: Player): Vec3 | null`
- `static getPlacementHit(player: Player): PlacementHit | null`
- `static pickUsableMesh(player: Player, maxDistance = REACH_DISTANCE): Mesh | null`
- `static pickMobTarget(player: Player, maxDistance = REACH_DISTANCE)`

**Types / Interfaces / Enums**
- type `PlacementHit`
- type `LiteForwardRayCamera`
- type `LiteRayPickScene`

---

## `Player/Hud/Crosshair/CrosshairOptions.ts` (437 LOC)

**Module-level functions**
- `export function normalizeCrosshairId(value: unknown): string`
- `export function allCrosshairIds(): string[]`
- `export function crosshairTexturePath(id: string): string`
- `export function normalizeCrosshairSize(value: unknown): number`
- `export function normalizeCrosshairColor(value: unknown): string`
- `export function filterForCrosshairColor(hex: string): string`
- `export function ensureCrosshairOptionStyles(): void`
- `export function createCrosshairPreview(initial: {
	id: string;
	size: number;
	color: string;
	visible: boolean;
}): CrosshairPreview`

**Types / Interfaces / Enums**
- interface `CrosshairVisualOptions`
- interface `CrosshairColorPreset`
- interface `CrosshairGrid`
- interface `CrosshairPreview`
- interface `CrosshairSwatches`

---

## `Player/Hud/Crosshair/CrosshairUI.ts` (105 LOC)

### export class CrosshairUI

**Constructor**
- `constructor(options?: Partial<CrosshairVisualOptions>)`

**Methods**
- `crosshairTexturePath(this.#crosshairId)`
- `setCrosshair(id: string): void`
- `getCrosshairId(): string`
- `setSize(sizePx: number): void`
- `setColor(hex: string): void`
- `setVisible(visible: boolean): void`
- `setHitmarkerEnabled(enabled: boolean): void`
- `isHitmarkerEnabled(): boolean`
- `applyVisualOptions(options: Partial<CrosshairVisualOptions>): void`
- `showHitMarker(): void`

**Types / Interfaces / Enums**
- type `CrosshairVisualOptions`

---

## `Player/Hud/DebugPanel.ts` (80 LOC)

### export class DebugPanel

**Constructor**
- `constructor()`

**Properties**
- `private static instance: DebugPanel | undefined`
- `private static div: HTMLDivElement | undefined`
- `private static readonly elements`
- `container: HTMLDivElement`
- `valueNode: Text`
- `value: string`

**Methods**
- `public static getInstance(): DebugPanel`
- `public static show(): void`
- `public static hide(): void`
- `public static updateInfo(key: string, value: string | number): void`
- `public static removeInfo(key: string): void`
- `public static clear(): void`
- `private static getDiv(): HTMLDivElement`

---

## `Player/Hud/PauseMenu.ts` (618 LOC)

### export class PauseMenu

**Constructor**
- `constructor(onResume: () => void, player: Player)`

**Properties**
- `private static nextSliderId`
- `private readonly menuContainer: HTMLDivElement`
- `private readonly mainButtonsContainer: HTMLDivElement`
- `private readonly settingsContainer: HTMLDivElement`
- `private readonly onResume: () => void`
- `private readonly player: Player`
- `private onLeaveServer: (() => void) | null = null`
- `private savePromise: Promise<void> | null = null`
- `private saveResetTimer: ReturnType<typeof setTimeout> | null = null`
- `private chunkUpdateFrame: number | null = null`
- `private disposed`
- `private readonly handleResume`
- `private readonly handleShowSettings`
- `private readonly handleSave`
- `private readonly handleMainMenu`
- `key: K,`
- `value: GameSettings[K],`

**Methods**
- `public setLeaveServerCallback(callback: () => void): void`
- `public show(isMultiplayer = false): void`
- `public hide(): void`
- `public dispose(): void`
- `private createMainButtons(): HTMLDivElement`
- `private saveAll(): Promise<void>`
- `private async saveWithFeedback(): Promise<void>`
- `saveGameSettings(settings)`
- `private createSettingsPanel(): HTMLDivElement`
- `private createCrosshairSection(): HTMLElement`
- `private scheduleChunkUpdate(): void`
- `private createSlider(container: HTMLElement, options: SliderOptions): HTMLInputElement`
- `private createToggle(container: HTMLElement, options: ToggleOptions): HTMLInputElement`
- `private createSeparator(text: string): HTMLDivElement`
- `private showSettings(show: boolean): void`

**Types / Interfaces / Enums**
- interface `SliderOptions`
- interface `ToggleOptions`
- type `GameSettings`
- type `NumericSettingKey`

---

## `Player/Hud/PlayerHud.ts` (1551 LOC)

**Module-level functions**
- `function statPct(value: number, max: number): number`
- `function setBar(fill: HTMLDivElement, prev: number, pct: number): number`

**Types / Interfaces / Enums**
- type `SavedBlockInventory`

---

## `Player/Hud/PlayerPreview.ts` (328 LOC)

### export class PlayerPreview

**Properties**
- `readonly container: HTMLDivElement`
- `canvas: HTMLCanvasElement`
- `getLightLevel?: () => number`

**Types / Interfaces / Enums**
- type `EngineContext`
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`

---

## `Player/Inventory/Armor.ts` (15 LOC)

**Module-level functions**
- `export function mitigationForArmorValue(armorValue: number): number`
- `export function effectiveArmorValue(armorValue: number, spent: boolean, depletedMultiplier: number): number`

---

## `Player/Inventory/CreativePalette.ts` (149 LOC)

### export class CreativePalette

**Constructor**
- `constructor(inventory: PlayerInventory)`

**Properties**
- `readonly container: HTMLDivElement`
- `rowDiv`
- `itemId: definition.id,`
- `maxStack: definition.maxStack ?? 64,`
- `item: null,`

**Methods**
- `async build(): Promise<void>`
- `public dispose(): void`

**Types / Interfaces / Enums**
- interface `PaletteEntry`

---

## `Player/Inventory/CubeIcon.ts` (602 LOC)

**Module-level functions**
- `export function setNormalMapEnabled(enabled: boolean): void`
- `export function isNormalMapEnabled(): boolean`
- `function _resizeLitCacheFromDiffuseAtlas(): void`
- `function _ensureOutBuffer(): void`
- `function _notifyAtlasesReady(): void`
- `function _onDiffuseLoad(): void`
- `function _onNormalLoad(): void`
- `function _ensureAtlases(): void`
- `function _getTileCacheKey(srcX: number, srcY: number): number`
- `function _mulClamp255(value: number, brightness: number): number`
- `function _buildLitTile(srcX: number, srcY: number): HTMLCanvasElement | null`
- `function getShadeFill(shade: number): string`
- `function _getShadedTile(srcX: number, srcY: number, shade: number): HTMLCanvasElement | null`
- `export function drawCubeIcon(ctx: CanvasRenderingContext2D, blockId: number | null, options?: CubeIconOptions): void`
- `function _projectHexagon(box: ShapeBox, R: number, ry: number, H: number, bboxMaxY: number, offX: number, offY: number): number[]`
- `function _pointInHexagon(px: number, py: number, pts: number[]): boolean`
- `function _drawFlatSprite(ctx: CanvasRenderingContext2D, blockId: number, size: number): void`
- `function _drawQuad(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, srcX: number, srcY: number, shade: number): void`

**Types / Interfaces / Enums**
- type `ShapeBox`
- type `IconQuad`

---

## `Player/Inventory/DroppedItem.ts` (923 LOC)

### export class DroppedItem implements IUsable

**Constructor**
- `constructor(item: Item, x: number, y: number, z: number)`

**Properties**
- `private _boxMesh: Mesh`
- `private _material: ShaderMaterial`
- `private _materialEpoch`
- `private _item: Item`
- `private _isSprite`
- `private _velocity`
- `private _position: Vec3`
- `private _halfSize`
- `private _voxelCollider: VoxelAabbCollider`
- `private _disposed`
- `private _itemIndex`
- `private _lastLightX`
- `private _lastLightY`
- `private _lastLightZ`
- `private _tint: [number, number, number] = [1, 1, 1]`
- `private _oldPositionX`
- `private _oldPositionY`
- `private _oldPositionZ`
- `_grounded`
- `private _sleeping`
- `private _remotePendingPickup: { player: Player; itemId: number; granted: number; } | null = null`
- `private static readonly _allItems: DroppedItem[] = []`
- `private static _observerRegistered`
- `static readonly GRAVITY`
- `static readonly STEP_SIZE`
- `static readonly EPSILON`
- `static readonly SPRITE_BOB_AMPLITUDE`
- `static readonly SPRITE_BOB_SPEED`
- `static readonly AIR_DAMPING_PER_SEC`
- `static readonly GROUND_DAMPING_PER_SEC`
- `static readonly MIN_SPEED`
- `static readonly SKY_LIGHT_COLOR`
- `static readonly BLOCK_LIGHT_COLOR`
- `private static _atlasPromise: Promise<Texture2D | null> | null = null`
- `scene: Map1.mainScene,`
- `name: ITEM_NAME_AABB,`
- `position: this._position,`
- `renderOrder: 1,`
- `private _sceneAdded`
- `use`

**Accessors**
- `get isRemote(): boolean`
- `get boxMesh(): Mesh`
- `get position(): Vec3`
- `get item(): Item`
- `static get activeItems(): ReadonlyArray<DroppedItem>`
- `get halfExtent(): number`

**Methods**
- `private static _ensureObserver(): void`
- `static sizeFor(stackSize: number): number`
- `private static _getAtlasTexture(): Promise<Texture2D | null>`
- `static preloadAtlas(): void`
- `vec3(this._halfSize, this._halfSize, this._halfSize)`
- `setShaderUniform(this._material, 1)`
- `setShaderUniform(this._material, [0, 0])`
- `setShaderTexture(this._material, sharedAtlas)`
- `setShaderTexture(this._material, atlas)`
- `private _ensureAddedToScene(): void`
- `private _faceCamera(): void`
- `private _applyBob(dt: number): void`
- `addVelocity(x: number, y: number, z: number): void`
- `private _resize(): void`
- `private _dispose(): void`
- `private _updatePhysics(dt: number): void`
- `private _moveAxis(axis: ColliderAxis, delta: number): void`
- `private _syncTransformAndLightingIfMoved(): void`
- `private _updateLightingIfNeeded(): void`
- `public setInitialLight(packedLight: number): void`
- `public setRemote(instanceId: number, onPickup: (instanceId: number) => void): void`
- `public rollbackRemotePickup(instanceId: number): void`
- `public setRemotePosition(x: number, y: number, z: number): void`
- `public dispose(): void`
- `private _applyTintFromPackedLight(packedLight: number): void`
- `private _applyAtlasTile(item: Item): void`
- `static disposeAll(): void`
- `static nearestTo(player: Player): DroppedItem | null`

**Module-level functions**
- `function createDroppedItemMaterial(): ShaderMaterial`
- `function disposeItemMaterial(mat: ShaderMaterial): void`
- `export function acquireDroppedItemMaterial(blockId: number): ShaderMaterial`
- `export function releaseDroppedItemMaterial(blockId: number, mat: ShaderMaterial): void`
- `function disposeAllPooledItemMaterials(): void`
- `export function getBillboardQuadGeometry()`

**Types / Interfaces / Enums**
- type `LiteMetadata`
- type `Mesh`
- type `Texture2D`
- type `Vec3`

---

## `Player/Inventory/dropWorldItem.ts` (22 LOC)

**Module-level functions**
- `export function dropWorldItem(item: Item, x: number, y: number, z: number, vx: number, vy: number, vz: number, player?: Player): DroppedItem | null`

---

## `Player/Inventory/Durability.ts` (29 LOC)

**Module-level functions**
- `export function isDepleted(durability: number, maxDurability: number): boolean`
- `export function toolLookupId(itemId: number, durability: number, maxDurability: number): number`
- `export function canStackTogether(a: { itemId: number; durability: number }, b: { itemId: number; durability: number }): boolean`
- `export function repairAmount(current: number, max: number, amount: number): number`

---

## `Player/Inventory/Equipment.ts` (140 LOC)

**Module-level functions**
- `export function isEquipment(item: Item): boolean`

**Types / Interfaces / Enums**
- type `EquipmentGroup`

---

## `Player/Inventory/EquipmentLayout.ts` (53 LOC)

**Module-level functions**
- `export function groupForSlotId(id: string): EquipmentGroup`
- `export function labelForSlotId(id: string): string`
- `export function getEquipmentSlotIds(): string[]`
- `export function getArmorColumnPairs()`

**Types / Interfaces / Enums**
- type `EquipmentGroup`
- type `ArmorSlotId`

---

## `Player/Inventory/HeldItemView.ts` (576 LOC)

### export class HeldItemView

**Properties**
- `private _entries`
- `private _activeLightX`
- `private _activeLightY`
- `private _activeLightZ`
- `private _lastSunDirY`
- `punch`

**Methods**
- `setYawOuter(_qCam, camYaw, camPitch)`
- `setYawOuter(_qPunch, punch * PUNCH_TWIST, -punch * PUNCH_TILT)`
- `mulQuat(_qCam, _qPunch, _qMix)`
- `mulQuat(_qMix, base, _qMix)`
- `mulQuat(_qCam, base, _qMix)`

**Module-level functions**
- `function createHeldItemMaterial(name: string): ShaderMaterial`
- `function disposeItemMaterial(mat: ShaderMaterial): void`
- `function getWhiteFallback(engine: EngineContext): Texture2D`
- `function getFlatNormalFallback(engine: EngineContext): Texture2D`
- `function entryKey(useSprite: boolean, icon: string, blockId: number, blockState: number): EntryKey`
- `export function updateHeldItemView(player: Player, dt: number): void`
- `export function swingHeldItemView(): void`

**Types / Interfaces / Enums**
- type `EngineContext`
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`
- type `Texture2D`
- type `EntryKey`
- type `Entry`

---

## `Player/Inventory/Item.ts` (473 LOC)

### export class Item implements IUsable

**Properties**
- `name: string`
- `description: string`
- `icon: string`
- `material: ShaderMaterial | undefined`
- `itemId`
- `blockId: number | null = null`
- `blockState`
- `row: number`
- `col: number`

**Types / Interfaces / Enums**
- interface `BoatCtx`

---

## `Player/Inventory/ItemRegistry.ts` (171 LOC)

**Module-level functions**
- `function getBlockState(def: ItemDefinition): number`
- `function setBlockIndex(blockId: number, blockState: number, def: ItemDefinition): void`
- `function deleteBlockIndex(blockId: number, blockState: number): void`
- `export function registerItemToDisplayName(rawName: string): string`
- `function initDefaults(): void`
- `async export function ensureItemRegistryLoaded(url = DEFAULT_ITEMS_URL): Promise<void>`
- `async function loadRegisteredItemFromUrl(url: string): Promise<void>`
- `export function registerItem(def: ItemDefinition): void`
- `export function getRegisteredItemById(id: number): ItemDefinition | undefined`
- `export function getItemByBlock(blockId: number, blockState = 0): ItemDefinition | undefined`
- `export function getAllRegisteredItems(): ItemDefinition[]`
- `function compareItemIds(a: ItemDefinition, b: ItemDefinition): number`
- `function isValidDefinition(value: unknown): value is ItemDefinition`

---

## `Player/Inventory/ItemSlot.ts` (187 LOC)

### export class ItemSlot implements EventListenerObject

**Constructor**
- `constructor(row: number, col: number)`

**Properties**
- `onDraggedOut?: (slot: ItemSlot) => void`
- `isEquipmentSlot`
- `acceptsItem: ((item: Item) => boolean) | null = null`
- `equipmentSlotId: string | null = null`

**Accessors**
- `public get divItemSlot(): HTMLDivElement`
- `public get destroysDroppedItems(): boolean`
- `public set destroysDroppedItems(value: boolean)`
- `public set divItemSlot(div: HTMLDivElement)`
- `public set item(item: Item | null)`
- `public get item(): Item | null`

**Methods**
- `public canAccept(item: Item | null): boolean`
- `public swapSlots(slot: ItemSlot): void`
- `public clearItemSlots(): void`
- `public initialize(): void`
- `public dispose(): void`
- `public handleEvent(event: Event): void`

---

## `Player/Inventory/ItemUseActions.ts` (327 LOC)

**Module-level functions**
- `function useTool(player: Player): void`
- `function openCrafting(player: Player): void`
- `export function useBow(player: Player, drawProgress: number = 1.0): void`
- `function useSpawnEgg(player: Player): void`
- `function useFood(player: Player): void`

**Types / Interfaces / Enums**
- type `ItemUseAction`

---

## `Player/Inventory/Materials/MaterialTier.ts` (33 LOC)

**Module-level functions**
- `export function clampMaterialTier(value: unknown): MaterialTier | undefined`
- `export function materialTierName(tier: MaterialTier): string`

---

## `Player/Inventory/PlayerInventory.ts` (441 LOC)

### export class PlayerInventory

---

## `Player/Inventory/ProceduralTools.ts` (231 LOC)

**Module-level functions**
- `function indexMaterials(rows: readonly ToolMaterial[]): void`
- `export function getToolMiningLevel(toolItemId?: number): number`
- `export function getToolMaterialTier(toolItemId?: number): MaterialTier | undefined`
- `export function getToolMaxDurability(toolItemId?: number): number`
- `export function getDurabilityTooltip(item: {
	durability: number;
	maxDurability: number;
}): string | null`
- `export function parseToolKind(value: unknown): ToolKindId | undefined`

**Types / Interfaces / Enums**
- interface `ToolMaterial`
- interface `ToolKind`
- interface `ToolFacts`
- enum `ToolKindId`

---

## `Player/Inventory/SmithTools.ts` (94 LOC)

**Module-level functions**
- `function register(def: SmithToolDef): void`
- `export function smithToolForBlock(blockId: number): SmithToolDef | undefined`
- `export function smithToolForItem(itemId: number): SmithToolDef | undefined`
- `export function isSmithToolBlock(blockId: number): boolean`
- `export function smithToolBlocksForKind(kind: SmithToolKind): readonly number[]`
- `export function wearFromBlockState(blockState: number): number`
- `export function isBlockStateSpent(blockState: number): boolean`
- `export function freshBlockState(): number`
- `export function advanceBlockState(blockState: number): number`
- `export function wearFraction(blockState: number): number`
- `export function durabilityFromWear(blockState: number, maxDurability: number): number`

**Types / Interfaces / Enums**
- interface `SmithToolDef`
- type `SmithToolKind`

---

## `Player/Inventory/Types/InventoryTypes.ts` (48 LOC)

**Types / Interfaces / Enums**
- interface `CubeIconOptions`
- type `ItemDefinition`
- type `SavedInventoryItem`
- type `SavedInventoryState`
- type `ArmorSlot`
- type `ArmorSlotId`
- type `SavedEquipmentState`

---

## `Player/LocateCommand.ts` (90 LOC)

**Module-level functions**
- `export function currentWorldSeed(serverSeed: string | null = null): string`
- `export function runLocateCommand(args: string[], deps: LocateCommandDeps): void`

**Types / Interfaces / Enums**
- type `LocateCommandDeps`

---

## `Player/Player.ts` (477 LOC)

### export class Player

**Constructor**
- `constructor(private engine: EngineContext, private scene: SceneContext, playerCam: PlayerCamera, private canvas: HTMLCanvasElement)`

**Properties**
- `static readonly USE_REPEAT_INTERVAL_MS`
- `networkManager?: import( ).NetworkManager`
- `keyboardControls: IControls<unknown>`
- `camera: playerCam,`
- `controls: new PlayerBodyControlState(),`
- `playerStats: this.#stats,`

**Methods**
- `public createHud(scene: SceneContext): void`
- `addToScene(scene, body)`
- `applyRigSkin(this.engine, mat, () => {
			this.#bodySkinBound = true;
		})`
- `public respawn(): void`
- `public tick(deltaMs: number): void`
- `public triggerPunch(): void`
- `igniteTnt(x, y, z)`

---

## `Player/PlayerBody.ts` (44 LOC)

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

## `Player/PlayerCamera.ts` (165 LOC)

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

## `Player/PlayerLoadingGate.ts` (123 LOC)

---

## `Player/PlayerLoopController.ts` (1009 LOC)

### export class PlayerLoopController

**Constructor**
- `constructor(scene: SceneContext, private readonly playerVehicle: {
			isSprinting: boolean;
			isClimbing: boolean;
			isFlying: boolean;
			isMounted: boolean;
			isGrounded: boolean;
			onAudibleStep: (() => void) | null;
			velocity: Vec3;
			inputDirection: Vec3;
			update(dt: number): void;
			updateCameraAndVisuals(deltaMs?: number): void;
		}, private readonly playerStats: PlayerStats, private readonly playerHud: PlayerHud, private readonly playerCamera: PlayerCamera, private readonly getKeyboardControls: () => IControls<unknown>, private readonly getPlayerPosition: () => Vec3)`

**Properties**
- `static readonly PICK_STILL_REFRESH_FRAMES`
- `static readonly DEBUG_HUD_INTERVAL_MS`
- `static readonly SPIKE_FRAME_MS`
- `static readonly SLOW_FRAME_SAMPLE_MS`
- `private readonly scene: SceneContext`
- `isFarVisible: () => FarTileManager.isFarTilesVisible(),`
- `setFarVisible: (visible: boolean) => { FarTileManager.setFarTilesVisible(visible); },`
- `isChunksVisible: () => areChunkMeshesVisible(),`
- `setChunksVisible: (visible: boolean) => { setChunkMeshesVisible(visible); },`

**Methods**
- `public bind(): void`
- `resetPackedUploadStats()`
- `public tick(deltaMs: number): void`
- `queueMicrotask(() => {
			if (this.#pendingGpuLagMs > 0) {
				frameProfiler.noteSectionValue(        , this.#pendingGpuLagMs);
				this.#pendingGpuLagMs = 0;
			}

			frameProfiler.endFrame(deltaMs, performance.now() - frameStart);
		})`
- `public dispose(): void`
- `pickTargetGated(playerPos: {
		x: number;
		y: number;
		z: number;
	}): BlockRaycastHit | null`
- `updateControls(uiOpen: boolean, hit?: BlockRaycastHit | null): void`
- `updateSprintParticles(uiOpen: boolean, playerPos: { x: number; y: number; z: number }): void`

**Types / Interfaces / Enums**
- type `BlockRaycastHit`

---

## `Player/PlayerModel.ts` (533 LOC)

**Module-level functions**
- `export function setRigHeldItemTransform(item: Mesh, body: Mesh, phase: number, amp: number, punchT = Number.POSITIVE_INFINITY): void`
- `export function buildPlayerRigData(origin: RigOrigin =): MeshData`
- `export function buildFloorSlabData(width = 1.0, atlasRect?: readonly [number, number, number, number]): MeshData`
- `export function createPlayerRigMesh(engine: EngineContext, name: string, origin: RigOrigin =): Mesh`
- `function getFallbackTexture(engine: EngineContext): Texture2D`
- `export function getRigFallbackTexture(engine: EngineContext): Texture2D`
- `export function loadPlayerSkin(engine: EngineContext): Promise<Texture2D>`
- `export function packedLightToLightColor(packed: number): readonly [number, number, number]`
- `export function createRigShaderMaterial(name: string): ShaderMaterial`
- `export function bindRigTexture(mat: ShaderMaterial, tex: Texture2D): void`
- `export function setRigLightColor(mat: ShaderMaterial, color: readonly [number, number, number]): void`
- `export function setRigWalk(mat: ShaderMaterial, phase: number, amp: number): void`
- `export function setRigHeadPitch(mat: ShaderMaterial, pitch: number): void`
- `export function setRigPunch(mat: ShaderMaterial, punchT: number): void`

**Types / Interfaces / Enums**
- interface `UvSet`
- interface `RigAnimState`
- type `EngineContext`
- type `Mesh`
- type `ShaderMaterial`
- type `Texture2D`
- type `UvRect`

---

## `Player/PlayerStatePersistence.ts` (257 LOC)

### export class PlayerStatePersistence

**Constructor**
- `constructor(private readonly scene: SceneContext, private readonly player: Player, private readonly worldName: string, private readonly options: PlayerPersistenceOptions = {})`

**Properties**
- `private static readonly PLAYER_POSITION_STORAGE_KEY`
- `private static readonly PLAYER_INVENTORY_STORAGE_KEY`
- `private static readonly PLAYER_STATS_STORAGE_KEY`
- `private static readonly PLAYER_EQUIPMENT_STORAGE_KEY`
- `private static readonly PLAYER_STATE_SAVE_INTERVAL_MS`
- `private static readonly CHUNK_SAVE_BATCH_SIZE`
- `private static readonly CHUNK_SAVE_NOW_BATCH_SIZE`
- `private lastPositionSaveMs`
- `private lastCheckMs`
- `private inventoryObserver: any = null`
- `private sceneDisposeObserver: any = null`
- `private isDisposed`
- `private readonly onBeforeUnload`
- `private readonly onVisibilityChange`

**Methods**
- `private storageKey(baseKey: string): string`
- `public update(): void`
- `public async saveNow(): Promise<void>`
- `public dispose(): void`
- `private setupPersistence(): void`
- `private requestChunkSave(batchSize: number): void`
- `private savePosition(): void`
- `private saveInventory(): void`
- `private saveStats(): void`
- `private restoreFromLocalStorage(): void`
- `private restorePosition(): void`
- `private restoreInventory(): void`
- `private restoreEquipment(): void`
- `private restoreStats(): void`

**Types / Interfaces / Enums**
- interface `PlayerPersistenceOptions`

---

## `Player/PlayerStats.ts` (132 LOC)

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
- `public xp`
- `public xpLevel`
- `public healthRegenRate`
- `public staminaRegenRate`
- `public manaRegenRate`
- `public hungerDepletionRate`
- `public climbingStaminaRegenMultiplier`
- `public damageReduction`

**Methods**
- `public update(deltaTime: number, isSprinting: boolean, staminaRegenScale = 1): void`
- `public takeDamage(amount: number): void`
- `public xpForNextLevel(): number`
- `public addXp(amount: number): void`
- `public getSavedStatsState(): SavedPlayerStats`
- `public restoreSavedStatsState(saved: SavedPlayerStats): boolean`
- `public heal(amount: number): void`
- `public consumeStamina(amount: number): boolean`
- `public consumeMana(amount: number): boolean`
- `public eat(amount: number): void`

**Types / Interfaces / Enums**
- type `SavedPlayerStats`

---

## `Player/PlayerVehicle.ts` (221 LOC)

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
- `copyFrom(v: Vec3): void`
- `public clearControlState(): void`
- `public toggleFlying(): void`
- `public lockMovementAtCurrentPosition(): void`
- `public unlockMovement(): void`
- `public getSavedPosition(): Vec3`
- `public restoreSavedPosition(position: unknown): boolean`
- `public setMount(mount: Mount | null): void`
- `public respawn(): void`
- `public update(deltaTime: number): void`
- `public updateCameraAndVisuals(deltaMs?: number): void`

**Types / Interfaces / Enums**
- type `BlockShapeInfo`
- type `MutableVec3`

---

## `Player/PlayerVehicleMotor.ts` (1351 LOC)

**Types / Interfaces / Enums**
- type `EngineContext`
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`
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

## `TestScene.ts` (276 LOC)

### export class TestScene

**Constructor**
- `constructor(document: Document, private readonly canvas: HTMLCanvasElement, private readonly worldName: string)`

**Properties**
- `public readonly document: Document`
- `public readonly initPromise: Promise<void>`
- `public scene?: SceneContext`
- `public engine?: EngineContext`

**Methods**
- `public async init(): Promise<void>`
- `private async initMultiplayer(engine: EngineContext, scene: SceneContext, player: Player, playerCamera: PlayerCamera, serverNick: string): Promise<void>`
- `private async initSingleplayer(engine: EngineContext, scene: SceneContext, player: Player, playerCamera: PlayerCamera): Promise<void>`
- `private initSharedPlayerSystems(scene: SceneContext, player: Player): void`
- `private registerFrameUpdate(scene: SceneContext, playerCamera: PlayerCamera, perModeUpdate: (deltaMs: number) => void): void`
- `private async showLiteExplorer(engine: EngineContext, scene: SceneContext): Promise<void>`
- `public dispose(): void`

**Module-level functions**
- `function reconstructWsUrl(nick: string | null): string | undefined`

**Types / Interfaces / Enums**
- type `EngineContext`
- type `SceneContext`

---

## `UI/GameSettings.ts` (122 LOC)

**Module-level functions**
- `function clamp(v: number, min: number, fallback: number, max: number): number`
- `export function loadGameSettings(): GameSettings`
- `export function saveGameSettings(settings: GameSettings): void`
- `export function applyGameSettingsToEngine(settings: GameSettings): GameSettings`

**Types / Interfaces / Enums**
- interface `GameSettings`

---

## `UI/MainMenu.ts` (858 LOC)

### export class MainMenu

**Constructor**
- `constructor()`

**Properties**
- `private readonly container: HTMLElement`
- `private screen: MenuScreen =`
- `private crosshairId`
- `private crosshairColor`
- `private crosshairGrid?: CrosshairGrid`
- `private crosshairSwatches?: CrosshairSwatches`
- `private crosshairPreview?: CrosshairPreview`

**Methods**
- `btnMinecraft(spBtn)`
- `btnMinecraft(mpBtn)`
- `btnMinecraft(optsBtn)`
- `btnMinecraft(quitBtn)`
- `btnMinecraft(spBack)`
- `btnMinecraft(createBtn)`
- `btnMinecraft(mpBack)`
- `btnSmallMinecraft(refreshBtn)`
- `btnMinecraft(addBtn)`
- `makeOptionSlider(labelText: string, min: number, max: number, step: number, initial: number, format: (value: number) => string)`
- `makeOptionToggle(labelText: string, initial: boolean, format: (value: boolean) => string)`
- `private createOptionsScreen(): HTMLElement`
- `private createCrosshairSection(initialId: string, initial: {
			size: number;
			color: string;
			visible: boolean;
			hitmarkerEnabled: boolean;
		}): HTMLElement`
- `private updateCrosshairPreview(): void`
- `private showScreen(screen: MenuScreen): void`
- `public mount(root: HTMLElement): void`
- `public dispose(): void`
- `private async createWorld(): Promise<void>`
- `private async refreshWorlds(): Promise<void>`
- `private worldRow(name: string): HTMLElement`
- `private async deleteWorld(name: string, button: HTMLButtonElement): Promise<void>`
- `private normalizeServerUrl(raw: string): string`
- `private addServer(): void`
- `private async connectMultiplayer(name: string, url: string): Promise<void>`
- `private async refreshServerList(): Promise<void>`
- `private serverRow(server: SavedServer): HTMLElement`
- `private updateServerRow(row: HTMLElement, server: SavedServer, status: ServerStatus): void`
- `private loadingRow(text: string): HTMLElement`
- `private addStyles(): void`

**Module-level functions**
- `function getRandomWorldName(): string`
- `function getRandomSeed(): string`
- `async function listWorlds(): Promise<string[]>`
- `async function deleteWorld(name: string): Promise<void>`
- `function setStatus(el: HTMLElement, msg: string, isError = false): void`
- `function btnMinecraft(btn: HTMLButtonElement, text: string): void`
- `function btnSmallMinecraft(btn: HTMLButtonElement, text: string): void`

**Types / Interfaces / Enums**
- type `SavedServer`
- type `CrosshairGrid`
- type `CrosshairPreview`
- type `CrosshairSwatches`
- type `MenuScreen`

---

## `wasm/gradient_tables.ts` (80 LOC)

---

## `wasm/kernels.ts` (1604 LOC)

**Module-level functions**
- `function hash2(seed: i32, xp: i32, yp: i32): i32`
- `function hash3(seed: i32, xp: i32, yp: i32, zp: i32): i32`
- `function gradCoord2(seed: i32, xp: i32, yp: i32, xd: f32, yd: f32): f32`
- `function gradCoord3(seed: i32, xp: i32, yp: i32, zp: i32, xd: f32, yd: f32, zd: f32): f32`
- `function pingpong(t: f32): f32`
- `function lerp(a: f32, b: f32, t: f32): f32`
- `function singleSimplex2(seed: i32, x: f32, y: f32): f32`
- `function singleSimplex3(seed: i32, x: f32, y: f32, z: f32): f32`
- `function fractalBounding(gain: f32, octaves: i32): f32`
- `function fractal2(seed: i32, x: f32, y: f32, fractalType: i32, octaves: i32, lacunarity: f32, gain: f32, ws: f32, pp: f32): f32`
- `function fractal3(seed: i32, x: f32, y: f32, z: f32, fractalType: i32, octaves: i32, lacunarity: f32, gain: f32, ws: f32, pp: f32): f32`
- `function gradL2(seed: i32, xp: v128, yp: v128, xd: v128, yd: v128): v128`
- `function gradL3(seed: i32, xp: v128, yp: v128, zp: v128, xd: v128, yd: v128, zd: v128): v128`
- `function selectB(a: v128, b: v128, c: v128): v128`
- `function singleSimplex2L4(seed: i32, x: v128, y: v128): v128`
- `function singleSimplex3L4(seed: i32, x: v128, y: v128, z: v128): v128`
- `function fractal2L4(seed: i32, x: v128, y: v128, fractalType: i32, octaves: i32, lacunarity: f32, gain: f32, ws: f32, pp: f32): v128`
- `function fractal3L4(seed: i32, x: v128, y: v128, z: v128, fractalType: i32, octaves: i32, lacunarity: f32, gain: f32, ws: f32, pp: f32): v128`
- `export function ensureScratch(n: i32): usize`
- `export function noise_scalar_2d(x: f32, y: f32, freq: f32, noiseType: i32, fractalType: i32, seed: i32, octaves: i32, lacunarity: f32, gain: f32, ws: f32, pp: f32): f32`
- `export function noise_scalar_3d(x: f32, y: f32, z: f32, freq: f32, noiseType: i32, fractalType: i32, transformType: i32, seed: i32, octaves: i32, lacunarity: f32, gain: f32, ws: f32, pp: f32): f32`
- `function noise3L4(x: v128, y: v128, z: v128, freq: f32, noiseType: i32, fractalType: i32, transformType: i32, seed: i32, octaves: i32, lacunarity: f32, gain: f32, ws: f32, pp: f32): v128`
- `export function noise_fill_2d(out: usize, width: i32, height: i32, offsetX: f32, offsetY: f32, freq: f32, noiseType: i32, fractalType: i32, seed: i32, octaves: i32, lacunarity: f32, gain: f32, ws: f32, pp: f32): void`
- `export function noise_fill_3d(out: usize, width: i32, height: i32, depth: i32, offsetX: f32, offsetY: f32, offsetZ: f32, freq: f32, noiseType: i32, fractalType: i32, transformType: i32, seed: i32, octaves: i32, lacunarity: f32, gain: f32, ws: f32, pp: f32): void`
- `export function noise_fill_3d_affine(out: usize, width: i32, height: i32, depth: i32, x0: f32, y0: f32, z0: f32, ax: f32, bx: f32, ay: f32, az: f32, bz: f32, freq: f32, noiseType: i32, fractalType: i32, transformType: i32, seed: i32, octaves: i32, lacunarity: f32, gain: f32, ws: f32, pp: f32): void`
- `export function surface_density_band(out: usize, count: i32, y0: f32, step: f32, baseNoiseX: f32, baseNoiseZ: f32, overhangBaseX: f32, overhangBaseZ: f32, baseHeight: f32, yFreq: f32, cliffContribution: f32, baseAmp: f32, overhangAmp: f32, influenceRange: f32, freq: f32, noiseType: i32, fractalType: i32, transformType: i32, seed: i32, octaves: i32, lacunarity: f32, gain: f32, ws: f32, pp: f32): void`

---

## `World/BlockInventory/BlockInventoryManager.ts` (165 LOC)

**Module-level functions**
- `function posKey(x: number, y: number, z: number): string`
- `function loadAll(): Map<string, SavedBlockInventory>`
- `function saveAll(): void`
- `export function getBlockInventory(x: number, y: number, z: number): SavedBlockInventory`
- `export function saveBlockInventory(x: number, y: number, z: number, inv: SavedBlockInventory): void`
- `export function createEmptyInventory(width: number, height: number): SavedBlockInventory`
- `export function ensureSeededLoot(x: number, y: number, z: number, seedAsInt: number): SavedBlockInventory`
- `export function buildBlockInventorySlots(saved: SavedBlockInventory): ItemSlot[][]`
- `export function serializeBlockSlots(grid: ItemSlot[][]): SavedBlockInventory`

**Types / Interfaces / Enums**
- interface `SavedBlockInventoryItem`
- interface `SavedBlockInventory`

---

## `World/BlockInventory/StationManager.ts` (148 LOC)

**Module-level functions**
- `function posKey(x: number, y: number, z: number): string`
- `function loadAll(): Map<string, SavedStation>`
- `function saveAll(): void`
- `function isStack(value: unknown): value is ItemStack | null`
- `function isValidSavedStation(value: unknown): value is SavedStation`
- `export function resetStationStoreForTests(): void`
- `export function getStationState(x: number, y: number, z: number, kind: StationKind): StationState`
- `export function saveStationState(x: number, y: number, z: number, state: StationState): void`
- `export function forgetStation(x: number, y: number, z: number): void`
- `export function stationKindForBlock(blockId: number): StationKind | undefined`
- `export function isStationBlock(blockId: number): boolean`

**Types / Interfaces / Enums**
- interface `SavedStation`

---

## `World/BlockInventory/StationRuntime.ts` (137 LOC)

**Module-level functions**
- `function key(x: number, y: number, z: number): string`
- `export function clearStationTracking(): void`
- `export function getTrackedStations(): readonly TrackedStation[]`
- `export function tickStationRuntime(dtSec: number, position: Vec3): void`
- `function rescan(px: number, py: number, pz: number): void`
- `function prune(px: number, py: number, pz: number): void`
- `export function flushStationRuntime(): void`
- `export function notifyStationBlockBroken(x: number, y: number, z: number): void`

**Types / Interfaces / Enums**
- interface `TrackedStation`

---

## `World/BlockInventory/StationTypes.ts` (340 LOC)

**Module-level functions**
- `export function findStationRecipe(kind: StationKind, inputItemId: number): StationRecipe | undefined`
- `export function canProcess(kind: StationKind, itemId: number): boolean`
- `export function createStationState(kind: StationKind): StationState`
- `export function isLit(state: StationState): boolean`
- `export function tickStation(state: StationState, ticks = 1, toolTier = Number.POSITIVE_INFINITY): StationTickResult`
- `export function stationProgress(state: StationState): number`

**Types / Interfaces / Enums**
- interface `StationState`
- interface `StationTickResult`
- type `StationKind`

---

## `World/BlockInventory/StationUi.ts` (504 LOC)

### export class StationUi

**Module-level functions**
- `export function isRepairStation(kind: StationKind): boolean`
- `export function makeStationItem(stack: ItemStack | null): Item | null`
- `export function describeStation(state: StationState): string`
- `function stackOrNull(stack: {
	itemId: number;
	stackSize: number;
}): ItemStack | null`
- `function stationKindFromId(id: number): StationKind | undefined`
- `function progressFraction(smeltProgress: number, kind: StationKind | undefined): number`
- `function isRemote(): boolean`

**Types / Interfaces / Enums**
- type `ItemStack`
- type `StationKind`
- type `StationState`

---

## `World/Boat/BoatChunk.ts` (523 LOC)

### export class BoatChunk

**Constructor**
- `constructor(blocks: BoatChunkBlock[], center: Vec3)`

**Properties**
- `private static activeChunks`
- `private static readonly CHUNK_Y_BASE`
- `private static readonly CHUNK_COORD_GRID_WIDTH`
- `private static readonly CHUNK_COORD_SPACING`
- `private static nextChunkSlot`
- `minX: 0,`
- `minY: 0,`
- `minZ: 0,`
- `maxX: 0,`
- `maxY: 0,`
- `maxZ: 0,`
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
- `public getOccupiedBoundsLocal(): BoatChunkBounds | null`
- `public getOccupiedBoundsLocalToRef(out: BoatChunkBounds = this.#scratchBounds): BoatChunkBounds | null`
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
- type `BoatChunkBounds`

---

## `World/Boat/BoatCreatorSystem.ts` (275 LOC)

**Module-level functions**
- `export function setSourceBlockIds(ids: Iterable<number>): void`
- `export function addSourceBlockId(id: number): void`
- `export function removeSourceBlockId(id: number): void`
- `export function getSourceBlockIds(): number[]`
- `export function setVisualMode(mode: VisualMode): void`
- `export function tryCreateBoatFromMarker(player: Player, markerX: number, markerY: number, markerZ: number): CustomBoat | null`
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

## `World/Chunk/Chunk.ts` (1068 LOC)

### export class Chunk

**Constructor**
- `constructor(chunkX: number, chunkY: number, chunkZ: number)`

**Properties**
- `public id: bigint = 0n`
- `public lodLevel`
- `public static readonly SIZE`
- `public static readonly SIZE2`
- `public static readonly SIZE3`
- `public static readonly SM1`
- `public static readonly chunkInstances`
- `public static readonly chunkByNumericKey`
- `public static readonly loadedChunks`
- `public static readonly loadedChunkIndex`
- `public isModified`
- `public isBoatChunk`
- `public isDirty`
- `public isLoaded`
- `public isTerrainScheduled`
- `public isLightDirty`
- `public persistenceRevision`
- `public remeshQueued`
- `public rerunRemeshAfterInflight`
- `public meshRevision`
- `public blockRevision`
- `public generation`
- `private static _generationCounter`
- `public static DEBUG_REMESH`
- `public static onRequestRemesh`
- `public static onChunkLoaded: ((chunk: Chunk) => void) | null = null`
- `public static onBlockModified: ((chunk: Chunk) => void) | null = null`
- `public static lightHeaderBuffer: SharedArrayBuffer | null = null`
- `public static lightHeaderView: LightHeaderView | null = null`
- `private static _lightHeaderNextSlot`
- `private static _lightHeaderFreeSlots: number[] = []`
- `public static onLightChunkLoaded`
- `public static onLightChunkLayoutChanged: ((chunk: Chunk) => void) | null =`
- `public static onLightChunkDisposed: ((chunk: Chunk) => void) | null = null`
- `private _block_array: Uint8Array | Uint16Array | null = null`
- `private _isUniform`
- `private _uniformBlockId`
- `private _palette: Uint16Array | null = null`
- `private _paletteMap: Map<number, number> | null = null`
- `private _hasVoxelData`
- `private _la32: Uint32Array | null = null`
- `private _paletteOpacity: Uint8Array | null = null`
- `public chunkY: number`
- `public chunkX: number`
- `public chunkZ: number`
- `public mesh: Mesh | null = null`
- `public waterMesh: Mesh | null = null`
- `public cutoutMesh: Mesh | null = null`
- `public opaqueMeshData: MeshData | null = null`
- `public waterMeshData: MeshData | null = null`
- `public cutoutMeshData: MeshData | null = null`
- `public mergedGroupKey: number | null = null`
- `public faceConnectivity`
- `public connectivityDirty`
- `_isDarkCached: boolean | undefined = undefined`
- `light_array: Uint8Array`
- `private _storageSnapshot: LightStorageSnapshot | null = null`
- `public readonly numericId: number`
- `private static _nextNumericId`
- `public lightHeaderSlot: number = 0xffff_ffff`
- `public bfsQueryId: number = 0`
- `public bfsVisitedFaces: number = 0`
- `public bfsSteps0`
- `public bfsSteps1`
- `public bfsQueuedForConnectivity: boolean = false`
- `public readonly neighborRefs: (Chunk | null)[] = [ null, null, null, null, null, null, ]`
- `public static readonly SKY_LIGHT_SHIFT`
- `public static readonly BLOCK_LIGHT_MASK`
- `private static readonly EMPTY_LIGHT_ARRAY`
- `private static readonly MAX_CACHED_LOD`
- `private static readonly LOD_CACHE_SIZE`
- `private _cachedLODMeshes: (CachedLODMesh | null)[] | null = null`
- `private static readonly _lightEmissionLUT`

**Accessors**
- `public get isSolidOccluder(): boolean`

**Methods**
- `private static allocPooledChunk(x: number, y: number, z: number): Chunk`
- `public static obtain(x: number, y: number, z: number): Chunk`
- `public static beginBlockEditBatch(): void`
- `public static endBlockEditBatch(): void`
- `public static initLightHeader(): SharedArrayBuffer`
- `private static allocLightHeaderSlot(): number`
- `public getLightStorageSnapshot(): LightStorageSnapshot`
- `public static getLightEmission(blockId: number): number`
- `registerChunk(this)`
- `private ensureSharedBacking(): void`
- `public loadLodOnlyFromStorage(scheduleRemesh = false): void`
- `public getCachedLODMesh(lod: number): CachedLODMesh | null`
- `public hasCachedLODMesh(lod: number): boolean`
- `public setCachedLODMesh(lod: number, mesh: CachedLODMesh): void`
- `private getOrCreateLODCache(): (CachedLODMesh | null)[]`
- `private setCachedLODMeshParts(lod: number, opaque: MeshData | null, water: MeshData | null, cutout: MeshData | null): void`
- `public isDarkCached(): boolean`
- `public setBlockLight(x: number, y: number, z: number, level: number): void`
- `public setSkyLight(x: number, y: number, z: number, level: number): void`
- `public getBlock(lx: number, ly: number, lz: number): number`
- `public getBlockState(lx: number, ly: number, lz: number): number`
- `public getBlockPacked(lx: number, ly: number, lz: number): number`
- `private _rebuildPaletteOpacity(): void`
- `public setBlock(localX: number, localY: number, localZ: number, blockId: number, state = 0): void`
- `private linkNeighbors(): void`
- `public markLightChanged(): void`
- `public needsPersistence(): boolean`
- `public computeFaceConnectivity(): number`
- `private updateLightView(): void`
- `public dispose(): void`

**Module-level functions**
- `function makeSharedUint16(length: number): Uint16Array`
- `function makeSharedUint8(length: number): Uint8Array`
- `export function addChunkDisposeHook(hook: ChunkDisposeHook): void`
- `function runChunkDisposeHooks(chunk: Chunk): void`
- `export function getChunk(cx: number, cy: number, cz: number): Chunk | undefined`

**Types / Interfaces / Enums**
- type `ChunkLightPool`
- type `LightHeaderView`
- type `CachedLODMesh`
- type `SerializedLODMeshCache`
- type `LightStorageSnapshot`
- type `ChunkDisposeHook`

---

## `World/Chunk/ChunkEntityAPI.ts` (14 LOC)

**Types / Interfaces / Enums**
- type `DynamicBlockQueryOptions`
- type `DynamicBlockSample`

---

## `World/Chunk/ChunkLoadingSystem.ts` (742 LOC)

**Module-level functions**
- `function queueBlockEditSave(chunk: Chunk): void`
- `function isEntityAlive(entity: ChunkBoundEntity): boolean`
- `function getEntityChunkId(entity: ChunkBoundEntity): bigint | null`
- `export function deleteBlock(worldX: number, worldY: number, worldZ: number)`
- `export function setBlock(worldX: number, worldY: number, worldZ: number, blockId: number, state = 0)`
- `export function getBlockByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): number`
- `export function getTerrainBlockByWorldCoords(worldX: number, worldY: number, worldZ: number): number`
- `export function getBlockStateByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): number`
- `export function getBlockAndStateByWorldCoordsInto(worldX: number, worldY: number, worldZ: number, out: BlockAndStateOut, options?: DynamicBlockQueryOptions): BlockAndStateOut`
- `export function resolveBlockAtWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): ResolvedBlock`
- `export function getBlockAndStateByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): BlockAndStateOut`
- `export function getLightByWorldCoords(worldX: number, worldY: number, worldZ: number, options?: DynamicBlockQueryOptions): number`
- `function collectChunkEntityPayloads(): ReadonlyMap<
	bigint,
	SavedChunkEntityData[]
>`

**Types / Interfaces / Enums**
- type `SavedChunkData`
- type `SavedChunkEntityData`
- type `QueuedChunkRequest`
- type `DynamicBlockSample`
- type `DynamicBlockProvider`
- type `DynamicBlockMutator`
- type `DynamicBlockProviderEntry`
- type `DynamicBlockQueryOptions`
- type `BlockAndStateOut`
- type `ResolvedBlock`

---

## `World/Chunk/ChunkWorkerPool.ts` (3093 LOC)

### export class ChunkWorkerPool

**Module-level functions**
- `function compareLodCandidateScores(a: number, b: number): number`
- `function packInflightKey(numericId: number, lod: number): number`
- `function pushRecyclableBuffer(scratch: ArrayBuffer[], arr: Uint8Array): void`
- `function assertNever(value: never): never`

**Types / Interfaces / Enums**
- type `DistantTerrainGeneratedMessage`
- type `DistantTerrainTask`
- type `FarTileGeneratedMessage`
- type `FullMeshMessage`
- type `GenerateFarTileRequest`
- type `LightDirtyMessage`
- type `LightRegisterChunkBatchRequest`
- type `MeshWorkerResponse`
- type `RelightMeshMissMessage`
- type `TerrainGeneratedMessage`
- type `WorkerResponseData`
- type `WorkerMessageData`
- type `FarTileTask`
- type `ChunkWorkerPoolDebugStats`
- type `WorkerTaskContextShape`
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

## `World/Chunk/DataStructures/MeshData.ts` (6 LOC)

### export class MeshData

**Properties**
- `faceData: Uint8Array = EMPTY_U8`
- `faceCount`

---

## `World/Chunk/DataStructures/PaletteExpander.ts` (36 LOC)

**Module-level functions**
- `export function expandPalette(packed: Uint8Array, palette: ArrayLike<number>, totalBlocks: number): Uint8Array | Uint16Array`
- `export function isUint16(palette: ArrayLike<number> | null | undefined): boolean`

---

## `World/Chunk/DataStructures/ResizableTypedArray.ts` (164 LOC)

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
- `get finalArrayView(): T`

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

## `World/Chunk/DataStructures/WorkerInternalMeshData.ts` (5 LOC)

**Types / Interfaces / Enums**
- type `WorkerInternalMeshData`

---

## `World/Chunk/DataStructures/WorkerMessageType.ts` (347 LOC)

**Types / Interfaces / Enums**
- interface `SerializedLightSeedState`
- type `GenerateTerrainRequest`
- type `GenerateFullMeshRequest`
- type `VoxelRegisterChunkRequest`
- type `VoxelRegisterChunkBatchRequest`
- type `VoxelUnregisterChunkRequest`
- type `VoxelUnregisterChunkBatchRequest`
- type `VoxelUpdateChunkBuffersRequest`
- type `VoxelRecycleBuffersRequest`
- type `FullMeshMessage`
- type `TerrainGeneratedMessage`
- type `RelightMeshMissMessage`
- type `DistantTerrainGeneratedMessage`
- type `WorkerResponseData`
- type `MeshWorkerResponse`

---

## `World/Chunk/LightDebugTool.ts` (155 LOC)

**Module-level functions**
- `function dumpLightDiagnostics(wx: number, wy: number, wz: number): void`
- `function dumpChunkTable(pcx: number, pcy: number, pcz: number): void`
- `function dumpColumns(px: number, py: number, pz: number): void`
- `function dumpColumn(worldX: number, worldZ: number, py: number): void`

**Types / Interfaces / Enums**
- type `Vec3Like`

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

## `World/Chunk/Loading/ChunkHydration.ts` (40 LOC)

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

## `World/Chunk/Loading/ChunkPersistenceCoordinator.ts` (152 LOC)

### export class ChunkPersistenceCoordinator

**Constructor**
- `constructor(private readonly adapter: ChunkPersistenceCoordinatorAdapter)`

**Properties**
- `private flushPromise: Promise<void> | null = null`
- `private pendingFlushRequested`
- `private entityFlushPromise: Promise<void> | null = null`
- `private pendingEntityFlushRequested`
- `private readonly lastPersistedEntityChunkIds`
- `private readonly modifiedChunksScratch: Chunk[] = []`
- `private readonly candidateChunkIdsScratch: bigint[] = []`

**Methods**
- `public flushModifiedChunks(maxChunks: number = this.getChunkSaveBatchSize()): Promise<void>`
- `public flushChunkBoundEntities(maxChunks: number = this.getChunkEntitySaveBatchSize()): Promise<void>`
- `private getChunkSaveBatchSize(): number`
- `private getChunkEntitySaveBatchSize(): number`
- `private async drainModifiedChunkFlushes(maxChunks: number): Promise<void>`
- `private async drainChunkBoundEntityFlushes(maxChunks: number): Promise<void>`
- `private async flushModifiedChunksInternal(maxChunks: number): Promise<void>`
- `private async flushChunkBoundEntitiesInternal(maxChunks: number): Promise<void>`

**Module-level functions**
- `function normalizeFlushLimit(maxChunks: number): number`

**Types / Interfaces / Enums**
- interface `ChunkPersistenceCoordinatorAdapter`

---

## `World/Chunk/Loading/ChunkProcessScheduler.ts` (586 LOC)

### export class ChunkProcessScheduler

**Constructor**
- `constructor(private readonly adapter: ChunkProcessSchedulerAdapter)`

**Properties**
- `private isProcessing`
- `private inFlightProcessState: InFlightProcessState | null = null`
- `private readonly _state: InFlightProcessState =`
- `private processContinuationScheduled`
- `private readonly _saveScratch: Chunk[] = []`
- `private readonly _nearIdScratch: bigint[] = []`
- `private readonly _farIdScratch: bigint[] = []`
- `private preferLoadNext`
- `private unloadRetryAfterMs`
- `public onContinuationSlice: (() => void) | null = null`

**Accessors**
- `public get processing(): boolean`

**Methods**
- `private createReusableProcessState(): InFlightProcessState`
- `private resetState(state: InFlightProcessState): void`
- `private clearLoadState(state: InFlightProcessState): void`
- `public async processQueues(): Promise<void>`
- `private recoverProcessState(state: InFlightProcessState): void`
- `private isStillDesired(request: QueuedChunkRequest): boolean`
- `private queueGeneration(state: InFlightProcessState, chunk: Chunk): void`
- `public beginSlice(state: InFlightProcessState): void`
- `public hasBudget(state: InFlightProcessState): boolean`
- `public scheduleProcessContinuation(): void`

**Types / Interfaces / Enums**
- interface `ChunkProcessSchedulerAdapter`

---

## `World/Chunk/Loading/ChunkQueueManager.ts` (244 LOC)

### export class ChunkQueueManager

**Constructor**
- `constructor(private readonly adapter: ChunkQueueManagerAdapter = {})`

**Properties**
- `private readonly loadQueue: Array<Chunk | undefined> = []`
- `private loadQueueHead`
- `private loadQueueHoleCount`
- `private readonly loadQueueSet`
- `private readonly unloadQueueSet`
- `loadQueue: this.loadQueue as Chunk[],`
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
- `private compactLoadQueueIfUseful(): void`
- `private compactLoadQueue(): void`

**Module-level functions**
- `function normalizeBatchSize(maxChunks: number, queueLength: number): number`

**Types / Interfaces / Enums**
- interface `ChunkQueueManagerAdapter`
- interface `ChunkQueueBatch`

---

## `World/Chunk/Loading/ChunkReadiness.ts` (51 LOC)

**Module-level functions**
- `export function areChunksLoadedAround(chunkX: number, chunkY: number, chunkZ: number, horizontalRadius: number = 1, verticalRadius: number = 0): boolean`
- `export function areChunksLod0ReadyAround(chunkX: number, chunkY: number, chunkZ: number, horizontalRadius: number = 1, verticalRadius: number = 0): boolean`

---

## `World/Chunk/Loading/ChunkStreamingController.ts` (1294 LOC)

**Module-level functions**
- `function clampLodForY(chunkY: number, lod: number): number`
- `function resolveDesiredLod(chunkX: number, chunkY: number, chunkZ: number, hDist: number, vDist: number, previousLod: number, lodRuleSet: ChunkLodRuleSet, enforceCreation: boolean): number`
- `function absI(n: number): number`
- `function chebyH(x: number, z: number): number`
- `function isBuriedCullable(chunkX: number, chunkY: number, chunkZ: number, hDist: number, caveState: boolean): boolean`

---

## `World/Chunk/Loading/ChunkTypes.ts` (78 LOC)

**Types / Interfaces / Enums**
- type `ChunkBoundEntity`
- type `InFlightProcessState`
- type `ChunkLoadingDebugStats`

---

## `World/Chunk/Loading/ChunkWorldMutations.ts` (330 LOC)

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
- `public getBlockAndStateAtWorldCoordsInto(worldX: number, worldY: number, worldZ: number, out: BlockAndStateLoadedOut): BlockAndStateLoadedOut`
- `public getLightByWorldCoords(worldX: number, worldY: number, worldZ: number): number`
- `public setBlock(worldX: number, worldY: number, worldZ: number, blockId: number, state: number = 0): boolean`
- `public deleteBlock(worldX: number, worldY: number, worldZ: number): boolean`

**Module-level functions**
- `function resolveCoords(worldX: number, worldY: number, worldZ: number): ResolvedChunkCoords`
- `function fillMutationContext(ctx: BlockMutationContext, worldX: number, worldY: number, worldZ: number, chunkX: number, chunkY: number, chunkZ: number, localX: number, localY: number, localZ: number, chunk: Chunk, previousBlockId: number, previousBlockState: number, nextBlockId: number, nextBlockState: number): BlockMutationContext`
- `function isBoundaryLocalCoord(localX: number, localY: number, localZ: number): boolean`
- `export function toLocalBlockCoordinates(worldX: number, worldY: number, worldZ: number): LocalBlockCoordinates`
- `export function getBlockStateByWorldCoords(worldX: number, worldY: number, worldZ: number): number`

**Types / Interfaces / Enums**
- interface `WorldBlockCoordinates`
- interface `LocalBlockCoordinates`
- interface `BlockMutationContext`
- interface `ChunkWorldMutationsAdapter`
- type `BlockAndStateLoadedOut`

---

## `World/Chunk/Loading/ColumnStreamingOrder.ts` (52 LOC)

**Module-level functions**
- `export function isAheadColumn(x: number, z: number, cx: number, cz: number, dx: number, dz: number): boolean`
- `export function buildInitialColumnList(cx: number, cz: number, radius: number, dx: number, dz: number): ColumnEntry[]`
- `export function sortColumnsAheadFirst(columns: ColumnEntry[], aheadRingBonus = 0.5): ColumnEntry[]`

**Types / Interfaces / Enums**
- type `ColumnEntry`

---

## `World/Chunk/Loading/LoadedChunkIndex.ts` (219 LOC)

### export class LoadedChunkIndex

**Properties**
- `private readonly cells`
- `private readonly chunkCells`
- `private readonly _freeCells: LoadedChunkCell[] = []`
- `centerX: number,`
- `centerY: number,`
- `centerZ: number,`
- `horizontalRadius: number,`
- `verticalRadius: number,`

**Methods**
- `private _allocCell(hash: number, cx: number, cy: number, cz: number): LoadedChunkCell`
- `register(chunk: Chunk): void`
- `unregister(chunk: Chunk): void`
- `queryCollect(centerX: number, centerY: number, centerZ: number, horizontalRadius: number, verticalRadius: number, out: Chunk[]): void`
- `private removeFromCell(chunk: Chunk, cell: LoadedChunkCell): void`

**Module-level functions**
- `function chunkCoordToCell(coord: number): number`
- `function hashCellKey(cx: number, cy: number, cz: number): number`
- `function chunkCellX(chunk: Chunk): number`
- `function chunkCellY(chunk: Chunk): number`
- `function chunkCellZ(chunk: Chunk): number`

**Types / Interfaces / Enums**
- type `LoadedChunkCell`

---

## `World/Chunk/LOD/ChunkLodRules.ts` (285 LOC)

### export class Lod0ChunkCreationRule implements ChunkLodCreationRule

**Constructor**
- `constructor(private readonly horizontalRadius: number, private readonly verticalRadius: number)`

**Properties**
- `public readonly lodLevel`
- `public readonly allowsChunkCreation`

**Methods**
- `public matches(distance: ChunkLodDistance): boolean`

### export class BandChunkCreationRule implements ChunkLodCreationRule

**Constructor**
- `constructor(public readonly lodLevel: number, private readonly horizontalRadius: number, private readonly verticalRadius: number)`

**Properties**
- `public readonly allowsChunkCreation`

**Methods**
- `public matches(distance: ChunkLodDistance): boolean`

### export class DistantOnlyChunkCreationRule implements ChunkLodCreationRule

**Constructor**
- `constructor(public readonly lodLevel = DISTANT_LOD_LEVEL)`

**Properties**
- `public readonly allowsChunkCreation`

**Methods**
- `public matches(_distance: ChunkLodDistance): boolean`

### export class ChunkLodRuleSet

**Constructor**
- `constructor(public readonly radii: ChunkLodRadii, private readonly rules: ChunkLodCreationRule[], private readonly horizontalRadiiArr: number[], private readonly verticalRadiiArr: number[], public readonly revision: number = 0, public readonly undergroundVerticalCap?: number)`

**Properties**
- `horizontalDist: 0,`
- `verticalDist: 0,`
- `horizontalDist: 0,`
- `verticalDist: 0,`
- `lodLevel: 0,`
- `allowsChunkCreation: false,`
- `private readonly _scratchDistance: ChunkLodDistance`
- `private readonly _scratchDecision: ChunkLodDecision`

**Methods**
- `public static fromRenderRadii(renderDistance: number, verticalRadius: number, revision: number = 0): ChunkLodRuleSet`
- `public maxHorizontalRadius(): number`
- `public maxVerticalRadius(): number`
- `public horizontalRadiusFor(lod: number): number`
- `public verticalRadiusFor(lod: number): number`
- `public horizontalLodForDistance(hDist: number): number`
- `private resolveWithDistance(horizontalDist: number, verticalDist: number): ChunkLodDecision`
- `public resolve(target: ChunkLodCoordinates, player: ChunkLodCoordinates): ChunkLodDecision`
- `public resolveWithHysteresis(targetX: number, targetY: number, targetZ: number, playerX: number, playerY: number, playerZ: number, previousLod: number | null | undefined): ChunkLodDecision`
- `public resolveWithHysteresisFromDistance(horizontalDist: number, verticalDist: number, previousLod: number | null | undefined): ChunkLodDecision`
- `private _resolveWithHysteresis(horizontalDist: number, verticalDist: number, previousLod: number | null | undefined): ChunkLodDecision`

**Types / Interfaces / Enums**
- interface `ChunkLodCreationRule`
- type `ChunkLodCoordinates`
- type `ChunkLodRadii`
- type `ChunkLodDistance`
- type `ChunkLodDecision`

---

## `World/Chunk/LOD/LODUtilities.ts` (6 LOC)

**Module-level functions**
- `export function maxLodForChunkY(chunkY: number): number`

---

## `World/Chunk/Meshing/ChunkFaceMasks.ts` (298 LOC)

**Module-level functions**
- `function getFaceBit(axis: number, dir: number): number`
- `function pushRectFlat(f: number, u0: number, u1: number, v0: number, v1: number): void`
- `function insertionSortEdges(start: number, len: number): void`
- `function dedupeEdges(start: number, len: number): number`
- `function doesFlatRectsCoverUnitSquare(f: number): boolean`
- `function getClosedFaceMaskForPacked(blockPacked: number): number`
- `function applySliceStateToBoxForLight(min: [number, number, number], max: [number, number, number], state: number)`
- `export function isTransparent(blockPacked: number, axis?: number, dir?: number): boolean`
- `export function facePairIndex(i: number, j: number): number`
- `function connectFacesMask(faceMask: number): number`
- `export function precomputeClosedFaceMasks(): Uint8Array`

---

## `World/Chunk/Meshing/ChunkMesher.ts` (656 LOC)

**Module-level functions**
- `function nearlyEqual(a: number, b: number, eps = UNIFORM_EPSILON): boolean`
- `function getOpaqueMaterialForLodBucket(lod: number): ShaderMaterial`
- `function getTransparentMaterialForLodBucket(lod: number): ShaderMaterial`
- `function getCutoutMaterialForLodBucket(lod: number): ShaderMaterial`
- `function uploadTintLUT(): void`
- `function hasStaticLightingChanged(): boolean`
- `function cacheStaticLightingState(): void`
- `function setStaticMaterialUniforms(m: ShaderMaterial): void`
- `function setTransparentTimeUniform(time: number): void`
- `function buildBoatInput(material: ShaderMaterial, data: MeshData): PackedMeshInput`
- `export function disposeSharedResources(): void`

**Types / Interfaces / Enums**
- type `EngineContext`
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`
- type `MergedFaceRange`
- type `MergedMeshGroup`
- type `PackedMeshInput`

---

## `World/Chunk/Meshing/MergedMeshManager.ts` (1422 LOC)

### export class MergedMeshMeta

**Properties**
- `chunkOffsets: Float32Array | null = null`
- `chunkOffsetsArray: number[] | null = null`
- `isMerged`
- `__lodLevel`

**Module-level functions**
- `function disposeGroupMesh(mesh: Mesh): void`
- `export function consumeGroupsMutated(): boolean`
- `function clearDiscardedGroup(group: MergedMeshGroup): void`

**Types / Interfaces / Enums**
- interface `ChunkMemberData`

---

## `World/Chunk/Meshing/PackedChunkMesh.ts` (1536 LOC)

**Module-level functions**
- `function freeFaces(arenaIndex: number, base: number, count: number): void`
- `function freeOffsetBlock(base: number): void`
- `function allocOffsetBlock(): number`
- `function largestHoleFaces(a: FaceArena): number`
- `function compactEntryCompare(a: CompactEntry, b: CompactEntry): number`
- `function compactArena(index: number): boolean`
- `function tryCompactFor(count: number): boolean`
- `function reportArenaExhaustion(count: number): void`
- `function growOffset(): void`
- `function uploadFaceRange(arena: number, base: number, count: number): void`
- `function writeBufferChunked(buffer: StorageBuffer, data: Uint32Array | Float32Array, dstByteOffset: number, srcElementOffset: number, elementCount: number): void`
- `export function registerPackedMaterial(material: ShaderMaterial): void`
- `function ensureFaceWordViews(state: PackedMeshState, input: PackedMeshInput): Uint32Array`
- `function packFaceRanges(state: PackedMeshState, input: PackedMeshInput, ranges: readonly MergedFaceRange[]): void`
- `function packFaces(state: PackedMeshState, input: PackedMeshInput): void`
- `function packOffsets(state: PackedMeshState, input: PackedMeshInput): void`
- `export function createPackedChunkMesh(input: PackedMeshInput): Mesh | null`
- `export function updatePackedChunkMesh(mesh: Mesh, input: PackedMeshInput, dirtyRanges?: readonly MergedFaceRange[] | null): Mesh`
- `export function setChunkMeshesVisible(visible: boolean): boolean`
- `export function disposePackedMesh(mesh: Mesh): void`
- `export function destroyPackedArenas(): void`
- `export function getPackedMeshMemoryStats()`
- `export function getPackedUploadStats()`
- `export function getTotalFaceUploadBytes(): number`
- `export function resetPackedUploadStats(): void`

**Types / Interfaces / Enums**
- interface `CompactEntry`
- type `EngineContext`
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`
- type `StorageBuffer`
- type `BuildGroupFn`

---

## `World/Chunk/Runtime/ChunkCensus.ts` (74 LOC)

**Module-level functions**
- `export function getChunkCensus(chunks: Iterable<CensusChunk>, lodCount: number): ChunkCensus`

**Types / Interfaces / Enums**
- interface `CensusMeshData`
- interface `CensusLODMesh`
- interface `CensusChunk`
- interface `ChunkCensus`

---

## `World/Chunk/Runtime/ChunkConnectivity.ts` (145 LOC)

**Module-level functions**
- `function premarkOpaque(blocks: Uint8Array | Uint16Array, paletteOpacity: Uint8Array | null, visited: Uint8Array): void`
- `function computeConnectivity(visited: Uint8Array, stack: Int32Array, faceCounts: Uint16Array): number`
- `export function computeStoredFaceConnectivity(blocks: Uint8Array | Uint16Array, paletteOpacity: Uint8Array | null): number`

---

## `World/Chunk/Runtime/ChunkConnectivityQueue.ts` (7 LOC)

**Module-level functions**
- `export function queueConnectivityRecompute(chunk: Chunk): void`

---

## `World/Chunk/Runtime/ChunkEditBatching.ts` (138 LOC)

### class LightMutationBuffer

**Properties**
- `private data`
- `length`

**Methods**
- `push(x: number, y: number, z: number, oldPacked: number, newPacked: number): void`
- `payload(): Uint32Array`
- `private grow(required: number): void`

**Module-level functions**
- `function flush(pool: ChunkLightPool | null): void`
- `export function beginChunkEditBatch(): void`
- `export function endChunkEditBatch(pool: ChunkLightPool | null): void`
- `export function markChunkDirtyForRemesh(chunk: Chunk | null | undefined): void`
- `export function recordLightMutation(chunk: Chunk, pool: ChunkLightPool | null, x: number, y: number, z: number, oldPacked: number, newPacked: number): void`
- `export function discardChunkEditState(chunk: Chunk): void`

**Types / Interfaces / Enums**
- interface `LightMutation`
- interface `LightMutationBatch`
- interface `ChunkLightPool`

---

## `World/Chunk/Runtime/ChunkMeshDisposal.ts` (53 LOC)

**Module-level functions**
- `function drain(): void`
- `function afterWait(): void`
- `function onWaitError(error: unknown): void`
- `function schedule(): void`
- `export function deferMeshDisposal(mesh: Mesh): void`
- `export function deferChunkMeshes(scene: Parameters<typeof removeFromScene>[0], opaque: Mesh | null, water: Mesh | null, cutout: Mesh | null): void`

---

## `World/Chunk/Runtime/ChunkPool.ts` (10 LOC)

**Module-level functions**
- `export function takePooledChunk(): Chunk | undefined`
- `export function releasePooledChunk(chunk: Chunk): void`

---

## `World/Chunk/Runtime/ChunkRegistry.ts` (87 LOC)

**Module-level functions**
- `function inNumericRange(x: number, y: number, z: number): boolean`
- `export function invalidateFastChunkCache(chunk: Chunk): void`
- `export function registerChunk(chunk: Chunk): void`
- `export function unregisterChunk(chunk: Chunk): void`
- `export function getChunkFast(x: number, y: number, z: number): Chunk | undefined`

---

## `World/Chunk/Runtime/ChunkSunlight.ts` (106 LOC)

**Module-level functions**
- `export function seedSunlight(chunk: SunlightChunk, aboveChunk: SunlightChunk | undefined, light: Uint8Array, blocks: Uint8Array | Uint16Array | null, palette: Uint16Array | null, isUniform: boolean, uniformBlockId: number, canReadBlocks: boolean)`

**Types / Interfaces / Enums**
- interface `SunlightChunk`

---

## `World/Chunk/Runtime/NeighborHelpers.ts` (60 LOC)

**Module-level functions**
- `export function hasStableVoxelNeighborsForCachedMesh(chunk: Chunk): boolean`

---

## `World/Chunk/Simulation/BlockTickScheduler.ts` (116 LOC)

---

## `World/Chunk/Simulation/WaterSimulation.ts` (574 LOC)

### export class WaterSimulation

**Module-level functions**
- `function getDefaultInstance(): WaterSimulation`
- `export function processWaterUpdate(worldX: number, worldY: number, worldZ: number): void`
- `export function scheduleWaterNeighborUpdate(worldX: number, worldY: number, worldZ: number): void`
- `export function scheduleBlockBreakWaterUpdates(worldX: number, worldY: number, worldZ: number): void`
- `export function scheduleBlockPlaceWaterUpdates(worldX: number, worldY: number, worldZ: number, blockId: number): void`
- `export function checkNewInfiniteSource(worldX: number, worldY: number, worldZ: number): void`

---

## `World/Chunk/Worker/chunk.worker.ts` (372 LOC)

**Module-level functions**
- `function _registerFromBoth(meta: {
		seq: number;
		chunkId: bigint;
		chunkX: number;
		chunkY: number;
		chunkZ: number;
		headerSlot: number;
	}, voxel: PendingVoxelData): void`
- `function _handleChannelMessage(event: MessageEvent): void`
- `function sharedU8(len: number): Uint8Array`
- `function sharedU16(len: number): Uint16Array`
- `function compressBlocks(blocks: Uint8Array)`

**Types / Interfaces / Enums**
- interface `PendingVoxelData`
- type `LightRegisterChunkBatchRequest`
- type `LightRegisterChunkRequest`

---

## `World/Chunk/Worker/ChunkLightHeader.ts` (103 LOC)

**Module-level functions**
- `function rowBase(slot: number): number`
- `function packMeta(flags: number, uniformBlockId: number): number`
- `function chunkIdLow32(chunkId: bigint): number`
- `function chunkIdHigh32(chunkId: bigint): number`
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

## `World/Chunk/Worker/ChunkMesherConstants.ts` (86 LOC)

**Module-level functions**
- `export function filtersFullSunlight(blockId: number): boolean`

---

## `World/Chunk/Worker/chunkWorker.ts` (637 LOC)

### export class ChunkWorker

**Properties**
- `private terrainWorker: Worker`
- `private voxelWorker: Worker`
- `private distantTerrainSharedInitialized`
- `private lightSharedInitialized`
- `private readonly _lightMutateMsg: LightMutateRequest = { type: WorkerTaskType.LightMutate, chunkId: 0n, headerSlot: 0, x: 0, y: 0, z: 0, oldPacked: 0, newPacked: 0, seq: 0, }`
- `private readonly _lightEmissionMsg: LightAddEmissionRequest = { type: WorkerTaskType.LightAddEmission, chunkId: 0n, headerSlot: 0, x: 0, y: 0, z: 0, level: 0, seq: 0, }`
- `private readonly _lightSkyReconcileMsg: LightSkyReconcileRequest = { type: WorkerTaskType.LightSkyReconcile, chunkId: 0n, headerSlot: 0, seq: 0, }`
- `private readonly _lightPropagateMsg: LightPropagateDeferredRequest = { type: WorkerTaskType.LightPropagateDeferred, chunkId: 0n, headerSlot: 0, seedQueue: new Uint16Array(0), seedLength: 0, seq: 0, }`
- `borderSkirtSides: 0,`
- `borderSkirtNearInset: 0,`
- `uniformBlockId: undefined,`

**Module-level functions**
- `function lodStepOfLod(lod: number | null | undefined): number`
- `export function computeBorderSkirtMasks(chunk: Chunk): number`

**Types / Interfaces / Enums**
- type `GenerateDistantTerrainRequest`
- type `GenerateFarTileRequest`
- type `GenerateFullMeshRequest`
- type `GenerateTerrainRequest`
- type `InitDistantTerrainSharedRequest`
- type `InitLightSharedRequest`
- type `LightAddEmissionRequest`
- type `LightMutateRequest`
- type `LightPropagateDeferredRequest`
- type `LightRegisterChunkBatchRequest`
- type `LightRegisterChunkRequest`
- type `LightSetClosedFaceMaskRequest`
- type `LightSkyReconcileRequest`
- type `LightUpdateChunkBuffersRequest`
- type `MeshWorkerResponse`
- type `RelightMeshRequest`
- type `SetWorldSeedRequest`
- type `VoxelRecycleBuffersRequest`
- type `VoxelRegisterChunkBatchRequest`
- type `VoxelRegisterChunkRequest`
- type `VoxelUpdateChunkBuffersRequest`
- type `WorkerResponseData`

---

## `World/Chunk/Worker/LightCore.ts` (1467 LOC)

### export class DirtySlotSet

**Properties**
- `private readonly stamps`
- `private readonly touched`
- `private epoch`
- `private count`

**Accessors**
- `get size(): number`

**Methods**
- `clear(): void`
- `add(slot: number): void`
- `next(): IteratorResult<number>`
- `forEach(fn: (slot: number) => void): void`

### class LightQueue

**Module-level functions**
- `function getClosedFaceMaskForPacked(packed: number): number`
- `export function applyClosedFaceMaskLUT(lut: Uint8Array): void`
- `function isTransparent(packed: number, axis: number, dir: number): boolean`
- `function tryRaiseLightByte(view: ChunkView, idx: number, isSky: boolean, nextLevel: number): boolean`
- `function clearLightByte(view: ChunkView, idx: number, isSky: boolean): boolean`
- `function processSkyQueue(registry: ChunkViewRegistry, q: LightQueue, dirtySlots: DirtySlotSet): void`
- `function processBlockQueue(registry: ChunkViewRegistry, q: LightQueue, dirtySlots: DirtySlotSet): void`
- `function processRemoveSkyQueue(registry: ChunkViewRegistry, q: LightQueue, dirtySlots: DirtySlotSet, initialOldPacked?: number): void`
- `function processRemoveBlockQueue(registry: ChunkViewRegistry, q: LightQueue, dirtySlots: DirtySlotSet, initialOldPacked?: number): void`
- `export function lightMutate(registry: ChunkViewRegistry, headerSlot: number, x: number, y: number, z: number, oldPacked: number, _newPacked: number): DirtySlotSet`
- `function removeLightAt(registry: ChunkViewRegistry, view: ChunkView, x: number, y: number, z: number, startLevel: number, isSkyLight: boolean, dirtySlots: DirtySlotSet, oldPacked?: number): void`
- `function updateLightFromNeighborsAt(registry: ChunkViewRegistry, view: ChunkView, x: number, y: number, z: number, isSkyLight: boolean, dirtySlots: DirtySlotSet): void`
- `export function addLightAt(registry: ChunkViewRegistry, view: ChunkView, x: number, y: number, z: number, level: number, dirtySlots: DirtySlotSet): void`
- `function cutSkyLightBelowAt(registry: ChunkViewRegistry, view: ChunkView, x: number, y: number, z: number, dirtySlots: DirtySlotSet): void`
- `function seedSkyEdgePair(view: ChunkView, neighbor: ChunkView, axis: 0 | 1 | 2, selfEdge: number, nbrEdge: number, size: number, size2: number, u: number, v: number, count: number): number`
- `export function lightSkyReconcile(registry: ChunkViewRegistry, headerSlot: number): DirtySlotSet`
- `function batchPropagate(registry: ChunkViewRegistry, slots: Int32Array, coords: Int32Array, levels: Uint8Array, count: number, dirty: DirtySlotSet): DirtySlotSet`
- `function tryReconcileOneDir(srcView: ChunkView, srcIdx: number, srcSlot: number, srcLevel: number, tgtView: ChunkView, tgtIdx: number, tgtLevel: number, axis: 0 | 1 | 2, outDir: number, u: number, v: number, edge: number): void`
- `export function lightBlockReconcile(registry: ChunkViewRegistry, headerSlot: number): DirtySlotSet`
- `export function propagateDeferred(registry: ChunkViewRegistry, headerSlot: number, seedState: { queue: Uint16Array; length: number }): DirtySlotSet`
- `export function bumpLightVersion(registry: ChunkViewRegistry, slot: number): void`

**Types / Interfaces / Enums**
- type `LightHeaderView`
- type `ChunkView`
- type `ChunkViewRegistry`

---

## `World/Chunk/Worker/LightTaskHandlers.ts` (354 LOC)

**Module-level functions**
- `function viewForBuffer(sab: SharedArrayBuffer, bytesPerElement: 1 | 2, length: number): Uint8Array | Uint16Array`
- `function getLoadedView(registry: ChunkViewRegistry, headerSlot: number, chunkId: bigint)`
- `function ensureState(req: InitLightSharedRequest | null): ChunkViewRegistry`
- `function postDirty(seq: number, dirtySlots: DirtySlotSet, registry: ChunkViewRegistry): void`
- `function handleInitLightShared(req: InitLightSharedRequest): void`
- `function handleSetClosedFaceMask(req: LightSetClosedFaceMaskRequest): void`
- `function registerChunkFields(fields: LightRegisterChunkFields): void`
- `function handleRegisterChunk(req: LightRegisterChunkRequest): void`
- `function handleRegisterChunkBatch(req: LightRegisterChunkBatchRequest): void`
- `function handleUnregisterChunk(req: LightUnregisterChunkRequest): void`
- `function handleUnregisterChunkBatch(req: LightUnregisterChunkBatchRequest): void`
- `function handleUpdateBuffers(req: LightUpdateChunkBuffersRequest): void`
- `function handleMutate(req: LightMutateRequest): void`
- `export function handleMutateBatch(req: LightMutateBatchRequest): void`
- `function handleAddEmission(req: LightAddEmissionRequest): void`
- `function handleSkyReconcile(req: LightSkyReconcileRequest): void`
- `function handlePropagateDeferred(req: LightPropagateDeferredRequest): void`

**Types / Interfaces / Enums**
- type `LightRegisterChunkFields`

---

## `World/Chunk/Worker/voxel.worker.ts` (831 LOC)

**Module-level functions**
- `function touchRelightEntry(chunkId: bigint, entry: RelightCacheEntry): void`
- `function resetMeshOut(): void`
- `function buildVoxelMeshFromInput(input: WorkerMeshInput, size: number, lod: number, grids?: PaddedGrids, skipBlockFill = false): void`
- `function takePooledMeshBuffer(byteLength: number): Uint8Array | null`
- `function givePooledMeshBuffer(buf: Uint8Array): void`
- `function copyMeshBytes(source: Uint8Array, target: Uint8Array, byteLength: number): void`
- `function fillMeshBuffer(rta: ResizableTypedArray<Uint8Array>, byteLength: number): Uint8Array`
- `function postRelightMiss(chunkId: bigint, meshRevision: number, lod: number): void`
- `function takeTransferableOutput(data: WorkerInternalMeshData): MeshData | null`
- `function postMeshResponse(chunkId: bigint, meshRevision: number, lod: number): void`

**Types / Interfaces / Enums**
- type `PaddedGrids`
- type `WorkerMeshInput`
- type `FullMeshMessage`
- type `GenerateFullMeshRequest`
- type `RelightMeshMissMessage`
- type `RelightMeshRequest`
- type `VoxelRecycleBuffersRequest`
- type `VoxelRegisterChunkBatchRequest`
- type `VoxelRegisterChunkRequest`
- type `VoxelUnregisterChunkBatchRequest`
- type `VoxelUnregisterChunkRequest`
- type `VoxelUpdateChunkBuffersRequest`
- type `VoxelWorkerRequest`
- type `RelightCacheEntry`

---

## `World/Chunk/Worker/WorkerTaskHandlers.ts` (245 LOC)

**Module-level functions**
- `function createEmptyTransferables(): Transferable[]`
- `export function handleGenerateTerrain(request: GenerateTerrainRequest, deps: TerrainHandlerDependencies)`
- `export function handleInitDistantTerrainShared(request: InitDistantTerrainSharedRequest)`
- `export function handleGenerateDistantTerrain(request: GenerateDistantTerrainRequest)`
- `export function handleGenerateFarTile(request: GenerateFarTileRequest)`
- `function appendTransferable(transferables: Transferable[], index: number, view: ArrayBufferView | null | undefined, label: string): number`

**Types / Interfaces / Enums**
- type `DistantTerrainGeneratedMessage`
- type `FarTileGeneratedMessage`
- type `GenerateDistantTerrainRequest`
- type `GenerateFarTileRequest`
- type `GenerateTerrainRequest`
- type `TerrainGeneratedMessage`
- type `MeshBuilderLike`
- type `DistantTerrainGenerateOutput`
- type `CompressBlocksFn`
- type `TerrainHandlerDependencies`
- type `InitDistantTerrainSharedRequest`

---

## `World/Collision/VoxelAabbCollider.ts` (486 LOC)

### export class VoxelAabbCollider

**Constructor**
- `constructor(halfExtents: Vec3, isSolidBlockAt: IsSolidBlockAt, epsilon = 0.001, debugOptions?: VoxelAabbDebugOptions)`

**Properties**
- `private readonly tmpPos`
- `private readonly tmpVoxelHit`
- `position: Vec3,`
- `halfExtents: Vec3,`
- `hitOut?: { x: number; y: number; z: number },`
- `x: hit.x,`
- `y: hit.y,`
- `z: hit.z,`

**Accessors**
- `public set HalfExtents(halfExtents: Vec3)`

**Methods**
- `addToScene(options.scene, this.#debugMesh)`
- `testShapeBoxOverlap(aMinX, aMaxX, aMinY, aMaxY, aMinZ, aMaxZ, eps, info.shape, info.rotation, info.slice, info.flipY, x, y, z)`
- `public overlaps(position: Vec3): boolean`
- `public overlapsXYZ(x: number, y: number, z: number): boolean`
- `public overlapsBox(position: Vec3, halfExtents: Vec3): boolean`
- `public wouldOverlapBlock(position: Vec3, blockX: number, blockY: number, blockZ: number, blockShape: {
			boxes: Array<{
				min: [number, number, number];
				max: [number, number, number];
			}>;
			rotateY: boolean;
			usesSliceState: boolean;
		}, rotation: number, slice: number, flipY: boolean): boolean`
- `public firstSolidVoxel(position: Vec3, halfExtents: Vec3)`
- `public firstSolidVoxelScratch(position: Vec3, halfExtents: Vec3)`
- `public moveAxis(position: Vec3, velocity: Vec3, axis: Axis, delta: number, stepSize: number): void`
- `public syncDebugMesh(position: Vec3): void`
- `public dispose(): void`
- `disposeMeshGpu(mesh)`
- `public static toggleDebugEnabled(): void`
- `public static setDebugEnabled(enabled: boolean): void`

**Module-level functions**
- `export function createVoxelColliderBlockSampler(resolveBlock: VoxelBlockResolver, deps: VoxelBlockSamplerDeps): (x: number, y: number, z: number) => BlockShapeInfo | null`
- `function testShapeBoxOverlap(aMinX: number, aMaxX: number, aMinY: number, aMaxY: number, aMinZ: number, aMaxZ: number, eps: number, shape: ShapeDefinition, rotation: number, slice: number, flipY: boolean, blockX: number, blockY: number, blockZ: number): boolean`

**Types / Interfaces / Enums**
- type `Mesh`
- type `SceneContext`
- type `Vec3`
- type `BlockShapeInfo`
- type `IsSolidBlockAt`
- type `VoxelAabbDebugOptions`
- type `VoxelBlockResolver`
- type `VoxelBlockSamplerDeps`

---

## `World/Collision/VoxelObbCollider.ts` (233 LOC)

**Types / Interfaces / Enums**
- type `Mesh`
- type `SceneContext`
- type `Vec3`
- type `IsSolidBlockAt`
- type `VoxelObbDebugOptions`

---

## `World/Explosion.ts` (227 LOC)

**Module-level functions**
- `function fadeFlashOverlay(): void`
- `function flashScreen(strength: number): void`
- `export function explode(cx: number, cy: number, cz: number, options: ExplodeOptions = {}): ExplosionResult`

**Types / Interfaces / Enums**
- interface `ExplodeOptions`
- interface `ExplosionResult`
- type `ChainIgniter`

---

## `World/ExplosionSim.ts` (156 LOC)

**Module-level functions**
- `export function tntBlastRadius(blockId: number): number | null`
- `export function explosionFalloff(distance: number, radius: number): number`
- `export function explosionDamage(distance: number, radius: number, maxDamage: number = TNT_MAX_DAMAGE): number`
- `export function blastMobDamages(mobs: ReadonlyArray<{ x: number; y: number; z: number }>, cx: number, cy: number, cz: number, radius: number, maxDamage: number = TNT_MAX_DAMAGE): number[]`

**Types / Interfaces / Enums**
- type `ExplosionTarget`
- type `ExplosionTargets`

---

## `World/FarTiles/FarTileFaceFormat.ts` (65 LOC)

**Module-level functions**
- `export function packWord1(w: number, h: number, axis: number, backFace: number): number`
- `export function decodeFarTileFace(faces: Uint32Array, faceIndex: number): DecodedFarTileFace`

**Types / Interfaces / Enums**
- interface `DecodedFarTileFace`

---

## `World/FarTiles/FarTileGenerator.ts` (551 LOC)

### class FaceWriter

**Module-level functions**
- `function sampleLatticeHeight(lattice: HeightLattice, localX: number, localZ: number): number`
- `export function generateFarTile(request: FarTileGenerateRequest): FarTileResult`
- `function stampTrees(out: FaceWriter, lattice: HeightLattice, originX: number, originZ: number, sizeBlocks: number, step: number, seaLevel: number): void`

**Types / Interfaces / Enums**
- interface `FarTileGenerateRequest`
- interface `FarTileResult`

---

## `World/FarTiles/FarTileLadder.ts` (84 LOC)

**Module-level functions**
- `function buildLadder(farDistance: number): FarTileLevelDef[]`
- `export function getFarTileLevels(): FarTileLevelDef[]`
- `export function isFarTilesEnabled(): boolean`
- `export function farTileReachBlocks(): number`
- `export function farTileOutermostRingChunks(): number`
- `export function levelForChunkDistance(chunkDist: number): number`
- `export function worldToTileCoord(worldBlock: number, tileSizeBlocks: number): number`

**Types / Interfaces / Enums**
- interface `FarTileLevelDef`

---

## `World/FarTiles/FarTileManager.ts` (1579 LOC)

**Module-level functions**
- `function packTileKey(levelIndex: number, tx: number, tz: number): number`
- `function writeFarFrustumPlane(out: Float32Array, off: number, nx: number, ny: number, nz: number, d: number): void`
- `function extractFarFrustumPlanes(vp: Mat4, out: Float32Array): void`
- `function syncThinInstanceCount(mesh: FarMeshLike, wm: WindingMesh): void`
- `function maxFarFacesPerArena(): number`

**Types / Interfaces / Enums**
- interface `EngineWithDevice`
- type `EngineContext`
- type `Mat4`
- type `Mesh`
- type `SceneContext`
- type `ShaderMaterial`
- type `StorageBuffer`

---

## `World/GLOBAL_VALUES.ts` (11 LOC)

---

## `World/Light/DistantTerrainShaderLite.ts` (223 LOC)

**Types / Interfaces / Enums**
- type `EngineContext`
- type `SceneContext`
- type `ShaderMaterial`
- type `Texture2D`

---

## `World/Light/FarTileShaderLite.ts` (442 LOC)

**Module-level functions**
- `export function bindFarTileBuffers(material: ShaderMaterial, faceBuffer: StorageBuffer, originsBuffer: StorageBuffer, frustumPlanesBuffer?: StorageBuffer | null): void`
- `export function createFarTileTerrainMaterial(opts: FarTileMaterialOptions): ShaderMaterial`
- `export function createFarTileWaterMaterial(nameSuffix?: string): ShaderMaterial`

---

## `World/Light/gpuBottleneckProbe.ts` (397 LOC)

**Module-level functions**
- `export function isGpuProbeSupported(engine: EngineContext): boolean`
- `export function isGpuProbeEnabled(): boolean`
- `export function isBisectRunning(): boolean`
- `export function getLastBisectSummary(): string`
- `export function setGpuProbeEnabled(engine: EngineContext, enabled: boolean): void`
- `export function cycleGpuProbe(engine: EngineContext, scene: SceneContext): string`
- `export function getGpuExecSnapshot(engine: EngineContext): GpuExecSnapshot`
- `export function getDrawnBucketFaces(countChunks: boolean, countFar: boolean)`
- `function sleep(ms: number): Promise<void>`
- `async function samplePhase(engine: EngineContext, label: string, countChunks: boolean, countFar: boolean): Promise<BisectPhaseResult>`
- `async export function runBucketBisect(engine: EngineContext, scene: SceneContext, visibility: BucketVisibility): Promise<BisectPhaseResult[] | null>`
- `async export function measureSceneOverdraw(engine: EngineContext, scene: SceneContext): Promise<string>`
- `export function isLiveSortEnabled(): boolean`
- `function bindingDepth(binding: SortableBinding, view: ArrayLike<number>): number`
- `function compareOpaqueFrontToBack(a: SortableBinding, b: SortableBinding): number`
- `function sortTaskFrontToBack(scene: SceneContext): void`
- `function getSortableSceneTask(scene: SceneContext): SortableTask | null`
- `export function setLiveSortEnabled(scene: SceneContext, enabled: boolean): void`

**Types / Interfaces / Enums**
- interface `GpuExecSnapshot`
- interface `BucketVisibility`
- interface `BisectPhaseResult`
- interface `FrameGraphWithTasks`
- interface `SortableBinding`
- interface `SortableTask`
- type `Camera`
- type `EngineContext`
- type `RenderTask`
- type `SceneContext`

---

## `World/Light/liteGpuBuffer.ts` (57 LOC)

**Module-level functions**
- `function deviceOf(engine: EngineContext): GPUDevice`
- `function ignoreGpuCompletion(): void`
- `export function onGpuWorkDone(engine: EngineContext): Promise<void>`
- `function updateGpuPressureFactor(): void`
- `export function publishGpuPressure(sampleMs: number): void`
- `export function getGpuPressureMs(): number`
- `export function getGpuPressureFactor(): number`
- `export function resetGpuPressure(): void`

**Types / Interfaces / Enums**
- interface `EngineWithDevice`

---

## `World/Light/Lod2ShaderLite.ts` (304 LOC)

**Module-level functions**
- `function baseUniforms(): readonly ShaderUniformOption[]`
- `function createLod2Material(name: string, opts: Lod2MaterialOptions, vertexOptions: PackedVertexOptions, fragmentSource: string, texture: Lod2MaterialOptions[                ], lutLabel: string, extra: {
		backFaceCulling: boolean;
		needAlphaBlending?: boolean;
		blendMode?:        ;
		depthWrite?: boolean;
	}): ShaderMaterial`
- `export function createLod2OpaqueMaterial(opts: Lod2MaterialOptions): ShaderMaterial`
- `export function createLod2CutoutMaterial(opts: Lod2MaterialOptions): ShaderMaterial`
- `export function createLod2TransparentMaterial(opts: Lod2MaterialOptions): ShaderMaterial`

**Types / Interfaces / Enums**
- interface `Lod2MaterialOptions`
- interface `PackedVertexOptions`
- type `EngineContext`
- type `SceneContext`
- type `ShaderMaterial`
- type `ShaderUniformOption`
- type `Texture2D`

---

## `World/Light/Lod3ShaderLite.ts` (321 LOC)

**Module-level functions**
- `function createLod3Material(name: string, opts: Lod3MaterialOptions, vertexOptions: Lod3VertexOptions, fragmentSource: string, texture: Lod3MaterialOptions[                ], lutLabel: string, renderOptions: Lod3MaterialRenderOptions): ShaderMaterial`
- `export function createLod3OpaqueMaterial(opts: Lod3MaterialOptions): ShaderMaterial`
- `export function createLod3CutoutMaterial(opts: Lod3MaterialOptions): ShaderMaterial`
- `export function createLod3TransparentMaterial(opts: Lod3MaterialOptions): ShaderMaterial`

**Types / Interfaces / Enums**
- interface `Lod3MaterialOptions`
- interface `Lod3VertexOptions`
- interface `Lod3MaterialRenderOptions`
- interface `StorageBufferDeclaration`
- type `EngineContext`
- type `SceneContext`
- type `ShaderMaterial`
- type `Texture2D`

---

## `World/Light/Lod4ShaderLite.ts` (238 LOC)

**Module-level functions**
- `function wgslFloat(value: number, fallback: number): string`
- `function tintLutWgsl(lut: Float32Array): string`
- `function makeOpaqueFragmentSource(lut: Float32Array): string`
- `function makeWaterFragmentSource(): string`
- `function normalizedArenaCount(value: number): number`
- `function createStorageBufferDeclarations(arenaCount: number): StorageBufferDeclaration[]`
- `function buildCommonMaterial(name: string, opts: Lod4MaterialOptions, fragmentSource: string, renderOptions: Lod4RenderOptions): ShaderMaterial`
- `export function createLod4OpaqueMaterial(opts: Lod4MaterialOptions): ShaderMaterial`
- `export function createLod4TransparentMaterial(opts: Lod4MaterialOptions): ShaderMaterial`

**Types / Interfaces / Enums**
- interface `StorageBufferDeclaration`
- interface `Lod4RenderOptions`
- interface `Lod4MaterialOptions`
- type `EngineContext`
- type `SceneContext`
- type `ShaderMaterial`
- type `Texture2D`

---

## `World/Light/OpaqueShaderLite.ts` (414 LOC)

**Module-level functions**
- `export function createChunkCutoutMaterial(opts: ChunkMaterialOptions): ShaderMaterial`

**Types / Interfaces / Enums**
- type `EngineContext`
- type `SceneContext`
- type `ShaderMaterial`
- type `ShaderUniformOption`
- type `Texture2D`
- type `VertexShaderOptions`

---

## `World/Light/PackedChunkShaderWGSL.ts` (397 LOC)

**Types / Interfaces / Enums**
- interface `VertexShaderOptions`

---

## `World/Light/SkyShaderLite.ts` (198 LOC)

**Module-level functions**
- `export function createSkyMaterial(): ShaderMaterial`

**Types / Interfaces / Enums**
- type `ShaderMaterial`

---

## `World/MeshPipeline/core/AOPipeline.ts` (75 LOC)

**Module-level functions**
- `function getAOOpaqueLut(): Uint8Array`
- `export function computeAO(session: MeshBuildSession, faceX: number, faceY: number, faceZ: number, uAxis: number, vAxis: number): number`

---

## `World/MeshPipeline/core/BlockInfoCache.ts` (506 LOC)

**Module-level functions**
- `function canUseDenseCache(packed: number): boolean`
- `export function isGlassBlock(blockId: number): boolean`
- `export function getBlockTint(blockId: number): number`
- `export function getMaterialType(blockId: number): MaterialType`
- `function obtainFaceRect(): FaceRect`
- `function resetFaceRectPool(): void`
- `function clamp01(v: number): number`
- `function pushRect(rects: FaceRect[], u0: number, u1: number, v0: number, v1: number): void`
- `function doesRectUnionCoverUnitSquare(rects: FaceRect[]): boolean`
- `function doesTwoRectsCoverUnitSquare(a: FaceRect, b: FaceRect): boolean`
- `function doesRectUnionCoverUnitSquareGeneral(rects: FaceRect[]): boolean`
- `function computeClosedFaceMaskFromBoxes(boxes: readonly ShapeBounds[]): number`
- `function isFullCubeFromBoxes(shapeBoxCount: number, boxes: readonly ShapeBounds[]): boolean`
- `function isGreedyCompatibleFromShape(blockId: number, packedBlock: number, shapeInfo: BlockShapeInfo, boxes: readonly ShapeBounds[]): boolean`
- `function buildEntry(packed: number): number`
- `function getEntry(packed: number): number`
- `export function getFullBlockEntry(packed: number): number`
- `export function getCachedFlagsAndId(packed: number): number`
- `export function getFlagsFromCombined(combined: number): number`
- `export function getIdFromCombined(combined: number): number`
- `export function getCachedFlags(packed: number): number`
- `export function getCachedBlockId(packed: number): number`
- `export function getCachedIsCube(packed: number): boolean`
- `export function isGreedyCompatiblePackedBlock(packed: number): boolean`
- `export function getShapeInfo(packed: number): BlockShapeInfo`
- `export function getRuntimeShapeBoxes(packed: number): readonly ShapeBounds[]`

**Types / Interfaces / Enums**
- type `ShapeBounds`
- type `FaceRect`

---

## `World/MeshPipeline/core/CustomShapeEmitter.ts` (585 LOC)

**Module-level functions**
- `function parseBlockInto(packed: number, out: ParsedBlock): void`
- `function getFaceBit(axis: number, isBackFace: boolean): number`
- `function isWaterGlassInterface(curr: ParsedBlock, nbr: ParsedBlock): boolean`
- `function isBorderOutwardFace(x: number, y: number, z: number, size: number, axis: number, isBackFace: boolean): boolean`
- `function emitCrossShapeAtBlock(x: number, y: number, z: number, blockId: number, baseLight: number, materialType: MaterialType = MaterialType.Cutout, out: QuadBuffer): void`
- `function emitCrossDiagonalAtBlock(x: number, y: number, z: number, blockId: number, baseLight: number, materialType: MaterialType = MaterialType.Cutout, out: QuadBuffer): void`
- `function emitLOD2CrossBillboard(x: number, y: number, z: number, blockId: number, baseLight: number, materialType: MaterialType, out: QuadBuffer): void`
- `function emitBoxFace(session: MeshBuildSession, voxelX: number, voxelY: number, voxelZ: number, blockId: number, packedBlock: number, box: {
		min: [number, number, number];
		max: [number, number, number];
		faceMask: number;
	}, axis: number, isBackFace: boolean, baseLight: number, out: QuadBuffer): void`

**Types / Interfaces / Enums**
- type `ParsedBlock`
- type `FaceDescriptor`

---

## `World/MeshPipeline/core/GreedyPipeline.ts` (116 LOC)

**Module-level functions**
- `export function greedyMesh(session: MeshBuildSession, extractMask: MaskExtractor | null, emitFace: FaceEmitterCallback, maskBank?: Int32Array, lightBank?: Uint16Array): void`

**Types / Interfaces / Enums**
- type `WritableNumberArray`
- type `MaskExtractor`
- type `FaceEmitterCallback`

---

## `World/MeshPipeline/core/LightPipeline.ts` (26 LOC)

**Module-level functions**
- `export function quantizeNibble(v: number): number`
- `export function quantizeByteForLOD(light: number): number`
- `export function quantizeLightForLOD(packed: number, disableAO: boolean): number`

---

## `World/MeshPipeline/core/LodBorderSkirts.ts` (345 LOC)

**Module-level functions**
- `function emitBorderColumn(session: MeshBuildSession, out: QuadBuffer, slot: number, col: number, cx: number, cz: number, axis: number, back: number, qx: number, qz: number, span: number, depth: number, face: FaceName): void`

---

## `World/MeshPipeline/core/MeshEmitters.ts` (45 LOC)

**Module-level functions**
- `export function reserveMeshCapacity(out: WorkerInternalMeshData, maxQuads: number): void`

---

## `World/MeshPipeline/core/QuadBuffer.ts` (306 LOC)

### export class QuadBuffer

**Properties**
- `private count`

**Methods**
- `public bind(out: WorkerInternalMeshData): void`
- `public finish(): void`
- `private emitRaw(sx: number, sy: number, sz: number, axisFace: number, sw: number, sh: number, tx: number, ty: number, ao: number, light: number, tint: number, meta: number): void`
- `public emitQuad(x: number, y: number, z: number, axis: number, width: number, height: number, blockId: number, backFace: number, light: number, ao: number, faceName: FaceName, materialType: number, flip: number, diagonal: number, rawDim: number): void`
- `public emitCubeQuadUnchecked(x: number, y: number, z: number, axis: number, width: number, height: number, blockId: number, backFace: number, light: number, ao: number, faceName: FaceName, rawDim: number): void`
- `public emitQuadRawUnits(x: number, y: number, z: number, axis: number, width: number, height: number, blockId: number, backFace: number, light: number, ao: number, faceName: FaceName): void`
- `public emitQuadUnchecked(x: number, y: number, z: number, axis: number, width: number, height: number, blockId: number, backFace: number, light: number, ao: number, faceName: FaceName, materialType: number, flip: number, diagonal: number, rawDim: number): void`
- `public emitWaterQuad(x: number, y: number, z: number, axis: number, width: number, height: number, blockId: number, backFace: number, light: number, ao: number, faceName: FaceName, materialType: number, packedBlock: number): void`

---

## `World/MeshPipeline/core/VoxelFaceEmitterAdapter.ts` (395 LOC)

### export class VoxelFaceEmitterAdapter

**Constructor**
- `constructor(session: MeshBuildSession)`

**Properties**
- `private readonly _session: SplitTransparentSession`

**Methods**
- `public emitVoxelFace(axis: number, desc: GreedyFaceDescriptor): void`
- `private emitCubeFace(out: QuadBuffer, axis: number, desc: GreedyFaceDescriptor, _packedBlock: number, blockId: number, back: number, light: number, ao: number, faceName: FaceName, _faceBit: number): void`
- `private emitWaterFace(out: QuadBuffer, axis: number, desc: GreedyFaceDescriptor, packedBlock: number, blockId: number, back: number, light: number, ao: number, faceName: FaceName, _faceBit: number): void`
- `private emitCustomShapeFace(out: QuadBuffer, axis: number, desc: GreedyFaceDescriptor, packedBlock: number, blockId: number, back: number, light: number, ao: number, faceName: FaceName, faceBit: number): void`
- `private emitWaterCustomShapeFace(out: QuadBuffer, axis: number, desc: GreedyFaceDescriptor, packedBlock: number, blockId: number, back: number, light: number, ao: number, faceName: FaceName, faceBit: number): void`

**Module-level functions**
- `function needsRawDim(blockId: number, width: number, height: number): boolean`
- `function inlineOrigin(axis: number, back: number, desc: GreedyFaceDescriptor, step: number): void`

**Types / Interfaces / Enums**
- type `SplitTransparentSession`

---

## `World/MeshPipeline/core/VoxelGreedyAdapter.ts` (43 LOC)

**Types / Interfaces / Enums**
- type `EmitFaceCallback`

---

## `World/MeshPipeline/core/VoxelMaskExtractor.ts` (642 LOC)

**Module-level functions**
- `function isWaterAt(blockArr: Uint16Array, ps: number, ps2: number, x: number, y: number, z: number): boolean`

**Types / Interfaces / Enums**
- type `WritableNumberArray`

---

## `World/MeshPipeline/core/VoxelPipeline.ts` (13 LOC)

### export class VoxelPipeline

**Constructor**
- `constructor(private readonly session: MeshBuildSession)`

**Properties**
- `private greedy: VoxelGreedyAdapter`

**Methods**
- `public build(): void`

---

## `World/MeshPipeline/core/WorkerMeshHelpers.ts` (333 LOC)

**Module-level functions**
- `export function createEmptyWorkerInternalMeshData(): WorkerInternalMeshData`
- `export function toTransferableMeshData(data: WorkerInternalMeshData): MeshData`

**Types / Interfaces / Enums**
- type `WorkerMeshBaseContext`
- type `WorkerMeshInput`

---

## `World/MeshPipeline/types/MeshTypes.ts` (50 LOC)

**Types / Interfaces / Enums**
- interface `MeshContext`
- interface `EmitQuadParams`
- interface `BlockShapeInfo`
- interface `GreedyFaceDescriptor`
- type `WorkerInternalMeshData`

---

## `World/MeshVisibility.ts` (36 LOC)

**Module-level functions**
- `function applyMeshVisibility(mesh: GatedMesh): void`
- `export function setMeshCulled(mesh: Mesh | null | undefined, culled: boolean): void`
- `export function setMeshBaseVisible(mesh: Mesh | null | undefined, base: boolean): void`
- `export function isMeshCulled(mesh: Mesh | null | undefined): boolean`
- `export function carryMeshCulled(from: Mesh | null | undefined, to: Mesh): void`

**Types / Interfaces / Enums**
- interface `GatedMesh`

---

## `World/Occlusion/GroupOctree.ts` (476 LOC)

**Module-level functions**
- `export function getOctreeGroupCount(): number`
- `export function getOctreeRootCount(): number`
- `export function groupMinX(gridX: number): number`
- `export function groupMinY(gridY: number): number`
- `export function groupMinZ(gridZ: number): number`
- `function rootKeyFor(rx: number, ry: number, rz: number): number`
- `function makeNode(minX: number, minY: number, minZ: number, size: number, depth: number): OctreeNode`
- `function childIndexFor(minX: number, minY: number, minZ: number, half: number, x: number, y: number, z: number): number`
- `export function aabbOutsidePlanes(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, packed: Float32Array, margin: number): boolean`
- `export function aabbInsidePlanes(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, packed: Float32Array, margin: number): boolean`
- `export function octreeInsert(group: OctreeGroupLike): void`
- `export function octreeRemove(group: OctreeGroupLike): void`
- `export function octreeClear(): void`

**Types / Interfaces / Enums**
- interface `OctreeGroupLike`
- interface `OctreeNode`
- interface `OctreeTraverseStats`
- enum `FrustumHint`

---

## `World/Occlusion/OcclusionCuller.ts` (759 LOC)

### export class OcclusionCuller

**Properties**
- `private _topoVisibleChunks: Chunk[] = []`
- `private _currentQueryId`
- `private _lastCompletedQueryId`
- `private _lastCamCX`
- `private _lastCamCY`
- `private _lastCamCZ`
- `private _topoDirtyFrameCount`
- `private static readonly TOPO_THROTTLE_FRAMES`
- `private _lastTotal`
- `private _lastOccluded`
- `private _bfsInProgress`
- `private _bfsQHead`
- `private _bfsQTail`
- `private _bfsOriginMissing`
- `vpChanged`
- `group: MergedMeshGroup,`
- `i: number,`
- `hint: FrustumHint,`
- `inFrustum`
- `inFrustum`
- `inFrustum`
- `inFrustum`
- `inFrustum`
- `vis`
- `bfsReachable`
- `bfsPrevious`
- `vis`

**Methods**
- `cacheFrustumPlanes(vp)`
- `aabbInFrustum(minGX, minGY, minGZ, maxGX, maxGY, maxGZ)`
- `setMeshCulled(group.opaqueMeshRef, !vis)`
- `setMeshCulled(group.waterMeshRef, !vis)`
- `setMeshCulled(group.cutoutMeshRef, !vis)`
- `traverseGroupOctree(_frustumPacked, FRUSTUM_MARGIN, camPos.x, camPos.y, camPos.z, (group, hint) => {
					processGroup(group as MergedMeshGroup, ordinal++, hint);
				})`
- `processGroup(allGroups[i], i, FrustumHint.INTERSECT)`

**Module-level functions**
- `function initFacePairTable(): void`
- `function cacheFrustumPlanes(vp: Mat4): void`
- `function aabbInFrustum(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean`
- `function getFStep(chunk: Chunk, face: number): number`
- `function setFStep(chunk: Chunk, face: number, value: number): void`
- `function ensureNeighborRefs(chunk: Chunk): void`
- `function minFSteps(chunk: Chunk): number`
- `function hasConnectivity(neighborVisited: number, exitFace: number, fc: number): boolean`

**Types / Interfaces / Enums**
- interface `OcclusionStats`
- type `MergedMeshGroup`

---

## `World/Pathfinding/Pathfinding.ts` (452 LOC)

**Module-level functions**
- `function hasClearance(x: number, z: number, groundY: number, headroom: number, allowWater: boolean): boolean`
- `function findWaterSurface(x: number, z: number, startY: number, searchUp: number, searchDown: number, result: SurfaceResult): SurfaceResult | null`
- `function hasPathfindingBudget(): boolean`
- `function consumePathfindingBudget(): void`
- `function fallbackSurface(out: SurfaceResult, groundY: number): SurfaceResult`
- `function buildPathInto(outPath: PathWaypoint[], endIndex: number): void`
- `export function findPathInto(outPath: PathWaypoint[], startX: number, startZ: number, startGroundY: number, targetX: number, targetZ: number, headroom: number, maxExpansions = 300, requiredTargetGroundY?: number): boolean`

**Types / Interfaces / Enums**
- interface `PathWaypoint`
- interface `SurfaceResult`

---

## `World/SETTINGS_PARAMS.ts` (46 LOC)

---

## `World/Shape/BlockShapes.ts` (343 LOC)

**Module-level functions**
- `function ensureShapeInit(): Promise<void>`
- `export function getShapeDefinitions(): ShapeDefinition[]`
- `export function getShapeByBlockId(): Uint16Array`
- `export function areShapesInitialized(): boolean`
- `export function isRegisteredBlockId(id: number | null): boolean`
- `export function getCubeShapeIndex(): number`
- `export function isCrossBlockId(blockId: number): boolean`
- `export function isCrossDiagonalBlockId(blockId: number): boolean`

**Types / Interfaces / Enums**
- type `ShapeBox`
- type `ShapeDefinition`
- type `RawShapeBox`
- type `RawShapeDefinition`
- type `RawBlockDefinition`
- type `BlockShapeMapResult`

---

## `World/Shape/BlockShapeTransforms.ts` (327 LOC)

**Module-level functions**
- `function getRelevantStateForShape(blockState: number, shape: {
		rotateY: boolean;
		allowFlipY: boolean;
		usesSliceState: boolean;
	}): number`

**Types / Interfaces / Enums**
- type `ShapeBounds`

---

## `World/Shape/FenceConnect.ts` (103 LOC)

**Module-level functions**
- `export function isFenceBlockId(blockId: number): boolean`
- `export function computeFenceNeighborMask(x: number, y: number, z: number, getBlock: GetBlockFn): number`
- `export function getFenceArmBoxes(mask: number): ShapeBox[]`
- `export function getFenceDynamicShape(mask: number): ShapeDefinition`

**Types / Interfaces / Enums**
- type `ShapeBox`
- type `ShapeDefinition`
- type `GetBlockFn`

---

## `World/SpawnPoint.ts` (189 LOC)

**Module-level functions**
- `function findTopGroundY(x: number, z: number, topY = MAX_SCAN_Y, bottomY = MIN_SCAN_Y): number`
- `export function getSpiralCandidates(centerX = 0, centerZ = 0, maxR = SEARCH_CHUNK_RADIUS)`
- `export function evaluateSpawnColumn(x: number, z: number): SpawnColumnEval`
- `export function buildPlatform(found: FoundSpawn): void`
- `export function createFallbackSpawn(centerX = 0, centerZ = 0): SpawnPosition`
- `export function getSpawnPosition(): SpawnPosition`
- `export function setSpawnPosition(p: SpawnPosition): void`
- `export function isSpawnPrepared(): boolean`
- `function trySpawnAt(x: number, z: number): FoundSpawn | null`

**Types / Interfaces / Enums**
- interface `SpawnPosition`
- interface `FoundSpawn`
- type `SpawnColumnEval`

---

## `World/Storage/blobCodec.worker.ts` (45 LOC)

**Module-level functions**
- `async function runCodec(codec: {
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<BufferSource>;
	}, bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array>`

---

## `World/Storage/BlobCompression.ts` (223 LOC)

### class CodecWorkerUnavailable extends Error

**Module-level functions**
- `function toPlainBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer>`
- `export function deflateSupported(): boolean`
- `async function runCodec(codec: {
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<BufferSource>;
	}, bytes: Uint8Array): Promise<Uint8Array>`
- `async export function deflate(bytes: Uint8Array): Promise<Uint8Array>`
- `function ensureCodecWorker(): Worker | null`
- `function codecWorkerRun(compress: boolean, bytes: Uint8Array): Promise<Uint8Array>`
- `async export function inflateInto(data: Uint8Array, outLen: number): Promise<Uint8Array>`
- `function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void`
- `function readUint32LE(bytes: Uint8Array, offset: number): number`
- `function frameRaw(bytes: Uint8Array): Uint8Array`
- `async export function compressBlob(bytes: Uint8Array): Promise<Uint8Array>`
- `export function frameDeflated(origLen: number, deflated: Uint8Array): Uint8Array`
- `async export function decompressBlob(bytes: Uint8Array): Promise<Uint8Array>`

**Types / Interfaces / Enums**
- type `PendingCodecRequest`

---

## `World/Storage/ChunkKey.ts` (53 LOC)

**Module-level functions**
- `export function unpackChunkKeyFast(key: number): readonly [number, number, number]`

---

## `World/Storage/LevelDbChunkStore.ts` (1613 LOC)

### export class CacheResetError extends Error implements ChunkStorage

**Constructor**
- `constructor(message =)`

**Properties**
- `readonly code`

**Methods**
- `super(message)`

### export class LevelDbChunkStore implements ChunkStorage

**Constructor**
- `constructor(worldName: string, basePath: string, maxCacheSize = 2048)`

**Properties**
- `private db: any = null`
- `private readonly isBrowser`
- `private readonly dbPath: string`
- `private opened`
- `private openPromise: Promise<void> | null = null`
- `private closing`
- `private closePromise: Promise<void> | null = null`
- `private readonly writeQueue: QueueEntry[] = []`
- `private writeQueueHead`
- `private writePumpRunning`
- `private pumpPromise: Promise<void> | null = null`
- `private flushTimer: ReturnType<typeof setTimeout> | null = null`
- `private pendingBarrierError: Error | null = null`
- `private visibilityHandler: (() => void) | null = null`
- `private readonly cache`
- `private readonly touched`
- `private readonly order: number[] = []`
- `private readonly orderIndex`
- `private hand`
- `private readonly maxCacheSize: number`
- `private readonly pendingDeletes`
- `private readonly pendingWrites`
- `private readonly pendingMeta`
- `private metaGeneration`
- `private readonly _hasMany: (keys: string[]) => Promise<Set<string>>`
- `private static readonly MAX_TRANSACTION_OPS`
- `private static readonly COALESCE_MS`
- `private readonly preparedJobsScratch: WriteJob[] = new Array( LevelDbChunkStore.MAX_TRANSACTION_OPS, )`
- `private readonly preparedOpsScratch: WriteOperation[] = new Array( LevelDbChunkStore.MAX_TRANSACTION_OPS, )`
- `private readonly _hasManyBrowser`
- `private readonly _hasManyNode`

**Accessors**
- `get cachedEntryCount(): number`
- `get isReady(): boolean`

**Methods**
- `async open(): Promise<void>`
- `private async openInternal(): Promise<void>`
- `private async openBrowser(): Promise<void>`
- `private async openNode(): Promise<void>`
- `close(): Promise<void>`
- `private async closeInternal(): Promise<void>`
- `async readChunk(cx: number, cy: number, cz: number, key?: string): Promise<Uint8Array | undefined>`
- `async readChunks(coords: readonly ChunkCoord[]): Promise<Map<string, Uint8Array>>`
- `async readChunksNumeric(coords: readonly ChunkCoord[]): Promise<Map<number, Uint8Array>>`
- `async hasChunk(cx: number, cy: number, cz: number, key?: string): Promise<boolean>`
- `async hasChunks(coords: readonly ChunkCoord[]): Promise<Set<string>>`
- `async hasChunksNumeric(coords: readonly ChunkCoord[]): Promise<Set<number>>`
- `async getMeta(key: string): Promise<string | null>`
- `async getMetaBytes(key: string): Promise<Uint8Array | undefined>`
- `writeChunk(cx: number, cy: number, cz: number, data: Uint8Array, key?: string, preCompressed?: boolean): Promise<void>`
- `writeChunks(writes: readonly ChunkWrite[]): Promise<void>`
- `deleteChunk(cx: number, cy: number, cz: number, key?: string): Promise<void>`
- `deleteChunks(coords: readonly ChunkCoord[]): Promise<void>`
- `flush(): Promise<void>`
- `clear(options: { discardPendingWrites?: boolean } = {}): Promise<void>`
- `setMeta(key: string, value: string): Promise<void>`
- `setMetaBytes(key: string, value: Uint8Array): Promise<void>`
- `deleteMeta(key: string): Promise<void>`
- `private enqueueMetaOp(storageKey: string, pendingValue: string | Uint8Array | null, operation: WriteOperation): Promise<void>`
- `private enqueueSingleWrite(operation: WriteOperation): Promise<void>`
- `private enqueueSingleWriteUnchecked(operation: WriteOperation): Promise<void>`
- `private enqueueWriteJob(operations: WriteOperation[]): Promise<void>`
- `private enqueueWriteJobUnchecked(operations: WriteOperation[]): Promise<void>`
- `private scheduleWritePump(): void`
- `private forceWritePump(): void`
- `private startWritePump(): void`
- `private async runWritePump(): Promise<void>`
- `private countAvailableOperations(limit = LevelDbChunkStore.MAX_TRANSACTION_OPS): number`
- `private skipCancelledEntries(): void`
- `private compactWriteQueue(): void`
- `private async drainWritePump(): Promise<void>`
- `private async commitNextTransaction(): Promise<void>`
- `private clearPreparedScratch(count: number): void`
- `private processBarrier(entry: {
		resolve: () => void;
		reject: (error: Error) => void;
	}): void`
- `private async processClear(entry: {
		resolve: () => void;
		reject: (error: Error) => void;
		metaGeneration: number;
	}): Promise<void>`
- `private async publishCommittedOperations(preparedJobs: readonly WriteJob[], preparedOps: readonly WriteOperation[], preparedCount: number): Promise<void>`
- `private settleFinishedJobs(): void`
- `private rejectAffectedJobs(preparedJobs: readonly WriteJob[], preparedCount: number, error: Error): void`
- `private rejectRemainingJobs(error: Error): void`
- `private resolveJob(job: WriteJob): void`
- `private rejectJob(job: WriteJob, error: Error): void`
- `private clearMetaShadowsThrough(generation: number): void`
- `private cancelFlushTimer(): void`
- `private async _getMany(keys: string[]): Promise<Map<string, Uint8Array>>`
- `private addToCache(key: number, data: Uint8Array): void`
- `private evictOne(): void`
- `private removeFromOrder(key: number): void`

### class IndexedDbStore

**Constructor**
- `constructor(private readonly dbName: string)`

**Properties**
- `private db: IDBDatabase | null = null`
- `private readonly storeName`

**Methods**
- `async open(): Promise<void>`
- `async close(): Promise<void>`
- `async get(key: string): Promise<Uint8Array | string | undefined>`
- `async put(key: string, value: Uint8Array | string): Promise<void>`
- `batch(): IndexedDbBatch`
- `async clear(): Promise<void>`
- `async has(keys: string[]): Promise<Set<string>>`
- `async getMany(keys: string[]): Promise<Array<Uint8Array | undefined>>`
- `private normalizeValue(value: unknown): Uint8Array | string | undefined`

### class IndexedDbBatch

**Constructor**
- `constructor(private readonly db: IDBDatabase, private readonly storeName: string)`

**Properties**
- `private readonly types: IndexedDbOperationType[] = []`
- `private readonly keys: string[] = []`
- `private readonly values: Array<Uint8Array | string | undefined> = []`
- `private readonly preCompressed: boolean[] = []`

**Methods**
- `put(key: string, value: Uint8Array | string, preCompressed = false): this`
- `del(key: string): this`
- `delete(key: string): this`
- `async write(): Promise<void>`

**Module-level functions**
- `export function chunkKey(cx: number, cy: number, cz: number): string`
- `export function packChunkKeyNumeric(cx: number, cy: number, cz: number): number`
- `export function numericKeyToChunkKey(key: number): string`
- `export function chunkKeyToNumeric(key: string): number`
- `export function isCacheResetError(error: unknown): error is CacheResetError`

**Types / Interfaces / Enums**
- interface `ChunkCoord`
- interface `ChunkReadCoord`
- interface `ChunkWrite`
- interface `ChunkStorage`
- type `WriteOperation`
- type `WriteJob`
- type `QueueEntry`
- type `PendingMeta`
- enum `WriteOperationKind`
- enum `QueueEntryKind`

---

## `World/Storage/MeshSerializer.ts` (134 LOC)

**Module-level functions**
- `function writeU32LE(buf: Uint8Array, off: number, val: number): void`
- `function readU32LE(buf: Uint8Array, off: number): number`
- `function serializedMeshLength(mesh: MeshData): number`
- `function writeSerializedMeshInto(out: Uint8Array, off: number, mesh: MeshData): number`
- `export function serializeMesh(mesh: MeshData | null | undefined): Uint8Array | null`
- `export function deserializeMesh(bytes: Uint8Array): MeshData`
- `export function serializeMeshPair(opaque: MeshData | null | undefined, transparent: MeshData | null | undefined): Uint8Array | null`
- `export function deserializeMeshPair(bytes: Uint8Array, lod: number): DeserializedMeshPair | null`

**Types / Interfaces / Enums**
- type `DeserializedMeshPair`

---

## `World/Storage/VoxelSerializer.ts` (323 LOC)

**Module-level functions**
- `function asBytes(value: Uint8Array | Uint16Array): Uint8Array`
- `function copyBytes(source: Uint8Array, sourceOffset: number, destination: Uint8Array): void`
- `function readU16LE(data: Uint8Array, offset: number): number`
- `function readU32LE(data: Uint8Array, offset: number): number`
- `function writeU16LE(data: Uint8Array, offset: number, value: number): void`
- `function writeU32LE(data: Uint8Array, offset: number, value: number): void`
- `export function serializeVoxelData(blocks: Uint8Array | Uint16Array | null, palette: Uint16Array | null | undefined, isUniform: boolean | undefined, uniformBlockId: number | undefined, lightArray: Uint8Array | null | undefined, compressed: boolean | undefined, version?: number): Uint8Array`
- `export function deserializeVoxelData(data: Uint8Array): SavedChunkData`
- `export function deserializeVoxelDataShared(data: Uint8Array): SavedChunkData`
- `export function serializeEntities(entities: SavedChunkEntityData[]): Uint8Array`
- `export function deserializeEntities(data: Uint8Array): SavedChunkEntityData[]`

**Types / Interfaces / Enums**
- interface `HydratedVoxelData`
- type `SavedChunkData`
- type `SavedChunkEntityData`

---

## `World/Texture/AtlasPacker.ts` (195 LOC)

**Module-level functions**
- `function mipLevelCount(w: number, h: number): number`
- `async function loadImageBitmap(url: string): Promise<ImageBitmap>`
- `function extractTile(src: Uint8ClampedArray, srcW: number, tx: number, ty: number): Uint8ClampedArray`
- `function flipY(data: Uint8ClampedArray, w: number, h: number): void`
- `function fillTransparentPixels(data: Uint8ClampedArray): void`
- `async function loadNormalTilesIntoArray(engine: EngineContext, url: string): Promise<Texture2DArray>`
- `async export function packAtlas(engine: EngineContext): Promise<`

---

## `World/Texture/BlockMaterial.ts` (76 LOC)

**Module-level functions**
- `export function isVirtualBlockId(blockId: number): boolean`
- `export function getSourceBlockId(blockId: number): number`
- `export function getVirtualBlockIdsForSource(sourceBlockId: number): number[]`
- `export function isGlassSourceId(sourceId: number): boolean`
- `export function isWaterSourceId(sourceId: number): boolean`
- `export function isGlassBlockId(blockId: number): boolean`
- `export function isWaterBlockId(blockId: number): boolean`
- `export function isTransparentBlockId(blockId: number): boolean`
- `export function isFullSunFilterBlockId(blockId: number): boolean`

---

## `World/Texture/BlockTextures.ts` (152 LOC)

**Module-level functions**
- `function writeDirect(blockId: number, col: number, row: number): void`
- `function buildBlockTextures(maxId: number, size: number): (BlockTextureDef | null)[]`
- `function createTileDef(col: number, row: number): BlockTextureDef`
- `function writePackedTiles(blockId: number, def: BlockTextureDef): void`
- `function getMaxBlockTypeId(): number`
- `function getTextureCapacity(maxBlockTypeId: number): number`
- `export function getVirtualBlockId(sourceBlockId: number, shape: string): number | null`
- `export function setBlockAtlasTile(blockId: number, col: number, row: number): void`
- `export function getAtlasTile(blockId: number | null): [number, number] | null`
- `export function getFaceAtlasTile(blockId: number | null, face: FaceName): [number, number] | null`

**Types / Interfaces / Enums**
- type `BlockTextureDef`
- type `MasonShape`

---

## `World/Texture/BlockType.ts` (149 LOC)

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

## `World/Texture/TextureAtlasFactory.ts` (43 LOC)

**Module-level functions**
- `export function getDiffuse(): Texture2D | null`
- `export function setDiffuse(texture: Texture2D)`
- `export function getNormal(): Texture2D | null`
- `export function setNormal(texture: Texture2D)`
- `export function getDiffuseTexture2D(): Texture2D | null`
- `export function setDiffuseTexture2D(texture: Texture2D)`
- `export function getDiffuseArray(): Texture2DArray | null`
- `export function setDiffuseArray(texture: Texture2DArray | null)`
- `export function getNormalArray(): Texture2DArray | null`
- `export function setNormalArray(texture: Texture2DArray | null)`

**Types / Interfaces / Enums**
- type `TileUV`

---

## `World/Texture/TextureCache.ts` (47 LOC)

**Module-level functions**
- `function getDB(): Promise<IDBDatabase>`
- `async export function getTextureCache(url: string): Promise<Blob | undefined>`
- `async export function putTextureCache(url: string, blob: Blob): Promise<void>`

---

## `World/Texture/TextureDefinitions.ts` (163 LOC)

**Module-level functions**
- `async function loadAndPublishBlockDefinitions(): Promise<TextureDefinition[]>`
- `async function loadBlockDefinitions(): Promise<TextureDefinition[]>`
- `async function loadBlockData(): Promise<unknown>`
- `function normalizeBlockData(data: unknown): TextureDefinition[]`
- `function normalizeBlockId(id: unknown): BlockType | null`
- `export function getBlockBreakTime(id: number, toolItemId?: number): number`
- `export function canHarvestBlock(id: number, toolItemId?: number): boolean`
- `export function getBlockRequiredLevel(id: number): MaterialTier | undefined`
- `export function getBlockInfo(id: number): TextureDefinition | undefined`

**Types / Interfaces / Enums**
- interface `TextureDefinition`
- type `MaterialTier`
- type `ToolKindId`

---

## `World/WorldContext.ts` (89 LOC)

**Module-level functions**
- `export function getStoredWorldSeed(worldName: string): string | null`
- `export function setStoredWorldSeed(worldName: string, seed: string): void`
- `export function removeStoredWorldSeed(worldName: string): void`
- `export function worldSeedFor(worldName: string): string`

---

## `World/WorldStorage.ts` (358 LOC)

### class WorldStorageImpl

**Properties**
- `private store: LevelDbChunkStore | null = null`
- `private initPromise: Promise<void> | null = null`

**Methods**
- `initialize(storeNameOverride?: string): Promise<void>`
- `private async getStore(): Promise<LevelDbChunkStore | null>`
- `async saveChunk(chunk: Chunk): Promise<void>`
- `async saveChunks(chunks: Chunk[]): Promise<void>`
- `async saveAllModifiedChunks(): Promise<void>`
- `async saveChunkEntities(chunkId: bigint, entities: SavedChunkEntityData[]): Promise<void>`
- `async loadChunkEntities(chunkId: bigint): Promise<SavedChunkEntityData[]>`
- `async loadChunk(chunkId: bigint, options?: LoadChunkOptions): Promise<SavedChunkData | null>`
- `async loadChunks(chunkIds: bigint[], options?: LoadChunkOptions, outMap?: Map<bigint, SavedChunkData>): Promise<Map<bigint, SavedChunkData>>`
- `async flush(): Promise<void>`
- `async saveSpawnPoint(p: SpawnPosition): Promise<void>`
- `async loadSpawnPoint(): Promise<SpawnPosition | null>`
- `async clearLocalChunkCache(): Promise<void>`

**Module-level functions**
- `function packChunkBlob(chunk: Chunk): Uint8Array | null`
- `function chunkIdToCoords(chunkId: bigint): [number, number, number]`
- `function chunkIdToCoordsOut(chunkId: bigint, out: ChunkCoordsOut): ChunkCoordsOut`

**Types / Interfaces / Enums**
- interface `ChunkCoordsOut`
- type `ChunkReadCoord`
- type `ChunkWrite`
- type `SavedChunkData`
- type `SavedChunkEntityData`
- type `LoadChunkOptions`

---
