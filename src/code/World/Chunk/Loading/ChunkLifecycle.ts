/**
 * ChunkLifecycle.ts — the single owner for a chunk's residency and
 * mesh-currency state.
 *
 * WHY THIS EXISTS
 * ---------------
 * A chunk's lifecycle used to be an *implicit* state machine spread across
 * ~10 independent booleans on `Chunk` (`isTerrainScheduled`, `isLoaded`,
 * `isDirty`, `remeshQueued`, `rerunRemeshAfterInflight`, …) mutated directly
 * by five subsystems with no transition guard. The invariant the whole
 * streaming system leans on was never enforced:
 *
 *   isTerrainScheduled === true  ⟺  the chunk is in exactly one of
 *     { load queue, in-flight storage read, queued worker generation }.
 *
 * When a request was dropped without clearing the flag *and* without
 * re-queueing, a chunk landed in `isTerrainScheduled && !isLoaded && !queued`
 * — invisible to reconcile / movement-rings / loaded-refresh forever (the
 * "world hole that only heals after a teleport" bug). Five separate ad-hoc
 * guards compensated for that: the orphan sweep, the IO timeout, remote
 * retry-park, backpressure re-queue, and the `rerunRemeshAfterInflight` flag.
 *
 * This module gives that question ONE owner. Subsystems *request* transitions
 * through {@link ChunkLifecycle}; they never set the flags directly. The
 * transition table makes the orphan state structurally unreachable:
 * `dispatchLoad` is the only exit from `Scheduled` and must register the
 * in-flight entry; `abandonLoad` is the only exit from `Loading` and must
 * either re-enqueue (→ Scheduled) or go terminal — never neither.
 *
 * DESIGN CONSTRAINTS
 * ------------------
 *  - **Import-free.** The module operates on a structural {@link
 *    ChunkLifecycleView} (the subset of `Chunk` fields it touches) and an
 *    injectable {@link ChunkLifecycleHost} (queue / in-flight queries + side
 *    effects). It never imports `Chunk`, `ChunkWorkerPool`, or the scheduler,
 *    so the transition core is unit-testable in isolation with plain objects
 *    (mirrors the import-free `FarTileFaceFormat` precedent).
 *  - **Stateless.** Current state is *derived* from the view + host on every
 *    call — there is no shadow `Map` that can desync from the booleans. The
 *    booleans remain the source of truth until Phase 4 derives them from this
 *    module.
 *  - **Phase 1 = no production callers yet.** This lands the owner + its
 *    tests; Phase 2 wires the real host and routes the load/unload writers
 *    through it, one subsystem per PR.
 *
 * See `plans/chunk-lifecycle-single-owner-design.md` for the full design.
 */

// ---------------------------------------------------------------------------
// Residency state — does the chunk exist and hold data?
//
// This is the dimension the orphan bug lives in.
//
// NOTE: a regular `enum`, not a `const enum`. Unlike the hot-path block enums
// (`MaterialType`), a lifecycle state is logged and debugged constantly — the
// Phase-0 invariant checker and the streaming watchdog both want to print the
// state name. A regular enum is reverse-mappable at runtime for free, whereas
// `const enum` inlines to bare integers and forces a parallel names array (the
// workaround `ChunkProcessScheduler` already carries for `ProcessStage`). The
// owner is per-chunk-per-transition, not per-voxel, so the inlining win is nil.
// ---------------------------------------------------------------------------
export enum ResidencyState {
	/** No live chunk / disposed. */
	Absent = 0,
	/** Desired; a load request exists but has not been dispatched. */
	Scheduled = 1,
	/** Request dispatched — awaiting a storage read or worker generation. */
	Loading = 2,
	/** Voxel + light data resident (near LOD). */
	Loaded = 3,
	/** Far-LOD shell resident, no voxel data. */
	LodOnly = 4,
	/** On the save/dispose queue. */
	Unloading = 5,
}

// ---------------------------------------------------------------------------
// Mesh-currency state — is the rendered mesh current? Orthogonal to residency.
//
// A `Loaded` chunk is always in some mesh sub-state.
// ---------------------------------------------------------------------------
// Regular `enum` for the same reverse-mapping reason as ResidencyState.
export enum MeshState {
	/** Mesh matches current voxel + light data. */
	Clean = 0,
	/** Data changed; no remesh requested yet. */
	Dirty = 1,
	/** Remesh requested, not yet dispatched to a worker. */
	Queued = 2,
	/** Remesh dispatched to a worker; result outstanding. */
	Building = 3,
	/** Data changed again while a remesh was Building — must rerun after. */
	Superseded = 4,
}

