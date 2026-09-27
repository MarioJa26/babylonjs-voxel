import { onBeforeRender, type SceneContext, type Vec3 } from "@babylonjs/lite";
import {
	MAYA_SEAL_HALF_EXTENT,
	type MayaGuardianPost,
	type MayaTempleLayout,
} from "../Generation/Structure/MayaTempleLayout";
import {
	buildTempleLayout,
	resolveTempleInRegion,
} from "../Generation/Structure/StructureSeal";
import { CHUNK_SIZE } from "../Lib/VoxelMath";
import { Map1 } from "../Maps/Map1";
import { Chunk } from "../World/Chunk/Chunk";
import { resolveBlockAtWorldCoords } from "../World/Chunk/ChunkLoadingSystem";
import { BlockType } from "../World/Texture/BlockType";
import { MAYA_GUARDIAN_MOB_TYPE, MayaGuardian } from "./Mobs/MayaGuardian";
import type { Mob } from "./Mobs/Mob";
import { Skeleton } from "./Mobs/Skeleton";
import { Zombie } from "./Mobs/Zombie";

// ---------------------------------------------------------------------------
// Populates Maya temple dungeons with guardians.
//
// Why this is not worldgen: IWorldFeature.generate() runs inside the chunk Web
// Worker with nothing but a PlaceBlockFn. It cannot construct a Mob, and a Mob
// that worldgen created would be destroyed anyway — SpawnCoordinator
// hard-despawns anything past 128 blocks from the player, and the chunk unload
// path serialises a deleted mob as an empty payload.
//
// The dungeon itself is described by MayaTempleLayout, which is pure and shared
// with worldgen: given a position, both sides independently derive the same
// rooms, guardian posts and loot caches. So there is nothing to persist for the
// encounter system. It watches the loaded chunk set for chunks that overlap a
// temple's seal, derives the layout, and owns the guardians from there. That
// self-heals across chunk loads, chunk unloads and save reloads without any
// stored state that could drift from the geometry worldgen actually wrote.
//
// Re-population: guardians within POPULATE_RADIUS of the player are alive, and
// guardians beyond DISPOPULATE_RADIUS are released. That is what makes a second
// run through the dungeon worth doing, and it also sidesteps
// SpawnCoordinator's 128-block despawn entirely.
// ---------------------------------------------------------------------------

/** Guardians further than this from the player are released. */
const DISPOPULATE_RADIUS = 96;
const DISPOPULATE_RADIUS_SQ = DISPOPULATE_RADIUS * DISPOPULATE_RADIUS;

/** Guardians nearer than this are (re)spawned. */
const POPULATE_RADIUS = 80;
const POPULATE_RADIUS_SQ = POPULATE_RADIUS * POPULATE_RADIUS;

/** How often the sweep runs (ms). */
const SWEEP_INTERVAL_MS = 1000;

/** Beyond this horizontal distance a temple is forgotten entirely. */
const RELEASE_RADIUS = MAYA_SEAL_HALF_EXTENT + 160;
const RELEASE_RADIUS_SQ = RELEASE_RADIUS * RELEASE_RADIUS;

/** Floor blocks a guardian may stand on. */
const VALID_FLOOR_BLOCKS = new Set<number>([
	BlockType.Cobblestone03,
	BlockType.StoneTileWall,
	BlockType.Obsidian,
	BlockType.BasaltBlock,
	BlockType.RedSandstoneWall,
	BlockType.AncientCrackedStone,
	BlockType.GravellySand,
]);

type ActiveTemple = {
	templeId: number;
	layout: MayaTempleLayout;
	/** Live guardians, keyed by their index in `layout.guards`. */
	mobs: Map<number, Mob>;
};

export class MayaDungeonEncounter {
	readonly #scene: SceneContext;
	readonly #getPlayerPosition: () => Vec3;
	readonly #seedAsInt: number;

	/** Temples whose dungeon intersects the currently loaded chunks. */
	readonly #active = new Map<number, ActiveTemple>();

	#lastSweep = -SWEEP_INTERVAL_MS;
	#disposed = false;

	constructor(
		scene: SceneContext,
		getPlayerPosition: () => Vec3,
		seedAsInt: number,
	) {
		this.#scene = scene;
		this.#getPlayerPosition = getPlayerPosition;
		this.#seedAsInt = seedAsInt;

		onBeforeRender(scene, () => this.#tick());
	}

	// -------------------------------------------------------------------------
	// Sweep
	// -------------------------------------------------------------------------

	#tick(): void {
		if (this.#disposed) return;

		const now = performance.now();
		if (now - this.#lastSweep < SWEEP_INTERVAL_MS) return;
		this.#lastSweep = now;

		this.#activateTemplesForLoadedChunks();
		this.#updatePopulations();
	}

	/**
	 * Any loaded chunk that overlaps a temple's seal activates that temple.
	 *
	 * `resolveTempleInRegion` is a handful of integer ops and is memoised
	 * against the active set, so walking the loaded chunk set once a second is
	 * far cheaper than maintaining a separate subscription to chunk load/unload.
	 */
	#activateTemplesForLoadedChunks(): void {
		for (const chunk of Chunk.loadedChunks) {
			const resolved = resolveTempleInRegion(
				chunk.chunkX,
				chunk.chunkZ,
				CHUNK_SIZE,
				this.#seedAsInt,
			);
			if (!resolved) continue;
			if (this.#active.has(resolved.templeId)) continue;

			// Cheap XZ reject before paying for the full layout build.
			const cx = chunk.chunkX * CHUNK_SIZE + CHUNK_SIZE / 2;
			const cz = chunk.chunkZ * CHUNK_SIZE + CHUNK_SIZE / 2;
			if (
				Math.abs(resolved.centerX - cx) > MAYA_SEAL_HALF_EXTENT + CHUNK_SIZE ||
				Math.abs(resolved.centerZ - cz) > MAYA_SEAL_HALF_EXTENT + CHUNK_SIZE
			) {
				continue;
			}

			this.#active.set(resolved.templeId, {
				templeId: resolved.templeId,
				layout: buildTempleLayout(resolved, this.#seedAsInt),
				mobs: new Map(),
			});
		}
	}

	#updatePopulations(): void {
		const playerPos = this.#getPlayerPosition();

		for (const [templeId, temple] of this.#active) {
			const dx = temple.layout.centerX - playerPos.x;
			const dz = temple.layout.centerZ - playerPos.z;
			if (dx * dx + dz * dz > RELEASE_RADIUS_SQ) {
				this.#releaseTemple(temple);
				this.#active.delete(templeId);
				continue;
			}
			this.#populateNear(temple, playerPos);
		}
	}

