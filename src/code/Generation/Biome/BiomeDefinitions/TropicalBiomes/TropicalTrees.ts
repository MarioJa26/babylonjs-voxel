import { getPRNGBySeed } from "@/code/Generation/NoiseAndParameters/Squirrel13";
import type { PlaceBlockFn } from "@/code/Generation/SurfaceGenerator";
import type { TreeDefinition } from "../../BiomeTypes";
import { DIAG_X, DIAG_Z, generateSlinkyTree } from "../../TreeDefinition";

export const JUNGLE_TREE: TreeDefinition = {
	woodId: 33,
	leavesId: 93,
	baseHeight: 20,
	heightVariance: 20,
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
	woodId: 95, // mangrove wood block
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
	woodId: 85, // palm wood
	leavesId: 86, // palm leaves
	baseHeight: 9,
	heightVariance: 4,

	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const hash =
			getPRNGBySeed(worldX * 374761393 + worldZ * 678446653, seedAsInt) >>> 0;

		const height = this.baseHeight + (hash % (this.heightVariance + 1));

		const woodId = this.woodId;
		const leavesId = this.leavesId;

		const leanDir = (hash >>> 3) & 7;
		const maxLean = 2 + ((hash >>> 6) & 1);

		const dirX = DIAG_X[leanDir];
		const dirZ = DIAG_Z[leanDir];

		let tx = worldX;
		let tz = worldZ;

		let prevX = worldX;
		let prevY = worldY;
		let prevZ = worldZ;

		placeBlock(prevX, prevY, prevZ, woodId, true);

		for (let i = 1; i < height; i++) {
			const t = i / (height - 1);
			const leanAmount = Math.round(t * t * maxLean);

			const targetX = worldX + dirX * leanAmount;
			const targetZ = worldZ + dirZ * leanAmount;
			const targetY = worldY + i;

			if (tx < targetX) tx++;
			else if (tx > targetX) tx--;

			if (tz < targetZ) tz++;
			else if (tz > targetZ) tz--;

			placeFaceConnected(
				prevX,
				prevY,
				prevZ,
				tx,
				targetY,
				tz,
				woodId,
				true,
				placeBlock,
			);

			prevX = tx;
			prevY = targetY;
			prevZ = tz;
		}

		const crownX = prevX;
		const crownY = prevY;
		const crownZ = prevZ;

		// Frond burst at the crown — 6–8 fronds radiating outward
		const frondCount = 6 + ((hash >>> 9) % 3);

		for (let f = 0; f < frondCount; f++) {
			const frondHash =
				getPRNGBySeed(
					worldX * 15731 + worldZ * 789221 + f * 1013,
					seedAsInt,
				) >>> 0;

			const frondDir = f & 7;
			const frondLen = 3 + (frondHash & 1);

			const frondDirX = DIAG_X[frondDir];
			const frondDirZ = DIAG_Z[frondDir];

			let prevFx = crownX;
			let prevFy = crownY;
			let prevFz = crownZ;

			for (let step = 0; step < frondLen; step++) {
				const nextX = prevFx + frondDirX;
				const nextZ = prevFz + frondDirZ;

				let nextY = prevFy;

				if (step === 0) {
					nextY++;
				} else if (step >= 2) {
					nextY--;
				}

				placeFaceConnected(
					prevFx,
					prevFy,
					prevFz,
					nextX,
					nextY,
					nextZ,
					leavesId,
					false,
					placeBlock,
				);

				prevFx = nextX;
				prevFy = nextY;
				prevFz = nextZ;
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

	while (y !== toY) {
		y += y < toY ? 1 : -1;
		placeBlock(x, y, z, blockId, replace);
	}

	while (x !== toX) {
		x += x < toX ? 1 : -1;
		placeBlock(x, y, z, blockId, replace);
	}

	while (z !== toZ) {
		z += z < toZ ? 1 : -1;
		placeBlock(x, y, z, blockId, replace);
	}
}
