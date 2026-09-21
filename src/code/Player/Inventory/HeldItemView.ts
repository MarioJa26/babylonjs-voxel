import {
	addToScene,
	createMeshFromData,
	createShaderMaterial,
	createSolidTexture2D,
	type EngineContext,
	loadTexture2D,
	type Mesh,
	type Texture2D,
	onSceneDispose,
	removeFromScene,
	type SceneContext,
	type ShaderMaterial,
	setShaderTexture,
	setShaderUniform,
	setShaderVector3,
} from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import { getLightByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import { isRegisteredBlockId } from "@/code/World/Shape/BlockShapes";
import { getAtlasTile } from "@/code/World/Texture/BlockTextures";
import {
	atlasSize,
	atlasTileSize,
	getDiffuseTexture2D,
	getNormal,
} from "@/code/World/Texture/TextureAtlasFactory";
import type { Player } from "../Player";
import {
	PLAYER_LIGHT_SAMPLE_Y_OFFSET,
	PUNCH_DURATION_S,
	packedLightToLightColor,
	setRigHeldItemTransform,
} from "../PlayerModel";
import {
	getBillboardQuadGeometry,
	getBlockItemGeometry,
	getIconTexture,
	PLACEHOLDER_ICON_URL,
} from "./DroppedItem";
import { getRegisteredItemById } from "./ItemRegistry";

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
/** Forward thrust along the view at the middle of a punch (meters). */
const PUNCH_PUSH = 0.16;
/** Upward lift at the middle of a punch (meters). */
const PUNCH_RISE = 0.06;
/** Extra pitch at the middle of a punch (radians). */
const PUNCH_TILT = 0.7;
/** Yaw twist at the middle of a punch (radians). */
const PUNCH_TWIST = 0.35;
/** Upper bound on cached viewmodel meshes; oldest unused entry is retired. */
const MAX_ENTRIES = 32;

// ─── Held-item shader (normals + environment light) ──────────────────────────
// The shared DroppedItem material is unlit (diffuse × flat tint); the hand
// previously forced a white tint to stay readable. That made held blocks look
// flat next to the normal-mapped, sun-shaded terrain. This isolated material
// samples the SAME normal atlas the terrain uses (matched tile math), shades
// with GLOBAL_VALUES' sun direction / day factor, and re-tints from packed
// voxel light (packedLightToLightColor) so the item dims in caves and glows
// near torches, first-person and on the third-person avatar alike.

const heldItemVertexWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vNormal : vec3<f32>,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  out.pos = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.vUV = input.uv;
  out.vNormal = input.normal;
  return out;
}
`;

const heldItemFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vNormal : vec3<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let atlasUV = in.vUV * shaderUniforms.uScale + shaderUniforms.uOffset;
  let tex = textureSample(diffuseTexture, diffuseTextureSampler, atlasUV);
  // Alpha test for billboard item sprites (block atlas texels are opaque).
  if (tex.a < 0.5) { discard; }

  // Face normal straight from the mesh (per-face on cubes, +Z on sprites).
  let nWorld = normalize(in.vNormal);

  // Sun direction (terrain convention: lightDirection points TO the sun).
  let lightDirection = shaderUniforms.lightDirection;

  let diffuseIntensity = max(0.0, dot(nWorld, lightDirection));
  let halfwayDir = normalize(nWorld + lightDirection);
  let NH = max(dot(nWorld, halfwayDir), 0.0);
  let spec = exp2(clamp(32.0 * 1.4427 * (NH - 1.0), -126.0, 0.0));

  let skyLight = shaderUniforms.lightColor;
  let sunIntensity = shaderUniforms.sunLightIntensity;

  // Base voxel light (caves/torch) from packedLightToLightColor, plus a
  // sun-facing diffuse/spec bump scaled by how much sun actually hits.
  let lightMix = clamp(
    skyLight + diffuseIntensity * sunIntensity * 0.5,
    vec3<f32>(0.06),
    vec3<f32>(1.0)
  );

  let color =
    tex.rgb * lightMix +
    vec3<f32>(0.25) * spec * sunIntensity * skyLight.x;

  return vec4<f32>(color, 1.0);
}
`;