	#populateNear(temple: ActiveTemple, playerPos: Vec3): void {
		const { layout, mobs } = temple;

		for (let i = 0; i < layout.guards.length; i++) {
			const post = layout.guards[i];
			const dx = post.x - playerPos.x;
			const dy = post.y - playerPos.y;
			const dz = post.z - playerPos.z;
			const distSq = dx * dx + dy * dy + dz * dz;

			const existing = mobs.get(i);
			if (existing && !existing.isDisposed) {
				// A living guardian inside the release radius stays. One that
				// wandered further out is dropped, and re-created below if the
				// player is still close enough to want it.
				if (distSq <= DISPOPULATE_RADIUS_SQ) continue;
				existing.dispose();
				mobs.delete(i);
			}

			if (distSq > POPULATE_RADIUS_SQ) continue;

			const mob = this.#createGuardian(post, playerPos);
			if (mob) mobs.set(i, mob);
		}
	}

	/**
	 * Instantiate one guardian. Returns null when the post is not actually
	 * standable — a room can be flooded or the player may have mined the floor,
	 * and spawning a mob inside stone is worse than spawning nothing.
	 */
	#createGuardian(post: MayaGuardianPost, playerPos: Vec3): Mob | null {
		const standY = this.#findStandableY(post.x, post.y, post.z);
		if (standY === null) return null;

		let mob: Mob;
		if (post.boss) {
			const guardian = new MayaGuardian(post.x, standY, post.z, this.#scene);
			// Dungeon mobs are not natural spawns, so they must not consume the
			// natural mob cap the surface spawner enforces.
			guardian.countsTowardMobCap = false;
			mob = guardian;
		} else if (post.mobType === "skeleton") {
			const skeleton = new Skeleton(post.x, standY, post.z, this.#scene);
			skeleton.countsTowardMobCap = false;
			mob = skeleton;
		} else {
			const zombie = new Zombie(post.x, standY, post.z, this.#scene);
			zombie.countsTowardMobCap = false;
			mob = zombie;
		}

		mob.setPlayerPosition(playerPos);
		Map1.mobRegistry?.addMob(mob);
		return mob;
	}

	/**
	 * Find a Y at or just below the post where a mob can actually stand. Reads
	 * the live world rather than trusting the layout, so mined or flooded rooms
	 * degrade gracefully instead of spawning mobs in rock.
	 */
	#findStandableY(x: number, y: number, z: number): number | null {
		for (let dy = 0; dy >= -2; dy--) {
			const probeY = y + dy;
			const below = resolveBlockAtWorldCoords(x, probeY - 1, z);
			if (below === null || !VALID_FLOOR_BLOCKS.has(below.blockId)) continue;
			const feet = resolveBlockAtWorldCoords(x, probeY, z);
			const head = resolveBlockAtWorldCoords(x, probeY + 1, z);
			if (feet?.blockId === BlockType.Air && head?.blockId === BlockType.Air) {
				return probeY;
			}
		}
		return null;
	}

	#releaseTemple(temple: ActiveTemple): void {
		for (const mob of temple.mobs.values()) {
			if (!mob.isDisposed) mob.dispose();
		}
		temple.mobs.clear();
	}

	dispose(): void {
		this.#disposed = true;
		for (const temple of this.#active.values()) this.#releaseTemple(temple);
		this.#active.clear();
	}

	/** How many guardians a temple currently has alive. */
	getLiveGuardianCount(templeId: number): number {
		const temple = this.#active.get(templeId);
		if (!temple) return 0;
		let count = 0;
		for (const mob of temple.mobs.values()) {
			if (!mob.isDisposed) count++;
		}
		return count;
	}

	/** Live boss, if one is currently instantiated. Drives the boss HUD. */
	getLiveBoss(): MayaGuardian | null {
		for (const temple of this.#active.values()) {
			for (const mob of temple.mobs.values()) {
				if (mob.isDisposed) continue;
				if (mob.mobType === MAYA_GUARDIAN_MOB_TYPE) {
					return mob as MayaGuardian;
				}
			}
		}
		return null;
	}
}

let _encounter: MayaDungeonEncounter | null = null;

/** Idempotent; safe to call from the scene setup path. */
export function createMayaDungeonEncounter(
	scene: SceneContext,
	getPlayerPosition: () => Vec3,
	seedAsInt: number,
): MayaDungeonEncounter {
	_encounter ??= new MayaDungeonEncounter(scene, getPlayerPosition, seedAsInt);
	return _encounter;
}

export function getMayaDungeonEncounter(): MayaDungeonEncounter | null {
	return _encounter;
}
