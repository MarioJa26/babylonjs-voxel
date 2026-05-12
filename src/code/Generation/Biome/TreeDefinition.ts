import { BlockType } from "@/code/World/BlockType";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import type { TreeDefinition } from "./BiomeTypes";

// --- Shared constants hoisted to module scope ---
// V8: avoid re-allocating identical arrays on every function call
const DIR_X = [1, 0, -1, 0] as const;
const DIR_Z = [0, 1, 0, -1] as const;
const DIAG_X = [1, 1, 0, -1, -1, -1, 0, 1] as const;
const DIAG_Z = [0, 1, 1, 1, 0, -1, -1, -1] as const;

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
// Tree definitions
// ---------------------------------------------------------------------------

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

export const CACTUS: TreeDefinition = {
	woodId: 34,
	leavesId: 0,
	baseHeight: 3,
	heightVariance: 2,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = Squirrel3.get(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));
		const woodId = this.woodId;
		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, woodId);
		}
	},
};

export const SAVANNAH_TREE: TreeDefinition = {
	woodId: 31, // Acacia wood
	leavesId: 43, // Acacia leaves
	baseHeight: 7,
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
		const heightHash = Squirrel3.get(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));
		const woodId = this.woodId;
		const leavesId = this.leavesId;

		// Tall trunk
		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, woodId, true);
		}

		// Flat umbrella-shaped canopy at the top
		const canopyY = worldY + height - 1;
		const canopyRadius = 3;

		// Flat layer of leaves (the umbrella top)
		for (let x = -canopyRadius; x <= canopyRadius; x++) {
			for (let z = -canopyRadius; z <= canopyRadius; z++) {
				if (Math.abs(x) + Math.abs(z) <= canopyRadius + 1) {
					placeBlock(worldX + x, canopyY, worldZ + z, leavesId, false);
				}
			}
		}

		// Slightly smaller layer above
		const upperY = canopyY + 1;
		for (let x = -2; x <= 2; x++) {
			for (let z = -2; z <= 2; z++) {
				if (Math.abs(x) + Math.abs(z) <= 3) {
					placeBlock(worldX + x, upperY, worldZ + z, leavesId, false);
				}
			}
		}

		// Small top
		placeBlock(worldX, canopyY + 2, worldZ, leavesId, false);
	},
};
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

// ---------------------------------------------------------------------------
// BAOBAB_TREE definition
// ---------------------------------------------------------------------------

export const BAOBAB_TREE: TreeDefinition = {
	woodId: 31, // acacia wood — replace with a baobab-specific block when available
	leavesId: 43, // acacia leaves — replace with baobab leaves when available
	baseHeight: 8,
	heightVariance: 3,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		generateBaobab(
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
}; // ---------------------------------------------------------------------------
// DEAD_TREE — Snowy Plains, Scorched Savannah, Peat Bog
// Leafless bare trunk with a few broken branch stubs
// ---------------------------------------------------------------------------

export const DEAD_TREE: TreeDefinition = {
	woodId: 28, // oak wood — replace with dead/grey wood block
	leavesId: 0, // no leaves
	baseHeight: 5,
	heightVariance: 3,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = Squirrel3.get(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));
		const woodId = this.woodId;

		// Trunk — slight lean using DIAG offsets
		const leanDir = Math.abs(heightHash) % 8;
		const leanStart = Math.floor(height * 0.6); // lean begins 60% up
		let tx = worldX;
		let tz = worldZ;

		for (let i = 0; i < height; i++) {
			if (i === leanStart) {
				tx += DIAG_X[leanDir];
				tz += DIAG_Z[leanDir];
			}
			placeBlock(tx, worldY + i, tz, woodId, true);
		}

		// Broken branch stubs — 2–4 stubs at random heights
		const stubCount = 2 + (Math.abs(heightHash >> 4) % 3);
		for (let s = 0; s < stubCount; s++) {
			const stubHash = Squirrel3.get(
				worldX * 9719 + worldZ * 19997 + s * 53,
				seedAsInt,
			);
			const stubY = worldY + 2 + (Math.abs(stubHash) % (height - 2));
			const stubDir = Math.abs(stubHash >> 3) % 8;
			const stubLen = 1 + (Math.abs(stubHash >> 6) % 2); // 1–2 blocks

			let sx = tx;
			let sz = tz;
			for (let step = 0; step < stubLen; step++) {
				sx += DIAG_X[stubDir];
				sz += DIAG_Z[stubDir];
				placeBlock(sx, stubY, sz, woodId, true);
			}
		}
	},
};

// ---------------------------------------------------------------------------
// ICE_SPIKE_COLUMN — Ice Spikes biome
// Tall tapered column of packed ice, wider at base
// ---------------------------------------------------------------------------