function createHeldItemMaterial(name: string): ShaderMaterial {
	return createShaderMaterial({
		name,
		vertexSource: heldItemVertexWGSL,
		fragmentSource: heldItemFragmentWGSL,
		attributes: ["position", "normal", "uv"],
		uniforms: [
			"world",
			"worldViewProjection",
			{ name: "uScale", type: "f32" },
			{ name: "uOffset", type: "vec2<f32>" },
			{ name: "tintColor", type: "vec3<f32>" },
			{ name: "lightColor", type: "vec3<f32>" },
			{ name: "lightDirection", type: "vec3<f32>" },
			{ name: "sunLightIntensity", type: "f32" },
		],
		samplers: ["diffuseTexture", "normalTexture"],
		backFaceCulling: true,
	});
}

// Lite's ShaderMaterial type exposes no dispose — call it structurally
// (same pattern as DroppedItem's local dispose? interface).
function disposeItemMaterial(mat: ShaderMaterial): void {
	(mat as unknown as { dispose?: () => void }).dispose?.();
}

// Cached solid placeholder textures so a mesh never draws with an unbound
// sampler (lite builds bind groups at renderable construction and throws
// #241 when a declared sampler has no Texture2D).
let whiteFallback: Texture2D | null = null;
function getWhiteFallback(engine: EngineContext): Texture2D {
	if (!whiteFallback) {
		whiteFallback = createSolidTexture2D(engine, 255, 255, 255, 255);
	}
	return whiteFallback;
}

let flatNormalFallback: Texture2D | null = null;
function getFlatNormalFallback(engine: EngineContext): Texture2D {
	if (!flatNormalFallback) {
		// RGB (128, 128, 255) is the neutral tangent-space normal: items
		// without normal art still shade like a flat surface.
		flatNormalFallback = createSolidTexture2D(engine, 128, 128, 255, 255);
	}
	return flatNormalFallback;
}

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

export class HeldItemView {
	private _sprites = new Map<string, SpriteEntry>();
	private _cubes = new Map<string, CubeEntry>();

	// Reused light-color tuple for the per-crossing tint write (no allocs).
	private _lightColor: [number, number, number] = [1, 1, 1];
	/** Voxel the environment light was last sampled from (per active entry). */
	private _activeLightX = Number.NaN;
	private _activeLightY = Number.NaN;
	private _activeLightZ = Number.NaN;
	private _lastSunDirY = Number.NaN;

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

	/** Punch/mining swing: thrust the held item briefly. */
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

	updateAvatar(
		itemId: number,
		blockState: number,
		body: Mesh,
		walkPhase: number,
		walkAmp: number,
		punchT = Number.POSITIVE_INFINITY,
	): void {
		if (this._disposed) return;
		const item = itemId === 0 ? undefined : getRegisteredItemById(itemId);
		if (!body.visible || !item) {
			this.hide();
			return;
		}
		const blockId = item.blockId ?? -1;
		const icon = item.icon || PLACEHOLDER_ICON_URL;
		const useSprite = !isRegisteredBlockId(blockId);
		blockState &= 63;
		const changed = useSprite
			? this._activeKind !== "sprite" || this._activeIcon !== icon
			: this._activeKind !== "cube" ||
				this._activeBlockId !== blockId ||
				this._activeBlockState !== blockState;
		if (changed) this._select(useSprite, icon, blockId, blockState);
		if (!this._activeMesh && this._activeKind === "cube") {
			this._getCube(blockId, blockState);
		}
		if (this._activeMesh) {
			this._updateEnvironmentLight(
				body.position.x,
				body.position.y,
				body.position.z,
			);
			setRigHeldItemTransform(
				this._activeMesh,
				body,
				walkPhase,
				walkAmp,
				punchT,
			);
		}
	}

