import {
	getPlayerName,
	getSavedServers,
	removeServer,
	type SavedServer,
	saveServer,
	setPlayerName,
} from "../Network/serverList";
import { fetchAllStatuses, type ServerStatus } from "../Network/serverStatus";
import {
	isValidWorldName,
	removeStoredWorldSeed,
	sanitizeWorldName,
	serverPath,
	setStoredWorldSeed,
	WORLD_SEED_BASE_KEY,
	worldLocalStorageKey,
	worldPath,
} from "../World/WorldContext";
import worldNames from "./worldNames.json";

const OPFS_ROOT = "b102";
const OPFS_WORLDS = "worlds";
const MULTIPLAYER_SERVER_KEY = "b102.mpServer";

function getRandomWorldName(): string {
	const pick = (list: readonly string[]): string =>
		list[Math.floor(Math.random() * list.length)];
	return `${pick(worldNames.prefixes)}_${pick(worldNames.roots)}${pick(worldNames.suffixes)}`;
}

function getRandomSeed(): string {
	const hi = Math.floor(Math.random() * 0x100000000);
	const lo = Math.floor(Math.random() * 0x100000000);
	let seed = (BigInt(hi) << 32n) | BigInt(lo);
	if (seed >= 0x8000000000000000n) {
		seed -= 0x10000000000000000n;
	}
	return seed.toString();
}

function diceButton(title: string, onClick: () => void): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.title = title;
	button.setAttribute("aria-label", title);
	button.innerHTML = `
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<rect x="2" y="2" width="20" height="20" rx="5" fill="none" stroke="currentColor" stroke-width="2"/>
			<circle cx="7.5" cy="7.5" r="1.6" fill="currentColor"/>
			<circle cx="16.5" cy="7.5" r="1.6" fill="currentColor"/>
			<circle cx="12" cy="12" r="1.6" fill="currentColor"/>
			<circle cx="7.5" cy="16.5" r="1.6" fill="currentColor"/>
			<circle cx="16.5" cy="16.5" r="1.6" fill="currentColor"/>
		</svg>`;
	button.onclick = onClick;
	return button;
}

