import { getPRNGBySeed } from "@/code/Generation/NoiseAndParameters/Squirrel13";
import type { TreeDefinition } from "../../BiomeTypes";
import { DIAG_X, DIAG_Z } from "../../TreeDefinition";

// ---------------------------------------------------------------------------
// PETRIFIED_TREE — Petrified Forest
// Stone trunk, no leaves, broken top, looks ancient and fossilised
// ---------------------------------------------------------------------------
export const PETRIFIED_TREE: TreeDefinition = {
	woodId: 1, // stone — the trunk is fully petrified
	leavesId: 0, // no leaves
	baseHeight: 6,
	heightVariance: 4,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = getPRNGBySeed(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));
		const stoneId = this.woodId;

		// Wide stone trunk — 2 blocks wide at base, tapers to 1
		for (let i = 0; i < height; i++) {
			const t = i / Math.max(1, height - 1);
			const radius = t < 0.4 ? 1 : 0; // wide base, slim top
			const y = worldY + i;

			if (radius === 0) {
				placeBlock(worldX, y, worldZ, stoneId, true);
			} else {
				for (let x = -radius; x <= radius; x++) {
					for (let z = -radius; z <= radius; z++) {
						placeBlock(worldX + x, y, worldZ + z, stoneId, true);
					}
				}
			}
		}

		// Broken crown — a few stone stub branches, no symmetry
		const stubCount = 2 + (Math.abs(heightHash >> 4) % 3);
		for (let s = 0; s < stubCount; s++) {
			const stubHash = getPRNGBySeed(
				worldX * 9719 + worldZ * 19997 + s * 53,
				seedAsInt,
			);
			const stubDir = Math.abs(stubHash) % 8;
			const stubLen = 1 + (Math.abs(stubHash >> 3) % 3); // 1–3 blocks
			const stubY = worldY + height - 1;

			let sx = worldX;
			let sz = worldZ;
			for (let step = 0; step < stubLen; step++) {
				sx += DIAG_X[stubDir];
				sz += DIAG_Z[stubDir];
				placeBlock(sx, stubY, sz, stoneId, true);
				// Droop slightly
				if (step === stubLen - 1) {
					placeBlock(sx, stubY - 1, sz, stoneId, true);
				}
			}
		}
	},
};
