import {
	addToScene,
	type Camera,
	createMeshFromData,
	createShaderMaterial,
	createSolidTexture2D,
	createTexture2DArrayFromPixels,
	type EngineContext,
	getProjectionMatrix,
	type Mesh,
	onSceneDispose,
	removeFromScene,
	type SceneContext,
	type ShaderMaterial,
	setMeshVisible,
	setShaderMatrix,
	setShaderTexture,
	setShaderUniform,
	setShaderVector3,
	type Texture2D,
	type Texture2DArray,
} from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import { getLightByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import { isRegisteredBlockId } from "@/code/World/Shape/BlockShapes";
import {
	getDiffuseArray,
	getNormalArray,
} from "@/code/World/Texture/TextureAtlasFactory";
import type { Player } from "../Player";
import {
	PLAYER_LIGHT_SAMPLE_Y_OFFSET,
	PUNCH_DURATION_S,
	packedLightToLightColor,
	setRigHeldItemTransform,
	WALK_STRIDE_FACTOR,
} from "../PlayerModel";
import {
	getBillboardQuadGeometry,
	getIconTexture,
	PLACEHOLDER_ICON_URL,
} from "./DroppedItem";
import { getHeldBlockGeometry } from "./HeldBlockGeometry";
import {
	advanceHeldItemBobPhase,
	computeHeldItemBob,
	getHeldItemBobAmplitude,
	type HeldItemBobOffset,
} from "./HeldItemBob";
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

/**
 * Downward dip at the middle of a punch, in meters.
 *
 * The punch chops down and forward, the way Minecraft's swing does, instead
 * of lifting the item back towards the player.
 */
const PUNCH_DIP = 0.06;

/**
 * Pull towards the middle of the screen at the middle of a punch, in meters.
 *
 * The punch aims at the crosshair: the item leaves its resting corner and
 * lunges at the centre of the view.
 */
const PUNCH_CENTER = 0.06;

/**
 * Additional pitch at the middle of a punch, in radians.
 *
 * A positive pitch tips the top of the item away from the camera, which is
 * the downward chop. The opposite sign leaned the item back at the player,
 * which read as the punch tilting upwards.
 */
const PUNCH_TILT = 0.7;

/** Maximum number of cached viewmodel meshes. */
const MAX_ENTRIES = 32;

const MIN_FORWARD_LENGTH_SQUARED = 1e-8;

type QuatTuple = [number, number, number, number];

/**
 * Writes qY(yaw) * qX(pitch) into out.
 */
function setYawOuter(out: QuatTuple, yaw: number, pitch: number): void {
	const halfYaw = yaw * 0.5;
	const halfPitch = pitch * 0.5;

	const sy = Math.sin(halfYaw);
	const cy = Math.cos(halfYaw);
	const sx = Math.sin(halfPitch);
	const cx = Math.cos(halfPitch);

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
const _qBob: QuatTuple = [0, 0, 0, 0];
const _qMix: QuatTuple = [0, 0, 0, 0];

/**
 * Reused walk-bob sample, so the per-frame path stays allocation free.
 */
const _bobScratch: HeldItemBobOffset = {
	x: 0,
	y: 0,
	forward: 0,
	pitch: 0,
	yaw: 0,
};

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
 * Camera-relative view transform scratch.
 *
 * The viewmodel is rendered exactly like the engine's floating-origin path:
 * meshes are positioned relative to the camera and the view matrix carries
 * no translation, so the GPU never sees the camera's world position in a
 * matrix.
 */
const _relativeViewProjection = new Float32Array(16);
const _relativeViewRotation = new Float32Array(16);

/**
 * Writes P * V0, where V0 is the camera's view rotation with the translation
 * column forced to zero.
 */
function writeCameraRelativeViewProjection(camera: Camera): Float32Array {
	const world = camera.worldMatrix;
	const view = _relativeViewRotation;

	// V0 is the transpose of the camera's world rotation.
	view[0] = world[0];
	view[1] = world[4];
	view[2] = world[8];
	view[3] = 0;

	view[4] = world[1];
	view[5] = world[5];
	view[6] = world[9];
	view[7] = 0;

	view[8] = world[2];
	view[9] = world[6];
	view[10] = world[10];
	view[11] = 0;

	view[12] = 0;
	view[13] = 0;
	view[14] = 0;
	view[15] = 1;

	const canvas = Map1.engine.canvas;
	const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
	const projection = getProjectionMatrix(camera, aspect);
	const output = _relativeViewProjection;

	// output = projection * view, using column-major storage.
	for (let column = 0; column < 4; column++) {
		const offset = column * 4;

		const b0 = view[offset];
		const b1 = view[offset + 1];
		const b2 = view[offset + 2];
		const b3 = view[offset + 3];

		output[offset] =
			projection[0] * b0 +
			projection[4] * b1 +
			projection[8] * b2 +
			projection[12] * b3;

		output[offset + 1] =
			projection[1] * b0 +
			projection[5] * b1 +
			projection[9] * b2 +
			projection[13] * b3;

		output[offset + 2] =
			projection[2] * b0 +
			projection[6] * b1 +
			projection[10] * b2 +
			projection[14] * b3;

		output[offset + 3] =
			projection[3] * b0 +
			projection[7] * b1 +
			projection[11] * b2 +
			projection[15] * b3;
	}

	return output;
}

/**
 * Publishes the camera-relative view-projection to one viewmodel material.
 */
function syncRelativeViewProjection(
	material: ShaderMaterial,
	camera: Camera,
): void {
	setShaderMatrix(
		material,
		"uViewProjection",
		writeCameraRelativeViewProjection(camera),
	);
}

/**
 * Held-item sprite shader.
 *
 * This shader applies environment voxel lighting and directional sunlight.
 * The mesh normal is transformed into the same rotated space as the item.
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

  let relativeWorldPosition =
    shaderSystem.world * vec4<f32>(input.position, 1.0);

  out.pos =
    shaderUniforms.uViewProjection *
    relativeWorldPosition;

  out.vUV = input.uv;

  // w = 0 prevents translation from affecting the normal. This is valid for
  // the viewmodel's uniform mesh scaling.
  out.vNormal = normalize(
    (shaderSystem.world * vec4<f32>(input.normal, 0.0)).xyz
  );

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

  // Time-of-day intensity multiplied by local voxel skylight. This becomes
  // zero in fully enclosed caves and fades through partially lit entrances.
  let localSunIntensity =
    shaderUniforms.sunLightIntensity *
    shaderUniforms.skyLightLevel;

  let lightMix = clamp(
    voxelLight +
      diffuseIntensity * localSunIntensity * 0.5,
    vec3<f32>(0.06),
    vec3<f32>(1.0)
  );

  let color =
    tex.rgb * lightMix +
    vec3<f32>(0.25) *
      specular *
      localSunIntensity;

  return vec4<f32>(color, tex.a);
}
`;

/**
 * Held-item block shader.
 *
 * Blocks are sampled from the same atlas arrays the world mesher uses: one
 * atlas tile per layer, addressed by the per-face tile index carried in
 * uv2.x. Sampling a tile layer instead of a rectangle of the 2D atlas is
 * what keeps a face from reaching into the neighbouring tile at its border,
 * which showed up as a sub-pixel seam at the corners of the held cube.
 *
 * The UVs are the world mesher's frame, so one tile covers exactly one
 * block face and the texture scale matches the terrain blocks.
 *
 * Lighting is tangent-space, like the world's opaque chunk shader: the
 * normal map is sampled from the matching layer of the normal atlas and
 * modulates the direct sunlight term.
 */
const heldBlockVertexWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) @interpolate(flat) vTileLayer : u32,
  @location(2) vNormal : vec3<f32>,
  @location(3) vTangent : vec3<f32>,
  @location(4) vBitangent : vec3<f32>,
  @location(5) vViewDirTS : vec3<f32>,
  @location(6) @interpolate(flat) vLightDirTS : vec3<f32>,
  @location(7) @interpolate(flat) vDiffuse : f32,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;

  let world = shaderSystem.world;

  let relativeWorldPosition =
    world * vec4<f32>(input.position, 1.0);

  out.pos =
    shaderUniforms.uViewProjection *
    relativeWorldPosition;

  out.vUV = input.uv;
  out.vTileLayer = u32(input.uv2.x);

  let worldNormal = normalize(
    (world * vec4<f32>(input.normal, 0.0)).xyz
  );

  out.vNormal = worldNormal;

  // Tangent frame of the world mesher: the +X faces use the Y axis, the
  // +Y faces the Z axis and the +Z faces the X axis, flipped for the
  // back faces. Keeping the same frame means the held block reacts to the
  // sun exactly like the same block placed in the world.
  let localNormal = input.normal;

  var localTangent = vec3<f32>(1.0, 0.0, 0.0);

  if (abs(localNormal.y) > 0.5) {
    localTangent = vec3<f32>(0.0, 0.0, localNormal.y);
  } else if (abs(localNormal.x) > 0.5) {
    localTangent = vec3<f32>(0.0, localNormal.x, 0.0);
  } else {
    localTangent = vec3<f32>(localNormal.z, 0.0, 0.0);
  }

  let worldTangent = normalize(
    (world * vec4<f32>(localTangent, 0.0)).xyz
  );

  let worldBitangent = cross(worldNormal, worldTangent);

  out.vTangent = worldTangent;
  out.vBitangent = worldBitangent;

  // The viewmodel lives in camera-relative space, so the camera sits at
  // the origin of that space.
  let viewDirection = normalize(-relativeWorldPosition.xyz);

  let lightDirection = normalize(shaderUniforms.lightDirection);

  out.vViewDirTS = vec3<f32>(
    dot(viewDirection, worldTangent),
    dot(viewDirection, worldBitangent),
    dot(viewDirection, worldNormal)
  );

  out.vLightDirTS = normalize(vec3<f32>(
    dot(lightDirection, worldTangent),
    dot(lightDirection, worldBitangent),
    dot(lightDirection, worldNormal)
  ));

  out.vDiffuse = max(0.0, dot(lightDirection, worldNormal));

  return out;
}
`;

const heldBlockFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) @interpolate(flat) vTileLayer : u32,
  @location(2) vNormal : vec3<f32>,
  @location(3) vTangent : vec3<f32>,
  @location(4) vBitangent : vec3<f32>,
  @location(5) vViewDirTS : vec3<f32>,
  @location(6) @interpolate(flat) vLightDirTS : vec3<f32>,
  @location(7) @interpolate(flat) vDiffuse : f32,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let singleTileUV = fract(in.vUV);

  let dx = dpdx(in.vUV);
  let dy = dpdy(in.vUV);

  let tex = textureSampleGrad(
    diffuseTexture,
    diffuseTextureSampler,
    singleTileUV,
    in.vTileLayer,
    dx,
    dy
  );

  // Cutout blocks (leaves, grass) keep their alpha cutout.
  if (tex.a < 0.5) {
    discard;
  }

  let sampledNormal = textureSampleGrad(
    normalTexture,
    normalTextureSampler,
    singleTileUV,
    in.vTileLayer,
    dx,
    dy
  ).rgb;

  let normalTS = normalize(sampledNormal * 2.0 - 1.0);

  let lightDirectionTS = in.vLightDirTS;
  let viewDirectionTS = normalize(in.vViewDirTS);

  let normalMapDiffuse = max(
    0.0,
    dot(normalTS, lightDirectionTS)
  );

  let halfwayDirectionTS = normalize(
    viewDirectionTS + lightDirectionTS
  );

  let normalHalf = max(
    dot(normalTS, halfwayDirectionTS),
    0.0
  );

  let specularPower = exp2(
    clamp(
      32.0 * 1.4427 * (normalHalf - 1.0),
      -126.0,
      0.0
    )
  );

  let voxelLight = shaderUniforms.lightColor;

  let localSunIntensity =
    shaderUniforms.sunLightIntensity *
    shaderUniforms.skyLightLevel;

  let lightMix = clamp(
    voxelLight +
      in.vDiffuse * localSunIntensity * 0.5,
    vec3<f32>(0.06),
    vec3<f32>(1.0)
  );

  // The normal map adds the surface relief the flat diffuse term cannot
  // show. The world shader uses the same 1 + N.L * sun * sky shape.
  let directLight =
    1.0 +
    normalMapDiffuse * localSunIntensity * 0.5;

  let color =
    tex.rgb * lightMix * directLight +
    vec3<f32>(0.25) *
      specularPower *
      localSunIntensity;

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
			{ name: "uViewProjection", type: "mat4x4<f32>" },
			{ name: "uScale", type: "f32" },
			{ name: "uOffset", type: "vec2<f32>" },
			{ name: "lightColor", type: "vec3<f32>" },
			{ name: "lightDirection", type: "vec3<f32>" },
			{ name: "sunLightIntensity", type: "f32" },
			{ name: "skyLightLevel", type: "f32" },
		],
		samplers: ["diffuseTexture"],
		backFaceCulling: true,
	});
}

/**
 * Block material.
 *
 * Both samplers are array views so a face can only ever read the atlas
 * tile it was assigned, never the neighbouring tile.
 */
function createHeldBlockMaterial(name: string): ShaderMaterial {
	return createShaderMaterial({
		name,
		vertexSource: heldBlockVertexWGSL,
		fragmentSource: heldBlockFragmentWGSL,
		attributes: ["position", "normal", "uv", "uv2"],
		uniforms: [
			"world",
			{ name: "uViewProjection", type: "mat4x4<f32>" },
			{ name: "lightColor", type: "vec3<f32>" },
			{ name: "lightDirection", type: "vec3<f32>" },
			{ name: "sunLightIntensity", type: "f32" },
			{ name: "skyLightLevel", type: "f32" },
		],
		samplers: [
			{ name: "diffuseTexture", viewDimension: "2d-array" },
			{ name: "normalTexture", viewDimension: "2d-array" },
		],
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
	if (whiteFallback === null) {
		whiteFallback = createSolidTexture2D(engine, 255, 255, 255, 255);
	}

	return whiteFallback;
}

/**
 * Cached single-layer fallback arrays for the block material.
 *
 * The block shader samples two array views, so the fallback has to be an
 * array too. A one-layer array is enough: an out-of-range layer index is
 * clamped to the only valid layer.
 */
let whiteFallbackArray: Texture2DArray | null = null;
let flatNormalFallbackArray: Texture2DArray | null = null;

function getWhiteFallbackArray(engine: EngineContext): Texture2DArray {
	if (whiteFallbackArray === null) {
		whiteFallbackArray = createTexture2DArrayFromPixels(
			engine,
			new Uint8Array([255, 255, 255, 255]),
			1,
			1,
			1,
			{ mipMaps: false, magFilter: "nearest", minFilter: "nearest" },
		);
	}

	return whiteFallbackArray;
}

/**
 * Flat tangent-space normal (0, 0, 1) as an array layer.
 */
function getFlatNormalFallbackArray(engine: EngineContext): Texture2DArray {
	if (flatNormalFallbackArray === null) {
		flatNormalFallbackArray = createTexture2DArrayFromPixels(
			engine,
			new Uint8Array([128, 128, 255, 255]),
			1,
			1,
			1,
			{ mipMaps: false, magFilter: "nearest", minFilter: "nearest" },
		);
	}

	return flatNormalFallbackArray;
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
	 * True after the diffuse and normal atlas arrays have been bound to
	 * this cube material.
	 */
	atlasBound: boolean;

	/**
	 * Environment-light cache belongs to the material rather than to the
	 * view as a whole.
	 */
	lightX: number;
	lightY: number;
	lightZ: number;

	/** Version of the sunlight state last written to this material. */
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
		atlasBound: false,
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
	 * Both values are null when nothing is visible.
	 */
	private _activeKey: EntryKey | null = null;
	private _activeEntry: Entry | null = null;

	/** Last observed global sunlight direction. */
	private _lastSunX = Number.NaN;
	private _lastSunY = Number.NaN;
	private _lastSunZ = Number.NaN;

	/** Incremented whenever any sunlight-direction component changes. */
	private _sunVersion = 0;

	private _swingT = Number.POSITIVE_INFINITY;
	private _disposed = false;
	private _updateFailed = false;

	/**
	 * Stride phase of the first-person bob.
	 *
	 * The viewmodel keeps its own phase with a capped rate, so a sprint
	 * nudges the rhythm up instead of turning the bob into a fast jitter.
	 */
	private _bobPhase = 0;

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
		if (this._disposed) {
			return;
		}

		try {
			this._updateInner(player, dt);
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
		if (this._disposed) {
			return;
		}

		const item = itemId === 0 ? undefined : getRegisteredItemById(itemId);

		if (!body.visible || !item) {
			this.hide();
			return;
		}

		const blockId = item.blockId ?? -1;
		const isBlock = isRegisteredBlockId(blockId);
		const icon = item.icon || PLACEHOLDER_ICON_URL;
		const useSprite = !isBlock;

		this._syncSelection(useSprite, icon, blockId, blockState);

		const entry = this._activeEntry;

		if (entry === null) {
			return;
		}

		const camera = Map1.mainScene?.camera ?? null;

		if (camera === null) {
			this.hide();
			return;
		}

		if (entry.kind === "cube" && !entry.atlasBound) {
			this._bindAtlas(entry);
		}

		syncRelativeViewProjection(entry.material, camera);

		const bodyPosition = body.position;

		this._updateEnvironmentLight(
			entry,
			bodyPosition.x,
			bodyPosition.y,
			bodyPosition.z,
		);

		const cameraMatrix = camera.worldMatrix;

		setRigHeldItemTransform(
			entry.mesh,
			body,
			cameraMatrix[12],
			cameraMatrix[13],
			cameraMatrix[14],
			walkPhase,
			walkAmp,
			punchT,
		);
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
		const x = direction.x;
		const y = direction.y;
		const z = direction.z;

		if (x === this._lastSunX && y === this._lastSunY && z === this._lastSunZ) {
			return;
		}

		this._lastSunX = x;
		this._lastSunY = y;
		this._lastSunZ = z;
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

		const packedLight = getLightByWorldCoords(x, sampleY, z);
		const skyLightLevel = ((packedLight >> 4) & 0xf) / 15;

		setShaderVector3(
			entry.material,
			"lightColor",
			packedLightToLightColor(packedLight),
		);

		setShaderUniform(entry.material, "skyLightLevel", skyLightLevel);
	}

	private _updateInner(player: Player, dt: number): void {
		const inventory = player.playerInventory.inventory;
		const hotbarSlot = player.playerHud.selectedHotbarSlot;
		const cameraController = player.playerCamera;

		const item = inventory[0]?.[hotbarSlot]?.item ?? null;

		if (cameraController.isThirdPerson || item === null) {
			this._clearActive();
			return;
		}

		const blockId = item.blockId ?? -1;
		const isBlock = isRegisteredBlockId(blockId);

		/*
		 * A non-block item without an icon cannot be rendered safely.
		 * Treating it as a cube could call getBlockItemGeometry(-1, state).
		 */
		if (!isBlock && item.icon === "") {
			this._clearActive();
			return;
		}

		const useSprite = !isBlock;
		const blockState = item.blockState ?? 0;

		this._syncSelection(useSprite, item.icon, blockId, blockState);

		const entry = this._activeEntry;

		if (entry === null) {
			return;
		}

		/*
		 * Retry the atlas binding from the ordinary update path until the
		 * asynchronously-created atlas becomes available.
		 */
		if (entry.kind === "cube" && !entry.atlasBound) {
			this._bindAtlas(entry);
		}

		const playerPosition = player.position;

		this._updateEnvironmentLight(
			entry,
			playerPosition.x,
			playerPosition.y,
			playerPosition.z,
		);

		const camera = cameraController.playerCamera;
		const cameraPosition = camera.position;
		const cameraTarget = camera.target;

		let forwardX = cameraTarget.x - cameraPosition.x;
		let forwardY = cameraTarget.y - cameraPosition.y;
		let forwardZ = cameraTarget.z - cameraPosition.z;

		const forwardLengthSquared =
			forwardX * forwardX + forwardY * forwardY + forwardZ * forwardZ;

		if (forwardLengthSquared > MIN_FORWARD_LENGTH_SQUARED) {
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
			const nextSwingT = Math.min(
				PUNCH_DURATION_S,
				this._swingT + Math.max(0, dt),
			);

			this._swingT = nextSwingT;

			punch = Math.sin((nextSwingT / PUNCH_DURATION_S) * Math.PI);
		}

		/*
		 * Walk bob: the viewmodel is pinned to the camera, so without this it
		 * would sit perfectly still while the player walks. The offsets are
		 * camera-relative and the amplitude is a player setting.
		 */
		const velocity = player.velocity;

		const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);

		this._bobPhase = advanceHeldItemBobPhase(
			this._bobPhase,
			speed,
			Math.max(0, dt),
			WALK_STRIDE_FACTOR,
		);

		const bob = computeHeldItemBob(
			this._bobPhase,
			player.walkAmplitude,
			getHeldItemBobAmplitude(),
			_bobScratch,
		);

		const forwardDistance = FORWARD_DIST + punch * PUNCH_PUSH + bob.forward;

		const downDistance = DOWN_DIST + punch * PUNCH_DIP;

		const rightDistance = RIGHT_DIST + bob.x - punch * PUNCH_CENTER;
		const downOffset = downDistance - bob.y;

		/**
		 * Camera-relative world position: the engine renders this mesh with
		 * the zero-translation view-projection written below, so the mesh
		 * position must not include the camera's world position.
		 */
		entry.mesh.position.set(
			forwardX * forwardDistance + rightX * rightDistance - upX * downOffset,
			forwardY * forwardDistance - upY * downOffset,
			forwardZ * forwardDistance + rightZ * rightDistance - upZ * downOffset,
		);

		syncRelativeViewProjection(entry.material, camera);

		setYawOuter(_qCam, cameraYaw, cameraPitch);
		setYawOuter(_qBob, bob.yaw, bob.pitch);

		const base = entry.kind === "sprite" ? SPRITE_BASE_Q : CUBE_BASE_Q;

		/*
		 * The bob is a camera-space rotation, so it is applied between the
		 * camera rotation and the item's rest orientation.
		 */
		mulQuat(_qCam, _qBob, _qMix);

		if (punch > 0) {
			/*
			 * No yaw on the punch. Turning a flat sprite swings its near edge
			 * across the screen and slides the whole silhouette off to the
			 * left, so the punch used to land beside the crosshair instead
			 * of on it. The punch now stays centred and aims at the middle.
			 */
			setYawOuter(_qPunch, 0, punch * PUNCH_TILT);

			mulQuat(_qMix, _qPunch, _qMix);
		}

		mulQuat(_qMix, base, _qMix);

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
			const previousEntry = this._activeEntry;

			if (previousEntry !== null) {
				setMeshVisible(previousEntry.mesh, false);
			}

			this._activeKey = key;
			this._activeEntry = null;
		}

		this._showActive();
	}

	private _showActive(): void {
		const key = this._activeKey;

		if (key === null || this._activeEntry !== null || this._disposed) {
			return;
		}

		const entry =
			typeof key === "string" ? this._getSprite(key) : this._getCube(key);

		if (!entry.added) {
			return;
		}

		/**
		 * An asynchronous icon load can reveal a mesh between frames. Make
		 * sure it never renders with a stale or never-written matrix.
		 */
		const camera = Map1.mainScene?.camera ?? null;

		if (camera !== null) {
			syncRelativeViewProjection(entry.material, camera);
		}

		setMeshVisible(entry.mesh, true);
		this._activeEntry = entry;
	}

	/**
	 * Hides the current mesh and clears the active selection.
	 */
	private _clearActive(): void {
		if (this._activeKey === null) {
			return;
		}

		const activeEntry = this._activeEntry;

		if (activeEntry !== null) {
			setMeshVisible(activeEntry.mesh, false);
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

		if (existing !== undefined) {
			this._touchEntry(icon, existing);
			this._ensureAdded(existing);
			return existing;
		}

		this._evictIfNeeded();

		const quad = getBillboardQuadGeometry();

		/*
		 * Use the shared quad indices directly. Creating another typed array
		 * and appending a second six-index quad duplicated the same geometry.
		 */
		const mesh = createMeshFromData(
			Map1.engine,
			"heldItemSprite",
			quad.positions,
			quad.normals,
			quad.indices,
			quad.uvs,
		);

		mesh.pickable = false;
		setMeshVisible(mesh, false);
		mesh.scaling.set(SPRITE_SCALE, SPRITE_SCALE, SPRITE_SCALE);

		const material = createHeldItemMaterial(`heldSprite_${icon}`);

		mesh.material = material;

		setShaderUniform(material, "uScale", 1);
		setShaderUniform(material, "uOffset", [0, 0]);
		setShaderVector3(material, "lightColor", [1, 1, 1]);
		setShaderUniform(material, "skyLightLevel", 0);

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
				if (this._disposed) {
					return;
				}

				console.warn(`[HeldItemView] Failed to load icon "${icon}":`, error);
			});

		return entry;
	}

	/**
	 * Gets or creates a cube entry and refreshes its LRU position.
	 */
	private _getCube(key: number): Entry {
		const existing = this._entries.get(key);

		if (existing !== undefined) {
			this._touchEntry(key, existing);
			this._bindAtlas(existing);
			return existing;
		}

		this._evictIfNeeded();

		const blockId = Math.floor(key / 64);
		const blockState = key & 63;
		const cube = getHeldBlockGeometry(blockId, blockState);

		const mesh = createMeshFromData(
			Map1.engine,
			"heldItemCube",
			cube.positions,
			cube.normals,
			cube.indices,
			cube.uvs,
			cube.uvs2,
		);

		mesh.pickable = false;
		setMeshVisible(mesh, false);
		mesh.scaling.set(CUBE_SCALE, CUBE_SCALE, CUBE_SCALE);

		const material = createHeldBlockMaterial(
			`heldCube_${blockId}_${blockState}`,
		);

		mesh.material = material;

		setShaderVector3(material, "lightColor", [1, 1, 1]);
		setShaderUniform(material, "skyLightLevel", 0);

		setShaderTexture(
			material,
			"diffuseTexture",
			getWhiteFallbackArray(Map1.engine),
		);

		setShaderTexture(
			material,
			"normalTexture",
			getFlatNormalFallbackArray(Map1.engine),
		);

		const entry = createEntry(mesh, material, "cube");

		this._entries.set(key, entry);
		this._bindAtlas(entry);

		return entry;
	}

	/**
	 * Moves an existing entry to the most-recently-used end of the Map.
	 */
	private _touchEntry(key: EntryKey, entry: Entry): void {
		this._entries.delete(key);
		this._entries.set(key, entry);
	}

	/**
	 * Binds the shared atlas arrays when available.
	 *
	 * Blocks read the diffuse and normal atlas arrays the world mesher uses,
	 * so the held block shows the very same tiles as the terrain.
	 *
	 * The operation is idempotent and is retried from the normal update path
	 * while the atlas is unavailable.
	 */
	private _bindAtlas(entry: Entry): void {
		if (this._disposed) {
			return;
		}

		this._ensureAdded(entry);

		if (entry.atlasBound) {
			return;
		}

		const diffuse = getDiffuseArray();
		const normal = getNormalArray();

		if (!diffuse || !normal) {
			return;
		}

		setShaderTexture(entry.material, "diffuseTexture", diffuse);
		setShaderTexture(entry.material, "normalTexture", normal);

		entry.atlasBound = true;
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

		if (entry === undefined) {
			return;
		}

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
		if (this._disposed) {
			return;
		}

		this._disposed = true;

		/**
		 * Drain the map without allocating a copied key array.
		 */
		while (this._entries.size > 0) {
			const next = this._entries.keys().next();

			if (next.done) {
				break;
			}

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

	if (instance !== null && instanceScene !== scene) {
		instance.dispose();
		instance = null;
		instanceScene = null;
	}

	try {
		if (instance === null) {
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
