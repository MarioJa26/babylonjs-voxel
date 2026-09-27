import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";

// ---------------------------------------------------------------------------
// Maya temples + underground dungeons — shared layout description.
//
// This module is the single source of truth for the shape of a temple. It is
// consumed by three places that must agree on the exact same geometry:
//
//   1. MayaTempleFeature     — the worldgen IWorldFeature (chunk Web Worker)
//   2. StructureSeal         — the cave carver, which must know which columns
//                              and Y values are off-limits
//   3. MayaDungeonEncounter  — the runtime system that populates guardians and
//                              loot caches (main thread)
//
// Because (1) and (2) run in a worker and (3) runs on the main thread, the
// layout MUST stay pure and must only depend on values that are identical in
// both contexts:
//
//   - `templeId` / `seed`: pure integer hashes.
//   - ground height: callers must inject `getFinalTerrainHeight`, NOT the
//     SurfaceGenerator column prepass resolver. The prepass is a cached view
//     that may be sampled before neighbouring terrain is finalised, so it can
//     disagree with the canonical function. If it ever did, the worker would
//     carve one dungeon while the main thread looked for another.
// ---------------------------------------------------------------------------

/** Half-width of the whole temple footprint (96x96 blocks). */
export const MAYA_TEMPLE_HALF_EXTENT = 48;

/**
 * Half-width used when sealing caves. Slightly larger than the footprint so
 * the outer wall is never eroded by a cave intersecting the platform edge.
 */
export const MAYA_SEAL_HALF_EXTENT = MAYA_TEMPLE_HALF_EXTENT + 2;

/** Number of underground levels below the plaza. */
export const MAYA_LEVEL_COUNT = 4;

/** Floor-Y spacing between consecutive dungeon levels. */
export const MAYA_LEVEL_DROP = 11;

/** Vertical distance from the plaza down to level 0's floor. */
export const MAYA_FIRST_LEVEL_DROP = 14;

/** Interior air height of a dungeon room (floor slab and ceiling excluded). */
export const MAYA_ROOM_HEIGHT = 5;

/** Interior air height of a surface temple building. */
export const MAYA_SURFACE_ROOM_HEIGHT = 7;

/**
 * Absolute clamp on the deepest dungeon level. Keeps the bottom level inside
 * the lowest chunkY slice that MAX_STRUCTURE_BELOW_SURFACE makes eligible for
 * structures (chunkY = -2 spans world Y -64..-33).
 */
export const MAYA_MIN_DUNGEON_Y = -48;

/** Total depth the dungeon needs below the plaza, floor to floor. */
export const MAYA_TOTAL_DUNGEON_DEPTH =
	MAYA_FIRST_LEVEL_DROP + (MAYA_LEVEL_COUNT - 1) * MAYA_LEVEL_DROP;

/**
 * Lowest plaza height a temple can be built at.
 *
 * makeLevelY clamps the level stack so the deepest floor never goes below
 * MAYA_MIN_DUNGEON_Y, because that is the lowest slice worldgen will run the
 * feature for. If a site's surface is so low that the clamp has to lift the
 * stack, the dungeon ends up ABOVE its own plaza — an inverted temple whose
 * rooms punch through the pyramid. Rather than emit that, the site is rejected.
 */
export const MAYA_MIN_PLAZA_Y = MAYA_MIN_DUNGEON_Y + MAYA_TOTAL_DUNGEON_DEPTH;

/** Side of the square dungeon room grid. */
const GRID = 3;
const CELL = 26;
const GRID_SPAN = GRID * CELL;

/** Grid cell that always exists on every level: it carries the descent ramps. */
const RAMP_CELL = 2;

/** Grid cell forced occupied on level 0: the cenote shaft lands in it. */
const CENTRE_CELL = 1;

/**
 * Largest surface relief across the footprint that still gets anchored on the
 * high sample. Beyond this the terrain is a cliff, and levelling to the high
 * point would build an absurd skirt.
 */
const MAX_PLAZA_RELIEF = 14;

/**
 * How far along the arena's exit corridor the boss gate wall must sit, in
 * blocks from the arena centre. The boss post is the arena centre, so the wall
 * has to stand clear of it or the fight happens inside a solid block.
 */
const BOSS_GATE_CLEARANCE = 6;

export type MayaRect = {
	x0: number;
	x1: number;
	z0: number;
	z1: number;
};

export type MayaLootTier = "alcove" | "vault" | "treasury" | "boss";

export type MayaRoomKind =
	| "hall"
	| "gallery"
	| "cistern"
	| "armory"
	| "sanctum"
	| "treasury"
	| "boss";

export type MayaGuardKind = "zombie" | "skeleton";

export type MayaChamber = {
	/** -1 for surface buildings, 0..MAYA_LEVEL_COUNT-1 for dungeon levels. */
	level: number;
	floorY: number;
	rect: MayaRect;
	kind: MayaRoomKind;
	/** Block offsets from the room's min corner, to interior torch positions. */
	torches: readonly (readonly [number, number])[];
	/** Block offsets from the room's min corner, to loot cache positions. */
	caches: readonly (readonly [number, number])[];
	/** Loot tier per cache, index-aligned with `caches`. */
	cacheTiers: readonly MayaLootTier[];
	/** Block offsets from the room's min corner, to guardian spawn points. */
	guards: readonly (readonly [number, number, MayaGuardKind])[];
};

