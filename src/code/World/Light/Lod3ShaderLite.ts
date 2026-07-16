/**
 * Babylon Lite (native) port of the LOD3 chunk shader (farthest LOD).
 * Repacked attributes (see OpaqueShaderLite.ts). `tintLUT[6]` via storage buffer.
 * LOD3 uses the baked face normal directly (no TBN).
 */
import {
	createShaderMaterial,
	type EngineContext,
	type SceneContext,
	type ShaderMaterial,
	setShaderStorageBuffer,
	setShaderTexture,
	setShaderUniform,
	type Texture2D,
} from "@babylonjs/lite";
import { registerPackedMaterial } from "../Chunk/PackedChunkMesh.js";
import { createLiteStorageBuffer } from "./liteGpuBuffer.js";
import { buildPackedVertexWGSL } from "./PackedChunkShaderWGSL.js";

// LOD3 declares a single diffuse sampler, so storage buffers begin at binding
// 2 + 2*1 = 4. tintLUT occupies 4; face data / chunk offsets follow at 5/6.
const lod3VertexWGSL = buildPackedVertexWGSL();

const lod3OpaqueFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vUV2 : vec2<f32>,
  @location(3) @interpolate(flat) vTangent : vec3<f32>,
  @location(5) @interpolate(flat) vNormal : vec3<f32>,
  @location(6) vAO : f32,
  @location(7) @interpolate(flat) vLight : vec2<f32>,
  @location(10) vFogFactor : f32,
  @location(11) vFogColor : vec3<f32>,
  @location(12) vTint : f32,
  @location(13) vViewDir : vec3<f32>,
};

