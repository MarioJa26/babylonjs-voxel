import type { PlayerInventory } from "@/code/Player/Inventory/PlayerInventory";
import { MaterialFactory } from "@/code/World/Texture/MaterialFactory";
import {
	TextureDefinitions,
	TextureDefinitionsReady,
} from "@/code/World/Texture/TextureDefinitions";
import { type Recipe, Recipes } from "../CraftingManager";

// Tracks the item id currently being dragged from a recipe-search slot, so we
// can tell a swap (slot -> slot) apart from a new drop (e.g. inventory -> slot).
let draggedSearchItemId: number | null = null;

export class CraftMenu {
	#inventory: PlayerInventory;

	#craftingRecipeDivs: { recipe: Recipe; div: HTMLDivElement }[] = [];
	#recipeSearchSlots: (number | null)[] = [null, null, null];
	#recipeSearchSlotDivs: HTMLDivElement[] = [];
	#recipeSearchResultsDiv!: HTMLDivElement;
	#recipeSearchDragJustDropped = false;
	#recipePickerOverlay: HTMLDivElement | null = null;

	constructor(inventory: PlayerInventory) {
		this.#inventory = inventory;
	}

	/** Builds the full crafting menu (view switcher + search panel + recipe
	 *  list) into the given container. */
	async build(container: HTMLDivElement): Promise<void> {
		await TextureDefinitionsReady;
		this.createCraftingUI(container);
	}

	private createCraftingUI(container: HTMLDivElement): void {
		container.innerHTML = "";
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

		const header = document.createElement("div");
		header.classList.add("crafting-header");
		header.appendChild(viewSwitcher);
		header.appendChild(this.createRecipeSearchPanel());
		container.appendChild(header);

		const list = document.createElement("div");
		list.classList.add("crafting-list");
		for (const recipe of Recipes) {
			const recipeDiv = this.createRecipeCard(recipe);
			if (!recipeDiv) continue;

			recipeDiv.onclick = () => this.craftRecipe(recipeDiv, recipe);
			list.appendChild(recipeDiv);
		}
		container.appendChild(list);
		this.updateCraftingAvailability();
	}

	private craftRecipe(recipeDiv: HTMLDivElement, recipe: Recipe): void {
		let canCraft = true;
		for (const ing of recipe.ingredients) {
			if (!this.#inventory.hasItem(ing.itemId, ing.count)) {
				canCraft = false;
				break;
			}
		}

		if (canCraft) {
			for (const ing of recipe.ingredients) {
				this.#inventory.removeItems(ing.itemId, ing.count);
			}
			this.#inventory.createAndAddItem(recipe.resultId, recipe.resultCount);
			this.updateCraftingAvailability();
		} else {
			recipeDiv.style.borderColor = "red";
			setTimeout(() => (recipeDiv.style.borderColor = ""), 200);
		}
	}

	private createRecipeCard(recipe: Recipe): HTMLDivElement | null {
		const textureDef = TextureDefinitions.find((t) => t.id === recipe.resultId);
		if (!textureDef) return null;

		const recipeDiv = document.createElement("div");
		recipeDiv.classList.add("crafting-recipe");

		const ingredientsInfo = recipe.ingredients
			.map((ing) => {
				const ingDef = TextureDefinitions.find((t) => t.id === ing.itemId);
				return `${ing.count} ${ingDef ? ingDef.name : "Unknown"}`;
			})
			.join("\n");
		recipeDiv.title = `Craft ${recipe.resultCount}x ${textureDef.name}\nRequires:\n${ingredientsInfo}`;

		const inputWrap = document.createElement("div");
		inputWrap.classList.add("crafting-recipe-inputs");
		for (const ing of recipe.ingredients) {
			const ingDef = TextureDefinitions.find((t) => t.id === ing.itemId);
			if (!ingDef) continue;
			const slot = document.createElement("div");
			slot.classList.add("crafting-slot");

			const ingIcon = document.createElement("img");
			ingIcon.src = MaterialFactory.getTexturePathFromFolder(ingDef.path) ?? "";
			ingIcon.classList.add("crafting-icon");
			ingIcon.alt = ingDef.name;

			const count = document.createElement("span");
			count.classList.add("crafting-slot-count");
			count.innerText = `x${ing.count}`;

			slot.appendChild(ingIcon);
			slot.appendChild(count);
			inputWrap.appendChild(slot);
		}

		const arrow = document.createElement("div");
		arrow.classList.add("crafting-arrow");
		arrow.innerText = "→";

		const outputSlot = document.createElement("div");
		outputSlot.classList.add("crafting-slot", "crafting-slot-output");

		const icon = document.createElement("img");
		icon.src = MaterialFactory.getTexturePathFromFolder(textureDef.path) ?? "";
		icon.classList.add("crafting-icon");
		icon.alt = textureDef.name;

		const outCount = document.createElement("span");
		outCount.classList.add("crafting-slot-count");
		outCount.innerText = `x${recipe.resultCount}`;

		outputSlot.appendChild(icon);
		outputSlot.appendChild(outCount);

		const outWrap = document.createElement("div");
		outWrap.classList.add("crafting-recipe-output");
		outWrap.appendChild(outputSlot);

		recipeDiv.appendChild(inputWrap);
		recipeDiv.appendChild(arrow);
		recipeDiv.appendChild(outWrap);

		return recipeDiv;
	}

