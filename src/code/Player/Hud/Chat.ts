import { ChatHistory } from "@/code/Lib/ChatHistory";
import { closeUi, openUi, UiFocus } from "@/code/Lib/GameRuntimeState";
import { Map1 } from "@/code/Maps/Map1";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import { getWorldNameFromUrl, worldSeedFor } from "@/code/World/WorldContext";
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
	#maxVisibleHistory = 30;
	#history = new ChatHistory();

	constructor(player: Player) {
		this.#player = player;
		this.#container = this.#createContainer();
		this.#messageList = this.#createMessageList();
		this.#input = this.#createInput();
		this.#container.appendChild(this.#messageList);
		document.body.appendChild(this.#container);
		document.body.appendChild(this.#input);
	}

	#createContainer(): HTMLDivElement {
		const el = document.createElement("div");
		el.id = "chat-container";
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
		el.style.display = "none";
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

		this.#history.add(text);
		this.#input.value = "";

		if (text.startsWith("/") || text.startsWith("!")) {
			this.#handleCommand(text);
		} else {
			this.#addMessage(text, "player");
		}

		this.close();
	}

	#historyUp(): void {
		const prev = this.#history.previous();
		if (prev !== null) this.#input.value = prev;
	}

	#historyDown(): void {
		const next = this.#history.next();
		this.#input.value = next ?? "";
	}

	#handleCommand(text: string): void {
		const raw = text.slice(1).trim();
		const parts = raw.split(/\s+/);
		const cmd = parts[0]?.toLowerCase();

		switch (cmd) {
			case "g":
			case "gamemode": {
				const gm = this.#parseGamemode(parts[1]);
				if (gm !== null) {
					this.#player.stats.gamemode = gm;
					this.#player.playerHud.updateCreativePaletteVisibility();
					this.#addSystem(`Gamemode set to ${gamemodeName(gm)}`);
				} else {
					this.#addSystem(
						"Usage: !g <gamemode> (survival, creative, adventure, spectator)",
					);
				}
				break;
			}
			case "tp":
			case "teleport":
				this.#handleTeleport(parts.slice(1));
				break;
			case "seed": {
				const worldName = getWorldNameFromUrl() ?? "default";
				const seed = worldSeedFor(worldName);
				this.#addSystem(`World "${worldName}" seed: ${seed}`);
				break;
			}
			case "time":
				this.#handleTime(parts.slice(1));
				break;
			case "h":
			case "help":
				this.#addSystem("Commands:");
				this.#addSystem(
					"  !g <gamemode> - Set gamemode (survival, creative, adventure, spectator)",
				);
				this.#addSystem(
					"  !tp <x> <y> <z> - Teleport to coordinates (~ for current)",
				);
				this.#addSystem("  !tp <x> <z> - Teleport keeping current y");
				this.#addSystem(
					"  !time        - Show the current time of day (0-1000)",
				);
				this.#addSystem("  !time <0-1000> - Set the time of day");
				this.#addSystem("  !time +<amt> - Advance the time of day");
				this.#addSystem("  !time day    - Set to day");
				this.#addSystem("  !seed       - Show the current world's seed");
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

	#handleTeleport(args: string[]): void {
		const pos = this.#player.position;
		const current = { x: pos.x, y: pos.y, z: pos.z };

		if (args.length === 2) {
			const x = this.#parseCoord(args[0], current.x);
			const z = this.#parseCoord(args[1], current.z);
			if (x === null || z === null) {
				this.#addSystem("Usage: !tp <x> <z>");
				return;
			}
			pos.x = x;
			pos.z = z;
			this.#addSystem(`Teleported to ${x} ${current.y} ${z}`);
		} else if (args.length === 3) {
			const x = this.#parseCoord(args[0], current.x);
			const y = this.#parseCoord(args[1], current.y);
			const z = this.#parseCoord(args[2], current.z);
			if (x === null || y === null || z === null) {
				this.#addSystem("Usage: !tp <x> <y> <z>");
				return;
			}
			pos.x = x;
			pos.y = y;
			pos.z = z;
			this.#addSystem(`Teleported to ${x} ${y} ${z}`);
		} else {
			this.#addSystem("Usage: !tp <x> <y> <z> or !tp <x> <z>");
		}
	}

	#parseCoord(input: string, current: number): number | null {
		if (input === "~") return current;
		if (input.startsWith("~")) {
			const offset = Number.parseFloat(input.slice(1));
			if (Number.isNaN(offset)) return null;
			return current + offset;
		}
		const val = Number.parseFloat(input);
		return Number.isNaN(val) ? null : val;
	}

	#handleTime(args: string[]): void {
		const env = Map1.environment;

		if (!env) {
			this.#addSystem("World environment is not ready");
			return;
		}

		const arg = args[0];

		if (!arg) {
			const fraction = env.getTimeOfDayMs() / SETTING_PARAMS.DAY_DURATION_MS;
			this.#addSystem(
				`Time: ${Math.round(fraction * 1000)} (${this.#timeLabel(fraction)})`,
			);
			return;
		}

		if (arg.toLowerCase() === "day") {
			Map1.setTime(0.1);
			this.#addSystem("Time set to day");
			return;
		}

		const isRelative = arg.startsWith("+") || arg.startsWith("-");
		const numeric = Number.parseFloat(arg);

		if (!Number.isFinite(numeric)) {
			this.#addSystem("Usage: !time [<0-1000> | +<amount> | day]");
			return;
		}

		if (isRelative) {
			const currentFrac = env.getTimeOfDayMs() / SETTING_PARAMS.DAY_DURATION_MS;
			const frac = (currentFrac + numeric / 1000) % 1;
			Map1.setTime(frac);
			this.#addSystem(
				`Time advanced to ${Math.round(frac * 1000)} (${this.#timeLabel(frac)})`,
			);
		} else {
			const frac = Math.max(0, Math.min(1000, numeric)) / 1000;
			Map1.setTime(frac);
			this.#addSystem(
				`Time set to ${Math.round(frac * 1000)} (${this.#timeLabel(frac)})`,
			);
		}
	}

	#timeLabel(fraction: number): string {
		if (fraction < 0.25) return "morning";
		if (fraction < 0.5) return "day";
		if (fraction < 0.75) return "evening";
		return "night";
	}

	#addMessage(text: string, type: ChatMessage["type"]): void {
		const msg: ChatMessage = { text, type };
		this.#messages.push(msg);
		if (this.#messages.length > this.#maxMessages) {
			this.#messages.shift();
		}
		const el = this.#renderMessage(msg);
		this.#scheduleFade(el, type);
		this.#trimVisible();
	}

	#scheduleFade(el: HTMLElement, type: ChatMessage["type"]): void {
		const delay = type === "system" ? 4000 : 10000;
		setTimeout(() => {
			el.classList.add("chat-message--fade");
			setTimeout(() => {
				if (el.parentNode) el.parentNode.removeChild(el);
			}, 1000);
		}, delay);
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
		this.#renderHistory();
		this.#input.style.display = "";
		this.#input.value = "";
		this.#history.reset();
		this.#input.focus();
		if (document.pointerLockElement) {
			document.exitPointerLock();
		}
	}

	#renderHistory(): void {
		// Re-render the recent message history so it is visible while typing.
		this.#messageList.innerHTML = "";
		const start = Math.max(0, this.#messages.length - this.#maxVisibleHistory);
		for (let i = start; i < this.#messages.length; i++) {
			this.#messageList.appendChild(this.#renderMessage(this.#messages[i]));
		}
		this.#messageList.scrollTop = this.#messageList.scrollHeight;
	}

	close(): void {
		if (!this.#isOpen) return;
		this.#isOpen = false;
		closeUi(UiFocus.chat);
		// Keep the message list visible as a HUD so messages can fade out;
		// only hide the input.
		this.#input.style.display = "none";
		this.#input.blur();
		// Restore HUD behavior for the history re-rendered on open().
		for (const el of Array.from(this.#messageList.children) as HTMLElement[]) {
			const type = el.classList.contains("chat-message--system")
				? "system"
				: "player";
			this.#scheduleFade(el, type);
		}
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
