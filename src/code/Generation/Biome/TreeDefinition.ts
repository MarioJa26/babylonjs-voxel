import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";

// --- Shared constants hoisted to module scope ---
// V8: avoid re-allocating identical arrays on every function call
export const DIR_X = [1, 0, -1, 0] as const;
export const DIR_Z = [0, 1, 0, -1] as const;
export const DIAG_X = [1, 1, 0, -1, -1, -1, 0, 1] as const;
export const DIAG_Z = [0, 1, 1, 1, 0, -1, -1, -1] as const;

// ---------------------------------------------------------------------------
// Leaf scatter LUT
// ---------------------------------------------------------------------------
// V8: replaces per-voxel Squirrel3.get() calls in canopy loops with a single
// array read. 256 entries is enough entropy for visual scatter — the pattern
// difference is invisible to the player at canopy scale.
const LEAF_NOISE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
	LEAF_NOISE[i] = (Squirrel3.get(i, 0) >>> 0) & 0xff;
}

// ---------------------------------------------------------------------------
// Packed-int spatial set  (LOCAL offsets only — keeps keys SMI-safe)
// ---------------------------------------------------------------------------
// Offsets from tree base are small (dx/dz ≤ ±20, dy ≤ ±15), so 6 bits per
// axis is plenty (±32). Keys fit in a 31-bit SMI — no HeapNumber allocation.
//
// IMPORTANT: always call packLocal(x - worldX, y - worldY, z - worldZ).
// Do NOT pass raw world coordinates — they would silently alias.
const PACK_LOCAL_BITS = 6; // 2^6 = 64  →  range −32 … +31
const PACK_LOCAL_ORIGIN = 32; // bias so negatives stay positive
const PACK_LOCAL_MASK = (1 << PACK_LOCAL_BITS) - 1;

/** Pack local (dx, dy, dz) offsets into a single SMI-safe integer key. */
function packLocal(dx: number, dy: number, dz: number): number {
	return (
		((dx + PACK_LOCAL_ORIGIN) & PACK_LOCAL_MASK) |
		(((dy + PACK_LOCAL_ORIGIN) & PACK_LOCAL_MASK) << PACK_LOCAL_BITS) |
		(((dz + PACK_LOCAL_ORIGIN) & PACK_LOCAL_MASK) << (PACK_LOCAL_BITS * 2))
	);
}

