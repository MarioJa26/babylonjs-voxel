import { getPRNGBySeed } from "@/code/Generation/NoiseAndParameters/Squirrel13";
import type { TreeDefinition } from "../../BiomeTypes";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
const HASH_A = 374761393;
const HASH_B = 678446653;

// ---------------------------------------------------------------------------
// ICE_SPIKE_COLUMN — Ice Spikes biome
// - Above ground: tapered ice spike with wooden core
// - Below ground: mirrored taper downward, half height, no wooden core
// ---------------------------------------------------------------------------
export const ICE_SPIKE_COLUMN: TreeDefinition = {
	woodId: 22, // wooden core inside the spike
	leavesId: 0,
	baseHeight: 10,
	heightVariance: 15,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const h = getPRNGBySeed(worldX * HASH_A + worldZ * HASH_B, seedAsInt);
		const height = this.baseHeight + (Math.abs(h) % (this.heightVariance + 1));
		const woodId = this.woodId;
		const iceId = 75; // packed ice

		const heightM1 = Math.max(1, height - 1);
		const rootHeight = height >> 1; // mirrored root, half height
		const rootHeightM1 = Math.max(1, rootHeight - 1);

		// ── Underground mirrored root — no wooden core ────────────────────────
		// Mirrors the spike shape downward: wide at worldY, tapers to point below
		for (let i = 1; i <= rootHeight; i++) {
			// t=0 at surface (wide), t=1 at tip (narrow) — same taper curve as above
			const t = i / rootHeightM1;
			const radius = Math.round((1 - t) * 2); // radius 2 → 0
			const radiusSq = radius * radius;
			const y = worldY - i;

			if (radius === 0) {
				placeBlock(worldX, y, worldZ, iceId, true);
			} else {
				for (let x = -radius; x <= radius; x++) {
					const x2 = x * x;
					for (let z = -radius; z <= radius; z++) {
						if (x2 + z * z <= radiusSq) {
							placeBlock(worldX + x, y, worldZ + z, iceId, true);
						}
					}
				}
			}
		}

		// ── Above ground spike — ice shell with wooden core ───────────────────
		for (let i = 0; i < height; i++) {
			const t = i / heightM1; // 0 = base, 1 = tip
			const radius = Math.round((1 - t) * 2); // radius 2 → 0
			const radiusSq = radius * radius;
			const y = worldY + i;

			if (radius === 0) {
				// Tip — just ice, single block
				placeBlock(worldX, y, worldZ, iceId, true);
			} else {
				for (let x = -radius; x <= radius; x++) {
					const x2 = x * x;
					for (let z = -radius; z <= radius; z++) {
						if (x2 + z * z <= radiusSq) {
							// Wooden core — only the center column gets wood
							const isCore = x === 0 && z === 0;
							placeBlock(
								worldX + x,
								y,
								worldZ + z,
								isCore ? woodId : iceId,
								true,
							);
						}
					}
				}
			}
		}
	},
};
