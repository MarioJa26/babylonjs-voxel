import type { Vector3 } from "@babylonjs/core";

export interface IControls<type> {
	controlledEntity: type;
	pressedKeys: Set<string>;
	inputDirection: Vector3;

	handleKeyEvent(key: string, isKeyDown: boolean): void;
	onKeyUp(key?: string): void;
	onKeyDown(key?: string): void;
}
