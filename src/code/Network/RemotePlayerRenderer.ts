/**
 * RemotePlayerRenderer — visual representation of other players.
 *
 * Creates and updates simple capsule meshes for remote players.
 * In Phase 1, just colored capsules. Later: proper player models.
 */
import type { EngineContext, Mesh, SceneContext } from "@babylonjs/lite";
import {
	addToScene,
	createCapsule,
	createStandardMaterial,
	disposeMeshGpu,
} from "@babylonjs/lite";
import type { RemotePlayer } from "./NetClient";

const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.3;

// Color palette for different players
const PLAYER_COLORS: [number, number, number][] = [
	[0.2, 0.6, 1.0], // Blue
	[1.0, 0.4, 0.2], // Orange
	[0.2, 1.0, 0.4], // Green
	[1.0, 0.2, 0.6], // Pink
	[0.6, 0.2, 1.0], // Purple
	[1.0, 0.8, 0.2], // Yellow
	[0.2, 0.8, 1.0], // Cyan
	[0.8, 0.4, 0.1], // Brown
];

export class RemotePlayerVisual {
	readonly mesh: Mesh;
	private nameSprite: Mesh | null = null;

	constructor(
		private engine: EngineContext,
		scene: SceneContext,
		private player: RemotePlayer,
		colorIndex: number,
	) {
		this.mesh = createCapsule(engine, {
			height: PLAYER_HEIGHT,
			radius: PLAYER_RADIUS,
		});

		const color = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length];
		const mat = createStandardMaterial();
		mat.diffuseColor = color;
		mat.emissiveColor = [0, 0, 0];
		mat.disableLighting = true;
		this.mesh.material = mat;
		this.mesh.pickable = false;

		addToScene(scene, this.mesh);
	}

	update(): void {
		this.mesh.position.set(this.player.x, this.player.y, this.player.z);
		this.mesh.rotation.y = (this.player.yaw * Math.PI) / 180;
	}

	dispose(): void {
		disposeMeshGpu(this.mesh);
	}
}

export class RemotePlayerRenderer {
	private visuals = new Map<string, RemotePlayerVisual>();
	private scene: SceneContext;
	private engine: EngineContext;

	constructor(engine: EngineContext, scene: SceneContext) {
		this.engine = engine;
		this.scene = scene;
	}

	onPlayerJoin(player: RemotePlayer): void {
		if (this.visuals.has(player.sessionId)) return;
		const colorIndex = this.visuals.size % PLAYER_COLORS.length;
		const visual = new RemotePlayerVisual(
			this.engine,
			this.scene,
			player,
			colorIndex,
		);
		this.visuals.set(player.sessionId, visual);
	}

	onPlayerLeave(sessionId: string): void {
		const visual = this.visuals.get(sessionId);
		if (visual) {
			visual.dispose();
			this.visuals.delete(sessionId);
		}
	}

	update(): void {
		for (const visual of this.visuals.values()) {
			visual.update();
		}
	}

	dispose(): void {
		for (const visual of this.visuals.values()) {
			visual.dispose();
		}
		this.visuals.clear();
	}
}
