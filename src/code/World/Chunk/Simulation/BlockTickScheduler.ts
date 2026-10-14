const RING_SIZE = 64;
const RING_MASK = RING_SIZE - 1;

const DEFAULT_SAFETY_CEILING = 4096;

const KEY_X_BITS = 21;
const KEY_Y_BITS = 11;
const KEY_Z_BITS = 21;

const KEY_X_OFFSET = 1 << (KEY_X_BITS - 1);
const KEY_Y_OFFSET = 1 << (KEY_Y_BITS - 1);
const KEY_Z_OFFSET = 1 << (KEY_Z_BITS - 1);

const KEY_Y_MUL = 2 ** KEY_Z_BITS;
const KEY_X_MUL = 2 ** (KEY_Y_BITS + KEY_Z_BITS);

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
	/**
	 * Authoritative target tick for each scheduled coordinate.
	 */
	#pending = new Map<number, number>();

	/**
	 * Interleaved [key, targetTick, key, targetTick, ...] entries.
	 *
	 * Recording targetTick alongside the key is necessary because a stale
	 * bucket entry could otherwise match a newly scheduled operation for the
	 * same coordinate and cause it to execute too early.
	 */
	#buckets: number[][] = Array.from({ length: RING_SIZE }, () => []);

	/**
	 * Interleaved [key, targetTick, ...] entries carried over after hitting
	 * the safety ceiling.
	 */
	#overflow: number[] = [];

	currentTick = 0;
	safetyCeiling = DEFAULT_SAFETY_CEILING;

	#processCallback:
		| ((worldX: number, worldY: number, worldZ: number) => void)
		| null = null;

	static getInstance(): BlockTickScheduler {
		return (_instance ??= new BlockTickScheduler());
	}

	setProcessCallback(
		cb: (worldX: number, worldY: number, worldZ: number) => void,
	): void {
		this.#processCallback = cb;
	}

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

		// A zero-delay update must run on the next scheduler tick. Putting it
		// in the current tick's bucket would delay it by a complete ring lap.
		const clampedDelay = Math.min(RING_MASK, Math.max(1, delay | 0));

		const targetTick = this.currentTick + clampedDelay;
		const existingTargetTick = this.#pending.get(key);

		// Retain the earliest request for this coordinate.
		if (existingTargetTick !== undefined && targetTick >= existingTargetTick) {
			return;
		}

		this.#pending.set(key, targetTick);

		const bucket = this.#buckets[targetTick & RING_MASK];
		bucket.push(key, targetTick);
	}

	removeAt(worldX: number, worldY: number, worldZ: number): void {
		this.#pending.delete(packKey(worldX, worldY, worldZ));
	}

	processFrame(): void {
		this.currentTick++;

		const callback = this.#processCallback;
		if (!callback) return;

		const bucketIndex = this.currentTick & RING_MASK;
		const freshDue = this.#buckets[bucketIndex];

		// Detach the bucket before invoking callbacks. Any callback that
		// schedules into this ring slot writes to a different array.
		this.#buckets[bucketIndex] = [];

		// Detach overflow as well, so callback-driven scheduling cannot
		// mutate the collection currently being drained.
		const previousOverflow = this.#overflow;
		this.#overflow = [];

		let inspectedCount = 0;
		const ceiling = this.safetyCeiling;

		// Preserve ordering: overdue entries are inspected before fresh ones.
		let index = 0;

		for (; index < previousOverflow.length; index += 2) {
			if (inspectedCount >= ceiling) break;
			inspectedCount++;

			const key = previousOverflow[index];
			const targetTick = previousOverflow[index + 1];

			// Match both key and generation/target tick. A key-only check can
			// accidentally execute a newer schedule through an old tombstone.
			if (this.#pending.get(key) !== targetTick) continue;

			this.#pending.delete(key);
			callback(unpackKeyX(key), unpackKeyY(key), unpackKeyZ(key));
		}

		if (index < previousOverflow.length) {
			for (; index < previousOverflow.length; index += 2) {
				this.#overflow.push(
					previousOverflow[index],
					previousOverflow[index + 1],
				);
			}

			// The ceiling has already been reached, so all fresh entries
			// must be carried over too.
			for (let i = 0; i < freshDue.length; i += 2) {
				this.#overflow.push(freshDue[i], freshDue[i + 1]);
			}

			return;
		}

		index = 0;

		for (; index < freshDue.length; index += 2) {
			if (inspectedCount >= ceiling) break;
			inspectedCount++;

			const key = freshDue[index];
			const targetTick = freshDue[index + 1];

			if (this.#pending.get(key) !== targetTick) continue;

			this.#pending.delete(key);
			callback(unpackKeyX(key), unpackKeyY(key), unpackKeyZ(key));
		}

		for (; index < freshDue.length; index += 2) {
			this.#overflow.push(freshDue[index], freshDue[index + 1]);
		}
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	getDiagnostics(): {
		pendingCount: number;
		overflowCount: number;
	} {
		return {
			pendingCount: this.#pending.size,
			overflowCount: this.#overflow.length >>> 1,
		};
	}

	clear(): void {
		this.#pending.clear();

		for (let i = 0; i < RING_SIZE; i++) {
			this.#buckets[i].length = 0;
		}

		this.#overflow.length = 0;
	}
}
