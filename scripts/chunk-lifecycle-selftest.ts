/**
 * Standalone self-test for the ChunkLifecycle owner.
 *
 * Covers three layers:
 *   1. The pure transition tables (residency + mesh) — exhaustively, so any
 *      future edit that opens or closes a transition is caught here.
 *   2. The owner API driven through a mock host — the full load/unload and
 *      mesh-currency lifecycles, including idempotency and the abandon paths.
 *   3. The residency invariant checker — it must flag the orphan shape
 *      (`isTerrainScheduled && !isLoaded && !queued && !inFlight && !generating`)
 *      that the whole design exists to make unreachable.
 *
 * Zero game dependencies: ChunkLifecycle is intentionally import-free and
 * operates on a structural view + injectable host, so this test needs no
 * Chunk, worker pool, or scheduler. Run via `npm run selftest:lifecycle`
 * (or `npx tsx scripts/chunk-lifecycle-selftest.ts`).
 */
import {
	ChunkLifecycle,
	type ChunkLifecycleHost,
	type ChunkLifecycleView,
	deriveMeshState,
	deriveResidencyState,
	findResidencyInvariantViolation,
	hasChunkLifecycleHost,
	MeshState,
	nextMeshState,
	nextResidencyState,
	notifyResidencyLoadComplete,
	ResidencyState,
	setChunkLifecycleHost,
	setChunkLifecycleStrict,
	surveyResidencyInvariants,
} from "../src/code/World/Chunk/Loading/ChunkLifecycle.js";

let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
	if (cond) {
		console.log(`PASS ${name}`);
	} else {
		failures++;
		console.error(`FAIL ${name} ${detail}`);
	}
}

// ---------------------------------------------------------------------------
// Mock host — models the load queue / in-flight / generation / unload sets as
// sets of views, exactly the bookkeeping the real host will wrap.
// ---------------------------------------------------------------------------
class MockHost implements ChunkLifecycleHost {
	queued = new Set<ChunkLifecycleView>();
	inFlight = new Set<ChunkLifecycleView>();
	generating = new Set<ChunkLifecycleView>();
	unloading = new Set<ChunkLifecycleView>();
	remeshInFlight = new Set<ChunkLifecycleView>();

	isQueuedForLoad(v: ChunkLifecycleView): boolean {
		return this.queued.has(v);
	}
	isLoadInFlight(v: ChunkLifecycleView): boolean {
		return this.inFlight.has(v);
	}
	isGenerating(v: ChunkLifecycleView): boolean {
		return this.generating.has(v);
	}
	isUnloading(v: ChunkLifecycleView): boolean {
		return this.unloading.has(v);
	}
	isRemeshInFlight(v: ChunkLifecycleView): boolean {
		return this.remeshInFlight.has(v);
	}

	enqueueLoad(v: ChunkLifecycleView): void {
		// Model the controller's enqueue: mark queued + scheduled. The owner's
		// requestLoad delegates the isTerrainScheduled write to the host.
		this.queued.add(v);
		v.isTerrainScheduled = true;
	}
	moveLoadToInFlight(v: ChunkLifecycleView): void {
		this.queued.delete(v);
		this.inFlight.add(v);
	}
	moveInFlightToLoad(v: ChunkLifecycleView): void {
		this.inFlight.delete(v);
		this.queued.add(v);
	}
	clearInFlight(v: ChunkLifecycleView): void {
		this.inFlight.delete(v);
	}
	dropFromLoadPath(v: ChunkLifecycleView): void {
		this.queued.delete(v);
		this.inFlight.delete(v);
	}
	discardQueuedLoad(v: ChunkLifecycleView): void {
		this.queued.delete(v);
	}
	enqueueUnload(v: ChunkLifecycleView): void {
		this.unloading.add(v);
	}
	dequeueUnload(v: ChunkLifecycleView): void {
		this.unloading.delete(v);
	}
}

