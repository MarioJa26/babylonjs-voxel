import { onSceneDispose, type SceneContext } from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import type {
	RemoteStationManager,
	RemoteStationSlotUpdate,
	RemoteStationState,
} from "@/code/Network/RemoteStationManager";
import { Item } from "@/code/Player/Inventory/Item";
import { ItemSlot } from "@/code/Player/Inventory/ItemSlot";
import type { Player } from "@/code/Player/Player";
import { getBlockByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	getStationState,
	saveStationState,
	stationKindForBlock,
} from "./StationManager";
import {
	setStationChangeHandler,
	setWhetstoneRepairHandler,
} from "./StationRuntime";
import {
	canProcess,
	findStationRecipe,
	type ItemStack,
	isFuel,
	STATION_KINDS,
	type StationKind,
	type StationState,
	stationProgress,
} from "./StationTypes";

/**
 * The station panel: input / fuel / result slots, a progress bar and a status
 * line.
 *
 * Extracted from `PlayerHud` rather than added to it â€” PlayerHud is already ~2000
 * lines of hand-rolled DOM, and this panel needs a non-trivial teardown (Escape
 * handling, borrowed-slot DOM restoration, pointer-lock juggling, a per-frame
 * reach check) so it earns its own file.
 *
 * Singleplayer only in Phase 3a: `StationManager` is the source of truth and this
 * panel reads and writes it directly. Phase 3b routes the same operations through
 * the network instead.
 */

const STATION_TITLES: Readonly<Record<StationKind, string>> = {
	kiln: "Kiln",
	furnace: "Furnace",
	whetstone: "Whetstone",
	crucible: "Crucible",
	anvil: "Anvil",
	smeltery: "Smeltery",
};

const CELL_LABELS = ["Input", "Fuel", "Result"] as const;

/** Distance at which the panel closes. Block reach elsewhere is 64. */
const CLOSE_RANGE = 64;
const CLOSE_RANGE_SQ = CLOSE_RANGE * CLOSE_RANGE;

/** A repair station holds a tool and produces nothing. */
export function isRepairStation(kind: StationKind): boolean {
	return findStationRecipe(kind, 0)?.resultId === 0;
}

/** Build an Item from a persisted stack, or null if the id no longer exists. */
export function makeStationItem(stack: ItemStack | null): Item | null {
	if (stack === null) return null;
	try {
		const item = Item.createById(stack.itemId, -1, -1);
		item.stackSize = stack.stackSize;
		return item;
	} catch {
		return null;
	}
}

/** One-line status for the panel. */
export function describeStation(state: StationState): string {
	if (state.output !== null) return "Ready â€” take the result";

	const recipe = findStationRecipe(state.kind, state.input?.itemId ?? 0);

	if (recipe === undefined) {
		if (state.input !== null) return "This station cannot use that";
		if (state.kind === "kiln") return "Put wood or coal in the fuel slot";
		if (state.kind === "whetstone") return "Put a worn tool on the stone";
		return "Nothing to work on";
	}

	if (
		recipe.usesFuel &&
		recipe.fuelIsMaterial !== true &&
		state.burnRemaining <= 0
	) {
		return state.fuel === null ? "Needs fuel" : "Not lit";
	}

	return isRepairStation(state.kind) ? "Repairingâ€¦" : "Workingâ€¦";
}

/** Wire stack -> internal stack, mapping "empty" onto null. */
function stackOrNull(stack: {
	itemId: number;
	stackSize: number;
}): ItemStack | null {
	if (stack.itemId === 0 || stack.stackSize === 0) return null;
	return { itemId: stack.itemId, stackSize: stack.stackSize };
}

/** Numeric StationKind back to its name. */
function stationKindFromId(id: number): StationKind | undefined {
	return STATION_KINDS[id];
}

