/**
 * Advanced Cave Culling: graph-based BFS occlusion culler.
 *
 * BFS state is stored directly on Chunk objects. Fixed-capacity ring buffers
 * hold Chunk references and are cleared as entries are consumed.
 *
 * Queue overflow is handled fail-open. An incomplete BFS must never classify
 * potentially reachable terrain as occluded.
 */

import type { FreeCamera, Mat4 } from "@babylonjs/lite";
import { getCameraPosition, getViewProjectionMatrix } from "@babylonjs/lite";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { isOceanFloorBandChunk } from "@/code/Generation/TerrainHeightMap";
import { isInCave } from "@/code/Lib/GameRuntimeState";
import { Map1 } from "@/code/Maps/Map1";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import { Chunk, getChunk } from "../Chunk/Chunk";
import { facePairIndex } from "../Chunk/Meshing/ChunkFaceMasks";
import {
	consumeGroupsMutated,
	getAllGroups,
	type MergedMeshGroup,
} from "../Chunk/Meshing/MergedMeshManager";
import { pendingConnectivity } from "../Chunk/Runtime/ChunkConnectivityQueue";
import { setMeshCulled } from "../MeshVisibility";
import {
	FrustumHint,
	getOctreeGroupCount,
	traverseGroupOctree,
} from "./GroupOctree";

export interface OcclusionStats {
	total: number;
	occluded: number;
	timeMs: number;
}

// ---------------------------------------------------------------------------
// Tuning and sizing
// ---------------------------------------------------------------------------

const NEAR_CHUNKS = 1;
const MAX_BFS_STEPS = 32;

const MAX_RENDER_RADIUS =
	SETTING_PARAMS.RENDER_DISTANCE +
	Math.max(
		SETTING_PARAMS.LOD_1_OFFSET,
		SETTING_PARAMS.LOD_2_OFFSET,
		SETTING_PARAMS.LOD_3_OFFSET,
		SETTING_PARAMS.LOD_4_OFFSET,
		SETTING_PARAMS.LOD_5_OFFSET,
	) +
	2;

const SEA_LEVEL = GenerationParams.SEA_LEVEL;
const FRUSTUM_MARGIN = 32;
const GROUP_CHUNKS = 4;

const DISABLE_FRUSTUM_CULL = false;

const BFS_FRAME_BUDGET = 1500;
const BFS_CAP = 32768;
const BFS_MASK = BFS_CAP - 1;
const BFS_ORIGIN_BIT = 1 << 7;

// ---------------------------------------------------------------------------
// Face-pair connectivity tables
// ---------------------------------------------------------------------------

const FACE_PAIR_FLAT = new Int32Array(36);
const FACE_PAIR_MASK_FLAT = new Int32Array(36);

let _facePairTableInitialized = false;

function initFacePairTable(): void {
	for (let entryFace = 0; entryFace < 6; entryFace++) {
		const row = entryFace * 6;

		for (let exitFace = 0; exitFace < 6; exitFace++) {
			const min = entryFace < exitFace ? entryFace : exitFace;

			const max = entryFace > exitFace ? entryFace : exitFace;

			const pair = facePairIndex(min, max);

			FACE_PAIR_FLAT[row + exitFace] = pair;
			FACE_PAIR_MASK_FLAT[row + exitFace] = 1 << pair;
		}
	}

	_facePairTableInitialized = true;
}

// ---------------------------------------------------------------------------
// BFS ring buffers
// ---------------------------------------------------------------------------

const _bfsChunks = new Array<Chunk | null>(BFS_CAP).fill(null);
const _bfsEntry = new Int8Array(BFS_CAP);
const _bfsSteps = new Uint16Array(BFS_CAP);

const _incBfsChunks = new Array<Chunk | null>(BFS_CAP).fill(null);
const _incBfsEntry = new Int8Array(BFS_CAP);
const _incBfsSteps = new Uint16Array(BFS_CAP);

const _nearbyChunksScratch: Chunk[] = [];

// ---------------------------------------------------------------------------
// Frustum state
// ---------------------------------------------------------------------------

const _frustumPacked = new Float32Array(24);
const _lastVP = new Float32Array(16);

let _frustumValid = false;