function makeView(): ChunkLifecycleView {
	return {
		isTerrainScheduled: false,
		isLoaded: false,
		hasVoxelData: false,
		isDirty: false,
		remeshQueued: false,
		rerunRemeshAfterInflight: false,
	};
}

// ---------------------------------------------------------------------------
// 1. Pure residency transition table — exhaustive.
// ---------------------------------------------------------------------------
{
	const R = ResidencyState;
	// from -> transition -> expected target (only the LEGAL pairs are listed).
	const legal: Array<[ResidencyState, string, ResidencyState]> = [
		[R.Absent, "requestLoad", R.Scheduled],
		[R.Scheduled, "dispatchLoad", R.Loading],
		[R.Scheduled, "requestUnload", R.Unloading],
		[R.Loading, "completeLoadVoxel", R.Loaded],
		[R.Loading, "completeLoadFarLod", R.LodOnly],
		[R.Loading, "abandonLoadRequeue", R.Scheduled],
		[R.Loading, "abandonLoadTerminal", R.Absent],
		[R.Loading, "requestUnload", R.Unloading],
		[R.Loaded, "requestUnload", R.Unloading],
		[R.LodOnly, "requestUnload", R.Unloading],
		[R.Unloading, "completeUnload", R.Absent],
	];
	const legalMap = new Map<string, ResidencyState>();
	for (const [from, t, to] of legal) {
		legalMap.set(`${from}|${t}`, to);
	}

	const transitions = [
		"requestLoad",
		"dispatchLoad",
		"completeLoadVoxel",
		"completeLoadFarLod",
		"abandonLoadRequeue",
		"abandonLoadTerminal",
		"requestUnload",
		"completeUnload",
	];
	const states = [
		R.Absent,
		R.Scheduled,
		R.Loading,
		R.Loaded,
		R.LodOnly,
		R.Unloading,
	];

	let legalOk = true;
	let illegalOk = true;
	for (const from of states) {
		for (const t of transitions) {
			const got = nextResidencyState(from, t as never);
			const expected = legalMap.get(`${from}|${t}`);
			if (expected !== undefined) {
				if (got !== expected) legalOk = false;
			} else if (got !== null) {
				illegalOk = false;
			}
		}
	}
	check(
		"residency table: all legal transitions map to the right target",
		legalOk,
	);
	check("residency table: every unlisted pair is illegal (null)", illegalOk);
}

// ---------------------------------------------------------------------------
// 2. Pure mesh transition table — exhaustive.
// ---------------------------------------------------------------------------
{
	const M = MeshState;
	const legal: Array<[MeshState, string, MeshState]> = [
		[M.Clean, "markDirty", M.Dirty],
		[M.Dirty, "markDirty", M.Dirty],
		[M.Dirty, "queueRemesh", M.Queued],
		[M.Clean, "queueRemesh", M.Queued],
		[M.Queued, "markDirty", M.Queued], // coalesce
		[M.Queued, "beginRemesh", M.Building],
		[M.Building, "markDirty", M.Superseded],
		[M.Superseded, "markDirty", M.Superseded], // stays superseded
		[M.Building, "completeRemesh", M.Clean],
		[M.Queued, "completeRemesh", M.Clean],
		[M.Superseded, "completeRemesh", M.Superseded], // apply, preserve rerun
		[M.Superseded, "rerunAfterInflight", M.Queued],
	];
	const legalMap = new Map<string, MeshState>();
	for (const [from, t, to] of legal) legalMap.set(`${from}|${t}`, to);

	const transitions = [
		"markDirty",
		"queueRemesh",
		"beginRemesh",
		"completeRemesh",
		"rerunAfterInflight",
	];
	const states = [M.Clean, M.Dirty, M.Queued, M.Building, M.Superseded];

	let legalOk = true;
	let illegalOk = true;
	for (const from of states) {
		for (const t of transitions) {
			const got = nextMeshState(from, t as never);
			const expected = legalMap.get(`${from}|${t}`);
			if (expected !== undefined) {
				if (got !== expected) legalOk = false;
			} else if (got !== null) {
				illegalOk = false;
			}
		}
	}
	check("mesh table: all legal transitions map to the right target", legalOk);
	check("mesh table: every unlisted pair is illegal (null)", illegalOk);
}

