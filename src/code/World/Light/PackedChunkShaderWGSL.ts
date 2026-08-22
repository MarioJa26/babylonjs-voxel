export interface VertexShaderOptions {
	fog?: boolean;
	tint?: boolean;
	meta?: boolean;
	tangent?: boolean;
	worldPosition?: boolean;
	viewDir?: boolean;
	/**
	 * For normal-mapped lighting.
	 * Emits light/view direction in tangent space so the fragment shader can use
	 * the sampled normal map directly.
	 */
	tangentSpaceLighting?: boolean;
}

type ResolvedVertexShaderOptions = Required<VertexShaderOptions>;

// Varying locations (stable across all variants):
//   0: vUV          (always)
//   1: vTileLayer   (always)
//   2: vWorldPosition (optional)
//   3: vTangent     (optional)
//   5: vNormal      (always)
//   6: vAO          (always)
//   7: vLight       (always)
//   9: vMeta        (optional)
//  10: vFogFactor   (optional)
//  11: vFogColor    (optional)
//  12: vTint        (optional)
//  13: vViewDir     (optional)
//  14: vLightDirTS   (optional, tangent-space lighting only, normalized)

function fogWGSL(enabled: boolean): string {
	if (!enabled) return "";
	return /* wgsl */ `
const LIGHT_BLUE = vec3<f32>(0.6, 0.75, 0.95);
const DEEP_BLUE = vec3<f32>(0.1, 0.2, 0.4);
const MID_SKY = vec3<f32>(0.5, 0.7, 0.9);
const DAY_SKY = vec3<f32>(0.1, 0.3, 0.6);
const DARK_SKY = vec3<f32>(0.1, 0.1, 0.2);

fn getAtmosphereColor(heightFactor : f32) -> vec3<f32> {
  let sunlight = shaderUniforms.sunLightIntensity;
  return mix(LIGHT_BLUE, DEEP_BLUE, heightFactor) * sunlight * sunlight;
}

fn getSkyboxColor(viewDirY : f32) -> vec3<f32> {
  let skyFactor = smoothstep(0.0, 0.4, max(viewDirY, 0.0));
  var skyboxColor = mix(MID_SKY, DAY_SKY, skyFactor);
  if (shaderUniforms.lightDirection.y > 0.0) {
    let darkness = clamp(shaderUniforms.lightDirection.y * 2.0, 0.0, 1.0);
    skyboxColor = mix(skyboxColor, DARK_SKY, darkness);
  }
  return skyboxColor;
}
`;
}

function vsOutFields(opts: ResolvedVertexShaderOptions): string {
	const f: string[] = [];
	f.push("  @builtin(position) pos : vec4<f32>,");
	f.push("  @location(0) vUV : vec2<f32>,");
	f.push("  @location(1) @interpolate(flat) vTileLayer : u32,");
	if (opts.worldPosition) f.push("  @location(2) vWorldPosition : vec3<f32>,");
	if (opts.tangent)
		f.push("  @location(3) @interpolate(flat) vTangent : vec3<f32>,");
	f.push("  @location(5) @interpolate(flat) vNormal : vec3<f32>,");
	f.push("  @location(6) vAO : f32,");
	f.push("  @location(7) @interpolate(flat) vLight : vec2<f32>,");
	if (opts.meta) f.push("  @location(9) @interpolate(flat) vMeta : u32,");
	if (opts.fog) {
		f.push("  @location(10) vFogFactor : f32,");
		f.push("  @location(11) vFogColor : vec3<f32>,");
	}
	if (opts.tint) f.push("  @location(12) @interpolate(flat) vTint : u32,");
	if (opts.tangentSpaceLighting) {
		f.push("  @location(13) vViewDirTS : vec3<f32>,");
		f.push("  @location(14) @interpolate(flat) vLightDirTS : vec3<f32>,");
	} else if (opts.viewDir) {
		f.push("  @location(13) vViewDir : vec3<f32>,");
	}
	return f.join("\n");
}

