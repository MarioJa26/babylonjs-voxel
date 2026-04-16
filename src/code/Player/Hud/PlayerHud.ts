import { type Engine, Scene } from "@babylonjs/core";
import { Map1 } from "@/code/Maps/Map1";
import { MaterialFactory } from "@/code/World/Texture/MaterialFactory";
import { TextureDefinitions } from "@/code/World/Texture/TextureDefinitions";
import MapFog from "../../Maps/MapFog";
import { WorldEnvironment } from "../../Maps/WorldEnvironment";
import { type Recipe, Recipes } from "../Crafting/CraftingManager";
import { CrossHair } from "../Hud/CrossHair";
import { PlayerInventory } from "../Inventory/PlayerInventory";
import type { Player } from "../Player";

export class PlayerHud {
	#engine: Engine;
	#scene: Scene;
	#player: Player;

	static #inventory: PlayerInventory;
	#inventoryOpen = false;
	#craftingRecipeDivs: { recipe: Recipe; div: HTMLDivElement }[] = [];

	#selectedHotbarSlot = 0;
	#hotbarSlots: HTMLDivElement[] = [];
	static #heldItemNameDiv: HTMLDivElement = document.createElement("div");
	#heldItemNameTimeout?: number;

	#overlayDiv: HTMLDivElement;

	static debugPanelDiv: HTMLDivElement;
	private static infoRows: {
		[key: string]: {
			container: HTMLDivElement;
			valueNode: Text;
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
		new CrossHair(engine, scene, player);
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

				// Calculate position relative to the hotbar container
				const slotRect = itemSlot.divItemSlot.getBoundingClientRect();
				const leftOffset = itemSlot.divItemSlot.getBoundingClientRect().left;
				const widthOffset =
					leftOffset +
					slotRect.width / 2 -
					PlayerHud.#heldItemNameDiv.getBoundingClientRect().width / 2;

				PlayerHud.#heldItemNameDiv.style.left = `${widthOffset}px`;
			} else {
				PlayerHud.#heldItemNameDiv.classList.remove("visible");
			}
		}
	}

	private initializeDebugPanel(): void {
		if (PlayerHud.debugPanelDiv) return;

		const div = document.createElement("div");
		div.style.position = "absolute";
		div.style.top = "10px";
		div.style.left = "10px";
		div.style.padding = "10px";
		div.style.backgroundColor = "rgba(0, 0, 0, 0.6)";
		div.style.color = "white";
		div.style.fontFamily = "monospace";
		div.style.fontSize = "16px";
		div.style.zIndex = "100";
		div.style.display = "block"; // Initially hidden
		div.style.borderRadius = "5px";
		document.body.appendChild(div);
		PlayerHud.debugPanelDiv = div;

		// Add time of day slider
		const timeLabel = document.createElement("div");
		timeLabel.innerText = "Time of Day";
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

	public static updateDebugInfo(key: string, value: string | number): void {
		if (!PlayerHud.debugPanelDiv) return;

		const stringValue = String(value);

		const row = PlayerHud.infoRows[key];

		if (!row) {
			// Create row once
			const container = document.createElement("div");

			const strong = document.createElement("strong");
			strong.textContent = key + ": ";

			const valueNode = document.createTextNode(stringValue);

			container.appendChild(strong);
			container.appendChild(valueNode);

			// Create info container once
			let textContainer = PlayerHud.debugPanelDiv.querySelector(
				".info-container",
			) as HTMLDivElement;

			if (!textContainer) {
				textContainer = document.createElement("div");
				textContainer.className = "info-container";
				PlayerHud.debugPanelDiv.prepend(textContainer);
			}

			textContainer.appendChild(container);

			PlayerHud.infoRows[key] = { container, valueNode };
		} else {
			// Only update text node if changed
			if (row.valueNode.nodeValue !== stringValue) {
				row.valueNode.nodeValue = stringValue;
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

		this.#healthBarFill.style.width = `${
			(stats.health / stats.maxHealth) * 100
		}%`;
		this.#hungerBarFill.style.width = `${
			(stats.hunger / stats.maxHunger) * 100
		}%`;
		this.#staminaBarFill.style.width = `${
			(stats.stamina / stats.maxStamina) * 100
		}%`;
		this.#manaBarFill.style.width = `${(stats.mana / stats.maxMana) * 100}%`;
	}
}