// ---------------------------------------------------------------------------
// Named transitions. Distinct names keep the table unambiguous where one
// logical operation has two outcomes (voxel vs far-LOD load; requeue vs
// terminal abandon).
// ---------------------------------------------------------------------------
export type ResidencyTransition =
	| "requestLoad"
	| "dispatchLoad"
	| "completeLoadVoxel"
	| "completeLoadFarLod"
	| "abandonLoadRequeue"
	| "abandonLoadTerminal"
	| "requestUnload"
	| "completeUnload";

export type MeshTransition =
	| "markDirty"
	| "queueRemesh"
	| "beginRemesh"
	| "completeRemesh"
	| "rerunAfterInflight";

// ---------------------------------------------------------------------------
// Structural view of the chunk fields the owner reads and writes.
//
// `Chunk` satisfies this structurally, so the owner never imports it. Tests
// pass plain object literals.
// ---------------------------------------------------------------------------
export interface ChunkLifecycleView {
	isTerrainScheduled: boolean;
	isLoaded: boolean;
	hasVoxelData: boolean;
	isDirty: boolean;
	remeshQueued: boolean;
	rerunRemeshAfterInflight: boolean;
}

/**
 * Payload for a load request, carried through `requestLoad` → `enqueueLoad`.
 * These are the streaming controller's request fields; the owner stays agnostic
 * to their meaning and simply forwards them to the host, which owns the enqueue
 * policy (desired-state tracking, request pooling, priority).
 */
export interface LoadRequest {
	desiredLod: number;
	revision: number;
	includeVoxelData?: boolean;
}

/**
 * Read-only queue / in-flight queries.
 *
 * These are all the derivation + invariant-checking paths need, so they are
 * split out from the full host: a read-only query object can be wired (and the
 * invariant checker activated against live data) WITHOUT committing to the
 * write-side migration. The real query object is backed by
 * `ChunkStreamingController` (`loadQueueRequestMap`, `_loadRequestsInFlight`),
 * `ChunkWorkerPool` (`terrainTaskQueue` via `isTerrainTaskQueued`), and the
 * unload set. Queries are keyed by the view so the owner stays
 * chunk-type-agnostic; the host maps the view back to its numericId / Chunk
 * internally.
 */
export interface ChunkLifecycleQueries {
	isQueuedForLoad(view: ChunkLifecycleView): boolean;
	isLoadInFlight(view: ChunkLifecycleView): boolean;
	isGenerating(view: ChunkLifecycleView): boolean;
	isUnloading(view: ChunkLifecycleView): boolean;
	/** Optional: distinguishes MeshState.Queued from Building. */
	isRemeshInFlight?(view: ChunkLifecycleView): boolean;
}

/**
 * The full host: read-only queries + the write-side side effects the owner
 * performs on a transition. Wired only once the load/unload writers are being
 * migrated through the owner (Phase 2b).
 */
export interface ChunkLifecycleHost extends ChunkLifecycleQueries {
	// --- side effects (the load-path bookkeeping that today is done ad-hoc) ---
	/** Add to the load queue (create or update the request for `request`). */
	enqueueLoad(view: ChunkLifecycleView, request?: LoadRequest): void;
	/** Move load-queue entry → in-flight (request is now being serviced). */
	moveLoadToInFlight(view: ChunkLifecycleView): void;
	/** Move in-flight entry → back onto the load queue (abandon + requeue). */
	moveInFlightToLoad(view: ChunkLifecycleView): void;
	/** Remove from the in-flight set (load completed or terminally abandoned). */
	clearInFlight(view: ChunkLifecycleView): void;
	/** Remove from BOTH the load queue and the in-flight set (unload wins). */
	dropFromLoadPath(view: ChunkLifecycleView): void;
	/** Add to the unload/save queue. */
	enqueueUnload(view: ChunkLifecycleView): void;
	/** Remove from the unload/save queue (dispose finished). */
	dequeueUnload(view: ChunkLifecycleView): void;
}

