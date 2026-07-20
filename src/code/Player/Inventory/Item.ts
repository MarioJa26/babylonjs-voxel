import type { ShaderMaterial } from "@babylonjs/lite";
import type { IUsable } from "@/code/Interface/IUsable";
import type { BoatChunk } from "@/code/World/Boat/BoatChunk";
import { setBlock } from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	getShapeForBlockId,
	shapeInitPromise,
} from "@/code/World/Shape/BlockShapes";
import { getSliceAxis } from "@/code/World/Shape/BlockShapeTransforms";
import { BlockType } from "@/code/World/Texture/BlockType";
import { TextureDefinitions } from "@/code/World/Texture/TextureDefinitions";
import { Map1 } from "../../Maps/Map1";
import {
	getPlacementHit,
	pickBlock,
} from "../Hud/BlockHighlight/BlockRaycaster";
import type { Player } from "../Player";
import { drawCubeIcon, getShapeHeightScale } from "./CubeIcon";
import { getRegisteredItemById, type ItemDefinition } from "./ItemRegistry";
import { ItemUseActions } from "./ItemUseActions";

type BoatPlacementContext = {
	kind: "boatChunk";
	boatChunk: BoatChunk;
	localX: number;
	localY: number;
	localZ: number;
	localHitNx: number;
	localHitNy: number;
	localHitNz: number;
};

export class Item implements IUsable {
	private static readonly SLICE_SHAPE_ROTATION_POLICY: Record<
		string,
		{ rotateVerticalByYaw: boolean }
	> = {
		cube: { rotateVerticalByYaw: true },
		slab: { rotateVerticalByYaw: true },
	};

	name: string;
	description: string;
	icon: string;
	material: ShaderMaterial | undefined;

	itemId = 1;
	blockId: number | null = null;
	blockState = 0;

	#maxStack = 64;
	#stackSize = 1;
	#div: HTMLDivElement = document.createElement("div");
	#stackLabel: HTMLSpanElement = document.createElement("span");
	#cubeCanvas: HTMLCanvasElement = document.createElement("canvas");
	#useAction: ((player: Player) => void) | null = null;
	row: number;
	col: number;

	constructor(
		name: string,
		description: string,
		icon: string,
		row: number,
		col: number,
		maxStack?: number,
	) {
		if (typeof maxStack === "number") {
			this.#maxStack = Math.max(1, Math.floor(maxStack));
			this.#stackSize = Math.min(this.#stackSize, this.#maxStack);
		}
		this.name = name;
		this.description = description;
		this.icon = icon;
		this.row = row;
		this.col = col;
		this.#div = this.createDiv();
	}

	private static createFromDefinition(
		def: ItemDefinition,
		row: number,
		col: number,
	): Item {
		const icon = def.icon ?? "";

		const item = new Item(
			def.name,
			def.description ?? def.name,
			icon,
			row,
			col,
			def.maxStack,
		);
		item.itemId = def.id;
		item.blockId = def.blockId ?? def.id;
		item.blockState = def.blockState ?? 0;
		item.refreshIconStyle();

		if (def.useAction === "place_block") {
			item.#useAction = (player: Player) => Item.place(player);
		} else if (def.useAction) {
			const action = ItemUseActions[def.useAction];
			if (action) {
				item.#useAction = action;
			} else {
				console.warn(`Unknown item use action: ${def.useAction}`);
			}
		}

		return item;
	}

	static createById(itemId: number, row = -1, col = -1): Item {
		const def = getRegisteredItemById(itemId);
		if (def) {
			return Item.createFromDefinition(def, row, col);
		}

		const textureDef = TextureDefinitions.find((t) => t.id === itemId);
		if (!textureDef) throw new Error("Item not found");

		const item = new Item(textureDef.name, "Crafted Item", "", row, col);
		item.itemId = itemId;
		item.blockId = itemId;
		item.blockState = 0;
		item.refreshIconStyle();

		return item;
	}

	use(player: Player): void {
		if (this.#useAction) {
			this.#useAction(player);
		} else {
			Item.place(player);
		}
	}

