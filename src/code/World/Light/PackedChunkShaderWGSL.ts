export interface VertexShaderOptions {
	fog?: boolean;
	tint?: boolean;
	meta?: boolean;
	tangent?: boolean;
	worldPosition?: boolean;
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
//  13: vViewDir     (always)

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
	f.push("  @location(13) vViewDir : vec3<f32>,");
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
	};

	let loadFaceBody = "";
	for (let i = 0; i < arenas; i++) {
		loadFaceBody += `  if (arena == ${i}u) { return faceData${i}[idx]; }\n`;
	}
	loadFaceBody += "  return faceData0[idx];\n";

	return /* wgsl */ `
struct VSOut {
${vsOutFields(o)}
};

// Thin-instance matrix columns (locations 1..4): Babylon Lite's instancing path
// injects the per-instance 4x4 matrix as four vec4 vertex attributes.
//   world3.w carries this mesh's faceBase offset into its face arena.
//   world0.w carries the arena index (which faceDataN buffer to read).
// The rest of the matrix is unused (the vertex position is derived from
// faceData, not the matrix).

fn loadFace(arena : u32, idx : u32) -> vec4<u32> {
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
  let face = loadFace(arena, faceBase + instanceIndex);

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
${o.tint ? "  let tintBucket = (face.z >> 16u) & 0xffu;" : ""}
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

  let posX = aByte * INV_POS - f32((metaByte >> 3u) & 1u) * 0.5 * INV_POS;
  let posZ = cByte * INV_POS - f32((metaByte >> 7u) & 1u) * 0.5 * INV_POS;
  let baseX = posX + co.x;
  let baseY = bByte * INV_POS + co.y;
  let baseZ = posZ + co.z;

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
  out.vViewDir = toCamera * invDist;
  return out;
}
`;
}
