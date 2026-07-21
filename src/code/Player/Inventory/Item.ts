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
import { drawCubeIcon, getShapeHeightScale } from "./CubeIcon";
import { getRegisteredItemById, type ItemDefinition } from "./ItemRegistry";
import { ItemUseActions } from "./ItemUseActions";

// ─── Constants hoisted to module scope (V8 inlines as immediates) ───
const QUARTER_TURN = Math.PI * 0.5;
const TWO_PI = Math.PI * 2;
const CANVAS_SIZE = 64;
const ATLAS_PATH = "/texture/diffuse_atlas.png";

// ─── Rotation policy: use a frozen flat lookup instead of Record<string, obj> ───
// Keyed by shape name → boolean. Avoids object allocation per lookup.
const SLICE_ROTATE_VERTICAL: ReadonlyMap<string, boolean> = new Map([
	["cube", true],
	["slab", true],
]);

// ─── Boat context: avoid allocating a new object every placement check ───
// Reusable scratch — only valid within a single `place()` call.
let _boatCtx: {
	boatChunk: BoatChunk;
	localX: number;
	localY: number;
	localZ: number;
	localHitNx: number;
	localHitNy: number;
	localHitNz: number;
} | null = null;

export class Item implements IUsable {
	name: string;
	description: string;
	icon: string;
	material: ShaderMaterial | undefined;

	itemId = 1;
	blockId: number | null = null;
	blockState = 0;
	row: number;
	col: number;

	// ─── Private fields: use underscore convention for V8 hidden class stability ───
	// (V8 optimizes classes with consistent property order; # private fields can
	//  cause deopt in some engines when mixed with prototype access patterns)
	private _maxStack = 64;
	private _stackSize = 1;
	private _div: HTMLDivElement | null = null;
	private _stackLabel: HTMLSpanElement | null = null;
	private _cubeCanvas: HTMLCanvasElement | null = null;
	private _useAction: ((player: Player) => void) | null = null;

