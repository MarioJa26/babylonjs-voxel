/**
 * Babylon Lite materials for far-tile LOD meshes (LOD6+).
 *
 * Vertex data is CPU-expanded from the compact face format produced by
 * FarTileGenerator into standard Lite slots:
 *   position : Float32x3 (world-space)
 *   normal   : Float32x3
 *   uv       : Float32x2 (block-space, tiles per block via fract)
 *   uv2      : Float32x2 (atlas tile id, constant per quad)
 *   color    : Float32x4 (r = light factor)
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

const FOG_HELPER_WGSL = /* wgsl */ `
fn ftAtmosphereColor(heightFactor : f32) -> vec3<f32> {
  return mix(vec3<f32>(0.6, 0.75, 0.95), vec3<f32>(0.1, 0.2, 0.4), heightFactor)
    * (shaderUniforms.sunLightIntensity * shaderUniforms.sunLightIntensity);
}

fn ftSkyboxColor(viewDirY : f32, nightAmount : f32) -> vec3<f32> {
  let skyFactor = smoothstep(0.0, 0.4, max(viewDirY, 0.0));
  var skyboxColor = mix(vec3<f32>(0.5, 0.7, 0.9), vec3<f32>(0.1, 0.3, 0.6), skyFactor);
  skyboxColor = mix(skyboxColor, vec3<f32>(0.0, 0.0, 0.0), nightAmount);
  return skyboxColor;
}
`;

const terrainVertexWGSL = /* wgsl */ `
${FOG_HELPER_WGSL}
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vPositionW : vec3<f32>,
  @location(1) vTile : vec2<f32>,
  // Per-vertex shading: every far-tile face is FLAT (axis-aligned constant
  // normal), so N·L and the sky term are identical across each quad's pixels
  // and fold exactly into one scalar here instead of per-pixel work.
  @location(2) vShade : f32,
  // Axis hint for triplanar UV selection: 0 = X-facing, 1 = Y-facing, 2 = Z.
  @location(3) vAxisMode : f32,
  @location(4) vFogColor : vec3<f32>,
  @location(5) vFogFactor : f32,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  let worldPos = input.position + shaderSystem.world[3].xyz;
  out.pos = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.vPositionW = worldPos;
  out.vTile = input.uv2;

  let nrm = normalize(input.normal);
  // Chunk-matching sun convention: dot(N, +lightDirection).
  let ndotl = max(0.0, dot(nrm, shaderUniforms.lightDirection));
  let sun = shaderUniforms.sunLightIntensity;
  let shade =
    (ndotl * sun * 0.6 + 0.48 * (sun + 0.2)) * mix(0.55, 1.0, input.color.r);
  out.vShade = shade;

  // Triplanar axis hint from the face normal's dominant component.
  let an = abs(nrm);
  out.vAxisMode =
    select(select(2.0, 0.0, an.x > an.y), 1.0, an.y >= an.x && an.y >= an.z);

  let toCamera = shaderSystem.cameraPosition - worldPos;
  let dist = length(toCamera);

  let infos = shaderUniforms.fogInfos;
  let fogFactor = clamp((infos.z - dist) * shaderUniforms.fogInvRange, 0.0, 1.0);

  let heightFactor = clamp(worldPos.y * 0.003, 0.0, 1.0);
  let atmosphereColor = ftAtmosphereColor(heightFactor);
  var baseFogColor = mix(shaderUniforms.fogColor, atmosphereColor, 0.8);
  let nightAmount = clamp(1.0 - sun, 0.0, 1.0);
  baseFogColor = mix(baseFogColor, vec3<f32>(0.0, 0.0, 0.0), nightAmount);

  let viewDirY = toCamera.y / max(dist, 1e-4);
  let skyboxColor = ftSkyboxColor(viewDirY, nightAmount);
  let skyBlend = clamp((dist - 1400.0) * 0.0003333, 0.0, 1.0);

  out.vFogColor = mix(baseFogColor, skyboxColor, skyBlend);
  out.vFogFactor = fogFactor;
  return out;
}
`;

const terrainFragmentWGSL = /* wgsl */ `
${FOG_HELPER_WGSL}
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vPositionW : vec3<f32>,
  @location(1) vTile : vec2<f32>,
  @location(2) vShade : f32,
  @location(3) vAxisMode : f32,
  @location(4) vFogColor : vec3<f32>,
  @location(5) vFogFactor : f32,
};

fn sampleAtlasTile(tile : vec2<f32>, worldUV : vec2<f32>) -> vec3<f32> {
  let baseUV = vec2<f32>(tile.x * shaderUniforms.atlasTileSize, 1.0 - ((tile.y + 1.0) * shaderUniforms.atlasTileSize));
  let atlasUV = baseUV + fract(worldUV) * shaderUniforms.atlasTileSize;
  return textureSample(diffuseTexture, diffuseTextureSampler, atlasUV).rgb;
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  // Triplanar-ish UV selection so side faces tile correctly. The dominant
  // axis arrives precomputed from the vertex stage (faces are flat).
  var worldUV = in.vPositionW.xz / shaderUniforms.textureScale;
  if (in.vAxisMode < 0.5) {
    worldUV = in.vPositionW.zy / shaderUniforms.textureScale;
  } else if (in.vAxisMode > 1.5) {
    worldUV = in.vPositionW.xy / shaderUniforms.textureScale;
  }

  let texColor = sampleAtlasTile(in.vTile, worldUV);
  let finalColor = texColor * in.vShade;

  let colorWithFog = mix(in.vFogColor, finalColor, in.vFogFactor);
  return vec4<f32>(colorWithFog, 1.0);
}
`;

const waterVertexWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vPositionW : vec3<f32>,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  out.pos = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.vPositionW = input.position + shaderSystem.world[3].xyz;
  return out;
}
`;

const waterFragmentWGSL = /* wgsl */ `
${FOG_HELPER_WGSL}
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vPositionW : vec3<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let normal = vec3<f32>(0.0, 1.0, 0.0);

  let viewVec = in.vPositionW - shaderSystem.cameraPosition;
  let dist = length(viewVec);
  let viewDir = -viewVec / max(dist, 1e-4);

  let reflectDir = reflect(shaderUniforms.lightDirection, normal);
  let RV = max(dot(viewDir, reflectDir), 0.0);
  let spec = exp2(clamp(64.0 * 1.4427 * (RV - 1.0), -126.0, 0.0));
  let specular = vec3<f32>(spec * shaderUniforms.sunLightIntensity);

  let litWater = vec3<f32>(0.0, 0.25, 0.55) * (shaderUniforms.sunLightIntensity * 0.8 + 0.2);
  let nightWater = vec3<f32>(0.0, 0.06, 0.18);
  let finalColor = mix(nightWater, litWater, shaderUniforms.sunLightIntensity) + specular;

  let infos = shaderUniforms.fogInfos;
  let fogFactor = clamp((infos.z - dist) * shaderUniforms.fogInvRange, 0.0, 1.0);

  let heightFactor = clamp(in.vPositionW.y * 0.003, 0.0, 1.0);
  let atmosphereColor = ftAtmosphereColor(heightFactor);
  var baseFogColor = mix(shaderUniforms.fogColor, atmosphereColor, 0.8);
  let nightAmount = clamp(1.0 - shaderUniforms.sunLightIntensity, 0.0, 1.0);
  baseFogColor = mix(baseFogColor, vec3<f32>(0.0, 0.0, 0.0), nightAmount);

  let viewDirY = viewVec.y / max(dist, 1e-4);
  let skyboxColor = ftSkyboxColor(viewDirY, nightAmount);
  let skyBlend = clamp((dist - 7000.0) * 0.0003333, 0.0, 1.0);
  let fogColor = mix(baseFogColor, skyboxColor, skyBlend);

  let colorWithFog = mix(fogColor, finalColor, fogFactor);
  return vec4<f32>(colorWithFog, 1.0);
}
`;

export interface FarTileMaterialOptions {
	engine: EngineContext;
	scene: SceneContext;
	diffuseTexture: Texture2D | null;
	atlasTileSize: number;
	textureScale: number;
}

export function createFarTileTerrainMaterial(
	opts: FarTileMaterialOptions,
): ShaderMaterial {
	const material = createShaderMaterial({
		name: "farTileTerrainLite",
		vertexSource: terrainVertexWGSL,
		fragmentSource: terrainFragmentWGSL,
		attributes: ["position", "normal", "uv2", "color"],
		uniforms: [
			"world",
			"worldViewProjection",
			"cameraPosition",
			{ name: "lightDirection", type: "vec3<f32>" },
			{ name: "sunLightIntensity", type: "f32" },
			{ name: "atlasTileSize", type: "f32" },
			{ name: "textureScale", type: "f32" },
			{ name: "fogInfos", type: "vec4<f32>" },
			{ name: "fogColor", type: "vec3<f32>" },
			{ name: "fogInvRange", type: "f32" },
		],
		samplers: ["diffuseTexture"],
		backFaceCulling: true,
	});
	setShaderTexture(material, "diffuseTexture", opts.diffuseTexture);
	setShaderUniform(material, "atlasTileSize", opts.atlasTileSize);
	setShaderUniform(material, "textureScale", opts.textureScale);
	setShaderUniform(material, "sunLightIntensity", 1);
	setShaderUniform(material, "lightDirection", [0, 1, 0]);
	setShaderUniform(material, "fogInfos", [0, 0, 1000, 0]);
	setShaderUniform(material, "fogColor", [0.6, 0.7, 0.9]);
	setShaderUniform(material, "fogInvRange", 1 / 1000);
	return material;
}

export function createFarTileWaterMaterial(): ShaderMaterial {
	const material = createShaderMaterial({
		name: "farTileWaterLite",
		vertexSource: waterVertexWGSL,
		fragmentSource: waterFragmentWGSL,
		attributes: ["position"],
		uniforms: [
			"world",
			"worldViewProjection",
			"cameraPosition",
			{ name: "lightDirection", type: "vec3<f32>" },
			{ name: "sunLightIntensity", type: "f32" },
			{ name: "fogInfos", type: "vec4<f32>" },
			{ name: "fogColor", type: "vec3<f32>" },
			{ name: "fogInvRange", type: "f32" },
		],
		samplers: [],
		backFaceCulling: true,
		// Same reasoning as the clip-map water: never publish depth so real
		// chunk geometry always wins the depth test against this plane.
		depthWrite: false,
	});
	setShaderUniform(material, "sunLightIntensity", 1);
	setShaderUniform(material, "lightDirection", [0, 1, 0]);
	setShaderUniform(material, "fogInfos", [0, 0, 1000, 0]);
	setShaderUniform(material, "fogColor", [0.6, 0.7, 0.9]);
	setShaderUniform(material, "fogInvRange", 1 / 1000);
	return material;
}
