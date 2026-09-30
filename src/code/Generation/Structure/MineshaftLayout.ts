import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";

// ---------------------------------------------------------------------------
// Mineshafts — shared layout description.
//
// This module is the single source of truth for the shape of a mineshaft. It is
// consumed by three places that must agree on the exact same geometry:
//
//   1. MineshaftFeature   — the worldgen IWorldFeature (chunk Web Worker)
//   2. MineshaftSeal      — the cave carver, which must know which columns and
//                           Y values are off-limits
//   3. MineshaftLootTable — the runtime loot resolver (main thread + server)
//
// Because (1) and (2) run in a worker and (3) runs on the main thread, the
// layout MUST stay pure and must only depend on values that are identical in
// both contexts:
//
//   - `shaftId` / `seed`: pure integer hashes.
//   - ground height: callers must inject `getFinalTerrainHeight`, NOT the
//     SurfaceGenerator column prepass resolver. The prepass is a cached view
//     that may be sampled before neighbouring terrain is finalised, so it can
//     disagree with the canonical function. If it ever did, the worker would
//     carve one shaft while the main thread looked for another.
//
// Everything below is a pure function of (shaftId, seed, centerX, centerZ) and
// the injected ground sampler. No stored state, no chunk access.
//
// SHAPE
//
// Three levels, each a 3x3 grid of cells. Cells are randomly omitted; the
// centre cell is forced present on every level, which is what makes the whole
// shaft connected (see CONNECTIVITY below). Cells on one level are joined by
// corridors, and the centre cell carries a stair between consecutive levels.
//
//   +Y   surface: approach stair -> plank deck -> roofed mine head -> adit
//    |
//    |   level 0    . [C] .        C = centre cell, always carved
//    |              . [C] .
//    |              . [C] .        drop 8 to level 0, then 10 per level
//    |
//    |   level 1    ... [C] ...
//    |              ... [C] ...
//    |
//    |   level 2    ... [C] ...
//    +Y
//
// DARKNESS
//
// The shaft places no light-emitting block (see the deny-list in
// MineshaftFeature), and it never contains a straight column open to the sky:
// the adit is a 1:1 stair set into a corner of the centre cell, so skylight
// cannot pour down it. Together with `EMISSION_MIN_WORLD_Y` sitting far above
// the whole structure, every voxel in the shaft is generated with light 0.
//
// CONNECTIVITY
//
// Occupancy per level is a 3x3 mask; the centre cell is always set. A BFS from
// the centre over the mask yields a spanning tree whose edges become corridors.
// Because the centre cell is shared by all three levels, the three level graphs
// meet at a node every path must pass through, and the stair between levels
// always touches that node. The result: every carved cell is reachable from the
// surface, by construction, with no orphan tunnels.
// ---------------------------------------------------------------------------

/** Cells per horizontal axis. */
export const MINESHAFT_GRID = 3;

/** Number of underground levels. */
export const MINESHAFT_LEVELS = 3;

/** Air width of a single cell. */
export const MINESHAFT_CELL_INTERIOR = 11;

/** Cell block footprint = interior plus one wall on each side. */
export const MINESHAFT_CELL_BLOCK = MINESHAFT_CELL_INTERIOR + 2;

/** Interior air height of a cell (floor and ceiling slabs excluded). */
export const MINESHAFT_CELL_HEIGHT = 5;

/** Walkable corridor width between two cells. */
export const MINESHAFT_CORRIDOR_WIDTH = 3;

/** Walkable stair width. */
export const MINESHAFT_STAIR_WIDTH = 2;

/** Distance between the centres of adjacent cells. */
export const MINESHAFT_CELL_PITCH =
	MINESHAFT_CELL_BLOCK + MINESHAFT_CORRIDOR_WIDTH;

/** Centre-to-centre distance of the centre cell from the shaft centre. */
export const MINESHAFT_HALF_SPAN = MINESHAFT_CELL_PITCH;

/** Full XZ span of the 3x3 grid, in blocks. */
export const MINESHAFT_GRID_SPAN =
	MINESHAFT_HALF_SPAN * 2 + MINESHAFT_CELL_BLOCK;

/** Floor-to-floor spacing between consecutive levels. */
export const MINESHAFT_LEVEL_DROP = 10;