/**
 * Progress fraction for a raw tick count received from the server.
 *
 * Deliberately not `stationProgress`, which resolves the recipe from local
 * state â€” in multiplayer the local state is not authoritative, so the recipe is
 * looked up by kind and the input the client last saw.
 */
function progressFraction(
	smeltProgress: number,
	kind: StationKind | undefined,
): number {
	if (kind === undefined) return 0;
	const recipe = findStationRecipe(kind, 0);
	if (recipe === undefined || recipe.smeltTicks <= 0) return 0;
	const frac = smeltProgress / recipe.smeltTicks;
	return frac > 1 ? 1 : frac < 0 ? 0 : frac;
}

/**
 * Which station a slot references, in whichever mode is active.
 *
 * In multiplayer the server is authoritative: the client never ticks the smelt
 * and never invents progress, it only pushes slot writes and renders whatever
 * snapshot arrives. In singleplayer `StationRuntime` and `StationManager` own
 * it locally.
 */
function isRemote(): boolean {
	return Map1.mainPlayer?.networkManager?.isConnected === true;
}

export class StationUi {
	#scene: SceneContext;
	#player: Player;

	#open = false;
	#div: HTMLDivElement | null = null;
	#pos: { x: number; y: number; z: number } | null = null;
	#kind: StationKind = "furnace";

	#inputItem: Item | null = null;
	#fuelItem: Item | null = null;
	#outputItem: Item | null = null;

	#slots: ItemSlot[] = [];
	/** Set while `#syncSlots` assigns, to stop `onChanged` echoing a write back. */
	#syncing = false;
	#keyHandler: ((e: KeyboardEvent) => void) | null = null;
	#progressFill: HTMLDivElement | null = null;
	#statusLabel: HTMLSpanElement | null = null;
	#title: HTMLDivElement | null = null;

	constructor(scene: SceneContext, player: Player) {
		this.#scene = scene;
		this.#player = player;
	}

	public get isOpen(): boolean {
		return this.#open;
	}