/**
 * A 1:1 stepped ramp — one block of Y per block travelled along `axis`. 1:1 is
 * the steepest slope the player and hostiles can both walk (step-up height is
 * 1.01 for the player, 1.0 for mobs), and there is no ladder block in the game,
 * so every vertical transition in a temple has to be one of these.
 *
 * The covered axis range is INCLUSIVE of both `from` and `to`, and Y is
 * `y0 + dir * t` for step `t`. `dir: 0` marks a flat landing or connector, so
 * a descent is expressed as a flight plus flat segments rather than a
 * switchback (the flight alone is long enough to be walkable).
 */
export type MayaRamp = {
	axis: "x" | "z";
	/** The horizontal coordinate the ramp does not travel along. */
	fixed: number;
	from: number;
	to: number;
	/** Floor Y at `from`. */
	y0: number;
	/** +1 if Y rises as the axis increases, -1 if it falls, 0 if flat. */
	dir: 1 | -1 | 0;
	/** Width of the walkable strip, centred on `fixed`. */
	width: number;
};

/** A polyline of straight segments carved on one level. */
export type MayaCorridor = {
	level: number;
	floorY: number;
	width: number;
	/** Flat [x0,z0, x1,z1, ...] world-space waypoints. */
	points: readonly number[];
};

export type MayaGuardianPost = {
	x: number;
	y: number;
	z: number;
	mobType: MayaGuardKind;
	/** True for the single boss post. */
	boss: boolean;
};

export type MayaLootCache = {
	x: number;
	y: number;
	z: number;
	tier: MayaLootTier;
};

/**
 * A puzzle glyph. For the three sanctum glyphs, `ring` holds the crystal
 * blocks whose block id encodes the charged state. That is what makes the
 * puzzle stateless: the answer is readable straight out of the voxel grid with
 * no extra save data, and the blocks themselves persist it.
 *
 * The boss gate instead has a solid `wall` to dissolve once all three seals
 * are charged.
 */
export type MayaGlyph = {
	/** The interactable glyph block. */
	x: number;
	y: number;
	z: number;
	ring: readonly (readonly [number, number, number])[];
	/** Set only on the boss gate. */
	gate?: {
		wall: readonly (readonly [number, number, number])[];
		/** Axis the wall runs across. */
		across: "x" | "z";
	};
};

export type MayaPyramidTier = {
	half: number;
	y0: number;
	y1: number;
};

export type MayaTempleLayout = {
	templeId: number;
	seed: number;
	centerX: number;
	centerZ: number;

	/** Y of the plaza deck (top of the levelled platform). */
	plazaY: number;

	/** Stepped pyramid tiers, outermost first. Hollow around the cenote. */
	pyramid: readonly MayaPyramidTier[];
	/** Top surface Y of the topmost pyramid tier. */
	pyramidTopY: number;

	/** Summit temple footprint, sitting on `pyramidTopY`. */
	summit: MayaRect;

	/** Four temple buildings on the plaza. */
	surfaceRooms: readonly MayaChamber[];

	/** The surface -> level 0 shaft. */
	cenote: MayaRect;
	/** Topmost Y the cenote is carved open to. */
	cenoteTopY: number;

	/** Every underground room, ordered by level. */
	rooms: readonly MayaChamber[];
	ramps: readonly MayaRamp[];
	corridors: readonly MayaCorridor[];

	/** The boss arena (also present in `rooms` with `kind: "boss"`). */
	bossRoom: MayaChamber;

	/** Three puzzle glyphs plus the boss gate glyph. */
	glyphs: readonly MayaGlyph[];

	/** Every guardian spawn point, boss included. */
	guards: readonly MayaGuardianPost[];
	/** Every loot cache in the dungeon. */
	caches: readonly MayaLootCache[];

	/** Absolute bounding box the cave carver must not touch. */
	seal: MayaSealBox;
};

export type MayaSealBox = {
	minX: number;
	maxX: number;
	minZ: number;
	maxZ: number;
	minY: number;
	maxY: number;
};

/** Half-extents of the stepped pyramid, outermost first. */
const PYRAMID_TIER_HALVES = [23, 19, 15, 11, 7] as const;

/** Height of one pyramid tier (4 solid + 1 deck). */
const PYRAMID_TIER_HEIGHT = 5;

/**
 * Cheap seal-box-only path.
 *
 * The cave carver probes up to 25 candidate regions per chunk but only needs
 * the protected box, so it must not pay for the full room/corridor/ramp build.
 */
export function computeMayaSealBox(
	centerX: number,
	centerZ: number,
	ground: GroundSampler,
): MayaSealBox {
	const plazaY = plazaSurfaceY(ground, centerX, centerZ);
	const levelY = makeLevelY(plazaY);
	const pyramidTopY =
		plazaY + PYRAMID_TIER_HALVES.length * PYRAMID_TIER_HEIGHT - 1;

	return {
		minX: centerX - MAYA_SEAL_HALF_EXTENT,
		maxX: centerX + MAYA_SEAL_HALF_EXTENT,
		minZ: centerZ - MAYA_SEAL_HALF_EXTENT,
		maxZ: centerZ + MAYA_SEAL_HALF_EXTENT,
		minY: levelY(MAYA_LEVEL_COUNT - 1) - 3,
		maxY: pyramidTopY + 4,
	};
}

export type GroundSampler = (worldX: number, worldZ: number) => number;

// ---------------------------------------------------------------------------
// Deterministic RNG — house style: successive values come from
// Math.abs(getPRNGBySeed(cursor, seed)) with a golden-ratio cursor advance.
// ---------------------------------------------------------------------------

class TempleRandom {
	private cursor: number;

	constructor(
		templeId: number,
		private readonly seed: number,
		salt: number,
	) {
		this.cursor = getPRNGBySeed(templeId + salt * 2654435761, seed) | 0 || 1;
	}

