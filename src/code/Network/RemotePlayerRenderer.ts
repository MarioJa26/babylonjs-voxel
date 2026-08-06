/**
 * RemotePlayerRenderer — visual representation of other players.
 *
 * Creates capsule meshes for remote players + floating name tags (DOM overlays).
 */
import type { EngineContext, Mesh, SceneContext } from "@babylonjs/lite";
import {
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
	private nameTag: HTMLDivElement;
	private _screenX = 0;
	private _screenY = 0;
	private _visible = true;

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

		// Create floating name tag
		this.nameTag = document.createElement("div");
		this.nameTag.className = "mp-name-tag";
		this.nameTag.textContent = player.name;
		document.body.appendChild(this.nameTag);
	}

	update(camera: any, screenW: number, screenH: number): void {
		this.mesh.position.set(this.player.x, this.player.y, this.player.z);
		this.mesh.rotation.y = (this.player.yaw * Math.PI) / 180;

		// Project 3D position to screen space for name tag
		const wx = this.player.x;
		const wy = this.player.y + PLAYER_HEIGHT + 0.3; // above head
		const wz = this.player.z;

		const cam = camera;
		if (cam?.position && cam.target) {
			// Camera forward vector
			let fx = cam.target.x - cam.position.x;
			let fy = cam.target.y - cam.position.y;
			let fz = cam.target.z - cam.position.z;
			const fLen = Math.sqrt(fx * fx + fy * fy + fz * fz);
			fx /= fLen;
			fy /= fLen;
			fz /= fLen;

			// Vector from camera to player
			const dx = wx - cam.position.x;
			const dy = wy - cam.position.y;
			const dz = wz - cam.position.z;

			// Forward distance (dot product)
			const forwardDist = dx * fx + dy * fy + dz * fz;

			if (forwardDist > 0.1) {
				// Right vector = forward × world_up
				let rx = fy * 0 - fz * 1;
				let ry = fz * 0 - fx * 0;
				let rz = fx * 1 - fy * 0;
				let rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
				rx /= rLen;
				ry /= rLen;
				rz /= rLen;

				// True camera up = right × forward (perpendicular to both)
				const ux = ry * fz - rz * fy;
				const uy = rz * fx - rx * fz;
				const uz = rx * fy - ry * fx;

				// Project onto camera plane
				const rightDist = (dx * rx + dy * ry + dz * rz) / forwardDist;
				const upDist = (dx * ux + dy * uy + dz * uz) / forwardDist;

				// FOV-based scaling
				const fov = cam.fov ?? 1.1;
				const tanHalfFov = Math.tan(fov * 0.5);
				const aspect = screenW / screenH;

				// Normalized device coordinates [-1, 1]
				// Negate X for left-handed coordinate system
				const ndcX = -rightDist / (tanHalfFov * aspect);
				const ndcY = upDist / tanHalfFov;

				// Screen coordinates
				this._screenX = screenW * 0.5 * (1 + ndcX);
				this._screenY = screenH * 0.5 * (1 - ndcY);
				this._visible = true;
			} else {
				this._visible = false;
			}
		}

		// Update name tag position
		this.nameTag.style.left = `${this._screenX}px`;
		this.nameTag.style.top = `${this._screenY}px`;
		this.nameTag.style.display = this._visible ? "block" : "none";
	}

	dispose(): void {
		disposeMeshGpu(this.mesh);
		this.nameTag.remove();
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

	update(camera: any, screenW: number, screenH: number): void {
		for (const visual of this.visuals.values()) {
			visual.update(camera, screenW, screenH);
		}
	}

	dispose(): void {
		for (const visual of this.visuals.values()) {
			visual.dispose();
		}
		this.visuals.clear();
	}
}