	public show(x: number, y: number, z: number): void {
		if (this.#open) {
			this.hide();
			return;
		}

		const kind = stationKindForBlock(getBlockByWorldCoords(x, y, z) ?? 0);
		if (kind === undefined) return;

		this.#open = true;
		this.#pos = { x, y, z };
		this.#kind = kind;

		if (isRemote()) {
			// Multiplayer: the server owns the state. Subscribe first so the
			// snapshot that resolves the open is not dropped on the floor, then
			// render from that snapshot rather than local state.
			this.#subscribeRemote(x, y, z);
			this.#inputItem = null;
			this.#fuelItem = null;
			this.#outputItem = null;
		} else {
			this.#reload();
		}

		if (this.#div === null) this.#div = this.#build();

		this.#div.style.display = "flex";
		this.#div.dataset.stationKind = kind;
		if (this.#title !== null) this.#title.textContent = STATION_TITLES[kind];

		this.#applySlotConstraints(kind);
		this.#syncSlots();

		// Capture phase: stop Tab/Escape reaching the InventoryControls instance
		// that is live while this panel is open, which would otherwise swap the
		// control scheme out from under it and leave the player stuck.
		this.#keyHandler = (e: KeyboardEvent): void => {
			if (!this.#open) return;
			if (e.key !== "Escape" && e.key !== "Tab") return;
			e.preventDefault();
			e.stopPropagation();
			if (e.type === "keydown") this.hide();
		};
		window.addEventListener("keydown", this.#keyHandler, true);
		window.addEventListener("keyup", this.#keyHandler, true);

		setStationChangeHandler(this.#onRuntimeChanged);
		setWhetstoneRepairHandler(this.#onRepairCompleted);
		this.#refresh();
	}

	#onRuntimeChanged = (): void => {
		if (this.#open) this.#refresh();
	};

	// â”€â”€â”€ Multiplayer plumbing â”€â”€â”€

	#remoteManager(): RemoteStationManager | null {
		return Map1.mainPlayer?.networkManager?.stations ?? null;
	}

	#subscribeRemote(x: number, y: number, z: number): void {
		const remote = this.#remoteManager();
		if (remote === null) return;

		remote.setCallbacks({
			onState: (state) => {
				if (!this.#open || this.#pos === null) return;
				if (
					state.x !== this.#pos.x ||
					state.y !== this.#pos.y ||
					state.z !== this.#pos.z
				) {
					return;
				}
				this.#applyRemoteState(state);
			},
			onSlotUpdate: (update) => {
				if (!this.#open || this.#pos === null) return;
				if (
					update.x !== this.#pos.x ||
					update.y !== this.#pos.y ||
					update.z !== this.#pos.z
				) {
					return;
				}
				this.#applyRemoteUpdate(update);
			},
			onRejected: () => {
				// The server refused the open or a write: close rather than show a
				// panel the player cannot use.
				this.hide();
			},
			onResultClaimed: (claimed) => {
				if (!this.#open || this.#pos === null) return;
				if (
					claimed.x !== this.#pos.x ||
					claimed.y !== this.#pos.y ||
					claimed.z !== this.#pos.z
				) {
					return;
				}
				// The server already cleared its copy and confirmed this client won
				// the stack, so it is ours to bank. The result slot itself is left
				// to the following state broadcast.
				const item = makeStationItem({
					itemId: claimed.itemId,
					stackSize: claimed.stackSize,
				});
				if (item !== null) this.#player.playerInventory.addItem(item);
			},
		});

		remote.open(x, y, z).catch(() => this.hide());
	}

	#applyRemoteState(state: RemoteStationState): void {
		this.#kind = stationKindFromId(state.kind) ?? this.#kind;
		this.#inputItem = makeStationItem(stackOrNull(state.input));
		this.#fuelItem = makeStationItem(stackOrNull(state.fuel));
		this.#outputItem = makeStationItem(stackOrNull(state.output));
		this.#syncSlots();
		this.#refreshBar(state.smeltProgress, state.lit, state.kind);
	}

	#applyRemoteUpdate(update: RemoteStationSlotUpdate): void {
		// slot -1 means only the counters moved, which is the common case while
		// smelting, so do not rebuild items for it.
		if (update.slot === 0) {
			this.#inputItem = makeStationItem(
				update.itemId === 0
					? null
					: { itemId: update.itemId, stackSize: update.stackSize },
			);
		} else if (update.slot === 1) {
			this.#fuelItem = makeStationItem(
				update.itemId === 0
					? null
					: { itemId: update.itemId, stackSize: update.stackSize },
			);
		} else if (update.slot === 2) {
			this.#outputItem = makeStationItem(
				update.itemId === 0
					? null
					: { itemId: update.itemId, stackSize: update.stackSize },
			);
		}

		this.#syncSlots();
		this.#refreshBar(update.smeltProgress, update.lit, this.#remoteKindId());
	}

	#remoteKindId(): number {
		return Math.max(0, STATION_KINDS.indexOf(this.#kind));
	}

	/**
	 * Redraw the bar and status from a server snapshot.
	 *
	 * Takes the raw numeric kind off the wire and resolves it through
	 * `STATION_KINDS`, so an unknown id from a newer server degrades to "no
	 * progress" instead of throwing.
	 */
	#refreshBar(progress: number, lit: boolean, kindId: number): void {
		const kind = STATION_KINDS[kindId];

		const fill = this.#progressFill;
		if (fill !== null) {
			fill.style.width = `${(progressFraction(progress, kind) * 100).toFixed(1)}%`;
		}
		if (kind === undefined) return;

		const status = this.#statusLabel;
		if (status !== null) {
			status.textContent = describeStation({
				kind,
				capTier: 0,
				input: this.#stackOf(this.#inputItem),
				fuel: this.#stackOf(this.#fuelItem),
				output: this.#stackOf(this.#outputItem),
				smeltProgress: progress,
				burnRemaining: lit ? 1 : 0,
			});
		}
	}

	#onRepairCompleted = (): void => {
		if (this.#open) this.applyPendingRepair();
	};

	public hide(): void {
		if (!this.#open) return;
		this.#open = false;
		this.#pos = null;
		setStationChangeHandler(null);
		setWhetstoneRepairHandler(null);

		// Detach the network callbacks so a stale snapshot cannot write into a
		// panel the player has already closed.
		this.#remoteManager()?.setCallbacks({});

		if (this.#div !== null) this.#div.style.display = "none";

		const handler = this.#keyHandler;
		if (handler !== null) {
			window.removeEventListener("keydown", handler, true);
			window.removeEventListener("keyup", handler, true);
			this.#keyHandler = null;
		}
	}

	public dispose(): void {
		this.hide();
		this.#div?.remove();
		this.#div = null;
		this.#slots.length = 0;
	}

	/**
	 * Close when the player walks out of range. Singleplayer has no server-side
	 * reach check â€” multiplayer rejects per message instead â€” so without this the
	 * panel would follow the player around the world.
	 */
	public update(): void {
		if (!this.#open || this.#pos === null) return;

		const p = this.#player.position;
		const dx = p.x - (this.#pos.x + 0.5);
		const dy = p.y - (this.#pos.y + 0.5);
		const dz = p.z - (this.#pos.z + 0.5);
		if (dx * dx + dy * dy + dz * dz <= CLOSE_RANGE_SQ) return;

		this.hide();
	}

	/**
	 * Apply the whetstone's durability write. Called when the runtime reports a
	 * completed repair, because that is the one craft whose effect is a mutation
	 * on an Item rather than a new item appearing in a slot.
	 */
	public applyPendingRepair(): void {
		if (this.#kind !== "whetstone") return;
		// The server owns durability in multiplayer; a client-side write would be
		// overwritten by the next snapshot.
		if (isRemote()) return;

		const item = this.#inputItem;
		if (item === null || !item.isDurable) return;

		const amount =
			findStationRecipe("whetstone", item.itemId)?.repairAmount ?? 0;
		if (amount <= 0) return;

		item.repairDurability(amount);
		// Repair in place; the player picks the tool back up themselves. Auto-
		// returning it would be a surprise and would fight the durability preview.
		this.#commit();
		this.#refresh();
	}

	// â”€â”€â”€ State bridge â”€â”€â”€

	#reload(): void {
		const pos = this.#pos;
		if (pos === null) return;

		const state = getStationState(pos.x, pos.y, pos.z, this.#kind);
		this.#inputItem = makeStationItem(state.input);
		this.#fuelItem = makeStationItem(state.fuel);
		this.#outputItem = makeStationItem(state.output);
	}

	#commit(): void {
		const pos = this.#pos;
		if (pos === null) return;

		// In multiplayer the server owns the state; writing locally would fight
		// the next snapshot and could resurrect a rejected item.
		if (isRemote()) return;

		const state = getStationState(pos.x, pos.y, pos.z, this.#kind);
		state.input = this.#stackOf(this.#inputItem);
		state.fuel = this.#stackOf(this.#fuelItem);
		state.output = this.#stackOf(this.#outputItem);
		saveStationState(pos.x, pos.y, pos.z, state);
	}

	#stackOf(item: Item | null): ItemStack | null {
		if (item === null) return null;
		return { itemId: item.itemId, stackSize: item.stackSize };
	}

	/**
	 * Pull the runtime's view and redraw. Only rebuilds the live items when an id
	 * or count actually moved, so an idle station does not churn DOM every frame.
	 */
	#refresh(): void {
		const pos = this.#pos;
		if (pos === null) return;

		const state = getStationState(pos.x, pos.y, pos.z, this.#kind);

		const fill = this.#progressFill;
		if (fill !== null) {
			fill.style.width = `${(stationProgress(state) * 100).toFixed(1)}%`;
		}

		const status = this.#statusLabel;
		if (status !== null) status.textContent = describeStation(state);

		const inputId = state.input?.itemId ?? 0;
		const inputSize = state.input?.stackSize ?? 0;
		const outputId = state.output?.itemId ?? 0;
		const outputSize = state.output?.stackSize ?? 0;

		if (
			(this.#inputItem?.itemId ?? 0) !== inputId ||
			(this.#inputItem?.stackSize ?? 0) !== inputSize ||
			(this.#outputItem?.itemId ?? 0) !== outputId ||
			(this.#outputItem?.stackSize ?? 0) !== outputSize
		) {
			this.#reload();
			this.#syncSlots();
		}
	}

	#syncSlots(): void {
		if (this.#slots.length < 3) return;
		this.#syncing = true;
		try {
			this.#slots[0]!.item = this.#inputItem;
			this.#slots[1]!.item = this.#fuelItem;
			this.#slots[2]!.item = this.#outputItem;
		} finally {
			this.#syncing = false;
		}
	}

	/**
	 * Adopt whatever a slot now holds after a drag, then push it out.
	 *
	 * `ItemSlot` has no reference back to this panel, so a drag into a slot would
	 * otherwise change the icon and nothing else — the smelt would never see the
	 * item. `onChanged` fires on every mutation (swap, clear, in-place merge),
	 * which makes it the one hook that covers all of them.
	 */
	#adoptSlot(index: number): void {
		// `#syncSlots` assigns `slot.item`, which fires `onChanged` in turn. Without
		// this guard a snapshot arriving from the server would be echoed straight
		// back as a write — wasteful, and it would churn the station's version
		// counter every frame.
		if (this.#syncing) return;

		const slot = this.#slots[index];
		if (slot === undefined) return;

		const item = slot.item;
		if (index === 0) this.#inputItem = item;
		else if (index === 1) this.#fuelItem = item;
		else if (index === 2) this.#outputItem = item;

		this.#commit();
		this.#pushRemoteSlots();
	}

	/** Push input and fuel to the server. Singleplayer state is already saved. */
	#pushRemoteSlots(): void {
		if (!isRemote()) return;

		const pos = this.#pos;
		const remote = this.#remoteManager();
		if (pos === null || remote === null) return;

		remote.sendSetSlot(
			pos.x,
			pos.y,
			pos.z,
			0,
			this.#inputItem?.itemId ?? 0,
			this.#inputItem?.stackSize ?? 0,
		);
		remote.sendSetSlot(
			pos.x,
			pos.y,
			pos.z,
			1,
			this.#fuelItem?.itemId ?? 0,
			this.#fuelItem?.stackSize ?? 0,
		);
	}

	/**
	 * Withdraw a slot's contents into the player's inventory.
	 *
	 * Click rather than drag, because the result slot is read-only for writing
	 * and needs some way out. Refuses when the inventory has no room rather than
	 * silently deleting the stack — `addItem` returns the leftover count, which is
	 * exactly the signal needed.
	 */
	#withdrawSlot(index: number): boolean {
		const slot = this.#slots[index];
		const item = slot?.item ?? null;
		if (item === null) return false;

		// In multiplayer the result belongs to the server. Ask for it and wait for
		// StationResultClaimed: adding it here instead would let a modified client
		// mint ingots by clicking, and would show the stack even when another player
		// claimed it first. The state broadcast that follows empties the slot.
		const pos = this.#pos;
		const remote = this.#remoteManager();
		if (index === 2 && remote !== null && pos !== null) {
			remote.sendClaimResult(pos.x, pos.y, pos.z);
			return true;
		}

		const inventory = this.#player.playerInventory;
		const wanted = item.stackSize;
		const leftover = inventory.addItem(item);

		if (leftover >= wanted) {
			// Nowhere to put it. Leave the slot exactly as it was.
			return false;
		}

		// Partial acceptance: keep the remainder behind in the slot.
		if (leftover > 0) {
			item.stackSize = leftover;
			slot!.item = item;
		} else {
			slot!.item = null;
		}

		if (index === 0) this.#inputItem = slot!.item;
		else if (index === 1) this.#fuelItem = slot!.item;
		else if (index === 2) this.#outputItem = slot!.item;

		this.#commit();
		this.#pushRemoteSlots();
		return true;
	}

	/**
	 * Restrict what each slot accepts.
	 *   - input: anything this station can process; a whetstone takes only items
	 *     that actually have durability left to restore.
	 *   - fuel: fuel only.
	 *   - result: read-only, so it always refuses.
	 */
	#applySlotConstraints(kind: StationKind): void {
		const input = this.#slots[0];
		const fuel = this.#slots[1];
		const output = this.#slots[2];
		if (input === undefined || fuel === undefined || output === undefined)
			return;

		const repair = isRepairStation(kind);
		const fuelIsMaterial = findStationRecipe(kind, 0)?.fuelIsMaterial === true;

		input.acceptsItem = (item: Item | null): boolean => {
			if (item === null) return true;
			if (repair) return item.isDurable && item.durability < item.maxDurability;
			return canProcess(kind, item.itemId);
		};

		fuel.acceptsItem = (item: Item | null): boolean => {
			if (item === null) return true;
			return fuelIsMaterial || isFuel(item.itemId);
		};

		output.acceptsItem = (): boolean => false;
	}

	// â”€â”€â”€ DOM â”€â”€â”€

	#build(): HTMLDivElement {
		const overlay = document.createElement("div");
		overlay.className = "station-overlay";
		overlay.style.display = "none";

		const panel = document.createElement("div");
		panel.className = "station-panel";

		const title = document.createElement("div");
		title.className = "station-title";
		this.#title = title;

		const grid = document.createElement("div");
		grid.className = "station-slots";

		for (let i = 0; i < 3; i++) {
			const cell = document.createElement("div");
			cell.className = "station-cell";

			const caption = document.createElement("span");
			caption.className = "station-cell-label";
			caption.textContent = CELL_LABELS[i] ?? "";

			const host = document.createElement("div");
			host.className = "station-slot-host";

			const slot = new ItemSlot(-1 - i, -1);
			slot.isEquipmentSlot = true;
			slot.divItemSlot = host;

			// Fires on every mutation of this slot, which covers drag-in,
			// drag-out, an in-place stack merge and a programmatic clear.
			slot.onChanged = () => this.#adoptSlot(i);

			// Click withdraws. Needed because the result slot is read-only for
			// writing, so a finished smelt would otherwise have no way out.
			host.addEventListener("click", () => this.#withdrawSlot(i));

			this.#slots.push(slot);

			cell.appendChild(caption);
			cell.appendChild(host);

			// The result cell carries the progress bar, so the eye stays in one
			// place while waiting.
			if (i === 2) {
				const bar = document.createElement("div");
				bar.className = "station-progress";

				const fill = document.createElement("div");
				fill.className = "station-progress-fill";
				fill.style.width = "0%";
				this.#progressFill = fill;

				bar.appendChild(fill);
				cell.appendChild(bar);
			}

			grid.appendChild(cell);
		}

		const status = document.createElement("span");
		status.className = "station-status";
		this.#statusLabel = status;

		const close = document.createElement("button");
		close.className = "hud-close-button";
		close.innerHTML = "&times;";
		close.onclick = (): void => this.hide();

		panel.appendChild(title);
		panel.appendChild(grid);
		panel.appendChild(status);
		overlay.appendChild(panel);
		overlay.appendChild(close);
		document.body.appendChild(overlay);

		onSceneDispose(this.#scene, () => {
			overlay.remove();
		});

		return overlay;
	}
}

export { STATION_TITLES };
