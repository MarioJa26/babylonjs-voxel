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

// Rig metrics must precede constants derived from them.
export const PLAYER_MODEL_HEIGHT = 1.8;

/** Meters per skin pixel. The rig is 32 pixels tall. */
const PX = PLAYER_MODEL_HEIGHT / 32;
const INV_SKIN_SIZE = 1 / 64;
const HALF_PLAYER_MODEL_HEIGHT = PLAYER_MODEL_HEIGHT * 0.5;

/** Part IDs stored in normal.x for the animation shader. */
const PART_STATIC = 0;
const PART_ARM_L = 1;
const PART_ARM_R = 2;
const PART_LEG_L = 3;
const PART_LEG_R = 4;
const PART_HEAD = 5;

/**
 * Model-space pivot lines using the feet-origin convention.
 *
 * The origin offset is added when the geometry is built, so the baked pivots
 * are correct for both feet-origin and center-origin rigs.
 */
const SHOULDER_PIVOT_Y = 24 * PX;
const HIP_PIVOT_Y = 12 * PX;

/** Maximum limb swing angle, in radians, at amplitude 1. */
const SWING_MAX = 0.75;

/** Peak right-arm raise, in radians, at the middle of a punch. */
const PUNCH_MAX_ANGLE = 1.15;

/**
 * Positions and rotates an item so it follows the animated right hand.
 *
 * The mesh is positioned relative to the camera because HeldItemView renders
 * it using a camera-relative view-projection matrix.
 */
export function setRigHeldItemTransform(
	item: Mesh,
	body: Mesh,
	camX: number,
	camY: number,
	camZ: number,
	phase: number,
	amp: number,
	punchT = Number.POSITIVE_INFINITY,
): void {
	const swing = -Math.sin(phase) * SWING_MAX * amp;

	/*
	 * The total hand angle mirrors the rig shader's right-arm rotation:
	 * walk swing plus the forward punch raise.
	 */
	const punchCurve = punchT >= 0 && punchT < 1 ? Math.sin(punchT * Math.PI) : 0;

	const theta = swing - punchCurve * PUNCH_MAX_ANGLE;
	const sinTheta = Math.sin(theta);
	const cosTheta = Math.cos(theta);

	const handX = 6 * PX;
	const handY = -12 * PX;
	const handZ = 3 * PX;

	const localY =
		SHOULDER_PIVOT_Y -
		HALF_PLAYER_MODEL_HEIGHT +
		handY * cosTheta -
		handZ * sinTheta;

	const localZ = handY * sinTheta + handZ * cosTheta;

	const bodyPosition = body.position;
	const yaw = body.rotation.y;
	const sinYaw = Math.sin(yaw);
	const cosYaw = Math.cos(yaw);

	item.position.set(
		bodyPosition.x + handX * cosYaw + localZ * sinYaw - camX,
		bodyPosition.y + localY - camY,
		bodyPosition.z - handX * sinYaw + localZ * cosYaw - camZ,
	);

	item.rotation.set(theta, yaw, 0);
}

// ─── Rig shader sources ─────────────────────────────────────────────────────
//
// The rig is unlit and textured. Brightness is supplied through a uniform.
// Per-frame animation trigonometry runs on the CPU.
//
// uAnim:
// [sin(walkSwing), sin(headPitch), cos(headPitch), cos(walkSwing)]
//
// uPunch:
// [sin(punchAngle), cos(punchAngle)]
//
// Vertex metadata is stored in the normal attribute:
// x = part ID
// y = pivot Y
// z = swing sign

