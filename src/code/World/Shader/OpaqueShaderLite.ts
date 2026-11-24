/**
 * Babylon Lite (native) port of the chunk shaders (opaque / water / cutout).
 *
 * Attribute repacking (no storage buffers needed):
 *   position : baked local vertex position (center + corner + chunk offset)
 *   normal   : axis-aligned face normal
 *   uv       : quad corner UV within the tile (0..1)
 *   uv2      : base atlas UV  = (tileX, atlasMaxTiles-1-tileY) * atlasTileSize (+ sub-tile frac)
 *   tangent  : face tangent T (vec3)
 *   color    : (packedAO, light, meta, 0)
 *
 * Lite ShaderMaterial contract (verified from package source):
 *   entry points: mainVertex / mainFragment
 *   inputs via auto struct `VertexInput` (@location(i) = attribute order)
 *   system uniforms:  shaderSystem.<name>   (group1 binding0)
 *   custom uniforms:  shaderUniforms.<name> (group1 binding1)
 *   sampler "X":      X (texture_2d<f32>) + XSampler (sampler)
 *
 * Optimization notes (fragment side):
 *   - Everything that depends on the sun is multiplied by (sunIntensity * skyLight).
 *     When that product is 0 (night, caves, underground water) the normal-map
 *     fetch (opaque) or the whole wave/specular block (water) is skipped. The
 *     result is bit-for-bit the same as before, only cheaper.
 *   - Scalar factors (wetness, AO, brightness, direct light) are folded into one
 *     scalar before touching vec3 math.
 *   - Water waves use an analytic value-noise gradient (4 hashes) instead of
 *     three full noise evaluations (12 hashes).
 *   - The light-mix formula lives in one shared WGSL helper.
 */
import {
	createShaderMaterial,
	type EngineContext,
	type SceneContext,
	type ShaderMaterial,
	type ShaderUniformOption,
	setShaderTexture,
	setShaderUniform,
	type Texture2D,
} from "@babylonjs/lite";
import { registerPackedMaterial } from "../Chunk/Meshing/PackedChunkMesh.js";
import {
	buildPackedVertexWGSL,
	type VertexShaderOptions,
} from "./PackedChunkShaderWGSL.js";

const DEFAULT_LIGHT_DIRECTION = new Float32Array([0, 1, 0]);
const DEFAULT_FOG_INFOS = new Float32Array([0, 140, 2600, 0]);
const DEFAULT_FOG_COLOR = new Float32Array([0.6, 0.7, 0.9]);

/**
 * Shared sky/block light combiner. `minLight` is the per-material floor
 * (opaque 0.2, cutout 0.02, water 0.0).
 */
const LIGHT_MIX_WGSL = /* wgsl */ `
fn chunkLightMix(skyLight : f32, blockLight : f32, sunIntensity : f32, minLight : f32) -> vec3<f32> {
  let skyScale = skyLight * 0.8 * (sunIntensity + 0.2);
  return clamp(
    vec3<f32>(skyScale) + blockLight * vec3<f32>(0.9, 0.6, 0.2),
    vec3<f32>(minLight),
    vec3<f32>(1.0)
  );
}
`;

export const opaqueChunkFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) @interpolate(flat) vTileLayer : u32,
  @location(4) @interpolate(flat) vBrightness : f32,
  @location(6) vAO : f32,
  @location(7) @interpolate(flat) vLight : vec2<f32>,
  @location(13) vViewDirTS : vec3<f32>,
  @location(14) @interpolate(flat) vLightDirTS : vec3<f32>,
  @location(15) @interpolate(flat) vDiffuse : f32,
};

