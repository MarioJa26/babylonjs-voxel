import { type FreeCamera, Matrix, type Mesh } from "@babylonjs/core";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import type { Chunk } from "../Chunk";

const CHUNK_SIZE = GenerationParams.CHUNK_SIZE;

const WORLD_CHUNK_EXTENT_X = 512;
const WORLD_CHUNK_EXTENT_Y = 128;
const WORLD_CHUNK_EXTENT_Z = 512;

const MAX_DEPTH_X = Math.log2(WORLD_CHUNK_EXTENT_X);
const MAX_DEPTH_Y = Math.log2(WORLD_CHUNK_EXTENT_Y);
const MAX_DEPTH_Z = Math.log2(WORLD_CHUNK_EXTENT_Z);
const MAX_DEPTH = Math.max(MAX_DEPTH_X, MAX_DEPTH_Y, MAX_DEPTH_Z);

class OctreeNode {
	parent: OctreeNode | null = null;
	children: OctreeNode[] | null = null;
	chunk: Chunk | null = null;
	isEmpty = true;

	minX: number;
	minY: number;
	minZ: number;
	spanX: number;
	spanY: number;
	spanZ: number;

	wMinX: number;
	wMinY: number;
	wMinZ: number;
	wMaxX: number;
	wMaxY: number;
	wMaxZ: number;

	cX: number;
	cY: number;
	cZ: number;
	radius: number;

	constructor(
		minX: number,
		minY: number,
		minZ: number,
		spanX: number,
		spanY: number,
		spanZ: number,
	) {
		this.minX = minX;
		this.minY = minY;
		this.minZ = minZ;
		this.spanX = spanX;
		this.spanY = spanY;
		this.spanZ = spanZ;
		this.wMinX = minX * CHUNK_SIZE;
		this.wMinY = minY * CHUNK_SIZE;
		this.wMinZ = minZ * CHUNK_SIZE;
		this.wMaxX = (minX + spanX) * CHUNK_SIZE;
		this.wMaxY = (minY + spanY) * CHUNK_SIZE;
		this.wMaxZ = (minZ + spanZ) * CHUNK_SIZE;

		const halfWx = spanX * CHUNK_SIZE * 0.5;
		const halfWy = spanY * CHUNK_SIZE * 0.5;
		const halfWz = spanZ * CHUNK_SIZE * 0.5;
		this.cX = this.wMinX + halfWx;
		this.cY = this.wMinY + halfWy;
		this.cZ = this.wMinZ + halfWz;
		this.radius = Math.sqrt(
			halfWx * halfWx + halfWy * halfWy + halfWz * halfWz,
		);
	}

	get isLeaf(): boolean {
		return this.spanX <= 1 && this.spanY <= 1 && this.spanZ <= 1;
	}
}

const _scratchViewProj = new Matrix();

const _scratchPlanes = new Float32Array(24);

function extractFrustumPlanes(camera: FreeCamera, out: Float32Array): void {
	const scene = camera.getScene();
	if (!scene) return;
	const cameraMatrix = camera.getViewMatrix();

	const projectionMatrix = camera.getProjectionMatrix();

	projectionMatrix.multiplyToRef(cameraMatrix, _scratchViewProj);

	const m = _scratchViewProj.m;

	for (let p = 0; p < 6; p++) {
		let ex: number, ey: number, ez: number, ed: number;

		if (p === 0) {
			ex = m[3] + m[0];
			ey = m[7] + m[4];
			ez = m[11] + m[8];
			ed = m[15] + m[12];
		} else if (p === 1) {
			ex = m[3] - m[0];
			ey = m[7] - m[4];
			ez = m[11] - m[8];
			ed = m[15] - m[12];
		} else if (p === 2) {
			ex = m[3] + m[1];
			ey = m[7] + m[5];
			ez = m[11] + m[9];
			ed = m[15] + m[13];
		} else if (p === 3) {
			ex = m[3] - m[1];
			ey = m[7] - m[5];
			ez = m[11] - m[9];
			ed = m[15] - m[13];
		} else if (p === 4) {
			ex = m[3] + m[2];
			ey = m[7] + m[6];
			ez = m[11] + m[10];
			ed = m[15] + m[14];
		} else {
			ex = m[3] - m[2];
			ey = m[7] - m[6];
			ez = m[11] - m[10];
			ed = m[15] - m[14];
		}

		const len = Math.sqrt(ex * ex + ey * ey + ez * ez + ed * ed);
		const inv = 1.0 / len;
		const o = p * 4;
		out[o] = ex * inv;
		out[o + 1] = ey * inv;
		out[o + 2] = ez * inv;
		out[o + 3] = ed * inv;
	}
}