// ---------------------------------------------------------------------------
// Pure transition core — no view, no host, no side effects. This is the part
// that is exhaustively unit-tested.
// ---------------------------------------------------------------------------

/**
 * Legal residency transitions.
 *
 * @returns The target state, or `null` if the transition is illegal from
 * `from`. Idempotent no-ops (e.g. `requestLoad` on an already-`Scheduled`
 * chunk) are handled by the owner *before* consulting this table, so the
 * table only encodes real transitions and rejects impossible ones.
 */
export function nextResidencyState(
	from: ResidencyState,
	transition: ResidencyTransition,
): ResidencyState | null {
	switch (transition) {
		case "requestLoad":
			return from === ResidencyState.Absent ? ResidencyState.Scheduled : null;
		case "dispatchLoad":
			return from === ResidencyState.Scheduled ? ResidencyState.Loading : null;
		case "completeLoadVoxel":
			return from === ResidencyState.Loading ? ResidencyState.Loaded : null;
		case "completeLoadFarLod":
			return from === ResidencyState.Loading ? ResidencyState.LodOnly : null;
		case "abandonLoadRequeue":
			return from === ResidencyState.Loading ? ResidencyState.Scheduled : null;
		case "abandonLoadTerminal":
			return from === ResidencyState.Loading ? ResidencyState.Absent : null;
		case "requestUnload":
			return from === ResidencyState.Scheduled ||
				from === ResidencyState.Loading ||
				from === ResidencyState.Loaded ||
				from === ResidencyState.LodOnly
				? ResidencyState.Unloading
				: null;
		case "completeUnload":
			return from === ResidencyState.Unloading ? ResidencyState.Absent : null;
		default:
			return null;
	}
}

/** Whether `transition` is legal from `from`. */
export function canResidencyTransition(
	from: ResidencyState,
	transition: ResidencyTransition,
): boolean {
	return nextResidencyState(from, transition) !== null;
}

/** Legal mesh-currency transitions. @returns target state or `null`. */
export function nextMeshState(
	from: MeshState,
	transition: MeshTransition,
): MeshState | null {
	switch (transition) {
		case "markDirty":
			// Building → Superseded (in-flight result will be stale, rerun after).
			// Queued → Queued (coalesce: a remesh is already pending and will
			//   read the latest data when it runs — no re-queue needed).
			// Superseded → Superseded (another change while already superseded
			//   must NOT drop the rerun latch).
			// Clean/Dirty → Dirty.
			if (from === MeshState.Building) return MeshState.Superseded;
			if (from === MeshState.Queued) return MeshState.Queued;
			if (from === MeshState.Superseded) return MeshState.Superseded;
			return MeshState.Dirty;
		case "queueRemesh":
			return from === MeshState.Clean || from === MeshState.Dirty
				? MeshState.Queued
				: null;
		case "beginRemesh":
			return from === MeshState.Queued ? MeshState.Building : null;
		case "completeRemesh":
			// Queued/Building → Clean. Superseded → Superseded: the in-flight
			// result of a superseded chunk still applies (isDirty/remeshQueued
			// clear), but the rerun latch is PRESERVED so the re-run still fires
			// via rerunAfterInflight — matching the drain's behavior.
			if (from === MeshState.Queued || from === MeshState.Building) {
				return MeshState.Clean;
			}
			if (from === MeshState.Superseded) return MeshState.Superseded;
			return null;
		case "rerunAfterInflight":
			return from === MeshState.Superseded ? MeshState.Queued : null;
		default:
			return null;
	}
}

/** Whether `transition` is legal from `from` in the mesh sub-machine. */
export function canMeshTransition(
	from: MeshState,
	transition: MeshTransition,
): boolean {
	return nextMeshState(from, transition) !== null;
}

// ---------------------------------------------------------------------------
// Derivation — reconstruct the current state from the booleans + host. This is
// what lets the owner stay stateless and keeps the booleans as the source of
// truth until Phase 4.
// ---------------------------------------------------------------------------

/** Reconstruct the residency state of `view` from its flags + host queries. */
export function deriveResidencyState(
	view: ChunkLifecycleView,
	host: ChunkLifecycleQueries,
): ResidencyState {
	if (host.isUnloading(view)) {
		return ResidencyState.Unloading;
	}

	if (view.isLoaded) {
		return view.hasVoxelData ? ResidencyState.Loaded : ResidencyState.LodOnly;
	}

	if (!view.isTerrainScheduled) {
		return ResidencyState.Absent;
	}

	return host.isLoadInFlight(view) || host.isGenerating(view)
		? ResidencyState.Loading
		: ResidencyState.Scheduled;
}

