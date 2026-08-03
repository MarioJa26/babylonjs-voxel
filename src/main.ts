import { TestScene } from "./code/TestScene";
import { MainMenu } from "./code/UI/MainMenu";
import { enableWasmNoise } from "./code/Lib/WasmNoise";
import { getWorldNameFromUrl } from "./code/World/WorldContext";
import "@/style/hud.css";
import "@/style/Item.css";

function showErrorOverlay(error: unknown): void {
	console.error("Application startup failed:", error);

	const pre = document.createElement("pre");
	pre.style.cssText = [
		"position:fixed",
		"inset:0",
		"margin:0",
		"padding:20px",
		"overflow:auto",
		"color:#ffb4b4",
		"background:#181818",
		"font:14px/1.5 monospace",
		"white-space:pre-wrap",
	].join(";");

	pre.textContent =
		error instanceof Error
			? `${error.name}: ${error.message}\n\n${error.stack ?? ""}`
			: String(error);

	document.body.appendChild(pre);
}

/**
 * URL routing:
 *   /             → main menu (no engine created)
 *   /world/<name> → boot the game in that world
 */
async function main(): Promise<void> {
	const worldName = getWorldNameFromUrl();

	if (!worldName) {
		const menu = new MainMenu();
		menu.mount(document.body);
		return;
	}

	// Install the SIMD wasm noise backend (chunk generation itself runs in
	// the terrain workers, which load it independently). Fire-and-forget:
	// chunk generation never waits on this; failure keeps the JS backend.
	void enableWasmNoise();

	const canvas = document.createElement("canvas");

	canvas.style.cssText = [
		"width:100%",
		"height:100%",
		"display:block",
		"position:fixed",
		"top:0",
		"left:0",
		"outline:none",
		"background:rgb(30,38,36)",
	].join(";");

	document.body.appendChild(canvas);

	const testScene = new TestScene(document, canvas, worldName);
	await testScene.initPromise;

	window.addEventListener("beforeunload", () => testScene.dispose(), {
		once: true,
	});
}

main().catch(showErrorOverlay);
