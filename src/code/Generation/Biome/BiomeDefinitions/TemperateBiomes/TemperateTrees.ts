import { getPRNGBySeed } from "@/code/Generation/NoiseAndParameters/Squirrel13";
import type { TreeDefinition } from "../../BiomeTypes";
import {
	DIR_X,
	DIR_Z,
	generateBigTopBentOak,
	generateSlinkyTree,
} from "../../TreeDefinition";

// ---------------------------------------------------------------------------
// OAK_TREE
// ---------------------------------------------------------------------------

export const OAK_TREE: TreeDefinition = {
	woodId: 28,
	leavesId: 2,
	baseHeight: 5,
	heightVariance: 2,
	generate(
		worldX: number,
		worldY: number,
		worldZ: number,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			blockId: number,
			overwrite?: boolean,
		) => void,
		seedAsInt: number,
	): void {
		const heightHash = getPRNGBySeed(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));
		const woodId = this.woodId;
		const leavesId = this.leavesId;

		// Trunk
		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, woodId, true);
		}

		const leafYStart = worldY + height - 3;

		// V8: flatten radius logic into the loop condition rather than branching inside
		for (let y = leafYStart; y < leafYStart + 4; y++) {
			const radius = y < leafYStart + 2 ? 2 : 1;
			for (let x = -radius; x <= radius; x++) {
				for (let z = -radius; z <= radius; z++) {
					placeBlock(worldX + x, y, worldZ + z, leavesId, false);
				}
			}
		}
	},
};

// ---------------------------------------------------------------------------
// MAPLE_TREE — Maple Forest
// Rounded full crown, slightly shorter than BIG_OAK, dense leaves
// ---------------------------------------------------------------------------

export const MAPLE_TREE: TreeDefinition = {
	woodId: 28, // oak wood — replace with maple wood block
	leavesId: 2, // oak leaves — replace with maple leaves (autumn colours)
	baseHeight: 8,
	heightVariance: 4,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		generateBigTopBentOak(
			worldX,
			worldY,
			worldZ,
			placeBlock,
			seedAsInt,
			this.woodId,
			this.leavesId,
			this.baseHeight,
			this.heightVariance,
		);
	},
};
// ---------------------------------------------------------------------------
// BIRCH_TREE — Birch Forest
// Tall slim straight trunk, small tight oval crown
// ---------------------------------------------------------------------------

export const BIRCH_TREE: TreeDefinition = {
	woodId: 73, // birch wood — replace with birch-specific block
	leavesId: 74, // birch leaves
	baseHeight: 8,
	heightVariance: 3,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = getPRNGBySeed(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));
		const woodId = this.woodId;
		const leavesId = this.leavesId;

		// Straight slim trunk — no lean, no taper
		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, woodId, true);
		}

		// Tight oval crown — tall and narrow, birches aren't wide
		const crownBottom = worldY + height - 4;
		const crownTop = worldY + height + 1;
		for (let y = crownBottom; y <= crownTop; y++) {
			const dy = y - (worldY + height - 1);
			// Oval: wide in the middle, narrow at top and bottom
			const radius = dy === 0 || dy === 1 ? 2 : 1;
			const radiusSq = radius * radius;
			for (let x = -radius; x <= radius; x++) {
				for (let z = -radius; z <= radius; z++) {
					if (x * x + z * z <= radiusSq) {
						placeBlock(worldX + x, y, worldZ + z, leavesId, false);
					}
				}
			}
		}
	},
};
export const SLINKY_TREE: TreeDefinition = {
	woodId: 28,
	leavesId: 2,
	baseHeight: 10,
	heightVariance: 10,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		generateSlinkyTree(
			worldX,
			worldY,
			worldZ,
			placeBlock,
			seedAsInt,
			this.woodId,
			this.leavesId,
			this.baseHeight,
			this.heightVariance,
		);
	},
};

export const BIG_OAK_TREE: TreeDefinition = {
	woodId: 28,
	leavesId: 2,
	baseHeight: 10,
	heightVariance: 10,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		generateBigTopBentOak(
			worldX,
			worldY,
			worldZ,
			placeBlock,
			seedAsInt,
			this.woodId,
			this.leavesId,
			this.baseHeight,
			this.heightVariance,
		);
	},
};
export const PLAINS_TREE: TreeDefinition = {
	woodId: 31,
	leavesId: 43,
	baseHeight: 6,
	heightVariance: 2,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = getPRNGBySeed(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));
		const woodId = this.woodId;
		const leavesId = this.leavesId;

		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, woodId, true);
		}

		const leafYStart = worldY + height - 3;
		for (let y = leafYStart; y < leafYStart + 4; y++) {
			const radius = y < leafYStart + 2 ? 2 : 1;
			for (let x = -radius; x <= radius; x++) {
				for (let z = -radius; z <= radius; z++) {
					placeBlock(worldX + x, y, worldZ + z, leavesId, false);
				}
			}
		}
	},
};

