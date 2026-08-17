/**
 * Babylon Lite (native) port of the opaque chunk shader.
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
import { registerPackedMaterial } from "../Chunk/PackedChunkMesh.js";
import {
	buildPackedVertexWGSL,
	type VertexShaderOptions,
} from "./PackedChunkShaderWGSL.js";

const DEFAULT_LIGHT_DIRECTION = new Float32Array([0, 1, 0]);
const DEFAULT_FOG_INFOS = new Float32Array([0, 140, 2600, 0]);
const DEFAULT_FOG_COLOR = new Float32Array([0.6, 0.7, 0.9]);

export const opaqueChunkFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) @interpolate(flat) vTileLayer : u32,
  @location(6) vAO : f32,
  @location(7) @interpolate(flat) vLight : vec2<f32>,
  @location(13) vViewDirTS : vec3<f32>,
  @location(14) @interpolate(flat) vLightDirTS : vec3<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let singleTileUV = fract(in.vUV);
  let layer = in.vTileLayer;
  let dx = dpdx(in.vUV);
  let dy = dpdy(in.vUV);

  var diffuseColor = textureSampleGrad(diffuseTexture, diffuseTextureSampler, singleTileUV, layer, dx, dy);
  if (diffuseColor.a < 0.01) { discard; }
  diffuseColor = vec4<f32>(diffuseColor.rgb * mix(1.0, 0.5, shaderUniforms.wetness), diffuseColor.a);

  var normalMap = textureSampleGrad(normalTexture, normalTextureSampler, singleTileUV, layer, dx, dy).rgb;
  normalMap = normalize(normalMap * 2.0 - 1.0);

  let lightDirectionTS = in.vLightDirTS;
  let viewDirTS = normalize(in.vViewDirTS);

  let diffuseIntensity = max(0.0, dot(normalMap, lightDirectionTS));

  let shininess = mix(16.0, 128.0, shaderUniforms.wetness);
  let halfwayDirTS = normalize(viewDirTS + lightDirectionTS);
  let NH = max(dot(normalMap, halfwayDirTS), 0.0);
  let spec = exp2(clamp(shininess * 1.4427 * (NH - 1.0), -126.0, 0.0));
  let specIntensity = mix(0.03, 0.7, shaderUniforms.wetness) * in.vLight.x;
  let specular = vec3<f32>(specIntensity) * spec * max(shaderUniforms.sunLightIntensity - 0.1, 0.0);

  let aoFactor = 1.0 - in.vAO * 0.23;
  let skyScale = in.vLight.x * 0.8 * (shaderUniforms.sunLightIntensity + 0.2);
  let lightMix = clamp(vec3<f32>(skyScale) + in.vLight.y * vec3<f32>(0.9, 0.6, 0.2), vec3<f32>(0.2), vec3<f32>(1.0));

  let color = (diffuseColor.rgb * (1.0 + diffuseIntensity * shaderUniforms.sunLightIntensity * in.vLight.x) + specular) * lightMix * aoFactor;

  return vec4<f32>(color, 1.0);
}
`;

/**
 * Water-only transparent fragment shader. The transparent bucket now carries
 * only water faces, so the isWater branch and its mix()s are gone — every
 * remaining instruction is water work: scroll, procedural waves, specular,
 * fog and blended alpha.
 */
