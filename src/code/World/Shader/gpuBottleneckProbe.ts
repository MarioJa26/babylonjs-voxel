/**
 * GPU bottleneck probe — answers "which part of the GPU work is slow?"
 *
 * DevTools only shows total load, and WebGPU timestamp writes are per
 * render-pass, not per draw. This scene renders through a single automatic
 * frame-graph task ("scene"), so per-draw GPU times are not available at
 * all. The probe therefore combines three Lite-native instruments:
 *
 *   1. Whole-frame GPU execution time (`engine.gpuFrameTimeMs`, updated 1-2
 *      frames behind via async readback). This is EXECUTION time, unlike the
 *      queue-drain "GPU Lag" signal in liteGpuBuffer, which measures backlog.
 *   2. Per-task GPU times (`getRenderTaskGpuTimings`) — today a single
 *      "scene" entry; still useful as a second opinion on the frame number.
 *   3. Automated bucket bisect: hide far tiles (F6 path) / chunk meshes (F7
 *      path) one at a time and record median GPU ms per phase. The deltas
 *      attribute GPU time to each bucket without any per-draw timers.
 *   4. Overdraw replay probe (`measureRenderTaskOverdrawCost`): replays the
 *      scene task as-is vs. visible-only (perfect-prepass floor) vs.
 *      front-to-back sorted, reporting msAsIs / overdrawMs / sortGainMs.
 *
 * Everything is a no-op on devices without the `timestamp-query` feature
 * (Lite requests it opportunistically at `createEngine`; nothing to do
 * here). Enabling installs three tiny per-frame hooks inside Lite; while
 * disabled the cost is effectively zero.
 */
import {
	type Camera,
	type EngineContext,
	getFrameGraph,
	getRenderTaskGpuTimings,
	getViewMatrix,
	isGpuTimingSupported,
	isRenderTaskGpuTimingSupported,
	measureRenderTaskOverdrawCost,
	onBeforeRender,
	type RenderTask,
	type SceneContext,
	setGpuTimingEnabled,
	setRenderTaskGpuTimingEnabled,
} from "@babylonjs/lite";
import { getAllGroups } from "../Chunk/Meshing/MergedMeshManager";
import { FarTileManager } from "../FarTiles/FarTileManager";
import { isMeshCulled } from "../MeshVisibility";

let probeEnabled = false;
let bisectRunning = false;
let lastBisectSummary = "F10 to run (stand still, streaming settled)";

/** Whether the device can do GPU timing at all. */
export function isGpuProbeSupported(engine: EngineContext): boolean {
	return isGpuTimingSupported(engine);
}

/** Whether the probe is currently recording. */
export function isGpuProbeEnabled(): boolean {
	return probeEnabled;
}

/** Whether a bisect run is currently in flight (F10 re-press guard). */
export function isBisectRunning(): boolean {
	return bisectRunning;
}

/** One-line status of the last automated bisect, for the HUD. */
export function getLastBisectSummary(): string {
	return lastBisectSummary;
}

/**
 * Enable/disable whole-frame + per-task GPU timing. The per-task enable is
 * async (dynamic-imports the profiler chunk on first use); failures only
 * log, the frame timer keeps working.
 */
export function setGpuProbeEnabled(
	engine: EngineContext,
	enabled: boolean,
): void {
	probeEnabled = enabled;
	setGpuTimingEnabled(engine, enabled);
	if (enabled && isRenderTaskGpuTimingSupported(engine)) {
		void setRenderTaskGpuTimingEnabled(engine, true).catch((e: unknown) => {
			console.warn("[GpuProbe] per-task timing enable failed:", e);
		});
	} else if (!enabled) {
		void setRenderTaskGpuTimingEnabled(engine, false).catch(() => {});
	}
	console.info(
		`[GpuProbe] ${enabled ? "enabled" : "disabled"}` +
			(isGpuTimingSupported(engine)
				? " (timestamp-query active, readback lags 1-2 frames)"
				: " — UNSUPPORTED on this device, HUD will stay at 0"),
	);
}

/**
 * F9 cycle: off → timings → timings+liveSort → off. The live sort needs
 * timings anyway (it is measured through them), so a single cycle key
 * keeps the diagnostic states coherent with zero key-binding conflicts.
 */
