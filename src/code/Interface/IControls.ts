import type { Vec3 } from "@babylonjs/lite";

export interface IControls<type> {
	controlledEntity: type;
	pressedKeys: Set<string>;
	inputDirection: Vec3;
	readonly controlType: string;

	handleKeyEvent(key: string, isKeyDown: boolean): void;
	onKeyUp(key?: string): void;
	onKeyDown(key?: string): void;
}