// ---------------------------------------------------------------------------
// 3. Owner: happy-path load lifecycle through the mock host.
// ---------------------------------------------------------------------------
setChunkLifecycleStrict(false);
{
	const host = new MockHost();
	setChunkLifecycleHost(host);
	const v = makeView();

	check(
		"owner: fresh view derives Absent",
		deriveResidencyState(v, host) === ResidencyState.Absent,
	);

	ChunkLifecycle.requestLoad(v);
	check(
		"owner: requestLoad → Scheduled",
		deriveResidencyState(v, host) === ResidencyState.Scheduled,
	);
	check("owner: requestLoad enqueued", host.isQueuedForLoad(v));
	check(
		"owner: requestLoad set isTerrainScheduled",
		v.isTerrainScheduled === true,
	);

	// Idempotent: a second requestLoad must not double-act.
	ChunkLifecycle.requestLoad(v);
	check(
		"owner: requestLoad idempotent (still Scheduled)",
		deriveResidencyState(v, host) === ResidencyState.Scheduled,
	);

	ChunkLifecycle.dispatchLoad(v);
	check(
		"owner: dispatchLoad → Loading",
		deriveResidencyState(v, host) === ResidencyState.Loading,
	);
	check(
		"owner: dispatchLoad moved to in-flight",
		host.isLoadInFlight(v) && !host.isQueuedForLoad(v),
	);

	v.hasVoxelData = true; // data layer populated voxels before completeLoad
	ChunkLifecycle.completeLoad(v);
	check(
		"owner: completeLoad(voxel) → Loaded",
		deriveResidencyState(v, host) === ResidencyState.Loaded,
	);
	check("owner: completeLoad cleared in-flight", !host.isLoadInFlight(v));
	check(
		"owner: completeLoad set isLoaded + cleared scheduled",
		v.isLoaded && !v.isTerrainScheduled,
	);
	check(
		"owner: loaded chunk has no invariant violation",
		findResidencyInvariantViolation(v, host) === null,
	);
}

// ---------------------------------------------------------------------------
// 4. Owner: far-LOD load (no voxel data) → LodOnly.
// ---------------------------------------------------------------------------
{
	const host = new MockHost();
	setChunkLifecycleHost(host);
	const v = makeView();
	ChunkLifecycle.requestLoad(v);
	ChunkLifecycle.dispatchLoad(v);
	// hasVoxelData stays false → far-LOD shell
	ChunkLifecycle.completeLoad(v);
	check(
		"owner: completeLoad(farLod) → LodOnly",
		deriveResidencyState(v, host) === ResidencyState.LodOnly,
	);
	check("owner: LodOnly is isLoaded", v.isLoaded === true);
}

// ---------------------------------------------------------------------------
// 5. Owner: abandon paths — the heart of the orphan fix.
// ---------------------------------------------------------------------------
{
	// requeue: Loading → Scheduled, back on the load queue, never orphaned.
	const host = new MockHost();
	setChunkLifecycleHost(host);
	const v = makeView();
	ChunkLifecycle.requestLoad(v);
	ChunkLifecycle.dispatchLoad(v);
	ChunkLifecycle.abandonLoad(v, "requeue");
	check(
		"owner: abandonLoad(requeue) → Scheduled",
		deriveResidencyState(v, host) === ResidencyState.Scheduled,
	);
	check(
		"owner: abandonLoad(requeue) back on load queue",
		host.isQueuedForLoad(v) && !host.isLoadInFlight(v),
	);
	check(
		"owner: requeued chunk has no invariant violation",
		findResidencyInvariantViolation(v, host) === null,
	);
}
{
	// terminal: Loading → Absent, flag cleared, nothing left dangling.
	const host = new MockHost();
	setChunkLifecycleHost(host);
	const v = makeView();
	ChunkLifecycle.requestLoad(v);
	ChunkLifecycle.dispatchLoad(v);
	ChunkLifecycle.abandonLoad(v, "terminal");
	check(
		"owner: abandonLoad(terminal) → Absent",
		deriveResidencyState(v, host) === ResidencyState.Absent,
	);
	check(
		"owner: abandonLoad(terminal) cleared scheduled + in-flight",
		!v.isTerrainScheduled && !host.isLoadInFlight(v),
	);
}