// Module-level reusable Set — always cleared at the top of each generator.
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

	const heightHash =
		Squirrel3.get(worldX * 374761393 + worldZ * 678446653, seedAsInt) >>> 0;

	const height = baseHeight + (heightHash % (heightVariance + 1));

	function placeWood(x: number, y: number, z: number): void {
		placeBlock(x, y, z, woodId, true);
		woodSet.add(packLocal(x - worldX, y - worldY, z - worldZ));
	}

	// Tap root
	const tapRootDepth = 3 + (heightHash % 2);
	for (let d = 1; d <= tapRootDepth; d++) {
		placeWood(worldX, worldY - d, worldZ);
	}

	// Surface roots
	for (let root = 0; root < 5; root++) {
		const rootHash =
			Squirrel3.get(worldX * 31337 + worldZ * 6971 + root * 101, seedAsInt) >>>
			0;

		let dir = rootHash % 4;
		const rootLength = 2 + (rootHash % 5);

		let rootX = worldX;
		let rootY = worldY - 1;
		let rootZ = worldZ;
		let unsupportedStreak = 0;

		for (let step = 0; step < rootLength; step++) {
			const turnHash = Squirrel3.get(rootHash + step * 17, seedAsInt) >>> 0;
			const mod = turnHash % 5;

			if (mod === 0) dir = (dir + 1) % 4;
			else if (mod === 1) dir = (dir + 3) % 4;

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

	// Trunk
	const trunkBaseHash =
		Squirrel3.get(worldX * 92837111 + worldZ * 689287499, seedAsInt) >>> 0;

	const bendDirection = trunkBaseHash % 8;
	const bendDirX = DIAG_X[bendDirection];
	const bendDirZ = DIAG_Z[bendDirection];
	const maxBend = 3 + (trunkBaseHash % 2);
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

		const swayHash = Squirrel3.get(trunkBaseHash + i * 31, seedAsInt) >>> 0;
		const swayPhase = (swayHash % 360) * 0.0174533;
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

		// Bridge between layers
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

	// Main canopy
	const canopyCenterX = finalTrunkX;
	const canopyCenterY = worldY + height - 1;
	const canopyCenterZ = finalTrunkZ;

	for (let dy = -3; dy <= 3; dy++) {
		const layerY = canopyCenterY + dy;
		const radius = 5 - Math.floor(Math.abs(dy) / 2);
		const radiusSqP1 = radius * radius + 1;
		for (let x = -radius; x <= radius; x++) {
			const lx = canopyCenterX + x;
			const x2 = x * x;
			for (let z = -radius; z <= radius; z++) {
				if (x2 + z * z <= radiusSqP1) {
					// LUT replaces per-voxel Squirrel3.get — invisible quality diff at
					// canopy scale, avoids hash cost for every leaf candidate
					if (
						LEAF_NOISE[
							(lx * 3 + (canopyCenterZ + z) * 7 + layerY * 13) & 0xff
						] > 32
					) {
						placeBlock(lx, layerY, canopyCenterZ + z, leavesId, false);
					}
				}
			}
		}
	}

	// Side lobes
	for (let lobe = 0; lobe < 3; lobe++) {
		const lobeHash =
			Squirrel3.get(worldX * 9719 + worldZ * 19997 + lobe * 53, seedAsInt) >>>
			0;

		const lobeDir = lobeHash % 8;
		const centerX = canopyCenterX + DIAG_X[lobeDir] * 3;
		const centerZ = canopyCenterZ + DIAG_Z[lobeDir] * 3;
		const centerY = canopyCenterY - 1 + (lobeHash % 2);

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

	const heightHash =
		Squirrel3.get(worldX * 374761393 + worldZ * 678446653, seedAsInt) >>> 0;
	const height = baseHeight + (heightHash % (heightVariance + 1));

	function placeWood(x: number, y: number, z: number): void {
		placeBlock(x, y, z, woodId, true);
		woodSet.add(packLocal(x - worldX, y - worldY, z - worldZ));
	}

	// Tap root
	const tapRootDepth = 5 + (heightHash % 2);
	for (let d = 1; d <= tapRootDepth; d++) {
		placeWood(worldX, worldY - d, worldZ);
	}

	// Surface roots
	for (let root = 0; root < 5; root++) {
		const rootHash =
			Squirrel3.get(worldX * 31337 + worldZ * 6971 + root * 101, seedAsInt) >>>
			0;
		let dir = rootHash % 4;
		const rootLength = 3 + (rootHash % 5);
		let rootX = worldX;
		let rootY = worldY - 1;
		let rootZ = worldZ;
		let unsupportedStreak = 0;

		for (let step = 0; step < rootLength; step++) {
			const turnHash = Squirrel3.get(rootHash + step * 17, seedAsInt) >>> 0;
			const mod = turnHash % 5;
			if (mod === 0) dir = (dir + 1) % 4;
			else if (mod === 1) dir = (dir + 3) % 4;

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

	// Trunk parameters
	const trunkBaseHash =
		Squirrel3.get(worldX * 92837111 + worldZ * 689287499, seedAsInt) >>> 0;
	const arcHash = Squirrel3.get(worldX * 1237 + worldZ * 7919, seedAsInt) >>> 0;
	const bendAxisX = (arcHash & 1) === 0;
	const bendSign = ((arcHash >> 1) & 1) === 0 ? 1 : -1;
	const arcRadius = 6 + ((trunkBaseHash >> 2) % 2);
	const twistDrift = 2 + ((trunkBaseHash >> 4) % 2);
	const canopyBaseRadius = 4 + ((trunkBaseHash >> 13) % 2);
	const canopyYOffset = ((trunkBaseHash >> 15) % 3) - 1;
	const sideLobeCount = 3 + ((trunkBaseHash >> 17) % 2);
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
					if (
						LEAF_NOISE[
							(lx * 3 + (canopyCenterZ + z) * 7 + layerY * 13) & 0xff
						] > 32
					) {
						placeBlock(lx, layerY, canopyCenterZ + z, leavesId, false);
					}
				}
			}
		}
	}

	// Side lobes
	for (let lobe = 0; lobe < sideLobeCount; lobe++) {
		const lobeHash =
			Squirrel3.get(worldX * 9719 + worldZ * 19997 + lobe * 53, seedAsInt) >>>
			0;
		const lobeDir = lobeHash % 8;
		const lobeDistance = 3 + ((lobeHash >> 3) % 2);
		const centerX = canopyCenterX + DIAG_X[lobeDir] * lobeDistance;
		const centerZ = canopyCenterZ + DIAG_Z[lobeDir] * lobeDistance;
		const centerY = canopyCenterY - 1 + (lobeHash % 2);

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

	const heightHash =
		Squirrel3.get(worldX * 374761393 + worldZ * 678446653, seedAsInt) >>> 0;
	const height = baseHeight + (heightHash % (heightVariance + 1));

	function placeWood(x: number, y: number, z: number): void {
		placeBlock(x, y, z, woodId, true);
		// woodSet not needed for baobab: placeBlock(overwrite=false) already refuses
		// to overwrite wood with leaves, so the woodSet.has() guard in leaf clusters
		// was redundant. woodSet.clear() is still called above for safety in case
		// this function is ever extended to use it (e.g. for root gravity).
	}

	// Tap root
	const tapRootDepth = 3 + (heightHash % 2);
	for (let d = 1; d <= tapRootDepth; d++) {
		placeWood(worldX, worldY - d, worldZ);
	}

	// ── Trunk ──────────────────────────────────────────────────────────────────
	const baseTrunkRadius = 3;
	const topTrunkRadius = 1;

	for (let i = 0; i < height; i++) {
		const t = i / Math.max(1, height - 1);
		const taper = 1 - t ** 0.5;
		const radius = Math.round(
			topTrunkRadius + (baseTrunkRadius - topTrunkRadius) * taper,
		);
		const radiusSq = radius * radius;
		const y = worldY + i;

		for (let x = -radius; x <= radius; x++) {
			const x2 = x * x;
			for (let z = -radius; z <= radius; z++) {
				if (x2 + z * z <= radiusSq) {
					placeWood(worldX + x, y, worldZ + z);
				}
			}
		}
	}

	// ── Branch forks ───────────────────────────────────────────────────────────
	const branchCount = 4 + (heightHash % 3);
	const crownY = worldY + height;

	for (let b = 0; b < branchCount; b++) {
		const branchHash =
			Squirrel3.get(worldX * 15731 + worldZ * 789221 + b * 1013, seedAsInt) >>>
			0;
		const branchDir = branchHash % 8;
		const branchLength = 2 + ((branchHash >> 3) % 3);
		const branchRise = 1 + ((branchHash >> 6) % 2);

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

		// ── Leaf cluster at branch tip ──────────────────────────────────────────
		const leafRadius = 2 + ((branchHash >> 9) % 2);
		const leafRadiusSq = leafRadius * leafRadius + 1;

		for (let dy = -1; dy <= 2; dy++) {
			const ly = by + dy;
			for (let x = -leafRadius; x <= leafRadius; x++) {
				const x2 = x * x;
				const lx = bx + x;
				for (let z = -leafRadius; z <= leafRadius; z++) {
					if (x2 + z * z <= leafRadiusSq) {
						// LUT scatter: ~7/8 density (threshold 32/256 ≈ 12.5% skip rate)
						if (LEAF_NOISE[(lx * 3 + (bz + z) * 7 + ly * 13) & 0xff] > 32) {
							placeBlock(lx, ly, bz + z, leavesId, false);
						}
					}
				}
			}
		}
	}
}
