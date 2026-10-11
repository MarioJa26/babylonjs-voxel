import { readFileSync } from "node:fs";

/**
 * Physical-core estimation for worker-pool sizing.
 *
 * WHY THIS EXISTS
 *
 * Node's `os.cpus().length` and the browser's `navigator.hardwareConcurrency`
 * both report LOGICAL processors (hardware threads), not physical cores. On
 * any SMT machine — which is essentially every modern x86 CPU — logical count
 * is 2x physical count.
 *
 * Sizing a CPU-bound worker pool from the logical count is wrong twice over:
 *
 *   1. It over-allocates. 8 runnable threads on 6 physical cores do NOT get
 *      8 cores of throughput. SMT siblings share one core's execution
 *      resources, and once a core is saturated the extra threads add
 *      contention and cache pressure. Past that point, running 8 threads on 6
 *      cores is typically SLOWER than running 6.
 *
 *   2. It steals budget from the main thread. In this codebase the main thread
 *      is the most latency-sensitive thread in the process: the server's runs
 *      the 20 Hz tick, mob/water simulation, blob deflate and the LevelDB
 *      write pump; the client's renders, assembles meshes and performs
 *      occlusion culling. Those threads degrade badly when starved, and that
 *      shows up as latency spikes rather than as reduced throughput.
 *
 * The failure is invisible in normal use — everything still works, just
 * slowly — so it is worth detecting explicitly rather than assuming the
 * logical count is the core count.
 */

/**
 * Best-effort physical core count.
 *
 * Detection is layered and conservative:
 *
 *   - Linux: parse /proc/cpuinfo, which exposes `physical id` and `core id`.
 *     Grouping by (physical id, core id) gives a true physical core count.
 *   - Elsewhere (Windows/macOS): no portable API. Fall back to assuming SMT
 *     (2 threads per core) when the logical count is in the range where SMT is
 *     essentially universal, which is the safe assumption for capacity
 *     planning. Below that range, take the count at face value — assuming SMT
 *     on a small machine would starve it.
 *
 * Clamped to [1, logicalCount] so a parse failure or malformed cpuinfo can
 * never yield 0 or a value above the real thread count.
 */
export function detectPhysicalCores(logicalCores: number): number {
	const logical = Math.max(1, Math.floor(logicalCores) || 1);

	if (process.platform === "linux") {
		const fromProc = readLinuxPhysicalCores();
		if (fromProc !== null && fromProc >= 1 && fromProc <= logical) {
			return fromProc;
		}
	}

	if (logical >= 8) {
		return Math.max(1, Math.round(logical / 2));
	}

	return logical;
}

function readLinuxPhysicalCores(): number | null {
	let text: string;

	try {
		// Runs once per process start; the OS caches this.
		text = readFileSync("/proc/cpuinfo", "utf-8");
	} catch {
		return null;
	}

	const seen = new Set<string>();
	let physicalId: string | null = null;
	let coreId: string | null = null;

	const flush = (): void => {
		if (physicalId !== null && coreId !== null) {
			seen.add(`${physicalId}:${coreId}`);
		}
		physicalId = null;
		coreId = null;
	};

	for (const line of text.split("\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) {
			// Blank line or record separator.
			flush();
			continue;
		}

		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();

		if (key === "physical id") physicalId = value;
		else if (key === "core id") coreId = value;
	}

	flush();

	return seen.size > 0 ? seen.size : null;
}