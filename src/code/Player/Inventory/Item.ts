import type { ShaderMaterial } from "@babylonjs/lite";
import type { IUsable } from "@/code/Interface/IUsable";
import type { BoatChunk } from "@/code/World/Boat/BoatChunk";
import { setBlock } from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	getShapeForBlockId,
	isRegisteredBlockId,
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
import { drawCubeIcon, iconAtlasesReadyPromise } from "./CubeIcon";
import { getRegisteredItemById } from "./ItemRegistry";
import { ItemUseActions } from "./ItemUseActions";
import type { ItemDefinition } from "./Types/InventoryTypes";

// ─── Module-level constants (V8 inlines as immediates, zero memory per instance) ───
const QUARTER_TURN = Math.PI * 0.5;
const TWO_PI = Math.PI * 2;
const HALF_QUARTER = QUARTER_TURN * 0.5;
const INV_QUARTER = 1 / QUARTER_TURN;
const CANVAS_SIZE = 64;
const ATLAS_PATH = "/texture/diffuse_atlas.png";

// ─── Shared atlas loader (single Image for all Item instances) ───
let _sharedAtlasImg: HTMLImageElement | null = null;
let _sharedAtlasLoaded = false;
const _atlasWaiters: (() => void)[] = [];

function _ensureSharedAtlas(): HTMLImageElement {
	if (_sharedAtlasImg !== null) return _sharedAtlasImg;
	const img = new Image();
	img.onload = () => {
		_sharedAtlasLoaded = true;
		// Flush waiters
		const len = _atlasWaiters.length;
		for (let i = 0; i < len; i++) _atlasWaiters[i]();
		_atlasWaiters.length = 0; // release references
	};
	img.src = ATLAS_PATH;
	_sharedAtlasImg = img;
	return img;
}
_ensureSharedAtlas();
// ─── Rotation policy: flat lookup (avoids Map.get overhead for 2 entries) ───
// Only "cube" and "slab" return true; everything else defaults to true.
// Since the default is true, we only need to track exceptions (none currently).
// This eliminates the Map entirely.
const SLICE_ROTATE_VERTICAL_DEFAULT = true;

// ─── Boat context: reusable scratch (zero allocation per placement) ───
// V8 hidden class is stable: always same 7 properties in same order.
interface BoatCtx {
	boatChunk: BoatChunk;
	localX: number;
	localY: number;
	localZ: number;
	localHitNx: number;
	localHitNy: number;
	localHitNz: number;
}

let _boatCtx: BoatCtx | null = null;

// Multiplayer callback: called when a block is placed locally
let _onBlockPlaced:
	| ((x: number, y: number, z: number, blockId: number) => void)
	| null = null;

export function setOnBlockPlaced(
	callback: (x: number, y: number, z: number, blockId: number) => void,
): void {
	_onBlockPlaced = callback;
}

export class Item implements IUsable {
	// ─── Public fields (ordered for V8 hidden class stability) ───
	name: string;
	description: string;
	icon: string;
	material: ShaderMaterial | undefined;

	itemId = 1;
	blockId: number | null = null;
	blockState = 0;
	row: number;
	col: number;

	// ─── Private fields (underscore convention: V8 optimises better than #private
	//     when mixed with prototype method access) ───
	private _maxStack = 64;
	private _stackSize = 1;
	private _div: HTMLDivElement | null = null;
	private _stackLabel: HTMLSpanElement | null = null;
	private _cubeCanvas: HTMLCanvasElement | null = null;
	private _useAction: ((player: Player) => void) | null = null;
	private _iconReadyDrawn = false;

	constructor(
		name: string,
		description: string,
		icon: string,
		row: number,
		col: number,
		maxStack?: number,
	) {
		this.name = name;
		this.description = description;
		this.icon = icon;
		this.row = row;
		this.col = col;
		if (maxStack !== undefined) {
			this._maxStack = maxStack > 1 ? maxStack | 0 : 1;
			if (this._stackSize > this._maxStack) this._stackSize = this._maxStack;
		}
	}

	// ─── Lazy DOM (deferred to first visual access) ───
	get div(): HTMLDivElement {
		if (this._div === null) this._initDom();
		return this._div!;
	}

	private _initDom(): void {
		const div = document.createElement("div");
		div.classList.add("inventory-item");

		const canvas = document.createElement("canvas");
		canvas.width = CANVAS_SIZE;
		canvas.height = CANVAS_SIZE;
		div.appendChild(canvas);

		const label = document.createElement("span");
		label.classList.add("stack-label");
		label.innerText = String(this._stackSize);
		div.appendChild(label);

		div.draggable = true;
		div.addEventListener("dragstart", this._onDragStart, false);

		this._div = div;
		this._cubeCanvas = canvas;
		this._stackLabel = label;

		this._refreshIcon();
	}

	// ─── Bound handler (single allocation per instance, not per drag) ───
	private _onDragStart = (e: DragEvent): void => {
		const dt = e.dataTransfer;
		if (dt) {
			dt.setData("text/plain", `inv:${this.itemId}`);
			dt.setData("inv-id", String(this.itemId));
		}
	};