export function cycleGpuProbe(
	engine: EngineContext,
	scene: SceneContext,
): string {
	if (!probeEnabled) {
		setGpuProbeEnabled(engine, true);
		return "timings";
	}
	if (!liveSortEnabled) {
		setLiveSortEnabled(scene, true);
		return "timings+sort";
	}
	setLiveSortEnabled(scene, false);
	setGpuProbeEnabled(engine, false);
	return "off";
}

export interface GpuExecSnapshot {
	supported: boolean;
	enabled: boolean;
	/** Median-agnostic latest readback; 0 until the first measured frame. */
	frameMs: number;
	draws: number;
	taskStatus: string;
	tasks: readonly { name: string; ms: number }[];
	droppedTasks: number;
}

/** Cheap per-frame snapshot for the HUD (no allocations beyond the row). */
export function getGpuExecSnapshot(engine: EngineContext): GpuExecSnapshot {
	const supported = isGpuTimingSupported(engine);
	if (!supported) {
		return {
			supported,
			enabled: false,
			frameMs: 0,
			draws: engine.drawCallCount,
			taskStatus: "unsupported",
			tasks: [],
			droppedTasks: 0,
		};
	}
	const timings = getRenderTaskGpuTimings(engine);
	return {
		supported,
		enabled: probeEnabled,
		frameMs: engine.gpuFrameTimeMs,
		draws: engine.drawCallCount,
		taskStatus: timings.status,
		tasks: timings.tasks.map((t) => ({ name: t.name, ms: t.durationMs })),
		droppedTasks: timings.droppedTaskCount,
	};
}

// ---------------------------------------------------------------------------
// Automated bucket bisect
// ---------------------------------------------------------------------------

export interface BucketVisibility {
	isFarVisible: () => boolean;
	setFarVisible: (visible: boolean) => void;
	isChunksVisible: () => boolean;
	setChunksVisible: (visible: boolean) => void;
}

export interface BisectPhaseResult {
	label: string;
	/** Median GPU execution ms across the phase samples. */
	gpuMs: number;
	draws: number;
	/**
	 * DRAWN (not resident) faces: chunk sum skips culled groups and honors
	 * the phase mask below; far faces are exact (never culled). Distant
	 * clipmap / sky / mobs / particles are not counted (rest bucket).
	 */
	chunkFaces: number;
	farFaces: number;
	samples: number;
}

/**
 * Exact drawn-face census per bucket. Chunk side sums per-layer group
 * totals for non-culled groups only (frustum + BFS); far side is exact
 * because far meshes are never culled. `getAllGroups` returns a reused
 * array — consumed synchronously, never retained.
 */
