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

// ─── Rig shader sources (unlit textured, brightness uniform) ────────────────
// Mirrors the proven DroppedItem shader so no scene lights or
// StandardMaterial state can interfere with how the model looks.

const RIG_VERTEX_WGSL = /* wgsl */ `
struct VSOut {
	@builtin(position) pos : vec4<f32>,
	@location(0) vUV : vec2<f32>,
	@location(1) vNormal : vec3<f32>,
	@location(2) vWorldPos : vec3<f32>,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
	var out : VSOut;
	let worldPos = shaderSystem.world * vec4<f32>(input.position, 1.0);
	out.pos = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
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
export const PLAYER_MODEL_HEIGHT = 1.8;

const PX = PLAYER_MODEL_HEIGHT / 32; // meters per skin pixel (rig is 32px tall)

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

const ARM_L_UV = limbUv(32, 48);
const ARM_R_UV = limbUv(40, 16);
const LEG_L_UV = limbUv(16, 48);
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
	const hx = p.w / 2;
	const hy = p.h / 2;
	const hz = p.d / 2;
	const { x, y, z } = p;

	// Face vertex order: [bottom-left, bottom-right, top-right, top-left] as
	// seen from outside — identical to the game's proven box winding.
	const faces: Array<{
		n: [number, number, number];
		r: UvRect | undefined;
		v: Array<[number, number, number]>;
	}> = [
		{
			n: [1, 0, 0],
			r: p.uv?.left,
			v: [
				[x + hx, y - hy, z + hz],
				[x + hx, y - hy, z - hz],
				[x + hx, y + hy, z - hz],
				[x + hx, y + hy, z + hz],
			],
		},
		{
			n: [-1, 0, 0],
			r: p.uv?.right,
			v: [
				[x - hx, y - hy, z - hz],
				[x - hx, y - hy, z + hz],
				[x - hx, y + hy, z + hz],
				[x - hx, y + hy, z - hz],
			],
		},
		{
			n: [0, 1, 0],
			r: p.uv?.top,
			v: [
				[x - hx, y + hy, z + hz],
				[x + hx, y + hy, z + hz],
				[x + hx, y + hy, z - hz],
				[x - hx, y + hy, z - hz],
			],
		},
		{
			n: [0, -1, 0],
			r: p.uv?.bottom,
			v: [
				[x - hx, y - hy, z - hz],
				[x + hx, y - hy, z - hz],
				[x + hx, y - hy, z + hz],
				[x - hx, y - hy, z + hz],
			],
		},
		{
			n: [0, 0, 1],
			r: p.uv?.front,
			v: [
				[x - hx, y - hy, z + hz],
				[x + hx, y - hy, z + hz],
				[x + hx, y + hy, z + hz],
				[x - hx, y + hy, z + hz],
			],
		},
		{
			n: [0, 0, -1],
			r: p.uv?.back,
			v: [
				[x + hx, y - hy, z - hz],
				[x - hx, y - hy, z - hz],
				[x - hx, y + hy, z - hz],
				[x + hx, y + hy, z - hz],
			],
		},
	];

	for (const f of faces) {
		const base = out.positions.length / 3;
		for (let i = 0; i < 4; i++) {
			out.positions.push(f.v[i][0], f.v[i][1], f.v[i][2]);
			out.normals.push(f.n[0], f.n[1], f.n[2]);
			if (f.r) {
				if (uvMode === "atlas") {
					// Final normalized atlas coords, passed through verbatim:
					// bl=(r0,r1) br=(r2,r1) tr=(r2,r3) tl=(r0,r3).
					out.uvs.push(
						i === 0 || i === 3 ? f.r[0] : f.r[2],
						i < 2 ? f.r[1] : f.r[3],
					);
				} else {
					// Skin-pixel space (÷64) with v=1 at image top.
					const vTop = 1 - f.r[1] / 64;
					const vBottom = 1 - f.r[3] / 64;
					out.uvs.push(
						i === 0 || i === 3 ? f.r[0] / 64 : f.r[2] / 64,
						i < 2 ? vBottom : vTop,
					);
				}
			}
		}
		out.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
	}
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
		{ x: 0, y: 28 * PX, z: 0, w: 8 * PX, h: 8 * PX, d: 8 * PX, uv: HEAD_UV },
		{ x: 0, y: 18 * PX, z: 0, w: 8 * PX, h: 12 * PX, d: 4 * PX, uv: BODY_UV },
		{
			x: -6 * PX,
			y: 18 * PX,
			z: 0,
			w: 4 * PX,
			h: 12 * PX,
			d: 4 * PX,
			uv: ARM_L_UV,
		},
		{
			x: 6 * PX,
			y: 18 * PX,
			z: 0,
			w: 4 * PX,
			h: 12 * PX,
			d: 4 * PX,
			uv: ARM_R_UV,
		},
		{
			x: -2 * PX,
			y: 6 * PX,
			z: 0,
			w: 4 * PX,
			h: 12 * PX,
			d: 4 * PX,
			uv: LEG_L_UV,
		},
		{
			x: 2 * PX,
			y: 6 * PX,
			z: 0,
			w: 4 * PX,
			h: 12 * PX,
			d: 4 * PX,
			uv: LEG_R_UV,
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
 * Bind the skin texture to a rig ShaderMaterial and initialize the light-color
 * uniform to neutral white. Mirrors DroppedItem: the mesh must stay HIDDEN
 * until the texture is bound (onBind), because drawing with an unbound sampler
 * invalidates the pass.
 *
 * An opaque-white placeholder is bound SYNCHRONOUSLY first: lite builds a
 * ShaderMaterial's bind group as soon as its renderable is constructed (scene
 * registration / material swap), and throws error #241 if any declared sampler
 * has no Texture2D — even when the mesh is invisible.
 */
export function applyRigSkin(
	engine: EngineContext,
	mat: ShaderMaterial,
	onBind?: () => void,
	isAlive: () => boolean = () => true,
): void {
	setShaderUniform(mat, "uLightColor", [1, 1, 1]);
	setShaderTexture(mat, "diffuseTexture", getFallbackTexture(engine));
	loadPlayerSkin(engine)
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
