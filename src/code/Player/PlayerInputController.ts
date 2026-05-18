import { PointerEventTypes, type Scene } from "@babylonjs/core";
import type { IControls } from "../Inferface/IControls";
import { Map1 } from "../Maps/Map1";
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

	constructor(
		private readonly scene: Scene,
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
			if (document.pointerLockElement !== this.canvas && Map1.timeScale > 0) {
				this.onPauseRequested();
			}
		};
		this.#onMouseDown = (event) => {
			const controls = this.getKeyboardControls();
			if (controls.controlType === "inventory") {
				(controls as InventoryControls).handleMouseEvent(event);
			} else if (controls.controlType === "walking") {
				(controls as WalkingControls).handleMouseEvent(event, true);
			}
		};
		this.#onMouseUp = (event) => {
			const controls = this.getKeyboardControls();
			if (controls.controlType === "walking") {
				(controls as WalkingControls).handleMouseEvent(event, false);
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
		this.bindPointerObserver();
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
