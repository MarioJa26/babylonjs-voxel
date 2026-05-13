import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import type { TreeDefinition } from "./BiomeTypes";

// --- Shared constants hoisted to module scope ---
// V8: avoid re-allocating identical arrays on every function call
export const DIR_X = [1, 0, -1, 0] as const;
export const DIR_Z = [0, 1, 0, -1] as const;
export const DIAG_X = [1, 1, 0, -1, -1, -1, 0, 1] as const;
export const DIAG_Z = [0, 1, 1, 1, 0, -1, -1, -1] as const;

// --- Shared packed-int spatial set ---
// V8: integer keys in a Set are far cheaper than string concatenation.
// Coordinates are packed into a single 32-bit int (supports ±1023 per axis).
// Change PACK_BITS if your world coords exceed that range.
const PACK_BITS = 10; // 2^10 = 1024
const PACK_MASK = (1 << PACK_BITS) - 1;
const PACK_ORIGIN = 512; // bias so negative coords stay positive

/** Pack (x, y, z) into a single integer key. */
function packXYZ(x: number, y: number, z: number): number {
	return (
		((x + PACK_ORIGIN) & PACK_MASK) |
		(((y + PACK_ORIGIN) & PACK_MASK) << PACK_BITS) |
		(((z + PACK_ORIGIN) & PACK_MASK) << (PACK_BITS * 2))
	);
}

// Module-level reusable Set – cleared before each tree that needs it.
// V8: avoids GC pressure from allocating/discarding large Sets per tree.
const woodSet = new Set<number>();

// ---------------------------------------------------------------------------
// generateSlinkyTree
// ---------------------------------------------------------------------------

