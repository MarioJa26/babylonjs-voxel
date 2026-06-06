import { TestScene } from "./code/TestScene";
import "@/style/hud.css"; 
import "@/style/Item.css"; 
const canvas = document.createElement("canvas");
canvas.style.cssText =
	"width:100%;height:100%;display:block;position:fixed;top:0;left:0;outline:none;background:rgb(30,38,36)";
document.body.appendChild(canvas);

const testScene = new TestScene(document, canvas);
await testScene.initPromise;

window.addEventListener("beforeunload", () => testScene.engine.dispose());