function setFrustumPlane(
	offset: number,
	nx: number,
	ny: number,
	nz: number,
	d: number,
): void {
	const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

	_frustumPacked[offset] = nx / length;
	_frustumPacked[offset + 1] = ny / length;
	_frustumPacked[offset + 2] = nz / length;
	_frustumPacked[offset + 3] = d / length;
}

function cacheFrustumPlanes(vp: Mat4): void {
	const matrix = vp;

	setFrustumPlane(
		0,
		matrix[3] + matrix[0],
		matrix[7] + matrix[4],
		matrix[11] + matrix[8],
		matrix[15] + matrix[12],
	);

	setFrustumPlane(
		4,
		matrix[3] - matrix[0],
		matrix[7] - matrix[4],
		matrix[11] - matrix[8],
		matrix[15] - matrix[12],
	);

	setFrustumPlane(
		8,
		matrix[3] + matrix[1],
		matrix[7] + matrix[5],
		matrix[11] + matrix[9],
		matrix[15] + matrix[13],
	);

	setFrustumPlane(
		12,
		matrix[3] - matrix[1],
		matrix[7] - matrix[5],
		matrix[11] - matrix[9],
		matrix[15] - matrix[13],
	);

	setFrustumPlane(16, matrix[2], matrix[6], matrix[10], matrix[14]);

	setFrustumPlane(
		20,
		matrix[3] - matrix[2],
		matrix[7] - matrix[6],
		matrix[11] - matrix[10],
		matrix[15] - matrix[14],
	);

	_frustumValid = true;
}

function aabbInFrustum(
	minX: number,
	minY: number,
	minZ: number,
	maxX: number,
	maxY: number,
	maxZ: number,
): boolean {
	const planes = _frustumPacked;
	const negativeMargin = -FRUSTUM_MARGIN;

	for (let offset = 0; offset < 24; offset += 4) {
		const nx = planes[offset];
		const ny = planes[offset + 1];
		const nz = planes[offset + 2];

		const px = nx >= 0 ? maxX : minX;
		const py = ny >= 0 ? maxY : minY;
		const pz = nz >= 0 ? maxZ : minZ;

		if (nx * px + ny * py + nz * pz + planes[offset + 3] < negativeMargin) {
			return false;
		}
	}

	return true;
}

// ---------------------------------------------------------------------------
// BFS helpers
// ---------------------------------------------------------------------------

function getFStep(chunk: Chunk, face: number): number {
	const steps = face < 4 ? chunk.bfsSteps0 : chunk.bfsSteps1;

	return (steps >>> ((face & 3) * 8)) & 0xff;
}

function setFStep(chunk: Chunk, face: number, value: number): void {
	const shift = (face & 3) * 8;
	const mask = ~(0xff << shift);
	const encoded = (value & 0xff) << shift;

	if (face < 4) {
		chunk.bfsSteps0 = (chunk.bfsSteps0 & mask) | encoded;
	} else {
		chunk.bfsSteps1 = (chunk.bfsSteps1 & mask) | encoded;
	}
}

function resetChunkBfs(chunk: Chunk, queryId: number): void {
	chunk.bfsQueryId = queryId;
	chunk.bfsVisitedFaces = 0;
	chunk.bfsSteps0 = 0;
	chunk.bfsSteps1 = 0;
}

function ensureNeighborRefs(chunk: Chunk): void {
	const refs = chunk.neighborRefs;

	for (let direction = 0; direction < 6; direction++) {
		if (refs[direction] === null) {
			refs[direction] = chunk.getNeighborChunk(direction) ?? null;
		}
	}
}

function minFSteps(chunk: Chunk): number {
	let minimum = 255;

	for (let face = 0; face < 6; face++) {
		const steps = getFStep(chunk, face);

		if (steps > 0 && steps < minimum) {
			minimum = steps;
		}
	}

	return minimum === 255 ? 0 : minimum;
}

function hasConnectivity(
	visitedFaces: number,
	exitFace: number,
	connectivity: number,
): boolean {
	if (
		(visitedFaces & 1) !== 0 &&
		(connectivity & FACE_PAIR_MASK_FLAT[exitFace]) !== 0
	) {
		return true;
	}

	if (
		(visitedFaces & 2) !== 0 &&
		(connectivity & FACE_PAIR_MASK_FLAT[6 + exitFace]) !== 0
	) {
		return true;
	}

	if (
		(visitedFaces & 4) !== 0 &&
		(connectivity & FACE_PAIR_MASK_FLAT[12 + exitFace]) !== 0
	) {
		return true;
	}

	if (
		(visitedFaces & 8) !== 0 &&
		(connectivity & FACE_PAIR_MASK_FLAT[18 + exitFace]) !== 0
	) {
		return true;
	}

	if (
		(visitedFaces & 16) !== 0 &&
		(connectivity & FACE_PAIR_MASK_FLAT[24 + exitFace]) !== 0
	) {
		return true;
	}

	return (
		(visitedFaces & 32) !== 0 &&
		(connectivity & FACE_PAIR_MASK_FLAT[30 + exitFace]) !== 0
	);
}

