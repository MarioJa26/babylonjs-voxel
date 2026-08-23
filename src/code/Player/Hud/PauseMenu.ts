import { worldToChunkCoord } from "@/code/Lib/VoxelMath";
import { Map1 } from "@/code/Maps/Map1";
import {
	type GameSettings,
	loadGameSettings,
	saveGameSettings,
} from "@/code/UI/GameSettings";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import {
	flushChunkBoundEntities,
	updateChunksAround,
} from "../../World/Chunk/ChunkLoadingSystem";
import { WorldStorage } from "../../World/WorldStorage";
import type { Player } from "../Player"; // Import Player to access its methods

export class PauseMenu {
	private menuContainer: HTMLElement;
	private mainButtonsContainer: HTMLElement;
	private settingsContainer: HTMLElement;
	private onResume: () => void;
	private onLeaveServer: (() => void) | null = null;
	private player: Player;
	private resumeButton: HTMLButtonElement | null = null;
	private saveButton: HTMLButtonElement | null = null;
	private titleElement: HTMLHeadingElement | null = null;
	private mainMenuButton: HTMLButtonElement | null = null;
	private isMultiplayer = false;

	constructor(onResume: () => void, player: Player) {
		this.onResume = onResume;
		this.player = player;
		this.menuContainer = this.createMenuElement();
		this.mainButtonsContainer = this.createMainButtons();
		this.settingsContainer = this.createSettingsPanel();
		this.menuContainer.appendChild(this.mainButtonsContainer);
		this.menuContainer.appendChild(this.settingsContainer);
		document.body.appendChild(this.menuContainer);

		this.hide();
	}

	public setLeaveServerCallback(cb: () => void): void {
		this.onLeaveServer = cb;
	}

	private createMenuElement(): HTMLElement {
		const container = document.createElement("div");
		container.id = "pauseMenuContainer";

		this.titleElement = document.createElement("h1");
		this.titleElement.innerText = "Paused";
		container.appendChild(this.titleElement);
		return container;
	}

	private createMainButtons(): HTMLElement {
		const container = document.createElement("div");
		container.id = "mainButtonsContainer";
		container.style.display = "flex";
		container.style.flexDirection = "column";
		container.style.alignItems = "center";
		container.style.gap = "15px";

		this.resumeButton = document.createElement("button");
		this.resumeButton.innerText = "Resume";
		this.resumeButton.onclick = () => this.onResume();
		container.appendChild(this.resumeButton);

		this.saveButton = document.createElement("button");
		this.saveButton.innerText = "Save Game";
		this.saveButton.onclick = async () => {
			this.saveButton!.innerText = "Saving...";
			this.saveButton!.disabled = true;
			try {
				await this.saveAll();
				this.saveButton!.innerText = "Saved!";
			} catch (e) {
				console.error("Save failed", e);
				this.saveButton!.innerText = "Error!";
			}

			setTimeout(() => {
				this.saveButton!.innerText = "Save Game";
				this.saveButton!.disabled = false;
			}, 1000);
		};
		container.appendChild(this.saveButton);

		const settingsButton = document.createElement("button");
		settingsButton.innerText = "Settings";
		settingsButton.onclick = () => this.showSettings(true);
		container.appendChild(settingsButton);

		this.mainMenuButton = document.createElement("button");
		this.mainMenuButton.innerText = "Main Menu";
		this.mainMenuButton.onclick = () => {
			if (this.onLeaveServer) {
				this.onLeaveServer();
			} else {
				this.saveAll().finally(() => {
					window.location.href = "/";
				});
			}
		};
		container.appendChild(this.mainMenuButton);

		return container;
	}

	private async saveAll(): Promise<void> {
		await WorldStorage.saveAllModifiedChunks();
		await flushChunkBoundEntities();
	}

