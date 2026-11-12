// Player/Inventory/HeldBlockGeometry.ts
//
// Viewmodel block geometry that lines up with the world mesher.
//
// The world renders block faces through the packed chunk shader, which
// samples a per-tile layer of the shared atlas array. This module produces
// the same information for the first-person held block:
//
//   uvs   - the texture frame of the face, expressed in block space
//           (0..1 per block), so one tile covers exactly one block face and
//           partial shapes show the sub-region the world shows.
//   uvs2  - x = the atlas tile layer of the face (tileY * atlasSize + tileX).
//           Every face can carry its own tile, exactly like the world.
//
// The UV frame per face matches the world mesher's frame:
//
//   +X -> U along +Z, V along +Y
//   -X -> U along -Z, V along +Y
//   +Y -> U along +X, V along +Z
//   -Y -> U along +X, V along -Z
//   +Z -> U along -X, V along +Y
//   -Z -> U along +X, V along +Y
//
// Opposite faces are mirrored relative to each other so each side of a block
// shows the tile the right way round when it is looked at from outside.

import {
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
	isCrossDiagonalBlockId,
} from "@/code/World/Shape/BlockShapes";
import { getTransformedShapeBoxes } from "@/code/World/Shape/BlockShapeTransforms";
import { getFaceAtlasTile } from "@/code/World/Texture/BlockTextures";
import { FaceName } from "@/code/World/Texture/FaceName";
import { atlasSize } from "@/code/World/Texture/TextureAtlasFactory";

export type HeldBlockGeometry = {
	positions: Float32Array;
	normals: Float32Array;

	/**
	 * Texture frame of each vertex, in block space.
	 */
	uvs: Float32Array;

	/**
	 * x = atlas tile layer of the vertex's face, y = unused.
	 */
	uvs2: Float32Array;

	indices: Uint32Array;
};

type FaceFrame = {
	bit: number;
	normal: [number, number, number];
	faceName: FaceName;

	/**
	 * Block axis the texture's U coordinate runs along.
	 */
	uAxis: number;

	/**
	 * True when the texture's U runs against the axis direction.
	 */
	uFlip: boolean;

	/**
	 * Block axis the texture's V coordinate runs along.
	 */
	vAxis: number;

	/**
	 * True when the texture's V runs against the axis direction.
	 */
	vFlip: boolean;

	verts: (
		min: [number, number, number],
		max: [number, number, number],
	) => Array<[number, number, number]>;
};

const FACE_FRAMES: FaceFrame[] = [
	{
		bit: FACE_PX,
		normal: [1, 0, 0],
		faceName: FaceName.West,
		uAxis: 2,
		uFlip: false,
		vAxis: 1,
		vFlip: false,
		verts: (min, max) => [
			[max[0], min[1], max[2]],
			[max[0], min[1], min[2]],
			[max[0], max[1], min[2]],
			[max[0], max[1], max[2]],
		],
	},
	{
		bit: FACE_NX,
		normal: [-1, 0, 0],
		faceName: FaceName.East,
		uAxis: 2,
		uFlip: true,
		vAxis: 1,
		vFlip: false,
		verts: (min, max) => [
			[min[0], min[1], min[2]],
			[min[0], min[1], max[2]],
			[min[0], max[1], max[2]],
			[min[0], max[1], min[2]],
		],
	},
	{
		bit: FACE_PY,
		normal: [0, 1, 0],
		faceName: FaceName.Top,
		uAxis: 0,
		uFlip: false,
		vAxis: 2,
		vFlip: false,
		verts: (min, max) => [
			[min[0], max[1], max[2]],
			[max[0], max[1], max[2]],
			[max[0], max[1], min[2]],
			[min[0], max[1], min[2]],
		],
	},
	{
		bit: FACE_NY,
		normal: [0, -1, 0],
		faceName: FaceName.Bottom,
		uAxis: 0,
		uFlip: false,
		vAxis: 2,
		vFlip: true,
		verts: (min, max) => [
			[min[0], min[1], min[2]],
			[max[0], min[1], min[2]],
			[max[0], min[1], max[2]],
			[min[0], min[1], max[2]],
		],
	},
	{
		bit: FACE_PZ,
		normal: [0, 0, 1],
		faceName: FaceName.South,
		uAxis: 0,
		uFlip: true,
		vAxis: 1,
		vFlip: false,
		verts: (min, max) => [
			[min[0], min[1], max[2]],
			[max[0], min[1], max[2]],
			[max[0], max[1], max[2]],
			[min[0], max[1], max[2]],
		],
	},
	{
		bit: FACE_NZ,
		normal: [0, 0, -1],
		faceName: FaceName.North,
		uAxis: 0,
		uFlip: false,
		vAxis: 1,
		vFlip: false,
		verts: (min, max) => [
			[max[0], min[1], min[2]],
			[min[0], min[1], min[2]],
			[min[0], max[1], min[2]],
			[max[0], max[1], min[2]],
		],
	},
];

