/**
 * ChatHistory — shared input-history state for the local and multiplayer chat
 * inputs. Tracks previously submitted messages and navigation through them with
 * the up/down arrow keys.
 */
export class ChatHistory {
	#entries: string[] = [];
	#index = -1;

	/**
	 * Record a submitted message and reset navigation to the newest entry.
	 */
	add(entry: string): void {
		if (!entry) return;
		this.#entries.push(entry);
		this.#index = this.#entries.length;
	}

	/**
	 * Reset navigation to the newest entry (call when the chat is opened).
	 */
	reset(): void {
		this.#index = this.#entries.length;
	}

	/**
	 * Move back through history. Returns the previous message, or null to
	 * keep the current input unchanged.
	 */
	previous(): string | null {
		if (this.#entries.length === 0 || this.#index <= 0) return null;
		this.#index--;
		return this.#entries[this.#index];
	}

	/**
	 * Move forward through history. Returns the next message, or null to
	 * clear the input.
	 */
	next(): string | null {
		if (this.#index < this.#entries.length - 1) {
			this.#index++;
			return this.#entries[this.#index];
		}
		this.#index = this.#entries.length;
		return null;
	}
}
