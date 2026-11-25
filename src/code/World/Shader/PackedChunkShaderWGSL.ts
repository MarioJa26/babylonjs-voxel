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
	 * (`vShade` @15): wetness/brightness × (1 + N·L·sun·sky) × lightMix ×
	 * faceShade. The uniform-only factors (`shadeSunScale`, `shadeWetBright`)
	 * are precomputed on the CPU once per lighting change. Drops the vNormal
	 * (@5) and vLight (@7) varyings entirely.
	 * The paired fragment stage MUST drop those VSOut fields and reduce to
	 * `diffuse.rgb * in.vShade` (+ tint/fog).
	 */
	bakeShade?: boolean;
	/**
	 * Player-facing brightness multiplier, applied once per vertex so the
	 * fragment stage never reads the uniform. With `bakeShade` it is folded
	 * straight into `vShade` (zero fragment cost); otherwise it travels as
	 * one flat `vBrightness` varying and costs a single multiply per pixel.
	 * The paired fragment stage MUST declare `vBrightness` when bakeShade is
	 * false.
	 */
	brightness?: boolean;
	/**
	 * Emit the flat world-space face normal varying (`vNormal` @5). Defaults to
	 * true (the historical behaviour: emitted whenever bakeShade is off), so
	 * existing fragment stages keep working. Fragment stages that never read
	 * `in.vNormal` (the chunk opaque/water/cutout shaders) should pass false:
	 * Tint does not link-strip unused outputs, so the normal would otherwise be
	 * computed and exported for nothing. Ignored (always false) with bakeShade.
	 */
	normal?: boolean;
}

type ResolvedVertexShaderOptions = Required<VertexShaderOptions>;
// Varying locations (stable across all variants):
//   0: vUV          (always)
//   1: vTileLayer   (always)
//   2: vWorldPosition (optional)
//   3: vTangent     (optional)
//   4: vBrightness  (optional, flat, only without bakeShade)
//   5: vNormal      (optional, flat, only without bakeShade, see `normal`)
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
	if (opts.brightness && !opts.bakeShade)
		f.push("  @location(4) @interpolate(flat) vBrightness : f32,");
	if (opts.normal)
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

/**
 * Axis frame of the face. The face axis is 0..2 and the in-plane axes are the
 * cyclic successors: U = (axis + 1) % 3, V = (axis + 2) % 3. For the one-hot
 * axis vector eA that is exactly eU = eA.zxy and eV = eA.yzx, so no U_AXIS /
 * V_AXIS / AXIS_BASIS tables (dynamically indexed const arrays, which many
 * drivers spill to scratch memory) and no compare chains are needed.
 */
const AXIS_FRAME_WGSL = ` let eA = axisVec(axis);
 let eU = eA.zxy;
 let eV = eA.yzx;`;

/**
 * Atlas corner → (u, v) bit lookup. Replaces ATLAS_CORNER_LUT plus the
 * per-vertex `(c ^ (c >> 1)) & 1` / `c >> 1` decode: each (face, corner) entry
 * is stored directly as two bits (u | v << 1). Faces 0..3 live in
 * ATLAS_PACK_LO (8 bits per face), faces 4..5 in ATLAS_PACK_HI.
 */
const ATLAS_DECODE_WGSL = ` let atlasWord = select(ATLAS_PACK_HI, ATLAS_PACK_LO, axisFace < 4u);
 let atlasBits = (atlasWord >> (((axisFace & 3u) << 3u) | (corner << 1u))) & 3u;
 let atlasU = atlasBits & 1u;
 let atlasV = atlasBits >> 1u;
 let swapUV = axisFace < 4u;`;

