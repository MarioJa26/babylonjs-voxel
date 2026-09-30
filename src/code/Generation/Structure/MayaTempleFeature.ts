import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import type { PlaceBlockFn } from "../SurfaceGenerator";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import {
	isMayaTempleSiteValid,
	MAYA_ROOM_HEIGHT,
	MAYA_SURFACE_ROOM_HEIGHT,
	MAYA_TEMPLE_HALF_EXTENT,
	type MayaChamber,
	type MayaCorridor,
	type MayaRamp,
	type MayaTempleLayout,
} from "./MayaTempleLayout";
import { aabbOverlaps, chunkWorldBounds } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";
import {
	buildTempleLayout,
	resolveTempleInRegion,
	sealOverlaps,
} from "./StructureSeal";

/** Jungle family — same gate TropicalTempleFeature uses. */
const MAYA_BIOMES = new Set([
	BIOME_ID.JUNGLE,
	BIOME_ID.BAMBOO_FOREST,
	BIOME_ID.MANGROVE,
	BIOME_ID.TROPICAL_ISLAND,
	BIOME_ID.CLOUD_FOREST,
]);

/**
 * Search window, in chunks, around the chunk being generated. Mirrors
 * STRUCTURE_SEARCH_RADIUS in Terrain/StructurePlacer: a structure is only
 * ever emitted by chunks within that radius of its centre chunk, so this
 * feature must probe the same window or it will miss its own centre.
 */
const SEARCH_RADIUS = 2;

/** Interior air height of a ramp or its landing. */
const RAMP_HEIGHT = 3;

/**
 * How far out from the temple centre each grand pyramid flight reaches.
 * 32 comfortably clears the base tier (half 23) and the 96x96 plaza edge
 * (half 48) is beyond it, so the flight lands on the plaza proper.
 */
const MAYA_PYRAMID_STAIR_REACH = 32;

/** Solid block used for the levelled plaza platform. */
const PLATFORM_BLOCK = BlockType.RedSandstoneWall;
/** Deck / tread material, reads as packed sand over the platform. */
const DECK_BLOCK = BlockType.GravellySand;
/** Weathered accent scattered over the platform and pyramid faces. */
const WEATHER_BLOCK = BlockType.MossyCobble;

const SURFACE_WALL = BlockType.RedSandstoneWall;
const SURFACE_FLOOR = BlockType.RedSandstoneWall;
const SURFACE_ROOF = BlockType.AncientCrackedStone;
const COLUMN_BLOCK = BlockType.GraniteWall;

/** Dungeon palette, indexed by level — shallower floors are dressed sandstone. */
const DUNGEON_WALL = [
	BlockType.RedSandstoneWall,
	BlockType.RedSandstoneWall,
	BlockType.AncientCrackedStone,
	BlockType.AncientCrackedStone,
];
const DUNGEON_FLOOR = [
	BlockType.Cobblestone03,
	BlockType.Cobblestone03,
	BlockType.StoneTileWall,
	BlockType.Obsidian,
];
const DUNGEON_CEILING = [
	BlockType.Cobblestone03,
	BlockType.AncientCrackedStone,
	BlockType.AncientCrackedStone,
	BlockType.BasaltBlock,
];

/**
 * Large Maya temple with a multi-level dungeon beneath it.
 *
 * Perf notes, since this runs in the chunk worker for every chunkY slice in
 * `verticalBounds` for every chunk in the +/-SEARCH_RADIUS window:
 *
 *   1. The seal box (5 ground samples) gates everything else, so a Y slice
 *      that cannot intersect the temple costs one AABB test.
 *   2. The full layout is only built when that box overlaps, and the layout's
 *      Y band spans ~7 chunkY slices, so this is rare.
 *   3. Emission is split into per-band stages, each gated on its own Y range,
 *      so a slice only pays for the one stage that touches it — in particular
 *      the 96x96 platform fill runs at most twice per chunk.
 */
export class MayaTempleFeature implements IWorldFeature {
	/** Pyramid top to deepest dungeon floor, rounded out for safety. */
	public readonly verticalBounds = { minWorldY: -72, maxWorldY: 168 };
	public readonly maxAboveSurface = 48;

