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
import { registerPackedMaterial } from "../Chunk/Meshing/PackedChunkMesh.js";
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
  @location(15) @interpolate(flat) vDiffuse : f32,
};

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

  let diffuseRGB = diffuseSample.rgb * (1.0 - wetness * 0.5);

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

  let halfwayDirectionTS = normalize(viewDirectionTS + lightDirectionTS);

  let normalHalf = max(dot(normalTS, halfwayDirectionTS), 0.0);

  let shininess = 16.0 + wetness * 112.0;

  let specularPower = exp2(
    clamp(
      shininess * 1.4427 * (normalHalf - 1.0),
      -126.0,
      0.0
    )
  );

  let specularIntensity = (0.03 + wetness * 0.67) * skyLight * max(sunIntensity - 0.1, 0.0);

  let specular = vec3<f32>(specularIntensity * specularPower);

  let skyScale = skyLight * 0.8 * (sunIntensity + 0.2);

  let lightMix = clamp(
    vec3<f32>(skyScale) + blockLight * vec3<f32>(0.9, 0.6, 0.2),
    vec3<f32>(0.2),
    vec3<f32>(1.0)
  );

  let directLight = 1.0 + in.vDiffuse * normalMapDiffuse * sunIntensity * skyLight;

  let aoFactor = 1.0 - in.vAO * 0.23;

  let color = (diffuseRGB * directLight + specular) * lightMix * aoFactor;

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
let time = shaderUniforms.time;

let scrollDirection = vec2<f32>(
-time * 0.3,
time * 0.4
);

let animatedUV = in.vUV + scrollDirection;
let singleTileUV = fract(animatedUV);

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

let wavePosition = in.vWorldPosition.xz * 0.3 + scrollDirection;

let centerWave = valueNoise(wavePosition);

let waveGradient = vec2<f32>(
valueNoise(wavePosition + vec2<f32>(0.05, 0.0)) - centerWave,
valueNoise(wavePosition + vec2<f32>(0.0, 0.05)) - centerWave
);

let worldNormal = normalize(
vec3<f32>(
-waveGradient.x * 3.0,
1.0,
-waveGradient.y * 3.0
)
);

let lightDirection = shaderUniforms.lightDirection;

let sunIntensity = shaderUniforms.sunLightIntensity;

let skyLight = in.vLight.x;
let blockLight = in.vLight.y;
let lightLevel = max(skyLight, blockLight);

let diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));

let halfwayDirection = normalize(in.vViewDir + lightDirection);

let normalHalf = max(dot(worldNormal, halfwayDirection), 0.0);

let specularPower = exp2(
clamp(
92.3328 * (normalHalf - 1.0),
-126.0,
0.0
)
);

let specular = vec3<f32>(
0.7 * skyLight * specularPower * sunIntensity
);

let skyScale = skyLight * 0.8 * (sunIntensity + 0.2);

let lightMix = clamp(
vec3<f32>(skyScale) + blockLight * vec3<f32>(0.9, 0.6, 0.2),
vec3<f32>(0.0),
vec3<f32>(1.0)
);

let directLight = 1.0 + diffuseIntensity * sunIntensity * skyLight;

let litColor = diffuseColor.rgb * directLight + specular;

let luminance = dot(litColor, vec3<f32>(0.299, 0.587, 0.114));

let saturatedColor = mix(
vec3<f32>(luminance),
litColor,
lightLevel * 0.5 + 0.5
);

let aoFactor = 1.0 - in.vAO * 0.1;

let illuminatedColor = saturatedColor * max(lightMix * aoFactor, vec3<f32>(0.08));

let finalColor = mix(
illuminatedColor,
in.vFogColor,
in.vFogFactor
);

let alpha = diffuseColor.a * (0.9 - lightLevel * 0.5);

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
  @location(6) vAO : f32,
  @location(7) @interpolate(flat) vLight : vec2<f32>,
  @location(15) @interpolate(flat) vDiffuse : f32,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let singleTileUV = fract(in.vUV);
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

  if (diffuseColor.a < shaderSystem.alphaCutoff) {
    discard;
  }

  let skyLight = in.vLight.x;
  let blockLight = in.vLight.y;
  let sunIntensity = shaderUniforms.sunLightIntensity;

  let aoFactor = 1.0 - in.vAO * 0.1;
  let skyScale = skyLight * 0.8 * (sunIntensity + 0.2);

  let lightMix = clamp(
    vec3<f32>(skyScale) + blockLight * vec3<f32>(0.9, 0.6, 0.2),
    vec3<f32>(0.02),
    vec3<f32>(1.0)
  );

  let directLight = 1.0 + in.vDiffuse * sunIntensity * skyLight;

  let color =
    diffuseColor.rgb *
    shaderUniforms.cutoutWetDiffuseMul *
    directLight *
    lightMix *
    aoFactor;

  return vec4<f32>(color, 1.0);
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
	ao: true,
	bakeShade: false,
};

const CUTOUT_VERTEX_OPTIONS: VertexShaderOptions = {
	tangent: false,
	worldPosition: false,
	meta: false,
	tint: false,
	fog: false,
	viewDir: false,
	tangentSpaceLighting: false,

	// Exaktes Ergebnis für flache Quad-Normalen.
	vertexDiffuse: true,

	rawUnits: false,
	boundarySentinel: true,
	ao: true,
	bakeShade: false,
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

function buildMaterialUniforms(
	kind: ChunkMaterialKind,
	useFog: boolean,
): ShaderUniformOption[] {
	const isOpaque = kind === "opaque";
	const isTransparent = kind === "transparent";
	const isCutout = kind === "cutout";

	const uniforms: ShaderUniformOption[] = [
		"world",
		"worldViewProjection",
		"cameraPosition",
		{ name: "atlasMaxTilesU32", type: "u32" },
		{ name: "lightDirection", type: "vec3<f32>" },
		{ name: "sunLightIntensity", type: "f32" },
	];

	if (isOpaque) {
		uniforms.push({
			name: "wetness",
			type: "f32",
		});
	}

	if (isCutout) {
		uniforms.push(
			{
				name: "alphaCutoff",
				type: "f32",
			},
			{
				name: "cutoutWetDiffuseMul",
				type: "f32",
			},
		);
	}

	if (useFog) {
		uniforms.push(
			{
				name: "fogInfos",
				type: "vec4<f32>",
			},
			{
				name: "fogColor",
				type: "vec3<f32>",
			},
		);
	}

	if (isTransparent) {
		uniforms.push({
			name: "time",
			type: "f32",
		});
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

	const uniforms = buildMaterialUniforms(kind, useFog);

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
		// Water faces share one unsorted buffer (X/Z sides + Y tops). With
		// the default depthWrite:false for blended materials, deep side
		// faces at ocean-bottom cave openings composite OVER the surface
		// when viewed from above (buffer order is draw order). Explicit
		// depthWrite:true makes water self-occluding: nearest wins
		// regardless of emission order, so the surface occludes deep cave
		// water from above. Opaque already drew first (renderOrder 0 vs 1),
		// so this only affects water-vs-water.
		depthWrite: isTransparent ? true : undefined,
	});

	registerPackedMaterial(material);

	setShaderTexture(material, "diffuseTexture", opts.diffuseTexture);

	if (isOpaque) {
		setShaderTexture(material, "normalTexture", opts.normalTexture);
	}

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
		CUTOUT_VERTEX_OPTIONS,
		opts,
	);
}