export const ICE_SPIKE_COLUMN: TreeDefinition = {
	woodId: 101, // packed ice
	leavesId: 0,
	baseHeight: 10,
	heightVariance: 15,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = Squirrel3.get(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));
		const iceId = this.woodId;

		// Wide base tapering to a single point at the tip
		for (let i = 0; i < height; i++) {
			const t = i / Math.max(1, height - 1); // 0 = base, 1 = tip
			const radius = Math.round((1 - t) * 2); // radius 2 → 0
			const radiusSq = radius * radius;
			const y = worldY + i;

			for (let x = -radius; x <= radius; x++) {
				for (let z = -radius; z <= radius; z++) {
					if (x * x + z * z <= radiusSq) {
						placeBlock(worldX + x, y, worldZ + z, iceId, true);
					}
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
	leavesId: BlockType.FactoryWall, // birch leaves
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

// ---------------------------------------------------------------------------
// GIANT_MUSHROOM — Mushroom Fields
// Wide flat cap on a tall stem, cap underside left open
// ---------------------------------------------------------------------------

export const GIANT_MUSHROOM: TreeDefinition = {
	woodId: 117, // mushroom stem block
	leavesId: 118, // mushroom cap block
	baseHeight: 6,
	heightVariance: 4,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = Squirrel3.get(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));
		const stemId = this.woodId;
		const capId = this.leavesId;

		// Stem — single block wide
		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, stemId, true);
		}

		// Cap — flat disc with a slight dome, 1–2 layers thick
		const capY = worldY + height;
		const capRadius = 3 + (Math.abs(heightHash >> 4) % 2); // 3–4
		const capRadiusSq = capRadius * capRadius;

		// Bottom flat layer
		for (let x = -capRadius; x <= capRadius; x++) {
			for (let z = -capRadius; z <= capRadius; z++) {
				if (x * x + z * z <= capRadiusSq) {
					placeBlock(worldX + x, capY, worldZ + z, capId, true);
				}
			}
		}

		// Dome top layer — slightly smaller radius
		const domeRadius = capRadius - 1;
		const domeRadiusSq = domeRadius * domeRadius;
		for (let x = -domeRadius; x <= domeRadius; x++) {
			for (let z = -domeRadius; z <= domeRadius; z++) {
				if (x * x + z * z <= domeRadiusSq) {
					placeBlock(worldX + x, capY + 1, worldZ + z, capId, true);
				}
			}
		}

		// Tiny tip
		placeBlock(worldX, capY + 2, worldZ, capId, true);
	},
};

// ---------------------------------------------------------------------------
// CRYSTAL_SPIRE — Crystal Caves
// Tapered hexagonal-ish spire of crystal, clusters of 3 at varying heights
// ---------------------------------------------------------------------------

export const CRYSTAL_SPIRE: TreeDefinition = {
	woodId: 111, // crystal stone
	leavesId: 119, // glowing crystal tip block — replace when available
	baseHeight: 5,
	heightVariance: 8,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = Squirrel3.get(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);

		// Spawn a cluster of 2–3 spires offset from the origin
		const spireCount = 2 + (Math.abs(heightHash) % 2);
		for (let s = 0; s < spireCount; s++) {
			const spireHash = Squirrel3.get(
				worldX * 15731 + worldZ * 789221 + s * 1013,
				seedAsInt,
			);
			const spireHeight =
				this.baseHeight + (Math.abs(spireHash) % (this.heightVariance + 1));
			const offsetX = s === 0 ? 0 : (Math.abs(spireHash >> 2) % 3) - 1; // -1,0,1
			const offsetZ = s === 0 ? 0 : (Math.abs(spireHash >> 4) % 3) - 1;
			const cx = worldX + offsetX;
			const cz = worldZ + offsetZ;
			const crystalId = this.woodId;
			const tipId = this.leavesId;

			for (let i = 0; i < spireHeight; i++) {
				const t = i / Math.max(1, spireHeight - 1);
				// Sharp taper — only wide at the very base
				const radius = t < 0.3 ? 1 : 0;
				const y = worldY + i;

				if (radius === 0) {
					placeBlock(cx, y, cz, crystalId, true);
				} else {
					for (let x = -radius; x <= radius; x++) {
						for (let z = -radius; z <= radius; z++) {
							placeBlock(cx + x, y, cz + z, crystalId, true);
						}
					}
				}
			}

			// Glowing tip — top 2 blocks use the tip block
			placeBlock(cx, worldY + spireHeight - 1, cz, tipId, true);
			placeBlock(cx, worldY + spireHeight, cz, tipId, true);
		}
	},
};

// ---------------------------------------------------------------------------
// PETRIFIED_TREE — Petrified Forest
// Stone trunk, no leaves, broken top, looks ancient and fossilised
// ---------------------------------------------------------------------------

export const PETRIFIED_TREE: TreeDefinition = {
	woodId: 1, // stone — the trunk is fully petrified
	leavesId: 0, // no leaves
	baseHeight: 6,
	heightVariance: 4,
	generate(worldX, worldY, worldZ, placeBlock, seedAsInt): void {
		const heightHash = Squirrel3.get(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));
		const stoneId = this.woodId;

		// Wide stone trunk — 2 blocks wide at base, tapers to 1
		for (let i = 0; i < height; i++) {
			const t = i / Math.max(1, height - 1);
			const radius = t < 0.4 ? 1 : 0; // wide base, slim top
			const y = worldY + i;

			if (radius === 0) {
				placeBlock(worldX, y, worldZ, stoneId, true);
			} else {
				for (let x = -radius; x <= radius; x++) {
					for (let z = -radius; z <= radius; z++) {
						placeBlock(worldX + x, y, worldZ + z, stoneId, true);
					}
				}
			}
		}

		// Broken crown — a few stone stub branches, no symmetry
		const stubCount = 2 + (Math.abs(heightHash >> 4) % 3);
		for (let s = 0; s < stubCount; s++) {
			const stubHash = Squirrel3.get(
				worldX * 9719 + worldZ * 19997 + s * 53,
				seedAsInt,
			);
			const stubDir = Math.abs(stubHash) % 8;
			const stubLen = 1 + (Math.abs(stubHash >> 3) % 3); // 1–3 blocks
			const stubY = worldY + height - 1;

			let sx = worldX;
			let sz = worldZ;
			for (let step = 0; step < stubLen; step++) {
				sx += DIAG_X[stubDir];
				sz += DIAG_Z[stubDir];
				placeBlock(sx, stubY, sz, stoneId, true);
				// Droop slightly
				if (step === stubLen - 1) {
					placeBlock(sx, stubY - 1, sz, stoneId, true);
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
