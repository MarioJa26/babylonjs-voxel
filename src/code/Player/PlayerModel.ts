import {
	createMeshFromData,
	createShaderMaterial,
	createSolidTexture2D,
	type EngineContext,
	loadTexture2D,
	type Mesh,
	type ShaderMaterial,
	setShaderTexture,
	setShaderUniform,
	type Texture2D,
} from "@babylonjs/lite";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";

// Rig metrics (must precede the WGSL template, which bakes them in).
export const PLAYER_MODEL_HEIGHT = 1.8;
const PX = PLAYER_MODEL_HEIGHT / 32; // meters per skin pixel (rig is 32px tall)

/** Limb ids baked into normal.x for the animation shader. */
const PART_STATIC = 0;
const PART_ARM_L = 1;
const PART_ARM_R = 2;
const PART_LEG_L = 3;
const PART_LEG_R = 4;
const PART_HEAD = 5;

// ─── Rig shader sources (unlit textured, brightness uniform) ────────────────
// Mirrors the proven DroppedItem shader so no scene lights or
// StandardMaterial state can interfere with how the model looks.

// Limb animation is driven by a PART ID stored in the normal attribute
// (normal.x = id, see appendBox). The unlit fragment shader never reads
// normals, so the slot is free — tagging at build time gives exact limb
// membership with none of the coplanar-boundary ambiguity of classifying by
// position (arm bottoms / leg tops / torso underside all share y-planes).
// IDs: 0 static · 1 arm-left · 2 arm-right · 3 leg-left · 4 leg-right ·
// 5 head (pitches with the camera around the neck line).
const RIG_VERTEX_WGSL = /* wgsl */ `
struct VSOut {
	@builtin(position) pos : vec4<f32>,
	@location(0) vUV : vec2<f32>,
	@location(1) vNormal : vec3<f32>,
	@location(2) vWorldPos : vec3<f32>,
};

const ARM_PIVOT_Y : f32 = ${(8 * PX).toFixed(6)};
const HIP_PIVOT_Y : f32 = ${(-(4 * PX)).toFixed(6)};
const SWING_MAX : f32 = 0.75;

fn animateRig(p : vec3<f32>, part : f32) -> vec3<f32> {
	if (shaderUniforms.uWalkAmp <= 0.0 && shaderUniforms.uHeadPitch == 0.0) {
		return p;
	}
	let osc = sin(shaderUniforms.uWalkPhase)
		* SWING_MAX
		* shaderUniforms.uWalkAmp;
	var pivotY : f32;
	var ang : f32;
	if (part < 0.5) {
		return p;
	} else if (part < 2.5) {
		// arms: right swings opposite to left
		pivotY = ARM_PIVOT_Y;
		ang = osc * select(-1.0, 1.0, part > 1.5) * -1.0;
	} else if (part < 4.5) {
		// legs: right in phase with left arm
		pivotY = HIP_PIVOT_Y;
		ang = osc * select(-1.0, 1.0, part > 3.5);
	} else {
		// head pitches with the camera about the neck line
		pivotY = ARM_PIVOT_Y;
		ang = shaderUniforms.uHeadPitch;
	}
	let s = sin(ang);
	let c = cos(ang);
	let cy = p.y - pivotY;
	return vec3<f32>(p.x, pivotY + cy * c - p.z * s, cy * s + p.z * c);
}

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
	var out : VSOut;
	let animated = animateRig(input.position, input.normal.x);
	let worldPos = shaderSystem.world * vec4<f32>(animated, 1.0);
	out.pos = shaderSystem.worldViewProjection * vec4<f32>(animated, 1.0);
	out.vUV = input.uv;
	out.vNormal = input.normal;
	out.vWorldPos = worldPos.xyz;
	return out;
}
`;

const RIG_FRAGMENT_WGSL = /* wgsl */ `
struct VSOut {
	@builtin(position) pos : vec4<f32>,
	@location(0) vUV : vec2<f32>,
	@location(1) vNormal : vec3<f32>,
	@location(2) vWorldPos : vec3<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
	let tex = textureSample(diffuseTexture, diffuseTextureSampler, in.vUV);
	return vec4<f32>(tex.rgb * shaderUniforms.uLightColor, 1.0);
}
`;

/**
 * Minecraft-style player rig (head/torso/arms/legs) built from textured boxes
 * and skinned by a 64x64 Minecraft-layout texture. Shared between the
 * inventory preview and the in-world third-person player body.
 */

export const PLAYER_SKIN_PATH = "/texture/player/skin.png";

/**
 * Vertical offset (meters) from the mid-body controller origin where rig
 * lighting samples voxel light. Chest height — below the head, so ceiling
 * contact while jumping never reads inside-block darkness.
 */
export const PLAYER_LIGHT_SAMPLE_Y_OFFSET = 0.5;