/** Surface to level 0 floor. Also the horizontal length of the adit. */
export const MINESHAFT_FIRST_DROP = 8;

/**
 * Absolute clamp on the deepest level's floor.
 *
 * Structures are only generated for chunkY slices intersecting
 * `[minSurfaceY - MAX_STRUCTURE_BELOW_SURFACE(56), maxSurfaceY + 64]`, and light
 * generation gives up entirely below Y -128. A site whose deepest floor would
 * fall under this clamp is rejected outright — the layout returns null and both
 * the feature and the seal agree on that — rather than emitting a shaft whose
 * lower half silently fails to generate. The old feature had no such clamp and
 * simply carved below the eligible band, which is why most of its tunnels were
 * never written at all.
 */
export const MINESHAFT_MIN_FLOOR_Y = -40;

/** Height of the mine head above the deck: posts and a roof slab. */
export const MINESHAFT_ENTRANCE_HEIGHT = 5;

/** Half-width of the seal box — the grid plus four blocks of rock each side. */
export const MINESHAFT_SEAL_HALF_EXTENT = MINESHAFT_HALF_SPAN + 4;

/**
 * Largest surface relief across the mine head's footprint that still gets a
 * shaft. Past this the terrain is a cliff rather than a hillside, and the deck
 * would be a plank shelf glued to a slope with no way up to it. Mirrors the
 * Maya temple's MAX_PLAZA_RELIEF rejection.
 */
const MAX_SITE_RELIEF = 4;

/**
 * Distance from the centre column to the relief probes. The deck is 11 x 6, so
 * this brackets it with a small margin without sampling out in the hills.
 */
const SITE_PROBE_RADIUS = 6;

/** Probe offsets: centre, four deck corners, four approach-side corners. */
const SITE_PROBES: readonly (readonly [number, number])[] = [
	[0, 0],
	[-1, -1],
	[1, -1],
	[-1, 1],
	[1, 1],
	[-2, 0],
	[2, 0],
];

/**
 * Probability that a non-centre cell is carved, out of 100. Tuned so most
 * shafts land somewhere between 3 and 20 carved cells rather than always
 * filling all 27.
 */
const CELL_OCCUPANCY = 62;

/** Probability that a carved cell keeps its crate, out of 100. */
const CRATE_DENSITY = 60;

/**
 * A shaft never has fewer crates than this. A player who finds a mineshaft must
 * be able to find loot in it without having to exhaustively search every cell.
 */
const MIN_CRATES = 4;

const CENTER_CELL = 1 * MINESHAFT_GRID + 1;

export type MineshaftRect = {
	x0: number;
	x1: number;
	z0: number;
	z1: number;
};

export type MineshaftLootTier = "supply" | "stores" | "hoard";

/** One carved cell on one level. */
export type MineshaftCell = {
	level: number;
	/** Grid coordinates, 0..MINESHAFT_GRID-1. */
	gx: number;
	gz: number;
	/** Full cell footprint including its walls. */
	rect: MineshaftRect;
	/** Walkable interior, inset by one block. */
	interior: MineshaftRect;
	floorY: number;
	/** Ceiling slab Y. */
	ceilingY: number;
	/** Centre of the cell, on the walkable surface. */
	centerX: number;
	centerZ: number;
};

/**
 * A 1:1 stepped run — one block of Y per block travelled along `axis`. 1:1 is
 * the steepest slope the player can walk (step-up is 1.01) and the game has no
 * ladder block, so every vertical transition in a mineshaft is one of these.
 *
 * `from`/`to` are inclusive world coordinates and may run either way. The
 * walking surface at axis position `p` is `topY - dir * (p - from)`, where
 * `dir` is the sign of `to - from`. `center` is the LOWER coordinate of the
 * walkable strip on the other axis, so the strip is `center .. center+width-1`.
 */
export type MineshaftStair = {
	/** -1 = the surface approach or adit. */
	fromLevel: number;
	/** n = the run from level n down to level n+1. */
	toLevel: number;
	axis: "x" | "z";
	from: number;
	to: number;
	center: number;
	width: number;
	/** Walking surface Y at `from`. */
	topY: number;
	dir: 1 | -1;
};

/**
 * A flat connector between two horizontally adjacent cells.
 *
 * `center` is likewise the lower coordinate of the walkable strip.
 */