	public generate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		biome: Biome,
		placeBlock: PlaceBlockFn,
		seed: number,
		chunkSize: number,
		generatingChunkX: number,
		generatingChunkZ: number,
		columnPrepassResolver?: ColumnPrepassResolver,
	) {
		if (!MAYA_BIOMES.has(biome.id)) return;

		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		const chunkMinY = chunkY * chunkSize;
		const chunkMaxY = chunkMinY + chunkSize - 1;

		for (let cx = chunkX - SEARCH_RADIUS; cx <= chunkX + SEARCH_RADIUS; cx++) {
			for (
				let cz = chunkZ - SEARCH_RADIUS;
				cz <= chunkZ + SEARCH_RADIUS;
				cz++
			) {
				const resolved = resolveTempleInRegion(cx, cz, chunkSize, seed);
				if (!resolved) continue;

				// Cheap XZ test before touching ground: the seal box is a fixed
				// half-extent around the centre, so this needs no terrain.
				const half = MAYA_TEMPLE_HALF_EXTENT + 2;
				if (
					!aabbOverlaps(
						resolved.centerX - half,
						resolved.centerX + half,
						resolved.centerZ - half,
						resolved.centerZ + half,
						bounds.minX,
						bounds.maxX,
						bounds.minZ,
						bounds.maxZ,
					)
				) {
					continue;
				}

				// Site validity before anything expensive. A site whose surface is
				// too low cannot fit the dungeon beneath it, and the level clamp
				// would otherwise invert the temple (rooms above their own
				// plaza, punching through the pyramid).
				if (
					!isMayaTempleSiteValid(
						resolved.centerX,
						resolved.centerZ,
						getFinalTerrainHeight,
					)
				) {
					continue;
				}

				// Full layout, then gate on the exact seal box (which needs the
				// real plaza Y to know the temple's vertical extent).
				const layout = buildTempleLayout(resolved, seed);
				if (chunkMaxY < layout.seal.minY || chunkMinY > layout.seal.maxY) {
					continue;
				}
				if (
					!sealOverlaps(
						layout.seal,
						bounds.minX,
						chunkMinY,
						bounds.minZ,
						bounds.maxX,
						chunkMaxY,
						bounds.maxZ,
					)
				) {
					continue;
				}

				this.emit(
					layout,
					placeBlock,
					seed,
					columnPrepassResolver,
					chunkMinY,
					chunkMaxY,
				);
			}
		}
	}

	// -------------------------------------------------------------------------
	// Emission
	// -------------------------------------------------------------------------

	private emit(
		layout: MayaTempleLayout,
		placeBlock: PlaceBlockFn,
		seed: number,
		resolver: ColumnPrepassResolver | undefined,
		chunkMinY: number,
		chunkMaxY: number,
	): void {
		const b = new StructureBuilder(placeBlock, resolver, seed);

		this.emitPlatform(b, layout, chunkMinY, chunkMaxY);
		this.emitPyramid(b, layout, chunkMinY, chunkMaxY);
		this.emitSurfaceRooms(b, layout, chunkMinY, chunkMaxY);
		this.emitDungeonSolid(b, layout, chunkMinY, chunkMaxY);

		// Air is always carved after every solid write, so overlapping rooms,
		// corridors and ramps resolve to connected space rather than one
		// structure filling in another.
		this.emitDungeonAir(b, layout, chunkMinY, chunkMaxY);
	}

	/** Does [chunkMinY, chunkMaxY] intersect [minY, maxY]? */
	private static overlapsBand(
		chunkMinY: number,
		chunkMaxY: number,
		minY: number,
		maxY: number,
	): boolean {
		return chunkMaxY >= minY && chunkMinY <= maxY;
	}

	// --- surface ---------------------------------------------------------

	/**
	 * Level the whole 96x96 footprint to `plazaY`, filling each column from its
	 * own ground. Sampling the prepass here (rather than the layout's canonical
	 * height function) is safe because this only affects decorative fill; the
	 * dungeon geometry below uses the layout's own Y values.
	 */
	private emitPlatform(
		b: StructureBuilder,
		layout: MayaTempleLayout,
		chunkMinY: number,
		chunkMaxY: number,
	): void {
		const plazaY = layout.plazaY;

		// Fill spans from the lowest plausible ground up to the deck.
		if (
			!MayaTempleFeature.overlapsBand(chunkMinY, chunkMaxY, plazaY - 40, plazaY)
		) {
			return;
		}

		const half = MAYA_TEMPLE_HALF_EXTENT;
		const x0 = layout.centerX - half;
		const z0 = layout.centerZ - half;

		for (let dx = 0; dx <= half * 2; dx++) {
			for (let dz = 0; dz <= half * 2; dz++) {
				const wx = x0 + dx;
				const wz = z0 + dz;
				const ground = b.ground(wx, wz);

				// The pyramid occupies the middle; skip its footprint so the
				// tier fill is not buried in a solid slab.
				if (!MayaTempleFeature.isUnderPyramid(layout, wx, wz)) {
					if (ground < plazaY) {
						b.column(wx, ground, wz, plazaY - ground, PLATFORM_BLOCK);
					}
				}

				// Deck, weather pattern and the plaza edge kerb.
				if (dx === 0 || dz === 0 || dx === half * 2 || dz === half * 2) {
					b.set(wx, plazaY, wz, DECK_BLOCK);
				} else if ((dx + dz) % 11 === 0) {
					b.set(wx, plazaY, wz, WEATHER_BLOCK);
				} else {
					b.set(wx, plazaY, wz, PLATFORM_BLOCK);
				}
			}
		}

		// Braziers on the four processional approaches: a short pillar with a
		// torch on top, rather than a torch floating over the deck.
		for (const sign of [-1, 1]) {
			for (let i = 0; i < 4; i++) {
				const offset = half - 4 - i * 9;
				for (const [wx, wz] of [
					[layout.centerX + offset, layout.centerZ + sign * (half - 1)],
					[layout.centerX + sign * (half - 1), layout.centerZ + offset],
				] as const) {
					b.set(wx, plazaY + 1, wz, COLUMN_BLOCK);
					b.set(wx, plazaY + 2, wz, BlockType.Torch);
				}
			}
		}
	}

	private static isUnderPyramid(
		layout: MayaTempleLayout,
		wx: number,
		wz: number,
	): boolean {
		const base = layout.pyramid[0];
		const dx = Math.abs(wx - layout.centerX);
		const dz = Math.abs(wz - layout.centerZ);
		return dx <= base.half && dz <= base.half;
	}

	/**
	 * Five stacked tiers, hollowed around the cenote slot, with a staircase on
	 * each cardinal face and a summit temple on top.
	 */
	private emitPyramid(
		b: StructureBuilder,
		layout: MayaTempleLayout,
		chunkMinY: number,
		chunkMaxY: number,
	): void {
		if (
			!MayaTempleFeature.overlapsBand(
				chunkMinY,
				chunkMaxY,
				layout.plazaY - 2,
				layout.pyramidTopY + MAYA_SURFACE_ROOM_HEIGHT + 2,
			)
		) {
			return;
		}

		const c = layout.centerX;
		const cz = layout.centerZ;
		const cenote = layout.cenote;

		for (const tier of layout.pyramid) {
			for (let dx = -tier.half; dx <= tier.half; dx++) {
				for (let dz = -tier.half; dz <= tier.half; dz++) {
					const wx = c + dx;
					const wz = cz + dz;

					// Leave the cenote shaft open through every tier.
					if (
						wx >= cenote.x0 &&
						wx <= cenote.x1 &&
						wz >= cenote.z0 &&
						wz <= cenote.z1
					) {
						continue;
					}

					// Solid from the tier's base to its top.
					for (let y = tier.y0; y <= tier.y1; y++) {
						b.set(wx, y, wz, SURFACE_WALL);
					}

					// The exposed ring of the tier's top surface is the tread
					// the player actually walks on; the inner part is buried
					// under the tier above.
					if (Math.max(Math.abs(dx), Math.abs(dz)) === tier.half) {
						b.set(wx, tier.y1, wz, DECK_BLOCK);
					}
				}
			}
		}

		this.emitPyramidStairs(b, layout);
		this.emitSummit(b, layout);
	}

	/**
	 * One grand 1:1 flight per cardinal face, the way El Castillo does it: a
	 * wide stair that projects out from the summit and descends to the plaza,
	 * rather than per-tier steps hugging the tiers.
	 *
	 * The flight is cut as a channel through the tiers and then treads are laid
	 * into it, so the pyramid stays solid underneath the stair. The order
	 * matters: the channel has to be carved after the tier fill and the treads
	 * after the carve.
	 *
	 * 1:1 is not a style choice — the player's step-up height is 1.01
	 * (PlayerVehicleMotor) and hostiles' is 1.0 (HostileMob), so anything
	 * steeper is impassable and anything shallower would need a block state the
	 * generator cannot set.
	 */
	private emitPyramidStairs(
		b: StructureBuilder,
		layout: MayaTempleLayout,
	): void {
		const c = layout.centerX;
		const cz = layout.centerZ;
		const plazaY = layout.plazaY;
		const topY = layout.pyramidTopY + 1;

		const halfWidth = 3;
		const innerOffset = layout.summit.x1 - c; // 5
		const outerOffset = MAYA_PYRAMID_STAIR_REACH;
		const rise = topY - plazaY;

		for (const [axis, sign] of [
			["x", 1],
			["x", -1],
			["z", 1],
			["z", -1],
		] as const) {
			for (let step = 0; step <= rise; step++) {
				// Outward is downward: the highest tread sits against the summit.
				const at = sign * (innerOffset + (rise - step));
				const treadY = topY - step;

				for (let w = -halfWidth; w <= halfWidth; w++) {
					const wx = axis === "x" ? c + at : c + w;
					const wz = axis === "x" ? cz + w : cz + at;

					// Carve the stairwell: a few blocks below the tread (so the
					// step itself is solid) and three above it for headroom.
					const clearLo = Math.max(plazaY, treadY - 3);
					for (let y = clearLo; y <= treadY + 3; y++) {
						b.air(wx, y, wz);
					}

					b.set(wx, treadY, wz, DECK_BLOCK);
				}
			}
		}

		// Landing platform where each flight meets the plaza.
		for (const [axis, sign] of [
			["x", 1],
			["x", -1],
			["z", 1],
			["z", -1],
		] as const) {
			for (let w = -halfWidth - 1; w <= halfWidth + 1; w++) {
				for (let d = -2; d <= 1; d++) {
					const at = sign * (outerOffset + d);
					const wx = axis === "x" ? c + at : c + w;
					const wz = axis === "x" ? cz + w : cz + at;
					for (let h = 1; h <= 3; h++) b.air(wx, plazaY + h, wz);
				}
			}
		}
	}

	private emitSummit(b: StructureBuilder, layout: MayaTempleLayout): void {
		const s = layout.summit;
		const base = layout.pyramidTopY + 1;

		b.box(s.x0, base, s.z0, s.x1, base, s.z1, SURFACE_FLOOR);
		b.shell(
			s.x0,
			base + 1,
			s.z0,
			s.x1,
			base + MAYA_SURFACE_ROOM_HEIGHT,
			s.z1,
			SURFACE_WALL,
			{ side: "z+", width: 2, height: 3 },
		);
		b.box(
			s.x0,
			base + MAYA_SURFACE_ROOM_HEIGHT + 1,
			s.z0,
			s.x1,
			base + MAYA_SURFACE_ROOM_HEIGHT + 1,
			s.z1,
			SURFACE_ROOF,
		);

		for (const [dx, dz] of [
			[-3, -3],
			[3, -3],
			[-3, 3],
			[3, 3],
		] as const) {
			b.column(
				s.x0 + 5 + dx,
				base + 1,
				s.z0 + 5 + dz,
				MAYA_SURFACE_ROOM_HEIGHT,
				COLUMN_BLOCK,
			);
		}

		for (const [wx, wz] of [
			[s.x0 + 2, s.z0 + 2],
			[s.x1 - 2, s.z1 - 2],
		] as const) {
			b.set(wx, base + 1, wz, BlockType.Torch);
		}
	}

	/** Four small temples around the plaza. */
	private emitSurfaceRooms(
		b: StructureBuilder,
		layout: MayaTempleLayout,
		chunkMinY: number,
		chunkMaxY: number,
	): void {
		if (
			!MayaTempleFeature.overlapsBand(
				chunkMinY,
				chunkMaxY,
				layout.plazaY,
				layout.plazaY + MAYA_SURFACE_ROOM_HEIGHT + 2,
			)
		) {
			return;
		}

		for (const room of layout.surfaceRooms) {
			const r = room.rect;
			b.box(r.x0, room.floorY, r.z0, r.x1, room.floorY, r.z1, SURFACE_FLOOR);
			b.shell(
				r.x0,
				room.floorY + 1,
				r.z0,
				r.x1,
				room.floorY + MAYA_SURFACE_ROOM_HEIGHT,
				r.z1,
				SURFACE_WALL,
				{ side: "z+", width: 3, height: 3 },
			);
			b.box(
				r.x0,
				room.floorY + MAYA_SURFACE_ROOM_HEIGHT + 1,
				r.z0,
				r.x1,
				room.floorY + MAYA_SURFACE_ROOM_HEIGHT + 1,
				r.z1,
				SURFACE_ROOF,
			);

			// Interior columns and torches.
			for (let i = 1; i < 4; i++) {
				const wx = r.x0 + Math.floor(((r.x1 - r.x0) * i) / 4);
				for (const wz of [r.z0 + 2, r.z1 - 2]) {
					b.column(
						wx,
						room.floorY + 1,
						wz,
						MAYA_SURFACE_ROOM_HEIGHT,
						COLUMN_BLOCK,
					);
				}
			}
			for (const [lx, lz] of room.torches) {
				b.set(r.x0 + lx, room.floorY + 2, r.z0 + lz, BlockType.Torch);
			}
		}
	}

	// --- dungeon: solid pass --------------------------------------------

	private emitDungeonSolid(
		b: StructureBuilder,
		layout: MayaTempleLayout,
		chunkMinY: number,
		chunkMaxY: number,
	): void {
		for (const room of layout.rooms) {
			if (
				!MayaTempleFeature.overlapsBand(
					chunkMinY,
					chunkMaxY,
					room.floorY - 1,
					room.floorY + MAYA_ROOM_HEIGHT + 1,
				)
			) {
				continue;
			}
			// Fill the whole footprint solid; the air pass hollows it out. This
			// makes overlapping rooms and corridors merge cleanly.
			b.box(
				room.rect.x0,
				room.floorY - 1,
				room.rect.z0,
				room.rect.x1,
				room.floorY + MAYA_ROOM_HEIGHT,
				room.rect.z1,
				DUNGEON_WALL[room.level] ?? DUNGEON_WALL[0],
			);
			// Floor and ceiling get their own material.
			b.box(
				room.rect.x0,
				room.floorY - 1,
				room.rect.z0,
				room.rect.x1,
				room.floorY - 1,
				room.rect.z1,
				DUNGEON_FLOOR[room.level] ?? DUNGEON_FLOOR[0],
			);
			b.box(
				room.rect.x0,
				room.floorY + MAYA_ROOM_HEIGHT,
				room.rect.z0,
				room.rect.x1,
				room.floorY + MAYA_ROOM_HEIGHT,
				room.rect.z1,
				DUNGEON_CEILING[room.level] ?? DUNGEON_CEILING[0],
			);
		}

		for (const corridor of layout.corridors) {
			if (
				!MayaTempleFeature.overlapsBand(
					chunkMinY,
					chunkMaxY,
					corridor.floorY - 1,
					corridor.floorY + MAYA_ROOM_HEIGHT + 1,
				)
			) {
				continue;
			}
			this.fillCorridor(b, corridor);
		}

		for (const ramp of layout.ramps) {
			if (!MayaTempleFeature.rampOverlaps(ramp, chunkMinY, chunkMaxY)) continue;
			this.fillRamp(b, ramp);
		}
	}

	private fillCorridor(b: StructureBuilder, corridor: MayaCorridor): void {
		const half = (corridor.width - 1) / 2;
		for (let i = 0; i + 3 < corridor.points.length; i += 2) {
			this.fillAxisRun(
				b,
				"x",
				corridor.points[i],
				corridor.points[i + 2],
				corridor.points[i + 1],
				corridor.points[i + 3],
				half,
				corridor.floorY - 1,
				corridor.floorY + MAYA_ROOM_HEIGHT,
				DUNGEON_FLOOR[corridor.level] ?? DUNGEON_FLOOR[0],
			);
		}
	}

	/**
	 * Fill a straight run of blocks along one axis, extruded `width` blocks
	 * across the other axis, from `y0` to `y1` inclusive.
	 */
	private fillAxisRun(
		b: StructureBuilder,
		axis: "x" | "z",
		a0: number,
		a1: number,
		fixed0: number,
		fixed1: number,
		half: number,
		y0: number,
		y1: number,
		block: number,
	): void {
		const lo = Math.min(a0, a1);
		const hi = Math.max(a0, a1);
		const fLo = Math.min(fixed0, fixed1) - half;
		const fHi = Math.max(fixed0, fixed1) + half;

		for (let along = lo; along <= hi; along++) {
			for (let across = fLo; across <= fHi; across++) {
				const wx = axis === "x" ? along : across;
				const wz = axis === "x" ? across : along;
				for (let y = y0; y <= y1; y++) b.set(wx, y, wz, block);
			}
		}
	}

	/**
	 * Fill a 1:1 ramp as a solid stepped mass one block wider than the
	 * walkable strip, so the air pass leaves side walls for free.
	 */
	private fillRamp(b: StructureBuilder, ramp: MayaRamp): void {
		const half = (ramp.width - 1) / 2;
		const sign = ramp.to >= ramp.from ? 1 : -1;
		const steps = Math.abs(ramp.to - ramp.from) + 1;

		for (let t = 0; t < steps; t++) {
			const along = ramp.from + sign * t;
			const floorY = ramp.y0 + ramp.dir * t;

			for (let across = -half - 1; across <= half + 1; across++) {
				const wx = ramp.axis === "x" ? along : ramp.fixed + across;
				const wz = ramp.axis === "x" ? ramp.fixed + across : along;
				for (let y = floorY - 1; y <= floorY + RAMP_HEIGHT; y++) {
					b.set(wx, y, wz, DUNGEON_FLOOR[0]);
				}
			}
		}
	}

	// --- dungeon: air pass ----------------------------------------------

	private emitDungeonAir(
		b: StructureBuilder,
		layout: MayaTempleLayout,
		chunkMinY: number,
		chunkMaxY: number,
	): void {
		// Rooms first, so corridor carving can punch doorways through walls.
		for (const room of layout.rooms) {
			if (
				!MayaTempleFeature.overlapsBand(
					chunkMinY,
					chunkMaxY,
					room.floorY - 1,
					room.floorY + MAYA_ROOM_HEIGHT + 1,
				)
			) {
				continue;
			}
			this.carveRoom(b, room);
		}

		for (const corridor of layout.corridors) {
			if (
				!MayaTempleFeature.overlapsBand(
					chunkMinY,
					chunkMaxY,
					corridor.floorY - 1,
					corridor.floorY + MAYA_ROOM_HEIGHT + 1,
				)
			) {
				continue;
			}
			this.carveCorridor(b, corridor);
		}

		for (const ramp of layout.ramps) {
			if (!MayaTempleFeature.rampOverlaps(ramp, chunkMinY, chunkMaxY)) continue;
			this.carveRamp(b, ramp);
		}

		this.emitDungeonDressing(b, layout, chunkMinY, chunkMaxY);
	}

	private carveRoom(b: StructureBuilder, room: MayaChamber): void {
		const r = room.rect;
		// Interior only — the perimeter stays as wall.
		b.box(
			r.x0 + 1,
			room.floorY,
			r.z0 + 1,
			r.x1 - 1,
			room.floorY + MAYA_ROOM_HEIGHT - 1,
			r.z1 - 1,
			BlockType.Air,
		);

		// Floor dressing, torches, loot caches and the puzzle glyph.
		this.dressRoom(b, room);
	}

	private carveCorridor(b: StructureBuilder, corridor: MayaCorridor): void {
		const half = (corridor.width - 1) / 2;
		for (let i = 0; i + 3 < corridor.points.length; i += 2) {
			this.fillAxisRun(
				b,
				"x",
				corridor.points[i],
				corridor.points[i + 2],
				corridor.points[i + 1],
				corridor.points[i + 3],
				half,
				corridor.floorY,
				corridor.floorY + MAYA_ROOM_HEIGHT - 1,
				BlockType.Air,
			);
		}

		// Wall sconces so corridors are navigable without a torch per block.
		const [x0, z0, x1, z1] = corridor.points;
		const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
		const spacing = 7;
		for (let s = spacing; s < steps; s += spacing) {
			const t = s / steps;
			const wx = Math.round(x0 + (x1 - x0) * t);
			const wz = Math.round(z0 + (z1 - z0) * t);
			b.set(wx, corridor.floorY + 2, wz, BlockType.Torch);
		}
	}

	private carveRamp(b: StructureBuilder, ramp: MayaRamp): void {
		const half = (ramp.width - 1) / 2;
		const sign = ramp.to >= ramp.from ? 1 : -1;
		const steps = Math.abs(ramp.to - ramp.from) + 1;

		for (let t = 0; t < steps; t++) {
			const along = ramp.from + sign * t;
			const floorY = ramp.y0 + ramp.dir * t;

			for (let across = -half; across <= half; across++) {
				const wx = ramp.axis === "x" ? along : ramp.fixed + across;
				const wz = ramp.axis === "x" ? ramp.fixed + across : along;
				for (let y = floorY; y <= floorY + RAMP_HEIGHT - 1; y++) {
					b.set(wx, y, wz, BlockType.Air);
				}
			}
		}
	}

	private static rampOverlaps(
		ramp: MayaRamp,
		chunkMinY: number,
		chunkMaxY: number,
	): boolean {
		const steps = Math.abs(ramp.to - ramp.from);
		const drop = ramp.dir * steps;
		const lo = Math.min(ramp.y0, ramp.y0 + drop) - 1;
		const hi = Math.max(ramp.y0, ramp.y0 + drop) + RAMP_HEIGHT + 1;
		return chunkMaxY >= lo && chunkMinY <= hi;
	}

	// --- dungeon dressing ----------------------------------------------

	/**
	 * Per-room detail: torch sconces, loot crates, the puzzle glyph and its
	 * crystal ring, and a flooded cistern for the cistern rooms. Boss rooms get
	 * a lava margin instead.
	 */
	private emitDungeonDressing(
		b: StructureBuilder,
		layout: MayaTempleLayout,
		chunkMinY: number,
		chunkMaxY: number,
	): void {
		const glyphs = layout.glyphs;

		// The boss gate is a free-standing wall, not tied to any one room, so
		// it is placed once rather than inside the room loop.
		for (const glyph of glyphs) {
			if (!glyph.gate) continue;
			if (
				!MayaTempleFeature.overlapsBand(
					chunkMinY,
					chunkMaxY,
					glyph.y,
					glyph.y + MAYA_ROOM_HEIGHT,
				)
			) {
				continue;
			}
			for (const [gx, gy, gz] of glyph.gate.wall) {
				b.set(gx, gy, gz, BlockType.TempleGlyph);
			}
		}

		for (const room of layout.rooms) {
			if (
				!MayaTempleFeature.overlapsBand(
					chunkMinY,
					chunkMaxY,
					room.floorY,
					room.floorY + MAYA_ROOM_HEIGHT,
				)
			) {
				continue;
			}
			const r = room.rect;

			// Sconces.
			for (const [lx, lz] of room.torches) {
				b.set(r.x0 + lx, room.floorY + 2, r.z0 + lz, BlockType.Torch);
			}

			// Loot caches — the crate block itself; contents are rolled at
			// runtime by TempleLootTable when the player first opens it.
			for (const [lx, lz] of room.caches) {
				b.set(r.x0 + lx, room.floorY + 1, r.z0 + lz, BlockType.WoodCrate);
			}

			// Puzzle glyph + crystal ring.
			for (const glyph of glyphs) {
				if (glyph.gate) continue;
				if (glyph.x < r.x0 || glyph.x > r.x1) continue;
				if (glyph.z < r.z0 || glyph.z > r.z1) continue;
				if (glyph.y !== room.floorY) continue;

				b.set(glyph.x, glyph.y, glyph.z, BlockType.TempleGlyph);
				for (const [rx, ry, rz] of glyph.ring) {
					b.set(rx, ry, rz, BlockType.CrystalBlock);
				}
			}

			// Room-specific set dressing.
			if (room.kind === "cistern") {
				// Shallow water sheet over the floor.
				b.box(
					r.x0 + 1,
					room.floorY,
					r.z0 + 1,
					r.x1 - 1,
					room.floorY,
					r.z1 - 1,
					BlockType.Water,
				);
			} else if (room.kind === "boss") {
				// Lava margin hugging the walls, plus a dais for the boss.
				//
				// The dais is laid INTO the floor slab (floorY - 1), not on top of
				// it: raising it would put a solid block at floorY, which is
				// exactly where MayaDungeonEncounter looks for the boss's feet,
				// and the post would then fail its standable test and no boss
				// would ever spawn.
				const mid = Math.floor((r.x0 + r.x1) / 2);
				const midZ = Math.floor((r.z0 + r.z1) / 2);
				for (let x = r.x0 + 1; x <= r.x1 - 1; x++) {
					for (let z = r.z0 + 1; z <= r.z1 - 1; z++) {
						const edge =
							x === r.x0 + 1 ||
							x === r.x1 - 1 ||
							z === r.z0 + 1 ||
							z === r.z1 - 1;
						if (edge) b.set(x, room.floorY, z, BlockType.MetalGrateRusty);
					}
				}
				b.disc(mid, room.floorY - 1, midZ, 3, BlockType.Obsidian);
			} else if (room.kind === "treasury" || room.kind === "armory") {
				// Storage rows along the walls.
				for (let x = r.x0 + 2; x <= r.x1 - 2; x += 3) {
					for (const z of [r.z0 + 2, r.z1 - 2]) {
						b.column(x, room.floorY + 1, z, 2, COLUMN_BLOCK);
					}
				}
			} else if (room.kind === "gallery") {
				// Colonnade down the middle.
				const mid = Math.floor((r.x0 + r.x1) / 2);
				for (let z = r.z0 + 3; z <= r.z1 - 3; z += 4) {
					b.column(mid, room.floorY + 1, z, MAYA_ROOM_HEIGHT - 1, COLUMN_BLOCK);
				}
			}
		}

		this.emitDeeperHazards(b, layout, chunkMinY, chunkMaxY);
	}

	/**
	 * Molten pools at the bottom of the shaft. MetalGrateRusty is this game's
	 * lava surrogate and is also a light source, so it doubles as the deepest
	 * level's ambient light.
	 */
	private emitDeeperHazards(
		b: StructureBuilder,
		layout: MayaTempleLayout,
		chunkMinY: number,
		chunkMaxY: number,
	): void {
		const floorY = layout.bossRoom.floorY;
		if (
			!MayaTempleFeature.overlapsBand(chunkMinY, chunkMaxY, floorY, floorY + 4)
		) {
			return;
		}

		for (const room of layout.rooms) {
			if (room.level !== 3) continue;
			const r = room.rect;
			// Skip the arena: it already has its own lava margin.
			if (room === layout.bossRoom) continue;
			for (let x = r.x0 + 2; x <= r.x1 - 2; x += 5) {
				for (let z = r.z0 + 2; z <= r.z1 - 2; z += 5) {
					if ((x + z) % 3 !== 0) continue;
					b.disc(x, room.floorY, z, 1, BlockType.MetalGrateRusty);
				}
			}
		}
	}

	/** Kept separate so the room loop above stays readable. */
	private dressRoom(b: StructureBuilder, room: MayaChamber): void {
		// Pillars at the room corners double as structural detail and cover the
		// seam where the floor slab meets the walls.
		const lx = room.rect.x1 - room.rect.x0 - 1;
		const lz = room.rect.z1 - room.rect.z0 - 1;
		for (const [ox, oz] of [
			[1, 1],
			[lx, 1],
			[1, lz],
			[lx, lz],
		] as const) {
			b.column(
				room.rect.x0 + ox,
				room.floorY + 1,
				room.rect.z0 + oz,
				MAYA_ROOM_HEIGHT - 1,
				COLUMN_BLOCK,
			);
		}
	}
}
