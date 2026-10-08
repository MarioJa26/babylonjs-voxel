/**
 * Babylon Lite (native) port of the LOD2 chunk shader.
 * Repacked attributes (see OpaqueShaderLite.ts). `tintLUT[6]` is supplied as a
 * read-only storage buffer (not a supported uniform type). `faceShade` is
 * reconstructed from the baked face normal in the fragment.
 */
import {
	createShaderMaterial,
	createStorageBuffer,
	type EngineContext,
	type SceneContext,
	type ShaderMaterial,
	type ShaderUniformOption,
	setShaderStorageBuffer,
	setShaderTexture,
	setShaderUniform,
	type Texture2D,
} from "@babylonjs/lite";
import { registerPackedMaterial } from "../Chunk/Meshing/PackedChunkMesh.js";
import { buildPackedVertexWGSL } from "./PackedChunkShaderWGSL.js";

const lod2OpaqueFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) @interpolate(flat) vTileLayer : u32,
  @location(10) vFogFactor : f32,
  @location(11) vFogColor : vec3<f32>,
  @location(12) @interpolate(flat) vTint : u32,
  @location(15) @interpolate(flat) vShade : vec3<f32>,
};

fn applyTintBucket(color : vec3<f32>, bucket : u32) -> vec3<f32> {
  let idx = i32(min(bucket, 5u));
  let lum = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  return mix(vec3<f32>(lum), color, tintLUT[idx].a) * tintLUT[idx].rgb;
}

// PERF: no \`discard\` anywhere in this shader, on purpose.
//
// A \`discard\` anywhere in a fragment shader disables early depth testing for
// the whole pass on every current WebGPU driver, so every depth-rejected
// fragment still pays the full shader. With this geometry covering an ever
// larger fraction of the screen as render distance grows, that is charged on
// every overdrawn pixel.
//
// Neither discard here is load-bearing:
//   - the dither fade was a LOD-crossing transition driven by
//     \`lodFadeDirection\`, which is set to 0 at creation and never written
//     again, so both of its branches were unreachable;
//   - the alpha cutoff guarded against fully transparent atlas texels, but
//     this is the OPAQUE bucket — the mesher only emits faces for solid
//     blocks, whose atlas tiles are opaque, and the shader already forces
//     alpha to 1.0 on write.
@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let singleTileUV = fract(in.vUV);

  let diffuseColor = textureSampleLevel(
    diffuseTexture,
    diffuseTextureSampler,
    singleTileUV,
    in.vTileLayer,
    3.0
  );

  var color = diffuseColor.rgb * in.vShade;
  color = applyTintBucket(color, in.vTint);
  color = mix(color, in.vFogColor, in.vFogFactor);

  return vec4<f32>(color, 1.0);
}
`;

/**
 * Alpha-tested cutout — the LOD2 analogue of OpaqueShaderLite's
 * `cutoutChunkFragmentWGSL`. Discard is retained here (it is the whole point
 * of the bucket) but the pass is back-face culled and writes alpha 1.0, so it
 * rasterises once into the opaque target instead of blending twice.
 */
const lod2CutoutFragmentWGSL = /* wgsl */ `
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

fn applyTintBucket(color : vec3<f32>, bucket : u32) -> vec3<f32> {
  let idx = i32(min(bucket, 5u));
  let lum = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  return mix(vec3<f32>(lum), color, tintLUT[idx].a) * tintLUT[idx].rgb;
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let diffuseColor = textureSampleLevel(
    diffuseTexture,
    diffuseTextureSampler,
    fract(in.vUV),
    in.vTileLayer,
    3.0
  );

  // alphaCutoff is a system uniform: declaring it in the uniforms list routes
  // it into the auto-generated shaderSystem struct (not shaderUniforms).
  if (diffuseColor.a < shaderSystem.alphaCutoff) {
    discard;
  }

  var color = diffuseColor.rgb * in.vShade;
  color = applyTintBucket(color, in.vTint);
  color = mix(color, in.vFogColor, in.vFogFactor);

  return vec4<f32>(color, 1.0);
}
`;

const lod2TransparentFragmentWGSL = /* wgsl */ `
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

export interface Lod2MaterialOptions {
	engine: EngineContext;
	scene: SceneContext;
	diffuseTexture: Texture2D | null;
	/**
	 * Cutout atlas (leaves/glass). Falls back to `diffuseTexture` when the
	 * build only ships one atlas.
	 */
	cutoutTexture?: Texture2D | null;
	tintLUT: Float32Array; // 6 * vec4 = 24 floats
	atlasTileSize: number;
	atlasMaxTiles: number;
	faceArenaCount: number;
}

function baseUniforms(): readonly ShaderUniformOption[] {
	return [
		"world",
		"worldViewProjection",
		"cameraPosition",
		{ name: "atlasTileSize", type: "f32" } as const,
		{ name: "atlasMaxTiles", type: "f32" } as const,
		{ name: "atlasMaxTilesU32", type: "u32" } as const,
		{ name: "lightDirection", type: "vec3<f32>" } as const,
		{ name: "sunLightIntensity", type: "f32" } as const,
		{ name: "wetness", type: "f32" } as const,
		{ name: "lodFadeProgress", type: "f32" } as const,
		{ name: "lodFadeDirection", type: "f32" } as const,
		{ name: "lodFadeSeed", type: "f32" } as const,
		{ name: "fogInfos", type: "vec4<f32>" } as const,
		{ name: "fogColor", type: "vec3<f32>" } as const,
	];
}

