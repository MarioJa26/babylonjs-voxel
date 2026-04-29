import { type TransformNode, Vector3 } from "@babylonjs/core";
import { BlockBreakParticles } from "@/code/Maps/BlockBreakParticles";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	getBlockBreakTime,
	getBlockInfo,
} from "@/code/World/Texture/TextureDefinitions";
import { DroppedItem } from "../../Inventory/DroppedItem";
import { Item } from "../../Inventory/Item";
import type { Player } from "../../Player";
import { Gamemodes } from "../../PlayerStats";
import { updateCrackingState } from "./BlockBreakingVisuals";
import { pickTarget } from "./BlockRaycaster";

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
	#breakingBlock: { x: number; y: number; z: number } | null = null;
	#breakingTargetKey = "";
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
		this.#breakingBlock = null;
		this.#breakingTargetKey = "";
		this.#breakTimer = 0;
		updateCrackingState(null, 0);
	}

	public update(): void {
		if (!this.#active) return;

		const dt =
			this.#player.playerVehicle.scene.getEngine().getDeltaTime() / 1000;

		const hit = pickTarget(this.#player);
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

		const targetKey = this.#getBreakingTargetKey(hit);
		const isSameBlock = this.#breakingTargetKey === targetKey;

		if (isSameBlock) {
			this.#breakTimer += dt;
			this.#breakingBlock = { x, y, z };

			const frac = Math.min(this.#breakTimer / breakTime, 1);
			updateCrackingState(
				this.#breakingBlock,
				frac,
				blockId,
				blockState,
				hit.dynamicContext,
			);

			if (this.#breakTimer >= breakTime) {
				const lightPos = new Vector3(
					x + 0.5 + hit.nx,
					y + 0.5 + hit.ny,
					z + 0.5 + hit.nz,
				);

				const packedLight = ChunkLoadingSystem.getLightByWorldCoords(
					lightPos.x,
					lightPos.y,
					lightPos.z,
				);

				this.#breakBlock(x, y, z, blockId, packedLight, hit.dynamicContext);
			}
		} else {
			this.#breakingBlock = { x, y, z };
			this.#breakingTargetKey = targetKey;
			this.#breakTimer = 0;

			updateCrackingState(
				this.#breakingBlock,
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
			typeof value.localZ !== "number"
		) {
			return null;
		}

		return {
			kind: "boatChunk",
			boatChunk: value.boatChunk!,
			localX: value.localX,
			localY: value.localY,
			localZ: value.localZ,
		};
	}

	#getBreakingTargetKey(hit: {
		x: number;
		y: number;
		z: number;
		dynamicContext?: unknown;
	}): string {
		const boatContext = this.#asBoatBlockContext(hit.dynamicContext);
		if (boatContext) {
			return `boat:${boatContext.localX}:${boatContext.localY}:${boatContext.localZ}`;
		}
		return `world:${hit.x}:${hit.y}:${hit.z}`;
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

		BlockBreakParticles.play(
			this.#player.playerVehicle.scene,
			new Vector3(x + 0.5, y + 0.5, z + 0.5),
			blockId,
			packedLight,
		);

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
			ChunkLoadingSystem.deleteBlock(x, y, z);
		}

		if (this.#player.stats.gamemode === Gamemodes.Creative) {
			di.use(this.#player);
		}
	}
}
