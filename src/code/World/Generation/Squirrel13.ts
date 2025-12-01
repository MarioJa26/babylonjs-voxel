/**
 * A simple, fast hashing utility for deterministic randomness.
 * It uses the Squirrel3 noise function, which is great for procedural generation.
 */
export class Squirrel3 {
  private static readonly NOISE1 = 0xb5297a4d;
  private static readonly NOISE2 = 0x68e31da4;
  private static readonly NOISE3 = 0x1b56c4e9;
  private static HASH = 0xc4ceb9fe;

  /**
   * Generates a pseudo-random integer for a given 1D position and seed.
   */
  public static get(position: number, seed: number): number {
    let mangled = position;
    mangled *= Squirrel3.NOISE1;
    mangled += seed;
    mangled ^= mangled >> 8;
    mangled += Squirrel3.NOISE2;
    mangled ^= mangled << 8;
    mangled *= Squirrel3.NOISE3;
    return mangled ^ (mangled >> 8);
  }

  public static getPRNG(position: number): number {
    let mangled = position;
    mangled *= Squirrel3.NOISE1;
    mangled += Squirrel3.HASH;
    mangled ^= mangled >> 8;
    mangled += Squirrel3.NOISE2;
    mangled ^= mangled << 8;
    mangled *= Squirrel3.NOISE3;
    mangled ^= mangled >> 8;
    this.HASH = mangled;
    return mangled;
  }
}
