// ---------------------------------------------------------------------------
// IPlayerContext
//
// Minimal interface for Player consumed by Controls (Walking, Inventory, etc.)
// to break the Controls → Player → PlayerInputController → Controls cycle.
// Only the members actually accessed by Controls are declared here.
// ---------------------------------------------------------------------------

import type { Vector3 } from "@babylonjs/core";
import type { IControls } from "./IControls";

export interface IPlayerContext {
	readonly position: Vector3;
	keyboardControls: IControls<unknown>;
	readonly defaultKeyboardControls: IControls<unknown>;
}
