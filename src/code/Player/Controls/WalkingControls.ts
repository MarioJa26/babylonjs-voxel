import { Player } from "../Player";
import { IControls } from "../Controls/IControls";
import { Vector3 } from "@babylonjs/core";
import { CrossHair } from "../Hud/CrossHair";
import { PlayerVehicle } from "../PlayerVehicle";
import { World } from "@/code/World/World";
import { GlobalValues } from "@/code/World/GlobalValues";
import { PlayerHud } from "../Hud/PlayerHud";

export class WalkingControls implements IControls<PlayerVehicle> {
  public pressedKeys = new Set<string>();
  #controlledEntity: PlayerVehicle;
  #inputDirection: Vector3;

  #player: Player;

  public static KEY_LEFT = ["a", "arrowleft"];
  public static KEY_RIGHT = ["d", "arrowright"];
  public static KEY_UP = ["w", "arrowup"];
  public static KEY_DOWN = ["s", "arrowdown"];
  public static KEY_USE = ["e"];
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
    if (WalkingControls.MOUSE1.includes(mouseEvent.button) && isKeyDown) {
      const hit = CrossHair.pickTarget(this.#player);
      if (!hit) return;
      World.deleteBlock(hit.x, hit.y, hit.z);
    } else if (WalkingControls.MOUSE2.includes(mouseEvent.button)) {
      const item =
        this.#player.playerInventory.inventory[0][
          this.#player.playerHud.selectedHotbarSlot
        ]?.item;

      if (item) {
        const hit = CrossHair.pickMesh(this.#player);
        if (!hit) return;
        World.setBlock(hit.x, hit.y, hit.z, item.itemId);
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
      PlayerHud.showDebugPanel();
    } else if (key === "l") {
      this.#player.position.y = 100;
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
    }
    if (
      WalkingControls.KEY_F6.includes(key) ||
      (this.#pressedKeysHas(WalkingControls.KEY_ALT) &&
        WalkingControls.MOUSE_WHEEL_UP.includes(key))
    ) {
      this.#controlledEntity.camera.zoomIn();
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
  public get controlledEntity(): PlayerVehicle {
    return this.#controlledEntity;
  }

  public get inputDirection(): Vector3 {
    return this.#inputDirection;
  }
}
