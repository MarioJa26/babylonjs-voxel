import { getVirtualBlockId } from "@/code/World/Texture/BlockTextures";
import { BlockType } from "@/code/World/Texture/BlockType";

/**
 * Pure, engine-free TNT blast helpers.
 * Safe to unit-test without DOM, GPU, or scene dependencies.
 */

/** Default blast radius in blocks. */
export const TNT_BLAST_RADIUS = 4;

/** Blast radius for half-size TNT variants. */
export const TNT_HALF_BLAST_RADIUS = TNT_BLAST_RADIUS / 2;

/** Damage at the explosion center. */
export const TNT_MAX_DAMAGE = 40;

/** Maximum TNT blocks ignited as chains by a single blast. */
export const TNT_MAX_CHAIN = 20;

/**
 * Blocks that explosions never destroy.
 * Additional blast-resistant blocks can be added here.
 */
export const BLAST_RESISTANT_BLOCKS: ReadonlySet<number> = new Set([
	BlockType.Obsidian,
]);

export type ExplosionTarget = {
	x: number;
	y: number;
	z: number;
	blockId: number;
};

export type ExplosionTargets = {
	/** Solid blocks to vaporize. */
	destroy: ExplosionTarget[];

	/** Live TNT blocks to ignite instead of deleting. */
	chain: ExplosionTarget[];
};

/*
 * Resolve virtual TNT IDs once at module initialization rather than calling
 * getVirtualBlockId() for every block visited by every explosion.
 */
const TNT_SLAB_BLOCK_ID = getVirtualBlockId(BlockType.Tnt, "slab");

const TNT_HALF_WALL_BLOCK_ID = getVirtualBlockId(BlockType.Tnt, "half_wall");

/**
 * Blast radius for an ignitable block, or null when it cannot be ignited.
 *
 * Full TNT receives the standard range. Slab and half-wall TNT variants
 * receive half range. Other shapes are not ignitable.
 */
export function tntBlastRadius(blockId: number): number | null {
	if (blockId === BlockType.Tnt) {
		return TNT_BLAST_RADIUS;
	}

	if (blockId === TNT_SLAB_BLOCK_ID || blockId === TNT_HALF_WALL_BLOCK_ID) {
		return TNT_HALF_BLAST_RADIUS;
	}

	return null;
}

/**
 * Linear blast falloff:
 *
 * - 1 at or behind the center
 * - 0 at or beyond the radius
 */
export function explosionFalloff(distance: number, radius: number): number {
	if (radius <= 0 || distance >= radius) {
		return 0;
	}

	if (distance <= 0) {
		return 1;
	}

	return 1 - distance / radius;
}

/** Falloff-scaled damage, rounded down. */
export function explosionDamage(
	distance: number,
	radius: number,
	maxDamage: number = TNT_MAX_DAMAGE,
): number {
	if (radius <= 0 || distance >= radius) {
		return 0;
	}

	if (distance <= 0) {
		return Math.floor(maxDamage);
	}

	return Math.floor(maxDamage - distance * (maxDamage / radius));
}

/**
 * Calculates per-mob blast damage while preserving input order.
 *
 * Mobs at or beyond the blast radius receive zero damage.
 */
export function blastMobDamages(
	mobs: ReadonlyArray<{
		x: number;
		y: number;
		z: number;
	}>,
	cx: number,
	cy: number,
	cz: number,
	radius: number,
	maxDamage: number = TNT_MAX_DAMAGE,
): number[] {
	const mobCount = mobs.length;
	const damages = new Array<number>(mobCount);

	if (mobCount === 0) {
		return damages;
	}

	/*
	 * Preserve explosionFalloff() behavior for invalid or zero radii while
	 * avoiding all position calculations.
	 */
	if (!(radius > 0)) {
		damages.fill(0);
		return damages;
	}

	const radiusSquared = radius * radius;
	const damageScale = maxDamage / radius;
	const centerDamage = Math.floor(maxDamage);

	for (let i = 0; i < mobCount; i++) {
		const mob = mobs[i];

		const deltaX = mob.x - cx;
		const deltaY = mob.y - cy;
		const deltaZ = mob.z - cz;

		const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;

		/*
		 * Reject mobs outside the sphere without calculating a square root.
		 * The comparison also rejects an infinite distance.
		 */
		if (distanceSquared >= radiusSquared) {
			damages[i] = 0;
			continue;
		}

		if (distanceSquared <= 0) {
			damages[i] = centerDamage;
			continue;
		}

		const distance = Math.sqrt(distanceSquared);

		damages[i] = Math.floor(maxDamage - distance * damageScale);
	}

	return damages;
}