	hide(): void {
		this._clearActive();
	}

	dispose(): void {
		this._dispose();
	}

	/**
	 * Environment lighting: refresh the active entry's tint only when the
	 * sampled voxel, the sun vector, or the day factor actually changed —
	 * the same voxel-crossing + re-sample strategy Player.ts uses for its
	 * third-person body, and the same light color math
	 * (packedLightToLightColor) mobs and dropped items share.
	 */
	private _updateEnvironmentLight(x: number, y: number, z: number): void {
		const dir = GLOBAL_VALUES.skyLightDirection;
		if (dir.y !== this._lastSunDirY) {
			this._lastSunDirY = dir.y;
			this._writeSunUniforms();
			// Sun moved -> re-derive the tint even in the same voxel.
			this._activeLightX = Number.NaN;
		}

		const lx = Math.floor(x);
		const ly = Math.floor(y + PLAYER_LIGHT_SAMPLE_Y_OFFSET);
		const lz = Math.floor(z);
		if (
			lx === this._activeLightX &&
			ly === this._activeLightY &&
			lz === this._activeLightZ
		) {
			return;
		}
		this._activeLightX = lx;
		this._activeLightY = ly;
		this._activeLightZ = lz;

		const packed = getLightByWorldCoords(
			x,
			y + PLAYER_LIGHT_SAMPLE_Y_OFFSET,
			z,
		);
		const c = packedLightToLightColor(packed);
		this._lightColor[0] = c[0];
		this._lightColor[1] = c[1];
		this._lightColor[2] = c[2];

		const entry = this._activeEntryMaterial();
		if (entry) setShaderVector3(entry, "lightColor", this._lightColor);
	}

	/** Sun direction + day intensity uniforms shared by every held material. */
	private _writeSunUniforms(): void {
		const dir = GLOBAL_VALUES.skyLightDirection;
		// Terrain shaders negate skyLightDirection so the vector points
		// TOWARD the sun (ChunkMesher.updateGlobalUniforms convention).
		const sunX = -dir.x;
		const sunY = -dir.y;
		const sunZ = -dir.z;
		// Same day-factor formula as DroppedItem/BlockBreakParticles.
		const sunIntensity = Math.min(1, Math.max(0, (sunY + 0.1) * 4));
		const u = [sunX, sunY, sunZ];
		for (const mat of this._liveMaterials()) {
			setShaderUniform(mat, "lightDirection", u);
			setShaderUniform(mat, "sunLightIntensity", sunIntensity);
		}
	}

	private _activeEntryMaterial(): ShaderMaterial | null {
		if (this._activeKind === "sprite") {
			const icon = this._activeIcon;
			return icon !== null ? (this._sprites.get(icon)?.material ?? null) : null;
		}
		if (this._activeKind === "cube") {
			for (const entry of this._cubes.values()) {
				if (
					entry.blockId === this._activeBlockId &&
					entry.blockState === this._activeBlockState
				) {
					return entry.material;
				}
			}
			return null;
		}
		return null;
	}

