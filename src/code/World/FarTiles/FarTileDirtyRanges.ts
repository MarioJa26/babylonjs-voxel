/**
 * Pure far-tile dirty-range interval tracker.
 *
 * ZERO imports. This module must stay dependency-free so the self-test can
 * compile and run it standalone (see scripts/far-tile-selftest.ts).
 *
 * Holds dirty ranges as two parallel number[] arrays (`starts`/`counts`),
 * always kept sorted and canonical: intervals are non-empty, pairwise
 * non-overlapping AND non-touching (adjacent ranges merge, exactly like the
 * original linear-scan merge this replaces).
 *
 * Why replacing the O(n^2) restart-scan merge: worker completions arrive out
 * of order while arena hole reuse makes slots non-monotonic, so streaming
 * bursts fragmented the range list and the old "restart from index 0 after
 * every merge + splice" implementation degenerated quadratically. This
 * version does a binary-search insertion (O(log n) typical) plus one
 * `copyWithin` tail shift — O(n) worst, but with a tiny constant and no
 * per-merge rescan.
 */
export function farTilePushDirtyRange(
	starts: number[],
	counts: number[],
	start: number,
	count: number,
): void {
	if (count <= 0) {
		return;
	}

	const size = starts.length;
	let newStart = start;
	let newEnd = start + count;

	// First entry whose start is >= the requested start (lower bound).
	let lo = 0;
	let hi = size;

	while (lo < hi) {
		const mid = (lo + hi) >> 1;

		if (starts[mid] < start) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}

	/*
	 * The canonical array is pairwise non-touching, so at most the entry
	 * left of the insertion point can overlap/adjacency-merge the new range
	 * from below; anything further left ends strictly before it starts.
	 */
	let insert = lo;
	let absorbStart = lo;

	if (lo > 0) {
		const prevIndex = lo - 1;
		const prevEnd = starts[prevIndex] + counts[prevIndex];

		if (prevEnd >= newStart) {
			if (prevEnd > newEnd) {
				newEnd = prevEnd;
			}

			newStart = starts[prevIndex];
			insert = prevIndex;
			absorbStart = lo;
		}
	}

	// Absorb every entry that touches the (possibly widened) new range's top.
	let absorbEnd = absorbStart;

	for (let index = absorbStart; index < size; index++) {
		if (starts[index] > newEnd) {
			break;
		}

		const existingEnd = starts[index] + counts[index];

		if (existingEnd > newEnd) {
			newEnd = existingEnd;
		}

		absorbEnd = index + 1;
	}

	// Shift the survivors [absorbEnd, size) down to (insert + 1, ...) and
	// truncate the absorbed entries away. For a pure insert (nothing was
	// absorbed) this is the classic "make room" shift.
	//
	// copyWithin NEVER extends an array: a pure insert shifts survivors one
	// slot right, which needs one extra slot at the end, so the arrays are
	// grown first. Absorbed merges shift narrowed overlap targets DOWN and
	// always fit inside the current length — no growth there.
	if (insert === absorbEnd) {
		starts.push(0);
		counts.push(0);
	}

	const tailLength = size - absorbEnd;

	if (tailLength > 0) {
		starts.copyWithin(insert + 1, absorbEnd, size);
		counts.copyWithin(insert + 1, absorbEnd, size);
	}

	starts[insert] = newStart;
	counts[insert] = newEnd - newStart;

	const nextLength = insert + 1 + tailLength;

	starts.length = nextLength;
	counts.length = nextLength;
}
