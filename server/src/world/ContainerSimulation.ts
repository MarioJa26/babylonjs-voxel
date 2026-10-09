/**
 * ContainerSimulation — server-authoritative Wood Crate inventories.
 *
 * Each crate owns a fixed 3x6 slot grid. Live state is held in memory and
 * persisted through ServerWorldStorage.
 */

import {
	findTempleCacheAt,
	rollTempleCrate,
} from "@/code/Entities/TempleLootTable.ts";
import type {
	PersistedContainer,
	ServerWorldStorage,
} from "./ServerWorldStorage.ts";

export const CONTAINER_WIDTH = 3;
export const CONTAINER_HEIGHT = 6;
export const MAX_CONTAINER_ITEM_ID = 65535;
export const MAX_CONTAINER_STACK = 1024;

const CONTAINER_SLOT_COUNT = CONTAINER_WIDTH * CONTAINER_HEIGHT;

export interface ContainerSlot {
	itemId: number;
	/** Zero-sized stacks are normalized to itemId 0. */
	stackSize: number;
}

export interface ServerContainer {
	x: number;
	y: number;
	z: number;
	version: number;
	width: number;
	height: number;
	slots: ContainerSlot[];
}

interface PendingPersistence {
	container: ServerContainer;
	requestedVersion: number;
	persistedVersion: number;
	running: boolean;
}

