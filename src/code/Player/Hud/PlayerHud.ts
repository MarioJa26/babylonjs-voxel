import type { SceneContext } from "@babylonjs/lite";
import { onSceneDispose } from "@babylonjs/lite";
import { getArrowTooltipStats } from "@/code/Entities/Arrow/ArrowTypes";
import {
	closeUi,
	isUiOpen,
	openUi,
	UiFocus,
} from "@/code/Lib/GameRuntimeState";
import { Map1 } from "@/code/Maps/Map1";
import { ContainerRejectReason } from "@/code/Network/protocol/messages";
import type {
	RemoteContainerRejection,
	RemoteContainerSlotUpdate,
	RemoteContainerState,
} from "@/code/Network/RemoteContainerManager";
import { getToolTooltipStats } from "@/code/Player/Inventory/ProceduralTools";
import { loadGameSettings } from "@/code/UI/GameSettings";
import {
	buildBlockInventorySlots,
	createEmptyInventory,
	getBlockInventory,
	type SavedBlockInventory,
	saveBlockInventory,
	serializeBlockSlots,
} from "@/code/World/BlockInventory/BlockInventoryManager";
import { getLightByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import { MaterialFactory } from "@/code/World/Texture/MaterialFactory";
import { TextureDefinitions } from "@/code/World/Texture/TextureDefinitions";
import MapFog from "../../Maps/MapFog";
import { WorldEnvironment } from "../../Maps/WorldEnvironment";
import { MasonRecipes } from "../Crafting/CraftingManager";
import { CraftMenu } from "../Crafting/CraftMenu/CraftMenu";
import { CreativePalette } from "../Inventory/CreativePalette";
import { Item } from "../Inventory/Item";
import type { ItemSlot } from "../Inventory/ItemSlot";
import { PlayerInventory } from "../Inventory/PlayerInventory";
import type { Player } from "../Player";
import { PLAYER_LIGHT_SAMPLE_Y_OFFSET } from "../PlayerModel";
import { Gamemodes } from "../PlayerStats";
import { ArmorPanel } from "./ArmorPanel";
import { Chat } from "./Chat";
import { Crosshair } from "./Crosshair/Crosshair";
import { PlayerPreview } from "./PlayerPreview";

export class PlayerHud {
	#scene: SceneContext;
	readonly #player: Player;

	public readonly crossHair: Crosshair;

	public get player(): Player {
		return this.#player;
	}

	public get chat(): Chat {
		return this.#chat;
	}

	static #inventory: PlayerInventory;
	#inventoryOpen = false;
	#craftMenu: CraftMenu;

	#masonTableOpen = false;
	#masonTableDiv: HTMLDivElement | null = null;
	#selectedSourceBlockId: number | null = null;
	#selectedShape: string | null = null;

	#woodCrateOpen = false;
	#woodCrateDiv: HTMLDivElement | null = null;
	#woodCrateBlockGrid: HTMLElement | null = null;
	#woodCratePlayerGrid: HTMLElement | null = null;
	#woodCrateBlockPos: { x: number; y: number; z: number } | null = null;
	#woodCrateSlots: ItemSlot[][] | null = null;
	#woodCrateSavedState: SavedBlockInventory | null = null;
	// Multiplayer (server-authoritative crate): when true the grid mirrors
	// the server snapshot and every local edit is pushed as a slot delta.
	#woodCrateRemote = false;
	#woodCrateLoading = false;
	#woodCrateVersion = 0;
	#woodCrateApplyingRemote = false;
	#woodCrateLastSent: { itemId: number; stackSize: number }[][] | null = null;
	#woodCrateInventoryObserverId: number | null = null;

	#selectedHotbarSlot = 0;
	#hotbarSlots: HTMLDivElement[] = [];
	static #heldItemNameDiv: HTMLDivElement = document.createElement("div");
	#heldItemNameTimeout?: number;
	// PERF: Cache held item name div width to avoid redundant getBoundingClientRect().
	#heldItemNameDivCachedWidth = 0;
	// PERF: Cache previous stat percentages to skip DOM writes when unchanged.
	#prevHealthPct = -1;
	#prevHungerPct = -1;
	#prevStaminaPct = -1;
	#prevManaPct = -1;

	#overlayDiv: HTMLDivElement;
	#craftingContainer!: HTMLDivElement;
	#mainInventoryContainer!: HTMLDivElement;
	#creativePalette: CreativePalette | null = null;
	#playerPreview = new PlayerPreview(() => {
		// Sample the voxel light at chest height (below the head) so the
		// preview is lit like the spot the player is standing in — and never
		// goes dark when the head clips a ceiling mid-jump.
		const p = this.#player.position;
		return getLightByWorldCoords(p.x, p.y + PLAYER_LIGHT_SAMPLE_Y_OFFSET, p.z);
	});
	#armorPanel = new ArmorPanel();

	static debugPanelDiv: HTMLDivElement;
	static debugPanelVisible = true;
	static #hudHidden = false;
	private static infoRows: {
		[key: string]: {
			container: HTMLDivElement;
			valueNode: Text;
			valueSpan?: HTMLSpanElement;
			keySpan?: HTMLSpanElement;
		};
	} = {};
	private static itemTooltipDiv: HTMLDivElement;

	// Tooltip positioning: one persistent mousemove listener buffers cursor
	// coords, and a single rAF callback applies them via transform. Transform
	// writes never invalidate layout, so hovering items can no longer force
	// the engine's per-frame resize read into a synchronous layout flush.
	// (Previously every mousemove wrote left/top and listeners were swapped
	// per hover — 128 forced layouts in a 4.85s capture.)
	static #tooltipPendingX = 0;
	static #tooltipPendingY = 0;
	static #tooltipRafId: number | null = null;
	static #tooltipVisible = false;

	#healthBarFill!: HTMLDivElement;
	#hungerBarFill!: HTMLDivElement;
	#staminaBarFill!: HTMLDivElement;
	#manaBarFill!: HTMLDivElement;

	// Bow draw progress indicator
	#drawIndicator: HTMLDivElement | null = null;
	#drawFill: HTMLDivElement | null = null;

	readonly #chat: Chat;

	constructor(scene: SceneContext, player: Player) {
		this.#scene = scene;
		this.#player = player;
		PlayerHud.#inventory = player.playerInventory;
		this.#craftMenu = new CraftMenu(player.playerInventory);
		// Apply persisted crosshair visuals (style/size/color/visibility).
		this.crossHair = new Crosshair(loadGameSettings());
		this.#overlayDiv = this.initializeHUD();
		this.createHotbarUI();
		this.createStatsUI();
		this.initializeDebugPanel();
		this.initializeTooltip();
		this.initializeDrawIndicator();

		PlayerHud.#inventory.onInventoryChangedObservable.add(() => {
			if (this.#inventoryOpen) {
				this.#craftMenu.updateCraftingAvailability();
			}
		});

		void this.#craftMenu.build(this.#craftingContainer);

		this.#chat = new Chat(player);
	}

	private initializeHUD(): HTMLDivElement {
		const existingOverlay = document.getElementById("hud-overlay");
		if (existingOverlay) {
			existingOverlay.remove();
		}
		const overlayDiv = document.createElement("div");
		overlayDiv.id = "hud-overlay";
		overlayDiv.style.display = "none";
		overlayDiv.classList.add("hud-overlay");

		const closeButton = document.createElement("button");
		closeButton.innerHTML = "&times;";
		closeButton.classList.add("hud-close-button");
		closeButton.onclick = () => {
			this.toggleInventory();
		};

		const contentWrapper = document.createElement("div");
		contentWrapper.classList.add("hud-content-wrapper");

		const inventoryUI = this.createInventoryUI();

		this.#craftingContainer = document.createElement("div");
		this.#craftingContainer.classList.add("crafting-container");

		const previewColumn = document.createElement("div");
		previewColumn.classList.add("preview-column");
		previewColumn.appendChild(this.#playerPreview.container);
		previewColumn.appendChild(this.#armorPanel.container);
		contentWrapper.appendChild(previewColumn);
		contentWrapper.appendChild(inventoryUI);
		contentWrapper.appendChild(this.#craftingContainer);

		overlayDiv.appendChild(contentWrapper);
		overlayDiv.appendChild(closeButton);
		document.body.appendChild(overlayDiv);

		onSceneDispose(this.#scene, () => {
			this.#playerPreview.dispose();
			this.#armorPanel.dispose();
			this.#creativePalette?.dispose();
			this.#creativePalette = null;
			overlayDiv.remove();
			document.exitPointerLock();
		});

		return overlayDiv;
	}

	private createInventoryUI(): HTMLDivElement {
		const inventoryContainer = document.createElement("div");
		inventoryContainer.classList.add("inventory-container");
		this.#mainInventoryContainer = inventoryContainer;

		const inventory = PlayerHud.#inventory.inventory;
		const fragment = document.createDocumentFragment();

		for (let row = inventory.length - 1; row >= 1; row--) {
			const rowContainer = document.createElement("div");
			rowContainer.classList.add("inventory-row");

			const invRow = inventory[row];

			for (let col = 0, len = invRow.length; col < len; col++) {
				const slot = invRow[col].divItemSlot;
				if (!slot) continue;

				slot.addEventListener("dblclick", () => {
					const item = invRow[col].item;
					if (item) {
						this.#craftMenu.addItemToFirstFreeSearchSlot(item.itemId);
					}
				});

				rowContainer.appendChild(slot);
			}

			fragment.appendChild(rowContainer);
		}

		inventoryContainer.appendChild(fragment);

		// Minecraft-style creative palette below the storage rows: scrollable,
		// lists every registered item, copies on take / destroys on drop.
		const palette = new CreativePalette(PlayerHud.#inventory);
		this.#creativePalette = palette;
		inventoryContainer.appendChild(palette.container);
		void palette.build();
		this.updateCreativePaletteVisibility();

		return inventoryContainer;
	}
	private createHotbarUI(): HTMLDivElement {
		const existingWrapper = document.getElementById("hotbar-wrapper");
		if (existingWrapper) {
			existingWrapper.remove();
		}

		const hotbarWrapper = document.createElement("div");
		hotbarWrapper.id = "hotbar-wrapper";
		hotbarWrapper.classList.add("hotbar-wrapper");

		const nameDiv = PlayerHud.#heldItemNameDiv;
		nameDiv.classList.add("held-item-name");

		const hotbarContainer = document.createElement("div");
		hotbarContainer.classList.add("hotbar-container");

		const hotbarRow = PlayerHud.#inventory.inventory[0];
		const fragment = document.createDocumentFragment();

		this.#hotbarSlots.length = 0;

		for (let col = 0, len = hotbarRow.length; col < len; col++) {
			const slot = hotbarRow[col].divItemSlot;
			if (!slot) continue;

			fragment.appendChild(slot);
			this.#hotbarSlots.push(slot);
		}

		hotbarContainer.appendChild(fragment);

		hotbarWrapper.appendChild(nameDiv);
		hotbarWrapper.appendChild(hotbarContainer);

		this.updateHotbarSelection();

		document.body.appendChild(hotbarWrapper);

		onSceneDispose(this.#scene, () => {
			hotbarWrapper.remove();
		});

		return hotbarContainer;
	}

	private createStatsUI(): void {
		const container = document.createElement("div");
		container.id = "stats-container";

		const createBar = (className: string) => {
			const wrapper = document.createElement("div");
			wrapper.classList.add("stat-bar-wrapper");

			const fill = document.createElement("div");
			fill.classList.add("stat-bar-fill", className);

			wrapper.appendChild(fill);
			container.appendChild(wrapper);
			return fill;
		};

		this.#healthBarFill = createBar("health"); // Red
		this.#hungerBarFill = createBar("hunger"); // Orange
		this.#staminaBarFill = createBar("stamina"); // Green
		this.#manaBarFill = createBar("mana"); // Blue

		document.body.appendChild(container);

		onSceneDispose(this.#scene, () => {
			container.remove();
		});
	}

	/**
	 * Create the bow draw progress indicator — a small bar centered just below
	 * the crosshair. Hidden by default; shown while drawing.
	 */
	private initializeDrawIndicator(): void {
		const indicator = document.createElement("div");
		indicator.classList.add("bow-draw-indicator");
		indicator.id = "bow-draw-indicator";

		const fill = document.createElement("div");
		fill.classList.add("bow-draw-fill");

		indicator.appendChild(fill);
		document.body.appendChild(indicator);

		this.#drawIndicator = indicator;
		this.#drawFill = fill;

		onSceneDispose(this.#scene, () => {
			indicator.remove();
		});
	}

	readonly #drawStartColor = { r: 244, g: 67, b: 54 }; // #4caf50
	readonly #drawEndColor = { r: 76, g: 175, b: 80 }; // #f44336

	#lastDrawProgress = -1;
	#drawIndicatorVisible = false;
	/**
	 * Update the bow draw progress indicator.
	 * @param progress 0 = hidden, 0-1 = fill percentage.
	 */
	public updateDrawProgress(progress: number): void {
		if (!this.#drawIndicator || !this.#drawFill) return;

		if (progress <= 0) {
			if (this.#drawIndicatorVisible) {
				this.#drawIndicator.classList.remove("visible");
				this.#drawIndicatorVisible = false;
			}

			if (this.#lastDrawProgress !== 0) {
				this.#drawFill.style.transform = "scaleX(0)";
				this.#lastDrawProgress = 0;
			}

			return;
		}

		const pct = Math.min(1, progress);

		// Avoid redundant DOM/style updates.
		if (pct === this.#lastDrawProgress) return;

		if (!this.#drawIndicatorVisible) {
			this.#drawIndicator.classList.add("visible");
			this.#drawIndicatorVisible = true;
		}

		this.#lastDrawProgress = pct;

		this.#drawFill.style.transform = `scaleX(${pct})`;

		const { r: r1, g: g1, b: b1 } = this.#drawStartColor;
		const { r: r2, g: g2, b: b2 } = this.#drawEndColor;

		const r = Math.round(r1 + (r2 - r1) * pct);
		const g = Math.round(g1 + (g2 - g1) * pct);
		const b = Math.round(b1 + (b2 - b1) * pct);

		this.#drawFill.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
	}

	private getSlot(column: number, row: number): HTMLDivElement | null {
		return PlayerHud.#inventory.inventory[row][column].divItemSlot;
	}

	public updateCreativePaletteVisibility(): void {
		if (!this.#creativePalette) return;
		const show = this.#player.stats.gamemode === Gamemodes.Creative;
		this.#creativePalette.container.style.display = show ? "" : "none";
	}

	public toggleInventory(): void {
		if (this.#masonTableOpen) {
			this.hideMasonTableUI();
		}
		if (this.#woodCrateOpen) {
			this.hideWoodCrateUI();
		}
		this.#inventoryOpen = !this.#inventoryOpen;
		if (this.#inventoryOpen) {
			// Non-blocking overlay: mark UI focus so the pointer-lock loss below is
			// not mistaken for a pause request. The world keeps ticking.
			openUi(UiFocus.inventory);
			// Authoritatively switch to inventory controls so the state is correct
			// no matter how the inventory was opened (Tab key or UI button). Also
			// cancel any in-progress block breaking from a held mouse button.
			this.#activateInventoryControls();
			this.#craftMenu.updateCraftingAvailability();
			PlayerHud.#heldItemNameDiv.classList.remove("visible");
			this.#overlayDiv.style.display = "flex";
			this.#playerPreview.show();
			this.updateCreativePaletteVisibility();
			this.updateDrawProgress(0);
			this.#player.playerCamera.clearBowZoom();
			this.#exitPointerLock();
		} else {
			closeUi(UiFocus.inventory);
			// Restore walking controls regardless of how the inventory was closed
			// (Tab, Escape, or the close button) so world interactions work again.
			this.#activateWalkingControls();
			this.#overlayDiv.style.display = "none";
			this.#playerPreview.hide();
			this.#craftMenu.closePicker();
			// Only re-grab the mouse if no other overlay is still open.
			if (!isUiOpen()) this.#enterPointerLock();
		}
	}

	/** Switch the active keyboard/mouse scheme to the inventory controls. */
	#activateInventoryControls(): void {
		const walking = this.#player.defaultKeyboardControls;
		// Cancel any in-progress block breaking from a held mouse button.
		walking.stopBlockBreaking();
		const inv = this.#player.playerInventory.inventoryControls;
		inv.underlyingControls = walking;
		this.#player.keyboardControls = inv;
	}

	/** Restore the default walking controls. */
	#activateWalkingControls(): void {
		this.#player.keyboardControls = this.#player.defaultKeyboardControls;
	}

	public showMasonTableUI(): void {
		if (this.#masonTableOpen) return;
		this.#masonTableOpen = true;
		openUi(UiFocus.masonTable);
		this.#selectedSourceBlockId = null;
		this.#selectedShape = null;

		if (!this.#masonTableDiv) {
			this.#masonTableDiv = this.createMasonTableUI();
		}

		this.updateMasonTableAvailability();
		this.#masonTableDiv.style.display = "flex";
		this.#exitPointerLock();
	}

	public hideMasonTableUI(): void {
		if (!this.#masonTableOpen) return;
		this.#masonTableOpen = false;
		closeUi(UiFocus.masonTable);
		if (this.#masonTableDiv) {
			this.#masonTableDiv.style.display = "none";
		}
		// Only re-grab the mouse if no other overlay is still open.
		if (!isUiOpen()) this.#enterPointerLock();
	}

	#enterPointerLock(): void {
		document.querySelector("canvas")?.requestPointerLock();
	}

	#exitPointerLock(): void {
		document.exitPointerLock();
	}

	public get isMasonTableOpen(): boolean {
		return this.#masonTableOpen;
	}

	// ─── Wood Crate ─────────────────────────────────────────────────────────

	#woodCrateKeyHandler?: (e: KeyboardEvent) => void;
	#woodCrateClickHandler?: (e: MouseEvent) => void;

	public showWoodCrateUI(x: number, y: number, z: number): void {
		if (this.#woodCrateOpen) return;
		this.#woodCrateOpen = true;
		this.#woodCrateBlockPos = { x, y, z };
		openUi(UiFocus.woodCrate);

		const net = this.#player.networkManager;
		const remote = net?.isConnected === true ? net : null;
		if (remote) {
			// Server-authoritative: open with an empty grid, then fill it
			// from the ContainerState snapshot. Edits made before the
			// snapshot arrives are not sent (loading gate in pushCrateDiff).
			this.#woodCrateRemote = true;
			this.#woodCrateLoading = true;
			this.#woodCrateVersion = 0;
			const empty = createEmptyInventory(3, 6);
			this.#woodCrateSavedState = empty;
			this.#woodCrateSlots = buildBlockInventorySlots(empty);
			this.#attachCrateSlotListeners();
			this.#woodCrateLastSent = PlayerHud.emptyCrateSnapshot();
		} else {
			// Load saved state and build live slots
			const saved = getBlockInventory(x, y, z);
			this.#woodCrateSavedState = saved;
			this.#woodCrateSlots = buildBlockInventorySlots(saved);
			this.#attachCrateSlotListeners();
		}

		if (!this.#woodCrateDiv) {
			this.#woodCrateDiv = this.createWoodCrateUI();
		} else {
			// Rebuild the block inventory content
			this.#refreshWoodCrateContent();
		}

		if (remote) {
			remote.containers.setCallbacks({
				onState: (state) => this.#onRemoteCrateState(state),
				onSlotUpdate: (update) => this.#applyRemoteCrateCell(update),
				onRejected: (rejection) => this.#onRemoteCrateRejected(rejection),
			});
			void remote.containers.open(x, y, z).then(
				(state) => {
					if (this.#woodCrateOpen && this.#woodCrateLoading) {
						this.#onRemoteCrateState(state);
					}
				},
				() => {
					// Rejection details arrive via onRejected; a timeout or
					// disconnect just closes the loading UI quietly.
					if (this.#woodCrateOpen && this.#woodCrateLoading) {
						this.hideWoodCrateUI();
					}
				},
			);
		}

		// Switch to inventory controls for Q-drop and cross-inventory drag
		this.#activateInventoryControls();
		this.#woodCrateDiv.style.display = "flex";
		this.#exitPointerLock();

		// Capture-phase handler: close woodcrate on Tab/Escape and block the
		// event from reaching the InventoryControls instance that was active
		// while the crate was open. Without this, the old InventoryControls'
		// keyup handler overwrites keyboardControls after toggleInventory
		// opens the player inventory, leaving the player stuck.
		this.#woodCrateKeyHandler = (e: KeyboardEvent) => {
			if (!this.#woodCrateOpen) return;
			if (e.key === "Escape" || e.key === "Tab") {
				e.preventDefault();
				e.stopPropagation();
				if (e.type === "keydown") {
					this.hideWoodCrateUI();
				}
			}
		};
		window.addEventListener("keydown", this.#woodCrateKeyHandler, true);
		window.addEventListener("keyup", this.#woodCrateKeyHandler, true);

		// Shift-click handler for fast transfer between crate and inventory
		this.#woodCrateClickHandler = (e: MouseEvent) => {
			if (!this.#woodCrateOpen) return;
			if (!e.shiftKey) return;
			const slot = PlayerInventory.currentlyHoveredSlot;
			if (!slot?.item) return;
			if (this.#moveItemBetweenCrateAndInventory(slot)) {
				e.preventDefault();
				e.stopPropagation();
			}
		};
		this.#woodCrateDiv.addEventListener(
			"click",
			this.#woodCrateClickHandler,
			true,
		);

		// Catch-all for inventory-system mutations that bypass slot setters:
		// Q-drop (and similar consume paths) edit hovered crate items in
		// place, so no onChanged fires. Every such path ends with
		// onInventoryChangedObservable, where we repair + push the diff.
		this.#woodCrateInventoryObserverId =
			PlayerHud.#inventory.onInventoryChangedObservable.add(() =>
				this.#onInventorySystemChanged(),
			);
	}

	public hideWoodCrateUI(): void {
		if (!this.#woodCrateOpen) return;

		this.#woodCrateOpen = false;

		if (this.#woodCrateRemote) {
			// Server already has every accepted delta; just unsubscribe.
			const net = this.#player.networkManager;
			if (this.#woodCrateBlockPos) {
				const { x, y, z } = this.#woodCrateBlockPos;
				try {
					net?.containers.sendClose(x, y, z);
				} catch {
					// Close is best-effort; the server also cleans up on leave.
				}
			}
			try {
				net?.containers.setCallbacks({});
			} catch {
				// ignore
			}
			this.#woodCrateRemote = false;
			this.#woodCrateLoading = false;
			this.#woodCrateLastSent = null;
		} else if (this.#woodCrateBlockPos && this.#woodCrateSlots) {
			const saved = serializeBlockSlots(this.#woodCrateSlots);
			const { x, y, z } = this.#woodCrateBlockPos;
			saveBlockInventory(x, y, z, saved);
		}

		this.#woodCrateSlots = null;
		this.#woodCrateSavedState = null;
		this.#woodCrateBlockPos = null;

		closeUi(UiFocus.woodCrate);

		if (this.#woodCrateDiv) {
			this.#woodCrateDiv.style.display = "none";
		}

		const main = this.#mainInventoryContainer;
		if (main) {
			const inventory = PlayerHud.#inventory.inventory;
			const rows = main.children;

			for (let row = inventory.length - 1; row >= 1; row--) {
				const rowDiv = rows[inventory.length - 1 - row] as
					| HTMLElement
					| undefined;
				if (!rowDiv) continue;

				const invRow = inventory[row];
				for (let col = 0, len = invRow.length; col < len; col++) {
					rowDiv.appendChild(invRow[col].divItemSlot);
				}
			}
		}

		this.#activateWalkingControls();

		const keyHandler = this.#woodCrateKeyHandler;
		if (keyHandler) {
			window.removeEventListener("keydown", keyHandler, true);
			window.removeEventListener("keyup", keyHandler, true);
			this.#woodCrateKeyHandler = undefined;
		}

		const clickHandler = this.#woodCrateClickHandler;
		const div = this.#woodCrateDiv;
		if (clickHandler && div) {
			div.removeEventListener("click", clickHandler, true);
			this.#woodCrateClickHandler = undefined;
		}

		if (this.#woodCrateInventoryObserverId !== null) {
			PlayerHud.#inventory.onInventoryChangedObservable.remove(
				this.#woodCrateInventoryObserverId,
			);
			this.#woodCrateInventoryObserverId = null;
		}

		if (!isUiOpen()) {
			this.#enterPointerLock();
		}
	}

	public get isWoodCrateOpen(): boolean {
		return this.#woodCrateOpen;
	}

	/**
	 * Catch-all for inventory-system mutations (Q-drop, stack consumes) that
	 * edit crate items in place without touching slot setters. Repairs
	 * depleted/detached crate items, then pushes the diff (remote only —
	 * pushCrateDiff gates on remote/loading itself).
	 */
	#onInventorySystemChanged(): void {
		if (!this.#woodCrateOpen || !this.#woodCrateSlots) return;
		this.#repairCrateSlots();
		this.#pushCrateDiff();
	}

	/**
	 * Q-drop depletes the hovered item in place and its delete path only
	 * knows the player grid, so a fully-dropped crate item is left behind as
	 * a detached 0-stack ghost. Clear those (and re-attach renders that lost
	 * their DOM parent) so the grid — and the next diff — reflect reality.
	 */
	#repairCrateSlots(): void {
		const grid = this.#woodCrateSlots;
		if (!grid) return;
		for (const row of grid) {
			for (const slot of row) {
				const item = slot.item;
				if (!item) continue;
				if (item.stackSize <= 0) {
					slot.clearItemSlots();
				} else if (item.div.parentElement !== slot.divItemSlot) {
					// Content unchanged — re-render only, no server write
					// (the diff against last-sent stays clean).
					slot.item = item;
				}
			}
		}
	}

	// ─── Server-authoritative crate sync ────────────────────────────────

	private static emptyCrateSnapshot(): {
		itemId: number;
		stackSize: number;
	}[][] {
		const rows: { itemId: number; stackSize: number }[][] = [];
		for (let r = 0; r < 6; r++) {
			const row: { itemId: number; stackSize: number }[] = [];
			for (let c = 0; c < 3; c++) row.push({ itemId: 0, stackSize: 0 });
			rows.push(row);
		}
		return rows;
	}

	/** Attach live-delta listeners to the current crate grid. */
	#attachCrateSlotListeners(): void {
		const grid = this.#woodCrateSlots;
		if (!grid) return;
		for (const row of grid) {
			for (const slot of row) {
				slot.onChanged = () => this.#pushCrateDiff();
			}
		}
	}

	/**
	 * Diff the live crate grid against the last-sent snapshot and push every
	 * changed cell to the server. No-op in singleplayer, while loading, or
	 * while applying a remote update (the snapshot is updated alongside).
	 */
	#pushCrateDiff(): void {
		if (
			!this.#woodCrateOpen ||
			!this.#woodCrateRemote ||
			this.#woodCrateLoading ||
			this.#woodCrateApplyingRemote
		) {
			return;
		}
		const net = this.#player.networkManager;
		if (net?.isConnected !== true) return;
		const pos = this.#woodCrateBlockPos;
		const grid = this.#woodCrateSlots;
		const last = this.#woodCrateLastSent;
		if (!pos || !grid || !last) return;
		for (let r = 0; r < grid.length; r++) {
			const gridRow = grid[r];
			const lastRow = last[r];
			if (!gridRow || !lastRow) continue;
			for (let c = 0; c < gridRow.length; c++) {
				const slot = gridRow[c];
				const prev = lastRow[c];
				if (!slot || !prev) continue;
				const item = slot.item;
				const curItemId = item?.itemId ?? 0;
				const curStack = item?.stackSize ?? 0;
				if (prev.itemId === curItemId && prev.stackSize === curStack) {
					continue;
				}
				lastRow[c] = { itemId: curItemId, stackSize: curStack };
				net.containers.sendSetSlot(
					pos.x,
					pos.y,
					pos.z,
					r,
					c,
					curItemId,
					curStack,
				);
			}
		}
	}

	/** Apply a full authoritative snapshot (open response / re-sync). */
	#onRemoteCrateState(state: RemoteContainerState): void {
		if (!this.#woodCrateOpen || !this.#woodCrateRemote) return;
		const pos = this.#woodCrateBlockPos;
		if (!pos || state.x !== pos.x || state.y !== pos.y || state.z !== pos.z) {
			return;
		}
		if (
			!this.#woodCrateLoading &&
			state.version <= this.#woodCrateVersion &&
			this.#woodCrateSlots
		) {
			return;
		}
		if (
			state.width < 1 ||
			state.width > 8 ||
			state.height < 1 ||
			state.height > 8 ||
			state.slots.length !== state.width * state.height
		) {
			return;
		}
		this.#woodCrateVersion = state.version;
		const saved: SavedBlockInventory = {
			width: state.width,
			height: state.height,
			slots: [],
		};
		const last = PlayerHud.emptyCrateSnapshot();
		for (let r = 0; r < state.height; r++) {
			const savedRow: SavedBlockInventory["slots"][number] = [];
			for (let c = 0; c < state.width; c++) {
				const s = state.slots[r * state.width + c];
				if (r < 6 && c < 3)
					last[r][c] = { itemId: s.itemId, stackSize: s.stackSize };
				savedRow.push(
					s.itemId === 0 ? null : { itemId: s.itemId, stackSize: s.stackSize },
				);
			}
			saved.slots.push(savedRow);
		}
		this.#woodCrateSavedState = saved;
		this.#woodCrateSlots = buildBlockInventorySlots(saved);
		this.#attachCrateSlotListeners();
		this.#woodCrateLastSent = last;
		this.#woodCrateLoading = false;
		this.#refreshWoodCrateContent();
	}

	/** Apply one authoritative slot delta from another viewer (or our echo). */
	#applyRemoteCrateCell(update: RemoteContainerSlotUpdate): void {
		if (!this.#woodCrateOpen || !this.#woodCrateRemote) return;
		const pos = this.#woodCrateBlockPos;
		if (
			!pos ||
			update.x !== pos.x ||
			update.y !== pos.y ||
			update.z !== pos.z
		) {
			return;
		}
		if (update.version < this.#woodCrateVersion) return;
		this.#woodCrateVersion = update.version;
		const slot = this.#woodCrateSlots?.[update.row]?.[update.col];
		const lastRow = this.#woodCrateLastSent?.[update.row];
		if (!slot || !lastRow?.[update.col]) return;
		lastRow[update.col] = {
			itemId: update.itemId,
			stackSize: update.stackSize,
		};
		this.#woodCrateApplyingRemote = true;
		try {
			if (update.itemId === 0) {
				slot.clearItemSlots();
			} else {
				try {
					const item = Item.createById(update.itemId, update.row, update.col);
					item.stackSize = update.stackSize;
					slot.item = item;
				} catch {
					// Unknown item id — render empty rather than crashing.
					slot.clearItemSlots();
				}
			}
		} finally {
			this.#woodCrateApplyingRemote = false;
		}
	}

	/** The server refused the open/write (or the crate is gone): close up. */
	#onRemoteCrateRejected(rejection: RemoteContainerRejection): void {
		if (!this.#woodCrateOpen || !this.#woodCrateRemote) return;
		const pos = this.#woodCrateBlockPos;
		if (
			!pos ||
			rejection.x !== pos.x ||
			rejection.y !== pos.y ||
			rejection.z !== pos.z
		) {
			return;
		}
		const net = this.#player.networkManager;
		let detail = "is no longer available";
		if (rejection.reason === ContainerRejectReason.TooFar) {
			detail = "is too far away";
		} else if (rejection.reason === ContainerRejectReason.NotCrate) {
			detail = "is not a crate";
		}
		this.hideWoodCrateUI();
		net?.notifySystemMessage(`Crate ${detail} — closed`);
	}

	#moveItemBetweenCrateAndInventory(slot: ItemSlot): boolean {
		const item = slot.item;
		if (!item) return false;

		const inventory = PlayerHud.#inventory.inventory;
		const crateSlots = this.#woodCrateSlots;

		const isInCrate = crateSlots
			? this.slotExistsInRows(slot, crateSlots)
			: false;

		const isInInventory = !isInCrate && this.slotExistsInRows(slot, inventory);

		if (!isInInventory && !isInCrate) return false;

		const targetRows = isInCrate ? inventory : crateSlots;
		if (!targetRows) return false;

		// First try to stack into existing stacks.
		if (this.tryStackItemIntoRows(slot, item, targetRows)) {
			// In-place stack merges bypass slot setters — push explicitly.
			this.#pushCrateDiff();
			return true;
		}

		// Then try to move into the first empty slot.
		const moved = this.tryMoveItemToEmptySlot(slot, item, targetRows);
		if (moved) this.#pushCrateDiff();
		return moved;
	}
	private slotExistsInRows(slot: ItemSlot, rows: ItemSlot[][]): boolean {
		for (let row = 0, rowCount = rows.length; row < rowCount; row++) {
			const slots = rows[row];

			for (let col = 0, colCount = slots.length; col < colCount; col++) {
				if (slots[col] === slot) {
					return true;
				}
			}
		}

		return false;
	}

	private tryStackItemIntoRows(
		sourceSlot: ItemSlot,
		item: Item,
		targetRows: ItemSlot[][],
	): boolean {
		for (let row = targetRows.length - 1; row >= 0; row--) {
			const slots = targetRows[row];

			for (let col = 0, colCount = slots.length; col < colCount; col++) {
				const targetItem = slots[col].item;

				if (!targetItem || targetItem.itemId !== item.itemId) {
					continue;
				}

				const remainder = Item.stackItemAtoB(item, targetItem);

				if (remainder === 0) {
					sourceSlot.clearItemSlots();
					return true;
				}
			}
		}

		return false;
	}

	private tryMoveItemToEmptySlot(
		sourceSlot: ItemSlot,
		item: Item,
		targetRows: ItemSlot[][],
	): boolean {
		for (let row = targetRows.length - 1; row >= 0; row--) {
			const slots = targetRows[row];

			for (let col = 0, colCount = slots.length; col < colCount; col++) {
				const targetSlot = slots[col];

				if (targetSlot.item) {
					continue;
				}

				sourceSlot.clearItemSlots();

				item.row = targetSlot.row;
				item.col = targetSlot.col;

				targetSlot.divItemSlot.appendChild(item.div);
				targetSlot.item = item;

				return true;
			}
		}

		return false;
	}
	private createWoodCrateUI(): HTMLDivElement {
		const overlay = document.createElement("div");
		overlay.id = "woodcrate-overlay";
		overlay.classList.add("woodcrate-overlay");

		const closeButton = document.createElement("button");
		closeButton.innerHTML = "&times;";
		closeButton.classList.add("hud-close-button");
		closeButton.onclick = () => this.hideWoodCrateUI();

		const title = document.createElement("div");
		title.classList.add("woodcrate-title");
		title.textContent = "Wood Crate";

		const content = document.createElement("div");
		content.classList.add("woodcrate-content");

		// Player inventory panel (left, takes most space)
		const playerPanel = document.createElement("div");
		playerPanel.classList.add("woodcrate-panel", "woodcrate-panel--player");
		const playerTitle = document.createElement("div");
		playerTitle.classList.add("woodcrate-panel-title");
		playerTitle.textContent = "Inventory";
		playerPanel.appendChild(playerTitle);

		const playerGrid = document.createElement("div");
		playerGrid.classList.add("woodcrate-grid");
		playerGrid.id = "woodcrate-player-grid";
		this.#woodCratePlayerGrid = playerGrid;
		const inventory = PlayerHud.#inventory.inventory;
		for (let row = inventory.length - 1; row >= 1; row--) {
			const rowDiv = document.createElement("div");
			rowDiv.classList.add("inventory-row");
			for (let col = 0; col < inventory[row].length; col++) {
				const slot = inventory[row][col];
				rowDiv.appendChild(slot.divItemSlot);
			}
			playerGrid.appendChild(rowDiv);
		}
		playerPanel.appendChild(playerGrid);
		content.appendChild(playerPanel);

		// Block inventory panel (right, compact)
		const blockPanel = document.createElement("div");
		blockPanel.classList.add("woodcrate-panel", "woodcrate-panel--crate");
		const blockTitle = document.createElement("div");
		blockTitle.classList.add("woodcrate-panel-title");
		blockTitle.textContent = "Crate";
		blockPanel.appendChild(blockTitle);

		const blockGrid = document.createElement("div");
		blockGrid.classList.add("woodcrate-grid", "woodcrate-grid--vertical");
		blockGrid.id = "woodcrate-block-grid";
		this.#woodCrateBlockGrid = blockGrid;
		if (this.#woodCrateSlots) {
			for (const row of this.#woodCrateSlots) {
				const rowDiv = document.createElement("div");
				rowDiv.classList.add("woodcrate-row--vertical");
				for (const slot of row) {
					rowDiv.appendChild(slot.divItemSlot);
				}
				blockGrid.appendChild(rowDiv);
			}
		}
		blockPanel.appendChild(blockGrid);
		content.appendChild(blockPanel);

		overlay.appendChild(title);
		overlay.appendChild(content);
		overlay.appendChild(closeButton);
		document.body.appendChild(overlay);

		onSceneDispose(this.#scene, () => {
			overlay.remove();
		});

		return overlay;
	}

	#refreshWoodCrateContent(): void {
		const blockGrid = this.#woodCrateBlockGrid;
		const crateSlots = this.#woodCrateSlots;

		if (!blockGrid || !crateSlots) return;

		const blockFragment = document.createDocumentFragment();

		for (let r = 0, rowCount = crateSlots.length; r < rowCount; r++) {
			const row = crateSlots[r];
			const rowDiv = document.createElement("div");
			rowDiv.classList.add("woodcrate-row--vertical");

			for (let c = 0, colCount = row.length; c < colCount; c++) {
				rowDiv.appendChild(row[c].divItemSlot);
			}

			blockFragment.appendChild(rowDiv);
		}

		blockGrid.replaceChildren(blockFragment);

		const playerGrid = this.#woodCratePlayerGrid;
		if (!playerGrid) return;

		const inventory = PlayerHud.#inventory.inventory;
		const playerFragment = document.createDocumentFragment();

		for (let row = inventory.length - 1; row >= 1; row--) {
			const rowDiv = document.createElement("div");
			rowDiv.classList.add("inventory-row");

			const invRow = inventory[row];
			for (let col = 0, len = invRow.length; col < len; col++) {
				rowDiv.appendChild(invRow[col].divItemSlot);
			}

			playerFragment.appendChild(rowDiv);
		}

		playerGrid.replaceChildren(playerFragment);
	}

	private createMasonTableUI(): HTMLDivElement {
		const overlay = document.createElement("div");
		overlay.id = "mason-overlay";
		overlay.classList.add("mason-overlay");

		const closeButton = document.createElement("button");
		closeButton.innerHTML = "&times;";
		closeButton.classList.add("hud-close-button");
		closeButton.onclick = () => this.hideMasonTableUI();

		const title = document.createElement("div");
		title.classList.add("mason-title");
		title.textContent = "Mason Table";

		const content = document.createElement("div");
		content.classList.add("mason-content");

		const sourcePanel = document.createElement("div");
		sourcePanel.classList.add("mason-panel", "mason-source-panel");

		const sourceTitle = document.createElement("div");
		sourceTitle.classList.add("mason-panel-title");
		sourceTitle.textContent = "Source Block";
		sourcePanel.appendChild(sourceTitle);

		const sourceGrid = document.createElement("div");
		sourceGrid.classList.add("mason-source-grid");

		const sourceBlocks = this.getMasonSourceBlocks();
		for (const def of sourceBlocks) {
			const btn = document.createElement("div");
			btn.classList.add("mason-source-btn");

			const icon = document.createElement("img");
			icon.src = MaterialFactory.getTexturePathFromFolder(def.path) ?? "";
			icon.classList.add("mason-icon");

			const label = document.createElement("div");
			label.classList.add("mason-source-label");
			label.textContent = def.name
				.split("_")
				.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
				.join(" ");

			btn.appendChild(icon);
			btn.appendChild(label);

			btn.onclick = () => {
				sourceGrid.querySelectorAll(".mason-source-btn").forEach((b) => {
					b.classList.remove("selected");
				});
				btn.classList.add("selected");
				this.#selectedSourceBlockId = def.id;
				this.updateMasonTableAvailability();
			};

			sourceGrid.appendChild(btn);
		}
		sourcePanel.appendChild(sourceGrid);

		const shapePanel = document.createElement("div");
		shapePanel.classList.add("mason-panel", "mason-shape-panel");

		const shapeTitle = document.createElement("div");
		shapeTitle.classList.add("mason-panel-title");
		shapeTitle.textContent = "Shape";
		shapePanel.appendChild(shapeTitle);

		const shapeGrid = document.createElement("div");
		shapeGrid.classList.add("mason-shape-grid");

		const shapes = ["slab", "stairs", "half_wall", "pane", "fence"];
		for (const shape of shapes) {
			const btn = document.createElement("div");
			btn.classList.add("mason-shape-btn");
			btn.dataset.shape = shape;

			const label = document.createElement("div");
			label.classList.add("mason-shape-label");
			label.textContent = shape
				.split("_")
				.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
				.join(" ");

			btn.appendChild(label);

			btn.onclick = () => {
				shapeGrid.querySelectorAll(".mason-shape-btn").forEach((b) => {
					b.classList.remove("selected");
				});
				btn.classList.add("selected");
				this.#selectedShape = shape;
				this.updateMasonTableAvailability();
			};

			shapeGrid.appendChild(btn);
		}
		shapePanel.appendChild(shapeGrid);

		const resultPanel = document.createElement("div");
		resultPanel.classList.add("mason-panel", "mason-result-panel");

		const resultTitle = document.createElement("div");
		resultTitle.classList.add("mason-panel-title");
		resultTitle.textContent = "Result";
		resultPanel.appendChild(resultTitle);

		const resultPreview = document.createElement("div");
		resultPreview.classList.add("mason-result-preview");
		resultPreview.id = "mason-result-preview";
		resultPanel.appendChild(resultPreview);

		const craftButton = document.createElement("button");
		craftButton.classList.add("mason-craft-btn");
		craftButton.textContent = "Craft";
		craftButton.id = "mason-craft-btn";
		craftButton.onclick = () => this.craftMasonRecipe();
		resultPanel.appendChild(craftButton);

		content.appendChild(sourcePanel);
		content.appendChild(shapePanel);
		content.appendChild(resultPanel);

		overlay.appendChild(title);
		overlay.appendChild(content);
		overlay.appendChild(closeButton);
		document.body.appendChild(overlay);

		onSceneDispose(this.#scene, () => {
			overlay.remove();
		});

		return overlay;
	}

	private getMasonSourceBlocks() {
		const sourceBlocks: {
			id: number;
			name: string;
			path: string;
		}[] = [];

		const seen = new Set<number>();
		for (const recipe of MasonRecipes) {
			if (seen.has(recipe.sourceBlockId)) continue;
			seen.add(recipe.sourceBlockId);

			const def = TextureDefinitions.find((t) => t.id === recipe.sourceBlockId);
			if (def) {
				sourceBlocks.push({
					id: def.id,
					name: def.name,
					path: def.path,
				});
			}
		}

		return sourceBlocks.sort((a, b) => a.name.localeCompare(b.name));
	}

	public updateMasonTableAvailability(): void {
		const resultPreview = document.getElementById("mason-result-preview");
		const craftButton = document.getElementById("mason-craft-btn");
		if (!resultPreview || !craftButton) return;

		if (this.#selectedSourceBlockId === null || this.#selectedShape === null) {
			resultPreview.textContent = "Select a source block and shape";
			craftButton.classList.remove("available");
			return;
		}

		const recipe = MasonRecipes.find(
			(r) =>
				r.sourceBlockId === this.#selectedSourceBlockId &&
				r.targetShape === this.#selectedShape,
		);

		if (!recipe) {
			resultPreview.textContent = "No recipe found";
			craftButton.classList.remove("available");
			return;
		}

		const resultDef = TextureDefinitions.find(
			(t) => t.id === recipe.resultBlockId,
		);
		const resultName = resultDef
			? resultDef.name
					.split("_")
					.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
					.join(" ")
			: "Unknown";

		const hasItem = PlayerHud.#inventory.hasItem(recipe.sourceBlockId, 1);

		resultPreview.textContent = hasItem
			? `Result: ${resultName}`
			: `Need: ${resultName.split(" ").slice(0, -1).join(" ") || "source block"}`;

		if (hasItem) {
			craftButton.classList.add("available");
		} else {
			craftButton.classList.remove("available");
		}
	}

	private craftMasonRecipe(): void {
		if (this.#selectedSourceBlockId === null || this.#selectedShape === null)
			return;

		const recipe = MasonRecipes.find(
			(r) =>
				r.sourceBlockId === this.#selectedSourceBlockId &&
				r.targetShape === this.#selectedShape,
		);

		if (!recipe) return;

		if (!PlayerHud.#inventory.hasItem(recipe.sourceBlockId, 1)) {
			const craftButton = document.getElementById("mason-craft-btn");
			if (craftButton) {
				craftButton.classList.add("shake");
				setTimeout(() => craftButton.classList.remove("shake"), 300);
			}
			return;
		}

		PlayerHud.#inventory.removeItems(recipe.sourceBlockId, 1);
		PlayerHud.#inventory.createAndAddItem(recipe.resultBlockId, 1);
		this.updateMasonTableAvailability();
	}

	public get selectedHotbarSlot(): number {
		return this.#selectedHotbarSlot;
	}

	public set selectedHotbarSlot(slot: number) {
		this.#selectedHotbarSlot = slot;
		this.updateHotbarSelection();
	}
	private updateHotbarSelection(): void {
		const selected = this.#selectedHotbarSlot;
		const hotbarSlots = this.#hotbarSlots;

		for (let i = 0, len = hotbarSlots.length; i < len; i++) {
			const slot = hotbarSlots[i];
			const shouldBeSelected = i === selected;

			if (slot.classList.contains("selected") !== shouldBeSelected) {
				slot.classList.toggle("selected", shouldBeSelected);
			}
		}

		if (this.#heldItemNameTimeout) {
			clearTimeout(this.#heldItemNameTimeout);
			this.#heldItemNameTimeout = undefined;
		}

		const itemSlot = PlayerHud.#inventory.inventory[0][selected];
		const item = itemSlot?.item;
		const itemName = item ? item.name : "";
		const nameDiv = PlayerHud.#heldItemNameDiv;

		if ((nameDiv.dataset.itemName ?? "") !== itemName) {
			nameDiv.dataset.itemName = itemName;
			nameDiv.textContent = itemName;
			this.#heldItemNameDivCachedWidth = 0;
		}

		if (!itemName) {
			nameDiv.classList.remove("visible");
			return;
		}

		nameDiv.classList.add("visible");

		this.#heldItemNameTimeout = window.setTimeout(() => {
			nameDiv.classList.remove("visible");
		}, 2000);

		if (this.#heldItemNameDivCachedWidth === 0) {
			this.#heldItemNameDivCachedWidth = nameDiv.getBoundingClientRect().width;
		}

		const slotRect = itemSlot.divItemSlot.getBoundingClientRect();
		const widthOffset =
			slotRect.left +
			slotRect.width * 0.5 -
			this.#heldItemNameDivCachedWidth * 0.5;

		const left = `${widthOffset}px`;
		if (nameDiv.style.left !== left) {
			nameDiv.style.left = left;
		}
	}

	private initializeDebugPanel(): void {
		if (PlayerHud.debugPanelDiv) return;

		const div = document.createElement("div");
		div.id = "debug-panel";
		document.body.appendChild(div);
		PlayerHud.debugPanelDiv = div;

		// Add time of day slider
		const timeLabel = document.createElement("div");
		timeLabel.innerText = "Time of Day";
		timeLabel.className = "debug-slider-label";
		div.appendChild(timeLabel);
		const timeSlider = document.createElement("input");
		timeSlider.id = "timeSlider";
		timeSlider.type = "range";
		timeSlider.min = "0";
		timeSlider.max = "1000";
		timeSlider.style.width = "100%";

		timeSlider.oninput = () => {
			const timeValue = parseFloat(timeSlider.value) / 1000;
			Map1.setTime(timeValue);
		};
		div.appendChild(timeSlider);

		// Add time scale slider
		const timeScaleLabel = document.createElement("div");
		timeScaleLabel.innerText = "Time Scale";
		timeScaleLabel.className = "debug-slider-label";
		timeScaleLabel.style.marginTop = "10px";
		div.appendChild(timeScaleLabel);
		const timeScaleSlider = document.createElement("input");
		timeScaleSlider.type = "range";
		timeScaleSlider.min = "0";
		timeScaleSlider.max = "300"; // 0.0 to 20.0
		timeScaleSlider.value = "10"; // Default to 1.0 (10 / 10)
		timeScaleSlider.style.width = "100%";
		timeScaleSlider.oninput = () => {
			Map1.timeScale = parseFloat(timeScaleSlider.value) / 10;
		};
		div.appendChild(timeScaleSlider);

		// Add Fog Start slider
		const fogStartLabel = document.createElement("div");
		fogStartLabel.innerText = "Fog Start";
		fogStartLabel.className = "debug-slider-label";
		fogStartLabel.style.marginTop = "10px";
		div.appendChild(fogStartLabel);
		const fogStartSlider = document.createElement("input");
		fogStartSlider.type = "range";
		fogStartSlider.min = "0";
		fogStartSlider.max = "3000";
		fogStartSlider.value = MapFog.getFogStart(false).toString();
		fogStartSlider.style.width = "100%";
		fogStartSlider.oninput = () => {
			MapFog.setFogStartOverride(parseFloat(fogStartSlider.value));
		};
		div.appendChild(fogStartSlider);

		// Add Fog End slider
		const fogEndLabel = document.createElement("div");
		fogEndLabel.innerText = "Fog End";
		fogEndLabel.className = "debug-slider-label";
		fogEndLabel.style.marginTop = "10px";
		div.appendChild(fogEndLabel);
		const fogEndSlider = document.createElement("input");
		fogEndSlider.type = "range";
		fogEndSlider.min = "0";
		fogEndSlider.max = "3000";
		fogEndSlider.value = MapFog.getFogEnd(false).toString();
		fogEndSlider.style.width = "100%";
		fogEndSlider.oninput = () => {
			MapFog.setFogEndOverride(parseFloat(fogEndSlider.value));
		};
		div.appendChild(fogEndSlider);

		// Add Wetness slider
		const wetnessLabel = document.createElement("div");
		wetnessLabel.innerText = "Wetness";
		wetnessLabel.className = "debug-slider-label";
		wetnessLabel.style.marginTop = "10px";
		div.appendChild(wetnessLabel);
		const wetnessSlider = document.createElement("input");
		wetnessSlider.type = "range";
		wetnessSlider.min = "0";
		wetnessSlider.max = "100";
		wetnessSlider.value = (
			(WorldEnvironment.instance?.wetness || 0) * 100
		).toString();
		wetnessSlider.style.width = "100%";
		wetnessSlider.oninput = () => {
			if (WorldEnvironment.instance) {
				WorldEnvironment.instance.wetness =
					parseFloat(wetnessSlider.value) / 100;
			}
		};
		div.appendChild(wetnessSlider);
	}

	/** Toggle visibility of all persistent HUD elements via the `hud-hidden` body class. */
	public static toggleHud(): void {
		PlayerHud.#hudHidden = !PlayerHud.#hudHidden;
		document.body.classList.toggle("hud-hidden", PlayerHud.#hudHidden);
	}

	public static get isHudHidden(): boolean {
		return PlayerHud.#hudHidden;
	}

	public static toggleDebugInfo(): void {
		if (PlayerHud.debugPanelDiv) {
			if (PlayerHud.debugPanelVisible) {
				PlayerHud.hideDebugPanel();
			} else {
				PlayerHud.showDebugPanel();
			}
		}
	}

	public static showDebugPanel(): void {
		if (PlayerHud.debugPanelDiv) {
			PlayerHud.removeDebugInfo("Faces");
			PlayerHud.debugPanelDiv.style.display = "block";
			PlayerHud.debugPanelVisible = true;
		}
	}

	public static hideDebugPanel(): void {
		if (PlayerHud.debugPanelDiv) {
			PlayerHud.debugPanelDiv.style.display = "none";
			PlayerHud.debugPanelVisible = false;
		}
	}

	public static updateDebugInfo(
		key: string,
		value: string | number,
		category?: string,
	): void {
		const panel = PlayerHud.debugPanelDiv;
		if (!panel) return;

		const stringValue = String(value);
		const row = PlayerHud.infoRows[key];

		if (row) {
			if (row.valueSpan && row.valueSpan.textContent !== stringValue) {
				row.valueSpan.textContent = stringValue;
			}
			return;
		}

		const container = document.createElement("div");
		container.className = "debug-row";

		const keySpan = document.createElement("span");
		keySpan.className = "debug-key";
		if (category) keySpan.dataset.cat = category;
		keySpan.textContent = `${key}: `;

		const valueSpan = document.createElement("span");
		valueSpan.className = "debug-value";
		valueSpan.textContent = stringValue;

		container.appendChild(keySpan);
		container.appendChild(valueSpan);

		let textContainer = panel.firstElementChild as HTMLDivElement | null;

		if (textContainer?.className !== "debug-info-container") {
			textContainer = document.createElement("div");
			textContainer.className = "debug-info-container";
			panel.prepend(textContainer);
		}

		textContainer.appendChild(container);

		PlayerHud.infoRows[key] = {
			container,
			valueNode: valueSpan.firstChild as Text,
			valueSpan,
			keySpan,
		};
	}

	public static removeDebugInfo(key: string): void {
		const row = PlayerHud.infoRows[key];
		if (!row) return;

		row.container.remove();
		delete PlayerHud.infoRows[key];
	}

	private initializeTooltip(): void {
		if (PlayerHud.itemTooltipDiv) return;

		const tooltip = document.createElement("div");
		tooltip.id = "item-tooltip";
		document.body.appendChild(tooltip);
		PlayerHud.itemTooltipDiv = tooltip;

		// Bound once for the tooltip's lifetime. While the tooltip is hidden
		// this only writes two numbers per event.
		document.addEventListener("mousemove", PlayerHud.#onTooltipMouseMove);
	}

	public static showItemTooltip(text: string, event: MouseEvent): void {
		const tooltip = PlayerHud.itemTooltipDiv;
		if (!tooltip) return;

		const item = PlayerInventory.currentlyHoveredSlot?.item;

		if (item) {
			if (tooltip.dataset.itemName !== item.name) {
				tooltip.dataset.itemName = item.name;
				tooltip.dataset.itemDesc = item.description ?? "";

				let nameDiv = tooltip.firstElementChild as HTMLDivElement | null;
				if (nameDiv?.className !== "item-tooltip-name") {
					tooltip.textContent = "";

					nameDiv = document.createElement("div");
					nameDiv.className = "item-tooltip-name";
					tooltip.appendChild(nameDiv);
				}

				nameDiv.textContent = item.name;

				const arrowStats = getArrowTooltipStats(item.itemId);
				const toolStats = getToolTooltipStats(item.itemId);
				const stats = [arrowStats, toolStats].filter(Boolean).join("\n");
				const desc = stats ? `${item.description}\n${stats}` : item.description;
				let descDiv = nameDiv.nextElementSibling as HTMLDivElement | null;

				if (desc) {
					if (descDiv?.className !== "item-tooltip-desc") {
						descDiv = document.createElement("div");
						descDiv.className = "item-tooltip-desc";
						tooltip.appendChild(descDiv);
					}

					descDiv.textContent = desc;
				} else if (descDiv) {
					descDiv.remove();
				}
			}
		} else if (tooltip.dataset.fallbackText !== text) {
			tooltip.dataset.itemName = "";
			tooltip.dataset.itemDesc = "";
			tooltip.dataset.fallbackText = text;
			tooltip.textContent = text;
		}

		PlayerHud.#tooltipVisible = true;
		tooltip.classList.add("visible");

		// Place immediately from this event so the tooltip never appears at a
		// stale position; a transform write does not invalidate layout.
		PlayerHud.#tooltipPendingX = event.clientX + 12;
		PlayerHud.#tooltipPendingY = event.clientY - 32;
		PlayerHud.#applyTooltipPosition();
	}

	static #onTooltipMouseMove = (event: MouseEvent): void => {
		PlayerHud.#tooltipPendingX = event.clientX + 12;
		PlayerHud.#tooltipPendingY = event.clientY - 32;

		if (!PlayerHud.#tooltipVisible) {
			// Drop any pending write for a tooltip that is no longer shown.
			if (PlayerHud.#tooltipRafId !== null) {
				cancelAnimationFrame(PlayerHud.#tooltipRafId);
				PlayerHud.#tooltipRafId = null;
			}
			return;
		}

		if (PlayerHud.#tooltipRafId === null) {
			PlayerHud.#tooltipRafId = requestAnimationFrame(
				PlayerHud.#applyTooltipPosition,
			);
		}
	};

	static #applyTooltipPosition = (): void => {
		PlayerHud.#tooltipRafId = null;

		const tooltip = PlayerHud.itemTooltipDiv;
		if (!tooltip || !PlayerHud.#tooltipVisible) return;

		tooltip.style.transform = `translate3d(${PlayerHud.#tooltipPendingX}px, ${PlayerHud.#tooltipPendingY}px, 0)`;
	};

	public static hideItemTooltip(): void {
		const tooltip = PlayerHud.itemTooltipDiv;
		if (!tooltip) return;

		PlayerHud.#tooltipVisible = false;
		tooltip.classList.remove("visible");

		if (PlayerHud.#tooltipRafId !== null) {
			cancelAnimationFrame(PlayerHud.#tooltipRafId);
			PlayerHud.#tooltipRafId = null;
		}
	}

	public updateStats(): void {
		const stats = this.#player.stats;
		if (!stats) return;

		const healthPct =
			stats.maxHealth > 0
				? Math.max(
						0,
						Math.min(100, Math.round((stats.health / stats.maxHealth) * 100)),
					)
				: 0;

		if (healthPct !== this.#prevHealthPct) {
			this.#prevHealthPct = healthPct;
			this.#healthBarFill.style.transform = `scaleX(${healthPct / 100})`;
		}

		const hungerPct =
			stats.maxHunger > 0
				? Math.max(
						0,
						Math.min(100, Math.round((stats.hunger / stats.maxHunger) * 100)),
					)
				: 0;

		if (hungerPct !== this.#prevHungerPct) {
			this.#prevHungerPct = hungerPct;
			this.#hungerBarFill.style.transform = `scaleX(${hungerPct / 100})`;
		}

		const staminaPct =
			stats.maxStamina > 0
				? Math.max(
						0,
						Math.min(100, Math.round((stats.stamina / stats.maxStamina) * 100)),
					)
				: 0;

		if (staminaPct !== this.#prevStaminaPct) {
			this.#prevStaminaPct = staminaPct;
			this.#staminaBarFill.style.transform = `scaleX(${staminaPct / 100})`;
		}

		const manaPct =
			stats.maxMana > 0
				? Math.max(
						0,
						Math.min(100, Math.round((stats.mana / stats.maxMana) * 100)),
					)
				: 0;

		if (manaPct !== this.#prevManaPct) {
			this.#prevManaPct = manaPct;
			this.#manaBarFill.style.transform = `scaleX(${manaPct / 100} )`;
		}
	}
}
