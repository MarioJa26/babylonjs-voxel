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

// Rig metrics (must precede any constants derived from them).
export const PLAYER_MODEL_HEIGHT = 1.8;
const PX = PLAYER_MODEL_HEIGHT / 32; // meters per skin pixel (rig is 32px tall)

/** Part ids stored in normal.x for the animation shader. */
const PART_STATIC = 0;
const PART_ARM_L = 1;
const PART_ARM_R = 2;
const PART_LEG_L = 3;
const PART_LEG_R = 4;
const PART_HEAD = 5;

// Model-space pivot lines (feet-origin convention; the origin offset is added
// at build time, so baked pivots are correct for BOTH "feet" and "center").
const SHOULDER_PIVOT_Y = 24 * PX; // arm tops / neck line
const HIP_PIVOT_Y = 12 * PX; // leg tops

/** Max limb swing angle (radians) at amp 1. Applied CPU-side. */
const SWING_MAX = 0.75;

// ─── Rig shader sources (unlit textured, brightness uniform) ────────────────
// Mirrors the proven DroppedItem shader so no scene lights or
// StandardMaterial state can interfere with how the model looks.
//
// All per-frame animation math runs on the CPU: every player-material writes
// ONE vec4 uniform (uAnim) holding precomputed sin/cos pairs — no trig and no
// per-part select chains in the vertex shader, and idle players write nothing
// at all (callers can hammer setRigWalk/setRigHeadPitch; unchanged values are
// dropped before they reach the material).
//
// uAnim layout: [sin(swing), sin(headPitch), cos(headPitch), cos(swing)].
// The cos slots are only read when their sin sibling is non-zero, so an
// all-zero (never-written) uniform buffer still renders the rest pose
// correctly through the early-outs below.
//
// Per-vertex limb metadata rides in the normal attribute (the unlit fragment
// shader never reads normals): x = part id, y = pivot Y (model space,
// origin-aware), z = swing sign (+1 arm-L/leg-R, -1 arm-R/leg-L). IDs:
// 0 static · 1 arm-left · 2 arm-right · 3 leg-left · 4 leg-right · 5 head.
const RIG_VERTEX_WGSL = /* wgsl */ `
struct VSOut {
	@builtin(position) pos : vec4<f32>,
	@location(0) vUV : vec2<f32>,
};

fn animateRig(p : vec3<f32>, tag : vec3<f32>) -> vec3<f32> {
	if (tag.x < 0.5) {
		return p; // static (torso)
	}
	var s : f32;
	var c : f32;
	if (tag.x > 4.5) {
		// head pitches with the camera about the neck line
		if (shaderUniforms.uAnim.y == 0.0) {
			return p;
		}
		s = shaderUniforms.uAnim.y;
		c = shaderUniforms.uAnim.z;
	} else {
		// arms and legs swing about their pivot, mirrored by sign
		if (shaderUniforms.uAnim.x == 0.0) {
			return p;
		}
		s = shaderUniforms.uAnim.x * tag.z;
		c = shaderUniforms.uAnim.w;
	}
	let cy = p.y - tag.y;
	return vec3<f32>(p.x, tag.y + cy * c - p.z * s, cy * s + p.z * c);
}

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
	var out : VSOut;
	let animated = animateRig(input.position, input.normal);
	out.pos = shaderSystem.worldViewProjection * vec4<f32>(animated, 1.0);
	out.vUV = input.uv;
	return out;
}
`;

