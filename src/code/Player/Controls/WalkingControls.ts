import type { Vec3 } from "@babylonjs/lite";
import type { Mob } from "@/code/Entities/Mobs/Mob";
import type { IControls } from "@/code/Interface/IControls";
import { Chunk } from "@/code/World/Chunk/Chunk";
import { validateChunksAround } from "@/code/World/Chunk/ChunkLoadingSystem";
import { MetadataContainer } from "../../Entities/MetadataContainer";
import type { BlockRaycastHit } from "../Hud/BlockHighlight/BlockRaycaster";
import { pickTarget } from "../Hud/BlockHighlight/BlockRaycaster";
import { BlockBreakingHandler } from "../Hud/BlockHighlight/BreakingBlockHandler";
import { Crosshair } from "../Hud/Crosshair/Crosshair";
import type { Item } from "../Inventory/Item";
import type { Player } from "../Player";
import type { PlayerVehicleMotor } from "../PlayerVehicleMotor";
import { handleDebugKey } from "./DebugControlHelper";

export class WalkingControls implements IControls<PlayerVehicleMotor> {
	readonly controlType = "walking";
	public pressedKeys = new Set<string>();
	#controlledEntity: PlayerVehicleMotor;
	#inputDirection: Vec3;
	#player: Player;
	#blockBreaking: BlockBreakingHandler;

	#lastJumpTapMs = 0;
	static readonly DOUBLE_TAP_MS = 260;

