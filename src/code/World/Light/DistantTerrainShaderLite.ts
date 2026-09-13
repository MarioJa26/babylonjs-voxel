/**
 * Babylon Lite (native) port of the DistantTerrain + DistantWater shaders.
 * Same repacked/standard-attribute contract as the chunk shaders. The terrain
 * grid mesh only carries `position` + `normal`; the water plane only `position`.
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

const DEEP_BLUE = /* wgsl */ `vec3<f32>(0.1, 0.2, 0.4)`;
const LIGHT_BLUE = /* wgsl */ `vec3<f32>(0.6, 0.75, 0.95)`;
const MID_SKY = /* wgsl */ `vec3<f32>(0.5, 0.7, 0.9)`;
const DAY_SKY = /* wgsl */ `vec3<f32>(0.1, 0.3, 0.6)`;

// Ported faithfully from the pre-Lite GLSL shader. The Lite port's
// updateUniforms() remaps lightDirection, so its sign is inverted vs the old
// code: here lightDirection.y < 0 means the sun is below the horizon (night),
// whereas the old shader tested > 0. All other lighting math is unchanged.
const FOG_HELPER_WGSL = /* wgsl */ `
fn getAtmosphereColor(heightFactor : f32) -> vec3<f32> {
  return mix(${LIGHT_BLUE}, ${DEEP_BLUE}, heightFactor) * (shaderUniforms.sunLightIntensity * shaderUniforms.sunLightIntensity);
}

fn getSkyboxColor(viewDirY : f32, nightAmount : f32) -> vec3<f32> {
  let skyFactor = smoothstep(0.0, 0.4, max(viewDirY, 0.0));
  var skyboxColor = mix(${MID_SKY}, ${DAY_SKY}, skyFactor);
  skyboxColor = mix(skyboxColor, vec3<f32>(0.0, 0.0, 0.0), nightAmount);
  return skyboxColor;
}
`;

const terrainVertexWGSL = /* wgsl */ `
${FOG_HELPER_WGSL}
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vShade : f32,
  @location(1) vPositionW : vec3<f32>,
  @location(2) vFogColor : vec3<f32>,
  @location(3) vFogFactor : f32,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  let worldPos = input.position + shaderSystem.world[3].xyz;
  out.pos = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.vPositionW = worldPos;

  // Clip-map quads are flat 32-block cells with smoothly varying normals;
  // interpolating N·L per-vertex is visually identical to normalizing the
  // interpolated normal per-pixel, at a fraction of the ALU.
  let nrm = normalize(input.normal);
  // Same sun convention as the chunk shaders (dot(N, +lightDirection)).
  let ndotl = max(0.0, dot(nrm, shaderUniforms.lightDirection));
  let sun = shaderUniforms.sunLightIntensity;
  let skyTerm = 0.48 * (sun + 0.2); // (vec3(0.8)*(sun+0.2))*0.6 collapsed
  out.vShade = ndotl * sun * 0.6 + skyTerm;

  let viewVec = shaderSystem.cameraPosition - worldPos;
  let dist = length(viewVec);

  let infos = shaderUniforms.fogInfos;
  let fogFactor = clamp((infos.z - dist) * shaderUniforms.fogInvRange, 0.0, 1.0);

  let heightFactor = clamp(worldPos.y * 0.003, 0.0, 1.0);
  let atmosphereColor = getAtmosphereColor(heightFactor);
  var baseFogColor = mix(shaderUniforms.fogColor, atmosphereColor, 0.8);
  let nightAmount = clamp(1.0 - sun, 0.0, 1.0);
  baseFogColor = mix(baseFogColor, vec3<f32>(0.0, 0.0, 0.0), nightAmount);

  let viewDirY = viewVec.y / max(dist, 1e-4);
  let skyboxColor = getSkyboxColor(viewDirY, nightAmount);
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
  @location(0) vShade : f32,
  @location(1) vPositionW : vec3<f32>,
  @location(2) vFogColor : vec3<f32>,
  @location(3) vFogFactor : f32,
};

fn sampleAtlasTile(tile : vec2<f32>, worldUV : vec2<f32>) -> vec3<f32> {
  let baseUV = vec2<f32>(tile.x * shaderUniforms.atlasTileSize, 1.0 - ((tile.y + 1.0) * shaderUniforms.atlasTileSize));
  let atlasUV = baseUV + fract(worldUV) * shaderUniforms.atlasTileSize;
  return textureSample(diffuseTexture, diffuseTextureSampler, atlasUV).rgb;
}

fn readTopTileFromLookup(vPositionW : vec3<f32>) -> vec2<f32> {
  let grid = (vPositionW.xz - shaderUniforms.gridOriginWorld) / shaderUniforms.gridWorldStep;
  let nearest = clamp(floor(grid + vec2<f32>(0.5)), vec2<f32>(0.0), vec2<f32>(shaderUniforms.tileGridResolution - 1.0));
  let lookupUV = (nearest + vec2<f32>(0.5)) / shaderUniforms.tileGridResolution;
  return floor(textureSample(tileLookupTexture, tileLookupTextureSampler, lookupUV).rg * 255.0 + vec2<f32>(0.5));
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  var albedo = vec3<f32>(0.5);

  if (shaderUniforms.useTexture > 0.5) {
    let tile = readTopTileFromLookup(in.vPositionW);

    let worldUV =
      in.vPositionW.xz /
      shaderUniforms.textureScale;

    albedo = sampleAtlasTile(tile, worldUV);
  }

  let finalColor = albedo * in.vShade;

  return vec4<f32>(
    mix(in.vFogColor, finalColor, in.vFogFactor),
    1.0
  );
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

  // Fog computed per-fragment so the huge flat plane fades correctly
  // (per-vertex would interpolate fully-fogged corners across the whole plane).
  let infos = shaderUniforms.fogInfos;
  let fogFactor = clamp((infos.z - dist) * shaderUniforms.fogInvRange, 0.0, 1.0);

  let heightFactor = clamp(in.vPositionW.y * 0.003, 0.0, 1.0);
  let atmosphereColor = getAtmosphereColor(heightFactor);
  var baseFogColor = mix(shaderUniforms.fogColor, atmosphereColor, 0.8);
  let nightAmount = clamp(1.0 - shaderUniforms.sunLightIntensity, 0.0, 1.0);
  baseFogColor = mix(baseFogColor, vec3<f32>(0.0, 0.0, 0.0), nightAmount);

  let viewDirY = viewVec.y / max(dist, 1e-4);
  let skyboxColor = getSkyboxColor(viewDirY, nightAmount);
  let skyBlend = clamp((dist - 7000.0) * 0.0003333, 0.0, 1.0);
  let fogColor = mix(baseFogColor, skyboxColor, skyBlend);

  let colorWithFog = mix(fogColor, finalColor, fogFactor);
  return vec4<f32>(colorWithFog, 1.0);
}
`;