export type MineshaftCorridor = {
	level: number;
	/** "x" = the run travels along X (joining X-adjacent cells). */
	axis: "x" | "z";
	from: number;
	to: number;
	center: number;
	width: number;
	floorY: number;
	/** Headroom above the walking surface. */
	height: number;
};

export type MineshaftCrate = {
	x: number;
	y: number;
	z: number;
	tier: MineshaftLootTier;
	level: number;
	/** Index into `layout.crates`. */
	index: number;
};

export type MineshaftEntrance = {
	/** Plank deck footprint. The roof covers the same rect. */
	deck: MineshaftRect;
	/** Top surface of the deck. */
	deckY: number;
	/** Y of the roof slab. */
	roofY: number;
	/** Corner post positions, as [x, z] pairs. */
	posts: readonly (readonly [number, number])[];
	/** The deck opening the adit passes through. */
	hatch: MineshaftRect;
	/** The surface -> level 0 stair. */
	adit: MineshaftStair;
	/** The terrain -> deck stair, on the -X face. */
	approach: MineshaftStair;
	/** Lowest ground sample on the site; the approach lands on it. */
	approachFloorY: number;
};

export type MineshaftSealBox = {
	minX: number;
	maxX: number;
	minZ: number;
	maxZ: number;
	minY: number;
	maxY: number;
};

/** The site-level decisions, shared by the layout and the seal. */
export type MineshaftSite = {
	/** Deck height: the ground at the centre column. */
	surfaceY: number;
	/** Lowest and highest ground samples across the site. */
	minGroundY: number;
	maxGroundY: number;
	/** Floor Y of each level. */
	levelFloors: readonly number[];
	/** Floor Y of the deepest level. */
	deepest: number;
};

export type MineshaftLayout = {
	shaftId: number;
	seed: number;
	centerX: number;
	centerZ: number;
	site: MineshaftSite;

	entrance: MineshaftEntrance;
	/** Every carved cell, ordered by level then grid position. */
	cells: readonly MineshaftCell[];
	/** Every corridor, one per spanning-tree edge. */
	corridors: readonly MineshaftCorridor[];
	/** Approach, adit, then one stair per level transition. */
	stairs: readonly MineshaftStair[];
	/** Every loot crate; `crate.index` matches its position in this array. */
	crates: readonly MineshaftCrate[];

	/** Absolute bounding box the cave carver must not touch. */
	seal: MineshaftSealBox;
};

/** Ground sampler. Callers inject the canonical `getFinalTerrainHeight`. */
export type GroundSampler = (worldX: number, worldZ: number) => number;

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

/**
 * getPRNGBySeed already returns a value with bit 31 clear, so it is
 * non-negative. Math.abs is kept so this stays correct if that ever changes.
 */
function hash(shaftId: number, salt: number, seed: number): number {
	return Math.abs(getPRNGBySeed(shaftId + salt, seed));
}

// ---------------------------------------------------------------------------
// Cell geometry
// ---------------------------------------------------------------------------

/** Centre X of grid column `gx`, so cell (1, ·) is centred on `centerX`. */
export function mineshaftCellCenterX(centerX: number, gx: number): number {
	return centerX + (gx - 1) * MINESHAFT_CELL_PITCH;
}

export function mineshaftCellCenterZ(centerZ: number, gz: number): number {
	return centerZ + (gz - 1) * MINESHAFT_CELL_PITCH;
}

/** Grid cell index for (gx, gz). */
function cellIndex(gx: number, gz: number): number {
	return gz * MINESHAFT_GRID + gx;
}

function cellRect(
	centerX: number,
	centerZ: number,
	gx: number,
	gz: number,
): MineshaftRect {
	const half = (MINESHAFT_CELL_BLOCK - 1) / 2;
	const cx = mineshaftCellCenterX(centerX, gx);
	const cz = mineshaftCellCenterZ(centerZ, gz);
	return { x0: cx - half, x1: cx + half, z0: cz - half, z1: cz + half };
}

function interiorOf(rect: MineshaftRect): MineshaftRect {
	return {
		x0: rect.x0 + 1,
		x1: rect.x1 - 1,
		z0: rect.z0 + 1,
		z1: rect.z1 - 1,
	};
}

function levelFloorY(surfaceY: number, level: number): number {
	return surfaceY - MINESHAFT_FIRST_DROP - level * MINESHAFT_LEVEL_DROP;
}

