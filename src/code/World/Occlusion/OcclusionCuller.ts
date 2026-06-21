/**
 * Advanced Cave Culling — Graph-based BFS Occlusion Culler.
 *
 * All BFS state lives directly on Chunk objects (bfsQueryId, bfsVisitedFaces,
 * _fSteps, etc.) as declared class fields. Ring buffers store Chunk refs
 * directly — no Map.get() on dequeue, no bigint/number conversion.
 *
 * [TYPED ARRAYS]   FACE_PAIR_FLAT: 6×6 Int32Array for connectivity lookups.
 *                  Frustum planes cached in a Float64Array (6 planes × 4 floats).
 *                  Ring buffer entry/steps stay typed (Int8Array / Uint16Array).
 *
 * [LOOP HOISTING]  Chunk.SIZE, this._lastCamC*, queryId, SEA_LEVEL all hoisted
 *                  to local const before every hot loop.
 */

import { Frustum, Matrix, type Scene, Vector3 } from "@babylonjs/core";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { Map1 } from "@/code/Maps/Map1";
import { Chunk, getChunk } from "../Chunk/Chunk";
import { getAllGroups } from "../Chunk/MergedMeshManager";

// ---------------------------------------------------------------------------
export interface OcclusionStats {
	total: number;
	occluded: number;
	timeMs: number;
}

// ---------------------------------------------------------------------------
// Tuning & Sizing
// ---------------------------------------------------------------------------
const NEAR_CHUNKS = 1;
const MAX_BFS_STEPS = 32;
const MAX_RENDER_RADIUS = 20;
const UNDERGROUND_RENDER_RADIUS = 6;
const SEA_LEVEL = GenerationParams.SEA_LEVEL;
const FRUSTUM_MARGIN = 32.0;
const BFS_FRAME_BUDGET = 3000;
const BFS_CAP = 32768; // must be power-of-2
const BFS_MASK = BFS_CAP - 1;

// ---------------------------------------------------------------------------
// FACE_PAIR_BIT — flattened 6×6 Int32Array
// ---------------------------------------------------------------------------
const FACE_PAIR_FLAT = new Int32Array(36);
let _facePairTableInitialized = false;

function initFacePairTable(): void {
	for (let i = 0; i < 6; i++) {
		for (let j = 0; j < 6; j++) {
			const min = Math.min(i, j);
			const max = Math.max(i, j);
			FACE_PAIR_FLAT[i * 6 + j] = Chunk.facePairIndex(min, max);
		}
	}
	_facePairTableInitialized = true;
}

// ---------------------------------------------------------------------------
// Ring-buffer pools — Chunk refs directly, no ID→Chunk lookup on dequeue.
// ---------------------------------------------------------------------------
const _bfsChunks = new Array<Chunk | null>(BFS_CAP).fill(null);
const _bfsEntry = new Int8Array(BFS_CAP);
const _bfsSteps = new Uint16Array(BFS_CAP);

const _incBfsChunks = new Array<Chunk | null>(BFS_CAP).fill(null);
const _incBfsEntry = new Int8Array(BFS_CAP);
const _incBfsSteps = new Uint16Array(BFS_CAP);

// ---------------------------------------------------------------------------
// Frustum plane cache — packed Float64Array
// ---------------------------------------------------------------------------
const _frustumPacked = new Float64Array(24);
let _frustumValid = false;
let _lastVPHash = -1;

const _vpMatrix = Matrix.Identity();
const _workingVector = new Vector3();