function vsOutAssignments(opts: ResolvedVertexShaderOptions): string {
	const a: string[] = [];
	a.push("  out.vUV = vec2<f32>(faceU, faceV);");
	a.push("  out.vTileLayer = tileY * shaderUniforms.atlasMaxTilesU32 + tileX;");
	if (opts.worldPosition) a.push("  out.vWorldPosition = worldPos.xyz;");
	if (opts.tangent) a.push("  out.vTangent = sharedTangent;");
	a.push("  out.vNormal = sharedNormal;");
	a.push("  out.vAO = f32(ambientOcclusion);");
	a.push("  out.vLight = vec2<f32>(skyLight, blockLight);");
	if (opts.meta) a.push("  out.vMeta = metaByte;");
	if (opts.tint) a.push("  out.vTint = tintBucket;");
	if (opts.fog) {
		a.push("  let infos = shaderUniforms.fogInfos;");
		a.push("  let fogStart = infos.y;");
		a.push("  let fogEnd = infos.z;");
		a.push(
			"  out.vFogFactor = clamp((dist - fogStart) / max(fogEnd - fogStart, 1.0), 0.0, 1.0);",
		);
		a.push("  let heightFactor = clamp(worldPos.y * 0.003, 0.0, 1.0);");
		a.push("  let atmosphereColor = getAtmosphereColor(heightFactor);");
		a.push(
			"  let baseFogColor = mix(shaderUniforms.fogColor, atmosphereColor, 0.8);",
		);
		a.push("  let viewDirY = -toCamera.y * invDist;");
		a.push("  let skyboxColor = getSkyboxColor(viewDirY);");
		a.push("  let skyBlend = clamp((dist - 1400.0) * 0.0003333, 0.0, 1.0);");
		a.push("  out.vFogColor = mix(baseFogColor, skyboxColor, skyBlend);");
	}
	if (opts.tangentSpaceLighting) {
		a.push("  out.vViewDirTS = vec3<f32>(");
		a.push("    dot(toCamera * invDist, sharedTangent),");
		a.push("    dot(toCamera * invDist, sharedBitangent),");
		a.push("    dot(toCamera * invDist, sharedNormal)");
		a.push("  );");
		a.push("  out.vLightDirTS = normalize(vec3<f32>(");
		a.push("    dot(shaderUniforms.lightDirection, sharedTangent),");
		a.push("    dot(shaderUniforms.lightDirection, sharedBitangent),");
		a.push("    dot(shaderUniforms.lightDirection, sharedNormal)");
		a.push("  ));");
	} else if (opts.viewDir) {
		a.push("  out.vViewDir = toCamera * invDist;");
	}
	return a.join("\n");
}

