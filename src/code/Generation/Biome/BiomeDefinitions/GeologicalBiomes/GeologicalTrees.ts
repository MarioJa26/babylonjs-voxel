import { getPRNGBySeed } from "@/code/Generation/NoiseAndParameters/Squirrel13";
import type { TreeDefinition } from "../../BiomeTypes";
import { DIR_X, DIR_Z } from "../../TreeDefinition";

// ---------------------------------------------------------------------------
// Shared constants — hoisted to module scope to avoid per-call allocation
// V8: integer constants are Smi (small integer) — zero heap cost
// ---------------------------------------------------------------------------
const HASH_A = 374761393;
const HASH_B = 678446653;
const HASH_C = 11939;
const HASH_D = 15485863;
const HASH_E = 29791;

// ---------------------------------------------------------------------------
// Shared inline helpers
// V8: inlined as pure integer ops, no function call overhead at hot paths
// ---------------------------------------------------------------------------

/** Deterministic height from world position and seed. */
function heightHash(worldX: number, worldZ: number, seedAsInt: number): number {
	return getPRNGBySeed(worldX * HASH_A + worldZ * HASH_B, seedAsInt);
}

/** Leaf/hole hash for a specific block position. */
function leafHash(x: number, y: number, z: number, seedAsInt: number): number {
	return getPRNGBySeed(x * HASH_C + z * HASH_D + y * HASH_E, seedAsInt);
}

/** Fill a flat disc of radius r centered at (cx, cy, cz). */
function placedisc(
	cx: number,
	cy: number,
	cz: number,
	r: number,
	blockId: number,
	overwrite: boolean,
	placeBlock: (
		x: number,
		y: number,
		z: number,
		id: number,
		ow?: boolean,
	) => void,
): void {
	const rSq = r * r;
	for (let x = -r; x <= r; x++) {
		const x2 = x * x;
		for (let z = -r; z <= r; z++) {
			if (x2 + z * z <= rSq) {
				placeBlock(cx + x, cy, cz + z, blockId, overwrite);
			}
		}
	}
}

