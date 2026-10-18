import type { NetClient } from "./NetClient";

/**
 * Shared single-open broker for RemoteContainerManager / RemoteStationManager.
 *
 * Both request a server snapshot and wait for the matching State message.
 * Only one open is tracked at a time: a new request supersedes the previous
 * one, and supersede/disconnect/timeout/dispose all reject the waiters so
 * panels never hang.
 */
export class PendingOpenBroker<TState> {
	private pending: {
		key: string;
		resolve: (state: TState) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;

	/**
	 * Begin an open request. Creation order mirrors the original managers:
	 * any previous open is failed as "superseded" first (callers own their
	 * connected checks), then the timer + entry are registered before the
	 * request is sent.
	 */
	begin(
		label: string,
		key: string,
		timeoutMs: number,
		send: () => void,
	): Promise<TState> {
		this.fail(label, "superseded");

		return new Promise<TState>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending?.timer === timer) this.pending = null;
				reject(new Error(`${label} open timed out`));
			}, timeoutMs);
			this.pending = { key, resolve, reject, timer };
			send();
		});
	}

	/**
	 * Match a message key against the pending open. Fetching consumes the
	 * entry (field cleared, timer cleared) so resolve/reject never double-fires.
	 */
	takeIfKey(key: string): {
		resolve: (state: TState) => void;
		reject: (error: Error) => void;
	} | null {
		const pending = this.pending;
		if (!pending || pending.key !== key) return null;
		this.pending = null;
		clearTimeout(pending.timer);
		return pending;
	}

	fail(label: string, reason: string): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = null;
		clearTimeout(pending.timer);
		pending.reject(new Error(`${label} open ${reason}`));
	}
}

/**
 * Register/remove the binary message + disconnect handlers every remote
 * manager needs, in one place. `onDisconnect` receives each manager's own
 * reconnect-reset behavior (e.g. clearing a version cache).
 */
export class ClientHandlerBinding {
	readonly handler: (data: Uint8Array) => void;
	readonly onDisconnected: () => void;

	constructor(
		client: NetClient,
		onMessage: (data: Uint8Array) => void,
		onDisconnect: () => void,
	) {
		this.handler = onMessage;
		this.onDisconnected = onDisconnect;
		client.addBinaryHandler(this.handler);
		client.addDisconnectListener(this.onDisconnected);
	}

	dispose(client: NetClient): void {
		client.removeBinaryHandler(this.handler);
		client.removeDisconnectListener(this.onDisconnected);
	}
}