function chunkWithinBfsRange(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	cameraX: number,
	cameraY: number,
	cameraZ: number,
	radius: number,
): boolean {
	return (
		Math.abs(chunkX - cameraX) <= radius &&
		Math.abs(chunkY - cameraY) <= radius &&
		Math.abs(chunkZ - cameraZ) <= radius
	);
}

function nextBfsStepCost(
	previousSteps: number,
	chunk: Chunk,
	chunkSize: number,
): number {
	let steps = previousSteps + 1;

	if (chunk.chunkY * chunkSize < SEA_LEVEL) {
		steps++;
	}

	if (chunk.isDarkCached()) {
		steps += 3;
	}

	return steps;
}

function isLiveChunk(chunk: Chunk): boolean {
	return (
		chunk.isLoaded &&
		getChunk(chunk.chunkX, chunk.chunkY, chunk.chunkZ) === chunk
	);
}

function clearChunkRing(
	chunks: Array<Chunk | null>,
	head: number,
	tail: number,
): void {
	while (head !== tail) {
		chunks[head] = null;
		head = (head + 1) & BFS_MASK;
	}
}

// ---------------------------------------------------------------------------

export class OcclusionCuller {
	private _topoVisibleChunks: Chunk[] = [];

	private _currentQueryId = 0;
	private _lastCompletedQueryId = 0;

	private _lastCamCX = -99999;
	private _lastCamCY = -99999;
	private _lastCamCZ = -99999;

	private _topoDirtyFrameCount = 0;

	private static readonly TOPO_THROTTLE_FRAMES = 3;

	private _lastTotal = 0;
	private _lastOccluded = 0;

	private _bfsInProgress = false;
	private _bfsQHead = 0;
	private _bfsQTail = 0;

	/*
	 * True when no usable seed exists, or when BFS overflow prevented a
	 * complete reachability result. In either case reachability fails open.
	 */
	private _bfsOriginMissing = true;

	/*
	 * Records fixed-ring saturation. It is cleared on every BFS restart.
	 */
	private _bfsQueueOverflowed = false;

	private static readonly SWEEP_AMORTIZE_FRAMES = 3;
	private static readonly SWEEP_NEAR_DIST_SQ = (10 * Chunk.SIZE) ** 2;

	private _sweepSlot = 0;

	private hasOceanFloorGroupMember(group: MergedMeshGroup): boolean {
		const cached = group.oceanFloorBand;

		if (cached !== undefined) {
			return cached;
		}

		const baseX = group.gridX * GROUP_CHUNKS;
		const baseY = group.gridY * GROUP_CHUNKS;
		const baseZ = group.gridZ * GROUP_CHUNKS;

		let hasOceanFloor = false;

		if (baseY < 0) {
			const probeY = Math.min(baseY + GROUP_CHUNKS - 1, -1);

			for (let dx = 0; dx < GROUP_CHUNKS && !hasOceanFloor; dx++) {
				for (let dz = 0; dz < GROUP_CHUNKS; dz++) {
					if (isOceanFloorBandChunk(baseX + dx, probeY, baseZ + dz)) {
						hasOceanFloor = true;
						break;
					}
				}
			}
		}

		group.oceanFloorBand = hasOceanFloor;
		return hasOceanFloor;
	}