export function buildPackedVertexWGSL(
	arenaCount: number = 1,
	opts: VertexShaderOptions = {},
): string {
	const arenas = Math.max(1, arenaCount | 0);
	const o: ResolvedVertexShaderOptions = {
		fog: opts.fog ?? true,
		tint: opts.tint ?? true,
		meta: opts.meta ?? true,
		tangent: opts.tangent ?? true,
		worldPosition: opts.worldPosition ?? true,
		viewDir: opts.viewDir ?? true,
		tangentSpaceLighting: opts.tangentSpaceLighting ?? false,
	};

	let loadFaceBody = "";
	for (let i = 0; i < arenas; i++) {
		loadFaceBody += `  if (arena == ${i}u) { return vec3<u32>(faceData${i}[i3], faceData${i}[i3 + 1u], faceData${i}[i3 + 2u]); }\n`;
	}
	loadFaceBody +=
		"  return vec3<u32>(faceData0[i3], faceData0[i3 + 1u], faceData0[i3 + 2u]);\n";

	return /* wgsl */ `
struct VSOut {
${vsOutFields(o)}
};

// Thin-instance matrix columns (locations 1..4): Babylon Lite's instancing path
// injects the per-instance 4x4 matrix as four vec4 vertex attributes.
//   world3.w carries this mesh's faceBase offset into its face arena.
//   world0.w carries the arena index (which faceDataN buffer to read).
//   world1.x carries the group's chunkOffsets base (the 64-offset block index).
// The rest of the matrix is unused (the vertex position is derived from
// faceData, not the matrix).
//
// Face layout — 3 u32 words per face (12 bytes, little-endian):
//   word0: sx | sy<<8 | sz<<16 | axisFace(3)<<24 | tint(3)<<27
//   word1: sw | sh<<8 | tileX<<16 | tileY<<24
//   word2: ao | light<<8 | meta<<16 | chunkIndex(6)<<24
// sx/sy/sz are chunk-local positions scaled by 8 (1 block = 8 units);
// sw/sh are face dimensions in the same scaled units (rawDimensions flag
// switches them to unscaled block units for oversized faces); chunkIndex is
// the per-face local chunk 0..63 selecting one of the 64 chunkOffsets entries
// of this group.
//
// meta byte (word2 byte 2) bit usage:
//   bit0 flip · bit1-2 materialType(2) · bit3 posOffX · bit4 diag ·
//   bit5 diagVariant · bit6 rawDim · bit7 posOffZ
//   materialType=3 is a vertex-stage sentinel: chunk-boundary faces clamp to
//   the u8 position grid and the shader restores the exact plane (+1 unit).
// Water faces carry isWater in bit 2 (their materialType=1 leaves bit 2 clear;
// Cutout=2 faces render on the opaque pipeline), so bit 3 stays a clean
// posOffX correction for every face — water never sets posOffX/posOffZ.
//
// The face arenas are declared as flat array<u32> (NOT array<vec3<u32>>:
// WGSL storage-buffer layout pads vec3 elements to a 16-byte stride, which
// would misalign every face after the first), so loadFace reads 3 consecutive
// u32s per face.

fn loadFace(arena : u32, idx : u32) -> vec3<u32> {
  let i3 = idx * 3u;
${loadFaceBody}}

${fogWGSL(o.fog)}
const DIAGONAL : f32 = 0.70710678;
const INV_POS : f32 = 0.125;
const INV_LIGHT : f32 = 1.0 / 15.0;

const CORNER_LUT = array<u32,16>(
  0u,1u,2u,3u,   // state 0  (was packed byte 228)
  3u,0u,1u,2u,   // state 1  (was packed byte 147)
  2u,1u,0u,3u,   // state 2  (was packed byte 198)
  1u,0u,3u,2u    // state 3  (was packed byte 177)
);

const ATLAS_CORNER_LUT = array<u32,24>(
  0u,3u,2u,1u,   // axisFace 0
  1u,2u,3u,0u,   // axisFace 1
  0u,3u,2u,1u,   // axisFace 2
  3u,0u,1u,2u,   // axisFace 3
  1u,0u,3u,2u,   // axisFace 4
  0u,1u,2u,3u    // axisFace 5 (default/else case)
);

const AXIS_BASIS = array<vec3<f32>,3>(
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0)
);

const CORNER_U = array<f32, 4>(0.0, 1.0, 1.0, 0.0);
const CORNER_V = array<f32, 4>(0.0, 0.0, 1.0, 1.0);
const U_AXIS = array<u32, 3>(1u, 2u, 0u);
const V_AXIS = array<u32, 3>(2u, 0u, 1u);

@vertex
fn mainVertex(input : VertexInput, @builtin(instance_index) instanceIndex : u32, @builtin(vertex_index) vertexIndex : u32) -> VSOut {
  var out : VSOut;

  let faceBase = u32(input.world3.w);
  let arena = u32(input.world0.w);
  let offsetBase = u32(input.world1.x);
  let face = loadFace(arena, faceBase + instanceIndex);

  let aByte = f32(face.x & 0xffu);
  let bByte = f32((face.x >> 8u) & 0xffu);
  let cByte = f32((face.x >> 16u) & 0xffu);
  let axisFace = (face.x >> 24u) & 7u;

  let widthByte = face.y & 0xffu;
  let heightByte = (face.y >> 8u) & 0xffu;
  let tileX = (face.y >> 16u) & 0xffu;
  let tileY = (face.y >> 24u) & 0xffu;

  let packedAO = face.z & 0xffu;
  let lightByte = (face.z >> 8u) & 0xffu;
  let metaByte = (face.z >> 16u) & 0xffu;
  let localChunk = (face.z >> 24u) & 0x3fu;
${o.tint ? "  let tintBucket = (face.x >> 27u) & 7u;" : ""}

  let axis = axisFace >> 1u;
  let isBackFace = axisFace & 1u;
  let flip = metaByte & 1u;
  let diagonalEnabled = (metaByte >> 4u) & 1u;
  let diagonalVariant = (metaByte >> 5u) & 1u;
  let rawDimensions = (metaByte >> 6u) & 1u;

  let faceWidth = select(f32(widthByte) * INV_POS, f32(widthByte), rawDimensions != 0u);
  let faceHeight = select(f32(heightByte) * INV_POS, f32(heightByte), rawDimensions != 0u);

  let co = chunkOffsets[offsetBase + localChunk];

  let posX = aByte * INV_POS - f32((metaByte >> 3u) & 1u) * 0.5 * INV_POS;
  let posZ = cByte * INV_POS - f32((metaByte >> 7u) & 1u) * 0.5 * INV_POS;
  var baseX = posX + co.x;
  var baseY = bByte * INV_POS + co.y;
  var baseZ = posZ + co.z;

  // materialType==3 marks chunk-boundary faces: their true plane (coord =
  // CHUNK_SIZE) exceeds the u8 position encoding, which clamped them 1/8
  // block inward. Restore the exact plane along the face axis (+1 position
  // unit = INV_POS, NOT one block).
  if (((metaByte >> 1u) & 3u) == 3u) {
    if (axis == 0u) { baseX = baseX + INV_POS; }
    else if (axis == 1u) { baseY = baseY + INV_POS; }
    else { baseZ = baseZ + INV_POS; }
  }

  let skyLight = f32((lightByte >> 4u) & 0x0fu) * INV_LIGHT;
  let blockLight = f32(lightByte & 0x0fu) * INV_LIGHT;

  let cornerState = (isBackFace << 1u) | flip;
  let uAxis = U_AXIS[axis];
  let vAxis = V_AXIS[axis];
  let faceSign = select(1.0, -1.0, isBackFace != 0u);

  let isDiag = diagonalEnabled != 0u;

  let aNormal = AXIS_BASIS[axis] * faceSign;
  let aTangent = AXIS_BASIS[uAxis] * faceSign;

  let dZ = select(-DIAGONAL, DIAGONAL, diagonalVariant == 0u);
  let dTangent = vec3<f32>(DIAGONAL, 0.0, dZ);
  let dNormal = vec3<f32>(dZ * faceSign, 0.0, -DIAGONAL * faceSign);

  let sharedNormal = select(aNormal, dNormal, isDiag);
  let sharedTangent = select(aTangent, dTangent, isDiag);
${o.tangentSpaceLighting ? "  let sharedBitangent = cross(sharedNormal, sharedTangent);" : ""}

  let vid = vertexIndex;
  let corner = CORNER_LUT[cornerState * 4u + vid];
  let cuF = CORNER_U[corner];
  let cvF = CORNER_V[corner];

  var position : vec3<f32>;
  var faceU : f32;
  var faceV : f32;
  if (isDiag) {
    let diagH = (cuF - 0.5) * faceWidth;
    position = vec3<f32>(
      baseX + sharedTangent.x * diagH,
      baseY + cvF * faceHeight,
      baseZ + sharedTangent.z * diagH
    );
    faceU = cuF;
    faceV = cvF;
  } else {
    let fractionalX = fract(posX);
    let fractionalZ = fract(posZ);
    let uvOffsetU = select(fractionalX, fractionalZ, uAxis == 0u);
    let uvOffsetV = select(fractionalX, fractionalZ, vAxis == 0u);

    let pu = cuF * faceWidth;
    let pv = cvF * faceHeight;
    position = vec3<f32>(baseX, baseY, baseZ) + AXIS_BASIS[uAxis] * pu + AXIS_BASIS[vAxis] * pv;

    let ac = ATLAS_CORNER_LUT[axisFace * 4u + corner];
    let atlasU = (ac ^ (ac >> 1u)) & 1u;
    let atlasV = ac >> 1u;
    let swapUV = axisFace < 4u;
    faceU = select(f32(atlasU) * faceWidth + uvOffsetU, f32(atlasU) * faceHeight + uvOffsetV, swapUV);
    faceV = select(f32(atlasV) * faceHeight + uvOffsetV, f32(atlasV) * faceWidth + uvOffsetU, swapUV);
  }

  let localPosition = vec4<f32>(position, 1.0);
  let worldPos = shaderSystem.world * localPosition;
  out.pos = shaderSystem.worldViewProjection * localPosition;
  let ambientOcclusion = (packedAO >> (corner << 1u)) & 3u;
  let toCamera = shaderSystem.cameraPosition - worldPos.xyz;
  let distSq = dot(toCamera, toCamera);
  let invDist = inverseSqrt(max(distSq, 1e-8));
${o.fog ? "  let dist = distSq * invDist;" : ""}
${vsOutAssignments(o)}
  return out;
}
`;
}