	static place(player: Player) {
		const blockNumber = pickBlock(player);
		if (blockNumber === BlockType.CraftingTable) return;

		const hit = getPlacementHit(player);
		if (!hit) return;

		const { pos, nx, ny, nz, hitFracX, hitFracY, hitFracZ } = hit;

		const item =
			player.playerInventory.inventory[0][player.playerHud.selectedHotbarSlot]
				?.item;

		if (item) {
			const blockId = item.blockId ?? item.itemId;
			let blockState = item.blockState ?? 0;
			// Water always placed as source: level 0
			if (blockId === BlockType.Water) blockState = 0;
			const shape = getShapeForBlockId(blockId);
			const yaw = player.playerCamera.cameraYaw;
			const hasSlice = (blockState >> 3) & 7;

			let rotation = 0;
			let slice = 0;
			let flipY = false;

			if (hasSlice > 0) {
				const sliceBits = blockState & ~7;
				const existingRotation = blockState & 7;
				const originalSliceAxis = getSliceAxis(existingRotation);
				const policy = Item.SLICE_SHAPE_ROTATION_POLICY[shape.name] ?? {
					rotateVerticalByYaw: true,
				};

				rotation = existingRotation & 3;
				if (originalSliceAxis !== 1 && policy.rotateVerticalByYaw) {
					rotation = Item.getWallRotationFromYaw(yaw);
				}
				const sliceAxis = getSliceAxis(rotation);

				flipY = (existingRotation & 4) !== 0;
				if (sliceAxis === 1) {
					// Horizontal slabs: only top/bottom.
					if (ny === -1) flipY = true;
					else if (ny === 1) flipY = false;
					else flipY = hitFracY > 0.5;
				} else if (sliceAxis === 0) {
					// Vertical slabs on X: only +/-X side.
					flipY = nx !== 0 ? nx < 0 : hitFracX > 0.5;
				} else {
					// Vertical slabs on Z: only +/-Z side.
					flipY = nz !== 0 ? nz < 0 : hitFracZ > 0.5;
				}

				const flipBit = flipY ? 4 : 0;
				blockState = sliceBits | flipBit | rotation;
				slice = (blockState >> 3) & 7;
			} else if (shape.rotateY) {
				const quarterTurn = Math.PI / 2;
				const normalized =
					((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
				rotation =
					(Math.floor((normalized + quarterTurn / 2) / quarterTurn) & 3) ^ 2;
				rotation = (4 - rotation) & 3;
				flipY = (shape.allowFlipY && ny === -1) || hitFracY > 0.5;
				const flipBit = flipY ? 4 : 0;
				const sliceBits = blockState & ~7;
				blockState = sliceBits | flipBit | rotation;
			}

			// Prevent placing a block inside the player - use actual voxel collider
			if (
				player.playerVehicle.wouldBlockOverlapPlayer(
					pos.x,
					pos.y,
					pos.z,
					shape,
					rotation,
					slice,
					flipY,
				)
			) {
				return;
			}

			// Prevent placing a block inside a mob
			const mobRegistry = Map1.mobRegistry;
			if (mobRegistry) {
				for (const mob of mobRegistry.getAllMobs()) {
					const mpos = mob.position;
					if (
						mpos.x >= pos.x &&
						mpos.x < pos.x + 1 &&
						mpos.y >= pos.y &&
						mpos.y < pos.y + 1 &&
						mpos.z >= pos.z &&
						mpos.z < pos.z + 1
					) {
						return;
					}
				}
			}

			const boatContext = Item.#asBoatPlacementContext(hit.dynamicContext);
			if (boatContext) {
				const placeLocalX = boatContext.localX + boatContext.localHitNx;
				const placeLocalY = boatContext.localY + boatContext.localHitNy;
				const placeLocalZ = boatContext.localZ + boatContext.localHitNz;
				if (
					boatContext.boatChunk.isInsideLocalBounds(
						placeLocalX,
						placeLocalY,
						placeLocalZ,
					)
				) {
					boatContext.boatChunk.setBlockLocal(
						placeLocalX,
						placeLocalY,
						placeLocalZ,
						blockId,
						blockState,
					);
					return;
				}
			}

			setBlock(pos.x, pos.y, pos.z, blockId, blockState);
		}
	}

	static #asBoatPlacementContext(
		context: unknown,
	): BoatPlacementContext | null {
		if (!context || typeof context !== "object") return null;
		const value = context as Partial<BoatPlacementContext>;
		if (value.kind !== "boatChunk") return null;
		if (!value.boatChunk) return null;
		if (
			typeof value.localX !== "number" ||
			typeof value.localY !== "number" ||
			typeof value.localZ !== "number" ||
			typeof value.localHitNx !== "number" ||
			typeof value.localHitNy !== "number" ||
			typeof value.localHitNz !== "number"
		) {
			return null;
		}
		return {
			kind: "boatChunk",
			boatChunk: value.boatChunk,
			localX: value.localX,
			localY: value.localY,
			localZ: value.localZ,
			localHitNx: value.localHitNx,
			localHitNy: value.localHitNy,
			localHitNz: value.localHitNz,
		};
	}

	createDiv(): HTMLDivElement {
		this.#div.classList.add("inventory-item");
		this.#div.appendChild(this.#cubeCanvas);
		this.refreshIconStyle();

		this.#stackLabel.innerText = this.#stackSize.toString();
		this.#stackLabel.classList.add("stack-label");

		this.#div.appendChild(this.#stackLabel);

		this.#div.draggable = true;
		this.#div.addEventListener("dragstart", (e) => {
			e.dataTransfer?.setData("text/plain", `inv:${this.itemId}`);
			e.dataTransfer?.setData("inv-id", String(this.itemId));
		});