	private advance(): number {
		this.cursor = (this.cursor + 0x9e3779b9) | 0;
		return this.cursor;
	}

	/** Uniform integer in [0, maxExclusive). */
	int(maxExclusive: number): number {
		if (maxExclusive <= 1) return 0;
		return Math.abs(getPRNGBySeed(this.advance(), this.seed)) % maxExclusive;
	}

	/** Uniform integer in [min, maxInclusive]. */
	range(min: number, maxInclusive: number): number {
		return min + this.int(maxInclusive - min + 1);
	}

	/** Uniform float in [0, 1). */
	unit(): number {
		return Math.abs(getPRNGBySeed(this.advance(), this.seed)) / 2147483648;
	}

	chance(probability: number): boolean {
		return this.unit() < probability;
	}
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function rectCentre(rect: MayaRect): { x: number; z: number } {
	return {
		x: Math.floor((rect.x0 + rect.x1) / 2),
		z: Math.floor((rect.z0 + rect.z1) / 2),
	};
}

function rectWidth(rect: MayaRect): number {
	return rect.x1 - rect.x0 + 1;
}

function rectDepth(rect: MayaRect): number {
	return rect.z1 - rect.z0 + 1;
}

function cellRect(
	gridX0: number,
	gridZ0: number,
	cx: number,
	cz: number,
): MayaRect {
	const x0 = gridX0 + cx * CELL;
	const z0 = gridZ0 + cz * CELL;
	return { x0, x1: x0 + CELL - 1, z0, z1: z0 + CELL - 1 };
}

function cellOfRect(
	gridX0: number,
	gridZ0: number,
	rect: MayaRect,
): { cx: number; cz: number } {
	const c = rectCentre(rect);
	return {
		cx: Math.max(0, Math.min(GRID - 1, Math.floor((c.x - gridX0) / CELL))),
		cz: Math.max(0, Math.min(GRID - 1, Math.floor((c.z - gridZ0) / CELL))),
	};
}

/** Squared XZ distance between rect centres — picks the "farthest room". */
function rectDistSq(a: MayaRect, b: MayaRect): number {
	const ca = rectCentre(a);
	const cb = rectCentre(b);
	const dx = ca.x - cb.x;
	const dz = ca.z - cb.z;
	return dx * dx + dz * dz;
}

/** Is (x,z) inside rect, inclusive? */
function rectContains(rect: MayaRect, x: number, z: number): boolean {
	return x >= rect.x0 && x <= rect.x1 && z >= rect.z0 && z <= rect.z1;
}

// ---------------------------------------------------------------------------
// Dungeon geometry
// ---------------------------------------------------------------------------

/**
 * Floor Y per level. Levels are spaced by `MAYA_LEVEL_DROP`, then the whole
 * stack is shifted up if the deepest one would fall below `MAYA_MIN_DUNGEON_Y`.
 * Shifting the stack (rather than clamping each level) keeps every level
 * distinct and the descent ramps consistent.
 */
function makeLevelY(plazaY: number): (level: number) => number {
	const raw = (level: number) =>
		plazaY - MAYA_FIRST_LEVEL_DROP - level * MAYA_LEVEL_DROP;

	const deepest = raw(MAYA_LEVEL_COUNT - 1);
	const shift = deepest < MAYA_MIN_DUNGEON_Y ? MAYA_MIN_DUNGEON_Y - deepest : 0;

	return (level: number) => raw(level) + shift;
}

function buildRooms(
	rng: TempleRandom,
	gridX0: number,
	gridZ0: number,
	levelY: (level: number) => number,
	level: number,
): MayaChamber[] {
	const rooms: MayaChamber[] = [];

	for (let cz = 0; cz < GRID; cz++) {
		for (let cx = 0; cx < GRID; cx++) {
			// The ramp cell exists on every level (it carries the descent) and the
			// centre cell is forced on level 0 (the cenote lands in it).
			const forced =
				(cx === RAMP_CELL && cz === RAMP_CELL) ||
				(level === 0 && cx === CENTRE_CELL && cz === CENTRE_CELL);
			if (!forced && !rng.chance(0.72)) continue;

			const cell = cellRect(gridX0, gridZ0, cx, cz);
			const w = rng.range(13, 19);
			const d = rng.range(13, 19);
			const x0 = cell.x0 + rng.range(3, CELL - w - 3);
			const z0 = cell.z0 + rng.range(3, CELL - d - 3);

			rooms.push({
				level,
				floorY: levelY(level),
				rect: { x0, x1: x0 + w - 1, z0, z1: z0 + d - 1 },
				kind: "gallery",
				torches: scatterTorches(rng, w, d),
				caches: [],
				cacheTiers: [],
				guards: scatterGuards(rng, w, d, level),
			});
		}
	}

	return rooms;
}

/**
 * Torch positions inset from the room's four walls. Shuffled so rooms are not
 * all lit in the same order.
 */
function scatterTorches(
	rng: TempleRandom,
	w: number,
	d: number,
): (readonly [number, number])[] {
	const inset = 2;
	const spots: [number, number][] = [];

	const alongX = Math.max(2, Math.min(4, Math.floor(w / 4)));
	for (let i = 0; i < alongX; i++) {
		const lx =
			inset + Math.floor(((i + 1) * (w - 1 - inset * 2)) / (alongX + 1));
		spots.push([lx, 0]);
		spots.push([lx, d - 1]);
	}

	const alongZ = Math.max(2, Math.min(4, Math.floor(d / 4)));
	for (let i = 0; i < alongZ; i++) {
		const lz =
			inset + Math.floor(((i + 1) * (d - 1 - inset * 2)) / (alongZ + 1));
		spots.push([0, lz]);
		spots.push([w - 1, lz]);
	}

	for (let i = spots.length - 1; i > 0; i--) {
		const j = rng.int(i + 1);
		const tmp = spots[i];
		spots[i] = spots[j];
		spots[j] = tmp;
	}

	// Offsets are relative to the room's min corner; the caller applies them.
	return spots;
}

/** 1-3 guardians, offset from the walls. Deeper floors skew towards skeletons. */
function scatterGuards(
	rng: TempleRandom,
	w: number,
	d: number,
	level: number,
): (readonly [number, number, MayaGuardKind])[] {
	const count = rng.range(1, 3);
	const guards: [number, number, MayaGuardKind][] = [];

	// Per-dungeon flavour rather than a per-room reroll.
	const skeletonOdds = 0.2 + level * 0.18;

	for (let i = 0; i < count; i++) {
		guards.push([
			rng.range(2, w - 3),
			rng.range(2, d - 3),
			rng.chance(skeletonOdds) ? "skeleton" : "zombie",
		]);
	}

	return guards;
}

/**
 * Connect each occupied grid cell to its occupied +X / +Z neighbour. The path
 * is up to three straight segments: out of room A to the shared cell boundary,
 * along the boundary, then into room B.
 */
function buildCorridors(
	rooms: readonly MayaChamber[],
	gridX0: number,
	gridZ0: number,
): MayaCorridor[] {
	const corridors: MayaCorridor[] = [];
	const byCell = new Map<string, MayaChamber>();

	for (const room of rooms) {
		const { cx, cz } = cellOfRect(gridX0, gridZ0, room.rect);
		const key = `${cx},${cz}`;
		if (!byCell.has(key)) byCell.set(key, room);
	}

	for (const room of rooms) {
		const { cx, cz } = cellOfRect(gridX0, gridZ0, room.rect);
		const from = rectCentre(room.rect);

		const east = byCell.get(`${cx + 1},${cz}`);
		if (east) {
			const bx = gridX0 + (cx + 1) * CELL;
			const to = rectCentre(east.rect);
			corridors.push({
				level: room.level,
				floorY: room.floorY,
				width: 3,
				points: [from.x, from.z, bx, from.z, bx, to.z, to.x, to.z],
			});
		}

		const south = byCell.get(`${cx},${cz + 1}`);
		if (south) {
			const bz = gridZ0 + (cz + 1) * CELL;
			const to = rectCentre(south.rect);
			corridors.push({
				level: room.level,
				floorY: room.floorY,
				width: 3,
				points: [from.x, from.z, from.x, bz, to.x, bz, to.x, to.z],
			});
		}
	}

	return corridors;
}

/**
 * Locate the room that occupies a given grid cell on a level. The ramp cell is
 * forced occupied on every level, so this always finds one.
 */
function roomInCell(
	rooms: readonly MayaChamber[],
	gridX0: number,
	gridZ0: number,
	level: number,
	cx: number,
	cz: number,
): MayaChamber | undefined {
	return rooms.find((room) => {
		if (room.level !== level) return false;
		const cell = cellOfRect(gridX0, gridZ0, room.rect);
		return cell.cx === cx && cell.cz === cz;
	});
}

/** Walkable width of a descent ramp and its landings. */
const RAMP_WIDTH = 3;

/**
 * The surface -> level 0 descent: a 1:1 flight cut into a slot that runs from
 * the plaza deck down through the pyramid's tiers to the entry hall.
 *
 * The flight walks inward along -Z from the plaza, so the player steps straight
 * onto it from the causeway. The slot is hollowed out of every pyramid tier it
 * passes through, which is what produces the "collapsed shaft down the middle
 * of the temple" read.
 *
 * `entryFloorY` is level 0's actual floor, NOT `plazaY - drop`. makeLevelY can
 * shift the whole stack up when the terrain is low enough to hit
 * MAYA_MIN_DUNGEON_Y, and deriving the drop from the plaza instead of from the
 * level would leave the shaft hanging in open rock above the entry hall.
 */
function buildCenoteRamp(
	centerX: number,
	centerZ: number,
	plazaY: number,
	entryFloorY: number,
	entryRoom: MayaChamber | undefined,
): MayaRamp[] {
	// Offset off the face centre line so the pyramid's grand flight (7 wide,
	// centred on the face) cannot land in the shaft mouth.
	const lane = centerX + CENOTE_LATERAL_OFFSET_X;
	const drop = plazaY - entryFloorY;
	const flightStartZ = centerZ + CENOTE_FLIGHT_START_Z;
	const flightEndZ = flightStartZ - drop;

	if (drop <= 0) return [];

	const ramps: MayaRamp[] = [
		{
			axis: "z",
			fixed: lane,
			from: flightStartZ,
			// Inclusive of both ends, so the flight covers drop + 1 treads and
			// lands exactly on entryFloorY.
			to: flightEndZ,
			y0: plazaY,
			dir: -1,
			width: RAMP_WIDTH,
		},
	];

	// Flat run from the foot of the flight into the entry hall. Starts exactly
	// where the flight ends so the two cross-sections coincide.
	if (entryRoom) {
		const target = rectCentre(entryRoom.rect);
		ramps.push({
			axis: "z",
			fixed: lane,
			from: flightEndZ,
			to: target.z,
			y0: entryFloorY,
			dir: 0,
			width: RAMP_WIDTH,
		});
		// The entry hall's centre is at the temple's X, so bridge the lateral
		// offset at the foot of the flight.
		ramps.push({
			axis: "x",
			fixed: target.z,
			from: lane,
			to: target.x,
			y0: entryFloorY,
			dir: 0,
			width: RAMP_WIDTH,
		});
	}

	return ramps;
}

/**
 * Z offset of the descent flight's head, relative to the temple centre.
 *
 * 30 puts the mouth out on the plaza, past the base tier (half 23), so the
 * player walks straight off the causeway onto the first tread.
 */
export const CENOTE_FLIGHT_START_Z = 30;

/**
 * Lateral offset of the cenote from the temple centre, in X.
 *
 * The four grand pyramid flights run along the face centre lines, 7 blocks
 * wide, so the shaft is offset well clear of them. Without this the +Z flight
 * would fill the shaft mouth with treads and the descent would be unreachable.
 */
export const CENOTE_LATERAL_OFFSET_X = 14;

/**
 * Level N -> level N+1 descent, inside the ramp cell.
 *
 * Rooms are inset 3..22 blocks within their 26-wide cell, so the strip at
 * `cell.x0 + 24` is always free of room geometry. The rooms above and below can
 * sit at unrelated Z, so the path is four straight segments that bracket the
 * flight:
 *
 *   1. flat along X at the upper room's Z, onto the head of the flight
 *   2. the descending flight, along Z in the free strip
 *   3. flat along Z at the flight's foot, over to the lower room's Z
 *   4. flat along X into the lower room
 *
 * Every segment boundary is placed at the previous segment's final
 * cross-section, so consecutive segments meet exactly rather than merely
 * adjacent — otherwise the player would step into a wall at each junction.
 */
function buildDescentRamp(
	gridX0: number,
	gridZ0: number,
	levelY: (level: number) => number,
	level: number,
	roomAbove: MayaChamber | undefined,
	roomBelow: MayaChamber | undefined,
): MayaRamp[] {
	const cell = cellRect(gridX0, gridZ0, RAMP_CELL, RAMP_CELL);

	const topY = levelY(level);
	const bottomY = levelY(level + 1);
	const drop = topY - bottomY;

	const lane = cell.x0 + 24;

	// The flight starts level with the room above, so segment 1 lands exactly
	// on its head. Dropping `drop` blocks along +Z stays inside the cell: the
	// room centre is at most cell.z0 + 13, and the cell is 26 deep.
	const headZ = roomAbove ? rectCentre(roomAbove.rect).z : cell.z0 + 6;
	const footZ = headZ + drop;

	const aboveX = roomAbove ? rectCentre(roomAbove.rect).x : lane;
	const belowX = roomBelow ? rectCentre(roomBelow.rect).x : lane;
	const belowZ = roomBelow ? rectCentre(roomBelow.rect).z : footZ;

	return [
		{
			axis: "x",
			fixed: headZ,
			from: aboveX,
			to: lane,
			y0: topY,
			dir: 0,
			width: RAMP_WIDTH,
		},
		{
			axis: "z",
			fixed: lane,
			from: headZ,
			to: footZ,
			y0: topY,
			dir: -1,
			width: RAMP_WIDTH,
		},
		{
			axis: "z",
			fixed: lane,
			from: footZ,
			to: belowZ,
			y0: bottomY,
			dir: 0,
			width: RAMP_WIDTH,
		},
		{
			axis: "x",
			fixed: belowZ,
			from: lane,
			to: belowX,
			y0: bottomY,
			dir: 0,
			width: RAMP_WIDTH,
		},
	];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build the complete, deterministic layout for one temple.
 *
 * `ground` must be `getFinalTerrainHeight` (see the module header) so the
 * worker and the main thread derive identical Y values.
 */
export function buildMayaTempleLayout(
	templeId: number,
	seed: number,
	centerX: number,
	centerZ: number,
	ground: GroundSampler,
): MayaTempleLayout {
	const rng = new TempleRandom(templeId, seed, 1);
	const plazaY = plazaSurfaceY(ground, centerX, centerZ);
	const levelY = makeLevelY(plazaY);

	// --- rooms and corridors -------------------------------------------
	const gridX0 = centerX - Math.floor(GRID_SPAN / 2);
	const gridZ0 = centerZ - Math.floor(GRID_SPAN / 2);

	const rawRooms: MayaChamber[] = [];
	const corridors: MayaCorridor[] = [];

	for (let level = 0; level < MAYA_LEVEL_COUNT; level++) {
		const levelRooms = buildRooms(rng, gridX0, gridZ0, levelY, level);
		rawRooms.push(...levelRooms);
		corridors.push(...buildCorridors(levelRooms, gridX0, gridZ0));
	}

	// --- vertical circulation ------------------------------------------
	// Built after the rooms so each flight can be tied to the actual room
	// centres it has to connect.
	const ramps: MayaRamp[] = [];

	const centreRoom = roomInCell(
		rawRooms,
		gridX0,
		gridZ0,
		0,
		CENTRE_CELL,
		CENTRE_CELL,
	);

	ramps.push(
		...buildCenoteRamp(centerX, centerZ, plazaY, levelY(0), centreRoom),
	);

	for (let level = 0; level < MAYA_LEVEL_COUNT - 1; level++) {
		ramps.push(
			...buildDescentRamp(
				gridX0,
				gridZ0,
				levelY,
				level,
				roomInCell(rawRooms, gridX0, gridZ0, level, RAMP_CELL, RAMP_CELL),
				roomInCell(rawRooms, gridX0, gridZ0, level + 1, RAMP_CELL, RAMP_CELL),
			),
		);
	}

	const rampCell = cellRect(gridX0, gridZ0, RAMP_CELL, RAMP_CELL);

	// Boss arena: deepest level, room furthest from the ramp cell, so reaching
	// it means crossing the floor.
	const deepest = rawRooms.filter(
		(room) => room.level === MAYA_LEVEL_COUNT - 1,
	);
	let bossRoom = deepest[0];
	for (const room of deepest) {
		if (rectDistSq(room.rect, rampCell) > rectDistSq(bossRoom.rect, rampCell)) {
			bossRoom = room;
		}
	}
	if (!bossRoom) bossRoom = rawRooms[rawRooms.length - 1];

	// Glyph sanctums: on each middle level, the room furthest from the ramp
	// cell (excluding the arena). Spreading the three across separate levels
	// forces the player through the whole dungeon before the gate opens.
	const sanctumRooms: MayaChamber[] = [];
	for (let level = 1; level < MAYA_LEVEL_COUNT; level++) {
		const candidates = rawRooms.filter(
			(room) =>
				room.level === level &&
				room !== bossRoom &&
				rectDistSq(room.rect, rampCell) > CELL * CELL,
		);
		if (candidates.length === 0) continue;
		let best = candidates[0];
		let bestDist = rectDistSq(best.rect, rampCell);
		for (const candidate of candidates) {
			const d = rectDistSq(candidate.rect, rampCell);
			if (d > bestDist) {
				bestDist = d;
				best = candidate;
			}
		}
		sanctumRooms.push(best);
	}

	// --- roles and contents -------------------------------------------
	const rooms: MayaChamber[] = rawRooms.map((room) => {
		let kind: MayaRoomKind = "gallery";
		if (room === centreRoom) kind = "hall";
		else if (room === bossRoom) kind = "boss";
		else if (sanctumRooms.includes(room)) kind = "sanctum";
		else if (rng.chance(0.14)) kind = "armory";
		else if (rng.chance(0.1)) kind = "treasury";
		else if (rng.chance(0.12)) kind = "cistern";

		return populate(rng, room, kind);
	});

	const resolvedBoss = rooms.find((room) => room.kind === "boss") ?? bossRoom;

	// --- glyphs ---------------------------------------------------------
	const glyphs: MayaGlyph[] = rooms
		.filter((room) => room.kind === "sanctum")
		.map((room) => makeGlyph(room));

	// The arena must have an approach before the gate can be placed on it. A
	// room's neighbours are chosen at random, so the deepest level can come up
	// with the arena completely isolated — in which case the gate would have
	// nothing to seal and would fall back to a wall standing on the boss.
	ensureBossApproach(rooms, corridors, resolvedBoss, rampCell);

	const gate = makeBossGate(rooms, corridors, rampCell);
	if (gate) glyphs.push(gate);
	// --- guardian posts and caches -------------------------------------
	const guards: MayaGuardianPost[] = [];
	const caches: MayaLootCache[] = [];

	for (const room of rooms) {
		for (const [lx, lz, mobType] of room.guards) {
			guards.push({
				x: room.rect.x0 + lx,
				// A room's floor material occupies floorY - 1 and the carved
				// interior starts at floorY, so floorY is the voxel a mob's feet
				// stand in. MayaDungeonEncounter probes exactly that (solid
				// below at floorY - 1, air at floorY).
				y: room.floorY,
				z: room.rect.z0 + lz,
				mobType,
				boss: false,
			});
		}
		for (let i = 0; i < room.caches.length; i++) {
			caches.push({
				x: room.rect.x0 + room.caches[i][0],
				y: room.floorY,
				z: room.rect.z0 + room.caches[i][1],
				tier: room.cacheTiers[i],
			});
		}
	}

	// The boss stands in the arena centre and never despawns.
	{
		const centre = rectCentre(resolvedBoss.rect);
		guards.push({
			x: centre.x,
			y: resolvedBoss.floorY,
			z: centre.z,
			mobType: "skeleton",
			boss: true,
		});
	}

	// --- surface geometry ----------------------------------------------
	const tiers: MayaPyramidTier[] = [];
	let tierY = plazaY;
	for (const half of PYRAMID_TIER_HALVES) {
		tiers.push({ half, y0: tierY, y1: tierY + PYRAMID_TIER_HEIGHT - 1 });
		tierY += PYRAMID_TIER_HEIGHT;
	}
	const pyramidTopY = tiers[tiers.length - 1].y1;

	const summit: MayaRect = {
		x0: centerX - 5,
		x1: centerX + 5,
		z0: centerZ - 5,
		z1: centerZ + 5,
	};

	const surfaceRooms: MayaChamber[] = (
		[
			[-30, -30],
			[30, -30],
			[30, 30],
			[-30, 30],
		] as const
	).map(([dx, dz]) => ({
		level: -1,
		floorY: plazaY,
		rect: {
			x0: centerX + dx - 6,
			x1: centerX + dx + 6,
			z0: centerZ + dz - 4,
			z1: centerZ + dz + 4,
		},
		kind: "hall" as const,
		torches: [
			[-4, 0],
			[4, 0],
			[-4, 8],
			[4, 8],
		] as const,
		caches: [] as const,
		cacheTiers: [] as const,
		guards: [] as const,
	}));

	// The cenote slot is exactly the columns the surface descent ramp hollows
	// out, so the tier fill can skip them and leave the shaft open.
	const cenoteTopZ = centerZ + CENOTE_FLIGHT_START_Z;
	const cenoteBottomZ = cenoteTopZ - MAYA_FIRST_LEVEL_DROP;
	const cenoteLaneX = centerX + CENOTE_LATERAL_OFFSET_X;
	const cenote: MayaRect = {
		x0: cenoteLaneX - 1,
		x1: cenoteLaneX + 1,
		z0: cenoteBottomZ,
		z1: cenoteTopZ,
	};

	const deepestFloorY = levelY(MAYA_LEVEL_COUNT - 1);

	return {
		templeId,
		seed,
		centerX,
		centerZ,
		plazaY,
		pyramid: tiers,
		pyramidTopY,
		summit,
		surfaceRooms,
		cenote,
		cenoteTopY: plazaY + 1,
		rooms,
		ramps,
		corridors,
		bossRoom: resolvedBoss,
		glyphs,
		guards,
		caches,
		seal: {
			minX: centerX - MAYA_SEAL_HALF_EXTENT,
			maxX: centerX + MAYA_SEAL_HALF_EXTENT,
			minZ: centerZ - MAYA_SEAL_HALF_EXTENT,
			maxZ: centerZ + MAYA_SEAL_HALF_EXTENT,
			minY: deepestFloorY - 3,
			maxY: pyramidTopY + 4,
		},
	};
}

/**
 * Plaza deck height.
 *
 * Anchored on the HIGHEST of five footprint samples rather than their mean: a
 * single pit or ravine under one corner would otherwise drag the whole plaza
 * (and with it every dungeon level) down into the rock, leaving a temple that
 * is 70 blocks underground and whose cenote misses the entry hall entirely.
 *
 * When the spread is extreme — a cliff, say — fall back to the mean instead,
 * because honouring the high sample there would build a 50-block skirt.
 */
function plazaSurfaceY(
	ground: GroundSampler,
	centerX: number,
	centerZ: number,
): number {
	const inset = MAYA_TEMPLE_HALF_EXTENT - 4;
	const samples = [
		ground(centerX, centerZ),
		ground(centerX - inset, centerZ - inset),
		ground(centerX + inset, centerZ - inset),
		ground(centerX - inset, centerZ + inset),
		ground(centerX + inset, centerZ + inset),
	];

	let lo = Infinity;
	let hi = -Infinity;
	let sum = 0;
	for (const value of samples) {
		if (value < lo) lo = value;
		if (value > hi) hi = value;
		sum += value;
	}

	return hi - lo > MAX_PLAZA_RELIEF ? Math.round(sum / samples.length) : hi;
}

/**
 * Can a temple actually be built at this site?
 *
 * Only the surface height matters: the dungeon needs MAYA_TOTAL_DUNGEON_DEPTH
 * of room below the plaza, and the level stack is clamped at
 * MAYA_MIN_DUNGEON_Y. Rejecting low sites keeps the clamp from ever inverting
 * the temple.
 */
export function isMayaTempleSiteValid(
	centerX: number,
	centerZ: number,
	ground: GroundSampler,
): boolean {
	return plazaSurfaceY(ground, centerX, centerZ) >= MAYA_MIN_PLAZA_Y;
}

/**
 * Give each room an appropriate loot density. Guardians are stripped from the
 * boss chamber — the boss itself is posted separately, in the centre.
 */
function populate(
	rng: TempleRandom,
	room: MayaChamber,
	kind: MayaRoomKind,
): MayaChamber {
	const w = rectWidth(room.rect);
	const d = rectDepth(room.rect);

	let wantCaches: number;
	let tier: MayaLootTier;
	switch (kind) {
		case "boss":
			wantCaches = 2;
			tier = "boss";
			break;
		case "treasury":
		case "armory":
			wantCaches = 2;
			tier = "treasury";
			break;
		case "sanctum":
			wantCaches = 1;
			tier = "vault";
			break;
		case "hall":
			wantCaches = 0;
			tier = "alcove";
			break;
		default:
			// Deliberately sparse: a cache in most rooms turns the dungeon into a
			// loot-sweep with no destination. The named room kinds above are where
			// the player should be pulling open crates.
			wantCaches = rng.chance(0.28) ? 1 : 0;
			tier = "alcove";
			break;
	}

	const caches: [number, number][] = [];
	const cacheTiers: MayaLootTier[] = [];
	for (let i = 0; i < wantCaches; i++) {
		caches.push([rng.range(2, w - 3), rng.range(2, d - 3)]);
		cacheTiers.push(tier);
	}

	return {
		...room,
		kind,
		caches,
		cacheTiers,
		// Boss guards are posted separately, in the arena centre. Cisterns are
		// flooded to ankle depth, which is not a standable spot for a mob, so
		// they are left empty rather than spawning guardians that immediately
		// fail to find footing.
		guards: kind === "boss" || kind === "cistern" ? [] : room.guards,
	};
}

/**
 * Guarantee the boss arena has at least one corridor leading out of it.
 *
 * Rooms are placed at random, so the deepest level can come up with the arena
 * boxed in by solid rock and no neighbour at all. Without an approach the gate
 * has nothing to seal, and the player would reach the boss by mining straight
 * through the wall. This synthesises a corridor to the nearest other room on
 * the same level (the ramp cell's room is always present, so one always exists).
 */
function ensureBossApproach(
	rooms: readonly MayaChamber[],
	corridors: MayaCorridor[],
	boss: MayaChamber,
	rampCell: MayaRect,
): void {
	const hasApproach = corridors.some(
		(corridor) =>
			corridor.level === boss.level &&
			rectContains(boss.rect, corridor.points[0], corridor.points[1]),
	);
	if (hasApproach) return;

	const from = rectCentre(boss.rect);

	let target: { x: number; z: number } | null = null;
	let bestDist = Infinity;
	for (const room of rooms) {
		if (room === boss || room.level !== boss.level) continue;
		const centre = rectCentre(room.rect);
		const d = (centre.x - from.x) ** 2 + (centre.z - from.z) ** 2;
		if (d < bestDist) {
			bestDist = d;
			target = centre;
		}
	}

	// Nothing else on this level: fall back to the ramp cell's room, which is
	// forced present on every level.
	if (!target) {
		const rampCentre = rectCentre(rampCell);
		target = rampCentre;
	}

	// L-shaped path: along X to the target's X, then along Z. The first segment
	// is nudged sideways when it would be degenerate, because the gate is placed
	// on the first segment and a zero-length run has no perpendicular extent to
	// build a wall across.
	let midX = target.x;
	if (midX === from.x) midX = from.x + BOSS_GATE_CLEARANCE + 2;

	corridors.push({
		level: boss.level,
		floorY: boss.floorY,
		width: 3,
		points: [from.x, from.z, midX, from.z, midX, target.z, target.x, target.z],
	});
}

/** Glyph block in the room centre, ringed by four crystal blocks. */
function makeGlyph(room: MayaChamber): MayaGlyph {
	const centre = rectCentre(room.rect);
	const y = room.floorY;

	return {
		x: centre.x,
		y,
		z: centre.z,
		ring: [
			[centre.x - 2, y, centre.z],
			[centre.x + 2, y, centre.z],
			[centre.x, y, centre.z - 2],
			[centre.x, y, centre.z + 2],
		],
	};
}

/**
 * Seal the arena behind a glyph wall.
 *
 * The wall spans a corridor that LEAVES the arena, from floor to ceiling, so the
 * arena is genuinely closed until the three sanctum seals are charged and the
 * wall is dissolved. Matching on the corridor's *start* rather than its end is
 * deliberate: corridors are only generated towards a room's +X / +Z grid
 * neighbour, and the arena is always the room furthest from the ramp cell �
 * i.e. a grid corner � so nothing is ever generated pointing at it.
 */
function makeBossGate(
	rooms: readonly MayaChamber[],
	corridors: readonly MayaCorridor[],
	rampCell: MayaRect,
): MayaGlyph | null {
	const boss = rooms.find((room) => room.kind === "boss");
	if (!boss) return null;

	// Corridors on the arena's level whose first waypoint is inside the arena.
	const leaving = corridors.filter(
		(corridor) =>
			corridor.level === boss.level &&
			rectContains(boss.rect, corridor.points[0], corridor.points[1]),
	);

	const y0 = boss.floorY + 1;
	const y1 = boss.floorY + MAYA_ROOM_HEIGHT;

	if (leaving.length > 0) {
		// Prefer the exit the player is most likely to walk towards.
		let chosen = leaving[0];
		let chosenDist = pointDistSq(
			chosen.points[0],
			chosen.points[1],
			rampCell.x0,
			rampCell.z0,
		);
		for (const corridor of leaving) {
			const d = pointDistSq(
				corridor.points[0],
				corridor.points[1],
				rampCell.x0,
				rampCell.z0,
			);
			if (d < chosenDist) {
				chosenDist = d;
				chosen = corridor;
			}
		}

		// The first segment runs (x0,z0) -> (x1,z1); one axis is constant, and
		// that is the axis the wall spans.
		const sx = chosen.points[0];
		const sz = chosen.points[1];
		const ex = chosen.points[2];
		const ez = chosen.points[3];
		const across: "x" | "z" = sx === ex ? "z" : "x";

		// Sit the wall outside the arena's threshold, but never on the boss post
		// — the post is the arena centre, and a wall there would seal the boss
		// into a solid block and leave the fight with no headroom.
		const length = Math.max(
			1,
			across === "x" ? Math.abs(ex - sx) : Math.abs(ez - sz),
		);
		const along = Math.min(length, Math.max(BOSS_GATE_CLEARANCE, length * 0.45));
		const wallX = across === "x" ? sx + Math.sign(ex - sx) * along : sx;
		const wallZ = across === "x" ? sz : sz + Math.sign(ez - sz) * along;

		return {
			x: wallX,
			y: y0,
			z: wallZ,
			ring: [],
			gate: { wall: buildGateWall(wallX, wallZ, across, chosen.width, y0, y1), across },
		};
	}

	// No corridor leaves the arena (possible if the level's rooms are isolated).
	// Seal it with a free-standing wall across the room instead, so the boss is
	// still gated.
	const centre = rectCentre(boss.rect);
	return {
		x: centre.x,
		y: y0,
		z: centre.z,
		ring: [],
		gate: {
			wall: buildGateWall(centre.x, centre.z, "x", 5, y0, y1),
			across: "x",
		},
	};
}

/** A 1-block-thick wall spanning `width` blocks, from `y0` to `y1` inclusive. */
function buildGateWall(
	x: number,
	z: number,
	across: "x" | "z",
	width: number,
	y0: number,
	y1: number,
): [number, number, number][] {
	const half = Math.floor((width - 1) / 2);
	const wall: [number, number, number][] = [];
	for (let y = y0; y <= y1; y++) {
		for (let o = -half; o <= half; o++) {
			if (across === "x") wall.push([x, y, z + o]);
			else wall.push([x + o, y, z]);
		}
	}
	return wall;
}

function pointDistSq(
	ax: number,
	az: number,
	bx: number,
	bz: number,
): number {
	const dx = ax - bx;
	const dz = az - bz;
	return dx * dx + dz * dz;
}