	// Atlas state (lazy)
	private _atlasImg: HTMLImageElement | null = null;
	private _atlasLoaded = false;
	private _redrawPending = false;
	private _shapeRedrawn = false;

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
		// DOM creation deferred to first access (lazy) — avoids work for items
		// that are constructed but never rendered (e.g. server-side logic).
	}

	// ─── Lazy DOM accessors (avoid createElement in constructor) ───
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

	// ─── Bound handler (single allocation, not per-item closure) ───
	private _onDragStart = (e: DragEvent): void => {
		const dt = e.dataTransfer;
		if (dt) {
			dt.setData("text/plain", `inv:${this.itemId}`);
			dt.setData("inv-id", String(this.itemId));
		}
	};

	// ─── Factory: single-pass construction, no double refreshIconStyle ───
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
		if (def) return Item._fromDef(def, row, col);

		// Fallback: linear scan (unavoidable, but cache-friendly for small arrays)
		const texDef = TextureDefinitions.find((t) => t.id === itemId);
		if (!texDef) throw new Error("Item not found");

		const item = new Item(texDef.name, "Crafted Item", "", row, col);
		item.itemId = itemId;
		item.blockId = itemId;
		item.blockState = 0;
		return item;
	}

	use(player: Player): void {
		const action = this._useAction;
		if (action) {
			action(player);
		} else {
			Item._placeAction(player);
		}
	}

	// ─── Static bound reference (avoids closure allocation) ───
	private static _placeAction(player: Player): void {
		Item.place(player);
	}

	static place(player: Player): void {
		const blockNumber = pickBlock(player);
		if (blockNumber === BlockType.CraftingTable) return;

		const hit = getPlacementHit(player);
		if (!hit) return;

		const item =
			player.playerInventory.inventory[0][player.playerHud.selectedHotbarSlot]
				?.item;
		if (!item) return;

		const blockId = item.blockId ?? item.itemId;
		let blockState = item.blockState ?? 0;

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
			const rotateVertical = SLICE_ROTATE_VERTICAL.get(shape.name) ?? true;

			rotation = existingRotation & 3;
			if (originalSliceAxis !== 1 && rotateVertical) {
				rotation = Item._wallRotFromYaw(yaw);
			}
			const sliceAxis = getSliceAxis(rotation);

			flipY = (existingRotation & 4) !== 0;
			if (sliceAxis === 1) {
				if (hit.ny === -1) flipY = true;
				else if (hit.ny === 1) flipY = false;
				else flipY = hit.hitFracY > 0.5;
			} else if (sliceAxis === 0) {
				flipY = hit.nx !== 0 ? hit.nx < 0 : hit.hitFracX > 0.5;
			} else {
				flipY = hit.nz !== 0 ? hit.nz < 0 : hit.hitFracZ > 0.5;
			}

			blockState = sliceBits | (flipY ? 4 : 0) | rotation;
			slice = (blockState >> 3) & 7;
		} else if (shape.rotateY) {
			const normalized = ((yaw % TWO_PI) + TWO_PI) % TWO_PI;
			rotation = (((normalized + QUARTER_TURN * 0.5) / QUARTER_TURN) | 0) & 3;
			rotation = (rotation ^ 2) & 3;
			rotation = (4 - rotation) & 3;
			flipY = (shape.allowFlipY && hit.ny === -1) || hit.hitFracY > 0.5;
			blockState = (blockState & ~7) | (flipY ? 4 : 0) | rotation;
		}

		const pos = hit.pos;

		// Player overlap
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

		// Mob overlap (Set iteration)
		const mobRegistry = Map1.mobRegistry;
		if (mobRegistry) {
			const px = pos.x,
				py = pos.y,
				pz = pos.z;
			const px1 = px + 1,
				py1 = py + 1,
				pz1 = pz + 1;
			for (const mob of mobRegistry.getAllMobs()) {
				const mp = mob.position;
				if (
					mp.x >= px &&
					mp.x < px1 &&
					mp.y >= py &&
					mp.y < py1 &&
					mp.z >= pz &&
					mp.z < pz1
				) {
					return;
				}
			}
		}

		// Boat placement
		const boatCtx = Item._extractBoatCtx(hit.dynamicContext);
		if (boatCtx) {
			const plX = boatCtx.localX + boatCtx.localHitNx;
			const plY = boatCtx.localY + boatCtx.localHitNy;
			const plZ = boatCtx.localZ + boatCtx.localHitNz;
			if (boatCtx.boatChunk.isInsideLocalBounds(plX, plY, plZ)) {
				boatCtx.boatChunk.setBlockLocal(plX, plY, plZ, blockId, blockState);
				return;
			}
		}

		setBlock(pos.x, pos.y, pos.z, blockId, blockState);
	}

	// ─── Zero-allocation boat context extraction (reuses module-level scratch) ───
	private static _extractBoatCtx(context: unknown): typeof _boatCtx {
		if (!context || typeof context !== "object") return null;
		const c = context as Record<string, unknown>;
		if (c.kind !== "boatChunk" || !c.boatChunk) return null;
		if (
			typeof c.localX !== "number" ||
			typeof c.localY !== "number" ||
			typeof c.localZ !== "number" ||
			typeof c.localHitNx !== "number" ||
			typeof c.localHitNy !== "number" ||
			typeof c.localHitNz !== "number"
		) {
			return null;
		}
		// Reuse scratch object — no allocation
		if (!_boatCtx) {
			_boatCtx = {
				boatChunk: c.boatChunk as BoatChunk,
				localX: 0,
				localY: 0,
				localZ: 0,
				localHitNx: 0,
				localHitNy: 0,
				localHitNz: 0,
			};
		}
		_boatCtx.boatChunk = c.boatChunk as BoatChunk;
		_boatCtx.localX = c.localX as number;
		_boatCtx.localY = c.localY as number;
		_boatCtx.localZ = c.localZ as number;
		_boatCtx.localHitNx = c.localHitNx as number;
		_boatCtx.localHitNy = c.localHitNy as number;
		_boatCtx.localHitNz = c.localHitNz as number;
		return _boatCtx;
	}

	private static _wallRotFromYaw(yaw: number): number {
		const normalized = ((yaw % TWO_PI) + TWO_PI) % TWO_PI;
		const qi = (((normalized + QUARTER_TURN * 0.5) / QUARTER_TURN) | 0) & 3;
		return qi & 1 ? 1 : 2; // odd → 1, even → 2
	}

	// ─── Icon rendering ───
	private _refreshIcon(): void {
		const isBlock = isRegisteredBlockId(this.blockId);
		if (isBlock) {
			if (this._cubeCanvas) this._cubeCanvas.style.display = "";
			this._drawCube();
			if (!this._shapeRedrawn) {
				this._shapeRedrawn = true;
				shapeInitPromise.then(() => {
					if (isRegisteredBlockId(this.blockId)) this._drawCube();
				});
			}
			return;
		}
		// Non-block item: hide the cube canvas and use the icon image instead.
		if (this._cubeCanvas) this._cubeCanvas.style.display = "none";
		const div = this._div;
		if (div) {
			div.style.backgroundImage = this.icon ? `url(${this.icon})` : "";
			div.style.backgroundSize = "contain";
			div.style.backgroundPosition = "center";
			div.style.backgroundRepeat = "no-repeat";
		}
	}

	public refreshIconStyle(): void {
		this._refreshIcon();
	}

	private _getAtlas(): HTMLImageElement {
		let img = this._atlasImg;
		if (img) return img;
		img = new Image();
		img.onload = () => {
			this._atlasLoaded = true;
			if (!this._redrawPending) {
				this._redrawPending = true;
				queueMicrotask(() => {
					this._redrawPending = false;
					if (this.blockId !== null) this._drawCube();
				});
			}
		};
		img.src = ATLAS_PATH;
		this._atlasImg = img;
		return img;
	}

	private _drawCube(): void {
		const canvas = this._cubeCanvas;
		if (!canvas) return;
		// Canvas size set once in _initDom; skip redundant check
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const img = this._getAtlas();
		const ready = this._atlasLoaded && img.width > 0;

		drawCubeIcon(
			ctx,
			this.blockId,
			img,
			ready,
			getShapeHeightScale(this.blockId),
		);
	}

	// ─── Stack operations (hot path in inventory UI) ───
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
			const parent = itemA._div?.parentElement;
			if (parent && itemA._div) parent.removeChild(itemA._div);
			return 0;
		}
		return aRemain;
	}

	private _updateLabel(): void {
		if (this._stackLabel) {
			this._stackLabel.innerText = String(this._stackSize);
		}
	}

	public set stackSize(value: number) {
		const v = value > this._maxStack ? this._maxStack : value;
		this._stackSize = v;
		this._updateLabel();
	}

	public get stackSize(): number {
		return this._stackSize;
	}
}
