import {
	MAYA_SEAL_HALF_EXTENT,
	type MayaGlyph,
	type MayaTempleLayout,
} from "../Generation/Structure/MayaTempleLayout";
import {
	buildTempleLayout,
	resolveTempleInRegion,
} from "../Generation/Structure/StructureSeal";
import { CHUNK_SIZE } from "../Lib/VoxelMath";
import {
	getBlockByWorldCoords,
	setBlock,
} from "../World/Chunk/ChunkLoadingSystem";
import { BlockType } from "../World/Texture/BlockType";

// ---------------------------------------------------------------------------
// Maya temple glyph puzzle.
//
// Three sanctum glyphs, one per middle dungeon level. Right-clicking a glyph
// toggles the four crystal blocks around it:
//
//   uncharged  all four = CrystalBlock (80)
//   charged    all four = ExposedCrystalBlock (79)
//
// A fifth glyph is the boss gate: a solid wall across the corridor into the
// arena. It dissolves only once all three sanctum glyphs read as charged.
//
// The puzzle is deliberately STATELESS. "Charged" is not a saved flag — it is
// the block ids in the ring, which are ordinary voxel data that already persists
// through the normal chunk save path. Nothing new is stored, so nothing can
// desync: two players looking at the same glyph see the same state, and a
// reload restores it for free.
// --------------------------------------------------------------------------

/** Rings are only 2 blocks from the glyph, so a small probe window suffices. */
const RING_SEARCH_RADIUS = 3;

export type GlyphInteraction =
	| { kind: "toggled"; charged: boolean }
	| { kind: "gate-open" }
	| { kind: "gate-locked"; chargedCount: number; requiredCount: number }
	| { kind: "none" };

/**
 * Resolve the glyph at a world position, or null when the position is not a
 * temple glyph. Same derivation path as worldgen, so it always agrees with what
 * MayaTempleFeature actually wrote.
 */
export function findGlyphAt(
	worldX: number,
	worldY: number,
	worldZ: number,
	seedAsInt: number,
): { layout: MayaTempleLayout; glyph: MayaGlyph } | null {
	const chunkX = Math.floor(worldX / CHUNK_SIZE);
	const chunkZ = Math.floor(worldZ / CHUNK_SIZE);

	for (let dx = -2; dx <= 2; dx++) {
		for (let dz = -2; dz <= 2; dz++) {
			const resolved = resolveTempleInRegion(
				chunkX + dx,
				chunkZ + dz,
				CHUNK_SIZE,
				seedAsInt,
			);
			if (!resolved) continue;

			if (
				Math.abs(resolved.centerX - worldX) > MAYA_SEAL_HALF_EXTENT ||
				Math.abs(resolved.centerZ - worldZ) > MAYA_SEAL_HALF_EXTENT
			) {
				continue;
			}

			const layout = buildTempleLayout(resolved, seedAsInt);
			for (const glyph of layout.glyphs) {
				if (glyph.x === worldX && glyph.y === worldY && glyph.z === worldZ) {
					return { layout, glyph };
				}
			}
		}
	}

	return null;
}

/** True when every block in the glyph's ring reads as charged. */
export function isGlyphCharged(glyph: MayaGlyph, seedAsInt: number): boolean {
	if (glyph.ring.length === 0) return false;
	for (const [x, y, z] of glyph.ring) {
		if (getBlockByWorldCoords(x, y, z) !== BlockType.ExposedCrystalBlock) {
			return false;
		}
	}
	void seedAsInt;
	return true;
}

/** How many of the layout's sanctum glyphs are currently charged. */
export function countChargedSanctums(
	layout: MayaTempleLayout,
	seedAsInt: number,
): number {
	let charged = 0;
	for (const glyph of layout.glyphs) {
		if (glyph.gate) continue;
		if (isGlyphCharged(glyph, seedAsInt)) charged++;
	}
	return charged;
}

/** Total number of sanctum glyphs, i.e. how many seals must be solved. */
export function sanctumCount(layout: MayaTempleLayout): number {
	let total = 0;
	for (const glyph of layout.glyphs) {
		if (!glyph.gate) total++;
	}
	return total;
}

/**
 * Apply a single block write locally and, in multiplayer, tell the server.
 *
 * Mirrors what the normal place/break path does: `setBlock` mutates the chunk
 * and schedules water updates, and `NetworkManager.onBlockPlaced` broadcasts it
 * so every client and the server agree.
 */
type BlockWriteSink = (
	x: number,
	y: number,
	z: number,
	blockId: number,
) => void;

function makeBlockWriter(
	onNetworkPlace:
		| ((
				x: number,
				y: number,
				z: number,
				blockId: number,
				state: number,
		  ) => void)
		| undefined,
): BlockWriteSink {
	return (x, y, z, blockId) => {
		setBlock(x, y, z, blockId, 0);
		onNetworkPlace?.(x, y, z, blockId, 0);
	};
}

/**
 * Handle a right-click on a TempleGlyph block.
 *
 * `onNetworkPlace` should be the player's `NetworkManager.onBlockPlaced` in
 * multiplayer and undefined offline.
 */
export function interactWithGlyph(
	worldX: number,
	worldY: number,
	worldZ: number,
	seedAsInt: number,
	onNetworkPlace?:
		| ((
				x: number,
				y: number,
				z: number,
				blockId: number,
				state: number,
		  ) => void)
		| undefined,
): GlyphInteraction {
	const found = findGlyphAt(worldX, worldY, worldZ, seedAsInt);
	if (!found) return { kind: "none" };

	const { layout, glyph } = found;
	const write = makeBlockWriter(onNetworkPlace);

	if (glyph.gate) {
		const charged = countChargedSanctums(layout, seedAsInt);
		const required = sanctumCount(layout);
		if (charged < required) {
			return {
				kind: "gate-locked",
				chargedCount: charged,
				requiredCount: required,
			};
		}
		for (const [x, y, z] of glyph.gate.wall) {
			write(x, y, z, BlockType.Air);
		}
		return { kind: "gate-open" };
	}

	// Toggle the ring.
	const charged = !isGlyphCharged(glyph, seedAsInt);
	const ringBlock = charged
		? BlockType.ExposedCrystalBlock
		: BlockType.CrystalBlock;
	for (const [x, y, z] of glyph.ring) {
		write(x, y, z, ringBlock);
	}

	// Solving the last seal opens the gate immediately, so the player is never
	// left wondering what to do next.
	if (
		charged &&
		countChargedSanctums(layout, seedAsInt) === sanctumCount(layout)
	) {
		for (const candidate of layout.glyphs) {
			if (!candidate.gate) continue;
			for (const [x, y, z] of candidate.gate.wall) {
				write(x, y, z, BlockType.Air);
			}
		}
	}

	return { kind: "toggled", charged };
}

/** Is a glyph ring still intact enough to probe? Used for hover feedback. */
export function hasGlyphRing(glyph: MayaGlyph): boolean {
	if (glyph.ring.length === 0) return false;
	const [rx, , rz] = glyph.ring[0];
	return (
		Math.abs(rx - glyph.x) <= RING_SEARCH_RADIUS &&
		Math.abs(rz - glyph.z) <= RING_SEARCH_RADIUS
	);
}
