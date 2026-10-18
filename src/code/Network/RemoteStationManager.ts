/**
 * RemoteStationManager — client side of server-authoritative stations.
 *
 * Registers a binary handler on the NetClient (same pattern as
 * RemoteContainerManager) and turns StationState / StationSlotUpdate /
 * StationRejected messages into callbacks consumed by StationUi.
 *
 * The server owns every slot **and the smelt itself**. This manager never invents
 * progress: it transports snapshots and deltas, and pushes slot writes. A client
 * that reported its own progress would be a trivial way to mint ingots, so the
 * client-side StationRuntime is singleplayer-only and this is the only path in
 * multiplayer.
 */

import type { NetClient } from "./NetClient";
import { ClientHandlerBinding, PendingOpenBroker } from "./PendingOpenBroker";
import {
	BinaryDecoder,
	decodeStationRejectedInto,
	decodeStationResultClaimedInto,
	decodeStationSlotUpdateInto,
	decodeStationStateInto,
} from "./protocol/encoder";
import { MessageType } from "./protocol/messages";

export interface RemoteStationStack {
	itemId: number;
	stackSize: number;
}

export interface RemoteStationState {
	x: number;
	y: number;
	z: number;
	version: number;
	/** Numeric StationKind; see StationTypes.STATION_KINDS. */
	kind: number;
	capTier: number;
	input: RemoteStationStack;
	fuel: RemoteStationStack;
	output: RemoteStationStack;
	smeltProgress: number;
	burnRemaining: number;
	/** Sent by the server rather than derived, so the two can never disagree. */
	lit: boolean;
}

export interface RemoteStationSlotUpdate {
	x: number;
	y: number;
	z: number;
	version: number;
	/** -1 means a counter changed, not a slot. */
	slot: number;
	itemId: number;
	stackSize: number;
	smeltProgress: number;
	burnRemaining: number;
	lit: boolean;
}

export interface RemoteStationRejection {
	x: number;
	y: number;
	z: number;
	reason: number;
}

/** The server confirmed this client won the result stack. */
export interface RemoteStationResultClaimed {
	x: number;
	y: number;
	z: number;
	itemId: number;
	stackSize: number;
}

export interface RemoteStationCallbacks {
	onState?: (state: RemoteStationState) => void;
	onSlotUpdate?: (update: RemoteStationSlotUpdate) => void;
	onRejected?: (rejection: RemoteStationRejection) => void;
	onResultClaimed?: (claimed: RemoteStationResultClaimed) => void;
}

/** ms to wait for a StationState before failing the open. */
const OPEN_TIMEOUT_MS = 8000;

