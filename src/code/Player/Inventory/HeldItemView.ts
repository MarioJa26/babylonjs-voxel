import {
	addToScene,
	createMeshFromData,
	type Mesh,
	onSceneDispose,
	removeFromScene,
	type SceneContext,
	type ShaderMaterial,
	setShaderTexture,
	setShaderUniform,
	setShaderVector3,
} from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import { isRegisteredBlockId } from "@/code/World/Shape/BlockShapes";
import { getAtlasTile } from "@/code/World/Texture/BlockTextures";
import {
	atlasSize,
	atlasTileSize,
	getDiffuseTexture2D,
} from "@/code/World/Texture/TextureAtlasFactory";
import type { Player } from "../Player";
import {
	acquireDroppedItemMaterial,
	acquireSpriteMaterial,
	getBillboardQuadGeometry,
	getBlockItemGeometry,
	getIconTexture,
	PLACEHOLDER_ICON_URL,
	releaseDroppedItemMaterial,
	releaseSpriteMaterial,
} from "./DroppedItem";

/**
 * First-person held-item viewmodel: renders the selected hotbar item
 * bottom-right of the camera, Minecraft-style.
 *
 * One cached mesh per distinct icon / block id (only one visible at a
 * time): a billboarded icon quad for art-backed items (tools, food,
 * eggs, ...) and a small atlas-textured cube for block items (which have
 * no icon PNG). Both reuse the DroppedItem material pools and geometry
 * caches, so the viewmodel costs no extra pipelines or textures.
 *
 * Engine rule (see removeFromScene docs): a mesh removed from its last
 * scene is retired — re-adding throws. Meshes are therefore added to the
 * scene exactly once and only ever toggled via `visible`. Hidden in third
 * person, with an empty hand, or before the scene exists.
 *
 * Hot-path note: `update()` runs every frame, but the selected hotbar
 * item usually doesn't change frame-to-frame. The active selection is
 * therefore tracked directly (`_activeKind`/`_activeIcon`/
 * `_activeBlockId`/`_activeMesh`) instead of being rebuilt from a
 * template-string key each call. On an unchanged frame this drops the
 * per-frame cost to a couple of field reads and comparisons — no Map
 * lookups, no LRU reinsertion, no full-cache visibility sweep, and no
 * object allocation. That machinery only runs on the (rare) frame where
 * the selection actually changes.
 *
 * Per-frame writes are limited to what can actually change frame-to-frame
 * (position, rotation) — scaling is constant per kind, so it's written
 * once when a mesh is created rather than redundantly every frame.
 */

const FORWARD_DIST = 0.55;
const RIGHT_DIST = 0.3;
const DOWN_DIST = 0.3;
const SPRITE_SCALE = 0.3;
const CUBE_SCALE = 0.22;
const CUBE_YAW_OFFSET = 0.6;
const CUBE_PITCH = 0.45;
const SPRITE_TILT = -0.1;
const SWING_DURATION = 0.28;
const SWING_DIP = 0.16;
const SWING_PUSH = 0.07;
/** Upper bound on cached viewmodel meshes; oldest unused entry is retired. */
const MAX_ENTRIES = 32;

type SpriteEntry = {
	mesh: Mesh;
	material: ShaderMaterial;
	icon: string;
	/** True once a texture is bound (mesh is in the scene from then on). */
	bound: boolean;
	/** True while an icon load is in flight (never start two). */
	binding: boolean;
};

type CubeEntry = {
	mesh: Mesh;
	material: ShaderMaterial;
	blockId: number;
	blockState: number;
	/** True once the atlas is bound (mesh is in the scene from then on). */
	bound: boolean;
};

class HeldItemView {
	private _sprites = new Map<string, SpriteEntry>();
	private _cubes = new Map<string, CubeEntry>();

	// Currently-shown selection. Declared up front (fixed hidden class,
	// no shape transitions) and updated only when the selection changes;
	// `_activeMesh` is null whenever nothing is visible, including while
	// a newly-selected entry's texture/atlas bind is still in flight.
	private _activeKind: "sprite" | "cube" | null = null;
	private _activeIcon: string | null = null;
	private _activeBlockId: number | null = null;
	private _activeBlockState: number | null = null;
	private _activeMesh: Mesh | null = null;

	private _swingT = Number.POSITIVE_INFINITY;
	private _disposed = false;
	private _updateFailed = false;

	constructor() {
		onSceneDispose(Map1.mainScene, () => {
			this._dispose();
		});
	}

