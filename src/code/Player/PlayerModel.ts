import {
	addToScene,
	createDirectionalLight,
	createHemisphericLight,
	createMeshFromData,
	type EngineContext,
	loadTexture2D,
	type Mesh,
	rebuildMaterial,
	type SceneContext,
	type StandardMaterialProps,
	type Texture2D,
} from "@babylonjs/lite";

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

function appendBox(out: MeshBuffers, p: BoxPart): void {
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
				// v=1 maps to the image top (Babylon invertY convention)
				const vTop = 1 - f.r[1] / 64;
				const vBottom = 1 - f.r[3] / 64;
				out.uvs.push(
					i === 0 || i === 3 ? f.r[0] / 64 : f.r[2] / 64,
					i < 2 ? vBottom : vTop,
				);
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
	const yOffset = origin === "center" ? -PLAYER_MODEL_HEIGHT / 2 : 0;

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

/** Thin light-gray reference slab used under the preview model. */
export function buildFloorSlabData(width = 1.7): MeshData {
	const out: MeshBuffers = { positions: [], normals: [], indices: [], uvs: [] };
	appendBox(out, { x: 0, y: -0.04, z: 0, w: width, h: 0.08, d: width });
	return { ...toData(out), uvs: undefined };
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

export function loadPlayerSkin(engine: EngineContext): Promise<Texture2D> {
	let promise = skinCache.get(engine);
	if (!promise) {
		promise = loadTexture2D(engine, PLAYER_SKIN_PATH, {
			magFilter: "nearest",
			minFilter: "nearest",
			srgb: true,
		});
		skinCache.set(engine, promise);
		promise.catch(() => {}); // callers handle failures; keep console clean
	}
	return promise;
}

/**
 * Wire a standard material to the skin texture (teal fallback while loading /
 * on failure). The material should already be assigned to a mesh. A material
 * rebuild is required after the late texture assignment, otherwise the
 * compiled pipeline keeps sampling nothing and renders white.
 */
export function applyPlayerSkin(
	engine: EngineContext,
	scene: SceneContext,
	mat: StandardMaterialProps,
	isAlive: () => boolean = () => true,
): void {
	loadPlayerSkin(engine)
		.then((tex) => {
			if (!isAlive()) return;
			mat.diffuseTexture = tex;
			mat.diffuseColor = [1, 1, 1];
			rebuildMaterial(scene, mat);
		})
		.catch(() => {
			if (!isAlive()) return;
			mat.diffuseColor = [0.2, 0.9, 0.8];
			rebuildMaterial(scene, mat);
		});
}

const litScenes = new WeakSet<SceneContext>();

/**
 * The voxel world renders through its own shader pipeline, so plain
 * StandardMaterials would render black. Add one shared hemispheric +
 * directional pair per scene so rig meshes are always readable.
 */
export function ensureWorldRigLights(scene: SceneContext): void {
	if (litScenes.has(scene)) return;
	litScenes.add(scene);
	addToScene(scene, createHemisphericLight([0, 1, 0], 0.85));
	addToScene(scene, createDirectionalLight([-0.4, -1, -0.3], 0.8));
}
