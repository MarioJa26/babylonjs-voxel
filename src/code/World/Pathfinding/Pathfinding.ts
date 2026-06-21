import { getBlockByWorldCoords } from "../Chunk/ChunkLoadingSystem";
import {
	BlockType,
	isCollidableBlock,
	isPassThroughBlock,
} from "../Texture/BlockType";

export const enum PathNodeKind {
	Land = 0,
	Water = 1,
}

export interface PathWaypoint {
	x: number;
	z: number;
	groundY: number;
	kind: PathNodeKind;
}

interface AStarNode {
	x: number;
	z: number;
	groundY: number;
	kind: PathNodeKind;
	g: number;
	h: number;
	f: number;
	parent: AStarNode | null;
}

interface SurfaceResult {
	groundY: number;
	cost: number;
	kind: PathNodeKind;
}

const DIRS: [number, number][] = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
];

// --- Headroom clearance check ---

function hasClearance(
	x: number,
	z: number,
	groundY: number,
	headroom: number,
	allowWater: boolean,
): boolean {
	for (let y = 1; y <= headroom; y++) {
		const block = getBlockByWorldCoords(x, groundY + y, z);
		if (!isPassThroughBlock(block)) {
			return false;
		}
		if (!allowWater && block === BlockType.Water) {
			return false;
		}
	}
	return true;
}

// --- Water surface detection ---

function findWaterSurface(
	x: number,
	z: number,
	startY: number,
	searchUp: number,
	searchDown: number,
): SurfaceResult | null {
	for (let dy = searchUp; dy >= -searchDown; dy--) {
		const y = startY + dy;
		const block = getBlockByWorldCoords(x, y, z);
		if (block !== BlockType.Water) continue;
		const above = getBlockByWorldCoords(x, y + 1, z);
		if (above !== BlockType.Water && isPassThroughBlock(above)) {
			const heightCost = dy > 0 ? dy * 4 : -dy;
			return {
				groundY: y,
				cost: 4 + heightCost,
				kind: PathNodeKind.Water,
			};
		}
	}
	return null;
}

// --- Surface scanning ---

export function findSurface(
	x: number,
	z: number,
	startGroundY: number,
	stepUp: number,
	stepDown: number,
	headroom: number,
	allowWater = true,
): SurfaceResult | null {
	for (let dy = stepUp; dy >= -stepDown; dy--) {
		const groundY = startGroundY + dy;
		const groundBlock = getBlockByWorldCoords(x, groundY, z);
		const heightCost = dy > 0 ? dy * 5 : -dy;
		if (
			isCollidableBlock(groundBlock) &&
			hasClearance(x, z, groundY, headroom, false)
		) {
			return {
				groundY,
				cost: 1 + heightCost,
				kind: PathNodeKind.Land,
			};
		}
	}
	if (!allowWater) return null;
	return findWaterSurface(x, z, startGroundY, stepUp + 4, stepDown + 8);
}

// --- Land surface lookup (for shore targeting) ---

export function findLandSurface(
	x: number,
	z: number,
	startY: number,
	headroom: number,
): { groundY: number } | null {
	for (let dy = 5; dy >= -5; dy--) {
		const groundY = startY + dy;
		if (!isCollidableBlock(getBlockByWorldCoords(x, groundY, z))) continue;
		if (hasClearance(x, z, groundY, headroom, false)) return { groundY };
	}
	return null;
}

export function isLandAt(
	x: number,
	z: number,
	startY: number,
	headroom: number,
): boolean {
	return findLandSurface(x, z, startY, headroom) !== null;
}

// --- AStar heap (specialized, no closures) ---

class AStarHeap {
	private items: AStarNode[] = [];

	get size(): number {
		return this.items.length;
	}

	clear(): void {
		this.items.length = 0;
	}

	push(item: AStarNode): void {
		const items = this.items;
		items.push(item);
		let idx = items.length - 1;
		while (idx > 0) {
			const parent = (idx - 1) >> 1;
			if (items[idx].f >= items[parent].f) break;
			const tmp = items[idx];
			items[idx] = items[parent];
			items[parent] = tmp;
			idx = parent;
		}
	}

	pop(): AStarNode | undefined {
		const items = this.items;
		if (items.length === 0) return undefined;
		const top = items[0];
		const last = items.pop()!;
		if (items.length > 0) {
			items[0] = last;
			let idx = 0;
			const len = items.length;
			while (true) {
				let smallest = idx;
				const left = (idx << 1) + 1;
				const right = left + 1;
				if (left < len && items[left].f < items[smallest].f) {
					smallest = left;
				}
				if (right < len && items[right].f < items[smallest].f) {
					smallest = right;
				}
				if (smallest === idx) break;
				const tmp = items[idx];
				items[idx] = items[smallest];
				items[smallest] = tmp;
				idx = smallest;
			}
		}
		return top;
	}
}

// --- Numeric node key (FNV-1a) ---

function nodeKey(x: number, z: number, y: number, kind: PathNodeKind): number {
	let h = 2166136261;
	h ^= x | 0;
	h = Math.imul(h, 16777619);
	h ^= z | 0;
	h = Math.imul(h, 16777619);
	h ^= y | 0;
	h = Math.imul(h, 16777619);
	h ^= kind;
	h = Math.imul(h, 16777619);
	return h >>> 0;
}

// --- Node pool ---

const NODE_POOL: AStarNode[] = [];
const USED_NODES: AStarNode[] = [];
const MAX_NODE_POOL_SIZE = 4096;