	/** Punch/mining swing: dip the held item briefly. */
	swing(): void {
		if (this._disposed) return;
		this._swingT = 0;
	}

	update(player: Player, dt: number): void {
		if (this._disposed) return;

		// A cosmetic feature must never take down the game loop: report
		// the first failure with context, then keep trying (transient
		// errors recover on later frames).
		try {
			this._updateInner(player, dt);
		} catch (error) {
			if (!this._updateFailed) {
				this._updateFailed = true;
				console.error("[HeldItemView] per-frame update failed:", error);
			}
		}
	}

	private _updateInner(player: Player, dt: number): void {
		const item =
			player.playerInventory.inventory[0]?.[player.playerHud.selectedHotbarSlot]
				?.item ?? null;

		// Third-person body is visible instead; empty hands show nothing.
		if (player.playerCamera.isThirdPerson || item === null) {
			this._clearActive();
			return;
		}

		const useSprite =
			!isRegisteredBlockId(item.blockId ?? -1) && item.icon !== "";
		const blockId = item.blockId ?? -1;
		const blockState = item.blockState ?? 0;

		const changed = useSprite
			? this._activeKind !== "sprite" || this._activeIcon !== item.icon
			: this._activeKind !== "cube" ||
				this._activeBlockId !== blockId ||
				this._activeBlockState !== blockState;
		if (changed) {
			this._select(useSprite, item.icon, blockId, blockState);
		}

		const mesh = this._activeMesh;
		if (!mesh) return; // texture/atlas bind still in flight

		// Lens straight from the player camera (same source as the block
		// raycaster — never a possibly-stale matrix).
		const cam = player.playerCamera.playerCamera;
		const camPos = cam.position;
		const camTgt = cam.target;
		const camX = camPos.x;
		const camY = camPos.y;
		const camZ = camPos.z;
		let fwdX = camTgt.x - camX;
		let fwdY = camTgt.y - camY;
		let fwdZ = camTgt.z - camZ;
		const fwdLen = Math.sqrt(fwdX * fwdX + fwdY * fwdY + fwdZ * fwdZ);
		if (fwdLen > 0.0001) {
			fwdX /= fwdLen;
			fwdY /= fwdLen;
			fwdZ /= fwdLen;
		} else {
			fwdX = 0;
			fwdY = 0;
			fwdZ = 1;
		}
		// Screen-right from the camera yaw (matches the movement mapping:
		// at yaw 0 the camera faces +Z and strafe-right moves +X).
		const camYaw = player.playerCamera.cameraYaw;
		const rightX = Math.cos(camYaw);
		const rightY = 0;
		const rightZ = -Math.sin(camYaw);
		// No camera roll exists, so world-up is exact here.
		const upX = 0;
		const upY = 1;
		const upZ = 0;

		// Swing dip: down a touch and forward along the view. Advancing
		// swingT and deriving dip from it are combined into one branch
		// (rather than two separate `swingT < SWING_DURATION` checks) —
		// nothing in between depends on swingT, so there's no reason to
		// test it twice on every frame.
		let dip = 0;
		if (this._swingT < SWING_DURATION) {
			this._swingT = Math.min(SWING_DURATION, this._swingT + dt);
			dip = Math.sin((this._swingT / SWING_DURATION) * Math.PI);
		}
		const dipDown = dip * SWING_DIP;
		const dipFwd = dip * SWING_PUSH;

		const px =
			camX +
			fwdX * (FORWARD_DIST + dipFwd) +
			rightX * RIGHT_DIST -
			upX * (DOWN_DIST + dipDown);
		const py =
			camY +
			fwdY * (FORWARD_DIST + dipFwd) +
			rightY * RIGHT_DIST -
			upY * (DOWN_DIST + dipDown);
		const pz =
			camZ +
			fwdZ * (FORWARD_DIST + dipFwd) +
			rightZ * RIGHT_DIST -
			upZ * (DOWN_DIST + dipDown);

		// Yaw the item to face the camera (same convention as dropped-item
		// billboarding: local +Z ends up pointing at the lens).
		const yaw = Math.atan2(camX - px, camZ - pz);
		mesh.position.set(px, py, pz);
		// Scaling is constant per kind and set once at mesh creation (see
		// _getSprite/_getCube) — only rotation needs a per-frame write.
		if (this._activeKind === "sprite") {
			mesh.rotation.set(SPRITE_TILT - dip * 0.4, yaw, 0);
		} else {
			mesh.rotation.set(CUBE_PITCH - dip * 0.4, yaw + CUBE_YAW_OFFSET, 0);
		}
	}