const RIG_VERTEX_WGSL = /* wgsl */ `
struct VSOut {
    @builtin(position) pos : vec4<f32>,
    @location(0) vUV : vec2<f32>,
};

fn animateRig(
    p : vec3<f32>,
    tag : vec3<f32>
) -> vec3<f32> {
    if (tag.x < 0.5) {
        return p;
    }

    var s : f32;
    var c : f32;

    if (tag.x > 4.5) {
        // Head pitches around the neck line.
        if (shaderUniforms.uAnim.y == 0.0) {
            return p;
        }

        s = shaderUniforms.uAnim.y;
        c = shaderUniforms.uAnim.z;
    } else if (tag.x > 1.5 && tag.x < 2.5) {
        // Right arm combines the walk swing and punch rotation.
        if (
            shaderUniforms.uAnim.x == 0.0 &&
            shaderUniforms.uPunch.x == 0.0
        ) {
            return p;
        }

        let walkSin =
            shaderUniforms.uAnim.x * tag.z;

        let walkCos =
            shaderUniforms.uAnim.w;

        let punchSin =
            shaderUniforms.uPunch.x;

        let punchCos =
            shaderUniforms.uPunch.y;

        s =
            walkSin * punchCos +
            walkCos * punchSin;

        c =
            walkCos * punchCos -
            walkSin * punchSin;
    } else {
        // Left arm and legs swing around their baked pivots.
        if (shaderUniforms.uAnim.x == 0.0) {
            return p;
        }

        s = shaderUniforms.uAnim.x * tag.z;
        c = shaderUniforms.uAnim.w;
    }

    let centeredY = p.y - tag.y;

    return vec3<f32>(
        p.x,
        tag.y + centeredY * c - p.z * s,
        centeredY * s + p.z * c
    );
}

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
    var out : VSOut;

    let animated =
        animateRig(input.position, input.normal);

    out.pos =
        shaderSystem.worldViewProjection *
        vec4<f32>(animated, 1.0);

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
fn mainFragment(
    in : VSOut
) -> @location(0) vec4<f32> {
    let tex = textureSample(
        diffuseTexture,
        diffuseTextureSampler,
        in.vUV
    );

    return vec4<f32>(
        tex.rgb * shaderUniforms.uLightColor,
        1.0
    );
}
`;

/**
 * Minecraft-style player rig built from textured boxes and a 64×64 skin.
 */
export const PLAYER_SKIN_PATH = "/texture/player/skin.png";

/**
 * Vertical offset from the controller's mid-body origin used to sample voxel
 * lighting. Chest height avoids sampling inside a low ceiling while jumping.
 */
export const PLAYER_LIGHT_SAMPLE_Y_OFFSET = 0.5;

// ─── Skin atlas layout ──────────────────────────────────────────────────────

type UvRect = readonly [u0: number, v0: number, u1: number, v1: number];

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

function createLimbUv(offsetX: number, offsetY: number): UvSet {
	return {
		top: [offsetX + 4, offsetY, offsetX + 8, offsetY + 4],
		bottom: [offsetX + 8, offsetY, offsetX + 12, offsetY + 4],
		right: [offsetX, offsetY + 4, offsetX + 4, offsetY + 16],
		front: [offsetX + 4, offsetY + 4, offsetX + 8, offsetY + 16],
		left: [offsetX + 8, offsetY + 4, offsetX + 12, offsetY + 16],
		back: [offsetX + 12, offsetY + 4, offsetX + 16, offsetY + 16],
	};
}

/*
 * Compact sheet: left limbs are directly below their right counterparts in
 * the y=32–48 band rather than Minecraft's default y=48–64 row.
 */
const ARM_L_UV = createLimbUv(40, 32);
const ARM_R_UV = createLimbUv(40, 16);
const LEG_L_UV = createLimbUv(0, 32);
const LEG_R_UV = createLimbUv(0, 16);

// ─── Box builder ────────────────────────────────────────────────────────────

/** [partId, pivotY, swingSign] stored in every vertex normal. */
type PartMeta = readonly [partId: number, pivotY: number, swingSign: number];

const STATIC_META: PartMeta = [PART_STATIC, 0, 0];

interface BoxPart {
	x: number;
	y: number;
	z: number;
	w: number;
	h: number;
	d: number;
	uv?: UvSet;
	meta?: PartMeta;
}

interface MeshData {
	positions: Float32Array;
	normals: Float32Array;
	indices: Uint32Array;
	uvs?: Float32Array;
}

interface MeshBuffers {
	positions: number[];
	normals: number[];
	indices: number[];
	uvs: number[];
}

