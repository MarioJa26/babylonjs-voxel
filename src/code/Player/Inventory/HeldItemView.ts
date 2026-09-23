import {
	addToScene,
	createMeshFromData,
	createShaderMaterial,
	createSolidTexture2D,
	type EngineContext,
	type Mesh,
	onSceneDispose,
	removeFromScene,
	type SceneContext,
	type ShaderMaterial,
	setShaderTexture,
	setShaderUniform,
	setShaderVector3,
	type Texture2D,
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
 * One cached mesh per icon / block id (only one visible at a time): an
 * icon quad for art-backed items (tools, food, ...) and a small
 * atlas-textured cube for block items. Geometry and icon PNGs are shared
 * with DroppedItem's caches, so the viewmodel adds no pipelines.
 *
 * Engine rule (see removeFromScene docs): a mesh removed from its last
 * scene is retired — re-adding throws. Meshes are therefore added exactly
 * once and only ever toggled via `visible`. Hidden in third person, with
 * an empty hand, or before the scene exists.
 *
 * Hot path: `update()` runs every frame but the selection rarely changes,
 * so it's tracked as a single key (one comparison per frame; no Map
 * lookups, no allocation). Shown entries render from placeholder textures
 * until the real icon/atlas lands, so swapping slots never blanks the hand.
 * Per-frame writes are position + orientation only; scale is set once at
 * mesh creation.
 */

const FORWARD_DIST = 0.55;
const RIGHT_DIST = 0.3;
const DOWN_DIST = 0.3;
const SPRITE_SCALE = 0.3;
const CUBE_SCALE = 0.22;
const CUBE_YAW_OFFSET = 0.6;
/**
 * Static yaw the legacy world-space billboard baked in: the item sits
 * RIGHT_DIST off the lens axis, so facing the camera meant turning
 * atan2(RIGHT_DIST, FORWARD_DIST) ≈ 0.5 past face-on. Preserved so the
 * rest framing matches what players know (angled tool, 3-face block).
 */
const LEGACY_YAW_OFFSET = 0.5;
/**
 * Rest tilts in camera space, solved numerically against the engine's own
 * quat/matrix functions to reproduce the legacy rest faces (old tuning was
 * SPRITE_TILT −0.1 / CUBE_PITCH 0.45 in pitch-outer Euler, which is a
 * different frame — see the yaw-outer note at the rotation write).
 */
const SPRITE_REST_TILT = 0.088;
const CUBE_REST_TILT = -0.199;
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

type QuatTuple = [number, number, number, number];

/** Write qY(yaw) * qX(pitch) into out. */
function setYawOuter(out: QuatTuple, yaw: number, pitch: number): void {
	const sy = Math.sin(yaw * 0.5);
	const cy = Math.cos(yaw * 0.5);
	const sx = Math.sin(pitch * 0.5);
	const cx = Math.cos(pitch * 0.5);
	out[0] = cy * sx;
	out[1] = sy * cx;
	out[2] = -sy * sx;
	out[3] = cy * cx;
}

/** out = a * b (b applies first). Alias-safe: a, b, out may overlap. */
function mulQuat(a: QuatTuple, b: QuatTuple, out: QuatTuple): void {
	const ax = a[0];
	const ay = a[1];
	const az = a[2];
	const aw = a[3];
	out[0] = aw * b[0] + ax * b[3] + ay * b[2] - az * b[1];
	out[1] = aw * b[1] - ax * b[2] + ay * b[3] + az * b[0];
	out[2] = aw * b[2] + ax * b[1] - ay * b[0] + az * b[3];
	out[3] = aw * b[3] - ax * b[0] - ay * b[1] - az * b[2];
}

// Per-frame composition scratch (module scope: no per-frame allocation).
const _qCam: QuatTuple = [0, 0, 0, 0];
const _qPunch: QuatTuple = [0, 0, 0, 0];
const _qMix: QuatTuple = [0, 0, 0, 0];

/**
 * Fixed rest orientation in CAMERA space (constant, so the item is exactly
 * rigid — zero drift at any look angle). Framing reproduces the legacy
 * rest faces (angled tool sprite, front-top-side cube).
 */
const SPRITE_BASE_Q: QuatTuple = [0, 0, 0, 0];
const CUBE_BASE_Q: QuatTuple = [0, 0, 0, 0];
setYawOuter(SPRITE_BASE_Q, Math.PI + LEGACY_YAW_OFFSET, SPRITE_REST_TILT);
setYawOuter(
	CUBE_BASE_Q,
	Math.PI + LEGACY_YAW_OFFSET + CUBE_YAW_OFFSET,
	CUBE_REST_TILT,
);

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

/**
 * Cache key: the icon URL for sprites, blockId * 64 + state for cubes.
 * Map keys compare by type, so string and number keys never collide.
 */
type EntryKey = string | number;

