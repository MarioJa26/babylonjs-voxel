import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import type { PlaceBlockFn } from "../SurfaceGenerator";

export const DIR_X = [1, 0, -1, 0] as const;
export const DIR_Z = [0, 1, 0, -1] as const;
export const DIAG_X = [1, 1, 0, -1, -1, -1, 0, 1] as const;
export const DIAG_Z = [0, 1, 1, 1, 0, -1, -1, -1] as const;

const LEAF_NOISE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
	LEAF_NOISE[i] = (getPRNGBySeed(i, 0) >>> 0) & 0xff;
}

const PACK_LOCAL_BITS = 6;
const PACK_LOCAL_ORIGIN = 32;
const PACK_LOCAL_MASK = (1 << PACK_LOCAL_BITS) - 1;

function packLocal(dx: number, dy: number, dz: number): number {
	return (
		((dx + PACK_LOCAL_ORIGIN) & PACK_LOCAL_MASK) |
		(((dy + PACK_LOCAL_ORIGIN) & PACK_LOCAL_MASK) << PACK_LOCAL_BITS) |
		(((dz + PACK_LOCAL_ORIGIN) & PACK_LOCAL_MASK) << (PACK_LOCAL_BITS * 2))
	);
}

const woodSet = new Set<number>();

const CANOPY_RADIUS_REDUCTION_7 = [1, 1, 0, 0, 0, 1, 1] as const;
const SIDE_LOBE_RADIUS_REDUCTION_5 = [1, 0, 0, 0, 1] as const;