fn hash12(p : vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn applyDitherFade(coord : vec2<f32>) {
  if (abs(shaderUniforms.lodFadeDirection) < 0.5) { return; }
  let n = hash12(floor(coord) + vec2<f32>(shaderUniforms.lodFadeSeed, shaderUniforms.lodFadeSeed * 1.37));
  if (shaderUniforms.lodFadeDirection > 0.0) {
    if (n > shaderUniforms.lodFadeProgress) { discard; }
  } else {
    if (n < shaderUniforms.lodFadeProgress) { discard; }
  }
}

fn applyTintBucket(color : vec3<f32>, bucket : f32) -> vec3<f32> {
  let idx = i32(clamp(floor(bucket + 0.5), 0.0, 5.0));
  let lum = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  return mix(vec3<f32>(lum), color, tintLUT[idx].a) * tintLUT[idx].rgb;
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  applyDitherFade(in.pos.xy);

  let singleTileUV = fract(in.vUV);
  let atlasUV = in.vUV2 + singleTileUV * shaderUniforms.atlasTileSize;
  let tex = textureSample(diffuseTexture, diffuseTextureSampler, atlasUV);

  let worldNormal = in.vNormal;
  let diffuseIntensity = max(0.0, dot(worldNormal, shaderUniforms.lightDirection));
  let viewDirection = in.vViewDir;
  let halfwayDir = normalize(viewDirection + shaderUniforms.lightDirection);
  let shininess = mix(16.0, 96.0, shaderUniforms.wetness);
  let NH = max(dot(worldNormal, halfwayDir), 0.0);
  let spec = exp2(clamp(shininess * 1.4427 * (NH - 1.0), -126.0, 0.0));
  let specIntensity = mix(0.02, 0.5, shaderUniforms.wetness) * in.vLight.x;
  let specular = vec3<f32>(specIntensity) * spec * max(shaderUniforms.sunLightIntensity - 0.1, 0.0);

  let skyScale = in.vLight.x * 0.8 * (shaderUniforms.sunLightIntensity + 0.2);
  let lightMix = clamp(skyScale + in.vLight.y * vec3<f32>(0.9, 0.6, 0.2), vec3<f32>(0.18), vec3<f32>(1.0));

  let topBottom = select(0.58, 1.0, in.vNormal.y > 0.0);
  let faceShade = select(0.78, topBottom, abs(in.vNormal.y) > 0.5);

  var color = (tex.rgb * (1.0 + diffuseIntensity * shaderUniforms.sunLightIntensity) + specular) * lightMix * faceShade;
  color = applyTintBucket(color, in.vTint);
  color = mix(color, in.vFogColor, in.vFogFactor);
  return vec4<f32>(color, 1.0);
}
`;

const lod3TransparentFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vUV2 : vec2<f32>,
  @location(3) @interpolate(flat) vTangent : vec3<f32>,
  @location(5) @interpolate(flat) vNormal : vec3<f32>,
  @location(6) vAO : f32,
  @location(7) @interpolate(flat) vLight : vec2<f32>,
  @location(10) vFogFactor : f32,
  @location(11) vFogColor : vec3<f32>,
  @location(12) vTint : f32,
  @location(13) vViewDir : vec3<f32>,
};

fn hash12(p : vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn applyDitherFade(coord : vec2<f32>) {
  if (abs(shaderUniforms.lodFadeDirection) < 0.5) { return; }
  let n = hash12(floor(coord) + vec2<f32>(shaderUniforms.lodFadeSeed, shaderUniforms.lodFadeSeed * 1.37));
  if (shaderUniforms.lodFadeDirection > 0.0) {
    if (n > shaderUniforms.lodFadeProgress) { discard; }
  } else {
    if (n < shaderUniforms.lodFadeProgress) { discard; }
  }
}

fn applyTintBucket(color : vec3<f32>, bucket : f32) -> vec3<f32> {
  let idx = i32(clamp(floor(bucket + 0.5), 0.0, 5.0));
  let lum = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  return mix(vec3<f32>(lum), color, tintLUT[idx].a) * tintLUT[idx].rgb;
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  applyDitherFade(in.pos.xy);

  let singleTileUV = fract(in.vUV);
  let atlasUV = in.vUV2 + singleTileUV * shaderUniforms.atlasTileSize;
  let tex = textureSample(diffuseTexture, diffuseTextureSampler, atlasUV);
  if (tex.a < 0.02) { discard; }

  let worldNormal = in.vNormal;
  let diffuseIntensity = max(0.0, dot(worldNormal, shaderUniforms.lightDirection));
  let viewDirection = in.vViewDir;
  let halfwayDir = normalize(viewDirection + shaderUniforms.lightDirection);
  let shininess = mix(16.0, 96.0, shaderUniforms.wetness);
  let NH = max(dot(worldNormal, halfwayDir), 0.0);
  let spec = exp2(clamp(shininess * 1.4427 * (NH - 1.0), -126.0, 0.0));
  let specIntensity = mix(0.02, 0.5, shaderUniforms.wetness) * in.vLight.x;
  let specular = vec3<f32>(specIntensity) * spec * max(shaderUniforms.sunLightIntensity - 0.1, 0.0);

  let skyScale = in.vLight.x * 0.8 * (shaderUniforms.sunLightIntensity + 0.2);
  let lightMix = clamp(skyScale + in.vLight.y * vec3<f32>(0.9, 0.6, 0.2), vec3<f32>(0.18), vec3<f32>(1.0));

  let topBottom = select(0.58, 1.0, in.vNormal.y > 0.0);
  let faceShade = select(0.78, topBottom, abs(in.vNormal.y) > 0.5);

  var color = (tex.rgb * (1.0 + diffuseIntensity * shaderUniforms.sunLightIntensity) + specular) * lightMix * faceShade;
  color = applyTintBucket(color, in.vTint);
  color = mix(color, in.vFogColor, in.vFogFactor);
  return vec4<f32>(color, tex.a);
}
`;

export interface Lod3MaterialOptions {
	engine: EngineContext;
	scene: SceneContext;
	diffuseTexture: Texture2D | null;
	tintLUT: Float32Array;
	atlasTileSize: number;
	atlasMaxTiles: number;
}

export function createLod3OpaqueMaterial(
	opts: Lod3MaterialOptions,
): ShaderMaterial {
	const material = createShaderMaterial({
		name: "lod3OpaqueLite",
		vertexSource: lod3VertexWGSL,
		fragmentSource: lod3OpaqueFragmentWGSL,
		attributes: ["position"],
		uniforms: [
			"world",
			"worldViewProjection",
			"cameraPosition",
			{ name: "atlasTileSize", type: "f32" },
			{ name: "atlasMaxTiles", type: "f32" },
			{ name: "lightDirection", type: "vec3<f32>" },
			{ name: "sunLightIntensity", type: "f32" },
			{ name: "wetness", type: "f32" },
			{ name: "lodFadeProgress", type: "f32" },
			{ name: "lodFadeDirection", type: "f32" },
			{ name: "lodFadeSeed", type: "f32" },
			{ name: "fogInfos", type: "vec4<f32>" },
			{ name: "fogColor", type: "vec3<f32>" },
		],
		samplers: ["diffuseTexture"],
		storageBuffers: [
			{ name: "tintLUT", type: "array<vec4<f32>, 6>" },
			{ name: "faceData", type: "array<vec4<u32>>" },
			{ name: "chunkOffsets", type: "array<vec4<f32>>" },
		],
		backFaceCulling: true,
	});

	registerPackedMaterial(material);
	setShaderTexture(material, "diffuseTexture", opts.diffuseTexture);
	setShaderUniform(material, "atlasTileSize", opts.atlasTileSize);
	setShaderUniform(material, "atlasMaxTiles", opts.atlasMaxTiles);
	setShaderUniform(material, "sunLightIntensity", 1);
	setShaderUniform(material, "wetness", 0);
	setShaderUniform(material, "lodFadeProgress", 1);
	setShaderUniform(material, "lodFadeDirection", 0);
	setShaderUniform(material, "lodFadeSeed", 0);
	setShaderUniform(material, "fogInfos", [0, 0, 1000, 0]);
	setShaderUniform(material, "fogColor", [0.6, 0.7, 0.9]);
	setShaderUniform(material, "lightDirection", [0, 1, 0]);
	setShaderStorageBuffer(
		material,
		"tintLUT",
		createLiteStorageBuffer(opts.engine, opts.tintLUT, "lod3-tintLUT"),
	);
	return material;
}

export function createLod3TransparentMaterial(
	opts: Lod3MaterialOptions,
): ShaderMaterial {
	const material = createShaderMaterial({
		name: "lod3TransparentLite",
		vertexSource: lod3VertexWGSL,
		fragmentSource: lod3TransparentFragmentWGSL,
		attributes: ["position"],
		uniforms: [
			"world",
			"worldViewProjection",
			"cameraPosition",
			{ name: "atlasTileSize", type: "f32" },
			{ name: "atlasMaxTiles", type: "f32" },
			{ name: "lightDirection", type: "vec3<f32>" },
			{ name: "sunLightIntensity", type: "f32" },
			{ name: "wetness", type: "f32" },
			{ name: "lodFadeProgress", type: "f32" },
			{ name: "lodFadeDirection", type: "f32" },
			{ name: "lodFadeSeed", type: "f32" },
			{ name: "fogInfos", type: "vec4<f32>" },
			{ name: "fogColor", type: "vec3<f32>" },
		],
		samplers: ["diffuseTexture"],
		storageBuffers: [
			{ name: "tintLUT", type: "array<vec4<f32>, 6>" },
			{ name: "faceData", type: "array<vec4<u32>>" },
			{ name: "chunkOffsets", type: "array<vec4<f32>>" },
		],
		backFaceCulling: false,
		needAlphaBlending: true,
	});

	registerPackedMaterial(material);
	setShaderTexture(material, "diffuseTexture", opts.diffuseTexture);
	setShaderUniform(material, "atlasTileSize", opts.atlasTileSize);
	setShaderUniform(material, "atlasMaxTiles", opts.atlasMaxTiles);
	setShaderUniform(material, "sunLightIntensity", 1);
	setShaderUniform(material, "wetness", 0);
	setShaderUniform(material, "lodFadeProgress", 1);
	setShaderUniform(material, "lodFadeDirection", 0);
	setShaderUniform(material, "lodFadeSeed", 0);
	setShaderUniform(material, "fogInfos", [0, 0, 1000, 0]);
	setShaderUniform(material, "fogColor", [0.6, 0.7, 0.9]);
	setShaderUniform(material, "lightDirection", [0, 1, 0]);
	setShaderStorageBuffer(
		material,
		"tintLUT",
		createLiteStorageBuffer(opts.engine, opts.tintLUT, "lod3-trans-tintLUT"),
	);
	return material;
}