async function listWorlds(): Promise<string[]> {
	try {
		const root = await navigator.storage.getDirectory();
		const b102 = await root.getDirectoryHandle(OPFS_ROOT);
		const worlds = await b102.getDirectoryHandle(OPFS_WORLDS);
		const names: string[] = [];
		for await (const [name, handle] of worlds.entries()) {
			if (handle.kind === "directory") names.push(name);
		}
		return names.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

async function deleteWorld(name: string): Promise<void> {
	const root = await navigator.storage.getDirectory();
	const b102 = await root.getDirectoryHandle(OPFS_ROOT);
	const worlds = await b102.getDirectoryHandle(OPFS_WORLDS);
	await worlds.removeEntry(name, { recursive: true });
	for (const baseKey of [
		"playerPosition.v1",
		"playerInventory.v1",
		WORLD_SEED_BASE_KEY,
	]) {
		localStorage.removeItem(worldLocalStorageKey(name, baseKey));
	}
}

type MenuScreen = "main" | "singleplayer" | "multiplayer";

export class MainMenu {
	private readonly container: HTMLElement;
	private screen: MenuScreen = "main";

	// Main screen elements
	private readonly mainScreen!: HTMLElement;

	// Singleplayer elements
	private readonly spScreen!: HTMLElement;
	private readonly worldListEl!: HTMLElement;
	private readonly nameInput!: HTMLInputElement;
	private readonly seedInput!: HTMLInputElement;
	private readonly spStatusEl!: HTMLElement;

	// Multiplayer elements
	private readonly mpScreen!: HTMLElement;
	private readonly mpNameInput!: HTMLInputElement;
	private readonly mpServerInput!: HTMLInputElement;
	private readonly mpStatusEl!: HTMLElement;
	private readonly mpServerListEl!: HTMLElement;
	// Player name (shared)
	private readonly playerNameInput!: HTMLInputElement;

	constructor() {
		this.container = document.createElement("div");
		this.container.id = "mainMenuContainer";

		const title = document.createElement("h1");
		title.innerText = "b102";
		this.container.appendChild(title);

		// ─── Player Name (top of main screen) ────────────────────────
		const nameBar = document.createElement("div");
		nameBar.className = "player-name-bar";

		const nameLabel = document.createElement("label");
		nameLabel.className = "player-name-label";
		nameLabel.innerText = "Player Name";
		nameBar.appendChild(nameLabel);

		this.playerNameInput = document.createElement("input");
		this.playerNameInput.type = "text";
		this.playerNameInput.placeholder = "Steve";
		this.playerNameInput.maxLength = 24;
		this.playerNameInput.value = getPlayerName();
		nameBar.appendChild(this.playerNameInput);

		this.container.appendChild(nameBar);

		// ─── Main Screen ──────────────────────────────────────────────
		this.mainScreen = document.createElement("div");
		this.mainScreen.className = "menu-screen active";
		this.mainScreen.id = "mainScreen";

		const spBtn = document.createElement("button");
		btnMinecraft(spBtn, "Singleplayer");
		spBtn.onclick = () => this.showScreen("singleplayer");
		this.mainScreen.appendChild(spBtn);

		const mpBtn = document.createElement("button");
		btnMinecraft(mpBtn, "Multiplayer");
		mpBtn.onclick = () => this.showScreen("multiplayer");
		this.mainScreen.appendChild(mpBtn);

		const spacer1 = document.createElement("div");
		spacer1.className = "menu-spacer";
		this.mainScreen.appendChild(spacer1);

		const optsBtn = document.createElement("button");
		btnMinecraft(optsBtn, "Options…");
		optsBtn.onclick = () => alert("Options not yet implemented");
		this.mainScreen.appendChild(optsBtn);

		const quitBtn = document.createElement("button");
		btnMinecraft(quitBtn, "Quit Game");
		quitBtn.onclick = () => window.close();
		this.mainScreen.appendChild(quitBtn);

		this.container.appendChild(this.mainScreen);

		// ─── Singleplayer Screen ──────────────────────────────────────
		this.spScreen = document.createElement("div");
		this.spScreen.className = "menu-screen";
		this.spScreen.id = "spScreen";

		const spBack = document.createElement("button");
		btnMinecraft(spBack, "← Back");
		spBack.onclick = () => this.showScreen("main");
		this.spScreen.appendChild(spBack);

		const spTitle = document.createElement("h2");
		spTitle.className = "screen-title";
		spTitle.innerText = "Select World";
		this.spScreen.appendChild(spTitle);

		// Create world
		const createRow = document.createElement("div");
		createRow.className = "menu-create-row";
		this.nameInput = document.createElement("input");
		this.nameInput.type = "text";
		this.nameInput.placeholder = "New World";
		this.nameInput.maxLength = 64;
		this.nameInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") void this.createWorld();
		});
		const randomBtn = diceButton("Random name", () => {
			this.nameInput.value = getRandomWorldName();
			this.nameInput.focus();
		});
		const inputWrap = document.createElement("div");
		inputWrap.className = "menu-input-wrap";
		inputWrap.appendChild(this.nameInput);
		inputWrap.appendChild(randomBtn);
		createRow.appendChild(inputWrap);
		this.spScreen.appendChild(createRow);

		const createBtnRow = document.createElement("div");
		createBtnRow.className = "menu-create-row";

		const createBtn = document.createElement("button");
		btnMinecraft(createBtn, "Create New World");
		createBtn.classList.add("mc-btn-green");
		createBtn.onclick = () => void this.createWorld();

		this.seedInput = document.createElement("input");
		this.seedInput.type = "text";
		this.seedInput.placeholder = "Seed (optional)";
		this.seedInput.maxLength = 64;
		this.seedInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") void this.createWorld();
		});

		const seedRandomBtn = diceButton("Random seed", () => {
			this.seedInput.value = getRandomSeed();
			this.seedInput.focus();
		});

		const seedWrap = document.createElement("div");
		seedWrap.className = "menu-input-wrap";
		seedWrap.append(this.seedInput, seedRandomBtn);

		createBtnRow.append(createBtn, seedWrap);
		this.spScreen.appendChild(createBtnRow);

		//
		this.spStatusEl = document.createElement("div");
		this.spStatusEl.className = "menu-status";
		this.spScreen.appendChild(this.spStatusEl);

		this.worldListEl = document.createElement("div");
		this.worldListEl.className = "menu-world-list";
		this.spScreen.appendChild(this.worldListEl);

		this.container.appendChild(this.spScreen);

		// ─── Multiplayer Screen ───────────────────────────────────────
		this.mpScreen = document.createElement("div");
		this.mpScreen.className = "menu-screen";
		this.mpScreen.id = "mpScreen";

		const mpBack = document.createElement("button");
		btnMinecraft(mpBack, "← Back");
		mpBack.onclick = () => this.showScreen("main");
		this.mpScreen.appendChild(mpBack);

		const mpTitle = document.createElement("h2");
		mpTitle.className = "screen-title";
		mpTitle.innerText = "Multiplayer";
		this.mpScreen.appendChild(mpTitle);

		// ─── Saved Servers (primary list, shown above the controls) ─
		const listHeader = document.createElement("div");
		listHeader.className = "menu-list-header";
		const serverListTitle = document.createElement("h3");
		serverListTitle.className = "screen-subtitle";
		serverListTitle.innerText = "Saved Servers";
		const refreshBtn = document.createElement("button");
		btnSmallMinecraft(refreshBtn, "Refresh");
		refreshBtn.classList.add("mc-btn-refresh");
		refreshBtn.onclick = () => void this.refreshServerList();
		listHeader.appendChild(serverListTitle);
		listHeader.appendChild(refreshBtn);
		this.mpScreen.appendChild(listHeader);

		this.mpServerListEl = document.createElement("div");
		this.mpServerListEl.className = "menu-server-list";
		this.mpScreen.appendChild(this.mpServerListEl);

		// ─── Add Server (Minecraft-style: name + IP) ───────────────
		const addTitle = document.createElement("h3");
		addTitle.className = "screen-subtitle";
		addTitle.innerText = "Add Server";
		this.mpScreen.appendChild(addTitle);

		const nameGroup = document.createElement("div");
		nameGroup.className = "input-group";
		const mpNameLabel = document.createElement("label");
		mpNameLabel.className = "input-label";
		mpNameLabel.innerText = "Server Name";
		this.mpNameInput = document.createElement("input");
		this.mpNameInput.type = "text";
		this.mpNameInput.placeholder = "My Server";
		this.mpNameInput.maxLength = 32;
		nameGroup.appendChild(mpNameLabel);
		nameGroup.appendChild(this.mpNameInput);
		this.mpScreen.appendChild(nameGroup);

		const addrGroup = document.createElement("div");
		addrGroup.className = "input-group";
		const addrLabel = document.createElement("label");
		addrLabel.className = "input-label";
		addrLabel.innerText = "Server Address (IP)";
		this.mpServerInput = document.createElement("input");
		this.mpServerInput.type = "text";
		this.mpServerInput.placeholder = "ws://host:2567";
		this.mpServerInput.value =
			localStorage.getItem(MULTIPLAYER_SERVER_KEY) ?? "ws://localhost:2567";
		addrGroup.appendChild(addrLabel);
		addrGroup.appendChild(this.mpServerInput);
		this.mpScreen.appendChild(addrGroup);

		const addRow = document.createElement("div");
		addRow.className = "menu-create-row";
		const addBtn = document.createElement("button");
		btnMinecraft(addBtn, "Add Server");
		addBtn.classList.add("mc-btn-green");
		addBtn.onclick = () => void this.addServer();
		addRow.appendChild(addBtn);
		this.mpScreen.appendChild(addRow);

		this.mpStatusEl = document.createElement("div");
		this.mpStatusEl.className = "menu-status";
		this.mpScreen.appendChild(this.mpStatusEl);

		this.container.appendChild(this.mpScreen);

		this.addStyles();
	}

	private showScreen(screen: MenuScreen): void {
		this.screen = screen;
		this.container.querySelectorAll(".menu-screen").forEach((el) => {
			el.classList.remove("active");
		});
		switch (screen) {
			case "main":
				this.mainScreen.classList.add("active");
				break;
			case "singleplayer":
				this.spScreen.classList.add("active");
				void this.refreshWorlds();
				break;
			case "multiplayer":
				this.mpScreen.classList.add("active");
				void this.refreshServerList();
				break;
		}
	}

	public mount(root: HTMLElement): void {
		root.appendChild(this.container);
	}

	public dispose(): void {
		this.container.remove();
	}

	// ─── Singleplayer ──────────────────────────────────────────────────

	private async createWorld(): Promise<void> {
		const raw = this.nameInput.value;
		const name = sanitizeWorldName(raw);
		if (!isValidWorldName(name)) {
			this.spStatusEl.innerText = "Please enter a valid world name.";
			this.spStatusEl.classList.add("error");
			return;
		}
		const seed = this.seedInput.value.trim();
		if (seed) {
			setStoredWorldSeed(name, seed.slice(0, 64));
		} else {
			removeStoredWorldSeed(name);
		}
		window.location.href = worldPath(name);
	}

	private async refreshWorlds(): Promise<void> {
		this.spStatusEl.innerText = "";
		this.spStatusEl.classList.remove("error");
		this.worldListEl.replaceChildren(this.loadingRow("Loading worlds…"));

		let worlds: string[];
		try {
			worlds = await listWorlds();
		} catch (err) {
			this.worldListEl.replaceChildren();
			this.spStatusEl.innerText = `Could not read saved worlds: ${String(err)}`;
			this.spStatusEl.classList.add("error");
			return;
		}

		if (worlds.length === 0) {
			this.worldListEl.replaceChildren(
				this.loadingRow("No worlds yet — create one above."),
			);
			return;
		}

		const fragment = document.createDocumentFragment();
		for (const name of worlds) {
			fragment.appendChild(this.worldRow(name));
		}

		this.worldListEl.replaceChildren(fragment);
	}

	private worldRow(name: string): HTMLElement {
		const row = document.createElement("div");
		row.className = "menu-world-row";

		const label = document.createElement("span");
		label.className = "world-name";
		label.innerText = name;
		row.appendChild(label);

		const playBtn = document.createElement("button");
		btnSmallMinecraft(playBtn, "Play");
		playBtn.onclick = () => {
			window.location.href = worldPath(name);
		};
		row.appendChild(playBtn);

		const deleteBtn = document.createElement("button");
		btnSmallMinecraft(deleteBtn, "Delete");
		deleteBtn.onclick = () => void this.deleteWorld(name, deleteBtn);
		row.appendChild(deleteBtn);

		return row;
	}

	private async deleteWorld(
		name: string,
		button: HTMLButtonElement,
	): Promise<void> {
		if (!confirm(`Delete world "${name}"? This cannot be undone.`)) return;
		button.disabled = true;
		button.innerText = "Deleting…";
		try {
			await deleteWorld(name);
			this.spStatusEl.innerText = `Deleted "${name}".`;
			this.spStatusEl.classList.remove("error");
			await this.refreshWorlds();
		} catch (err) {
			console.error("Failed to delete world", err);
			this.spStatusEl.innerText = `Failed to delete "${name}": ${String(err)}`;
			this.spStatusEl.classList.add("error");
			button.disabled = false;
			button.innerText = "Delete";
		}
	}

	// ─── Multiplayer ───────────────────────────────────────────────────

	/** Normalize a user-typed address into a ws:// (or wss://) URL. */
	private normalizeServerUrl(raw: string): string {
		const trimmed = raw.trim();
		if (!trimmed) return "";
		if (/^wss?:\/\//.test(trimmed)) return trimmed;
		const scheme =
			typeof window !== "undefined" && window.location.protocol === "https:"
				? "wss://"
				: "ws://";
		return `${scheme}${trimmed}`;
	}

	private addServer(): void {
		const name = this.mpNameInput.value.trim();
		const address = this.mpServerInput.value.trim();
		const url = this.normalizeServerUrl(address);

		if (!name) {
			this.mpStatusEl.innerText = "Please enter a server name.";
			this.mpStatusEl.classList.add("error");
			return;
		}
		if (!url) {
			this.mpStatusEl.innerText = "Please enter a server address.";
			this.mpStatusEl.classList.add("error");
			return;
		}

		saveServer({ name, url });
		localStorage.setItem(MULTIPLAYER_SERVER_KEY, address);
		this.mpNameInput.value = "";
		this.mpServerInput.value = "";
		this.mpStatusEl.classList.remove("error");
		this.mpStatusEl.innerText = `Added "${name}".`;
		void this.refreshServerList();
	}

	private async connectMultiplayer(name: string, url: string): Promise<void> {
		const playerName = this.playerNameInput.value.trim();
		if (!playerName) {
			this.mpStatusEl.innerText = "Please enter your name.";
			this.mpStatusEl.classList.add("error");
			return;
		}

		setPlayerName(playerName);
		// Ensure the server entry exists (name → url mapping) so the clean
		// /server/<name> route can resolve the address on load.
		saveServer({ name, url });

		// No query string: the server address lives in the saved-servers list
		// (keyed by the name in the URL), and the player name is read from
		// localStorage on load.
		window.location.href = serverPath(name);
	}

	private async refreshServerList(): Promise<void> {
		this.mpStatusEl.innerText = "";
		this.mpStatusEl.classList.remove("error");

		const servers = getSavedServers();

		if (servers.length === 0) {
			this.mpServerListEl.replaceChildren(
				this.loadingRow("No saved servers — add one above."),
			);
			return;
		}

		const fragment = document.createDocumentFragment();
		const rows: HTMLElement[] = new Array(servers.length);

		for (let i = 0; i < servers.length; i++) {
			const row = this.serverRow(servers[i]);
			rows[i] = row;
			fragment.appendChild(row);
		}

		this.mpServerListEl.replaceChildren(fragment);

		let statuses: ServerStatus[];
		try {
			statuses = await fetchAllStatuses(servers);
		} catch (err) {
			this.mpStatusEl.innerText = `Could not refresh server status: ${String(err)}`;
			this.mpStatusEl.classList.add("error");
			return;
		}

		for (let i = 0; i < servers.length; i++) {
			this.updateServerRow(rows[i], servers[i], statuses[i]);
		}
	}

	/** Build the static parts of a server row (name + buttons). */
	private serverRow(server: SavedServer): HTMLElement {
		const row = document.createElement("div");
		row.className = "menu-server-row";

		const info = document.createElement("div");
		info.className = "server-info";
		const nameEl = document.createElement("div");
		nameEl.className = "server-name";
		nameEl.innerText = server.name;
		const motdEl = document.createElement("div");
		motdEl.className = "server-motd";
		motdEl.innerText = "Pinging…";
		const metaEl = document.createElement("div");
		metaEl.className = "server-meta";
		metaEl.innerHTML = `<span class="server-ping ping-offline"></span><span class="server-ping-num">—</span><span class="server-players">👤 —</span>`;
		info.appendChild(nameEl);
		info.appendChild(motdEl);
		info.appendChild(metaEl);
		row.appendChild(info);

		const joinBtn = document.createElement("button");
		btnSmallMinecraft(joinBtn, "Join");
		joinBtn.onclick = () =>
			void this.connectMultiplayer(server.name, server.url);
		row.appendChild(joinBtn);

		const delBtn = document.createElement("button");
		btnSmallMinecraft(delBtn, "✕");
		delBtn.title = "Remove";
		delBtn.onclick = () => {
			removeServer(server.url);
			void this.refreshServerList();
		};
		row.appendChild(delBtn);

		return row;
	}

	/** Fill a row with live status (MOTD, player count, ping dot). */
	private updateServerRow(
		row: HTMLElement,
		server: SavedServer,
		status: ServerStatus,
	): void {
		const motdEl = row.querySelector(".server-motd") as HTMLElement | null;
		const pingEl = row.querySelector(".server-ping") as HTMLElement | null;
		const pingNumEl = row.querySelector(
			".server-ping-num",
		) as HTMLElement | null;
		const playersEl = row.querySelector(
			".server-players",
		) as HTMLElement | null;

		if (motdEl) motdEl.innerText = status.motd || "(no message)";
		if (playersEl) {
			playersEl.innerText = status.online
				? `👤 ${status.players}/${status.maxPlayers}`
				: "👤 —";
		}
		if (pingEl) {
			pingEl.classList.remove(
				"ping-offline",
				"ping-good",
				"ping-ok",
				"ping-bad",
			);
			if (!status.online || status.pingMs < 0) {
				pingEl.classList.add("ping-offline");
				pingEl.title = "Offline";
				if (pingNumEl) pingNumEl.innerText = "—";
			} else {
				pingEl.title = `${status.pingMs} ms`;
				if (status.pingMs < 100) pingEl.classList.add("ping-good");
				else if (status.pingMs < 300) pingEl.classList.add("ping-ok");
				else pingEl.classList.add("ping-bad");
				if (pingNumEl) pingNumEl.innerText = `${status.pingMs} ms`;
			}
		}
	}

	private loadingRow(text: string): HTMLElement {
		const row = document.createElement("div");
		row.className = "menu-world-row empty";
		row.innerText = text;
		return row;
	}

	private addStyles(): void {
		const style = document.createElement("style");
		style.innerHTML = `
			#mainMenuContainer {
				position: fixed;
				inset: 0;
				z-index: 200;
				display: flex;
				flex-direction: column;
				align-items: center;
				justify-content: center;
				gap: 8px;
				background: radial-gradient(circle at 50% 30%, #1e2a33, #0e1418);
				color: #e8e8e8;
				font-family: "Segoe UI", system-ui, sans-serif;
			}

			#mainMenuContainer h1 {
				font-size: 3.5em;
				margin: 0 0 16px;
				text-shadow: 0 4px 12px rgba(0, 0, 0, 0.8), 0 0 40px rgba(127, 179, 213, 0.3);
				letter-spacing: 6px;
				font-weight: 700;
			}

			/* Player name bar at top of main screen */
			.player-name-bar {
				display: flex;
				flex-direction: column;
				align-items: center;
				gap: 4px;
				margin-bottom: 16px;
				width: 480px;
			}

			.player-name-label {
				font-size: 0.75em;
				text-transform: uppercase;
				letter-spacing: 1px;
				color: #9aa7b0;
				align-self: flex-start;
				margin-left: 4px;
			}

			.player-name-bar input {
				width: 100%;
				text-align: center;
				font-size: 1.1em;
			}

			#mainMenuContainer h2.screen-title {
				font-size: 1.5em;
				margin: 0 0 16px;
				color: #e8e8e8;
			}

			#mainMenuContainer h3.screen-subtitle {
				font-size: 1em;
				margin: 16px 0 8px;
				color: #9aa7b0;
				font-weight: 400;
			}

			.menu-screen {
				display: none;
				flex-direction: column;
				align-items: center;
				gap: 8px;
				width: 100%;
				max-width: 560px;
				max-height: 90vh;
				overflow-y: auto;
				padding: 16px;
			}

			.menu-screen.active {
				display: flex;
			}

			.menu-spacer {
				height: 16px;
			}

			/* Minecraft-style button */
			.mc-btn {
				width: 480px;
				padding: 12px 24px;
				font-size: 1.1em;
				font-family: inherit;
				border: 2px solid #3a3a3a;
				border-radius: 0;
				background: #5a5a5a linear-gradient(180deg, rgba(255,255,255,0.1) 0%, transparent 50%);
				color: #e8e8e8;
				cursor: pointer;
				text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
				transition: all 0.1s;
				position: relative;
			}

			.mc-btn:hover {
				background: #6a6a6a linear-gradient(180deg, rgba(255,255,255,0.15) 0%, transparent 50%);
				border-color: #7fb3d5;
				color: #fff;
			}

			.mc-btn:active {
				background: #4a4a4a;
			}

			/* Small button variant */
			.mc-btn-small {
				padding: 6px 12px;
				font-size: 0.9em;
				width: auto;
				min-width: 70px;
			}

			/* Create world / connect buttons — green accent */
			.mc-btn-green {
				border-color: #3a6a3a;
				background: #2d5a2d linear-gradient(180deg, rgba(255,255,255,0.08) 0%, transparent 50%);
			}

			.mc-btn-green:hover {
				border-color: #5d9c6a;
				background: #3d7a3d linear-gradient(180deg, rgba(255,255,255,0.12) 0%, transparent 50%);
			}

			/* Delete / remove buttons — red accent */
			.mc-btn-red {
				border-color: #6a3a3a;
				background: #5a2d2d linear-gradient(180deg, rgba(255,255,255,0.08) 0%, transparent 50%);
			}

			.mc-btn-red:hover {
				border-color: #9c5d5d;
				background: #7a3d3d linear-gradient(180deg, rgba(255,255,255,0.12) 0%, transparent 50%);
			}

			/* Back button — left aligned */
			.mc-btn-back {
				width: auto;
				min-width: 100px;
				margin-bottom: 16px;
				align-self: flex-start;
			}

			.menu-create-row {
				display: flex;
				gap: 8px;
				width: 100%;
				max-width: 50vh;
				align-items: center;
			}

			.menu-input-wrap {
				position: relative;
				flex: 1;
			}

			.menu-input-wrap input {
				width: 100%;
				padding-right: 40px;
				box-sizing: border-box;
			}

			.menu-input-wrap button {
				position: absolute;
				right: 6px;
				top: 50%;
				transform: translateY(-50%);
				background: none;
				border: none;
				color: #9aa7b0;
				cursor: pointer;
				padding: 4px;
				font-size: 1.1em;
				line-height: 1;
			}

			.menu-input-wrap button:hover {
				color: #e8e8e8;
			}

			.input-group {
				display: flex;
				flex-direction: column;
				gap: 2px;
				width: 100%;
				max-width: 50vh;
			}

			.input-label {
				font-size: 0.7em;
				text-transform: uppercase;
				letter-spacing: 1px;
				color: #9aa7b0;
				margin-left: 4px;
			}

			#mainMenuContainer input {
				width: 100%;
				padding: 10px 12px;
				font-size: 1em;
				font-family: inherit;
				border: 2px solid #3a3a3a;
				border-radius: 0;
				background: #1a1a1a;
				color: #e8e8e8;
				outline: none;
				box-sizing: border-box;
			}

			#mainMenuContainer input:focus {
				border-color: #7fb3d5;
				background: #222;
			}

			.menu-world-list,
			.menu-server-list {
				display: flex;
				flex-direction: column;
				gap: 4px;
				width: 100%;
				max-width: 50vh;
				max-height: 55vh;
				overflow-y: auto;
			}

			.menu-world-row,
			.menu-server-row {
				display: flex;
				align-items: center;
				gap: 8px;
				padding: 8px 12px;
				background: rgba(255, 255, 255, 0.03);
				border: 1px solid #2c3a44;
			}

			.menu-world-row.empty,
			.menu-server-row.empty {
				justify-content: center;
				color: #9aa7b0;
				font-style: italic;
			}

			.world-name {
				flex: 1;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
				font-size: 0.95em;
			}

			.server-info {
				flex: 1;
				min-width: 0;
			}

			.server-name {
				font-weight: 600;
				font-size: 0.9em;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			.server-url {
				font-size: 0.75em;
				color: #9aa7b0;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			/* List header (title + Refresh) */
			.menu-list-header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				width: 100%;
				max-width: 50vh;
				margin-top: 8px;
			}

			.menu-list-header .screen-subtitle {
				margin: 16px 0 8px;
			}

			.mc-btn-refresh {
				border-color: #3a5a6a;
				background: #2d4a5a linear-gradient(180deg, rgba(255,255,255,0.08) 0%, transparent 50%);
			}

			.mc-btn-refresh:hover {
				border-color: #5d9cc6;
				background: #3d6a7a linear-gradient(180deg, rgba(255,255,255,0.12) 0%, transparent 50%);
			}

			/* Server row live status */
			.server-motd {
				font-size: 0.78em;
				color: #c8d2da;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
				margin: 2px 0;
			}

			.server-meta {
				display: flex;
				align-items: center;
				gap: 8px;
				font-size: 0.75em;
				color: #9aa7b0;
			}

			.server-ping {
				width: 9px;
				height: 9px;
				border-radius: 50%;
				display: inline-block;
				flex: 0 0 auto;
			}

			.server-ping.ping-good { background: #5dd65d; box-shadow: 0 0 6px #5dd65d; }
			.server-ping.ping-ok { background: #e8c84b; box-shadow: 0 0 6px #e8c84b; }
			.server-ping.ping-bad { background: #e86a4b; box-shadow: 0 0 6px #e86a4b; }
			.server-ping.ping-offline { background: #5a5a5a; }

			.server-ping-num {
				font-variant-numeric: tabular-nums;
				min-width: 44px;
			}

			.server-players {
				font-variant-numeric: tabular-nums;
			}

			.menu-status {
				min-height: 1.2em;
				font-size: 0.85em;
				color: #9aa7b0;
				width: 100%;
				max-width: 50vh;
			}

			.menu-status.error {
				color: #ff9b9b;
			}

			@media (max-width: 480px) {
				.mc-btn { width: 320px; }
				#mainMenuContainer h1 { font-size: 2.5em; }
			}
		`;
		document.head.appendChild(style);
	}
}

// ─── Helper functions for Minecraft-style buttons ────────────────────────

function btnMinecraft(btn: HTMLButtonElement, text: string): void {
	btn.className = "mc-btn";
	btn.innerText = text;
}

function btnSmallMinecraft(btn: HTMLButtonElement, text: string): void {
	btn.className = "mc-btn mc-btn-small";
	btn.innerText = text;
}
