import { PointerEventTypes, Scene } from "@babylonjs/core";

import { IControls } from "../Inferface/IControls";
import { Map1 } from "../Maps/Map1";
import { InventoryControls } from "./Controls/InventoryControls";
import { WalkingControls } from "./Controls/WalkingControls";
import { PlayerCamera } from "./PlayerCamera";

type KeyEventHandler = (key: string, isKeyDown: boolean) => void;

export class PlayerInputController {
  constructor(
    private readonly scene: Scene,
    private readonly canvas: HTMLCanvasElement,
    private readonly playerCamera: PlayerCamera,
    private readonly onKeyEvent: KeyEventHandler,
    private readonly getKeyboardControls: () => IControls<unknown>,
    private readonly onPauseRequested: () => void,
  ) {}

  public bind(): void {
    this.bindKeyboardInput();
    this.bindPointerLock();
    this.bindMouseButtons();
    this.bindPointerObserver();
  }

  private bindKeyboardInput(): void {
    window.addEventListener("keydown", (event) => {
      event.preventDefault();
      this.onKeyEvent(event.key.toLowerCase(), true);
    });

    window.addEventListener("keyup", (event) => {
      event.preventDefault();
      this.onKeyEvent(event.key.toLowerCase(), false);
    });
  }

  private bindPointerLock(): void {
    this.canvas.addEventListener("click", () => {
      if (document.pointerLockElement !== this.canvas) {
        this.canvas.requestPointerLock();
      }
    });

    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== this.canvas && Map1.timeScale > 0) {
        this.onPauseRequested();
      }
    });
  }

  private bindMouseButtons(): void {
    window.addEventListener("mousedown", (event) => {
      const controls = this.getKeyboardControls();
      if (controls instanceof InventoryControls) {
        controls.handleMouseEvent(event);
      } else if (controls instanceof WalkingControls) {
        controls.handleMouseEvent(event, true);
      }
    });

    window.addEventListener("mouseup", (event) => {
      const controls = this.getKeyboardControls();
      if (controls instanceof WalkingControls) {
        controls.handleMouseEvent(event, false);
      }
    });
  }

  private bindPointerObserver(): void {
    this.scene.onPointerObservable.add((pointerInfo) => {
      if (document.pointerLockElement !== this.canvas) return;

      switch (pointerInfo.type) {
        case PointerEventTypes.POINTERMOVE:
          this.playerCamera.handleMouseMovement(
            pointerInfo.event.movementX,
            pointerInfo.event.movementY,
          );
          break;
        case PointerEventTypes.POINTERWHEEL: {
          const wheelEvent = pointerInfo.event as WheelEvent;
          if (wheelEvent.deltaY > 0) {
            this.onKeyEvent("wheel_down", false);
          } else if (wheelEvent.deltaY < 0) {
            this.onKeyEvent("wheel_up", false);
          }
          break;
        }
      }
    });
  }
}
