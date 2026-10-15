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
	setMeshVisible,
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
 * at the bottom-right of the camera, Minecraft-style.
 *
 * One cached mesh is maintained per icon or block/state combination, with
 * only one mesh visible at a time. Sprite and block geometry are shared with
 * the dropped-item implementation.
 *
 * A mesh removed from its last scene is considered retired and cannot safely
 * be added again. Consequently, an entry enters its scene exactly once and is
 * hidden or shown by changing its visibility.
 *
 * update() runs every frame, but changing the selected item is uncommon. The
 * active selection is therefore represented by one primitive key and one
 * direct Entry reference. No Map lookup or allocation is needed on the normal
 * unchanged-selection path.
 */

const FORWARD_DIST = 0.55;
const RIGHT_DIST = 0.3;
const DOWN_DIST = 0.3;

const SPRITE_SCALE = 0.3;
const CUBE_SCALE = 0.22;

const CUBE_YAW_OFFSET = 0.6;

/**
 * Static yaw used by the legacy world-space billboard.
 */
const LEGACY_YAW_OFFSET = 0.5;

/**
 * Fixed rest tilts in camera space.
 */
const SPRITE_REST_TILT = 0.088;
const CUBE_REST_TILT = -0.199;

/** Forward thrust along the view at the middle of a punch, in meters. */
const PUNCH_PUSH = 0.16;

/** Upward lift at the middle of a punch, in meters. */
const PUNCH_RISE = 0.06;

/** Additional pitch at the middle of a punch, in radians. */
const PUNCH_TILT = 0.7;

/** Yaw twist at the middle of a punch, in radians. */
const PUNCH_TWIST = 0.35;

/** Maximum number of cached viewmodel meshes. */
const MAX_ENTRIES = 32;

type QuatTuple = [number, number, number, number];

/**
 * Writes qY(yaw) * qX(pitch) into out.
 */
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

/**
 * Computes out = a * b, where b applies first.
 *
 * Alias-safe: a, b, and out may refer to the same tuple.
 */
function mulQuat(a: QuatTuple, b: QuatTuple, out: QuatTuple): void {
	const ax = a[0];
	const ay = a[1];
	const az = a[2];
	const aw = a[3];

	const bx = b[0];
	const by = b[1];
	const bz = b[2];
	const bw = b[3];

	out[0] = aw * bx + ax * bw + ay * bz - az * by;
	out[1] = aw * by - ax * bz + ay * bw + az * bx;
	out[2] = aw * bz + ax * by - ay * bx + az * bw;
	out[3] = aw * bw - ax * bx - ay * by - az * bz;
}

/**
 * Module-scoped quaternion scratch eliminates per-frame allocation.
 */
const _qCam: QuatTuple = [0, 0, 0, 0];
const _qPunch: QuatTuple = [0, 0, 0, 0];
const _qMix: QuatTuple = [0, 0, 0, 0];

/**
 * Fixed rest orientations in camera space.
 */
const SPRITE_BASE_Q: QuatTuple = [0, 0, 0, 0];
const CUBE_BASE_Q: QuatTuple = [0, 0, 0, 0];

setYawOuter(SPRITE_BASE_Q, Math.PI + LEGACY_YAW_OFFSET, SPRITE_REST_TILT);

setYawOuter(
	CUBE_BASE_Q,
	Math.PI + LEGACY_YAW_OFFSET + CUBE_YAW_OFFSET,
	CUBE_REST_TILT,
);

/**
 * Held-item shader.
 *
 * This shader applies environment voxel lighting and directional sunlight.
 * It intentionally uses the mesh face normal. The formerly declared normal
 * texture was removed because it was never sampled and the geometry does not
 * currently provide the tangent basis required for correct tangent-space
 * normal mapping.
 */

const heldItemVertexWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vNormal : vec3<f32>,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;

  out.pos =
    shaderSystem.worldViewProjection *
    vec4<f32>(input.position, 1.0);

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
  let atlasUV =
    in.vUV * shaderUniforms.uScale +
    shaderUniforms.uOffset;

  let tex = textureSample(
    diffuseTexture,
    diffuseTextureSampler,
    atlasUV
  );

  // Alpha test for billboard sprites. Block atlas texels are opaque.
  if (tex.a < 0.5) {
    discard;
  }

  let surfaceNormal = normalize(in.vNormal);
  let lightDirection =
    normalize(shaderUniforms.lightDirection);

  let diffuseIntensity = max(
    0.0,
    dot(surfaceNormal, lightDirection)
  );

  let halfwayDir = normalize(
    surfaceNormal + lightDirection
  );

  let normalHalfway = max(
    dot(surfaceNormal, halfwayDir),
    0.0
  );

  let specular = exp2(
    clamp(
      32.0 * 1.4427 * (normalHalfway - 1.0),
      -126.0,
      0.0
    )
  );

  let voxelLight = shaderUniforms.lightColor;
  let sunIntensity =
    shaderUniforms.sunLightIntensity;

  let lightMix = clamp(
    voxelLight +
      diffuseIntensity * sunIntensity * 0.5,
    vec3<f32>(0.06),
    vec3<f32>(1.0)
  );

  let color =
    tex.rgb * lightMix +
    vec3<f32>(0.25) *
      specular *
      sunIntensity *
      voxelLight.x;

  return vec4<f32>(color, tex.a);
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
			{ name: "lightColor", type: "vec3<f32>" },
			{
				name: "lightDirection",
				type: "vec3<f32>",
			},
			{
				name: "sunLightIntensity",
				type: "f32",
			},
		],
		samplers: ["diffuseTexture"],
		backFaceCulling: true,
	});
}

/**
 * Lite's ShaderMaterial type does not currently expose dispose().
 */
function disposeItemMaterial(material: ShaderMaterial): void {
	(
		material as unknown as {
			dispose?: () => void;
		}
	).dispose?.();
}

/**
 * Cached synchronous fallback texture.
 *
 * It prevents creation of a renderable with an unbound sampler while an icon
 * or the texture atlas is still loading.
 */
let whiteFallback: Texture2D | null = null;

function getWhiteFallback(engine: EngineContext): Texture2D {
	if (!whiteFallback) {
		whiteFallback = createSolidTexture2D(engine, 255, 255, 255, 255);
	}

	return whiteFallback;
}

/**
 * Sprite entries use their icon URL as the cache key. Cube entries use
 * blockId * 64 + state. Map compares strings and numbers by type, so these
 * two key spaces cannot collide.
 */
type EntryKey = string | number;

type Entry = {
	mesh: Mesh;
	material: ShaderMaterial;
	kind: "sprite" | "cube";

	/** True after the mesh has entered its scene. */
	added: boolean;

	/**
	 * Environment-light cache belongs to the material rather than to the
	 * view as a whole. This ensures a newly selected material receives its
	 * light value even if the player has not crossed a voxel boundary.
	 */
	lightX: number;
	lightY: number;
	lightZ: number;

	/**
	 * Version of the sunlight state last written to this material.
	 */
	sunVersion: number;
};

function createEntry(
	mesh: Mesh,
	material: ShaderMaterial,
	kind: Entry["kind"],
): Entry {
	return {
		mesh,
		material,
		kind,
		added: false,
		lightX: Number.NaN,
		lightY: Number.NaN,
		lightZ: Number.NaN,
		sunVersion: -1,
	};
}

/**
 * Creates a zero-allocation selection key for the per-frame comparison.
 */
function entryKey(
	useSprite: boolean,
	icon: string,
	blockId: number,
	blockState: number,
): EntryKey {
	return useSprite ? icon : blockId * 64 + (blockState & 63);
}

export class HeldItemView {
	private readonly _entries = new Map<EntryKey, Entry>();

	/**
	 * Active selection.
	 *
	 * Both values are null when nothing is visible, including third-person
	 * mode, an empty hand, or a scene that is not ready.
	 */
	private _activeKey: EntryKey | null = null;
	private _activeEntry: Entry | null = null;

	/**
	 * Last observed global sunlight direction.
	 */
	private _lastSunX = Number.NaN;
	private _lastSunY = Number.NaN;
	private _lastSunZ = Number.NaN;

	/**
	 * Incremented whenever any sunlight-direction component changes.
	 */
	private _sunVersion = 0;

	private _swingT = Number.POSITIVE_INFINITY;
	private _disposed = false;
	private _updateFailed = false;

	constructor() {
		onSceneDispose(Map1.mainScene, () => {
			this._dispose();
		});
	}

	/**
	 * Starts or restarts the punch/mining swing.
	 */
	swing(): void {
		if (!this._disposed) {
			this._swingT = 0;
		}
	}

