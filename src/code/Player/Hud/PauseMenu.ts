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
import type { Player } from "../Player";

type NumericSettingKey = {
	[K in keyof typeof SETTING_PARAMS]: (typeof SETTING_PARAMS)[K] extends number
		? K
		: never;
}[keyof typeof SETTING_PARAMS];

interface SliderOptions {
	readonly label: string;
	readonly min: number;
	readonly max: number;
	readonly initialValue: number;
	readonly format: (value: number) => string;
	readonly onInput: (value: number) => void;
	readonly step?: number;
}

const LOD_SLIDERS: ReadonlyArray<{
	readonly key: NumericSettingKey;
	readonly label: string;
	readonly min: number;
	readonly max: number;
}> = [
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

export class PauseMenu {
	private readonly menuContainer: HTMLDivElement;
	private readonly mainButtonsContainer: HTMLDivElement;
	private readonly settingsContainer: HTMLDivElement;
	private readonly onResume: () => void;
	private readonly player: Player;

	private resumeButton!: HTMLButtonElement;
	private saveButton!: HTMLButtonElement;
	private titleElement!: HTMLHeadingElement;
	private mainMenuButton!: HTMLButtonElement;

	private onLeaveServer: (() => void) | null = null;
	private savePromise: Promise<void> | null = null;
	private saveResetTimer: ReturnType<typeof setTimeout> | null = null;
	private chunkUpdateFrame: number | null = null;
	private disposed = false;

	constructor(onResume: () => void, player: Player) {
		this.onResume = onResume;
		this.player = player;

		this.menuContainer = document.createElement("div");
		this.menuContainer.id = "pauseMenuContainer";

		this.titleElement = document.createElement("h1");
		this.titleElement.textContent = "Paused";
		this.menuContainer.appendChild(this.titleElement);

		this.mainButtonsContainer = this.createMainButtons();
		this.settingsContainer = this.createSettingsPanel();

		this.menuContainer.append(
			this.mainButtonsContainer,
			this.settingsContainer,
		);

		document.body.appendChild(this.menuContainer);
		this.hide();
	}

	public setLeaveServerCallback(callback: () => void): void {
		this.onLeaveServer = callback;
	}

	public show(isMultiplayer = false): void {
		this.titleElement.textContent = isMultiplayer ? "Game Menu" : "Paused";

		this.resumeButton.textContent = isMultiplayer ? "Resume" : "Resume Game";

		this.saveButton.style.display = isMultiplayer ? "none" : "";

		this.mainMenuButton.textContent = isMultiplayer
			? "Leave Server"
			: "Main Menu";

		this.showSettings(false);
		this.menuContainer.style.display = "flex";
	}

	public hide(): void {
		this.menuContainer.style.display = "none";
		this.showSettings(false);
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;

		if (this.saveResetTimer !== null) {
			clearTimeout(this.saveResetTimer);
			this.saveResetTimer = null;
		}

		if (this.chunkUpdateFrame !== null) {
			cancelAnimationFrame(this.chunkUpdateFrame);
			this.chunkUpdateFrame = null;
		}

		this.menuContainer.remove();
	}

	private createMainButtons(): HTMLDivElement {
		const container = document.createElement("div");
		container.id = "mainButtonsContainer";
		container.style.display = "flex";
		container.style.flexDirection = "column";
		container.style.alignItems = "center";
		container.style.gap = "15px";

		this.resumeButton = document.createElement("button");
		this.resumeButton.textContent = "Resume";
		this.resumeButton.addEventListener("click", this.handleResume);

		this.saveButton = document.createElement("button");
		this.saveButton.textContent = "Save Game";
		this.saveButton.addEventListener("click", this.handleSave);

		const settingsButton = document.createElement("button");
		settingsButton.textContent = "Settings";
		settingsButton.addEventListener("click", this.handleShowSettings);

		this.mainMenuButton = document.createElement("button");
		this.mainMenuButton.textContent = "Main Menu";
		this.mainMenuButton.addEventListener("click", this.handleMainMenu);

		container.append(
			this.resumeButton,
			this.saveButton,
			settingsButton,
			this.mainMenuButton,
		);

		return container;
	}

	private readonly handleResume = (): void => {
		this.onResume();
	};

	private readonly handleShowSettings = (): void => {
		this.showSettings(true);
	};

	private readonly handleSave = (): void => {
		void this.saveWithFeedback();
	};

	private readonly handleMainMenu = (): void => {
		if (this.mainMenuButton.disabled) {
			return;
		}

		this.mainMenuButton.disabled = true;

		if (this.onLeaveServer !== null) {
			try {
				this.onLeaveServer();
			} finally {
				this.mainMenuButton.disabled = false;
			}

			return;
		}

		void this.saveAll()
			.catch((error: unknown) => {
				console.error("Save before leaving failed", error);
			})
			.finally(() => {
				window.location.assign("/");
			});
	};

	/**
	 * Deduplicates concurrent saves. A Save Game click and a Main Menu click
	 * cannot start two full world flushes at the same time.
	 */
	private saveAll(): Promise<void> {
		if (this.savePromise !== null) {
			return this.savePromise;
		}

		this.savePromise = (async () => {
			await WorldStorage.saveAllModifiedChunks();
			await flushChunkBoundEntities();
		})().finally(() => {
			this.savePromise = null;
		});

		return this.savePromise;
	}

	private async saveWithFeedback(): Promise<void> {
		if (this.saveResetTimer !== null) {
			clearTimeout(this.saveResetTimer);
			this.saveResetTimer = null;
		}

		this.saveButton.textContent = "Saving...";
		this.saveButton.disabled = true;

		try {
			await this.saveAll();

			if (!this.disposed) {
				this.saveButton.textContent = "Saved!";
			}
		} catch (error: unknown) {
			console.error("Save failed", error);

			if (!this.disposed) {
				this.saveButton.textContent = "Error!";
			}
		}

		if (this.disposed) {
			return;
		}

		this.saveResetTimer = setTimeout(() => {
			this.saveResetTimer = null;

			if (this.disposed) {
				return;
			}

			this.saveButton.textContent = "Save Game";
			this.saveButton.disabled = false;
		}, 1000);
	}

	private persistSetting<K extends Exclude<keyof GameSettings, "msaaEnabled">>(
		key: K,
		value: GameSettings[K],
	): void {
		const settings = loadGameSettings();
		settings[key] = value;
		saveGameSettings(settings);
	}

	private createSettingsPanel(): HTMLDivElement {
		const container = document.createElement("div");
		container.id = "settingsContainer";
		container.style.display = "none";
		container.style.flexDirection = "column";
		container.style.alignItems = "center";
		container.style.gap = "15px";

		container.appendChild(this.createSeparator("World & Time"));

		this.createSlider(container, {
			label: "Time Scale",
			min: 0,
			max: 200,
			initialValue: Map1.timeScale * 10,
			format: (value) => `x${(value / 10).toFixed(1)}`,
			onInput: (value) => {
				Map1.timeScale = value / 10;
			},
		});

		container.appendChild(this.createSeparator("Player Settings"));

		this.createSlider(container, {
			label: "Mouse Sensitivity",
			min: 1,
			max: 15,
			initialValue: this.player.playerCamera.mouseSensitivity * 1000,
			format: (value) => (value / 1000).toFixed(3),
			onInput: (value) => {
				const sensitivity = value / 1000;
				this.player.playerCamera.mouseSensitivity = sensitivity;
				this.persistSetting("mouseSensitivity", sensitivity);
			},
		});

		this.createSlider(container, {
			label: "Field of View (FOV)",
			min: 50,
			max: 140,
			initialValue: this.player.playerCamera.playerCamera.fov * (180 / Math.PI),
			format: (value) => `${value}°`,
			onInput: (value) => {
				this.player.playerCamera.fov = value;
				this.persistSetting("fov", value);
			},
		});

		container.appendChild(this.createSeparator("Graphics"));

		this.createSlider(container, {
			label: "Render Distance",
			min: 1,
			max: 32,
			initialValue: SETTING_PARAMS.RENDER_DISTANCE,
			format: (value) => `${value} chunks`,
			onInput: (value) => {
				SETTING_PARAMS.RENDER_DISTANCE = value;
				this.persistSetting("renderDistance", value);
				this.scheduleChunkUpdate();
			},
		});

		const lodHeader = document.createElement("button");
		lodHeader.type = "button";
		lodHeader.className = "collapsible-header";
		lodHeader.setAttribute("aria-expanded", "false");

		const lodHeaderText = document.createElement("span");
		lodHeaderText.textContent = "LOD Settings";

		const lodArrow = document.createElement("span");
		lodArrow.className = "collapsible-arrow";
		lodArrow.textContent = "▸";
		lodArrow.setAttribute("aria-hidden", "true");

		lodHeader.append(lodHeaderText, lodArrow);

		const lodSection = document.createElement("div");
		lodSection.style.display = "none";

		lodHeader.addEventListener("click", () => {
			const open = lodSection.style.display === "none";
			lodSection.style.display = open ? "block" : "none";
			lodArrow.textContent = open ? "▾" : "▸";
			lodHeader.setAttribute("aria-expanded", String(open));
		});

		this.createSlider(lodSection, {
			label: "Vertical Render Distance",
			min: 1,
			max: 20,
			initialValue: SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
			format: (value) => `${value} chunks`,
			onInput: (value) => {
				SETTING_PARAMS.VERTICAL_RENDER_DISTANCE = value;
				this.persistSetting("verticalRenderDistance", value);
				this.scheduleChunkUpdate();
			},
		});

		for (const definition of LOD_SLIDERS) {
			this.createSlider(lodSection, {
				label: definition.label,
				min: definition.min,
				max: definition.max,
				initialValue: SETTING_PARAMS[definition.key],
				format: String,
				onInput: (value) => {
					SETTING_PARAMS[definition.key] = value;
				},
			});
		}

		this.createSlider(lodSection, {
			label: "Distant Render Dist",
			min: 32,
			max: 256,
			initialValue: SETTING_PARAMS.DISTANT_RENDER_DISTANCE,
			format: (value) => `${value} chunks`,
			onInput: (value) => {
				SETTING_PARAMS.DISTANT_RENDER_DISTANCE = value;
			},
		});

		container.append(lodHeader, lodSection);

		const separator = document.createElement("hr");
		separator.className = "settings-hr";

		const backButton = document.createElement("button");
		backButton.textContent = "Back";
		backButton.style.marginTop = "20px";
		backButton.addEventListener("click", () => {
			this.showSettings(false);
		});

		container.append(separator, backButton);

		return container;
	}

	/**
	 * Coalesces multiple range-input events into one chunk scan per animation
	 * frame and always uses the latest horizontal and vertical distances.
	 */
	private scheduleChunkUpdate(): void {
		if (this.chunkUpdateFrame !== null) {
			return;
		}

		this.chunkUpdateFrame = requestAnimationFrame(() => {
			this.chunkUpdateFrame = null;

			if (this.disposed) {
				return;
			}

			const position = this.player.position;

			void updateChunksAround(
				worldToChunkCoord(position.x),
				worldToChunkCoord(position.y),
				worldToChunkCoord(position.z),
				SETTING_PARAMS.RENDER_DISTANCE,
				SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
			).catch((error: unknown) => {
				console.error("Chunk render-distance update failed", error);
			});
		});
	}

	private createSlider(
		container: HTMLElement,
		options: SliderOptions,
	): HTMLInputElement {
		const sliderContainer = document.createElement("div");
		sliderContainer.className = "slider-container";

		const label = document.createElement("label");
		label.textContent = options.label;

		const valueDisplay = document.createElement("span");
		valueDisplay.className = "slider-value";

		const slider = document.createElement("input");
		slider.type = "range";
		slider.min = String(options.min);
		slider.max = String(options.max);
		slider.step = String(options.step ?? 1);

		const initialValue = Math.min(
			options.max,
			Math.max(options.min, options.initialValue),
		);

		slider.value = String(initialValue);
		valueDisplay.textContent = options.format(initialValue);

		label.append(valueDisplay, slider);
		sliderContainer.appendChild(label);
		container.appendChild(sliderContainer);

		slider.addEventListener("input", () => {
			const value = slider.valueAsNumber;

			if (!Number.isFinite(value)) {
				return;
			}

			valueDisplay.textContent = options.format(value);
			options.onInput(value);
		});

		return slider;
	}

	private createSeparator(text: string): HTMLDivElement {
		const separator = document.createElement("div");
		separator.className = "settings-separator";
		separator.textContent = text;
		return separator;
	}

	private showSettings(show: boolean): void {
		this.mainButtonsContainer.style.display = show ? "none" : "flex";
		this.settingsContainer.style.display = show ? "flex" : "none";
	}
}
