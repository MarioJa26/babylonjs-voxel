import { Map1 } from "@/code/Maps/Map1";
import { Player } from "../Player"; // Import Player to access its methods
import { SettingParams } from "@/code/World/SettingParams";
import { SSAO2RenderingPipeline } from "@babylonjs/core";
import { WorldStorage } from "../../World/WorldStorage";
import { ChunkLoadingSystem } from "../../World/Chunk/ChunkLoadingSystem";

export class PauseMenu {
  private menuContainer: HTMLElement;
  private mainButtonsContainer: HTMLElement;
  private settingsContainer: HTMLElement;
  private onResume: () => void;
  private player: Player; // Store the player instance

  constructor(onResume: () => void, player: Player) {
    this.onResume = onResume;
    this.player = player; // Assign the player instance
    this.menuContainer = this.createMenuElement();
    this.mainButtonsContainer = this.createMainButtons(); // No change here, but uses player for settings
    this.settingsContainer = this.createSettingsPanel();
    this.menuContainer.appendChild(this.mainButtonsContainer);
    this.menuContainer.appendChild(this.settingsContainer);
    document.body.appendChild(this.menuContainer);

    // Add styles to the document
    this.addStyles();

    // Initially hide the menu
    this.hide();
  }

  private createMenuElement(): HTMLElement {
    const container = document.createElement("div");
    container.id = "pauseMenuContainer";

    const title = document.createElement("h1");
    title.innerText = "Paused";
    container.appendChild(title);
    return container;
  }

  private createMainButtons(): HTMLElement {
    const container = document.createElement("div");
    container.id = "mainButtonsContainer";
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.alignItems = "center";
    container.style.gap = "15px";

    // Resume Button
    const resumeButton = document.createElement("button");
    resumeButton.innerText = "Resume Game";
    resumeButton.onclick = () => {
      this.onResume();
    };
    container.appendChild(resumeButton);

    // Save Game Button
    const saveButton = document.createElement("button");
    saveButton.innerText = "Save Game";
    saveButton.onclick = async () => {
      saveButton.innerText = "Saving...";
      saveButton.disabled = true;
      try {
        await WorldStorage.saveAllModifiedChunks();
        await ChunkLoadingSystem.flushChunkBoundEntities();
        saveButton.innerText = "Saved!";
      } catch (e) {
        console.error("Save failed", e);
        saveButton.innerText = "Error!";
      }

      setTimeout(() => {
        saveButton.innerText = "Save Game";
        saveButton.disabled = false;
      }, 1000);
    };
    container.appendChild(saveButton);

    // Settings Button
    const settingsButton = document.createElement("button");
    settingsButton.innerText = "Settings";
    settingsButton.onclick = () => this.showSettings(true);
    container.appendChild(settingsButton);

    // Reset World Button
    const resetButton = document.createElement("button");
    resetButton.innerText = "Reset World";
    resetButton.style.backgroundColor = "#800000";
    resetButton.onclick = async () => {
      if (
        confirm(
          "Are you sure you want to delete your world? This cannot be undone.",
        )
      ) {
        resetButton.innerText = "Deleting...";
        resetButton.disabled = true;
        try {
          await WorldStorage.clearWorldData();
          window.location.reload();
        } catch (e) {
          console.error("Failed to reset world", e);
          resetButton.innerText = "Error!";
        }
      }
    };
    container.appendChild(resetButton);

    // Quit Button
    const quitButton = document.createElement("button");
    quitButton.innerText = "Quit Game";
    quitButton.onclick = () => {
      // For a web game, reloading is a simple way to "quit" to the start.
      window.location.reload();
    };
    container.appendChild(quitButton);

    return container;
  }

