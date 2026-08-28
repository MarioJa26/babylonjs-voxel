/**
 * MultiplayerHUD — overlay showing connection status, player count, and chat.
 */
import "@/style/MultiplayerHUD.css";
import { ChatHistory } from "@/code/Lib/ChatHistory";

export class MultiplayerHUD {
	private container: HTMLElement;
	private statusEl: HTMLElement;
	private playerCountEl: HTMLElement;
	private playerListEl: HTMLElement;
	private chatMessagesEl: HTMLElement;
	private chatInput: HTMLInputElement;
	private chatOpen = false;
	private history = new ChatHistory();
	private messageCount = 0;
	private _lastNamesKey = "";

	constructor(
		private onSendChat: (message: string) => void,
		private onToggleChat: (open: boolean) => void,
	) {
		this.container = document.createElement("div");
		this.container.className = "mp-hud";

		// Connection status + player count (top-left)
		const statusBar = document.createElement("div");
		statusBar.className = "mp-status-bar";

		this.statusEl = document.createElement("span");
		this.statusEl.className = "mp-status mp-status-connecting";
		this.statusEl.textContent = "● Connecting...";

		this.playerCountEl = document.createElement("span");
		this.playerCountEl.className = "mp-player-count";
		this.playerCountEl.textContent = "👤 1";

		statusBar.appendChild(this.statusEl);
		statusBar.appendChild(this.playerCountEl);

		// Player list (hidden by default, shown with Tab)
		this.playerListEl = document.createElement("div");
		this.playerListEl.className = "mp-player-list hidden";

		// Chat messages
		this.chatMessagesEl = document.createElement("div");
		this.chatMessagesEl.className = "mp-chat-messages";

		// Chat input (hidden until T is pressed)
		this.chatInput = document.createElement("input");
		this.chatInput.type = "text";
		this.chatInput.id = "chat";
		this.chatInput.className = "mp-chat-input hidden";
		this.chatInput.placeholder = "Type a message...";
		this.chatInput.maxLength = 256;
		this.chatInput.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter" && this.chatInput.value.trim()) {
				this.history.add(this.chatInput.value.trim());
				this.onSendChat(this.chatInput.value.trim());
				this.chatInput.value = "";
				this.closeChat();
			} else if (e.key === "Escape") {
				this.closeChat();
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				const prev = this.history.previous();
				if (prev !== null) this.chatInput.value = prev;
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				const next = this.history.next();
				this.chatInput.value = next ?? "";
			}
		});
		this.chatInput.addEventListener("blur", () => this.closeChat());

		this.container.appendChild(statusBar);
		this.container.appendChild(this.playerListEl);
		this.container.appendChild(this.chatMessagesEl);
		this.container.appendChild(this.chatInput);

		document.body.appendChild(this.container);
	}

	setConnected(connected: boolean): void {
		if (connected) {
			this.statusEl.className = "mp-status mp-status-connected";
			this.statusEl.textContent = "● Online";
		} else {
			this.statusEl.className = "mp-status mp-status-disconnected";
			this.statusEl.textContent = "● Offline";
		}
	}

	setPlayerCount(count: number): void {
		this.playerCountEl.textContent = `👤 ${count}`;
	}

	setPlayerNames(names: string[]): void {
		// names = remote players only; total = self + remotes
		const total = names.length + 1;
		// Skip DOM write if the player list hasn't changed — avoids
		// layout/paint thrash on every frame when nobody joined/left.
		const key = total <= 1 ? "1" : `${total}:${names.join(",")}`;
		if (key === this._lastNamesKey) return;
		this._lastNamesKey = key;
		if (total <= 1) {
			this.playerCountEl.textContent = "1 (solo)";
		} else {
			this.playerCountEl.textContent = `👤 ${total}: ${names.join(", ")}`;
		}
	}

	setPlayerList(players: { name: string; sessionId: string }[]): void {
		this.playerListEl.innerHTML = "";
		for (const p of players) {
			const row = document.createElement("div");
			row.className = "mp-player-row";
			row.textContent = p.name;
			this.playerListEl.appendChild(row);
		}
	}

	showPlayerList(show: boolean): void {
		this.playerListEl.classList.toggle("hidden", !show);
	}

	addChatMessage(name: string, message: string): void {
		const msgEl = document.createElement("div");
		msgEl.className = "mp-chat-msg";
		msgEl.innerHTML = `<span class="mp-chat-name">${this.escapeHtml(name)}:</span> ${this.escapeHtml(message)}`;
		this.chatMessagesEl.appendChild(msgEl);
		this.messageCount++;
		this.#trimToMax();
		this.#scheduleFade(msgEl, 10000);
	}

	addSystemMessage(text: string): void {
		const msgEl = document.createElement("div");
		msgEl.className = "mp-chat-msg mp-chat-system";
		msgEl.textContent = text;
		this.chatMessagesEl.appendChild(msgEl);
		this.messageCount++;
		this.#trimToMax();
		this.#scheduleFade(msgEl, 4000);
	}

	#trimToMax(): void {
		while (this.chatMessagesEl.children.length > 50) {
			this.chatMessagesEl.removeChild(this.chatMessagesEl.firstChild!);
		}
		this.chatMessagesEl.scrollTop = this.chatMessagesEl.scrollHeight;
	}

	#scheduleFade(el: HTMLElement, delay: number): void {
		setTimeout(() => {
			el.classList.add("mp-chat-msg-fade");
			setTimeout(() => {
				if (el.parentNode) el.parentNode.removeChild(el);
			}, 1000);
		}, delay);
	}

	openChat(): void {
		this.chatOpen = true;
		this.chatInput.classList.remove("hidden");
		this.chatInput.value = "";
		this.history.reset();
		this.chatInput.focus();
		this.onToggleChat(true);
	}

	private closeChat(): void {
		if (!this.chatOpen) return;
		this.chatOpen = false;
		this.chatInput.classList.add("hidden");
		this.chatInput.blur();
		this.onToggleChat(false);
	}

	private escapeHtml(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	dispose(): void {
		this.container.remove();
	}
}
