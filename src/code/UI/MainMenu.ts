import {
	isValidWorldName,
	removeStoredWorldSeed,
	sanitizeWorldName,
	setStoredWorldSeed,
	WORLD_SEED_BASE_KEY,
	worldLocalStorageKey,
	worldPath,
} from "../World/WorldContext";
import worldNames from "./worldNames.json";

/**
 * OPFS layout: b102/worlds/<name>/ — same tree the OPFS worker uses, so a
 * world created here is immediately visible to the game and vice versa.
 */
const OPFS_ROOT = "b102";
const OPFS_WORLDS = "worlds";

function randomWorldName(): string {
	const pick = (list: readonly string[]): string =>
		list[Math.floor(Math.random() * list.length)];
	return `${pick(worldNames.prefixes)}_${pick(worldNames.roots)}${pick(worldNames.suffixes)}`;
}

function randomSeed(): string {
	// Minecraft-style 64-bit signed seed (full range, including negatives).
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

/**
 * Remove a world directory. Safe on the menu page because no OPFS worker is
 * running here, so no file handles are open (an open sync access handle would
 * make removeEntry fail with NoModificationAllowedError).
 */
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

/**
 * Main menu — world list + create + delete. Pure DOM overlay (no engine),
 * following the same pattern as PauseMenu.
 */
export class MainMenu {
	private readonly container: HTMLElement;
	private readonly worldListEl: HTMLElement;
	private readonly nameInput: HTMLInputElement;
	private readonly seedInput: HTMLInputElement;
	private readonly statusEl: HTMLElement;

	constructor() {
		this.container = document.createElement("div");
		this.container.id = "mainMenuContainer";

		const title = document.createElement("h1");
		title.innerText = "b102";
		this.container.appendChild(title);

		const subtitle = document.createElement("p");
		subtitle.className = "main-menu-subtitle";
		subtitle.innerText = "Select a world to play";
		this.container.appendChild(subtitle);

		// Create-world row
		const createRow = document.createElement("div");
		createRow.className = "main-menu-create";

		this.nameInput = document.createElement("input");
		this.nameInput.type = "text";
		this.nameInput.placeholder = "New world name";
		this.nameInput.maxLength = 64;
		this.nameInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") void this.createWorld();
		});

		const createButton = document.createElement("button");
		createButton.innerText = "Create World";
		createButton.onclick = () => void this.createWorld();

		const randomButton = diceButton("Generate a random name", () => {
			this.nameInput.value = randomWorldName();
			this.nameInput.focus();
			this.statusEl.classList.remove("error");
			this.statusEl.innerText = "";
		});

		const inputWrap = document.createElement("div");
		inputWrap.className = "main-menu-input-wrap";
		inputWrap.appendChild(this.nameInput);
		inputWrap.appendChild(randomButton);

		createRow.appendChild(inputWrap);
		createRow.appendChild(createButton);
		this.container.appendChild(createRow);

		// Seed row
		this.seedInput = document.createElement("input");
		this.seedInput.type = "text";
		this.seedInput.placeholder = "Seed (optional)";
		this.seedInput.maxLength = 64;
		this.seedInput.title =
			"Optional terrain seed. Leave empty to derive it from the world name.";
		this.seedInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") void this.createWorld();
		});

		const seedRandomButton = diceButton("Generate a random seed", () => {
			this.seedInput.value = randomSeed();
			this.seedInput.focus();
			this.statusEl.classList.remove("error");
			this.statusEl.innerText = "";
		});

		const seedRow = document.createElement("div");
		seedRow.className = "main-menu-create";
		const seedWrap = document.createElement("div");
		seedWrap.className = "main-menu-input-wrap";
		seedWrap.appendChild(this.seedInput);
		seedWrap.appendChild(seedRandomButton);
		seedRow.appendChild(seedWrap);
		this.container.appendChild(seedRow);

		this.statusEl = document.createElement("div");
		this.statusEl.className = "main-menu-status";
		this.container.appendChild(this.statusEl);

		// World list
		this.worldListEl = document.createElement("div");
		this.worldListEl.className = "main-menu-worlds";
		this.container.appendChild(this.worldListEl);

		this.addStyles();
	}

	public mount(root: HTMLElement): void {
		root.appendChild(this.container);
		void this.refreshWorlds();
	}

	public dispose(): void {
		this.container.remove();
	}

	private async createWorld(): Promise<void> {
		const raw = this.nameInput.value;
		const name = sanitizeWorldName(raw);
		if (!isValidWorldName(name)) {
			this.statusEl.innerText = "Please enter a valid world name.";
			this.statusEl.classList.add("error");
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
		this.worldListEl.textContent = "";
		this.worldListEl.appendChild(this.loadingRow("Loading worlds…"));

		let worlds: string[];
		try {
			worlds = await listWorlds();
		} catch (err) {
			this.statusEl.innerText = `Could not read saved worlds: ${String(err)}`;
			this.statusEl.classList.add("error");
			return;
		}
		this.worldListEl.textContent = "";

		if (worlds.length === 0) {
			this.worldListEl.appendChild(
				this.loadingRow("No worlds yet — create one above."),
			);
			return;
		}

		for (const name of worlds) {
			this.worldListEl.appendChild(this.worldRow(name));
		}
	}

	private worldRow(name: string): HTMLElement {
		const row = document.createElement("div");
		row.className = "main-menu-world-row";

		const label = document.createElement("span");
		label.className = "main-menu-world-name";
		label.innerText = name;
		row.appendChild(label);

		const playButton = document.createElement("button");
		playButton.innerText = "Play";
		playButton.className = "play";
		playButton.onclick = () => {
			window.location.href = worldPath(name);
		};
		row.appendChild(playButton);

		const deleteButton = document.createElement("button");
		deleteButton.innerText = "Delete";
		deleteButton.className = "delete";
		deleteButton.onclick = () => void this.deleteWorld(name, deleteButton);
		row.appendChild(deleteButton);

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
			this.statusEl.innerText = `Deleted "${name}".`;
			this.statusEl.classList.remove("error");
			await this.refreshWorlds();
		} catch (err) {
			console.error("Failed to delete world", err);
			this.statusEl.innerText = `Failed to delete "${name}": ${String(err)}`;
			this.statusEl.classList.add("error");
			button.disabled = false;
			button.innerText = "Delete";
		}
	}

	private loadingRow(text: string): HTMLElement {
		const row = document.createElement("div");
		row.className = "main-menu-world-row empty";
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
        gap: 16px;
        background: radial-gradient(circle at 50% 30%, #1e2a33, #0e1418);
        color: #e8e8e8;
        font-family: sans-serif;
      }

      #mainMenuContainer h1 {
        font-size: 4em;
        margin: 0;
        text-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
        letter-spacing: 4px;
      }

      #mainMenuContainer .main-menu-subtitle {
        margin: 0 0 12px;
        color: #9aa7b0;
      }

      #mainMenuContainer .main-menu-create {
        display: flex;
        gap: 8px;
        margin-bottom: 8px;
      }

      #mainMenuContainer .main-menu-input-wrap {
        position: relative;
      }

      #mainMenuContainer .main-menu-input-wrap input {
        width: 100%;
        padding-right: 96px;
        box-sizing: border-box;
      }

      #mainMenuContainer .main-menu-input-wrap button {
        position: absolute;
        right: 4px;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 4px 8px;
        border: none;
        border-radius: 3px;
      }

      #mainMenuContainer input {
        width: 260px;
        padding: 10px 12px;
        font-size: 1em;
        border: 1px solid #45545e;
        border-radius: 4px;
        background: #141c22;
        color: #e8e8e8;
        outline: none;
      }

      #mainMenuContainer input:focus {
        border-color: #7fb3d5;
      }

      #mainMenuContainer button {
        font-size: 1em;
        padding: 10px 18px;
        border: 1px solid #7fb3d5;
        border-radius: 4px;
        background: #2c4a5c;
        color: #e8e8e8;
        cursor: pointer;
        transition: background-color 0.2s, color 0.2s;
      }

      #mainMenuContainer button:hover:not(:disabled) {
        background: #7fb3d5;
        color: #0e1418;
      }

      #mainMenuContainer button:disabled {
        opacity: 0.5;
        cursor: default;
      }

      #mainMenuContainer .main-menu-world-row {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 420px;
        max-width: 90vw;
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid #2c3a44;
        border-radius: 4px;
      }

      #mainMenuContainer .main-menu-world-row .main-menu-world-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #mainMenuContainer .main-menu-world-row button.play {
        border-color: #5d9c6a;
        background: #2c5c38;
      }

      #mainMenuContainer .main-menu-world-row button.delete {
        border-color: #9c5d5d;
        background: #5c2c2c;
      }

      #mainMenuContainer .main-menu-world-row.empty {
        justify-content: center;
        color: #9aa7b0;
        font-style: italic;
      }

      #mainMenuContainer .main-menu-worlds {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 50vh;
        overflow-y: auto;
      }

      #mainMenuContainer .main-menu-status {
        min-height: 1.2em;
        color: #9aa7b0;
      }

      #mainMenuContainer .main-menu-status.error {
        color: #ff9b9b;
      }
    `;
		document.head.appendChild(style);
	}
}