	#persistSetting<K extends Exclude<keyof GameSettings, "msaaEnabled">>(
		key: K,
		value: number,
	): void {
		const settings = loadGameSettings();
		settings[key] = value;
		saveGameSettings(settings);
	}

	private createSettingsPanel(): HTMLElement {
		const container = document.createElement("div");
		container.id = "settingsContainer";
		container.style.display = "none"; // Initially hidden
		container.style.flexDirection = "column";
		container.style.alignItems = "center";
		container.style.gap = "15px";

		// --- World & Time ---
		container.appendChild(this.createSeparator("World & Time"));
		this.createSlider(
			container,
			"Time Scale",
			0,
			200,
			Map1.timeScale * 10,
			(value) => {
				Map1.timeScale = value / 10;
				return `x${(value / 10).toFixed(1)}`;
			},
		);

		container.appendChild(this.createSeparator("Player Settings"));

		// --- Player ---
		this.createSlider(
			container,
			"Mouse Sensitivity",
			1,
			15,
			this.player.playerCamera.mouseSensitivity * 1000,
			(value) => {
				const sensitivity = value / 1000;
				this.player.playerCamera.mouseSensitivity = sensitivity;
				this.#persistSetting("mouseSensitivity", sensitivity);
				return sensitivity.toFixed(3);
			},
		);

		this.createSlider(
			container,
			"Field of View (FOV)",
			50,
			140,
			this.player.playerCamera.playerCamera.fov * (180 / Math.PI),
			(value) => {
				this.player.playerCamera.fov = value;
				this.#persistSetting("fov", value);
				return `${value}°`;
			},
		);

		container.appendChild(this.createSeparator("Graphics"));

		// --- Graphics ---
		let initialized = false;

		this.createSlider(
			container,
			"Render Distance",
			1,
			32,
			SETTING_PARAMS.RENDER_DISTANCE,
			(value) => {
				SETTING_PARAMS.RENDER_DISTANCE = value;
				this.#persistSetting("renderDistance", value);

				if (initialized) {
					const pos = this.player.position;
					const chunkX = worldToChunkCoord(pos.x);
					const chunkY = worldToChunkCoord(pos.y);
					const chunkZ = worldToChunkCoord(pos.z);

					void updateChunksAround(
						chunkX,
						chunkY,
						chunkZ,
						value,
						SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
						// no prev coords → forces full volume scan
					);
				}

				return `${value} chunks`;
			},
		);

		initialized = true;

		const lodHeader = document.createElement("div");
		lodHeader.className = "collapsible-header";
		const lodHeaderText = document.createElement("span");
		lodHeaderText.innerText = "LOD Settings";
		const lodArrow = document.createElement("span");
		lodArrow.className = "collapsible-arrow";
		lodArrow.innerText = "▸";
		lodHeader.appendChild(lodHeaderText);
		lodHeader.appendChild(lodArrow);

		const lodSection = document.createElement("div");
		lodSection.style.display = "none";

		lodHeader.onclick = () => {
			const open = lodSection.style.display === "none";
			lodSection.style.display = open ? "block" : "none";
			lodArrow.innerText = open ? "▾" : "▸";
		};

		this.createSlider(
			lodSection,
			"Vertical Render Distance",
			1,
			20,
			SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
			(value) => {
				SETTING_PARAMS.VERTICAL_RENDER_DISTANCE = value;
				this.#persistSetting("verticalRenderDistance", value);
				return `${value} chunks`;
			},
		);

		const lodSliders: {
			key: {
				[K in keyof typeof SETTING_PARAMS]: (typeof SETTING_PARAMS)[K] extends number
					? K
					: never;
			}[keyof typeof SETTING_PARAMS];
			label: string;
			min: number;
			max: number;
		}[] = [
			{ key: "LOD_0_OFFSET", label: "LOD 0 Offset", min: 0, max: 10 },
			{ key: "LOD_1_OFFSET", label: "LOD 1 Offset", min: 0, max: 10 },
			{ key: "LOD_2_OFFSET", label: "LOD 2 Offset", min: 0, max: 10 },
			{ key: "LOD_3_OFFSET", label: "LOD 3 Offset", min: 0, max: 10 },
			{
				key: "LOD_VERTICAL_0_OFFSET",
				label: "LOD V0 Offset",
				min: 0,
				max: 10,
			},
			{
				key: "LOD_VERTICAL_1_OFFSET",
				label: "LOD V1 Offset",
				min: 0,
				max: 10,
			},
			{
				key: "LOD_VERTICAL_2_OFFSET",
				label: "LOD V2 Offset",
				min: 0,
				max: 10,
			},
			{
				key: "LOD_VERTICAL_3_OFFSET",
				label: "LOD V3 Offset",
				min: 0,
				max: 10,
			},
			{
				key: "LOD_PRECOMPUTE_HORIZONTAL_OFFSET",
				label: "Precompute H Offset",
				min: 0,
				max: 30,
			},
			{
				key: "LOD_PRECOMPUTE_VERTICAL_OFFSET",
				label: "Precompute V Offset",
				min: 0,
				max: 15,
			},
		];

		for (const { key, label, min, max } of lodSliders) {
			this.createSlider(
				lodSection,
				label,
				min,
				max,
				SETTING_PARAMS[key],
				(value) => {
					SETTING_PARAMS[key] = value;
					return `${value}`;
				},
			);
		}

		this.createSlider(
			lodSection,
			"Distant Render Dist",
			32,
			256,
			SETTING_PARAMS.DISTANT_RENDER_DISTANCE,
			(value) => {
				SETTING_PARAMS.DISTANT_RENDER_DISTANCE = value;
				return `${value} chunks`;
			},
		);

		container.appendChild(lodHeader);
		container.appendChild(lodSection);

		// --- Separator and Back Button ---
		const separator = document.createElement("hr");
		separator.className = "settings-hr";
		container.appendChild(separator);

		// Back Button
		const backButton = document.createElement("button");
		backButton.innerText = "Back";
		backButton.style.marginTop = "20px";
		backButton.onclick = () => this.showSettings(false);
		container.appendChild(backButton);

		return container;
	}

	private createSlider(
		container: HTMLElement,
		labelText: string,
		min: number,
		max: number,
		initialValue: number,
		onInput: (value: number) => string,
	) {
		const sliderContainer = document.createElement("div");
		sliderContainer.className = "slider-container";

		const label = document.createElement("label");
		label.innerText = labelText;

		const valueDisplay = document.createElement("span");
		valueDisplay.className = "slider-value";

		const slider = document.createElement("input");
		slider.type = "range";
		slider.min = String(min);
		slider.max = String(max);
		slider.value = String(initialValue);

		// Set initial display value
		valueDisplay.innerText = onInput(parseFloat(slider.value));

		slider.oninput = () => {
			valueDisplay.innerText = onInput(parseFloat(slider.value));
		};

		sliderContainer.appendChild(label);
		sliderContainer.appendChild(valueDisplay);
		sliderContainer.appendChild(slider);
		container.appendChild(sliderContainer);
	}

	private createSeparator(text: string): HTMLElement {
		const separator = document.createElement("div");
		separator.className = "settings-separator";
		separator.innerText = text;
		return separator;
	}

	public show(isMultiplayer = false) {
		this.isMultiplayer = isMultiplayer;

		if (this.titleElement) {
			this.titleElement.innerText = isMultiplayer ? "Game Menu" : "Paused";
		}

		if (this.resumeButton) {
			this.resumeButton.innerText = isMultiplayer ? "Resume" : "Resume Game";
		}

		if (this.saveButton) {
			this.saveButton.style.display = isMultiplayer ? "none" : "block";
		}

		if (this.mainMenuButton) {
			this.mainMenuButton.innerText = isMultiplayer
				? "Leave Server"
				: "Main Menu";
		}

		this.menuContainer.style.display = "flex";
	}

	public hide() {
		this.menuContainer.style.display = "none";
		this.showSettings(false);
		this.isMultiplayer = false;
	}

	private showSettings(show: boolean) {
		this.mainButtonsContainer.style.display = show ? "none" : "flex";
		this.settingsContainer.style.display = show ? "flex" : "none";
	}
}