${LIGHT_MIX_WGSL}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let singleTileUV = fract(in.vUV);
  let dx = dpdx(in.vUV);
  let dy = dpdy(in.vUV);

  let diffuseSample = textureSampleGrad(
    diffuseTexture,
    diffuseTextureSampler,
    singleTileUV,
    in.vTileLayer,
    dx,
    dy
  );

  if (diffuseSample.a < 0.01) {
    discard;
  }

  let wetness = shaderUniforms.wetness;
  let sunIntensity = shaderUniforms.sunLightIntensity;
  let skyLight = in.vLight.x;
  let blockLight = in.vLight.y;

  // Both the normal-mapped diffuse term and the specular term are scaled by
  // sunIntensity * skyLight, so without sun/sky light the normal map (a second
  // texture fetch) is not needed at all. textureSampleGrad is legal in
  // non-uniform control flow, so the branch is safe.
  let sunSky = sunIntensity * skyLight;
  var directLight = 1.0;
  var specular = 0.0;

  if (sunSky > 0.0) {
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

    let normalMapDiffuse = max(0.0, dot(normalTS, lightDirectionTS));
    directLight = 1.0 + in.vDiffuse * normalMapDiffuse * sunSky;

    let halfwayDirectionTS = normalize(viewDirectionTS + lightDirectionTS);
    let normalHalf = max(dot(normalTS, halfwayDirectionTS), 0.0);

    let shininess = 16.0 + wetness * 112.0;
    let specularPower = exp2(max(shininess * 1.4427 * (normalHalf - 1.0), -126.0));
    let specularIntensity = (0.03 + wetness * 0.67) * skyLight * max(sunIntensity - 0.1, 0.0);

    specular = specularIntensity * specularPower;
  }

  let lightMix = chunkLightMix(skyLight, blockLight, sunIntensity, 0.2);

  // Fold all scalar factors before the vec3 multiplies.
  let diffuseScale = (1.0 - wetness * 0.5) * directLight;
  let shade = (1.0 - in.vAO * 0.23) * in.vBrightness;

  let color = (diffuseSample.rgb * diffuseScale + vec3<f32>(specular)) * lightMix * shade;

  return vec4<f32>(color, 1.0);
}
`;

/**
 * Water-only transparent fragment shader. The transparent bucket carries only
 * water faces: scroll, procedural waves, specular, fog and blended alpha.
 *
 * Wave normals only feed the diffuse/specular terms, which are both scaled by
 * sunIntensity * skyLight, so the whole wave block is skipped when that is 0.
 */
export const transparentChunkFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) @interpolate(flat) vTileLayer : u32,
  @location(2) vWorldPosition : vec3<f32>,
  @location(4) @interpolate(flat) vBrightness : f32,
  @location(6) vAO : f32,
  @location(7) @interpolate(flat) vLight : vec2<f32>,
  @location(10) vFogFactor : f32,
  @location(11) vFogColor : vec3<f32>,
  @location(13) vViewDir : vec3<f32>,
};

${LIGHT_MIX_WGSL}

fn hash(p : vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Analytic gradient of the smoothstepped value noise: 4 hashes total.
// (Replaces three full noise evaluations used for finite differences.)
fn valueNoiseGradient(p : vec2<f32>) -> vec2<f32> {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let du = 6.0 * f * (1.0 - f);

  let a = hash(i);
  let b = hash(i + vec2<f32>(1.0, 0.0));
  let c = hash(i + vec2<f32>(0.0, 1.0));
  let d = hash(i + vec2<f32>(1.0, 1.0));

  let k0 = b - a;
  let k1 = c - a;
  let k2 = a - b - c + d;

  return du * vec2<f32>(k0 + k2 * u.y, k1 + k2 * u.x);
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let time = shaderUniforms.time;
  let scrollDirection = vec2<f32>(-time * 0.3, time * 0.4);

  let singleTileUV = fract(in.vUV + scrollDirection);

  let dx = dpdx(in.vUV);
  let dy = dpdy(in.vUV);

  let diffuseColor = textureSampleGrad(
    diffuseTexture,
    diffuseTextureSampler,
    singleTileUV,
    in.vTileLayer,
    dx,
    dy
  );

  if (diffuseColor.a < 0.01) {
    discard;
  }

  let sunIntensity = shaderUniforms.sunLightIntensity;
  let skyLight = in.vLight.x;
  let blockLight = in.vLight.y;
  let lightLevel = max(skyLight, blockLight);

  let sunSky = sunIntensity * skyLight;
  var directLight = 1.0;
  var specular = 0.0;

  if (sunSky > 0.0) {
    let lightDirection = shaderUniforms.lightDirection;

    // forward-difference step 0.05 * normal strength 3.0 = 0.15
    let wavePosition = in.vWorldPosition.xz * 0.3 + scrollDirection;
    let waveSlope = valueNoiseGradient(wavePosition) * 0.15;
    let worldNormal = normalize(vec3<f32>(-waveSlope.x, 1.0, -waveSlope.y));

    let diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));
    directLight = 1.0 + diffuseIntensity * sunSky;

    let halfwayDirection = normalize(in.vViewDir + lightDirection);
    let normalHalf = max(dot(worldNormal, halfwayDirection), 0.0);
    let specularPower = exp2(max(92.3328 * (normalHalf - 1.0), -126.0));

    specular = 0.7 * skyLight * specularPower * sunIntensity;
  }

  let lightMix = chunkLightMix(skyLight, blockLight, sunIntensity, 0.0);

  let litColor = diffuseColor.rgb * directLight + vec3<f32>(specular);
  let luminance = dot(litColor, vec3<f32>(0.299, 0.587, 0.114));
  let saturatedColor = mix(vec3<f32>(luminance), litColor, lightLevel * 0.5 + 0.5);

  let aoFactor = 1.0 - in.vAO * 0.1;
  let illuminatedColor = saturatedColor * max(lightMix * aoFactor, vec3<f32>(0.08));

  let finalColor = mix(illuminatedColor, in.vFogColor, in.vFogFactor);
  let alpha = diffuseColor.a * (0.9 - lightLevel * 0.5);

  return vec4<f32>(finalColor * in.vBrightness, alpha);
}
`;

