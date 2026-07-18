import { type FogConfig, type SceneContext, setFog } from "@babylonjs/lite";

export default class MapFog {
	public static readonly fogStartUnderWater = 1;
	public static readonly fogEndUnderWater = 100;

	public static readonly fogStartAboveWater = 1;
	public static readonly fogEndAboveWater = 1100;
	private static fogStartOverride: number | null = null;
	private static fogEndOverride: number | null = null;

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
		return isUnderWater ? MapFog.fogEndUnderWater : MapFog.fogEndAboveWater;
	}

	private static readonly fogColorAboveWater: [number, number, number] = [
		0.6, 0.7, 0.9,
	];
	private static readonly fogColorUnderWater: [number, number, number] = [
		0.6, 0.7, 0.9,
	];

	public static getFogColor(isUnderWater: boolean): [number, number, number] {
		return isUnderWater ? MapFog.fogColorUnderWater : MapFog.fogColorAboveWater;
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