type UvMode = "skin" | "atlas";

function appendBox(
	output: MeshBuffers,
	part: BoxPart,
	uvMode: UvMode = "skin",
): void {
	const halfWidth = part.w * 0.5;
	const halfHeight = part.h * 0.5;
	const halfDepth = part.d * 0.5;

	const x0 = part.x - halfWidth;
	const x1 = part.x + halfWidth;
	const y0 = part.y - halfHeight;
	const y1 = part.y + halfHeight;
	const z0 = part.z - halfDepth;
	const z1 = part.z + halfDepth;

	const meta = part.meta ?? STATIC_META;
	const partId = meta[0];
	const pivotY = meta[1];
	const swingSign = meta[2];

	const positions = output.positions;
	const normals = output.normals;
	const indices = output.indices;
	const uvs = output.uvs;
	const uv = part.uv;

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
			partId,
			pivotY,
			swingSign,
			partId,
			pivotY,
			swingSign,
			partId,
			pivotY,
			swingSign,
			partId,
			pivotY,
			swingSign,
		);

		if (rect !== undefined) {
			let u0: number;
			let u1: number;
			let vBottom: number;
			let vTop: number;

			if (uvMode === "atlas") {
				u0 = rect[0];
				u1 = rect[2];
				vBottom = rect[1];
				vTop = rect[3];
			} else {
				u0 = rect[0] * INV_SKIN_SIZE;
				u1 = rect[2] * INV_SKIN_SIZE;
				vBottom = 1 - rect[3] * INV_SKIN_SIZE;
				vTop = 1 - rect[1] * INV_SKIN_SIZE;
			}

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

	// +X face, skin "left".
	appendFace(uv?.left, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1);

	// -X face, skin "right".
	appendFace(uv?.right, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0);

	// +Y face.
	appendFace(uv?.top, x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0);

	// -Y face.
	appendFace(uv?.bottom, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);

	// +Z face.
	appendFace(uv?.front, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);

	// -Z face.
	appendFace(uv?.back, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0);
}

function toMeshData(buffers: MeshBuffers): MeshData {
	return {
		positions: new Float32Array(buffers.positions),
		normals: new Float32Array(buffers.normals),
		indices: new Uint32Array(buffers.indices),
		uvs: new Float32Array(buffers.uvs),
	};
}

export type RigOrigin = "feet" | "center";

function appendPlayerPart(
	output: MeshBuffers,
	x: number,
	y: number,
	z: number,
	width: number,
	height: number,
	depth: number,
	uv: UvSet,
	yOffset: number,
	meta?: PartMeta,
): void {
	appendBox(output, {
		x,
		y: y + yOffset,
		z,
		w: width,
		h: height,
		d: depth,
		uv,
		meta,
	});
}

function computePlayerRigData(origin: RigOrigin): MeshData {
	const output: MeshBuffers = {
		positions: [],
		normals: [],
		indices: [],
		uvs: [],
	};

	/*
	 * World bodies anchor at the character controller's mid-body position.
	 * Feet-origin previews retain the original small floor alignment offset.
	 */
	const yOffset = origin === "center" ? -HALF_PLAYER_MODEL_HEIGHT : -0.1;

	const shoulderY = SHOULDER_PIVOT_Y + yOffset;
	const hipY = HIP_PIVOT_Y + yOffset;

	const headMeta: PartMeta = [PART_HEAD, shoulderY, 0];

	const leftArmMeta: PartMeta = [PART_ARM_L, shoulderY, 1];

	const rightArmMeta: PartMeta = [PART_ARM_R, shoulderY, -1];

	const leftLegMeta: PartMeta = [PART_LEG_L, hipY, -1];

	const rightLegMeta: PartMeta = [PART_LEG_R, hipY, 1];

	/*
	 * Append directly instead of allocating a temporary parts array and
	 * cloning every part with object spread.
	 */
	appendPlayerPart(
		output,
		0,
		28 * PX,
		0,
		8 * PX,
		8 * PX,
		8 * PX,
		HEAD_UV,
		yOffset,
		headMeta,
	);

	appendPlayerPart(
		output,
		0,
		18 * PX,
		0,
		8 * PX,
		12 * PX,
		4 * PX,
		BODY_UV,
		yOffset,
	);

	appendPlayerPart(
		output,
		-6 * PX,
		18 * PX,
		0,
		4 * PX,
		12 * PX,
		4 * PX,
		ARM_L_UV,
		yOffset,
		leftArmMeta,
	);

	appendPlayerPart(
		output,
		6 * PX,
		18 * PX,
		0,
		4 * PX,
		12 * PX,
		4 * PX,
		ARM_R_UV,
		yOffset,
		rightArmMeta,
	);

	appendPlayerPart(
		output,
		-2 * PX,
		6 * PX,
		0,
		4 * PX,
		12 * PX,
		4 * PX,
		LEG_L_UV,
		yOffset,
		leftLegMeta,
	);

	appendPlayerPart(
		output,
		2 * PX,
		6 * PX,
		0,
		4 * PX,
		12 * PX,
		4 * PX,
		LEG_R_UV,
		yOffset,
		rightLegMeta,
	);

	return toMeshData(output);
}

