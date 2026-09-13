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
	result: SurfaceResult,
): SurfaceResult | null {
	for (let dy = searchUp; dy >= -searchDown; dy--) {
		const y = startY + dy;
		const block = getBlockByWorldCoords(x, y, z);
		if (block !== BlockType.Water) continue;
		const above = getBlockByWorldCoords(x, y + 1, z);
		if (above !== BlockType.Water && isPassThroughBlock(above)) {
			const heightCost = dy > 0 ? dy * 4 : -dy;
			result.groundY = y;
			result.cost = 4 + heightCost;
			result.kind = PathNodeKind.Water;
			return result;
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
	result?: SurfaceResult,
): SurfaceResult | null {
	const out: SurfaceResult = result ?? {
		groundY: 0,
		cost: 0,
		kind: PathNodeKind.Land,
	};
	for (let dy = stepUp; dy >= -stepDown; dy--) {
		const groundY = startGroundY + dy;
		const groundBlock = getBlockByWorldCoords(x, groundY, z);
		const heightCost = dy > 0 ? dy * 5 : -dy;
		if (
			isCollidableBlock(groundBlock) &&
			hasClearance(x, z, groundY, headroom, false)
		) {
			out.groundY = groundY;
			out.cost = 1 + heightCost;
			out.kind = PathNodeKind.Land;
			return out;
		}
	}
	if (!allowWater) return null;
	return findWaterSurface(x, z, startGroundY, stepUp + 4, stepDown + 8, out);
}

// --- Land surface lookup (for shore targeting) ---

export function findLandSurface(
	x: number,
	z: number,
	startY: number,
	headroom: number,
	result?: { groundY: number },
): { groundY: number } | null {
	const out = result ?? { groundY: 0 };
	for (let dy = 5; dy >= -5; dy--) {
		const groundY = startY + dy;
		if (!isCollidableBlock(getBlockByWorldCoords(x, groundY, z))) continue;
		if (hasClearance(x, z, groundY, headroom, false)) {
			out.groundY = groundY;
			return out;
		}
	}
	return null;
}

export function isLandAt(
	x: number,
	z: number,
	startY: number,
	headroom: number,
): boolean {
	return findLandSurface(x, z, startY, headroom, LAND_SCRATCH) !== null;
}

// --- A* storage (flat SoA arrays) ---
//
// Node records live in parallel typed arrays addressed by node index; the
// heap stores indices and compares nodeF directly — no pointer-chasing, no
// per-node objects, nothing to pool or release. The closed set is an
// open-addressed table whose entries are node indices compared by FULL
// identity (x, z, groundY, kind), so distinct nodes can never alias through
// a hash collision (the old FNV-hash-keyed Map compared hashes only).
//
// Worst case: one start node + 4 neighbors per expansion. With the global
// expansion budget (PATHFINDING_EXPANSION_BUDGET) capping expansions per
// window, NODE_CAPACITY covers any single search with wide margin; hitting
// it aborts the search cleanly (caller retries next tick, same as budget
// exhaustion).
const NODE_CAPACITY = 8192;
const TABLE_CAPACITY = 16384; // power of two
const TABLE_MASK = TABLE_CAPACITY - 1;

const nodeX = new Int32Array(NODE_CAPACITY);
const nodeZ = new Int32Array(NODE_CAPACITY);
const nodeY = new Int32Array(NODE_CAPACITY);
const nodeKind = new Int32Array(NODE_CAPACITY);
const nodeG = new Float64Array(NODE_CAPACITY);
const nodeF = new Float64Array(NODE_CAPACITY);
const nodeParent = new Int32Array(NODE_CAPACITY);

const heapItems = new Int32Array(NODE_CAPACITY);
let heapSize = 0;

const closedTable = new Int32Array(TABLE_CAPACITY); // nodeId + 1, 0 = empty

function hashIdentity(
	x: number,
	z: number,
	groundY: number,
	kind: number,
): number {
	let h = 2166136261;
	h ^= x;
	h = Math.imul(h, 16777619);
	h ^= z;
	h = Math.imul(h, 16777619);
	h ^= groundY;
	h = Math.imul(h, 16777619);
	h ^= kind;
	h = Math.imul(h, 16777619);
	return h >>> 0;
}

/** Append a node record; returns its index. Caller guards NODE_CAPACITY. */
function allocNodeIndex(
	x: number,
	z: number,
	groundY: number,
	kind: number,
	g: number,
	h: number,
	parent: number,
): number {
	const id = _nodeCursor;
	nodeX[id] = x;
	nodeZ[id] = z;
	nodeY[id] = groundY;
	nodeKind[id] = kind;
	nodeG[id] = g;
	nodeF[id] = g + h;
	nodeParent[id] = parent;
	_nodeCursor++;
	return id;
}

let _nodeCursor = 0;

function heapPush(node: number): void {
	const f = nodeF[node];
	let idx = heapSize++;
	while (idx > 0) {
		const parent = (idx - 1) >> 1;
		if (nodeF[heapItems[parent]] <= f) break;
		heapItems[idx] = heapItems[parent];
		idx = parent;
	}
	heapItems[idx] = node;
}

function heapPop(): number {
	const top = heapItems[0];
	const last = heapItems[--heapSize];
	if (heapSize > 0) {
		const lastF = nodeF[last];
		let idx = 0;
		for (;;) {
			const left = (idx << 1) + 1;
			if (left >= heapSize) break;
			const right = left + 1;
			let child = left;
			let childF = nodeF[heapItems[left]];
			if (right < heapSize) {
				const rf = nodeF[heapItems[right]];
				if (rf < childF) {
					child = right;
					childF = rf;
				}
			}
			if (childF >= lastF) break;
			heapItems[idx] = heapItems[child];
			idx = child;
		}
		heapItems[idx] = last;
	}
	return top;
}

/**
 * Insert `node` into the closed table. If an entry with the same identity
 * already exists it is REPOINTED to the newer record — matching the old
 * Map.set(key, tentativeG) overwrite-on-better-g semantics.
 */
function closedUpsert(node: number): void {
	const x = nodeX[node];
	const z = nodeZ[node];
	const gy = nodeY[node];
	const kind = nodeKind[node];
	let slot = hashIdentity(x, z, gy, kind) & TABLE_MASK;
	for (;;) {
		const entry = closedTable[slot];
		if (entry === 0) {
			closedTable[slot] = node + 1;
			return;
		}
		const n = entry - 1;
		if (
			nodeX[n] === x &&
			nodeZ[n] === z &&
			nodeY[n] === gy &&
			nodeKind[n] === kind
		) {
			closedTable[slot] = node + 1;
			return;
		}
		slot = (slot + 1) & TABLE_MASK;
	}
}

/** Best recorded g for this exact identity, or -1 when absent. */
function closedLookupG(
	x: number,
	z: number,
	groundY: number,
	kind: number,
): number {
	let slot = hashIdentity(x, z, groundY, kind) & TABLE_MASK;
	for (;;) {
		const entry = closedTable[slot];
		if (entry === 0) return -1;
		const n = entry - 1;
		if (
			nodeX[n] === x &&
			nodeZ[n] === z &&
			nodeY[n] === groundY &&
			nodeKind[n] === kind
		) {
			return nodeG[n];
		}
		slot = (slot + 1) & TABLE_MASK;
	}
}

// PERF: Global per-window expansion budget for A* so mob wander/shore searches
// (up to 2×250 + 6×700 expansions) can't eat the whole main thread when many
// mobs search around the same time. The window is time-based so consecutive
// findPathInto calls within the same frame share one budget, and it resets
// automatically ~2 frames later.
export const PATHFINDING_EXPANSION_BUDGET = 1500;
const PATHFINDING_BUDGET_WINDOW_MS = 40;
let _budgetWindowStartMs = 0;
let _budgetExpansionsUsed = 0;

/** True while expansions remain within the current budget window. */
function hasPathfindingBudget(): boolean {
	const now = performance.now();
	if (now - _budgetWindowStartMs >= PATHFINDING_BUDGET_WINDOW_MS) {
		_budgetWindowStartMs = now;
		_budgetExpansionsUsed = 0;
		return true;
	}
	return _budgetExpansionsUsed < PATHFINDING_EXPANSION_BUDGET;
}

function consumePathfindingBudget(): void {
	_budgetExpansionsUsed++;
}

// Scratch results for findSurface/findLandSurface — reused across the A*
// expansion loop. Not reentrant (same rule as findPathInto).
const SURFACE_SCRATCH: SurfaceResult = {
	groundY: 0,
	cost: 0,
	kind: PathNodeKind.Land,
};
const LAND_SCRATCH: { groundY: number } = { groundY: 0 };

/** Writes a flat-land fallback into the scratch and returns it (no allocation). */
function fallbackSurface(out: SurfaceResult, groundY: number): SurfaceResult {
	out.groundY = groundY;
	out.cost = 1;
	out.kind = PathNodeKind.Land;
	return out;
}

// --- Path reconstruction (no reverse/slice/shift) ---

function buildPathInto(outPath: PathWaypoint[], endIndex: number): void {
	let count = 0;
	for (let node = endIndex; node !== -1; node = nodeParent[node]) {
		count++;
	}

	const waypointCount = Math.max(0, count - 1);
	outPath.length = waypointCount;

	let node = endIndex;
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
		wp.x = nodeX[node];
		wp.z = nodeZ[node];
		wp.groundY = nodeY[node];
		wp.kind = nodeKind[node];
		node = nodeParent[node];
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
			? fallbackSurface(SURFACE_SCRATCH, requiredTargetGroundY)
			: findSurface(
					targetX,
					targetZ,
					startGroundY,
					5,
					3,
					headroom,
					true,
					SURFACE_SCRATCH,
				);
	if (!targetSurface) return false;

	const startSurface =
		findSurface(
			startX,
			startZ,
			startGroundY,
			3,
			8,
			headroom,
			true,
			SURFACE_SCRATCH,
		) ?? fallbackSurface(SURFACE_SCRATCH, startGroundY);

	// Reset the shared SoA search state. The closed-table fill is 16k words —
	// cheaper than generation-stamp bookkeeping and runs once per search.
	heapSize = 0;
	_nodeCursor = 0;
	closedTable.fill(0);

	let success = false;
	try {
		const startH = Math.abs(startX - targetX) + Math.abs(startZ - targetZ);
		const startIndex = allocNodeIndex(
			startX,
			startZ,
			startSurface.groundY,
			startSurface.kind,
			0,
			startH,
			-1,
		);
		heapPush(startIndex);
		closedUpsert(startIndex);

		let expansions = 0;
		while (heapSize > 0 && expansions < maxExpansions) {
			if (!hasPathfindingBudget()) {
				// Budget window exhausted — bail out cleanly this tick; the
				// caller retries on its next wander/shore search.
				break;
			}
			consumePathfindingBudget();
			const current = heapPop();
			expansions++;

			if (
				nodeX[current] === targetX &&
				nodeZ[current] === targetZ &&
				(requiredTargetGroundY === undefined ||
					nodeY[current] === requiredTargetGroundY)
			) {
				buildPathInto(outPath, current);
				success = outPath.length > 0;
				return success;
			}

			const curX = nodeX[current];
			const curZ = nodeZ[current];
			const curY = nodeY[current];
			const curKind = nodeKind[current];
			const curG = nodeG[current];

			for (let i = 0; i < DIRS.length; i++) {
				const dir = DIRS[i];
				const nx = curX + dir[0];
				const nz = curZ + dir[1];

				const surface = findSurface(
					nx,
					nz,
					curY,
					curKind === PathNodeKind.Water ? 3 : 1,
					curKind === PathNodeKind.Water ? 6 : 1,
					headroom,
					true,
					SURFACE_SCRATCH,
				);
				if (!surface) continue;

				let moveCost = surface.cost;
				if (surface.kind === PathNodeKind.Water) {
					moveCost += 6;
				}
				if (
					curKind === PathNodeKind.Land &&
					surface.kind === PathNodeKind.Water
				) {
					moveCost += 8;
				}
				if (
					curKind === PathNodeKind.Water &&
					surface.kind === PathNodeKind.Land
				) {
					moveCost -= 3;
				}

				const tentativeG = curG + moveCost;
				const best = closedLookupG(nx, nz, surface.groundY, surface.kind);
				if (best >= 0 && best <= tentativeG) continue;

				if (_nodeCursor >= NODE_CAPACITY) break;

				const h = Math.abs(nx - targetX) + Math.abs(nz - targetZ);
				const nextNode = allocNodeIndex(
					nx,
					nz,
					surface.groundY,
					surface.kind,
					tentativeG,
					h,
					current,
				);
				heapPush(nextNode);
				closedUpsert(nextNode);
			}
		}

		return false;
	} finally {
		heapSize = 0;
		closedTable.fill(0);
		_nodeCursor = 0;
		if (!success) {
			outPath.length = 0;
		}
	}
}