const geometryCache = new Map<string, HeldBlockGeometry>();

/**
 * Resolves the atlas layer of a face.
 *
 * The layer index follows the world mesher: tileY * atlasSize + tileX.
 */
function getTileLayer(blockId: number, faceName: FaceName): number {
	const tile = getFaceAtlasTile(blockId, faceName);

	if (tile === null) {
		return 0;
	}

	const tileX = Math.max(0, Math.min(atlasSize - 1, tile[0]));
	const tileY = Math.max(0, Math.min(atlasSize - 1, tile[1]));

	return tileY * atlasSize + tileX;
}

export function getHeldBlockGeometry(
	blockId: number,
	blockState: number,
): HeldBlockGeometry {
	const cacheKey = `${blockId}:${blockState & 63}`;
	const cached = geometryCache.get(cacheKey);

	if (cached !== undefined) {
		return cached;
	}

	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const uvs2: number[] = [];
	const indices: number[] = [];

	/**
	 * Emits one quad. The UVs are given per corner in block space.
	 */
	const addQuad = (
		verts: Array<[number, number, number]>,
		normal: [number, number, number],
		layer: number,
		cornerUvs: Array<[number, number]>,
	): void => {
		const base = positions.length / 3;

		for (let i = 0; i < 4; i++) {
			positions.push(verts[i][0] - 0.5, verts[i][1] - 0.5, verts[i][2] - 0.5);
			normals.push(normal[0], normal[1], normal[2]);
			uvs.push(cornerUvs[i][0], cornerUvs[i][1]);
			uvs2.push(layer, 0);
		}

		indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
	};

	if (isCrossDiagonalBlockId(blockId)) {
		/*
		 * Cross-diagonal foliage is two diagonal planes rather than box
		 * faces. Both windings are emitted because the viewmodel material
		 * keeps back-face culling enabled. A diagonal plane shows the
		 * whole tile.
		 */
		const layer = getTileLayer(blockId, FaceName.Side);

		const planeUvs: Array<[number, number]> = [
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		];

		const a: Array<[number, number, number]> = [
			[0, 0, 0],
			[1, 0, 1],
			[1, 1, 1],
			[0, 1, 0],
		];
		const b: Array<[number, number, number]> = [
			[1, 0, 0],
			[0, 0, 1],
			[0, 1, 1],
			[1, 1, 0],
		];
		const na: [number, number, number] = [Math.SQRT1_2, 0, -Math.SQRT1_2];
		const nb: [number, number, number] = [Math.SQRT1_2, 0, Math.SQRT1_2];

		addQuad(a, na, layer, planeUvs);
		addQuad(
			[...a].reverse(),
			[-na[0], -na[1], -na[2]],
			layer,
			[...planeUvs].reverse(),
		);
		addQuad(b, nb, layer, planeUvs);
		addQuad(
			[...b].reverse(),
			[-nb[0], -nb[1], -nb[2]],
			layer,
			[...planeUvs].reverse(),
		);
	} else {
		for (const box of getTransformedShapeBoxes(blockId, blockState)) {
			for (const frame of FACE_FRAMES) {
				if ((box.faceMask & frame.bit) === 0) {
					continue;
				}

				const verts = frame.verts(box.min, box.max);
				const base = positions.length / 3;
				const layer = getTileLayer(blockId, frame.faceName);

				for (let i = 0; i < 4; i++) {
					const vertex = verts[i];

					positions.push(vertex[0] - 0.5, vertex[1] - 0.5, vertex[2] - 0.5);
					normals.push(frame.normal[0], frame.normal[1], frame.normal[2]);

					const u = frame.uFlip ? 1 - vertex[frame.uAxis] : vertex[frame.uAxis];
					const v = frame.vFlip ? 1 - vertex[frame.vAxis] : vertex[frame.vAxis];

					uvs.push(u, v);
					uvs2.push(layer, 0);
				}

				indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
			}
		}
	}

	const geometry: HeldBlockGeometry = {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		uvs: new Float32Array(uvs),
		uvs2: new Float32Array(uvs2),
		indices: new Uint32Array(indices),
	};

	geometryCache.set(cacheKey, geometry);

	return geometry;
}
