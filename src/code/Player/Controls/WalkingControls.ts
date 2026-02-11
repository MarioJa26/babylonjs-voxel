import { Player } from "../Player";
import { IControls } from "../../Inferface/IControls";
import { Vector3 } from "@babylonjs/core";
import { CrossHair } from "../Hud/CrossHair";
import { PlayerVehicle } from "../PlayerVehicle";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";
import { GlobalValues } from "@/code/World/GlobalValues";
import { PlayerHud } from "../Hud/PlayerHud";
import { Map1 } from "@/code/Maps/Map1";
import { BlockBreakParticles } from "@/code/Maps/BlockBreakParticles";
import {
  getBlockBreakTime,
  getBlockInfo,
} from "@/code/World/Texture/TextureDefinitions";
import { Item } from "../Inventory/Item";
import { DroppedItem } from "../Inventory/DroppedItem";

export class WalkingControls implements IControls<PlayerVehicle> {
  public pressedKeys = new Set<string>();
  #controlledEntity: PlayerVehicle;
  #inputDirection: Vector3;

  #player: Player;

  #isBreaking = false;
  #breakingBlock: { x: number; y: number; z: number } | null = null;
  #breakTimer = 0;

  public static KEY_LEFT = ["a", "arrowleft"];
  public static KEY_RIGHT = ["d", "arrowright"];
  public static KEY_UP = ["w", "arrowup"];
  public static KEY_DOWN = ["s", "arrowdown"];
  public static KEY_USE = ["e"];
  public static KEY_PICK_BLOCK = ["r"];
  public static KEY_JUMP = [" "];
  public static KEY_SPRINT = ["shift"];
  public static KEY_FLASH = ["f"];
  public static KEY_INVENTORY = ["tab"];
  public static KEY_DROP = ["q"];
  public static KEY_CTRL = ["control"];
  public static KEY_ALT = ["alt"];

  public static MOUSE_WHEEL_UP = ["wheel_up"];
  public static MOUSE_WHEEL_DOWN = ["wheel_down"];

  public static MOUSE1 = [0];
  public static MOUSE2 = [2];

  public static KEY_1 = ["1", "!"];
  public static KEY_2 = ["2", '"'];
  public static KEY_3 = ["3", "§"];
  public static KEY_4 = ["4", "$"];
  public static KEY_5 = ["5", "%"];
  public static KEY_6 = ["6", "&"];
  public static KEY_7 = ["7", "/"];
  public static KEY_8 = ["8", "("];
  public static KEY_9 = ["9", ")"];
  public static KEY_0 = ["0", "="];

  public static KEY_F2 = ["f2"];
  public static KEY_F3 = ["f3"];
  public static KEY_F5 = ["f5"];
  public static KEY_F6 = ["f6"];

  constructor(player: Player) {
    this.#controlledEntity = player.playerVehicle;
    this.#inputDirection = player.playerVehicle.inputDirection;
    this.#player = player;
  }

  public handleKeyEvent(key: string, isKeyDown: boolean) {
    if (isKeyDown) {
      this.onKeyDown(key);
    } else {
      this.onKeyUp(key);
    }
  }
  public handleMouseEvent(mouseEvent: MouseEvent, isKeyDown: boolean): void {
    if (WalkingControls.MOUSE1.includes(mouseEvent.button)) {
      this.#isBreaking = isKeyDown;
      if (!isKeyDown) {
        this.#breakingBlock = null;
        this.#breakTimer = 0;
        Map1.updateCrackingState(null, 0);
      }
    } else if (
      WalkingControls.MOUSE2.includes(mouseEvent.button) &&
      isKeyDown
    ) {
      const item =
        this.#player.playerInventory.inventory[0][
          this.#player.playerHud.selectedHotbarSlot
        ]?.item;

      if (item) {
        item.use(this.#player);
      }
    }
  }

