import { type Camera, type Scene } from "@babylonjs/core";
import type { Player } from "../Player/Player";

// Babylon Lite (WebGPU) has no PostProcess / DepthRenderer / GLSL ShaderMaterial
// pipeline. This effect is reduced to a minimal, compiling stub that preserves the
// public surface used elsewhere (constructor + material/postProcess/dispose).
export class UnderWaterEffect {
	public material: any;
	public postProcess: any;

	private scene: Scene;
	private camera: Camera;
	private player: Player;
	private isUnderwater = false;
	private time = 0;
	private rate = 0.01;

	constructor(scene: Scene, camera: Camera, player: Player, baseTexture: any) {
		this.scene = scene;
		this.camera = camera;
		this.player = player;
		this.material = null;
		this.postProcess = null;
		void baseTexture;
	}

	public dispose(): void {
		this.material = null;
		this.postProcess = null;
		this.isUnderwater = false;
	}
}
