import { type Vec3, vec3 } from "@babylonjs/lite";
import type { Mob } from "@/code/Entities/Mobs/Mob";
import { segmentMobHit } from "@/code/Entities/Mobs/MobHitTest";
import { getMeleeDamage, getMeleeRange } from "@/code/Entities/WeaponStats";
import type { IControls } from "@/code/Interface/IControls";
import { playMobDamage } from "@/code/Maps/BlockBreakParticles";
import { Map1 } from "@/code/Maps/Map1";
import { Chunk } from "@/code/World/Chunk/Chunk";
import { validateChunksAround } from "@/code/World/Chunk/ChunkLoadingSystem";
import { isUiOpen, UiFocus } from "../../Lib/GameRuntimeState";
import type { BlockRaycastHit } from "../Hud/BlockHighlight/BlockRaycaster";
import { pickTarget } from "../Hud/BlockHighlight/BlockRaycaster";
import { BlockBreakingHandler } from "../Hud/BlockHighlight/BreakingBlockHandler";
import { swingHeldItemView } from "../Inventory/HeldItemView";
import type { Item } from "../Inventory/Item";
import { getRegisteredItemById } from "../Inventory/ItemRegistry";
import {
	BOW_DRAW_TIME,
	BOW_MIN_DRAW_TIME,
	playerHasArrows,
	useBow,
} from "../Inventory/ItemUseActions";
import type { Player } from "../Player";
import { Gamemodes } from "../PlayerStats";
import type { PlayerVehicleMotor } from "../PlayerVehicleMotor";
import { handleDebugKey } from "./DebugControlHelper";

type MeleeRay = {
	startX: number;
	startY: number;
	startZ: number;
	dirX: number;
	dirY: number;
	dirZ: number;
	reach: number;
};

type LocalMeleeHit = {
	kind: "local";
	mob: Mob;
	distance: number;
	x: number;
	y: number;
	z: number;
};

type RemoteMeleeHit = {
	kind: "remote";
	id: number;
	distance: number;
	x: number;
	y: number;
	z: number;
};

type MeleeHit = LocalMeleeHit | RemoteMeleeHit;

export class WalkingControls implements IControls<PlayerVehicleMotor> {
	readonly controlType = "walking";
	public pressedKeys = new Set<string>();
	#controlledEntity: PlayerVehicleMotor;
	#inputDirection: Vec3;
	#player: Player;
	#blockBreaking: BlockBreakingHandler;

	#lastJumpTapMs = 0;
	static readonly DOUBLE_TAP_MS = 260;

	// Bow draw state
	#isDrawing = false;
	#drawStartTime = 0;
	#drawProgress = 0;

	// Punch/mining swing: held-mouse repeats the swing until release.
	#miningHeld = false;
	#lastPunchMs = 0;
	static readonly PUNCH_REPEAT_MS = 350;

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
	public static KEY_CHAT = ["t"];
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