export const transparentChunkFragmentWGSL = /* wgsl */ `
struct VSOut {
@builtin(position) pos : vec4<f32>,
@location(0) vUV : vec2<f32>,
@location(1) @interpolate(flat) vTileLayer : u32,
@location(2) vWorldPosition : vec3<f32>,
@location(6) vAO : f32,
@location(7) @interpolate(flat) vLight : vec2<f32>,
@location(10) vFogFactor : f32,
@location(11) vFogColor : vec3<f32>,
@location(13) vViewDir : vec3<f32>,
};

fn hash(p : vec2<f32>) -> f32 {
var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
p3 = p3 + dot(p3, p3.yzx + 33.33);
return fract((p3.x + p3.y) * p3.z);
}

fn valueNoise(p : vec2<f32>) -> f32 {
let i = floor(p);
let f = fract(p);
let u = f * f * (3.0 - 2.0 * f);

let a = hash(i);
let b = hash(i + vec2<f32>(1.0, 0.0));
let c = hash(i + vec2<f32>(0.0, 1.0));
let d = hash(i + vec2<f32>(1.0, 1.0));

return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
let scrollDir = vec2<f32>(
-shaderUniforms.time * 0.3,
shaderUniforms.time * 0.4
);

let animatedUV = in.vUV + scrollDir;
let singleTileUV = fract(animatedUV);
let layer = in.vTileLayer;

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

if (diffuseColor.a < 0.01) {
discard;
}

let wavePos = in.vWorldPosition.xz * 0.3 + scrollDir;
let eps = 0.05;
let invEpsWaveStrength = 3.0;

let wC = valueNoise(wavePos);
let wCDX = valueNoise(wavePos + vec2<f32>(eps, 0.0));
let wCDZ = valueNoise(wavePos + vec2<f32>(0.0, eps));

let worldNormal = normalize(vec3<f32>(
-(wCDX - wC) * invEpsWaveStrength,
1.0,
-(wCDZ - wC) * invEpsWaveStrength
));

let lightDirection = shaderUniforms.lightDirection;
let diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));

let halfwayDir = normalize(in.vViewDir + lightDirection);
let NH = max(dot(worldNormal, halfwayDir), 0.0);
let spec = exp2(clamp(64.0 * 1.4427 * (NH - 1.0), -126.0, 0.0));

let skyLight = in.vLight.x;
let blockLight = in.vLight.y;
let lightLevel = max(skyLight, blockLight);

let specular = vec3<f32>(0.7 * skyLight) * spec * shaderUniforms.sunLightIntensity;

let aoFactor = 1.0 - in.vAO * 0.1;
let skyScale = skyLight * 0.8 * (shaderUniforms.sunLightIntensity + 0.2);

let lightMix = clamp(
vec3<f32>(skyScale) + blockLight * vec3<f32>(0.9, 0.6, 0.2),
vec3<f32>(0.0),
vec3<f32>(1.0)
);

var litColor =
diffuseColor.rgb *
(1.0 + diffuseIntensity * shaderUniforms.sunLightIntensity * skyLight) +
specular;

let luminance = dot(litColor, vec3<f32>(0.299, 0.587, 0.114));

litColor = mix(
vec3<f32>(luminance),
litColor,
lightLevel * 0.5 + 0.5
);

var finalColor = litColor * max(lightMix * aoFactor, vec3<f32>(0.08));

finalColor = mix(finalColor, in.vFogColor, in.vFogFactor);

let alpha = diffuseColor.a * mix(0.9, 0.4, lightLevel);

return vec4<f32>(finalColor, alpha);
}
`;

/**
 * Cheap alpha-test cutout shader for glass, grass leaves and other fully-
 * transparent-texel materials. One diffuse sample, alpha-test, simple world-
 * space lighting; wetness is cheap diffuse darkening only (no normal map, no
 * specular). Deliberately does NOT declare `time`, waves, fog or
 * vWorldPosition — the water shader's per-fragment costs are all absent here.
 * The surface is drawn in the opaque pass (no blending, no deferred sort);
 * fragments below the alphaCutoff system uniform are discarded and survivors
 * write alpha 1.
 */