/** Reconstruct the mesh-currency state of `view`. */
export function deriveMeshState(
	view: ChunkLifecycleView,
	host?: ChunkLifecycleQueries,
): MeshState {
	if (view.rerunRemeshAfterInflight) return MeshState.Superseded;
	if (view.remeshQueued) {
		return host?.isRemeshInFlight?.(view)
			? MeshState.Building
			: MeshState.Queued;
	}
	return view.isDirty ? MeshState.Dirty : MeshState.Clean;
}

// ---------------------------------------------------------------------------
// Invariant check — the Phase-0 diagnostic. Returns a human-readable
// description when `view` is in an inconsistent state, or `null` when healthy.
//
// The orphan shape is: wants to load, not loaded, and accounted for by NO
// queue (not queued, not in-flight, not generating, not unloading).
// ---------------------------------------------------------------------------
export function findResidencyInvariantViolation(
	view: ChunkLifecycleView,
	host: ChunkLifecycleQueries,
): string | null {
	const queued = host.isQueuedForLoad(view);
	const inFlight = host.isLoadInFlight(view);
	const generating = host.isGenerating(view);
	const unloading = host.isUnloading(view);

	const activeLoadLocationCount =
		Number(queued) + Number(inFlight) + Number(generating);

	if (unloading) {
		if (queued || inFlight || generating) {
			return "Unloading while still present in the load path";
		}

		if (view.isTerrainScheduled) {
			return "Unloading but isTerrainScheduled is still set";
		}

		return null;
	}

	if (view.isLoaded) {
		if (view.isTerrainScheduled) {
			return "Loaded but isTerrainScheduled is still set";
		}

		if (queued || inFlight || generating) {
			return "Loaded but still present in the load path";
		}

		return null;
	}

	if (!view.isTerrainScheduled) {
		if (queued) {
			return "Not scheduled but still present in the load queue";
		}

		if (inFlight) {
			return "Not scheduled but still marked as an in-flight load";
		}

		if (generating) {
			return "Not scheduled but still queued for worker generation";
		}

		return null;
	}

	if (activeLoadLocationCount === 0) {
		return "Scheduled but absent from the load queue, in-flight set, and generation queue (orphan)";
	}

	if (activeLoadLocationCount > 1) {
		return "Scheduled load is present in multiple load-path locations";
	}

	return null;
}

export interface ResidencyInvariantViolation {
	view: ChunkLifecycleView;
	reason: string;
}

/**
 * Walk `chunks` and collect every residency-invariant violation.
 *
 * Pure and host-driven, so it is unit-testable and needs no live subsystems.
 * The dev-only streaming watchdog calls this once a real host is wired
 * (Phase 2) to prove the orphan state is unreachable. `limit` bounds the
 * retained samples so a pathological world cannot allocate without bound;
 * `count` is always the true total.
 */
export function surveyResidencyInvariants(
	chunks: Iterable<ChunkLifecycleView>,
	host: ChunkLifecycleQueries,
	limit = 32,
): { count: number; samples: ResidencyInvariantViolation[] } {
	const sampleLimit =
		Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;

	let count = 0;
	const samples: ResidencyInvariantViolation[] = [];

	for (const view of chunks) {
		const reason = findResidencyInvariantViolation(view, host);

		if (reason === null) {
			continue;
		}

		count++;

		if (samples.length < sampleLimit) {
			samples.push({ view, reason });
		}
	}

	return { count, samples };
}

// ---------------------------------------------------------------------------
// The owner.
// ---------------------------------------------------------------------------

let activeHost: ChunkLifecycleHost | null = null;
/**
 * Read-only queries, published independently of the write host so the
 * invariant checker can run against live data before any writer is migrated.
 * A full host implies its queries, so `setChunkLifecycleHost` sets both.
 */
let activeQueries: ChunkLifecycleQueries | null = null;
/**
 * When true, an illegal transition throws (dev / CI). When false (default,
 * production), it logs and takes no action — the safest correction, since
 * guessing a recovery could itself orphan a chunk.
 */