// ---------------------------------------------------------------------------
// TEMPERATE_RAINFOREST_TREE
// Tall moss-draped tree with buttress roots, thick trunk, large irregular canopy
// ---------------------------------------------------------------------------
export const TEMPERATE_RAINFOREST_TREE: TreeDefinition = {
	woodId: 28,
	leavesId: 2,
	baseHeight: 14,
	heightVariance: 8,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const h = getPRNGBySeed(worldX * 374761393 + worldZ * 678446653, seedAsInt);
		const height = this.baseHeight + (Math.abs(h) % (this.heightVariance + 1));
		const woodId = this.woodId;
		const leavesId = this.leavesId;
		const heightM1 = Math.max(1, height - 1);

		function placeWood(x: number, y: number, z: number): void {
			placeBlock(x, y, z, woodId, true);
		}

		// ── Deep tap root ─────────────────────────────────────────────────────
		const tapDepth = 4 + (Math.abs(h) % 3);
		for (let d = 1; d <= tapDepth; d++) {
			placeWood(worldX, worldY - d, worldZ);
		}

		// ── Buttress roots — droop as they extend outward ─────────────────────
		const buttressCount = 4 + (Math.abs(h >> 2) % 2);
		for (let b = 0; b < buttressCount; b++) {
			const bHash = getPRNGBySeed(
				worldX * 31337 + worldZ * 6971 + b * 101,
				seedAsInt,
			);
			const dir = b % 4;
			const length = 3 + (Math.abs(bHash) % 3);

			let rootY = worldY;

			for (let step = 1; step <= length; step++) {
				const bx = worldX + DIR_X[dir] * step;
				const bz = worldZ + DIR_Z[dir] * step;

				if (step > 1) {
					rootY--;
					// Connect vertically — face-connected, no gap
					placeWood(bx, rootY + 1, bz);
				}

				const finHeight = Math.max(1, length - step + 1);
				for (let rise = 0; rise < finHeight; rise++) {
					placeWood(bx, rootY + rise, bz);
				}
			}
		}

		// ── Trunk ─────────────────────────────────────────────────────────────
		const bendDir = Math.abs(h >> 6) % 4;
		const bendDirX = DIR_X[bendDir];
		const bendDirZ = DIR_Z[bendDir];
		const maxBend = 2 + (Math.abs(h >> 8) % 2);

		let tx = worldX;
		let tz = worldZ;
		let bendStepsDone = 0;

		for (let i = 0; i < height; i++) {
			const target = Math.round((i / heightM1) * maxBend);
			const prevTarget = Math.round(((i - 1) / heightM1) * maxBend);

			if (target > prevTarget && bendStepsDone < maxBend) {
				tx += bendDirX;
				tz += bendDirZ;
				bendStepsDone++;
			}

			const trunkR = i < Math.floor(height * 0.4) ? 2 : 1;
			const rSq = trunkR * trunkR;
			for (let x = -trunkR; x <= trunkR; x++) {
				const x2 = x * x;
				for (let z = -trunkR; z <= trunkR; z++) {
					if (x2 + z * z <= rSq) {
						placeWood(tx + x, worldY + i, tz + z);
					}
				}
			}
		}

		// ── Main canopy — solid sphere, no shell check ────────────────────────
		const canopyR = 6 + (Math.abs(h >> 10) % 3);
		const canopyCY = worldY + height + 1;
		const canopyRSq = canopyR * canopyR;

		for (let dy = -canopyR; dy <= canopyR; dy++) {
			const dy2 = dy * dy;
			if (dy2 > canopyRSq) continue;
			const ly = canopyCY + dy;
			for (let x = -canopyR; x <= canopyR; x++) {
				const x2 = x * x;
				if (x2 + dy2 > canopyRSq) continue;
				for (let z = -canopyR; z <= canopyR; z++) {
					if (x2 + z * z + dy2 <= canopyRSq) {
						placeBlock(tx + x, ly, tz + z, leavesId, false);
					}
				}
			}
		}

		// ── Secondary canopy lobes — solid spheres ────────────────────────────
		const lobeCount = 3 + (Math.abs(h >> 12) % 2);
		for (let l = 0; l < lobeCount; l++) {
			const lHash = getPRNGBySeed(
				worldX * 9719 + worldZ * 19997 + l * 53,
				seedAsInt,
			);
			const lobeDir = l % 4;
			const lobeDist = 4 + (Math.abs(lHash >> 2) % 3);
			const lobeCX = tx + DIR_X[lobeDir] * lobeDist;
			const lobeCZ = tz + DIR_Z[lobeDir] * lobeDist;
			const lobeCY = canopyCY - 2 + (Math.abs(lHash >> 5) % 4);
			const lobeR = 3 + (Math.abs(lHash >> 8) % 2);
			const lobeRSq = lobeR * lobeR;

			for (let dy = -lobeR; dy <= lobeR; dy++) {
				const dy2 = dy * dy;
				if (dy2 > lobeRSq) continue;
				for (let x = -lobeR; x <= lobeR; x++) {
					const x2 = x * x;
					if (x2 + dy2 > lobeRSq) continue;
					for (let z = -lobeR; z <= lobeR; z++) {
						if (x2 + z * z + dy2 <= lobeRSq) {
							placeBlock(lobeCX + x, lobeCY + dy, lobeCZ + z, leavesId, false);
						}
					}
				}
			}
		}

		// ── Hanging moss ──────────────────────────────────────────────────────
		const mossCount = 8 + (Math.abs(h >> 14) % 8);
		for (let m = 0; m < mossCount; m++) {
			const mHash = getPRNGBySeed(
				worldX * 7919 + worldZ * 6271 + m * 37,
				seedAsInt,
			);
			const mossR = canopyR - 1;
			const mossX = tx + ((Math.abs(mHash) % (mossR * 2 + 1)) - mossR);
			const mossZ = tz + ((Math.abs(mHash >> 4) % (mossR * 2 + 1)) - mossR);
			const mossY = canopyCY - 1;
			const mossLen = 1 + (Math.abs(mHash >> 8) % 3);

			for (let d = 0; d < mossLen; d++) {
				placeBlock(mossX, mossY - d, mossZ, leavesId, false);
			}
		}
	},
};

