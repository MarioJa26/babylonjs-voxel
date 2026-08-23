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
import { loadGameSettings, saveGameSettings } from "./GameSettings";
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

type MenuScreen = "main" | "singleplayer" | "multiplayer" | "options";

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

	// Options elements
	private readonly optionsScreen!: HTMLElement;
	private optFov!: { row: HTMLElement; getValue: () => number };
	private optSens!: { row: HTMLElement; getValue: () => number };
	private optRenderDist!: { row: HTMLElement; getValue: () => number };
	private optVertDist!: { row: HTMLElement; getValue: () => number };
	private optRenderScale!: { row: HTMLElement; getValue: () => number };
	private optMsaa!: { row: HTMLElement; getValue: () => boolean };
	private optFpsCap!: { row: HTMLElement; getValue: () => number };
	private optStatusEl!: HTMLElement;

	constructor() {
		this.container = document.createElement("div");
		this.container.id = "mainMenuContainer";

		const title = document.createElement("h1");
		title.innerText = "b102";
		this.container.appendChild(title);

		const tagline = document.createElement("div");
		tagline.className = "menu-tagline";
		tagline.innerText = "Voxel Sandbox";
		this.container.appendChild(tagline);

		// ─── Player Name (top of main screen) ────────────────────────
		const nameBar = document.createElement("div");
		nameBar.className = "player-name-bar";

		const nameLabel = document.createElement("label");
		nameLabel.className = "player-name-label";
		nameLabel.innerText = "Player Name";
		nameBar.appendChild(nameLabel);

		this.playerNameInput = document.createElement("input");
		this.playerNameInput.type = "text";
		this.playerNameInput.placeholder = "Player";
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
		optsBtn.onclick = () => this.showScreen("options");
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

		// ─── Options Screen ───────────────────────────────────────────
		this.optionsScreen = this.createOptionsScreen();
		this.container.appendChild(this.optionsScreen);

		this.addStyles();
	}

	makeOptionSlider(
		labelText: string,
		min: number,
		max: number,
		step: number,
		initial: number,
		format: (value: number) => string,
	): { row: HTMLElement; getValue: () => number } {
		const row = document.createElement("div");
		row.className = "slider-container";

		const label = document.createElement("label");
		label.innerText = labelText;

		const value = document.createElement("span");
		value.className = "slider-value";
		value.innerText = format(initial);

		const input = document.createElement("input");
		input.type = "range";
		input.min = String(min);
		input.max = String(max);
		input.step = String(step);
		input.value = String(initial);
		input.addEventListener("input", () => {
			value.innerText = format(Number(input.value));
		});

		row.append(label, value, input);
		return { row, getValue: () => Number(input.value) };
	}

	makeOptionToggle(
		labelText: string,
		initial: boolean,
		format: (value: boolean) => string,
	): { row: HTMLElement; getValue: () => boolean } {
		const row = document.createElement("div");
		row.className = "slider-container";

		const label = document.createElement("label");
		label.innerText = labelText;

		const value = document.createElement("span");
		value.className = "slider-value";
		value.innerText = format(initial);

		const btn = document.createElement("button");
		btn.className = "mc-btn mc-btn-small";
		btn.innerText = initial ? "ON" : "OFF";
		btn.onclick = () => {
			const next = !btn.classList.contains("on");
			btn.classList.toggle("on", next);
			btn.innerText = next ? "ON" : "OFF";
			value.innerText = format(next);
		};
		btn.classList.toggle("on", initial);

		row.append(label, value, btn);
		return { row, getValue: () => btn.classList.contains("on") };
	}

	private createOptionsScreen(): HTMLElement {
		const screen = document.createElement("div");
		screen.className = "menu-screen";
		screen.id = "optionsScreen";

		const back = document.createElement("button");
		btnMinecraft(back, "← Back");
		back.classList.add("mc-btn-back");
		back.onclick = () => this.showScreen("main");
		screen.appendChild(back);

		const title = document.createElement("h2");
		title.className = "screen-title";
		title.innerText = "Options";
		screen.appendChild(title);

		const settings = loadGameSettings();

		this.optFov = this.makeOptionSlider(
			"Field of View (FOV)",
			50,
			140,
			1,
			settings.fov,
			(v) => `${v}°`,
		);
		this.optSens = this.makeOptionSlider(
			"Mouse Sensitivity",
			1,
			20,
			1,
			Math.round(settings.mouseSensitivity * 1000),
			(v) => (v / 1000).toFixed(3),
		);
		this.optRenderDist = this.makeOptionSlider(
			"Render Distance",
			1,
			32,
			1,
			settings.renderDistance,
			(v) => `${v} chunks`,
		);
		this.optVertDist = this.makeOptionSlider(
			"Vertical Render Distance",
			1,
			20,
			1,
			settings.verticalRenderDistance,
			(v) => `${v} chunks`,
		);
		this.optRenderScale = this.makeOptionSlider(
			"Render Scale (GPU load)",
			50,
			200,
			5,
			Math.round(settings.renderScale * 100),
			(v) => `${v}%`,
		);
		this.optMsaa = this.makeOptionToggle(
			"MSAA (4x, costly)",
			settings.msaaEnabled,
			() => "",
		);
		this.optFpsCap = this.makeOptionSlider(
			"FPS Limit",
			0,
			120,
			30,
			settings.fpsCap,
			(v) => (v === 0 ? "Uncapped" : `${v} fps`),
		);

		for (const opt of [
			this.optFov,
			this.optSens,
			this.optRenderDist,
			this.optVertDist,
			this.optRenderScale,
			this.optMsaa,
			this.optFpsCap,
		]) {
			screen.appendChild(opt.row);
		}

		const saveBtn = document.createElement("button");
		btnMinecraft(saveBtn, "Save Settings");
		saveBtn.classList.add("mc-btn-green", "options-save");
		saveBtn.onclick = () => {
			const next = loadGameSettings();
			next.fov = this.optFov.getValue();
			next.mouseSensitivity = this.optSens.getValue() / 1000;
			next.renderDistance = this.optRenderDist.getValue();
			next.verticalRenderDistance = this.optVertDist.getValue();
			next.renderScale = this.optRenderScale.getValue() / 100;
			next.msaaEnabled = this.optMsaa.getValue();
			next.fpsCap = this.optFpsCap.getValue();
			saveGameSettings(next);
			this.optStatusEl.classList.remove("error");
			this.optStatusEl.innerText =
				"Settings saved — they apply the next time a world loads.";
		};
		screen.appendChild(saveBtn);

		this.optStatusEl = document.createElement("div");
		this.optStatusEl.className = "menu-status";
		this.optStatusEl.style.textAlign = "center";
		screen.appendChild(this.optStatusEl);

		return screen;
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
			case "options":
				this.optionsScreen.classList.add("active");
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
				this.loadingRow("No saved servers, add one below."),
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
				padding: 24px;
				box-sizing: border-box;
				background:
					radial-gradient(circle at 50% 22%, rgba(26, 163, 148, 0.07), transparent 55%),
					radial-gradient(circle at 50% 35%, rgb(18, 26, 34), rgb(7, 11, 15));
				color: var(--hud-text);
				font-family: var(--ui-font-family);
			}

			#mainMenuContainer h1 {
				font-size: 3.5em;
				margin: 0 0 2px;
				text-shadow:
					var(--hud-text-shadow),
					0 0 42px var(--hud-accent-faint);
				letter-spacing: 6px;
				font-weight: 700;
			}

			/* Olive signature bar under the title */
			#mainMenuContainer h1::after {
				content: "";
				display: block;
				width: 64px;
				height: 3px;
				margin: 10px auto 0;
				background: var(--hud-frame-bright);
				border-radius: var(--hud-radius-sm);
			}

			.menu-tagline {
				font-size: 0.85em;
				letter-spacing: 3px;
				text-transform: uppercase;
				color: var(--hud-text-muted);
				margin-bottom: 18px;
			}

			/* Player name bar at top of main screen */
			.player-name-bar {
				display: flex;
				flex-direction: column;
				align-items: center;
				gap: 4px;
				margin-bottom: 16px;
				width: min(480px, 90vw);
			}

			.player-name-label {
				font-size: 0.75em;
				text-transform: uppercase;
				letter-spacing: 1px;
				color: var(--hud-text-muted);
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
				color: var(--hud-text);
			}

			#mainMenuContainer h3.screen-subtitle {
				font-size: 1em;
				margin: 16px 0 8px;
				color: var(--hud-text-muted);
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
				scrollbar-width: thin;
				scrollbar-color: var(--hud-frame-bright) transparent;
			}

			.menu-screen.active {
				display: flex;
				animation: menu-fade-in 0.18s ease-out;
			}

			@keyframes menu-fade-in {
				from {
					opacity: 0;
					transform: translateY(6px);
				}
				to {
					opacity: 1;
					transform: translateY(0);
				}
			}

			.menu-spacer {
				height: 16px;
			}

			/* Minecraft-style button, HUD design language */
			.mc-btn {
				box-sizing: border-box;
				width: min(480px, 90vw);
				padding: 12px 24px;
				font-size: 1.05em;
				font-family: inherit;
				border: 2px solid var(--hud-frame);
				border-radius: 0;
				background-color: var(--hud-bg-inset);
				background-image: linear-gradient(180deg, rgba(255, 255, 255, 0.09) 0%, transparent 55%);
				color: var(--hud-text);
				cursor: pointer;
				text-shadow: var(--hud-text-shadow);
				user-select: none;
				transition:
					border-color 0.15s,
					background-color 0.15s,
					transform 0.1s;
			}

			.mc-btn:hover {
				background-image: linear-gradient(180deg, rgba(0, 187, 255, 0.12) 0%, transparent 60%);
				border-color: var(--hud-accent);
				color: #fff;
			}

			.mc-btn:active {
				background-color: rgba(0, 0, 0, 0.55);
				transform: translateY(1px);
			}

			.mc-btn:focus-visible {
				outline: none;
				box-shadow: var(--hud-focus-ring);
			}

			/* Small button variant */
			.mc-btn-small {
				padding: 7px 14px;
				font-size: 0.9em;
				width: auto;
				min-width: 74px;
			}

			/* Primary action buttons — cyan accent (matches --hud-accent) */
			.mc-btn-green {
				border-color: rgba(0, 187, 255, 0.45);
				background-color: var(--hud-accent-faint);
			}

			.mc-btn-green:hover {
				border-color: var(--hud-accent);
				background-color: rgba(0, 187, 255, 0.26);
			}

			/* Delete / remove buttons — red accent (matches --hud-danger) */
			.mc-btn-red {
				border-color: rgba(239, 83, 80, 0.45);
				background-color: rgba(239, 83, 80, 0.12);
			}

			.mc-btn-red:hover {
				border-color: var(--hud-danger);
				background-color: rgba(239, 83, 80, 0.24);
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
				max-width: min(480px, 90vw);
				align-items: center;
			}

			/* Buttons inside rows keep their natural size instead of stealing
			   the full column (this used to squeeze the seed input + dice). */
			.menu-create-row .mc-btn {
				width: auto;
				flex: 0 0 auto;
				white-space: nowrap;
			}

			.menu-input-wrap {
				position: relative;
				flex: 1;
				min-width: 0;
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
				color: var(--hud-text-muted);
				cursor: pointer;
				padding: 4px;
				font-size: 1.1em;
				line-height: 1;
			}

			.menu-input-wrap button:hover {
				color: var(--hud-accent);
			}

			.input-group {
				display: flex;
				flex-direction: column;
				gap: 2px;
				width: 100%;
				max-width: min(480px, 90vw);
			}

			.input-label {
				font-size: 0.7em;
				text-transform: uppercase;
				letter-spacing: 1px;
				color: var(--hud-text-muted);
				margin-left: 4px;
			}

			#mainMenuContainer input {
				width: 100%;
				padding: 10px 12px;
				font-size: 1em;
				font-family: inherit;
				border: 2px solid var(--hud-frame-dim);
				border-radius: 0;
				background: var(--hud-bg-inset);
				color: var(--hud-text);
				outline: none;
				box-sizing: border-box;
				transition:
					border-color 0.15s,
					box-shadow 0.15s,
					background-color 0.15s;
			}

			#mainMenuContainer input::placeholder {
				color: var(--hud-text-muted);
				opacity: 0.7;
			}

			#mainMenuContainer input:focus {
				border-color: var(--hud-accent);
				background: rgba(0, 0, 0, 0.6);
				box-shadow: var(--hud-focus-ring);
			}

			.menu-world-list,
			.menu-server-list {
				display: flex;
				flex-direction: column;
				gap: 6px;
				width: 100%;
				max-width: min(480px, 90vw);
				max-height: 55vh;
				overflow-y: auto;
				scrollbar-width: thin;
				scrollbar-color: var(--hud-frame-bright) transparent;
			}

			.menu-world-list::-webkit-scrollbar,
			.menu-server-list::-webkit-scrollbar,
			.menu-screen::-webkit-scrollbar {
				width: 8px;
			}

			.menu-world-list::-webkit-scrollbar-thumb,
			.menu-server-list::-webkit-scrollbar-thumb,
			.menu-screen::-webkit-scrollbar-thumb {
				background: var(--hud-frame-bright);
				border-radius: var(--hud-radius-md);
			}

			.menu-world-row,
			.menu-server-row {
				box-sizing: border-box;
				display: flex;
				align-items: center;
				gap: 8px;
				padding: 10px 12px;
				background-color: var(--hud-bg-panel);
				background-image: linear-gradient(180deg, rgba(255, 255, 255, 0.03) 0%, transparent 60%);
				border: var(--hud-border-width) solid var(--hud-border-soft);
				border-radius: var(--hud-radius-sm);
				transition: border-color 0.15s;
			}

			.menu-world-row:hover,
			.menu-server-row:hover {
				border-color: var(--hud-border-strong);
			}

			.menu-world-row.empty,
			.menu-server-row.empty {
				justify-content: center;
				color: var(--hud-text-muted);
				font-style: italic;
				background-image: none;
				background-color: transparent;
				border-style: dashed;
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
				color: var(--hud-text-muted);
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
				max-width: min(480px, 90vw);
				margin-top: 8px;
			}

			.menu-list-header .screen-subtitle {
				margin: 16px 0 8px;
			}

			.mc-btn-refresh {
				border-color: var(--hud-frame);
			}

			.mc-btn-refresh:hover {
				border-color: var(--hud-accent);
			}

			/* Server row live status */
			.server-motd {
				font-size: 0.78em;
				color: var(--hud-text);
				opacity: 0.85;
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
				color: var(--hud-text-muted);
			}

			.server-ping {
				width: 9px;
				height: 9px;
				border-radius: 50%;
				display: inline-block;
				flex: 0 0 auto;
			}

			.server-ping.ping-good {
				background: var(--hud-ok);
				box-shadow: 0 0 6px var(--hud-ok);
			}
			.server-ping.ping-ok {
				background: var(--hud-warn);
				box-shadow: 0 0 6px var(--hud-warn);
			}
			.server-ping.ping-bad {
				background: var(--hud-danger);
				box-shadow: 0 0 6px var(--hud-danger);
			}
			.server-ping.ping-offline {
				background: #5a646e;
			}

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
				color: var(--hud-text-muted);
				width: 100%;
				max-width: min(480px, 90vw);
			}

			.menu-status.error {
				color: var(--hud-danger);
			}

			@media (max-width: 480px) {
				#mainMenuContainer h1 {
					font-size: 2.5em;
				}
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