/*
 * Geometry is identical for every rig of a given origin. There are only two
 * possible origins, so direct slots are faster and simpler than a Map.
 */
let feetRigData: MeshData | null = null;
let centerRigData: MeshData | null = null;

/**
 * Returns merged player-rig geometry.
 *
 * Callers must not mutate the returned typed arrays.
 */
export function buildPlayerRigData(origin: RigOrigin = "feet"): MeshData {
	if (origin === "center") {
		if (centerRigData === null) {
			centerRigData = computePlayerRigData("center");
		}

		return centerRigData;
	}

	if (feetRigData === null) {
		feetRigData = computePlayerRigData("feet");
	}

	return feetRigData;
}

/**
 * Builds the thin reference slab displayed below the preview model.
 *
 * atlasRect contains final normalized atlas coordinates:
 * [u0, vLow, u1, vHigh].
 */
export function buildFloorSlabData(
	width = 1,
	atlasRect?: readonly [number, number, number, number],
): MeshData {
	const output: MeshBuffers = {
		positions: [],
		normals: [],
		indices: [],
		uvs: [],
	};

	if (atlasRect !== undefined) {
		const uv: UvSet = {
			front: atlasRect,
			back: atlasRect,
			right: atlasRect,
			left: atlasRect,
			top: atlasRect,
			bottom: atlasRect,
		};

		appendBox(
			output,
			{
				x: 0,
				y: -0.6,
				z: 0,
				w: width,
				h: 1,
				d: width,
				uv,
			},
			"atlas",
		);
	} else {
		appendBox(output, {
			x: 0,
			y: -0.6,
			z: 0,
			w: width,
			h: 1,
			d: width,
		});
	}

	return toMeshData(output);
}

// ─── Factories and texture caches ──────────────────────────────────────────

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
	const cached = fallbackTextureCache.get(engine);

	if (cached !== undefined) {
		return cached;
	}

	const texture = createSolidTexture2D(engine, 255, 255, 255, 255);

	fallbackTextureCache.set(engine, texture);

	return texture;
}

/** Returns the shared opaque-white fallback for one engine. */
export function getRigFallbackTexture(engine: EngineContext): Texture2D {
	return getFallbackTexture(engine);
}

export function loadPlayerSkin(engine: EngineContext): Promise<Texture2D> {
	const cached = skinCache.get(engine);

	if (cached !== undefined) {
		return cached;
	}

	const promise = loadTexture2D(engine, PLAYER_SKIN_PATH, {
		magFilter: "nearest",
		minFilter: "nearest",
	});

	skinCache.set(engine, promise);

	/*
	 * Attach a rejection handler so an unused cached promise does not produce
	 * an unhandled rejection. The original promise remains rejected, allowing
	 * applyRigSkin and external callers to handle the failure normally.
	 */
	void promise.catch(ignoreError);

	return promise;
}

function ignoreError(): void {
	// Intentionally empty.
}