export function containerKey(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

function emptySlot(): ContainerSlot {
	return {
		itemId: 0,
		stackSize: 0,
	};
}

function emptySlots(): ContainerSlot[] {
	const slots = new Array<ContainerSlot>(CONTAINER_SLOT_COUNT);

	for (let i = 0; i < CONTAINER_SLOT_COUNT; i++) {
		slots[i] = emptySlot();
	}

	return slots;
}

function normalizeSlot(itemId: number, stackSize: number): ContainerSlot {
	if (
		!Number.isInteger(itemId) ||
		itemId <= 0 ||
		itemId > MAX_CONTAINER_ITEM_ID ||
		!Number.isInteger(stackSize) ||
		stackSize <= 0 ||
		stackSize > MAX_CONTAINER_STACK
	) {
		return emptySlot();
	}

	return {
		itemId,
		stackSize,
	};
}

function restoreSlots(restored: PersistedContainer | null): ContainerSlot[] {
	if (restored === null || restored.slots.length !== CONTAINER_SLOT_COUNT) {
		return emptySlots();
	}

	const slots = new Array<ContainerSlot>(CONTAINER_SLOT_COUNT);
	const source = restored.slots;

	for (let i = 0; i < CONTAINER_SLOT_COUNT; i++) {
		const slot = source[i];
		slots[i] = normalizeSlot(slot.itemId, slot.stackSize);
	}

	return slots;
}

function snapshotContainer(container: ServerContainer): PersistedContainer {
	const source = container.slots;
	const slots = new Array<ContainerSlot>(source.length);

	for (let i = 0; i < source.length; i++) {
		const slot = source[i];

		slots[i] = {
			itemId: slot.itemId,
			stackSize: slot.stackSize,
		};
	}

	return {
		version: container.version,
		width: container.width,
		height: container.height,
		slots,
	};
}

export class ServerContainerStore {
	private readonly containers = new Map<string, ServerContainer>();

	/**
	 * Prevent duplicate storage reads and duplicate temple rolls when multiple
	 * clients open the same previously unloaded crate concurrently.
	 */
	private readonly pendingOpens = new Map<string, Promise<ServerContainer>>();

	/**
	 * Per-container persistence state.
	 *
	 * Writes for one crate are serialized and intermediate versions are
	 * coalesced. Different crates can still persist concurrently.
	 */
	private readonly pendingPersistence = new Map<string, PendingPersistence>();

	/**
	 * @param seedAsInt Terrain seed folded the same way as chunk workers,
	 * used to resolve Maya temple loot caches on first open.
	 */
	constructor(
		private readonly storage: ServerWorldStorage,
		private readonly seedAsInt: number = 0,
	) {}

	/**
	 * Load-through open: memory first, then an in-flight open, then durable
	 * storage. The returned object is live server state.
	 */
	open(x: number, y: number, z: number): Promise<ServerContainer> {
		const key = containerKey(x, y, z);
		const live = this.containers.get(key);

		if (live !== undefined) {
			return Promise.resolve(live);
		}

		const pending = this.pendingOpens.get(key);

		if (pending !== undefined) {
			return pending;
		}

		const opening = this.loadContainer(key, x, y, z);
		this.pendingOpens.set(key, opening);

		const removePending = (): void => {
			if (this.pendingOpens.get(key) === opening) {
				this.pendingOpens.delete(key);
			}
		};

		void opening.then(removePending, removePending);

		return opening;
	}

	private async loadContainer(
		key: string,
		x: number,
		y: number,
		z: number,
	): Promise<ServerContainer> {
		/*
		 * Recheck in case another path installed live state before this
		 * asynchronous operation started.
		 */
		const existing = this.containers.get(key);

		if (existing !== undefined) {
			return existing;
		}

		let restored: PersistedContainer | null = null;

		try {
			restored = await this.storage.loadContainer(x, y, z);
		} catch (error: unknown) {
			console.error(`[ContainerStore] load failed for ${key}:`, error);
		}

		/*
		 * A crate may have been installed while storage was being read.
		 * Prefer the current authoritative in-memory object.
		 */
		const installedDuringLoad = this.containers.get(key);

		if (installedDuringLoad !== undefined) {
			return installedDuringLoad;
		}

		const container: ServerContainer = {
			x,
			y,
			z,
			version: restored?.version ?? 0,
			width: CONTAINER_WIDTH,
			height: CONTAINER_HEIGHT,
			slots: restoreSlots(restored),
		};

		if (restored === null && this.seedAsInt !== 0) {
			this.seedTempleCache(container);
		}

		this.containers.set(key, container);
		return container;
	}

	/**
	 * Populate a first-open crate when its coordinates identify a generated
	 * Maya temple cache.
	 */
	private seedTempleCache(container: ServerContainer): void {
		const { x, y, z } = container;
		const cache = findTempleCacheAt(x, y, z, this.seedAsInt);

		if (cache === undefined || cache === null) {
			return;
		}

		const rolled = rollTempleCrate(
			cache.templeId,
			this.seedAsInt,
			cache.tier,
			x,
			y,
			z,
		);

		const slots = container.slots;
		const rolledRows = rolled.slots;

		for (let row = 0; row < CONTAINER_HEIGHT; row++) {
			const rolledRow = rolledRows[row];

			if (rolledRow === undefined) {
				continue;
			}

			const rowOffset = row * CONTAINER_WIDTH;

			for (let col = 0; col < CONTAINER_WIDTH; col++) {
				const item = rolledRow[col];

				if (item === undefined || item === null) {
					continue;
				}

				slots[rowOffset + col] = normalizeSlot(item.itemId, item.stackSize);
			}
		}

		container.version = (container.version + 1) >>> 0;
		this.persist(container);
	}

	get(x: number, y: number, z: number): ServerContainer | undefined {
		return this.containers.get(containerKey(x, y, z));
	}

	/**
	 * Apply one validated slot write.
	 */
	setSlot(
		x: number,
		y: number,
		z: number,
		row: number,
		col: number,
		itemId: number,
		stackSize: number,
	): ServerContainer | null {
		const container = this.containers.get(containerKey(x, y, z));

		if (container === undefined) {
			return null;
		}

		if (
			!Number.isInteger(row) ||
			!Number.isInteger(col) ||
			row < 0 ||
			row >= container.height ||
			col < 0 ||
			col >= container.width
		) {
			return null;
		}

		const slotIndex = row * container.width + col;
		const normalized = normalizeSlot(itemId, stackSize);
		const current = container.slots[slotIndex];

		/*
		 * A repeated last-write-wins update that does not change state does not
		 * need a version bump, snapshot allocation, or storage write.
		 */
		if (
			current.itemId === normalized.itemId &&
			current.stackSize === normalized.stackSize
		) {
			return container;
		}

		container.slots[slotIndex] = normalized;
		container.version = (container.version + 1) >>> 0;

		this.persist(container);
		return container;
	}

	/**
	 * Remove a crate and return its non-empty contents for break-scatter.
	 */
	takeAll(x: number, y: number, z: number): ContainerSlot[] {
		const key = containerKey(x, y, z);
		const container = this.containers.get(key);

		this.containers.delete(key);
		this.pendingOpens.delete(key);

		/*
		 * Remove pending save ownership before deleting. An already-running
		 * storage operation cannot be cancelled, but the deletion is queued
		 * after that operation by awaitPendingPersistence().
		 */
		const deletion = this.deleteAfterPendingWrites(key, x, y, z);

		void deletion.catch((error: unknown) => {
			console.error(`[ContainerStore] delete failed for ${key}:`, error);
		});

		if (container === undefined) {
			return [];
		}

		const slots = container.slots;

		let nonEmptyCount = 0;

		for (let i = 0; i < slots.length; i++) {
			const slot = slots[i];

			if (slot.itemId !== 0 && slot.stackSize > 0) {
				nonEmptyCount++;
			}
		}

		if (nonEmptyCount === 0) {
			return [];
		}

		const contents = new Array<ContainerSlot>(nonEmptyCount);
		let outputIndex = 0;

		for (let i = 0; i < slots.length; i++) {
			const slot = slots[i];

			if (slot.itemId === 0 || slot.stackSize <= 0) {
				continue;
			}

			/*
			 * Return detached slot values so the caller cannot retain mutable
			 * references into the removed container.
			 */
			contents[outputIndex++] = {
				itemId: slot.itemId,
				stackSize: slot.stackSize,
			};
		}

		return contents;
	}

	private async deleteAfterPendingWrites(
		key: string,
		x: number,
		y: number,
		z: number,
	): Promise<void> {
		const state = this.pendingPersistence.get(key);

		/*
		 * The state remains in the map while its writer loop is active.
		 * Yield until the current persistence sequence finishes.
		 */
		while (state?.running) {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 0);
			});
		}

		this.pendingPersistence.delete(key);
		await this.storage.deleteContainer(x, y, z);
	}

	/** Drop in-memory state without touching durable storage. */
	clear(): void {
		this.containers.clear();
		this.pendingOpens.clear();
	}

	/**
	 * Schedule persistence for the newest container version.
	 *
	 * At most one writer loop runs per container. Multiple rapid edits are
	 * coalesced so storage receives the newest available snapshot rather than
	 * one concurrent write for every edit.
	 */
	private persist(container: ServerContainer): void {
		const key = containerKey(container.x, container.y, container.z);

		let state = this.pendingPersistence.get(key);

		if (state === undefined) {
			state = {
				container,
				requestedVersion: container.version,
				persistedVersion: -1,
				running: false,
			};

			this.pendingPersistence.set(key, state);
		} else {
			state.container = container;
			state.requestedVersion = container.version;
		}

		if (state.running) {
			return;
		}

		state.running = true;
		void this.runPersistenceLoop(key, state);
	}

	private async runPersistenceLoop(
		key: string,
		state: PendingPersistence,
	): Promise<void> {
		try {
			while (state.persistedVersion !== state.requestedVersion) {
				const container = state.container;
				const snapshot = snapshotContainer(container);
				const snapshotVersion = snapshot.version;

				try {
					await this.storage.saveContainer(
						container.x,
						container.y,
						container.z,
						snapshot,
					);

					state.persistedVersion = snapshotVersion;
				} catch (error: unknown) {
					console.error(`[ContainerStore] save failed for ${key}:`, error);

					/*
					 * Preserve fire-and-forget behavior. A later edit starts a
					 * new persistence attempt instead of spinning on failure.
					 */
					return;
				}
			}
		} finally {
			state.running = false;

			if (
				state.persistedVersion === state.requestedVersion &&
				this.pendingPersistence.get(key) === state
			) {
				this.pendingPersistence.delete(key);
			} else if (this.pendingPersistence.get(key) === state) {
				/*
				 * An edit may have arrived between the loop condition and the
				 * running flag update.
				 */
				state.running = true;
				void this.runPersistenceLoop(key, state);
			}
		}
	}
}
