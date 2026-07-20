// ---------------------------------------------------------------------------
// EventBus
//
// Minimal typed event bus for decoupling modules that would otherwise create
// import cycles. Uses the same Map<key, Set<fn>> pattern as Babylon Observable
// but without a scene dependency.
// ---------------------------------------------------------------------------

type EventMap = {
	"player:pause-requested": undefined;
	"player:position-changed": { x: number; y: number; z: number };
	"chunk:loaded": {
		chunkX: number;
		chunkY: number;
		chunkZ: number;
	};
};

type EventKey = keyof EventMap;
type Listener<K extends EventKey> = (data: EventMap[K]) => void;

const listeners = new Map<EventKey, Set<Listener<any>>>();

/**
 * Subscribe to an event. Returns an unsubscribe function.
 */
export function on<K extends EventKey>(event: K, fn: Listener<K>): () => void {
	if (!listeners.has(event)) {
		listeners.set(event, new Set());
	}
	listeners.get(event)?.add(fn);
	return () => {
		listeners.get(event)?.delete(fn);
	};
}

/**
 * Emit an event to all subscribers.
 */
export function emit<K extends EventKey>(event: K, data: EventMap[K]): void {
	listeners.get(event)?.forEach((fn) => {
		fn(data);
	});
}