  public update(): void {
    if (this.#isBreaking) {
      const dt =
        this.#player.playerVehicle.scene.getEngine().getDeltaTime() / 1000;
      const hit = CrossHair.pickTarget(this.#player);

      if (hit) {
        const blockId = ChunkLoadingSystem.getBlockByWorldCoords(
          hit.x,
          hit.y,
          hit.z,
        );
        const item =
          this.#player.playerInventory.inventory[0][
            this.#player.playerHud.selectedHotbarSlot
          ]?.item;

        const breakTime = getBlockBreakTime(blockId, item?.itemId);

        if (
          this.#breakingBlock &&
          this.#breakingBlock.x === hit.x &&
          this.#breakingBlock.y === hit.y &&
          this.#breakingBlock.z === hit.z
        ) {
          this.#breakTimer += dt;
          Map1.updateCrackingState(
            this.#breakingBlock,
            this.#breakTimer / breakTime,
          );
          if (this.#breakTimer >= breakTime) {
            this.#breakBlock(hit.x, hit.y, hit.z, blockId);
          }
        } else {
          this.#breakingBlock = { x: hit.x, y: hit.y, z: hit.z };
          this.#breakTimer = 0;
          Map1.updateCrackingState(this.#breakingBlock, 0);
        }
      } else {
        this.#breakingBlock = null;
        this.#breakTimer = 0;
        Map1.updateCrackingState(null, 0);
      }
    }
  }

  public onKeyDown(key: string) {
    this.pressedKeys.add(key);
    if (WalkingControls.KEY_UP.includes(key)) {
      this.#inputDirection.z = 1;
    } else if (WalkingControls.KEY_DOWN.includes(key)) {
      this.#inputDirection.z = -1;
    } else if (WalkingControls.KEY_RIGHT.includes(key)) {
      this.#inputDirection.x = 1;
    } else if (WalkingControls.KEY_LEFT.includes(key)) {
      this.#inputDirection.x = -1;
    } else if (WalkingControls.KEY_JUMP.includes(key)) {
      this.#controlledEntity.wantJump++;
    } else if (WalkingControls.KEY_SPRINT.includes(key)) {
      this.#controlledEntity.isSprinting = true;
    } else if (WalkingControls.KEY_USE.includes(key)) {
      this.#player.use();
    } else if (WalkingControls.KEY_FLASH.includes(key)) {
      this.#player.flashlight.toggle();
    } else if (WalkingControls.KEY_F2.includes(key)) {
      GlobalValues.DEBUG = !GlobalValues.DEBUG;
    } else if (WalkingControls.KEY_F3.includes(key)) {
      PlayerHud.toggleDebugInfo();
    } else if (key === "l") {
      this.#player.position.y += 50;
    }

    if (WalkingControls.KEY_DROP.includes(key)) {
      const item =
        this.#player.playerInventory.inventory[0][
          this.#player.playerHud.selectedHotbarSlot
        ]?.item;
      if (item) {
        if (this.#pressedKeysHas(WalkingControls.KEY_CTRL))
          this.#player.playerInventory.dropItem(item, item.stackSize);
        else this.#player.playerInventory.dropItem(item, 1);
      }
      return;
    }
  }
  public onKeyUp(key: string) {
    if (WalkingControls.KEY_UP.includes(key)) {
      if (this.#pressedKeysHas(WalkingControls.KEY_DOWN)) {
        this.#inputDirection.z = -1;
      } else {
        this.#inputDirection.z = 0;
      }
    } else if (WalkingControls.KEY_DOWN.includes(key)) {
      if (this.#pressedKeysHas(WalkingControls.KEY_UP)) {
        this.#inputDirection.z = 1;
      } else {
        this.#inputDirection.z = 0;
      }
    }

    if (WalkingControls.KEY_LEFT.includes(key)) {
      if (this.#pressedKeysHas(WalkingControls.KEY_RIGHT)) {
        this.#inputDirection.x = 1;
      } else {
        this.#inputDirection.x = 0;
      }
    } else if (WalkingControls.KEY_RIGHT.includes(key)) {
      if (this.#pressedKeysHas(WalkingControls.KEY_LEFT)) {
        this.#inputDirection.x = -1;
      } else {
        this.#inputDirection.x = 0;
      }
    }
    if (WalkingControls.KEY_JUMP.includes(key)) {
      this.#controlledEntity.wantJump = 0;
    }
    if (WalkingControls.KEY_SPRINT.includes(key)) {
      this.#controlledEntity.isSprinting = false;
    }
    if (WalkingControls.MOUSE_WHEEL_UP.includes(key)) {
      this.#player.playerHud.selectedHotbarSlot =
        (this.#player.playerHud.selectedHotbarSlot - 1) % 10;
      if (this.#player.playerHud.selectedHotbarSlot < 0)
        this.#player.playerHud.selectedHotbarSlot = 9;
    } else {
      if (WalkingControls.MOUSE_WHEEL_DOWN.includes(key)) {
        this.#player.playerHud.selectedHotbarSlot =
          (this.#player.playerHud.selectedHotbarSlot + 1) % 10;
      }
    }
    if (
      WalkingControls.KEY_F5.includes(key) ||
      (this.#pressedKeysHas(WalkingControls.KEY_ALT) &&
        WalkingControls.MOUSE_WHEEL_DOWN.includes(key))
    ) {
      this.#controlledEntity.camera.zoomOut();
    } else if (
      WalkingControls.KEY_F6.includes(key) ||
      (this.#pressedKeysHas(WalkingControls.KEY_ALT) &&
        WalkingControls.MOUSE_WHEEL_UP.includes(key))
    ) {
      this.#controlledEntity.camera.zoomIn();
    }

    if (WalkingControls.KEY_PICK_BLOCK.includes(key)) {
      const hit = CrossHair.pickTarget(this.#player);
      if (!hit) return;
      const blockId = ChunkLoadingSystem.getBlockByWorldCoords(
        hit.x,
        hit.y,
        hit.z,
      );
      if (blockId === 0) return; // Don't pick air

      // 1. Check hotbar first
      for (let i = 0; i < 10; i++) {
        const hotbarItemId =
          this.#player.playerInventory.inventory[0][i].item?.itemId;
        if (hotbarItemId === blockId) {
          this.#player.playerHud.selectedHotbarSlot = i;
          return;
        }
      }

      // 2. If not in hotbar, check main inventory and swap with current hotbar item
      const inventory = this.#player.playerInventory.inventory;
      for (let r = 1; r < inventory.length; r++) {
        for (let c = 0; c < inventory[r].length; c++) {
          const inventoryItemId = inventory[r][c].item?.itemId;
          if (inventoryItemId === blockId) {
            // Found in inventory, swap with selected hotbar slot
            const selectedSlot = this.#player.playerHud.selectedHotbarSlot;
            const hotbarSlot = inventory[0][selectedSlot];
            const inventorySlot = inventory[r][c];
            hotbarSlot.swapSlots(inventorySlot);

            return;
          }
        }
      }
    }

    if (WalkingControls.KEY_INVENTORY.includes(key)) {
      this.#player.playerHud.toggleInventory();
      this.#player.playerInventory.inventoryControls.underlyingControls = this;
      this.#player.keyboardControls =
        this.#player.playerInventory.inventoryControls;
    }

    if (WalkingControls.KEY_1.includes(key)) {
      this.#player.playerHud.selectedHotbarSlot = 0;
    } else if (WalkingControls.KEY_2.includes(key)) {
      this.#player.playerHud.selectedHotbarSlot = 1;
    } else if (WalkingControls.KEY_3.includes(key)) {
      this.#player.playerHud.selectedHotbarSlot = 2;
    } else if (WalkingControls.KEY_4.includes(key)) {
      this.#player.playerHud.selectedHotbarSlot = 3;
    } else if (WalkingControls.KEY_5.includes(key)) {
      this.#player.playerHud.selectedHotbarSlot = 4;
    } else if (WalkingControls.KEY_6.includes(key)) {
      this.#player.playerHud.selectedHotbarSlot = 5;
    } else if (WalkingControls.KEY_7.includes(key)) {
      this.#player.playerHud.selectedHotbarSlot = 6;
    } else if (WalkingControls.KEY_8.includes(key)) {
      this.#player.playerHud.selectedHotbarSlot = 7;
    } else if (WalkingControls.KEY_9.includes(key)) {
      this.#player.playerHud.selectedHotbarSlot = 8;
    } else if (WalkingControls.KEY_0.includes(key)) {
      this.#player.playerHud.selectedHotbarSlot = 9;
    }

    this.pressedKeys.delete(key);
  }
  #pressedKeysHas(keys: string[]) {
    return keys.some((k) => this.pressedKeys.has(k));
  }

  #breakBlock(x: number, y: number, z: number, blockId: number) {
    const info = getBlockInfo(blockId);
    if (!info) return;

    const worldItem = Item.createById(blockId);
    worldItem.stackSize = 1;
    worldItem.itemId = blockId;

    new DroppedItem(worldItem, x + 0.5, y + 0.5, z + 0.5);

    BlockBreakParticles.play(
      this.#player.playerVehicle.scene,
      new Vector3(x + 0.5, y + 0.5, z + 0.5),
      blockId,
    );
    this.#breakTimer = 0;
    Map1.updateCrackingState(null, 0);

    ChunkLoadingSystem.deleteBlock(x, y, z);
  }

  public get controlledEntity(): PlayerVehicle {
    return this.#controlledEntity;
  }

  public get inputDirection(): Vector3 {
    return this.#inputDirection;
  }
}
