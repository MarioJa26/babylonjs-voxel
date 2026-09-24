// A scheduled block goes into one of RING_SIZE buckets keyed by
// (targetTick % RING_SIZE). Each frame we advance one tick and drain
// exactly the bucket whose tick has arrived — so the number of blocks
// processed naturally matches however many are actually due, the same
// way vanilla's tick list works, instead of scanning the whole queue
// for a fixed-size subset every frame.
const RING_SIZE = 64; // supports scheduling up to 63 ticks into the future
const RING_MASK = RING_SIZE - 1; // RING_SIZE must stay a power of two

// Purely a safety valve against a pathological single-tick burst (e.g. an
// instantaneous flood-fill) stalling a frame — NOT a routine throttle.
// Vanilla has no meaningful per-tick cap on scheduled fluid updates, so
// this should essentially never bind during normal play.
const DEFAULT_SAFETY_CEILING = 4096;

// Packs world coordinates into a single number key instead of a template
// string, avoiding a string allocation + hash per schedule/removeAt call
// (same fix category as the unsigned-32-bit key work in TerrainHeightMap).
// Bit widths give +-1,048,576 on X/Z and +-1024 on Y while staying inside
// the 53-bit safe-integer range (21 + 11 + 21 = 53) — widen these (keeping
// the total <= 53) if your world needs a bigger horizontal range.
const KEY_X_BITS = 21;
const KEY_Y_BITS = 11;
const KEY_Z_BITS = 21;
const KEY_X_OFFSET = 1 << (KEY_X_BITS - 1);
const KEY_Y_OFFSET = 1 << (KEY_Y_BITS - 1);
const KEY_Z_OFFSET = 1 << (KEY_Z_BITS - 1);
const KEY_Y_MUL = 1 << KEY_Z_BITS;
const KEY_X_MUL = KEY_Y_MUL * (1 << KEY_Y_BITS);

function packKey(x: number, y: number, z: number): number {
	return (
		(x + KEY_X_OFFSET) * KEY_X_MUL +
		(y + KEY_Y_OFFSET) * KEY_Y_MUL +
		(z + KEY_Z_OFFSET)
	);
}

function unpackKeyX(key: number): number {
	return Math.floor(key / KEY_X_MUL) - KEY_X_OFFSET;
}

function unpackKeyY(key: number): number {
	return Math.floor((key % KEY_X_MUL) / KEY_Y_MUL) - KEY_Y_OFFSET;
}

function unpackKeyZ(key: number): number {
	return (key % KEY_Y_MUL) - KEY_Z_OFFSET;
}

let _instance: BlockTickScheduler | null = null;

export class BlockTickScheduler {
	// Authoritative "is this block scheduled, and for when" — keyed by
	// packed coordinate, value = targetTick. Reschedules only ever move a
	// key's targetTick earlier (see schedule() below), never later, which is
	// what makes the simple `undefined` staleness check in processFrame()
	// sufficient.
	//
	// PERF: coordinates are re-derived from the key at drain time instead of
	// storing a {x,y,z,tick} object per cell — water floods schedule thousands
	// of cells per second and each first-time key used to allocate one.
	#pending = new Map<number, number>();
	// buckets[tick & RING_MASK] holds the packed keys due at that tick.
	#buckets: number[][] = Array.from(
		{ length: RING_SIZE },
		() => [] as number[],
	);
	// Carries over anything that overflowed the safety ceiling last frame,
	// so it still runs (slightly late) instead of being dropped.
	#overflow: number[] = [];

	// Reusable scratch to avoid splice+concat allocation when merging overflow + freshDue.
	private static readonly _dueScratch: number[] = [];

	currentTick = 0;
	safetyCeiling = DEFAULT_SAFETY_CEILING;

	#processCallback:
		| ((worldX: number, worldY: number, worldZ: number) => void)
		| null = null;

	static getInstance(): BlockTickScheduler {
		if (_instance) return _instance;
		_instance = new BlockTickScheduler();
		return _instance;
	}

	setProcessCallback(
		cb: (worldX: number, worldY: number, worldZ: number) => void,
	): void {
		this.#processCallback = cb;
	}

	// Kept for API compatibility. Now sets the safety ceiling rather than a
	// routine per-frame cap — see DEFAULT_SAFETY_CEILING above for why.
	setBudget(budget: number): void {
		this.safetyCeiling = Math.max(1, budget | 0);
	}

	schedule(
		worldX: number,
		worldY: number,
		worldZ: number,
		delay: number,
	): void {
		const key = packKey(worldX, worldY, worldZ);
		const clampedDelay = Math.min(RING_MASK, Math.max(0, delay | 0));
		const targetTick = this.currentTick + clampedDelay;
		const existing = this.#pending.get(key);

		// Always keep whichever requested tick is sooner — matches the
		// original scheduler's semantics.
		if (existing !== undefined && targetTick >= existing) return;

		this.#pending.set(key, targetTick);
		// A stale copy left behind in an earlier-created bucket entry (if
		// any) is skipped at drain time via the #pending lookup — no need
		// to hunt it down and remove it from that bucket array now.
		this.#buckets[targetTick & RING_MASK].push(key);
	}

	removeAt(worldX: number, worldY: number, worldZ: number): void {
		// Leaves a tombstone in whatever bucket it was in; skipped there
		// once the #pending lookup no longer matches.
		this.#pending.delete(packKey(worldX, worldY, worldZ));
	}

	processFrame(): void {
		this.currentTick++;
		const callback = this.#processCallback;
		if (!callback) return;

		const bucketIdx = this.currentTick & RING_MASK;
		const freshDue = this.#buckets[bucketIdx];
		// Swap in a fresh array rather than clearing in place, so a
		// reschedule that lands back in this same slot mid-drain (only
		// possible if delayed ~RING_SIZE ticks) goes to next lap, not this
		// one.
		this.#buckets[bucketIdx] = [];

		const due: number[] =
			this.#overflow.length > 0
				? (() => {
						const scratch = BlockTickScheduler._dueScratch;
						scratch.length = 0;
						for (let i = 0; i < this.#overflow.length; i++)
							scratch.push(this.#overflow[i]);
						for (let i = 0; i < freshDue.length; i++) scratch.push(freshDue[i]);
						this.#overflow.length = 0;
						return scratch;
					})()
				: freshDue;

		const processCount = Math.min(due.length, this.safetyCeiling);

		for (let i = 0; i < processCount; i++) {
			const key = due[i];
			// Tombstone: cancelled via removeAt, or already fired via an
			// earlier reschedule.
			if (!this.#pending.has(key)) continue;
			this.#pending.delete(key);
			callback(unpackKeyX(key), unpackKeyY(key), unpackKeyZ(key));
		}

		for (let i = processCount; i < due.length; i++) {
			this.#overflow.push(due[i]);
		}
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	// Cheap diagnostics for verifying throughput in practice — see below.
	getDiagnostics(): { pendingCount: number; overflowCount: number } {
		return {
			pendingCount: this.#pending.size,
			overflowCount: this.#overflow.length,
		};
	}

	clear(): void {
		this.#pending.clear();
		for (let i = 0; i < RING_SIZE; i++) this.#buckets[i].length = 0;
		this.#overflow.length = 0;
	}
}