	update(player: Player, dt: number): void {
		if (this._disposed) return;

		try {
			this._updateInner(player, dt);

			// Permit a later, independent problem to be logged once.
			this._updateFailed = false;
		} catch (error) {
			if (!this._updateFailed) {
				this._updateFailed = true;

				console.error("[HeldItemView] Per-frame update failed:", error);
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

		const entry = this._activeEntry;
		if (!entry) return;

		this._updateEnvironmentLight(
			entry,
			body.position.x,
			body.position.y,
			body.position.z,
		);

		setRigHeldItemTransform(entry.mesh, body, walkPhase, walkAmp, punchT);
	}

	hide(): void {
		this._clearActive();
	}

	dispose(): void {
		this._dispose();
	}

	/**
	 * Detects sunlight changes using all three direction components.
	 */
	private _refreshSunState(): void {
		const direction = GLOBAL_VALUES.skyLightDirection;

		if (
			direction.x === this._lastSunX &&
			direction.y === this._lastSunY &&
			direction.z === this._lastSunZ
		) {
			return;
		}

		this._lastSunX = direction.x;
		this._lastSunY = direction.y;
		this._lastSunZ = direction.z;
		this._sunVersion++;
	}

	/**
	 * Writes global sunlight uniforms when this material's sunlight version
	 * is stale.
	 */
	private _writeSunUniforms(entry: Entry): void {
		if (entry.sunVersion === this._sunVersion) {
			return;
		}

		const direction = GLOBAL_VALUES.skyLightDirection;

		// Negated to point toward the sun.
		const sunX = -direction.x;
		const sunY = -direction.y;
		const sunZ = -direction.z;

		const sunIntensity = Math.min(1, Math.max(0, (sunY + 0.1) * 4));

		setShaderUniform(entry.material, "lightDirection", [sunX, sunY, sunZ]);

		setShaderUniform(entry.material, "sunLightIntensity", sunIntensity);

		entry.sunVersion = this._sunVersion;
	}

	/**
	 * Refreshes the active material's environment lighting only after the
	 * sampled voxel or sunlight state changes.
	 */
	private _updateEnvironmentLight(
		entry: Entry,
		x: number,
		y: number,
		z: number,
	): void {
		this._refreshSunState();
		this._writeSunUniforms(entry);

		const sampleY = y + PLAYER_LIGHT_SAMPLE_Y_OFFSET;

		const voxelX = Math.floor(x);
		const voxelY = Math.floor(sampleY);
		const voxelZ = Math.floor(z);

		if (
			voxelX === entry.lightX &&
			voxelY === entry.lightY &&
			voxelZ === entry.lightZ
		) {
			return;
		}

		entry.lightX = voxelX;
		entry.lightY = voxelY;
		entry.lightZ = voxelZ;

		setShaderVector3(
			entry.material,
			"lightColor",
			packedLightToLightColor(getLightByWorldCoords(x, sampleY, z)),
		);
	}

	private _updateInner(player: Player, dt: number): void {
		const item =
			player.playerInventory.inventory[0]?.[player.playerHud.selectedHotbarSlot]
				?.item ?? null;

		if (player.playerCamera.isThirdPerson || item === null) {
			this._clearActive();
			return;
		}

		const blockId = item.blockId ?? -1;
		const useSprite = !isRegisteredBlockId(blockId) && item.icon !== "";

		this._syncSelection(useSprite, item.icon, blockId, item.blockState ?? 0);

		const entry = this._activeEntry;
		if (!entry) return;

		this._updateEnvironmentLight(
			entry,
			player.position.x,
			player.position.y,
			player.position.z,
		);

		const cameraController = player.playerCamera;
		const camera = cameraController.playerCamera;

		const cameraPosition = camera.position;
		const cameraTarget = camera.target;

		const cameraX = cameraPosition.x;
		const cameraY = cameraPosition.y;
		const cameraZ = cameraPosition.z;

		let forwardX = cameraTarget.x - cameraX;
		let forwardY = cameraTarget.y - cameraY;
		let forwardZ = cameraTarget.z - cameraZ;

		const forwardLengthSquared =
			forwardX * forwardX + forwardY * forwardY + forwardZ * forwardZ;

		if (forwardLengthSquared > 1e-8) {
			const inverseLength = 1 / Math.sqrt(forwardLengthSquared);

			forwardX *= inverseLength;
			forwardY *= inverseLength;
			forwardZ *= inverseLength;
		} else {
			forwardX = 0;
			forwardY = 0;
			forwardZ = 1;
		}

		const cameraYaw = cameraController.cameraYaw;
		const cameraPitch = cameraController.cameraPitch;

		/**
		 * Camera-right at yaw zero is +X while forward is +Z.
		 */
		const rightX = Math.cos(cameraYaw);
		const rightZ = -Math.sin(cameraYaw);

		/**
		 * Camera up is forward cross right.
		 */
		const upX = forwardY * rightZ;
		const upY = forwardZ * rightX - forwardX * rightZ;
		const upZ = -forwardY * rightX;

		let punch = 0;

		if (this._swingT < PUNCH_DURATION_S) {
			this._swingT = Math.min(PUNCH_DURATION_S, this._swingT + dt);

			punch = Math.sin((this._swingT / PUNCH_DURATION_S) * Math.PI);
		}

		const forwardDistance = FORWARD_DIST + punch * PUNCH_PUSH;

		const downDistance = DOWN_DIST - punch * PUNCH_RISE;

		entry.mesh.position.set(
			cameraX +
				forwardX * forwardDistance +
				rightX * RIGHT_DIST -
				upX * downDistance,
			cameraY + forwardY * forwardDistance - upY * downDistance,
			cameraZ +
				forwardZ * forwardDistance +
				rightZ * RIGHT_DIST -
				upZ * downDistance,
		);

		setYawOuter(_qCam, cameraYaw, cameraPitch);

		const base = entry.kind === "sprite" ? SPRITE_BASE_Q : CUBE_BASE_Q;

		if (punch > 0) {
			setYawOuter(_qPunch, punch * PUNCH_TWIST, -punch * PUNCH_TILT);

			mulQuat(_qCam, _qPunch, _qMix);

			mulQuat(_qMix, base, _qMix);
		} else {
			mulQuat(_qCam, base, _qMix);
		}

		entry.mesh.rotationQuaternion.set(_qMix[0], _qMix[1], _qMix[2], _qMix[3]);
	}

	/**
	 * Tracks the current hotbar entry and ensures its mesh is visible.
	 */
	private _syncSelection(
		useSprite: boolean,
		icon: string,
		blockId: number,
		blockState: number,
	): void {
		const key = entryKey(useSprite, icon, blockId, blockState);

		if (key !== this._activeKey) {
			if (this._activeEntry) {
				setMeshVisible(this._activeEntry.mesh, false);
			}

			this._activeKey = key;
			this._activeEntry = null;
		}

		this._showActive();
	}

	private _showActive(): void {
		const key = this._activeKey;

		if (key === null || this._activeEntry || this._disposed) {
			return;
		}

		const entry =
			typeof key === "string" ? this._getSprite(key) : this._getCube(key);

		if (!entry.added) return;

		setMeshVisible(entry.mesh, true);
		this._activeEntry = entry;
	}

	/**
	 * Hides the current mesh and clears the active selection.
	 */
	private _clearActive(): void {
		if (this._activeKey === null) return;

		if (this._activeEntry) {
			setMeshVisible(this._activeEntry.mesh, false);
		}

		this._activeEntry = null;
		this._activeKey = null;
	}

	/**
	 * Adds an entry to the scene exactly once.
	 */
	private _ensureAdded(entry: Entry): void {
		if (entry.added || this._disposed || !Map1.mainScene) {
			return;
		}

		addToScene(Map1.mainScene, entry.mesh);

		entry.added = true;

		this._refreshSunState();
		this._writeSunUniforms(entry);
	}

	/**
	 * Gets or creates a sprite entry and refreshes its LRU position.
	 */
	private _getSprite(icon: string): Entry {
		const existing = this._entries.get(icon);

		if (existing) {
			this._entries.delete(icon);
			this._entries.set(icon, existing);

			this._ensureAdded(existing);
			return existing;
		}

		this._evictIfNeeded();

		const quad = getBillboardQuadGeometry();

		/**
		 * Avoids an intermediate JavaScript array from:
		 * new Uint32Array([...quad.indices, ...]).
		 */
		const sourceIndices = quad.indices;
		const indices = new Uint32Array(sourceIndices.length + 6);

		indices.set(sourceIndices);

		const offset = sourceIndices.length;

		indices[offset] = 0;
		indices[offset + 1] = 1;
		indices[offset + 2] = 2;
		indices[offset + 3] = 0;
		indices[offset + 4] = 2;
		indices[offset + 5] = 3;

		const mesh = createMeshFromData(
			Map1.engine,
			"heldItemSprite",
			quad.positions,
			quad.normals,
			indices,
			quad.uvs,
		);

		mesh.pickable = false;
		mesh.visible = false;

		mesh.scaling.set(SPRITE_SCALE, SPRITE_SCALE, SPRITE_SCALE);

		const material = createHeldItemMaterial(`heldSprite_${icon}`);

		mesh.material = material;

		setShaderUniform(material, "uScale", 1);

		setShaderUniform(material, "uOffset", [0, 0]);

		setShaderVector3(material, "lightColor", [1, 1, 1]);

		setShaderTexture(material, "diffuseTexture", getWhiteFallback(Map1.engine));

		const entry = createEntry(mesh, material, "sprite");

		this._entries.set(icon, entry);
		this._ensureAdded(entry);

		void getIconTexture(icon)
			.then((texture) => {
				if (texture || icon === PLACEHOLDER_ICON_URL) {
					return texture;
				}

				return getIconTexture(PLACEHOLDER_ICON_URL);
			})
			.then((texture) => {
				if (this._disposed || !texture || this._entries.get(icon) !== entry) {
					return;
				}

				setShaderTexture(material, "diffuseTexture", texture);

				this._ensureAdded(entry);
				this._showActive();
			})
			.catch((error: unknown) => {
				if (this._disposed) return;

				console.warn(`[HeldItemView] Failed to load icon "${icon}":`, error);
			});

		return entry;
	}

	/**
	 * Gets or creates a cube entry and refreshes its LRU position.
	 */
	private _getCube(key: number): Entry {
		const blockId = Math.floor(key / 64);
		const blockState = key & 63;

		const existing = this._entries.get(key);

		if (existing) {
			this._entries.delete(key);
			this._entries.set(key, existing);

			this._bindAtlas(existing);
			return existing;
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

		mesh.scaling.set(CUBE_SCALE, CUBE_SCALE, CUBE_SCALE);

		const material = createHeldItemMaterial(
			`heldCube_${blockId}_${blockState}`,
		);

		mesh.material = material;

		const tile = getAtlasTile(blockId);
		const tileX = tile?.[0] ?? 0;
		const tileY = tile?.[1] ?? 0;

		const clampedX = Math.max(0, Math.min(atlasSize - 1, tileX));

		const clampedY = Math.max(0, Math.min(atlasSize - 1, tileY));

		setShaderUniform(material, "uScale", atlasTileSize);

		setShaderUniform(material, "uOffset", [
			clampedX * atlasTileSize,
			(atlasSize - 1 - clampedY) * atlasTileSize,
		]);

		setShaderVector3(material, "lightColor", [1, 1, 1]);

		setShaderTexture(material, "diffuseTexture", getWhiteFallback(Map1.engine));

		const entry = createEntry(mesh, material, "cube");

		this._entries.set(key, entry);
		this._bindAtlas(entry);

		return entry;
	}

	/**
	 * Binds the shared diffuse atlas when available.
	 *
	 * This operation is idempotent and can be retried while the atlas is
	 * loading. The mesh remains renderable with its white fallback.
	 */
	private _bindAtlas(entry: Entry): void {
		if (this._disposed) return;

		this._ensureAdded(entry);

		const atlas = getDiffuseTexture2D();

		if (!atlas) return;

		setShaderTexture(entry.material, "diffuseTexture", atlas);
	}

	/**
	 * Retires the least recently used inactive entry.
	 */
	private _evictIfNeeded(): void {
		while (this._entries.size >= MAX_ENTRIES) {
			let victim: EntryKey | undefined;

			for (const key of this._entries.keys()) {
				if (key !== this._activeKey) {
					victim = key;
					break;
				}
			}

			if (victim === undefined) {
				return;
			}

			this._retire(victim);
		}
	}

	private _retire(key: EntryKey): void {
		const entry = this._entries.get(key);

		if (!entry) return;

		this._entries.delete(key);

		if (this._activeEntry === entry) {
			this._activeEntry = null;
		}

		if (entry.added && Map1.mainScene) {
			removeFromScene(Map1.mainScene, entry.mesh);
		}

		disposeItemMaterial(entry.material);
	}

	private _dispose(): void {
		if (this._disposed) return;

		this._disposed = true;

		/**
		 * Drain the map without allocating a copied key array.
		 */
		while (this._entries.size > 0) {
			const next = this._entries.keys().next();

			if (next.done) break;

			this._retire(next.value);
		}

		this._activeEntry = null;
		this._activeKey = null;
	}
}

let instance: HeldItemView | null = null;
let instanceScene: SceneContext | null = null;

/**
 * Per-frame viewmodel synchronization.
 *
 * The singleton is keyed by scene so joining another world cannot leave the
 * viewmodel associated with a disposed scene.
 */
export function updateHeldItemView(player: Player, dt: number): void {
	const scene = Map1.mainScene ?? null;

	if (instance && instanceScene !== scene) {
		instance.dispose();
		instance = null;
		instanceScene = null;
	}

	try {
		if (!instance) {
			instance = new HeldItemView();
			instanceScene = scene;
		}
	} catch (error) {
		console.error("[HeldItemView] Failed to initialize:", error);

		return;
	}

	instance.update(player, dt);
}

/**
 * Punch/mining swing feedback for the held item.
 */
export function swingHeldItemView(): void {
	instance?.swing();
}
