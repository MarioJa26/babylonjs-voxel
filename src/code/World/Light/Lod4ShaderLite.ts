/**
 * Babylon Lite shader for downsampled chunk meshes (LOD4+, lodStep > 1).
 *
 * Companion to Lod3ShaderLite, consuming the "raw units" face encoding:
 * QuadBuffer.emitQuadRawUnits writes whole-block positions and dimensions
 * verbatim with a zero meta byte, so buildPackedVertexWGSL({ rawUnits: true })
 * removes the fixed-point scaling and boundary-correction paths.
 *
 * Differences from the LOD3 materials:
 * - vertex source uses rawUnits: true
 * - the six-entry tint LUT is baked into the opaque fragment shader
 * - the water fragment omits the unused tint LUT entirely
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
import { registerPackedMaterial } from "../Chunk/Meshing/PackedChunkMesh.js";
import { buildPackedVertexWGSL } from "./PackedChunkShaderWGSL.js";

interface StorageBufferDeclaration {
	name: string;
	type: string;
}

interface Lod4RenderOptions {
	backFaceCulling: boolean;
	needAlphaBlending?: boolean;
	blendMode?: "alpha";
}

const LOD4_VERTEX_OPTIONS = {
	tangent: false,
	worldPosition: false,
	meta: false,
	tint: true,
	fog: true,

	// No view-dependent LOD lighting.
	viewDir: false,

	// Positions and dimensions are already expressed in block units.
	rawUnits: true,

	// Downsampled sessions disable AO, so omit its decode and varying.
	ao: false,

	// Hoist wetness, N.L, light mix, and face shade into one flat value.
	bakeShade: true,
} as const;

/**
 * Formats a finite JavaScript number as a WGSL-compatible f32 literal.
 *
 * Integer-valued numbers receive a decimal point so they cannot be inferred
 * as abstract integer literals inside vec4<f32> constructors.
 */
function wgslFloat(value: number, fallback: number): string {
	const finiteValue = Number.isFinite(value) ? value : fallback;

	if (Object.is(finiteValue, -0)) {
		return "0.0";
	}

	const text = String(finiteValue);

	if (text.includes(".") || text.includes("e") || text.includes("E")) {
		return text;
	}

	return `${text}.0`;
}

/**
 * Bakes the six-entry tint LUT into the opaque fragment shader.
 *
 * WGSL uses var<private> rather than const because the selected bucket is a
 * runtime value.
 */
function tintLutWgsl(lut: Float32Array): string {
	let source =
		"// Baked from ChunkMesher's LOD_TINT_LUT.\n" +
		"var<private> tintLUT : array<vec4<f32>, 6> = " +
		"array<vec4<f32>, 6>(\n";

	for (let i = 0; i < 6; i++) {
		const offset = i << 2;

		source +=
			" vec4<f32>(" +
			wgslFloat(lut[offset], 1) +
			", " +
			wgslFloat(lut[offset + 1], 1) +
			", " +
			wgslFloat(lut[offset + 2], 1) +
			", " +
			wgslFloat(lut[offset + 3], 1) +
			"),\n";
	}

	return source + ");\n";
}

/**
 * Opaque fragment shader: tinted diffuse plus fog.
 *
 * There is intentionally no discard. Opaque downsampled faces use opaque
 * atlas entries, allowing early depth testing for the complete pass.
 */
function makeOpaqueFragmentSource(lut: Float32Array): string {
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

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let diffuseColor = textureSampleLevel(
    diffuseTexture,
    diffuseTextureSampler,
    fract(in.vUV),
    in.vTileLayer,
    4.0
  );

  // Defensive clamp prevents malformed packed data from dynamically indexing
  // beyond the six-entry private array.
  let tintIndex = min(in.vTint, 5u);

  let litColor =
    diffuseColor.rgb *
    in.vShade *
    tintLUT[tintIndex].rgb;

  return vec4<f32>(
    mix(
      litColor,
      in.vFogColor,
      in.vFogFactor
    ),
    1.0
  );
}
`;
}

/**
 * Water fragment shader.
 *
 * The texture sample remains necessary for atlas alpha testing, but no tint
 * LUT is declared because water color does not use it.
 */
function makeWaterFragmentSource(): string {
	return /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) @interpolate(flat) vTileLayer : u32,
  @location(10) vFogFactor : f32,
  @location(11) vFogColor : vec3<f32>,
  @location(12) @interpolate(flat) vTint : u32,
  @location(15) @interpolate(flat) vShade : vec3<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let diffuseAlpha = textureSampleLevel(
    diffuseTexture,
    diffuseTextureSampler,
    fract(in.vUV),
    in.vTileLayer,
    4.0
  ).a;

  if (diffuseAlpha < 0.01) {
    discard;
  }

  let waterColor =
    vec3<f32>(0.1, 0.4, 0.7) *
    min(in.vShade, vec3<f32>(0.6));

  return vec4<f32>(
    mix(
      waterColor,
      in.vFogColor,
      in.vFogFactor
    ),
    diffuseAlpha
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

function normalizedArenaCount(value: number): number {
	if (!Number.isFinite(value)) {
		return 1;
	}

	const integerValue = Math.trunc(value);
	return integerValue > 0 ? integerValue : 1;
}

function createStorageBufferDeclarations(
	arenaCount: number,
): StorageBufferDeclaration[] {
	/*
	 * Allocate the final array once rather than building a temporary face
	 * array and spreading it into a second array.
	 */
	const declarations = new Array<StorageBufferDeclaration>(arenaCount + 1);

	for (let i = 0; i < arenaCount; i++) {
		declarations[i] = {
			name: `faceData${i}`,
			type: "array<u32>",
		};
	}

	declarations[arenaCount] = {
		name: "chunkOffsets",
		type: "array<vec4<f32>>",
	};

	return declarations;
}

function buildCommonMaterial(
	name: string,
	opts: Lod4MaterialOptions,
	fragmentSource: string,
	renderOptions: Lod4RenderOptions,
): ShaderMaterial {
	const arenaCount = normalizedArenaCount(opts.faceArenaCount);

	const storageBuffers = createStorageBufferDeclarations(arenaCount);

	const material = createShaderMaterial({
		name,
		vertexSource: buildPackedVertexWGSL(arenaCount, LOD4_VERTEX_OPTIONS),
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
		// NOTE: no tintLUT storage binding — the opaque variant bakes the LUT
		// into the fragment source, and the water variant does not use it.
		storageBuffers,
		...renderOptions,
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
		makeOpaqueFragmentSource(opts.tintLUT),
		{ backFaceCulling: true },
	);
}

export function createLod4TransparentMaterial(
	opts: Lod4MaterialOptions,
): ShaderMaterial {
	return buildCommonMaterial(
		"lod4TransparentLite",
		opts,
		makeWaterFragmentSource(),
		{
			backFaceCulling: true,
			needAlphaBlending: false,
		},
	);
}
