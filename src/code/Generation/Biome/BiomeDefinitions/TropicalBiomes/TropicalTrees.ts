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
	woodId: 85, // palm wood
	leavesId: 86, // palm leaves
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

		function placeFaceConnected(
			fromX: number,
			fromY: number,
			fromZ: number,
			toX: number,
			toY: number,
			toZ: number,
			blockId: number,
			replace: boolean,
		): { x: number; y: number; z: number } {
			let x = fromX;
			let y = fromY;
			let z = fromZ;

			while (y !== toY) {
				y += Math.sign(toY - y);
				placeBlock(x, y, z, blockId, replace);
			}

			while (x !== toX) {
				x += Math.sign(toX - x);
				placeBlock(x, y, z, blockId, replace);
			}

			while (z !== toZ) {
				z += Math.sign(toZ - z);
				placeBlock(x, y, z, blockId, replace);
			}

			return { x, y, z };
		}

		// Curved trunk — leans in one direction, but always face-connected
		const leanDir = Math.abs(heightHash >> 3) % 8;
		const maxLean = 2 + (Math.abs(heightHash >> 6) % 2); // 2–3 block lean total

		let tx = worldX;
		let tz = worldZ;

		let prevX = worldX;
		let prevY = worldY;
		let prevZ = worldZ;

		placeBlock(prevX, prevY, prevZ, woodId, true);

		for (let i = 1; i < height; i++) {
			const t = i / Math.max(1, height - 1);
			const leanAmount = Math.round(t * t * maxLean);

			const targetX = worldX + DIAG_X[leanDir] * leanAmount;
			const targetZ = worldZ + DIAG_Z[leanDir] * leanAmount;
			const targetY = worldY + i;

			tx += Math.max(-1, Math.min(1, targetX - tx));
			tz += Math.max(-1, Math.min(1, targetZ - tz));

			const p = placeFaceConnected(
				prevX,
				prevY,
				prevZ,
				tx,
				targetY,
				tz,
				woodId,
				true,
			);

			prevX = p.x;
			prevY = p.y;
			prevZ = p.z;
		}

		// Final trunk/crown position
		const crownX = prevX;
		const crownY = prevY;
		const crownZ = prevZ;

		// Frond burst at the crown — 6–8 fronds radiating outward
		const frondCount = 6 + (Math.abs(heightHash >> 9) % 3);

		for (let f = 0; f < frondCount; f++) {
			const frondHash = Squirrel3.get(
				worldX * 15731 + worldZ * 789221 + f * 1013,
				seedAsInt,
			);

			const frondDir = f % 8;
			const frondLen = 3 + (Math.abs(frondHash) % 2); // 3–4 blocks

			let prevFx = crownX;
			let prevFy = crownY;
			let prevFz = crownZ;

			for (let step = 0; step < frondLen; step++) {
				const nextX = prevFx + DIAG_X[frondDir];
				const nextZ = prevFz + DIAG_Z[frondDir];

				let nextY = prevFy;

				// Fronds droop: rise first, then fall outward
				if (step === 0) {
					nextY++;
				} else if (step >= 2) {
					nextY--;
				}

				const p = placeFaceConnected(
					prevFx,
					prevFy,
					prevFz,
					nextX,
					nextY,
					nextZ,
					leavesId,
					false,
				);

				prevFx = p.x;
				prevFy = p.y;
				prevFz = p.z;
			}
		}

		// Central top tuft
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
	placeBlock: (
		x: number,
		y: number,
		z: number,
		blockId: number,
		replace: boolean,
	) => void,
): { x: number; y: number; z: number } {
	let x = fromX;
	let y = fromY;
	let z = fromZ;

	// Move vertically first
	while (y !== toY) {
		y += Math.sign(toY - y);
		placeBlock(x, y, z, blockId, replace);
	}

	// Then move on X axis
	while (x !== toX) {
		x += Math.sign(toX - x);
		placeBlock(x, y, z, blockId, replace);
	}

	// Then move on Z axis
	while (z !== toZ) {
		z += Math.sign(toZ - z);
		placeBlock(x, y, z, blockId, replace);
	}

	return { x, y, z };
}
