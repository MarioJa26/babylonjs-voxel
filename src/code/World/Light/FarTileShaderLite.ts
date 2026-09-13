/**
 * Babylon Lite materials for far-tile LOD meshes (LOD6+) — GPU face-decoding
 * variant.
 *
 * Faces arrive from FarTileGenerator as 4×u32 words and go into a per-level
 * `faceData` storage buffer VERBATIM (no CPU expansion). Each level mesh is a
 * single shared quad drawn once per face via thin instances (compact stride-16
 * records injected by the lite patch as `instData`; the record content is
 * unused here — `@builtin(instance_index)` selects the face directly).
 *
 * Face encoding (see FarTileFaceFormat.ts):
 *   w0: x:u10 | (y+Y_OFF):u12 | z:u10      tile-local block coords
 *   w1: w:u10 | h:u10 | backFace:u1(b20) | axis:u2(b21-22)
 *   w2: tileX:u8 | tileY:u8 | light:u8
 *   w3: kind:u8 (low byte) | tileOriginIndex:u16 (bits 8-23, stamped by the
 *       manager) — indexes the `tileOrigins` storage buffer of vec2<f32>
 *       world-space X/Z origins.
 *
 * Corner selection: each level renders through TWO meshes that share the
 * face-word storage buffer — one with straight indices (0,1,2)(0,2,3) for
 * backFace=1 faces, one with reversed indices (0,2,1)(0,3,2) for backFace=0
 * — exactly reproducing the CPU expander's per-face winding with backface
 * culling ON. Coplanar opposite-facing skirt pairs at tile/ring boundaries
 * are therefore culled from behind (no z-fighting). The per-instance record
 * (compact stride-16 vec4 injected by the lite patch) carries the absolute
 * face index in instData.x; instance_index is not used for indexing.
 *
 * Fragment stages keep the previous fog/sky/atlas math bit-for-bit; only the
 * vertex stage changed its data source.
 */