	/** Hide whatever's currently shown and clear the active selection. */
	private _clearActive(): void {
		if (this._activeKind === null) return; // already clear — skip the writes
		if (this._activeMesh) this._activeMesh.visible = false;
		this._activeMesh = null;
		this._activeKind = null;
		this._activeIcon = null;
		this._activeBlockId = null;
		this._activeBlockState = null;
	}

	/**
	 * Switch the active selection to `icon`/`blockId`. Only called on the
	 * frame the hotbar selection actually changes. Hides the previous
	 * mesh (if any — cheap direct toggle, no cache-wide sweep needed
	 * since at most one mesh is ever visible), then gets-or-creates the
	 * target entry and shows it immediately if already bound.
	 */
	private _select(
		useSprite: boolean,
		icon: string,
		blockId: number,
		blockState: number,
	): void {
		if (this._activeMesh) this._activeMesh.visible = false;
		this._activeMesh = null;
		this._activeKind = useSprite ? "sprite" : "cube";
		this._activeIcon = useSprite ? icon : null;
		this._activeBlockId = useSprite ? null : blockId;
		this._activeBlockState = useSprite ? null : blockState;

		const entry = useSprite
			? this._getSprite(icon)
			: this._getCube(blockId, blockState);
		if (entry.bound) {
			entry.mesh.visible = true;
			this._activeMesh = entry.mesh;
		}
	}

	private _getSprite(icon: string): SpriteEntry {
		let entry = this._sprites.get(icon);
		if (entry) {
			// Refresh recency for eviction.
			this._sprites.delete(icon);
			this._sprites.set(icon, entry);
			return entry;
		}

		this._evictIfNeeded();
		const quad = getBillboardQuadGeometry();
		const mesh = createMeshFromData(
			Map1.engine,
			"heldItemSprite",
			quad.positions,
			quad.normals,
			quad.indices,
			quad.uvs,
		);
		mesh.pickable = false;
		mesh.visible = false;
		// Scale is constant for the lifetime of this mesh — set once here
		// instead of every frame in _updateInner.
		mesh.scaling.set(SPRITE_SCALE, SPRITE_SCALE, SPRITE_SCALE);
		const material = acquireSpriteMaterial(icon);
		mesh.material = material;
		setShaderUniform(material, "uScale", 1);
		setShaderUniform(material, "uOffset", [0, 0]);
		// Pooled materials carry whatever tint the previous holder left:
		// dropped sprites get theirs from voxel lighting, but the hand is
		// fullbright, so reset to white or icons render black.
		setShaderVector3(material, "tintColor", [1, 1, 1]);
		entry = { mesh, material, icon, bound: false, binding: false };
		this._sprites.set(icon, entry);

		entry.binding = true;
		void getIconTexture(icon)
			.then((tex) => {
				if (tex) return tex;
				if (icon === PLACEHOLDER_ICON_URL) return null;
				return getIconTexture(PLACEHOLDER_ICON_URL);
			})
			.then((tex) => {
				entry.binding = false;
				// Drop stale results: a newer entry or session took over.
				if (this._disposed || !tex || this._sprites.get(icon) !== entry) {
					return;
				}
				setShaderTexture(material, "diffuseTexture", tex);
				entry.bound = true;
				addToScene(Map1.mainScene, mesh);
				if (this._activeKind === "sprite" && this._activeIcon === icon) {
					mesh.visible = true;
					this._activeMesh = mesh;
				}
			});
		return entry;
	}