export interface DistantTerrainMaterialOptions {
	engine: EngineContext;
	scene: SceneContext;
	diffuseTexture: Texture2D | null;
	tileLookupTexture: Texture2D | null;
	atlasTileSize: number;
	textureScale: number;
	tileGridResolution: number;
	gridWorldStep: number;
}

export function createDistantTerrainMaterial(
	opts: DistantTerrainMaterialOptions,
): ShaderMaterial {
	const material = createShaderMaterial({
		name: "distantTerrainLite",
		vertexSource: terrainVertexWGSL,
		fragmentSource: terrainFragmentWGSL,
		attributes: ["position", "normal"],
		uniforms: [
			"world",
			"worldViewProjection",
			"cameraPosition",
			{ name: "lightDirection", type: "vec3<f32>" },
			{ name: "sunLightIntensity", type: "f32" },
			{ name: "atlasTileSize", type: "f32" },
			{ name: "textureScale", type: "f32" },
			{ name: "useTexture", type: "f32" },
			{ name: "tileGridResolution", type: "f32" },
			{ name: "gridOriginWorld", type: "vec2<f32>" },
			{ name: "gridWorldStep", type: "f32" },
			{ name: "fogInfos", type: "vec4<f32>" },
			{ name: "fogColor", type: "vec3<f32>" },
			{ name: "fogInvRange", type: "f32" },
		],
		samplers: ["diffuseTexture", "tileLookupTexture"],
		backFaceCulling: true,
	});
	setShaderTexture(material, "diffuseTexture", opts.diffuseTexture);
	setShaderTexture(material, "tileLookupTexture", opts.tileLookupTexture);
	setShaderUniform(material, "atlasTileSize", opts.atlasTileSize);
	setShaderUniform(material, "textureScale", opts.textureScale);
	setShaderUniform(material, "tileGridResolution", opts.tileGridResolution);
	setShaderUniform(material, "gridWorldStep", opts.gridWorldStep);
	setShaderUniform(material, "useTexture", 1);
	setShaderUniform(material, "sunLightIntensity", 1);
	setShaderUniform(material, "lightDirection", [0, 1, 0]);
	setShaderUniform(material, "fogInfos", [0, 0, 1000, 0]);
	setShaderUniform(material, "fogColor", [0.6, 0.7, 0.9]);
	setShaderUniform(material, "fogInvRange", 1 / 1000);
	return material;
}

export function createDistantWaterMaterial(): ShaderMaterial {
	const material = createShaderMaterial({
		name: "distantWaterLite",
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
		// Don't write depth — the distant water is a single flat plane at sea
		// level spanning the whole view. If it wrote depth, its nearer fragments
		// would occlude all chunk/terrain geometry behind it, making water appear
		// in front of chunks. With depthWrite off it never hides anything; chunks
		// (which do write depth) still occlude it via the depth test.
		depthWrite: false,
	});
	setShaderUniform(material, "sunLightIntensity", 1);
	setShaderUniform(material, "lightDirection", [0, 1, 0]);
	setShaderUniform(material, "fogInfos", [0, 0, 1000, 0]);
	setShaderUniform(material, "fogColor", [0.6, 0.7, 0.9]);
	setShaderUniform(material, "fogInvRange", 1 / 1000);
	return material;
}
