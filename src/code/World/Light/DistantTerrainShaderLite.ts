/**
 * Babylon Lite (native) port of the DistantTerrain + DistantWater shaders.
 *
 * Uses the same repacked/standard-attribute contract as the chunk shaders.
 * The terrain grid mesh carries `position` + `normal`; the water plane carries
 * only `position`.
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

// ---------------------------------------------------------------------------
// Shader constants
// ---------------------------------------------------------------------------

const DEEP_BLUE = /* wgsl */ `vec3<f32>(0.1, 0.2, 0.4)`;
const LIGHT_BLUE = /* wgsl */ `vec3<f32>(0.6, 0.75, 0.95)`;
const MID_SKY = /* wgsl */ `vec3<f32>(0.5, 0.7, 0.9)`;
const DAY_SKY = /* wgsl */ `vec3<f32>(0.1, 0.3, 0.6)`;
const BLACK = /* wgsl */ `vec3<f32>(0.0)`;

// Same gray used by the sky shader during rain.
const OVERCAST_DAY_COLOR = /* wgsl */ `vec3<f32>(0.46, 0.49, 0.54)`;

// ---------------------------------------------------------------------------
// Shared fog helpers
// ---------------------------------------------------------------------------

/**
 * The Lite port's updateUniforms() remaps lightDirection, so its sign is
 * inverted relative to the old implementation. Here, lightDirection.y < 0
 * means the sun is below the horizon.
 *
 * Weather is applied before night darkening. This prevents rain from replacing
 * an already-darkened night sky with the light-gray overcast color.
 */
const FOG_HELPER_WGSL = /* wgsl */ `
fn getAtmosphereColor(heightFactor : f32) -> vec3<f32> {
  let sun = shaderUniforms.sunLightIntensity;

  return mix(
    ${LIGHT_BLUE},
    ${DEEP_BLUE},
    heightFactor
  ) * (sun * sun);
}

fn getSkyboxColor(viewDirY : f32, nightAmount : f32) -> vec3<f32> {
  let skyFactor = smoothstep(
    0.0,
    0.4,
    max(viewDirY, 0.0)
  );

  let daylightSky = mix(
    ${MID_SKY},
    ${DAY_SKY},
    skyFactor
  );

  let weatherSky = mix(
    daylightSky,
    ${OVERCAST_DAY_COLOR},
    shaderUniforms.rainAmount
  );

  return mix(
    weatherSky,
    ${BLACK},
    nightAmount
  );
}
`;

// ---------------------------------------------------------------------------
// Distant terrain shaders
// ---------------------------------------------------------------------------

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

  let worldPos =
    input.position +
    shaderSystem.world[3].xyz;

  out.pos =
    shaderSystem.worldViewProjection *
    vec4<f32>(input.position, 1.0);

  out.vPositionW = worldPos;

  /*
   * Clip-map quads are flat cells with smoothly varying normals.
   * Interpolating N·L per vertex is cheaper than normalizing an interpolated
   * normal for every fragment.
   */
  let normal = normalize(input.normal);
  let sun = shaderUniforms.sunLightIntensity;

  let ndotl = max(
    dot(normal, shaderUniforms.lightDirection),
    0.0
  );

  out.vShade =
    ndotl * sun * 0.6 +
    0.48 * (sun + 0.2);

  let viewVec =
    shaderSystem.cameraPosition -
    worldPos;

  let distanceSquared =
    dot(viewVec, viewVec);

  let distance =
    sqrt(distanceSquared);

  let inverseDistance =
    inverseSqrt(max(distanceSquared, 1e-8));

  out.vFogFactor = clamp(
    (shaderUniforms.fogInfos.z - distance) *
      shaderUniforms.fogInvRange,
    0.0,
    1.0
  );

  let heightFactor = clamp(
    worldPos.y * 0.003,
    0.0,
    1.0
  );

  let atmosphereColor =
    getAtmosphereColor(heightFactor);

  let nightAmount = clamp(
    1.0 - sun,
    0.0,
    1.0
  );


  let baseFogColor = mix(
    mix(
      shaderUniforms.fogColor,
      atmosphereColor,
      0.8
    ),
    ${BLACK},
    nightAmount
  );

  let viewDirY =
    viewVec.y * inverseDistance;

  let skyboxColor =
    getSkyboxColor(viewDirY, nightAmount);

  let skyBlend = clamp(
    (distance - 1400.0) * 0.0003333333,
    0.0,
    1.0
  );

  out.vFogColor = mix(
    baseFogColor,
    skyboxColor,
    skyBlend
  );

  return out;
}
`;

const terrainFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vShade : f32,
  @location(1) vPositionW : vec3<f32>,
  @location(2) vFogColor : vec3<f32>,
  @location(3) vFogFactor : f32,
};

fn sampleAtlasTile(
  tile : vec2<f32>,
  worldUV : vec2<f32>
) -> vec3<f32> {
  let tileSize =
    shaderUniforms.atlasTileSize;

  let baseUV = vec2<f32>(
    tile.x * tileSize,
    1.0 - ((tile.y + 1.0) * tileSize)
  );

  let atlasUV =
    baseUV +
    fract(worldUV) * tileSize;

  return textureSample(
    diffuseTexture,
    diffuseTextureSampler,
    atlasUV
  ).rgb;
}

fn readTopTileFromLookup(
  worldPosition : vec3<f32>
) -> vec2<f32> {
  let resolution =
    shaderUniforms.tileGridResolution;

  let grid =
    (worldPosition.xz -
      shaderUniforms.gridOriginWorld) /
    shaderUniforms.gridWorldStep;

  let nearest = clamp(
    floor(grid + vec2<f32>(0.5)),
    vec2<f32>(0.0),
    vec2<f32>(resolution - 1.0)
  );

  let lookupUV =
    (nearest + vec2<f32>(0.5)) /
    resolution;

  return floor(
    textureSample(
      tileLookupTexture,
      tileLookupTextureSampler,
      lookupUV
    ).rg * 255.0 +
    vec2<f32>(0.5)
  );
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  var albedo = vec3<f32>(0.5);

  if (shaderUniforms.useTexture > 0.5) {
    let tile =
      readTopTileFromLookup(in.vPositionW);

    let worldUV =
      in.vPositionW.xz /
      shaderUniforms.textureScale;

    albedo =
      sampleAtlasTile(tile, worldUV);
  }

  let finalColor =
    albedo * in.vShade;

  return vec4<f32>(
    mix(
      in.vFogColor,
      finalColor,
      in.vFogFactor
    ),
    1.0
  );
}
`;

