import { Squirrel3 } from "@/code/Generation/NoiseAndParameters/Squirrel13";
import type { TreeDefinition } from "../../BiomeTypes";
import {
	DIAG_X,
	DIAG_Z,
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
		const heightHash = Squirrel3.get(
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
		const heightHash = Squirrel3.get(
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