// ─── Skin atlas layout (64x64 classic base layer, pixel coords) ─────────────

type UvRect = readonly [number, number, number, number];

interface UvSet {
	front: UvRect;
	back: UvRect;
	right: UvRect;
	left: UvRect;
	top: UvRect;
	bottom: UvRect;
}

const HEAD_UV: UvSet = {
	top: [8, 0, 16, 8],
	bottom: [16, 0, 24, 8],
	right: [0, 8, 8, 16],
	front: [8, 8, 16, 16],
	left: [16, 8, 24, 16],
	back: [24, 8, 32, 16],
};

const BODY_UV: UvSet = {
	top: [20, 16, 28, 20],
	bottom: [28, 16, 36, 20],
	right: [16, 20, 20, 32],
	front: [20, 20, 28, 32],
	left: [28, 20, 32, 32],
	back: [32, 20, 40, 32],
};

const limbUv = (ox: number, oy: number): UvSet => ({
	top: [ox + 4, oy, ox + 8, oy + 4],
	bottom: [ox + 8, oy, ox + 12, oy + 4],
	right: [ox, oy + 4, ox + 4, oy + 16],
	front: [ox + 4, oy + 4, ox + 8, oy + 16],
	left: [ox + 8, oy + 4, ox + 12, oy + 16],
	back: [ox + 12, oy + 4, ox + 16, oy + 16],
});

// Compact sheet: left limbs sit directly below their right counterparts
// (y32-48 band) instead of Minecraft's default bottom row (y48-64).
const ARM_L_UV = limbUv(40, 32);
const ARM_R_UV = limbUv(40, 16);
const LEG_L_UV = limbUv(0, 32);
const LEG_R_UV = limbUv(0, 16);

// ─── Box builder (winding matches DroppedItem.getUnitCubeGeometry) ──────────

interface BoxPart {
	x: number;
	y: number;
	z: number;
	w: number;
	h: number;
	d: number;
	uv?: UvSet;
	/** Limb tag baked into normal.x (see the WGSL header comment). */
	partId?: number;
}

interface MeshData {
	positions: Float32Array;
	normals: Float32Array;
	indices: Uint32Array;
	uvs?: Float32Array;
}

function appendBox(
	out: MeshBuffers,
	p: BoxPart,
	uvMode: "skin" | "atlas" = "skin",
): void {
	const x0 = p.x - p.w * 0.5;
	const x1 = p.x + p.w * 0.5;
	const y0 = p.y - p.h * 0.5;
	const y1 = p.y + p.h * 0.5;
	const z0 = p.z - p.d * 0.5;
	const z1 = p.z + p.d * 0.5;

	const partId = p.partId ?? PART_STATIC;
	const positions = out.positions;
	const normals = out.normals;
	const indices = out.indices;
	const uvs = out.uvs;
	const uv = p.uv;

	let vertexBase = positions.length / 3;

	const appendFace = (
		rect: UvRect | undefined,
		ax: number,
		ay: number,
		az: number,
		bx: number,
		by: number,
		bz: number,
		cx: number,
		cy: number,
		cz: number,
		dx: number,
		dy: number,
		dz: number,
	): void => {
		positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);

		normals.push(partId, 0, 0, partId, 0, 0, partId, 0, 0, partId, 0, 0);

		if (rect) {
			const u0 = uvMode === "atlas" ? rect[0] : rect[0] * (1 / 64);
			const u1 = uvMode === "atlas" ? rect[2] : rect[2] * (1 / 64);

			const vBottom = uvMode === "atlas" ? rect[1] : 1 - rect[3] * (1 / 64);
			const vTop = uvMode === "atlas" ? rect[3] : 1 - rect[1] * (1 / 64);

			// Vertex order: bottom-left, bottom-right, top-right, top-left.
			uvs.push(u0, vBottom, u1, vBottom, u1, vTop, u0, vTop);
		}

		indices.push(
			vertexBase,
			vertexBase + 2,
			vertexBase + 1,
			vertexBase,
			vertexBase + 3,
			vertexBase + 2,
		);

		vertexBase += 4;
	};

	// +X face, skin "left"
	appendFace(uv?.left, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1);

	// -X face, skin "right"
	appendFace(uv?.right, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0);

	// +Y face
	appendFace(uv?.top, x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0);

	// -Y face
	appendFace(uv?.bottom, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);

	// +Z face
	appendFace(uv?.front, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);

	// -Z face
	appendFace(uv?.back, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0);
}

interface MeshBuffers {
	positions: number[];
	normals: number[];
	indices: number[];
	uvs: number[];
}

function toData(out: MeshBuffers): MeshData {
	return {
		positions: new Float32Array(out.positions),
		normals: new Float32Array(out.normals),
		indices: new Uint32Array(out.indices),
		uvs: new Float32Array(out.uvs),
	};
}