	/** Builds the "what can I make?" semantic search panel. */
	private createRecipeSearchPanel(): HTMLDivElement {
		const panel = document.createElement("div");
		panel.classList.add("recipe-search-panel");

		const title = document.createElement("div");
		title.classList.add("recipe-search-title");
		title.innerText = "Recipe Search";
		panel.appendChild(title);

		const hint = document.createElement("div");
		hint.classList.add("recipe-search-hint");
		hint.innerText = "Add items to find matching recipes";
		panel.appendChild(hint);

		const slotsRow = document.createElement("div");
		slotsRow.classList.add("recipe-search-slots");
		this.#recipeSearchSlotDivs = [];
		for (let i = 0; i < this.#recipeSearchSlots.length; i++) {
			const slot = document.createElement("div");
			slot.classList.add("recipe-search-slot");
			slot.dataset.index = String(i);
			slot.draggable = true;

			slot.onclick = () => {
				// Don't open picker if a drag just finished on this slot.
				if (this.#recipeSearchDragJustDropped) {
					this.#recipeSearchDragJustDropped = false;
					return;
				}
				this.openRecipeSearchPicker(i);
			};
			slot.addEventListener("dragstart", (e) => {
				const id = this.#recipeSearchSlots[i];
				if (id === null) {
					e.preventDefault();
					return;
				}
				draggedSearchItemId = id;
				e.dataTransfer?.setData("text/plain", String(id));
				slot.classList.add("dragging");
			});
			slot.addEventListener("dragend", () => {
				slot.classList.remove("dragging");
				draggedSearchItemId = null;
			});
			slot.addEventListener("dragover", (e) => {
				e.preventDefault();
				slot.classList.add("drag-over");
			});
			slot.addEventListener("dragleave", () => {
				slot.classList.remove("drag-over");
			});
			slot.addEventListener("drop", (e) => {
				e.preventDefault();
				slot.classList.remove("drag-over");
				const droppedId = this.readDroppedItemId(e);
				if (droppedId === null) return;
				// If dropping onto a slot that already holds an item and the
				// source was another search slot, swap them.
				if (
					draggedSearchItemId !== null &&
					this.#recipeSearchSlots[i] !== null
				) {
					const srcIndex = this.#recipeSearchSlots.indexOf(draggedSearchItemId);
					if (srcIndex !== -1 && srcIndex !== i) {
						const tmp = this.#recipeSearchSlots[i];
						this.#recipeSearchSlots[i] = draggedSearchItemId;
						this.#recipeSearchSlots[srcIndex] = tmp;
						this.renderRecipeSearchSlot(i);
						this.renderRecipeSearchSlot(srcIndex);
						this.updateRecipeSearchResults();
						this.#recipeSearchDragJustDropped = true;
						return;
					}
				}
				this.#recipeSearchSlots[i] = droppedId;
				this.renderRecipeSearchSlot(i);
				this.updateRecipeSearchResults();
				this.#recipeSearchDragJustDropped = true;
			});
			this.#recipeSearchSlotDivs.push(slot);
			slotsRow.appendChild(slot);
			this.renderRecipeSearchSlot(i);
		}
		panel.appendChild(slotsRow);

		const controls = document.createElement("div");
		controls.classList.add("recipe-search-controls");

		const clearBtn = document.createElement("button");
		clearBtn.innerText = "Clear";
		clearBtn.onclick = () => {
			for (let i = 0; i < this.#recipeSearchSlots.length; i++) {
				this.#recipeSearchSlots[i] = null;
				this.renderRecipeSearchSlot(i);
			}
			this.updateRecipeSearchResults();
		};
		controls.appendChild(clearBtn);
		panel.appendChild(controls);

		this.#recipeSearchResultsDiv = document.createElement("div");
		this.#recipeSearchResultsDiv.classList.add("recipe-search-results");
		panel.appendChild(this.#recipeSearchResultsDiv);

		return panel;
	}

	private renderRecipeSearchSlot(index: number): void {
		const slotDiv = this.#recipeSearchSlotDivs[index];
		if (!slotDiv) return;
		slotDiv.innerHTML = "";
		const itemId = this.#recipeSearchSlots[index];
		if (itemId === null) {
			slotDiv.classList.add("empty");
			const plus = document.createElement("span");
			plus.classList.add("recipe-search-slot-plus");
			plus.innerText = "+";
			slotDiv.appendChild(plus);
			return;
		}
		slotDiv.classList.remove("empty");
		const def = TextureDefinitions.find((t) => t.id === itemId);
		if (!def) return;
		const img = document.createElement("img");
		img.src = MaterialFactory.getTexturePathFromFolder(def.path) ?? "";
		img.classList.add("crafting-icon");
		img.alt = def.name;
		slotDiv.appendChild(img);

		const remove = document.createElement("span");
		remove.classList.add("recipe-search-slot-remove");
		remove.innerText = "×";
		remove.onclick = (e) => {
			e.stopPropagation();
			this.#recipeSearchSlots[index] = null;
			this.renderRecipeSearchSlot(index);
			this.updateRecipeSearchResults();
		};
		slotDiv.appendChild(remove);
	}

	/** Drops an item id into the first empty search slot (or replaces the
	 *  first slot if all are full). Used by double-click on an inventory slot. */
	addItemToFirstFreeSearchSlot(itemId: number): void {
		let target = this.#recipeSearchSlots.indexOf(null);
		if (target === -1) target = 0;
		this.#recipeSearchSlots[target] = itemId;
		this.renderRecipeSearchSlot(target);
		this.updateRecipeSearchResults();
	}

	private openRecipeSearchPicker(slotIndex: number): void {
		this.closeRecipeSearchPicker();

		const overlay = document.createElement("div");
		overlay.classList.add("recipe-picker-overlay");
		overlay.onclick = (e) => {
			if (e.target === overlay) this.closeRecipeSearchPicker();
		};

		const picker = document.createElement("div");
		picker.classList.add("recipe-picker");

		const searchInput = document.createElement("input");
		searchInput.type = "text";
		searchInput.placeholder = "Search items...";
		searchInput.classList.add("recipe-picker-search");
		picker.appendChild(searchInput);

		const grid = document.createElement("div");
		grid.classList.add("recipe-picker-grid");

		const renderItems = (filter: string) => {
			grid.innerHTML = "";
			const f = filter.trim().toLowerCase();
			const defs = TextureDefinitions.filter(
				(d) => !f || d.name.toLowerCase().includes(f),
			);
			for (const def of defs) {
				const item = document.createElement("div");
				item.classList.add("recipe-picker-item");
				const img = document.createElement("img");
				img.src = MaterialFactory.getTexturePathFromFolder(def.path) ?? "";
				img.classList.add("crafting-icon");
				img.alt = def.name;
				img.draggable = false;
				img.style.pointerEvents = "none";
				const label = document.createElement("span");
				label.innerText = def.name;
				label.style.pointerEvents = "none";
				item.appendChild(img);
				item.appendChild(label);
				item.draggable = false;
				item.onclick = () => {
					this.#recipeSearchSlots[slotIndex] = def.id;
					this.renderRecipeSearchSlot(slotIndex);
					this.updateRecipeSearchResults();
					this.closeRecipeSearchPicker();
				};
				grid.appendChild(item);
			}
		};
		renderItems("");
		searchInput.oninput = () => renderItems(searchInput.value);
		picker.appendChild(grid);

		const doneBtn = document.createElement("button");
		doneBtn.innerText = "Done";
		doneBtn.classList.add("recipe-picker-done");
		doneBtn.onclick = () => this.closeRecipeSearchPicker();
		picker.appendChild(doneBtn);

		overlay.appendChild(picker);
		document.body.appendChild(overlay);
		this.#recipePickerOverlay = overlay;
		setTimeout(() => searchInput.focus(), 0);
	}

	private closeRecipeSearchPicker(): void {
		if (this.#recipePickerOverlay) {
			this.#recipePickerOverlay.remove();
			this.#recipePickerOverlay = null;
		}
	}

	/** Reads an item id dropped onto a search slot. Supports drops from the
	 *  inventory (dataTransfer carries "inv:<id>") and from other search slots
	 *  (dataTransfer carries the raw id, mirrored by `draggedSearchItemId`). */
	private readDroppedItemId(e: DragEvent): number | null {
		const raw = e.dataTransfer?.getData("text/plain") ?? "";
		if (raw.startsWith("inv:")) {
			const id = Number(raw.slice(4));
			return Number.isFinite(id) ? id : null;
		}
		if (raw !== "" && Number.isFinite(Number(raw))) {
			return Number(raw);
		}
		return draggedSearchItemId;
	}

	/** Scores every recipe against the selected search items and renders
	 *  the best matches (highest ingredient overlap) at the top. */
	private updateRecipeSearchResults(): void {
		const selected = this.#recipeSearchSlots.filter(
			(id): id is number => id !== null,
		);
		this.#recipeSearchResultsDiv.innerHTML = "";

		if (selected.length === 0) {
			const empty = document.createElement("div");
			empty.classList.add("recipe-search-empty");
			this.#recipeSearchResultsDiv.appendChild(empty);
			return;
		}

		const scored = Recipes.map((recipe) => {
			const needIds = new Set(recipe.ingredients.map((i) => i.itemId));
			let matched = 0;
			for (const id of selected) {
				if (needIds.has(id)) matched++;
			}
			const extra = recipe.ingredients.filter(
				(i) => !selected.includes(i.itemId),
			).length;
			const score = matched * 10 - extra;
			return { recipe, matched, score };
		})
			.filter((r) => r.matched > 0)
			.sort((a, b) => b.score - a.score);

		if (scored.length === 0) {
			const none = document.createElement("div");
			none.classList.add("recipe-search-empty");
			none.innerText = "No recipes use those items";
			this.#recipeSearchResultsDiv.appendChild(none);
			return;
		}

		for (const { recipe, matched } of scored) {
			const card = this.createRecipeCard(recipe);
			if (!card) continue;
			card.classList.add("recipe-search-result");
			if (matched === recipe.ingredients.length) {
				card.classList.add("recipe-search-exact");
			}
			card.onclick = () => this.craftRecipe(card, recipe);
			this.#recipeSearchResultsDiv.appendChild(card);
		}
	}

	/** Updates the "craftable" styling of the static recipe list based on
	 *  current inventory contents. */
	updateCraftingAvailability(): void {
		for (const item of this.#craftingRecipeDivs) {
			let canCraft = true;
			for (const ing of item.recipe.ingredients) {
				if (!this.#inventory.hasItem(ing.itemId, ing.count)) {
					canCraft = false;
					break;
				}
			}

			if (canCraft) {
				item.div.classList.remove("not-craftable");
				item.div.style.borderColor = "";
			} else {
				item.div.classList.add("not-craftable");
			}
		}
	}

	/** Re-renders search results after the inventory changed. */
	refreshAvailability(): void {
		this.updateCraftingAvailability();
	}

	/** Closes any open picker (e.g. when the inventory overlay is hidden). */
	closePicker(): void {
		this.closeRecipeSearchPicker();
	}
}
