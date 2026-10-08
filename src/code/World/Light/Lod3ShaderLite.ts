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
import { registerPackedMaterial } from "../Chunk/Meshing/PackedChunkMesh.js";
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
fn applyTintBucket(color : vec3<f32>, bucket : u32) -> vec3<f32> {
  let idx = i32(min(bucket, 5u));
  let lum = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  return mix(vec3<f32>(lum), color, tintLUT[idx].a) * tintLUT[idx].rgb;
}

// PERF: no \`discard\` in this shader, on purpose. See the same note in
// Lod2ShaderLite's opaque shader: a discard anywhere in a fragment shader
// disables early depth testing for the whole pass, and neither branch here is
// reachable / load-bearing (lodFadeDirection is pinned to 0 at creation; this
// is the opaque bucket, whose faces are only ever emitted for solid blocks).
@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let singleTileUV = fract(in.vUV);

  let diffuseColor = textureSampleLevel(
    diffuseTexture,
    diffuseTextureSampler,
    singleTileUV,
    in.vTileLayer,
    4.0
  );

  var color = diffuseColor.rgb * in.vShade;

  color = applyTintBucket(color, in.vTint);
  color = mix(color, in.vFogColor, in.vFogFactor);

  return vec4<f32>(color, 1.0);
}
`;

/**
 * Alpha-tested cutout — the LOD3 analogue of OpaqueShaderLite's
 * `cutoutChunkFragmentWGSL`. The cutout bucket no longer borrows the blended
 * transparent material from LOD2 outward (see createLod2CutoutMaterial).
 */
const lod3CutoutFragmentWGSL = /* wgsl */ `
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

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let diffuseColor = textureSampleLevel(
    diffuseTexture,
    diffuseTextureSampler,
    fract(in.vUV),
    in.vTileLayer,
    4.0
  );

  if (diffuseColor.a < shaderSystem.alphaCutoff) {
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
    4.0
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
	/**
	 * Cutout atlas (leaves/glass). Falls back to `diffuseTexture` when the
	 * build only ships one atlas.
	 */
	cutoutTexture?: Texture2D | null;
	tintLUT: Float32Array;
	atlasTileSize: number;
	atlasMaxTiles: number;
	faceArenaCount: number;
}

interface Lod3VertexOptions {
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

const LOD3_OPAQUE_VERTEX_OPTIONS: Lod3VertexOptions = {
	tangent: false,
	worldPosition: false,
	meta: false,
	tint: true,
	fog: true,
	viewDir: false,
	ao: false,
	bakeShade: true,
};

const LOD3_CUTOUT_VERTEX_OPTIONS: Lod3VertexOptions = {
	tangent: false,
	worldPosition: false,
	// The cutout fragment shader never reads vMeta.
	meta: false,
	tint: true,
	fog: true,
	viewDir: false,
	ao: false,
	bakeShade: true,
};

const LOD3_TRANSPARENT_VERTEX_OPTIONS: Lod3VertexOptions = {
	tangent: false,
	worldPosition: false,
	// Transparent faces inspect the water bit in vMeta.
	meta: true,
	tint: true,
	fog: true,
	viewDir: false,
	ao: false,
	bakeShade: true,
	boundarySentinel: false,
};

interface Lod3MaterialRenderOptions {
	backFaceCulling: boolean;
	needAlphaBlending?: boolean;
	blendMode?: "alpha";
	depthWrite?: boolean;
}

interface StorageBufferDeclaration {
	name: string;
	type: string;
}

function createLod3Material(
	name: string,
	opts: Lod3MaterialOptions,
	vertexOptions: Lod3VertexOptions,
	fragmentSource: string,
	texture: Lod3MaterialOptions["diffuseTexture"],
	lutLabel: string,
	renderOptions: Lod3MaterialRenderOptions,
): ShaderMaterial {
	/*
	 * Clamp invalid arena counts to one. Math.trunc avoids the signed 32-bit
	 * wrap performed by "| 0" for unexpectedly large values.
	 */
	const requestedArenaCount = Number.isFinite(opts.faceArenaCount)
		? Math.trunc(opts.faceArenaCount)
		: 1;

	const arenaCount = requestedArenaCount > 0 ? requestedArenaCount : 1;

	/*
	 * Allocate the complete declaration array once instead of creating a
	 * growable faceStorageBuffers array and then spreading it into another
	 * array.
	 *
	 * Layout:
	 * 0 tintLUT
	 * 1..arenaCount faceDataN
	 * arenaCount + 1 chunkOffsets
	 */
	const storageBuffers: StorageBufferDeclaration[] = new Array(arenaCount + 2);

	storageBuffers[0] = {
		name: "tintLUT",
		type: "array<vec4<f32>, 6>",
	};

	for (let i = 0; i < arenaCount; i++) {
		storageBuffers[i + 1] = {
			name: `faceData${i}`,
			type: "array<u32>",
		};
	}

	storageBuffers[arenaCount + 1] = {
		name: "chunkOffsets",
		type: "array<vec4<f32>>",
	};

	const material = createShaderMaterial({
		name,
		vertexSource: buildPackedVertexWGSL(arenaCount, vertexOptions),
		fragmentSource,
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
		storageBuffers,
		backFaceCulling: renderOptions.backFaceCulling,
		needAlphaBlending: renderOptions.needAlphaBlending,
		blendMode: renderOptions.blendMode,
		depthWrite: renderOptions.depthWrite,
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

	const tintBuffer = createStorageBuffer(opts.engine, opts.tintLUT, lutLabel);

	setShaderStorageBuffer(material, "tintLUT", tintBuffer);

	return material;
}

export function createLod3OpaqueMaterial(
	opts: Lod3MaterialOptions,
): ShaderMaterial {
	return createLod3Material(
		"lod3OpaqueLite",
		opts,
		LOD3_OPAQUE_VERTEX_OPTIONS,
		lod3OpaqueFragmentWGSL,
		opts.diffuseTexture,
		"lod3-tintLUT",
		{ backFaceCulling: true },
	);
}

/** Alpha-tested cutout for LOD3 (see createLod2CutoutMaterial). */
export function createLod3CutoutMaterial(
	opts: Lod3MaterialOptions,
): ShaderMaterial {
	return createLod3Material(
		"lod3CutoutLite",
		opts,
		LOD3_CUTOUT_VERTEX_OPTIONS,
		lod3CutoutFragmentWGSL,
		opts.cutoutTexture ?? opts.diffuseTexture,
		"lod3-cutout-tintLUT",
		{ backFaceCulling: true },
	);
}

export function createLod3TransparentMaterial(
	opts: Lod3MaterialOptions,
): ShaderMaterial {
	return createLod3Material(
		"lod3TransparentLite",
		opts,
		LOD3_TRANSPARENT_VERTEX_OPTIONS,
		lod3TransparentFragmentWGSL,
		opts.diffuseTexture,
		"lod3-trans-tintLUT",
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
