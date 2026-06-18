import { type TransformNode, Vector3 } from "@babylonjs/core";
import { play } from "@/code/Maps/BlockBreakParticles";
import {
	deleteBlock,
	getLightByWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	getBlockBreakTime,
	getBlockInfo,
} from "@/code/World/Texture/TextureDefinitions";
import { DroppedItem } from "../../Inventory/DroppedItem";
import { Item } from "../../Inventory/Item";
import type { Player } from "../../Player";
import { Gamemodes } from "../../PlayerStats";
import { updateCrackingState } from "./BlockBreakingVisuals";
import type { BlockRaycastHit } from "./BlockRaycaster";
import { pickTarget } from "./BlockRaycaster";

const _scratchLightPos = new Vector3();
const _scratchParticlePos = new Vector3();

export type BoatBlockHitContext = {
	kind: "boatChunk";
	boatChunk: {
		visualRoot: TransformNode;
		center: Vector3;
		setBlockLocal(
			x: number,
			y: number,
			z: number,
			blockId: number,
			blockState?: number,
		): void;
	};
	localX: number;
	localY: number;
	localZ: number;
};

export class BlockBreakingHandler {
	#player: Player;

	#active = false;
	#cachedX = 0;
	#cachedY = 0;
	#cachedZ = 0;
	#hasCachedBlock = false;
	#breakTimer = 0;

	constructor(player: Player) {
		this.#player = player;
	}

	public start(): void {
		this.#active = true;
	}

	public stop(): void {
		this.#active = false;
		this.reset();
	}

	public reset(): void {
		this.#hasCachedBlock = false;
		this.#breakTimer = 0;
		updateCrackingState(null, 0);
	}

	public update(hit?: BlockRaycastHit | null): void {
		if (!this.#active) return;

		const dt =
			this.#player.playerVehicle.scene.getEngine().getDeltaTime() / 1000;

		hit ??= pickTarget(this.#player);
		if (!hit) {
			this.reset();
			return;
		}

		const x = hit.x;
		const y = hit.y;
		const z = hit.z;

		const blockId = hit.blockId;
		const blockState = hit.blockState;

		const item =
			this.#player.playerInventory.inventory[0][
				this.#player.playerHud.selectedHotbarSlot
			]?.item;

		const breakTime =
			this.#player.stats.gamemode === Gamemodes.Creative
				? 0.1
				: getBlockBreakTime(blockId, item?.itemId) || 0.001;

		const isSameBlock =
			this.#hasCachedBlock &&
			x === this.#cachedX &&
			y === this.#cachedY &&
			z === this.#cachedZ;

		if (isSameBlock) {
			this.#breakTimer += dt;

			const frac = Math.min(this.#breakTimer / breakTime, 1);
			updateCrackingState(
				{ x: this.#cachedX, y: this.#cachedY, z: this.#cachedZ },
				frac,
				blockId,
				blockState,
				hit.dynamicContext,
			);

			if (this.#breakTimer >= breakTime) {
				const lightPos = _scratchLightPos;
				lightPos.set(x + 0.5 + hit.nx, y + 0.5 + hit.ny, z + 0.5 + hit.nz);

				const packedLight = getLightByWorldCoords(
					lightPos.x,
					lightPos.y,
					lightPos.z,
				);

				this.#breakBlock(x, y, z, blockId, packedLight, hit.dynamicContext);
			}
		} else {
			this.#cachedX = x;
			this.#cachedY = y;
			this.#cachedZ = z;
			this.#hasCachedBlock = true;
			this.#breakTimer = 0;

			updateCrackingState(
				{ x, y, z },
				0,
				blockId,
				blockState,
				hit.dynamicContext,
			);
		}
	}

	#asBoatBlockContext(context: unknown): BoatBlockHitContext | null {
		if (!context || typeof context !== "object") return null;

		const value = context as Partial<BoatBlockHitContext>;
		if (value.kind !== "boatChunk") return null;

		if (
			typeof value.localX !== "number" ||
			typeof value.localY !== "number" ||
			typeof value.localZ !== "number" ||
			!value.boatChunk
		) {
			return null;
		}

		return {
			kind: "boatChunk",
			boatChunk: value.boatChunk,
			localX: value.localX,
			localY: value.localY,
			localZ: value.localZ,
		};
	}

	#breakBlock(
		x: number,
		y: number,
		z: number,
		blockId: number,
		packedLight: number,
		dynamicContext: unknown,
	): void {
		const info = getBlockInfo(blockId);
		if (!info) return;

		const worldItem = Item.createById(blockId);
		worldItem.stackSize = 1;
		worldItem.itemId = blockId;

		const di = new DroppedItem(worldItem, x + 0.5, y + 0.5, z + 0.5);

		const particlePos = _scratchParticlePos;
		particlePos.set(x + 0.5, y + 0.5, z + 0.5);
		play(this.#player.playerVehicle.scene, particlePos, blockId, packedLight);

		this.reset();

		const boatContext = this.#asBoatBlockContext(dynamicContext);
		if (boatContext) {
			boatContext.boatChunk.setBlockLocal(
				boatContext.localX,
				boatContext.localY,
				boatContext.localZ,
				0,
				0,
			);
		} else {
			deleteBlock(x, y, z);
		}

		if (this.#player.stats.gamemode === Gamemodes.Creative) {
			di.use(this.#player);
		}
	}
}