/** Fill a flat disc with random holes (1-in-skip chance of skipping). */
function placeDiscHoley(
	cx: number,
	cy: number,
	cz: number,
	r: number,
	blockId: number,
	skip: number,
	seedAsInt: number,
	placeBlock: (
		x: number,
		y: number,
		z: number,
		id: number,
		ow?: boolean,
	) => void,
): void {
	const rSq = r * r;
	for (let x = -r; x <= r; x++) {
		const x2 = x * x;
		for (let z = -r; z <= r; z++) {
			if (x2 + z * z <= rSq) {
				if (Math.abs(leafHash(cx + x, cy, cz + z, seedAsInt)) % skip !== 0) {
					placeBlock(cx + x, cy, cz + z, blockId, true);
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// MINI_MUSHROOM
// 1–2 block stem, single cap, no overhang — most common
// ---------------------------------------------------------------------------
export const MINI_MUSHROOM: TreeDefinition = {
	woodId: 76,
	leavesId: 77,
	baseHeight: 1,
	heightVariance: 1,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const h = heightHash(worldX, worldZ, seedAsInt);
		const stemHeight = 1 + (Math.abs(h) % 2);
		const woodId = this.woodId;
		const leavesId = this.leavesId;
		for (let i = 0; i < stemHeight; i++) {
			placeBlock(worldX, worldY + i, worldZ, woodId, true);
		}
		placeBlock(worldX, worldY + stemHeight, worldZ, leavesId, true);
	},
};

// ---------------------------------------------------------------------------
// TINY_MUSHROOM
// 1–2 block stem, single cap with optional 4-way cardinal overhang
// ---------------------------------------------------------------------------
export const TINY_MUSHROOM: TreeDefinition = {
	woodId: 76,
	leavesId: 77,
	baseHeight: 1,
	heightVariance: 1,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const h = heightHash(worldX, worldZ, seedAsInt);
		const stemHeight = 1 + (Math.abs(h) % 2);
		const woodId = this.woodId;
		const leavesId = this.leavesId;
		for (let i = 0; i < stemHeight; i++) {
			placeBlock(worldX, worldY + i, worldZ, woodId, true);
		}
		const capY = worldY + stemHeight;
		placeBlock(worldX, capY, worldZ, leavesId, true);
		if ((Math.abs(h >> 2) & 1) === 0) {
			placeBlock(worldX + 1, capY, worldZ, leavesId, true);
			placeBlock(worldX - 1, capY, worldZ, leavesId, true);
			placeBlock(worldX, capY, worldZ + 1, leavesId, true);
			placeBlock(worldX, capY, worldZ - 1, leavesId, true);
		}
	},
};

// ---------------------------------------------------------------------------
// SMALL_MUSHROOM
// 3–5 block straight stem, 3x3 flat cap with cardinal protrusions
// ---------------------------------------------------------------------------
export const SMALL_MUSHROOM: TreeDefinition = {
	woodId: 76,
	leavesId: 77,
	baseHeight: 3,
	heightVariance: 2,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const h = heightHash(worldX, worldZ, seedAsInt);
		const height = this.baseHeight + (Math.abs(h) % (this.heightVariance + 1));
		const woodId = this.woodId;
		const leavesId = this.leavesId;
		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, woodId, true);
		}
		const capY = worldY + height;
		// 3x3 base
		placedisc(worldX, capY, worldZ, 1, leavesId, true, placeBlock);
		// Cardinal protrusions at radius 2 — only on the 4 cardinal axes (no disc)
		placeBlock(worldX + 2, capY, worldZ, leavesId, true);
		placeBlock(worldX - 2, capY, worldZ, leavesId, true);
		placeBlock(worldX, capY, worldZ + 2, leavesId, true);
		placeBlock(worldX, capY, worldZ - 2, leavesId, true);
		// Top pip — only Y moves
		placeBlock(worldX, capY + 1, worldZ, leavesId, true);
	},
};

// ---------------------------------------------------------------------------
// MEDIUM_MUSHROOM
// 6–10 block stem with a single cardinal bend, 2-layer flat disc cap
// Cap layers only move in Y — no simultaneous XZ+Y movement
// ---------------------------------------------------------------------------
export const MEDIUM_MUSHROOM: TreeDefinition = {
	woodId: 76,
	leavesId: 77,
	baseHeight: 6,
	heightVariance: 4,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const h = heightHash(worldX, worldZ, seedAsInt);
		const height = this.baseHeight + (Math.abs(h) % (this.heightVariance + 1));
		const woodId = this.woodId;
		const leavesId = this.leavesId;

		// Cardinal lean only — % 4 guarantees single-axis movement
		const leanDir = Math.abs(h >> 6) % 4;
		const leanDirX = DIR_X[leanDir];
		const leanDirZ = DIR_Z[leanDir];
		const bendPoint = Math.floor(height * 0.55);

		let tx = worldX;
		let tz = worldZ;
		for (let i = 0; i < height; i++) {
			// Stem moves one axis only — never diagonal
			if (i === bendPoint) {
				tx += leanDirX;
				tz += leanDirZ;
			}
			placeBlock(tx, worldY + i, tz, woodId, true);
		}

		const capY = worldY + height;
		const capRadius = 3 + (Math.abs(h >> 4) % 2);

		// Layer 0 — bottom disc, no Y movement yet
		placedisc(tx, capY, tz, capRadius, leavesId, true, placeBlock);
		// Layer 1 — smaller disc, only Y moves (+1), no XZ change
		placedisc(tx, capY + 1, tz, capRadius - 1, leavesId, true, placeBlock);
		// Layer 2 — top pip, only Y moves again
		placeBlock(tx, capY + 2, tz, leavesId, true);

		// Drooping fringe — only Y moves down, centered on stem tip
		const fringeR = capRadius - 1;
		placedisc(tx, capY - 1, tz, fringeR, leavesId, false, placeBlock);
	},
};