/**
 * Collects blast targets in a sphere around the explosion center.
 *
 * Distance is measured from the explosion center to voxel centers. Air,
 * water, and blast-resistant blocks are skipped. Ignitable TNT is placed in
 * `chain` until TNT_MAX_CHAIN is reached; further TNT is destroyed.
 */
export function collectExplosionTargets(
	cx: number,
	cy: number,
	cz: number,
	radius: number,
	getBlock: (x: number, y: number, z: number) => number,
): ExplosionTargets {
	const destroy: ExplosionTarget[] = [];
	const chain: ExplosionTarget[] = [];

	/*
	 * A non-finite radius would otherwise produce an unbounded loop for
	 * positive Infinity. NaN and negative radii naturally contain no blocks.
	 */
	if (!Number.isFinite(radius) || radius < 0) {
		return { destroy, chain };
	}

	const radiusSquared = radius * radius;
	const range = Math.ceil(radius);

	const centerBlockX = Math.floor(cx);
	const centerBlockY = Math.floor(cy);
	const centerBlockZ = Math.floor(cz);

	/*
	 * Displacement from the explosion center to the center of the containing
	 * voxel. Integer loop deltas then produce candidate-center displacement.
	 */
	const baseOffsetX = centerBlockX + 0.5 - cx;

	const baseOffsetY = centerBlockY + 0.5 - cy;

	const baseOffsetZ = centerBlockZ + 0.5 - cz;

	let chainCount = 0;

	for (let deltaX = -range; deltaX <= range; deltaX++) {
		const offsetX = baseOffsetX + deltaX;

		const offsetXSquared = offsetX * offsetX;

		if (offsetXSquared > radiusSquared) {
			continue;
		}

		const x = centerBlockX + deltaX;

		for (let deltaY = -range; deltaY <= range; deltaY++) {
			const offsetY = baseOffsetY + deltaY;

			const xyDistanceSquared = offsetXSquared + offsetY * offsetY;

			if (xyDistanceSquared > radiusSquared) {
				continue;
			}

			const y = centerBlockY + deltaY;

			/*
			 * Solve:
			 *
			 *   xyDistanceSquared + offsetZ² <= radiusSquared
			 *
			 * This restricts the inner loop to the Z coordinates that can
			 * actually lie in the sphere, instead of scanning the full cube.
			 */
			const maximumZDistance = Math.sqrt(radiusSquared - xyDistanceSquared);

			let minimumDeltaZ = Math.ceil(-maximumZDistance - baseOffsetZ);

			let maximumDeltaZ = Math.floor(maximumZDistance - baseOffsetZ);

			/*
			 * Clamp for floating-point boundary safety and to retain the
			 * original bounding-cube limits.
			 */
			if (minimumDeltaZ < -range) {
				minimumDeltaZ = -range;
			}

			if (maximumDeltaZ > range) {
				maximumDeltaZ = range;
			}

			for (let deltaZ = minimumDeltaZ; deltaZ <= maximumDeltaZ; deltaZ++) {
				const offsetZ = baseOffsetZ + deltaZ;

				/*
				 * Retain the exact sphere test. Although the calculated bounds
				 * normally guarantee inclusion, this protects against floating
				 * point rounding at the sphere boundary.
				 */
				const distanceSquared = xyDistanceSquared + offsetZ * offsetZ;

				if (distanceSquared > radiusSquared) {
					continue;
				}

				const z = centerBlockZ + deltaZ;
				const blockId = getBlock(x, y, z);

				if (
					blockId === BlockType.Air ||
					blockId === BlockType.Water ||
					BLAST_RESISTANT_BLOCKS.has(blockId)
				) {
					continue;
				}

				const target: ExplosionTarget = {
					x,
					y,
					z,
					blockId,
				};

				const isIgnitableTnt =
					blockId === BlockType.Tnt ||
					blockId === TNT_SLAB_BLOCK_ID ||
					blockId === TNT_HALF_WALL_BLOCK_ID;

				if (isIgnitableTnt && chainCount < TNT_MAX_CHAIN) {
					chain.push(target);
					chainCount++;
				} else {
					/*
					 * TNT beyond the chain limit is destroyed instead of
					 * ignited, preventing unbounded chain reactions.
					 */
					destroy.push(target);
				}
			}
		}
	}

	return {
		destroy,
		chain,
	};
}