export const cutoutChunkFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) @interpolate(flat) vTileLayer : u32,
  @location(5) @interpolate(flat) vNormal : vec3<f32>,
  @location(6) vAO : f32,
  @location(7) @interpolate(flat) vLight : vec2<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let singleTileUV = fract(in.vUV);
  let layer = in.vTileLayer;
  let dx = dpdx(in.vUV);
  let dy = dpdy(in.vUV);

  var diffuseColor = textureSampleGrad(
    diffuseTexture,
    diffuseTextureSampler,
    singleTileUV,
    layer,
    dx,
    dy
  );

  // alphaCutoff is a system uniform: declaring it in the uniforms list routes
  // it into the auto-generated shaderSystem struct (not shaderUniforms).
  if (diffuseColor.a < shaderSystem.alphaCutoff) {
    discard;
  }

  // Cheap wet look: darken the diffuse only (no normal/specular wetness).
  diffuseColor = vec4<f32>(
    diffuseColor.rgb * shaderUniforms.cutoutWetDiffuseMul,
    diffuseColor.a
  );

  let skyLight = in.vLight.x;
  let blockLight = in.vLight.y;
  let sunIntensity = shaderUniforms.sunLightIntensity;

  let diffuseIntensity = max(0.0, dot(in.vNormal, shaderUniforms.lightDirection));

  let aoFactor = 1.0 - in.vAO * 0.1;
  let skyScale = skyLight * 0.8 * (sunIntensity + 0.2);

  let lightMix = clamp(
    vec3<f32>(skyScale) + blockLight * vec3<f32>(0.9, 0.6, 0.2),
    vec3<f32>(0.02),
    vec3<f32>(1.0)
  );

  let color =
    diffuseColor.rgb *
    (1.0 + diffuseIntensity * sunIntensity * skyLight) *
    lightMix *
    aoFactor;

  return vec4<f32>(color, 1.0);
}
`;
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

	const samplers: { name: string; viewDimension: "2d" | "2d-array" }[] =
		isOpaque
			? [
					{ name: "diffuseTexture", viewDimension: "2d-array" },
					{ name: "normalTexture", viewDimension: "2d-array" },
				]
			: [{ name: "diffuseTexture", viewDimension: "2d-array" }];

	const storageBuffers: { name: string; type: string }[] = new Array(
		arenaCount + 1,
	);

	for (let i = 0; i < arenaCount; i++) {
		storageBuffers[i] = {
			name: `faceData${i}`,
			type: "array<u32>",
		};
	}

	storageBuffers[arenaCount] = {
		name: "chunkOffsets",
		type: "array<vec4<f32>>",
	};

	const uniforms: ShaderUniformOption[] = [
		"world",
		"worldViewProjection",
		"cameraPosition",
		{ name: "atlasTileSize", type: "f32" },
		{ name: "atlasMaxTiles", type: "f32" },
		{ name: "atlasMaxTilesU32", type: "u32" },
		{ name: "lightDirection", type: "vec3<f32>" },
		{ name: "sunLightIntensity", type: "f32" },
	];

	// Only opaque declares/uses wetness (normal-map specular response).
	// Cutout gets the cheaper cutoutWetDiffuseMul; transparent water has its
	// own look.
	if (isOpaque) {
		uniforms.push({ name: "wetness", type: "f32" });
	}

	if (isCutout) {
		// System uniform: declaring it here both adds alphaCutoff to the
		// auto-generated shaderSystem struct and creates the material's value
		// slot so setShaderUniform(material, "alphaCutoff", ...) can set it.
		uniforms.push(
			{ name: "alphaCutoff", type: "f32" },
			// Regular per-material uniform: wet-diffuse multiplier in [1, 0.65],
			// driven from the shared wetness uniform each frame.
			{ name: "cutoutWetDiffuseMul", type: "f32" },
		);
	}

	if (useFog) {
		uniforms.push(
			{ name: "fogInfos", type: "vec4<f32>" },
			{ name: "fogColor", type: "vec3<f32>" },
		);
	}

	if (isTransparent) {
		uniforms.push({ name: "time", type: "f32" });
	}

	const material = createShaderMaterial({
		name,
		vertexSource: buildPackedVertexWGSL(arenaCount, vertexOptions),
		fragmentSource,
		attributes: ["position"],
		uniforms,
		samplers,
		storageBuffers,

		// Only opaque culls back faces. Cutout stays double-sided for
		// grass/cross-plane vegetation; transparent needs both sides too
		// (water is viewed from under the surface).
		backFaceCulling: isOpaque,

		// The important part: cutout is alpha-tested, not alpha-blended, so it
		// draws in the opaque pass and keeps depth writes.
		needAlphaBlending: isTransparent,
		needAlphaTesting: isCutout,
		blendMode: isTransparent ? "alpha" : undefined,
	});

	registerPackedMaterial(material);

	setShaderTexture(material, "diffuseTexture", opts.diffuseTexture);

	if (isOpaque) {
		setShaderTexture(material, "normalTexture", opts.normalTexture);
	}

	setShaderUniform(material, "atlasTileSize", opts.atlasTileSize);
	setShaderUniform(material, "atlasMaxTiles", opts.atlasMaxTiles);
	setShaderUniform(material, "atlasMaxTilesU32", opts.atlasMaxTiles | 0);
	setShaderUniform(material, "lightDirection", DEFAULT_LIGHT_DIRECTION);
	setShaderUniform(material, "sunLightIntensity", 1);

	if (isOpaque) {
		setShaderUniform(material, "wetness", 0);
	}

	if (isTransparent) {
		setShaderUniform(material, "time", 0);
	}

	if (isCutout) {
		setShaderUniform(material, "alphaCutoff", 0.5);
		setShaderUniform(material, "cutoutWetDiffuseMul", 1);
	}

	if (useFog) {
		setShaderUniform(material, "fogInfos", DEFAULT_FOG_INFOS);
		setShaderUniform(material, "fogColor", DEFAULT_FOG_COLOR);
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
		{
			tangent: false,
			worldPosition: false,
			meta: false,
			tint: false,
			fog: false,
			viewDir: true,
			tangentSpaceLighting: true,
		},
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
		{
			tangent: false,
			worldPosition: true,
			meta: false,
			tint: false,
			fog: true,
			viewDir: true,
			tangentSpaceLighting: false,
		},
		opts,
	);
}

/**
 * Cheap alpha-test material for the cutout bucket (glass, grass leaves).
 * One diffuse sample + simple world-space lighting; wetness is cheap diffuse
 * darkening via cutoutWetDiffuseMul (no normal map, no specular). No `time`
 * uniform, no worldPosition/meta/fog/viewDir varyings, no blending — drawn
 * in the opaque pass ahead of the deferred blended water mesh, double-sided
 * for grass.
 */
export function createChunkCutoutMaterial(
	opts: ChunkMaterialOptions,
): ShaderMaterial {
	return buildChunkMaterial(
		"chunkCutoutLite",
		cutoutChunkFragmentWGSL,
		"cutout",
		{
			tangent: false,
			worldPosition: false,
			meta: false,
			tint: false,

			// Cutout skips fog entirely (ChunkMesher.materialUsesFog already
			// excludes cutoutMaterial): no fog varyings, no fog uniforms.
			fog: false,

			// No specular in the cheap cutout path.
			viewDir: false,

			// Not needed for cutout.
			tangentSpaceLighting: false,
		},
		opts,
	);
}