// ---------------------------------------------------------------------------
// SPHERE_MUSHROOM
// 6–10 block stem that wobbles cardinally, sphere cap offset one cardinal step
// Sphere center is one single-axis step from stem tip
// ---------------------------------------------------------------------------
export const SPHERE_MUSHROOM: TreeDefinition = {
	woodId: 76,
	leavesId: 77,
	baseHeight: 6,
	heightVariance: 4,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const h = heightHash(worldX, worldZ, seedAsInt);
		const height = this.baseHeight + (Math.abs(h) % (this.heightVariance + 1));
		const woodId = this.woodId;
		const leavesId = this.leavesId;

		// Cardinal lean only
		const leanDir = Math.abs(h >> 6) % 4;
		const leanDirX = DIR_X[leanDir];
		const leanDirZ = DIR_Z[leanDir];

		let tx = worldX;
		let tz = worldZ;
		const maxWobble = 3;
		let wobbleStepsDone = 0;

		for (let i = 0; i < height; i++) {
			if (i > 1 && i % 3 === 0 && wobbleStepsDone < maxWobble) {
				const wHash = getPRNGBySeed(
					worldX * 1337 + worldZ * 7331 + i,
					seedAsInt,
				);
				if (Math.abs(wHash) % 3 === 0) {
					// Single axis step — always face-connected
					tx += leanDirX;
					tz += leanDirZ;
					wobbleStepsDone++;
				}
			}
			placeBlock(tx, worldY + i, tz, woodId, true);
		}

		// Sphere center — one cardinal step from stem tip (single axis only)
		const sphereCX = tx + leanDirX;
		const sphereCZ = tz + leanDirZ;
		const sphereCY = worldY + height + 1;
		const sphereR = 3 + (Math.abs(h >> 5) % 2);
		const sphereRSq = sphereR * sphereR;
		// Cutoff — skip bottom 40% of sphere so it sits naturally on stem
		const cutoff = -Math.floor(sphereR * 0.4);

		for (let dy = cutoff; dy <= sphereR; dy++) {
			const dy2 = dy * dy;
			const ly = sphereCY + dy;
			for (let x = -sphereR; x <= sphereR; x++) {
				const x2 = x * x;
				if (x2 + dy2 > sphereRSq) continue; // early-out per row
				for (let z = -sphereR; z <= sphereR; z++) {
					if (x2 + z * z + dy2 <= sphereRSq) {
						// 90% fill — airy sphere
						if (
							Math.abs(leafHash(sphereCX + x, ly, sphereCZ + z, seedAsInt)) %
								10 !==
							0
						) {
							placeBlock(sphereCX + x, ly, sphereCZ + z, leavesId, false);
						}
					}
				}
			}
		}
	},
};

