import { BlockType } from "../../World/Texture/BlockType";
import type { Biome } from "../Biome/BiomeTypes";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import type { IWorldFeature } from "./IWorldFeature";
import {
	MINESHAFT_CELL_HEIGHT,
	MINESHAFT_GRID_SPAN,
	MINESHAFT_MIN_FLOOR_Y,
	type MineshaftLayout,
	type MineshaftRect,
} from "./MineshaftLayout";
import {
	buildMineshaftLayoutAt,
	MINESHAFT_REGION,
	resolveMineshaftInRegion,
} from "./MineshaftSeal";
import { chunkWorldBounds } from "./RegionFeature";

// ---------------------------------------------------------------------------
// The worldgen half of the mineshaft.
//
// All geometry comes from MineshaftLayout, which is shared with the cave seal
// and the loot resolver. This file only writes blocks.
//
// BLOCK PALETTE
//
// Two constraints decide every id used here:
//
//   1. No light-emitting block. LightGenerator's emission LUT covers 10
//      (BarkWillow02), 11 (DiagonalParquet), 24 (MetalGrateRusty) and 94
//      (Torch). The previous version of this feature used id 10 for its
//      support timbers, so the shaft lit itself — the exact opposite of what a
//      mineshaft should be. MINESHAFT_LIGHT_EMITTERS is exported so the
//      selftest can assert none of them is ever placed.
//
//   2. No ore-host block. OreGenerator replaces ids 1, 29 and the biome host
//      stone wherever a vein lands, so a shaft built from those would end up
//      speckled with ore veins breaking through its floors and walls.
//
// DARKNESS
//
// Nothing here emits light, and the layout guarantees no straight column open
// to the sky (the adit is a switchback under a roof), so skylight cannot reach
// the interior either. Because the shaft also sits entirely below
// `EMISSION_MIN_WORLD_Y` (32), worldgen never even seeds a block-light seed for
// it. The result is a genuinely dark structure: the player brings torches,
// finds them in the crates, or uses the flashlight.
// ---------------------------------------------------------------------------

/**
 * Block ids that emit light 15 in LightGenerator's emission LUT.
 *
 * Exported for the selftest, which asserts the placed set never contains one.
 */
export const MINESHAFT_LIGHT_EMITTERS: ReadonlySet<number> = new Set([
	10, 11, 24, 94,
]);

const AIR = BlockType.Air;
/** Shaft floors. Not an ore host. */
const FLOOR = BlockType.Cobblestone03;
/** Shaft walls and ceilings. Not an ore host. */
const WALL = BlockType.StoneTileWall;
/** Mine head planking, and the timbered cell corners. */
const PLANK = BlockType.WoodPlanks;
const TIMBER = BlockType.WoodPlankWall;
const POST = BlockType.BarkBrown02;
const CRATE = BlockType.WoodCrate;

/** Air blocks carved above a walking surface for headroom. */
const STAIR_HEADROOM = 3;

/** Air blocks above a corridor's walking surface. */
const CORRIDOR_HEADROOM = MINESHAFT_CELL_HEIGHT;

/**
 * One-entry memo for the last built layout.
 *
 * `generate` runs for every chunkY slice in the vertical band, for every chunk
 * in the +/-2 search window. A shaft spans up to 3x3 chunks and 3 slices, so
 * without this the same pure layout would be rebuilt and re-allocated up to 27
 * times per shaft. One slot is enough: the placer walks chunk by chunk, so all
 * those calls for one shaft arrive back to back.
 */
let _memoKey = "";
let _memoLayout: MineshaftLayout | null = null;

function buildMemoised(
	shaftId: number,
	centerX: number,
	centerZ: number,
	seed: number,
): MineshaftLayout | null {
	const key = `${shaftId}:${centerX}:${centerZ}:${seed}`;
	if (key !== _memoKey) {
		_memoKey = key;
		_memoLayout = buildMineshaftLayoutAt({ shaftId, centerX, centerZ }, seed);
	}
	return _memoLayout;
}

/** Re-exported so StructureLocator's existing import keeps working. */
export { MINESHAFT_REGION };

