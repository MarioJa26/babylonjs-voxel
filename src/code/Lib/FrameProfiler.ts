// Lib/FrameProfiler.ts
//
// Lightweight always-on frame profiler: a ring buffer of per-frame samples,
// each holding a fixed set of named section timings measured with
// performance.now() pairs. `report()` prints avg/p50/p95/max per section plus
// frame-time stats — surfaced via the F4 debug keybind (PlayerLoopController).
//
// Design constraints:
//  - Zero allocation in steady state: one scratch sample object is reused per
//    frame; section values live in a fixed Float64Array indexed by a static
//    name table (no per-frame Maps or string churn).
//  - One nesting level: sections must not overlap. Nested/overlapping
//    begin() calls are ignored (documented contract).
//  - Sections that never begin in a frame simply contribute 0.

const MAX_SECTION_NAME_LEN = 24;

export class FrameProfiler {
	/** Ring-buffer capacity in frames (~10s at 60fps). */
	public static readonly CAPACITY = 600;
	/** Frame deltas above this are suspension/debugger outliers, not frames. */
	public static readonly OUTLIER_FRAME_MS = 5000;

	private readonly sectionNames: string[];
	private readonly sectionIndex = new Map<string, number>();
	private readonly sectionCount: number;

	// Ring buffers, one Float64Array per metric, indexed frame-slot-major.
	private readonly frameMs: Float64Array;
	private readonly sectionMs: Float64Array; // sectionCount * CAPACITY
	private readonly unaccountedMs: Float64Array;
	private readonly frameTimes: Float64Array; // epoch ms, for report windows

	private writeIdx = 0;
	private recordedFrames = 0;
	private droppedOutliers = 0;

	// Scratch for the frame in progress.
	private readonly currentSections: Float64Array;
	private currentOpenIdx = -1;
	private currentOpenStart = 0;

	private enabled = true;

	constructor(sectionNames: string[], capacity = FrameProfiler.CAPACITY) {
		this.sectionNames = sectionNames.slice();
		this.sectionCount = sectionNames.length;
		this.sectionIndex = new Map(
			sectionNames.map((name, i) => [name, i] as const),
		);
		this.frameMs = new Float64Array(capacity);
		this.sectionMs = new Float64Array(this.sectionCount * capacity);
		this.unaccountedMs = new Float64Array(capacity);
		this.frameTimes = new Float64Array(capacity);
		this.currentSections = new Float64Array(this.sectionCount);
	}

	public setEnabled(value: boolean): void {
		this.enabled = value;
		if (!value) this.abortFrame();
	}

	public isEnabled(): boolean {
		return this.enabled;
	}

	/** Begin a named section for the frame in progress. */
	public begin(name: string): void {
		if (!this.enabled) return;
		const idx = this.sectionIndex.get(name);
		if (idx === undefined) {
			if (import.meta.env?.DEV) {
				console.warn(
					`[FrameProfiler] unknown section "${name.slice(0, MAX_SECTION_NAME_LEN)}"`,
				);
			}
			return;
		}
		// Overlapping/nested sections are ignored (contract: one level).
		if (this.currentOpenIdx !== -1) return;
		this.currentOpenIdx = idx;
		this.currentOpenStart = performance.now();
	}

	/** End the currently open section, accumulating its elapsed time. */
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
	 * Directly inject a measured value into a section for the frame in
	 * progress (for async probes like GPU-lag where begin/end can't span the
	 * measurement). Ignored while another section is open — injected values
	 * must not interleave with timed sections.
	 */
	public noteSectionValue(name: string, ms: number): void {
		if (!this.enabled) return;
		if (this.currentOpenIdx !== -1) return;
		const idx = this.sectionIndex.get(name);
		if (idx === undefined) return;
		this.currentSections[idx] += ms;
	}

	/**
	 * Commit the frame in progress with its total frame time (rAF delta).
	 * Call once per frame, after all sections are closed.
	 *
	 * Frames with absurd deltas (tab suspension, debugger pause) are counted
	 * as outliers and excluded from the ring buffer — a single 10-minute
	 * delta otherwise destroys the averages.
	 */
	public endFrame(frameMs: number): void {
		if (!this.enabled) return;
		if (this.currentOpenIdx !== -1) {
			// Unclosed section — still record its time (defensive).
			this.currentSections[this.currentOpenIdx] +=
				performance.now() - this.currentOpenStart;
			this.currentOpenIdx = -1;
		}

		// Suspension/debugger outlier — drop the whole sample.
		if (frameMs <= 0 || frameMs > FrameProfiler.OUTLIER_FRAME_MS) {
			this.droppedOutliers++;
			this.abortFrame();
			return;
		}

		let sectionSum = 0;
		for (let s = 0; s < this.sectionCount; s++) {
			sectionSum += this.currentSections[s];
		}

		const cap = this.frameMs.length;
		const slot = this.writeIdx;

		this.frameMs[slot] = frameMs;
		this.frameTimes[slot] = performance.now();
		// Unaccounted = frame time not covered by measured sections — lite's
		// render internals, GPU/vsync wait. The signal when p95 frames spike
		// while every measured section is cold.
		this.unaccountedMs[slot] = Math.max(0, frameMs - sectionSum);
		for (let s = 0; s < this.sectionCount; s++) {
			this.sectionMs[s * cap + slot] = this.currentSections[s];
			this.currentSections[s] = 0;
		}

		this.writeIdx = (slot + 1) % cap;
		if (this.recordedFrames < cap) this.recordedFrames++;
	}