const RIG_FRAGMENT_WGSL = /* wgsl */ `
struct VSOut {
	@builtin(position) pos : vec4<f32>,
	@location(0) vUV : vec2<f32>,
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

/** [partId, pivotY, swingSign] baked into every vertex normal of the box. */
type PartMeta = readonly [number, number, number];

const STATIC_META: PartMeta = [PART_STATIC, 0, 0];

interface BoxPart {
	x: number;
	y: number;
	z: number;
	w: number;
	h: number;
	d: number;
	uv?: UvSet;
	/** Animation metadata baked into normals (see the WGSL header comment). */
	meta?: PartMeta;
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

	const meta = p.meta ?? STATIC_META;
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

		normals.push(
			meta[0],
			meta[1],
			meta[2],
			meta[0],
			meta[1],
			meta[2],
			meta[0],
			meta[1],
			meta[2],
			meta[0],
			meta[1],
			meta[2],
		);

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

export type RigOrigin = "feet" | "center";

function computePlayerRigData(origin: RigOrigin): MeshData {
	const out: MeshBuffers = { positions: [], normals: [], indices: [], uvs: [] };

	// World bodies anchor at the character controller's position, which sits
	// mid-body (the old capsule was center-origin); shift accordingly.
	const yOffset = origin === "center" ? -PLAYER_MODEL_HEIGHT / 2 : -0.1;

	// Pivots are baked origin-aware, so feet- and center-origin rigs animate
	// around the same anatomical lines (previously the WGSL constants only
	// matched center-origin geometry).
	const shoulderY = SHOULDER_PIVOT_Y + yOffset;
	const hipY = HIP_PIVOT_Y + yOffset;

	const parts: BoxPart[] = [
		{
			x: 0,
			y: 28 * PX,
			z: 0,
			w: 8 * PX,
			h: 8 * PX,
			d: 8 * PX,
			uv: HEAD_UV,
			meta: [PART_HEAD, shoulderY, 0],
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
			meta: [PART_ARM_L, shoulderY, 1],
		},
		{
			x: 6 * PX,
			y: 18 * PX,
			z: 0,
			w: 4 * PX,
			h: 12 * PX,
			d: 4 * PX,
			uv: ARM_R_UV,
			meta: [PART_ARM_R, shoulderY, -1],
		},
		{
			x: -2 * PX,
			y: 6 * PX,
			z: 0,
			w: 4 * PX,
			h: 12 * PX,
			d: 4 * PX,
			uv: LEG_L_UV,
			meta: [PART_LEG_L, hipY, -1],
		},
		{
			x: 2 * PX,
			y: 6 * PX,
			z: 0,
			w: 4 * PX,
			h: 12 * PX,
			d: 4 * PX,
			uv: LEG_R_UV,
			meta: [PART_LEG_R, hipY, 1],
		},
	];
	for (const part of parts) appendBox(out, { ...part, y: part.y + yOffset });

	return toData(out);
}

// Geometry is identical for every rig of a given origin — build once, share.
// Callers MUST NOT mutate the returned arrays; pass them straight to
// createMeshFromData (which uploads its own GPU copy).
const rigDataCache = new Map<RigOrigin, MeshData>();

/** Merged rig mesh data — origin at the feet, +Z is the facing direction. */
export function buildPlayerRigData(origin: RigOrigin = "feet"): MeshData {
	let data = rigDataCache.get(origin);
	if (!data) {
		data = computePlayerRigData(origin);
		rigDataCache.set(origin, data);
	}
	return data;
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
	setShaderUniform(mat, "uAnim", REST_ANIM);
	rigAnimStates.set(mat, { phase: 0, amp: 0, pitch: 0 });
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

// PERF: reused result buffers — packedLightToLightColor/setRigLightColor run
// on every voxel-light crossing retint. Callers must consume immediately.
const _lightColorScratch: [number, number, number] = [0, 0, 0];
const _lightColorUniformScratch = [0, 0, 0];

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
	_lightColorScratch[0] = channel(0.9);
	_lightColorScratch[1] = channel(0.6);
	_lightColorScratch[2] = channel(0.2);
	return _lightColorScratch;
}

/**
 * Unlit textured ShaderMaterial for rigs: samples the skin texture and
 * multiplies by a uLightColor RGB uniform — fully bypassing scene lights and
 * StandardMaterial state. Backface culling is on (winding matches DroppedItem)
 * and the pipeline is fully opaque.
 */
export function createRigShaderMaterial(name: string): ShaderMaterial {
	return createShaderMaterial({
		name,
		vertexSource: RIG_VERTEX_WGSL,
		fragmentSource: RIG_FRAGMENT_WGSL,
		attributes: ["position", "normal", "uv"],
		uniforms: [
			"worldViewProjection",
			{ name: "uLightColor", type: "vec3<f32>" },
			{ name: "uAnim", type: "vec4<f32>" },
		],
		samplers: ["diffuseTexture"],
		backFaceCulling: true,
	});
}

export function bindRigTexture(mat: ShaderMaterial, tex: Texture2D): void {
	setShaderTexture(mat, "diffuseTexture", tex);
}

export function setRigLightColor(
	mat: ShaderMaterial,
	color: readonly [number, number, number],
): void {
	const u = _lightColorUniformScratch;
	u[0] = color[0];
	u[1] = color[1];
	u[2] = color[2];
	setShaderUniform(mat, "uLightColor", u);
}

/** Radians of walk-stride phase accumulated per meter traveled. */
export const WALK_STRIDE_FACTOR = 1.8;

/** Horizontal speed (m/s) at which the swing reaches full amplitude. */
export const WALK_REF_SPEED = 3;

/** Head pitch clamp (±~69°) so extreme look angles stay readable. */
export const HEAD_PITCH_LIMIT = 1.2;

// ─── Animation state (CPU-side trig, single packed uniform per material) ────

interface RigAnimState {
	phase: number;
	amp: number;
	pitch: number;
}

// Last-written animation state per material. Powers the skip-unchanged fast
// path: idle players re-issuing the same (phase, amp, pitch) every frame cost
// zero uniform writes. WeakMap so disposed materials don't leak.
const rigAnimStates = new WeakMap<ShaderMaterial, RigAnimState>();

/** uAnim = [sin(swing), sin(pitch), cos(pitch), cos(swing)] rest value. */
const REST_ANIM: readonly number[] = [0, 0, 1, 1];

// PERF: scratch buffer for the per-frame write (setShaderUniform copies).
const _animUniform = [0, 0, 1, 1];

function writeRigAnim(mat: ShaderMaterial, st: RigAnimState): void {
	const swing = Math.sin(st.phase) * SWING_MAX * st.amp;
	_animUniform[0] = Math.sin(swing);
	_animUniform[1] = Math.sin(st.pitch);
	_animUniform[2] = Math.cos(st.pitch);
	_animUniform[3] = Math.cos(swing);
	setShaderUniform(mat, "uAnim", _animUniform);
}

/** Drive the rig's walk-swing (amp 0 = rest pose, 1 = full stride). */
export function setRigWalk(
	mat: ShaderMaterial,
	phase: number,
	amp: number,
): void {
	const clampedAmp = Math.max(0, Math.min(1, amp));
	let st = rigAnimStates.get(mat);
	if (st) {
		if (st.phase === phase && st.amp === clampedAmp) return; // no-op frame
		st.phase = phase;
		st.amp = clampedAmp;
	} else {
		st = { phase, amp: clampedAmp, pitch: 0 };
		rigAnimStates.set(mat, st);
	}
	writeRigAnim(mat, st);
}

/**
 * Tilt the head part with the camera. Positive = looking down (the camera
 * convention: cameraPitch is positive when looking down, and +ang tips the
 * face's +Z front downward).
 */
export function setRigHeadPitch(mat: ShaderMaterial, pitch: number): void {
	const clamped = Math.max(
		-HEAD_PITCH_LIMIT,
		Math.min(HEAD_PITCH_LIMIT, pitch),
	);
	let st = rigAnimStates.get(mat);
	if (st) {
		if (st.pitch === clamped) return; // no-op frame
		st.pitch = clamped;
	} else {
		st = { phase: 0, amp: 0, pitch: clamped };
		rigAnimStates.set(mat, st);
	}
	writeRigAnim(mat, st);
}
