import { Engine, Scene } from "@babylonjs/core";
import { Player } from "../Player";
import { Map1 } from "@/code/Maps/Map1";
import { CrossHair } from "../Hud/CrossHair";
import { PlayerInventory } from "../Inventory/PlayerInventory";
import { PlayerCamera } from "../PlayerCamera";

export class PlayerHud {
  #engine: Engine;
  #scene: Scene;
  #player: Player;

  static #inventory: PlayerInventory;
  #inventoryOpen = false;
  #crosshair: CrossHair;

  #selectedHotbarSlot = 0;
  #hotbarSlots: HTMLDivElement[] = [];
  static #heldItemNameDiv: HTMLDivElement = document.createElement("div");
  #heldItemNameTimeout?: number;

  #overlayDiv: HTMLDivElement;

  static debugPanelDiv: HTMLDivElement;
  private static infoLines: { [key: string]: string } = {};
  private static itemTooltipDiv: HTMLDivElement;
  private static itemTooltipMouseMove?: (e: MouseEvent) => void;

  constructor(
    engine: Engine,
    scene: Scene,
    player: Player,
    playerCamera: PlayerCamera
  ) {
    this.#engine = engine;
    this.#scene = scene;
    this.#player = player;
    PlayerHud.#inventory = player.playerInventory;
    this.#crosshair = new CrossHair(engine, playerCamera, scene);
    this.#overlayDiv = this.initializeHUD();
    this.createHotbarUI();
    this.initializeDebugPanel();
    this.initializeTooltip();
  }

  private initializeHUD(): HTMLDivElement {
    const existingOverlay = document.getElementById("hud-overlay");
    if (existingOverlay) {
      return existingOverlay as HTMLDivElement;
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

    const inventoryUI = this.createInventoryUI();

    overlayDiv.appendChild(inventoryUI);
    overlayDiv.appendChild(closeButton);
    document.body.appendChild(overlayDiv);

    this.#scene.onDisposeObservable.add(() => {
      overlayDiv.remove();
      document.exitPointerLock();
    });

    return overlayDiv;
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

  private getSlot(column: number, row: number): HTMLDivElement | null {
    return PlayerHud.#inventory.inventory[row][column].divItemSlot;
  }

  public toggleInventory(): void {
    this.#inventoryOpen = !this.#inventoryOpen;
    if (this.#inventoryOpen) {
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
  }

  public static showDebugPanel(): void {
    if (this.debugPanelDiv) this.debugPanelDiv.style.display = "block";
  }

  public static hideDebugPanel(): void {
    if (this.debugPanelDiv) this.debugPanelDiv.style.display = "none";
  }

  public static updateDebugInfo(key: string, value: string | number): void {
    this.infoLines[key] = String(value);
    this.renderDebugInfo();
  }

  private static renderDebugInfo(): void {
    if (!this.debugPanelDiv) return;

    let html = "";
    for (const key in this.infoLines) {
      html += `<div><strong>${key}:</strong> ${this.infoLines[key]}</div>`;
    }

    // Keep the slider by only updating the text content part
    const textContainer =
      this.debugPanelDiv.querySelector("div.info-container") ||
      document.createElement("div");
    textContainer.className = "info-container";
    textContainer.innerHTML = html;

    if (!textContainer.parentElement) {
      this.debugPanelDiv.prepend(textContainer);
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
    if (!this.itemTooltipDiv) return;

    this.itemTooltipDiv.innerText = text;
    this.itemTooltipDiv.style.display = "block";

    // Update position immediately and then follow the cursor
    const updatePos = (e: MouseEvent) => {
      // small offset so tooltip doesn't overlap the cursor
      const offsetX = 12;
      const offsetY = 32;
      this.itemTooltipDiv.style.left = `${e.clientX + offsetX}px`;
      this.itemTooltipDiv.style.top = `${e.clientY - offsetY}px`;
    };

    // Set initial position from the original event
    updatePos(event);

    // Remove any previous listener to avoid duplicates
    if (this.itemTooltipMouseMove) {
      document.removeEventListener("mousemove", this.itemTooltipMouseMove);
    }

    this.itemTooltipMouseMove = updatePos;
    document.addEventListener("mousemove", this.itemTooltipMouseMove);
  }

  public static hideItemTooltip(): void {
    if (!this.itemTooltipDiv) return;

    this.itemTooltipDiv.style.display = "none";

    if (this.itemTooltipMouseMove) {
      document.removeEventListener("mousemove", this.itemTooltipMouseMove);
      this.itemTooltipMouseMove = undefined;
    }
  }
}
