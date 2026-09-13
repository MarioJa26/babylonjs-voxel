/**
 * ContainerSimulation — server-authoritative Wood Crate inventories.
 *
 * Each crate at a block position owns a fixed 3x6 slot grid (matching the
 * client's BlockInventoryManager defaults). The server is the source of
 * truth: clients render from ContainerState snapshots and push every edit
 * as a ContainerSetSlot delta (last-write-wins per slot). Contents persist
 * across restarts via ServerWorldStorage meta keys (`crate:x,y,z`).
 *
 * Babylon-free: pure data + persistence, driven by VoxelRoom handlers.
 */

import type {
	PersistedContainer,
	ServerWorldStorage,
} from "./ServerWorldStorage.ts";

export const CONTAINER_WIDTH = 3;
export const CONTAINER_HEIGHT = 6;
/** Mirrors the VoxelRoom item-drop caps (itemId u16, stack u16 range). */
export const MAX_CONTAINER_ITEM_ID = 65535;
export const MAX_CONTAINER_STACK = 1024;

export interface ContainerSlot {
	itemId: number;
	/** 0-sized stacks are normalized to itemId 0 (empty). */
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

export function containerKey(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

function emptySlots(): ContainerSlot[] {
	const count = CONTAINER_WIDTH * CONTAINER_HEIGHT;
	const slots = new Array<ContainerSlot>(count);
	for (let i = 0; i < count; i++) slots[i] = { itemId: 0, stackSize: 0 };
	return slots;
}

function normalizeSlot(itemId: number, stackSize: number): ContainerSlot {
	if (
		!Number.isInteger(itemId) ||
		itemId < 0 ||
		itemId > MAX_CONTAINER_ITEM_ID ||
		!Number.isInteger(stackSize) ||
		stackSize < 0 ||
		stackSize > MAX_CONTAINER_STACK ||
		itemId === 0 ||
		stackSize === 0
	) {
		return { itemId: 0, stackSize: 0 };
	}
	return { itemId, stackSize };
}

export class ServerContainerStore {
	private readonly containers = new Map<string, ServerContainer>();

	constructor(private readonly storage: ServerWorldStorage) {}

	/**
	 * Load-through open: memory first, then durable storage, else a fresh
	 * empty crate. The returned object is live server state — callers must
	 * not retain it beyond synchronous snapshot/encode.
	 */
	async open(x: number, y: number, z: number): Promise<ServerContainer> {
		const key = containerKey(x, y, z);
		const live = this.containers.get(key);
		if (live) return live;

		let restored: PersistedContainer | null = null;
		try {
			restored = await this.storage.loadContainer(x, y, z);
		} catch (error) {
			console.error(`[ContainerStore] load failed for ${key}:`, error);
		}

		const container: ServerContainer = {
			x,
			y,
			z,
			version: restored?.version ?? 0,
			width: CONTAINER_WIDTH,
			height: CONTAINER_HEIGHT,
			slots:
				restored && restored.slots.length === CONTAINER_WIDTH * CONTAINER_HEIGHT
					? restored.slots.map((s) => normalizeSlot(s.itemId, s.stackSize))
					: emptySlots(),
		};
		this.containers.set(key, container);
		return container;
	}

	get(x: number, y: number, z: number): ServerContainer | undefined {
		return this.containers.get(containerKey(x, y, z));
	}

	/**
	 * Apply one validated slot write. Returns the container (with the bumped
	 * version) or null when the crate is unknown or the cell is out of
	 * bounds. Persists fire-and-forget — crate edits are human-rate and the
	 * in-memory state stays authoritative even if a write fails.
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
		if (!container) return null;
		if (
			!Number.isInteger(row) ||
			!Number.isInteger(col) ||
			row < 0 ||
			col < 0 ||
			row >= container.height ||
			col >= container.width
		) {
			return null;
		}

		container.slots[row * container.width + col] = normalizeSlot(
			itemId,
			stackSize,
		);
		container.version = (container.version + 1) >>> 0;
		this.persist(container);
		return container;
	}

	/**
	 * Remove a crate and return its non-empty contents (for break-scatter).
	 * Drops the durable record too; a missing crate yields an empty array.
	 */
	takeAll(x: number, y: number, z: number): ContainerSlot[] {
		const key = containerKey(x, y, z);
		const container = this.containers.get(key);
		this.containers.delete(key);
		void this.storage.deleteContainer(x, y, z).catch((error) => {
			console.error(`[ContainerStore] delete failed for ${key}:`, error);
		});
		if (!container) return [];
		return container.slots.filter((s) => s.itemId !== 0 && s.stackSize > 0);
	}

	/** Drop in-memory state without touching storage (room teardown). */
	clear(): void {
		this.containers.clear();
	}

	private persist(container: ServerContainer): void {
		const snapshot: PersistedContainer = {
			version: container.version,
			width: container.width,
			height: container.height,
			slots: container.slots.map((s) => ({
				itemId: s.itemId,
				stackSize: s.stackSize,
			})),
		};
		void this.storage
			.saveContainer(container.x, container.y, container.z, snapshot)
			.catch((error) => {
				console.error(
					`[ContainerStore] save failed for ${containerKey(container.x, container.y, container.z)}:`,
					error,
				);
			});
	}
}
