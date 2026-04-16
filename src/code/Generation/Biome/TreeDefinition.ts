import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import type { TreeDefinition } from "./BiomeTypes";

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

		// Place trunk
		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, this.woodId, true); // Log
		}

		// A more authentic Minecraft oak tree canopy
		const leafYStart = worldY + height - 3;

		// Main canopy layers (two 5x5 layers with corners removed)
		let radius = 2;
		for (let y = leafYStart; y < leafYStart + 4; y++) {
			if (y < leafYStart + 2) radius = 2;
			else radius = 1;
			for (let x = -radius; x <= radius; x++) {
				for (let z = -radius; z <= radius; z++) {
					placeBlock(worldX + x, y, worldZ + z, this.leavesId, false); // Leaves
				}
			}
		}
	},
};

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
	const heightHash = Squirrel3.get(
		worldX * 374761393 + worldZ * 678446653,
		seedAsInt,
	);
	const height = baseHeight + (Math.abs(heightHash) % (heightVariance + 1));
	const placedWood = new Set<string>();
	const toKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;
	const placeWood = (x: number, y: number, z: number): void => {
		placeBlock(x, y, z, woodId, true);
		placedWood.add(toKey(x, y, z));
	};
	// Anchor the tree with roots below ground.
	const tapRootDepth = 3 + (Math.abs(heightHash) % 2);
	for (let d = 1; d <= tapRootDepth; d++) {
		placeWood(worldX, worldY - d, worldZ);
	}

	for (let root = 0; root < 5; root++) {
		const rootHash = Squirrel3.get(
			worldX * 31337 + worldZ * 6971 + root * 101,
			seedAsInt,
		);
		let dir = Math.abs(rootHash) % 4;
		const dirX = [1, 0, -1, 0];
		const dirZ = [0, 1, 0, -1];
		const rootLength = 2 + (Math.abs(rootHash) % 5);
		let rootX = worldX;
		let rootY = worldY - 1;
		let rootZ = worldZ;
		let unsupportedStreak = 0;

		for (let step = 0; step < rootLength; step++) {
			const turnHash = Squirrel3.get(rootHash + step * 17, seedAsInt);
			if (Math.abs(turnHash) % 5 === 0) {
				dir = (dir + 1) % 4;
			} else if (Math.abs(turnHash) % 5 === 1) {
				dir = (dir + 3) % 4;
			}

			// Horizontal face-connected step.
			rootX += dirX[dir];
			rootZ += dirZ[dir];
			placeWood(rootX, rootY, rootZ);

			const hasSupportBelow = placedWood.has(toKey(rootX, rootY - 1, rootZ));
			if (hasSupportBelow) {
				unsupportedStreak = 0;
			} else {
				unsupportedStreak++;
			}

			// Droop down more aggressively when unsupported.
			const shouldDroop =
				!hasSupportBelow || (unsupportedStreak > 0 && step % 2 === 0);
			if (shouldDroop) {
				rootY--;
				placeWood(rootX, rootY, rootZ);
				if (unsupportedStreak >= 2 && step % 2 === 1) {
					rootY--;
					placeWood(rootX, rootY, rootZ);
				}
			}
		}
	}

	let trunkOffsetX = 0;
	let trunkOffsetZ = 0;
	const trunkBaseHash = Squirrel3.get(
		worldX * 92837111 + worldZ * 689287499,
		seedAsInt,
	);
	const bendDirection = Math.abs(trunkBaseHash) % 8;
	const dirX = [1, 1, 0, -1, -1, -1, 0, 1][bendDirection];
	const dirZ = [0, 1, 1, 1, 0, -1, -1, -1][bendDirection];
	const maxBend = 3 + (Math.abs(trunkBaseHash) % 2);
	let trunkCenterX = worldX;
	let trunkCenterZ = worldZ;
	let finalTrunkX = worldX;
	let finalTrunkZ = worldZ;

	// Build a trunk with a deliberate crescent-like bend.
	for (let i = 0; i < height; i++) {
		const t = i / Math.max(1, height - 1);
		// Arc profile: little bend at the base, strongest through the mid/upper trunk.
		const arc = Math.sin(t * Math.PI * 0.85);
		const curveAmount = Math.round(arc * maxBend);

		trunkOffsetX = dirX * curveAmount;
		trunkOffsetZ = dirZ * curveAmount;

		const swayHash = Squirrel3.get(trunkBaseHash + i * 31, seedAsInt);
		const swayPhase = (Math.abs(swayHash) % 360) * 0.0174533;
		const lateralSway = Math.sin(t * Math.PI + swayPhase) * 0.5;
		const targetX = worldX + trunkOffsetX + dirZ * lateralSway;
		const targetZ = worldZ + trunkOffsetZ - dirX * lateralSway;

		// Keep centerline continuous so each trunk layer remains well-supported.
		trunkCenterX += Math.max(
			-1,
			Math.min(1, Math.round(targetX) - trunkCenterX),
		);
		trunkCenterZ += Math.max(
			-1,
			Math.min(1, Math.round(targetZ) - trunkCenterZ),
		);

		const trunkX = trunkCenterX;
		const trunkZ = trunkCenterZ;
		const y = worldY + i;
		const trunkRadius = i < height - 3 ? 1 + 3 * (i / height) : 0;

		for (let x = -trunkRadius; x <= trunkRadius; x++) {
			for (let z = -trunkRadius; z <= trunkRadius; z++) {
				if (x * x + z * z <= trunkRadius * trunkRadius) {
					placeBlock(trunkX + x, y, trunkZ + z, woodId, true);
				}
			}
		}
		finalTrunkX = trunkX;
		finalTrunkZ = trunkZ;
	}

	const canopyCenterX = finalTrunkX;
	const canopyCenterY = worldY + height - 1;
	const canopyCenterZ = finalTrunkZ;

	// Main large canopy.
	for (let dy = -3; dy <= 3; dy++) {
		const layerY = canopyCenterY + dy;
		const radius = 5 - Math.floor(Math.abs(dy) / 2);
		for (let x = -radius; x <= radius; x++) {
			for (let z = -radius; z <= radius; z++) {
				if (x * x + z * z <= radius * radius + 1) {
					const leafHash = Squirrel3.get(
						(canopyCenterX + x) * 11939 +
							(canopyCenterZ + z) * 15485863 +
							layerY * 29791,
						seedAsInt,
					);
					if (Math.abs(leafHash) % 8 !== 0) {
						placeBlock(
							canopyCenterX + x,
							layerY,
							canopyCenterZ + z,
							leavesId,
							false,
						);
					}
				}
			}
		}
	}

	// Add side canopy lobes for a wider crown.
	for (let lobe = 0; lobe < 3; lobe++) {
		const lobeHash = Squirrel3.get(
			worldX * 9719 + worldZ * 19997 + lobe * 53,
			seedAsInt,
		);
		const lobeDir = Math.abs(lobeHash) % 8;
		const dirX = [1, 1, 0, -1, -1, -1, 0, 1][lobeDir];
		const dirZ = [0, 1, 1, 1, 0, -1, -1, -1][lobeDir];
		const centerX = canopyCenterX + dirX * 3;
		const centerZ = canopyCenterZ + dirZ * 3;
		const centerY = canopyCenterY - 1 + (Math.abs(lobeHash) % 2);

		for (let dy = -2; dy <= 2; dy++) {
			const radius = 3 - Math.floor(Math.abs(dy) / 2);
			for (let x = -radius; x <= radius; x++) {
				for (let z = -radius; z <= radius; z++) {
					if (x * x + z * z <= radius * radius + 1) {
						placeBlock(centerX + x, centerY + dy, centerZ + z, leavesId, false);
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
	const heightHash = Squirrel3.get(
		worldX * 374761393 + worldZ * 678446653,
		seedAsInt,
	);
	const height = baseHeight + (Math.abs(heightHash) % (heightVariance + 1));
	const placedWood = new Set<string>();
	const toKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;
	const placeWood = (x: number, y: number, z: number): void => {
		placeBlock(x, y, z, woodId, true);
		placedWood.add(toKey(x, y, z));
	};

	// Re-add roots to anchor the larger oak.
	const tapRootDepth = 5 + (Math.abs(heightHash) % 2);
	for (let d = 1; d <= tapRootDepth; d++) {
		placeWood(worldX, worldY - d, worldZ);
	}

	for (let root = 0; root < 5; root++) {
		const rootHash = Squirrel3.get(
			worldX * 31337 + worldZ * 6971 + root * 101,
			seedAsInt,
		);
		let dir = Math.abs(rootHash) % 4;
		const rootDirX = [1, 0, -1, 0];
		const rootDirZ = [0, 1, 0, -1];
		const rootLength = 3 + (Math.abs(rootHash) % 5);
		let rootX = worldX;
		let rootY = worldY - 1;
		let rootZ = worldZ;
		let unsupportedStreak = 0;

		for (let step = 0; step < rootLength; step++) {
			const turnHash = Squirrel3.get(rootHash + step * 17, seedAsInt);
			if (Math.abs(turnHash) % 5 === 0) {
				dir = (dir + 1) % 4;
			} else if (Math.abs(turnHash) % 5 === 1) {
				dir = (dir + 3) % 4;
			}

			rootX += rootDirX[dir];
			rootZ += rootDirZ[dir];
			placeWood(rootX, rootY, rootZ);

			const hasSupportBelow = placedWood.has(toKey(rootX, rootY - 1, rootZ));
			if (hasSupportBelow) {
				unsupportedStreak = 0;
			} else {
				unsupportedStreak++;
			}

			const shouldDroop =
				!hasSupportBelow || (unsupportedStreak > 0 && step % 2 === 0);
			if (shouldDroop) {
				rootY--;
				placeWood(rootX, rootY, rootZ);
				if (unsupportedStreak >= 2 && step % 2 === 1) {
					rootY--;
					placeWood(rootX, rootY, rootZ);
				}
			}
		}
	}

	const trunkBaseHash = Squirrel3.get(
		worldX * 92837111 + worldZ * 689287499,
		seedAsInt,
	);
	const arcHash = Squirrel3.get(worldX * 1237 + worldZ * 7919, seedAsInt);
	const bendAxisX = Math.abs(arcHash) % 2 === 0;
	const bendSign = Math.abs(arcHash >> 1) % 2 === 0 ? 1 : -1;
	const arcRadius = 6 + (Math.abs(trunkBaseHash >> 2) % 2);
	const twistDrift = 2 + (Math.abs(trunkBaseHash >> 4) % 2);
	const canopyBaseRadius = 4 + (Math.abs(trunkBaseHash >> 13) % 2);
	const canopyYOffset = (Math.abs(trunkBaseHash >> 15) % 3) - 1;
	const sideLobeCount = 3 + (Math.abs(trunkBaseHash >> 17) % 2);
	const baseFlareLayers = Math.max(4, Math.floor(height * 0.28));
	const deepBaseLayers = Math.max(2, Math.floor(height * 0.14));
	let finalTrunkX = worldX;
	let finalTrunkZ = worldZ;

	// Thick crescent-like trunk with slight lateral drift.
	for (let i = 0; i < height; i++) {
		const t = i / Math.max(1, height - 1);
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
			// Thicken lower trunk into a wider, grounded base.
			placeWood(trunkX + 2, y, trunkZ);
			placeWood(trunkX - 2, y, trunkZ);
			placeWood(trunkX, y, trunkZ + 2);
			placeWood(trunkX, y, trunkZ - 2);

			// Add corner mass only near the very bottom to avoid a full thick cylinder.
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
		const radius = canopyBaseRadius - Math.floor(Math.abs(dy) / 2);
		for (let x = -radius; x <= radius; x++) {
			for (let z = -radius; z <= radius; z++) {
				if (x * x + z * z <= radius * radius + 1) {
					const leafHash = Squirrel3.get(
						(canopyCenterX + x) * 11939 +
							(canopyCenterZ + z) * 15485863 +
							layerY * 29791,
						seedAsInt,
					);
					if (Math.abs(leafHash) % 8 !== 0) {
						placeBlock(
							canopyCenterX + x,
							layerY,
							canopyCenterZ + z,
							leavesId,
							false,
						);
					}
				}
			}
		}
	}

	for (let lobe = 0; lobe < sideLobeCount; lobe++) {
		const lobeHash = Squirrel3.get(
			worldX * 9719 + worldZ * 19997 + lobe * 53,
			seedAsInt,
		);
		const lobeDir = Math.abs(lobeHash) % 8;
		const lobeDirX = [1, 1, 0, -1, -1, -1, 0, 1][lobeDir];
		const lobeDirZ = [0, 1, 1, 1, 0, -1, -1, -1][lobeDir];
		const lobeDistance = 3 + (Math.abs(lobeHash >> 3) % 2);
		const centerX = canopyCenterX + lobeDirX * lobeDistance;
		const centerZ = canopyCenterZ + lobeDirZ * lobeDistance;
		const centerY = canopyCenterY - 1 + (Math.abs(lobeHash) % 2);

		for (let dy = -2; dy <= 2; dy++) {
			const radius = 3 - Math.floor(Math.abs(dy) / 2);
			for (let x = -radius; x <= radius; x++) {
				for (let z = -radius; z <= radius; z++) {
					if (x * x + z * z <= radius * radius + 1) {
						placeBlock(centerX + x, centerY + dy, centerZ + z, leavesId, false);
					}
				}
			}
		}
	}
}

export const SLINKY_TREE: TreeDefinition = {
	woodId: 28,
	leavesId: 2,
	baseHeight: 10,
	heightVariance: 10,
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

		// Place trunk
		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, this.woodId, true); // Log
		}

		// A more authentic Minecraft oak tree canopy
		const leafYStart = worldY + height - 3;

		// Main canopy layers (two 5x5 layers with corners removed)
		let radius = 2;
		for (let y = leafYStart; y < leafYStart + 4; y++) {
			if (y < leafYStart + 2) radius = 2;
			else radius = 1;
			for (let x = -radius; x <= radius; x++) {
				for (let z = -radius; z <= radius; z++) {
					placeBlock(worldX + x, y, worldZ + z, this.leavesId, false); // Leaves
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

		// Place trunk
		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, this.woodId, true);
		}

		// Simple canopy for now, similar to oak but larger

		const canopyRadius = 4; // Larger radius

		for (let conopie = 1; conopie <= 2; conopie++) {
			const leafYStart = worldY + height - 5 * conopie - (conopie - 1) * 3;
			for (let y = leafYStart; y < leafYStart + 8; y++) {
				// Taller canopy
				const currentRadius = canopyRadius - Math.floor((y - leafYStart) / 2);
				for (let x = -currentRadius; x <= currentRadius; x++) {
					for (let z = -currentRadius; z <= currentRadius; z++) {
						if (x * x + z * z <= currentRadius * currentRadius + 1) {
							// More spherical
							placeBlock(worldX + x, y, worldZ + z, this.leavesId, false);
						}
					}
				}
			}
		}
	},
};

export const CACTUS: TreeDefinition = {
	woodId: 34,
	leavesId: 0, // No leaves on a cactus
	baseHeight: 3,
	heightVariance: 2,
	generate(
		worldX: number,
		worldY: number,
		worldZ: number,
		placeBlock: (x: number, y: number, z: number, blockId: number) => void,
		seedAsInt: number,
	): void {
		const heightHash = Squirrel3.get(
			worldX * 374761393 + worldZ * 678446653,
			seedAsInt,
		);
		const height =
			this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));

		// Place cactus blocks (woodId is used for cactus block)
		for (let i = 0; i < height; i++) {
			placeBlock(worldX, worldY + i, worldZ, this.woodId);
		}
		// No leaves for cactus
	},
};