let strict = false;

/** Inject the real host. Called once during Phase-2 wiring. */
export function setChunkLifecycleHost(host: ChunkLifecycleHost | null): void {
	activeHost = host;
	activeQueries = host;
}

/**
 * Publish read-only queries WITHOUT the write host. Lets the invariant checker
 * (`surveyResidencyInvariants` / `findResidencyInvariantViolation`) run against
 * live chunk data before the load/unload writers are migrated.
 */
export function setChunkLifecycleQueries(
	queries: ChunkLifecycleQueries | null,
): void {
	activeQueries = queries;
}

/** The currently published read-only queries, or null if none are wired. */
export function getChunkLifecycleQueries(): ChunkLifecycleQueries | null {
	return activeQueries;
}

/** Toggle strict mode (throw on illegal transition). */
export function setChunkLifecycleStrict(value: boolean): void {
	strict = value;
}

/**
 * Whether a production host is wired. Data-layer completion sites
 * (`Chunk.loadFromStorage`, worker ingestion) use this to decide between the
 * owner transition and the legacy direct flag writes — the writes are
 * identical either way, so unit tests without a host keep today's behavior.
 */
export function hasChunkLifecycleHost(): boolean {
	return activeHost !== null;
}

function reportIllegal(
	transition: ResidencyTransition | MeshTransition,
	from: number,
): void {
	const msg =
		`[ChunkLifecycle] illegal transition "${transition}" from state ${from}. ` +
		`No action taken.`;
	if (strict) {
		throw new Error(msg);
	}
	console.error(msg);
}

/** Write the residency booleans to match `state`. `hasVoxelData` is data-owned
 *  and is never written here — the Loaded/LodOnly distinction is derived. */
function writeResidencyBooleans(
	view: ChunkLifecycleView,
	state: ResidencyState,
): void {
	switch (state) {
		case ResidencyState.Absent:
			view.isTerrainScheduled = false;
			view.isLoaded = false;
			break;
		case ResidencyState.Scheduled:
			view.isTerrainScheduled = true;
			view.isLoaded = false;
			break;
		case ResidencyState.Loading:
			view.isTerrainScheduled = true;
			view.isLoaded = false;
			break;
		case ResidencyState.Loaded:
		case ResidencyState.LodOnly:
			view.isTerrainScheduled = false;
			view.isLoaded = true;
			break;
		case ResidencyState.Unloading:
			// Still resident until completeUnload; no longer wants loading.
			view.isTerrainScheduled = false;
			break;
	}
}

function requireHost(): ChunkLifecycleHost {
	if (activeHost === null) {
		throw new Error(
			"[ChunkLifecycle] no host set — call setChunkLifecycleHost() first.",
		);
	}
	return activeHost;
}

