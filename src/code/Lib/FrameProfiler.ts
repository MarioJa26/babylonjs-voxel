// Lib/FrameProfiler.ts
//
// Lightweight always-on frame profiler: a ring buffer of per-frame samples,
// each holding a fixed set of named section timings measured with
// performance.now() pairs. `report()` prints avg/p50/p95/max per section plus
// frame-time stats — surfaced via the F5 keybind (PlayerLoopController).
//
// Design constraints:
//  - Zero allocation in steady state: section values live in a fixed
//    Float64Array indexed by a static name table (no per-frame Maps or string
//    churn).
//  - One nesting level: in-frame sections must not overlap. Nested/overlapping
//    begin() calls are ignored (documented contract).
//  - Sections that never begin in a frame simply contribute 0.
//
// ---------------------------------------------------------------------------
// WHY THERE ARE TWO TABLES
//
// A section only measures what happens *inside an onBeforeRender callback*.
// A large share of this game's main-thread work does not: ChunkWorkerPool
// drains its mesh/lighting queues from a MessageChannel macrotask, worker
// results arrive in plain message tasks, and the chunk scheduler resumes in
// microtasks after its first await. All of that still consumes the frame
// budget, so it still drops frames — but it lands in no section at all, which
// is what makes a stall look like "0 work".
//
// Off-frame work therefore has its own name table and its own ring buffer
// (noteOffFrameValue / measureOffFrame), kept deliberately OUT of `sectionSum`
// so it cannot distort the in-frame unaccounted figure.
// ---------------------------------------------------------------------------

const MAX_SECTION_NAME_LEN = 24;

const compareNumbers = (a: number, b: number): number => a - b;

export interface SectionStat {
	name: string;
	avg: number;
	p50: number;
	p95: number;
	max: number;
}

interface MetricStat {
	avg: number;
	p50: number;
	p95: number;
	max: number;
}

export class FrameProfiler {
	/** Ring-buffer capacity in frames (~10s at 60fps). */
	public static readonly CAPACITY = 600;
	/** Frame deltas above this are suspension/debugger outliers, not frames. */
	public static readonly OUTLIER_FRAME_MS = 5000;

	private readonly sectionNames: string[];
	private readonly sectionIndex = new Map<string, number>();
	private readonly sectionCount: number;
	/** Index of the async gpuLag section, or -1. Excluded from sum arithmetic. */
	private readonly gpuLagIndex: number;

	// Off-frame sections run in tasks that execute BETWEEN animation frames.
	// They are tracked separately so they never contaminate sectionSum.
	private readonly offFrameNames: string[];
	private readonly offFrameIndex = new Map<string, number>();
	private readonly offFrameCount: number;
	private readonly offFrameMs: Float64Array; // offFrameCount * CAPACITY

	// Ring buffers, one Float64Array per metric, indexed frame-slot-major.
	private readonly frameMs: Float64Array; // rAF delta: wall time between BeginFrames
	private readonly frameCpuMs: Float64Array; // CPU time inside the rAF task itself
	private readonly busyRatio: Float64Array; // (frameCpu + offFrame) / frameDelta
	private readonly sectionMs: Float64Array; // sectionCount * CAPACITY
	private readonly unaccountedMs: Float64Array;
	private readonly frameTimes: Float64Array; // epoch ms, for report windows

	// Scratch for the frame in progress.
	private readonly currentSections: Float64Array;
	private currentOpenIdx = -1;
	private currentOpenStart = 0;

	// Off-frame time is not tied to a frame: a MessageChannel flush can land
	// between any two frames. It accumulates until the next endFrame() drains
	// it, so no task is lost across a frame boundary.
	private readonly currentOffFrame: Float64Array;

	private writeIdx = 0;
	private recordedFrames = 0;
	private droppedOutliers = 0;

	// Small ring of recent frame deltas, used to estimate the display refresh
	// period. The MEDIAN is the right statistic, not the minimum: when the
	// main thread is oversubscribed the browser fires rAF callbacks back to
	// back, so the smallest gap collapses toward ~1ms and reports a nonsense
	// period. The median sits on the vsync cluster (16.7ms at 60Hz) because
	// the loop is vsync-locked for most of any run.
	private static readonly REFRESH_SAMPLES = 61;
	private readonly recentDeltas: Float64Array;
	private recentDeltaCount = 0;
	private recentDeltaIdx = 0;

	/** Window scratch for buildStats — reused so a report allocates nothing. */
	private readonly statScratch: number[] = [];