	private _getCube(blockId: number, blockState: number): CubeEntry {
		const key = `${blockId}:${blockState & 63}`;
		let entry = this._cubes.get(key);
		if (entry) {
			// Refresh recency for eviction.
			this._cubes.delete(key);
			this._cubes.set(key, entry);
			this._finishCubeBind(entry);
			return entry;
		}

		this._evictIfNeeded();
		const cube = getBlockItemGeometry(blockId, blockState);
		const mesh = createMeshFromData(
			Map1.engine,
			"heldItemCube",
			cube.positions,
			cube.normals,
			cube.indices,
			cube.uvs,
		);
		mesh.pickable = false;
		mesh.visible = false;
		// Scale is constant for the lifetime of this mesh — set once here
		// instead of every frame in _updateInner.
		mesh.scaling.set(CUBE_SCALE, CUBE_SCALE, CUBE_SCALE);
		const material = acquireDroppedItemMaterial(blockId);
		mesh.material = material;

		// Same atlas tile mapping as a dropped cube of this block.
		const tile = getAtlasTile(blockId) ?? [0, 0];
		const tileSize = atlasTileSize;
		const clampedX = Math.max(0, Math.min(atlasSize - 1, tile[0]));
		const clampedY = Math.max(0, Math.min(atlasSize - 1, tile[1]));
		const atlasRow = atlasSize - 1 - clampedY;
		setShaderUniform(material, "uScale", tileSize);
		setShaderUniform(material, "uOffset", [
			clampedX * tileSize,
			atlasRow * tileSize,
		]);
		// Fullbright hand lighting (Minecraft-style; the hand ignores
		// voxel darkness so the held item stays readable).
		setShaderVector3(material, "tintColor", [1, 1, 1]);
		entry = { mesh, material, blockId, blockState, bound: false };
		this._cubes.set(key, entry);

		this._finishCubeBind(entry);
		return entry;
	}

	/** Bind the shared atlas to a cube entry once it exists; retried. */
	private _finishCubeBind(entry: CubeEntry): void {
		if (entry.bound || this._disposed) return;
		const atlas = getDiffuseTexture2D();
		if (!atlas) return;

		setShaderTexture(entry.material, "diffuseTexture", atlas);
		entry.bound = true;
		addToScene(Map1.mainScene, entry.mesh);
		if (
			this._activeKind === "cube" &&
			this._activeBlockId === entry.blockId &&
			this._activeBlockState === entry.blockState
		) {
			entry.mesh.visible = true;
			this._activeMesh = entry.mesh;
		}
	}

	/** Retire the least-recently shown entry to bound mesh count. */
	private _evictIfNeeded(): void {
		while (this._sprites.size + this._cubes.size >= MAX_ENTRIES) {
			const oldestSprite = this._sprites.keys().next();
			const spriteKey = oldestSprite.done ? null : oldestSprite.value;
			if (
				spriteKey !== null &&
				!(this._activeKind === "sprite" && this._activeIcon === spriteKey)
			) {
				this._retireSprite(spriteKey);
				continue;
			}
			const oldestCube = this._cubes.keys().next();
			const cubeKey = oldestCube.done ? null : oldestCube.value;
			if (
				cubeKey !== null &&
				!(
					this._activeKind === "cube" &&
					this._cubes.get(cubeKey)?.blockId === this._activeBlockId &&
					this._cubes.get(cubeKey)?.blockState === this._activeBlockState
				)
			) {
				this._retireCube(cubeKey);
				continue;
			}
			return;
		}
	}

	private _retireSprite(icon: string): void {
		const entry = this._sprites.get(icon);
		if (!entry) return;
		this._sprites.delete(icon);
		if (this._activeMesh === entry.mesh) this._activeMesh = null;
		removeFromScene(Map1.mainScene, entry.mesh);
		releaseSpriteMaterial(entry.icon, entry.material);
	}

	private _retireCube(key: string): void {
		const entry = this._cubes.get(key);
		if (!entry) return;
		this._cubes.delete(key);
		if (this._activeMesh === entry.mesh) this._activeMesh = null;
		removeFromScene(Map1.mainScene, entry.mesh);
		releaseDroppedItemMaterial(entry.blockId, entry.material);
	}

	private _dispose(): void {
		if (this._disposed) return;
		this._disposed = true;

		for (const icon of [...this._sprites.keys()]) this._retireSprite(icon);
		for (const id of [...this._cubes.keys()]) this._retireCube(id);
		this._activeMesh = null;
		this._activeKind = null;
		this._activeIcon = null;
		this._activeBlockId = null;
		this._activeBlockState = null;
	}
}

let instance: HeldItemView | null = null;
let instanceScene: SceneContext | null = null;

/**
 * Per-frame viewmodel sync; safe to call before the scene exists. The
 * singleton is keyed by scene: joining a new world recreates it so the
 * viewmodel can never stay stuck on (or disposed with) a dead scene.
 */
export function updateHeldItemView(player: Player, dt: number): void {
	const scene = Map1.mainScene ?? null;
	if (instance && instanceScene !== scene) {
		instance = null;
	}
	try {
		if (!instance) {
			instance = new HeldItemView();
			instanceScene = scene;
		}
	} catch {
		return;
	}
	instance.update(player, dt);
}

/** Punch/mining swing feedback for the held item. */
export function swingHeldItemView(): void {
	instance?.swing();
}