// ---------------------------------------------------------------------------
// Site resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the depth stack for a site, or null when the site is unusable.
 *
 * This is the single reject gate. `computeMineshaftSealBox` and
 * `buildMineshaftLayout` both go through it, so a site that the feature refuses
 * to build is also a site the cave carver leaves alone — they cannot drift.
 *
 * Two rejection reasons, both about the structure being cut off from the world:
 *
 *   - the deepest floor falls under MINESHAFT_MIN_FLOOR_Y, so worldgen would
 *     never be asked to write it;
 *   - the site is a cliff (relief over MAX_SITE_RELIEF), so the deck would be
 *     a plank shelf with no walkable approach.
 */
export function resolveMineshaftSite(
	centerX: number,
	centerZ: number,
	ground: GroundSampler,
): MineshaftSite | null {
	const surfaceY = ground(centerX, centerZ);

	let minGroundY = surfaceY;
	let maxGroundY = surfaceY;
	for (const [dx, dz] of SITE_PROBES) {
		const g = ground(
			centerX + dx * SITE_PROBE_RADIUS,
			centerZ + dz * SITE_PROBE_RADIUS,
		);
		if (g < minGroundY) minGroundY = g;
		if (g > maxGroundY) maxGroundY = g;
	}

	if (maxGroundY - minGroundY > MAX_SITE_RELIEF) return null;

	const levelFloors: number[] = [];
	for (let level = 0; level < MINESHAFT_LEVELS; level++) {
		levelFloors.push(levelFloorY(surfaceY, level));
	}

	const deepest = levelFloors[MINESHAFT_LEVELS - 1];
	if (deepest < MINESHAFT_MIN_FLOOR_Y) return null;

	return { surfaceY, minGroundY, maxGroundY, levelFloors, deepest };
}

// ---------------------------------------------------------------------------
// Occupancy + connectivity
// ---------------------------------------------------------------------------

/**
 * Per-level 3x3 occupancy mask.
 *
 * The centre cell is forced on for every level. That single constraint is what
 * guarantees a connected shaft: the per-level spanning trees all meet at the
 * centre cell, and the inter-level stairs always start and end there.
 */
function buildOccupancy(shaftId: number, seed: number): boolean[][] {
	const mask: boolean[][] = [];

	for (let level = 0; level < MINESHAFT_LEVELS; level++) {
		const row: boolean[] = [];
		for (let gz = 0; gz < MINESHAFT_GRID; gz++) {
			for (let gx = 0; gx < MINESHAFT_GRID; gx++) {
				if (cellIndex(gx, gz) === CENTER_CELL) {
					row.push(true);
					continue;
				}
				// Salt per level keeps the three masks independent.
				const salt = level * 37 + cellIndex(gx, gz);
				row.push(hash(shaftId, salt, seed) % 100 < CELL_OCCUPANCY);
			}
		}
		mask.push(row);
	}

	return mask;
}

/** Fixed neighbour order, so the spanning tree is identical on every run. */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
	[0, -1],
	[1, 0],
	[0, 1],
	[-1, 0],
];

/**
 * BFS spanning tree over one level's occupied cells, rooted at the centre.
 *
 * Every emitted corridor joins two cells that both exist, and every occupied
 * cell is reached through a chain of occupied neighbours — so no cell is ever
 * left stranded. A ring corridor is deliberately not emitted: a spanning tree
 * already connects everything, and the extra edges would only punch more holes
 * in the surrounding rock.
 */
function buildLevelCorridors(
	level: number,
	mask: readonly boolean[],
	floorY: number,
	centerX: number,
	centerZ: number,
): MineshaftCorridor[] {
	const corridors: MineshaftCorridor[] = [];
	const seen = new Array<boolean>(MINESHAFT_GRID * MINESHAFT_GRID).fill(false);

	seen[CENTER_CELL] = true;
	const queue: number[] = [CENTER_CELL];

	for (let head = 0; head < queue.length; head++) {
		const current = queue[head];
		const gx = current % MINESHAFT_GRID;
		const gz = (current - gx) / MINESHAFT_GRID;

		for (const [dx, dz] of NEIGHBOURS) {
			const nx = gx + dx;
			const nz = gz + dz;
			if (nx < 0 || nz < 0 || nx >= MINESHAFT_GRID || nz >= MINESHAFT_GRID) {
				continue;
			}
			const next = cellIndex(nx, nz);
			if (seen[next] || !mask[next]) continue;
			seen[next] = true;
			queue.push(next);

			corridors.push(
				buildCorridor(
					level,
					dx !== 0 ? "x" : "z",
					gx,
					gz,
					centerX,
					centerZ,
					floorY,
				),
			);
		}
	}

	return corridors;
}

