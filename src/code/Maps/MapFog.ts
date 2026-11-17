import { type FogConfig, type SceneContext, setFog } from "@babylonjs/lite";
import { farTileReachBlocks } from "@/code/World/FarTiles/FarTileLadder";
import { WorldEnvironment } from "./WorldEnvironment";

export default class MapFog {
	public static readonly fogStartUnderWater = 1;
	public static readonly fogEndUnderWater = 100;

	// Above-water fog reaches the far-tile horizon when far tiles are active;
	// otherwise the legacy 1100-block cap applies.
	private static get computedFogEndAboveWater(): number {
		const farReach = farTileReachBlocks();
		return farReach > 0 ? Math.max(1100, farReach * 1.05) : 1100;
	}

	public static readonly fogStartAboveWater = 1;
	private static fogStartOverride: number | null = 300;
	private static fogEndOverride: number | null = 1750;

	private static readonly fogColor: [number, number, number] = [1.0, 0.0, 0.1];
	private static readonly fogDensity = 0.8;
	private static readonly fogMode = 1; // FOGMODE_LINEAR

	public static setFogStartOverride(value: number | null): void {
		MapFog.fogStartOverride = value;
	}

	public static setFogEndOverride(value: number | null): void {
		MapFog.fogEndOverride = value;
	}

	public static getFogStart(isUnderWater: boolean): number {
		if (MapFog.fogStartOverride !== null) return MapFog.fogStartOverride;
		return isUnderWater ? MapFog.fogStartUnderWater : MapFog.fogStartAboveWater;
	}

	public static getFogEnd(isUnderWater: boolean): number {
		if (MapFog.fogEndOverride !== null) return MapFog.fogEndOverride;
		return isUnderWater
			? MapFog.fogEndUnderWater
			: MapFog.computedFogEndAboveWater;
	}

	private static readonly fogColorAboveWater: [number, number, number] = [
		0.6, 0.7, 0.9,
	];
	private static readonly fogColorUnderWater: [number, number, number] = [
		0.6, 0.7, 0.9,
	];

	/**
	 * Fog colour once the rain takes over.
	 *
	 * The sky goes overcast while it rains, so the haze has to follow or the
	 * horizon shows a bright blue band under a grey sky.
	 */
	private static readonly fogColorRain: [number, number, number] = [
		0.42, 0.45, 0.5,
	];

	/**
	 * Scratch for the rain-blended fog colour.
	 *
	 * Shared rather than allocated per call: `getFogColor` runs in the
	 * per-frame fog update for the chunk, far-tile and distant-terrain
	 * shaders, and all three copy the components out immediately.
	 */
	private static readonly fogColorRainScratch: [number, number, number] = [
		0, 0, 0,
	];

	public static getFogColor(isUnderWater: boolean): [number, number, number] {
		if (isUnderWater) {
			return MapFog.fogColorUnderWater;
		}

		const rain = WorldEnvironment.instance?.rainIntensity ?? 0;

		if (rain <= 0) {
			return MapFog.fogColorAboveWater;
		}

		const base = MapFog.fogColorAboveWater;
		const rainy = MapFog.fogColorRain;
		const scratch = MapFog.fogColorRainScratch;

		scratch[0] = base[0] + (rainy[0] - base[0]) * rain;
		scratch[1] = base[1] + (rainy[1] - base[1]) * rain;
		scratch[2] = base[2] + (rainy[2] - base[2]) * rain;

		return scratch;
	}

	public static applyToScene(scene: SceneContext, isUnderWater: boolean): void {
		const cfg: FogConfig = {
			mode: MapFog.fogMode,
			density: MapFog.fogDensity,
			start: MapFog.getFogStart(isUnderWater),
			end: MapFog.getFogEnd(isUnderWater),
			color: MapFog.fogColor,
		};
		setFog(scene, cfg);
	}

	constructor(scene: SceneContext) {
		MapFog.applyToScene(scene, true);
	}
}
