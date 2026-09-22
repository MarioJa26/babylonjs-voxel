/**
 * GroupOctree — dynamic loose octree over merged 4×4×4 chunk groups (128³ blocks)
 * for hierarchical frustum culling.
 *
 * Babylon-free on purpose (like Lib/VoxelMath): the culler runs on the main
 * thread, but this module is also importable from workers and plain node tests.
 *
 * Design:
 * - Leaves hold MergedMeshGroup refs (the actual draw unit: 1 mesh per
 *   non-empty layer). Boat chunks are NOT inserted (they carry no world AABB
 *   and manage their own visibility — see ChunkMesher).
 * - Sparse top level: the world is unbounded (camera can travel anywhere), so
 *   space is tiled into aligned ROOT_CELL (1024³) cells, each holding an
 *   octree of depth MAX_DEPTH down to LEAF_SIZE (128³ == exactly one group).
 *   Roots live in a Map and are created/destroyed on demand — no giant empty
 *   tree, no rebalancing on stream.
 * - Alignment guarantee: every level size (1024/512/256/128) is a multiple of
 *   the group extent (128) and every node is aligned to its own size, so a
 *   grid-aligned group ALWAYS fits entirely inside exactly one child. No
 *   boundary straddling, no double-insert. Co-located groups that share the
 *   same grid cell but differ in lodBucket simply share the same leaf array.
 * - Query is callback-based and allocation-free: traverseFrustum() walks the
 *   tree with explicit stacks and yields (group, hint) where hint tells the
 *   caller whether the leaf already proved OUTSIDE / INSIDE, so per-group
 *   6-plane math can be skipped for whole subtrees.
 * - Eye fail-open: a node containing the camera is always classified
 *   INTERSECT (descend), mirroring the eyeInAABB guard in OcclusionCuller —
 *   the positive-vertex near-plane test can otherwise falsely cull the node
 *   the camera sits inside.
 */

import { CHUNK_SIZE } from "@/code/Lib/VoxelMath";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OCTREE_GROUP_SIZE = 4; // chunks per group side (mirrors MergedMeshManager GROUP_SIZE)
export const OCTREE_GROUP_EXTENT = OCTREE_GROUP_SIZE * CHUNK_SIZE; // 128 world units
export const OCTREE_LEAF_SIZE = OCTREE_GROUP_EXTENT; // leaf == exactly one group cell
export const OCTREE_ROOT_CELL_SIZE = 1024; // 8 groups per side per root
export const OCTREE_MAX_DEPTH = 3; // 1024 -> 512 -> 256 -> 128

/** Minimal shape the octree needs. MergedMeshGroup satisfies this structurally. */
export interface OctreeGroupLike {
	groupKey: number;
	gridX: number;
	gridY: number;
	gridZ: number;
}

/** Frustum hint delivered per visited group. Plain enum (not const enum) for isolatedModules safety. */
export enum FrustumHint {
	/** Some ancestor (or the leaf test) proved fully outside: caller may skip plane math. */
	OUTSIDE = 0,
	/** Some ancestor proved fully inside: caller may skip plane math (still apply range gate). */
	INSIDE = 1,
	/** Straddles the frustum: caller must run its own per-group AABB test. */
	INTERSECT = 2,
}

interface OctreeNode {
	minX: number;
	minY: number;
	minZ: number;
	size: number;
	depth: number;
	children: (OctreeNode | null)[] | null; // length 8 once subdivided
	groups: OctreeGroupLike[]; // populated only at leaf depth
	subtreeCount: number; // groups in this node + all descendants
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const _roots = new Map<string, OctreeNode>();
let _groupCount = 0;

export function getOctreeGroupCount(): number {
	return _groupCount;
}

export function getOctreeRootCount(): number {
	return _roots.size;
}

// ---------------------------------------------------------------------------
// AABB helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export function groupMinX(gridX: number): number {
	return gridX * OCTREE_GROUP_EXTENT;
}

export function groupMinY(gridY: number): number {
	return gridY * OCTREE_GROUP_EXTENT;
}

export function groupMinZ(gridZ: number): number {
	return gridZ * OCTREE_GROUP_EXTENT;
}

