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

import type { FreeCamera, Mat4 } from "@babylonjs/lite";
import { getCameraPosition, getViewProjectionMatrix } from "@babylonjs/lite";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { Map1 } from "@/code/Maps/Map1";
import { Chunk, getChunk } from "../Chunk/Chunk";
import { facePairIndex } from "../Chunk/ChunkFaceMasks";
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

// TEMP DEBUG: set true to disable frustum culling (for testing the gap).
const DISABLE_FRUSTUM_CULL = false;

// T2-12: staged re-enable. Stage 1 (current): frustum/backface sweep + merged-
// group frustum culling only — the graph-based cave BFS (connectivity scans,
// _startBFS/_stepBFS, topology-dirty handling) is disabled. Flip this to true
// for Stage 2 (full cave culling) once Stage 1 is verified in-game.
const BFS_CAVE_CULLING_ENABLED = false;

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
			FACE_PAIR_FLAT[i * 6 + j] = facePairIndex(min, max);
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

// Scratch array for fallback nearby-chunk collection — reused to avoid per-call allocation.
const _nearbyChunksScratch: Chunk[] = [];

// ---------------------------------------------------------------------------
// Frustum plane cache — packed Float32Array
// ---------------------------------------------------------------------------
const _frustumPacked = new Float32Array(24);
let _frustumValid = false;
// Full VP matrix from the previous frame, used to detect ANY camera change
// (translation or rotation). A hash over 4 diagonal elements truncated to int
// was too collision-prone and froze the frustum planes / visibility sweep.
const _lastVP = new Float32Array(16);

// VP matrix + scratch vectors are derived per-frame from Lite camera math (see update()).

// Write one frustum plane (normal.xyz, d) into the packed Float32Array,
// normalising it so the aabbInFrustum margin test stays in world units —
// this mirrors Babylon's Frustum.GetPlanes, which normalises each plane.
function setFrustumPlane(
	off: number,
	nx: number,
	ny: number,
	nz: number,
	d: number,
): void {
	const len = Math.hypot(nx, ny, nz) || 1;
	_frustumPacked[off] = nx / len;
	_frustumPacked[off + 1] = ny / len;
	_frustumPacked[off + 2] = nz / len;
	_frustumPacked[off + 3] = d / len;
}

