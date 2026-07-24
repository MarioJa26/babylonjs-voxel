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
	setShaderTexture,
	setShaderUniform,
	type Texture2D,
} from "@babylonjs/lite";
import { registerPackedMaterial } from "../Chunk/PackedChunkMesh.js";
import { buildPackedVertexWGSL } from "./PackedChunkShaderWGSL.js";

// Opaque / transparent materials declare diffuse + normal samplers (2 sampler
// pairs). Babylon Lite auto-injects faceData@6 / chunkOffsets@7 from storageBuffers.
export const opaqueChunkVertexWGSL = buildPackedVertexWGSL;

export const opaqueChunkFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) @interpolate(flat) vUV2 : vec2<f32>,
  @location(3) @interpolate(flat) vTangent : vec3<f32>,
  @location(5) @interpolate(flat) vNormal : vec3<f32>,
  @location(6) vAO : f32,
  @location(7) @interpolate(flat) vLight : vec2<f32>,
  @location(10) vFogFactor : f32,
  @location(11) vFogColor : vec3<f32>,
  @location(12) vTint : f32,
  @location(13) vViewDir : vec3<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let singleTileUV = fract(in.vUV);
  let layer = u32(in.vUV2.y) * u32(shaderUniforms.atlasMaxTiles) + u32(in.vUV2.x);

  var diffuseColor = textureSampleGrad(diffuseTexture, diffuseTextureSampler, singleTileUV, layer, dpdx(in.vUV), dpdy(in.vUV));
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

  let color = (diffuseColor.rgb * (1.0 + diffuseIntensity * shaderUniforms.sunLightIntensity) + specular) * lightMix * aoFactor;

  let finalColor = color;
  return vec4<f32>(finalColor, 1.0);
}
`;

export const transparentChunkVertexWGSL = opaqueChunkVertexWGSL;

export const transparentChunkFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) @interpolate(flat) vUV2 : vec2<f32>,
  @location(2) vWorldPosition : vec3<f32>,
  @location(3) @interpolate(flat) vTangent : vec3<f32>,
  @location(5) @interpolate(flat) vNormal : vec3<f32>,
  @location(6) vAO : f32,
  @location(7) @interpolate(flat) vLight : vec2<f32>,
  @location(9) @interpolate(flat) vMeta : f32,
  @location(10) vFogFactor : f32,
  @location(11) vFogColor : vec3<f32>,
  @location(12) vTint : f32,
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
  return mix(
    mix(hash(i + vec2<f32>(0.0, 0.0)), hash(i + vec2<f32>(1.0, 0.0)), u.x),
    mix(hash(i + vec2<f32>(0.0, 1.0)), hash(i + vec2<f32>(1.0, 1.0)), u.x),
    u.y
  );
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  // meta (isWater flag in bit 3) is carried in vMeta for near transparent
  // meshes; glass/other transparent have isWater = 0.
  let faceMeta = u32(in.vMeta);
  let isWater = f32((faceMeta >> 3u) & 1u);

  let scrollDir = vec2<f32>(-shaderUniforms.time * 0.3, shaderUniforms.time * 0.4) * isWater;
  let animatedUV = in.vUV + scrollDir;
  let singleTileUV = fract(animatedUV);
  let layer = u32(in.vUV2.y) * u32(shaderUniforms.atlasMaxTiles) + u32(in.vUV2.x);

  var diffuseColor = textureSampleGrad(diffuseTexture, diffuseTextureSampler, singleTileUV, layer, dpdx(in.vUV), dpdy(in.vUV));
  if (diffuseColor.a < 0.01) { discard; }

  var worldNormal : vec3<f32>;
  if (isWater > 0.5) {
    let wavePos = in.vWorldPosition.xz * 0.3 + scrollDir;
    let eps = 0.05;
    let wC = valueNoise(wavePos);
    let wCDX = valueNoise(wavePos + vec2<f32>(eps, 0.0));
    let wCDZ = valueNoise(wavePos + vec2<f32>(0.0, eps));
    let waveStrength = 0.15;
    worldNormal = normalize(vec3<f32>(
      -(wCDX - wC) / eps * waveStrength,
      1.0,
      -(wCDZ - wC) / eps * waveStrength
    ));
  } else {
    worldNormal = in.vNormal;
  }

  let lightDirection = shaderUniforms.lightDirection;
  let viewDir = in.vViewDir;
  let diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));

  let halfwayDir = normalize(viewDir + lightDirection);
  let specPower = mix(16.0, 64.0, isWater);
  let NH = max(dot(worldNormal, halfwayDir), 0.0);
  let spec = exp2(clamp(specPower * 1.4427 * (NH - 1.0), -126.0, 0.0));
  let specularIntensity = mix(0.2, 0.7, isWater) * in.vLight.x;
  let specular = vec3<f32>(specularIntensity) * spec * shaderUniforms.sunLightIntensity;

  let aoFactor = 1.0 - in.vAO * 0.1;
  let blockLight = in.vLight.y;
  let skyLight = in.vLight.x;
  let lightLevel = max(skyLight, blockLight);

  let skyScale = skyLight * 0.8 * (shaderUniforms.sunLightIntensity + 0.2);
  let lightMix = clamp(skyScale + blockLight * vec3<f32>(0.9, 0.6, 0.2), vec3<f32>(0.0), vec3<f32>(1.0));

  var litColor = diffuseColor.rgb * (1.0 + diffuseIntensity * shaderUniforms.sunLightIntensity) + specular;
  let luminance = dot(litColor, vec3<f32>(0.299, 0.587, 0.114));
  let saturation = mix(1.0, 0.5, isWater);
  litColor = mix(vec3<f32>(luminance), litColor, lightLevel * saturation + (1.0 - saturation));

  let finalColor = litColor * max(lightMix * aoFactor, vec3<f32>(mix(0.02, 0.08, isWater)));

  let baseAlpha = diffuseColor.a;
  let alpha = baseAlpha * mix(1.0, mix(0.9, 0.4, lightLevel), isWater);

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
	opts: ChunkMaterialOptions,
): ShaderMaterial {
	const samplers: { name: string; viewDimension: "2d" | "2d-array" }[] = [
		{ name: "diffuseTexture", viewDimension: "2d-array" },
	];
	if (useNormal) {
		samplers.push({ name: "normalTexture", viewDimension: "2d-array" });
	}

	const arenaCount = Math.max(1, opts.faceArenaCount | 0);
	const faceStorageBuffers = [];
	for (let i = 0; i < arenaCount; i++) {
		faceStorageBuffers.push({
			name: `faceData${i}`,
			type: "array<vec4<u32>>",
		});
	}

	const material = createShaderMaterial({
		name,
		vertexSource: opaqueChunkVertexWGSL(arenaCount),
		fragmentSource,
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
			{ name: "time", type: "f32" },
			{ name: "fogInfos", type: "vec4<f32>" },
			{ name: "fogColor", type: "vec3<f32>" },
		],
		samplers,
		storageBuffers: [
			...faceStorageBuffers,
			{ name: "chunkOffsets", type: "array<vec4<f32>>" },
		],
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
	setShaderUniform(material, "sunLightIntensity", 1);
	setShaderUniform(material, "wetness", 0);
	setShaderUniform(material, "time", 0);
	setShaderUniform(material, "lightDirection", [0, 1, 0]);
	setShaderUniform(material, "fogInfos", [0, 140, 2600, 0]);
	setShaderUniform(material, "fogColor", [0.6, 0.7, 0.9]);
	return material;
}

export function createChunkOpaqueMaterial(
	opts: ChunkMaterialOptions,
): ShaderMaterial {
	return buildChunkMaterial(
		"chunkOpaqueLite",
		opaqueChunkFragmentWGSL,
		true,
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
		opts,
	);
}