	// Names seen in begin()/noteOffFrameValue() that are not in either table.
	// An unregistered name is silently discarded, which is exactly how real
	// work turns into a "0 work" reading, so it is reported once per name.
	private readonly unknownSections = new Set<string>();

	private enabled = true;

	constructor(
		sectionNames: string[],
		offFrameSectionNames: string[] = [],
		capacity = FrameProfiler.CAPACITY,
	) {
		this.sectionNames = sectionNames.slice();
		this.sectionCount = sectionNames.length;
		this.sectionIndex = new Map(
			sectionNames.map((name, i) => [name, i] as const),
		);
		this.gpuLagIndex = this.sectionNames.indexOf("gpuLag");

		this.offFrameNames = offFrameSectionNames.slice();
		this.offFrameCount = this.offFrameNames.length;
		this.offFrameIndex = new Map(
			this.offFrameNames.map((name, i) => [name, i] as const),
		);

		this.frameMs = new Float64Array(capacity);
		this.frameCpuMs = new Float64Array(capacity);
		this.busyRatio = new Float64Array(capacity);
		this.sectionMs = new Float64Array(this.sectionCount * capacity);
		this.offFrameMs = new Float64Array(this.offFrameCount * capacity);
		this.unaccountedMs = new Float64Array(capacity);
		this.frameTimes = new Float64Array(capacity);
		this.currentSections = new Float64Array(this.sectionCount);
		this.currentOffFrame = new Float64Array(this.offFrameCount);
		this.recentDeltas = new Float64Array(FrameProfiler.REFRESH_SAMPLES);
	}

	public setEnabled(value: boolean): void {
		this.enabled = value;
		if (!value) this.abortFrame();
	}

	public isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * A section name that is not in the relevant table is silently dropped.
	 * Warn once per name, and NOT gated on DEV: the whole point is to catch
	 * this in a production build, where three mob sections were previously
	 * unregistered and their A* cost was invisible.
	 */
	private reportUnknownSection(name: string): void {
		if (this.unknownSections.has(name)) return;
		this.unknownSections.add(name);
		console.warn(
			`[FrameProfiler] section "${name.slice(0, MAX_SECTION_NAME_LEN)}" is not ` +
				"registered — its time is discarded. Add it to PROFILE_SECTIONS or " +
				"OFF_FRAME_SECTIONS.",
		);
	}

	/** Begin an in-frame named section for the frame in progress. */
	public begin(name: string): void {
		if (!this.enabled) return;
		const idx = this.sectionIndex.get(name);
		if (idx === undefined) {
			this.reportUnknownSection(name);
			return;
		}
		// Overlapping/nested sections are ignored (contract: one level).
		if (this.currentOpenIdx !== -1) return;
		this.currentOpenIdx = idx;
		this.currentOpenStart = performance.now();
	}

	/** End the currently open in-frame section, accumulating its elapsed time. */
	public end(name?: string): void {
		if (!this.enabled) return;
		if (this.currentOpenIdx === -1) return;
		const idx = this.currentOpenIdx;
		if (name !== undefined) {
			const expected = this.sectionIndex.get(name);
			if (expected !== idx) return; // mismatched end — ignore
		}
		this.currentSections[idx] += performance.now() - this.currentOpenStart;
		this.currentOpenIdx = -1;
	}

	/**
	 * Directly inject a measured value into an in-frame section (for async
	 * probes like GPU-lag where begin/end can't span the measurement). Ignored
	 * while another section is open — injected values must not interleave with
	 * timed sections.
	 */
	public noteSectionValue(name: string, ms: number): void {
		if (!this.enabled) return;
		if (this.currentOpenIdx !== -1) return;
		const idx = this.sectionIndex.get(name);
		if (idx === undefined) {
			this.reportUnknownSection(name);
			return;
		}
		this.currentSections[idx] += ms;
	}

	/**
	 * Record time spent in a main-thread task that runs BETWEEN animation
	 * frames — a MessageChannel flush, a worker onmessage handler, or an async
	 * continuation that resumed after its rAF callback returned.
	 *
	 * These cannot go through begin()/end() because no frame is in progress,
	 * yet they consume the frame budget all the same. They are reported apart
	 * from the in-frame sections and folded into busyRatio.
	 */
	public noteOffFrameValue(name: string, ms: number): void {
		if (!this.enabled) return;
		const idx = this.offFrameIndex.get(name);
		if (idx === undefined) {
			this.reportUnknownSection(name);
			return;
		}
		this.currentOffFrame[idx] += ms;
	}

	/** Time `fn()` and file the result under the off-frame section `name`. */
	public measureOffFrame<T>(name: string, fn: () => T): T {
		if (!this.enabled) return fn();
		const start = performance.now();
		try {
			return fn();
		} finally {
			this.noteOffFrameValue(name, performance.now() - start);
		}
	}