function posKey(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

export class RemoteStationManager {
	private readonly decoder = new BinaryDecoder(new Uint8Array(0));

	// Reusable decode targets, in the house style for hot binary paths: zero
	// allocation per message. Values are copied out before being retained.
	private readonly stateScratch: RemoteStationState = {
		x: 0,
		y: 0,
		z: 0,
		version: 0,
		kind: 0,
		capTier: 0,
		input: { itemId: 0, stackSize: 0 },
		fuel: { itemId: 0, stackSize: 0 },
		output: { itemId: 0, stackSize: 0 },
		smeltProgress: 0,
		burnRemaining: 0,
		lit: false,
	};
	private readonly slotUpdateScratch: RemoteStationSlotUpdate = {
		x: 0,
		y: 0,
		z: 0,
		version: 0,
		slot: -1,
		itemId: 0,
		stackSize: 0,
		smeltProgress: 0,
		burnRemaining: 0,
		lit: false,
	};
	private readonly rejectedScratch = { x: 0, y: 0, z: 0, reason: 0 };
	private readonly claimedScratch = {
		x: 0,
		y: 0,
		z: 0,
		itemId: 0,
		stackSize: 0,
	};

	private readonly binding: ClientHandlerBinding;
	private callbacks: RemoteStationCallbacks = {};

	private readonly pendingOpen = new PendingOpenBroker<RemoteStationState>();

	/** Highest version seen per station, so stale deltas can be dropped. */
	private readonly latestVersion = new Map<string, number>();

	constructor(private readonly client: NetClient) {
		this.binding = new ClientHandlerBinding(
			client,
			(data) => this.handleBinaryMessage(data),
			// A reconnect starts fresh server state: fail any in-flight open so
			// the panel never hangs on a station that no longer exists, and
			// drop the version cache so the first snapshot after reconnect is
			// accepted.
			() => {
				this.pendingOpen.fail("station", "disconnected");
				this.latestVersion.clear();
			},
		);
	}

	setCallbacks(callbacks: RemoteStationCallbacks): void {
		this.callbacks = callbacks;
	}

	/**
	 * Request to view the station at a position. Resolves with the authoritative
	 * snapshot, or rejects on StationRejected / timeout / disconnect.
	 */
	open(x: number, y: number, z: number): Promise<RemoteStationState> {
		if (!this.client.isConnected) {
			return Promise.reject(new Error("not connected"));
		}

		return this.pendingOpen.begin(
			"station",
			posKey(x, y, z),
			OPEN_TIMEOUT_MS,
			() => this.client.sendStationOpen(x, y, z),
		);
	}

	/** Write input(0) or fuel(1). The server refuses slot 2 outright. */
	sendSetSlot(
		x: number,
		y: number,
		z: number,
		slot: number,
		itemId: number,
		stackSize: number,
	): void {
		this.client.sendStationSetSlot(x, y, z, slot, itemId, stackSize);
	}

	sendUpgrade(x: number, y: number, z: number, capTier: number): void {
		this.client.sendStationUpgrade(x, y, z, capTier);
	}

	/**
	 * Ask the server to hand over the result stack.
	 *
	 * The server clears its copy first and answers with StationResultClaimed only
	 * if this client actually won the stack, so the local inventory addition waits
	 * for that reply rather than happening on click.
	 */
	sendClaimResult(x: number, y: number, z: number): void {
		this.client.sendStationClaimResult(x, y, z);
	}

	private handleBinaryMessage(data: Uint8Array): void {
		if (data.byteLength < 1) return;

		switch (data[0]) {
			case MessageType.StationState: {
				this.decoder.setBuffer(data);
				this.decoder.readUint8();
				const s = decodeStationStateInto(this.decoder, this.stateScratch);

				const snapshot: RemoteStationState = {
					x: s.x,
					y: s.y,
					z: s.z,
					version: s.version,
					kind: s.kind,
					capTier: s.capTier,
					input: { ...s.input },
					fuel: { ...s.fuel },
					output: { ...s.output },
					smeltProgress: s.smeltProgress,
					burnRemaining: s.burnRemaining,
					lit: s.lit,
				};

				this.latestVersion.set(posKey(s.x, s.y, s.z), s.version);

				const pending = this.pendingOpen.takeIfKey(posKey(s.x, s.y, s.z));
				if (pending) pending.resolve(snapshot);
				this.callbacks.onState?.(snapshot);
				break;
			}

			case MessageType.StationSlotUpdate: {
				this.decoder.setBuffer(data);
				this.decoder.readUint8();
				const u = decodeStationSlotUpdateInto(
					this.decoder,
					this.slotUpdateScratch,
				);

				// Drop out-of-order deltas. Progress updates arrive 20x a second per
				// viewer and can cross in flight over an unreliable transport.
				const key = posKey(u.x, u.y, u.z);
				const seen = this.latestVersion.get(key);
				if (seen !== undefined && u.version < seen) return;
				this.latestVersion.set(key, u.version);

				this.callbacks.onSlotUpdate?.({
					x: u.x,
					y: u.y,
					z: u.z,
					version: u.version,
					slot: u.slot,
					itemId: u.itemId,
					stackSize: u.stackSize,
					smeltProgress: u.smeltProgress,
					burnRemaining: u.burnRemaining,
					lit: u.lit,
				});
				break;
			}

			case MessageType.StationResultClaimed: {
				this.decoder.setBuffer(data);
				this.decoder.readUint8();
				const c = decodeStationResultClaimedInto(
					this.decoder,
					this.claimedScratch,
				);

				this.callbacks.onResultClaimed?.({
					x: c.x,
					y: c.y,
					z: c.z,
					itemId: c.itemId,
					stackSize: c.stackSize,
				});
				break;
			}

			case MessageType.StationRejected: {
				this.decoder.setBuffer(data);
				this.decoder.readUint8();
				const r = decodeStationRejectedInto(this.decoder, this.rejectedScratch);

				const rejection: RemoteStationRejection = {
					x: r.x,
					y: r.y,
					z: r.z,
					reason: r.reason,
				};

				const pending = this.pendingOpen.takeIfKey(posKey(r.x, r.y, r.z));
				if (pending) {
					pending.reject(new Error(`station rejected (reason ${r.reason})`));
				}
				this.callbacks.onRejected?.(rejection);
				break;
			}
		}
	}

	dispose(): void {
		this.binding.dispose(this.client);
		this.pendingOpen.fail("station", "disposed");
		this.callbacks = {};
		this.latestVersion.clear();
	}
}
