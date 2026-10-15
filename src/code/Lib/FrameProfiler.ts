// Lib/FrameProfiler.ts

const MAX_SECTION_NAME_LEN = 24;
const DEFAULT_REFRESH_MS = 1000 / 60;

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
	/** Ring-buffer capacity in frames, approximately 10 seconds at 60 Hz. */
	public static readonly CAPACITY = 600;

	/** Frame deltas above this are suspension/debugger outliers, not frames. */
	public static readonly OUTLIER_FRAME_MS = 5000;

	private static readonly REFRESH_SAMPLES = 61;

	private readonly capacity: number;

	private readonly sectionNames: string[];
	private readonly sectionIndex: Map<string, number>;
	private readonly sectionCount: number;

	/** Index of the asynchronous gpuLag section, or -1. */
	private readonly gpuLagIndex: number;

	private readonly offFrameNames: string[];
	private readonly offFrameIndex: Map<string, number>;
	private readonly offFrameCount: number;

	// Frame ring buffers.
	private readonly frameMs: Float64Array;
	private readonly frameCpuMs: Float64Array;
	private readonly busyRatio: Float64Array;
	private readonly unaccountedMs: Float64Array;
	private readonly frameTimes: Float64Array;

	// Section-major storage: section * capacity + frame slot.
	private readonly sectionMs: Float64Array;
	private readonly offFrameMs: Float64Array;

	// Scratch for the frame currently being recorded.
	private readonly currentSections: Float64Array;
	private readonly currentOffFrame: Float64Array;

	private currentOpenIdx = -1;
	private currentOpenStart = 0;

	private writeIdx = 0;
	private recordedFrames = 0;
	private droppedOutliers = 0;

	// Refresh-period estimator.
	private readonly recentDeltas: Float64Array;
	private recentDeltaCount = 0;
	private recentDeltaIdx = 0;

	// Reused report scratch. Reporting still creates the returned objects,
	// but it does not create a sample array for every metric.
	private readonly statScratch: number[] = [];

	// Reused by estimatedRefreshMs(), avoiding Array.prototype.slice.call().
	private readonly refreshScratch: number[] = [];

	private readonly unknownSections = new Set<string>();

	private enabled = false;

	constructor(
		sectionNames: string[],
		offFrameSectionNames: string[] = [],
		capacity = FrameProfiler.CAPACITY,
	) {
		if (!Number.isInteger(capacity) || capacity <= 0) {
			throw new RangeError("FrameProfiler capacity must be a positive integer");
		}

		this.capacity = capacity;

		this.sectionNames = sectionNames.slice();
		this.sectionCount = this.sectionNames.length;
		this.sectionIndex = new Map<string, number>();

		for (let i = 0; i < this.sectionCount; i++) {
			this.sectionIndex.set(this.sectionNames[i], i);
		}

		this.gpuLagIndex = this.sectionIndex.get("gpuLag") ?? -1;

		this.offFrameNames = offFrameSectionNames.slice();
		this.offFrameCount = this.offFrameNames.length;
		this.offFrameIndex = new Map<string, number>();

		for (let i = 0; i < this.offFrameCount; i++) {
			this.offFrameIndex.set(this.offFrameNames[i], i);
		}

		this.frameMs = new Float64Array(capacity);
		this.frameCpuMs = new Float64Array(capacity);
		this.busyRatio = new Float64Array(capacity);
		this.unaccountedMs = new Float64Array(capacity);
		this.frameTimes = new Float64Array(capacity);

		this.sectionMs = new Float64Array(this.sectionCount * capacity);
		this.offFrameMs = new Float64Array(this.offFrameCount * capacity);

		this.currentSections = new Float64Array(this.sectionCount);
		this.currentOffFrame = new Float64Array(this.offFrameCount);

		this.recentDeltas = new Float64Array(FrameProfiler.REFRESH_SAMPLES);
	}

	public setEnabled(value: boolean): void {
		if (this.enabled === value) return;

		this.enabled = value;

		if (!value) {
			this.abortFrame();
		}
	}

	public isEnabled(): boolean {
		return this.enabled;
	}

	private reportUnknownSection(name: string): void {
		if (this.unknownSections.has(name)) return;

		this.unknownSections.add(name);

		console.warn(
			`[FrameProfiler] section "${name.slice(0, MAX_SECTION_NAME_LEN)}" is not ` +
				"registered - its time is discarded. Add it to PROFILE_SECTIONS or " +
				"OFF_FRAME_SECTIONS.",
		);
	}

	/** Begin an in-frame named section. Nested/overlapping calls are ignored. */
	public begin(name: string): void {
		if (!this.enabled || this.currentOpenIdx !== -1) return;

		const idx = this.sectionIndex.get(name);

		if (idx === undefined) {
			this.reportUnknownSection(name);
			return;
		}

		this.currentOpenIdx = idx;
		this.currentOpenStart = performance.now();
	}

	/** End the currently open in-frame section. */
	public end(name?: string): void {
		if (!this.enabled) return;

		const idx = this.currentOpenIdx;
		if (idx === -1) return;

		if (name !== undefined && this.sectionIndex.get(name) !== idx) {
			return;
		}

		this.currentSections[idx] += performance.now() - this.currentOpenStart;
		this.currentOpenIdx = -1;
	}

	/** Inject a directly measured in-frame section value. */
	public noteSectionValue(name: string, ms: number): void {
		if (!this.enabled || this.currentOpenIdx !== -1) return;

		const idx = this.sectionIndex.get(name);

		if (idx === undefined) {
			this.reportUnknownSection(name);
			return;
		}

		this.currentSections[idx] += ms;
	}

	/** Record work executed between animation-frame callbacks. */
	public noteOffFrameValue(name: string, ms: number): void {
		if (!this.enabled) return;

		const idx = this.offFrameIndex.get(name);

		if (idx === undefined) {
			this.reportUnknownSection(name);
			return;
		}

		this.currentOffFrame[idx] += ms;
	}

	/** Time a synchronous off-frame operation. */
	public measureOffFrame<T>(name: string, fn: () => T): T {
		if (!this.enabled) return fn();

		const start = performance.now();

		try {
			return fn();
		} finally {
			this.noteOffFrameValue(name, performance.now() - start);
		}
	}

	/** Commit the frame currently being recorded. */
	public endFrame(frameDeltaMs: number, frameCpuMs: number): void {
		if (!this.enabled) return;

		const openIdx = this.currentOpenIdx;

		if (openIdx !== -1) {
			this.currentSections[openIdx] +=
				performance.now() - this.currentOpenStart;
			this.currentOpenIdx = -1;
		}

		if (
			!Number.isFinite(frameDeltaMs) ||
			frameDeltaMs <= 0 ||
			frameDeltaMs > FrameProfiler.OUTLIER_FRAME_MS
		) {
			this.droppedOutliers++;
			this.abortFrame();
			return;
		}

		// Avoid allowing invalid input to poison every aggregate containing it.
		if (!Number.isFinite(frameCpuMs) || frameCpuMs < 0) {
			this.abortFrame();
			return;
		}

		let sectionSum = 0;

		for (let s = 0; s < this.sectionCount; s++) {
			if (s !== this.gpuLagIndex) {
				sectionSum += this.currentSections[s];
			}
		}

		let offFrameSum = 0;

		for (let o = 0; o < this.offFrameCount; o++) {
			offFrameSum += this.currentOffFrame[o];
		}

		const slot = this.writeIdx;
		const capacity = this.capacity;

		this.frameMs[slot] = frameDeltaMs;
		this.frameCpuMs[slot] = frameCpuMs;
		this.busyRatio[slot] = (frameCpuMs + offFrameSum) / frameDeltaMs;
		this.unaccountedMs[slot] = Math.max(0, frameCpuMs - sectionSum);
		this.frameTimes[slot] = performance.now();

		for (let s = 0; s < this.sectionCount; s++) {
			this.sectionMs[s * capacity + slot] = this.currentSections[s];
		}

		for (let o = 0; o < this.offFrameCount; o++) {
			this.offFrameMs[o * capacity + slot] = this.currentOffFrame[o];
		}

		// Native typed-array clearing is generally faster than separate JS
		// loops and keeps the reset logic independent of the storage loops.
		this.currentSections.fill(0);
		this.currentOffFrame.fill(0);

		this.writeIdx = slot + 1 === capacity ? 0 : slot + 1;

		if (this.recordedFrames < capacity) {
			this.recordedFrames++;
		}

		const refreshSlot = this.recentDeltaIdx;
		this.recentDeltas[refreshSlot] = frameDeltaMs;

		this.recentDeltaIdx =
			refreshSlot + 1 === this.recentDeltas.length ? 0 : refreshSlot + 1;

		if (this.recentDeltaCount < this.recentDeltas.length) {
			this.recentDeltaCount++;
		}
	}

	/**
	 * Estimate the display refresh period from the median of recent frame
	 * deltas. Reuses scratch storage instead of allocating with slice().
	 */
	public estimatedRefreshMs(): number {
		const n = this.recentDeltaCount;

		if (n === 0) {
			return DEFAULT_REFRESH_MS;
		}

		const samples = this.refreshScratch;
		samples.length = n;

		for (let i = 0; i < n; i++) {
			samples[i] = this.recentDeltas[i];
		}

		samples.sort(compareNumbers);

		return Math.max(1, samples[n >>> 1]);
	}

	/** Discard all measurements belonging to the frame in progress. */
	public abortFrame(): void {
		this.currentOpenIdx = -1;
		this.currentOpenStart = 0;
		this.currentSections.fill(0);
		this.currentOffFrame.fill(0);
	}

	private static percentileRank(percentile: number, count: number): number {
		const rank = Math.ceil((percentile / 100) * count) - 1;

		if (rank < 0) return 0;
		if (rank >= count) return count - 1;
		return rank;
	}

	/**
	 * Build statistics directly from a ring-buffer metric.
	 *
	 * `baseOffset` selects a section in section-major storage. For ordinary
	 * frame metrics it is zero.
	 */
	private buildArrayStats(
		name: string,
		values: Float64Array,
		windowFrames: number,
		baseOffset = 0,
	): SectionStat {
		const n = Math.min(this.recordedFrames, windowFrames);

		if (n === 0) {
			return { name, avg: 0, p50: 0, p95: 0, max: 0 };
		}

		const samples = this.statScratch;
		samples.length = n;

		const capacity = this.capacity;
		let slot = this.writeIdx === 0 ? capacity - 1 : this.writeIdx - 1;
		let sum = 0;

		for (let i = 0; i < n; i++) {
			const value = values[baseOffset + slot];
			samples[i] = value;
			sum += value;

			slot = slot === 0 ? capacity - 1 : slot - 1;
		}

		samples.sort(compareNumbers);

		return {
			name,
			avg: sum / n,
			p50: samples[FrameProfiler.percentileRank(50, n)],
			p95: samples[FrameProfiler.percentileRank(95, n)],
			max: samples[n - 1],
		};
	}

	/**
	 * Build a structured report over the most recent `windowFrames`.
	 *
	 * The returned arrays and objects necessarily allocate because ownership
	 * is transferred to the caller. Sample collection and sorting reuse
	 * internal scratch storage.
	 */
	public report(windowFrames = this.capacity): {
		frames: number;
		droppedOutliers: number;
		frame: MetricStat;
		frameCpu: MetricStat;
		busy: MetricStat;
		sections: SectionStat[];
		offFrame: SectionStat[];
	} {
		const normalizedWindow =
			Number.isFinite(windowFrames) && windowFrames > 0
				? Math.floor(windowFrames)
				: 0;

		const sections = new Array<SectionStat>(this.sectionCount + 1);

		for (let s = 0; s < this.sectionCount; s++) {
			sections[s] = this.buildArrayStats(
				this.sectionNames[s],
				this.sectionMs,
				normalizedWindow,
				s * this.capacity,
			);
		}

		sections[this.sectionCount] = this.buildArrayStats(
			"(unaccounted)",
			this.unaccountedMs,
			normalizedWindow,
		);

		const offFrame = new Array<SectionStat>(this.offFrameCount);

		for (let o = 0; o < this.offFrameCount; o++) {
			offFrame[o] = this.buildArrayStats(
				this.offFrameNames[o],
				this.offFrameMs,
				normalizedWindow,
				o * this.capacity,
			);
		}

		return {
			frames: Math.min(this.recordedFrames, normalizedWindow),
			droppedOutliers: this.droppedOutliers,
			frame: this.buildArrayStats("frame", this.frameMs, normalizedWindow),
			frameCpu: this.buildArrayStats(
				"frameCpu",
				this.frameCpuMs,
				normalizedWindow,
			),
			busy: this.buildArrayStats("busy", this.busyRatio, normalizedWindow),
			sections,
			offFrame,
		};
	}

	/** Formatted console report used by the F5 dump. */
	public logReport(windowFrames?: number): void {
		const report = this.report(windowFrames);

		if (report.frames === 0) {
			console.info("[FrameProfiler] no samples yet");
			return;
		}

		console.group(
			`[FrameProfiler] last ${report.frames} frames ` +
				`(${report.droppedOutliers} outliers dropped)\n` +
				`  frame  delta avg ${report.frame.avg.toFixed(2)}ms ` +
				`p50 ${report.frame.p50.toFixed(2)} ` +
				`p95 ${report.frame.p95.toFixed(2)} ` +
				`max ${report.frame.max.toFixed(2)}\n` +
				`  frame   cpu avg ${report.frameCpu.avg.toFixed(2)}ms ` +
				`p50 ${report.frameCpu.p50.toFixed(2)} ` +
				`p95 ${report.frameCpu.p95.toFixed(2)} ` +
				`max ${report.frameCpu.max.toFixed(2)}\n` +
				`  thread busy  avg ${(report.busy.avg * 100).toFixed(0)}% ` +
				`p50 ${(report.busy.p50 * 100).toFixed(0)}% ` +
				`p95 ${(report.busy.p95 * 100).toFixed(0)}% ` +
				`max ${(report.busy.max * 100).toFixed(0)}%`,
		);

		console.table(
			report.sections.map((section) => ({
				section: section.name,
				avg: +section.avg.toFixed(3),
				p50: +section.p50.toFixed(3),
				p95: +section.p95.toFixed(3),
				max: +section.max.toFixed(3),
			})),
		);

		if (report.offFrame.length > 0) {
			console.info(
				"[FrameProfiler] work outside onBeforeRender (same frame budget):",
			);

			console.table(
				report.offFrame.map((section) => ({
					section: section.name,
					avg: +section.avg.toFixed(3),
					p50: +section.p50.toFixed(3),
					p95: +section.p95.toFixed(3),
					max: +section.max.toFixed(3),
				})),
			);
		}

		console.groupEnd();
	}

	/** One-line summary for the debug panel. */
	public summaryLine(): string {
		const report = this.report(300);

		if (report.frames === 0) {
			return "no samples";
		}

		// Reports contain fresh result objects, so sorting these arrays cannot
		// mutate the profiler's internal state.
		const offFrame = report.offFrame
			.filter((section) => section.avg > 0.005)
			.sort((a, b) => b.p95 - a.p95)
			.slice(0, 2)
			.map((section) => `~${section.name} ${section.p95.toFixed(1)}`)
			.join(" ");

		const topSections = report.sections
			.filter(
				(section) =>
					section.name !== "(unaccounted)" && section.name !== "gpuLag",
			)
			.sort((a, b) => b.p95 - a.p95)
			.slice(0, 2)
			.map((section) => `${section.name} ${section.p95.toFixed(1)}`)
			.join(" | ");

		return (
			`p95 ${report.frame.p95.toFixed(1)}ms ` +
			`cpu ${report.frameCpu.p95.toFixed(1)}ms ` +
			`busy ${(report.busy.p95 * 100).toFixed(0)}% | ` +
			`${topSections}${offFrame ? ` | ${offFrame}` : ""}`
		);
	}
}

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
	"hostileMobs",
	"aquaticMobs",
	"birds",
	"gpuLag",
] as const;

export const OFF_FRAME_SECTIONS = [
	"poolQueue",
	"poolMeshDrain",
	"poolLighting",
	"workerMsg",
	"streamAsync",
	"remotePump",
] as const;

export const frameProfiler = new FrameProfiler(
	[...PROFILE_SECTIONS],
	[...OFF_FRAME_SECTIONS],
);

if (typeof window !== "undefined") {
	(window as unknown as Record<string, unknown>).__b102Profiler = {
		report: (windowFrames?: number) => frameProfiler.report(windowFrames),
		refreshMs: () => frameProfiler.estimatedRefreshMs(),
	};
}