/** uAnim rest value: [sin(swing), sin(pitch), cos(pitch), cos(swing)]. */
const REST_ANIM: readonly number[] = [0, 0, 1, 1];

/** uPunch rest value: [sin(angle), cos(angle)]. */
const REST_PUNCH: readonly number[] = [0, 1];

interface RigAnimState {
	phase: number;
	amp: number;
	pitch: number;

	/**
	 * Punch curve from 0 at rest to 1 at the peak.
	 */
	punch: number;
}

/**
 * Last-written animation state by material.
 *
 * WeakMap prevents disposed materials from being retained.
 */
const rigAnimStates = new WeakMap<ShaderMaterial, RigAnimState>();

function alwaysAlive(): boolean {
	return true;
}

/**
 * Binds a fallback texture synchronously, initializes rig uniforms, and then
 * replaces the fallback with the loaded skin.
 */
export function applyRigSkin(
	engine: EngineContext,
	material: ShaderMaterial,
	onBind?: () => void,
	isAlive: () => boolean = alwaysAlive,
	loadSkin: (engine: EngineContext) => Promise<Texture2D> = loadPlayerSkin,
): void {
	setShaderUniform(material, "uLightColor", WHITE_LIGHT_COLOR);

	setShaderUniform(material, "uAnim", REST_ANIM);

	setShaderUniform(material, "uPunch", REST_PUNCH);

	rigAnimStates.set(material, {
		phase: 0,
		amp: 0,
		pitch: 0,
		punch: 0,
	});

	setShaderTexture(material, "diffuseTexture", getFallbackTexture(engine));

	void loadSkin(engine)
		.then((texture) => {
			if (!isAlive()) {
				return;
			}

			setShaderTexture(material, "diffuseTexture", texture);

			onBind?.();
		})
		.catch(() => {
			if (isAlive()) {
				onBind?.();
			}
		});
}

// ─── Lighting ───────────────────────────────────────────────────────────────

const WHITE_LIGHT_COLOR: readonly [number, number, number] = [1, 1, 1];

/*
 * Reused result buffers. Consumers must use returned values immediately and
 * must not retain or mutate them.
 */
const lightColorScratch: [number, number, number] = [0, 0, 0];

const lightColorUniformScratch = [0, 0, 0];

/**
 * Converts packed voxel light, sky << 4 | block, into an RGB light color.
 */
export function packedLightToLightColor(
	packed: number,
): readonly [number, number, number] {
	const sky = ((packed >> 4) & 0xf) / 15;
	const block = (packed & 0xf) / 15;

	const sunElevation = -GLOBAL_VALUES.skyLightDirection.y + 0.1;

	const sunIntensity = Math.min(1, Math.max(0, sunElevation * 4));

	const skyScale = sky * 0.8 * (sunIntensity + 0.2);

	/*
	 * Calculate channels directly instead of allocating a closure for every
	 * light update.
	 */
	lightColorScratch[0] = Math.min(1, Math.max(0.2, skyScale + block * 0.9));

	lightColorScratch[1] = Math.min(1, Math.max(0.2, skyScale + block * 0.6));

	lightColorScratch[2] = Math.min(1, Math.max(0.2, skyScale + block * 0.2));

	return lightColorScratch;
}

/**
 * Creates the unlit textured material used by player rigs.
 */
export function createRigShaderMaterial(name: string): ShaderMaterial {
	return createShaderMaterial({
		name,
		vertexSource: RIG_VERTEX_WGSL,
		fragmentSource: RIG_FRAGMENT_WGSL,
		attributes: ["position", "normal", "uv"],
		uniforms: [
			"worldViewProjection",
			{
				name: "uLightColor",
				type: "vec3<f32>",
			},
			{
				name: "uAnim",
				type: "vec4<f32>",
			},
			{
				name: "uPunch",
				type: "vec2<f32>",
			},
		],
		samplers: ["diffuseTexture"],
		backFaceCulling: true,
	});
}

export function bindRigTexture(
	material: ShaderMaterial,
	texture: Texture2D,
): void {
	setShaderTexture(material, "diffuseTexture", texture);
}