function rootKeyFor(rx: number, ry: number, rz: number): string {
	return `${rx},${ry},${rz}`;
}

function makeNode(
	minX: number,
	minY: number,
	minZ: number,
	size: number,
	depth: number,
): OctreeNode {
	return {
		minX,
		minY,
		minZ,
		size,
		depth,
		children: null,
		groups: [],
		subtreeCount: 0,
	};
}

function childIndexFor(
	minX: number,
	minY: number,
	minZ: number,
	half: number,
	x: number,
	y: number,
	z: number,
): number {
	let idx = 0;
	if (x >= minX + half) idx |= 1;
	if (y >= minY + half) idx |= 2;
	if (z >= minZ + half) idx |= 4;
	return idx;
}

/** Positive-vertex test: true when the AABB is fully outside at least one plane.
 *  Planes carry inward normals (frustum interior is n·x+d >= 0), so the
 *  outside proof needs the p-vertex (corner maximizing n·x). Verified against
 *  live @babylonjs/lite view-projection matrices (see tests/group-octree). */
export function aabbOutsidePlanes(
	minX: number,
	minY: number,
	minZ: number,
	maxX: number,
	maxY: number,
	maxZ: number,
	packed: Float32Array,
	margin: number,
): boolean {
	for (let p = 0; p < 6; p++) {
		const off = p * 4;
		const nx = packed[off];
		const ny = packed[off + 1];
		const nz = packed[off + 2];
		const d = packed[off + 3];
		const px = nx >= 0 ? maxX : minX;
		const py = ny >= 0 ? maxY : minY;
		const pz = nz >= 0 ? maxZ : minZ;
		if (nx * px + ny * py + nz * pz + d < -margin) return true;
	}
	return false;
}

/** Negative-vertex test: true only when the AABB is fully inside every plane. */
export function aabbInsidePlanes(
	minX: number,
	minY: number,
	minZ: number,
	maxX: number,
	maxY: number,
	maxZ: number,
	packed: Float32Array,
	margin: number,
): boolean {
	for (let p = 0; p < 6; p++) {
		const off = p * 4;
		const nx = packed[off];
		const ny = packed[off + 1];
		const nz = packed[off + 2];
		const d = packed[off + 3];
		const qx = nx >= 0 ? minX : maxX;
		const qy = ny >= 0 ? minY : maxY;
		const qz = nz >= 0 ? minZ : maxZ;
		if (nx * qx + ny * qy + nz * qz + d < -margin) return false;
	}
	return true;
}

function eyeInsideBox(
	minX: number,
	minY: number,
	minZ: number,
	maxX: number,
	maxY: number,
	maxZ: number,
	ex: number,
	ey: number,
	ez: number,
): boolean {
	return (
		ex >= minX &&
		ex <= maxX &&
		ey >= minY &&
		ey <= maxY &&
		ez >= minZ &&
		ez <= maxZ
	);
}

// ---------------------------------------------------------------------------
// Insert / remove
// ---------------------------------------------------------------------------

/**
 * Insert a group. Idempotent per groupKey: re-inserting the same groupKey
 * refreshes the stored ref instead of duplicating.
 */
