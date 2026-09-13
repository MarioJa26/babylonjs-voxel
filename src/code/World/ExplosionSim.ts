import { getVirtualBlockId } from "@/code/World/Texture/BlockTextures";
import { BlockType } from "@/code/World/Texture/BlockType";

/**
 * Pure, engine-free TNT blast helpers.
 * Safe to unit-test without DOM, GPU, or scene dependencies.
 */

/** Default blast radius in blocks. */
export const TNT_BLAST_RADIUS = 4;

/** Blast radius for half-size TNT variants (slab, half wall). */
export const TNT_HALF_BLAST_RADIUS = TNT_BLAST_RADIUS / 2;

/** Damage at the explosion center. */
export const TNT_MAX_DAMAGE = 40;

/** Max TNT blocks ignited as chains by a single blast. */
export const TNT_MAX_CHAIN = 20;

/**
 * Blocks that explosions never destroy.
 * Additional blast-proof blocks can be added here.
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

/**
 * Blast radius for an ignitable block, or null when the block cannot be
 * ignited. Full TNT blocks get the full range; the half-size mason variants
 * (slab, half wall) get half range. Other shapes (stairs, pane, fence) and
 * all other blocks are not ignitable.
 */
export function tntBlastRadius(blockId: number): number | null {
	if (blockId === BlockType.Tnt) {
		return TNT_BLAST_RADIUS;
	}

	if (
		blockId === getVirtualBlockId(BlockType.Tnt, "slab") ||
		blockId === getVirtualBlockId(BlockType.Tnt, "half_wall")
	) {
		return TNT_HALF_BLAST_RADIUS;
	}

	return null;
}

/**
 * Linear falloff:
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

	return Math.floor((1 - distance / radius) * maxDamage);
}

/**
 * Calculates per-mob blast damage while preserving input order.
 *
 * Mobs at or beyond the blast radius receive zero damage.
 */
export function blastMobDamages(
	mobs: ReadonlyArray<{ x: number; y: number; z: number }>,
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

	// Preserve explosionFalloff behavior for invalid or zero radii while
	// avoiding unnecessary position calculations.
	if (radius <= 0) {
		damages.fill(0);
		return damages;
	}

	const radiusSquared = radius * radius;
	const damageScale = maxDamage / radius;

	for (let i = 0; i < mobCount; i++) {
		const mob = mobs[i];
		const dx = mob.x - cx;
		const dy = mob.y - cy;
		const dz = mob.z - cz;
		const distanceSquared = dx * dx + dy * dy + dz * dz;

		// Avoid Math.sqrt for mobs at or outside the blast radius.
		if (distanceSquared >= radiusSquared) {
			damages[i] = 0;
			continue;
		}

		if (distanceSquared <= 0) {
			damages[i] = Math.floor(maxDamage);
			continue;
		}

		// Equivalent to:
		// floor((1 - distance / radius) * maxDamage)
		const distance = Math.sqrt(distanceSquared);
		damages[i] = Math.floor(maxDamage - distance * damageScale);
	}

	return damages;
}

/**
 * Collects blast targets in a sphere around the explosion center.
 *
 * Distance is measured from the explosion center to voxel centers.
 * Air, water, and blast-resistant blocks are skipped. Ignitable TNT (full
 * blocks plus slab / half wall variants, see tntBlastRadius) is placed in
 * `chain` until TNT_MAX_CHAIN is reached, after which it is destroyed.
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

	if (radius < 0) {
		return { destroy, chain };
	}

	const range = Math.ceil(radius);
	const radiusSquared = radius * radius;

	const centerBlockX = Math.floor(cx);
	const centerBlockY = Math.floor(cy);
	const centerBlockZ = Math.floor(cz);

	// Offset from the explosion center to the center of its containing voxel.
	// For each loop iteration, adding the integer delta gives the candidate
	// voxel-center displacement without recalculating world coordinates.
	const baseOffsetX = centerBlockX + 0.5 - cx;
	const baseOffsetY = centerBlockY + 0.5 - cy;
	const baseOffsetZ = centerBlockZ + 0.5 - cz;

	for (let dx = -range; dx <= range; dx++) {
		const offsetX = baseOffsetX + dx;
		const offsetXSquared = offsetX * offsetX;

		// No point scanning this entire yz plane if its x distance alone
		// already lies outside the sphere.
		if (offsetXSquared > radiusSquared) {
			continue;
		}

		const x = centerBlockX + dx;

		for (let dy = -range; dy <= range; dy++) {
			const offsetY = baseOffsetY + dy;
			const xyDistanceSquared = offsetXSquared + offsetY * offsetY;

			// Skip the entire z row when x and y already exceed the radius.
			if (xyDistanceSquared > radiusSquared) {
				continue;
			}

			const y = centerBlockY + dy;

			for (let dz = -range; dz <= range; dz++) {
				const offsetZ = baseOffsetZ + dz;
				const distanceSquared = xyDistanceSquared + offsetZ * offsetZ;

				if (distanceSquared > radiusSquared) {
					continue;
				}

				const z = centerBlockZ + dz;
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

				if (tntBlastRadius(blockId) !== null && chain.length < TNT_MAX_CHAIN) {
					chain.push(target);
				} else {
					// Overflow TNT is destroyed to prevent runaway chains.
					destroy.push(target);
				}
			}
		}
	}

	return { destroy, chain };
}