  private createSettingsPanel(): HTMLElement {
    const container = document.createElement("div");
    container.id = "settingsContainer";
    container.style.display = "none"; // Initially hidden
    container.style.flexDirection = "column";
    container.style.alignItems = "center";
    container.style.gap = "15px";
    container.style.width = "300px";
    container.style.padding = "20px";
    container.style.backgroundColor = "rgba(0, 0, 0, 0.7)";

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
        return `${value}°`;
      },
    );

    container.appendChild(this.createSeparator("Graphics"));

    // --- Graphics ---
    this.createSlider(
      container,
      "Render Distance",
      1,
      32,
      SettingParams.RENDER_DISTANCE,
      (value) => {
        SettingParams.RENDER_DISTANCE = value;
        return `${value} chunks`;
      },
    );

    // --- SSAO Toggle ---
    const ssaoToggleLabel = document.createElement("label");
    ssaoToggleLabel.style.display = "flex";
    ssaoToggleLabel.style.alignItems = "center";
    ssaoToggleLabel.style.marginTop = "10px";
    ssaoToggleLabel.style.width = "100%";
    ssaoToggleLabel.style.justifyContent = "space-between";

    const ssaoText = document.createElement("span");
    ssaoText.innerText = "Enable SSAO";

    const ssaoCheckbox = document.createElement("input");
    ssaoCheckbox.type = "checkbox";
    ssaoCheckbox.checked = SettingParams.ENABLE_SSAO;
    ssaoCheckbox.onchange = () => {
      SettingParams.ENABLE_SSAO = ssaoCheckbox.checked;
      this.toggleSSAO(ssaoCheckbox.checked);
    };
    ssaoToggleLabel.appendChild(ssaoText);
    ssaoToggleLabel.appendChild(ssaoCheckbox);
    container.appendChild(ssaoToggleLabel);

    // --- Separator and Back Button ---
    const separator = document.createElement("hr");
    separator.style.width = "100%";
    separator.style.border = "none";
    separator.style.borderTop = "1px solid #555";
    separator.style.margin = "20px 0";
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
    separator.innerText = text;
    separator.style.fontWeight = "bold";
    separator.style.marginTop = "15px";
    separator.style.marginBottom = "5px";
    separator.style.borderBottom = "1px solid #777";
    separator.style.width = "100%";
    separator.style.textAlign = "center";
    return separator;
  }

  private toggleSSAO(enabled: boolean) {
    const scene = this.player.playerCamera.playerCamera.getScene();
    const camera = this.player.playerCamera.playerCamera;

    if (enabled) {
      // Create new SSAO pipeline
      const ssao = new SSAO2RenderingPipeline(
        "ssao",
        scene,
        SettingParams.SSAO_RATIO,
        [camera],
      );
      ssao.radius = 2;
      ssao.totalStrength = 1.3;
      ssao.expensiveBlur = true;
    }
  }

  public show() {
    this.menuContainer.style.display = "flex";
  }

  public hide() {
    this.menuContainer.style.display = "none";
    this.showSettings(false); // Ensure settings are hidden when pause menu is hidden
  }

  private showSettings(show: boolean) {
    this.mainButtonsContainer.style.display = show ? "none" : "flex";
    this.settingsContainer.style.display = show ? "flex" : "none";
  }

  private addStyles() {
    const style = document.createElement("style");
    style.innerHTML = `
      #pauseMenuContainer {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(0, 0, 0, 0.5);
        color: white;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        font-family: sans-serif;
        z-index: 100;
      }

      #pauseMenuContainer h1 {
        font-size: 3em;
        margin-bottom: 20px;
        text-shadow: 2px 2px 4px #000000;
      }

      #pauseMenuContainer button {
        font-size: 1.5em;
        padding: 10px 20px;
        border: 2px solid white;
        background-color: #333;
        color: white;
        min-width: 200px;
        cursor: pointer;
        transition: background-color 0.3s, color 0.3s;
      }

      #pauseMenuContainer button:hover {
        background-color: white;
        color: #333;
      }

      .slider-container {
        width: 100%;
        display: grid;
        grid-template-columns: 1fr auto;
        grid-template-rows: auto auto;
        gap: 5px;
        margin-top: 10px;
      }
      .slider-container label {
        grid-column: 1 / 2;
      }
      .slider-container .slider-value {
        grid-column: 2 / 3;
        justify-self: end;
      }
      .slider-container input[type="range"] {
        grid-column: 1 / 3;
        width: 100%;
      }
    `;
    document.head.appendChild(style);
  }
}