function cacheFrustumPlanes(vp: Matrix): void {
	const planes = Frustum.GetPlanes(vp);
	for (let p = 0; p < 6; p++) {
		const pl = planes[p]!;
		const off = p * 4;
		_frustumPacked[off] = pl.normal.x;
		_frustumPacked[off + 1] = pl.normal.y;
		_frustumPacked[off + 2] = pl.normal.z;
		_frustumPacked[off + 3] = pl.d;
	}
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
	let off = 0;
	let nx = _frustumPacked[off];
	let ny = _frustumPacked[off + 1];
	let nz = _frustumPacked[off + 2];
	let d = _frustumPacked[off + 3];
	if (
		nx * (nx >= 0 ? maxX : minX) +
			ny * (ny >= 0 ? maxY : minY) +
			nz * (nz >= 0 ? maxZ : minZ) +
			d <
		-FRUSTUM_MARGIN
	)
		return false;
	off = 4;
	nx = _frustumPacked[off];
	ny = _frustumPacked[off + 1];
	nz = _frustumPacked[off + 2];
	d = _frustumPacked[off + 3];
	if (
		nx * (nx >= 0 ? maxX : minX) +
			ny * (ny >= 0 ? maxY : minY) +
			nz * (nz >= 0 ? maxZ : minZ) +
			d <
		-FRUSTUM_MARGIN
	)
		return false;
	off = 8;
	nx = _frustumPacked[off];
	ny = _frustumPacked[off + 1];
	nz = _frustumPacked[off + 2];
	d = _frustumPacked[off + 3];
	if (
		nx * (nx >= 0 ? maxX : minX) +
			ny * (ny >= 0 ? maxY : minY) +
			nz * (nz >= 0 ? maxZ : minZ) +
			d <
		-FRUSTUM_MARGIN
	)
		return false;
	off = 12;
	nx = _frustumPacked[off];
	ny = _frustumPacked[off + 1];
	nz = _frustumPacked[off + 2];
	d = _frustumPacked[off + 3];
	if (
		nx * (nx >= 0 ? maxX : minX) +
			ny * (ny >= 0 ? maxY : minY) +
			nz * (nz >= 0 ? maxZ : minZ) +
			d <
		-FRUSTUM_MARGIN
	)
		return false;
	off = 16;
	nx = _frustumPacked[off];
	ny = _frustumPacked[off + 1];
	nz = _frustumPacked[off + 2];
	d = _frustumPacked[off + 3];
	if (
		nx * (nx >= 0 ? maxX : minX) +
			ny * (ny >= 0 ? maxY : minY) +
			nz * (nz >= 0 ? maxZ : minZ) +
			d <
		-FRUSTUM_MARGIN
	)
		return false;
	off = 20;
	nx = _frustumPacked[off];
	ny = _frustumPacked[off + 1];
	nz = _frustumPacked[off + 2];
	d = _frustumPacked[off + 3];
	if (
		nx * (nx >= 0 ? maxX : minX) +
			ny * (ny >= 0 ? maxY : minY) +
			nz * (nz >= 0 ? maxZ : minZ) +
			d <
		-FRUSTUM_MARGIN
	)
		return false;
	return true;
}

// ---------------------------------------------------------------------------
/** Reset a chunk's BFS state for a new query. */
function resetChunkBfs(chunk: Chunk, queryId: number): void {
	chunk.bfsQueryId = queryId;
	chunk.bfsVisitedFaces = 0;
	chunk._fSteps[0] = 0;
	chunk._fSteps[1] = 0;
	chunk._fSteps[2] = 0;
	chunk._fSteps[3] = 0;
	chunk._fSteps[4] = 0;
	chunk._fSteps[5] = 0;
}

/** Find minimum non-zero fSteps value across 6 faces. */
function minFSteps(fs: Uint8Array): number {
	let m = 255;
	if (fs[0] > 0 && fs[0] < m) m = fs[0];
	if (fs[1] > 0 && fs[1] < m) m = fs[1];
	if (fs[2] > 0 && fs[2] < m) m = fs[2];
	if (fs[3] > 0 && fs[3] < m) m = fs[3];
	if (fs[4] > 0 && fs[4] < m) m = fs[4];
	if (fs[5] > 0 && fs[5] < m) m = fs[5];
	return m === 255 ? 0 : m;
}