export function setRigLightColor(
	material: ShaderMaterial,
	color: readonly [number, number, number],
): void {
	lightColorUniformScratch[0] = color[0];
	lightColorUniformScratch[1] = color[1];
	lightColorUniformScratch[2] = color[2];

	setShaderUniform(material, "uLightColor", lightColorUniformScratch);
}

// ─── Animation ──────────────────────────────────────────────────────────────

/** Radians of walk-stride phase accumulated per meter traveled. */
export const WALK_STRIDE_FACTOR = 1.8;

/** Horizontal speed at which the swing reaches full amplitude. */
export const WALK_REF_SPEED = 3;

/** Head-pitch clamp in radians, approximately ±69 degrees. */
export const HEAD_PITCH_LIMIT = 1.2;

/** Full punch duration in seconds. */
export const PUNCH_DURATION_S = 0.32;

/*
 * Reused uniform buffers. setShaderUniform is expected to copy their values
 * synchronously, matching the existing lite API contract.
 */
const punchUniformScratch = [0, 1];
const animUniformScratch = [0, 0, 1, 1];

function getOrCreateRigAnimState(material: ShaderMaterial): RigAnimState {
	const existing = rigAnimStates.get(material);

	if (existing !== undefined) {
		return existing;
	}

	const state: RigAnimState = {
		phase: 0,
		amp: 0,
		pitch: 0,
		punch: 0,
	};

	rigAnimStates.set(material, state);

	return state;
}

function writeRigAnim(material: ShaderMaterial, state: RigAnimState): void {
	const swing = Math.sin(state.phase) * SWING_MAX * state.amp;

	animUniformScratch[0] = Math.sin(swing);
	animUniformScratch[3] = Math.cos(swing);

	/*
	 * Preserve the shader's all-zero early-out convention at exact rest while
	 * retaining a valid cosine for nonzero head pitch.
	 */
	if (state.pitch === 0) {
		animUniformScratch[1] = 0;
		animUniformScratch[2] = 1;
	} else {
		animUniformScratch[1] = Math.sin(state.pitch);

		animUniformScratch[2] = Math.cos(state.pitch);
	}

	setShaderUniform(material, "uAnim", animUniformScratch);
}

/**
 * Drives walk animation. Amplitude is clamped to [0, 1].
 */
export function setRigWalk(
	material: ShaderMaterial,
	phase: number,
	amp: number,
): void {
	const clampedAmp = Math.min(1, Math.max(0, amp));

	const state = getOrCreateRigAnimState(material);

	if (state.phase === phase && state.amp === clampedAmp) {
		return;
	}

	state.phase = phase;
	state.amp = clampedAmp;

	writeRigAnim(material, state);
}

/**
 * Tilts the head with the camera.
 *
 * Positive pitch looks downward.
 */
export function setRigHeadPitch(material: ShaderMaterial, pitch: number): void {
	const clampedPitch = Math.min(
		HEAD_PITCH_LIMIT,
		Math.max(-HEAD_PITCH_LIMIT, pitch),
	);

	const state = getOrCreateRigAnimState(material);

	if (state.pitch === clampedPitch) {
		return;
	}

	state.pitch = clampedPitch;

	writeRigAnim(material, state);
}

/**
 * Raises the right arm for a punch or mining strike.
 *
 * punchT is normalized progress in [0, 1). Values outside that range produce
 * the rest pose.
 */
export function setRigPunch(material: ShaderMaterial, punchT: number): void {
	const curve = punchT >= 0 && punchT < 1 ? Math.sin(punchT * Math.PI) : 0;

	const state = getOrCreateRigAnimState(material);

	if (state.punch === curve) {
		return;
	}

	state.punch = curve;

	/*
	 * A negative angle raises the arm forward. The shader combines this
	 * rotation with the right arm's walk rotation.
	 */
	const angle = curve * PUNCH_MAX_ANGLE;

	punchUniformScratch[0] = -Math.sin(angle);
	punchUniformScratch[1] = Math.cos(angle);

	setShaderUniform(material, "uPunch", punchUniformScratch);
}
