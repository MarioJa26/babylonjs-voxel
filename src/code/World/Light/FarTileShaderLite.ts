/**
 * Babylon Lite materials for far-tile LOD meshes (LOD6+) — GPU face-decoding
 * variant.
 *
 * Faces arrive from FarTileGenerator as 4×u32 words and go into a per-level
 * `faceData` storage buffer VERBATIM (no CPU expansion). Each level mesh is a
 * single shared quad drawn once per face via thin instances (compact stride-16
 * records injected by the lite patch as `instData`; the face index is read
 * from `instData.x`, not from `@builtin(instance_index)`).
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
 * Vertex-stage notes (GPU perf):
 * - Corner weights and axis bases are derived arithmetically (no const-array
 *   dynamic indexing); water uses a reduced decode (skips tile/light word).
 * - Terrain varyings are packed: planar UV (axis-selected in the vertex
 *   stage) + tile/shade + fog — 4 locations instead of 6.
 *
 * Fragment stages keep the previous fog/sky/atlas math bit-for-bit, except
 * fully-fogged pixels return the fog colour without an atlas fetch (the
 * fetch itself uses explicit LOD 0 — the identical texel, since the atlas
 * is uploaded without mips).
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
//
// PERF: corner weights and axis bases are derived arithmetically (no
// const-array dynamic indexing), so the vertex stage pays pure ALU instead
// of array loads + bounds checks per vertex.
const FACE_EXPAND_WGSL = /* wgsl */ `
const FAR_TILE_Y_OFFSET : f32 = 1024.0;

// Terrain faces carry the full decode payload: world corner, dimensions,
// corner weights, atlas tile, light factor and the axis that drives the
// basis / UV / shade selection below.
struct TerrainFace {
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

// Water faces are always axis-1 (top) quads, so this record drops the axis,
// atlas-tile, light and kind fields the terrain record carries — fewer live
// values for the vertex stage to hold.
struct WaterFace {
  x : f32,
  y : f32,
  z : f32,
  w : f32,
  h : f32,
  au : f32,
  av : f32,
}

fn decodeCornerWeights(vi : u32) -> vec2<f32> {
  // Identity walk [P00,P10,P11,P01]: corner 0:(0,0) 1:(1,0) 2:(1,1) 3:(0,1).
  // au = bit1 XOR bit0, av = bit1 — branchless, no array lookup.
  let corner = vi & 3u;
  return vec2<f32>(
    f32(((corner >> 1u) ^ corner) & 1u),
    f32((corner >> 1u) & 1u),
  );
}

fn expandFace(faceIndex : u32, vi : u32) -> TerrainFace {
  var d : TerrainFace;
  let i4 = faceIndex << 2u;
  let w0 = faceData[i4];
  let w1 = faceData[i4 + 1u];
  let w2 = faceData[i4 + 2u];
  let w3 = faceData[i4 + 3u];

  let origin = tileOrigins[(w3 >> 8u) & 0xffffu];

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
  let corner = decodeCornerWeights(vi);
  d.au = corner.x;
  d.av = corner.y;
  return d;
}

// Water-only decode: the atlas-tile/light word (w2) is never read and the
// axis is hardcoded to 1 — 1 fewer storage load and no tile/light unpack ALU
// per water vertex, and a smaller record than TerrainFace.
fn expandWaterFace(faceIndex : u32, vi : u32) -> WaterFace {
  var d : WaterFace;
  let i4 = faceIndex << 2u;
  let w0 = faceData[i4];
  let w1 = faceData[i4 + 1u];
  let w3 = faceData[i4 + 3u];

  let origin = tileOrigins[(w3 >> 8u) & 0xffffu];

  d.x = origin.x + f32(w0 & 0x3ffu);
  d.y = f32((w0 >> 10u) & 0xfffu) - FAR_TILE_Y_OFFSET;
  d.z = origin.y + f32((w0 >> 22u) & 0x3ffu);

  d.w = f32(w1 & 0x3ffu);
  d.h = f32((w1 >> 10u) & 0x3ffu);

  let corner = decodeCornerWeights(vi);
  d.au = corner.x;
  d.av = corner.y;
  return d;
}

// Branchless axis basis from the face axis, mirroring the deleted CPU
// AXIS_BASIS and AXIS_NORMAL tables:
//   axis 0: U=Y(w), V=Z(h), N=+X   axis 1: U=Z(w), V=X(h), N=+Y
//   axis 2: U=X(w), V=Y(h), N=+Z
// The old CPU path always emitted +axis normals (backFace flipped WINDING,
// never the normal), so N·L uses the unsigned axis vector exactly as before.
// A plain struct of the three vectors is cheaper to hold than a mat3x3 the
// vertex stage would index column by column.
struct AxisBasis {
  u : vec3<f32>,
  v : vec3<f32>,
  n : vec3<f32>,
}

fn axisBases(axis : u32) -> AxisBasis {
  let isX = select(0.0, 1.0, axis == 0u);
  let isY = select(0.0, 1.0, axis == 1u);
  let isZ = 1.0 - max(isX, isY);
  var b : AxisBasis;
  b.u = vec3<f32>(isZ, isX, isY);
  b.v = vec3<f32>(isY, isZ, isX);
  b.n = vec3<f32>(isX, isY, isZ);
  return b;
}
`;

