/**
 * MultiplayerHUD — overlay showing connection status, player count, and chat.
 */
import "@/style/MultiplayerHUD.css";

export class MultiplayerHUD {
	private container: HTMLElement;
	private statusEl: HTMLElement;
	private playerCountEl: HTMLElement;
	private playerListEl: HTMLElement;
	private chatMessagesEl: HTMLElement;
	private chatInput: HTMLInputElement;
	private chatOpen = false;
	private messageCount = 0;

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
		this.chatInput.className = "mp-chat-input hidden";
		this.chatInput.placeholder = "Type a message...";
		this.chatInput.maxLength = 256;
		this.chatInput.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter" && this.chatInput.value.trim()) {
				this.onSendChat(this.chatInput.value.trim());
				this.chatInput.value = "";
				this.closeChat();
			} else if (e.key === "Escape") {
				this.closeChat();
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
		// Show names as a tooltip-like display
		if (names.length <= 1) {
			this.playerCountEl.textContent = `👤 ${names.length} (solo)`;
		} else {
			this.playerCountEl.textContent = `👤 ${names.length}: ${names.join(", ")}`;
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

		// Keep only last 50 messages
		while (this.chatMessagesEl.children.length > 50) {
			this.chatMessagesEl.removeChild(this.chatMessagesEl.firstChild!);
		}

		// Auto-scroll
		this.chatMessagesEl.scrollTop = this.chatMessagesEl.scrollHeight;

		// Fade out old messages after 10 seconds if chat is closed
		if (!this.chatOpen) {
			setTimeout(() => {
				msgEl.classList.add("mp-chat-msg-fade");
			}, 8000);
		}
	}

	addSystemMessage(text: string): void {
		const msgEl = document.createElement("div");
		msgEl.className = "mp-chat-msg mp-chat-system";
		msgEl.textContent = text;
		this.chatMessagesEl.appendChild(msgEl);
		this.messageCount++;

		while (this.chatMessagesEl.children.length > 50) {
			this.chatMessagesEl.removeChild(this.chatMessagesEl.firstChild!);
		}
		this.chatMessagesEl.scrollTop = this.chatMessagesEl.scrollHeight;
	}

	openChat(): void {
		this.chatOpen = true;
		this.chatInput.classList.remove("hidden");
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
		const div = document.createElement("div");
		div.textContent = text;
		return div.innerHTML;
	}

	dispose(): void {
		this.container.remove();
	}
}