type Entry = {
	mesh: Mesh;
	material: ShaderMaterial;
	/** Sprite quad or atlas cube. */
	kind: "sprite" | "cube";
	/** True once the mesh entered the scene (exactly once — re-adding throws). */
	added: boolean;
};

/** Zero-allocation selection key for the per-frame change check. */
function entryKey(
	useSprite: boolean,
	icon: string,
	blockId: number,
	blockState: number,
): EntryKey {
	return useSprite ? icon : blockId * 64 + (blockState & 63);
}

export class HeldItemView {
	private _entries = new Map<EntryKey, Entry>();

	/** Voxel the environment light was last sampled from (per active entry). */
	private _activeLightX = Number.NaN;
	private _activeLightY = Number.NaN;
	private _activeLightZ = Number.NaN;
	private _lastSunDirY = Number.NaN;

	// Active selection: null when nothing is visible (third person, empty
	// hand) or the scene isn't ready yet. New selections show immediately
	// with placeholder textures, so a pending icon/atlas load never blanks
	// the hand.
	private _activeKey: EntryKey | null = null;
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
		this._syncSelection(useSprite, icon, blockId, blockState);
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
	 * Environment lighting: refresh the active tint only when the sampled
	 * voxel or sun vector changed (same voxel-crossing strategy as the
	 * third-person body). setShaderUniform copies values synchronously, so
	 * the shared packedLightToLightColor scratch can pass straight through.
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

