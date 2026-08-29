/**
 * Babylon Lite shader for downsampled chunk meshes (LOD4+, lodStep > 1).
 *
 * Companion to Lod3ShaderLite, consuming the "raw units" face encoding:
 * QuadBuffer.emitQuadRawUnits writes whole-block positions/dimensions
 * verbatim with a zero meta byte, so buildPackedVertexWGSL({ rawUnits })
 * strips the entire ×8 scaling machinery (INV_POS decode, posOff
 * corrections, materialType==3 boundary restore, rawDimensions selects,
 * flip bit, diagonal branch, fractional UV offsets).
 *
 * Differences vs the LOD3 materials:
 *  - vertex source built with { rawUnits: true } (slim vertex stage)
 *  - the tint LUT is baked into the fragment source as a module-scope
 *    private array instead of a storage buffer (one binding fewer)
 * Everything else (dither fade, wetness darkening, fog, vertex-hoisted
 * N·L diffuse) mirrors the LOD3 shaders exactly.
 */
import {
	createShaderMaterial,
	type EngineContext,
	type SceneContext,
	type ShaderMaterial,
	setShaderTexture,
	setShaderUniform,
	type Texture2D,
} from "@babylonjs/lite";
import { registerPackedMaterial } from "../Chunk/PackedChunkMesh.js";
import { buildPackedVertexWGSL } from "./PackedChunkShaderWGSL.js";

// Bakes the 6-entry tint LUT into WGSL. `var<private>` (not `const`) so the
// dynamic bucket index is valid WGSL.
function tintLutWgsl(lut: Float32Array): string {
	const rows: string[] = [];
	for (let i = 0; i < 6; i++) {
		const r = lut[i * 4];
		const g = lut[i * 4 + 1];
		const b = lut[i * 4 + 2];
		const a = lut[i * 4 + 3];
		rows.push(`  vec4<f32>(${r}, ${g}, ${b}, ${a}),`);
	}
	return (
		`// Baked from ChunkMesher's LOD_TINT_LUT (passed via opts.tintLUT).\n` +
		`var<private> tintLUT : array<vec4<f32>, 6> = array<vec4<f32>, 6>(\n` +
		rows.join("\n") +
		`\n);\n`
	);
}

// The two fragment variants differ only in alpha handling; generate both
// from one template to keep them in lockstep.
function makeFragmentSource(lut: Float32Array): string {
	return /* wgsl */ `${tintLutWgsl(lut)}
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
  let idx = min(bucket, 5u);
  return color * tintLUT[idx].rgb;
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

  let litColor = applyTintBucket(
    diffuseColor.rgb * in.vShade,
    in.vTint
  );

  return vec4<f32>(
    mix(litColor, in.vFogColor, in.vFogFactor),
    1.0
  );
}
`;
}

export interface Lod4MaterialOptions {
	engine: EngineContext;
	scene: SceneContext;
	diffuseTexture: Texture2D | null;
	tintLUT: Float32Array;
	atlasTileSize: number;
	atlasMaxTiles: number;
	faceArenaCount: number;
}

function buildCommonMaterial(
	name: string,
	opts: Lod4MaterialOptions,
	fragmentSource: string,
	extra: {
		backFaceCulling: boolean;
		needAlphaBlending?: boolean;
		blendMode?: "alpha";
	},
): ShaderMaterial {
	const arenaCount = Math.max(1, opts.faceArenaCount | 0);
	const faceStorageBuffers = [];
	for (let i = 0; i < arenaCount; i++) {
		faceStorageBuffers.push({ name: `faceData${i}`, type: "array<u32>" });
	}
	const material = createShaderMaterial({
		name,
		vertexSource: buildPackedVertexWGSL(arenaCount, {
			tangent: false,
			worldPosition: false,
			meta: false,
			tint: true,
			fog: true,

			// Free win: no view-dependent LOD lighting now.
			viewDir: false,

			// Slim raw-units variant — see interface doc.
			rawUnits: true,

			// Downsampled builds run with session.disableAO=true, so every
			// face's packed AO byte is zero. Drop the decode + varying.
			// (The fragment VSOut below must stay in sync.)
			ao: false,

			// Bake wetness × N·L × lightMix × faceShade into one flat vec3 in
			// the vertex stage; the fragment below reads only `in.vShade`.
			// (Keeps the fragment VSOut above in sync.)
			bakeShade: true,
		}),
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
		storageBuffers: [
			// NOTE: no tintLUT binding — baked into the fragment source.
			...faceStorageBuffers,
			{ name: "chunkOffsets", type: "array<vec4<f32>>" },
		],
		...extra,
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
	return material;
}

export function createLod4OpaqueMaterial(
	opts: Lod4MaterialOptions,
): ShaderMaterial {
	return buildCommonMaterial(
		"lod4OpaqueLite",
		opts,
		makeFragmentSource(opts.tintLUT),
		{ backFaceCulling: true },
	);
}

export function createLod4TransparentMaterial(
	opts: Lod4MaterialOptions,
): ShaderMaterial {
	return buildCommonMaterial(
		"lod4TransparentLite",
		opts,
		makeFragmentSource(opts.tintLUT),
		{
			backFaceCulling: false,
			needAlphaBlending: true,
			blendMode: "alpha",
		},
	);
}