		return this.#div;
	}

	private static getWallRotationFromYaw(yaw: number): number {
		const quarterTurn = Math.PI / 2;
		const normalized = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
		const quarterIndex =
			Math.floor((normalized + quarterTurn / 2) / quarterTurn) & 3;
		return quarterIndex % 2 === 0 ? 2 : 1;
	}

	public refreshIconStyle(): void {
		if (this.blockId !== null) {
			this.#drawCubeIcon();
			// Shapes load asynchronously; once ready, redraw so shape-aware
			// boxes (slabs, stairs, fences, ...) are used instead of the fallback.
			if (!this.#shapeRedrawn) {
				this.#shapeRedrawn = true;
				void shapeInitPromise.then(() => {
					if (this.blockId !== null) this.#drawCubeIcon();
				});
			}
			return;
		}

		// Non-block items: fall back to a plain icon image.
		this.#div.style.backgroundImage = this.icon ? `url(${this.icon})` : "";
		this.#div.style.backgroundSize = "contain";
		this.#div.style.backgroundRepeat = "no-repeat";
	}

	#cubeAtlasImage: HTMLImageElement | null = null;
	#cubeAtlasLoaded = false;
	#cubeRedrawPending = false;
	#shapeRedrawn = false;

	#getCubeAtlasImage(): HTMLImageElement {
		if (this.#cubeAtlasImage) return this.#cubeAtlasImage;
		const img = new Image();
		img.onload = () => {
			this.#cubeAtlasLoaded = true;
			// Redraw any items that were waiting on the atlas (async).
			if (!this.#cubeRedrawPending) {
				this.#cubeRedrawPending = true;
				queueMicrotask(() => {
					this.#cubeRedrawPending = false;
					if (this.blockId !== null) this.#drawCubeIcon();
				});
			}
		};
		img.src = "/texture/diffuse_atlas.png";
		this.#cubeAtlasImage = img;
		return img;
	}

	/**
	 * Builds a crisp, nearest-neighbor upscaled tile sprite from the atlas so
	 * the cube faces never blur or bleed into neighbouring atlas tiles. A half
	 * texel is inset from each edge to avoid sampling adjacent tiles, and the
	 * whole tile is drawn into a small offscreen canvas with smoothing off.
	 */
	/**
	 * Draws the Minecraft-style isometric cube icon for this block onto the
	 * item's canvas. The actual rendering lives in CubeIcon.ts.
	 */
	#drawCubeIcon(): void {
		const canvas = this.#cubeCanvas;
		const size = 64;
		if (canvas.width !== size) {
			canvas.width = size;
			canvas.height = size;
		}
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		this.#getCubeAtlasImage();
		const img = this.#cubeAtlasImage;
		const ready: boolean = this.#cubeAtlasLoaded && !!img && img.width > 0;

		drawCubeIcon(
			ctx,
			this.blockId,
			img,
			ready,
			getShapeHeightScale(this.blockId),
		);
	}

	public static stackItemAtoB(itemA: Item, itemB: Item): number {
		if (itemA.itemId !== itemB.itemId) return itemA.stackSize;
		//StackSize is limited to maxStackSize
		const stackSize = itemA.stackSize + itemB.stackSize;
		itemB.stackSize = stackSize;
		itemA.stackSize = stackSize - itemB.stackSize;
		if (itemA.stackSize <= 0) {
			itemA.div.parentElement?.removeChild(itemA.div);
			return 0;
		}
		return itemA.stackSize;
	}

	public set stackSize(value: number) {
		this.#stackSize = Math.min(value, this.#maxStack);
		this.#stackLabel.innerText = this.#stackSize.toString();
	}
	public get stackSize(): number {
		return this.#stackSize;
	}

	get div(): HTMLDivElement {
		return this.#div;
	}
}
