import {
	type AbstractMesh,
	Color3,
	Color4,
	type Engine,
	Mesh,
	MeshBuilder,
	Ray,
	type Scene,
	StandardMaterial,
	Vector3,
} from "@babylonjs/core";
import * as GUI from "@babylonjs/gui";
import { MetadataContainer } from "@/code/Entities/MetaDataContainer";
import { BlockType, isCollidableBlock } from "@/code/World/BlockType";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";
import { SettingParams } from "@/code/World/SettingParams";
import { FACE_ALL, getShapeForBlockId } from "@/code/World/Shape/BlockShapes";
import { getTransformedShapeBoxes } from "@/code/World/Shape/BlockShapeTransforms";
import { Player } from "../Player";

type BlockRaycastHit = {
	x: number;
	y: number;
	z: number;
	nx: number;
	ny: number;
	nz: number;
	t: number;
};

export class CrossHair {
	static readonly #meshRayMarchStep = 0.25;
	static readonly #meshBoundsEpsilon = 0.001;
	static readonly #sharedPoint = new Vector3(0, 0, 0);

	readonly #scene: Scene;
	readonly #engine: Engine;
	readonly #ui: GUI.AdvancedDynamicTexture =
		GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");
	readonly #player: Player;

	#crosshair = this.#createCrosshair("179");
	#hitMarker = this.#createHitMarker();
	#highlightMaterial: StandardMaterial;
	#highlightShapeKey = "";
	#blockHighlightMesh: Mesh;

