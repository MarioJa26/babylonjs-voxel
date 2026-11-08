/**
 * GroupOctree: dynamic loose octree over merged 4x4x4 chunk groups.
 *
 * The world is split into sparse 1024-unit root cells. Each root contains an
 * octree whose leaves correspond exactly to one merged terrain-group cell.
 *
 * This module intentionally has no Babylon.js dependency.
 */

import { CHUNK_SIZE } from "@/code/Lib/VoxelMath";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OCTREE_GROUP_SIZE = 4;
export const OCTREE_GROUP_EXTENT = OCTREE_GROUP_SIZE * CHUNK_SIZE;

export const OCTREE_LEAF_SIZE = OCTREE_GROUP_EXTENT;
export const OCTREE_ROOT_CELL_SIZE = 1024;
export const OCTREE_MAX_DEPTH = 3;

const CHILD_COUNT = 8;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OctreeGroupLike {
	groupKey: number;
	gridX: number;
	gridY: number;
	gridZ: number;
}

export enum FrustumHint {
	OUTSIDE = 0,
	INSIDE = 1,
	INTERSECT = 2,
}

export interface OctreeTraverseStats {
	visitedGroups: number;
	culledSubtrees: number;
	insideFastPath: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface OctreeNode {
	minX: number;
	minY: number;
	minZ: number;

	size: number;
	depth: number;

	children: (OctreeNode | null)[] | null;
	groups: OctreeGroupLike[];

	subtreeCount: number;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const _roots = new Map<string, OctreeNode>();

let _groupCount = 0;

/*
 * Traversal stacks are shared to avoid per-frame allocations. Reentrant
 * traversal is rejected because nested traversal would corrupt these stacks.
 */
const _traversalStack: OctreeNode[] = [];
const _collectStack: OctreeNode[] = [];

let _traversalActive = false;

// ---------------------------------------------------------------------------
// Public counters
// ---------------------------------------------------------------------------

export function getOctreeGroupCount(): number {
	return _groupCount;
}

export function getOctreeRootCount(): number {
	return _roots.size;
}

// ---------------------------------------------------------------------------
// Coordinate helpers
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

function rootKeyFor(rootX: number, rootY: number, rootZ: number): string {
	return `${rootX},${rootY},${rootZ}`;
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
	let index = 0;

	if (x >= minX + half) {
		index |= 1;
	}

	if (y >= minY + half) {
		index |= 2;
	}

	if (z >= minZ + half) {
		index |= 4;
	}

	return index;
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

function createChildren(): (OctreeNode | null)[] {
	return [null, null, null, null, null, null, null, null];
}

// ---------------------------------------------------------------------------
// AABB helpers
// ---------------------------------------------------------------------------

function aabbContainsEye(
	minX: number,
	minY: number,
	minZ: number,
	maxX: number,
	maxY: number,
	maxZ: number,
	eyeX: number,
	eyeY: number,
	eyeZ: number,
): boolean {
	return (
		eyeX >= minX &&
		eyeX <= maxX &&
		eyeY >= minY &&
		eyeY <= maxY &&
		eyeZ >= minZ &&
		eyeZ <= maxZ
	);
}

function nodeContainsEye(
	node: OctreeNode,
	eyeX: number,
	eyeY: number,
	eyeZ: number,
): boolean {
	return (
		eyeX >= node.minX &&
		eyeX <= node.minX + node.size &&
		eyeY >= node.minY &&
		eyeY <= node.minY + node.size &&
		eyeZ >= node.minZ &&
		eyeZ <= node.minZ + node.size
	);
}

/**
 * Classifies an AABB against packed, normalized frustum planes.
 *
 * The frustum interior is n*x + d >= 0.
 */
function classifyAabbAgainstPlanes(
	minX: number,
	minY: number,
	minZ: number,
	maxX: number,
	maxY: number,
	maxZ: number,
	packed: Float32Array,
	negativeMargin: number,
): FrustumHint {
	let fullyInside = true;

	for (let offset = 0; offset < 24; offset += 4) {
		const nx = packed[offset];
		const ny = packed[offset + 1];
		const nz = packed[offset + 2];
		const d = packed[offset + 3];

		const positiveX = nx >= 0 ? maxX : minX;
		const positiveY = ny >= 0 ? maxY : minY;
		const positiveZ = nz >= 0 ? maxZ : minZ;

		if (nx * positiveX + ny * positiveY + nz * positiveZ + d < negativeMargin) {
			return FrustumHint.OUTSIDE;
		}

		if (fullyInside) {
			const negativeX = nx >= 0 ? minX : maxX;
			const negativeY = ny >= 0 ? minY : maxY;
			const negativeZ = nz >= 0 ? minZ : maxZ;

			if (
				nx * negativeX + ny * negativeY + nz * negativeZ + d <
				negativeMargin
			) {
				fullyInside = false;
			}
		}
	}

	return fullyInside ? FrustumHint.INSIDE : FrustumHint.INTERSECT;
}

function classifyNode(
	node: OctreeNode,
	packedPlanes: Float32Array,
	negativeMargin: number,
	eyeX: number,
	eyeY: number,
	eyeZ: number,
): FrustumHint {
	if (nodeContainsEye(node, eyeX, eyeY, eyeZ)) {
		return FrustumHint.INTERSECT;
	}

	const maxX = node.minX + node.size;
	const maxY = node.minY + node.size;
	const maxZ = node.minZ + node.size;

	return classifyAabbAgainstPlanes(
		node.minX,
		node.minY,
		node.minZ,
		maxX,
		maxY,
		maxZ,
		packedPlanes,
		negativeMargin,
	);
}

/**
 * Returns true when the AABB is fully outside at least one plane.
 */
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
	const negativeMargin = -margin;

	for (let offset = 0; offset < 24; offset += 4) {
		const nx = packed[offset];
		const ny = packed[offset + 1];
		const nz = packed[offset + 2];

		const positiveX = nx >= 0 ? maxX : minX;
		const positiveY = ny >= 0 ? maxY : minY;
		const positiveZ = nz >= 0 ? maxZ : minZ;

		if (
			nx * positiveX + ny * positiveY + nz * positiveZ + packed[offset + 3] <
			negativeMargin
		) {
			return true;
		}
	}

	return false;
}

/**
 * Returns true only when the AABB is fully inside every plane.
 */
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
	const negativeMargin = -margin;

	for (let offset = 0; offset < 24; offset += 4) {
		const nx = packed[offset];
		const ny = packed[offset + 1];
		const nz = packed[offset + 2];

		const negativeX = nx >= 0 ? minX : maxX;
		const negativeY = ny >= 0 ? minY : maxY;
		const negativeZ = nz >= 0 ? minZ : maxZ;

		if (
			nx * negativeX + ny * negativeY + nz * negativeZ + packed[offset + 3] <
			negativeMargin
		) {
			return false;
		}
	}

	return true;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

/**
 * Inserts a group.
 *
 * Re-inserting the same groupKey in the same group cell refreshes the stored
 * reference without changing subtree counts.
 */
export function octreeInsert(group: OctreeGroupLike): void {
	const minX = group.gridX * OCTREE_GROUP_EXTENT;
	const minY = group.gridY * OCTREE_GROUP_EXTENT;
	const minZ = group.gridZ * OCTREE_GROUP_EXTENT;

	const rootX = Math.floor(minX / OCTREE_ROOT_CELL_SIZE);

	const rootY = Math.floor(minY / OCTREE_ROOT_CELL_SIZE);

	const rootZ = Math.floor(minZ / OCTREE_ROOT_CELL_SIZE);

	const rootKey = rootKeyFor(rootX, rootY, rootZ);

	let root = _roots.get(rootKey);

	if (root === undefined) {
		root = makeNode(
			rootX * OCTREE_ROOT_CELL_SIZE,
			rootY * OCTREE_ROOT_CELL_SIZE,
			rootZ * OCTREE_ROOT_CELL_SIZE,
			OCTREE_ROOT_CELL_SIZE,
			0,
		);

		_roots.set(rootKey, root);
	}

	let node = root;

	/*
	 * Maximum path length is four nodes:
	 * root, depth 1, depth 2, leaf.
	 */
	const path0 = node;
	let path1: OctreeNode | null = null;
	let path2: OctreeNode | null = null;
	let path3: OctreeNode | null = null;

	while (node.depth < OCTREE_MAX_DEPTH) {
		const half = node.size * 0.5;

		const childIndex = childIndexFor(
			node.minX,
			node.minY,
			node.minZ,
			half,
			minX,
			minY,
			minZ,
		);

		let children = node.children;

		if (children === null) {
			children = createChildren();
			node.children = children;
		}

		let child = children[childIndex];

		if (child === null) {
			child = makeNode(
				node.minX + ((childIndex & 1) !== 0 ? half : 0),
				node.minY + ((childIndex & 2) !== 0 ? half : 0),
				node.minZ + ((childIndex & 4) !== 0 ? half : 0),
				half,
				node.depth + 1,
			);

			children[childIndex] = child;
		}

		node = child;

		if (node.depth === 1) {
			path1 = node;
		} else if (node.depth === 2) {
			path2 = node;
		} else {
			path3 = node;
		}
	}

	const groups = node.groups;

	for (let index = 0; index < groups.length; index++) {
		if (groups[index].groupKey === group.groupKey) {
			groups[index] = group;
			return;
		}
	}

	groups.push(group);

	path0.subtreeCount++;

	if (path1 !== null) {
		path1.subtreeCount++;
	}

	if (path2 !== null) {
		path2.subtreeCount++;
	}

	if (path3 !== null) {
		path3.subtreeCount++;
	}

	_groupCount++;
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/**
 * Removes a group and prunes empty branches.
 */
export function octreeRemove(group: OctreeGroupLike): void {
	const minX = group.gridX * OCTREE_GROUP_EXTENT;
	const minY = group.gridY * OCTREE_GROUP_EXTENT;
	const minZ = group.gridZ * OCTREE_GROUP_EXTENT;

	const rootX = Math.floor(minX / OCTREE_ROOT_CELL_SIZE);

	const rootY = Math.floor(minY / OCTREE_ROOT_CELL_SIZE);

	const rootZ = Math.floor(minZ / OCTREE_ROOT_CELL_SIZE);

	const rootKey = rootKeyFor(rootX, rootY, rootZ);
	const root = _roots.get(rootKey);

	if (root === undefined) {
		return;
	}

	let node = root;

	const pathNodes: OctreeNode[] = [root];
	const pathIndices: number[] = [];

	while (node.depth < OCTREE_MAX_DEPTH) {
		const children = node.children;

		if (children === null) {
			return;
		}

		const half = node.size * 0.5;

		const childIndex = childIndexFor(
			node.minX,
			node.minY,
			node.minZ,
			half,
			minX,
			minY,
			minZ,
		);

		const child = children[childIndex];

		if (child === null) {
			return;
		}

		pathIndices.push(childIndex);
		pathNodes.push(child);
		node = child;
	}

	const groups = node.groups;
	let foundIndex = -1;

	for (let index = 0; index < groups.length; index++) {
		if (groups[index].groupKey === group.groupKey) {
			foundIndex = index;
			break;
		}
	}

	if (foundIndex < 0) {
		return;
	}

	const finalIndex = groups.length - 1;

	if (foundIndex !== finalIndex) {
		groups[foundIndex] = groups[finalIndex];
	}

	groups.pop();
	_groupCount--;

	for (let index = 0; index < pathNodes.length; index++) {
		pathNodes[index].subtreeCount--;
	}

	/*
	 * Prune from the leaf toward the root. The child index is retained from
	 * the initial descent, avoiding repeated coordinate classification.
	 */
	for (let pathIndex = pathNodes.length - 1; pathIndex >= 1; pathIndex--) {
		const child = pathNodes[pathIndex];

		if (child.subtreeCount !== 0) {
			break;
		}

		const parent = pathNodes[pathIndex - 1];
		const children = parent.children;

		if (children === null) {
			break;
		}

		children[pathIndices[pathIndex - 1]] = null;

		let hasChildren = false;

		for (let childIndex = 0; childIndex < CHILD_COUNT; childIndex++) {
			if (children[childIndex] !== null) {
				hasChildren = true;
				break;
			}
		}

		if (hasChildren) {
			break;
		}

		parent.children = null;
	}

	if (root.subtreeCount === 0) {
		_roots.delete(rootKey);
	}
}

// ---------------------------------------------------------------------------
// Lifecycle and validation
// ---------------------------------------------------------------------------

export function octreeClear(): void {
	_roots.clear();
	_groupCount = 0;

	_traversalStack.length = 0;
	_collectStack.length = 0;
}

export function octreeForEach(visit: (group: OctreeGroupLike) => void): void {
	const stack = _collectStack;

	if (_traversalActive) {
		throw new Error("GroupOctree traversal is not reentrant.");
	}

	_traversalActive = true;
	stack.length = 0;

	try {
		for (const root of _roots.values()) {
			stack.push(root);

			while (stack.length !== 0) {
				const node = stack.pop();

				if (node === undefined) {
					break;
				}

				if (node.depth === OCTREE_MAX_DEPTH) {
					const groups = node.groups;

					for (let index = 0; index < groups.length; index++) {
						visit(groups[index]);
					}

					continue;
				}

				const children = node.children;

				if (children === null) {
					continue;
				}

				for (let index = 0; index < CHILD_COUNT; index++) {
					const child = children[index];

					if (child !== null && child.subtreeCount !== 0) {
						stack.push(child);
					}
				}
			}
		}
	} finally {
		stack.length = 0;
		_traversalActive = false;
	}
}

// ---------------------------------------------------------------------------
// Classified subtree emission
// ---------------------------------------------------------------------------

function visitClassifiedSubtree(
	root: OctreeNode,
	hint: FrustumHint,
	visit: (group: OctreeGroupLike, hint: FrustumHint) => void,
): number {
	const stack = _collectStack;

	stack.length = 0;
	stack.push(root);

	while (stack.length !== 0) {
		const node = stack.pop();

		if (node === undefined) {
			break;
		}

		if (node.depth === OCTREE_MAX_DEPTH) {
			const groups = node.groups;

			for (let index = 0; index < groups.length; index++) {
				visit(groups[index], hint);
			}

			continue;
		}

		const children = node.children;

		if (children === null) {
			continue;
		}

		for (let index = 0; index < CHILD_COUNT; index++) {
			const child = children[index];

			if (child !== null && child.subtreeCount !== 0) {
				stack.push(child);
			}
		}
	}

	return root.subtreeCount;
}

// ---------------------------------------------------------------------------
// Frustum traversal
// ---------------------------------------------------------------------------

export function traverseGroupOctree(
	packedPlanes: Float32Array,
	margin: number,
	eyeX: number,
	eyeY: number,
	eyeZ: number,
	visit: (group: OctreeGroupLike, hint: FrustumHint) => void,
	stats?: OctreeTraverseStats | null,
): void {
	if (_traversalActive) {
		throw new Error("GroupOctree traversal is not reentrant.");
	}

	let visitedGroups = 0;
	let culledSubtrees = 0;
	let insideFastPath = 0;

	const negativeMargin = -margin;
	const stack = _traversalStack;

	_traversalActive = true;
	stack.length = 0;
	_collectStack.length = 0;

	try {
		for (const root of _roots.values()) {
			if (root.subtreeCount === 0) {
				continue;
			}

			const rootHint = classifyNode(
				root,
				packedPlanes,
				negativeMargin,
				eyeX,
				eyeY,
				eyeZ,
			);

			if (rootHint === FrustumHint.OUTSIDE) {
				culledSubtrees++;

				visitedGroups += visitClassifiedSubtree(
					root,
					FrustumHint.OUTSIDE,
					visit,
				);

				continue;
			}

			if (rootHint === FrustumHint.INSIDE) {
				const emitted = visitClassifiedSubtree(root, FrustumHint.INSIDE, visit);

				visitedGroups += emitted;
				insideFastPath += emitted;
				continue;
			}

			stack.push(root);

			while (stack.length !== 0) {
				const node = stack.pop();

				if (node === undefined) {
					break;
				}

				if (node.depth === OCTREE_MAX_DEPTH) {
					const groups = node.groups;
					const count = groups.length;

					visitedGroups += count;

					for (let index = 0; index < count; index++) {
						visit(groups[index], FrustumHint.INTERSECT);
					}

					continue;
				}

				const children = node.children;

				if (children === null) {
					continue;
				}

				for (let index = 0; index < CHILD_COUNT; index++) {
					const child = children[index];

					if (child === null || child.subtreeCount === 0) {
						continue;
					}

					const childHint = classifyNode(
						child,
						packedPlanes,
						negativeMargin,
						eyeX,
						eyeY,
						eyeZ,
					);

					if (childHint === FrustumHint.INTERSECT) {
						stack.push(child);
						continue;
					}

					if (childHint === FrustumHint.OUTSIDE) {
						culledSubtrees++;
					} else {
						insideFastPath += child.subtreeCount;
					}

					visitedGroups += visitClassifiedSubtree(child, childHint, visit);
				}
			}
		}
	} finally {
		stack.length = 0;
		_collectStack.length = 0;
		_traversalActive = false;
	}

	if (stats !== undefined && stats !== null) {
		stats.visitedGroups = visitedGroups;
		stats.culledSubtrees = culledSubtrees;
		stats.insideFastPath = insideFastPath;
	}
}