// ---------------------------------------------------------------------------
// 6. Owner: unload from each resident state, then complete.
// ---------------------------------------------------------------------------
for (const withVoxel of [true, false]) {
	const host = new MockHost();
	setChunkLifecycleHost(host);
	const v = makeView();
	ChunkLifecycle.requestLoad(v);
	ChunkLifecycle.dispatchLoad(v);
	v.hasVoxelData = withVoxel;
	ChunkLifecycle.completeLoad(v);
	ChunkLifecycle.requestUnload(v);
	check(
		`owner: requestUnload from ${withVoxel ? "Loaded" : "LodOnly"} → Unloading`,
		deriveResidencyState(v, host) === ResidencyState.Unloading,
	);
	check(
		"owner: requestUnload dropped from load path + enqueued unload",
		!host.isQueuedForLoad(v) && !host.isLoadInFlight(v) && host.isUnloading(v),
	);
	ChunkLifecycle.completeUnload(v);
	check(
		"owner: completeUnload → Absent",
		deriveResidencyState(v, host) === ResidencyState.Absent,
	);
	check(
		"owner: completeUnload cleared all flags",
		!v.isLoaded &&
			!v.isTerrainScheduled &&
			!v.isDirty &&
			!v.remeshQueued &&
			!v.rerunRemeshAfterInflight,
	);
}

// ---------------------------------------------------------------------------
// 7. Owner: unload wins over a pending load (no resurrection).
// ---------------------------------------------------------------------------
{
	const host = new MockHost();
	setChunkLifecycleHost(host);
	const v = makeView();
	ChunkLifecycle.requestLoad(v); // Scheduled
	ChunkLifecycle.requestUnload(v); // culled before it ever loaded
	check(
		"owner: unload of a Scheduled chunk → Unloading",
		deriveResidencyState(v, host) === ResidencyState.Unloading,
	);
	// A late requestLoad must NOT resurrect a chunk mid-unload.
	ChunkLifecycle.requestLoad(v);
	check(
		"owner: requestLoad during Unloading is a no-op (unload wins)",
		deriveResidencyState(v, host) === ResidencyState.Unloading,
	);
}

// ---------------------------------------------------------------------------
// 8. Owner: mesh-currency sub-machine, incl. supersede + rerun.
// ---------------------------------------------------------------------------
{
	const host = new MockHost();
	setChunkLifecycleHost(host);
	const v = makeView();

	check(
		"mesh: fresh view derives Clean",
		deriveMeshState(v, host) === MeshState.Clean,
	);
	ChunkLifecycle.markDirty(v);
	check(
		"mesh: markDirty → Dirty",
		deriveMeshState(v, host) === MeshState.Dirty,
	);
	ChunkLifecycle.queueRemesh(v);
	check(
		"mesh: queueRemesh → Queued",
		deriveMeshState(v, host) === MeshState.Queued,
	);
	// Coalesce: a change while Queued stays Queued.
	ChunkLifecycle.markDirty(v);
	check(
		"mesh: markDirty while Queued coalesces (stays Queued)",
		deriveMeshState(v, host) === MeshState.Queued,
	);
	ChunkLifecycle.beginRemesh(v);
	host.remeshInFlight.add(v);
	check(
		"mesh: beginRemesh → Building",
		deriveMeshState(v, host) === MeshState.Building,
	);
	// A change while Building supersedes the in-flight result.
	ChunkLifecycle.markDirty(v);
	check(
		"mesh: markDirty while Building → Superseded",
		deriveMeshState(v, host) === MeshState.Superseded,
	);
	check(
		"mesh: Superseded set rerunRemeshAfterInflight",
		v.rerunRemeshAfterInflight === true,
	);
	ChunkLifecycle.rerunAfterInflight(v);
	// The stale in-flight build is abandoned; the rerun is queued, not yet
	// re-dispatched — so the host no longer reports a current build in-flight.
	host.remeshInFlight.delete(v);
	check(
		"mesh: rerunAfterInflight → Queued",
		deriveMeshState(v, host) === MeshState.Queued,
	);
	check("mesh: rerun cleared the latch", v.rerunRemeshAfterInflight === false);
	ChunkLifecycle.completeRemesh(v);
	check(
		"mesh: completeRemesh → Clean",
		deriveMeshState(v, host) === MeshState.Clean,
	);
	check(
		"mesh: completeRemesh cleared dirty + queued",
		!v.isDirty && !v.remeshQueued,
	);
}

