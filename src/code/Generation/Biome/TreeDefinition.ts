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