	/** Drop the frame in progress (e.g., when profiling is disabled). */
	public abortFrame(): void {
		this.currentOpenIdx = -1;
		for (let s = 0; s < this.sectionCount; s++) this.currentSections[s] = 0;
	}

	/**
	 * Percentile of a sorted-in-place-optional sample window.
	 * Copies the window (does not mutate the ring buffer).
	 */
	private percentileOverWindow(
		get: (slot: number) => number,
		windowFrames: number,
		p: number,
	): number {
		const n = Math.min(this.recordedFrames, windowFrames);
		if (n === 0) return 0;
		const samples: number[] = new Array(n);
		const cap = this.frameMs.length;
		for (let i = 0; i < n; i++) {
			const slot = (this.writeIdx - 1 - i + cap * 2) % cap;
			samples[i] = get(slot);
		}
		samples.sort((a, b) => a - b);
		const rank = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
		return samples[rank];
	}

	private sectionValue(section: number, slot: number): number {
		return this.sectionMs[section * this.frameMs.length + slot];
	}

	/**
	 * Build the report. `windowFrames` limits the analysis to the most
	 * recent frames (default: the whole buffer).
	 */
	public report(windowFrames = this.frameMs.length): {
		frames: number;
		droppedOutliers: number;
		frame: { avg: number; p50: number; p95: number; max: number };
		sections: {
			name: string;
			avg: number;
			p50: number;
			p95: number;
			max: number;
		}[];
	} {
		const n = Math.min(this.recordedFrames, windowFrames);
		const cap = this.frameMs.length;
		const frameStats = {
			avg: 0,
			p50: this.percentileOverWindow((s) => this.frameMs[s], n, 50),
			p95: this.percentileOverWindow((s) => this.frameMs[s], n, 95),
			max: this.percentileOverWindow((s) => this.frameMs[s], n, 100),
		};
		if (n > 0) {
			let sum = 0;
			for (let i = 0; i < n; i++) {
				const slot = (this.writeIdx - 1 - i + cap * 2) % cap;
				sum += this.frameMs[slot];
			}
			frameStats.avg = sum / n;
		}

		const sections = this.sectionNames.map((name, s) => ({
			name,
			avg: 0,
			p50: this.percentileOverWindow(
				(slot) => this.sectionValue(s, slot),
				n,
				50,
			),
			p95: this.percentileOverWindow(
				(slot) => this.sectionValue(s, slot),
				n,
				95,
			),
			max: this.percentileOverWindow(
				(slot) => this.sectionValue(s, slot),
				n,
				100,
			),
		}));
		if (n > 0) {
			for (let s = 0; s < this.sectionCount; s++) {
				let sum = 0;
				for (let i = 0; i < n; i++) {
					const slot = (this.writeIdx - 1 - i + cap * 2) % cap;
					sum += this.sectionValue(s, slot);
				}
				sections[s].avg = sum / n;
			}
		}

		// Unaccounted: frame time not covered by measured sections — lite's
		// render internals, draw submission, GPU/vsync wait.
		sections.push({
			name: "(unaccounted)",
			avg: 0,
			p50: this.percentileOverWindow((slot) => this.unaccountedMs[slot], n, 50),
			p95: this.percentileOverWindow((slot) => this.unaccountedMs[slot], n, 95),
			max: this.percentileOverWindow(
				(slot) => this.unaccountedMs[slot],
				n,
				100,
			),
		});
		if (n > 0) {
			let sum = 0;
			for (let i = 0; i < n; i++) {
				const slot = (this.writeIdx - 1 - i + cap * 2) % cap;
				sum += this.unaccountedMs[slot];
			}
			sections[sections.length - 1].avg = sum / n;
		}

		return {
			frames: n,
			droppedOutliers: this.droppedOutliers,
			frame: frameStats,
			sections,
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
			`[FrameProfiler] last ${r.frames} frames (${r.droppedOutliers} outliers dropped) — frame avg ${r.frame.avg.toFixed(2)}ms p50 ${r.frame.p50.toFixed(2)} p95 ${r.frame.p95.toFixed(2)} max ${r.frame.max.toFixed(2)}`,
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
		console.groupEnd();
	}

	/** One-line summary for the debug panel (p95-weighted). */
	public summaryLine(): string {
		const r = this.report(300);
		if (r.frames === 0) return "no samples";
		const unaccounted = r.sections.find((s) => s.name === "(unaccounted)");
		const top = [...r.sections]
			.filter((s) => s.name !== "(unaccounted)")
			.sort((a, b) => b.p95 - a.p95)
			.slice(0, 3)
			.map((s) => `${s.name} ${s.p95.toFixed(1)}`)
			.join(" | ");
		return `p95 ${r.frame.p95.toFixed(1)}ms idle+gpu ${unaccounted ? unaccounted.p95.toFixed(1) : "?"}ms | ${top}`;
	}
}

// ---------------------------------------------------------------------------
// Shared application profiler. Fixed section table — sections not listed here
// are ignored (with a dev-mode warning). Sections must not overlap; they may
// be spread across multiple callbacks in one frame (values accumulate).
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
	"gpuLag",
] as const;

export const frameProfiler = new FrameProfiler([...PROFILE_SECTIONS]);
