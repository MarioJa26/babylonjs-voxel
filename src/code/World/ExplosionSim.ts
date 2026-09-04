import { BlockType } from "@/code/World/Texture/BlockType";

/**
 * Pure (engine-free) TNT blast helpers. No DOM, no GPU, no scene imports —
 * safe to unit-test under tsx. Engine side effects live in Explosion.ts.
 */

/** Default blast radius in blocks (user-confirmed). */
export const TNT_BLAST_RADIUS = 4;
/** Damage at the explosion center. */
export const TNT_MAX_DAMAGE = 40;
/** Max TNT blocks ignited as chains by a single blast (runaway guard). */
export const TNT_MAX_CHAIN = 20;

/**
 * Blocks the blast never destroys. Obsidian is the blast-proof building
 * material; more entries (e.g. Bedrock) can be added here later.
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
	/** Live TNT blocks to ignite with a short fuse instead of deleting. */
	chain: ExplosionTarget[];
};

/**
 * Linear falloff: 1 at the center, 0 at/ past the rim. Distance is measured
 * from the explosion center to the target position.
 */
export function explosionFalloff(distance: number, radius: number): number {
	if (radius <= 0) return 0;
	if (distance >= radius) return 0;
	if (distance <= 0) return 1;
	return 1 - distance / radius;
}

/** Falloff-scaled damage, rounded down (0 outside the radius). */
export function explosionDamage(
	distance: number,
	radius: number,
	maxDamage: number = TNT_MAX_DAMAGE,
): number {
	return Math.floor(explosionFalloff(distance, radius) * maxDamage);
}

/**
 * Per-mob blast damage for a list of entity positions, preserving input
 * order (0 for mobs outside the radius — callers skip those). Shared by the
 * client's local-mob loop and the server's authoritative mob damage so SP
 * and MP use identical math.
 */
export function blastMobDamages(
	mobs: ReadonlyArray<{ x: number; y: number; z: number }>,
	cx: number,
	cy: number,
	cz: number,
	radius: number,
	maxDamage: number = TNT_MAX_DAMAGE,
): number[] {
	const damages = new Array<number>(mobs.length);

	for (let i = 0; i < mobs.length; i++) {
		const mob = mobs[i];
		const dx = mob.x - cx;
		const dy = mob.y - cy;
		const dz = mob.z - cz;
		damages[i] = explosionDamage(
			Math.sqrt(dx * dx + dy * dy + dz * dz),
			radius,
			maxDamage,
		);
	}

	return damages;
}

/**
 * Collect blast targets in a sphere around (cx, cy, cz). Distance is measured
 * to voxel centers. Air and Water are skipped (blasts don't vaporize lakes);
 * blast-resistant blocks are skipped; TNT goes to `chain` (capped) so it
 * ignites instead of vanishing; everything else goes to `destroy`.
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

	const r = Math.ceil(radius);
	for (let dx = -r; dx <= r; dx++) {
		for (let dy = -r; dy <= r; dy++) {
			for (let dz = -r; dz <= r; dz++) {
				const x = Math.floor(cx) + dx;
				const y = Math.floor(cy) + dy;
				const z = Math.floor(cz) + dz;

				const dist = Math.sqrt(
					(x + 0.5 - cx) * (x + 0.5 - cx) +
						(y + 0.5 - cy) * (y + 0.5 - cy) +
						(z + 0.5 - cz) * (z + 0.5 - cz),
				);
				if (dist > radius) continue;

				const blockId = getBlock(x, y, z);
				if (blockId === BlockType.Air || blockId === BlockType.Water) {
					continue;
				}
				if (BLAST_RESISTANT_BLOCKS.has(blockId)) continue;

				if (blockId === BlockType.Tnt) {
					// Cap chain ignitions; overflow TNT is still destroyed so a
					// dense TNT store can't cascade forever.
					if (chain.length < TNT_MAX_CHAIN) {
						chain.push({ x, y, z, blockId });
					} else {
						destroy.push({ x, y, z, blockId });
					}
					continue;
				}

				destroy.push({ x, y, z, blockId });
			}
		}
	}

	return { destroy, chain };
}
