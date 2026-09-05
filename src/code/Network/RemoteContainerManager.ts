/**
 * RemoteContainerManager — client side of server-authoritative crates.
 *
 * Registers a binary handler on the NetClient (same pattern as
 * RemoteItemManager) and turns ContainerState / ContainerSlotUpdate /
 * ContainerRejected messages into callbacks consumed by PlayerHud. The
 * server owns every slot; this manager only transports snapshots, live
 * deltas, and rejections — it never invents inventory contents.
 */

import type { NetClient } from "./NetClient";
import {
	BinaryDecoder,
	decodeContainerRejectedInto,
	decodeContainerSlotUpdateInto,
	decodeContainerStateInto,
} from "./protocol/encoder";
import { MessageType } from "./protocol/messages";

export interface RemoteContainerSlot {
	itemId: number;
	stackSize: number;
}

export interface RemoteContainerState {
	x: number;
	y: number;
	z: number;
	version: number;
	width: number;
	height: number;
	slots: RemoteContainerSlot[];
}

export interface RemoteContainerSlotUpdate {
	x: number;
	y: number;
	z: number;
	version: number;
	row: number;
	col: number;
	itemId: number;
	stackSize: number;
}

export interface RemoteContainerRejection {
	x: number;
	y: number;
	z: number;
	reason: number;
}

export interface RemoteContainerCallbacks {
	onState?: (state: RemoteContainerState) => void;
	onSlotUpdate?: (update: RemoteContainerSlotUpdate) => void;
	onRejected?: (rejection: RemoteContainerRejection) => void;
}

/** ms to wait for a ContainerState before failing the open. */
const OPEN_TIMEOUT_MS = 8000;

function posKey(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

export class RemoteContainerManager {
	private readonly decoder = new BinaryDecoder(new Uint8Array(0));
	private readonly stateScratch = {
		x: 0,
		y: 0,
		z: 0,
		version: 0,
		width: 0,
		height: 0,
		slots: [] as RemoteContainerSlot[],
	};
	private readonly slotUpdateScratch = {
		x: 0,
		y: 0,
		z: 0,
		version: 0,
		row: 0,
		col: 0,
		itemId: 0,
		stackSize: 0,
	};
	private readonly rejectedScratch = { x: 0, y: 0, z: 0, reason: 0 };
	private readonly handler: (data: Uint8Array) => void;
	private readonly onDisconnected: () => void;
	private callbacks: RemoteContainerCallbacks = {};
	private pendingOpen: {
		key: string;
		resolve: (state: RemoteContainerState) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;

	constructor(private readonly client: NetClient) {
		this.handler = (data) => this.handleBinaryMessage(data);
		this.client.addBinaryHandler(this.handler);

		// A reconnect starts fresh server state: fail any in-flight open so
		// the HUD never hangs on a loading crate, and let viewers re-open.
		this.onDisconnected = () => this.failPendingOpen("disconnected");
		this.client.addDisconnectListener(this.onDisconnected);
	}

	setCallbacks(callbacks: RemoteContainerCallbacks): void {
		this.callbacks = callbacks;
	}

	/**
	 * Request to view a crate. Resolves with the authoritative snapshot, or
	 * rejects on ContainerRejected / timeout / disconnect. Only one open is
	 * tracked at a time (the crate UI shows a single crate); a new request
	 * supersedes the previous one.
	 */
	open(x: number, y: number, z: number): Promise<RemoteContainerState> {
		this.failPendingOpen("superseded");
		if (!this.client.isConnected) {
			return Promise.reject(new Error("not connected"));
		}
		return new Promise<RemoteContainerState>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pendingOpen?.timer === timer) this.pendingOpen = null;
				reject(new Error("container open timed out"));
			}, OPEN_TIMEOUT_MS);
			this.pendingOpen = { key: posKey(x, y, z), resolve, reject, timer };
			this.client.sendContainerOpen(x, y, z);
		});
	}

	sendSetSlot(
		x: number,
		y: number,
		z: number,
		row: number,
		col: number,
		itemId: number,
		stackSize: number,
	): void {
		this.client.sendContainerSetSlot(x, y, z, row, col, itemId, stackSize);
	}

	sendClose(x: number, y: number, z: number): void {
		this.client.sendContainerClose(x, y, z);
	}

	private failPendingOpen(reason: string): void {
		const pending = this.pendingOpen;
		if (!pending) return;
		this.pendingOpen = null;
		clearTimeout(pending.timer);
		pending.reject(new Error(`container open ${reason}`));
	}

	private handleBinaryMessage(data: Uint8Array): void {
		if (data.byteLength < 1) return;

		switch (data[0]) {
			case MessageType.ContainerState: {
				this.decoder.setBuffer(data);
				this.decoder.readUint8();
				const state = decodeContainerStateInto(this.decoder, this.stateScratch);
				// Copy out of the scratch: decode reuses the slots array shape
				// per message and the HUD retains the snapshot.
				const snapshot: RemoteContainerState = {
					x: state.x,
					y: state.y,
					z: state.z,
					version: state.version,
					width: state.width,
					height: state.height,
					slots: state.slots.map((s) => ({
						itemId: s.itemId,
						stackSize: s.stackSize,
					})),
				};
				const pending = this.pendingOpen;
				if (pending && pending.key === posKey(state.x, state.y, state.z)) {
					this.pendingOpen = null;
					clearTimeout(pending.timer);
					pending.resolve(snapshot);
				}
				this.callbacks.onState?.(snapshot);
				break;
			}

			case MessageType.ContainerSlotUpdate: {
				this.decoder.setBuffer(data);
				this.decoder.readUint8();
				const u = decodeContainerSlotUpdateInto(
					this.decoder,
					this.slotUpdateScratch,
				);
				this.callbacks.onSlotUpdate?.({
					x: u.x,
					y: u.y,
					z: u.z,
					version: u.version,
					row: u.row,
					col: u.col,
					itemId: u.itemId,
					stackSize: u.stackSize,
				});
				break;
			}

			case MessageType.ContainerRejected: {
				this.decoder.setBuffer(data);
				this.decoder.readUint8();
				const r = decodeContainerRejectedInto(
					this.decoder,
					this.rejectedScratch,
				);
				const rejection: RemoteContainerRejection = {
					x: r.x,
					y: r.y,
					z: r.z,
					reason: r.reason,
				};
				const pending = this.pendingOpen;
				if (pending && pending.key === posKey(r.x, r.y, r.z)) {
					this.pendingOpen = null;
					clearTimeout(pending.timer);
					pending.reject(new Error(`container rejected (reason ${r.reason})`));
				}
				this.callbacks.onRejected?.(rejection);
				break;
			}
		}
	}

	dispose(): void {
		this.client.removeBinaryHandler(this.handler);
		this.client.removeDisconnectListener(this.onDisconnected);
		this.failPendingOpen("disposed");
		this.callbacks = {};
	}
}