// ---------------------------------------------------------------------------
// 9. Invariant checker flags the orphan shape.
// ---------------------------------------------------------------------------
{
	const host = new MockHost();
	setChunkLifecycleHost(host);
	const v = makeView();
	// Simulate the exact bug: flag set, request lost, accounted for by nothing.
	v.isTerrainScheduled = true;
	const violation = findResidencyInvariantViolation(v, host);
	check(
		"invariant: orphan shape is flagged",
		typeof violation === "string" && violation.includes("orphan"),
		String(violation),
	);

	// Healthy Scheduled chunk (in the load queue) is not flagged.
	host.queued.add(v);
	check(
		"invariant: healthy Scheduled chunk is not flagged",
		findResidencyInvariantViolation(v, host) === null,
	);
}

// ---------------------------------------------------------------------------
// 10. Strict mode throws on an illegal transition.
// ---------------------------------------------------------------------------
{
	const host = new MockHost();
	setChunkLifecycleHost(host);
	const v = makeView();
	setChunkLifecycleStrict(true);
	let threw = false;
	try {
		// completeLoad from Absent is illegal.
		ChunkLifecycle.completeLoad(v);
	} catch {
		threw = true;
	}
	check("strict: illegal transition throws", threw);
	setChunkLifecycleStrict(false);

	// Non-strict: same illegal call logs and takes no action (stays Absent).
	const before = deriveResidencyState(v, host);
	ChunkLifecycle.completeLoad(v);
	check(
		"non-strict: illegal transition is a no-op",
		deriveResidencyState(v, host) === before &&
			before === ResidencyState.Absent,
	);
}

// ---------------------------------------------------------------------------
// 11. surveyResidencyInvariants — the Phase-2 watchdog helper.
// ---------------------------------------------------------------------------
{
	const host = new MockHost();
	// One healthy Scheduled chunk (queued) + one orphan (flag set, no queue).
	const healthy = makeView();
	healthy.isTerrainScheduled = true;
	host.queued.add(healthy);
	const orphan = makeView();
	orphan.isTerrainScheduled = true; // lost its request

	const result = surveyResidencyInvariants([healthy, orphan], host);
	check(
		"survey: counts exactly the one orphan",
		result.count === 1,
		`count=${result.count}`,
	);
	check(
		"survey: retains a bounded sample",
		result.samples.length === 1 && result.samples[0].view === orphan,
	);

	// limit bounds the retained samples but not the true count.
	const many: ChunkLifecycleView[] = [];
	for (let i = 0; i < 10; i++) {
		const v = makeView();
		v.isTerrainScheduled = true;
		many.push(v);
	}
	const capped = surveyResidencyInvariants(many, host, 3);
	check(
		"survey: count is total, samples are capped",
		capped.count === 10 && capped.samples.length === 3,
	);
}