// ---------------------------------------------------------------------------
// GIANT_MUSHROOM
// Tall leaning stem (cardinal steps only), large 3-layer disc cap
// All cap layers move only in Y — no simultaneous XZ+Y
// ---------------------------------------------------------------------------
export const GIANT_MUSHROOM: TreeDefinition = {
	woodId: 76,
	leavesId: 77,
	baseHeight: 6,
	heightVariance: 4,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const h = heightHash(worldX, worldZ, seedAsInt);
		const height = this.baseHeight + this.heightVariance + (Math.abs(h) % 5);
		const woodId = this.woodId;
		const leavesId = this.leavesId;

		// Cardinal lean only
		const leanDir = Math.abs(h >> 8) % 4;
		const leanDirX = DIR_X[leanDir];
		const leanDirZ = DIR_Z[leanDir];
		const maxLean = 3 + (Math.abs(h >> 8) % 2);
		// Pre-hoist division denominator
		const heightM1 = Math.max(1, height - 1);

		let tx = worldX;
		let tz = worldZ;
		let leanStepsDone = 0;

		for (let i = 0; i < height; i++) {
			const target = Math.round((i / heightM1) * maxLean);
			const prevTarget = Math.round(((i - 1) / heightM1) * maxLean);

			if (target > prevTarget && leanStepsDone < maxLean) {
				// Single cardinal step — always face-connected
				tx += leanDirX;
				tz += leanDirZ;
				leanStepsDone++;
			}

			// Wide base (radius 1) tapers to single block
			if (i < Math.floor(height * 0.3)) {
				// 3x3 base — disc radius 1
				placedisc(tx, worldY + i, tz, 1, woodId, true, placeBlock);
			} else {
				placeBlock(tx, worldY + i, tz, woodId, true);
			}
		}

		const capRadius = 5 + (Math.abs(h >> 4) % 2);
		const capY = worldY + height;

		// 3 cap layers — each only moves in Y, centered on final stem position
		// Layer 0: full radius at capY
		placeDiscHoley(tx, capY, tz, capRadius, leavesId, 9, seedAsInt, placeBlock);
		// Layer 1: radius-1 at capY+1 — only Y moved
		placeDiscHoley(
			tx,
			capY + 1,
			tz,
			capRadius - 1,
			leavesId,
			9,
			seedAsInt,
			placeBlock,
		);
		// Layer 2: radius-2 at capY+2 — only Y moved
		placeDiscHoley(
			tx,
			capY + 2,
			tz,
			capRadius - 2,
			leavesId,
			9,
			seedAsInt,
			placeBlock,
		);

		// Droop fringe — only Y moves down, no XZ drift
		// drop=1: capY-1, drop=2: capY-2
		for (let drop = 1; drop <= 2; drop++) {
			const fringeR = capRadius - drop - 1;
			if (fringeR > 0) {
				placedisc(tx, capY - drop, tz, fringeR, leavesId, false, placeBlock);
			}
		}

		// Understem gills — 3x3 just below cap, only Y differs from cap
		placedisc(tx, capY - 1, tz, 1, leavesId, false, placeBlock);
	},
};

// ---------------------------------------------------------------------------
// CRYSTAL_SPIRE — Crystal Caves
// Cluster of 2–3 tapered spires, glowing tips
// ---------------------------------------------------------------------------
export const CRYSTAL_SPIRE: TreeDefinition = {
	woodId: 111, // crystal stone
	leavesId: 119, // glowing crystal tip
	baseHeight: 5,
	heightVariance: 8,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const h = heightHash(worldX, worldZ, seedAsInt);
		const spireCount = 2 + (Math.abs(h) % 2);
		const crystalId = this.woodId;
		const tipId = this.leavesId;

		for (let s = 0; s < spireCount; s++) {
			const sHash = getPRNGBySeed(
				worldX * 15731 + worldZ * 789221 + s * 1013,
				seedAsInt,
			);
			const spireHeight =
				this.baseHeight + (Math.abs(sHash) % (this.heightVariance + 1));
			// Offsets are at most ±1 so always face-connected to origin spire
			const cx = worldX + (s === 0 ? 0 : (Math.abs(sHash >> 2) % 3) - 1);
			const cz = worldZ + (s === 0 ? 0 : (Math.abs(sHash >> 4) % 3) - 1);
			const heightM1 = Math.max(1, spireHeight - 1);

			for (let i = 0; i < spireHeight; i++) {
				const t = i / heightM1;
				if (t < 0.3) {
					// Wide base — 3x3
					placedisc(cx, worldY + i, cz, 1, crystalId, true, placeBlock);
				} else {
					placeBlock(cx, worldY + i, cz, crystalId, true);
				}
			}
			// Glowing tip — top 2 blocks, only Y changes
			placeBlock(cx, worldY + spireHeight - 1, cz, tipId, true);
			placeBlock(cx, worldY + spireHeight, cz, tipId, true);
		}
	},
};