// ---------------------------------------------------------------------------
// Distant water shaders
// ---------------------------------------------------------------------------

const waterVertexWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vPositionW : vec3<f32>,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;

  out.pos =
    shaderSystem.worldViewProjection *
    vec4<f32>(input.position, 1.0);

  out.vPositionW =
    input.position +
    shaderSystem.world[3].xyz;

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
  let sun =
    shaderUniforms.sunLightIntensity;

  let viewVec =
    in.vPositionW -
    shaderSystem.cameraPosition;

  let distanceSquared =
    dot(viewVec, viewVec);

  let distance =
    sqrt(distanceSquared);

  let inverseDistance =
    inverseSqrt(max(distanceSquared, 1e-8));

  let viewDir =
    -viewVec * inverseDistance;

  /*
   * Specialized equivalent of:
   *
   * reflect(shaderUniforms.lightDirection, vec3<f32>(0.0, 1.0, 0.0))
   *
   * reflect(I, N) = I - 2.0 * dot(N, I) * N
   */
  let lightDirection =
    shaderUniforms.lightDirection;

  let reflectDir = vec3<f32>(
    lightDirection.x,
    -lightDirection.y,
    lightDirection.z
  );

  let reflectedView = max(
    dot(viewDir, reflectDir),
    0.0
  );

  /*
   * Preserve the original specular approximation:
   * exp2(64 * log2(e) * (RV - 1)).
   */
  let specularStrength = exp2(
    clamp(
      92.3328 * (reflectedView - 1.0),
      -126.0,
      0.0
    )
  ) * sun;

  let litWater =
    vec3<f32>(0.0, 0.25, 0.55) *
    (sun * 0.8 + 0.2);

  let nightWater =
    vec3<f32>(0.0, 0.06, 0.18);

  let waterColor =
    mix(nightWater, litWater, sun) +
    vec3<f32>(specularStrength);

  /*
   * Fog remains per fragment because the water mesh is one very large plane.
   * Per-vertex fog would interpolate fully fogged corners across the plane.
   */
  let fogFactor = clamp(
    (shaderUniforms.fogInfos.z - distance) *
      shaderUniforms.fogInvRange,
    0.0,
    1.0
  );

  let heightFactor = clamp(
    in.vPositionW.y * 0.003,
    0.0,
    1.0
  );

  let atmosphereColor =
    getAtmosphereColor(heightFactor);

  let nightAmount = clamp(
    1.0 - sun,
    0.0,
    1.0
  );

 
  let baseFogColor = mix(
    mix(
      shaderUniforms.fogColor,
      atmosphereColor,
      0.8
    ),
    ${BLACK},
    nightAmount
  );

  // Preserve the original water shader's view-vector convention.
  let viewDirY =
    viewVec.y * inverseDistance;

  let skyboxColor =
    getSkyboxColor(viewDirY, nightAmount);

  let skyBlend = clamp(
    (distance - 500.0) * 0.00075,
    0.0,
    1.0
  );

  let fogColor = mix(
    baseFogColor,
    skyboxColor,
    skyBlend
  );

  return vec4<f32>(
    mix(
      fogColor,
      waterColor,
      fogFactor
    ),
    1.0
  );
}
`;

// ---------------------------------------------------------------------------
// Material configuration
// ---------------------------------------------------------------------------

/*
 * Full descriptors are required by ShaderUniformOption. String shorthand such
 * as "world" is not accepted by the installed @babylonjs/lite declarations.
 */
const TERRAIN_UNIFORMS = [
	{ name: "world", type: "mat4x4<f32>" },
	{ name: "worldViewProjection", type: "mat4x4<f32>" },
	{ name: "cameraPosition", type: "vec3<f32>" },
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
	{ name: "rainAmount", type: "f32" },
] as const;

const WATER_UNIFORMS = [
	{ name: "world", type: "mat4x4<f32>" },
	{ name: "worldViewProjection", type: "mat4x4<f32>" },
	{ name: "cameraPosition", type: "vec3<f32>" },
	{ name: "lightDirection", type: "vec3<f32>" },
	{ name: "sunLightIntensity", type: "f32" },
	{ name: "fogInfos", type: "vec4<f32>" },
	{ name: "fogColor", type: "vec3<f32>" },
	{ name: "fogInvRange", type: "f32" },
	{ name: "rainAmount", type: "f32" },
] as const;

const DEFAULT_LIGHT_DIRECTION: readonly [number, number, number] = [0, 1, 0];

const DEFAULT_FOG_INFOS: readonly [number, number, number, number] = [
	0, 0, 1000, 0,
];

const DEFAULT_FOG_COLOR: readonly [number, number, number] = [0.6, 0.7, 0.9];

const DEFAULT_FOG_INV_RANGE = 1 / 1000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

function setEnvironmentDefaults(material: ShaderMaterial): void {
	setShaderUniform(material, "sunLightIntensity", 1);

	setShaderUniform(material, "lightDirection", DEFAULT_LIGHT_DIRECTION);

	setShaderUniform(material, "fogInfos", DEFAULT_FOG_INFOS);

	setShaderUniform(material, "fogColor", DEFAULT_FOG_COLOR);

	setShaderUniform(material, "fogInvRange", DEFAULT_FOG_INV_RANGE);

	setShaderUniform(material, "rainAmount", 0);
}

export function createDistantTerrainMaterial(
	opts: DistantTerrainMaterialOptions,
): ShaderMaterial {
	const material = createShaderMaterial({
		name: "distantTerrainLite",
		vertexSource: terrainVertexWGSL,
		fragmentSource: terrainFragmentWGSL,
		attributes: ["position", "normal"],
		uniforms: TERRAIN_UNIFORMS,
		samplers: ["diffuseTexture", "tileLookupTexture"],
		backFaceCulling: true,
	});

	setShaderTexture(material, "diffuseTexture", opts.diffuseTexture);

	setShaderTexture(material, "tileLookupTexture", opts.tileLookupTexture);

	setShaderUniform(material, "atlasTileSize", opts.atlasTileSize);

	setShaderUniform(material, "textureScale", opts.textureScale);

	setShaderUniform(material, "tileGridResolution", opts.tileGridResolution);

	setShaderUniform(material, "gridWorldStep", opts.gridWorldStep);

	setShaderUniform(
		material,
		"useTexture",
		opts.diffuseTexture !== null && opts.tileLookupTexture !== null ? 1 : 0,
	);

	setEnvironmentDefaults(material);

	return material;
}

export function createDistantWaterMaterial(): ShaderMaterial {
	const material = createShaderMaterial({
		name: "distantWaterLite",
		vertexSource: waterVertexWGSL,
		fragmentSource: waterFragmentWGSL,
		attributes: ["position"],
		uniforms: WATER_UNIFORMS,
		samplers: [],
		backFaceCulling: true,

		/*
		 * The distant water is a flat sea-level plane spanning the whole view.
		 * Writing depth would allow its nearer fragments to hide chunk and terrain
		 * geometry behind it.
		 *
		 * Depth testing remains enabled, so chunks can still occlude the water.
		 */
		depthWrite: false,
	});

	setEnvironmentDefaults(material);

	return material;
}