// ---------------------------------------------------------------------------
// 12. requestLoad guard — exact replica of the controller's guard.
// ---------------------------------------------------------------------------
{
	const host = new MockHost();
	setChunkLifecycleHost(host);

	// Loaded chunk (has voxels): never re-requested, regardless of includeVoxelData.
	const loaded = makeView();
	loaded.isLoaded = true;
	loaded.hasVoxelData = true;
	ChunkLifecycle.requestLoad(loaded, {
		desiredLod: 0,
		revision: 1,
		includeVoxelData: true,
	});
	check(
		"requestLoad: Loaded chunk is not re-requested",
		!host.isQueuedForLoad(loaded) &&
			deriveResidencyState(loaded, host) === ResidencyState.Loaded,
	);

	// LodOnly chunk, includeVoxelData=false: not re-requested.
	const lodOnlyNoVoxel = makeView();
	lodOnlyNoVoxel.isLoaded = true;
	lodOnlyNoVoxel.hasVoxelData = false;
	ChunkLifecycle.requestLoad(lodOnlyNoVoxel, {
		desiredLod: 3,
		revision: 1,
		includeVoxelData: false,
	});
	check(
		"requestLoad: LodOnly + includeVoxelData=false is not re-requested",
		!host.isQueuedForLoad(lodOnlyNoVoxel),
	);

	// LodOnly chunk, includeVoxelData=true: re-requested to fetch voxels.
	const lodOnlyWantVoxel = makeView();
	lodOnlyWantVoxel.isLoaded = true;
	lodOnlyWantVoxel.hasVoxelData = false;
	ChunkLifecycle.requestLoad(lodOnlyWantVoxel, {
		desiredLod: 0,
		revision: 1,
		includeVoxelData: true,
	});
	check(
		"requestLoad: LodOnly + includeVoxelData=true IS re-requested",
		host.isQueuedForLoad(lodOnlyWantVoxel) &&
			lodOnlyWantVoxel.isTerrainScheduled,
	);

	// Absent chunk: enqueued.
	const absent = makeView();
	ChunkLifecycle.requestLoad(absent, { desiredLod: 0, revision: 1 });
	check(
		"requestLoad: Absent chunk is enqueued",
		host.isQueuedForLoad(absent) &&
			deriveResidencyState(absent, host) === ResidencyState.Scheduled,
	);
}

// ---------------------------------------------------------------------------
// 13. Mesh: a superseded chunk's in-flight result still applies, then re-runs.
// ---------------------------------------------------------------------------
{
	const host = new MockHost();
	setChunkLifecycleHost(host);
	const v = makeView();

	ChunkLifecycle.markDirty(v);
	ChunkLifecycle.queueRemesh(v);
	ChunkLifecycle.beginRemesh(v);
	host.remeshInFlight.add(v); // Building
	ChunkLifecycle.markDirty(v); // superseded while building
	check(
		"mesh: superseded latches rerun",
		v.rerunRemeshAfterInflight === true &&
			deriveMeshState(v, host) === MeshState.Superseded,
	);

	// The in-flight result lands: it still applies, but the rerun latch survives.
	ChunkLifecycle.completeRemesh(v);
	check(
		"mesh: completeRemesh on Superseded applies (dirty/queued clear)",
		!v.isDirty && !v.remeshQueued,
	);
	check(
		"mesh: completeRemesh on Superseded PRESERVES the rerun latch",
		v.rerunRemeshAfterInflight === true &&
			deriveMeshState(v, host) === MeshState.Superseded,
	);

	// The re-run is then driven by rerunAfterInflight.
	host.remeshInFlight.delete(v);
	ChunkLifecycle.rerunAfterInflight(v);
	check(
		"mesh: rerunAfterInflight re-queues and clears the latch",
		v.remeshQueued === true &&
			v.rerunRemeshAfterInflight === false &&
			deriveMeshState(v, host) === MeshState.Queued,
	);
}