export class MineshaftFeature implements IWorldFeature {
	/**
	 * The whole structure hangs off the local surface: the mine head sits on it
	 * and the deepest level is 28 blocks under it. So the absolute band is
	 * [lowest legal floor - a slab, highest plausible surface + the hut].
	 *
	 * The old bounds of -150..0 were decorative — `canContainStructures` rejects
	 * a chunkY slice before any feature is consulted, using
	 * `minSurfaceY - MAX_STRUCTURE_BELOW_SURFACE`, which for typical terrain is
	 * around Y -46. Bounds wider than that changed nothing except how many
	 * slices reached the cheap AABB reject below.
	 */
	public readonly verticalBounds = {
		minWorldY: MINESHAFT_MIN_FLOOR_Y - 2,
		maxWorldY: 420,
	};

	public generate(
		chunkX: number,
		_chunkY: number,
		chunkZ: number,
		_biome: Biome,
		placeBlock: PlaceBlockFn,
		seed: number,
		chunkSize: number,
		generatingChunkX: number,
		generatingChunkZ: number,
	): void {
		const resolved = resolveMineshaftInRegion(chunkX, chunkZ, chunkSize, seed);
		if (!resolved) return;

		// Cheap XZ reject before paying for a layout build. One block of slack
		// over the grid span covers the approach stair, which reaches further
		// out on -X than any cell does.
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		const reach = MINESHAFT_GRID_SPAN / 2 + 2;
		if (
			resolved.centerX + reach < bounds.minX ||
			resolved.centerX - reach >= bounds.maxX ||
			resolved.centerZ + reach < bounds.minZ ||
			resolved.centerZ - reach >= bounds.maxZ
		) {
			return;
		}

		const layout = buildMemoised(
			resolved.shaftId,
			resolved.centerX,
			resolved.centerZ,
			seed,
		);
		if (!layout) return;

		// placeBlock clips writes to the generating chunk, so the whole layout
		// can be written unconditionally — the bounds check above is purely to
		// avoid building a layout that would contribute nothing.
		this.#write(layout, placeBlock);
	}

	// -------------------------------------------------------------------------
	// Writing
	// -------------------------------------------------------------------------

