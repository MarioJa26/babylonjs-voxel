export class DebugPanel {
  static instance: DebugPanel;

  static div: HTMLDivElement = document.createElement("div");
  private static infoLines: { [key: string]: string } = {};

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
    if (!this.instance) {
      this.instance = new DebugPanel();
    }
    return this.instance;
  }

  public static show(): void {
    this.div.style.display = "block";
  }

  public static hide(): void {
    this.div.style.display = "none";
  }

  public static updateInfo(key: string, value: string | number): void {
    this.infoLines[key] = String(value);
    this.render();
  }

  private static render(): void {
    let html = "";
    for (const key in this.infoLines) {
      html += `<div><strong>${key}:</strong> ${this.infoLines[key]}</div>`;
    }
    this.div.innerHTML = html;
  }
}