	/**
	 * Commit the frame in progress. Call once per frame, after all in-frame
	 * sections are closed.
	 *
	 * @param frameDeltaMs rAF delta — wall time between BeginFrames. Includes
	 *   idle vsync wait, so it is NOT a CPU cost.
	 * @param frameCpuMs   CPU time actually spent inside the rAF task
	 *   (first hook entry → the microtask that runs once the whole task
	 *   drains). This is the number that should be compared against the frame
	 *   budget.
	 *
	 * Frames with absurd deltas (tab suspension, debugger pause) are counted
	 * as outliers and excluded from the ring buffer — a single 10-minute
	 * delta otherwise destroys the averages.
	 */
	public endFrame(frameDeltaMs: number, frameCpuMs: number): void {
		if (!this.enabled) return;
		if (this.currentOpenIdx !== -1) {
			// Unclosed section — still record its time (defensive).
			this.currentSections[this.currentOpenIdx] +=
				performance.now() - this.currentOpenStart;
			this.currentOpenIdx = -1;
		}

		// Suspension/debugger outlier — drop the whole sample.
		if (frameDeltaMs <= 0 || frameDeltaMs > FrameProfiler.OUTLIER_FRAME_MS) {
			this.droppedOutliers++;
			this.abortFrame();
			return;
		}

		let sectionSum = 0;
		for (let s = 0; s < this.sectionCount; s++) {
			// gpuLag is an ASYNC wall-clock measurement (how long the GPU queue
			// takes to drain), not CPU time spent inside this frame. Summing it
			// in subtracted GPU wait from `unaccounted`, hiding exactly the
			// stalls it exists to reveal. Excluded from the budget arithmetic.
			if (s === this.gpuLagIndex) continue;
			sectionSum += this.currentSections[s];
		}

		let offFrameSum = 0;
		for (let o = 0; o < this.offFrameCount; o++) {
			offFrameSum += this.currentOffFrame[o];
		}

		const cap = this.frameMs.length;
		const slot = this.writeIdx;

		this.frameMs[slot] = frameDeltaMs;
		this.frameCpuMs[slot] = frameCpuMs;
		this.busyRatio[slot] = (frameCpuMs + offFrameSum) / frameDeltaMs;
		const now = performance.now();
		this.frameTimes[slot] = now;
		// Unaccounted = in-frame CPU time not covered by a measured section:
		// lite's render internals, draw submission, and the ~15 onBeforeRender
		// hooks that have no section at all. Computed against frameCpuMs, not
		// the rAF delta, so it no longer conflates idle vsync wait with a real
		// stall — the old form could not tell a healthy 13ms of idle from a
		// 13ms stall.
		this.unaccountedMs[slot] = Math.max(0, frameCpuMs - sectionSum);
		for (let s = 0; s < this.sectionCount; s++) {
			this.sectionMs[s * cap + slot] = this.currentSections[s];
			this.currentSections[s] = 0;
		}
		for (let o = 0; o < this.offFrameCount; o++) {
			this.offFrameMs[o * cap + slot] = this.currentOffFrame[o];
			this.currentOffFrame[o] = 0;
		}

		this.writeIdx = (slot + 1) % cap;
		if (this.recordedFrames < cap) this.recordedFrames++;

		this.recentDeltas[this.recentDeltaIdx] = frameDeltaMs;
		this.recentDeltaIdx = (this.recentDeltaIdx + 1) % this.recentDeltas.length;
		if (this.recentDeltaCount < this.recentDeltas.length)
			this.recentDeltaCount++;
	}

	/**
	 * Best-effort display refresh period in ms — the median of recent frame
	 * deltas. A frame whose CPU cost exceeds this cannot hit its deadline,
	 * which is exactly Chrome's dropped-frame criterion. Falls back to 60Hz
	 * before enough history exists.
	 */
	public estimatedRefreshMs(): number {
		const n = this.recentDeltaCount;
		if (n === 0) return 16.7;
		const s = Array.prototype.slice.call(this.recentDeltas, 0, n) as number[];
		s.sort((a, b) => a - b);
		return Math.max(1, s[n >> 1]);
	}

	/**
	 * Drop the frame in progress (e.g., when profiling is disabled, or the
	 * frame turned out to be a suspension outlier). Also discards pending
	 * off-frame time: it was measured inside the same broken window, so it is
	 * just as unusable.
	 */
	public abortFrame(): void {
		this.currentOpenIdx = -1;
		for (let s = 0; s < this.sectionCount; s++) this.currentSections[s] = 0;
		for (let o = 0; o < this.offFrameCount; o++) this.currentOffFrame[o] = 0;
	}

