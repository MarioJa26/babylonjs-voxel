/**
 * Babylon Lite (native) port of the LOD3 chunk shader (farthest LOD).
 * Repacked attributes (see OpaqueShaderLite.ts). `tintLUT[6]` via storage buffer.
 * LOD3 uses the baked face normal directly (no TBN).
 */
import {
	createShaderMaterial,
	createStorageBuffer,
	type EngineContext,
	type SceneContext,
	type ShaderMaterial,
	setShaderStorageBuffer,
	setShaderTexture,
	setShaderUniform,
	type Texture2D,
} from "@babylonjs/lite";
import { registerPackedMaterial } from "../Chunk/PackedChunkMesh.js";
import { buildPackedVertexWGSL } from "./PackedChunkShaderWGSL.js";

const lod3OpaqueFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) @interpolate(flat) vTileLayer : u32,
  @location(10) vFogFactor : f32,
  @location(11) vFogColor : vec3<f32>,
  @location(12) @interpolate(flat) vTint : u32,
  @location(15) @interpolate(flat) vShade : vec3<f32>,
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

fn applyTintBucket(color : vec3<f32>, bucket : u32) -> vec3<f32> {
  let idx = i32(min(bucket, 5u));
  let lum = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  return mix(vec3<f32>(lum), color, tintLUT[idx].a) * tintLUT[idx].rgb;
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  applyDitherFade(in.pos.xy);

  let singleTileUV = fract(in.vUV);

  var diffuseColor = textureSampleLevel(
    diffuseTexture,
    diffuseTextureSampler,
    singleTileUV,
    in.vTileLayer,
    3.0
  );

  if (diffuseColor.a < 0.01) {
    discard;
  }

  var color = diffuseColor.rgb * in.vShade;

  color = applyTintBucket(color, in.vTint);
  color = mix(color, in.vFogColor, in.vFogFactor);

  return vec4<f32>(color, 1.0);
}
`;

const lod3TransparentFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) @interpolate(flat) vTileLayer : u32,
  @location(9) @interpolate(flat) vMeta : u32,
  @location(10) vFogFactor : f32,
  @location(11) vFogColor : vec3<f32>,
  @location(12) @interpolate(flat) vTint : u32,
  @location(15) @interpolate(flat) vShade : vec3<f32>,
};

fn hash12(p : vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn applyDitherFade(coord : vec2<f32>) {
  if (abs(shaderUniforms.lodFadeDirection) < 0.5) { return; }

  let n = hash12(
    floor(coord) +
    vec2<f32>(
      shaderUniforms.lodFadeSeed,
      shaderUniforms.lodFadeSeed * 1.37
    )
  );

  if (shaderUniforms.lodFadeDirection > 0.0) {
    if (n > shaderUniforms.lodFadeProgress) { discard; }
  } else {
    if (n < shaderUniforms.lodFadeProgress) { discard; }
  }
}

fn applyTintBucket(color : vec3<f32>, bucket : u32) -> vec3<f32> {
  let idx = i32(min(bucket, 5u));
  let lum = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  return mix(vec3<f32>(lum), color, tintLUT[idx].a) * tintLUT[idx].rgb;
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  applyDitherFade(in.pos.xy);

  let singleTileUV = fract(in.vUV);

  var diffuseColor = textureSampleLevel(
    diffuseTexture,
    diffuseTextureSampler,
    singleTileUV,
    in.vTileLayer,
    3.0
  );

  if (diffuseColor.a < 0.02) {
    discard;
  }

  var color = diffuseColor.rgb * in.vShade;
  color = applyTintBucket(color, in.vTint);

  let isWater = f32((in.vMeta >> 2u) & 1u);

  let waterColor =
    vec3<f32>(0.1, 0.4, 0.7) *
    min(in.vShade, vec3<f32>(0.6));

  color = mix(
    color,
    waterColor,
    isWater
  );

  color = mix(color, in.vFogColor, in.vFogFactor);

  return vec4<f32>(color, diffuseColor.a);
}
`;

export interface Lod3MaterialOptions {
	engine: EngineContext;
	scene: SceneContext;
	diffuseTexture: Texture2D | null;
	tintLUT: Float32Array;
	atlasTileSize: number;
	atlasMaxTiles: number;
	faceArenaCount: number;
}