function sphereOutsideFrustum(
	cX: number,
	cY: number,
	cZ: number,
	radius: number,
	planes: Float32Array,
): boolean {
	for (let p = 0; p < 6; p++) {
		const o = p * 4;
		const dist =
			planes[o] * cX + planes[o + 1] * cY + planes[o + 2] * cZ + planes[o + 3];
		if (dist < -radius) return true;
	}
	return false;
}

function intersectsFrustum(
	node: OctreeNode,
	planes: Float32Array,
): "outside" | "inside" | "intersect" {
	if (sphereOutsideFrustum(node.cX, node.cY, node.cZ, node.radius, planes)) {
		return "outside";
	}

	let result: "outside" | "inside" | "intersect" = "inside";

	for (let p = 0; p < 6; p++) {
		const o = p * 4;
		const nx = planes[o];
		const ny = planes[o + 1];
		const nz = planes[o + 2];
		const d = planes[o + 3];

		const pX = nx >= 0 ? node.wMaxX : node.wMinX;
		const pY = ny >= 0 ? node.wMaxY : node.wMinY;
		const pZ = nz >= 0 ? node.wMaxZ : node.wMinZ;
		const distP = nx * pX + ny * pY + nz * pZ + d;

		if (distP < 0) return "outside";

		const nX = nx >= 0 ? node.wMinX : node.wMaxX;
		const nY = ny >= 0 ? node.wMinY : node.wMaxY;
		const nZ = nz >= 0 ? node.wMinZ : node.wMaxZ;
		const distN = nx * nX + ny * nY + nz * nZ + d;

		if (distN < 0) result = "intersect";
	}

	return result;
}

function nodeOverlapsRadius(
	node: OctreeNode,
	centerX: number,
	centerY: number,
	centerZ: number,
	horizontalRadius: number,
	verticalRadius: number,
): boolean {
	const nodeMinX = node.minX;
	const nodeMinY = node.minY;
	const nodeMinZ = node.minZ;
	const nodeMaxX = node.minX + node.spanX - 1;
	const nodeMaxY = node.minY + node.spanY - 1;
	const nodeMaxZ = node.minZ + node.spanZ - 1;

	const rMinX = centerX - horizontalRadius;
	const rMaxX = centerX + horizontalRadius;
	const rMinY = centerY - verticalRadius;
	const rMaxY = centerY + verticalRadius;
	const rMinZ = centerZ - horizontalRadius;
	const rMaxZ = centerZ + horizontalRadius;

	return (
		nodeMinX <= rMaxX &&
		nodeMaxX >= rMinX &&
		nodeMinY <= rMaxY &&
		nodeMaxY >= rMinY &&
		nodeMinZ <= rMaxZ &&
		nodeMaxZ >= rMinZ
	);
}

const _traverseStack: OctreeNode[] = new Array(4096);

function collectLeafInline(
	node: OctreeNode,
	visible: Chunk[],
	visibleMeshes: Mesh[],
): void {
	const stack = _traverseStack;
	let top = 0;
	stack[0] = node;

	while (top >= 0) {
		const current = stack[top--];
		if (current.isLeaf) {
			const ch = current.chunk;
			if (ch) {
				ch._octreeVisible = true;
				visible.push(ch);
				const mesh = ch.mesh;
				if (mesh) {
					mesh.isVisible = true;
					visibleMeshes.push(mesh);
				}
				const tMesh = ch.transparentMesh;
				if (tMesh) {
					tMesh.isVisible = true;
					visibleMeshes.push(tMesh);
				}
			}
		} else {
			const children = current.children;
			if (children) {
				for (let i = 7; i >= 0; i--) {
					const child = children[i];
					if (child && !child.isEmpty) {
						stack[++top] = child;
					}
				}
			}
		}
	}
}

