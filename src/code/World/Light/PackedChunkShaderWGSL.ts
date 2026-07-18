export function buildPackedVertexWGSL(arenaCount: number = 1): string {
	const arenas = Math.max(1, arenaCount | 0);

	// Babylon Lite injects the `var<storage, read> faceDataN : array<vec4<u32>>`
	// declarations (with @group/@binding) from each material's `storageBuffers`
	// list, so we must NOT declare them here. We only generate the `loadFace`
	// helper that selects among them via the per-instance arena index.
	let loadFaceBody = "";
	for (let i = 0; i < arenas; i++) {
		loadFaceBody += `  if (arena == ${i}u) { return faceData${i}[idx]; }\n`;
	}
	loadFaceBody += "  return faceData0[idx];\n";

	return /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vUV2 : vec2<f32>,
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

// Thin-instance matrix columns (locations 1..4): Babylon Lite's instancing path
// injects the per-instance 4x4 matrix as four vec4 vertex attributes.
//   world3.w carries this mesh's faceBase offset into its face arena.
//   world0.w carries the arena index (which faceDataN buffer to read).
// The rest of the matrix is unused (the vertex position is derived from
// faceData, not the matrix).

// Resolve a face from the arena selected by the arena index. The if-chain is
// generated to match the number of bound faceDataN buffers (dynamic indexing
// of an array of storage buffers is not portable in WGSL).
fn loadFace(arena : u32, idx : u32) -> vec4<u32> {
${loadFaceBody}}

const LIGHT_BLUE = vec3<f32>(0.6, 0.75, 0.95);
const DEEP_BLUE = vec3<f32>(0.1, 0.2, 0.4);
const MID_SKY = vec3<f32>(0.5, 0.7, 0.9);
const DAY_SKY = vec3<f32>(0.1, 0.3, 0.6);
const DARK_SKY = vec3<f32>(0.1, 0.1, 0.2);

fn getAtmosphereColor(heightFactor : f32) -> vec3<f32> {
  return mix(LIGHT_BLUE, DEEP_BLUE, heightFactor) * (shaderUniforms.sunLightIntensity * shaderUniforms.sunLightIntensity);
}

fn getSkyboxColor(viewDirY : f32) -> vec3<f32> {
  let skyFactor = smoothstep(0.0, 0.4, max(viewDirY, 0.0));
  var skyboxColor = mix(MID_SKY, DAY_SKY, skyFactor);
  if (shaderUniforms.lightDirection.y > 0.0) {
    skyboxColor = mix(skyboxColor, DARK_SKY, shaderUniforms.lightDirection.y * 2.0);
  }
  return skyboxColor;
}

const DIAGONAL : f32 = 0.70710678;
const INV_POS : f32 = 0.125;
const INV_LIGHT : f32 = 1.0 / 15.0;

// Flattened replacement for cornerData(state) >> (vid*2) & 3
// Index as [state * 4u + vid]
const CORNER_LUT = array<u32,16>(
  0u,1u,2u,3u,   // state 0  (was packed byte 228)
  3u,0u,1u,2u,   // state 1  (was packed byte 147)
  2u,1u,0u,3u,   // state 2  (was packed byte 198)
  1u,0u,3u,2u    // state 3  (was packed byte 177)
);

// Flattened replacement for atlasCornerLookup(axisFace) >> (corner*2) & 3
// Index as [axisFace * 4u + corner]. axisFace ranges 0..5.
const ATLAS_CORNER_LUT = array<u32,24>(
  0u,3u,2u,1u,   // axisFace 0
  1u,2u,3u,0u,   // axisFace 1
  0u,3u,2u,1u,   // axisFace 2
  3u,0u,1u,2u,   // axisFace 3
  1u,0u,3u,2u,   // axisFace 4
  0u,1u,2u,3u    // axisFace 5 (default/else case)
);

// Per-axis basis vectors, replaces select() chains for axis placement
const AXIS_BASIS = array<vec3<f32>,3>(
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0)
);