	static readonly #HOTBAR_KEY_MAP = new Map<string, number>([
		["1", 0],
		["!", 0],
		["2", 1],
		['"', 1],
		["3", 2],
		["§", 2],
		["4", 3],
		["$", 3],
		["5", 4],
		["%", 4],
		["6", 5],
		["&", 5],
		["7", 6],
		["/", 6],
		["8", 7],
		["(", 7],
		["9", 8],
		[")", 8],
		["0", 9],
		["=", 9],
	]);

	public static KEY_LEFT = ["a", "arrowleft"];
	public static KEY_RIGHT = ["d", "arrowright"];
	public static KEY_UP = ["w", "arrowup"];
	public static KEY_DOWN = ["s", "arrowdown"];
	public static KEY_USE = ["e"];
	public static KEY_PICK_BLOCK = ["r"];
	public static KEY_PICK_BLOCK_EXACT = ["t"];
	public static KEY_JUMP = [" "];
	public static KEY_SPRINT = ["capslock"];
	public static KEY_SNEAK = ["control", "shift"];
	public static KEY_FLASH = ["f"];
	public static KEY_INVENTORY = ["tab"];
	public static KEY_DROP = ["q"];
	public static KEY_CTRL = ["control"];
	public static KEY_ALT = ["alt"];
	public static KEY_PRINT_TRACE = ["o"];

	public static MOUSE_WHEEL_UP = ["wheel_up"];
	public static MOUSE_WHEEL_DOWN = ["wheel_down"];

	public static MOUSE1 = [0];
	public static MOUSE2 = [2];

	public static KEY_F5 = ["f5"];
	public static KEY_F6 = ["f6"];

	constructor(player: Player) {
		// The Lite `Player` now exposes the full `PlayerVehicleMotor` (an
		// `IPlayerBody`), so read the control surface directly.
		this.#controlledEntity = player.playerVehicle;
		this.#inputDirection = player.playerVehicle.inputDirection;
		this.#player = player;
		this.#blockBreaking = new BlockBreakingHandler(player);
	}

	public handleKeyEvent(key: string, isKeyDown: boolean) {
		if (isKeyDown) {
			this.onKeyDown(key);
		} else {
			this.onKeyUp(key);
		}
	}

	public handleMouseEvent(mouseEvent: MouseEvent, isKeyDown: boolean): void {
		if (WalkingControls.MOUSE1.includes(mouseEvent.button)) {
			if (isKeyDown) {
				const mobMesh = Crosshair.pickMobMesh(this.#player);
				if (mobMesh?.metadata instanceof MetadataContainer) {
					const mob: Mob | undefined = mobMesh.metadata.get("mob");
					mob?.takeDamage(1);
					return;
				}
				this.#blockBreaking.start();
			} else {
				this.#blockBreaking.stop();
			}
			return;
		}

		if (WalkingControls.MOUSE2.includes(mouseEvent.button) && isKeyDown) {
			const item =
				this.#player.playerInventory.inventory[0][
					this.#player.playerHud.selectedHotbarSlot
				]?.item;

			if (item) {
				item.use(this.#player);
			}
		}
	}

	public update(hit?: BlockRaycastHit | null): void {
		this.#blockBreaking.update(hit);
	}

	/**
	 * Cancel any in-progress block breaking. Called when a UI overlay opens so a
	 * held mouse button doesn't keep breaking a block while the menu is up.
	 */
	public stopBlockBreaking(): void {
		this.#blockBreaking.stop();
	}

	public onKeyDown(key: string) {
		const isAlreadyPressed = this.pressedKeys.has(key);
		if (isAlreadyPressed && !WalkingControls.KEY_JUMP.includes(key)) return;

		if (isAlreadyPressed && WalkingControls.KEY_JUMP.includes(key)) {
			this.#controlledEntity.isJumpHeld = true;
			this.#controlledEntity.wantJump = Math.max(
				this.#controlledEntity.wantJump,
				1,
			);
			return;
		}

		this.pressedKeys.add(key);

		if (handleDebugKey(key)) return;

		this.#updateMovementAxesFromPressedKeys();

		if (WalkingControls.KEY_JUMP.includes(key)) {
			this.#controlledEntity.isJumpHeld = true;
			const now = performance.now();

			if (now - this.#lastJumpTapMs <= WalkingControls.DOUBLE_TAP_MS) {
				this.#controlledEntity.toggleFlying();
				this.#controlledEntity.wantJump = 0;
				this.#lastJumpTapMs = 0;
			} else {
				this.#controlledEntity.wantJump++;
				this.#lastJumpTapMs = now;
			}
		} else if (WalkingControls.KEY_SPRINT.includes(key)) {
			this.#controlledEntity.isSprinting = true;
		} else if (WalkingControls.KEY_SNEAK.includes(key)) {
			this.#controlledEntity.isSneaking = true;
		} else if (WalkingControls.KEY_USE.includes(key)) {
			this.#player.use();
		} else if (WalkingControls.KEY_FLASH.includes(key)) {
			this.#player.flashlight.toggle();
		}

		if (WalkingControls.KEY_DROP.includes(key)) {
			const item =
				this.#player.playerInventory.inventory[0][
					this.#player.playerHud.selectedHotbarSlot
				]?.item;

			if (item) {
				if (this.#pressedKeysHas(WalkingControls.KEY_CTRL)) {
					this.#player.playerInventory.dropItem(item, item.stackSize);
				} else {
					this.#player.playerInventory.dropItem(item, 1);
				}
			}
			return;
		}
	}

	public onKeyUp(key: string) {
		if (WalkingControls.KEY_JUMP.includes(key)) {
			this.#controlledEntity.isJumpHeld = false;
			this.#controlledEntity.wantJump = 0;
		}

		if (WalkingControls.KEY_SPRINT.includes(key)) {
			this.#controlledEntity.isSprinting = false;
		}

		if (WalkingControls.KEY_SNEAK.includes(key)) {
			this.#controlledEntity.isSneaking = false;
		}

		if (WalkingControls.MOUSE_WHEEL_UP.includes(key)) {
			this.#player.playerHud.selectedHotbarSlot =
				(this.#player.playerHud.selectedHotbarSlot - 1) % 10;
			if (this.#player.playerHud.selectedHotbarSlot < 0) {
				this.#player.playerHud.selectedHotbarSlot = 9;
			}
		} else if (WalkingControls.MOUSE_WHEEL_DOWN.includes(key)) {
			this.#player.playerHud.selectedHotbarSlot =
				(this.#player.playerHud.selectedHotbarSlot + 1) % 10;
		}

		if (
			WalkingControls.KEY_F5.includes(key) ||
			(this.#pressedKeysHas(WalkingControls.KEY_ALT) &&
				WalkingControls.MOUSE_WHEEL_DOWN.includes(key))
		) {
			this.#controlledEntity.camera.zoomOut();
		} else if (
			WalkingControls.KEY_F6.includes(key) ||
			(this.#pressedKeysHas(WalkingControls.KEY_ALT) &&
				WalkingControls.MOUSE_WHEEL_UP.includes(key))
		) {
			this.#controlledEntity.camera.zoomIn();
		}

		if (
			WalkingControls.KEY_PICK_BLOCK.includes(key) ||
			WalkingControls.KEY_PICK_BLOCK_EXACT.includes(key)
		) {
			this.#handlePickBlock(key);
		}

		if (WalkingControls.KEY_INVENTORY.includes(key)) {
			// toggleInventory() is now the single source of truth for switching the
			// active control scheme (see PlayerHud.#activateInventoryControls /
			// #activateWalkingControls), so we no longer swap keyboardControls here.
			this.#player.playerHud.toggleInventory();
		}

		if (WalkingControls.KEY_PRINT_TRACE.includes(key)) {
			const size = Chunk.SIZE ?? 32;
			validateChunksAround(
				Math.floor(this.#player.position.x / size),
				Math.floor(this.#player.position.y / size),
				Math.floor(this.#player.position.z / size),
			);
		}

		const hotbarSlot = WalkingControls.#HOTBAR_KEY_MAP.get(key);
		if (hotbarSlot !== undefined) {
			this.#player.playerHud.selectedHotbarSlot = hotbarSlot;
		}

		this.pressedKeys.delete(key);
		this.#updateMovementAxesFromPressedKeys();
	}

	#handlePickBlock(key: string) {
		const hit = pickTarget(this.#player);
		if (!hit) return;

		const blockId = hit.blockId;
		const blockState = hit.blockState;

		if (blockId === 0) return;

		const isExactPickMode = WalkingControls.KEY_PICK_BLOCK_EXACT.includes(key);

		const matchesPickedBlock = (
			item: Item | null | undefined,
			requireExactState: boolean,
		): boolean => {
			if (!item) return false;

			const itemBlockId = item.blockId ?? item.itemId;
			if (itemBlockId !== blockId) return false;
			if (!requireExactState) return true;

			return (item.blockState ?? 0) === blockState;
		};

		const trySelectOrSwapMatchingItem = (
			requireExactState: boolean,
		): boolean => {
			const inventory = this.#player.playerInventory;
			for (let i = 0; i < 10; i++) {
				const hotbarItem = inventory.inventory[0][i].item;
				if (matchesPickedBlock(hotbarItem, requireExactState)) {
					this.#player.playerHud.selectedHotbarSlot = i;
					return true;
				}
			}

			const inv = inventory.inventory;
			for (let r = 1; r < inv.length; r++) {
				for (let c = 0; c < inv[r].length; c++) {
					if (matchesPickedBlock(inv[r][c].item, requireExactState)) {
						const selectedSlot = this.#player.playerHud.selectedHotbarSlot;
						const hotbarSlot = inv[0][selectedSlot];
						const inventorySlot = inv[r][c];
						hotbarSlot.swapSlots(inventorySlot);
						return true;
					}
				}
			}

			return false;
		};

		if (isExactPickMode) {
			if (trySelectOrSwapMatchingItem(true)) return;
			if (trySelectOrSwapMatchingItem(false)) return;
		} else {
			if (trySelectOrSwapMatchingItem(false)) return;
		}
	}

	#pressedKeysHas(keys: string[]) {
		return keys.some((k) => this.pressedKeys.has(k));
	}

	#updateMovementAxesFromPressedKeys() {
		const forward = this.#pressedKeysHas(WalkingControls.KEY_UP);
		const backward = this.#pressedKeysHas(WalkingControls.KEY_DOWN);
		const right = this.#pressedKeysHas(WalkingControls.KEY_RIGHT);
		const left = this.#pressedKeysHas(WalkingControls.KEY_LEFT);

		this.#inputDirection.z = forward === backward ? 0 : forward ? 1 : -1;
		this.#inputDirection.x = right === left ? 0 : right ? 1 : -1;
	}

	public get controlledEntity(): PlayerVehicleMotor {
		return this.#controlledEntity;
	}

	public get inputDirection(): Vec3 {
		return this.#inputDirection;
	}
}
