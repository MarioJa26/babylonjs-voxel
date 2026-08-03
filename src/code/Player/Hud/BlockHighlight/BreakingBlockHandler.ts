import type { Mesh, Vec3 } from "@babylonjs/lite";
import { setVec3, vec3Zero } from "@/code/Lib/Math";
import { play, playMining } from "@/code/Maps/BlockBreakParticles";
import {
	createEmptyInventory,
	getBlockInventory,
	saveBlockInventory,
} from "@/code/World/BlockInventory/BlockInventoryManager";
import {
	deleteBlock,
	getLightByWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import { BlockType } from "@/code/World/Texture/BlockType";
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

const _scratchLightPos = vec3Zero();
const _scratchParticlePos = vec3Zero();
const _scratchMiningPos = vec3Zero();
let variation = 1834927911;

export type BoatBlockHitContext = {
	kind: "boatChunk";
	boatChunk: {
		visualRoot: Mesh;
		center: Vec3;
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
	#lastUpdateMs = 0;

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
		this.#lastUpdateMs = 0;
		updateCrackingState(null, 0);
	}

	public update(hit?: BlockRaycastHit | null): void {
		if (!this.#active) return;

		const now = performance.now();
		const dt =
			this.#lastUpdateMs > 0
				? Math.min(0.1, (now - this.#lastUpdateMs) / 1000)
				: 0;
		this.#lastUpdateMs = now;

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

		const selectedHotbarSlot = this.#player.playerHud.selectedHotbarSlot;
		const item =
			this.#player.playerInventory.inventory[0][selectedHotbarSlot]?.item;

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

			this.#emitMiningParticles(hit, x, y, z, blockId);

			if (this.#breakTimer >= breakTime) {
				const lightPos = _scratchLightPos;
				setVec3(lightPos, x + 0.5 + hit.nx, y + 0.5 + hit.ny, z + 0.5 + hit.nz);

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

			this.#emitMiningParticles(hit, x, y, z, blockId);
		}
	}

	#emitMiningParticles(
		hit: BlockRaycastHit,
		x: number,
		y: number,
		z: number,
		blockId: number,
	): void {
		const miningPos = _scratchMiningPos;
		setVec3(
			miningPos,
			x + 0.5 + hit.nx * 0.5,
			y + 0.5 + hit.ny * 0.5,
			z + 0.5 + hit.nz * 0.5,
		);
		playMining(
			this.#player.sceneRef,
			miningPos.x,
			miningPos.y,
			miningPos.z,
			hit.nx,
			hit.ny,
			hit.nz,
			blockId,
		);
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

		//todo make it good
		const dropId =
			blockId === BlockType.Grass001 || blockId === 14 || blockId === 51
				? 46
				: blockId === BlockType.Torch
					? 1017
					: blockId;
		const worldItem = Item.createById(dropId);
		worldItem.stackSize = 1;
		worldItem.itemId = dropId;

		const di = new DroppedItem(worldItem, x + 0.5, y + 0.5, z + 0.5);

		// The item spawns inside the still-solid block, whose voxel stores no
		// light until the deferred light propagation lands — tint it from the
		// lit air voxel beside the mined face instead.
		di.setInitialLight(packedLight);

		variation ^= blockId;
		variation ^= variation << 3;
		variation ^= variation >>> 2;

		const pushX = ((variation & 7) - 3.5) * 0.44;
		const pushY = 0.67 + ((variation >>> 3) & 3);
		const pushZ = (((variation >>> 5) & 7) - 3.5) * 0.44;

		di.addVelocity(pushX, pushY, pushZ);

		const particlePos = _scratchParticlePos;
		setVec3(particlePos, x + 0.5, y + 0.5, z + 0.5);
		play(this.#player.sceneRef, particlePos, blockId, packedLight);

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
		if (blockId === BlockType.WoodCrate) {
			const blockInventory = getBlockInventory(x, y, z);

			const dropX = x + 0.5;
			const dropY = y + 0.5;
			const dropZ = z + 0.5;

			for (const row of blockInventory.slots) {
				for (const savedItem of row) {
					if (savedItem) {
						const item = Item.createById(savedItem.itemId);
						item.stackSize = savedItem.stackSize;
						variation ^= savedItem.itemId;
						variation ^= variation << 3;
						variation ^= variation >>> 2;

						const pushX = ((variation & 7) - 3.5) * 0.44;
						const pushY = 0.5 + ((variation >>> 3) & 3);
						const pushZ = (((variation >>> 5) & 7) - 3.5) * 0.44;

						const droppedItem = new DroppedItem(item, dropX, dropY, dropZ);
						droppedItem.setInitialLight(packedLight);
						droppedItem.addVelocity(pushX, pushY, pushZ);
					}
				}
			}
			const emptyInv = createEmptyInventory(
				blockInventory.width,
				blockInventory.height,
			);
			saveBlockInventory(x, y, z, emptyInv);
		}

		if (this.#player.stats.gamemode === Gamemodes.Creative) {
			di.use(this.#player);
		}
	}
}