interface PackedVertexOptions {
	tangent: boolean;
	worldPosition: boolean;
	meta: boolean;
	tint: boolean;
	fog: boolean;
	viewDir: boolean;
	ao: boolean;
	bakeShade: boolean;
	boundarySentinel?: boolean;
}

/**
 * Shared builder for every LOD2 material.
 *
 * PERF: the cutout bucket used to reuse the TRANSPARENT material from LOD2
 * outward, which made all distant foliage/glass alpha-BLENDED, double-sided
 * and depth-writing. Blending costs a read-modify-write per fragment against
 * a (multisampled) attachment and `backFaceCulling:false` roughly doubles
 * raster work, while the bucket only needs an alpha TEST. Cutout now gets its
 * own alpha-tested material (see createLod2CutoutMaterial).
 */
function createLod2Material(
	name: string,
	opts: Lod2MaterialOptions,
	vertexOptions: PackedVertexOptions,
	fragmentSource: string,
	texture: Lod2MaterialOptions["diffuseTexture"],
	lutLabel: string,
	extra: {
		backFaceCulling: boolean;
		needAlphaBlending?: boolean;
		blendMode?: "alpha";
		depthWrite?: boolean;
	},
): ShaderMaterial {
	const arenaCount = Math.max(1, opts.faceArenaCount | 0);
	const faceStorageBuffers = [];
	for (let i = 0; i < arenaCount; i++) {
		faceStorageBuffers.push({ name: `faceData${i}`, type: "array<u32>" });
	}
	const material = createShaderMaterial({
		name,
		vertexSource: buildPackedVertexWGSL(arenaCount, vertexOptions),
		fragmentSource,
		attributes: ["position"],
		uniforms: baseUniforms(),
		samplers: [{ name: "diffuseTexture", viewDimension: "2d-array" }],
		storageBuffers: [
			{ name: "tintLUT", type: "array<vec4<f32>, 6>" },
			...faceStorageBuffers,
			{ name: "chunkOffsets", type: "array<vec4<f32>>" },
		],
		backFaceCulling: extra.backFaceCulling,
		needAlphaBlending: extra.needAlphaBlending,
		blendMode: extra.blendMode,
		depthWrite: extra.depthWrite,
	});

	registerPackedMaterial(material);
	setShaderTexture(material, "diffuseTexture", texture);
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
		createStorageBuffer(opts.engine, opts.tintLUT, lutLabel),
	);
	return material;
}

const OPAQUE_VERTEX_OPTIONS: PackedVertexOptions = {
	tangent: false,
	worldPosition: false,
	meta: false,
	tint: true,
	fog: true,
	viewDir: false,
	ao: false,
	bakeShade: true,
};

const TRANSPARENT_VERTEX_OPTIONS: PackedVertexOptions = {
	tangent: false,
	worldPosition: false,
	meta: true,
	tint: true,
	fog: true,
	viewDir: false,
	ao: false,
	bakeShade: true,
	boundarySentinel: false,
};

export function createLod2OpaqueMaterial(
	opts: Lod2MaterialOptions,
): ShaderMaterial {
	return createLod2Material(
		"lod2OpaqueLite",
		opts,
		OPAQUE_VERTEX_OPTIONS,
		lod2OpaqueFragmentWGSL,
		opts.diffuseTexture,
		"lod2-tintLUT",
		{ backFaceCulling: true },
	);
}

/**
 * Alpha-TESTED cutout for LOD2. Same atlas and mip as the opaque path but
 * samples the transparent texture and discards below the system cutoff, so
 * distant foliage/glass rasterise once into an opaque target instead of
 * twice into a blended one.
 */
export function createLod2CutoutMaterial(
	opts: Lod2MaterialOptions,
): ShaderMaterial {
	return createLod2Material(
		"lod2CutoutLite",
		opts,
		TRANSPARENT_VERTEX_OPTIONS,
		lod2CutoutFragmentWGSL,
		opts.cutoutTexture ?? opts.diffuseTexture,
		"lod2-cutout-tintLUT",
		{ backFaceCulling: true },
	);
}

export function createLod2TransparentMaterial(
	opts: Lod2MaterialOptions,
): ShaderMaterial {
	return createLod2Material(
		"lod2TransparentLite",
		opts,
		TRANSPARENT_VERTEX_OPTIONS,
		lod2TransparentFragmentWGSL,
		opts.diffuseTexture,
		"lod2-trans-tintLUT",
		{
			backFaceCulling: false,
			needAlphaBlending: true,
			blendMode: "alpha",
			// Water self-occlusion: unsorted blended faces otherwise let deep
			// cave-opening sides composite over the surface (see
			// OpaqueShaderLite transparent depthWrite).
			depthWrite: true,
		},
	);
}