	/** Fire one punch swing: first-person viewmodel + third-person arm. */
	#firePunch(): void {
		swingHeldItemView();
		this.#player.triggerPunch();
		this.#lastPunchMs = performance.now();
	}

	public handleMouseEvent(mouseEvent: MouseEvent, isKeyDown: boolean): void {
		if (WalkingControls.MOUSE1.includes(mouseEvent.button)) {
			if (isKeyDown) {
				this.#firePunch();
				const target = this.#resolveMeleeTarget();
				if (target) {
					this.#applyMeleeHit(target);
					return;
				}
				this.#blockBreaking.start();
				this.#miningHeld = true;
			} else {
				this.#miningHeld = false;
				this.#blockBreaking.stop();
			}
			return;
		}

		if (WalkingControls.MOUSE2.includes(mouseEvent.button)) {
			if (isKeyDown) {
				this.#onRightClickDown();
			} else {
				this.#onRightClickUp();
			}
		}
	}

	/**
	 * Handle right-click press. If the selected item is a bow with arrows
	 * available, start drawing. Otherwise, use the item immediately.
	 */
	#onRightClickDown(): void {
		if (this.#isDrawing) return;

		const item = this.selectedItem;
		if (!item) return;

		if (this.#isBowItem(item)) {
			// Start drawing the bow — only if the player has ammunition
			if (playerHasArrows(this.#player)) {
				this.#isDrawing = true;
				this.#drawStartTime = performance.now();
				this.#drawProgress = 0;
			}
		} else {
			// Non-bow item: use immediately (previous behavior)
			item.use(this.#player);
		}
	}

	/**
	 * Handle right-click release. If drawing a bow, fire the arrow if the
	 * draw time exceeded the minimum threshold; otherwise cancel the shot.
	 */
	#onRightClickUp(): void {
		if (!this.#isDrawing) return;

		this.#isDrawing = false;
		const drawTime = (performance.now() - this.#drawStartTime) / 1000;

		if (drawTime >= BOW_MIN_DRAW_TIME) {
			// Fire the arrow with speed based on draw progress
			useBow(this.#player, this.#drawProgress);
		}

		this.#drawProgress = 0;
		this.#player.playerHud.updateDrawProgress(0);
		this.#player.playerCamera.clearBowZoom();
	}

	/** Check whether the given item is a bow (has the use_bow action). */
	#isBowItem(item: Item): boolean {
		const def = getRegisteredItemById(item.itemId);
		return def?.useAction === "use_bow";
	}

	/** The currently selected hotbar item (or null). */
	get selectedItem(): Item | null {
		return (
			this.#player.playerInventory.inventory[0][
				this.#player.playerHud.selectedHotbarSlot
			]?.item ?? null
		);
	}

	#applyMeleeHit(target: MeleeHit): void {
		this.#miningHeld = false;
		this.#blockBreaking.stop();
		const damage = getMeleeDamage(this.selectedItem?.itemId);
		if (target.kind === "local") {
			target.mob.takeDamage(damage, vec3(target.x, target.y, target.z));
			return;
		}

		playMobDamage(target.x, target.y, target.z, damage);
		const remote = Map1.remoteMobManager;
		const netClient = this.#player.networkManager?.netClient;
		if (!remote || !netClient) return;
		netClient.sendMobDamage(target.id, damage);
		remote.noteOutgoingDamage(target.id);
	}

	#getMeleeRay(): MeleeRay {
		const cam = this.#player.playerCamera.playerCamera;
		const startX = cam.position.x;
		const startY = cam.position.y;
		const startZ = cam.position.z;
		let dirX = cam.target.x - startX;
		let dirY = cam.target.y - startY;
		let dirZ = cam.target.z - startZ;
		const length = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
		dirX /= length;
		dirY /= length;
		dirZ /= length;

		return {
			startX,
			startY,
			startZ,
			dirX,
			dirY,
			dirZ,
			reach: getMeleeRange(this.selectedItem?.itemId),
		};
	}

	#findLocalMeleeHit(ray: MeleeRay): LocalMeleeHit | null {
		const registry = Map1.mobRegistry;
		if (!registry) return null;

		const endX = ray.startX + ray.dirX * ray.reach;
		const endY = ray.startY + ray.dirY * ray.reach;
		const endZ = ray.startZ + ray.dirZ * ray.reach;
		let bestT = Number.POSITIVE_INFINITY;
		let bestMob: Mob | null = null;

		for (const mob of registry.getAllMobs()) {
			if (mob.isDisposed) continue;
			const halfExtents = mob.hitHalfExtents;
			const t = segmentMobHit(
				ray.startX,
				ray.startY,
				ray.startZ,
				endX,
				endY,
				endZ,
				mob.position.x,
				mob.position.y,
				mob.position.z,
				mob.facingYaw,
				halfExtents.x,
				halfExtents.y,
				halfExtents.z,
			);
			if (t !== null && t < bestT) {
				bestT = t;
				bestMob = mob;
			}
		}

		if (bestMob === null) return null;
		return {
			kind: "local",
			mob: bestMob,
			distance: bestT * ray.reach,
			x: ray.startX + (endX - ray.startX) * bestT,
			y: ray.startY + (endY - ray.startY) * bestT,
			z: ray.startZ + (endZ - ray.startZ) * bestT,
		};
	}

	#findRemoteMeleeHit(ray: MeleeRay): RemoteMeleeHit | null {
		const remote = Map1.remoteMobManager;
		const netClient = this.#player.networkManager?.netClient;
		if (!remote || !netClient?.isConnected) return null;

		const hit = remote.findSegmentHit(
			ray.startX,
			ray.startY,
			ray.startZ,
			ray.startX + ray.dirX * ray.reach,
			ray.startY + ray.dirY * ray.reach,
			ray.startZ + ray.dirZ * ray.reach,
		);
		if (!hit) return null;

		return {
			kind: "remote",
			id: hit.id,
			distance: Math.sqrt(
				(hit.x - ray.startX) ** 2 +
					(hit.y - ray.startY) ** 2 +
					(hit.z - ray.startZ) ** 2,
			),
			x: hit.x,
			y: hit.y,
			z: hit.z,
		};
	}

	#resolveMeleeTarget(): MeleeHit | null {
		const ray = this.#getMeleeRay();
		const localHit = this.#findLocalMeleeHit(ray);
		const remoteHit = this.#findRemoteMeleeHit(ray);
		let target: MeleeHit | null = null;

		if (localHit && (!remoteHit || localHit.distance <= remoteHit.distance)) {
			target = localHit;
		} else if (remoteHit) {
			target = remoteHit;
		}

		if (!target) return null;
		const blockHit = pickTarget(this.#player);
		if (blockHit && blockHit.t <= target.distance) return null;
		return target;
	}

	public update(hit?: BlockRaycastHit | null): void {
		if (this.#miningHeld && this.#blockBreaking.isActive) {
			const target = this.#resolveMeleeTarget();
			if (target) this.#applyMeleeHit(target);
		}
		this.#blockBreaking.update(hit);

		// While the mining button is held, repeat the punch swing so the
		// arm keeps striking until release or the block breaks.
		if (this.#miningHeld && this.#blockBreaking.isActive) {
			if (
				performance.now() - this.#lastPunchMs >=
				WalkingControls.PUNCH_REPEAT_MS
			) {
				this.#firePunch();
			}
		}

		if (this.#isDrawing) {
			const elapsed = (performance.now() - this.#drawStartTime) / 1000;
			const progress = Math.min(1, elapsed / BOW_DRAW_TIME);

			if (progress === this.#drawProgress) return;

			this.#drawProgress = progress;
			this.#player.playerHud.updateDrawProgress(progress);
			this.#player.playerCamera.setBowZoom(progress);
		}
	}

	/**
	 * Cancel any in-progress bow draw. Called when the player switches items,
	 * opens a UI, or otherwise interrupts the draw.
	 */
	public cancelDraw(): void {
		if (!this.#isDrawing) return;
		this.#isDrawing = false;
		this.#drawProgress = 0;
		this.#player.playerHud.updateDrawProgress(0);
		this.#player.playerCamera.clearBowZoom();
	}

	/**
	 * Cancel any in-progress block breaking. Called when a UI overlay opens so a
	 * held mouse button doesn't keep breaking a block while the menu is up.
	 */
	public stopBlockBreaking(): void {
		this.#miningHeld = false;
		this.#blockBreaking.stop();
	}

	/**
	 * Set callback for when a block is broken (for multiplayer sync).
	 */
	public setOnBlockBroken(
		callback: (x: number, y: number, z: number, blockId: number) => void,
	): void {
		this.#blockBreaking.setOnBlockBroken(callback);
	}

	public onKeyDown(key: string) {
		if (isUiOpen(UiFocus.chat)) return;

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

		if (WalkingControls.KEY_CHAT.includes(key)) {
			this.#player.playerHud.chat.open();
			// Also open multiplayer chat if connected
			this.#player.networkManager?.toggleChat();
			return;
		}

		this.#updateMovementAxesFromPressedKeys();

		if (WalkingControls.KEY_JUMP.includes(key)) {
			this.#controlledEntity.isJumpHeld = true;
			const now = performance.now();

			if (now - this.#lastJumpTapMs <= WalkingControls.DOUBLE_TAP_MS) {
				if (this.#player.stats.gamemode !== Gamemodes.Survival) {
					this.#controlledEntity.toggleFlying();
				}
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
			this.#player.setUseHeld(true);
			this.#player.use();
		} else if (WalkingControls.KEY_FLASH.includes(key)) {
			this.#player.flashlight.toggle();
		}

		if (WalkingControls.KEY_DROP.includes(key)) {
			this.cancelDraw();
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
		if (isUiOpen(UiFocus.chat)) {
			this.pressedKeys.delete(key);
			this.#updateMovementAxesFromPressedKeys();
			return;
		}

		if (WalkingControls.KEY_JUMP.includes(key)) {
			this.#controlledEntity.isJumpHeld = false;
			this.#controlledEntity.wantJump = 0;
		}

		if (WalkingControls.KEY_SPRINT.includes(key)) {
			this.#controlledEntity.isSprinting = false;
		}

		if (WalkingControls.KEY_SNEAK.includes(key)) {
			this.#player.playerVehicle.isSneaking = false;
		}

		if (WalkingControls.KEY_USE.includes(key)) {
			this.#player.setUseHeld(false);
		}

		if (WalkingControls.MOUSE_WHEEL_UP.includes(key)) {
			this.#player.playerHud.selectedHotbarSlot =
				(this.#player.playerHud.selectedHotbarSlot - 1) % 10;
			if (this.#player.playerHud.selectedHotbarSlot < 0) {
				this.#player.playerHud.selectedHotbarSlot = 9;
			}
			this.cancelDraw();
		} else if (WalkingControls.MOUSE_WHEEL_DOWN.includes(key)) {
			this.#player.playerHud.selectedHotbarSlot =
				(this.#player.playerHud.selectedHotbarSlot + 1) % 10;
			this.cancelDraw();
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

		if (WalkingControls.KEY_PICK_BLOCK.includes(key)) {
			this.#handlePickBlock(key);
		}

		if (WalkingControls.KEY_INVENTORY.includes(key)) {
			// toggleInventory() is now the single source of truth for switching the
			// active control scheme (see PlayerHud.#activateInventoryControls /
			// #activateWalkingControls), so we no longer swap keyboardControls here.
			this.cancelDraw();
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
			this.cancelDraw();
		}

		this.pressedKeys.delete(key);
		this.#updateMovementAxesFromPressedKeys();
	}

	#handlePickBlock(_key: string) {
		const hit = pickTarget(this.#player);
		if (!hit) return;

		const blockId = hit.blockId;

		if (blockId === 0) return;

		const matchesPickedBlock = (item: Item | null | undefined): boolean => {
			if (!item) return false;
			const itemBlockId = item.blockId ?? item.itemId;
			return itemBlockId === blockId;
		};

		const inventory = this.#player.playerInventory;
		for (let i = 0; i < 10; i++) {
			const hotbarItem = inventory.inventory[0][i].item;
			if (matchesPickedBlock(hotbarItem)) {
				this.#player.playerHud.selectedHotbarSlot = i;
				this.cancelDraw();
				return;
			}
		}

		const inv = inventory.inventory;
		for (let r = 1; r < inv.length; r++) {
			for (let c = 0; c < inv[r].length; c++) {
				if (matchesPickedBlock(inv[r][c].item)) {
					const selectedSlot = this.#player.playerHud.selectedHotbarSlot;
					const hotbarSlot = inv[0][selectedSlot];
					const inventorySlot = inv[r][c];
					hotbarSlot.swapSlots(inventorySlot);
					return;
				}
			}
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