/** Merged rig mesh data — origin at the feet, +Z is the facing direction. */
export function buildPlayerRigData(origin: RigOrigin = "feet"): MeshData {
	const out: MeshBuffers = { positions: [], normals: [], indices: [], uvs: [] };

	// World bodies anchor at the character controller's position, which sits
	// mid-body (the old capsule was center-origin); shift accordingly.
	const yOffset = origin === "center" ? -PLAYER_MODEL_HEIGHT / 2 : -0.1;

	const parts: BoxPart[] = [
		{
			x: 0,
			y: 28 * PX,
			z: 0,
			w: 8 * PX,
			h: 8 * PX,
			d: 8 * PX,
			uv: HEAD_UV,
			partId: PART_HEAD,
		},
		{
			x: 0,
			y: 18 * PX,
			z: 0,
			w: 8 * PX,
			h: 12 * PX,
			d: 4 * PX,
			uv: BODY_UV,
		},
		{
			x: -6 * PX,
			y: 18 * PX,
			z: 0,
			w: 4 * PX,
			h: 12 * PX,
			d: 4 * PX,
			uv: ARM_L_UV,
			partId: PART_ARM_L,
		},
		{
			x: 6 * PX,
			y: 18 * PX,
			z: 0,
			w: 4 * PX,
			h: 12 * PX,
			d: 4 * PX,
			uv: ARM_R_UV,
			partId: PART_ARM_R,
		},
		{
			x: -2 * PX,
			y: 6 * PX,
			z: 0,
			w: 4 * PX,
			h: 12 * PX,
			d: 4 * PX,
			uv: LEG_L_UV,
			partId: PART_LEG_L,
		},
		{
			x: 2 * PX,
			y: 6 * PX,
			z: 0,
			w: 4 * PX,
			h: 12 * PX,
			d: 4 * PX,
			uv: LEG_R_UV,
			partId: PART_LEG_R,
		},
	];
	for (const part of parts) appendBox(out, { ...part, y: part.y + yOffset });

	return toData(out);
}

/**
 * Thin reference slab used under the preview model.
 *
 * `atlasRect` = FINAL normalized atlas coords [u0, vLow, u1, vHigh] (computed
 * with the same tile math as DroppedItem), so the slab samples exactly one
 * block tile — pixel-identical to how the world renders that block.
 */
export function buildFloorSlabData(
	width = 1.0,
	atlasRect?: readonly [number, number, number, number],
): MeshData {
	const out: MeshBuffers = { positions: [], normals: [], indices: [], uvs: [] };
	const uv: UvSet | undefined = atlasRect
		? {
				front: atlasRect,
				back: atlasRect,
				right: atlasRect,
				left: atlasRect,
				top: atlasRect,
				bottom: atlasRect,
			}
		: undefined;
	appendBox(
		out,
		{ x: 0, y: -0.6, z: 0, w: width, h: 1.0, d: width, uv },
		atlasRect ? "atlas" : "skin",
	);
	return toData(out);
}

// ─── Factories ──────────────────────────────────────────────────────────────

export type RigOrigin = "feet" | "center";

export function createPlayerRigMesh(
	engine: EngineContext,
	name: string,
	origin: RigOrigin = "feet",
): Mesh {
	const data = buildPlayerRigData(origin);
	return createMeshFromData(
		engine,
		name,
		data.positions,
		data.normals,
		data.indices,
		data.uvs,
	);
}

const skinCache = new WeakMap<EngineContext, Promise<Texture2D>>();

const fallbackTextureCache = new WeakMap<EngineContext, Texture2D>();

function getFallbackTexture(engine: EngineContext): Texture2D {
	let tex = fallbackTextureCache.get(engine);
	if (!tex) {
		tex = createSolidTexture2D(engine, 255, 255, 255, 255);
		fallbackTextureCache.set(engine, tex);
	}
	return tex;
}

/** Shared opaque-white placeholder for rig materials (see applyRigSkin). */
export function getRigFallbackTexture(engine: EngineContext): Texture2D {
	return getFallbackTexture(engine);
}

export function loadPlayerSkin(engine: EngineContext): Promise<Texture2D> {
	let promise = skinCache.get(engine);
	if (!promise) {
		promise = loadTexture2D(engine, PLAYER_SKIN_PATH, {
			magFilter: "nearest",
			minFilter: "nearest",
		});
		skinCache.set(engine, promise);
		promise.catch(() => {}); // callers handle failures; keep console clean
	}
	return promise;
}