/**
 * The corridor between two adjacent cells.
 *
 * The 3-block gap between the two cell walls IS the corridor, so `from`/`to`
 * span the walls too — both have to be punched for the run to connect.
 */
function buildCorridor(
	level: number,
	axis: "x" | "z",
	gx: number,
	gz: number,
	centerX: number,
	centerZ: number,
	floorY: number,
): MineshaftCorridor {
	const half = (MINESHAFT_CELL_BLOCK - 1) / 2;
	const strip = (MINESHAFT_CORRIDOR_WIDTH - 1) / 2;

	if (axis === "x") {
		// gx is always the lower cell: BFS only steps +X out of it.
		const wall = mineshaftCellCenterX(centerX, gx) + half;
		return {
			level,
			axis,
			from: wall + 1,
			to: wall + MINESHAFT_CORRIDOR_WIDTH,
			center: mineshaftCellCenterZ(centerZ, gz) - strip,
			width: MINESHAFT_CORRIDOR_WIDTH,
			floorY,
			height: MINESHAFT_CELL_HEIGHT,
		};
	}

	// gz is always the lower cell: BFS only steps +Z out of it.
	const wall = mineshaftCellCenterZ(centerZ, gz) + half;
	return {
		level,
		axis,
		from: wall + 1,
		to: wall + MINESHAFT_CORRIDOR_WIDTH,
		center: mineshaftCellCenterX(centerX, gx) - strip,
		width: MINESHAFT_CORRIDOR_WIDTH,
		floorY,
		height: MINESHAFT_CELL_HEIGHT,
	};
}

// ---------------------------------------------------------------------------
// Vertical connections
// ---------------------------------------------------------------------------

/**
 * The stair from `level` down to `level + 1`, always inside the centre cell.
 *
 * Every vertical run gets its own wall strip, so no two staircases can share a
 * voxel or block each other's entrance:
 *
 *   approach (-1 -> -1) : -Z strip, along X, occupies [minGroundY, surfaceY]
 *   adit      (-1 -> 0)  : -Z strip, along X, occupies [level0Floor, surfaceY]
 *   level 0 -> 1        : -X strip, along Z, occupies [level1Floor, level0Floor]
 *   level 1 -> 2        : +Z strip, along X, occupies [level2Floor, level1Floor]
 *
 * The approach and the adit share a strip but never an X: the approach stops
 * one block short of the deck and the adit starts inside the hatch, so they
 * meet at the deck's edge and nowhere else. The descents sit on different walls
 * and in different Y bands. This matters — an earlier version put the adit and
 * the 0 -> 1 descent on the same -Z strip, and the adit's staircase ended up
 * sitting on top of the descent's top step, walling it off entirely.
 *
 * Each run starts flush with the upper floor and lands exactly on the lower
 * floor, so no landing block is needed at either end.
 */
function buildDescentStair(
	level: number,
	centerX: number,
	centerZ: number,
	floorY: number,
): MineshaftStair {
	const interior = interiorOf(cellRect(centerX, centerZ, 1, 1));

	if (level % 2 === 0) {
		// -X strip, descending towards +Z.
		return {
			fromLevel: level,
			toLevel: level + 1,
			axis: "z",
			from: interior.z0,
			to: interior.z0 + MINESHAFT_LEVEL_DROP,
			center: interior.x0,
			width: MINESHAFT_STAIR_WIDTH,
			topY: floorY,
			dir: 1,
		};
	}

	// +Z strip, descending towards +X.
	return {
		fromLevel: level,
		toLevel: level + 1,
		axis: "x",
		from: interior.x0,
		to: interior.x0 + MINESHAFT_LEVEL_DROP,
		center: interior.z1 - MINESHAFT_STAIR_WIDTH + 1,
		width: MINESHAFT_STAIR_WIDTH,
		topY: floorY,
		dir: 1,
	};
}