	constructor(engine: Engine, scene: Scene, player: Player) {
		this.#engine = engine;
		this.#scene = scene;
		this.#player = player;
		this.#highlightMaterial = this.#createHighlightMaterial();

		this.#engine.enterPointerlock();
		this.#blockHighlightMesh = this.#createBlockHighlight();
		this.#scene.onBeforeRenderObservable.add(() => {
			this.#updateBlockHighlight();
		});
	}

	#createCrosshair(hitMarkerId: string): GUI.Image {
		const img = new GUI.Image(
			"crossHair",
			`/texture/gui/kenney_crosshair-pack/PNG/Outline Retina/crosshair${hitMarkerId}.png`,
		);
		img.width = "48px";
		img.height = "48px";
		img.alpha = 1;
		this.#ui.addControl(img);
		return img;
	}

	#createHitMarker(): GUI.Image {
		const img = new GUI.Image("hitMarker", "/texture/gui/hitmarker01.png");
		img.width = "28px";
		img.height = "28px";
		img.alpha = 0;
		this.#ui.addControl(img);
		return img;
	}

	#showHitMarker(): void {
		let elapsedTime = 0;
		const durationSeconds = 0.33;

		const onRender = (): void => {
			elapsedTime += this.#engine.getDeltaTime() / 1000;
			this.#hitMarker.alpha = Math.max(
				0,
				this.#crosshair.alpha - elapsedTime / durationSeconds,
			);

			if (elapsedTime >= durationSeconds) {
				this.#scene.onBeforeRenderObservable.removeCallback(onRender);
				this.#hitMarker.alpha = 0;
			}
		};

		this.#scene.onBeforeRenderObservable.add(onRender);
	}

	#createBlockHighlight(): Mesh {
		const mesh = this.#createUnitCubeHighlightMesh();
		this.#configureHighlightMesh(mesh);
		this.#highlightShapeKey = "default";
		return mesh;
	}

	#createHighlightMaterial(): StandardMaterial {
		const highlightMaterial = new StandardMaterial("highlightMat", this.#scene);
		highlightMaterial.alpha = SettingParams.HIGHLIGHT_ALPHA;
		highlightMaterial.diffuseColor = new Color3(
			SettingParams.HIGHLIGHT_COLOR[0],
			SettingParams.HIGHLIGHT_COLOR[1],
			SettingParams.HIGHLIGHT_COLOR[2],
		);
		return highlightMaterial;
	}

	#configureHighlightMesh(mesh: Mesh): void {
		mesh.isPickable = false;
		mesh.renderingGroupId = 1;
		mesh.material = this.#highlightMaterial;
		mesh.enableEdgesRendering();
		mesh.edgesWidth = SettingParams.HIGHLIGHT_EDGE_WIDTH;
		mesh.edgesColor = new Color4(
			SettingParams.HIGHLIGHT_EDGE_COLOR[0],
			SettingParams.HIGHLIGHT_EDGE_COLOR[1],
			SettingParams.HIGHLIGHT_EDGE_COLOR[2],
			SettingParams.HIGHLIGHT_EDGE_COLOR[3],
		);
		mesh.visibility = 0;
	}

	#createUnitCubeHighlightMesh(): Mesh {
		const mesh = MeshBuilder.CreateBox(
			"blockHighlightUnitCube",
			{ size: 1.012 },
			this.#scene,
		);
		mesh.position.set(0.5, 0.5, 0.5);
		this.#bakeLocalOffset(mesh);
		return mesh;
	}

	#bakeLocalOffset(mesh: Mesh): void {
		mesh.bakeCurrentTransformIntoVertices();
		mesh.position.set(0, 0, 0);
	}

	#buildHighlightMeshForBlock(blockId: number, blockState: number): Mesh {
		const inflation = 0.005;
		const parts: Mesh[] = [];

		let index = 0;
		for (const transformed of getTransformedShapeBoxes(blockId, blockState)) {
			const width = transformed.max[0] - transformed.min[0];
			const height = transformed.max[1] - transformed.min[1];
			const depth = transformed.max[2] - transformed.min[2];
			if (width <= 0 || height <= 0 || depth <= 0) continue;

			const part = MeshBuilder.CreateBox(
				`blockHighlightPart_${index++}`,
				{
					width: width + inflation,
					height: height + inflation,
					depth: depth + inflation,
				},
				this.#scene,
			);
			part.position.set(
				(transformed.min[0] + transformed.max[0]) * 0.5,
				(transformed.min[1] + transformed.max[1]) * 0.5,
				(transformed.min[2] + transformed.max[2]) * 0.5,
			);
			this.#bakeLocalOffset(part);
			parts.push(part);
		}

		if (parts.length === 0) {
			const fallback = this.#createUnitCubeHighlightMesh();
			this.#configureHighlightMesh(fallback);
			return fallback;
		}

		let mesh: Mesh;
		if (parts.length === 1) {
			mesh = parts[0];
		} else {
			const merged = Mesh.MergeMeshes(
				parts,
				true,
				true,
				undefined,
				false,
				true,
			);
			if (!merged || !(merged instanceof Mesh)) {
				mesh = parts[0];
				for (let i = 1; i < parts.length; i++) parts[i].dispose();
			} else {
				mesh = merged;
			}
		}

		mesh.name = "blockHighlight";
		this.#configureHighlightMesh(mesh);
		return mesh;
	}

	#ensureHighlightShape(blockId: number, blockState: number): void {
		const shapeKey = `${blockId}:${blockState}`;
		if (shapeKey === this.#highlightShapeKey) return;

		const newMesh = this.#buildHighlightMeshForBlock(blockId, blockState);
		newMesh.position.copyFrom(this.#blockHighlightMesh.position);
		this.#blockHighlightMesh.dispose();
		this.#blockHighlightMesh = newMesh;
		this.#highlightShapeKey = shapeKey;
	}

	#updateBlockHighlight() {
		const hit = CrossHair.pickTarget(this.#player);
		if (hit) {
			const blockId = ChunkLoadingSystem.getBlockByWorldCoords(
				hit.x,
				hit.y,
				hit.z,
			);
			const blockState = ChunkLoadingSystem.getBlockStateByWorldCoords(
				hit.x,
				hit.y,
				hit.z,
			);
			this.#ensureHighlightShape(blockId, blockState);
			this.#blockHighlightMesh.position.set(hit.x, hit.y, hit.z);
			this.#blockHighlightMesh.visibility = 1;
		} else {
			this.#blockHighlightMesh.visibility = 0;
		}
	}

	static #sharedRay: Ray | null = null;
	static readonly #sharedHit: BlockRaycastHit = {
		x: 0,
		y: 0,
		z: 0,
		nx: 0,
		ny: 0,
		nz: 0,
		t: 0,
	};

	static #getSharedForwardRay(player: Player, length: number): Ray {
		if (!CrossHair.#sharedRay) {
			CrossHair.#sharedRay = new Ray(
				new Vector3(0, 0, 0),
				new Vector3(0, 0, 1),
				1,
			);
		}

		player.playerCamera.playerCamera.getForwardRayToRef(
			CrossHair.#sharedRay,
			length,
		);
		return CrossHair.#sharedRay;
	}

	static #raycastFirstBlock(
		player: Player,
		shouldHitBlockId: (
			x: number,
			y: number,
			z: number,
			blockId: number,
		) => boolean,
	): BlockRaycastHit | null {
		const ray = CrossHair.#getSharedForwardRay(player, Player.REACH_DISTANCE);

		const ox = ray.origin.x;
		const oy = ray.origin.y;
		const oz = ray.origin.z;
		const dx = ray.direction.x;
		const dy = ray.direction.y;
		const dz = ray.direction.z;

		const maxDistance = ray.length;
		if (!(maxDistance > 0)) return null;

		let x = Math.floor(ox);
		let y = Math.floor(oy);
		let z = Math.floor(oz);

		const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
		const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
		const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

		const invDx = stepX === 0 ? Infinity : 1 / Math.abs(dx);
		const invDy = stepY === 0 ? Infinity : 1 / Math.abs(dy);
		const invDz = stepZ === 0 ? Infinity : 1 / Math.abs(dz);

		const nextBoundaryX = stepX > 0 ? x + 1 : x;
		const nextBoundaryY = stepY > 0 ? y + 1 : y;
		const nextBoundaryZ = stepZ > 0 ? z + 1 : z;

		let tMaxX = stepX === 0 ? Infinity : (nextBoundaryX - ox) / dx;
		let tMaxY = stepY === 0 ? Infinity : (nextBoundaryY - oy) / dy;
		let tMaxZ = stepZ === 0 ? Infinity : (nextBoundaryZ - oz) / dz;

		const tDeltaX = invDx;
		const tDeltaY = invDy;
		const tDeltaZ = invDz;

		// Skip the voxel the ray starts in (avoids "picking yourself" when inside a block)
		let t = 0;
		let nx = 0;
		let ny = 0;
		let nz = 0;

		while (true) {
			if (tMaxX < tMaxY) {
				if (tMaxX < tMaxZ) {
					x += stepX;
					t = tMaxX;
					tMaxX += tDeltaX;
					nx = -stepX;
					ny = 0;
					nz = 0;
				} else {
					z += stepZ;
					t = tMaxZ;
					tMaxZ += tDeltaZ;
					nx = 0;
					ny = 0;
					nz = -stepZ;
				}
			} else {
				if (tMaxY < tMaxZ) {
					y += stepY;
					t = tMaxY;
					tMaxY += tDeltaY;
					nx = 0;
					ny = -stepY;
					nz = 0;
				} else {
					z += stepZ;
					t = tMaxZ;
					tMaxZ += tDeltaZ;
					nx = 0;
					ny = 0;
					nz = -stepZ;
				}
			}

			if (t > maxDistance) return null;

			const blockId = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
			if (shouldHitBlockId(x, y, z, blockId)) {
				const blockState = ChunkLoadingSystem.getBlockStateByWorldCoords(
					x,
					y,
					z,
				);
				if (CrossHair.#isFullBlockShape(blockId, blockState)) {
					const out = CrossHair.#sharedHit;
					out.x = x;
					out.y = y;
					out.z = z;
					out.nx = nx;
					out.ny = ny;
					out.nz = nz;
					out.t = t;
					return out;
				}

				const tExit = Math.min(tMaxX, tMaxY, tMaxZ, maxDistance);
				const shapeHit = CrossHair.#raycastShapeInVoxel(
					ox,
					oy,
					oz,
					dx,
					dy,
					dz,
					x,
					y,
					z,
					blockId,
					blockState,
					t,
					tExit,
					nx,
					ny,
					nz,
				);
				if (shapeHit) {
					const out = CrossHair.#sharedHit;
					out.x = x;
					out.y = y;
					out.z = z;
					out.nx = shapeHit.nx;
					out.ny = shapeHit.ny;
					out.nz = shapeHit.nz;
					out.t = shapeHit.t;
					return out;
				}
			}
		}
	}

	static #isFullBlockShape(blockId: number, blockState: number): boolean {
		const slice = (blockState >> 3) & 7;
		if (slice !== 0) return false;
		const shape = getShapeForBlockId(blockId);
		if (shape.name === "cube") return true;
		if (!shape.usesSliceState) return false;
		if (shape.boxes.length !== 1) return false;
		const box = shape.boxes[0];
		return (
			box.faceMask === FACE_ALL &&
			box.min[0] === 0 &&
			box.min[1] === 0 &&
			box.min[2] === 0 &&
			box.max[0] === 1 &&
			box.max[1] === 1 &&
			box.max[2] === 1
		);
	}

	static #intersectRayAabbSegment(
		ox: number,
		oy: number,
		oz: number,
		dx: number,
		dy: number,
		dz: number,
		minX: number,
		minY: number,
		minZ: number,
		maxX: number,
		maxY: number,
		maxZ: number,
		tMin: number,
		tMax: number,
		fallbackNx: number,
		fallbackNy: number,
		fallbackNz: number,
	): { t: number; nx: number; ny: number; nz: number } | null {
		const eps = 1e-8;
		let t0 = tMin;
		let t1 = tMax;
		let hitNx = 0;
		let hitNy = 0;
		let hitNz = 0;

		const origins = [ox, oy, oz];
		const dirs = [dx, dy, dz];
		const mins = [minX, minY, minZ];
		const maxs = [maxX, maxY, maxZ];

		for (let axis = 0; axis < 3; axis++) {
			const o = origins[axis];
			const d = dirs[axis];
			const mn = mins[axis];
			const mx = maxs[axis];

			if (Math.abs(d) < eps) {
				if (o < mn || o > mx) return null;
				continue;
			}

			const tToMin = (mn - o) / d;
			const tToMax = (mx - o) / d;
			let near = tToMin;
			let far = tToMax;
			let nearNx = 0;
			let nearNy = 0;
			let nearNz = 0;

			if (axis === 0) {
				nearNx = -1;
			} else if (axis === 1) {
				nearNy = -1;
			} else {
				nearNz = -1;
			}

			if (tToMin > tToMax) {
				near = tToMax;
				far = tToMin;
				nearNx = -nearNx;
				nearNy = -nearNy;
				nearNz = -nearNz;
			}

			if (near > t0) {
				t0 = near;
				hitNx = nearNx;
				hitNy = nearNy;
				hitNz = nearNz;
			}
			if (far < t1) {
				t1 = far;
			}
			if (t0 > t1) return null;
		}

		if (t0 < tMin || t0 > tMax) return null;
		if (hitNx === 0 && hitNy === 0 && hitNz === 0) {
			hitNx = fallbackNx;
			hitNy = fallbackNy;
			hitNz = fallbackNz;
		}
		return { t: t0, nx: hitNx, ny: hitNy, nz: hitNz };
	}

	static #raycastShapeInVoxel(
		ox: number,
		oy: number,
		oz: number,
		dx: number,
		dy: number,
		dz: number,
		vx: number,
		vy: number,
		vz: number,
		blockId: number,
		blockState: number,
		tEnter: number,
		tExit: number,
		fallbackNx: number,
		fallbackNy: number,
		fallbackNz: number,
	): { t: number; nx: number; ny: number; nz: number } | null {
		let bestHit: { t: number; nx: number; ny: number; nz: number } | null =
			null;
		for (const transformed of getTransformedShapeBoxes(blockId, blockState)) {
			const hit = CrossHair.#intersectRayAabbSegment(
				ox,
				oy,
				oz,
				dx,
				dy,
				dz,
				vx + transformed.min[0],
				vy + transformed.min[1],
				vz + transformed.min[2],
				vx + transformed.max[0],
				vy + transformed.max[1],
				vz + transformed.max[2],
				tEnter,
				tExit,
				fallbackNx,
				fallbackNy,
				fallbackNz,
			);
			if (!hit) continue;
			if (!bestHit || hit.t < bestHit.t) bestHit = hit;
		}

		return bestHit;
	}

	static #isInsideMeshBounds(mesh: AbstractMesh, point: Vector3): boolean {
		if (mesh.isDisposed()) return false;
		const bounds = mesh.getBoundingInfo().boundingBox;
		const min = bounds.minimumWorld;
		const max = bounds.maximumWorld;
		const eps = CrossHair.#meshBoundsEpsilon;
		return (
			point.x >= min.x - eps &&
			point.x <= max.x + eps &&
			point.y >= min.y - eps &&
			point.y <= max.y + eps &&
			point.z >= min.z - eps &&
			point.z <= max.z + eps
		);
	}

	static #rayMarchFirstMesh(
		player: Player,
		maxDistance: number,
		predicate?: (mesh: AbstractMesh) => boolean,
	): AbstractMesh | null {
		const ray = CrossHair.#getSharedForwardRay(player, maxDistance);
		const sceneMeshes = player.playerVehicle.scene.meshes;
		const candidates = sceneMeshes.filter((mesh) => {
			if (!mesh.isPickable || !mesh.isEnabled()) return false;
			if (predicate) return predicate(mesh);
			return true;
		});
		if (candidates.length === 0) return null;

		const origin = ray.origin;
		const dir = ray.direction;
		const marchLength = ray.length;
		const step = CrossHair.#meshRayMarchStep;
		const p = CrossHair.#sharedPoint;

		for (let t = 0; t <= marchLength; t += step) {
			p.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
			for (const mesh of candidates) {
				if (CrossHair.#isInsideMeshBounds(mesh, p)) {
					return mesh;
				}
			}
		}

		return null;
	}

	public static pickUsableMesh(
		player: Player,
		maxDistance = Player.REACH_DISTANCE,
	): AbstractMesh | null {
		return CrossHair.#rayMarchFirstMesh(player, maxDistance, (mesh) => {
			const metadata = mesh.metadata;
			return metadata instanceof MetadataContainer && metadata.has("use");
		});
	}

	/**
	 * Returns the block ID at the position that the player is currently
	 * looking at, or null if no block is hit.
	 * @param player The player to check for.
	 * @returns The block ID at the position that the player is currently
	 *          looking at, or null if no block is hit.
	 */
	public static pickBlock(player: Player): number | null {
		const pos = CrossHair.pickTarget(player);
		if (!pos) return null;
		return ChunkLoadingSystem.getBlockByWorldCoords(pos.x, pos.y, pos.z);
	}
	/**
	 * Returns the first solid non-water block position along the player's view ray.
	 */
	public static pickTarget(player: Player): Vector3 | null {
		const hit = CrossHair.#raycastFirstBlock(player, (_x, _y, _z, blockId) =>
			isCollidableBlock(blockId),
		);
		if (!hit) return null;
		return new Vector3(hit.x, hit.y, hit.z);
	}

	public static pickWaterPlacementTarget(player: Player): Vector3 | null {
		const hit = CrossHair.#raycastFirstBlock(
			player,
			(_x, _y, _z, blockId) => blockId === BlockType.Water,
		);
		if (!hit) return null;
		return new Vector3(hit.x, hit.y, hit.z);
	}

	public static getPlacementPosition(player: Player): Vector3 | null {
		const hit = CrossHair.#raycastFirstBlock(player, (_x, _y, _z, blockId) =>
			isCollidableBlock(blockId),
		);
		if (!hit) return null;

		const hitPos = new Vector3(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz);
		return new Vector3(
			Math.floor(hitPos.x),
			Math.floor(hitPos.y),
			Math.floor(hitPos.z),
		);
	}
	public static getPlacementHit(player: Player): {
		pos: Vector3;
		nx: number;
		ny: number;
		nz: number;
		hitFracX: number;
		hitFracY: number;
		hitFracZ: number;
	} | null {
		const hit = CrossHair.#raycastFirstBlock(player, (_x, _y, _z, blockId) =>
			isCollidableBlock(blockId),
		);
		if (!hit) return null;

		const ray = CrossHair.#getSharedForwardRay(player, Player.REACH_DISTANCE);

		// exact world position where the ray struck the block face
		const worldHitX = ray.origin.x + ray.direction.x * hit.t;
		const worldHitY = ray.origin.y + ray.direction.y * hit.t;
		const worldHitZ = ray.origin.z + ray.direction.z * hit.t;

		// fractional position within the block
		const hitFracX = worldHitX - Math.floor(worldHitX);
		// fractional position within the block (0 = bottom, 1 = top)
		const hitFracY = worldHitY - Math.floor(worldHitY);
		const hitFracZ = worldHitZ - Math.floor(worldHitZ);

		const hitPos = new Vector3(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz);
		const pos = new Vector3(
			Math.floor(hitPos.x),
			Math.floor(hitPos.y),
			Math.floor(hitPos.z),
		);

		return {
			pos,
			nx: hit.nx,
			ny: hit.ny,
			nz: hit.nz,
			hitFracX,
			hitFracY,
			hitFracZ,
		};
	}

	setCrosshair(number: string) {
		this.#crosshair.source = `/texture/gui/kenney_crosshair-pack/PNG/Outline Retina/crosshair${number}.png`;
	}
}