export function getDrawnBucketFaces(
	countChunks: boolean,
	countFar: boolean,
): { chunkFaces: number; farFaces: number } {
	let chunkFaces = 0;
	let farFaces = 0;
	try {
		if (countChunks) {
			const groups = getAllGroups();
			for (let i = 0; i < groups.length; i++) {
				const g = groups[i];
				if (!isMeshCulled(g.opaqueMeshRef)) chunkFaces += g.totalOpaqueFaces;
				if (!isMeshCulled(g.waterMeshRef)) chunkFaces += g.totalWaterFaces;
				if (!isMeshCulled(g.cutoutMeshRef)) chunkFaces += g.totalCutoutFaces;
			}
		}
		if (countFar) {
			const far = FarTileManager.getDebugStats();
			if (far) {
				for (const level of far.levels) farFaces += level.faces;
				farFaces += far.water.faces;
			}
		}
	} catch {
		// Diagnostic only — never break the bisect on stats.
	}
	return { chunkFaces, farFaces };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// GPU readback lags 1-2 frames behind the commands it measures, so each
// phase settles first, then collects wall-clock-spaced samples and reports
// the median (robust against one-off hitches and streaming bursts).
const PHASE_SETTLE_MS = 400;
const PHASE_SAMPLE_MS = 120;
const PHASE_SAMPLES = 12;

async function samplePhase(
	engine: EngineContext,
	label: string,
	countChunks: boolean,
	countFar: boolean,
): Promise<BisectPhaseResult> {
	await sleep(PHASE_SETTLE_MS);
	const samples: number[] = [];
	let draws = engine.drawCallCount;
	for (let i = 0; i < PHASE_SAMPLES; i++) {
		await sleep(PHASE_SAMPLE_MS);
		samples.push(engine.gpuFrameTimeMs);
		draws = engine.drawCallCount;
	}
	samples.sort((a, b) => a - b);
	const { chunkFaces, farFaces } = getDrawnBucketFaces(countChunks, countFar);
	return {
		label,
		gpuMs: samples[samples.length >> 1],
		draws,
		chunkFaces,
		farFaces,
		samples: samples.length,
	};
}

/**
 * Stand-still bucket bisect. Requires the probe (enables it when off) and
 * settled streaming — run only when pending/mesh queues are drained, or the
 * upload bursts pollute every phase equally and the deltas still roughly
 * hold but the absolute numbers do not.
 *
 * Restores both visibility flags in a finally block. Re-entrant calls are
 * rejected while a run is in flight.
 */
export async function runBucketBisect(
	engine: EngineContext,
	scene: SceneContext,
	visibility: BucketVisibility,
): Promise<BisectPhaseResult[] | null> {
	if (!isGpuTimingSupported(engine)) {
		lastBisectSummary = "unsupported (no timestamp-query)";
		console.warn("[GpuProbe] bisect skipped: timestamp-query unsupported");
		return null;
	}
	if (bisectRunning) {
		console.warn("[GpuProbe] bisect already running");
		return null;
	}
	bisectRunning = true;
	if (!probeEnabled) setGpuProbeEnabled(engine, true);
	// Bisect measures the default (unsorted) submission order so runs stay
	// comparable and the overdraw replay's sort-gain stays meaningful.
	const wasSort = isLiveSortEnabled();
	if (wasSort) setLiveSortEnabled(scene, false);

	const wasFar = visibility.isFarVisible();
	const wasChunks = visibility.isChunksVisible();
	const phases: BisectPhaseResult[] = [];
	try {
		console.info(
			"[GpuProbe] bisect start — stand still, do not move the camera",
		);
		phases.push(await samplePhase(engine, "all-on", true, true));
		visibility.setFarVisible(false);
		phases.push(await samplePhase(engine, "far-off", true, false));
		visibility.setFarVisible(true);
		visibility.setChunksVisible(false);
		phases.push(await samplePhase(engine, "chunks-off", false, true));
		visibility.setFarVisible(false);
		phases.push(await samplePhase(engine, "both-off", false, false));
	} finally {
		// Restore FIRST: the overdraw replay below skips hidden meshes, so
		// running it while buckets are hidden would measure only the rest.
		visibility.setFarVisible(wasFar);
		visibility.setChunksVisible(wasChunks);
	}

	if (phases.length === 4) {
		const base = phases[0].gpuMs;
		const baseDraws = phases[0].draws;
		const fmt = (ms: number) => `${ms.toFixed(2)}ms`;
		const fmtFaces = (p: BisectPhaseResult) =>
			`(${(p.chunkFaces / 1e6).toFixed(2)}Mchk+${(p.farFaces / 1e6).toFixed(2)}Mfar)`;
		const fmtDraws = (p: BisectPhaseResult) => {
			const d = p.draws - baseDraws;
			return `${p.draws} draws Δ${d > 0 ? "+" : ""}${d}`;
		};
		console.info(
			"[GpuProbe] bisect GPU medians: " +
				phases
					.map(
						(p) => `${p.label}=${fmt(p.gpuMs)} (${fmtDraws(p)} ${fmtFaces(p)})`,
					)
					.join(" "),
		);
		if (base > 0) {
			const farDelta = phases[0].gpuMs - phases[1].gpuMs;
			const chunkDelta = phases[0].gpuMs - phases[2].gpuMs;
			// A toggle that changed ~0 draws cannot have its ms delta
			// attributed to bucket work — it is depth interaction, queue
			// backlog, or noise. Flag it instead of reporting a bogus %.
			const flagIfNoDrawChange = (phase: BisectPhaseResult, delta: number) =>
				phase.draws === baseDraws && Math.abs(delta) > 0.2
					? " [Δ0 draws: noise/interaction, not bucket work]"
					: "";
			const farNote = flagIfNoDrawChange(phases[1], farDelta);
			const chunkNote = flagIfNoDrawChange(phases[2], chunkDelta);
			console.info(
				`[GpuProbe] attribution vs baseline ${fmt(base)}: ` +
					`far-tiles ${fmt(farDelta)} (${((farDelta / base) * 100).toFixed(0)}%)${farNote}, ` +
					`chunk-meshes ${fmt(chunkDelta)} (${((chunkDelta / base) * 100).toFixed(0)}%)${chunkNote}, ` +
					`rest ${fmt(phases[3].gpuMs)} (sky/water/distant/transparent)`,
			);
			lastBisectSummary =
				`base ${fmt(base)} far -${fmt(farDelta)} chunks -${fmt(chunkDelta)} ` +
				`rest ${fmt(phases[3].gpuMs)}`;
		}
	}

	// Full-scene overdraw AFTER restore + one settled frame, so the replay
	// sees every bucket. Never throws (failures are caught inside).
	await sleep(600);
	try {
		lastBisectSummary += ` | ${await measureSceneOverdraw(engine, scene)}`;
	} finally {
		if (wasSort) setLiveSortEnabled(scene, true);
		bisectRunning = false;
	}
	console.info("[GpuProbe] bisect done, visibility restored");
	return phases;
}

// ---------------------------------------------------------------------------
// Overdraw replay probe
// ---------------------------------------------------------------------------

interface FrameGraphWithTasks {
	_tasks?: { name?: string }[];
}

/**
 * Replays the scene task three ways (as-is / visible-only prepass floor /
 * front-to-back sorted) and reports where fragment time goes. Answers
 * "is overdraw the bottleneck" and "would draw sorting pay off" directly.
 * Takes a few seconds (27 full-scene replays by default); run settled.
 */
export async function measureSceneOverdraw(
	engine: EngineContext,
	scene: SceneContext,
): Promise<string> {
	try {
		const fg = getFrameGraph(scene) as unknown as FrameGraphWithTasks;
		const tasks = fg._tasks ?? [];
		const found = tasks.find((t) => t?.name === "scene") ?? tasks[0];
		if (!found) return "no scene task";
		const m = await measureRenderTaskOverdrawCost(
			engine,
			found as unknown as RenderTask,
		);
		const fmt = (ms: number) => `${ms.toFixed(2)}ms`;
		const summary =
			`overdraw as-is ${fmt(m.msAsIs)} visible-only ${fmt(m.msVisibleOnly)} ` +
			`wasted ${fmt(m.overdrawMs)} (x${m.ratio.toFixed(2)}) ` +
			`sort-gain ${fmt(m.sortGainMs)} [${m.bindings} bindings, MSAA${m.sampleCount}x]`;
		console.info(`[GpuProbe] ${summary}`);
		return summary;
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		console.warn("[GpuProbe] overdraw probe failed:", msg);
		return `overdraw: failed (${msg})`;
	}
}

// ---------------------------------------------------------------------------
// Live front-to-back sort (experimental)
//
// The engine draws opaque buckets in renderOrder/insertion order baked into
// a render bundle — never front-to-back. The overdraw replay probe measures
// what a depth sort would reclaim (~1ms here). This toggle applies that
// ordering live to test whether the gain materializes and what it costs:
//
//   - WITHIN each renderOrder group only. Cross-order sorting would break
//     load-bearing submission (far terrain 90 after chunk opaque 0 so
//     coplanar skirts resolve toward real chunks). The measured sort-gain
//     assumed free reordering, so live gain will be smaller — that delta
//     itself is the answer to "is order the problem".
//   - Opaque list: re-sorted + bundle invalidated (re-record next execute).
//     Direct list: re-sorted array takes effect immediately (drawn live).
//   - Transparent list untouched (engine already sorts back-to-front for
//     blending correctness).
//
// Runs from an onBeforeRender hook (fires before the frame-graph records),
// installed once per scene via a generation guard so world switches cannot
// leave stale hooks sorting a dead scene.
// ---------------------------------------------------------------------------

interface SortableBinding {
	renderable: {
		order: number;
		_worldCenter?: readonly number[] | null;
		mesh?: { worldMatrix?: ArrayLike<number> } | null;
	};
	_sortDistance: number;
}

interface SortableTask {
	name?: string;
	scene?: SceneContext;
	_opaqueBindings?: SortableBinding[];
	_directBindings?: SortableBinding[];
	_ob?: unknown[];
}

let liveSortEnabled = false;
let sortHookGeneration = 0;
let sortReorders = 0;
/** True once the current enable-cycle actually reordered something. */
let sortAppliedSinceEnable = false;

/** Whether the experimental live sort is active. */
export function isLiveSortEnabled(): boolean {
	return liveSortEnabled;
}

function bindingDepth(
	binding: SortableBinding,
	view: ArrayLike<number>,
): number {
	const wc = binding.renderable._worldCenter;
	if (wc)
		return wc[0] * view[2] + wc[1] * view[6] + wc[2] * view[10] + view[14];
	const m = binding.renderable.mesh?.worldMatrix;
	if (m) return m[12] * view[2] + m[13] * view[6] + m[14] * view[10] + view[14];
	return 0;
}

/** renderOrder first (load-bearing), view depth second (front-to-back). */
function compareOpaqueFrontToBack(
	a: SortableBinding,
	b: SortableBinding,
): number {
	return (
		a.renderable.order - b.renderable.order || a._sortDistance - b._sortDistance
	);
}

function sortTaskFrontToBack(scene: SceneContext): void {
	const task = getSortableSceneTask(scene);
	if (!task) return;
	const camera = (scene as unknown as { camera?: Camera }).camera;
	if (!camera) return;
	let view: ArrayLike<number>;
	try {
		view = getViewMatrix(camera);
	} catch {
		return;
	}
	let changed = false;
	const lists = [task._opaqueBindings, task._directBindings];
	for (const arr of lists) {
		if (!arr || arr.length <= 1) continue;
		for (const b of arr) b._sortDistance = bindingDepth(b, view);
		let ordered = true;
		for (let i = 1; i < arr.length; i++) {
			if (compareOpaqueFrontToBack(arr[i - 1], arr[i]) > 0) {
				ordered = false;
				break;
			}
		}
		if (!ordered) {
			arr.sort(compareOpaqueFrontToBack);
			changed = true;
		}
	}
	if (changed) {
		// Opaque draws replay from a baked bundle — drop it so the new
		// order is re-recorded on execute. Direct draws read the array
		// live and need nothing further.
		if (task._ob) task._ob.length = 0;
		sortReorders++;
		sortAppliedSinceEnable = true;
	}
}

function getSortableSceneTask(scene: SceneContext): SortableTask | null {
	const fg = getFrameGraph(scene) as unknown as { _tasks?: SortableTask[] };
	const tasks = fg._tasks ?? [];
	return tasks.find((t) => t?.name === "scene") ?? tasks[0] ?? null;
}

export function setLiveSortEnabled(
	scene: SceneContext,
	enabled: boolean,
): void {
	liveSortEnabled = enabled;
	if (enabled) {
		sortHookGeneration++;
		const generation = sortHookGeneration;
		onBeforeRender(scene, () => {
			if (!liveSortEnabled || generation !== sortHookGeneration) return;
			sortTaskFrontToBack(scene);
		});
	} else if (sortAppliedSinceEnable) {
		// Disabling must restore a deterministic OFF state: disabling the
		// flag alone would leave the depth order (and its bundle) in place,
		// silently contaminating every later "unsorted" measurement. Stable
		// re-sort by renderOrder alone is insertion-equivalent for ordering
		// purposes; the dropped bundle re-records it on next execute.
		const task = getSortableSceneTask(scene);
		if (task) {
			for (const arr of [task._opaqueBindings, task._directBindings]) {
				arr?.sort((a, b) => a.renderable.order - b.renderable.order);
			}
			if (task._ob) task._ob.length = 0;
		}
		sortAppliedSinceEnable = false;
	}
	console.info(
		`[GpuProbe] live opaque sort ${enabled ? "ON" : "OFF"}` +
			(enabled
				? " (front-to-back within renderOrder; watch GPU Exec + Main Thread Ms)"
				: ` (${sortReorders} bundle re-records total)`),
	);
}