export function createLod3OpaqueMaterial(
	opts: Lod3MaterialOptions,
): ShaderMaterial {
	const arenaCount = Math.max(1, opts.faceArenaCount | 0);
	const faceStorageBuffers = [];
	for (let i = 0; i < arenaCount; i++) {
		faceStorageBuffers.push({ name: `faceData${i}`, type: "array<u32>" });
	}
	const material = createShaderMaterial({
		name: "lod3OpaqueLite",
		vertexSource: buildPackedVertexWGSL(arenaCount, {
			tangent: false,
			worldPosition: false,
			meta: false,
			tint: true,
			fog: true,

			viewDir: false,

			ao: false,
			bakeShade: true,
		}),
		fragmentSource: lod3OpaqueFragmentWGSL,
		attributes: ["position"],
		uniforms: [
			"world",
			"worldViewProjection",
			"cameraPosition",
			{ name: "atlasTileSize", type: "f32" },
			{ name: "atlasMaxTiles", type: "f32" },
			{ name: "atlasMaxTilesU32", type: "u32" },
			{ name: "lightDirection", type: "vec3<f32>" },
			{ name: "sunLightIntensity", type: "f32" },
			{ name: "wetness", type: "f32" },
			{ name: "lodFadeProgress", type: "f32" },
			{ name: "lodFadeDirection", type: "f32" },
			{ name: "lodFadeSeed", type: "f32" },
			{ name: "fogInfos", type: "vec4<f32>" },
			{ name: "fogColor", type: "vec3<f32>" },
		],
		samplers: [{ name: "diffuseTexture", viewDimension: "2d-array" }],
		storageBuffers: [
			{ name: "tintLUT", type: "array<vec4<f32>, 6>" },
			...faceStorageBuffers,
			{ name: "chunkOffsets", type: "array<vec4<f32>>" },
		],
		backFaceCulling: true,
	});

	registerPackedMaterial(material);
	setShaderTexture(material, "diffuseTexture", opts.diffuseTexture);
	setShaderUniform(material, "atlasTileSize", opts.atlasTileSize);
	setShaderUniform(material, "atlasMaxTiles", opts.atlasMaxTiles);
	setShaderUniform(material, "atlasMaxTilesU32", opts.atlasMaxTiles);
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
		createStorageBuffer(opts.engine, opts.tintLUT, "lod3-tintLUT"),
	);
	return material;
}

export function createLod3TransparentMaterial(
	opts: Lod3MaterialOptions,
): ShaderMaterial {
	const arenaCount = Math.max(1, opts.faceArenaCount | 0);
	const faceStorageBuffers = [];
	for (let i = 0; i < arenaCount; i++) {
		faceStorageBuffers.push({ name: `faceData${i}`, type: "array<u32>" });
	}
	const material = createShaderMaterial({
		name: "lod3TransparentLite",
		vertexSource: buildPackedVertexWGSL(arenaCount, {
			tangent: false,
			worldPosition: false,

			// if this bucket is truly water-only:
			meta: true,

			tint: true,
			fog: true,

			viewDir: false,

			ao: false,
			bakeShade: true,

			boundarySentinel: false,
		}),
		fragmentSource: lod3TransparentFragmentWGSL,
		attributes: ["position"],
		uniforms: [
			"world",
			"worldViewProjection",
			"cameraPosition",
			{ name: "atlasTileSize", type: "f32" },
			{ name: "atlasMaxTiles", type: "f32" },
			{ name: "atlasMaxTilesU32", type: "u32" },
			{ name: "lightDirection", type: "vec3<f32>" },
			{ name: "sunLightIntensity", type: "f32" },
			{ name: "wetness", type: "f32" },
			{ name: "lodFadeProgress", type: "f32" },
			{ name: "lodFadeDirection", type: "f32" },
			{ name: "lodFadeSeed", type: "f32" },
			{ name: "fogInfos", type: "vec4<f32>" },
			{ name: "fogColor", type: "vec3<f32>" },
		],
		samplers: [{ name: "diffuseTexture", viewDimension: "2d-array" }],
		storageBuffers: [
			{ name: "tintLUT", type: "array<vec4<f32>, 6>" },
			...faceStorageBuffers,
			{ name: "chunkOffsets", type: "array<vec4<f32>>" },
		],
		backFaceCulling: false,
		needAlphaBlending: true,
		blendMode: "alpha",
	});

	registerPackedMaterial(material);
	setShaderTexture(material, "diffuseTexture", opts.diffuseTexture);
	setShaderUniform(material, "atlasTileSize", opts.atlasTileSize);
	setShaderUniform(material, "atlasMaxTiles", opts.atlasMaxTiles);
	setShaderUniform(material, "atlasMaxTilesU32", opts.atlasMaxTiles);
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
		createStorageBuffer(opts.engine, opts.tintLUT, "lod3-trans-tintLUT"),
	);
	return material;
}