// GPU frustum cull: far tiles submit every resident face in all 360 degrees
// (no CPU per-tile culling — one thin-instance draw per level). Collapsing
// fully-outside faces to a degenerate point discards them before raster, so
// the behind-camera half pays vertex decode only and skips atlas fetch,
// fog/sky varyings interpolation and raster entirely. Sphere test with the
// face half-diagonal + 2-block margin: straddlers are never culled.
const FRUSTUM_CULL_WGSL = /* wgsl */ `
fn ftFrustumCulled(center : vec3<f32>, radius : f32) -> bool {
  let fp0 : vec4<f32> = frustumPlanes[0];
  if (dot(fp0.xyz, center) + fp0.w < -radius) { return true; }
  let fp1 : vec4<f32> = frustumPlanes[1];
  if (dot(fp1.xyz, center) + fp1.w < -radius) { return true; }
  let fp2 : vec4<f32> = frustumPlanes[2];
  if (dot(fp2.xyz, center) + fp2.w < -radius) { return true; }
  let fp3 : vec4<f32> = frustumPlanes[3];
  if (dot(fp3.xyz, center) + fp3.w < -radius) { return true; }
  let fp4 : vec4<f32> = frustumPlanes[4];
  if (dot(fp4.xyz, center) + fp4.w < -radius) { return true; }
  let fp5 : vec4<f32> = frustumPlanes[5];
  if (dot(fp5.xyz, center) + fp5.w < -radius) { return true; }
  return false;
}
`;

const terrainVertexWGSL = /* wgsl */ `
${FACE_EXPAND_WGSL}
${FOG_HELPER_WGSL}
${FRUSTUM_CULL_WGSL}
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  // Axis-selected planar UV (world-position XY/XZ/ZY divided by
  // textureScale here in the vertex stage). The fragment only fract()s it,
  // which saves passing the 3-float world position plus the axis mode.
  @location(0) vUV : vec2<f32>,
  // Per-face payload: xy = atlas tile, z = flat shade. Every far-tile
  // face is FLAT (axis-aligned constant normal), so N·L and the sky term
  // are identical across each quad's pixels and fold into one scalar.
  @location(1) vTileShade : vec3<f32>,
  @location(2) vFogColor : vec3<f32>,
  @location(3) vFogFactor : f32,
};

@vertex
fn mainVertex(input : VertexInput, @builtin(vertex_index) vertexIndex : u32) -> VSOut {
  var out : VSOut;
  let f = expandFace(u32(input.instData.x), vertexIndex);

  let bases = axisBases(f.axis);
  let worldPos = vec3<f32>(f.x, f.y, f.z) + bases.u * (f.au * f.w) + bases.v * (f.av * f.h);

  // Behind-camera / off-screen faces: degenerate before raster (see above).
  // halfSize avoids a second * 0.5 for the cull-sphere radius.
  let halfSize = vec2<f32>(f.w, f.h) * 0.5;
  let ftCenter = vec3<f32>(f.x, f.y, f.z) + bases.u * halfSize.x + bases.v * halfSize.y;
  let ftRadius = length(halfSize) + 2.0;
  if (ftFrustumCulled(ftCenter, ftRadius)) {
    out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.vUV = vec2<f32>(0.0);
    out.vTileShade = vec3<f32>(0.0);
    out.vFogColor = vec3<f32>(0.0);
    out.vFogFactor = 0.0;
    return out;
  }

  out.pos = shaderSystem.worldViewProjection * vec4<f32>(worldPos, 1.0);

  // Triplanar-ish planar projection, branchless: X-faces sample ZY,
  // Y-faces sample XZ, Z-faces sample XY — same mapping as before.
  let isXFace = f.axis == 0u;
  let isYFace = f.axis == 1u;
  out.vUV = vec2<f32>(
    select(worldPos.x, worldPos.z, isXFace),
    select(worldPos.y, worldPos.z, isYFace),
  ) / shaderUniforms.textureScale;

  // Chunk-matching sun convention: dot(N, +lightDirection). The old CPU
  // path always emitted +axis normals (backFace flipped WINDING, not the
  // normal), so N·L here uses the unsigned axis vector exactly like before.
  let ndotl = max(0.0, dot(bases.n, shaderUniforms.lightDirection));
  let sun = shaderUniforms.sunLightIntensity;
  let shade =
    (ndotl * sun * 0.6 + 0.48 * (sun + 0.2)) * mix(0.55, 1.0, f.lightFactor);
  out.vTileShade = vec3<f32>(f.tileX, f.tileY, shade);

  let toCamera = shaderSystem.cameraPosition - worldPos;
  let distanceSquared = dot(toCamera, toCamera);
  let distance = sqrt(distanceSquared);

  let infos = shaderUniforms.fogInfos;
  let fogFactor = clamp((infos.z - distance) * shaderUniforms.fogInvRange, 0.0, 1.0);

  let heightFactor = clamp(worldPos.y * 0.003, 0.0, 1.0);
  let atmosphereColor = ftAtmosphereColor(heightFactor);
  var baseFogColor = mix(shaderUniforms.fogColor, atmosphereColor, 0.8);
  let nightAmount = clamp(1.0 - sun, 0.0, 1.0);
  baseFogColor = mix(baseFogColor, vec3<f32>(0.0, 0.0, 0.0), nightAmount);

  let inverseDistance = inverseSqrt(max(distanceSquared, 1e-8));
  let viewDirY = toCamera.y * inverseDistance;
  let skyboxColor = ftSkyboxColor(viewDirY, nightAmount);
  let skyBlend = clamp((distance - 1400.0) * 0.0003333, 0.0, 1.0);

  out.vFogColor = mix(baseFogColor, skyboxColor, skyBlend);
  out.vFogFactor = fogFactor;
  return out;
}
`;

const terrainFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vTileShade : vec3<f32>,
  @location(2) vFogColor : vec3<f32>,
  @location(3) vFogFactor : f32,
};

fn sampleAtlasTile(tile : vec2<f32>, worldUV : vec2<f32>) -> vec3<f32> {
  let tileSize = shaderUniforms.atlasTileSize;
  let baseUV = vec2<f32>(tile.x * tileSize, 1.0 - ((tile.y + 1.0) * tileSize));
  let atlasUV = baseUV + fract(worldUV) * tileSize;
  // Explicit LOD 0: the atlas is uploaded with mipMaps:false (single level,
  // see DistantTerrain init), so this samples the identical texel that
  // textureSample would — while staying legal inside the non-uniform fog
  // early-out below, where implicit derivatives are forbidden by WGSL.
  return textureSampleLevel(diffuseTexture, diffuseTextureSampler, atlasUV, 0.0).rgb;
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  // Fully-fogged horizon pixels are pure fog colour — skip the atlas fetch
  // and shading entirely. This covers the largest on-screen far-tile area.
  // Threshold 0.02 (not 0.001): a 2% texture blend is indistinguishable at
  // horizon distances but skips the fetch on far more pixels.
  if (in.vFogFactor <= 0.02) {
    return vec4<f32>(in.vFogColor, 1.0);
  }

  let texColor = sampleAtlasTile(in.vTileShade.xy, in.vUV);
  let finalColor = texColor * in.vTileShade.z;

  let colorWithFog = mix(in.vFogColor, finalColor, in.vFogFactor);
  return vec4<f32>(colorWithFog, 1.0);
}
`;

const waterVertexWGSL = /* wgsl */ `
${FACE_EXPAND_WGSL}
${FOG_HELPER_WGSL}
${FRUSTUM_CULL_WGSL}

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vPositionW : vec3<f32>,
  @location(1) vFogColor : vec3<f32>,
  @location(2) vFogFactor : f32,
};