export function octreeInsert(group: OctreeGroupLike): void {
	const minX = groupMinX(group.gridX);
	const minY = groupMinY(group.gridY);
	const minZ = groupMinZ(group.gridZ);

	const rx = Math.floor(minX / OCTREE_ROOT_CELL_SIZE);
	const ry = Math.floor(minY / OCTREE_ROOT_CELL_SIZE);
	const rz = Math.floor(minZ / OCTREE_ROOT_CELL_SIZE);
	const key = rootKeyFor(rx, ry, rz);

	let root = _roots.get(key);
	if (!root) {
		root = makeNode(
			rx * OCTREE_ROOT_CELL_SIZE,
			ry * OCTREE_ROOT_CELL_SIZE,
			rz * OCTREE_ROOT_CELL_SIZE,
			OCTREE_ROOT_CELL_SIZE,
			0,
		);
		_roots.set(key, root);
	}

	let node = root;
	node.subtreeCount++; // provisional; corrected below on duplicate re-insert
	const path: OctreeNode[] = [node];

	while (node.depth < OCTREE_MAX_DEPTH) {
		const half = node.size * 0.5;
		const ci = childIndexFor(
			node.minX,
			node.minY,
			node.minZ,
			half,
			minX,
			minY,
			minZ,
		);
		if (!node.children) {
			node.children = [null, null, null, null, null, null, null, null];
		}
		let child = node.children[ci];
		if (!child) {
			child = makeNode(
				node.minX + (ci & 1 ? half : 0),
				node.minY + (ci & 2 ? half : 0),
				node.minZ + (ci & 4 ? half : 0),
				half,
				node.depth + 1,
			);
			node.children[ci] = child;
		}
		node = child;
		node.subtreeCount++;
		path.push(node);
	}

	// Leaf: dedupe by groupKey (same grid cell, different lodBucket are
	// distinct groupKeys and correctly coexist).
	const leaf = node.groups;
	for (let i = 0; i < leaf.length; i++) {
		if (leaf[i].groupKey === group.groupKey) {
			leaf[i] = group;
			// Undo provisional increments — no new group was added.
			for (let k = 0; k < path.length; k++) path[k].subtreeCount--;
			return;
		}
	}
	leaf.push(group);
	_groupCount++;
}

/**
 * Remove a group. No-op when absent. Prunes empty branches and drops empty
 * roots so streaming unload cannot leak nodes.
 */
export function octreeRemove(group: OctreeGroupLike): void {
	const minX = groupMinX(group.gridX);
	const minY = groupMinY(group.gridY);
	const minZ = groupMinZ(group.gridZ);

	const rx = Math.floor(minX / OCTREE_ROOT_CELL_SIZE);
	const ry = Math.floor(minY / OCTREE_ROOT_CELL_SIZE);
	const rz = Math.floor(minZ / OCTREE_ROOT_CELL_SIZE);
	const key = rootKeyFor(rx, ry, rz);

	const root = _roots.get(key);
	if (!root) return;

	let node: OctreeNode = root;
	const path: OctreeNode[] = [root];

	while (node.depth < OCTREE_MAX_DEPTH) {
		const children = node.children;
		if (!children) return; // group was never inserted
		const half = node.size * 0.5;
		const ci = childIndexFor(
			node.minX,
			node.minY,
			node.minZ,
			half,
			minX,
			minY,
			minZ,
		);
		const child: OctreeNode | null = children[ci];
		if (!child) return;
		node = child;
		path.push(node);
	}

	const leaf = node.groups;
	let foundIdx = -1;
	for (let i = 0; i < leaf.length; i++) {
		if (leaf[i].groupKey === group.groupKey) {
			foundIdx = i;
			break;
		}
	}
	if (foundIdx < 0) return;

	// Swap-remove.
	leaf[foundIdx] = leaf[leaf.length - 1];
	leaf.length--;
	_groupCount--;

	for (let k = 0; k < path.length; k++) path[k].subtreeCount--;

	// Prune empty branches bottom-up (stop at root; root dropped from map).
	for (let k = path.length - 1; k >= 1; k--) {
		const childNode = path[k];
		const parent = path[k - 1];
		if (childNode.subtreeCount !== 0) break;
		if (!parent.children) break;
		const half = parent.size * 0.5;
		const ci = childIndexFor(
			parent.minX,
			parent.minY,
			parent.minZ,
			half,
			minX,
			minY,
			minZ,
		);
		parent.children[ci] = null;
		// Collapse the children array when all slots are empty.
		let anyLeft = false;
		for (let s = 0; s < 8; s++) {
			if (parent.children[s]) {
				anyLeft = true;
				break;
			}
		}
		if (!anyLeft) parent.children = null;
		else break; // siblings remain — higher levels are non-empty too
	}

	if (root.subtreeCount === 0) _roots.delete(key);
}

/** Drop the whole tree (world unload / disposeAll). */
export function octreeClear(): void {
	_roots.clear();
	_groupCount = 0;
}

