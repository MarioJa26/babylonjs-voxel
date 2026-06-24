// MountainTrees.ts

import { Squirrel3 } from "../../../NoiseAndParameters/Squirrel13";
import type { TreeDefinition } from "../../BiomeTypes";

export const CONIFER_TREE: TreeDefinition = {
	woodId: 87, // SierranConiferBark
	leavesId: 88, // SierranConiferLeaves
	baseHeight: 6,
	heightVariance: 4,

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
		const h = Squirrel3.get(worldX * 31337 + worldZ * 7919, seedAsInt);
		const height = this.baseHeight + (Math.abs(h) % this.heightVariance);

		for (let y = 0; y < height; y++) {
			placeBlock(worldX, worldY + y, worldZ, this.woodId, true);
		}

		const leafStart = Math.floor(height * 0.4);
		const leafEnd = height + 2;

		for (let y = leafStart; y < leafEnd; y++) {
			const radius = y < height ? 2 : 1;
			for (let dx = -radius; dx <= radius; dx++) {
				for (let dz = -radius; dz <= radius; dz++) {
					if (dx === 0 && dz === 0 && y < height) continue;
					const cornerHash = Squirrel3.get(
						(worldX + dx) * 127 + (worldZ + dz) * 31 + y * 17,
						seedAsInt,
					);
					if (
						Math.abs(dx) === radius &&
						Math.abs(dz) === radius &&
						cornerHash > 0
					)
						continue;
					placeBlock(
						worldX + dx,
						worldY + y,
						worldZ + dz,
						this.leavesId,
						false,
					);
				}
			}
		}
	},
};

export const DEAD_TREE: TreeDefinition = {
	woodId: 39, // RoughWood
	leavesId: 0, // Air (dead tree, no leaves)
	baseHeight: 5,
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
		const h = Squirrel3.get(worldX * 31337 + worldZ * 7919, seedAsInt);
		const height = this.baseHeight + (Math.abs(h) % this.heightVariance);

		for (let y = 0; y < height; y++) {
			placeBlock(worldX, worldY + y, worldZ, this.woodId, true);
		}

		const branchHash = Squirrel3.get(worldX * 521 + worldZ * 997, seedAsInt);
		const branchCount = 2 + (Math.abs(branchHash) % 3);
		for (let i = 0; i < branchCount; i++) {
			const dirHash = Squirrel3.get(
				worldX * 131 + worldZ * 277 + i * 43,
				seedAsInt,
			);
			const branchY =
				Math.floor(height * 0.4) +
				(Math.abs(dirHash) % Math.floor(height * 0.5));
			const dir = Math.abs(dirHash) % 4;
			const length =
				1 +
				(Math.abs(
					Squirrel3.get(worldX * 61 + worldZ * 151 + i * 73, seedAsInt),
				) %
					2);

			for (let l = 1; l <= length; l++) {
				let bx = worldX;
				let bz = worldZ;
				if (dir === 0) bx += l;
				else if (dir === 1) bx -= l;
				else if (dir === 2) bz += l;
				else bz -= l;
				placeBlock(bx, worldY + branchY, bz, this.woodId, false);
			}
		}
	},
};