export class WorldChunkOctree {
	private readonly root: OctreeNode;

	private visibleThisFrame: Chunk[] = [];
	private visibleLastFrame: Chunk[] = [];
	private _visibleMeshes: Mesh[] = [];

	constructor() {
		this.root = new OctreeNode(
			-WORLD_CHUNK_EXTENT_X / 2,
			0,
			-WORLD_CHUNK_EXTENT_Z / 2,
			WORLD_CHUNK_EXTENT_X,
			WORLD_CHUNK_EXTENT_Y,
			WORLD_CHUNK_EXTENT_Z,
		);
	}

	public insert(chunk: Chunk): void {
		this._insert(this.root, chunk);
	}

	public remove(chunk: Chunk): void {
		this._remove(this.root, chunk);
	}

	public updateEmptyState(chunk: Chunk): void {
		this._updateEmptyUp(this.root, chunk);
	}

	public traverseFrustum(camera: FreeCamera): void {
		const prev = this.visibleLastFrame;
		this.visibleLastFrame = this.visibleThisFrame;
		this.visibleThisFrame = prev;
		this.visibleThisFrame.length = 0;
		this._visibleMeshes.length = 0;

		extractFrustumPlanes(camera, _scratchPlanes);

		const stack = _traverseStack;
		let top = 0;
		stack[0] = this.root;

		const visible = this.visibleThisFrame;
		const visibleMeshes = this._visibleMeshes;

		while (top >= 0) {
			const node = stack[top--];
			if (node.isEmpty) continue;

			const frustumResult = intersectsFrustum(node, _scratchPlanes);
			if (frustumResult === "outside") continue;

			if (frustumResult === "inside") {
				collectLeafInline(node, visible, visibleMeshes);
				continue;
			}

			if (node.isLeaf) {
				const ch = node.chunk;
				if (ch) {
					ch._octreeVisible = true;
					visible.push(ch);
					const mesh = ch.mesh;
					if (mesh) {
						mesh.isVisible = true;
						visibleMeshes.push(mesh);
					}
					const tMesh = ch.transparentMesh;
					if (tMesh) {
						tMesh.isVisible = true;
						visibleMeshes.push(tMesh);
					}
				}
				continue;
			}

			const children = node.children;
			if (children) {
				for (let i = 7; i >= 0; i--) {
					const child = children[i];
					if (child) {
						stack[++top] = child;
					}
				}
			}
		}

		for (let i = 0; i < this.visibleLastFrame.length; i++) {
			const chunk = this.visibleLastFrame[i]!;
			chunk._octreeVisible = false;
			const mesh = chunk.mesh;
			if (mesh) mesh.isVisible = false;
			const tMesh = chunk.transparentMesh;
			if (tMesh) tMesh.isVisible = false;
		}
	}

	public getVisibleMeshes(): Mesh[] {
		return this._visibleMeshes;
	}

	public *queryLoadedChunksInRadius(
		centerX: number,
		centerY: number,
		centerZ: number,
		horizontalRadius: number,
		verticalRadius: number,
	): IterableIterator<Chunk> {
		yield* this._queryRadius(
			this.root,
			centerX,
			centerY,
			centerZ,
			horizontalRadius,
			verticalRadius,
		);
	}

	private *_queryRadius(
		node: OctreeNode,
		centerX: number,
		centerY: number,
		centerZ: number,
		horizontalRadius: number,
		verticalRadius: number,
	): IterableIterator<Chunk> {
		if (node.isEmpty) return;

		if (
			!nodeOverlapsRadius(
				node,
				centerX,
				centerY,
				centerZ,
				horizontalRadius,
				verticalRadius,
			)
		)
			return;

		if (node.isLeaf) {
			if (node.chunk) yield node.chunk;
			return;
		}

		const children = node.children;
		if (children) {
			for (let i = 0; i < 8; i++) {
				const child = children[i];
				if (child)
					yield* this._queryRadius(
						child,
						centerX,
						centerY,
						centerZ,
						horizontalRadius,
						verticalRadius,
					);
			}
		}
	}