		const material =
			this._activeKey === null
				? null
				: (this._entries.get(this._activeKey)?.material ?? null);
		if (material) {
			setShaderVector3(
				material,
				"lightColor",
				packedLightToLightColor(
					getLightByWorldCoords(x, y + PLAYER_LIGHT_SAMPLE_Y_OFFSET, z),
				),
			);
		}
	}

	/** Sun direction + day intensity uniforms shared by every held material. */
	private _writeSunUniforms(): void {
		const dir = GLOBAL_VALUES.skyLightDirection;
		// Negated so the vector points TOWARD the sun (terrain convention).
		const sun: [number, number, number] = [-dir.x, -dir.y, -dir.z];
		// Same day-factor formula as DroppedItem/BlockBreakParticles.
		const sunIntensity = Math.min(1, Math.max(0, (sun[1] + 0.1) * 4));
		for (const entry of this._entries.values()) {
			if (!entry.added) continue;
			setShaderUniform(entry.material, "lightDirection", sun);
			setShaderUniform(entry.material, "sunLightIntensity", sunIntensity);
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
		this._syncSelection(
			useSprite,
			item.icon,
			item.blockId ?? -1,
			item.blockState ?? 0,
		);
		const mesh = this._activeMesh;
		if (!mesh) return;

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
		const camPitch = player.playerCamera.cameraPitch;
		const rightX = Math.cos(camYaw);
		const rightZ = -Math.sin(camYaw);
		// Camera up, not world up: u = f × r. A world-up "down" offset
		// mixes frames and makes depth breathe with pitch; in the true
		// camera basis the offset is a constant (right, down, forward).
		const upX = fwdY * rightZ;
		const upY = fwdZ * rightX - fwdX * rightZ;
		const upZ = -fwdY * rightX;

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
			camY + fwdY * (FORWARD_DIST + punchFwd) - upY * (DOWN_DIST - punchUp);
		const pz =
			camZ +
			fwdZ * (FORWARD_DIST + punchFwd) +
			rightZ * RIGHT_DIST -
			upZ * (DOWN_DIST - punchUp);

		// Rigid viewmodel orientation: q = qCam * qPunch * qBase. qCam is the
		// camera world rotation, so the face-to-lens angle never changes;
		// qBase is the constant rest framing, qPunch the transient swing.
		setYawOuter(_qCam, camYaw, camPitch);
		const base =
			typeof this._activeKey === "string" ? SPRITE_BASE_Q : CUBE_BASE_Q;
		if (punch > 0) {
			// Legacy swing signs (twist +, tilt −), in camera space.
			setYawOuter(_qPunch, punch * PUNCH_TWIST, -punch * PUNCH_TILT);
			mulQuat(_qCam, _qPunch, _qMix);
			mulQuat(_qMix, base, _qMix);
		} else {
			mulQuat(_qCam, base, _qMix);
		}
		mesh.position.set(px, py, pz);
		// Scale is set once at mesh creation — only position + orientation here.
		mesh.rotationQuaternion.set(_qMix[0], _qMix[1], _qMix[2], _qMix[3]);
	}

	/**
	 * Track the current hotbar item (called every frame; the key compare is
	 * the fast path) and make sure its mesh is shown — placeholder texture
	 * until the real one lands, retried if the scene/atlas wasn't ready.
	 */
	private _syncSelection(
		useSprite: boolean,
		icon: string,
		blockId: number,
		blockState: number,
	): void {
		const key = entryKey(useSprite, icon, blockId, blockState);
		if (key !== this._activeKey) {
			if (this._activeMesh) this._activeMesh.visible = false;
			this._activeMesh = null;
			this._activeKey = key;
		}
		this._showActive();
	}

	private _showActive(): void {
		const key = this._activeKey;
		if (key === null || this._activeMesh || this._disposed) return;
		const entry =
			typeof key === "string" ? this._getSprite(key) : this._getCube(key);
		if (entry.added) {
			entry.mesh.visible = true;
			this._activeMesh = entry.mesh;
		}
	}

	/** Hide whatever's currently shown and clear the active selection. */
	private _clearActive(): void {
		if (this._activeKey === null) return; // already clear — skip the writes
		if (this._activeMesh) this._activeMesh.visible = false;
		this._activeMesh = null;
		this._activeKey = null;
	}

	/** Add a mesh to the scene exactly once (skipped until a scene exists). */
	private _ensureAdded(entry: Entry): void {
		if (entry.added || this._disposed || !Map1.mainScene) return;
		addToScene(Map1.mainScene, entry.mesh);
		entry.added = true;
	}

	/** Get-or-create + LRU refresh; ensures scene-add (and atlas for cubes). */
	private _getSprite(icon: string): Entry {
		const key: EntryKey = icon;
		let entry = this._entries.get(key);
		if (entry) {
			this._entries.delete(key);
			this._entries.set(key, entry);
			this._ensureAdded(entry);
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
		entry = { mesh, material, kind: "sprite", added: false };
		this._entries.set(key, entry);
		// Visible immediately with the white placeholder (samplers are
		// already bound, so the bind group is valid) — the icon upgrades
		// the texture in place when it resolves.
		this._ensureAdded(entry);

		void getIconTexture(icon)
			.then((tex) => {
				if (tex) return tex;
				if (icon === PLACEHOLDER_ICON_URL) return null;
				return getIconTexture(PLACEHOLDER_ICON_URL);
			})
			.then((tex) => {
				// Drop stale results: a newer entry or session took over.
				if (this._disposed || !tex || this._entries.get(key) !== entry) {
					return;
				}
				setShaderTexture(material, "diffuseTexture", tex);
				this._ensureAdded(entry);
				this._showActive();
			});
		return entry;
	}

	private _getCube(key: number): Entry {
		const blockId = (key / 64) | 0;
		const blockState = key % 64;
		let entry = this._entries.get(key);
		if (entry) {
			// Refresh recency for eviction.
			this._entries.delete(key);
			this._entries.set(key, entry);
			this._bindAtlas(entry);
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
		// Placeholder-first like sprites: _bindAtlas replaces the white
		// diffuse; the flat-normal fallback stays until the block normal
		// atlas swaps in.
		setShaderTexture(material, "diffuseTexture", getWhiteFallback(Map1.engine));
		setShaderTexture(
			material,
			"normalTexture",
			getFlatNormalFallback(Map1.engine),
		);
		entry = { mesh, material, kind: "cube", added: false };
		this._entries.set(key, entry);

		this._bindAtlas(entry);
		return entry;
	}

	/**
	 * Bind the shared atlas (idempotent — safe to retry every frame). The
	 * mesh is added with its white placeholder even while the atlas is
	 * missing, so selection never waits on it.
	 */
	private _bindAtlas(entry: Entry): void {
		if (this._disposed) return;
		this._ensureAdded(entry);
		const atlas = getDiffuseTexture2D();
		if (!atlas) return;

		setShaderTexture(entry.material, "diffuseTexture", atlas);
		// Same normal atlas the terrain uses, so held cubes shade like the
		// placed surface. Sprites keep the flat-normal fallback (no icon
		// normal art exists).
		const normals = getNormal();
		if (normals) {
			setShaderTexture(entry.material, "normalTexture", normals);
		}
	}

	/** Retire the least-recently shown entry to bound mesh count. */
	private _evictIfNeeded(): void {
		while (this._entries.size >= MAX_ENTRIES) {
			let victim: EntryKey | null = null;
			for (const key of this._entries.keys()) {
				if (key !== this._activeKey) {
					victim = key;
					break;
				}
			}
			if (victim === null) return;
			this._retire(victim);
		}
	}

	private _retire(key: EntryKey): void {
		const entry = this._entries.get(key);
		if (!entry) return;
		this._entries.delete(key);
		if (this._activeMesh === entry.mesh) this._activeMesh = null;
		if (entry.added && Map1.mainScene) {
			removeFromScene(Map1.mainScene, entry.mesh);
		}
		disposeItemMaterial(entry.material);
	}

	private _dispose(): void {
		if (this._disposed) return;
		this._disposed = true;

		for (const key of [...this._entries.keys()]) this._retire(key);
		this._activeMesh = null;
		this._activeKey = null;
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
