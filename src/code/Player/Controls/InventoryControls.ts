import type { Vec3 } from "@babylonjs/lite";
import type { IControls } from "@/code/Interface/IControls";
import { vec3Zero } from "@/code/Lib/Math";
import { PlayerInventory } from "../Inventory/PlayerInventory";
import type { Player } from "../Player";

export class InventoryControls implements IControls<unknown> {
	readonly controlType = "inventory";
	controlledEntity: unknown;
	pressedKeys: Set<string>;
	inputDirection: Vec3;

	#underlyingControls: IControls<unknown>;

	#player: Player;

	public static KEY_INVENTORY = ["tab", "escape"];
	public static KEY_DROP = ["q"];
	public static KEY_CTRL = ["control"];
	public static MOUSE1_INVENTORY = [0];

	constructor(
		controlledEntity: unknown,
		underlyingControls: IControls<unknown>,
		player: Player,
	) {
		this.controlledEntity = controlledEntity;
		this.pressedKeys = new Set<string>();
		this.inputDirection = vec3Zero();

		this.#underlyingControls = underlyingControls;
		this.#player = player;
	}

	/** Loose view of the not-yet-ported `Player` surface (inventory/hud/...). */
	#legacy(): any {
		return this.#player;
	}

	handleKeyEvent(key: string, isKeyDown: boolean): void {
		if (isKeyDown) this.onKeyDown(key);
		else this.onKeyUp(key);

		if (InventoryControls.KEY_INVENTORY.includes(key) && !isKeyDown) {
			this.#underlyingControls.handleKeyEvent(key, isKeyDown);
			this.#legacy().keyboardControls = this.#underlyingControls;
			return;
		}
		if (InventoryControls.KEY_DROP.includes(key) && isKeyDown) {
			const item = PlayerInventory.currentlyHoveredSlot?.item;
			if (item) {
				if (this.#pressedKeysHas(InventoryControls.KEY_CTRL))
					this.#legacy().playerInventory.dropItem(item, item.stackSize);
				else this.#legacy().playerInventory.dropItem(item, 1);
			}
			return;
		}
		this.#underlyingControls.handleKeyEvent(key, isKeyDown);
	}

	handleMouseEvent(mouseEvent: MouseEvent): void {
		if (
			InventoryControls.MOUSE1_INVENTORY.includes(mouseEvent.button) &&
			mouseEvent.shiftKey
		) {
			this.#moveItemToHotbar();
		}
	}

	#moveItemToHotbar(): void {
		const slotFocused = PlayerInventory.currentlyHoveredSlot;
		if (slotFocused?.item) {
			if (slotFocused.item.row > 0) {
				this.#legacy().playerInventory.moveItemToHotbar(slotFocused);
			} else {
				this.#legacy().playerInventory.moveItemToInventory(slotFocused);
			}
		}
	}

	onKeyUp(key: string): void {
		this.pressedKeys.delete(key);
	}
	onKeyDown(key: string): void {
		this.pressedKeys.add(key);
	}
	#pressedKeysHas(keys: string[]) {
		return keys.some((k) => this.pressedKeys.has(k));
	}
	public get underlyingControls(): IControls<unknown> {
		return this.#underlyingControls;
	}
	public set underlyingControls(value: IControls<unknown>) {
		this.#underlyingControls = value;
	}
}