function buildRawUnitsNormalBlock(
	needsNormal: boolean,
	needsTangent: boolean,
	needsBitangent: boolean,
): string {
	const lines: string[] = [];

	lines.push(" let cornerState = isBackFace << 1u;");

	if (needsNormal || needsTangent || needsBitangent) {
		lines.push(" let faceSign = 1.0 - 2.0 * f32(isBackFace);");
	}

	if (needsNormal || needsBitangent) {
		lines.push(" let sharedNormal = eA * faceSign;");
	}

	if (needsTangent || needsBitangent) {
		lines.push(" let sharedTangent = eU * faceSign;");
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
	lines.push(" let faceSign = 1.0 - 2.0 * f32(isBackFace);");
	lines.push(" let isDiag = diagonalEnabled != 0u;");

	// Always needed: the diagonal branch of the position block positions its
	// corners along the diagonal tangent (DIAGONAL, 0, diagonalZ). The shared
	// (axis/diagonal) tangent is only built when something actually consumes it.
	lines.push(
		" let diagonalZ = select(-DIAGONAL, DIAGONAL, diagonalVariant == 0u);",
	);

	if (needsNormal || needsBitangent) {
		lines.push(" let axisNormal = eA * faceSign;");
		lines.push(
			" let diagonalNormal = vec3<f32>(diagonalZ * faceSign, 0.0, -DIAGONAL * faceSign);",
		);
		lines.push(
			" let sharedNormal = select(axisNormal, diagonalNormal, isDiag);",
		);
	}

	if (needsTangent || needsBitangent) {
		lines.push(" let axisTangent = eU * faceSign;");
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
 eU * pu +
 eV * pv;

${ATLAS_DECODE_WGSL}

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
 baseX + DIAGONAL * diagonalOffset,
 baseY + cvF * faceHeight,
 baseZ + diagonalZ * diagonalOffset
 );

 faceU = cuF;
 faceV = cvF;
 } else {
 // One-hot dot products pick the fractional part of the in-plane axes.
 let fractions = vec3<f32>(fract(posX), fract(baseY), fract(posZ));
 let uvOffsetU = dot(fractions, eU);
 let uvOffsetV = dot(fractions, eV);

 let pu = cuF * faceWidth;
 let pv = cvF * faceHeight;

 position =
 vec3<f32>(baseX, baseY, baseZ) +
 eU * pu +
 eV * pv;

${ATLAS_DECODE_WGSL}

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

/**
 * Sun/wetness/brightness terms are folded on the CPU once per lighting change
 * into `shadeSunScale` / `shadeWetBright` and uploaded as uniforms. Both were
 * recomputed in every vertex even though neither varies across a draw call
 * (or across frames — the sun is quantized). bakeShade materials always enable
 * brightness, so `shadeWetBright` already includes it.
 */
function buildGeneralShadeAssignment(): string {
	return /* wgsl */ ` let sunI = shaderUniforms.sunLightIntensity;
 let skyScale = skyLight * shaderUniforms.shadeSunScale;

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

 let directLight =
 1.0 + diffuseTerm * sunI * skyLight;

 out.vShade =
 vec3<f32>(shaderUniforms.shadeWetBright * directLight * faceShade) *
 lightMix;`;
}

function buildRawUnitsShadeAssignment(): string {
	return /* wgsl */ ` let sunI = shaderUniforms.sunLightIntensity;
 let skyScale = skyLight * shaderUniforms.shadeSunScale;

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

 let directLight =
 1.0 + diffuseTerm * sunI * skyLight;

 out.vShade =
 vec3<f32>(shaderUniforms.shadeWetBright * directLight * faceShade) *
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

	if (opts.normal) {
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

	if (opts.brightness && !opts.bakeShade) {
		a.push(" out.vBrightness = shaderUniforms.brightness;");
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

		// Tangent-space lighting already exports the view vector in tangent
		// space. Do not also emit the world-space view direction.
		viewDir: !tangentSpaceLighting && (opts.viewDir ?? true),

		tangentSpaceLighting,

		// bakeShade replaces both vNormal/vLight and vertexDiffuse.
		vertexDiffuse: !bakeShade && (opts.vertexDiffuse ?? false),

		rawUnits,

		// Neither boundary correction applies to raw-units geometry.
		boundarySentinel: !rawUnits && (opts.boundarySentinel ?? true),

		boundaryFlag: !rawUnits && (opts.boundaryFlag ?? false),

		ao: opts.ao ?? true,
		bakeShade,
		brightness: opts.brightness ?? false,

		// bakeShade replaces vNormal as well.
		normal: !bakeShade && (opts.normal ?? true),
	};

	/*
	 * Dependency analysis
	 * -------------------
	 * Camera vector:
	 *   fog                 -> distance + view direction Y
	 *   viewDir             -> normalized world-space view direction
	 *   tangentSpaceLighting -> tangent-space view direction
	 */
	const needsCameraVector = o.fog || o.viewDir || o.tangentSpaceLighting;

	/*
	 * worldPos is required either as an output or as the source of the
	 * camera vector.
	 */
	const needsWorldPosition = o.worldPosition || needsCameraVector;

	/*
	 * sharedNormal is consumed by: the vNormal varying, the exported tangent
	 * frame, tangent-space lighting, the hoisted N·L, and (packed only) the
	 * general bakeShade face shading. rawUnits + bakeShade derives diffuse and
	 * face shading directly from axis/isBackFace.
	 */
	const needsNormal =
		o.normal ||
		o.tangent ||
		o.tangentSpaceLighting ||
		o.vertexDiffuse ||
		(o.bakeShade && !o.rawUnits);

	/*
	 * sharedTangent is only needed when it is exported or feeds tangent-space
	 * lighting. The packed diagonal position uses its own diagonalTangent.
	 */
	const needsTangent = o.tangent || o.tangentSpaceLighting;

	const needsBitangent = o.tangentSpaceLighting;

	/*
	 * Generate a static arena switch. Each generated shader therefore has a
	 * fixed number of storage buffers and no generic arena loop.
	 */
	const loadFaceBody =
		arenas === 1
			? ` return vec3<u32>(
 faceData0[i3],
 faceData0[i3 + 1u],
 faceData0[i3 + 2u]
);`
			: ` switch arena {
${Array.from(
	{ length: arenas },
	(_, i) => ` case ${i}u: {
 return vec3<u32>(
 faceData${i}[i3],
 faceData${i}[i3 + 1u],
 faceData${i}[i3 + 2u]
 );
}`,
).join("\n")}
 default: {
 return vec3<u32>(
 faceData0[i3],
 faceData0[i3 + 1u],
 faceData0[i3 + 2u]
 );
 }
}`;

	/*
	 * This block is omitted completely for pipelines that cannot contain
	 * either boundary representation. Branchless: the face axis one-hot eA
	 * selects which coordinate moves.
	 */
	const boundaryRestoreBlock =
		o.boundarySentinel || o.boundaryFlag
			? `
 let restoreBoundary =
     ${o.boundarySentinel ? "(((metaByte >> 1u) & 3u) == 3u)" : "false"} ||
     ${o.boundaryFlag ? "(((metaByte >> 5u) & 1u) != 0u)" : "false"};

 let boundaryStep = select(0.0, INV_POS, restoreBoundary);
 baseX += eA.x * boundaryStep;
 baseY += eA.y * boundaryStep;
 baseZ += eA.z * boundaryStep;
`
			: "";

	/*
	 * Decode tint only if the fragment interface consumes vTint.
	 */
	const tintDecode = o.tint ? " let tintBucket = (faceX >> 27u) & 7u;" : "";

	/*
	 * rawUnits removes:
	 *   - position scaling
	 *   - fractional position correction
	 *   - meta decoding
	 *   - diagonal flags
	 *   - raw dimension selection
	 *   - boundary restoration
	 */
	const decodeBlock = o.rawUnits
		? `
 let metaByte = 0u;
 let localChunk = faceZ >> 24u;
${tintDecode}

 let axis = axisFace >> 1u;
 let isBackFace = axisFace & 1u;
${AXIS_FRAME_WGSL}

 let faceWidth = f32(widthByte);
 let faceHeight = f32(heightByte);

 let co = chunkOffsets[offsetBase + localChunk];

 let baseX = f32(aByte) + co.x;
 let baseY = f32(bByte) + co.y;
 let baseZ = f32(cByte) + co.z;
`
		: `
 let metaByte = (faceZ >> 16u) & 0xffu;
 let localChunk = faceZ >> 24u;
${tintDecode}

 let axis = axisFace >> 1u;
 let isBackFace = axisFace & 1u;
${AXIS_FRAME_WGSL}

 let flip = metaByte & 1u;
 let diagonalEnabled = (metaByte >> 4u) & 1u;
 let diagonalVariant = (metaByte >> 5u) & 1u;
 let rawDimensions = (metaByte >> 6u) & 1u;

 let usesRawDimensions = rawDimensions != 0u;

 let faceWidth = select(
     f32(widthByte) * INV_POS,
     f32(widthByte),
     usesRawDimensions
 );

 let faceHeight = select(
     f32(heightByte) * INV_POS,
     f32(heightByte),
     usesRawDimensions
 );

 let co = chunkOffsets[offsetBase + localChunk];

 let posX =
     f32(aByte) * INV_POS -
     f32((metaByte >> 3u) & 1u) * HALF_INV_POS;

 let posZ =
     f32(cByte) * INV_POS -
     f32((metaByte >> 7u) & 1u) * HALF_INV_POS;

 var baseX = posX + co.x;
 var baseY = f32(bByte) * INV_POS + co.y;
 var baseZ = posZ + co.z;
${boundaryRestoreBlock}`;

	const normalBlock = o.rawUnits
		? buildRawUnitsNormalBlock(needsNormal, needsTangent, needsBitangent)
		: buildPackedNormalBlock(needsNormal, needsTangent, needsBitangent);

	const positionBlock = o.rawUnits
		? buildRawUnitsPositionBlock()
		: buildPackedPositionBlock();

	/*
	 * AO extraction is omitted entirely when AO is disabled. This also
	 * removes vAO from VSOut through vsOutFields().
	 */
	const aoDecode = o.ao ? " let packedAO = faceZ & 0xffu;" : "";

	const ambientOcclusionDecode = o.ao
		? `
 let ambientOcclusion =
     (packedAO >> (corner << 1u)) & 3u;
`
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

fn loadFace(
    arena : u32,
    idx : u32
) -> vec3<u32> {
    let i3 = idx * 3u;
${loadFaceBody}
}

${fogWGSL(o.fog)}

const DIAGONAL : f32 = 0.70710678;
const INV_POS : f32 = 0.125;
const HALF_INV_POS : f32 = 0.0625;
const INV_LIGHT : f32 = 0.0666666667;

// Corner permutation, 2 bits per entry, index = cornerState * 4 + vertex
// (16 entries). Replaces the CORNER_LUT const array.
const CORNER_PACK : u32 = 0xB1C693E4u;

// Atlas (u | v << 1) per face corner, see ATLAS_DECODE. Replaces
// ATLAS_CORNER_LUT.
const ATLAS_PACK_LO : u32 = 0xD2782D78u;
const ATLAS_PACK_HI : u32 = 0x0000B4E1u;

fn axisVec(a : u32) -> vec3<f32> {
    return vec3<f32>(f32(a == 0u), f32(a == 1u), f32(a == 2u));
}

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

    let face = loadFace(
        arena,
        faceBase + instanceIndex
    );

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

    let skyLight =
        f32((lightByte >> 4u) & 0x0fu) *
        INV_LIGHT;

    let blockLight =
        f32(lightByte & 0x0fu) *
        INV_LIGHT;

${normalBlock}

    let corner =
        (CORNER_PACK >> (((cornerState << 2u) | (vertexIndex & 3u)) << 1u)) & 3u;

    let cuF = f32(((corner + 1u) >> 1u) & 1u);
    let cvF = f32(corner >> 1u);

    var position : vec3<f32>;
    var faceU : f32;
    var faceV : f32;

${positionBlock}

    let localPosition =
        vec4<f32>(position, 1.0);

    out.pos =
        shaderSystem.worldViewProjection *
        localPosition;

${worldBlock}
${ambientOcclusionDecode}

${vsOutAssignments(o)}

    return out;
}
`;
}