export function generateSlinkyTree(
	worldX: number,
	worldY: number,
	worldZ: number,
	placeBlock: PlaceBlockFn,
	seedAsInt: number,
	woodId: number,
	leavesId: number,
	baseHeight: number,
	heightVariance: number,
): void {
	woodSet.clear();

	const heightHash =
		getPRNGBySeed(worldX * 374761393 + worldZ * 678446653, seedAsInt) >>> 0;
	const height = baseHeight + (heightHash & heightVariance);

	function placeWood(x: number, y: number, z: number): void {
		placeBlock(x, y, z, woodId, true);
		woodSet.add(packLocal(x - worldX, y - worldY, z - worldZ));
	}

	const tapRootDepth = 3 + (heightHash & 1);
	for (let d = 1; d <= tapRootDepth; d++) {
		placeWood(worldX, worldY - d, worldZ);
	}

	for (let root = 0; root < 5; root++) {
		const rootHash =
			getPRNGBySeed(worldX * 31337 + worldZ * 6971 + root * 101, seedAsInt) >>>
			0;

		let dir = rootHash & 3;
		const rootLength = 2 + (rootHash & 4);

		let rootX = worldX;
		let rootY = worldY - 1;
		let rootZ = worldZ;
		let unsupportedStreak = 0;

		for (let step = 0; step < rootLength; step++) {
			const turnHash = getPRNGBySeed(rootHash + step * 17, seedAsInt) >>> 0;
			const mod = turnHash & 4;

			if (mod === 0) dir = (dir + 1) & 3;
			else if (mod === 1) dir = (dir + 3) & 3;

			rootX += DIR_X[dir];
			rootZ += DIR_Z[dir];

			placeWood(rootX, rootY, rootZ);

			const hasSupportBelow = woodSet.has(
				packLocal(rootX - worldX, rootY - 1 - worldY, rootZ - worldZ),
			);

			unsupportedStreak = hasSupportBelow ? 0 : unsupportedStreak + 1;

			if (!hasSupportBelow || (unsupportedStreak > 0 && (step & 1) === 0)) {
				rootY--;
				placeWood(rootX, rootY, rootZ);

				if (unsupportedStreak >= 2 && (step & 1) === 1) {
					rootY--;
					placeWood(rootX, rootY, rootZ);
				}
			}
		}
	}

	const trunkBaseHash =
		getPRNGBySeed(worldX * 92837111 + worldZ * 689287499, seedAsInt) >>> 0;

	const bendDirection = trunkBaseHash & 7;
	const bendDirX = DIAG_X[bendDirection];
	const bendDirZ = DIAG_Z[bendDirection];
	const maxBend = 3 + (trunkBaseHash & 1);
	const heightM1 = Math.max(1, height - 1);

	let trunkCenterX = worldX;
	let trunkCenterZ = worldZ;
	let previousX = worldX;
	let previousZ = worldZ;
	let finalTrunkX = worldX;
	let finalTrunkZ = worldZ;

	for (let i = 0; i < height; i++) {
		const t = i / heightM1;
		const arc = Math.sin(t * Math.PI * 0.85);
		const curveAmount = Math.round(arc * maxBend);

		const swayHash = getPRNGBySeed(trunkBaseHash + i * 31, seedAsInt) >>> 0;
		const swayPhase = (swayHash & 255) * 0.0174533;
		const lateralSway = Math.sin(t * Math.PI + swayPhase) * 0.5;

		const targetX = worldX + bendDirX * curveAmount + bendDirZ * lateralSway;
		const targetZ = worldZ + bendDirZ * curveAmount - bendDirX * lateralSway;

		trunkCenterX += Math.max(
			-1,
			Math.min(1, Math.round(targetX) - trunkCenterX),
		);
		trunkCenterZ += Math.max(
			-1,
			Math.min(1, Math.round(targetZ) - trunkCenterZ),
		);

		const y = worldY + i;

		if (i > 0) {
			placeWood(
				Math.floor((previousX + trunkCenterX) / 2),
				y,
				Math.floor((previousZ + trunkCenterZ) / 2),
			);
		}

		const trunkRadius = i < height - 3 ? Math.floor(1 + 3 * (i / height)) : 0;
		const radiusSq = trunkRadius * trunkRadius;

		for (let x = -trunkRadius; x <= trunkRadius; x++) {
			const x2 = x * x;
			for (let z = -trunkRadius; z <= trunkRadius; z++) {
				if (x2 + z * z <= radiusSq) {
					placeWood(trunkCenterX + x, y, trunkCenterZ + z);
				}
			}
		}

		previousX = trunkCenterX;
		previousZ = trunkCenterZ;
		finalTrunkX = trunkCenterX;
		finalTrunkZ = trunkCenterZ;
	}

	const canopyCenterX = finalTrunkX;
	const canopyCenterY = worldY + height - 1;
	const canopyCenterZ = finalTrunkZ;

	for (let dy = -3; dy <= 3; dy++) {
		const layerY = canopyCenterY + dy;
		const layerTerm = layerY * 13;
		const radius = 5 - CANOPY_RADIUS_REDUCTION_7[dy + 3];
		const radiusSqP1 = radius * radius + 1;

		for (let x = -radius; x <= radius; x++) {
			const lx = canopyCenterX + x;
			const x2 = x * x;
			const xTerm = lx * 3;

			for (let z = -radius; z <= radius; z++) {
				if (x2 + z * z <= radiusSqP1) {
					const wz = canopyCenterZ + z;
					const noiseIndex = (xTerm + wz * 7 + layerTerm) & 0xff;

					if (LEAF_NOISE[noiseIndex] > 32) {
						placeBlock(lx, layerY, wz, leavesId, false);
					}
				}
			}
		}
	}

	for (let lobe = 0; lobe < 3; lobe++) {
		const lobeHash =
			getPRNGBySeed(worldX * 9719 + worldZ * 19997 + lobe * 53, seedAsInt) >>>
			0;

		const lobeDir = lobeHash & 7;
		const centerX = canopyCenterX + DIAG_X[lobeDir] * 3;
		const centerZ = canopyCenterZ + DIAG_Z[lobeDir] * 3;
		const centerY = canopyCenterY - 1 + (lobeHash & 1);

		for (let dy = -2; dy <= 2; dy++) {
			const layerY = centerY + dy;
			const radius = 3 - SIDE_LOBE_RADIUS_REDUCTION_5[dy + 2];
			const radiusSqP1 = radius * radius + 1;

			for (let x = -radius; x <= radius; x++) {
				const x2 = x * x;
				for (let z = -radius; z <= radius; z++) {
					if (x2 + z * z <= radiusSqP1) {
						placeBlock(centerX + x, layerY, centerZ + z, leavesId, false);
					}
				}
			}
		}
	}
}