import {
	createShaderMaterial,
	type EngineContext,
	type SceneContext,
	type ShaderMaterial,
	type StorageBuffer,
	setShaderStorageBuffer,
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

// Shared face-decode + quad-expansion prologue for both variants.
const FACE_EXPAND_WGSL = /* wgsl */ `
const FAR_TILE_Y_OFFSET : f32 = 1024.0;

const CORNER_U = array<f32, 4>(0.0, 1.0, 1.0, 0.0);
const CORNER_V = array<f32, 4>(0.0, 0.0, 1.0, 1.0);

// Right-handed (U, V) bases per axis — mirrors the deleted CPU AXIS_BASIS:
//   axis 0: U=Y(w), V=Z(h)   axis 1: U=Z(w), V=X(h)   axis 2: U=X(w), V=Y(h)
const AXIS_U = array<vec3<f32>, 3>(
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(1.0, 0.0, 0.0),
);
const AXIS_V = array<vec3<f32>, 3>(
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
);

// Unsigned +axis normal per face axis — the old CPU path always emitted
// +axis normals (backFace flipped WINDING, never the normal).
const AXIS_NORMAL = array<vec3<f32>, 3>(
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
);

struct DecodedFace {
  originX : f32,
  originZ : f32,
  x : f32,
  y : f32,
  z : f32,
  w : f32,
  h : f32,
  au : f32,
  av : f32,
  tileX : f32,
  tileY : f32,
  lightFactor : f32,
  axis : u32,
}

fn expandFace(ii : u32, vi : u32) -> DecodedFace {
  var d : DecodedFace;
  let i4 = ii * 4u;
  let w0 = faceData[i4];
  let w1 = faceData[i4 + 1u];
  let w2 = faceData[i4 + 2u];
  let w3 = faceData[i4 + 3u];

  let origin = tileOrigins[(w3 >> 8u) & 0xffffu];
  d.originX = origin.x;
  d.originZ = origin.y;

  d.x = origin.x + f32(w0 & 0x3ffu);
  d.y = f32((w0 >> 10u) & 0xfffu) - FAR_TILE_Y_OFFSET;
  d.z = origin.y + f32((w0 >> 22u) & 0x3ffu);

  d.w = f32(w1 & 0x3ffu);
  d.h = f32((w1 >> 10u) & 0x3ffu);
  d.axis = (w1 >> 21u) & 3u;

  d.tileX = f32(w2 & 0xffu);
  d.tileY = f32((w2 >> 8u) & 0xffu);
  let light = (w2 >> 16u) & 0xffu;
  d.lightFactor = select(0.8, 1.0, light >= 224u);

  // Corner weights are the identity walk [P00,P10,P11,P01]; the per-mesh
  // index buffer supplies straight vs reversed triangulation (see module
  // doc) so winding matches the face's intended normal with culling on.
  let corner = vi & 3u;
  d.au = CORNER_U[corner];
  d.av = CORNER_V[corner];
  return d;
}
`;

const terrainVertexWGSL = /* wgsl */ `
${FACE_EXPAND_WGSL}
${FOG_HELPER_WGSL}
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vPositionW : vec3<f32>,
  @location(1) vTile : vec2<f32>,
  // Per-vertex shading: every far-tile face is FLAT (axis-aligned constant
  // normal), so N·L and the sky term are identical across each quad's pixels
  // and fold exactly into one scalar here instead of per-pixel work.
  @location(2) vShade : f32,
  // Triplanar UV hint derived from the face axis: 0 = X-facing, 1 = Y, 2 = Z.
  @location(3) vAxisMode : f32,
  @location(4) vFogColor : vec3<f32>,
  @location(5) vFogFactor : f32,
};

@vertex
fn mainVertex(input : VertexInput, @builtin(instance_index) instanceIndex : u32, @builtin(vertex_index) vertexIndex : u32) -> VSOut {
  var out : VSOut;
  let f = expandFace(u32(input.instData.x), vertexIndex);

  let uvec = AXIS_U[f.axis];
  let vvec = AXIS_V[f.axis];
  let worldPos = vec3<f32>(f.x, f.y, f.z) + uvec * (f.au * f.w) + vvec * (f.av * f.h);

  out.pos = shaderSystem.worldViewProjection * vec4<f32>(worldPos, 1.0);
  out.vPositionW = worldPos;
  out.vTile = vec2<f32>(f.tileX, f.tileY);

  // Chunk-matching sun convention: dot(N, +lightDirection). The old CPU
  // path always emitted +axis normals (backFace flipped WINDING, not the
  // normal), so N·L here uses the unsigned axis vector exactly like before.
  let nrm = AXIS_NORMAL[f.axis];
  let ndotl = max(0.0, dot(nrm, shaderUniforms.lightDirection));
  let sun = shaderUniforms.sunLightIntensity;
  out.vShade =
    (ndotl * sun * 0.6 + 0.48 * (sun + 0.2)) * mix(0.55, 1.0, f.lightFactor);

  // axis 0 = X-facing (mode 0), axis 1 = Y-facing (mode 1), axis 2 = Z (2).
  out.vAxisMode = f32(f.axis);

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
${FACE_EXPAND_WGSL}
${FOG_HELPER_WGSL}

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vPositionW : vec3<f32>,
  @location(1) vFogColor : vec3<f32>,
  @location(2) vFogFactor : f32,
};

@vertex
fn mainVertex(
  input : VertexInput,
  @builtin(instance_index) instanceIndex : u32,
  @builtin(vertex_index) vertexIndex : u32
) -> VSOut {
  var out : VSOut;

  let f = expandFace(u32(input.instData.x), vertexIndex);

  let worldPos =
    vec3<f32>(f.x, f.y, f.z) +
    vec3<f32>(0.0, 0.0, 1.0) * (f.au * f.h) +
    vec3<f32>(1.0, 0.0, 0.0) * (f.av * f.w);

  out.pos =
    shaderSystem.worldViewProjection *
    vec4<f32>(worldPos, 1.0);

  out.vPositionW = worldPos;

  let toCamera = shaderSystem.cameraPosition - worldPos;
  let dist = length(toCamera);

  let infos = shaderUniforms.fogInfos;

  out.vFogFactor =
    clamp(
      (infos.z - dist) * shaderUniforms.fogInvRange,
      0.0,
      1.0
    );

  let heightFactor =
    clamp(worldPos.y * 0.003, 0.0, 1.0);

  let atmosphereColor =
    ftAtmosphereColor(heightFactor);

  var baseFogColor =
    mix(
      shaderUniforms.fogColor,
      atmosphereColor,
      0.8
    );

  let nightAmount =
    clamp(
      1.0 - shaderUniforms.sunLightIntensity,
      0.0,
      1.0
    );

  baseFogColor =
    mix(
      baseFogColor,
      vec3<f32>(0.0),
      nightAmount
    );

  let viewDirY =
    toCamera.y / max(dist, 1e-4);

  let skyboxColor =
    ftSkyboxColor(viewDirY, nightAmount);

  let skyBlend =
    clamp(
      (dist - 7000.0) * 0.0003333,
      0.0,
      1.0
    );

  out.vFogColor =
    mix(
      baseFogColor,
      skyboxColor,
      skyBlend
    );

  return out;
}
`;

const waterFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vPositionW : vec3<f32>,
  @location(1) vFogColor : vec3<f32>,
  @location(2) vFogFactor : f32,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let normal = vec3<f32>(0.0, 1.0, 0.0);

  let viewDir = normalize(
    shaderSystem.cameraPosition - in.vPositionW
  );

  let reflectDir =
    reflect(shaderUniforms.lightDirection, normal);

  let RV =
    max(dot(viewDir, reflectDir), 0.0);

  let spec =
    exp2(
      clamp(
        64.0 * 1.4427 * (RV - 1.0),
        -126.0,
        0.0
      )
    );

  let specular =
    vec3<f32>(
      spec * shaderUniforms.sunLightIntensity
    );

  let litWater =
    vec3<f32>(0.0, 0.25, 0.55) *
    (shaderUniforms.sunLightIntensity * 0.8 + 0.2);

  let nightWater =
    vec3<f32>(0.0, 0.06, 0.18);

  let finalColor =
    mix(
      nightWater,
      litWater,
      shaderUniforms.sunLightIntensity
    ) +
    specular;

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

export interface FarTileMaterialOptions {
	engine: EngineContext;
	scene: SceneContext;
	diffuseTexture: Texture2D | null;
	atlasTileSize: number;
	textureScale: number;
	nameSuffix?: string;
}

function applyCommonUniformDefaults(material: ShaderMaterial): void {
	setShaderUniform(material, "sunLightIntensity", 1);
	setShaderUniform(material, "lightDirection", [0, 1, 0]);
	setShaderUniform(material, "fogInfos", [0, 0, 1000, 0]);
	setShaderUniform(material, "fogColor", [0.6, 0.7, 0.9]);
	setShaderUniform(material, "fogInvRange", 1 / 1000);
}

/** Bind (or re-bind after a grow) the level's face-word + origin buffers. */
export function bindFarTileBuffers(
	material: ShaderMaterial,
	faceBuffer: StorageBuffer,
	originsBuffer: StorageBuffer,
): void {
	setShaderStorageBuffer(material, "faceData", faceBuffer);
	setShaderStorageBuffer(material, "tileOrigins", originsBuffer);
}

export function createFarTileTerrainMaterial(
	opts: FarTileMaterialOptions,
): ShaderMaterial {
	const material = createShaderMaterial({
		name: opts.nameSuffix
			? `farTileTerrainLite_${opts.nameSuffix}`
			: "farTileTerrainLite",
		vertexSource: terrainVertexWGSL,
		fragmentSource: terrainFragmentWGSL,
		attributes: ["position"],
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
		storageBuffers: [
			{ name: "faceData", type: "array<u32>" },
			{ name: "tileOrigins", type: "array<vec2<f32>>" },
		],
		// Per-face winding is restored by the straight/reversed mesh pair
		// (see module doc), so backface culling works exactly like the old
		// CPU-expanded path — and coplanar opposite-facing boundary skirts
		// are culled from behind instead of z-fighting.
		backFaceCulling: true,
	});
	setShaderTexture(material, "diffuseTexture", opts.diffuseTexture);
	setShaderUniform(material, "atlasTileSize", opts.atlasTileSize);
	setShaderUniform(material, "textureScale", opts.textureScale);
	applyCommonUniformDefaults(material);
	return material;
}

export function createFarTileWaterMaterial(
	nameSuffix?: string,
): ShaderMaterial {
	const material = createShaderMaterial({
		name: nameSuffix ? `farTileWaterLite_${nameSuffix}` : "farTileWaterLite",
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
		storageBuffers: [
			{ name: "faceData", type: "array<u32>" },
			{ name: "tileOrigins", type: "array<vec2<f32>>" },
		],
		backFaceCulling: true,
		// Same reasoning as the clip-map water: never publish depth so real
		// chunk geometry always wins the depth test against this plane.
		depthWrite: false,
	});
	applyCommonUniformDefaults(material);
	return material;
}
