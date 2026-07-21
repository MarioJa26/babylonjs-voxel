import { closeUi, openUi, UiFocus } from "@/code/Lib/GameRuntimeState";
import type { Player } from "../Player";
import { Gamemodes } from "../PlayerStats";

interface ChatMessage {
	text: string;
	type: "player" | "system" | "command";
}

function gamemodeName(gm: Gamemodes): string {
	switch (gm) {
		case Gamemodes.Survival:
			return "Survival";
		case Gamemodes.Creative:
			return "Creative";
		case Gamemodes.Adventure:
			return "Adventure";
		case Gamemodes.Spectator:
			return "Spectator";
		default:
			return "Unknown";
	}
}

export class Chat {
	#player: Player;
	#container: HTMLDivElement;
	#messageList: HTMLDivElement;
	#input: HTMLInputElement;
	#isOpen = false;
	#messages: ChatMessage[] = [];
	#maxMessages = 100;
	#history: string[] = [];
	#historyIndex = -1;

	constructor(player: Player) {
		this.#player = player;
		this.#container = this.#createContainer();
		this.#messageList = this.#createMessageList();
		this.#input = this.#createInput();
		this.#container.appendChild(this.#messageList);
		this.#container.appendChild(this.#input);
		document.body.appendChild(this.#container);
	}

	#createContainer(): HTMLDivElement {
		const el = document.createElement("div");
		el.id = "chat-container";
		el.style.display = "none";
		return el;
	}

	#createMessageList(): HTMLDivElement {
		const el = document.createElement("div");
		el.id = "chat-messages";
		return el;
	}

	#createInput(): HTMLInputElement {
		const el = document.createElement("input");
		el.id = "chat-input";
		el.type = "text";
		el.placeholder = "Type a message...";
		el.maxLength = 200;
		el.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") {
				this.#submit();
			} else if (e.key === "Escape") {
				this.close();
			} else if (e.key === "ArrowUp") {
				this.#historyUp();
			} else if (e.key === "ArrowDown") {
				this.#historyDown();
			} else if (e.altKey && e.key === "1") {
				this.#input.value = "!g 0";
			} else if (e.altKey && e.key === "2") {
				this.#input.value = "!g 1";
			}
		});
		el.addEventListener("blur", () => {
			this.close();
		});
		return el;
	}

	#submit(): void {
		const text = this.#input.value.trim();
		if (!text) {
			this.close();
			return;
		}

		this.#history.push(text);
		this.#historyIndex = this.#history.length;
		this.#input.value = "";

		if (text.startsWith("/") || text.startsWith("!")) {
			this.#handleCommand(text);
		} else {
			this.#addMessage(text, "player");
		}

		this.close();
	}

	#historyUp(): void {
		if (this.#history.length === 0) return;
		if (this.#historyIndex > 0) {
			this.#historyIndex--;
			this.#input.value = this.#history[this.#historyIndex];
		}
	}

	#historyDown(): void {
		if (this.#historyIndex < this.#history.length - 1) {
			this.#historyIndex++;
			this.#input.value = this.#history[this.#historyIndex];
		} else {
			this.#historyIndex = this.#history.length;
			this.#input.value = "";
		}
	}

	#handleCommand(text: string): void {
		const raw = text.slice(1).trim();
		const parts = raw.split(/\s+/);
		const cmd = parts[0]?.toLowerCase();
		const arg = parts[1];

		switch (cmd) {
			case "g":
			case "gamemode": {
				const gm = this.#parseGamemode(arg);
				if (gm !== null) {
					this.#player.stats.gamemode = gm;
					this.#addSystem(`Gamemode set to ${gamemodeName(gm)}`);
				} else {
					this.#addSystem(
						"Usage: !g <gamemode> (survival, creative, adventure, spectator)",
					);
				}
				break;
			}
			case "h":
			case "help":
				this.#addSystem("Commands:");
				this.#addSystem(
					"  !g <gamemode> - Set gamemode (survival, creative, adventure, spectator)",
				);
				this.#addSystem("  !h / !help   - Show this help");
				break;
			default:
				this.#addSystem(`Unknown command: ${cmd}`);
		}
	}

	#parseGamemode(input: string | undefined): Gamemodes | null {
		if (!input) return null;
		const lower = input.toLowerCase();
		if (lower === "0" || lower === "survival") return Gamemodes.Survival;
		if (lower === "1" || lower === "creative") return Gamemodes.Creative;
		if (lower === "2" || lower === "adventure") return Gamemodes.Adventure;
		if (lower === "3" || lower === "spectator") return Gamemodes.Spectator;
		return null;
	}

	#addMessage(text: string, type: ChatMessage["type"]): void {
		const msg: ChatMessage = { text, type };
		this.#messages.push(msg);
		if (this.#messages.length > this.#maxMessages) {
			this.#messages.shift();
		}
		const el = this.#renderMessage(msg);
		if (type === "system") {
			setTimeout(() => {
				el.classList.add("chat-message--fade");
				setTimeout(() => {
					if (el.parentNode) el.parentNode.removeChild(el);
				}, 1000);
			}, 4000);
		}
		this.#trimVisible();
	}

	#addSystem(text: string): void {
		this.#addMessage(text, "system");
	}

	#renderMessage(msg: ChatMessage): HTMLDivElement {
		const el = document.createElement("div");
		el.classList.add("chat-message", `chat-message--${msg.type}`);
		el.textContent = msg.text;
		this.#messageList.appendChild(el);
		return el;
	}

	#trimVisible(): void {
		while (this.#messageList.children.length > this.#maxMessages) {
			this.#messageList.removeChild(this.#messageList.firstChild!);
		}
		this.#messageList.scrollTop = this.#messageList.scrollHeight;
	}

	open(): void {
		if (this.#isOpen) return;
		this.#isOpen = true;
		openUi(UiFocus.chat);
		this.#container.style.display = "flex";
		this.#input.value = "";
		this.#historyIndex = this.#history.length;
		this.#input.focus();
		if (document.pointerLockElement) {
			document.exitPointerLock();
		}
	}

	close(): void {
		if (!this.#isOpen) return;
		this.#isOpen = false;
		closeUi(UiFocus.chat);
		this.#container.style.display = "none";
		this.#input.blur();
	}

	toggle(): void {
		if (this.#isOpen) this.close();
		else this.open();
	}

	addSystemMessage(text: string): void {
		this.#addSystem(text);
	}

	get isOpen(): boolean {
		return this.#isOpen;
	}
}
