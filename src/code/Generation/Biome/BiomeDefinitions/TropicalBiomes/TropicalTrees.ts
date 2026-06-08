import { Squirrel3 } from "@/code/Generation/NoiseAndParameters/Squirrel13";
import type { TreeDefinition } from "../../BiomeTypes";
import { DIAG_X, DIAG_Z, generateSlinkyTree } from "../../TreeDefinition";

export const JUNGLE_TREE: TreeDefinition = {
	woodId: 33,
	leavesId: 34,
	baseHeight: 20,
	heightVariance: 20,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = Squirrel3.get(
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

		const canopyRadius = 4;
		for (let conopie = 1; conopie <= 2; conopie++) {
			const leafYStart = worldY + height - 5 * conopie - (conopie - 1) * 3;
			for (let y = leafYStart; y < leafYStart + 8; y++) {
				const currentRadius = canopyRadius - Math.floor((y - leafYStart) / 2);
				const radiusSqP1 = currentRadius * currentRadius + 1;
				for (let x = -currentRadius; x <= currentRadius; x++) {
					const x2 = x * x;
					for (let z = -currentRadius; z <= currentRadius; z++) {
						if (x2 + z * z <= radiusSqP1) {
							placeBlock(worldX + x, y, worldZ + z, leavesId, false);
						}
					}
				}
			}
		}
	},
};

// ---------------------------------------------------------------------------
// MANGROVE_TREE — Mangrove biome
// Uses generateSlinkyTree with prop roots that spread wide into the water
// ---------------------------------------------------------------------------
export const MANGROVE_TREE: TreeDefinition = {
	woodId: 33, // jungle wood — replace with mangrove wood block
	leavesId: 34, // jungle leaves — replace with mangrove leaves
	baseHeight: 7,
	heightVariance: 3,
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

// ---------------------------------------------------------------------------
// PALM_TREE — Tropical Island, Oasis
// Tall curved trunk with no branches and a single top frond burst
// ---------------------------------------------------------------------------

export const PALM_TREE: TreeDefinition = {
	woodId: 31, // acacia wood — replace with palm wood block
	leavesId: 43, // acacia leaves — replace with palm frond block
	baseHeight: 9,
	heightVariance: 4,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = Squirrel3.get(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));
		const woodId = this.woodId;
		const leavesId = this.leavesId;

		// Curved trunk — leans in one direction the whole way up
		const leanDir = Math.abs(heightHash >> 3) % 8;
		const maxLean = 2 + (Math.abs(heightHash >> 6) % 2); // 2–3 block lean total
		let tx = worldX;
		let tz = worldZ;

		for (let i = 0; i < height; i++) {
			const t = i / Math.max(1, height - 1);
			// Lean increases with height using a smooth curve
			const leanAmount = Math.round(t * t * maxLean);
			const targetX = worldX + DIAG_X[leanDir] * leanAmount;
			const targetZ = worldZ + DIAG_Z[leanDir] * leanAmount;

			// Clamp movement to ±1 per step
			tx += Math.max(-1, Math.min(1, targetX - tx));
			tz += Math.max(-1, Math.min(1, targetZ - tz));

			placeBlock(tx, worldY + i, tz, woodId, true);
		}

		// Frond burst at the crown — 6–8 fronds radiating outward
		const crownY = worldY + height - 1;
		const frondCount = 6 + (Math.abs(heightHash >> 9) % 3);

		for (let f = 0; f < frondCount; f++) {
			const frondHash = Squirrel3.get(
				worldX * 15731 + worldZ * 789221 + f * 1013,
				seedAsInt,
			);
			const frondDir = f % 8; // evenly space around compass
			const frondLen = 3 + (Math.abs(frondHash) % 2); // 3–4 blocks

			let fx = tx;
			let fz = tz;
			let fy = crownY;

			for (let step = 0; step < frondLen; step++) {
				fx += DIAG_X[frondDir];
				fz += DIAG_Z[frondDir];
				// Fronds droop: rise on step 0, flat on 1, drop on 2+
				if (step === 0) fy++;
				else if (step >= 2) fy--;
				placeBlock(fx, fy, fz, leavesId, false);
			}
		}

		// Central top tuft
		placeBlock(tx, crownY + 1, tz, leavesId, false);
		placeBlock(tx, crownY + 2, tz, leavesId, false);
	},
};