/**
 * Bind a skin texture to a rig ShaderMaterial and initialize the light-color
 * uniform to neutral white. Mirrors DroppedItem: the mesh must stay HIDDEN
 * until the texture is bound (onBind), because drawing with an unbound sampler
 * invalidates the pass.
 *
 * An opaque-white placeholder is bound SYNCHRONOUSLY first: lite builds a
 * ShaderMaterial's bind group as soon as its renderable is constructed (scene
 * registration / material swap), and throws error #241 if any declared sampler
 * has no Texture2D — even when the mesh is invisible.
 *
 * `loadSkin` overrides where the skin comes from — remote players pass their
 * server-synced skin loader here instead of the default local PNG fetch.
 */
export function applyRigSkin(
	engine: EngineContext,
	mat: ShaderMaterial,
	onBind?: () => void,
	isAlive: () => boolean = () => true,
	loadSkin: (engine: EngineContext) => Promise<Texture2D> = loadPlayerSkin,
): void {
	setShaderUniform(mat, "uLightColor", [1, 1, 1]);
	setShaderUniform(mat, "uWalkPhase", 0);
	setShaderUniform(mat, "uWalkAmp", 0);
	setShaderUniform(mat, "uHeadPitch", 0);
	setShaderTexture(mat, "diffuseTexture", getFallbackTexture(engine));
	loadSkin(engine)
		.then((tex) => {
			if (!isAlive()) return;
			setShaderTexture(mat, "diffuseTexture", tex);
			onBind?.();
		})
		.catch(() => {
			if (!isAlive()) return;
			onBind?.();
		});
}

/**
 * Convert packed voxel light (sky << 4 | block) into an RGB light color,
 * mirroring the terrain shaders' mix: neutral skylight scaled by the
 * sun-elevation day factor plus a warm torch tint, with an ambient floor.
 */
export function packedLightToLightColor(
	packed: number,
): readonly [number, number, number] {
	const sky = ((packed >> 4) & 0xf) / 15;
	const block = (packed & 0xf) / 15;
	const sunElevation = -GLOBAL_VALUES.skyLightDirection.y + 0.1;
	const sunIntensity = Math.min(1, Math.max(0, sunElevation * 4));
	// Same mix as OpaqueShaderLite/Lod2/Lod3 fragment stages.
	const skyScale = sky * 0.8 * (sunIntensity + 0.2);
	const channel = (torch: number): number =>
		Math.min(1, Math.max(0.2, skyScale + block * torch));
	return [channel(0.9), channel(0.6), channel(0.2)];
}

/**
 * Unlit textured ShaderMaterial for rigs: samples the skin texture and
 * multiplies by a uLightColor RGB uniform — fully bypassing scene lights and
 * StandardMaterial state.
 */
export function createRigShaderMaterial(name: string): ShaderMaterial {
	return createShaderMaterial({
		name,
		vertexSource: RIG_VERTEX_WGSL,
		fragmentSource: RIG_FRAGMENT_WGSL,
		attributes: ["position", "normal", "uv"],
		uniforms: [
			"world",
			"worldViewProjection",
			{ name: "uLightColor", type: "vec3<f32>" },
			{ name: "uWalkPhase", type: "f32" },
			{ name: "uWalkAmp", type: "f32" },
			{ name: "uHeadPitch", type: "f32" },
		],
		samplers: ["diffuseTexture"],
		backFaceCulling: false,
	});
}

export function bindRigTexture(mat: ShaderMaterial, tex: Texture2D): void {
	setShaderTexture(mat, "diffuseTexture", tex);
}

export function setRigLightColor(
	mat: ShaderMaterial,
	color: readonly [number, number, number],
): void {
	setShaderUniform(mat, "uLightColor", [color[0], color[1], color[2]]);
}

/** Radians of walk-stride phase accumulated per meter traveled. */
export const WALK_STRIDE_FACTOR = 1.8;

/** Horizontal speed (m/s) at which the swing reaches full amplitude. */
export const WALK_REF_SPEED = 3;

/** Drive the rig's walk-swing (amp 0 = rest pose, 1 = full stride). */
export function setRigWalk(
	mat: ShaderMaterial,
	phase: number,
	amp: number,
): void {
	setShaderUniform(mat, "uWalkPhase", phase);
	setShaderUniform(mat, "uWalkAmp", Math.max(0, Math.min(1, amp)));
}

/** Head pitch clamp (±~69°) so extreme look angles stay readable. */
export const HEAD_PITCH_LIMIT = 1.2;

/**
 * Tilt the head part with the camera. Positive = looking down (the camera
 * convention: cameraPitch is positive when looking down, and +ang tips the
 * face's +Z front downward).
 */
export function setRigHeadPitch(mat: ShaderMaterial, pitch: number): void {
	setShaderUniform(
		mat,
		"uHeadPitch",
		Math.max(-HEAD_PITCH_LIMIT, Math.min(HEAD_PITCH_LIMIT, pitch)),
	);
}
