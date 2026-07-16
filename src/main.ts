import { TestScene } from "./code/TestScene";
import "@/style/hud.css";
import "@/style/Item.css";

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

async function main(): Promise<void> {
	const testScene = new TestScene(document, canvas);
	await testScene.initPromise;

	window.addEventListener("beforeunload", () => testScene.dispose(), {
		once: true,
	});
}

main().catch((error: unknown) => {
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
});