// Lite's Mat4 is column-major (m[col*4 + row]); Babylon's Matrix is row-major.
// Frustum planes come from clip-space half-space inequalities, which are built
// Babylon Lite runs on WebGPU, whose clip space is 0 <= z <= w (not the
// OpenGL -w <= z <= w). The side planes (left/right/top/bottom) and the far
// plane are the standard half-spaces (col3 +/- colN). The near plane is simply
// col2 (z >= 0); col3 + col2 would be the OpenGL near (z >= -w) and is WRONG here.
function cacheFrustumPlanes(vp: Mat4): void {
	const m = vp;
	// Clip-space half-space extraction (column-major VP): side planes and far
	// are (col3 +/- colN); near is col2 (see note above).
	setFrustumPlane(
		0,
		m[3]! + m[0]!,
		m[7]! + m[4]!,
		m[11]! + m[8]!,
		m[15]! + m[12]!,
	); // left
	setFrustumPlane(
		4,
		m[3]! - m[0]!,
		m[7]! - m[4]!,
		m[11]! - m[8]!,
		m[15]! - m[12]!,
	); // right
	setFrustumPlane(
		8,
		m[3]! + m[1]!,
		m[7]! + m[5]!,
		m[11]! + m[9]!,
		m[15]! + m[13]!,
	); // bottom
	setFrustumPlane(
		12,
		m[3]! - m[1]!,
		m[7]! - m[5]!,
		m[11]! - m[9]!,
		m[15]! - m[13]!,
	); // top
	setFrustumPlane(16, m[2]!, m[6]!, m[10]!, m[14]!); // near (WebGPU clip: z >= 0)
	setFrustumPlane(
		20,
		m[3]! - m[2]!,
		m[7]! - m[6]!,
		m[11]! - m[10]!,
		m[15]! - m[14]!,
	); // far
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
		nx * (nx >= 0 ? minX : maxX) +
			ny * (ny >= 0 ? minY : maxY) +
			nz * (nz >= 0 ? minZ : maxZ) +
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
		nx * (nx >= 0 ? minX : maxX) +
			ny * (ny >= 0 ? minY : maxY) +
			nz * (nz >= 0 ? minZ : maxZ) +
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
		nx * (nx >= 0 ? minX : maxX) +
			ny * (ny >= 0 ? minY : maxY) +
			nz * (nz >= 0 ? minZ : maxZ) +
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
		nx * (nx >= 0 ? minX : maxX) +
			ny * (ny >= 0 ? minY : maxY) +
			nz * (nz >= 0 ? minZ : maxZ) +
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
		nx * (nx >= 0 ? minX : maxX) +
			ny * (ny >= 0 ? minY : maxY) +
			nz * (nz >= 0 ? minZ : maxZ) +
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
		nx * (nx >= 0 ? minX : maxX) +
			ny * (ny >= 0 ? minY : maxY) +
			nz * (nz >= 0 ? minZ : maxZ) +
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

/**
 * Lazily populate a chunk's neighborRefs array from chunkInstances.
 * Called once per chunk on first BFS encounter. After this, the refs
 * are kept up to date via the dispose hook (nulling) and new-chunk load
 * (re-populating both sides).
 */
function ensureNeighborRefs(chunk: Chunk): void {
	const refs = chunk.neighborRefs;
	if (refs[0] !== null || refs[1] !== null) return; // already populated
	for (let d = 0; d < 6; d++) {
		refs[d] = chunk.getNeighborChunk(d) ?? null;
	}
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
		if (fc & (1 << FACE_PAIR_FLAT[exitFace])) return true;
	}
	if (neighborVisited & 2) {
		if (fc & (1 << FACE_PAIR_FLAT[6 + exitFace])) return true;
	}
	if (neighborVisited & 4) {
		if (fc & (1 << FACE_PAIR_FLAT[12 + exitFace])) return true;
	}
	if (neighborVisited & 8) {
		if (fc & (1 << FACE_PAIR_FLAT[18 + exitFace])) return true;
	}
	if (neighborVisited & 16) {
		if (fc & (1 << FACE_PAIR_FLAT[24 + exitFace])) return true;
	}
	if (neighborVisited & 32) {
		if (fc & (1 << FACE_PAIR_FLAT[30 + exitFace])) return true;
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

	// Cached visibility results so we can skip the O(chunks) sweep when nothing
	// that affects visibility has changed since last frame.
	private _lastTotal = 0;
	private _lastOccluded = 0;

	private _dirtyConnectivityChunks: Chunk[] = [];

	private _bfsInProgress = false;
	private _bfsQHead = 0;
	private _bfsQTail = 0;

	// ─── update ────────────────────────────────────────────────────────────────
	update(out: OcclusionStats): OcclusionStats {
		const camera = (Map1.mainScene?.camera as FreeCamera) ?? null;
		if (!camera) {
			out.total = 0;
			out.occluded = 0;
			out.timeMs = 0;
			return out;
		}

		const t0 = performance.now();
		const SIZE = Chunk.SIZE;

		const camPos = getCameraPosition(camera);
		const camCX = Math.floor(camPos.x / SIZE);
		const camCY = Math.floor(camPos.y / SIZE);
		const camCZ = Math.floor(camPos.z / SIZE);

		const currentLoadedSize = Chunk.loadedChunks.size;

		// Topology-dirty scan (BFS stage only)
		let topologyTrigger = false;
		if (BFS_CAVE_CULLING_ENABLED) {
			const vis = this._topoVisibleChunks;
			const len = vis.length;
			for (let i = 0; i < len; i++) {
				const chunk = vis[i];
				if (chunk.connectivityDirty && !chunk.bfsQueuedForConnectivity) {
					chunk.bfsQueuedForConnectivity = true;
					this._dirtyConnectivityChunks.push(chunk);
					this._topologyDirty = true;
				}
			}

			if (this._topologyDirty) {
				if (
					++this._topoDirtyFrameCount >= OcclusionCuller.TOPO_THROTTLE_FRAMES
				) {
					topologyTrigger = true;
					this._topoDirtyFrameCount = 0;
				}
			}
		}

		const cameraMoved =
			camCX !== this._lastCamCX ||
			camCY !== this._lastCamCY ||
			camCZ !== this._lastCamCZ;

		const needInitialBFS =
			BFS_CAVE_CULLING_ENABLED &&
			this._currentQueryId === 0 &&
			currentLoadedSize > 0;

		if (cameraMoved || needInitialBFS || topologyTrigger) {
			this._lastCamCX = camCX;
			this._lastCamCY = camCY;
			this._lastCamCZ = camCZ;
			this._topologyDirty = false;
			if (BFS_CAVE_CULLING_ENABLED) {
				this._startBFS(camCX, camCY, camCZ);
			}
		}

		if (BFS_CAVE_CULLING_ENABLED) {
			this._stepBFS(BFS_FRAME_BUDGET);
		}

		// Gradual-hide during in-progress BFS spread: max 100 per frame
		if (this._bfsInProgress) {
			const qid = this._currentQueryId;
			const vis = this._topoVisibleChunks;
			const len = vis.length;
			let hidden = 0;
			for (let i = 0; i < len && hidden < 100; i++) {
				const chunk = vis[i];
				if (chunk.bfsQueryId !== qid) {
					if (chunk.mergedGroupKey) continue;
					const mesh = chunk.mesh;
					if (mesh?.visible) {
						mesh.visible = false;
						const wm = chunk.waterMesh;
						if (wm) wm.visible = false;
						const cm = chunk.cutoutMesh;
						if (cm) cm.visible = false;
						hidden++;
					}
				}
			}
		}

		// ── Decide whether the expensive visibility sweep must run ──────────────
		// The BFS topology restart above is already gated on camera-chunk
		// movement. The per-chunk frustum/backface sweep and the merged-group
		// loop are O(visible chunks) with matrix math, so we skip them entirely
		// when the camera hasn't moved/rotated and no BFS is in flight —
		// visibility is then identical to the previous frame.
		const bfsWasInProgress = this._bfsInProgress;

		// VP matrix — recompute frustum planes whenever the full matrix changes
		// (translation OR rotation). The previous 4-element integer hash was too
		// collision-prone and left the planes / sweep frozen on camera rotation.
		const canvas = Map1.engine.canvas;
		const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
		const vp = getViewProjectionMatrix(camera, aspect);

		let vpChanged = !_frustumValid;
		if (!vpChanged) {
			for (let i = 0; i < 16; i++) {
				if (Math.abs(vp[i] - _lastVP[i]) > 1e-6) {
					vpChanged = true;
					break;
				}
			}
		}
		if (vpChanged) {
			cacheFrustumPlanes(vp);
			_lastVP.set(vp);
		}

		const needSweep =
			cameraMoved || vpChanged || bfsWasInProgress || needInitialBFS;

		if (!needSweep) {
			out.total = this._lastTotal;
			out.occluded = this._lastOccluded;
			out.timeMs = performance.now() - t0;
			return out;
		}

		// Camera forward for backface culling (direction from camera position to target).
		const _camPos = camPos;
		let fwdX = camera.target.x - _camPos.x;
		let fwdY = camera.target.y - _camPos.y;
		let fwdZ = camera.target.z - _camPos.z;
		const _fwdLen = Math.hypot(fwdX, fwdY, fwdZ) || 1;
		fwdX /= _fwdLen;
		fwdY /= _fwdLen;
		fwdZ /= _fwdLen;

		const total = currentLoadedSize;
		let visibleCount = 0;

		// ── Frustum + backface sweep ────────────────────────────────────────────
		// Stage 1 (no cave BFS): the BFS-visible list stays empty, so sweep every
		// loaded chunk instead — the BFS is only the topological subset filter.
		// PERF: Use spatial index query instead of iterating all loaded chunks.
		// This reduces O(all_loaded_chunks) to O(chunks_near_camera), which is
		// critical when render distance exceeds the visible frustum.
		const sweepList = BFS_CAVE_CULLING_ENABLED
			? this._topoVisibleChunks
			: _nearbyChunksScratch;
		if (!BFS_CAVE_CULLING_ENABLED) {
			_nearbyChunksScratch.length = 0;
			Chunk.loadedChunkIndex.queryCollect(
				camCX,
				camCY,
				camCZ,
				MAX_RENDER_RADIUS,
				MAX_RENDER_RADIUS,
				_nearbyChunksScratch,
			);
		}
		const visLen = sweepList.length;

		for (let i = 0; i < visLen; i++) {
			const chunk = sweepList[i]!;
			const mesh = chunk.mesh;
			if (!mesh) continue;
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
				const maxX = minX + SIZE;
				const maxY = minY + SIZE;
				const maxZ = minZ + SIZE;
				// Eye-inside guard (see group loop): a chunk AABB containing the
				// camera is always visible and must not be near-plane culled.
				const eyeInChunk =
					camPos.x >= minX &&
					camPos.x <= maxX &&
					camPos.y >= minY &&
					camPos.y <= maxY &&
					camPos.z >= minZ &&
					camPos.z <= maxZ;
				if (
					!DISABLE_FRUSTUM_CULL &&
					!eyeInChunk &&
					!aabbInFrustum(minX, minY, minZ, maxX, maxY, maxZ)
				) {
					visible = false;
				}
			}

			if (mesh.visible !== visible) {
				mesh.visible = visible;
				const wm = chunk.waterMesh;
				if (wm) wm.visible = visible;
				const cm = chunk.cutoutMesh;
				if (cm) cm.visible = visible;
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
					const pwm = pc.waterMesh;
					const pcm = pc.cutoutMesh;
					if (pm?.visible) {
						pm.visible = false;
						if (pwm) pwm.visible = false;
						if (pcm) pcm.visible = false;
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
		const cameraUnderground = camPos.y < SEA_LEVEL;

		for (let i = 0; i < allGroups.length; i++) {
			const group = allGroups[i];
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

			const maxGX = minGX + groupExtent;
			const maxGY = minGY + groupExtent;
			const maxGZ = minGZ + groupExtent;

			// An AABB that contains the eye (camera) always intersects the
			// frustum. The positive-vertex test below can otherwise falsely cull
			// it on the near plane (its far corner sits behind z=0 by more than
			// FRUSTUM_MARGIN), hiding the very chunks around the camera.
			const eyeInAABB =
				camPos.x >= minGX &&
				camPos.x <= maxGX &&
				camPos.y >= minGY &&
				camPos.y <= maxGY &&
				camPos.z >= minGZ &&
				camPos.z <= maxGZ;

			const inFrustum =
				inRange &&
				(DISABLE_FRUSTUM_CULL ||
					eyeInAABB ||
					aabbInFrustum(minGX, minGY, minGZ, maxGX, maxGY, maxGZ));

			// BFS reachability — hide groups sealed underground. Stage 1: BFS
			// disabled → every group is frustum-only (bypass the reachability
			// gate, which would otherwise hide every group below the queryId).
			const bypassBFS =
				!BFS_CAVE_CULLING_ENABLED || (isSurfaceGroup && !cameraUnderground);

			let vis: boolean;
			let bfsReachable = false;
			if (bypassBFS) {
				vis = inFrustum;
			} else {
				let bfsPrevious = false;
				const members = group.membersArray;
				for (let j = 0, mlen = members.length; j < mlen; j++) {
					const chunk = members[j]?.chunk;
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
			if (group.waterMeshRef && group.waterMeshRef.isVisible !== vis) {
				group.waterMeshRef.isVisible = vis;
			}
			if (group.cutoutMeshRef && group.cutoutMeshRef.isVisible !== vis) {
				group.cutoutMeshRef.isVisible = vis;
			}
		}

		out.total = total;
		out.occluded = total - visibleCount;
		out.timeMs = performance.now() - t0;
		this._lastTotal = total;
		this._lastOccluded = total - visibleCount;
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
		ensureNeighborRefs(newChunk);

		let qHead = 0;
		let qTail = 0;

		const neighborRefs = newChunk.neighborRefs;

		// Scan neighbours that already belong to this BFS pass
		for (let d = 0; d < 6; d++) {
			const neighbor = neighborRefs[d];
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
			if (newChunk.isDarkCached()) newSteps += 3;
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
			const curNeighborRefs = current.neighborRefs;

			for (let d = 0; d < 6; d++) {
				const nbr = curNeighborRefs[d];
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
				if (nbr.isDarkCached()) newSteps += 3;
				if (newSteps > MAX_BFS_STEPS) continue;

				// Connectivity gate
				if (entryFace >= 0) {
					const bit = FACE_PAIR_FLAT[entryFace * 6 + exitFace];
					if (!(curFc & (1 << bit))) continue;
				}
				if (nbr.bfsQueryId !== queryId) {
					ensureNeighborRefs(nbr);
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
			newChunk.mesh.visible = true;
			if (newChunk.waterMesh) newChunk.waterMesh.visible = true;
			if (newChunk.cutoutMesh) newChunk.cutoutMesh.visible = true;
		}
	}

	// ─── _startBFS ─────────────────────────────────────────────────────────────
	private _startBFS(camCX: number, camCY: number, camCZ: number): void {
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
			ensureNeighborRefs(originChunk);
			resetChunkBfs(originChunk, queryId);
			originChunk.bfsVisitedFaces = 1 << 7; // origin marker
			this._topoVisibleChunks.push(originChunk);
			_bfsChunks[qTail] = originChunk;
			_bfsEntry[qTail] = -1;
			_bfsSteps[qTail] = 0;
			qTail = 1;
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
			for (let i = 0; i < _nearbyChunksScratch.length; i++) {
				const chunk = _nearbyChunksScratch[i]!;
				if (chunk.bfsQueryId === queryId) continue;
				ensureNeighborRefs(chunk);
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
			const curNeighborRefs = current.neighborRefs;

			for (let d = 0; d < 6; d++) {
				const nbr = curNeighborRefs[d];
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
				if (nbr.isDarkCached()) newSteps += 3;
				if (newSteps > MAX_BFS_STEPS) continue;

				// Connectivity gate
				if (entryFace >= 0) {
					const bit = FACE_PAIR_FLAT[entryFace * 6 + exitFace]!;
					if (!(curFc & (1 << bit))) continue;
				}
				if (nbr.bfsQueryId !== queryId) {
					ensureNeighborRefs(nbr);
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