	private sectionValue(section: number, slot: number): number {
		return this.sectionMs[section * this.frameMs.length + slot];
	}

	private offFrameValue(section: number, slot: number): number {
		return this.offFrameMs[section * this.frameMs.length + slot];
	}

	private static percentileRank(p: number, n: number): number {
		return Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
	}

	/**
	 * avg/p50/p95/max for a slot-indexed metric over the window, in ONE pass.
	 *
	 * This used to be `meanOverWindow` plus three separate calls into a
	 * `percentileOverWindow` that each allocated its own `number[]` and sorted
	 * it with a comparator. A full `report()` therefore did 75 window copies
	 * and 75 sorts of a 300-element array — a ~1-3 ms allocation-and-sort
	 * burst on a 1250 ms timer inside the render loop, i.e. a self-inflicted
	 * periodic frame spike in the exact frames the profiler is measuring.
	 *
	 * Filling one shared scratch and sorting it once per metric removes every
	 * allocation and cuts the sort work by 3x. `statScratch` is safe to share
	 * because `buildStats` consumes it before returning.
	 */
	private buildStats(
		name: string,
		get: (slot: number) => number,
		windowFrames: number,
	): SectionStat {
		const n = Math.min(this.recordedFrames, windowFrames);
		if (n === 0) return { name, avg: 0, p50: 0, p95: 0, max: 0 };

		const samples = this.statScratch;
		samples.length = n;
		const cap = this.frameMs.length;
		let sum = 0;
		for (let i = 0; i < n; i++) {
			const value = get((this.writeIdx - 1 - i + cap * 2) % cap);
			samples[i] = value;
			sum += value;
		}
		samples.sort(compareNumbers);

		return {
			name,
			avg: sum / n,
			p50: samples[FrameProfiler.percentileRank(50, n)],
			p95: samples[FrameProfiler.percentileRank(95, n)],
			max: samples[FrameProfiler.percentileRank(100, n)],
		};
	}

	/**
	 * Build the report. `windowFrames` limits the analysis to the most
	 * recent frames (default: the whole buffer).
	 */
	public report(windowFrames = this.frameMs.length): {
		frames: number;
		droppedOutliers: number;
		/** rAF delta (wall time between BeginFrames). */
		frame: MetricStat;
		/** CPU time inside the rAF task. Compare this to the frame budget. */
		frameCpu: MetricStat;
		/** (frameCpu + offFrame) / frameDelta. >1 means the thread is oversubscribed. */
		busy: MetricStat;
		/** Sections measured inside onBeforeRender callbacks. */
		sections: SectionStat[];
		/** Work in tasks that run between animation frames. */
		offFrame: SectionStat[];
	} {
		const sections = this.sectionNames.map((name, s) =>
			this.buildStats(name, (slot) => this.sectionValue(s, slot), windowFrames),
		);

		// Unaccounted: in-frame CPU time not covered by a measured section —
		// lite's render internals, draw submission, unsectioned hooks.
		sections.push(
			this.buildStats(
				"(unaccounted)",
				(slot) => this.unaccountedMs[slot],
				windowFrames,
			),
		);

		const offFrame = this.offFrameNames.map((name, o) =>
			this.buildStats(
				name,
				(slot) => this.offFrameValue(o, slot),
				windowFrames,
			),
		);

		return {
			frames: Math.min(this.recordedFrames, windowFrames),
			droppedOutliers: this.droppedOutliers,
			frame: this.buildStats("frame", (s) => this.frameMs[s], windowFrames),
			frameCpu: this.buildStats(
				"frameCpu",
				(s) => this.frameCpuMs[s],
				windowFrames,
			),
			busy: this.buildStats("busy", (s) => this.busyRatio[s], windowFrames),
			sections,
			offFrame,
		};
	}