	private _insert(node: OctreeNode, chunk: Chunk): void {
		if (node.isLeaf) {
			node.chunk = chunk;
			node.isEmpty = false;
			this._propagateNonEmptyUp(node);
			return;
		}

		if (!node.children) {
			node.children = new Array(8);
		}

		const halfX = node.spanX >> 1;
		const halfY = node.spanY >> 1;
		const halfZ = node.spanZ >> 1;

		const cx = chunk.chunkX;
		const cy = chunk.chunkY;
		const cz = chunk.chunkZ;

		const ix = cx >= node.minX + halfX ? 1 : 0;
		const iy = cy >= node.minY + halfY ? 1 : 0;
		const iz = cz >= node.minZ + halfZ ? 1 : 0;
		const childIdx = ix + iy * 2 + iz * 4;

		let child = node.children[childIdx];
		if (!child) {
			child = new OctreeNode(
				node.minX + ix * halfX,
				node.minY + iy * halfY,
				node.minZ + iz * halfZ,
				halfX || 1,
				halfY || 1,
				halfZ || 1,
			);
			child.parent = node;
			node.children[childIdx] = child;
		}

		this._insert(child, chunk);
	}

	private _remove(node: OctreeNode, chunk: Chunk): void {
		if (node.isLeaf) {
			if (node.chunk === chunk) {
				node.chunk = null;
				node.isEmpty = true;
				this._propagateEmptyUp(node);
			}
			return;
		}

		if (!node.children) return;

		const halfX = node.spanX >> 1;
		const halfY = node.spanY >> 1;
		const halfZ = node.spanZ >> 1;

		const cx = chunk.chunkX;
		const cy = chunk.chunkY;
		const cz = chunk.chunkZ;

		const ix = cx >= node.minX + halfX ? 1 : 0;
		const iy = cy >= node.minY + halfY ? 1 : 0;
		const iz = cz >= node.minZ + halfZ ? 1 : 0;
		const childIdx = ix + iy * 2 + iz * 4;

		const child = node.children[childIdx];
		if (child) {
			this._remove(child, chunk);
		}
	}

	private _updateEmptyUp(node: OctreeNode, chunk: Chunk): void {
		if (node.isLeaf) {
			if (node.chunk === chunk) {
				node.isEmpty = chunk.isUniform && chunk.uniformBlockId === 0;
				this._propagateEmptyUp(node);
			}
			return;
		}

		if (!node.children) return;

		const halfX = node.spanX >> 1;
		const halfY = node.spanY >> 1;
		const halfZ = node.spanZ >> 1;

		const cx = chunk.chunkX;
		const cy = chunk.chunkY;
		const cz = chunk.chunkZ;

		const ix = cx >= node.minX + halfX ? 1 : 0;
		const iy = cy >= node.minY + halfY ? 1 : 0;
		const iz = cz >= node.minZ + halfZ ? 1 : 0;
		const childIdx = ix + iy * 2 + iz * 4;

		const child = node.children[childIdx];
		if (child) {
			this._updateEmptyUp(child, chunk);
		}
	}

	private _propagateNonEmptyUp(node: OctreeNode): void {
		let current: OctreeNode | null = node;
		while (current) {
			current.isEmpty = false;
			current = current.parent;
		}
	}

	private _propagateEmptyUp(node: OctreeNode): void {
		let current: OctreeNode | null = node;
		while (current) {
			if (current.isLeaf) {
				current = current.parent;
				continue;
			}
			const children = current.children;
			let allEmpty = true;
			if (children) {
				for (let i = 0; i < 8; i++) {
					const child = children[i];
					if (child && !child.isEmpty) {
						allEmpty = false;
						break;
					}
				}
			}
			current.isEmpty = allEmpty;
			if (!allEmpty) break;
			current = current.parent;
		}
	}
}