// ---------------------------------------------------------------------------
// CHERRY_BLOSSOM_TREE — Cherry Blossom Forest
// Wide spreading canopy, drooping branches, pink leaves
// Wood: BarkBrown02 (28), Leaves: TODO cherry blossom pink block (using Grass001 15 as placeholder)
// ---------------------------------------------------------------------------
export const CHERRY_BLOSSOM_TREE: TreeDefinition = {
	woodId: 28, // BarkBrown02
	leavesId: 15, // TODO: cherry blossom pink block — replace when available
	baseHeight: 6,
	heightVariance: 3,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const h = getPRNGBySeed(worldX * 374761393 + worldZ * 678446653, seedAsInt);
		const height = this.baseHeight + (Math.abs(h) % (this.heightVariance + 1));
		const woodId = this.woodId;
		const leavesId = this.leavesId;

		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, woodId, true);
		}

		const canopyBaseY = worldY + height - 2;
		const canopyTopY = worldY + height + 2;

		for (let y = canopyBaseY; y <= canopyTopY; y++) {
			const dy = y - (worldY + height);
			const radius = dy <= 0 ? 3 : dy === 1 ? 2 : 1;
			for (let x = -radius; x <= radius; x++) {
				for (let z = -radius; z <= radius; z++) {
					if (x * x + z * z <= radius * radius + 1) {
						placeBlock(worldX + x, y, worldZ + z, leavesId, false);
					}
				}
			}
		}

		const droopCount = 4 + (Math.abs(h >> 4) % 3);
		for (let d = 0; d < droopCount; d++) {
			const dHash = getPRNGBySeed(
				worldX * 7919 + worldZ * 6271 + d * 47,
				seedAsInt,
			);
			const dir = d % 4;
			const dx = DIR_X[dir];
			const dz = DIR_Z[dir];
			const droopLen = 2 + (Math.abs(dHash) % 3);

			for (let step = 1; step <= droopLen; step++) {
				const bx = worldX + dx * step;
				const bz = worldZ + dz * step;
				const by = canopyBaseY - (step > 1 ? 1 : 0);
				placeBlock(bx, by, bz, leavesId, false);
				if (step === droopLen) {
					placeBlock(bx, by - 1, bz, leavesId, false);
				}
			}
		}
	},
};