export const ChunkLifecycle = {
	// ---- residency ----

	/**
	 * Ensure a chunk is queued for load. This is a COMMAND, not a pure table
	 * transition: the controller's enqueue also updates an existing request's
	 * desiredLod/revision, which the discrete transition table doesn't model.
	 * The owner owns the "don't re-request a chunk that already holds the
	 * requested data" guard — an exact replica of the controller's, using the
	 * raw flags — and delegates the enqueue to the host.
	 */
	requestLoad(view: ChunkLifecycleView, request?: LoadRequest): ResidencyState {
		const host = requireHost();
		const includeVoxelData =
			request?.includeVoxelData ?? (request ? request.desiredLod <= 1 : true);
		// Exact replica of the controller's guard (raw flags, unchanged): a
		// chunk that already holds the requested data is not re-requested.
		if (view.isLoaded && (!includeVoxelData || view.hasVoxelData)) {
			return deriveResidencyState(view, host);
		}

		/*
		 * The owner must write the scheduled flag. Otherwise enqueueLoad
		 * remains an implicit flag owner, contradicting this module's
		 * contract.
		 *
		 * Enqueue first so an exception cannot leave the chunk marked as
		 * scheduled without a queue entry.
		 */
		host.enqueueLoad(view, request);
		writeResidencyBooleans(view, ResidencyState.Scheduled);

		return ResidencyState.Scheduled;
	},

	/** The scheduler dequeued the request and is servicing it. Scheduled → Loading. */
	dispatchLoad(view: ChunkLifecycleView): ResidencyState {
		const host = requireHost();
		const cur = deriveResidencyState(view, host);
		if (cur === ResidencyState.Loading) return cur; // idempotent
		const next = nextResidencyState(cur, "dispatchLoad");
		if (next === null) {
			reportIllegal("dispatchLoad", cur);
			return cur;
		}

		/*
		 * Update host bookkeeping first. If it throws, the flags still
		 * describe the original queued state.
		 */
		host.moveLoadToInFlight(view);
		writeResidencyBooleans(view, next);

		return next;
	},

	/**
	 * A load finished. Loading → Loaded (voxel) or LodOnly (far-LOD shell).
	 * The voxel/far-LOD outcome is chosen from `view.hasVoxelData`, which the
	 * data layer has already set by the time this is called.
	 */
	completeLoad(view: ChunkLifecycleView): ResidencyState {
		const host = requireHost();
		const cur = deriveResidencyState(view, host);

		/*
		 * A completion can arrive after the data layer has already set
		 * isLoaded. In that case the in-flight entry must still be cleared.
		 */
		if (cur === ResidencyState.Loaded || cur === ResidencyState.LodOnly) {
			host.clearInFlight(view);
			writeResidencyBooleans(view, cur);
			return cur;
		}

		const transition: ResidencyTransition = view.hasVoxelData
			? "completeLoadVoxel"
			: "completeLoadFarLod";
		const next = nextResidencyState(cur, transition);
		if (next === null) {
			reportIllegal(transition, cur);
			return cur;
		}
		host.clearInFlight(view);
		writeResidencyBooleans(view, next);

		return next;
	},

	/**
	 * A load did not complete. Loading → Scheduled (requeue) or Absent
	 * (terminal). This is the single home for the IO-timeout / remote-exhausted
	 * / backpressure recovery policy that today lives in three places.
	 */
	abandonLoad(
		view: ChunkLifecycleView,
		mode: "requeue" | "terminal",
	): ResidencyState {
		const host = requireHost();
		const cur = deriveResidencyState(view, host);
		const transition: ResidencyTransition =
			mode === "requeue" ? "abandonLoadRequeue" : "abandonLoadTerminal";
		const next = nextResidencyState(cur, transition);
		if (next === null) {
			reportIllegal(transition, cur);
			return cur;
		}

		if (mode === "requeue") {
			host.moveInFlightToLoad(view);
		} else {
			host.clearInFlight(view);
		}

		writeResidencyBooleans(view, next);
		return next;
	},

	/** Chunk is no longer wanted. → Unloading; removed from the load path. */
	requestUnload(view: ChunkLifecycleView): ResidencyState {
		const host = requireHost();
		const cur = deriveResidencyState(view, host);
		if (cur === ResidencyState.Unloading || cur === ResidencyState.Absent) {
			return cur; // idempotent / nothing to unload
		}
		const next = nextResidencyState(cur, "requestUnload");
		if (next === null) {
			reportIllegal("requestUnload", cur);
			return cur;
		}

		/*
		 * Establish the unload queue before exposing Unloading through flags.
		 * If enqueueUnload can throw, dropFromLoadPath and enqueueUnload
		 * should ideally be combined into one transactional host operation.
		 */
		host.dropFromLoadPath(view);
		host.enqueueUnload(view);
		writeResidencyBooleans(view, next);

		return next;
	},

	/** Dispose finished. Unloading → Absent; clears the mesh flags too. */
	completeUnload(view: ChunkLifecycleView): ResidencyState {
		const host = requireHost();
		const cur = deriveResidencyState(view, host);
		if (cur === ResidencyState.Absent) return cur; // idempotent (double-dispose)
		const next = nextResidencyState(cur, "completeUnload");
		if (next === null) {
			reportIllegal("completeUnload", cur);
			return cur;
		}

		host.dequeueUnload(view);
		writeResidencyBooleans(view, next);
		// Mirror Chunk.dispose's mesh-flag resets so a pooled chunk starts clean.
		view.isDirty = false;
		view.remeshQueued = false;
		view.rerunRemeshAfterInflight = false;
		return next;
	},

	// ---- mesh currency ----

	/** Data changed. Building → Superseded; otherwise → Dirty. */
	markDirty(view: ChunkLifecycleView): MeshState {
		const cur = deriveMeshState(view, activeQueries ?? undefined);
		const next = nextMeshState(cur, "markDirty");
		if (next === null) {
			reportIllegal("markDirty", cur);
			return cur;
		}
		view.isDirty = true;
		// Only the Building → Superseded edge needs the rerun latch; the Queued
		// coalesce and Clean/Dirty edges just keep isDirty set.
		if (next === MeshState.Superseded) {
			view.rerunRemeshAfterInflight = true;
		}
		return next;
	},

	/**
	 * Request a remesh. Clean/Dirty → Queued; every other state coalesces
	 * silently (Queued: repeat; Building: a build is already running, and the
	 * cross-LOD case is healed post-hoc by the drain's other-LOD path;
	 * Superseded: the re-run is already latched). The caller always refreshes
	 * its own queue entry; this owns only the flag writes. Total function by
	 * design — like requestLoad, it is a command, not a pure table step.
	 */
	queueRemesh(view: ChunkLifecycleView): MeshState {
		const cur = deriveMeshState(view, activeQueries ?? undefined);
		if (
			cur === MeshState.Queued ||
			cur === MeshState.Building ||
			cur === MeshState.Superseded
		) {
			return cur;
		}
		const next = nextMeshState(cur, "queueRemesh");
		if (next === null) {
			reportIllegal("queueRemesh", cur);
			return cur;
		}
		view.isDirty = true;
		view.remeshQueued = true;
		return next;
	},

	/** The pool dispatched the remesh to a worker. Queued → Building. */
	beginRemesh(view: ChunkLifecycleView): MeshState {
		const cur = deriveMeshState(view, activeQueries ?? undefined);
		if (cur === MeshState.Building) return cur; // idempotent (double-dispatch)
		const next = nextMeshState(cur, "beginRemesh");
		if (next === null) {
			reportIllegal("beginRemesh", cur);
			return cur;
		}

		/*
		 * Building is represented by host.isRemeshInFlight(). The worker
		 * pool must register the in-flight build before or immediately
		 * after this call. No view boolean distinguishes Queued from
		 * Building.
		 */
		return next;
	},

	/** A remesh result landed. Queued/Building → Clean. */
	completeRemesh(view: ChunkLifecycleView): MeshState {
		const cur = deriveMeshState(view, activeQueries ?? undefined);
		if (cur === MeshState.Clean) return cur; // idempotent (double-apply)
		const next = nextMeshState(cur, "completeRemesh");
		if (next === null) {
			reportIllegal("completeRemesh", cur);
			return cur;
		}
		view.isDirty = false;
		view.remeshQueued = false;
		// Deliberately does NOT clear rerunRemeshAfterInflight: a superseded
		// chunk's in-flight result still applies, and the re-run is driven by
		// rerunAfterInflight (which clears the latch when it re-queues).
		return next;
	},

	/** Re-run a remesh that was superseded while building. Superseded → Queued. */
	rerunAfterInflight(view: ChunkLifecycleView): MeshState {
		const cur = deriveMeshState(view, activeQueries ?? undefined);
		const next = nextMeshState(cur, "rerunAfterInflight");
		if (next === null) {
			reportIllegal("rerunAfterInflight", cur);
			return cur;
		}
		view.rerunRemeshAfterInflight = false;
		view.remeshQueued = true;
		return next;
	},
};

/**
 * Data-layer completion hook: a load finished installing voxel/far-LOD data
 * into `view` (the data layer already set `hasVoxelData` accordingly).
 *
 * Routes `Loading → Loaded/LodOnly` through the owner when the chunk is in a
 * completable state, performing the flag writes + in-flight clear. Returns
 * `false` when there is no host (unit tests) or the chunk is not completable
 * (stale worker result for a culled/recycled chunk, unload winning a race) —
 * the caller must then apply the legacy direct writes so the data install is
 * never dropped. Either branch leaves identical flag values.
 */
export function notifyResidencyLoadComplete(view: ChunkLifecycleView): boolean {
	const host = activeHost;
	if (host === null) return false;
	const cur = deriveResidencyState(view, host);
	if (
		cur === ResidencyState.Loading ||
		cur === ResidencyState.Loaded ||
		cur === ResidencyState.LodOnly
	) {
		ChunkLifecycle.completeLoad(view);
		return true;
	}
	return false;
}
