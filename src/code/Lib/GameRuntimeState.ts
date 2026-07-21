// ---------------------------------------------------------------------------
// GameRuntimeState
//
// Shared mutable state that avoids import cycles between PlayerLoopController,
// ChunkStreamingController, PlayerInputController, and Map1.
// ---------------------------------------------------------------------------

let _isInCave = false;
export function isInCave(): boolean {
	return _isInCave;
}
export function setInCave(value: boolean): void {
	_isInCave = value;
}

let _gameTimeScale = 0;
export function getGameTimeScale(): number {
	return _gameTimeScale;
}
export function setGameTimeScale(value: number): void {
	_gameTimeScale = value;
}

// ---------------------------------------------------------------------------
// UI focus / pause model
//
// Instead of a single "isPaused" flag we track which UI surfaces currently own
// the mouse. This lets non-blocking overlays (inventory, mason table) release
// the pointer lock WITHOUT pausing the world or showing the PauseMenu.
//
//   - "pauseMenu"  -> genuine pause: world tick + world time freeze.
//   - "inventory"  -> non-blocking overlay: world keeps running, mouse freed.
//   - "masonTable" -> non-blocking overlay: world keeps running, mouse freed.
// ---------------------------------------------------------------------------
export const enum UiFocus {
	pauseMenu,
	inventory,
	masonTable,
	chat,
}

const _openUi = new Set<UiFocus>();

export function openUi(focus: UiFocus): void {
	_openUi.add(focus);
}
export function closeUi(focus: UiFocus): void {
	_openUi.delete(focus);
}
/**
 * True when a specific UI surface is open, or (with no argument) when ANY UI
 * surface currently owns the mouse.
 */
export function isUiOpen(focus?: UiFocus): boolean {
	return focus ? _openUi.has(focus) : _openUi.size > 0;
}

/** The world is paused ONLY when the pause menu owns focus. */
export function getIsPaused(): boolean {
	return _openUi.has(UiFocus.pauseMenu);
}
export function setIsPaused(value: boolean): void {
	if (value) _openUi.add(UiFocus.pauseMenu);
	else _openUi.delete(UiFocus.pauseMenu);
}