/**
 * Cheap alpha-test cutout shader for glass, grass leaves and other fully-
 * transparent-texel materials. One diffuse sample, alpha-test, simple world-
 * space lighting; wetness is cheap diffuse darkening only (no normal map, no
 * specular). The `time` uniform only advances animated atlas tiles.
 * The surface is drawn in the opaque pass (no blending, no deferred sort);
 * fragments below the alphaCutoff system uniform are discarded and survivors
 * write alpha 1.
 */
export const cutoutChunkFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) @interpolate(flat) vTileLayer : u32,
  @location(4) @interpolate(flat) vBrightness : f32,
  @location(6) vAO : f32,
  @location(7) @interpolate(flat) vLight : vec2<f32>,
  @location(15) @interpolate(flat) vDiffuse : f32,
};

${LIGHT_MIX_WGSL}

fn animatedFireLayer(baseLayer : u32) -> u32 {
  if (baseLayer != 164u) {
    return baseLayer;
  }

  let frame = u32(shaderUniforms.time * 8.0) % 4u;
  if (frame == 1u) { return 246u; }
  if (frame == 2u) { return 247u; }
  if (frame == 3u) { return 252u; }
  return baseLayer;
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let singleTileUV = fract(in.vUV);
  let layer = animatedFireLayer(in.vTileLayer);
  let dx = dpdx(in.vUV);
  let dy = dpdy(in.vUV);

  let diffuseColor = textureSampleGrad(
    diffuseTexture,
    diffuseTextureSampler,
    singleTileUV,
    layer,
    dx,
    dy
  );

  if (diffuseColor.a < shaderSystem.alphaCutoff) {
    discard;
  }

  let skyLight = in.vLight.x;
  let blockLight = in.vLight.y;
  let sunIntensity = shaderUniforms.sunLightIntensity;

  let lightMix = chunkLightMix(skyLight, blockLight, sunIntensity, 0.02);

  let directLight = 1.0 + in.vDiffuse * sunIntensity * skyLight;
  let shade = (1.0 - in.vAO * 0.1) * in.vBrightness;
  let scalar = shaderUniforms.cutoutWetDiffuseMul * directLight * shade;

  return vec4<f32>(diffuseColor.rgb * lightMix * scalar, 1.0);
}
`;

const OPAQUE_VERTEX_OPTIONS: VertexShaderOptions = {
	tangent: false,
	worldPosition: false,
	meta: false,
	tint: false,
	fog: false,
	viewDir: false,
	tangentSpaceLighting: true,
	vertexDiffuse: true,
	rawUnits: false,
	boundarySentinel: true,
	ao: true,
	bakeShade: false,
	brightness: true,
};

const TRANSPARENT_VERTEX_OPTIONS: VertexShaderOptions = {
	tangent: false,
	worldPosition: true,
	meta: false,
	tint: false,
	fog: true,
	viewDir: true,
	tangentSpaceLighting: false,
	vertexDiffuse: false,
	rawUnits: false,
	boundarySentinel: false,
	boundaryFlag: true,
	ao: true,
	bakeShade: false,
	brightness: true,
};

const CUTOUT_VERTEX_OPTIONS: VertexShaderOptions = {
	tangent: false,
	worldPosition: false,
	meta: false,
	tint: false,
	fog: false,
	viewDir: false,
	tangentSpaceLighting: false,

	// Exact result for flat quad normals.
	vertexDiffuse: true,

	rawUnits: false,
	boundarySentinel: true,
	boundaryFlag: true,
	ao: true,
	bakeShade: false,
	brightness: true,
};

export interface ChunkMaterialOptions {
	engine: EngineContext;
	scene: SceneContext;
	diffuseTexture: Texture2D | null;
	normalTexture: Texture2D | null;
	tintLUT: Float32Array;
	atlasTileSize: number;
	atlasMaxTiles: number;
	faceArenaCount: number;
}

type ChunkMaterialKind = "opaque" | "transparent" | "cutout";

const DIFFUSE_ONLY_SAMPLERS = [
	{ name: "diffuseTexture", viewDimension: "2d-array" as const },
];

const DIFFUSE_AND_NORMAL_SAMPLERS = [
	{ name: "diffuseTexture", viewDimension: "2d-array" as const },
	{ name: "normalTexture", viewDimension: "2d-array" as const },
];

function buildMaterialUniforms(
	kind: ChunkMaterialKind,
	useFog: boolean,
): ShaderUniformOption[] {
	const uniforms: ShaderUniformOption[] = [
		"world",
		"worldViewProjection",
		"cameraPosition",
		{ name: "atlasMaxTilesU32", type: "u32" },
		{ name: "lightDirection", type: "vec3<f32>" },
		{ name: "sunLightIntensity", type: "f32" },
		{ name: "brightness", type: "f32" },
	];

	if (kind === "opaque") {
		uniforms.push({ name: "wetness", type: "f32" });
	}

	if (kind === "cutout") {
		uniforms.push(
			{ name: "alphaCutoff", type: "f32" },
			{ name: "cutoutWetDiffuseMul", type: "f32" },
		);
	}

	// Animated atlas tiles (cutout) and water scroll/waves (transparent).
	if (kind !== "opaque") {
		uniforms.push({ name: "time", type: "f32" });
	}

	if (useFog) {
		uniforms.push(
			{ name: "fogInfos", type: "vec4<f32>" },
			{ name: "fogColor", type: "vec3<f32>" },
		);
	}

	return uniforms;
}

function buildChunkMaterial(
	name: string,
	fragmentSource: string,
	kind: ChunkMaterialKind,
	vertexOptions: VertexShaderOptions,
	opts: ChunkMaterialOptions,
): ShaderMaterial {
	const isOpaque = kind === "opaque";
	const isTransparent = kind === "transparent";
	const isCutout = kind === "cutout";
	const useFog = vertexOptions.fog === true;
	const arenaCount = Math.max(1, opts.faceArenaCount | 0);

	const storageBuffers: { name: string; type: string }[] = Array.from(
		{ length: arenaCount },
		(_, i) => ({ name: `faceData${i}`, type: "array<u32>" }),
	);
	storageBuffers.push({ name: "chunkOffsets", type: "array<vec4<f32>>" });

	const material = createShaderMaterial({
		name,
		vertexSource: buildPackedVertexWGSL(arenaCount, vertexOptions),
		fragmentSource,
		attributes: ["position"],
		uniforms: buildMaterialUniforms(kind, useFog),
		samplers: isOpaque ? DIFFUSE_AND_NORMAL_SAMPLERS : DIFFUSE_ONLY_SAMPLERS,
		storageBuffers,

		// Only opaque culls back faces. Cutout stays double-sided for
		// grass/cross-plane vegetation; transparent needs both sides too
		// (water is viewed from under the surface).
		backFaceCulling: isOpaque,

		// Cutout is alpha-tested, not alpha-blended, so it draws in the opaque
		// pass and keeps depth writes.
		needAlphaBlending: isTransparent,
		needAlphaTesting: isCutout,
		blendMode: isTransparent ? "alpha" : undefined,

		// Water faces share one unsorted buffer (X/Z sides + Y tops). With the
		// default depthWrite:false for blended materials, deep side faces at
		// ocean-bottom cave openings composite OVER the surface when viewed
		// from above (buffer order is draw order). Explicit depthWrite:true
		// makes water self-occluding: nearest wins regardless of emission
		// order. Opaque already drew first (renderOrder 0 vs 1), so this only
		// affects water-vs-water.
		depthWrite: isTransparent ? true : undefined,
	});

	registerPackedMaterial(material);

	setShaderTexture(material, "diffuseTexture", opts.diffuseTexture);

	if (isOpaque) {
		setShaderTexture(material, "normalTexture", opts.normalTexture);
		setShaderUniform(material, "wetness", 0);
	}

	setShaderUniform(material, "atlasMaxTilesU32", opts.atlasMaxTiles | 0);
	// Copies, so no material can mutate the shared defaults.
	setShaderUniform(material, "lightDirection", DEFAULT_LIGHT_DIRECTION.slice());
	setShaderUniform(material, "sunLightIntensity", 1);
	setShaderUniform(material, "brightness", 1);

	if (isTransparent || isCutout) {
		setShaderUniform(material, "time", 0);
	}

	if (isCutout) {
		setShaderUniform(material, "alphaCutoff", 0.5);
		setShaderUniform(material, "cutoutWetDiffuseMul", 1);
	}

	if (useFog) {
		setShaderUniform(material, "fogInfos", DEFAULT_FOG_INFOS.slice());
		setShaderUniform(material, "fogColor", DEFAULT_FOG_COLOR.slice());
	}

	return material;
}

export function createChunkOpaqueMaterial(
	opts: ChunkMaterialOptions,
): ShaderMaterial {
	return buildChunkMaterial(
		"chunkOpaqueLite",
		opaqueChunkFragmentWGSL,
		"opaque",
		OPAQUE_VERTEX_OPTIONS,
		opts,
	);
}

export function createChunkTransparentMaterial(
	opts: ChunkMaterialOptions,
): ShaderMaterial {
	return buildChunkMaterial(
		"chunkTransparentLite",
		transparentChunkFragmentWGSL,
		"transparent",
		TRANSPARENT_VERTEX_OPTIONS,
		opts,
	);
}

/**
 * Cheap alpha-test material for the cutout bucket (glass, grass leaves).
 * One diffuse sample + simple world-space lighting; wetness is cheap diffuse
 * darkening via cutoutWetDiffuseMul (no normal map, no specular). The `time`
 * uniform only drives animated atlas tiles. No worldPosition/meta/fog/viewDir
 * varyings, no blending: drawn in the opaque pass ahead of the deferred
 * blended water mesh, double-sided for grass.
 */
export function createChunkCutoutMaterial(
	opts: ChunkMaterialOptions,
): ShaderMaterial {
	return buildChunkMaterial(
		"chunkCutoutLite",
		cutoutChunkFragmentWGSL,
		"cutout",
		CUTOUT_VERTEX_OPTIONS,
		opts,
	);
}
