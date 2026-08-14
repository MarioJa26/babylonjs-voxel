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
  @location(3) @interpolate(flat) vTangent : vec3<f32>,
  @location(5) @interpolate(flat) vNormal : vec3<f32>,
  @location(6) vAO : f32,
  @location(7) @interpolate(flat) vLight : vec2<f32>,
  @location(13) vViewDir : vec3<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let singleTileUV = fract(in.vUV);
  let layer = in.vTileLayer;

  var diffuseColor = textureSampleGrad(diffuseTexture, diffuseTextureSampler, singleTileUV, layer, dpdx(in.vUV), dpdy(in.vUV));
  if (diffuseColor.a < 0.01) { discard; }
  diffuseColor = vec4<f32>(diffuseColor.rgb * mix(1.0, 0.5, shaderUniforms.wetness), diffuseColor.a);

  var normalMap = textureSampleGrad(normalTexture, normalTextureSampler, singleTileUV, layer, dpdx(in.vUV), dpdy(in.vUV)).rgb;
  normalMap = normalize(normalMap * 2.0 - 1.0);

  let N = in.vNormal;
  let T = in.vTangent;
  let B = cross(N, T);
  let worldNormal = normalize(mat3x3<f32>(T, B, N) * normalMap);

  let lightDirection = shaderUniforms.lightDirection;
  let viewDir = in.vViewDir;

  let diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));

  let shininess = mix(16.0, 128.0, shaderUniforms.wetness);
  let halfwayDir = normalize(viewDir + lightDirection);
  let NH = max(dot(worldNormal, halfwayDir), 0.0);
  let spec = exp2(clamp(shininess * 1.4427 * (NH - 1.0), -126.0, 0.0));
  let specIntensity = mix(0.03, 0.7, shaderUniforms.wetness) * in.vLight.x;
  let specular = vec3<f32>(specIntensity) * spec * max(shaderUniforms.sunLightIntensity - 0.1, 0.0);

  let aoFactor = 1.0 - in.vAO * 0.23;
  let skyScale = in.vLight.x * 0.8 * (shaderUniforms.sunLightIntensity + 0.2);
  let lightMix = clamp(skyScale + in.vLight.y * vec3<f32>(0.9, 0.6, 0.2), vec3<f32>(0.2), vec3<f32>(1.0));

  let color = (diffuseColor.rgb * (1.0 + diffuseIntensity * shaderUniforms.sunLightIntensity * in.vLight.x) + specular) * lightMix * aoFactor;

  let finalColor = color;
  return vec4<f32>(finalColor, 1.0);
}
`;

export const transparentChunkFragmentWGSL = /* wgsl */ `
struct VSOut {
@builtin(position) pos : vec4<f32>,
@location(0) vUV : vec2<f32>,
@location(1) @interpolate(flat) vTileLayer : u32,
@location(2) vWorldPosition : vec3<f32>,
@location(5) @interpolate(flat) vNormal : vec3<f32>,
@location(6) vAO : f32,
@location(7) @interpolate(flat) vLight : vec2<f32>,
@location(9) @interpolate(flat) vMeta : u32,
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
// meta carries isWater in bit 2 for near transparent meshes.
let isWater = f32((in.vMeta >> 2u) & 1u);

let scrollDir = vec2<f32>(
-shaderUniforms.time * 0.3,
shaderUniforms.time * 0.4
) * isWater;

let animatedUV = in.vUV + scrollDir;
let singleTileUV = fract(animatedUV);
let layer = in.vTileLayer;

var diffuseColor = textureSampleGrad(
diffuseTexture,
diffuseTextureSampler,
singleTileUV,
layer,
dpdx(in.vUV),
dpdy(in.vUV)
);

if (diffuseColor.a < 0.01) {
discard;
}

var worldNormal : vec3<f32>;

if (isWater > 0.5) {
let wavePos = in.vWorldPosition.xz * 0.3 + scrollDir;
let eps = 0.05;
let invEpsWaveStrength = 0.15 / eps;

let wC = valueNoise(wavePos);
let wCDX = valueNoise(wavePos + vec2<f32>(eps, 0.0));
let wCDZ = valueNoise(wavePos + vec2<f32>(0.0, eps));

worldNormal = normalize(vec3<f32>(
-(wCDX - wC) * invEpsWaveStrength,
1.0,
-(wCDZ - wC) * invEpsWaveStrength
));
} else {
worldNormal = in.vNormal;
}

let lightDirection = shaderUniforms.lightDirection;
let diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));

let halfwayDir = normalize(in.vViewDir + lightDirection);
let specPower = mix(16.0, 64.0, isWater);
let NH = max(dot(worldNormal, halfwayDir), 0.0);
let spec = exp2(clamp(specPower * 1.4427 * (NH - 1.0), -126.0, 0.0));

let skyLight = in.vLight.x;
let blockLight = in.vLight.y;
let lightLevel = max(skyLight, blockLight);

let specularIntensity = mix(0.2, 0.7, isWater) * skyLight;
let specular = vec3<f32>(specularIntensity) * spec * shaderUniforms.sunLightIntensity;

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
let saturation = mix(1.0, 0.5, isWater);
litColor = mix(
vec3<f32>(luminance),
litColor,
lightLevel * saturation + (1.0 - saturation)
);

let minLight = vec3<f32>(mix(0.02, 0.08, isWater));
var finalColor = litColor * max(lightMix * aoFactor, minLight);

// The vertex shader already computes these fog varyings.
// Use them here instead of paying the varying cost and then ignoring them.
finalColor = mix(finalColor, in.vFogColor, in.vFogFactor);

let alpha = diffuseColor.a * mix(1.0, mix(0.9, 0.4, lightLevel), isWater);

return vec4<f32>(finalColor, alpha);
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

function buildChunkMaterial(
	name: string,
	fragmentSource: string,
	useNormal: boolean,
	vertexOptions: VertexShaderOptions,
	opts: ChunkMaterialOptions,
): ShaderMaterial {
	const isTransparent = name === "chunkTransparentLite";
	const useFog = vertexOptions.fog;
	const arenaCount = Math.max(1, opts.faceArenaCount | 0);

	const samplers: { name: string; viewDimension: "2d" | "2d-array" }[] =
		useNormal
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
		{ name: "wetness", type: "f32" },
	];

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
		backFaceCulling: useNormal,
		needAlphaBlending: !useNormal,
		blendMode: "alpha",
	});

	registerPackedMaterial(material);

	setShaderTexture(material, "diffuseTexture", opts.diffuseTexture);

	if (useNormal) {
		setShaderTexture(material, "normalTexture", opts.normalTexture);
	}

	setShaderUniform(material, "atlasTileSize", opts.atlasTileSize);
	setShaderUniform(material, "atlasMaxTiles", opts.atlasMaxTiles);
	setShaderUniform(material, "atlasMaxTilesU32", opts.atlasMaxTiles | 0);
	setShaderUniform(material, "lightDirection", DEFAULT_LIGHT_DIRECTION);
	setShaderUniform(material, "sunLightIntensity", 1);
	setShaderUniform(material, "wetness", 0);

	if (isTransparent) {
		setShaderUniform(material, "time", 0);
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
		true,
		{
			tangent: true,
			worldPosition: false,
			meta: false,
			tint: false,
			fog: false,
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
		false,
		{ tangent: false, worldPosition: true, meta: true, tint: false, fog: true },
		opts,
	);
}
