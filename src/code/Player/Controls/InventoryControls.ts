import { Vector3 } from "@babylonjs/core";
import { IControls } from "./IControls";
import { Player } from "../Player";
import { PlayerInventory } from "../Inventory/PlayerInventory";

export class InventoryControls implements IControls<unknown> {
  controlledEntity: unknown;
  pressedKeys: Set<string>;
  inputDirection: Vector3;

  #underlyingControls: IControls<unknown>;

  #player: Player;

  public static KEY_INVENTORY = ["tab", "escape"];
  public static KEY_DROP = ["q"];
  public static KEY_CTRL = ["control"];
  public static MOUSE1_INVENTORY = [0];

  constructor(
    controlledEntity: unknown,
    underlyingControls: IControls<unknown>,
    player: Player
  ) {
    this.controlledEntity = controlledEntity;
    this.pressedKeys = new Set<string>();
    this.inputDirection = Vector3.Zero();

    this.#underlyingControls = underlyingControls;
    this.#player = player;
  }
  handleKeyEvent(key: string, isKeyDown: boolean): void {
    if (isKeyDown) this.onKeyDown(key);
    else this.onKeyUp(key);

    if (InventoryControls.KEY_INVENTORY.includes(key) && !isKeyDown) {
      this.#underlyingControls.handleKeyEvent(key, isKeyDown);
      this.#player.keyboardControls = this.#underlyingControls;
      return;
    }
    if (InventoryControls.KEY_DROP.includes(key) && isKeyDown) {
      const item = PlayerInventory.currentlyHoveredSlot?.item;
      if (item) {
        if (this.#pressedKeysHas(InventoryControls.KEY_CTRL))
          this.#player.playerInventory.dropItem(item, item.stackSize);
        else this.#player.playerInventory.dropItem(item, 1);
      }
      return;
    }
    this.#underlyingControls.handleKeyEvent(key, isKeyDown);
  }

  handleMouseEvent(mouseEvent: MouseEvent, isKeyDown: boolean): void {
    if (
      InventoryControls.MOUSE1_INVENTORY.includes(mouseEvent.button) &&
      mouseEvent.shiftKey
    ) {
      this.#moveItemToHotbar();
    }
  }

  #moveItemToHotbar(): void {
    const slotFocused = PlayerInventory.currentlyHoveredSlot;
    if (slotFocused && slotFocused.item) {
      if (slotFocused.item.row > 0) {
        this.#player.playerInventory.moveItemToHotbar(slotFocused);
      } else {
        this.#player.playerInventory.moveItemToInventory(slotFocused);
      }
    }
  }

  onKeyUp(key: string): void {
    this.pressedKeys.delete(key);
  }
  onKeyDown(key: string): void {
    this.pressedKeys.add(key);
  }
  #pressedKeysHas(keys: string[]) {
    return keys.some((k) => this.pressedKeys.has(k));
  }
  public get underlyingControls(): IControls<unknown> {
    return this.#underlyingControls;
  }
  public set underlyingControls(value: IControls<unknown>) {
    this.#underlyingControls = value;
  }
}
