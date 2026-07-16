import type { IControls } from "../Interface/IControls";
import { isUiOpen } from "../Shared/GameRuntimeState";
import type { InventoryControls } from "./Controls/InventoryControls";
import type { WalkingControls } from "./Controls/WalkingControls";
import type { PlayerCamera } from "./PlayerCamera";

type KeyEventHandler = (key: string, isKeyDown: boolean) => void;

export class PlayerInputController {
	#onKeyDown: (event: KeyboardEvent) => void;
	#onKeyUp: (event: KeyboardEvent) => void;
	#onCanvasClick: () => void;
	#onPointerLockChange: () => void;
	#onMouseDown: (event: MouseEvent) => void;
	#onMouseUp: (event: MouseEvent) => void;
	#onPointerMove: (event: MouseEvent) => void;
	#onWheel: (event: WheelEvent) => void;
	#pointerObs: any = null;

	constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly playerCamera: PlayerCamera,
		private readonly onKeyEvent: KeyEventHandler,
		private readonly getKeyboardControls: () => IControls<unknown>,
		private readonly onPauseRequested: () => void,
	) {
		this.#onKeyDown = (event) => {
			event.preventDefault();
			this.onKeyEvent(event.key.toLowerCase(), true);
		};
		this.#onKeyUp = (event) => {
			event.preventDefault();
			this.onKeyEvent(event.key.toLowerCase(), false);
		};
		this.#onCanvasClick = () => {
			if (document.pointerLockElement !== this.canvas) {
				this.canvas.requestPointerLock();
			}
		};
		this.#onPointerLockChange = () => {
			// Only treat a lost pointer lock as a pause request when NO UI surface
			// is open. Menus (inventory, mason table) release the lock themselves;
			// those must NOT trigger the pause menu.
			if (document.pointerLockElement !== this.canvas && !isUiOpen()) {
				this.onPauseRequested();
			}
		};
		this.#onMouseDown = (event) => {
			const controls = this.getKeyboardControls();
			if (controls.controlType === "inventory") {
				(controls as InventoryControls).handleMouseEvent(event);
			} else if (controls.controlType === "walking") {
				// World interactions (break/place) only apply when the canvas owns
				// the pointer. While an overlay (inventory/mason) is open the pointer
				// is unlocked, so these clicks must be ignored — otherwise the player
				// could break/place blocks through the menu.
				if (document.pointerLockElement !== this.canvas) return;
				(controls as WalkingControls).handleMouseEvent(event, true);
			}
		};
		this.#onMouseUp = (event) => {
			const controls = this.getKeyboardControls();
			if (controls.controlType === "walking") {
				if (document.pointerLockElement !== this.canvas) return;
				(controls as WalkingControls).handleMouseEvent(event, false);
			}
		};
		this.#onPointerMove = (event: MouseEvent) => {
			if (document.pointerLockElement !== this.canvas) return;
			this.playerCamera.handleMouseMovement(event.movementX, event.movementY);
		};
		this.#onWheel = (event: WheelEvent) => {
			if (event.deltaY > 0) {
				this.onKeyEvent("wheel_down", false);
			} else if (event.deltaY < 0) {
				this.onKeyEvent("wheel_up", false);
			}
		};
	}

	public bind(): void {
		window.addEventListener("keydown", this.#onKeyDown);
		window.addEventListener("keyup", this.#onKeyUp);
		this.canvas.addEventListener("click", this.#onCanvasClick);
		document.addEventListener("pointerlockchange", this.#onPointerLockChange);
		window.addEventListener("mousedown", this.#onMouseDown);
		window.addEventListener("mouseup", this.#onMouseUp);
		this.canvas.addEventListener("mousemove", this.#onPointerMove);
		this.canvas.addEventListener("wheel", this.#onWheel);
	}

	public dispose(): void {
		window.removeEventListener("keydown", this.#onKeyDown);
		window.removeEventListener("keyup", this.#onKeyUp);
		this.canvas.removeEventListener("click", this.#onCanvasClick);
		document.removeEventListener(
			"pointerlockchange",
			this.#onPointerLockChange,
		);
		window.removeEventListener("mousedown", this.#onMouseDown);
		window.removeEventListener("mouseup", this.#onMouseUp);
		this.canvas.removeEventListener("mousemove", this.#onPointerMove);
		this.canvas.removeEventListener("wheel", this.#onWheel);
		this.#pointerObs = null;
	}
}