export function generateSlinkyTree(
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
	woodId: number,
	leavesId: number,
	baseHeight: number,
	heightVariance: number,
): void {
	woodSet.clear();

	const heightHash = Squirrel3.get(
		worldX * 374761393 + worldZ * 678446653,
		seedAsInt,
	);
	const height = baseHeight + (Math.abs(heightHash) % (heightVariance + 1));

	// Inline placeWood – avoids closure allocation on each call site
	function placeWood(x: number, y: number, z: number): void {
		placeBlock(x, y, z, woodId, true);
		woodSet.add(packXYZ(x, y, z));
	}

	// Tap root
	const tapRootDepth = 3 + (Math.abs(heightHash) % 2);
	for (let d = 1; d <= tapRootDepth; d++) {
		placeWood(worldX, worldY - d, worldZ);
	}

	// Surface roots
	for (let root = 0; root < 5; root++) {
		const rootHash = Squirrel3.get(
			worldX * 31337 + worldZ * 6971 + root * 101,
			seedAsInt,
		);
		let dir = Math.abs(rootHash) % 4;
		const rootLength = 2 + (Math.abs(rootHash) % 5);
		let rootX = worldX;
		let rootY = worldY - 1;
		let rootZ = worldZ;
		let unsupportedStreak = 0;

		for (let step = 0; step < rootLength; step++) {
			const turnHash = Squirrel3.get(rootHash + step * 17, seedAsInt);
			const mod = Math.abs(turnHash) % 5;
			if (mod === 0) dir = (dir + 1) % 4;
			else if (mod === 1) dir = (dir + 3) % 4;

			rootX += DIR_X[dir];
			rootZ += DIR_Z[dir];
			placeWood(rootX, rootY, rootZ);

			const hasSupportBelow = woodSet.has(packXYZ(rootX, rootY - 1, rootZ));
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

	// Trunk
	const trunkBaseHash = Squirrel3.get(
		worldX * 92837111 + worldZ * 689287499,
		seedAsInt,
	);
	const bendDirection = Math.abs(trunkBaseHash) % 8;
	const bendDirX = DIAG_X[bendDirection];
	const bendDirZ = DIAG_Z[bendDirection];
	const maxBend = 3 + (Math.abs(trunkBaseHash) % 2);
	const heightM1 = Math.max(1, height - 1); // hoist division denominator

	let trunkCenterX = worldX;
	let trunkCenterZ = worldZ;
	let finalTrunkX = worldX;
	let finalTrunkZ = worldZ;

	for (let i = 0; i < height; i++) {
		const t = i / heightM1;
		const arc = Math.sin(t * Math.PI * 0.85);
		const curveAmount = Math.round(arc * maxBend);

		const swayHash = Squirrel3.get(trunkBaseHash + i * 31, seedAsInt);
		const swayPhase = (Math.abs(swayHash) % 360) * 0.0174533;
		const lateralSway = Math.sin(t * Math.PI + swayPhase) * 0.5;
		const targetX = worldX + bendDirX * curveAmount + bendDirZ * lateralSway;
		const targetZ = worldZ + bendDirZ * curveAmount - bendDirX * lateralSway;

		// clamp delta to ±1
		trunkCenterX += Math.max(
			-1,
			Math.min(1, Math.round(targetX) - trunkCenterX),
		);
		trunkCenterZ += Math.max(
			-1,
			Math.min(1, Math.round(targetZ) - trunkCenterZ),
		);

		const y = worldY + i;
		// V8: pre-compute radius²; avoid repeated pow
		const trunkRadius = i < height - 3 ? 1 + 3 * (i / height) : 0;
		const radiusSq = trunkRadius * trunkRadius;

		for (let x = -trunkRadius; x <= trunkRadius; x++) {
			for (let z = -trunkRadius; z <= trunkRadius; z++) {
				if (x * x + z * z <= radiusSq) {
					placeBlock(trunkCenterX + x, y, trunkCenterZ + z, woodId, true);
				}
			}
		}

		finalTrunkX = trunkCenterX;
		finalTrunkZ = trunkCenterZ;
	}

	// Main canopy
	const canopyCenterX = finalTrunkX;
	const canopyCenterY = worldY + height - 1;
	const canopyCenterZ = finalTrunkZ;

	for (let dy = -3; dy <= 3; dy++) {
		const layerY = canopyCenterY + dy;
		const radius = 5 - Math.floor(Math.abs(dy) / 2); // Math.abs(dy)>>1 also works
		const radiusSqP1 = radius * radius + 1;
		for (let x = -radius; x <= radius; x++) {
			const lx = canopyCenterX + x;
			const x2 = x * x;
			for (let z = -radius; z <= radius; z++) {
				if (x2 + z * z <= radiusSqP1) {
					const leafHash = Squirrel3.get(
						lx * 11939 + (canopyCenterZ + z) * 15485863 + layerY * 29791,
						seedAsInt,
					);
					if (Math.abs(leafHash) % 8 !== 0) {
						placeBlock(lx, layerY, canopyCenterZ + z, leavesId, false);
					}
				}
			}
		}
	}

	// Side canopy lobes
	for (let lobe = 0; lobe < 3; lobe++) {
		const lobeHash = Squirrel3.get(
			worldX * 9719 + worldZ * 19997 + lobe * 53,
			seedAsInt,
		);
		const lobeDir = Math.abs(lobeHash) % 8;
		const centerX = canopyCenterX + DIAG_X[lobeDir] * 3;
		const centerZ = canopyCenterZ + DIAG_Z[lobeDir] * 3;
		const centerY = canopyCenterY - 1 + (Math.abs(lobeHash) % 2);

		for (let dy = -2; dy <= 2; dy++) {
			const radius = 3 - Math.floor(Math.abs(dy) / 2);
			const radiusSqP1 = radius * radius + 1;
			for (let x = -radius; x <= radius; x++) {
				const x2 = x * x;
				for (let z = -radius; z <= radius; z++) {
					if (x2 + z * z <= radiusSqP1) {
						placeBlock(centerX + x, centerY + dy, centerZ + z, leavesId, false);
					}
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// generateBigTopBentOak
// ---------------------------------------------------------------------------

export function generateBigTopBentOak(
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
	woodId: number,
	leavesId: number,
	baseHeight: number,
	heightVariance: number,
): void {
	woodSet.clear();

	const heightHash = Squirrel3.get(
		worldX * 374761393 + worldZ * 678446653,
		seedAsInt,
	);
	const height = baseHeight + (Math.abs(heightHash) % (heightVariance + 1));

	function placeWood(x: number, y: number, z: number): void {
		placeBlock(x, y, z, woodId, true);
		woodSet.add(packXYZ(x, y, z));
	}

	// Tap root
	const tapRootDepth = 5 + (Math.abs(heightHash) % 2);
	for (let d = 1; d <= tapRootDepth; d++) {
		placeWood(worldX, worldY - d, worldZ);
	}

	// Surface roots
	for (let root = 0; root < 5; root++) {
		const rootHash = Squirrel3.get(
			worldX * 31337 + worldZ * 6971 + root * 101,
			seedAsInt,
		);
		let dir = Math.abs(rootHash) % 4;
		const rootLength = 3 + (Math.abs(rootHash) % 5);
		let rootX = worldX;
		let rootY = worldY - 1;
		let rootZ = worldZ;
		let unsupportedStreak = 0;

		for (let step = 0; step < rootLength; step++) {
			const turnHash = Squirrel3.get(rootHash + step * 17, seedAsInt);
			const mod = Math.abs(turnHash) % 5;
			if (mod === 0) dir = (dir + 1) % 4;
			else if (mod === 1) dir = (dir + 3) % 4;

			rootX += DIR_X[dir];
			rootZ += DIR_Z[dir];
			placeWood(rootX, rootY, rootZ);

			const hasSupportBelow = woodSet.has(packXYZ(rootX, rootY - 1, rootZ));
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

	// Trunk parameters
	const trunkBaseHash = Squirrel3.get(
		worldX * 92837111 + worldZ * 689287499,
		seedAsInt,
	);
	const arcHash = Squirrel3.get(worldX * 1237 + worldZ * 7919, seedAsInt);
	const bendAxisX = (Math.abs(arcHash) & 1) === 0;
	const bendSign = (Math.abs(arcHash >> 1) & 1) === 0 ? 1 : -1;
	const arcRadius = 6 + (Math.abs(trunkBaseHash >> 2) % 2);
	const twistDrift = 2 + (Math.abs(trunkBaseHash >> 4) % 2);
	const canopyBaseRadius = 4 + (Math.abs(trunkBaseHash >> 13) % 2);
	const canopyYOffset = (Math.abs(trunkBaseHash >> 15) % 3) - 1;
	const sideLobeCount = 3 + (Math.abs(trunkBaseHash >> 17) % 2);
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

	// Main canopy
	const canopyCenterX = finalTrunkX;
	const canopyCenterY = worldY + height - 1 + canopyYOffset;
	const canopyCenterZ = finalTrunkZ;

	for (let dy = -3; dy <= 3; dy++) {
		const layerY = canopyCenterY + dy;
		const radius = canopyBaseRadius - Math.floor(Math.abs(dy) / 2);
		const radiusSqP1 = radius * radius + 1;
		for (let x = -radius; x <= radius; x++) {
			const lx = canopyCenterX + x;
			const x2 = x * x;
			for (let z = -radius; z <= radius; z++) {
				if (x2 + z * z <= radiusSqP1) {
					const leafHash = Squirrel3.get(
						lx * 11939 + (canopyCenterZ + z) * 15485863 + layerY * 29791,
						seedAsInt,
					);
					if (Math.abs(leafHash) % 8 !== 0) {
						placeBlock(lx, layerY, canopyCenterZ + z, leavesId, false);
					}
				}
			}
		}
	}

	// Side lobes
	for (let lobe = 0; lobe < sideLobeCount; lobe++) {
		const lobeHash = Squirrel3.get(
			worldX * 9719 + worldZ * 19997 + lobe * 53,
			seedAsInt,
		);
		const lobeDir = Math.abs(lobeHash) % 8;
		const lobeDistance = 3 + (Math.abs(lobeHash >> 3) % 2);
		const centerX = canopyCenterX + DIAG_X[lobeDir] * lobeDistance;
		const centerZ = canopyCenterZ + DIAG_Z[lobeDir] * lobeDistance;
		const centerY = canopyCenterY - 1 + (Math.abs(lobeHash) % 2);

		for (let dy = -2; dy <= 2; dy++) {
			const radius = 3 - Math.floor(Math.abs(dy) / 2);
			const radiusSqP1 = radius * radius + 1;
			for (let x = -radius; x <= radius; x++) {
				const x2 = x * x;
				for (let z = -radius; z <= radius; z++) {
					if (x2 + z * z <= radiusSqP1) {
						placeBlock(centerX + x, centerY + dy, centerZ + z, leavesId, false);
					}
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// generateBaobab
// ---------------------------------------------------------------------------

export function generateBaobab(
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
	woodId: number,
	leavesId: number,
	baseHeight: number,
	heightVariance: number,
): void {
	woodSet.clear();

	const heightHash = Squirrel3.get(
		worldX * 374761393 + worldZ * 678446653,
		seedAsInt,
	);
	const height = baseHeight + (Math.abs(heightHash) % (heightVariance + 1));

	function placeWood(x: number, y: number, z: number): void {
		placeBlock(x, y, z, woodId, true);
		woodSet.add(packXYZ(x, y, z));
	}

	// Tap root
	const tapRootDepth = 3 + (Math.abs(heightHash) % 2);
	for (let d = 1; d <= tapRootDepth; d++) {
		placeWood(worldX, worldY - d, worldZ);
	}

	// ── Trunk ──────────────────────────────────────────────────────────────────
	// Baobab trunks are very wide at the base and taper sharply toward the crown.
	// We compute radius per layer using an inverse-curve so it's fat low and thin high.
	const baseTrunkRadius = 3; // widest point at ground level
	const topTrunkRadius = 1; // narrowest point just before the canopy

	for (let i = 0; i < height; i++) {
		const t = i / Math.max(1, height - 1); // 0 at base, 1 at top
		// Ease-out curve: wide base tapers quickly in the lower half
		const taper = 1 - t ** 0.5;
		const radius = Math.round(
			topTrunkRadius + (baseTrunkRadius - topTrunkRadius) * taper,
		);
		const radiusSq = radius * radius;
		const y = worldY + i;

		for (let x = -radius; x <= radius; x++) {
			for (let z = -radius; z <= radius; z++) {
				if (x * x + z * z <= radiusSq) {
					placeWood(worldX + x, y, worldZ + z);
				}
			}
		}
	}

	// ── Branch forks ───────────────────────────────────────────────────────────
	// At the crown, baobabs split into several thick stubby branches.
	const branchCount = 4 + (Math.abs(heightHash) % 3); // 4–6 branches
	const crownY = worldY + height;

	for (let b = 0; b < branchCount; b++) {
		const branchHash = Squirrel3.get(
			worldX * 15731 + worldZ * 789221 + b * 1013,
			seedAsInt,
		);
		const branchDir = Math.abs(branchHash) % 8;
		const branchLength = 2 + (Math.abs(branchHash >> 3) % 3); // 2–4 blocks
		const branchRise = 1 + (Math.abs(branchHash >> 6) % 2); // 1–2 blocks up

		let bx = worldX;
		let by = crownY;
		let bz = worldZ;

		for (let step = 0; step < branchLength; step++) {
			// Move outward each step, rise on first step only
			bx += DIAG_X[branchDir];
			bz += DIAG_Z[branchDir];
			if (step < branchRise) by++;

			placeWood(bx, by, bz);
			// Give the branch a little girth
			placeWood(bx, by - 1, bz);
		}

		// ── Leaf cluster at branch tip ──────────────────────────────────────────
		const leafRadius = 2 + (Math.abs(branchHash >> 9) % 2); // 2–3
		const leafRadiusSq = leafRadius * leafRadius + 1;

		for (let dy = -1; dy <= 2; dy++) {
			for (let x = -leafRadius; x <= leafRadius; x++) {
				const x2 = x * x;
				for (let z = -leafRadius; z <= leafRadius; z++) {
					if (x2 + z * z <= leafRadiusSq) {
						// Skip positions already occupied by wood
						if (!woodSet.has(packXYZ(bx + x, by + dy, bz + z))) {
							const leafHash = Squirrel3.get(
								(bx + x) * 11939 + (bz + z) * 15485863 + (by + dy) * 29791,
								seedAsInt,
							);
							// Sparse canopy — baobabs aren't leafy
							if (Math.abs(leafHash) % 5 !== 0) {
								placeBlock(bx + x, by + dy, bz + z, leavesId, false);
							}
						}
					}
				}
			}
		}
	}
}