	/** Materials of all cached entries that currently have bound textures. */
	private *_liveMaterials(): Generator<ShaderMaterial> {
		for (const s of this._sprites.values()) if (s.bound) yield s.material;
		for (const c of this._cubes.values()) if (c.bound) yield c.material;
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

		this._updateEnvironmentLight(
			player.position.x,
			player.position.y,
			player.position.z,
		);

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

		// Punch thrust: forward along the view with a slight lift and
		// twist, peaking mid-swing. Advancing swingT and deriving the
		// curve from it are combined into one branch — nothing in between
		// depends on swingT, so there's no reason to test it twice.
		let punch = 0;
		if (this._swingT < PUNCH_DURATION_S) {
			this._swingT = Math.min(PUNCH_DURATION_S, this._swingT + dt);
			punch = Math.sin((this._swingT / PUNCH_DURATION_S) * Math.PI);
		}
		const punchFwd = punch * PUNCH_PUSH;
		const punchUp = punch * PUNCH_RISE;

		const px =
			camX +
			fwdX * (FORWARD_DIST + punchFwd) +
			rightX * RIGHT_DIST -
			upX * (DOWN_DIST - punchUp);
		const py =
			camY +
			fwdY * (FORWARD_DIST + punchFwd) +
			rightY * RIGHT_DIST -
			upY * (DOWN_DIST - punchUp);
		const pz =
			camZ +
			fwdZ * (FORWARD_DIST + punchFwd) +
			rightZ * RIGHT_DIST -
			upZ * (DOWN_DIST - punchUp);

		// Yaw the item to face the camera (same convention as dropped-item
		// billboarding: local +Z ends up pointing at the lens).
		const yaw = Math.atan2(camX - px, camZ - pz);
		mesh.position.set(px, py, pz);
		// Scaling is constant per kind and set once at mesh creation (see
		// _getSprite/_getCube) — only rotation needs a per-frame write.
		if (this._activeKind === "sprite") {
			mesh.rotation.set(
				SPRITE_TILT - punch * PUNCH_TILT,
				yaw + punch * PUNCH_TWIST,
				0,
			);
		} else {
			mesh.rotation.set(
				CUBE_PITCH - punch * PUNCH_TILT,
				yaw + CUBE_YAW_OFFSET + punch * PUNCH_TWIST,
				0,
			);
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
			new Uint32Array([...quad.indices, 0, 1, 2, 0, 2, 3]),
			quad.uvs,
		);
		mesh.pickable = false;
		mesh.visible = false;
		// Scale is constant for the lifetime of this mesh — set once here
		// instead of every frame in _updateInner.
		mesh.scaling.set(SPRITE_SCALE, SPRITE_SCALE, SPRITE_SCALE);
		const material = createHeldItemMaterial(`heldSprite_${icon}`);
		mesh.material = material;
		setShaderUniform(material, "uScale", 1);
		setShaderUniform(material, "uOffset", [0, 0]);
		setShaderVector3(material, "tintColor", [1, 1, 1]);
		// Bind placeholders synchronously (replaced by real textures when the
		// icon resolves) so the sampler is never unbound at construction.
		setShaderTexture(material, "diffuseTexture", getWhiteFallback(Map1.engine));
		setShaderTexture(
			material,
			"normalTexture",
			getFlatNormalFallback(Map1.engine),
		);
		entry = {
			mesh,
			material,
			icon,
			bound: false,
			binding: false,
		};
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
				// Sprite icons have no normal atlas tile: the flat-normal
				// fallback keeps them evenly lit by the environment instead.
				setShaderTexture(
					material,
					"normalTexture",
					getFlatNormalFallback(Map1.engine),
				);
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
		const material = createHeldItemMaterial(`heldCube_${blockId}`);
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
		setShaderVector3(material, "tintColor", [1, 1, 1]);
		// Same placeholder-first rule as sprites: the atlas bind in
		// _finishCubeBind replaces the white diffuse; the flat-normal
		// fallback stays until that bind swaps in the block normal atlas.
		setShaderTexture(material, "diffuseTexture", getWhiteFallback(Map1.engine));
		setShaderTexture(
			material,
			"normalTexture",
			getFlatNormalFallback(Map1.engine),
		);
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
		// Same normal atlas the terrain uses for this block, so held cubes
		// respond to bumps exactly like the placed surface. Sprites keep
		// their flat-normal fallback (no per-icon normal art exists).
		const normals = getNormal();
		if (normals) {
			setShaderTexture(entry.material, "normalTexture", normals);
		}
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
		disposeItemMaterial(entry.material);
	}

	private _retireCube(key: string): void {
		const entry = this._cubes.get(key);
		if (!entry) return;
		this._cubes.delete(key);
		if (this._activeMesh === entry.mesh) this._activeMesh = null;
		removeFromScene(Map1.mainScene, entry.mesh);
		disposeItemMaterial(entry.material);
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