	// ─── Factory: single-pass, no redundant style refresh ───
	private static _fromDef(def: ItemDefinition, row: number, col: number): Item {
		const item = new Item(
			def.name,
			def.description ?? def.name,
			def.icon ?? "",
			row,
			col,
			def.maxStack,
		);
		item.itemId = def.id;
		item.blockId = def.blockId ?? def.id;
		item.blockState = def.blockState ?? 0;

		// Resolve use action once at creation (not per-use)
		if (def.useAction === "place_block") {
			item._useAction = Item._placeAction;
		} else if (def.useAction) {
			item._useAction = ItemUseActions[def.useAction] ?? null;
			if (!item._useAction) {
				console.warn(`Unknown item use action: ${def.useAction}`);
			}
		}

		return item;
	}

	static createById(itemId: number, row = -1, col = -1): Item {
		const def = getRegisteredItemById(itemId);
		if (def !== null && def !== undefined) return Item._fromDef(def, row, col);

		// Fallback: linear scan (small array, cache-friendly)
		const len = TextureDefinitions.length;
		for (let i = 0; i < len; i++) {
			if (TextureDefinitions[i].id === itemId) {
				const t = TextureDefinitions[i];
				const item = new Item(t.name, "Crafted Item", "", row, col);
				item.itemId = itemId;
				item.blockId = itemId;
				item.blockState = 0;
				return item;
			}
		}
		throw new Error("Item not found");
	}

	use(player: Player): void {
		const action = this._useAction;
		if (action !== null) {
			action(player);
		} else {
			Item._placeAction(player);
		}
	}

	private static _placeAction(player: Player): void {
		Item.place(player);
	}

	static place(player: Player): void {
		const blockNumber = pickBlock(player);
		if (blockNumber === BlockType.CraftingTable) return;

		const hit = getPlacementHit(player);
		if (!hit) return;

		const hotbar = player.playerInventory.inventory[0];
		const slot = player.playerHud.selectedHotbarSlot;
		const item = hotbar?.[slot]?.item;
		if (item === null || item === undefined) return;

		const blockId = item.blockId ?? item.itemId;
		let blockState = blockId === BlockType.Water ? 0 : (item.blockState ?? 0);

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

			rotation = existingRotation & 3;

			if (originalSliceAxis !== 1 && SLICE_ROTATE_VERTICAL_DEFAULT) {
				rotation = Item._wallRotFromYaw(yaw);
			}

			const sliceAxis = getSliceAxis(rotation);

			flipY = (existingRotation & 4) !== 0;

			if (sliceAxis === 1) {
				if (hit.ny === -1) {
					flipY = true;
				} else if (hit.ny === 1) {
					flipY = false;
				} else {
					flipY = hit.hitFracY > 0.5;
				}
			} else if (sliceAxis === 0) {
				flipY = hit.nx !== 0 ? hit.nx < 0 : hit.hitFracX > 0.5;
			} else {
				flipY = hit.nz !== 0 ? hit.nz < 0 : hit.hitFracZ > 0.5;
			}

			blockState = sliceBits | (flipY ? 4 : 0) | rotation;
			slice = (blockState >> 3) & 7;
		} else if (shape.rotateY) {
			rotation = Item._blockRotationFromYaw(yaw);
			flipY = (shape.allowFlipY && hit.ny === -1) || hit.hitFracY > 0.5;
			blockState = (blockState & ~7) | (flipY ? 4 : 0) | rotation;
		}

		const pos = hit.pos;
		const x = pos.x;
		const y = pos.y;
		const z = pos.z;

		if (
			player.playerVehicle.wouldBlockOverlapPlayer(
				x,
				y,
				z,
				shape,
				rotation,
				slice,
				flipY,
			)
		) {
			return;
		}

		const mobRegistry = Map1.mobRegistry;
		if (mobRegistry !== null && mobRegistry !== undefined) {
			const x1 = x + 1;
			const y1 = y + 1;
			const z1 = z + 1;

			for (const mob of mobRegistry.getAllMobs()) {
				const mp = mob.position;

				if (
					mp.x >= x &&
					mp.x < x1 &&
					mp.y >= y &&
					mp.y < y1 &&
					mp.z >= z &&
					mp.z < z1
				) {
					return;
				}
			}
		}

		const boatCtx = Item._extractBoatCtx(hit.dynamicContext);
		if (boatCtx !== null) {
			const plX = boatCtx.localX + boatCtx.localHitNx;
			const plY = boatCtx.localY + boatCtx.localHitNy;
			const plZ = boatCtx.localZ + boatCtx.localHitNz;

			if (boatCtx.boatChunk.isInsideLocalBounds(plX, plY, plZ)) {
				boatCtx.boatChunk.setBlockLocal(plX, plY, plZ, blockId, blockState);
				return;
			}
		}