	#write(layout: MineshaftLayout, placeBlock: PlaceBlockFn): void {
		this.#writeCells(layout, placeBlock);
		this.#writeCorridors(layout, placeBlock);
		this.#writeStairs(layout, placeBlock);
		this.#writeEntrance(layout, placeBlock);
		this.#writeCrates(layout, placeBlock);
	}

	/**
	 * Floor slab, timbered corner posts, wall ring and ceiling slab for every
	 * carved cell, then the interior air.
	 *
	 * Walls are written solid and punched afterwards by the corridors, so a
	 * corridor opening is just air laid over a wall that is already there — no
	 * special-casing for cells that happen to have neighbours on both sides.
	 */
	#writeCells(layout: MineshaftLayout, placeBlock: PlaceBlockFn): void {
		for (const cell of layout.cells) {
			const { rect, interior, floorY, ceilingY } = cell;

			fill(placeBlock, rect, floorY, FLOOR);
			fill(placeBlock, rect, ceilingY, WALL);

			// Wall ring: the two X edges, then the two Z edges inset so the
			// corners are not written twice. The -X/-Z corner gets timber rather
			// than stone, because that is the corner the adit and the first
			// descent both come through, and a timbered corner reads as shoring.
			for (let y = floorY + 1; y < ceilingY; y++) {
				for (let x = rect.x0; x <= rect.x1; x++) {
					place(placeBlock, x, y, rect.z0, WALL);
					place(placeBlock, x, y, rect.z1, WALL);
				}
				for (let z = rect.z0 + 1; z < rect.z1; z++) {
					place(placeBlock, rect.x0, y, z, WALL);
					place(placeBlock, rect.x1, y, z, WALL);
				}
				place(placeBlock, rect.x0, y, rect.z0, TIMBER);
			}

			for (let y = floorY + 1; y < ceilingY; y++) {
				fill(placeBlock, interior, y, AIR);
			}
		}
	}

	/** A 3-wide flat run between two adjacent cells, including its wall punches. */
	#writeCorridors(layout: MineshaftLayout, placeBlock: PlaceBlockFn): void {
		for (const corridor of layout.corridors) {
			const lo = Math.min(corridor.from, corridor.to);
			const hi = Math.max(corridor.from, corridor.to);

			for (let p = lo; p <= hi; p++) {
				for (let w = 0; w < corridor.width; w++) {
					const x = corridor.axis === "x" ? p : corridor.center + w;
					const z = corridor.axis === "x" ? corridor.center + w : p;

					place(placeBlock, x, corridor.floorY, z, FLOOR);
					place(
						placeBlock,
						x,
						corridor.floorY + CORRIDOR_HEADROOM + 1,
						z,
						WALL,
					);
					for (let h = 1; h <= CORRIDOR_HEADROOM; h++) {
						place(placeBlock, x, corridor.floorY + h, z, AIR);
					}
				}
			}
		}
	}

	/**
	 * Every 1:1 run, by one generic walk.
	 *
	 * `center` is the lower coordinate of the strip, so the strip is
	 * `center .. center + width - 1`. The step block goes one below the walking
	 * surface, and the surface plus the two above it are cleared — which is what
	 * both opens the floor at the top of the run and keeps the headroom open
	 * inside the rock the run descends through.
	 */
	#writeStairs(layout: MineshaftLayout, placeBlock: PlaceBlockFn): void {
		for (const stair of layout.stairs) {
			const lo = Math.min(stair.from, stair.to);
			const hi = Math.max(stair.from, stair.to);

			for (let p = lo; p <= hi; p++) {
				const surface = stair.topY - stair.dir * (p - stair.from);

				for (let w = 0; w < stair.width; w++) {
					const x = stair.axis === "x" ? p : stair.center + w;
					const z = stair.axis === "x" ? stair.center + w : p;

					place(placeBlock, x, surface - 1, z, FLOOR);
					for (let h = 0; h < STAIR_HEADROOM; h++) {
						place(placeBlock, x, surface + h, z, AIR);
					}
				}
			}
		}
	}

	/**
	 * The mine head: approach stair, deck, posts, roof.
	 *
	 * The deck is laid with the hatch left open, and the roof covers the hatch
	 * — that roof is what keeps `topSunlightMask`'s skylight flood out of the
	 * shaft, since the adit below it is a switchback rather than an open column.
	 * Nothing is placed below `deckY`: the rock there is the mine head's
	 * foundation, and overwriting it would mean carving a plinth through the
	 * hillside for no gain.
	 */
	#writeEntrance(layout: MineshaftLayout, placeBlock: PlaceBlockFn): void {
		const { deck, deckY, roofY, hatch, posts } = layout.entrance;

		// Clear anything the terrain left inside the hut, so the deck is never
		// half buried in a rise.
		for (let y = deckY + 1; y < roofY; y++) {
			fill(placeBlock, deck, y, AIR);
		}

		for (let x = deck.x0; x <= deck.x1; x++) {
			for (let z = deck.z0; z <= deck.z1; z++) {
				if (x >= hatch.x0 && x <= hatch.x1) continue;
				if (z >= hatch.z0 && z <= hatch.z1) continue;
				place(placeBlock, x, deckY, z, PLANK);
			}
		}

		for (const [px, pz] of posts) {
			for (let y = deckY + 1; y < roofY; y++) {
				place(placeBlock, px, y, pz, POST);
			}
		}

		fill(placeBlock, deck, roofY, PLANK);
		// Cap the roof so nothing above it can feed skylight straight down the
		// hatch if a neighbouring structure ever opens the column.
		fill(placeBlock, deck, roofY + 1, WALL);
	}

	#writeCrates(layout: MineshaftLayout, placeBlock: PlaceBlockFn): void {
		for (const crate of layout.crates) {
			place(placeBlock, crate.x, crate.y, crate.z, CRATE);
		}
	}
}

// ---------------------------------------------------------------------------
// Block helpers
//
// Every write goes through these, with overwrite forced on: a mineshaft is
// carved into solid rock, so refusing to overwrite would leave the rock in
// place and the shaft would be a solid block of stone.
// ---------------------------------------------------------------------------

function place(
	placeBlock: PlaceBlockFn,
	x: number,
	y: number,
	z: number,
	blockId: number,
): void {
	placeBlock(x, y, z, blockId, true);
}

function fill(
	placeBlock: PlaceBlockFn,
	rect: MineshaftRect,
	y: number,
	blockId: number,
): void {
	for (let x = rect.x0; x <= rect.x1; x++) {
		for (let z = rect.z0; z <= rect.z1; z++) {
			placeBlock(x, y, z, blockId, true);
		}
	}
}
