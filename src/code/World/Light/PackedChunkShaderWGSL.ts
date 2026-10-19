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
	 * Restore liquid quads whose packed coordinate is the exact positive
	 * chunk boundary. This is separate from boundarySentinel because water
	 * uses META_WATER, which makes the material sentinel decode as 3 for every
	 * water face.
	 */
	boundaryFlag?: boolean;
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
//   5: vNormal      (always unless bakeShade)
//   6: vAO          (optional)
//   7: vLight       (always unless bakeShade)
//   9: vMeta        (optional)
//  10: vFogFactor   (optional)
//  11: vFogColor    (optional)
//  12: vTint        (optional)
//  13: vViewDir / vViewDirTS (optional)
//  14: vLightDirTS   (optional, tangent-space lighting only, normalized)
//  15: vShade / vDiffuse (optional, flat)

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

function buildRawUnitsNormalBlock(
	needsNormal: boolean,
	needsTangent: boolean,
	needsBitangent: boolean,
): string {
	const lines: string[] = [];

	lines.push(" let cornerState = isBackFace << 1u;");
	lines.push(" let uAxis = U_AXIS[axis];");
	lines.push(" let vAxis = V_AXIS[axis];");

	if (needsNormal || needsTangent || needsBitangent) {
		lines.push(" let faceSign = select(1.0, -1.0, isBackFace != 0u);");
	}

	if (needsNormal || needsBitangent) {
		lines.push(" let sharedNormal = AXIS_BASIS[axis] * faceSign;");
	}

	if (needsTangent || needsBitangent) {
		lines.push(" let sharedTangent = AXIS_BASIS[uAxis] * faceSign;");
	}

	if (needsBitangent) {
		lines.push(" let sharedBitangent = cross(sharedNormal, sharedTangent);");
	}

	return lines.join("\n");
}

function buildPackedNormalBlock(
	needsNormal: boolean,
	needsTangent: boolean,
	needsBitangent: boolean,
): string {
	const lines: string[] = [];

	lines.push(" let cornerState = (isBackFace << 1u) | flip;");
	lines.push(" let uAxis = U_AXIS[axis];");
	lines.push(" let vAxis = V_AXIS[axis];");
	lines.push(" let faceSign = select(1.0, -1.0, isBackFace != 0u);");
	lines.push(" let isDiag = diagonalEnabled != 0u;");

	if (needsNormal || needsBitangent) {
		lines.push(" let axisNormal = AXIS_BASIS[axis] * faceSign;");
		lines.push(
			" let diagonalZ = select(-DIAGONAL, DIAGONAL, diagonalVariant == 0u);",
		);
		lines.push(
			" let diagonalNormal = vec3<f32>(diagonalZ * faceSign, 0.0, -DIAGONAL * faceSign);",
		);
		lines.push(
			" let sharedNormal = select(axisNormal, diagonalNormal, isDiag);",
		);
	} else if (needsTangent) {
		lines.push(
			" let diagonalZ = select(-DIAGONAL, DIAGONAL, diagonalVariant == 0u);",
		);
	}

	if (needsTangent || needsBitangent) {
		lines.push(" let axisTangent = AXIS_BASIS[uAxis] * faceSign;");
		lines.push(" let diagonalTangent = vec3<f32>(DIAGONAL, 0.0, diagonalZ);");
		lines.push(
			" let sharedTangent = select(axisTangent, diagonalTangent, isDiag);",
		);
	}

	if (needsBitangent) {
		lines.push(" let sharedBitangent = cross(sharedNormal, sharedTangent);");
	}

	return lines.join("\n");
}

