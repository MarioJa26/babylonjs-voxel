import { type Engine, Scene } from "@babylonjs/core";
import { Map1 } from "@/code/Maps/Map1";
import { MaterialFactory } from "@/code/World/Texture/MaterialFactory";
import { TextureDefinitions } from "@/code/World/Texture/TextureDefinitions";
import MapFog from "../../Maps/MapFog";
import { WorldEnvironment } from "../../Maps/WorldEnvironment";
import {
	type MasonRecipe,
	MasonRecipes,
	type Recipe,
	Recipes,
} from "../Crafting/CraftingManager";
import { PlayerInventory } from "../Inventory/PlayerInventory";
import type { Player } from "../Player";
import { Crosshair } from "./Crosshair/Crosshair";

export class PlayerHud {
	#engine: Engine;
	#scene: Scene;
	readonly #player: Player;

	public readonly crossHair: Crosshair;

	public get player(): Player {
		return this.#player;
	}

	static #inventory: PlayerInventory;
	#inventoryOpen = false;
	#craftingRecipeDivs: { recipe: Recipe; div: HTMLDivElement }[] = [];

	#masonTableOpen = false;
	#masonTableDiv: HTMLDivElement | null = null;
	#selectedSourceBlockId: number | null = null;
	#selectedShape: string | null = null;
	#masonRecipeDivs: {
		recipe: MasonRecipe;
		div: HTMLDivElement;
	}[] = [];

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

	static debugPanelDiv: HTMLDivElement;
	private static infoRows: {
		[key: string]: {
			container: HTMLDivElement;
			valueNode: Text;
			valueSpan?: HTMLSpanElement;
			keySpan?: HTMLSpanElement;
		};
	} = {};
	private static itemTooltipDiv: HTMLDivElement;
	private static itemTooltipMouseMove?: (e: MouseEvent) => void;

	#healthBarFill!: HTMLDivElement;
	#hungerBarFill!: HTMLDivElement;
	#staminaBarFill!: HTMLDivElement;
	#manaBarFill!: HTMLDivElement;

	constructor(engine: Engine, scene: Scene, player: Player) {
		this.#engine = engine;
		this.#scene = scene;
		this.#player = player;
		PlayerHud.#inventory = player.playerInventory;
		this.crossHair = new Crosshair(engine, scene);
		this.#overlayDiv = this.initializeHUD();
		this.createHotbarUI();
		this.createStatsUI();
		this.initializeDebugPanel();
		this.initializeTooltip();

		PlayerHud.#inventory.onInventoryChangedObservable.add(() => {
			if (this.#inventoryOpen) {
				this.updateCraftingAvailability();
			}
		});
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
			this.#player.keyboardControls.onKeyUp("tab");
		};

		const contentWrapper = document.createElement("div");
		contentWrapper.classList.add("hud-content-wrapper");

		const inventoryUI = this.createInventoryUI();
		const craftingUI = this.createCraftingUI();

		contentWrapper.appendChild(inventoryUI);
		contentWrapper.appendChild(craftingUI);

		overlayDiv.appendChild(contentWrapper);
		overlayDiv.appendChild(closeButton);
		document.body.appendChild(overlayDiv);

		this.#scene.onDisposeObservable.add(() => {
			overlayDiv.remove();
			document.exitPointerLock();
		});

		return overlayDiv;
	}

	private createCraftingUI(): HTMLDivElement {
		const container = document.createElement("div");
		container.classList.add("crafting-container");
		this.#craftingRecipeDivs = [];

		const viewSwitcher = document.createElement("div");
		viewSwitcher.classList.add("crafting-view-switcher");

		const detailedButton = document.createElement("button");
		detailedButton.innerText = "List";
		detailedButton.title = "Show name and icon";
		detailedButton.classList.add("active");

		const compactButton = document.createElement("button");
		compactButton.innerText = "Grid";
		compactButton.title = "Show only icon";

		detailedButton.onclick = () => {
			container.classList.remove("compact-view");
			detailedButton.classList.add("active");
			compactButton.classList.remove("active");
		};

		compactButton.onclick = () => {
			container.classList.add("compact-view");
			compactButton.classList.add("active");
			detailedButton.classList.remove("active");
		};

		viewSwitcher.appendChild(detailedButton);
		viewSwitcher.appendChild(compactButton);
		container.appendChild(viewSwitcher);

		for (const recipe of Recipes) {
			const textureDef = TextureDefinitions.find(
				(t) => t.id === recipe.resultId,
			);
			if (!textureDef) continue;

			const recipeDiv = document.createElement("div");
			recipeDiv.classList.add("crafting-recipe");

			const ingredientsInfo = recipe.ingredients
				.map((ing) => {
					const ingDef = TextureDefinitions.find((t) => t.id === ing.itemId);
					return `- ${ingDef ? ingDef.name : "Unknown"} x${ing.count}`;
				})
				.join("\n");
			recipeDiv.title = `Craft ${textureDef.name}\nRequires:\n${ingredientsInfo}`;

			const icon = document.createElement("img");
			icon.src =
				MaterialFactory.getTexturePathFromFolder(textureDef.path) ?? "";
			icon.classList.add("crafting-icon");

			const name = document.createElement("span");
			name.innerText = textureDef.name;

			recipeDiv.appendChild(icon);
			recipeDiv.appendChild(name);

			this.#craftingRecipeDivs.push({ recipe, div: recipeDiv });

			recipeDiv.onclick = () => {
				let canCraft = true;
				for (const ing of recipe.ingredients) {
					if (!PlayerHud.#inventory.hasItem(ing.itemId, ing.count)) {
						canCraft = false;
						break;
					}
				}

				if (canCraft) {
					for (const ing of recipe.ingredients) {
						PlayerHud.#inventory.removeItems(ing.itemId, ing.count);
					}
					PlayerHud.#inventory.createAndAddItem(
						recipe.resultId,
						recipe.resultCount,
					);
					this.updateCraftingAvailability();
				} else {
					recipeDiv.style.borderColor = "red";
					setTimeout(() => (recipeDiv.style.borderColor = ""), 200);
				}
			};
			container.appendChild(recipeDiv);
		}
		this.updateCraftingAvailability();
		return container;
	}

	public updateCraftingAvailability(): void {
		for (const item of this.#craftingRecipeDivs) {
			let canCraft = true;
			for (const ing of item.recipe.ingredients) {
				if (!PlayerHud.#inventory.hasItem(ing.itemId, ing.count)) {
					canCraft = false;
					break;
				}
			}

			if (canCraft) {
				item.div.classList.remove("not-craftable");
				item.div.style.borderColor = ""; // Reset red border if it was set
			} else {
				item.div.classList.add("not-craftable");
			}
		}
	}

	private createInventoryUI(): HTMLDivElement {
		const inventoryContainer = document.createElement("div");
		inventoryContainer.classList.add("inventory-container");

		const inventory = PlayerHud.#inventory.inventory;
		for (let row = inventory.length - 1; row >= 1; row--) {
			const rowContainer = document.createElement("div");
			rowContainer.classList.add("inventory-row");

			for (let col = 0; col < inventory[row].length; col++) {
				const slot = this.getSlot(col, row);
				if (!slot) continue;
				rowContainer.appendChild(slot);
			}
			inventoryContainer.appendChild(rowContainer);
		}
		return inventoryContainer;
	}
	private createHotbarUI(): HTMLDivElement {
		const existingWrapper = document.getElementById("hotbar-wrapper");
		if (existingWrapper) {
			existingWrapper.remove(); // Remove old one to rebuild with new scene context
		}
		const hotbarWrapper = document.createElement("div");
		hotbarWrapper.id = "hotbar-wrapper";
		hotbarWrapper.classList.add("hotbar-wrapper");
		// Create item name display
		PlayerHud.#heldItemNameDiv.classList.add("held-item-name");

		const hotbarContainer = document.createElement("div");
		hotbarContainer.classList.add("hotbar-container");

		const hotbarRow = PlayerHud.#inventory.inventory[0];
		for (let col = 0; col < hotbarRow.length; col++) {
			const slot = this.getSlot(col, 0);
			if (!slot) continue;
			hotbarContainer.appendChild(slot);
			this.#hotbarSlots.push(slot); // Store every slot
		}

		hotbarWrapper.appendChild(PlayerHud.#heldItemNameDiv);
		hotbarWrapper.appendChild(hotbarContainer);

		this.updateHotbarSelection();
		document.body.appendChild(hotbarWrapper);

		this.#scene.onDisposeObservable.add(() => {
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

		this.#scene.onDisposeObservable.add(() => {
			container.remove();
		});
	}

	private getSlot(column: number, row: number): HTMLDivElement | null {
		return PlayerHud.#inventory.inventory[row][column].divItemSlot;
	}

	public toggleInventory(): void {
		if (this.#masonTableOpen) {
			this.hideMasonTableUI();
		}
		this.#inventoryOpen = !this.#inventoryOpen;
		if (this.#inventoryOpen) {
			this.updateCraftingAvailability();
			PlayerHud.#heldItemNameDiv.classList.remove("visible");
			this.#overlayDiv.style.display = "flex";
			this.#engine.exitPointerlock();
		} else {
			this.#overlayDiv.style.display = "none";
			this.#engine.enterPointerlock();
		}
	}

	public showMasonTableUI(): void {
		if (this.#masonTableOpen) return;
		this.#masonTableOpen = true;
		this.#selectedSourceBlockId = null;
		this.#selectedShape = null;

		if (!this.#masonTableDiv) {
			this.#masonTableDiv = this.createMasonTableUI();
		}

		this.updateMasonTableAvailability();
		this.#masonTableDiv.style.display = "flex";
		this.#engine.exitPointerlock();
	}

	public hideMasonTableUI(): void {
		if (!this.#masonTableOpen) return;
		this.#masonTableOpen = false;
		if (this.#masonTableDiv) {
			this.#masonTableDiv.style.display = "none";
		}
		this.#engine.enterPointerlock();
	}

	public get isMasonTableOpen(): boolean {
		return this.#masonTableOpen;
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

		this.#scene.onDisposeObservable.add(() => {
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
		this.#hotbarSlots.forEach((slot, index) => {
			slot.classList.toggle("selected", index === this.#selectedHotbarSlot);
		});

		// Clear any existing fade-out timeout
		if (this.#heldItemNameTimeout) {
			clearTimeout(this.#heldItemNameTimeout);
		}

		// Update held item name display
		const itemSlot =
			PlayerHud.#inventory.inventory[0][this.#selectedHotbarSlot];
		const item = itemSlot?.item;
		if (PlayerHud.#heldItemNameDiv) {
			const itemName = item ? item.name : "";
			PlayerHud.#heldItemNameDiv.innerText = itemName;

			if (itemName) {
				PlayerHud.#heldItemNameDiv.classList.add("visible");
				this.#heldItemNameTimeout = window.setTimeout(() => {
					PlayerHud.#heldItemNameDiv.classList.remove("visible");
				}, 2000);

				// PERF: Cache heldItemNameDiv width to avoid second getBoundingClientRect().
				if (this.#heldItemNameDivCachedWidth === 0) {
					this.#heldItemNameDivCachedWidth =
						PlayerHud.#heldItemNameDiv.getBoundingClientRect().width;
				}
				const slotRect = itemSlot.divItemSlot.getBoundingClientRect();
				const widthOffset =
					slotRect.left +
					slotRect.width / 2 -
					this.#heldItemNameDivCachedWidth / 2;

				PlayerHud.#heldItemNameDiv.style.left = `${widthOffset}px`;
			} else {
				PlayerHud.#heldItemNameDiv.classList.remove("visible");
			}
		}
	}

	private initializeDebugPanel(): void {
		if (PlayerHud.debugPanelDiv) return;

		const style = document.createElement("style");
		style.textContent = `
			.debug-info-container {
				display: flex;
				flex-direction: column;
				gap: 1px;
			}
			.debug-row {
				display: flex;
				gap: 4px;
				line-height: 1.3;
			}
			.debug-key {
				font-weight: bold;
				color: #e0e0e0;
				-webkit-text-stroke: 0.6px #000;
				text-stroke: 0.6px #000;
				paint-order: stroke fill;
				text-shadow:
					-1px -1px 0 #000,
					 1px -1px 0 #000,
					-1px  1px 0 #000,
					 1px  1px 0 #000,
					 0px  1px 0 #000,
					 0px -1px 0 #000,
					-1px  0px 0 #000,
					 1px  0px 0 #000;
			}
			.debug-value {
				color: #fff;
				-webkit-text-stroke: 0.4px #000;
				text-stroke: 0.4px #000;
				paint-order: stroke fill;
				text-shadow:
					-1px -1px 0 #000,
					 1px -1px 0 #000,
					-1px  1px 0 #000,
					 1px  1px 0 #000,
					 0px  1px 0 #000,
					 0px -1px 0 #000,
					-1px  0px 0 #000,
					 1px  0px 0 #000;
			}
			.debug-key[data-cat="performance"] { color: #00ff88; }
			.debug-key[data-cat="position"]    { color: #44aaff; }
			.debug-key[data-cat="world"]       { color: #ffcc44; }
			.debug-key[data-cat="chunks"]      { color: #ff8844; }
			.debug-key[data-cat="workers"]     { color: #cc66ff; }
			.debug-key[data-cat="stats"]       { color: #ff6688; }
			.debug-key[data-cat="biome"]       { color: #88ff44; }
			.debug-key[data-cat="mobs"]        { color: #44ffff; }
			.debug-slider-label {
				color: #ffcc44;
				font-weight: bold;
				-webkit-text-stroke: 0.6px #000;
				text-stroke: 0.6px #000;
				paint-order: stroke fill;
				text-shadow:
					-1px -1px 0 #000,
					 1px -1px 0 #000,
					-1px  1px 0 #000,
					 1px  1px 0 #000,
					 0px  1px 0 #000,
					 0px -1px 0 #000,
					-1px  0px 0 #000,
					 1px  0px 0 #000;
			}
		`;
		document.head.appendChild(style);

		const div = document.createElement("div");
		div.style.position = "absolute";
		div.style.top = "10px";
		div.style.left = "10px";
		div.style.padding = "10px";
		div.style.backgroundColor = "rgba(0, 0, 0, 0.5)";
		div.style.fontFamily = "monospace";
		div.style.fontSize = "14px";
		div.style.zIndex = "100";
		div.style.display = "block";
		div.style.borderRadius = "5px";
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
		fogStartSlider.value = (this.#scene.fogStart || 0).toString();
		fogStartSlider.style.width = "100%";
		fogStartSlider.oninput = () => {
			if (this.#scene.fogMode === Scene.FOGMODE_NONE) {
				this.#scene.fogMode = Scene.FOGMODE_LINEAR;
			}
			const value = parseFloat(fogStartSlider.value);
			MapFog.setFogStartOverride(value);
			if (this.#scene.fogStart !== value) {
				this.#scene.fogStart = value;
			}
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
		fogEndSlider.value = (this.#scene.fogEnd || 1000).toString();
		fogEndSlider.style.width = "100%";
		fogEndSlider.oninput = () => {
			if (this.#scene.fogMode === Scene.FOGMODE_NONE) {
				this.#scene.fogMode = Scene.FOGMODE_LINEAR;
			}
			const value = parseFloat(fogEndSlider.value);
			MapFog.setFogEndOverride(value);
			if (this.#scene.fogEnd !== value) {
				this.#scene.fogEnd = value;
			}
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

	public static toggleDebugInfo(): void {
		if (PlayerHud.debugPanelDiv) {
			if (PlayerHud.debugPanelDiv.style.display === "none") {
				PlayerHud.showDebugPanel();
			} else {
				PlayerHud.hideDebugPanel();
			}
		}
	}

	public static showDebugPanel(): void {
		if (PlayerHud.debugPanelDiv)
			PlayerHud.debugPanelDiv.style.display = "block";
	}

	public static hideDebugPanel(): void {
		if (PlayerHud.debugPanelDiv) PlayerHud.debugPanelDiv.style.display = "none";
	}

	public static updateDebugInfo(
		key: string,
		value: string | number,
		category?: string,
	): void {
		if (!PlayerHud.debugPanelDiv) return;

		const stringValue = String(value);

		const row = PlayerHud.infoRows[key];

		if (!row) {
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

			let textContainer = PlayerHud.debugPanelDiv.querySelector(
				".debug-info-container",
			) as HTMLDivElement;

			if (!textContainer) {
				textContainer = document.createElement("div");
				textContainer.className = "debug-info-container";
				PlayerHud.debugPanelDiv.prepend(textContainer);
			}

			textContainer.appendChild(container);

			PlayerHud.infoRows[key] = {
				container,
				valueNode: valueSpan as unknown as Text,
				valueSpan,
				keySpan,
			};
		} else {
			if (row.valueSpan && row.valueSpan.textContent !== stringValue) {
				row.valueSpan.textContent = stringValue;
			}
		}
	}

	private initializeTooltip(): void {
		if (PlayerHud.itemTooltipDiv) return;

		const tooltip = document.createElement("div");
		tooltip.id = "item-tooltip";
		tooltip.style.display = "none";
		document.body.appendChild(tooltip);
		PlayerHud.itemTooltipDiv = tooltip;
	}

	public static showItemTooltip(text: string, event: MouseEvent): void {
		if (!PlayerHud.itemTooltipDiv) return;

		const item = PlayerInventory.currentlyHoveredSlot?.item;
		PlayerHud.itemTooltipDiv.innerHTML = "";
		if (item) {
			const nameDiv = document.createElement("div");
			nameDiv.className = "item-tooltip-name";
			nameDiv.textContent = item.name;
			PlayerHud.itemTooltipDiv.appendChild(nameDiv);

			if (item.description) {
				const descDiv = document.createElement("div");
				descDiv.className = "item-tooltip-desc";
				descDiv.textContent = item.description;
				PlayerHud.itemTooltipDiv.appendChild(descDiv);
			}
		} else {
			PlayerHud.itemTooltipDiv.textContent = text;
		}

		PlayerHud.itemTooltipDiv.style.display = "block";

		// Update position immediately and then follow the cursor
		const updatePos = (e: MouseEvent) => {
			const offsetX = 12;
			const offsetY = 32;
			PlayerHud.itemTooltipDiv.style.left = `${e.clientX + offsetX}px`;
			PlayerHud.itemTooltipDiv.style.top = `${e.clientY - offsetY}px`;
		};

		// Set initial position from the original event
		updatePos(event);

		// Remove any previous listener to avoid duplicates
		if (PlayerHud.itemTooltipMouseMove) {
			document.removeEventListener("mousemove", PlayerHud.itemTooltipMouseMove);
		}

		PlayerHud.itemTooltipMouseMove = updatePos;
		document.addEventListener("mousemove", PlayerHud.itemTooltipMouseMove);
	}

	public static hideItemTooltip(): void {
		if (!PlayerHud.itemTooltipDiv) return;

		PlayerHud.itemTooltipDiv.style.display = "none";

		if (PlayerHud.itemTooltipMouseMove) {
			document.removeEventListener("mousemove", PlayerHud.itemTooltipMouseMove);
			PlayerHud.itemTooltipMouseMove = undefined;
		}
	}

	public updateStats(): void {
		const stats = this.#player.stats;
		if (!stats) return;

		// PERF: Only write to DOM when stat percentages actually change.
		const healthPct = (stats.health / stats.maxHealth) * 100;
		if (healthPct !== this.#prevHealthPct) {
			this.#prevHealthPct = healthPct;
			this.#healthBarFill.style.width = `${healthPct}%`;
		}
		const hungerPct = (stats.hunger / stats.maxHunger) * 100;
		if (hungerPct !== this.#prevHungerPct) {
			this.#prevHungerPct = hungerPct;
			this.#hungerBarFill.style.width = `${hungerPct}%`;
		}
		const staminaPct = (stats.stamina / stats.maxStamina) * 100;
		if (staminaPct !== this.#prevStaminaPct) {
			this.#prevStaminaPct = staminaPct;
			this.#staminaBarFill.style.width = `${staminaPct}%`;
		}
		const manaPct = (stats.mana / stats.maxMana) * 100;
		if (manaPct !== this.#prevManaPct) {
			this.#prevManaPct = manaPct;
			this.#manaBarFill.style.width = `${manaPct}%`;
		}
	}
}
