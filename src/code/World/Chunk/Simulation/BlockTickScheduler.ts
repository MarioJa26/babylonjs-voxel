const RING_SIZE = 64;
const RING_MASK = RING_SIZE - 1;

const DEFAULT_SAFETY_CEILING = 4096;

const KEY_X_BITS = 21;
const KEY_Y_BITS = 11;
const KEY_Z_BITS = 21;

const KEY_X_OFFSET = 2 ** (KEY_X_BITS - 1);
const KEY_Y_OFFSET = 2 ** (KEY_Y_BITS - 1);
const KEY_Z_OFFSET = 2 ** (KEY_Z_BITS - 1);

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
	const remainder = key % KEY_X_MUL;
	return Math.floor(remainder / KEY_Y_MUL) - KEY_Y_OFFSET;
}

function unpackKeyZ(key: number): number {
	return (key % KEY_Y_MUL) - KEY_Z_OFFSET;
}

let _instance: BlockTickScheduler | null = null;

export class BlockTickScheduler {
	/**
	 * Authoritative target tick for each scheduled coordinate.
	 */
	readonly #pending = new Map<number, number>();

	/**
	 * Interleaved [key, targetTick, key, targetTick, ...] entries.
	 */
	readonly #buckets: number[][] = Array.from({ length: RING_SIZE }, () => []);

	/**
	 * Interleaved overdue entries retained after the processing budget is
	 * exhausted.
	 */
	readonly #overflow: number[] = [];

	currentTick = 0;
	safetyCeiling = DEFAULT_SAFETY_CEILING;

	#processCallback:
		| ((worldX: number, worldY: number, worldZ: number) => void)
		| null = null;

	static getInstance(): BlockTickScheduler {
		_instance ??= new BlockTickScheduler();
		return _instance;
	}

	setProcessCallback(
		cb: (worldX: number, worldY: number, worldZ: number) => void,
	): void {
		this.#processCallback = cb;
	}

	setBudget(budget: number): void {
		this.safetyCeiling = Math.max(1, Math.trunc(budget));
	}

	schedule(
		worldX: number,
		worldY: number,
		worldZ: number,
		delay: number,
	): void {
		const key = packKey(worldX, worldY, worldZ);

		/*
		 * Zero and negative delays execute on the next scheduler tick.
		 * The ring can represent delays from 1 through 63 without aliasing
		 * the currently processed slot.
		 */
		const integerDelay = Number.isFinite(delay) ? Math.trunc(delay) : 1;
		const clampedDelay =
			integerDelay < 1
				? 1
				: integerDelay > RING_MASK
					? RING_MASK
					: integerDelay;

		const targetTick = this.currentTick + clampedDelay;
		const existingTargetTick = this.#pending.get(key);

		// Retain only the earliest pending request for this coordinate.
		if (existingTargetTick !== undefined && targetTick >= existingTargetTick) {
			return;
		}

		this.#pending.set(key, targetTick);
		this.#buckets[targetTick & RING_MASK].push(key, targetTick);
	}

	removeAt(worldX: number, worldY: number, worldZ: number): void {
		this.#pending.delete(packKey(worldX, worldY, worldZ));
	}

	processFrame(): void {
		this.currentTick++;

		const callback = this.#processCallback;

		if (callback === null) {
			return;
		}

		const ceiling = this.safetyCeiling;
		let inspectedCount = 0;

		/*
		 * Drain existing overflow first. Process entries in place, then move
		 * any uninspected suffix to the front of the same array.
		 *
		 * Callback-created schedules always enter a future ring bucket, so
		 * they cannot mutate #overflow while this loop is running.
		 */
		const overflow = this.#overflow;
		const overflowLength = overflow.length;
		let overflowRead = 0;

		while (overflowRead < overflowLength && inspectedCount < ceiling) {
			const key = overflow[overflowRead]!;
			const targetTick = overflow[overflowRead + 1]!;

			overflowRead += 2;
			inspectedCount++;

			if (this.#pending.get(key) !== targetTick) {
				continue;
			}

			this.#pending.delete(key);

			callback(unpackKeyX(key), unpackKeyY(key), unpackKeyZ(key));
		}

		if (overflowRead < overflowLength) {
			let write = 0;

			for (let read = overflowRead; read < overflowLength; read += 2) {
				overflow[write] = overflow[read]!;
				overflow[write + 1] = overflow[read + 1]!;
				write += 2;
			}

			overflow.length = write;
			return;
		}

		overflow.length = 0;

		const bucketIndex = this.currentTick & RING_MASK;
		const bucket = this.#buckets[bucketIndex];
		const bucketLength = bucket.length;
		let bucketRead = 0;

		/*
		 * A callback cannot schedule into this bucket because every delay is
		 * at least one tick. Therefore, the current bucket can safely be
		 * processed and cleared in place instead of replacing it with [].
		 */
		while (bucketRead < bucketLength && inspectedCount < ceiling) {
			const key = bucket[bucketRead]!;
			const targetTick = bucket[bucketRead + 1]!;

			bucketRead += 2;
			inspectedCount++;

			if (this.#pending.get(key) !== targetTick) {
				continue;
			}

			this.#pending.delete(key);

			callback(unpackKeyX(key), unpackKeyY(key), unpackKeyZ(key));
		}

		/*
		 * Carry the uninspected suffix forward. Use a manual copy rather than
		 * slice/spread to avoid creating a temporary array or risking an
		 * argument-count limit.
		 */
		for (let read = bucketRead; read < bucketLength; read += 2) {
			overflow.push(bucket[read]!, bucket[read + 1]!);
		}

		bucket.length = 0;
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
			this.#buckets[i]!.length = 0;
		}

		this.#overflow.length = 0;
	}
}