function buildRawUnitsPositionBlock(): string {
	return /* wgsl */ ` let pu = cuF * faceWidth;
 let pv = cvF * faceHeight;

 position =
 vec3<f32>(baseX, baseY, baseZ) +
 AXIS_BASIS[uAxis] * pu +
 AXIS_BASIS[vAxis] * pv;

 let atlasCorner = ATLAS_CORNER_LUT[axisFace * 4u + corner];
 let atlasU = (atlasCorner ^ (atlasCorner >> 1u)) & 1u;
 let atlasV = atlasCorner >> 1u;
 let swapUV = axisFace < 4u;

 let atlasUF = f32(atlasU);
 let atlasVF = f32(atlasV);

 let selectedUV = select(
 vec2<f32>(
 atlasUF * faceWidth,
 atlasVF * faceHeight
 ),
 vec2<f32>(
 atlasUF * faceHeight,
 atlasVF * faceWidth
 ),
 swapUV
 );

 faceU = selectedUV.x;
 faceV = selectedUV.y;
`;
}

function buildPackedPositionBlock(): string {
	return /* wgsl */ ` if (isDiag) {
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
 let fractionalY = fract(baseY);
 let fractionalZ = fract(posZ);

 let uvOffsetU = select(
 select(fractionalX, fractionalZ, uAxis == 2u),
 fractionalY,
 uAxis == 1u
 );

 let uvOffsetV = select(
 select(fractionalX, fractionalZ, vAxis == 2u),
 fractionalY,
 vAxis == 1u
 );

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
}

function buildWorldAndCameraBlock(
	needsWorldPosition: boolean,
	needsCameraVector: boolean,
	needsFogDistance: boolean,
): string {
	const lines: string[] = [];

	if (needsWorldPosition) {
		lines.push(" let worldPos = shaderSystem.world * localPosition;");
	}

	if (needsCameraVector) {
		lines.push(" let toCamera = shaderSystem.cameraPosition - worldPos.xyz;");
		lines.push(" let distSq = dot(toCamera, toCamera);");
		lines.push(" let invDist = inverseSqrt(max(distSq, 1e-8));");
	}

	if (needsFogDistance) {
		lines.push(" let dist = distSq * invDist;");
	}

	return lines.join("\n");
}

function buildGeneralShadeAssignment(): string {
	return /* wgsl */ ` let sunI = shaderUniforms.sunLightIntensity;
 let skyScale = skyLight * 0.8 * (sunI + 0.2);

 let lightMix = clamp(
 vec3<f32>(skyScale) +
 blockLight * vec3<f32>(0.9, 0.6, 0.2),
 vec3<f32>(0.18),
 vec3<f32>(1.0)
 );

 let topBottom =
 select(0.58, 1.0, sharedNormal.y > 0.0);

 let faceShade =
 select(0.78, topBottom, abs(sharedNormal.y) > 0.5);

 let diffuseTerm = max(
 0.0,
 dot(shaderUniforms.lightDirection, sharedNormal)
 );

 let wetnessFactor =
 1.0 - shaderUniforms.wetness * 0.35;

 let directLight =
 1.0 + diffuseTerm * sunI * skyLight;

 out.vShade =
 vec3<f32>(wetnessFactor * directLight * faceShade) *
 lightMix;`;
}

function buildRawUnitsShadeAssignment(): string {
	return /* wgsl */ ` let sunI = shaderUniforms.sunLightIntensity;
 let skyScale = skyLight * 0.8 * (sunI + 0.2);

 let lightMix = clamp(
 vec3<f32>(skyScale) +
 blockLight * vec3<f32>(0.9, 0.6, 0.2),
 vec3<f32>(0.18),
 vec3<f32>(1.0)
 );

 let faceSign =
 select(1.0, -1.0, isBackFace != 0u);

 let axisLight = select(
 select(
 shaderUniforms.lightDirection.x,
 shaderUniforms.lightDirection.z,
 axis == 2u
 ),
 shaderUniforms.lightDirection.y,
 axis == 1u
 );

 let diffuseTerm =
 max(0.0, axisLight * faceSign);

 let verticalShade =
 select(1.0, 0.58, isBackFace != 0u);

 let faceShade =
 select(0.78, verticalShade, axis == 1u);

 let wetnessFactor =
 1.0 - shaderUniforms.wetness * 0.35;

 let directLight =
 1.0 + diffuseTerm * sunI * skyLight;

 out.vShade =
 vec3<f32>(wetnessFactor * directLight * faceShade) *
 lightMix;`;
}

function vsOutAssignments(opts: ResolvedVertexShaderOptions): string {
	const a: string[] = [];

	a.push(" out.vUV = vec2<f32>(faceU, faceV);");
	a.push(" out.vTileLayer = tileY * shaderUniforms.atlasMaxTilesU32 + tileX;");

	if (opts.worldPosition) {
		a.push(" out.vWorldPosition = worldPos.xyz;");
	}

	if (opts.tangent) {
		a.push(" out.vTangent = sharedTangent;");
	}

	if (!opts.bakeShade) {
		a.push(" out.vNormal = sharedNormal;");
	}

	if (opts.ao) {
		a.push(" out.vAO = f32(ambientOcclusion);");
	}

	if (!opts.bakeShade) {
		a.push(" out.vLight = vec2<f32>(skyLight, blockLight);");
	}

	if (opts.meta) {
		a.push(" out.vMeta = metaByte;");
	}

	if (opts.tint) {
		a.push(" out.vTint = tintBucket;");
	}

	if (opts.bakeShade) {
		a.push(
			opts.rawUnits
				? buildRawUnitsShadeAssignment()
				: buildGeneralShadeAssignment(),
		);
	} else if (opts.vertexDiffuse) {
		a.push(
			" out.vDiffuse = max(0.0, dot(shaderUniforms.lightDirection, sharedNormal));",
		);
	}

	if (opts.fog) {
		a.push(" let infos = shaderUniforms.fogInfos;");
		a.push(" let fogStart = infos.y;");
		a.push(" let fogEnd = infos.z;");
		a.push(
			" out.vFogFactor = clamp((dist - fogStart) / max(fogEnd - fogStart, 1.0), 0.0, 1.0);",
		);
		a.push(" let heightFactor = clamp(worldPos.y * 0.003, 0.0, 1.0);");
		a.push(" let atmosphereColor = getAtmosphereColor(heightFactor);");
		a.push(
			" let baseFogColor = mix(shaderUniforms.fogColor, atmosphereColor, 0.8);",
		);
		a.push(" let viewDirY = -toCamera.y * invDist;");
		a.push(" let skyboxColor = getSkyboxColor(viewDirY);");
		a.push(" let skyBlend = clamp((dist - 1400.0) * 0.0003333, 0.0, 1.0);");
		a.push(" out.vFogColor = mix(baseFogColor, skyboxColor, skyBlend);");
	}

	if (opts.tangentSpaceLighting) {
		a.push(" let normalizedView = toCamera * invDist;");
		a.push(" out.vViewDirTS = vec3<f32>(");
		a.push(" dot(normalizedView, sharedTangent),");
		a.push(" dot(normalizedView, sharedBitangent),");
		a.push(" dot(normalizedView, sharedNormal)");
		a.push(" );");
		a.push(" out.vLightDirTS = normalize(vec3<f32>(");
		a.push(" dot(shaderUniforms.lightDirection, sharedTangent),");
		a.push(" dot(shaderUniforms.lightDirection, sharedBitangent),");
		a.push(" dot(shaderUniforms.lightDirection, sharedNormal)");
		a.push(" ));");
	} else if (opts.viewDir) {
		a.push(" out.vViewDir = toCamera * invDist;");
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
		boundaryFlag: !rawUnits && (opts.boundaryFlag ?? false),
		ao: opts.ao ?? true,
		bakeShade,
	};

	const needsCameraVector = o.fog || o.viewDir || o.tangentSpaceLighting;

	const needsWorldPosition = o.worldPosition || needsCameraVector;

	// Packed bakeShade (LOD2/LOD3) needs sharedNormal for the general shade
	// assignment; rawUnits bakeShade (LOD4) shades via axis/faceSign and needs
	// no normal. Non-baked variants always emit vNormal (@5).
	const needsNormal =
		!o.rawUnits ||
		!o.bakeShade ||
		o.tangentSpaceLighting ||
		o.tangent ||
		o.vertexDiffuse;

	const needsTangent = o.tangent || o.tangentSpaceLighting;

	// Packed (non-rawUnits) position needs sharedTangent for the diagonal
	// branch even when no varying consumes it. Raw-units guarantees no
	// diagonal faces, so only packed forces the tangent path.
	const needsTangentWithPosition = needsTangent || !o.rawUnits;

	const needsBitangent = o.tangentSpaceLighting;

	const needsLight = !o.bakeShade;
	void needsLight;

	const loadFaceBody =
		arenas === 1
			? " return vec3<u32>(faceData0[i3], faceData0[i3 + 1u], faceData0[i3 + 2u]);"
			: ` switch arena {
${Array.from(
	{ length: arenas },
	(_, i) =>
		` case ${i}u: { return vec3<u32>(faceData${i}[i3], faceData${i}[i3 + 1u], faceData${i}[i3 + 2u]); }`,
).join("\n")}
default: { return vec3<u32>(faceData0[i3], faceData0[i3 + 1u], faceData0[i3 + 2u]); }
}`;

	const boundaryRestoreBlock = o.boundarySentinel || o.boundaryFlag
		? `
if (${o.boundarySentinel ? "(((metaByte >> 1u) & 3u) == 3u)" : "false"} || ${o.boundaryFlag ? "(((metaByte >> 5u) & 1u) != 0u)" : "false"}) {
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

	const tintDecode = o.tint ? " let tintBucket = (face.x >> 27u) & 7u;" : "";

	const decodeBlock = o.rawUnits
		? ` let metaByte = 0u;
 let localChunk = face.z >> 24u;
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
		: ` let metaByte = (face.z >> 16u) & 0xffu;
 let localChunk = face.z >> 24u;
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

 let posX = f32(aByte) * INV_POS -
 f32((metaByte >> 3u) & 1u) * HALF_INV_POS;

 let posZ = f32(cByte) * INV_POS -
 f32((metaByte >> 7u) & 1u) * HALF_INV_POS;

 var baseX = posX + co.x;
 var baseY = f32(bByte) * INV_POS + co.y;
 var baseZ = posZ + co.z;
${boundaryRestoreBlock}`;

	const normalBlock = o.rawUnits
		? buildRawUnitsNormalBlock(needsNormal, needsTangent, needsBitangent)
		: buildPackedNormalBlock(
				needsNormal,
				needsTangentWithPosition,
				needsBitangent,
			);

	const positionBlock = o.rawUnits
		? buildRawUnitsPositionBlock()
		: buildPackedPositionBlock();

	const aoDecode = o.ao ? " let packedAO = face.z & 0xffu;" : "";

	const ambientOcclusionDecode = o.ao
		? ` let ambientOcclusion =
 (packedAO >> (corner << 1u)) & 3u;`
		: "";

	const worldBlock = buildWorldAndCameraBlock(
		needsWorldPosition,
		needsCameraVector,
		o.fog,
	);

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

let faceX = face.x;
let faceY = face.y;
let faceZ = face.z;

let aByte = faceX & 0xffu;
let bByte = (faceX >> 8u) & 0xffu;
let cByte = (faceX >> 16u) & 0xffu;
let axisFace = (faceX >> 24u) & 7u;

let widthByte = faceY & 0xffu;
let heightByte = (faceY >> 8u) & 0xffu;
let tileX = (faceY >> 16u) & 0xffu;
let tileY = faceY >> 24u;

${aoDecode}
let lightByte = (faceZ >> 8u) & 0xffu;
${decodeBlock}

let skyLight = f32((lightByte >> 4u) & 0x0fu) * INV_LIGHT;
let blockLight = f32(lightByte & 0x0fu) * INV_LIGHT;

${normalBlock}

let corner = CORNER_LUT[cornerState * 4u + vertexIndex];
let cuF = CORNER_U[corner];
let cvF = CORNER_V[corner];

var position : vec3<f32>;
var faceU : f32;
var faceV : f32;

${positionBlock}

let localPosition = vec4<f32>(position, 1.0);
out.pos = shaderSystem.worldViewProjection * localPosition;

${worldBlock}
${ambientOcclusionDecode}

${vsOutAssignments(o)}
return out;
}
`;
}
