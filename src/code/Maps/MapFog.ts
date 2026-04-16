import { Scene } from "@babylonjs/core";

export default class MapFog {
	public static readonly fogStartUnderWater = 1;
	public static readonly fogEndUnderWater = 100;

	public static readonly fogStartAboveWater = 1;
	public static readonly fogEndAboveWater = 1100;
	private static fogStartOverride: number | null = null;
	private static fogEndOverride: number | null = null;

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

	public static applyToScene(scene: Scene, isUnderWater: boolean): void {
		const nextStart = MapFog.getFogStart(isUnderWater);
		const nextEnd = MapFog.getFogEnd(isUnderWater);
		if (scene.fogStart !== nextStart) scene.fogStart = nextStart;
		if (scene.fogEnd !== nextEnd) scene.fogEnd = nextEnd;
	}

	constructor(private scene: Scene) {
		scene.fogMode = Scene.FOGMODE_LINEAR;
		MapFog.applyToScene(scene, true);
		// scene.fogColor = new Color3(1.0, 0.0, 0.1);
		scene.fogDensity = 0.9;
	}
}
