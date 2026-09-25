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
	CROSSHAIR_MAX_SIZE,
	CROSSHAIR_MIN_SIZE,
	type CrosshairGrid,
	type CrosshairPreview,
	type CrosshairSwatches,
	createCrosshairGrid,
	createCrosshairPreview,
	createCrosshairSwatches,
	ensureCrosshairOptionStyles,
	normalizeCrosshairColor,
	normalizeCrosshairId,
} from "../Player/Hud/Crosshair/CrosshairOptions";
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
import "./MainMenu.css";
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
	private optVolume!: { row: HTMLElement; getValue: () => number };
	private optMuted!: { row: HTMLElement; getValue: () => boolean };
	private optCrosshairSize!: { row: HTMLElement; getValue: () => number };
	private optCrosshairVisible!: { row: HTMLElement; getValue: () => boolean };
	private optHitmarker!: { row: HTMLElement; getValue: () => boolean };
	private crosshairId = "179";
	private crosshairColor = "#ffffff";
	private crosshairGrid?: CrosshairGrid;
	private crosshairSwatches?: CrosshairSwatches;
	private crosshairPreview?: CrosshairPreview;
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
		this.optVolume = this.makeOptionSlider(
			"Master Volume",
			0,
			100,
			5,
			Math.round(settings.masterVolume * 100),
			(v) => `${v}%`,
		);
		this.optMuted = this.makeOptionToggle(
			"Mute Audio",
			settings.muted,
			() => "",
		);

		for (const opt of [
			this.optFov,
			this.optSens,
			this.optRenderDist,
			this.optVertDist,
			this.optRenderScale,
			this.optMsaa,
			this.optFpsCap,
			this.optVolume,
			this.optMuted,
		]) {
			screen.appendChild(opt.row);
		}

		screen.appendChild(
			this.createCrosshairSection(settings.crosshairId, {
				size: settings.crosshairSize,
				color: settings.crosshairColor,
				visible: settings.crosshairVisible,
				hitmarkerEnabled: settings.hitmarkerEnabled,
			}),
		);

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
			next.masterVolume = this.optVolume.getValue() / 100;
			next.muted = this.optMuted.getValue();
			next.crosshairId = normalizeCrosshairId(this.crosshairId);
			next.crosshairSize = this.optCrosshairSize.getValue();
			next.crosshairColor = normalizeCrosshairColor(this.crosshairColor);
			next.crosshairVisible = this.optCrosshairVisible.getValue();
			next.hitmarkerEnabled = this.optHitmarker.getValue();
			saveGameSettings(next);
			setStatus(
				this.optStatusEl,
				"Settings saved — they apply the next time a world loads.",
			);
		};
		screen.appendChild(saveBtn);

		this.optStatusEl = document.createElement("div");
		this.optStatusEl.className = "menu-status";
		this.optStatusEl.style.textAlign = "center";
		screen.appendChild(this.optStatusEl);

		return screen;
	}

	/**
	 * Collapsible crosshair subsection (one layer deeper) so the 200-style
	 * grid, swatches and sliders don't dominate the Options screen.
	 */
	private createCrosshairSection(
		initialId: string,
		initial: {
			size: number;
			color: string;
			visible: boolean;
			hitmarkerEnabled: boolean;
		},
	): HTMLElement {
		ensureCrosshairOptionStyles();

		this.crosshairId = normalizeCrosshairId(initialId);
		this.crosshairColor = normalizeCrosshairColor(initial.color);

		const section = document.createElement("div");
		section.className = "crosshair-collapsible";

		const header = document.createElement("button");
		header.type = "button";
		header.className = "crosshair-collapsible-header";
		header.setAttribute("aria-expanded", "false");

		const headerText = document.createElement("span");
		headerText.innerText = "Crosshair";

		const arrow = document.createElement("span");
		arrow.innerText = "▸";
		arrow.setAttribute("aria-hidden", "true");
		header.append(headerText, arrow);

		const body = document.createElement("div");
		body.className = "crosshair-collapsible-body";
		body.style.display = "none";

		header.onclick = () => {
			const open = body.style.display === "none";
			body.style.display = open ? "flex" : "none";
			arrow.innerText = open ? "▾" : "▸";
			header.setAttribute("aria-expanded", String(open));
		};

		this.crosshairPreview = createCrosshairPreview({
			id: this.crosshairId,
			size: initial.size,
			color: this.crosshairColor,
			visible: initial.visible,
		});
		body.appendChild(this.crosshairPreview.element);

		this.optCrosshairSize = this.makeOptionSlider(
			"Crosshair Size",
			CROSSHAIR_MIN_SIZE,
			CROSSHAIR_MAX_SIZE,
			2,
			initial.size,
			(v) => `${v}px`,
		);
		this.optCrosshairVisible = this.makeOptionToggle(
			"Show Crosshair",
			initial.visible,
			() => "",
		);
		this.optHitmarker = this.makeOptionToggle(
			"Hit Marker",
			initial.hitmarkerEnabled,
			() => "",
		);

		this.crosshairSwatches = createCrosshairSwatches(
			this.crosshairColor,
			(hex) => {
				this.crosshairColor = normalizeCrosshairColor(hex);
				this.crosshairSwatches?.setSelected(this.crosshairColor);
				this.updateCrosshairPreview();
			},
		);

		this.crosshairGrid = createCrosshairGrid(this.crosshairId, (id) => {
			this.crosshairId = normalizeCrosshairId(id);
			this.crosshairGrid?.setSelected(this.crosshairId);
			this.updateCrosshairPreview();
		});

		body.append(
			this.optCrosshairSize.row,
			this.crosshairSwatches.element,
			this.optCrosshairVisible.row,
			this.optHitmarker.row,
			this.crosshairGrid.element,
		);

		// Keep the preview in sync with the slider/toggle rows.
		this.optCrosshairSize.row
			.querySelector("input")
			?.addEventListener("input", () => this.updateCrosshairPreview());
		for (const row of [this.optCrosshairVisible.row, this.optHitmarker.row]) {
			row
				.querySelector("button")
				?.addEventListener("click", () => this.updateCrosshairPreview());
		}

		section.append(header, body);
		return section;
	}

	private updateCrosshairPreview(): void {
		this.crosshairPreview?.update({
			id: this.crosshairId,
			size: this.optCrosshairSize?.getValue() ?? CROSSHAIR_MIN_SIZE,
			color: this.crosshairColor,
			visible: this.optCrosshairVisible?.getValue() ?? true,
		});
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
			setStatus(this.spStatusEl, "Please enter a valid world name.", true);
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
		setStatus(this.spStatusEl, "");
		this.worldListEl.replaceChildren(this.loadingRow("Loading worlds…"));

		let worlds: string[];
		try {
			worlds = await listWorlds();
		} catch (err) {
			this.worldListEl.replaceChildren();
			setStatus(
				this.spStatusEl,
				`Could not read saved worlds: ${String(err)}`,
				true,
			);
			return;
		}

		if (worlds.length === 0) {
			this.worldListEl.replaceChildren(
				this.loadingRow("No worlds yet — create one above."),
			);
			return;
		}

		renderRows(this.worldListEl, worlds, (name) => this.worldRow(name));
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
			setStatus(this.spStatusEl, `Deleted "${name}".`);
			await this.refreshWorlds();
		} catch (err) {
			console.error("Failed to delete world", err);
			setStatus(
				this.spStatusEl,
				`Failed to delete "${name}": ${String(err)}`,
				true,
			);
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
			setStatus(this.mpStatusEl, "Please enter a server name.", true);
			return;
		}
		if (!url) {
			setStatus(this.mpStatusEl, "Please enter a server address.", true);
			return;
		}

		saveServer({ name, url });
		localStorage.setItem(MULTIPLAYER_SERVER_KEY, address);
		this.mpNameInput.value = "";
		this.mpServerInput.value = "";
		setStatus(this.mpStatusEl, `Added "${name}".`);
		void this.refreshServerList();
	}

	private async connectMultiplayer(name: string, url: string): Promise<void> {
		const playerName = this.playerNameInput.value.trim();
		if (!playerName) {
			setStatus(this.mpStatusEl, "Please enter your name.", true);
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
		setStatus(this.mpStatusEl, "");

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
			setStatus(
				this.mpStatusEl,
				`Could not refresh server status: ${String(err)}`,
				true,
			);
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
		// Engine perf: styles are bundled via ./MainMenu.css (static import).
		// Kept as a no-op so existing constructor call sites stay valid.
	}
}

// ─── Helper functions for Minecraft-style buttons ────────────────────────

// Engine perf: cold UI paths only. Single place for status text + error
// styling (previously ~12 copy-pasted innerText/classList pairs).
function setStatus(el: HTMLElement, msg: string, isError = false): void {
	el.innerText = msg;
	el.classList.toggle("error", isError);
}

// Engine perf: cold UI paths only. Builds a fragment via rowFn and swaps it
// in with one replaceChildren (single layout pass).
function renderRows<T>(
	listEl: HTMLElement,
	items: readonly T[],
	rowFn: (item: T) => HTMLElement,
): void {
	const fragment = document.createDocumentFragment();
	for (const item of items) fragment.appendChild(rowFn(item));
	listEl.replaceChildren(fragment);
}

function btnMinecraft(btn: HTMLButtonElement, text: string): void {
	btn.className = "mc-btn";
	btn.innerText = text;
}

function btnSmallMinecraft(btn: HTMLButtonElement, text: string): void {
	btn.className = "mc-btn mc-btn-small";
	btn.innerText = text;
}