	update(out: OcclusionStats): OcclusionStats {
		const camera = (Map1.mainScene?.camera as FreeCamera) ?? null;

		if (camera === null) {
			out.total = 0;
			out.occluded = 0;
			out.timeMs = 0;
			return out;
		}

		const startTime = performance.now();
		const chunkSize = Chunk.SIZE;

		const cameraPosition = getCameraPosition(camera);

		const camCX = Math.floor(cameraPosition.x / chunkSize);
		const camCY = Math.floor(cameraPosition.y / chunkSize);
		const camCZ = Math.floor(cameraPosition.z / chunkSize);

		const loadedChunkCount = Chunk.loadedChunks.size;

		let topologyTrigger = false;

		if (pendingConnectivity.length > 0) {
			this._topoDirtyFrameCount++;

			if (this._topoDirtyFrameCount >= OcclusionCuller.TOPO_THROTTLE_FRAMES) {
				topologyTrigger = true;
				this._topoDirtyFrameCount = 0;
			}
		}

		const cameraMoved =
			camCX !== this._lastCamCX ||
			camCY !== this._lastCamCY ||
			camCZ !== this._lastCamCZ;

		const needInitialBFS = this._currentQueryId === 0 && loadedChunkCount > 0;

		if (cameraMoved || needInitialBFS || topologyTrigger) {
			this._lastCamCX = camCX;
			this._lastCamCY = camCY;
			this._lastCamCZ = camCZ;

			this._startBFS(camCX, camCY, camCZ);
		}

		/*
		 * Capture state before stepping. If the BFS completes or overflows in
		 * this call, visibility must still be swept this frame.
		 */
		const bfsWasInProgress = this._bfsInProgress;
		const overflowBeforeStep = this._bfsQueueOverflowed;

		this._stepBFS(BFS_FRAME_BUDGET);

		const bfsStateChanged =
			bfsWasInProgress !== this._bfsInProgress ||
			overflowBeforeStep !== this._bfsQueueOverflowed;

		const canvas = Map1.engine.canvas;
		const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;

		const viewProjection = getViewProjectionMatrix(camera, aspect);

		let viewProjectionChanged = !_frustumValid;

		if (!viewProjectionChanged) {
			for (let i = 0; i < 16; i++) {
				if (Math.abs(viewProjection[i] - _lastVP[i]) > 1e-6) {
					viewProjectionChanged = true;
					break;
				}
			}
		}

		if (viewProjectionChanged) {
			cacheFrustumPlanes(viewProjection);
			_lastVP.set(viewProjection);
		}

		const groupsMutated = consumeGroupsMutated();

		const needSweep =
			cameraMoved ||
			viewProjectionChanged ||
			bfsWasInProgress ||
			bfsStateChanged ||
			needInitialBFS ||
			topologyTrigger ||
			groupsMutated;

		if (!needSweep) {
			out.total = this._lastTotal;
			out.occluded = this._lastOccluded;
			out.timeMs = performance.now() - startTime;

			return out;
		}

		const allGroups = getAllGroups();

		const groupChunks = GROUP_CHUNKS;
		const groupExtent = groupChunks * chunkSize;
		const groupHalf = groupExtent * 0.5;

		const queryId = this._currentQueryId;
		const bfsInProgress = this._bfsInProgress;
		const cameraUnderground = isInCave();

		/*
		 * Missing origin and overflow both disable reachability gating.
		 */
		const bfsGateActive = !this._bfsOriginMissing && !this._bfsQueueOverflowed;

		let groupTotal = 0;
		let groupHidden = 0;

		const fullPass =
			groupsMutated ||
			needInitialBFS ||
			topologyTrigger ||
			bfsStateChanged ||
			this._bfsQueueOverflowed;

		const slotCount = OcclusionCuller.SWEEP_AMORTIZE_FRAMES;
		const activeSlot = this._sweepSlot;
		const nearDistanceSquared = OcclusionCuller.SWEEP_NEAR_DIST_SQ;

		const processGroup = (
			group: MergedMeshGroup,
			ordinal: number,
			hint: FrustumHint,
		): void => {
			const minGX = group.gridX * groupExtent;
			const minGY = group.gridY * groupExtent;
			const minGZ = group.gridZ * groupExtent;

			const maxGX = minGX + groupExtent;
			const maxGY = minGY + groupExtent;
			const maxGZ = minGZ + groupExtent;

			const centerGX = minGX + groupHalf;
			const centerGY = minGY + groupHalf;
			const centerGZ = minGZ + groupHalf;

			const dx = centerGX - cameraPosition.x;
			const dy = centerGY - cameraPosition.y;
			const dz = centerGZ - cameraPosition.z;

			if (!fullPass) {
				const distanceSquared = dx * dx + dy * dy + dz * dz;

				if (
					distanceSquared > nearDistanceSquared &&
					ordinal % slotCount !== activeSlot
				) {
					return;
				}
			}

			const eyeInsideGroup =
				cameraPosition.x >= minGX &&
				cameraPosition.x <= maxGX &&
				cameraPosition.y >= minGY &&
				cameraPosition.y <= maxGY &&
				cameraPosition.z >= minGZ &&
				cameraPosition.z <= maxGZ;

			let inFrustum: boolean;

			if (eyeInsideGroup) {
				inFrustum = true;
			} else if (hint === FrustumHint.OUTSIDE) {
				inFrustum = false;
			} else {
				const minChunkX = group.gridX * groupChunks;
				const minChunkY = group.gridY * groupChunks;
				const minChunkZ = group.gridZ * groupChunks;

				const maxChunkX = minChunkX + groupChunks - 1;
				const maxChunkY = minChunkY + groupChunks - 1;
				const maxChunkZ = minChunkZ + groupChunks - 1;

				const inRange =
					minChunkX <= camCX + MAX_RENDER_RADIUS &&
					camCX - maxChunkX <= MAX_RENDER_RADIUS &&
					minChunkY <= camCY + MAX_RENDER_RADIUS &&
					camCY - maxChunkY <= MAX_RENDER_RADIUS &&
					minChunkZ <= camCZ + MAX_RENDER_RADIUS &&
					camCZ - maxChunkZ <= MAX_RENDER_RADIUS;

				if (!inRange) {
					inFrustum = false;
				} else if (hint === FrustumHint.INSIDE || DISABLE_FRUSTUM_CULL) {
					inFrustum = true;
				} else {
					inFrustum = aabbInFrustum(minGX, minGY, minGZ, maxGX, maxGY, maxGZ);
				}
			}

			if (!inFrustum) {
				groupTotal++;
				groupHidden++;

				setMeshCulled(group.opaqueMeshRef, true);
				setMeshCulled(group.waterMeshRef, true);
				setMeshCulled(group.cutoutMeshRef, true);

				return;
			}

			const isSurfaceGroup = centerGY >= SEA_LEVEL;

			const isOceanFloorGroup =
				!isSurfaceGroup && this.hasOceanFloorGroupMember(group);

			const bypassBFS =
				!bfsGateActive ||
				(isSurfaceGroup && !cameraUnderground) ||
				isOceanFloorGroup;

			let visible: boolean;

			if (bypassBFS) {
				visible = true;
			} else {
				let currentlyReachable = false;
				let previouslyReachable = false;

				const members = group.membersArray;

				for (let index = 0; index < members.length; index++) {
					const chunk = members[index]?.chunk;

					if (chunk === undefined || !chunk.isLoaded) {
						continue;
					}

					if (chunk.bfsQueryId === queryId) {
						currentlyReachable = true;
						break;
					}

					if (
						(this._lastCompletedQueryId > 0 &&
							chunk.bfsQueryId === this._lastCompletedQueryId) ||
						chunk.bfsQueryId === queryId - 1
					) {
						previouslyReachable = true;
					}
				}

				if (!currentlyReachable && previouslyReachable && bfsInProgress) {
					groupTotal++;

					const mesh = group.opaqueMeshRef;

					if (mesh === null || mesh === undefined || mesh.visible === false) {
						groupHidden++;
					}

					return;
				}

				visible = currentlyReachable;
			}

			groupTotal++;

			if (!visible) {
				groupHidden++;
			}

			setMeshCulled(group.opaqueMeshRef, !visible);
			setMeshCulled(group.waterMeshRef, !visible);
			setMeshCulled(group.cutoutMeshRef, !visible);
		};

		if (_frustumValid && getOctreeGroupCount() === allGroups.length) {
			let ordinal = 0;

			traverseGroupOctree(
				_frustumPacked,
				FRUSTUM_MARGIN,
				cameraPosition.x,
				cameraPosition.y,
				cameraPosition.z,
				(group, hint) => {
					processGroup(group as MergedMeshGroup, ordinal, hint);

					ordinal++;
				},
			);
		} else {
			for (let index = 0; index < allGroups.length; index++) {
				processGroup(allGroups[index], index, FrustumHint.INTERSECT);
			}
		}

		this._sweepSlot = (this._sweepSlot + 1) % slotCount;

		this._lastTotal = groupTotal;
		this._lastOccluded = groupHidden;

		out.total = groupTotal;
		out.occluded = groupHidden;
		out.timeMs = performance.now() - startTime;

		return out;
	}

