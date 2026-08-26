import {
	createMeshFromData,
	createShaderMaterial,
	type Mesh,
	type ShaderMaterial,
	setShaderUniform,
} from "@babylonjs/lite";
import type { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import { MOB_SKIN_SIZE, type MobUvSet } from "./MobSkin";

const MOB_VERTEX_WGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vNormal : vec3<f32>,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  out.pos = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.vNormal = input.normal;
  return out;
}
`;

const MOB_FRAGMENT_WGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vNormal : vec3<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let n = normalize(in.vNormal);
  let light = clamp(0.45 + 0.55 * n.y, 0.0, 1.0);
  return vec4<f32>(shaderUniforms.tintColor * light, 1.0);
}
`;

// Dedicated mob skin (/texture/mobs/skin.png, 128x128) — Minecraft-style
// per-face UV layout, defined in MobSkin.ts. UVs are baked CPU-side into
// final texture space with a half-texel inset so mips never bleed.

/**
 * Walk-swing shader sources for mob legs. Mirrors the player rig's approach
 * (PlayerModel.animateRig): each vertex carries a limb id in normal.x, and the
 * vertex shader rotates leg vertices about the hip pivot by
 * sin(uWalkPhase) * SWING_MAX * uWalkAmp. The per-instance walk phase is
 * passed through the instance-color alpha channel (written by
 * MobInstancePool.writeWalkPhase); uWalkAmp is a per-material uniform so a
 * whole species shares the same stride amplitude.
 *
 * The rotation pivots about the X axis (swings the leg forward/back in Z) at
 * HIP_PIVOT_Y — the Y line where the legs meet the body.
 */
const MOB_LEG_VERTEX_WGSL = /* wgsl */ `
const SWING_MAX : f32 = 0.85;

fn animateMobLegs(p : vec3<f32>, partId : f32, walkPhase : f32) -> vec3<f32> {
  // partId 0 = static, 3 = leg-left, 4 = leg-right. Only leg parts swing.
  if (partId < 2.5 || partId > 4.5) {
    return p;
  }
  let amp = shaderUniforms.uWalkAmp;
  if (amp <= 0.0) {
    return p;
  }
  let osc = sin(walkPhase) * SWING_MAX * amp;
  // Right leg (id 4) in phase with left arm; left leg (id 3) opposite.
  let ang = osc * select(-1.0, 1.0, partId > 3.5);
  let s = sin(ang);
  let c = cos(ang);
  let cy = p.y - shaderUniforms.uHipPivotY;
  return vec3<f32>(p.x, shaderUniforms.uHipPivotY + cy * c - p.z * s, cy * s + p.z * c);
}
`;

function makeInstancedMobAtlasVertexWgsl(useInstanceColor: boolean): string {
	const tintExpr = useInstanceColor
		? "input.instanceColor.rgb"
		: "shaderUniforms.tintColor";

	return /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vTint : vec3<f32>,
  @location(2) vNormal : vec3<f32>,
};

${MOB_LEG_VERTEX_WGSL}

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  let instanceWorld = mat4x4<f32>(
    input.world0, input.world1, input.world2, input.world3
  );
  // Per-vertex limb tag arrives via the color attribute's R channel.
  let partId = input.color.r;
  // Per-instance walk phase arrives via the instance-color alpha channel.
  let walkPhase = ${useInstanceColor ? "input.instanceColor.a" : "0.0"};
  let animated = animateMobLegs(input.position, partId, walkPhase);
  out.pos = shaderSystem.viewProjection *
    (instanceWorld * vec4<f32>(animated, 1.0));
  out.vUV = input.uv;
  out.vTint = ${tintExpr};
  out.vNormal = (instanceWorld * vec4<f32>(input.normal, 0.0)).xyz;
  return out;
}
`;
}

function makeInstancedMobAtlasFragmentWgsl(): string {
	return /* wgsl */ `
struct FSIn {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vTint : vec3<f32>,
  @location(2) vNormal : vec3<f32>,
};