// ---------------------------------------------------------------------------
// Entrance
// ---------------------------------------------------------------------------

/**
 * The surface mine head: an approach stair, a plank deck, corner posts, a roof,
 * and the adit down to level 0.
 *
 * The adit is deliberately NOT a straight vertical drop: it is a 1:1 stair set
 * into the -X/-Z corner of the centre cell. A straight column would be marked
 * open-to-sky by `topSunlightMask` and skylight would flood the entire shaft,
 * which is exactly what this structure must not be. The roof closes the hatch as
 * a second line of defence, and being a switchback it is also the only reason a
 * player can get in at all — the game has no ladder block.
 */
function buildEntrance(
	centerX: number,
	centerZ: number,
	site: MineshaftSite,
): MineshaftEntrance {
	const interior = interiorOf(cellRect(centerX, centerZ, 1, 1));
	const aditZ = interior.z0;

	const adit: MineshaftStair = {
		fromLevel: -1,
		toLevel: 0,
		axis: "x",
		from: interior.x0,
		to: interior.x0 + MINESHAFT_FIRST_DROP,
		center: aditZ,
		width: MINESHAFT_STAIR_WIDTH,
		topY: site.surfaceY,
		dir: 1,
	};

	const hatch: MineshaftRect = {
		x0: adit.from,
		x1: adit.to,
		z0: aditZ,
		z1: aditZ + MINESHAFT_STAIR_WIDTH - 1,
	};

	// The deck wraps the hatch with a block of margin on every side, so the
	// adit never breaks out through the side of the platform.
	const deck: MineshaftRect = {
		x0: hatch.x0 - 1,
		x1: hatch.x1 + 1,
		z0: hatch.z0 - 2,
		z1: hatch.z1 + 2,
	};

	// The approach runs from the deck's -X edge down to the lowest ground
	// sample on the site. The site is rejected above MAX_SITE_RELIEF, so this
	// is at most four steps and always reaches terrain.
	const drop = site.surfaceY - site.minGroundY;
	const approach: MineshaftStair = {
		fromLevel: -1,
		toLevel: -1,
		axis: "x",
		from: deck.x0 - 1,
		to: deck.x0 - 1 - drop,
		center: aditZ,
		width: MINESHAFT_STAIR_WIDTH,
		topY: site.surfaceY,
		dir: 1,
	};

	return {
		deck,
		deckY: site.surfaceY,
		roofY: site.surfaceY + MINESHAFT_ENTRANCE_HEIGHT,
		posts: [
			[deck.x0, deck.z0],
			[deck.x1, deck.z0],
			[deck.x0, deck.z1],
			[deck.x1, deck.z1],
		],
		hatch,
		adit,
		approach,
		approachFloorY: site.minGroundY,
	};
}

// ---------------------------------------------------------------------------
// Crates
// ---------------------------------------------------------------------------

function tierForLevel(level: number): MineshaftLootTier {
	if (level <= 0) return "supply";
	if (level === 1) return "stores";
	return "hoard";
}

/**
 * One crate per carved cell, pushed into a wall corner so it never blocks the
 * corridor mouths on the two shared walls.
 *
 * Corners are inset by one stair width, because in the centre cell every wall
 * strip is spoken for: the adit takes the -Z, the first descent the -X, the
 * second the +Z. Inset corners clear all three on every level.
 */
function buildCrates(
	cells: readonly MineshaftCell[],
	shaftId: number,
	seed: number,
): MineshaftCrate[] {
	const candidates: MineshaftCrate[] = [];
	const inset = MINESHAFT_STAIR_WIDTH;

	for (let i = 0; i < cells.length; i++) {
		const cell = cells[i];
		const corner = hash(shaftId, 4096 + i, seed) % 3;
		const x = corner === 0 ? cell.interior.x1 : cell.interior.x0 + inset;
		const z = corner === 1 ? cell.interior.z1 : cell.interior.z0 + inset;

		candidates.push({
			x,
			y: cell.floorY + 1,
			z,
			tier: tierForLevel(cell.level),
			level: cell.level,
			index: 0,
		});
	}

	const kept: MineshaftCrate[] = [];
	for (let i = 0; i < candidates.length; i++) {
		if (hash(shaftId, 8192 + i, seed) % 100 < CRATE_DENSITY) {
			kept.push(candidates[i]);
		}
	}

	// Top the list back up to MIN_CRATES, deterministically.
	for (let i = 0; i < candidates.length && kept.length < MIN_CRATES; i++) {
		if (kept.indexOf(candidates[i]) !== -1) continue;
		kept.push(candidates[i]);
	}

	// `index` is the position in the returned array, which is what the loot
	// resolver matches a crate against.
	return kept.map((crate, i) => ({ ...crate, index: i }));
}