		setBlock(x, y, z, blockId, blockState);
		_onBlockPlaced?.(x, y, z, blockId);
	}

	// ─── Zero-allocation boat context extraction ───
	private static _extractBoatCtx(context: unknown): BoatCtx | null {
		if (context === null || typeof context !== "object") return null;

		const c = context as Record<string, unknown>;
		if (
			c.kind !== "boatChunk" ||
			c.boatChunk === null ||
			c.boatChunk === undefined
		) {
			return null;
		}

		const lx = c.localX;
		const ly = c.localY;
		const lz = c.localZ;
		const hnx = c.localHitNx;
		const hny = c.localHitNy;
		const hnz = c.localHitNz;

		if (
			typeof lx !== "number" ||
			typeof ly !== "number" ||
			typeof lz !== "number" ||
			typeof hnx !== "number" ||
			typeof hny !== "number" ||
			typeof hnz !== "number"
		) {
			return null;
		}

		const boatChunk = c.boatChunk as BoatChunk;

		if (_boatCtx === null) {
			_boatCtx = {
				boatChunk,
				localX: lx,
				localY: ly,
				localZ: lz,
				localHitNx: hnx,
				localHitNy: hny,
				localHitNz: hnz,
			};
		} else {
			_boatCtx.boatChunk = boatChunk;
			_boatCtx.localX = lx;
			_boatCtx.localY = ly;
			_boatCtx.localZ = lz;
			_boatCtx.localHitNx = hnx;
			_boatCtx.localHitNy = hny;
			_boatCtx.localHitNz = hnz;
		}

		return _boatCtx;
	}
	private static _blockRotationFromYaw(yaw: number): number {
		let rotation = Item._yawQuarter(yaw);
		rotation = (rotation ^ 2) & 3;
		return (4 - rotation) & 3;
	}
	private static _wallRotFromYaw(yaw: number): number {
		const qi = Item._yawQuarter(yaw);

		// Keep wall-slice rotations on the two horizontal wall axes.
		// The previous implementation returned 0 or 1 while the comment said 1 or 2.
		return (qi & 1) !== 0 ? 1 : 2;
	}
	private static _yawQuarter(yaw: number): number {
		let normalized = yaw % TWO_PI;
		if (normalized < 0) normalized += TWO_PI;
		return (((normalized + HALF_QUARTER) * INV_QUARTER) | 0) & 3;
	}

	// ─── Icon rendering ───
	private _refreshIcon(): void {
		const isBlock = isRegisteredBlockId(this.blockId);
		if (isBlock) {
			if (this._cubeCanvas !== null) this._cubeCanvas.style.display = "";
			if (!this._iconReadyDrawn) {
				// First draw: wait for the shading atlases and the shape
				// definitions so the icon is rendered correctly in one pass
				// instead of being redrawn with missing lighting.
				this._iconReadyDrawn = true;
				Promise.all([iconAtlasesReadyPromise, shapeInitPromise]).then(() => {
					if (isRegisteredBlockId(this.blockId)) this._drawCube();
				});
				return;
			}
			this._drawCube();
			return;
		}
		// Non-block: hide canvas, use background image
		if (this._cubeCanvas !== null) this._cubeCanvas.style.display = "none";
		const div = this._div;
		if (div !== null) {
			div.style.backgroundImage = this.icon ? `url(${this.icon})` : "";
			div.style.backgroundSize = "contain";
			div.style.backgroundPosition = "center";
			div.style.backgroundRepeat = "no-repeat";
		}
	}

	public refreshIconStyle(): void {
		this._refreshIcon();
	}

	private _drawCube(): void {
		const canvas = this._cubeCanvas;
		if (canvas === null) return;
		const ctx = canvas.getContext("2d");
		if (ctx === null) return;

		const img = _sharedAtlasImg!; // always non-null after module init
		const ready = _sharedAtlasLoaded && img.width > 0;

		drawCubeIcon(ctx, this.blockId, img, ready);
	}

	// ─── Stack operations (hot path: inventory drag/drop) ───
	public static stackItemAtoB(itemA: Item, itemB: Item): number {
		if (itemA.itemId !== itemB.itemId) return itemA._stackSize;
		const combined = itemA._stackSize + itemB._stackSize;
		const bMax = itemB._maxStack;
		const bNew = combined > bMax ? bMax : combined;
		itemB._stackSize = bNew;
		itemB._updateLabel();
		const aRemain = combined - bNew;
		itemA._stackSize = aRemain;
		itemA._updateLabel();
		if (aRemain <= 0) {
			const div = itemA._div;
			if (div !== null) {
				const parent = div.parentElement;
				if (parent !== null) parent.removeChild(div);
			}
			return 0;
		}
		return aRemain;
	}

	private _updateLabel(): void {
		const label = this._stackLabel;
		if (label !== null) {
			label.innerText = String(this._stackSize);
		}
	}

	public set stackSize(value: number) {
		this._stackSize = value > this._maxStack ? this._maxStack : value;
		this._updateLabel();
	}

	public get stackSize(): number {
		return this._stackSize;
	}
}
// ─── EAGER LOAD: begin fetching immediately on import ───
_ensureSharedAtlas();