// ---------------------------------------------------------------------------
// AUTUMN_TREE — Autumn Forest
// Full round crown, warm-colored leaves
// Wood: BarkBrown01 (31), Leaves: TODO autumn orange/red block (using ForestLeaves02 43 as placeholder)
// ---------------------------------------------------------------------------
export const AUTUMN_TREE: TreeDefinition = {
	woodId: 31, // BarkBrown01
	leavesId: 43, // TODO: autumn orange/red leaves — replace when available
	baseHeight: 8,
	heightVariance: 4,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const h = getPRNGBySeed(worldX * 374761393 + worldZ * 678446653, seedAsInt);
		const height = this.baseHeight + (Math.abs(h) % (this.heightVariance + 1));
		const woodId = this.woodId;
		const leavesId = this.leavesId;

		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, woodId, true);
		}

		const cy = worldY + height;
		const r = 4 + (Math.abs(h >> 4) % 2);
		const rSq = r * r;

		for (let dy = -r + 1; dy <= r; dy++) {
			const dy2 = dy * dy;
			if (dy2 > rSq) continue;
			const ly = cy + dy;
			for (let x = -r; x <= r; x++) {
				const x2 = x * x;
				if (x2 + dy2 > rSq) continue;
				for (let z = -r; z <= r; z++) {
					if (x2 + z * z + dy2 <= rSq) {
						placeBlock(worldX + x, ly, worldZ + z, leavesId, false);
					}
				}
			}
		}

		const lobeCount = 2 + (Math.abs(h >> 8) % 2);
		for (let l = 0; l < lobeCount; l++) {
			const lHash = getPRNGBySeed(
				worldX * 9719 + worldZ * 19997 + l * 53,
				seedAsInt,
			);
			const lobeDir = l % 4;
			const lobeDist = 3 + (Math.abs(lHash >> 2) % 2);
			const lobeCX = worldX + DIR_X[lobeDir] * lobeDist;
			const lobeCZ = worldZ + DIR_Z[lobeDir] * lobeDist;
			const lobeCY = cy - 1 + (Math.abs(lHash >> 5) % 3);
			const lobeR = 2 + (Math.abs(lHash >> 8) % 2);
			const lobeRSq = lobeR * lobeR;

			for (let dy = -lobeR; dy <= lobeR; dy++) {
				const dy2 = dy * dy;
				if (dy2 > lobeRSq) continue;
				for (let x = -lobeR; x <= lobeR; x++) {
					const x2 = x * x;
					if (x2 + dy2 > lobeRSq) continue;
					for (let z = -lobeR; z <= lobeR; z++) {
						if (x2 + z * z + dy2 <= lobeRSq) {
							placeBlock(lobeCX + x, lobeCY + dy, lobeCZ + z, leavesId, false);
						}
					}
				}
			}
		}
	},
};

export const PINE_TREE: TreeDefinition = {
	woodId: 22, // PineBark
	leavesId: 89, // PineLeaves
	baseHeight: 12,
	heightVariance: 6,

	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const h = getPRNGBySeed(
			(worldX * 374761393 + worldZ * 678446653) | 0,
			seedAsInt,
		);
		const hAbs = h < 0 ? -h : h;
		const height = (this.baseHeight + (hAbs % (this.heightVariance + 1))) | 0;

		const woodId = this.woodId;
		const leavesId = this.leavesId;

		// Trunk
		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, woodId, true);
		}

		// Guaranteed tip: leaf on top and 4 cardinal sides of top wood block
		const tipY = worldY + height;
		placeBlock(worldX, tipY, worldZ, leavesId, false); // top
		placeBlock(worldX + 1, tipY - 1, worldZ, leavesId, false); // sides
		placeBlock(worldX - 1, tipY - 1, worldZ, leavesId, false);
		placeBlock(worldX, tipY - 1, worldZ + 1, leavesId, false);
		placeBlock(worldX, tipY - 1, worldZ - 1, leavesId, false);

		// Whorl cone — stop at height - 1 so cone never touches tip y
		const bareBase = (height * 0.3) | 0;
		const coneTop = height - 1; // cone stops well below tip
		const coneSpan = (coneTop - bareBase) | 0;
		const TIER_STEP = 2;

		for (let y = bareBase; y <= coneTop; y++) {
			const progress = (y - bareBase) / coneSpan;
			const rawRadius = 4.5 * (1.0 - progress * progress * 0.9);
			const radius = rawRadius | 0;

			if (radius <= 0) continue;

			const isMajorTier = (y - bareBase) % TIER_STEP === 0;
			const fillRadius = isMajorTier ? radius : (radius - 1) | 0;
			if (fillRadius <= 0) continue;

			const r2 = (fillRadius * fillRadius) | 0;

			for (let dx = -fillRadius; dx <= fillRadius; dx++) {
				const dx2 = (dx * dx) | 0;
				for (let dz = -fillRadius; dz <= fillRadius; dz++) {
					if (dx2 + dz * dz > r2) continue;
					placeBlock(worldX + dx, worldY + y, worldZ + dz, leavesId, false);
				}
			}
		}
	},
};