export function generateBigTopBentOak(
	worldX: number,
	worldY: number,
	worldZ: number,
	placeBlock: PlaceBlockFn,
	seedAsInt: number,
	woodId: number,
	leavesId: number,
	baseHeight: number,
	heightVariance: number,
): void {
	woodSet.clear();

	const heightHash =
		getPRNGBySeed(worldX * 374761393 + worldZ * 678446653, seedAsInt) >>> 0;
	const height = baseHeight + (heightHash & heightVariance);

	function placeWood(x: number, y: number, z: number): void {
		placeBlock(x, y, z, woodId, true);
		woodSet.add(packLocal(x - worldX, y - worldY, z - worldZ));
	}

	const tapRootDepth = 5 + (heightHash & 1);
	for (let d = 1; d <= tapRootDepth; d++) {
		placeWood(worldX, worldY - d, worldZ);
	}

	for (let root = 0; root < 5; root++) {
		const rootHash =
			getPRNGBySeed(worldX * 31337 + worldZ * 6971 + root * 101, seedAsInt) >>>
			0;
		let dir = rootHash & 3;
		const rootLength = 3 + (rootHash & 4);
		let rootX = worldX;
		let rootY = worldY - 1;
		let rootZ = worldZ;
		let unsupportedStreak = 0;

		for (let step = 0; step < rootLength; step++) {
			const turnHash = getPRNGBySeed(rootHash + step * 17, seedAsInt) >>> 0;
			const mod = turnHash & 4;
			if (mod === 0) dir = (dir + 1) & 3;
			else if (mod === 1) dir = (dir + 3) & 3;

			rootX += DIR_X[dir];
			rootZ += DIR_Z[dir];
			placeWood(rootX, rootY, rootZ);

			const hasSupportBelow = woodSet.has(
				packLocal(rootX - worldX, rootY - 1 - worldY, rootZ - worldZ),
			);
			unsupportedStreak = hasSupportBelow ? 0 : unsupportedStreak + 1;

			if (!hasSupportBelow || (unsupportedStreak > 0 && (step & 1) === 0)) {
				rootY--;
				placeWood(rootX, rootY, rootZ);
				if (unsupportedStreak >= 2 && (step & 1) === 1) {
					rootY--;
					placeWood(rootX, rootY, rootZ);
				}
			}
		}
	}

	const trunkBaseHash =
		getPRNGBySeed(worldX * 92837111 + worldZ * 689287499, seedAsInt) >>> 0;
	const arcHash = getPRNGBySeed(worldX * 1237 + worldZ * 7919, seedAsInt) >>> 0;

	const bendAxisX = (arcHash & 1) === 0;
	const bendSign = ((arcHash >> 1) & 1) === 0 ? 1 : -1;
	const arcRadius = 6 + ((trunkBaseHash >> 2) & 1);
	const twistDrift = 2 + ((trunkBaseHash >> 4) & 1);
	const canopyBaseRadius = 4 + ((trunkBaseHash >> 13) & 1);
	const canopyYOffset = ((trunkBaseHash >> 15) & 3) - 1;
	const sideLobeCount = 3 + ((trunkBaseHash >> 17) & 1);
	const baseFlareLayers = Math.max(4, Math.floor(height * 0.28));
	const deepBaseLayers = Math.max(2, Math.floor(height * 0.14));
	const heightM1 = Math.max(1, height - 1);

	let finalTrunkX = worldX;
	let finalTrunkZ = worldZ;

	for (let i = 0; i < height; i++) {
		const t = i / heightM1;
		const arcOffset = Math.round(Math.sin(t * Math.PI) * arcRadius * bendSign);
		const drift = Math.round((t - 0.5) * twistDrift);
		const trunkX = bendAxisX ? worldX + arcOffset : worldX + drift;
		const trunkZ = bendAxisX ? worldZ + drift : worldZ + arcOffset;
		const y = worldY + i;

		placeWood(trunkX, y, trunkZ);

		if (i < height - 1) {
			placeWood(trunkX + 1, y, trunkZ);
			placeWood(trunkX - 1, y, trunkZ);
			placeWood(trunkX, y, trunkZ + 1);
			placeWood(trunkX, y, trunkZ - 1);
		}

		if (i < baseFlareLayers) {
			placeWood(trunkX + 2, y, trunkZ);
			placeWood(trunkX - 2, y, trunkZ);
			placeWood(trunkX, y, trunkZ + 2);
			placeWood(trunkX, y, trunkZ - 2);

			if (i < deepBaseLayers) {
				placeWood(trunkX + 1, y, trunkZ + 1);
				placeWood(trunkX + 1, y, trunkZ - 1);
				placeWood(trunkX - 1, y, trunkZ + 1);
				placeWood(trunkX - 1, y, trunkZ - 1);
			}
		}

		finalTrunkX = trunkX;
		finalTrunkZ = trunkZ;
	}

	const canopyCenterX = finalTrunkX;
	const canopyCenterY = worldY + height - 1 + canopyYOffset;
	const canopyCenterZ = finalTrunkZ;

	for (let dy = -3; dy <= 3; dy++) {
		const layerY = canopyCenterY + dy;
		const layerTerm = layerY * 13;
		const radius = canopyBaseRadius - CANOPY_RADIUS_REDUCTION_7[dy + 3];
		const radiusSqP1 = radius * radius + 1;

		for (let x = -radius; x <= radius; x++) {
			const lx = canopyCenterX + x;
			const x2 = x * x;
			const xTerm = lx * 3;

			for (let z = -radius; z <= radius; z++) {
				if (x2 + z * z <= radiusSqP1) {
					const wz = canopyCenterZ + z;
					const noiseIndex = (xTerm + wz * 7 + layerTerm) & 0xff;

					if (LEAF_NOISE[noiseIndex] > 32) {
						placeBlock(lx, layerY, wz, leavesId, false);
					}
				}
			}
		}
	}

	for (let lobe = 0; lobe < sideLobeCount; lobe++) {
		const lobeHash =
			getPRNGBySeed(worldX * 9719 + worldZ * 19997 + lobe * 53, seedAsInt) >>>
			0;

		const lobeDir = lobeHash & 7;
		const lobeDistance = 3 + ((lobeHash >> 3) & 1);
		const centerX = canopyCenterX + DIAG_X[lobeDir] * lobeDistance;
		const centerZ = canopyCenterZ + DIAG_Z[lobeDir] * lobeDistance;
		const centerY = canopyCenterY - 1 + (lobeHash & 1);

		for (let dy = -2; dy <= 2; dy++) {
			const layerY = centerY + dy;
			const radius = 3 - SIDE_LOBE_RADIUS_REDUCTION_5[dy + 2];
			const radiusSqP1 = radius * radius + 1;

			for (let x = -radius; x <= radius; x++) {
				const wx = centerX + x;
				const x2 = x * x;

				for (let z = -radius; z <= radius; z++) {
					if (x2 + z * z <= radiusSqP1) {
						placeBlock(wx, layerY, centerZ + z, leavesId, false);
					}
				}
			}
		}
	}
}