// ---------------------------------------------------------------------------
// Seal
// ---------------------------------------------------------------------------

/**
 * The bounding box the cave carver must leave alone, or null when the site is
 * rejected.
 *
 * Deliberately computed from the site resolution only — the full layout (cells,
 * corridors, stairs, crates) is irrelevant to a box. This runs for every
 * region near the generating chunk, so it stays a handful of ground samples and
 * some integer arithmetic. The reject test is the identical one
 * `buildMineshaftLayout` applies via resolveMineshaftSite.
 */
export function computeMineshaftSealBox(
	centerX: number,
	centerZ: number,
	ground: GroundSampler,
): MineshaftSealBox | null {
	const site = resolveMineshaftSite(centerX, centerZ, ground);
	if (!site) return null;

	return {
		minX: centerX - MINESHAFT_SEAL_HALF_EXTENT,
		maxX: centerX + MINESHAFT_SEAL_HALF_EXTENT,
		minZ: centerZ - MINESHAFT_SEAL_HALF_EXTENT,
		maxZ: centerZ + MINESHAFT_SEAL_HALF_EXTENT,
		minY: site.deepest - 1,
		maxY: site.surfaceY + MINESHAFT_ENTRANCE_HEIGHT,
	};
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build the complete layout for a shaft, or null when the site is rejected.
 *
 * Null is a real answer, not an error: the site is either below the worldgen
 * band or too steep to approach. The seal applies the same test via
 * resolveMineshaftSite, so neither side can disagree about whether a shaft
 * exists here.
 */
export function buildMineshaftLayout(
	shaftId: number,
	seed: number,
	centerX: number,
	centerZ: number,
	ground: GroundSampler,
): MineshaftLayout | null {
	const site = resolveMineshaftSite(centerX, centerZ, ground);
	if (!site) return null;

	const occupancy = buildOccupancy(shaftId, seed);
	const cells: MineshaftCell[] = [];
	const corridors: MineshaftCorridor[] = [];

	for (let level = 0; level < MINESHAFT_LEVELS; level++) {
		const floorY = site.levelFloors[level];

		for (let gz = 0; gz < MINESHAFT_GRID; gz++) {
			for (let gx = 0; gx < MINESHAFT_GRID; gx++) {
				if (!occupancy[level][cellIndex(gx, gz)]) continue;

				const rect = cellRect(centerX, centerZ, gx, gz);
				cells.push({
					level,
					gx,
					gz,
					rect,
					interior: interiorOf(rect),
					floorY,
					ceilingY: floorY + MINESHAFT_CELL_HEIGHT + 1,
					centerX: mineshaftCellCenterX(centerX, gx),
					centerZ: mineshaftCellCenterZ(centerZ, gz),
				});
			}
		}

		corridors.push(
			...buildLevelCorridors(level, occupancy[level], floorY, centerX, centerZ),
		);
	}

	const entrance = buildEntrance(centerX, centerZ, site);

	const stairs: MineshaftStair[] = [entrance.approach, entrance.adit];
	for (let level = 0; level < MINESHAFT_LEVELS - 1; level++) {
		stairs.push(
			buildDescentStair(level, centerX, centerZ, site.levelFloors[level]),
		);
	}

	return {
		shaftId,
		seed,
		centerX,
		centerZ,
		site,
		entrance,
		cells,
		corridors,
		stairs,
		crates: buildCrates(cells, shaftId, seed),
		seal: {
			minX: centerX - MINESHAFT_SEAL_HALF_EXTENT,
			maxX: centerX + MINESHAFT_SEAL_HALF_EXTENT,
			minZ: centerZ - MINESHAFT_SEAL_HALF_EXTENT,
			maxZ: centerZ + MINESHAFT_SEAL_HALF_EXTENT,
			minY: site.deepest - 1,
			maxY: site.surfaceY + MINESHAFT_ENTRANCE_HEIGHT,
		},
	};
}