	incrementalAdd(newChunk: Chunk): void {
		const queryId = this._currentQueryId;

		if (queryId === 0 || !isLiveChunk(newChunk)) {
			return;
		}

		if (!_facePairTableInitialized) {
			initFacePairTable();
		}

		const chunkSize = Chunk.SIZE;
		const camCX = this._lastCamCX;
		const camCY = this._lastCamCY;
		const camCZ = this._lastCamCZ;
		const radius = MAX_RENDER_RADIUS;

		if (
			!chunkWithinBfsRange(
				newChunk.chunkX,
				newChunk.chunkY,
				newChunk.chunkZ,
				camCX,
				camCY,
				camCZ,
				radius,
			)
		) {
			return;
		}

		if (newChunk.connectivityDirty) {
			newChunk.computeFaceConnectivity();
		}

		ensureNeighborRefs(newChunk);

		let queueHead = 0;
		let queueTail = 0;
		let overflowed = false;

		const enqueue = (
			chunk: Chunk,
			entryFace: number,
			steps: number,
		): boolean => {
			const nextTail = (queueTail + 1) & BFS_MASK;

			if (nextTail === queueHead) {
				overflowed = true;
				return false;
			}

			_incBfsChunks[queueTail] = chunk;
			_incBfsEntry[queueTail] = entryFace;
			_incBfsSteps[queueTail] = steps;

			queueTail = nextTail;
			return true;
		};

		const initialNeighbors = newChunk.neighborRefs;

		for (let direction = 0; direction < 6; direction++) {
			const neighbor = initialNeighbors[direction];

			if (
				neighbor === null ||
				!isLiveChunk(neighbor) ||
				neighbor.bfsQueryId !== queryId
			) {
				continue;
			}

			const visitedFaces = neighbor.bfsVisitedFaces;

			if (
				(visitedFaces & BFS_ORIGIN_BIT) === 0 &&
				!hasConnectivity(visitedFaces, direction, neighbor.faceConnectivity)
			) {
				continue;
			}

			const entryFace = direction ^ 1;

			const newSteps = nextBfsStepCost(
				minFSteps(neighbor),
				newChunk,
				chunkSize,
			);

			if (newSteps > MAX_BFS_STEPS) {
				continue;
			}

			if (newChunk.bfsQueryId !== queryId) {
				resetChunkBfs(newChunk, queryId);
				this._topoVisibleChunks.push(newChunk);
			}

			const faceBit = 1 << entryFace;

			if (
				(newChunk.bfsVisitedFaces & faceBit) !== 0 &&
				newSteps >= getFStep(newChunk, entryFace)
			) {
				continue;
			}

			newChunk.bfsVisitedFaces |= faceBit;
			setFStep(newChunk, entryFace, newSteps);

			if (!enqueue(newChunk, entryFace, newSteps)) {
				break;
			}
		}

		while (queueHead !== queueTail && !overflowed) {
			const slot = queueHead;
			const current = _incBfsChunks[slot];
			const entryFace = _incBfsEntry[slot];
			const steps = _incBfsSteps[slot];

			_incBfsChunks[slot] = null;
			queueHead = (queueHead + 1) & BFS_MASK;

			if (
				current === null ||
				current.bfsQueryId !== queryId ||
				!isLiveChunk(current)
			) {
				continue;
			}

			if (current.connectivityDirty) {
				current.computeFaceConnectivity();
			}

			const connectivity = current.faceConnectivity;
			const connectivityRow = entryFace * 6;
			const neighbors = current.neighborRefs;

			for (let direction = 0; direction < 6; direction++) {
				const neighbor = neighbors[direction];

				if (neighbor === null || !isLiveChunk(neighbor)) {
					continue;
				}

				if (
					!chunkWithinBfsRange(
						neighbor.chunkX,
						neighbor.chunkY,
						neighbor.chunkZ,
						camCX,
						camCY,
						camCZ,
						radius,
					)
				) {
					continue;
				}

				if (
					(connectivity & FACE_PAIR_MASK_FLAT[connectivityRow + direction]) ===
					0
				) {
					continue;
				}

				const nextEntry = direction ^ 1;

				const newSteps = nextBfsStepCost(steps, neighbor, chunkSize);

				if (newSteps > MAX_BFS_STEPS) {
					continue;
				}

				if (neighbor.bfsQueryId !== queryId) {
					ensureNeighborRefs(neighbor);
					resetChunkBfs(neighbor, queryId);
					this._topoVisibleChunks.push(neighbor);
				}

				const faceBit = 1 << nextEntry;

				if (
					(neighbor.bfsVisitedFaces & faceBit) !== 0 &&
					newSteps >= getFStep(neighbor, nextEntry)
				) {
					continue;
				}

				neighbor.bfsVisitedFaces |= faceBit;

				setFStep(neighbor, nextEntry, newSteps);

				if (!enqueue(neighbor, nextEntry, newSteps)) {
					break;
				}
			}
		}

		clearChunkRing(_incBfsChunks, queueHead, queueTail);

		if (overflowed) {
			/*
			 * The incremental result is incomplete. Restart the authoritative
			 * sliced BFS rather than accepting missing reachability.
			 */
			this._startBFS(camCX, camCY, camCZ);
			return;
		}

		if (newChunk.bfsQueryId === queryId && newChunk.mesh) {
			newChunk.mesh.visible = true;

			if (newChunk.waterMesh) {
				newChunk.waterMesh.visible = true;
			}

			if (newChunk.cutoutMesh) {
				newChunk.cutoutMesh.visible = true;
			}
		}
	}

