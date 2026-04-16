import { Color3, type StandardMaterial } from "@babylonjs/core";
import type { IUsable } from "@/code/Inferface/IUsable";
import { Map1 } from "@/code/Maps/Map1";
import { BlockType } from "@/code/World/BlockType";
import { BoatCreatorSystem } from "@/code/World/Boat/BoatCreatorSystem";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";
import { getShapeForBlockId } from "@/code/World/Shape/BlockShapes";
import { getSliceAxis } from "@/code/World/Shape/BlockShapeTransforms";
import { BlockTextures } from "@/code/World/Texture/BlockTextures";
import { TextureAtlasFactory } from "@/code/World/Texture/TextureAtlasFactory";
import { TextureDefinitions } from "@/code/World/Texture/TextureDefinitions";
import { MaterialFactory } from "../../World/Texture/MaterialFactory";
import { CrossHair } from "../Hud/CrossHair";
import type { Player } from "../Player";
import { type ItemDefinition, ItemRegistry } from "./ItemRegistry";
import { ItemUseActions } from "./ItemUseActions";

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
	materialFolder: string | undefined;
	material: StandardMaterial | undefined;

	itemId = 1;
	blockId: number | null = null;
	blockState = 0;

	#maxStack = 64;
	#stackSize = Math.round(Math.random() * this.#maxStack);
	#div: HTMLDivElement = document.createElement("div");
	#stackLabel: HTMLSpanElement = document.createElement("span");
	row: number;
	col: number;

	constructor(
		name: string,
		description: string,
		icon: string,
		row: number,
		col: number,
		materialFolder?: string,
		maxStack?: number,
	) {
		if (typeof maxStack === "number") {
			this.#maxStack = Math.max(1, Math.floor(maxStack));
			this.#stackSize = Math.min(this.#stackSize, this.#maxStack);
		}
		this.name = name;
		this.description = description;
		this.icon = icon;
		if (materialFolder) {
			this.materialFolder = materialFolder;
			this.material = MaterialFactory.createMaterialByFolder(
				Map1.mainScene,
				materialFolder,
				1,
				".png",
				true,
				true,
				true,
				false,
			);
			this.material.specularColor = new Color3(0.24, 0.3, 0.3);
		}
		this.row = row;
		this.col = col;
		this.#div = this.createDiv();
	}

	private static createFromDefinition(
		def: ItemDefinition,
		row: number,
		col: number,
	): Item {
		const icon =
			def.icon ||
			(def.materialFolder
				? (MaterialFactory.getTexturePathFromFolder(def.materialFolder) ?? "")
				: "");

		const item = new Item(
			def.name,
			def.description ?? def.name,
			icon,
			row,
			col,
			def.materialFolder,
			def.maxStack,
		);
		item.itemId = def.id;
		item.blockId = def.blockId ?? def.id;
		item.blockState = def.blockState ?? 0;
		item.refreshIconStyle();

		if (def.useAction === "place_block") {
			item.use = (player: Player) => Item.place(player);
		} else if (def.useAction) {
			const action = ItemUseActions[def.useAction];
			if (action) {
				item.use = action;
			} else {
				console.warn(`Unknown item use action: ${def.useAction}`);
			}
		}

		return item;
	}

	static createById(itemId: number, row = -1, col = -1): Item {
		const def = ItemRegistry.get(itemId);
		if (def) {
			return Item.createFromDefinition(def, row, col);
		}

		const textureDef = TextureDefinitions.find((t) => t.id === itemId);
		if (!textureDef) throw new Error("Item not found");
		const materialFolderPath = MaterialFactory.getTexturePathFromFolder(
			textureDef.path,
		);
		if (!materialFolderPath) throw new Error("Material not found");

		const item = new Item(
			textureDef.name,
			"Crafted Item",
			materialFolderPath,
			row,
			col,
			textureDef.path,
		);
		item.itemId = itemId;
		item.blockId = itemId;
		item.blockState = 0;
		item.refreshIconStyle();

		return item;
	}

	use(player: Player): void {
		Item.place(player);
	}

	static place(player: Player) {
		const blockNumber = CrossHair.pickBlock(player);
		if (blockNumber === BlockType.CraftingTable) return;

		const hit = CrossHair.getPlacementHit(player);
		if (!hit) return;

		const { pos, nx, ny, nz, hitFracX, hitFracY, hitFracZ } = hit;

		const item =
			player.playerInventory.inventory[0][player.playerHud.selectedHotbarSlot]
				?.item;

		if (item) {
			const blockId = item.blockId ?? item.itemId;
			let blockState = item.blockState ?? 0;
			const shape = getShapeForBlockId(blockId);
			const yaw = player.playerCamera.cameraYaw;
			const hasSlice = (blockState >> 3) & 7;

			if (hasSlice > 0) {
				const sliceBits = blockState & ~7;
				const existingRotation = blockState & 7;
				const originalSliceAxis = getSliceAxis(existingRotation);
				const policy = Item.SLICE_SHAPE_ROTATION_POLICY[shape.name] ?? {
					rotateVerticalByYaw: true,
				};

				let rotation = existingRotation & 3;
				if (originalSliceAxis !== 1 && policy.rotateVerticalByYaw) {
					rotation = Item.getWallRotationFromYaw(yaw);
				}
				const sliceAxis = getSliceAxis(rotation);

				let flip = (existingRotation & 4) !== 0;
				if (sliceAxis === 1) {
					// Horizontal slabs: only top/bottom.
					if (ny === -1) flip = true;
					else if (ny === 1) flip = false;
					else flip = hitFracY > 0.5;
				} else if (sliceAxis === 0) {
					// Vertical slabs on X: only +/-X side.
					flip = nx !== 0 ? nx < 0 : hitFracX > 0.5;
				} else {
					// Vertical slabs on Z: only +/-Z side.
					flip = nz !== 0 ? nz < 0 : hitFracZ > 0.5;
				}

				const flipBit = flip ? 4 : 0;
				blockState = sliceBits | flipBit | rotation;
			} else if (shape.rotateY) {
				const quarterTurn = Math.PI / 2;
				const normalized =
					((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
				let rotation =
					(Math.floor((normalized + quarterTurn / 2) / quarterTurn) & 3) ^ 2;
				rotation = (4 - rotation) & 3;
				const flipY = (shape.allowFlipY && ny === -1) || hitFracY > 0.5;
				const flipBit = flipY ? 4 : 0;
				const sliceBits = blockState & ~7;
				blockState = sliceBits | flipBit | rotation;
			}

			ChunkLoadingSystem.setBlock(pos.x, pos.y, pos.z, blockId, blockState);
			if (blockId === BlockType.BoatCreator) {
				BoatCreatorSystem.tryCreateBoatFromMarker(player, pos.x, pos.y, pos.z);
			}
		}
	}

	createDiv(): HTMLDivElement {
		this.#div.classList.add("inventory-item");
		this.refreshIconStyle();

		this.#stackLabel.innerText = this.#stackSize.toString();
		this.#stackLabel.classList.add("stack-label");

		this.#div.appendChild(this.#stackLabel);

		this.#div.draggable = true;

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
		const atlasTile = this.getAtlasTile();
		if (atlasTile) {
			const [tx, ty] = atlasTile;
			const atlasSize = TextureAtlasFactory.atlasSize;
			const maxIndex = Math.max(1, atlasSize - 1);
			this.#div.style.backgroundImage = "url(/texture/diffuse_atlas.png)";
			this.#div.style.backgroundSize = `${atlasSize * 100}% ${atlasSize * 100}%`;
			this.#div.style.backgroundPosition = `${(tx / maxIndex) * 100}% ${(ty / maxIndex) * 100}%`;
			this.#div.style.backgroundRepeat = "no-repeat";
			return;
		}

		this.#div.style.backgroundImage = this.icon ? `url(${this.icon})` : "";
		this.#div.style.backgroundSize = "contain";
		this.#div.style.backgroundPosition = "center";
		this.#div.style.backgroundRepeat = "no-repeat";
	}

	private getAtlasTile(): [number, number] | null {
		if (this.blockId === null) return null;

		const blockTexture = BlockTextures[this.blockId];
		if (!blockTexture) return null;

		const uv =
			blockTexture.all ??
			blockTexture.side ??
			blockTexture.top ??
			blockTexture.bottom;

		if (!uv || uv.length < 2) return null;
		return [uv[0], uv[1]];
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