@fragment
fn mainFragment(in : FSIn) -> @location(0) vec4<f32> {
  let tex = textureSample(diffuseTexture, diffuseTextureSampler, in.vUV);

  if (tex.a < 0.5) {
    discard;
  }

  let n = normalize(in.vNormal);
  let light = clamp(0.45 + 0.55 * n.y, 0.0, 1.0);
  return vec4<f32>(tex.rgb * in.vTint * light, 1.0);
}
`;
}

const BOX_INDICES = new Uint32Array([
	0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 12, 13, 14, 12, 14,
	15, 16, 17, 18, 16, 18, 19, 20, 21, 22, 20, 22, 23,
]);

const BOX_NORMALS = new Float32Array([
	// +X
	1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
	// -X
	-1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
	// +Y
	0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
	// -Y
	0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
	// +Z
	0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
	// -Z
	0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
]);

type BoxGeometry = {
	positions: Float32Array;
	normals: Float32Array;
	indices: Uint32Array;
};

const boxGeometryCache = new Map<string, BoxGeometry>();
const materialCache = new Map<string, ShaderMaterial>();

function boxGeometryKey(width: number, height: number, depth: number): string {
	return `${width},${height},${depth}`;
}

function colorMaterialKey(name: string, color: Color3): string {
	return `${name}:${color.r},${color.g},${color.b}`;
}

export function createMobColorMaterial(
	color: Color3,
	name: string,
): ShaderMaterial {
	const material = createShaderMaterial({
		name,
		vertexSource: MOB_VERTEX_WGSL,
		fragmentSource: MOB_FRAGMENT_WGSL,
		attributes: ["position", "normal"],
		uniforms: [
			"world",
			"worldViewProjection",
			{ name: "tintColor", type: "vec3<f32>" },
		],
		backFaceCulling: true,
	});

	setShaderUniform(material, "tintColor", [color.r, color.g, color.b]);

	return material;
}

export function getMobColorMaterial(
	color: Color3,
	name: string,
): ShaderMaterial {
	const key = colorMaterialKey(name, color);
	let material = materialCache.get(key);

	if (!material) {
		material = createMobColorMaterial(color, name);
		materialCache.set(key, material);
	}

	return material;
}

/**
 * ShaderMaterial for a thin-instanced mob mesh textured from the shared block
 * atlas. Each vertex picks its atlas tile via `color.a` (layer = BlockType id),
 * so one draw call can mix tiles across a whole animal model. With
 * `instanceColors` the tint comes from the per-instance color buffer
 * (requires `ti.colors` seeded on every mesh using this material); otherwise a
 * fixed uniform tint is used.
 */
export function createInstancedMobAtlasMaterial(
	name: string,
	instanceColors: boolean,
	tint: Color3,
	/**
	 * Y coordinate (mob-local space) of the hip pivot line — where legs meet
	 * the body. Leg vertices rotate about this X axis line during walking.
	 */
	hipPivotY: number,
	/** Walk-stride amplitude 0–1 (1 = full SWING_MAX swing). */
	walkAmp: number,
): ShaderMaterial {
	const material = createShaderMaterial({
		name,
		vertexSource: makeInstancedMobAtlasVertexWgsl(instanceColors),
		fragmentSource: makeInstancedMobAtlasFragmentWgsl(),
		attributes: ["position", "normal", "uv", "color"],
		uniforms: [
			"viewProjection",
			{ name: "uHipPivotY", type: "f32" },
			{ name: "uWalkAmp", type: "f32" },
			...(instanceColors
				? []
				: [{ name: "tintColor", type: "vec3<f32>" } as const]),
		],
		samplers: ["diffuseTexture"],
		useThinInstanceColors: instanceColors,
		backFaceCulling: true,
	});

	setShaderUniform(material, "uHipPivotY", hipPivotY);
	setShaderUniform(material, "uWalkAmp", walkAmp);

	if (!instanceColors) {
		setShaderUniform(material, "tintColor", [tint.r, tint.g, tint.b]);
	}

	return material;
}

export function buildBoxGeometry(
	width: number,
	height: number,
	depth: number,
): BoxGeometry {
	const hx = width * 0.5;
	const hy = height * 0.5;
	const hz = depth * 0.5;

	const positions = new Float32Array(72);

	// +X
	positions[0] = hx;
	positions[1] = -hy;
	positions[2] = -hz;
	positions[3] = hx;
	positions[4] = -hy;
	positions[5] = hz;
	positions[6] = hx;
	positions[7] = hy;
	positions[8] = hz;
	positions[9] = hx;
	positions[10] = hy;
	positions[11] = -hz;

	// -X
	positions[12] = -hx;
	positions[13] = -hy;
	positions[14] = hz;
	positions[15] = -hx;
	positions[16] = -hy;
	positions[17] = -hz;
	positions[18] = -hx;
	positions[19] = hy;
	positions[20] = -hz;
	positions[21] = -hx;
	positions[22] = hy;
	positions[23] = hz;

	// +Y
	positions[24] = -hx;
	positions[25] = hy;
	positions[26] = -hz;
	positions[27] = hx;
	positions[28] = hy;
	positions[29] = -hz;
	positions[30] = hx;
	positions[31] = hy;
	positions[32] = hz;
	positions[33] = -hx;
	positions[34] = hy;
	positions[35] = hz;

	// -Y
	positions[36] = -hx;
	positions[37] = -hy;
	positions[38] = hz;
	positions[39] = hx;
	positions[40] = -hy;
	positions[41] = hz;
	positions[42] = hx;
	positions[43] = -hy;
	positions[44] = -hz;
	positions[45] = -hx;
	positions[46] = -hy;
	positions[47] = -hz;

	// +Z
	positions[48] = -hx;
	positions[49] = -hy;
	positions[50] = hz;
	positions[51] = -hx;
	positions[52] = hy;
	positions[53] = hz;
	positions[54] = hx;
	positions[55] = hy;
	positions[56] = hz;
	positions[57] = hx;
	positions[58] = -hy;
	positions[59] = hz;

	// -Z
	positions[60] = hx;
	positions[61] = -hy;
	positions[62] = -hz;
	positions[63] = hx;
	positions[64] = hy;
	positions[65] = -hz;
	positions[66] = -hx;
	positions[67] = hy;
	positions[68] = -hz;
	positions[69] = -hx;
	positions[70] = -hy;
	positions[71] = -hz;

	return {
		positions,
		normals: BOX_NORMALS,
		indices: BOX_INDICES,
	};
}

export function getBoxGeometry(
	width: number,
	height: number,
	depth: number,
): BoxGeometry {
	const key = boxGeometryKey(width, height, depth);
	let geometry = boxGeometryCache.get(key);

	if (!geometry) {
		geometry = buildBoxGeometry(width, height, depth);
		boxGeometryCache.set(key, geometry);
	}

	return geometry;
}

export function createBoxMobMesh(
	name: string,
	width: number,
	height: number,
	depth: number,
	color: Color3,
	materialName: string,
): Mesh {
	const geometry = getBoxGeometry(width, height, depth);

	const mesh = createMeshFromData(
		Map1.engine,
		name,
		geometry.positions,
		geometry.normals,
		geometry.indices,
	);

	mesh.pickable = true;
	mesh.renderOrder = 1;
	mesh.material = getMobColorMaterial(color, materialName);

	return mesh;
}

// ─── Multi-part mob models ──────────────────────────────────────────────────

/** One box of an animal model, centered at (x, y, z) in mob-local space. */
export type MobPartSpec = {
	width: number;
	height: number;
	depth: number;
	x: number;
	y: number;
	z: number;
	/** Per-face skin rects (Minecraft-style unwrap — see MobSkin.ts). */
	uv: MobUvSet;
	/**
	 * Limb tag baked into normal.x at build time (same trick as PlayerModel:
	 * the fragment shader only reads n.y for lighting, so normal.x is free).
	 * 0 = static · 3 = leg-left · 4 = leg-right. Parts with no tag are static.
	 */
	partId?: number;
};

export type MobModelGeometry = {
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	/**
	 * Per-vertex limb tag (partId) packed into the R channel of a vec4 color
	 * attribute. The fragment shader never reads this channel, and normal.x
	 * stays the real normal so lighting is unaffected.
	 */
	colors: Float32Array;
	indices: Uint32Array;
};

// Faces copied VERBATIM from DroppedItem.getUnitCubeGeometry (the proven
// loadTexture2D convention): vertex order bottom-left, bottom-right,
// top-right, top-left per face; matching index winding below. `rect` is the
// MobUvSet field each face samples (PlayerModel convention: +X = skin left,
// -X = skin right).
const UNIT_FACES: {
	normal: [number, number, number];
	verts: [number, number, number][];
	rect: keyof MobUvSet;
}[] = [
	{
		normal: [1, 0, 0],
		rect: "left",
		verts: [
			[0.5, -0.5, 0.5],
			[0.5, -0.5, -0.5],
			[0.5, 0.5, -0.5],
			[0.5, 0.5, 0.5],
		],
	},
	{
		normal: [-1, 0, 0],
		rect: "right",
		verts: [
			[-0.5, -0.5, -0.5],
			[-0.5, -0.5, 0.5],
			[-0.5, 0.5, 0.5],
			[-0.5, 0.5, -0.5],
		],
	},
	{
		normal: [0, 1, 0],
		rect: "top",
		verts: [
			[-0.5, 0.5, 0.5],
			[0.5, 0.5, 0.5],
			[0.5, 0.5, -0.5],
			[-0.5, 0.5, -0.5],
		],
	},
	{
		normal: [0, -1, 0],
		rect: "bottom",
		verts: [
			[-0.5, -0.5, -0.5],
			[0.5, -0.5, -0.5],
			[0.5, -0.5, 0.5],
			[-0.5, -0.5, 0.5],
		],
	},
	{
		normal: [0, 0, 1],
		rect: "front",
		verts: [
			[-0.5, -0.5, 0.5],
			[0.5, -0.5, 0.5],
			[0.5, 0.5, 0.5],
			[-0.5, 0.5, 0.5],
		],
	},
	{
		normal: [0, 0, -1],
		rect: "back",
		verts: [
			[0.5, -0.5, -0.5],
			[-0.5, -0.5, -0.5],
			[-0.5, 0.5, -0.5],
			[0.5, 0.5, -0.5],
		],
	},
];

/**
 * Concatenate axis-aligned boxes into one geometry so an entire animal model
 * (body + head + legs + wings) renders as a single thin-instanced draw call.
 * Each face maps to its own rect in the mob skin PNG (Minecraft-style unwrap,
 * see MobSkin.ts) — same CPU-side-UV philosophy as PlayerModel's box builder.
 */
export function buildMobModelGeometry(
	parts: readonly MobPartSpec[],
): MobModelGeometry {
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const colors: number[] = [];
	const indices: number[] = [];

	const size = MOB_SKIN_SIZE;
	// Half-texel inset so mip bleeding never crosses face borders.
	const inset = 0.5;

	for (const part of parts) {
		// Limb tag packed into the R channel of the color attribute. Normals
		// stay untouched so lighting is correct on every face.
		const partId = part.partId ?? 0;

		for (const face of UNIT_FACES) {
			const rect = part.uv[face.rect];
			const u0 = (rect[0] + inset) / size;
			const u1 = (rect[2] - inset) / size;
			const vBottom = 1 - (rect[3] - inset) / size;
			const vTop = 1 - (rect[1] + inset) / size;

			for (let i = 0; i < 4; i++) {
				const v = face.verts[i];
				positions.push(
					v[0] * part.width + part.x,
					v[1] * part.height + part.y,
					v[2] * part.depth + part.z,
				);
				normals.push(face.normal[0], face.normal[1], face.normal[2]);

				// R = partId (limb tag); GBA unused.
				colors.push(partId, 0, 0, 0);

				// Corner order: bottom-left, bottom-right, top-right, top-left.
				uvs.push(
					i === 0 || i === 3 ? u0 : u1,
					i === 0 || i === 1 ? vBottom : vTop,
				);
			}

			const b = positions.length / 3 - 4;
			indices.push(b, b + 2, b + 1, b, b + 3, b + 2);
		}
	}

	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		uvs: new Float32Array(uvs),
		colors: new Float32Array(colors),
		indices: new Uint32Array(indices),
	};
}
