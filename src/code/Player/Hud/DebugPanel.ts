export class DebugPanel {
	static instance: DebugPanel;

	static div: HTMLDivElement = document.createElement("div");
	private static infoLines: { [key: string]: string } = {};
	private static elements = new Map<string, HTMLDivElement>();

	private constructor() {
		const div = DebugPanel.div;
		div.style.position = "absolute";
		div.style.top = "10px";
		div.style.left = "10px";
		div.style.padding = "10px";
		div.style.backgroundColor = "rgba(0, 0, 0, 0.6)";
		div.style.color = "white";
		div.style.fontFamily = "monospace";
		div.style.fontSize = "16px";
		div.style.zIndex = "100";
		div.style.display = "none"; // Initially hidden
		div.style.borderRadius = "5px";
		document.body.appendChild(div);
	}

	static getInstance(): DebugPanel {
		if (!DebugPanel.instance) {
			DebugPanel.instance = new DebugPanel();
		}
		return DebugPanel.instance;
	}

	public static show(): void {
		DebugPanel.div.style.display = "block";
	}

	public static hide(): void {
		DebugPanel.div.style.display = "none";
	}

	public static updateInfo(key: string, value: string | number): void {
		const strValue = String(value);
		if (DebugPanel.infoLines[key] === strValue) return;
		DebugPanel.infoLines[key] = strValue;

		let el = DebugPanel.elements.get(key);
		if (!el) {
			el = document.createElement("div");
			DebugPanel.div.appendChild(el);
			DebugPanel.elements.set(key, el);
		}
		el.textContent = `${key}: ${strValue}`;
	}
}