	private _startBFS(camCX: number, camCY: number, camCZ: number): void {
		if (!_facePairTableInitialized) {
			initFacePairTable();
		}

		/*
		 * Clear references from an interrupted previous query.
		 */
		clearChunkRing(_bfsChunks, this._bfsQHead, this._bfsQTail);

		let queryId = (this._currentQueryId + 1) >>> 0;

		if (queryId === 0) {
			queryId = 1;
		}

		this._currentQueryId = queryId;
		this._topoVisibleChunks.length = 0;
		this._bfsQueueOverflowed = false;

		const dirty = pendingConnectivity;
		const dirtyLength = dirty.length;

		for (let index = 0; index < dirtyLength; index++) {
			const chunk = dirty[index];

			if (chunk.connectivityDirty) {
				chunk.computeFaceConnectivity();
			}

			chunk.bfsQueuedForConnectivity = false;
		}

		dirty.length = 0;

		let queueHead = 0;
		let queueTail = 0;

		const enqueueSeed = (chunk: Chunk): boolean => {
			const nextTail = (queueTail + 1) & BFS_MASK;

			if (nextTail === queueHead) {
				this._bfsQueueOverflowed = true;
				return false;
			}

			_bfsChunks[queueTail] = chunk;
			_bfsEntry[queueTail] = -1;
			_bfsSteps[queueTail] = 0;

			queueTail = nextTail;
			return true;
		};

		const origin = getChunk(camCX, camCY, camCZ) ?? null;

		if (origin !== null && isLiveChunk(origin)) {
			if (origin.connectivityDirty) {
				origin.computeFaceConnectivity();
			}

			ensureNeighborRefs(origin);
			resetChunkBfs(origin, queryId);

			origin.bfsVisitedFaces = BFS_ORIGIN_BIT;

			this._topoVisibleChunks.push(origin);
			enqueueSeed(origin);
		} else {
			_nearbyChunksScratch.length = 0;

			Chunk.loadedChunkIndex.queryCollect(
				camCX,
				camCY,
				camCZ,
				NEAR_CHUNKS,
				NEAR_CHUNKS,
				_nearbyChunksScratch,
			);

			for (let index = 0; index < _nearbyChunksScratch.length; index++) {
				const chunk = _nearbyChunksScratch[index];

				if (!isLiveChunk(chunk) || chunk.bfsQueryId === queryId) {
					continue;
				}

				if (chunk.connectivityDirty) {
					chunk.computeFaceConnectivity();
				}

				ensureNeighborRefs(chunk);
				resetChunkBfs(chunk, queryId);

				chunk.bfsVisitedFaces = BFS_ORIGIN_BIT;

				this._topoVisibleChunks.push(chunk);

				if (!enqueueSeed(chunk)) {
					break;
				}
			}

			_nearbyChunksScratch.length = 0;
		}

		if (this._bfsQueueOverflowed) {
			clearChunkRing(_bfsChunks, queueHead, queueTail);

			queueHead = 0;
			queueTail = 0;
		}

		this._bfsOriginMissing =
			queueHead === queueTail || this._bfsQueueOverflowed;

		this._bfsQHead = queueHead;
		this._bfsQTail = queueTail;

		this._bfsInProgress = queueHead !== queueTail && !this._bfsQueueOverflowed;
	}