fn uAxisOf(axis : u32) -> u32 {
  if (axis == 0u) { return 1u; }
  if (axis == 1u) { return 2u; }
  return 0u;
}
fn vAxisOf(axis : u32) -> u32 {
  if (axis == 0u) { return 2u; }
  if (axis == 1u) { return 0u; }
  return 1u;
}
fn cornerUOf(corner : u32) -> f32 {
  if (corner == 0u || corner == 3u) { return 0.0; }
  return 1.0;
}
fn cornerVOf(corner : u32) -> f32 {
  if (corner == 0u || corner == 1u) { return 0.0; }
  return 1.0;
}

@vertex
fn mainVertex(input : VertexInput, @builtin(instance_index) instanceIndex : u32, @builtin(vertex_index) vertexIndex : u32) -> VSOut {
  var out : VSOut;

  // faceBase for this mesh is carried in the thin-instance matrix (world3.w);
  // the arena index (which faceDataN buffer to read) is in world0.w.
  let faceBase = u32(input.world3.w);
  let arena = u32(input.world0.w);
  let face = loadFace(arena, faceBase + instanceIndex);

  // If your WGSL target supports unpack4xU8, this whole block collapses to:
  //   let bytes0 = unpack4xU8(face.x);
  //   let aByte = f32(bytes0.x); let bByte = f32(bytes0.y);
  //   let cByte = f32(bytes0.z); let axisFace = bytes0.w;
  // Left as manual shifts below since intrinsic support wasn't confirmed.
  let aByte = f32(face.x & 0xffu);
  let bByte = f32((face.x >> 8u) & 0xffu);
  let cByte = f32((face.x >> 16u) & 0xffu);
  let axisFace = (face.x >> 24u) & 0xffu;

  let widthByte = face.y & 0xffu;
  let heightByte = (face.y >> 8u) & 0xffu;
  let tileX = (face.y >> 16u) & 0xffu;
  let tileY = (face.y >> 24u) & 0xffu;

  let packedAO = face.z & 0xffu;
  let lightByte = (face.z >> 8u) & 0xffu;
  let tintBucket = (face.z >> 16u) & 0xffu;
  let metaByte = (face.z >> 24u) & 0xffu;

  let axis = axisFace >> 1u;
  let isBackFace = axisFace & 1u;
  let flip = metaByte & 1u;
  let diagonalEnabled = (metaByte >> 4u) & 1u;
  let diagonalVariant = (metaByte >> 5u) & 1u;
  let rawDimensions = (metaByte >> 6u) & 1u;

  let faceWidth = select(f32(widthByte) * INV_POS, f32(widthByte), rawDimensions != 0u);
  let faceHeight = select(f32(heightByte) * INV_POS, f32(heightByte), rawDimensions != 0u);

  let co = chunkOffsets[face.w];

  // Hoisted: computed once, reused for base position and fractional UV offset
  let posX = aByte * INV_POS;
  let posZ = cByte * INV_POS;
  let baseX = posX + co.x;
  let baseY = bByte * INV_POS + co.y;
  let baseZ = posZ + co.z;

  let atlasBaseU = f32(tileX) * shaderUniforms.atlasTileSize;
  let atlasBaseV = f32(u32(shaderUniforms.atlasMaxTiles) - 1u - tileY) * shaderUniforms.atlasTileSize;

  let skyLight = f32((lightByte >> 4u) & 0x0fu) * INV_LIGHT;
  let blockLight = f32(lightByte & 0x0fu) * INV_LIGHT;

  let cornerState = (isBackFace << 1u) | flip;
  let uAxis = uAxisOf(axis);
  let vAxis = vAxisOf(axis);
  let faceSign = select(1.0, -1.0, isBackFace != 0u);

  let fractionalX = fract(posX);
  let fractionalZ = fract(posZ);
  let uvOffsetU = select(fractionalX, fractionalZ, uAxis == 0u);
  let uvOffsetV = select(fractionalX, fractionalZ, vAxis == 0u);

  let isDiag = diagonalEnabled != 0u;

  let aNormal = AXIS_BASIS[axis] * faceSign;
  let aTangent = AXIS_BASIS[uAxis] * faceSign;

  let dZ = select(-DIAGONAL, DIAGONAL, diagonalVariant == 0u);
  let dTangent = vec3<f32>(DIAGONAL, 0.0, dZ);
  let dNormal = vec3<f32>(dZ * faceSign, 0.0, -DIAGONAL * faceSign);

  let sharedNormal = select(aNormal, dNormal, isDiag);
  let sharedTangent = select(aTangent, dTangent, isDiag);

  let vid = vertexIndex;
  let corner = CORNER_LUT[cornerState * 4u + vid];
  let cuF = cornerUOf(corner);
  let cvF = cornerVOf(corner);

  let diagH = (cuF - 0.5) * faceWidth;
  let posDiag = vec3<f32>(
    baseX + sharedTangent.x * diagH,
    baseY + cvF * faceHeight,
    baseZ + sharedTangent.z * diagH
  );
  let faceUDiag = cuF;
  let faceVDiag = cvF;

  let pu = cuF * faceWidth;
  let pv = cvF * faceHeight;
  let posQuad = vec3<f32>(baseX, baseY, baseZ) + AXIS_BASIS[uAxis] * pu + AXIS_BASIS[vAxis] * pv;

  let ac = ATLAS_CORNER_LUT[axisFace * 4u + corner];
  let atlasU = (ac ^ (ac >> 1u)) & 1u;
  let atlasV = ac >> 1u;
  let swapUV = axisFace < 4u;
  let faceUQuad = select(f32(atlasU) * faceWidth + uvOffsetU, f32(atlasU) * faceHeight + uvOffsetV, swapUV);
  let faceVQuad = select(f32(atlasV) * faceHeight + uvOffsetV, f32(atlasV) * faceWidth + uvOffsetU, swapUV);

  let position = select(posQuad, posDiag, isDiag);
  let faceU = select(faceUQuad, faceUDiag, isDiag);
  let faceV = select(faceVQuad, faceVDiag, isDiag);

  let worldPos = shaderSystem.world * vec4<f32>(position, 1.0);
  out.pos = shaderSystem.worldViewProjection * vec4<f32>(position, 1.0);
  out.vUV = vec2<f32>(faceU, faceV);
  out.vUV2 = vec2<f32>(atlasBaseU, atlasBaseV);
  out.vWorldPosition = worldPos.xyz;
  out.vTangent = sharedTangent;
  out.vNormal = sharedNormal;
  let ambientOcclusion = (packedAO >> (corner << 1u)) & 3u;
  out.vAO = f32(ambientOcclusion);
  out.vLight = vec2<f32>(skyLight, blockLight);
  out.vMeta = f32(metaByte);
  out.vTint = f32(tintBucket);

  let viewVec = worldPos.xyz - shaderSystem.cameraPosition;
  let dist = length(viewVec);
  let infos = shaderUniforms.fogInfos;
  let fogStart = infos.y;
  let fogEnd = infos.z;
  out.vFogFactor = clamp((dist - fogStart) / max(fogEnd - fogStart, 1.0), 0.0, 1.0);

  let heightFactor = clamp(worldPos.y * 0.003, 0.0, 1.0);
  let atmosphereColor = getAtmosphereColor(heightFactor);
  let baseFogColor = mix(shaderUniforms.fogColor, atmosphereColor, 0.8);
  let viewDirY = viewVec.y / max(dist, 1e-4);
  let skyboxColor = getSkyboxColor(viewDirY);
  let skyBlend = clamp((dist - 1400.0) * 0.0003333, 0.0, 1.0);
  out.vFogColor = mix(baseFogColor, skyboxColor, skyBlend);

  out.vViewDir = normalize(shaderSystem.cameraPosition - worldPos.xyz);

  return out;
}
`;
}