// ---------------------------------------------------------------------------
// 14. Owner commands are total where production hot paths overlap:
// queueRemesh coalesces, begin/completeRemesh + completeUnload are idempotent.
// Strict mode must stay silent for all of these (they are normal races, not
// caller errors).
// ---------------------------------------------------------------------------
{
	const host = new MockHost();
	setChunkLifecycleHost(host);
	setChunkLifecycleStrict(true);
	let quiet = true;
	try {
		// Queued repeat.
		const q = makeView();
		ChunkLifecycle.markDirty(q);
		ChunkLifecycle.queueRemesh(q);
		ChunkLifecycle.queueRemesh(q);
		quiet &&= deriveMeshState(q, host) === MeshState.Queued;

		// Building repeat (cross-LOD schedule while a build runs).
		const b = makeView();
		ChunkLifecycle.markDirty(b);
		ChunkLifecycle.queueRemesh(b);
		ChunkLifecycle.beginRemesh(b);
		host.remeshInFlight.add(b);
		ChunkLifecycle.queueRemesh(b);
		quiet &&= deriveMeshState(b, host) === MeshState.Building;
		ChunkLifecycle.beginRemesh(b);
		quiet &&= deriveMeshState(b, host) === MeshState.Building;

		// Superseded repeat (heal-flush overlap).
		ChunkLifecycle.markDirty(b);
		ChunkLifecycle.queueRemesh(b);
		quiet &&= deriveMeshState(b, host) === MeshState.Superseded;

		// Double-apply.
		const c = makeView();
		ChunkLifecycle.markDirty(c);
		ChunkLifecycle.queueRemesh(c);
		ChunkLifecycle.completeRemesh(c);
		ChunkLifecycle.completeRemesh(c);
		quiet &&= deriveMeshState(c, host) === MeshState.Clean;

		// Double-dispose.
		const u = makeView();
		ChunkLifecycle.requestLoad(u);
		ChunkLifecycle.dispatchLoad(u);
		ChunkLifecycle.requestUnload(u);
		ChunkLifecycle.completeUnload(u);
		ChunkLifecycle.completeUnload(u);
		quiet &&= deriveResidencyState(u, host) === ResidencyState.Absent;
	} catch {
		quiet = false;
	}
	check("total commands: coalesce/idempotent paths are silent in strict", quiet);
	setChunkLifecycleStrict(false);
}

// ---------------------------------------------------------------------------
// 15. notifyResidencyLoadComplete — the data-layer completion hook.
// ---------------------------------------------------------------------------
{
	const host = new MockHost();
	setChunkLifecycleHost(host);
	check("notify: host is wired", hasChunkLifecycleHost());

	// Loading → completes through the owner.
	const v = makeView();
	ChunkLifecycle.requestLoad(v);
	ChunkLifecycle.dispatchLoad(v);
	v.hasVoxelData = true; // data layer installed voxels first
	check(
		"notify: Loading completes (true)",
		notifyResidencyLoadComplete(v) === true,
	);
	check(
		"notify: completed chunk is Loaded",
		deriveResidencyState(v, host) === ResidencyState.Loaded,
	);

	// Already Loaded → idempotent true (clears any stray in-flight).
	check(
		"notify: Loaded is idempotent (true)",
		notifyResidencyLoadComplete(v) === true,
	);

	// Absent (stale worker result for a culled chunk) → false: the caller
	// applies the legacy direct writes so the data install is not dropped.
	const stale = makeView();
	check(
		"notify: Absent is not completable (false)",
		notifyResidencyLoadComplete(stale) === false,
	);

	// No host (unit tests) → false.
	setChunkLifecycleHost(null);
	check(
		"notify: no host (false)",
		notifyResidencyLoadComplete(makeView()) === false,
	);
	check("notify: host unwired", !hasChunkLifecycleHost());
	setChunkLifecycleHost(host);
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) {
	throw new Error(`${failures} chunk-lifecycle self-test failure(s)`);
}
