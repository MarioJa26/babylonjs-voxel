export class DebugPanel {
	private static instance: DebugPanel | undefined;
	private static div: HTMLDivElement | undefined;

	private static readonly elements = new Map<
		string,
		{
			container: HTMLDivElement;
			valueNode: Text;
			value: string;
		}
	>();

	private constructor() {
		const div = document.createElement("div");

		div.style.position = "absolute";
		div.style.top = "10px";
		div.style.left = "10px";
		div.style.padding = "10px";
		div.style.backgroundColor = "rgba(0, 0, 0, 0.6)";
		div.style.color = "white";
		div.style.fontFamily = "monospace";
		div.style.fontSize = "16px";
		div.style.zIndex = "100";
		div.style.display = "none";
		div.style.borderRadius = "5px";

		document.body.appendChild(div);
		DebugPanel.div = div;
	}

	public static getInstance(): DebugPanel {
		let instance = DebugPanel.instance;

		if (!instance) {
			instance = new DebugPanel();
			DebugPanel.instance = instance;
		}

		return instance;
	}

	public static show(): void {
		const div = DebugPanel.getDiv();

		if (div.style.display !== "block") {
			div.style.display = "block";
		}
	}

	public static hide(): void {
		const div = DebugPanel.getDiv();

		if (div.style.display !== "none") {
			div.style.display = "none";
		}
	}

	public static updateInfo(key: string, value: string | number): void {
		const strValue = String(value);
		const entry = DebugPanel.elements.get(key);

		if (entry) {
			if (entry.value === strValue) {
				return;
			}

			entry.value = strValue;
			entry.valueNode.nodeValue = strValue;
			return;
		}

		const container = document.createElement("div");
		const valueNode = document.createTextNode(strValue);

		container.appendChild(document.createTextNode(`${key}: `));
		container.appendChild(valueNode);

		DebugPanel.getDiv().appendChild(container);

		DebugPanel.elements.set(key, {
			container,
			valueNode,
			value: strValue,
		});
	}

	public static removeInfo(key: string): void {
		const entry = DebugPanel.elements.get(key);

		if (!entry) {
			return;
		}

		entry.container.remove();
		DebugPanel.elements.delete(key);
	}

	public static clear(): void {
		const div = DebugPanel.div;

		if (div) {
			div.textContent = "";
		}

		DebugPanel.elements.clear();
	}

	private static getDiv(): HTMLDivElement {
		DebugPanel.getInstance();
		return DebugPanel.div as HTMLDivElement;
	}
}
