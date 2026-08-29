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
	/**
	 * Hoists N·L to the vertex stage. Exact for flat faces (greedy quads have
	 * constant normals) and removes a per-pixel dot+max from the fragment.
	 */
	vertexDiffuse?: boolean;
	/**
	 * Raw-units variant for downsampled LOD4+ builds. Faces are emitted by
	 * QuadBuffer.emitQuadRawUnits: positions/dimensions are WHOLE BLOCKS
	 * written verbatim (no ×8 POS_SCALE), the meta byte is guaranteed zero,
	 * diagonal faces cannot exist, and chunk-boundary planes encode exactly —
	 * so this strips the INV_POS scaling, the posOff corrections, the
	 * materialType==3 boundary restore, the rawDimensions selects, the flip
	 * bit, the diagonal branch and the fractional UV offsets entirely.
	 */
	rawUnits?: boolean;
	/**
	 * Emit the materialType==3 chunk-boundary plane restore (+INV_POS along
	 * the face axis). Water faces carry META_WATER in meta bit 2, which IS
	 * the high bit of the 2-bit materialType field, so ((metaByte >> 1) & 3)
	 * decodes as 3 for EVERY water face — materials whose buckets hold only
	 * water (chunkTransparentLite, lod2/lod3 transparent) MUST pass false or
	 * every water quad is displaced one position unit (1/8 block) along its
	 * axis. Opaque/cutout buckets never receive META_WATER faces, so they
	 * keep the default and genuine boundary cubes keep working.
	 */
	boundarySentinel?: boolean;
	/**
	 * Emit the ambient-occlusion varying. Downsampled builds (lodStep > 1)
	 * run with session.disableAO=true, which zeroes every face's packed AO
	 * word — pass false there to drop the byte decode, the per-corner
	 * shift/mask and the varying itself. The fragment stage MUST agree:
	 * remove the matching VSOut field when this is false.
	 */
	ao?: boolean;
	/**
	 * Bake every per-quad lighting term into ONE flat vec3 varying
	 * (`vShade` @15): wetness darkening × (1 + N·L·sun·sky) × lightMix ×
	 * faceShade. Drops the vNormal (@5) and vLight (@7) varyings entirely.
	 * The paired fragment stage MUST drop those VSOut fields and reduce to
	 * `diffuse.rgb * in.vShade` (+ tint/fog).
	 */
	bakeShade?: boolean;
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
//  15: vDiffuse     (optional, flat — vertex-hoisted N·L for flat faces)

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
	if (!opts.bakeShade)
		f.push("  @location(5) @interpolate(flat) vNormal : vec3<f32>,");
	if (opts.ao) f.push("  @location(6) vAO : f32,");
	if (!opts.bakeShade)
		f.push("  @location(7) @interpolate(flat) vLight : vec2<f32>,");
	if (opts.meta) f.push("  @location(9) @interpolate(flat) vMeta : u32,");
	if (opts.fog) {
		f.push("  @location(10) vFogFactor : f32,");
		f.push("  @location(11) vFogColor : vec3<f32>,");
	}
	if (opts.tint) f.push("  @location(12) @interpolate(flat) vTint : u32,");
	if (opts.bakeShade)
		f.push("  @location(15) @interpolate(flat) vShade : vec3<f32>,");
	else if (opts.vertexDiffuse)
		f.push("  @location(15) @interpolate(flat) vDiffuse : f32,");
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
	if (!opts.bakeShade) a.push("  out.vNormal = sharedNormal;");
	if (opts.ao) a.push("  out.vAO = f32(ambientOcclusion);");
	if (!opts.bakeShade)
		a.push("  out.vLight = vec2<f32>(skyLight, blockLight);");
	if (opts.meta) a.push("  out.vMeta = metaByte;");
	if (opts.tint) a.push("  out.vTint = tintBucket;");
	if (opts.bakeShade) {
		// Identical op-set the LOD4 fragment used to run per pixel — moved
		// here verbatim. All inputs are flat varyings or uniforms, so vShade
		// is constant across each quad.
		a.push("  let sunI = shaderUniforms.sunLightIntensity;");
		a.push("  let skyScale = skyLight * 0.8 * (sunI + 0.2);");
		a.push(
			"  let lightMix = clamp(vec3<f32>(skyScale) + blockLight * vec3<f32>(0.9, 0.6, 0.2), vec3<f32>(0.18), vec3<f32>(1.0));",
		);
		a.push("  let topBottom = select(0.58, 1.0, sharedNormal.y > 0.0);");
		a.push(
			"  let faceShade = select(0.78, topBottom, abs(sharedNormal.y) > 0.5);",
		);
		a.push(
			"  let diffuseTerm = max(0.0, dot(shaderUniforms.lightDirection, sharedNormal));",
		);
		a.push(
			"  out.vShade = mix(1.0, 0.65, shaderUniforms.wetness) * (vec3<f32>(1.0 + diffuseTerm * sunI * skyLight) * lightMix * faceShade);",
		);
	} else if (opts.vertexDiffuse) {
		a.push(
			"  out.vDiffuse = max(0.0, dot(shaderUniforms.lightDirection, sharedNormal));",
		);
	}
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
	const rawUnits = opts.rawUnits ?? false;
	const bakeShade = opts.bakeShade ?? false;
	const tangentSpaceLighting = opts.tangentSpaceLighting ?? false;

	/*
	 * Normalize option dependencies once in TypeScript rather than generating
	 * dead or contradictory WGSL paths.
	 *
	 * rawUnits guarantees:
	 *   - metaByte == 0
	 *   - no boundary sentinel
	 *   - no diagonal faces
	 *   - no packed position corrections
	 *
	 * bakeShade supersedes vertexDiffuse because both occupy location 15.
	 * Tangent-space lighting supplies the view direction at location 13.
	 */
	const o: ResolvedVertexShaderOptions = {
		fog: opts.fog ?? true,
		tint: opts.tint ?? true,
		meta: opts.meta ?? true,
		tangent: opts.tangent ?? true,
		worldPosition: opts.worldPosition ?? true,
		viewDir: !tangentSpaceLighting && (opts.viewDir ?? true),
		tangentSpaceLighting,
		vertexDiffuse: !bakeShade && (opts.vertexDiffuse ?? false),
		rawUnits,
		boundarySentinel: !rawUnits && (opts.boundarySentinel ?? true),
		ao: opts.ao ?? true,
		bakeShade,
	};

	const loadFaceBranches = new Array<string>(arenas);
	for (let i = 0; i < arenas; i++) {
		loadFaceBranches[i] =
			`  if (arena == ${i}u) { return vec3<u32>(faceData${i}[i3], faceData${i}[i3 + 1u], faceData${i}[i3 + 2u]); }`;
	}

	const loadFaceBody =
		`${loadFaceBranches.join("\n")}\n` +
		"  return vec3<u32>(faceData0[i3], faceData0[i3 + 1u], faceData0[i3 + 2u]);";

	const boundaryRestoreBlock = o.boundarySentinel
		? `
  if (((metaByte >> 1u) & 3u) == 3u) {
    if (axis == 0u) {
      baseX += INV_POS;
    } else if (axis == 1u) {
      baseY += INV_POS;
    } else {
      baseZ += INV_POS;
    }
  }
`
		: "";

	const tintDecode = o.tint ? "  let tintBucket = (face.x >> 27u) & 7u;" : "";

	const decodeBlock = o.rawUnits
		? `  // Raw-units faces guarantee a zero meta byte.
  let metaByte = 0u;
  let localChunk = (face.z >> 24u) & 0x3fu;
${tintDecode}

  let axis = axisFace >> 1u;
  let isBackFace = axisFace & 1u;

  let faceWidth = f32(widthByte);
  let faceHeight = f32(heightByte);

  let co = chunkOffsets[offsetBase + localChunk];

  let baseX = f32(aByte) + co.x;
  let baseY = f32(bByte) + co.y;
  let baseZ = f32(cByte) + co.z;
`
		: `  let metaByte = (face.z >> 16u) & 0xffu;
  let localChunk = (face.z >> 24u) & 0x3fu;
${tintDecode}

  let axis = axisFace >> 1u;
  let isBackFace = axisFace & 1u;
  let flip = metaByte & 1u;
  let diagonalEnabled = (metaByte >> 4u) & 1u;
  let diagonalVariant = (metaByte >> 5u) & 1u;
  let rawDimensions = (metaByte >> 6u) & 1u;

  let faceWidth = select(
    f32(widthByte) * INV_POS,
    f32(widthByte),
    rawDimensions != 0u
  );
  let faceHeight = select(
    f32(heightByte) * INV_POS,
    f32(heightByte),
    rawDimensions != 0u
  );

  let co = chunkOffsets[offsetBase + localChunk];

  let posX = aByte * INV_POS -
    f32((metaByte >> 3u) & 1u) * HALF_INV_POS;
  let posZ = cByte * INV_POS -
    f32((metaByte >> 7u) & 1u) * HALF_INV_POS;

  var baseX = posX + co.x;
  var baseY = bByte * INV_POS + co.y;
  var baseZ = posZ + co.z;
${boundaryRestoreBlock}`;

	const normalBlock = o.rawUnits
		? `  let cornerState = isBackFace << 1u;
  let uAxis = U_AXIS[axis];
  let vAxis = V_AXIS[axis];
  let faceSign = select(1.0, -1.0, isBackFace != 0u);

  let sharedNormal = AXIS_BASIS[axis] * faceSign;
  let sharedTangent = AXIS_BASIS[uAxis] * faceSign;
`
		: `  let cornerState = (isBackFace << 1u) | flip;
  let uAxis = U_AXIS[axis];
  let vAxis = V_AXIS[axis];
  let faceSign = select(1.0, -1.0, isBackFace != 0u);

  let isDiag = diagonalEnabled != 0u;

  let axisNormal = AXIS_BASIS[axis] * faceSign;
  let axisTangent = AXIS_BASIS[uAxis] * faceSign;

  let diagonalZ = select(-DIAGONAL, DIAGONAL, diagonalVariant == 0u);
  let diagonalTangent = vec3<f32>(DIAGONAL, 0.0, diagonalZ);
  let diagonalNormal =
    vec3<f32>(diagonalZ * faceSign, 0.0, -DIAGONAL * faceSign);

  let sharedNormal = select(axisNormal, diagonalNormal, isDiag);
  let sharedTangent = select(axisTangent, diagonalTangent, isDiag);
`;

	const positionBlock = o.rawUnits
		? `  let pu = cuF * faceWidth;
  let pv = cvF * faceHeight;

  position =
    vec3<f32>(baseX, baseY, baseZ) +
    AXIS_BASIS[uAxis] * pu +
    AXIS_BASIS[vAxis] * pv;

  let atlasCorner = ATLAS_CORNER_LUT[axisFace * 4u + corner];
  let atlasU = (atlasCorner ^ (atlasCorner >> 1u)) & 1u;
  let atlasV = atlasCorner >> 1u;
  let swapUV = axisFace < 4u;

  faceU = select(
    f32(atlasU) * faceWidth,
    f32(atlasU) * faceHeight,
    swapUV
  );
  faceV = select(
    f32(atlasV) * faceHeight,
    f32(atlasV) * faceWidth,
    swapUV
  );
`
		: `  if (isDiag) {
    let diagonalOffset = (cuF - 0.5) * faceWidth;

    position = vec3<f32>(
      baseX + sharedTangent.x * diagonalOffset,
      baseY + cvF * faceHeight,
      baseZ + sharedTangent.z * diagonalOffset
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

    position =
      vec3<f32>(baseX, baseY, baseZ) +
      AXIS_BASIS[uAxis] * pu +
      AXIS_BASIS[vAxis] * pv;

    let atlasCorner = ATLAS_CORNER_LUT[axisFace * 4u + corner];
    let atlasU = (atlasCorner ^ (atlasCorner >> 1u)) & 1u;
    let atlasV = atlasCorner >> 1u;
    let swapUV = axisFace < 4u;

    faceU = select(
      f32(atlasU) * faceWidth + uvOffsetU,
      f32(atlasU) * faceHeight + uvOffsetV,
      swapUV
    );
    faceV = select(
      f32(atlasV) * faceHeight + uvOffsetV,
      f32(atlasV) * faceWidth + uvOffsetU,
      swapUV
    );
  }
`;

	const aoDecode = o.ao ? "  let packedAO = face.z & 0xffu;" : "";

	const bitangentDeclaration = o.tangentSpaceLighting
		? "  let sharedBitangent = cross(sharedNormal, sharedTangent);"
		: "";

	const ambientOcclusionDecode = o.ao
		? `  let ambientOcclusion =
    (packedAO >> (corner << 1u)) & 3u;`
		: "";

	const distanceDeclaration = o.fog ? "  let dist = distSq * invDist;" : "";

	return /* wgsl */ `
struct VSOut {
${vsOutFields(o)}
};

fn loadFace(arena : u32, idx : u32) -> vec3<u32> {
  let i3 = idx * 3u;
${loadFaceBody}
}

${fogWGSL(o.fog)}

const DIAGONAL : f32 = 0.70710678;
const INV_POS : f32 = 0.125;
const HALF_INV_POS : f32 = 0.0625;
const INV_LIGHT : f32 = 0.0666666667;

const CORNER_LUT = array<u32, 16>(
  0u, 1u, 2u, 3u,
  3u, 0u, 1u, 2u,
  2u, 1u, 0u, 3u,
  1u, 0u, 3u, 2u
);

const ATLAS_CORNER_LUT = array<u32, 24>(
  0u, 3u, 2u, 1u,
  1u, 2u, 3u, 0u,
  0u, 3u, 2u, 1u,
  3u, 0u, 1u, 2u,
  1u, 0u, 3u, 2u,
  0u, 1u, 2u, 3u
);

const AXIS_BASIS = array<vec3<f32>, 3>(
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0)
);

const CORNER_U = array<f32, 4>(0.0, 1.0, 1.0, 0.0);
const CORNER_V = array<f32, 4>(0.0, 0.0, 1.0, 1.0);
const U_AXIS = array<u32, 3>(1u, 2u, 0u);
const V_AXIS = array<u32, 3>(2u, 0u, 1u);

@vertex
fn mainVertex(
  input : VertexInput,
  @builtin(instance_index) instanceIndex : u32,
  @builtin(vertex_index) vertexIndex : u32
) -> VSOut {
  var out : VSOut;

  let faceBase = u32(input.instData.x);
  let arena = u32(input.instData.y);
  let offsetBase = u32(input.instData.z);
  let face = loadFace(arena, faceBase + instanceIndex);

  let aByte = f32(face.x & 0xffu);
  let bByte = f32((face.x >> 8u) & 0xffu);
  let cByte = f32((face.x >> 16u) & 0xffu);
  let axisFace = (face.x >> 24u) & 7u;

  let widthByte = face.y & 0xffu;
  let heightByte = (face.y >> 8u) & 0xffu;
  let tileX = (face.y >> 16u) & 0xffu;
  let tileY = (face.y >> 24u) & 0xffu;

${aoDecode}
  let lightByte = (face.z >> 8u) & 0xffu;
${decodeBlock}

  let skyLight = f32((lightByte >> 4u) & 0x0fu) * INV_LIGHT;
  let blockLight = f32(lightByte & 0x0fu) * INV_LIGHT;

${normalBlock}
${bitangentDeclaration}

  let corner = CORNER_LUT[cornerState * 4u + vertexIndex];
  let cuF = CORNER_U[corner];
  let cvF = CORNER_V[corner];

  var position : vec3<f32>;
  var faceU : f32;
  var faceV : f32;

${positionBlock}

  let localPosition = vec4<f32>(position, 1.0);
  let worldPos = shaderSystem.world * localPosition;

  out.pos = shaderSystem.worldViewProjection * localPosition;

${ambientOcclusionDecode}
  let toCamera = shaderSystem.cameraPosition - worldPos.xyz;
  let distSq = dot(toCamera, toCamera);
  let invDist = inverseSqrt(max(distSq, 1e-8));
${distanceDeclaration}

${vsOutAssignments(o)}
  return out;
}
`;
}
