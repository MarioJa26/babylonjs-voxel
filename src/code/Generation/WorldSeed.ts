import Alea from "alea";
import { getPRNGBySeed } from "./NoiseAndParameters/Squirrel13";

/**
 * Derive the integer seed that all worldgen features hash against.
 *
 * `WorldGenerator` folds the world seed string down to an int32 once and then
 * passes that integer everywhere. Runtime systems that need to reproduce a
 * worldgen decision (which temple owns this position, what a loot cache holds)
 * have to fold it the same way, so the derivation lives here rather than being
 * duplicated.
 */
export function computeSeedAsInt(seed: string): number {
	return getPRNGBySeed(0, (Alea(seed)() * 0xffffffff) | 0);
}