	/** Formatted console table (the F5 dump). */
	public logReport(windowFrames?: number): void {
		const r = this.report(windowFrames);
		if (r.frames === 0) {
			console.info("[FrameProfiler] no samples yet");
			return;
		}
		console.group(
			`[FrameProfiler] last ${r.frames} frames (${r.droppedOutliers} outliers dropped)\n` +
				`  frame  delta avg ${r.frame.avg.toFixed(2)}ms p50 ${r.frame.p50.toFixed(2)} p95 ${r.frame.p95.toFixed(2)} max ${r.frame.max.toFixed(2)}\n` +
				`  frame   cpu avg ${r.frameCpu.avg.toFixed(2)}ms p50 ${r.frameCpu.p50.toFixed(2)} p95 ${r.frameCpu.p95.toFixed(2)} max ${r.frameCpu.max.toFixed(2)}\n` +
				`  thread busy  avg ${(r.busy.avg * 100).toFixed(0)}% p50 ${(r.busy.p50 * 100).toFixed(0)}% p95 ${(r.busy.p95 * 100).toFixed(0)}% max ${(r.busy.max * 100).toFixed(0)}%`,
		);
		console.table(
			r.sections.map((s) => ({
				section: s.name,
				avg: +s.avg.toFixed(3),
				p50: +s.p50.toFixed(3),
				p95: +s.p95.toFixed(3),
				max: +s.max.toFixed(3),
			})),
		);
		if (r.offFrame.length > 0) {
			console.info(
				"[FrameProfiler] work outside onBeforeRender (same frame budget):",
			);
			console.table(
				r.offFrame.map((s) => ({
					section: s.name,
					avg: +s.avg.toFixed(3),
					p50: +s.p50.toFixed(3),
					p95: +s.p95.toFixed(3),
					max: +s.max.toFixed(3),
				})),
			);
		}
		console.groupEnd();
	}

	/** One-line summary for the debug panel (p95-weighted). */
	public summaryLine(): string {
		const r = this.report(300);
		if (r.frames === 0) return "no samples";
		const off = r.offFrame
			.filter((s) => s.avg > 0.005)
			.sort((a, b) => b.p95 - a.p95)
			.slice(0, 2)
			.map((s) => `~${s.name} ${s.p95.toFixed(1)}`)
			.join(" ");
		const top = [...r.sections]
			.filter((s) => s.name !== "(unaccounted)" && s.name !== "gpuLag")
			.sort((a, b) => b.p95 - a.p95)
			.slice(0, 2)
			.map((s) => `${s.name} ${s.p95.toFixed(1)}`)
			.join(" | ");
		return (
			`p95 ${r.frame.p95.toFixed(1)}ms cpu ${r.frameCpu.p95.toFixed(1)}ms ` +
			`busy ${(r.busy.p95 * 100).toFixed(0)}% | ${top}${off ? ` | ${off}` : ""}`
		);
	}
}

// ---------------------------------------------------------------------------
// Shared application profiler. Fixed section tables — names not listed are
// reported as unknown and their time discarded.
//
// In-frame sections must not overlap; they may be spread across multiple
// callbacks in one frame (values accumulate).
// ---------------------------------------------------------------------------

export const PROFILE_SECTIONS = [
	"blockTicks",
	"pick",
	"boats",
	"physics",
	"controls",
	"occlusion",
	"hud",
	"streaming",
	"farTiles",
	"mobs",
	"mobSpawn",
	// Per-faction mob hooks. These were used at their call sites but never
	// registered, so hostile/aquatic/bird AI — and the A* expansions it
	// drives — were being measured as literally zero.
	"hostileMobs",
	"aquaticMobs",
	"birds",
	"gpuLag",
] as const;

// Sections for work that runs in a task BETWEEN animation frames. This is
// where ChunkWorkerPool's coalesced queue drain lives, along with worker
// message handling and the chunk scheduler's post-await continuation — all of
// which spend the frame budget without appearing in any onBeforeRender
// section.
export const OFF_FRAME_SECTIONS = [
	// ChunkWorkerPool._centralFlush (MessageChannel macrotask), split by
	// subsystem so the report can say WHICH drain is expensive.
	"poolQueue", // dispatch to idle workers
	"poolMeshDrain", // mesh ingest + rebuildGroupData + writeBuffer uploads
	"poolLighting", // deferred lighting, light registration, remesh flush
	"workerMsg", // worker onmessage handlers
	"streamAsync", // ChunkProcessScheduler.processQueues post-await stages
	"remotePump", // pumpRemoteGeneration + its continuation chain
] as const;

export const frameProfiler = new FrameProfiler(
	[...PROFILE_SECTIONS],
	[...OFF_FRAME_SECTIONS],
);

/*
 * Automation hook. The CDP harness in .tmp-perf/ drives the real game over the
 * DevTools Protocol and needs the structured report, not a console table it
 * would have to scrape. Namespaced to stay out of the app's global namespace.
 */
if (typeof window !== "undefined") {
	(window as unknown as Record<string, unknown>).__b102Profiler = {
		report: (windowFrames?: number) => frameProfiler.report(windowFrames),
		refreshMs: (): number => frameProfiler.estimatedRefreshMs(),
	};
}