@vertex
fn mainVertex(
  input : VertexInput,
  @builtin(vertex_index) vertexIndex : u32
) -> VSOut {
  var out : VSOut;

  // Axis 1 uses U = +Z with width and V = +X with height, matching
  // axisBases(1u) in the terrain path.
  let f = expandWaterFace(u32(input.instData.x), vertexIndex);

  let worldPos = vec3<f32>(
    f.x + f.av * f.h,
    f.y,
    f.z + f.au * f.w,
  );

  // Axis-1 dimensions:
  // X extent = h
  // Z extent = w
  // halfSize avoids a second * 0.5 for the cull-sphere radius.
  let halfSizeW = vec2<f32>(f.h, f.w) * 0.5;
  let ftCenterW = vec3<f32>(
    f.x + halfSizeW.x,
    f.y,
    f.z + halfSizeW.y,
  );
  let ftRadiusW = length(halfSizeW) + 2.0;
  if (ftFrustumCulled(ftCenterW, ftRadiusW)) {
    out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.vPositionW = ftCenterW;
    out.vFogColor = vec3<f32>(0.0);
    out.vFogFactor = 0.0;
    return out;
  }

  out.pos =
    shaderSystem.worldViewProjection *
    vec4<f32>(worldPos, 1.0);

  out.vPositionW = worldPos;

  let toCamera = shaderSystem.cameraPosition - worldPos;
  let distanceSquared = dot(toCamera, toCamera);
  let distance = sqrt(distanceSquared);

  let infos = shaderUniforms.fogInfos;

  out.vFogFactor =
    clamp(
      (infos.z - distance) * shaderUniforms.fogInvRange,
      0.0,
      1.0
    );

  let heightFactor =
    clamp(worldPos.y * 0.003, 0.0, 1.0);

  let atmosphereColor =
    ftAtmosphereColor(heightFactor);

  let sun = shaderUniforms.sunLightIntensity;

  var baseFogColor =
    mix(
      shaderUniforms.fogColor,
      atmosphereColor,
      0.8
    );

  let nightAmount =
    clamp(1.0 - sun, 0.0, 1.0);

  baseFogColor =
    mix(
      baseFogColor,
      vec3<f32>(0.0),
      nightAmount
    );

  let inverseDistance =
    inverseSqrt(max(distanceSquared, 1e-8));

  let viewDirY =
    toCamera.y * inverseDistance;

  let skyboxColor =
    ftSkyboxColor(viewDirY, nightAmount);

  let skyBlend =
    clamp(
      (distance - 7000.0) * 0.0003333,
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
  // Fully-fogged horizon pixels are pure fog colour — skip spec math.
  // Threshold 0.02 (not 0.001): see terrain fragment above.
  if (in.vFogFactor <= 0.02) {
    return vec4<f32>(in.vFogColor, 1.0);
  }

  const normal = vec3<f32>(0.0, 1.0, 0.0);

  let viewDelta = shaderSystem.cameraPosition - in.vPositionW;

  let inverseViewLength =
    inverseSqrt(max(dot(viewDelta, viewDelta), 1e-8));

  let viewDir = viewDelta * inverseViewLength;

  let reflectDir =
    reflect(shaderUniforms.lightDirection, normal);

  let reflectionAmount =
    max(dot(viewDir, reflectDir), 0.0);

  let specularFactor =
    exp2(
      clamp(
        92.3328 * (reflectionAmount - 1.0),
        -126.0,
        0.0
      )
    );

  let sun = shaderUniforms.sunLightIntensity;

  let litWater =
    vec3<f32>(0.0, 0.25, 0.55) *
    (sun * 0.8 + 0.2);

  let nightWater =
    vec3<f32>(0.0, 0.06, 0.18);

  let finalColor =
    mix(nightWater, litWater, sun) +
    vec3<f32>(specularFactor * sun);

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
	frustumPlanesBuffer?: StorageBuffer | null,
): void {
	setShaderStorageBuffer(material, "faceData", faceBuffer);
	setShaderStorageBuffer(material, "tileOrigins", originsBuffer);
	if (frustumPlanesBuffer) {
		setShaderStorageBuffer(material, "frustumPlanes", frustumPlanesBuffer);
	}
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
		storageBuffers: [
			{ name: "faceData", type: "array<u32>" },
			{ name: "tileOrigins", type: "array<vec2<f32>>" },
			// 6 world-space inward-normal planes fed per VP change by
			// FarTileManager (all zeros until then = never cull).
			{ name: "frustumPlanes", type: "array<vec4<f32>, 6>" },
		],
		samplers: ["diffuseTexture"],
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
			// Same 6-plane GPU cull feed as terrain (see above).
			{ name: "frustumPlanes", type: "array<vec4<f32>, 6>" },
		],
		backFaceCulling: true,
		// Same reasoning as the clip-map water: never publish depth so real
		// chunk geometry always wins the depth test against this plane.
		depthWrite: false,
	});
	applyCommonUniformDefaults(material);
	return material;
}
