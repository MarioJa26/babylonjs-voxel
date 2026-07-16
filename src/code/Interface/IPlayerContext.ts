// ---------------------------------------------------------------------------
// IPlayerContext
//
// Minimal interface for Player consumed by Controls (Walking, Inventory, etc.)
// to break the Controls → Player → PlayerInputController → Controls cycle.
// Only the members actually accessed by Controls are declared here.
// ---------------------------------------------------------------------------

import type { Vec3 } from "@babylonjs/lite";
import type { IControls } from "./IControls";

export interface IPlayerContext {
	readonly position: Vec3;
	keyboardControls: IControls<unknown>;
	readonly defaultKeyboardControls: IControls<unknown>;
}