function allocNode(
	x: number,
	z: number,
	groundY: number,
	kind: PathNodeKind,
	g: number,
	h: number,
	parent: AStarNode | null,
): AStarNode {
	const node = NODE_POOL.pop() ?? {
		x: 0,
		z: 0,
		groundY: 0,
		kind: PathNodeKind.Land,
		g: 0,
		h: 0,
		f: 0,
		parent: null,
	};
	node.x = x;
	node.z = z;
	node.groundY = groundY;
	node.kind = kind;
	node.g = g;
	node.h = h;
	node.f = g + h;
	node.parent = parent;
	USED_NODES.push(node);
	return node;
}

function releaseUsedNodes(): void {
	for (let i = 0; i < USED_NODES.length; i++) {
		const node = USED_NODES[i];
		node.parent = null;
		if (NODE_POOL.length < MAX_NODE_POOL_SIZE) {
			NODE_POOL.push(node);
		}
	}
	USED_NODES.length = 0;
}

// --- Shared state for findPathInto ---

const SHARED_OPEN_HEAP = new AStarHeap();
const SHARED_CLOSED = new Map<number, number>();

// --- Path reconstruction (no reverse/slice/shift) ---

function buildPathInto(outPath: PathWaypoint[], endNode: AStarNode): void {
	let count = 0;
	let node: AStarNode | null = endNode;
	while (node) {
		count++;
		node = node.parent;
	}

	const waypointCount = Math.max(0, count - 1);
	outPath.length = waypointCount;

	node = endNode;
	for (let i = waypointCount - 1; i >= 0; i--) {
		let wp = outPath[i];
		if (!wp) {
			wp = {
				x: 0,
				z: 0,
				groundY: 0,
				kind: PathNodeKind.Land,
			};
			outPath[i] = wp;
		}
		wp.x = node!.x;
		wp.z = node!.z;
		wp.groundY = node!.groundY;
		wp.kind = node!.kind;
		node = node!.parent;
	}
}

// --- findPathInto (replaces findPath) ---
// Not reentrant. Uses shared temporary state; must not be called
// concurrently or recursively.

export function findPathInto(
	outPath: PathWaypoint[],
	startX: number,
	startZ: number,
	startGroundY: number,
	targetX: number,
	targetZ: number,
	headroom: number,
	maxExpansions = 300,
	requiredTargetGroundY?: number,
): boolean {
	outPath.length = 0;

	const targetSurface =
		requiredTargetGroundY !== undefined
			? {
					groundY: requiredTargetGroundY,
					cost: 1,
					kind: PathNodeKind.Land,
				}
			: findSurface(targetX, targetZ, startGroundY, 5, 3, headroom, true);
	if (!targetSurface) return false;

	const startSurface = findSurface(
		startX,
		startZ,
		startGroundY,
		3,
		8,
		headroom,
		true,
	) ?? {
		groundY: startGroundY,
		cost: 1,
		kind: PathNodeKind.Land,
	};

	const open = SHARED_OPEN_HEAP;
	const closed = SHARED_CLOSED;
	open.clear();
	closed.clear();
	USED_NODES.length = 0;

	let success = false;
	try {
		const startH = Math.abs(startX - targetX) + Math.abs(startZ - targetZ);
		const startNode = allocNode(
			startX,
			startZ,
			startSurface.groundY,
			startSurface.kind,
			0,
			startH,
			null,
		);
		open.push(startNode);
		closed.set(
			nodeKey(startX, startZ, startSurface.groundY, startSurface.kind),
			0,
		);

		let expansions = 0;
		while (open.size > 0 && expansions < maxExpansions) {
			const current = open.pop()!;
			expansions++;

			if (
				current.x === targetX &&
				current.z === targetZ &&
				(requiredTargetGroundY === undefined ||
					current.groundY === requiredTargetGroundY)
			) {
				buildPathInto(outPath, current);
				success = outPath.length > 0;
				return success;
			}

			for (let i = 0; i < DIRS.length; i++) {
				const dir = DIRS[i];
				const nx = current.x + dir[0];
				const nz = current.z + dir[1];

				const surface = findSurface(
					nx,
					nz,
					current.groundY,
					current.kind === PathNodeKind.Water ? 3 : 1,
					current.kind === PathNodeKind.Water ? 6 : 1,
					headroom,
					true,
				);
				if (!surface) continue;

				let moveCost = surface.cost;
				if (surface.kind === PathNodeKind.Water) {
					moveCost += 6;
				}
				if (
					current.kind === PathNodeKind.Land &&
					surface.kind === PathNodeKind.Water
				) {
					moveCost += 8;
				}
				if (
					current.kind === PathNodeKind.Water &&
					surface.kind === PathNodeKind.Land
				) {
					moveCost -= 3;
				}

				const tentativeG = current.g + moveCost;
				const key = nodeKey(nx, nz, surface.groundY, surface.kind);
				const best = closed.get(key);
				if (best !== undefined && best <= tentativeG) continue;

				const h = Math.abs(nx - targetX) + Math.abs(nz - targetZ);
				const nextNode = allocNode(
					nx,
					nz,
					surface.groundY,
					surface.kind,
					tentativeG,
					h,
					current,
				);
				open.push(nextNode);
				closed.set(key, tentativeG);
			}
		}

		return false;
	} finally {
		open.clear();
		closed.clear();
		releaseUsedNodes();
		if (!success) {
			outPath.length = 0;
		}
	}
}
