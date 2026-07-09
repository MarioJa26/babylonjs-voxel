import { getPRNGBySeed } from "@/code/Generation/NoiseAndParameters/Squirrel13";
import type { TreeDefinition } from "../../BiomeTypes";
import { DIAG_X, DIAG_Z, generateBaobab } from "../../TreeDefinition";

export const CACTUS: TreeDefinition = {
	woodId: 34,
	leavesId: 0,
	baseHeight: 3,
	heightVariance: 2,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = getPRNGBySeed(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));
		const woodId = this.woodId;
		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, woodId, true);
		}
	},
};

export const SAVANNAH_TREE: TreeDefinition = {
	woodId: 31, // Acacia wood
	leavesId: 43, // Acacia leaves
	baseHeight: 7,
	heightVariance: 3,
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

		// Tall trunk
		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, woodId, true);
		}

		// Flat umbrella-shaped canopy at the top
		const canopyY = worldY + height - 1;
		const canopyRadius = 3;

		// Flat layer of leaves (the umbrella top)
		for (let x = -canopyRadius; x <= canopyRadius; x++) {
			for (let z = -canopyRadius; z <= canopyRadius; z++) {
				if (Math.abs(x) + Math.abs(z) <= canopyRadius + 1) {
					placeBlock(worldX + x, canopyY, worldZ + z, leavesId, false);
				}
			}
		}

		// Slightly smaller layer above
		const upperY = canopyY + 1;
		for (let x = -2; x <= 2; x++) {
			for (let z = -2; z <= 2; z++) {
				if (Math.abs(x) + Math.abs(z) <= 3) {
					placeBlock(worldX + x, upperY, worldZ + z, leavesId, false);
				}
			}
		}

		// Small top
		placeBlock(worldX, canopyY + 2, worldZ, leavesId, false);
	},
};
export const BAOBAB_TREE: TreeDefinition = {
	woodId: 31, // acacia wood — replace with a baobab-specific block when available
	leavesId: 43, // acacia leaves — replace with baobab leaves when available
	baseHeight: 8,
	heightVariance: 3,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		generateBaobab(
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
// DEAD_TREE — Snowy Plains, Scorched Savannah, Peat Bog
// Leafless bare trunk with a few broken branch stubs
// ---------------------------------------------------------------------------
export const DEAD_TREE: TreeDefinition = {
	woodId: 28, // oak wood — replace with dead/grey wood block
	leavesId: 0, // no leaves
	baseHeight: 5,
	heightVariance: 3,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = getPRNGBySeed(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));
		const woodId = this.woodId;

		// Trunk — slight lean using DIAG offsets
		const leanDir = Math.abs(heightHash) % 8;
		const leanStart = Math.floor(height * 0.6); // lean begins 60% up
		let tx = worldX;
		let tz = worldZ;

		for (let i = 0; i < height; i++) {
			if (i === leanStart) {
				tx += DIAG_X[leanDir];
				tz += DIAG_Z[leanDir];
			}
			placeBlock(tx, worldY + i, tz, woodId, true);
		}

		// Broken branch stubs — 2–4 stubs at random heights
		const stubCount = 2 + (Math.abs(heightHash >> 4) % 3);
		for (let s = 0; s < stubCount; s++) {
			const stubHash = getPRNGBySeed(
				worldX * 9719 + worldZ * 19997 + s * 53,
				seedAsInt,
			);
			const stubY = worldY + 2 + (Math.abs(stubHash) % (height - 2));
			const stubDir = Math.abs(stubHash >> 3) % 8;
			const stubLen = 1 + (Math.abs(stubHash >> 6) % 2); // 1–2 blocks

			let sx = tx;
			let sz = tz;
			for (let step = 0; step < stubLen; step++) {
				sx += DIAG_X[stubDir];
				sz += DIAG_Z[stubDir];
				placeBlock(sx, stubY, sz, woodId, true);
			}
		}
	},
};