	private _stepBFS(budget: number): void {
		if (!this._bfsInProgress || budget <= 0) {
			return;
		}

		const queryId = this._currentQueryId;
		const chunkSize = Chunk.SIZE;

		const camCX = this._lastCamCX;
		const camCY = this._lastCamCY;
		const camCZ = this._lastCamCZ;
		const radius = MAX_RENDER_RADIUS;

		let queueHead = this._bfsQHead;
		let queueTail = this._bfsQTail;
		let processed = 0;

		let overflowed = this._bfsQueueOverflowed;

		while (queueHead !== queueTail && processed < budget && !overflowed) {
			const slot = queueHead;
			const current = _bfsChunks[slot];
			const entryFace = _bfsEntry[slot];
			const steps = _bfsSteps[slot];

			/*
			 * Release the queued strong reference immediately.
			 */
			_bfsChunks[slot] = null;

			queueHead = (queueHead + 1) & BFS_MASK;
			processed++;

			if (
				current === null ||
				current.bfsQueryId !== queryId ||
				!isLiveChunk(current)
			) {
				continue;
			}

			if (current.connectivityDirty) {
				current.computeFaceConnectivity();
			}

			const connectivity = current.faceConnectivity;
			const neighbors = current.neighborRefs;

			const connectivityRow = entryFace >= 0 ? entryFace * 6 : -1;

			for (let direction = 0; direction < 6; direction++) {
				const neighbor = neighbors[direction];

				if (neighbor === null || !isLiveChunk(neighbor)) {
					continue;
				}

				if (
					!chunkWithinBfsRange(
						neighbor.chunkX,
						neighbor.chunkY,
						neighbor.chunkZ,
						camCX,
						camCY,
						camCZ,
						radius,
					)
				) {
					continue;
				}

				if (
					connectivityRow >= 0 &&
					(connectivity & FACE_PAIR_MASK_FLAT[connectivityRow + direction]) ===
						0
				) {
					continue;
				}

				const nextEntry = direction ^ 1;

				const newSteps = nextBfsStepCost(steps, neighbor, chunkSize);

				if (newSteps > MAX_BFS_STEPS) {
					continue;
				}

				if (neighbor.bfsQueryId !== queryId) {
					ensureNeighborRefs(neighbor);
					resetChunkBfs(neighbor, queryId);

					this._topoVisibleChunks.push(neighbor);
				}

				const faceBit = 1 << nextEntry;

				if (
					(neighbor.bfsVisitedFaces & faceBit) !== 0 &&
					newSteps >= getFStep(neighbor, nextEntry)
				) {
					continue;
				}

				neighbor.bfsVisitedFaces |= faceBit;

				setFStep(neighbor, nextEntry, newSteps);

				const nextTail = (queueTail + 1) & BFS_MASK;

				if (nextTail === queueHead) {
					overflowed = true;
					break;
				}

				_bfsChunks[queueTail] = neighbor;
				_bfsEntry[queueTail] = nextEntry;
				_bfsSteps[queueTail] = newSteps;

				queueTail = nextTail;
			}
		}

		this._bfsQHead = queueHead;
		this._bfsQTail = queueTail;
		this._bfsQueueOverflowed = overflowed;

		if (overflowed) {
			/*
			 * The frontier is incomplete, so this query cannot safely occlude
			 * anything by reachability.
			 */
			clearChunkRing(_bfsChunks, queueHead, queueTail);

			this._bfsQHead = 0;
			this._bfsQTail = 0;
			this._bfsInProgress = false;
			this._bfsOriginMissing = true;

			return;
		}

		if (queueHead !== queueTail) {
			return;
		}

		this._bfsInProgress = false;

		const visible = this._topoVisibleChunks;

		let writeIndex = 0;

		for (let index = 0; index < visible.length; index++) {
			const chunk = visible[index];

			if (chunk.bfsQueryId === queryId && isLiveChunk(chunk)) {
				visible[writeIndex++] = chunk;
			}
		}

		visible.length = writeIndex;
		this._lastCompletedQueryId = queryId;
	}
}
