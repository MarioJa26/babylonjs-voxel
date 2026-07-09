/**
 * A simple, fast hashing utility for deterministic randomness.
 * It uses the Squirrel3 noise function, which is great for procedural generation.
 */
const NOISE1 = 0xb5297a4d;
const NOISE2 = 0x68e31da4;
const NOISE3 = 0x1b56c4e9;
let HASH = 0xc4ceb9fe;

/**
 * Generates a pseudo-random integer for a given 1D position and seed.
 */
export function getPRNGBySeed(position: number, seed: number): number {
	let mangled = position;
	mangled *= NOISE1;
	mangled += seed;
	mangled ^= mangled >> 8;
	mangled += NOISE2;
	mangled ^= mangled << 8;
	mangled *= NOISE3;
	return mangled ^ (mangled >> 8);
}

export function getPRNG(position: number): number {
	let mangled = position;
	mangled *= NOISE1;
	mangled += HASH;
	mangled ^= mangled >> 8;
	mangled += NOISE2;
	mangled ^= mangled << 8;
	mangled *= NOISE3;
	mangled ^= mangled >> 8;
	HASH = mangled;
	return mangled;
}
