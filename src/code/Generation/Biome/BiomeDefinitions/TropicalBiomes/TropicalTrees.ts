import { getPRNGBySeed } from "@/code/Generation/NoiseAndParameters/Squirrel13";
import type { PlaceBlockFn } from "@/code/Generation/SurfaceGenerator";
import type { TreeDefinition } from "../../BiomeTypes";
import { DIAG_X, DIAG_Z, generateSlinkyTree } from "../../TreeDefinition";

const POSITION_HASH_X = 374761393;
const POSITION_HASH_Z = 678446653;

// ---------------------------------------------------------------------------
// JUNGLE_TREE
// ---------------------------------------------------------------------------

export const JUNGLE_TREE: TreeDefinition = {
	woodId: 33,
	leavesId: 93,
	baseHeight: 20,
	heightVariance: 20,

	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = getPRNGBySeed(
			worldX * POSITION_HASH_X + worldZ * POSITION_HASH_Z,
			seedAsInt,
		);

		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));

		const woodId = this.woodId;
		const leavesId = this.leavesId;
		const trunkTopY = worldY + height;

		for (let y = worldY; y < trunkTopY; y++) {
			placeBlock(worldX, y, worldZ, woodId, true);
		}

		const canopyRadius = 4;

		for (let canopy = 1; canopy <= 2; canopy++) {
			const leafYStart = trunkTopY - canopy * 5 - (canopy - 1) * 3;
			const leafYEnd = leafYStart + 8;

			for (let y = leafYStart; y < leafYEnd; y++) {
				const layer = y - leafYStart;
				const radius = canopyRadius - (layer >> 1);
				const radiusLimit = radius * radius + 1;

				for (let xOffset = -radius; xOffset <= radius; xOffset++) {
					const xSquared = xOffset * xOffset;
					const remaining = radiusLimit - xSquared;

					for (let zOffset = -radius; zOffset <= radius; zOffset++) {
						if (zOffset * zOffset <= remaining) {
							placeBlock(
								worldX + xOffset,
								y,
								worldZ + zOffset,
								leavesId,
								false,
							);
						}
					}
				}
			}
		}
	},
};

// ---------------------------------------------------------------------------
// MANGROVE_TREE
// Uses generateSlinkyTree with prop roots that spread wide into the water.
// ---------------------------------------------------------------------------

export const MANGROVE_TREE: TreeDefinition = {
	woodId: 95,
	leavesId: 34,
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
// PALM_TREE
// Tall curved trunk with no branches and a single top frond burst.
// ---------------------------------------------------------------------------

export const PALM_TREE: TreeDefinition = {
	woodId: 85,
	leavesId: 86,
	baseHeight: 9,
	heightVariance: 4,

	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const hash =
			getPRNGBySeed(
				worldX * POSITION_HASH_X + worldZ * POSITION_HASH_Z,
				seedAsInt,
			) >>> 0;

		const height = this.baseHeight + (hash % (this.heightVariance + 1));

		const woodId = this.woodId;
		const leavesId = this.leavesId;

		const leanDirection = (hash >>> 3) & 7;
		const maxLean = 2 + ((hash >>> 6) & 1);
		const directionX = DIAG_X[leanDirection];
		const directionZ = DIAG_Z[leanDirection];
		const heightMinusOne = height - 1;

		let trunkX = worldX;
		let trunkZ = worldZ;

		let previousX = worldX;
		let previousY = worldY;
		let previousZ = worldZ;

		placeBlock(previousX, previousY, previousZ, woodId, true);

		for (let i = 1; i < height; i++) {
			const progress = i / heightMinusOne;
			const leanAmount = Math.round(progress * progress * maxLean);

			const targetX = worldX + directionX * leanAmount;
			const targetY = worldY + i;
			const targetZ = worldZ + directionZ * leanAmount;

			trunkX += Math.sign(targetX - trunkX);
			trunkZ += Math.sign(targetZ - trunkZ);

			placeFaceConnected(
				previousX,
				previousY,
				previousZ,
				trunkX,
				targetY,
				trunkZ,
				woodId,
				true,
				placeBlock,
			);

			previousX = trunkX;
			previousY = targetY;
			previousZ = trunkZ;
		}

		const crownX = previousX;
		const crownY = previousY;
		const crownZ = previousZ;
		const frondCount = 6 + ((hash >>> 9) % 3);

		for (let frond = 0; frond < frondCount; frond++) {
			const frondHash =
				getPRNGBySeed(
					worldX * 15731 + worldZ * 789221 + frond * 1013,
					seedAsInt,
				) >>> 0;

			const frondDirection = frond & 7;
			const frondLength = 3 + (frondHash & 1);
			const frondDirectionX = DIAG_X[frondDirection];
			const frondDirectionZ = DIAG_Z[frondDirection];

			let frondX = crownX;
			let frondY = crownY;
			let frondZ = crownZ;

			for (let step = 0; step < frondLength; step++) {
				const nextX = frondX + frondDirectionX;
				const nextZ = frondZ + frondDirectionZ;

				let nextY = frondY;

				if (step === 0) {
					nextY++;
				} else if (step >= 2) {
					nextY--;
				}

				placeFaceConnected(
					frondX,
					frondY,
					frondZ,
					nextX,
					nextY,
					nextZ,
					leavesId,
					false,
					placeBlock,
				);

				frondX = nextX;
				frondY = nextY;
				frondZ = nextZ;
			}
		}

		placeBlock(crownX, crownY + 1, crownZ, leavesId, false);
		placeBlock(crownX, crownY + 2, crownZ, leavesId, false);
	},
};

function placeFaceConnected(
	fromX: number,
	fromY: number,
	fromZ: number,
	toX: number,
	toY: number,
	toZ: number,
	blockId: number,
	replace: boolean,
	placeBlock: PlaceBlockFn,
): void {
	let x = fromX;
	let y = fromY;
	let z = fromZ;

	const yStep = Math.sign(toY - fromY);
	const xStep = Math.sign(toX - fromX);
	const zStep = Math.sign(toZ - fromZ);

	while (y !== toY) {
		y += yStep;
		placeBlock(x, y, z, blockId, replace);
	}

	while (x !== toX) {
		x += xStep;
		placeBlock(x, y, z, blockId, replace);
	}

	while (z !== toZ) {
		z += zStep;
		placeBlock(x, y, z, blockId, replace);
	}
}
