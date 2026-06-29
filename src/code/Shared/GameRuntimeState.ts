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

let _isPaused = false;
export function getIsPaused(): boolean {
	return _isPaused;
}
export function setIsPaused(value: boolean): void {
	_isPaused = value;
}

// Lazy scene accessor — set by Map1 after construction.
// Used by Player for pointer lock without importing Map1.
let _getScene: (() => import("@babylonjs/core").Scene) | null = null;
export function setSceneAccessor(
	fn: () => import("@babylonjs/core").Scene,
): void {
	_getScene = fn;
}
export function getScene(): import("@babylonjs/core").Scene | null {
	return _getScene ? _getScene() : null;
}