export function generateBaobab(
	worldX: number,
	worldY: number,
	worldZ: number,
	placeBlock: PlaceBlockFn,
	seedAsInt: number,
	woodId: number,
	leavesId: number,
	baseHeight: number,
	heightVariance: number,
): void {
	const heightHash =
		getPRNGBySeed(worldX * 374761393 + worldZ * 678446653, seedAsInt) >>> 0;
	const height = baseHeight + (heightHash & heightVariance);

	function placeWood(x: number, y: number, z: number): void {
		placeBlock(x, y, z, woodId, true);
	}

	const tapRootDepth = 3 + (heightHash & 1);
	for (let d = 1; d <= tapRootDepth; d++) {
		placeWood(worldX, worldY - d, worldZ);
	}

	const baseTrunkRadius = 3;
	const topTrunkRadius = 1;
	const heightM1 = Math.max(1, height - 1);

	for (let i = 0; i < height; i++) {
		const t = i / heightM1;
		const taper = 1 - t ** 0.5;
		const radius = Math.round(
			topTrunkRadius + (baseTrunkRadius - topTrunkRadius) * taper,
		);
		const radiusSq = radius * radius;
		const y = worldY + i;

		for (let x = -radius; x <= radius; x++) {
			const x2 = x * x;
			const wx = worldX + x;

			for (let z = -radius; z <= radius; z++) {
				if (x2 + z * z <= radiusSq) {
					placeWood(wx, y, worldZ + z);
				}
			}
		}
	}

	const branchCount = 4 + (heightHash & 2);
	const crownY = worldY + height;

	for (let b = 0; b < branchCount; b++) {
		const branchHash =
			getPRNGBySeed(worldX * 15731 + worldZ * 789221 + b * 1013, seedAsInt) >>>
			0;

		const branchDir = branchHash & 7;
		const branchLength = 2 + ((branchHash >> 3) & 2);
		const branchRise = 1 + ((branchHash >> 6) & 1);

		let bx = worldX;
		let by = crownY;
		let bz = worldZ;

		for (let step = 0; step < branchLength; step++) {
			bx += DIAG_X[branchDir];
			bz += DIAG_Z[branchDir];

			if (step < branchRise) by++;

			placeWood(bx, by, bz);
			placeWood(bx, by - 1, bz);
		}

		const leafRadius = 2 + ((branchHash >> 9) & 1);
		const leafRadiusSq = leafRadius * leafRadius + 1;

		for (let dy = -1; dy <= 2; dy++) {
			const ly = by + dy;
			const layerTerm = ly * 13;

			for (let x = -leafRadius; x <= leafRadius; x++) {
				const lx = bx + x;
				const x2 = x * x;
				const xTerm = lx * 3;

				for (let z = -leafRadius; z <= leafRadius; z++) {
					if (x2 + z * z <= leafRadiusSq) {
						const wz = bz + z;
						const noiseIndex = (xTerm + wz * 7 + layerTerm) & 0xff;

						if (LEAF_NOISE[noiseIndex] > 32) {
							placeBlock(lx, ly, wz, leavesId, false);
						}
					}
				}
			}
		}
	}
}