/** Debug/validation: walk every stored group. */
export function octreeForEach(visit: (group: OctreeGroupLike) => void): void {
	for (const root of _roots.values()) {
		const stack: OctreeNode[] = [root];
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (node.depth === OCTREE_MAX_DEPTH) {
				for (let i = 0; i < node.groups.length; i++) visit(node.groups[i]);
			} else if (node.children) {
				for (let s = 0; s < 8; s++) {
					const c = node.children[s];
					if (c) stack.push(c);
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Frustum traversal
// ---------------------------------------------------------------------------

export interface OctreeTraverseStats {
	visitedGroups: number;
	culledSubtrees: number;
	insideFastPath: number;
}

// Module-level explicit stacks (no per-frame allocation).
const _travNodes: OctreeNode[] = [];
const _travHints: FrustumHint[] = [];
const _collectStack: OctreeNode[] = [];

/**
 * Hierarchical frustum traversal.
 *
 * Yields every stored group exactly once with a hint:
 * - OUTSIDE: an ancestor (or leaf) AABB proved fully outside — caller can
 *   hide without running plane math. Groups containing the eye never arrive
 *   with this hint (eye fail-open forces INTERSECT descent).
 * - INSIDE: an ancestor proved fully inside — caller can accept without plane
 *   math (range gate still applies).
 * - INTERSECT: caller must run its own per-group AABB test.
 */
export function traverseGroupOctree(
	packedPlanes: Float32Array,
	margin: number,
	eyeX: number,
	eyeY: number,
	eyeZ: number,
	visit: (group: OctreeGroupLike, hint: FrustumHint) => void,
	stats?: OctreeTraverseStats | null,
): void {
	let visited = 0;
	let culledSub = 0;
	let insideFast = 0;

	for (const root of _roots.values()) {
		const rMaxX = root.minX + root.size;
		const rMaxY = root.minY + root.size;
		const rMaxZ = root.minZ + root.size;

		let rootHint: FrustumHint;
		if (
			eyeInsideBox(
				root.minX,
				root.minY,
				root.minZ,
				rMaxX,
				rMaxY,
				rMaxZ,
				eyeX,
				eyeY,
				eyeZ,
			)
		) {
			rootHint = FrustumHint.INTERSECT;
		} else if (
			aabbOutsidePlanes(
				root.minX,
				root.minY,
				root.minZ,
				rMaxX,
				rMaxY,
				rMaxZ,
				packedPlanes,
				margin,
			)
		) {
			culledSub++;
			// Still must yield groups so the caller can hide them + keep HUD
			// stats consistent — but with OUTSIDE hint (no plane math, and the
			// caller may skip the BFS member scan for the bypass path).
			_collectStack.length = 0;
			_collectStack.push(root);
			while (_collectStack.length > 0) {
				const n = _collectStack.pop()!;
				if (n.depth === OCTREE_MAX_DEPTH) {
					for (let i = 0; i < n.groups.length; i++) {
						visited++;
						visit(n.groups[i], FrustumHint.OUTSIDE);
					}
				} else if (n.children) {
					for (let s = 0; s < 8; s++) {
						const c = n.children[s];
						if (c && c.subtreeCount > 0) _collectStack.push(c);
					}
				}
			}
			continue;
		} else if (
			aabbInsidePlanes(
				root.minX,
				root.minY,
				root.minZ,
				rMaxX,
				rMaxY,
				rMaxZ,
				packedPlanes,
				margin,
			)
		) {
			rootHint = FrustumHint.INSIDE;
		} else {
			rootHint = FrustumHint.INTERSECT;
		}

		_travNodes.length = 0;
		_travHints.length = 0;
		_travNodes.push(root);
		_travHints.push(rootHint);

		while (_travNodes.length > 0) {
			const node = _travNodes.pop()!;
			const hint = _travHints.pop()!;

			if (node.depth === OCTREE_MAX_DEPTH) {
				for (let i = 0; i < node.groups.length; i++) {
					const g = node.groups[i];
					visited++;
					if (hint === FrustumHint.INSIDE) {
						insideFast++;
						visit(g, FrustumHint.INSIDE);
					} else if (hint === FrustumHint.OUTSIDE) {
						// Ancestor proved outside and the eye is not inside
						// this subtree (eye forces INTERSECT) — yield directly.
						visit(g, FrustumHint.OUTSIDE);
					} else {
						// INTERSECT leaf: cheap per-group refine so the caller
						// only pays plane math for genuinely straddling groups.
						const gx0 = groupMinX(g.gridX);
						const gy0 = groupMinY(g.gridY);
						const gz0 = groupMinZ(g.gridZ);
						const gx1 = gx0 + OCTREE_GROUP_EXTENT;
						const gy1 = gy0 + OCTREE_GROUP_EXTENT;
						const gz1 = gz0 + OCTREE_GROUP_EXTENT;
						if (eyeInsideBox(gx0, gy0, gz0, gx1, gy1, gz1, eyeX, eyeY, eyeZ)) {
							visit(g, FrustumHint.INTERSECT);
						} else if (
							aabbOutsidePlanes(
								gx0,
								gy0,
								gz0,
								gx1,
								gy1,
								gz1,
								packedPlanes,
								margin,
							)
						) {
							visit(g, FrustumHint.OUTSIDE);
						} else if (
							aabbInsidePlanes(
								gx0,
								gy0,
								gz0,
								gx1,
								gy1,
								gz1,
								packedPlanes,
								margin,
							)
						) {
							insideFast++;
							visit(g, FrustumHint.INSIDE);
						} else {
							visit(g, FrustumHint.INTERSECT);
						}
					}
				}
				continue;
			}

			if (!node.children) continue;

			if (hint === FrustumHint.INSIDE || hint === FrustumHint.OUTSIDE) {
				// Whole subtree decided: collect groups without further plane
				// tests (INSIDE = accept, OUTSIDE = hide).
				_collectStack.length = 0;
				for (let s = 0; s < 8; s++) {
					const c = node.children[s];
					if (c && c.subtreeCount > 0) _collectStack.push(c);
				}
				while (_collectStack.length > 0) {
					const n = _collectStack.pop()!;
					if (n.depth === OCTREE_MAX_DEPTH) {
						for (let i = 0; i < n.groups.length; i++) {
							visited++;
							if (hint === FrustumHint.INSIDE) insideFast++;
							visit(n.groups[i], hint);
						}
					} else if (n.children) {
						for (let s = 0; s < 8; s++) {
							const c = n.children[s];
							if (c && c.subtreeCount > 0) _collectStack.push(c);
						}
					}
				}
				continue;
			}

			// INTERSECT: classify children.
			for (let s = 0; s < 8; s++) {
				const c = node.children[s];
				if (!c || c.subtreeCount === 0) continue;
				const cMaxX = c.minX + c.size;
				const cMaxY = c.minY + c.size;
				const cMaxZ = c.minZ + c.size;
				let ch: FrustumHint;
				if (
					eyeInsideBox(
						c.minX,
						c.minY,
						c.minZ,
						cMaxX,
						cMaxY,
						cMaxZ,
						eyeX,
						eyeY,
						eyeZ,
					)
				) {
					ch = FrustumHint.INTERSECT;
				} else if (
					aabbOutsidePlanes(
						c.minX,
						c.minY,
						c.minZ,
						cMaxX,
						cMaxY,
						cMaxZ,
						packedPlanes,
						margin,
					)
				) {
					// Push as OUTSIDE leaf-walk: children pushed with OUTSIDE
					// hint hit the fast yield path below without re-testing.
					ch = FrustumHint.OUTSIDE;
				} else if (
					aabbInsidePlanes(
						c.minX,
						c.minY,
						c.minZ,
						cMaxX,
						cMaxY,
						cMaxZ,
						packedPlanes,
						margin,
					)
				) {
					ch = FrustumHint.INSIDE;
				} else {
					ch = FrustumHint.INTERSECT;
				}
				_travNodes.push(c);
				_travHints.push(ch);
			}
		}
	}

	if (stats) {
		stats.visitedGroups = visited;
		stats.culledSubtrees = culledSub;
		stats.insideFastPath = insideFast;
	}
}