/** Hand-unrolled connectivity check: does the neighbour have face connectivity from any visited face to the exit face? */
function hasConnectivity(
	neighborVisited: number,
	exitFace: number,
	fc: number,
): boolean {
	if (neighborVisited & 1) {
		if (fc & (1 << FACE_PAIR_FLAT[exitFace]!)) return true;
	}
	if (neighborVisited & 2) {
		if (fc & (1 << FACE_PAIR_FLAT[6 + exitFace]!)) return true;
	}
	if (neighborVisited & 4) {
		if (fc & (1 << FACE_PAIR_FLAT[12 + exitFace]!)) return true;
	}
	if (neighborVisited & 8) {
		if (fc & (1 << FACE_PAIR_FLAT[18 + exitFace]!)) return true;
	}
	if (neighborVisited & 16) {
		if (fc & (1 << FACE_PAIR_FLAT[24 + exitFace]!)) return true;
	}
	if (neighborVisited & 32) {
		if (fc & (1 << FACE_PAIR_FLAT[30 + exitFace]!)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
export class OcclusionCuller {
	private _topoVisibleChunks: Chunk[] = [];
	private _prevTopoChunks: Chunk[] = [];
	private _currentQueryId = 0;
	private _lastCompletedQueryId = 0;

	private _lastCamCX = -99999;
	private _lastCamCY = -99999;
	private _lastCamCZ = -99999;

	private _topologyDirty = false;
	private _topoDirtyFrameCount = 0;
	private static readonly TOPO_THROTTLE_FRAMES = 3;

	private _dirtyConnectivityChunks: Chunk[] = [];

	private _bfsInProgress = false;
	private _bfsQHead = 0;
	private _bfsQTail = 0;

	// ─── update ────────────────────────────────────────────────────────────────
	update(_scene: Scene, out: OcclusionStats): OcclusionStats {
		const camera = Map1.mainScene?.activeCamera;
		if (!camera) {
			out.total = 0;
			out.occluded = 0;
			out.timeMs = 0;
			return out;
		}

		const t0 = performance.now();
		const SIZE = Chunk.SIZE;

		const camCX = Math.floor(camera.position.x / SIZE);
		const camCY = Math.floor(camera.position.y / SIZE);
		const camCZ = Math.floor(camera.position.z / SIZE);

		const currentLoadedSize = Chunk.loadedChunks.size;

		// Topology-dirty scan
		{
			const vis = this._topoVisibleChunks;
			const len = vis.length;
			for (let i = 0; i < len; i++) {
				const chunk = vis[i]!;
				if (chunk.connectivityDirty && !chunk.bfsQueuedForConnectivity) {
					chunk.bfsQueuedForConnectivity = true;
					this._dirtyConnectivityChunks.push(chunk);
					this._topologyDirty = true;
				}
			}
		}

		const cameraMoved =
			camCX !== this._lastCamCX ||
			camCY !== this._lastCamCY ||
			camCZ !== this._lastCamCZ;

		let topologyTrigger = false;
		if (this._topologyDirty) {
			if (++this._topoDirtyFrameCount >= OcclusionCuller.TOPO_THROTTLE_FRAMES) {
				topologyTrigger = true;
				this._topoDirtyFrameCount = 0;
			}
		}

		const needInitialBFS = this._currentQueryId === 0 && currentLoadedSize > 0;

		if (cameraMoved || needInitialBFS || topologyTrigger) {
			this._lastCamCX = camCX;
			this._lastCamCY = camCY;
			this._lastCamCZ = camCZ;
			this._topologyDirty = false;
			this._startBFS(camCX, camCY, camCZ, SIZE);
		}

		this._stepBFS(BFS_FRAME_BUDGET);

		// Gradual-hide during in-progress BFS spread: max 100 per frame
		if (this._bfsInProgress) {
			const qid = this._currentQueryId;
			const vis = this._topoVisibleChunks;
			const len = vis.length;
			let hidden = 0;
			for (let i = 0; i < len && hidden < 100; i++) {
				const chunk = vis[i]!;
				if (chunk.bfsQueryId !== qid) {
					if (chunk.mergedGroupKey) continue;
					const mesh = chunk.mesh;
					if (mesh && mesh.isVisible) {
						mesh.isVisible = false;
						const tm = chunk.transparentMesh;
						if (tm) tm.isVisible = false;
						hidden++;
					}
				}
			}
		}

		// VP matrix hash
		const view = camera.getViewMatrix(true);
		const proj = camera.getProjectionMatrix();
		view.multiplyToRef(proj, _vpMatrix);
		const m = _vpMatrix.m;
		const vpHash = (m[0]! + m[5]! + m[10]! + m[15]!) | 0;
		if (vpHash !== _lastVPHash || !_frustumValid) {
			cacheFrustumPlanes(_vpMatrix);
			_lastVPHash = vpHash;
		}

		// Camera forward for backface culling
		Vector3.TransformNormalToRef(
			_AXIS_Z,
			camera.getWorldMatrix(),
			_workingVector,
		);
		const fwdX = _workingVector.x;
		const fwdY = _workingVector.y;
		const fwdZ = _workingVector.z;

		const total = currentLoadedSize;
		let visibleCount = 0;

		// ── Frustum + backface sweep ────────────────────────────────────────────
		const vis = this._topoVisibleChunks;
		const visLen = vis.length;

		for (let i = 0; i < visLen; i++) {
			const chunk = vis[i]!;
			const mesh = chunk.mesh;
			if (!mesh) continue;
			if (mesh.isDisposed()) continue;
			if (!chunk.isLoaded) continue;
			if (chunk.mergedGroupKey) continue;

			const cx = chunk.chunkX;
			const cy = chunk.chunkY;
			const cz = chunk.chunkZ;

			const ddx = cx - camCX;
			const ddy = cy - camCY;
			const ddz = cz - camCZ;

			let visible = true;

			// Backface cull
			if (
				ddx > NEAR_CHUNKS ||
				ddx < -NEAR_CHUNKS ||
				ddy > NEAR_CHUNKS ||
				ddy < -NEAR_CHUNKS ||
				ddz > NEAR_CHUNKS ||
				ddz < -NEAR_CHUNKS
			) {
				const rawDot = ddx * fwdX + ddy * fwdY + ddz * fwdZ;
				if (rawDot < 0) {
					const lenSq = ddx * ddx + ddy * ddy + ddz * ddz;
					if (rawDot * rawDot > 0.25 * lenSq) visible = false;
				}
			}

			// Frustum AABB cull
			if (visible) {
				const minX = cx * SIZE;
				const minY = cy * SIZE;
				const minZ = cz * SIZE;
				if (
					!aabbInFrustum(
						minX,
						minY,
						minZ,
						minX + SIZE,
						minY + SIZE,
						minZ + SIZE,
					)
				) {
					visible = false;
				}
			}

			if (mesh.isVisible !== visible) {
				mesh.isVisible = visible;
				const tm = chunk.transparentMesh;
				if (tm) tm.isVisible = visible;
			}
			if (visible) visibleCount++;
		}

		// Batch-hide old chunks once BFS is complete
		if (!this._bfsInProgress) {
			const prev = this._prevTopoChunks;
			const prevLen = prev.length;
			const queryId = this._currentQueryId;
			for (let i = 0; i < prevLen; i++) {
				const pc = prev[i]!;
				if (pc.bfsQueryId !== queryId) {
					if (pc.mergedGroupKey) continue;
					const pm = pc.mesh;
					const ptm = pc.transparentMesh;
					if (pm && pm.isVisible) {
						pm.isVisible = false;
						if (ptm) ptm.isVisible = false;
					}
				}
			}
		}

		// Merged group visibility — frustum AABB + BFS topology cull.
		const allGroups = getAllGroups();
		const G = 4;
		const groupExtent = G * SIZE;
		const gHalf = groupExtent * 0.5;
		const queryId = this._currentQueryId;
		const bfsInProgress = this._bfsInProgress;
		const cameraUnderground = camera.position.y < SEA_LEVEL;

		for (let i = 0; i < allGroups.length; i++) {
			const group = allGroups[i]!;
			const minGX = group.gridX * groupExtent;
			const minGY = group.gridY * groupExtent;
			const minGZ = group.gridZ * groupExtent;

			// Underground groups use smaller render radius.
			const groupCenterY = minGY + gHalf;
			const isSurfaceGroup = groupCenterY >= SEA_LEVEL;
			const R_chunks =
				cameraUnderground || !isSurfaceGroup
					? UNDERGROUND_RENDER_RADIUS
					: MAX_RENDER_RADIUS;

			// Distance check between group AABB and camera chunk range in chunk coordinates.
			const minChunkX = group.gridX * G;
			const maxChunkX = minChunkX + G - 1;
			const minChunkY = group.gridY * G;
			const maxChunkY = minChunkY + G - 1;
			const minChunkZ = group.gridZ * G;
			const maxChunkZ = minChunkZ + G - 1;

			const inRange =
				minChunkX <= camCX + R_chunks &&
				camCX - maxChunkX <= R_chunks &&
				minChunkY <= camCY + R_chunks &&
				camCY - maxChunkY <= R_chunks &&
				minChunkZ <= camCZ + R_chunks &&
				camCZ - maxChunkZ <= R_chunks;

			const inFrustum =
				inRange &&
				aabbInFrustum(
					minGX,
					minGY,
					minGZ,
					minGX + groupExtent,
					minGY + groupExtent,
					minGZ + groupExtent,
				);

			// BFS reachability — hide groups sealed underground.
			const bypassBFS = isSurfaceGroup && !cameraUnderground;

			let vis: boolean;
			if (bypassBFS) {
				vis = inFrustum;
			} else {
				let bfsReachable = false;
				let bfsPrevious = false;
				const members = group.membersArray;
				for (let j = 0, mlen = members.length; j < mlen; j++) {
					const chunk = members[j]!.chunk;
					if (chunk.isLoaded) {
						if (chunk.bfsQueryId === queryId) {
							bfsReachable = true;
							break;
						}
						if (
							(this._lastCompletedQueryId > 0 &&
								chunk.bfsQueryId === this._lastCompletedQueryId) ||
							chunk.bfsQueryId === queryId - 1
						) {
							bfsPrevious = true;
						}
					}
				}

				if (!bfsReachable && bfsPrevious && bfsInProgress) {
					continue;
				}

				vis = inFrustum && bfsReachable;
			}

			if (group.opaqueMeshRef && group.opaqueMeshRef.isVisible !== vis) {
				group.opaqueMeshRef.isVisible = vis;
			}
			if (
				group.transparentMeshRef &&
				group.transparentMeshRef.isVisible !== vis
			) {
				group.transparentMeshRef.isVisible = vis;
			}
		}

		out.total = total;
		out.occluded = total - visibleCount;
		out.timeMs = performance.now() - t0;
		return out;
	}

	// ─── incrementalAdd ────────────────────────────────────────────────────────
	incrementalAdd(newChunk: Chunk): void {
		const queryId = this._currentQueryId;
		if (queryId === 0) return;

		const SIZE = Chunk.SIZE;
		const camCX = this._lastCamCX;
		const camCY = this._lastCamCY;
		const camCZ = this._lastCamCZ;
		const R = MAX_RENDER_RADIUS;

		const nX = newChunk.chunkX;
		const nY = newChunk.chunkY;
		const nZ = newChunk.chunkZ;

		if (
			nX - camCX > R ||
			camCX - nX > R ||
			nY - camCY > R ||
			camCY - nY > R ||
			nZ - camCZ > R ||
			camCZ - nZ > R
		)
			return;

		if (newChunk.connectivityDirty) newChunk.computeFaceConnectivity();

		let qHead = 0;
		let qTail = 0;

		const neighborIds = newChunk.neighborIds;

		// Scan neighbours that already belong to this BFS pass
		for (let d = 0; d < 6; d++) {
			const nId = neighborIds[d];
			if (nId === undefined) continue;

			const neighbor = Chunk.chunkInstances.get(nId);
			if (!neighbor) continue;

			if (neighbor.bfsQueryId !== queryId) continue;

			const exitFace = d;
			const entryForNew = exitFace ^ 1;

			// Check neighbour face connectivity
			const neighborVisited = neighbor.bfsVisitedFaces;
			let canPass = true;

			if (!(neighborVisited & (1 << 7))) {
				canPass = hasConnectivity(
					neighborVisited,
					exitFace,
					neighbor.faceConnectivity,
				);
			}
			if (!canPass) continue;

			// Derive step count from cheapest neighbour entry
			const minNbrSteps = minFSteps(neighbor._fSteps);

			let newSteps = minNbrSteps + 1;
			if (nY * SIZE < SEA_LEVEL) newSteps++;
			if (newChunk._isDarkCached === true) newSteps += 3;
			if (newSteps > MAX_BFS_STEPS) continue;

			// Initialise new chunk for this query if needed
			if (newChunk.bfsQueryId !== queryId) {
				resetChunkBfs(newChunk, queryId);
				this._topoVisibleChunks.push(newChunk);
			}

			const faceBit = 1 << entryForNew;
			newChunk.bfsVisitedFaces |= faceBit;
			newChunk._fSteps[entryForNew] = newSteps;

			// Enqueue new chunk for BFS propagation
			const nextTail = (qTail + 1) & BFS_MASK;
			if (nextTail !== qHead) {
				_incBfsChunks[qTail] = newChunk;
				_incBfsEntry[qTail] = entryForNew;
				_incBfsSteps[qTail] = newSteps;
				qTail = nextTail;
			}
		}

		// BFS propagation from newChunk outward
		while (qHead !== qTail) {
			const current = _incBfsChunks[qHead]!;
			const entryFace = _incBfsEntry[qHead]!;
			const steps = _incBfsSteps[qHead]!;
			qHead = (qHead + 1) & BFS_MASK;

			const curFc = current.faceConnectivity;
			const curNeighborIds = current.neighborIds;

			for (let d = 0; d < 6; d++) {
				const nbrId = curNeighborIds[d];
				if (nbrId === undefined) continue;

				const nbr = Chunk.chunkInstances.get(nbrId);
				if (!nbr) continue;

				const nx = nbr.chunkX;
				const ny = nbr.chunkY;
				const nz = nbr.chunkZ;

				if (
					nx - camCX > R ||
					camCX - nx > R ||
					ny - camCY > R ||
					camCY - ny > R ||
					nz - camCZ > R ||
					camCZ - nz > R
				)
					continue;

				const exitFace = d;
				const nextEntry = exitFace ^ 1;

				let newSteps = steps + 1;
				if (ny * SIZE < SEA_LEVEL) newSteps++;
				if (nbr._isDarkCached === true) newSteps += 3;
				if (newSteps > MAX_BFS_STEPS) continue;

				// Connectivity gate
				if (entryFace >= 0) {
					const bit = FACE_PAIR_FLAT[entryFace * 6 + exitFace];
					if (!(curFc & (1 << bit))) continue;
				}
				if (nbr.bfsQueryId !== queryId) {
					resetChunkBfs(nbr, queryId);
					this._topoVisibleChunks.push(nbr);
				}
				const faceBit = 1 << nextEntry;
				if ((nbr.bfsVisitedFaces & faceBit) !== 0) {
					if (newSteps >= nbr._fSteps[nextEntry]) continue;
				}

				if (nbr.connectivityDirty) nbr.computeFaceConnectivity();

				nbr.bfsVisitedFaces |= faceBit;
				nbr._fSteps[nextEntry] = newSteps;
				const nextTail = (qTail + 1) & BFS_MASK;
				if (nextTail !== qHead) {
					_incBfsChunks[qTail] = nbr;
					_incBfsEntry[qTail] = nextEntry;
					_incBfsSteps[qTail] = newSteps;
					qTail = nextTail;
				}
			}
		}

		if (newChunk.bfsQueryId === queryId && newChunk.mesh) {
			newChunk.mesh.isVisible = true;
			if (newChunk.transparentMesh) newChunk.transparentMesh.isVisible = true;
		}
	}

	// ─── _startBFS ─────────────────────────────────────────────────────────────
	private _startBFS(
		camCX: number,
		camCY: number,
		camCZ: number,
		SIZE: number,
	): void {
		if (!_facePairTableInitialized) initFacePairTable();

		this._currentQueryId++;
		const queryId = this._currentQueryId;

		// Swap visible arrays
		const recycled = this._prevTopoChunks;
		recycled.length = 0;
		this._prevTopoChunks = this._topoVisibleChunks;
		this._topoVisibleChunks = recycled;

		// Batch connectivity recomputation before BFS
		const dirty = this._dirtyConnectivityChunks;
		const dirtyLen = dirty.length;
		for (let i = 0; i < dirtyLen; i++) {
			const c = dirty[i]!;
			if (c.connectivityDirty) c.computeFaceConnectivity();
			c.bfsQueuedForConnectivity = false;
		}
		dirty.length = 0;

		let qTail = 0;

		const originChunk: Chunk | null = getChunk(camCX, camCY, camCZ) ?? null;

		if (originChunk) {
			if (originChunk.connectivityDirty) originChunk.computeFaceConnectivity();
			resetChunkBfs(originChunk, queryId);
			originChunk.bfsVisitedFaces = 1 << 7; // origin marker
			this._topoVisibleChunks.push(originChunk);
			_bfsChunks[qTail] = originChunk;
			_bfsEntry[qTail] = -1;
			_bfsSteps[qTail] = 0;
			qTail = 1;
		} else {
			const _nearbyChunks: Chunk[] = [];
			Chunk.loadedChunkIndex.queryCollect(
				camCX,
				camCY,
				camCZ,
				NEAR_CHUNKS,
				NEAR_CHUNKS,
				_nearbyChunks,
			);
			for (let i = 0; i < _nearbyChunks.length; i++) {
				const chunk = _nearbyChunks[i]!;
				if (chunk.bfsQueryId === queryId) continue;
				resetChunkBfs(chunk, queryId);
				chunk.bfsVisitedFaces = 1 << 7;
				this._topoVisibleChunks.push(chunk);
				const nextTail = (qTail + 1) & BFS_MASK;
				if (nextTail !== 0) {
					_bfsChunks[qTail] = chunk;
					_bfsEntry[qTail] = -1;
					_bfsSteps[qTail] = 0;
					qTail = nextTail;
				}
			}
		}

		this._bfsQHead = 0;
		this._bfsQTail = qTail;
		this._bfsInProgress = true;
	}

	// ─── _stepBFS ──────────────────────────────────────────────────────────────
	private _stepBFS(budget: number): void {
		if (!this._bfsInProgress) return;

		const queryId = this._currentQueryId;
		const SIZE = Chunk.SIZE;
		const camCX = this._lastCamCX;
		const camCY = this._lastCamCY;
		const camCZ = this._lastCamCZ;
		const R = MAX_RENDER_RADIUS;

		let qHead = this._bfsQHead;
		let qTail = this._bfsQTail;
		let processed = 0;

		while (qHead !== qTail && processed < budget) {
			const current = _bfsChunks[qHead]!;
			const entryFace = _bfsEntry[qHead]!;
			const steps = _bfsSteps[qHead]!;
			qHead = (qHead + 1) & BFS_MASK;
			processed++;

			const curFc = current.faceConnectivity;
			const curNeighborIds = current.neighborIds;

			for (let d = 0; d < 6; d++) {
				const nbrId = curNeighborIds[d];
				if (nbrId === undefined) continue;

				const nbr = Chunk.chunkInstances.get(nbrId);
				if (!nbr) continue;

				const nx = nbr.chunkX;
				const ny = nbr.chunkY;
				const nz = nbr.chunkZ;

				if (
					nx - camCX > R ||
					camCX - nx > R ||
					ny - camCY > R ||
					camCY - ny > R ||
					nz - camCZ > R ||
					camCZ - nz > R
				)
					continue;

				const exitFace = d;
				const nextEntry = exitFace ^ 1;

				let newSteps = steps + 1;
				if (ny * SIZE < SEA_LEVEL) newSteps++;
				if (nbr._isDarkCached === true) newSteps += 3;
				if (newSteps > MAX_BFS_STEPS) continue;

				// Connectivity gate
				if (entryFace >= 0) {
					const bit = FACE_PAIR_FLAT[entryFace * 6 + exitFace]!;
					if (!(curFc & (1 << bit))) continue;
				}
				if (nbr.bfsQueryId !== queryId) {
					resetChunkBfs(nbr, queryId);
					this._topoVisibleChunks.push(nbr);
				}
				const faceBit = 1 << nextEntry;
				if ((nbr.bfsVisitedFaces & faceBit) !== 0) {
					if (newSteps >= nbr._fSteps[nextEntry]) continue;
				}
				nbr.bfsVisitedFaces |= faceBit;
				nbr._fSteps[nextEntry] = newSteps;

				const nextTail = (qTail + 1) & BFS_MASK;
				if (nextTail !== qHead) {
					_bfsChunks[qTail] = nbr;
					_bfsEntry[qTail] = nextEntry;
					_bfsSteps[qTail] = newSteps;
					qTail = nextTail;
				}
			}
		}

		this._bfsQHead = qHead;
		this._bfsQTail = qTail;

		// BFS complete — compact visible list, evict stale entries
		if (qHead === qTail) {
			this._bfsInProgress = false;
			const vis = this._topoVisibleChunks;
			let writeIdx = 0;
			for (let i = 0; i < vis.length; i++) {
				const chunk = vis[i]!;
				if (chunk.bfsQueryId === queryId) {
					vis[writeIdx++] = chunk;
				}
			}
			vis.length = writeIdx;
			this._lastCompletedQueryId = queryId;
		}
	}
}

// ---------------------------------------------------------------------------
const _AXIS_Z = new Vector3(0, 0, 1);
