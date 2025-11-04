import { Engine, Scene } from "@babylonjs/core";
import { Player } from "../Player";
import { CrossHair } from "../Hud/CrossHair";
import { PlayerInventory } from "../Inventory/PlayerInventory";
import { PlayerCamera } from "../PlayerCamera";

export class PlayerHud {
  #engine: Engine;
  #scene: Scene;

  static #inventory: PlayerInventory;
  #inventoryOpen = false;
  #crosshair: CrossHair;

  #selectedHotbarSlot = 0;
  #hotbarSlots: HTMLDivElement[] = [];

  #overlayDiv: HTMLDivElement;

  private static debugPanelDiv: HTMLDivElement;
  private static infoLines: { [key: string]: string } = {};

  constructor(
    engine: Engine,
    scene: Scene,
    player: Player,
    playerCamera: PlayerCamera
  ) {
    this.#engine = engine;
    this.#scene = scene;
    PlayerHud.#inventory = player.playerInventory;
    this.#crosshair = new CrossHair(engine, playerCamera, scene);
    this.#overlayDiv = this.initializeHUD();
    this.createHotbarUI();
    this.initializeDebugPanel();
  }

  private initializeHUD(): HTMLDivElement {
    const overlayDiv = document.createElement("div");
    overlayDiv.style.display = "none";
    overlayDiv.classList.add("hud-overlay");

    const closeButton = document.createElement("button");
    closeButton.innerHTML = "&times;";
    closeButton.classList.add("hud-close-button");
    closeButton.onclick = () => this.toggleInventory();

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
    const hotbarContainer = document.createElement("div");
    hotbarContainer.classList.add("hotbar-container");

    const hotbarRow = PlayerHud.#inventory.inventory[0];
    for (let col = 0; col < hotbarRow.length; col++) {
      const slot = this.getSlot(col, 0);
      if (!slot) continue;
      hotbarContainer.appendChild(slot);
      this.#hotbarSlots.push(slot); // Store every slot
    }

    this.updateHotbarSelection();
    document.body.appendChild(hotbarContainer);

    this.#scene.onDisposeObservable.add(() => {
      hotbarContainer.remove();
    });
    return hotbarContainer;
  }

  private getSlot(column: number, row: number): HTMLDivElement | null {
    return PlayerHud.#inventory.inventory[row][column].divItemSlot;
  }

  public toggleInventory(): void {
    this.#inventoryOpen = !this.#inventoryOpen;
    if (this.#inventoryOpen) {
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
      // Add 'selected' class if it's the selected slot, remove it otherwise
      slot.classList.toggle("selected", index === this.#selectedHotbarSlot);
    });
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
    let html = "";
    for (const key in this.infoLines) {
      html += `<div><strong>${key}:</strong> ${this.infoLines[key]}</div>`;
    }
    if (this.debugPanelDiv) this.debugPanelDiv.innerHTML = html;
  }
}
