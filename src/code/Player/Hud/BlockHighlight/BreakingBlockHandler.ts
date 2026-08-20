import type { Mesh, Vec3 } from "@babylonjs/lite";
import { setVec3, vec3Zero } from "@/code/Lib/Math";
import { play, playDebris, playMining } from "@/code/Maps/BlockBreakParticles";
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
import { dropWorldItem } from "../../Inventory/dropWorldItem";
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

type CrackBlockPosition = { x: number; y: number; z: number };

function getDroppedBlockId(blockId: number): number {
	if (blockId === BlockType.Grass001 || blockId === 14 || blockId === 51) {
		return 46;
	}

	if (blockId === BlockType.Torch) {
		return 1017;
	}

	return blockId;
}

function stirVariation(seed: number): void {
	variation ^= seed;
	variation ^= variation << 3;
	variation ^= variation >>> 2;
}

export function computeDeterministicDropVelocity(
	seed: number,
	baseY: number,
): { x: number; y: number; z: number } {
	stirVariation(seed);

	const pushX = ((variation & 7) - 3.5) * 0.44;
	const pushY = baseY + ((variation >>> 3) & 3);
	const pushZ = (((variation >>> 5) & 7) - 3.5) * 0.44;

	return { x: pushX, y: pushY, z: pushZ };
}

function isBoatBlockContext(context: unknown): context is BoatBlockHitContext {
	if (!context || typeof context !== "object") {
		return false;
	}

	const value = context as Partial<BoatBlockHitContext>;

	if (value.kind !== "boatChunk") {
		return false;
	}

	if (
		typeof value.localX !== "number" ||
		typeof value.localY !== "number" ||
		typeof value.localZ !== "number"
	) {
		return false;
	}

	const boatChunk = value.boatChunk;

	return (
		!!boatChunk &&
		!!boatChunk.visualRoot &&
		!!boatChunk.center &&
		typeof boatChunk.setBlockLocal === "function"
	);
}

export class BlockBreakingHandler {
	#player: Player;
	#onBlockBroken?: (x: number, y: number, z: number, blockId: number) => void;

	#active = false;

	#cachedX = 0;
	#cachedY = 0;
	#cachedZ = 0;
	#cachedBlockId = -1;
	#cachedBlockState = -1;

	#cachedBoatChunk: BoatBlockHitContext["boatChunk"] | null = null;
	#cachedLocalX = 0;
	#cachedLocalY = 0;
	#cachedLocalZ = 0;

	#hasCachedBlock = false;
	#breakTimer = 0;
	#lastUpdateMs = 0;

	readonly #crackBlock: CrackBlockPosition = { x: 0, y: 0, z: 0 };

	constructor(player: Player) {
		this.#player = player;
	}

	setOnBlockBroken(
		callback: (x: number, y: number, z: number, blockId: number) => void,
	): void {
		this.#onBlockBroken = callback;
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

		this.#cachedBlockId = -1;
		this.#cachedBlockState = -1;
		this.#cachedBoatChunk = null;

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
		const boatContext = isBoatBlockContext(hit.dynamicContext)
			? hit.dynamicContext
			: null;

		const selectedHotbarSlot = this.#player.playerHud.selectedHotbarSlot;
		const item =
			this.#player.playerInventory.inventory[0][selectedHotbarSlot]?.item;

		const breakTime =
			this.#player.stats.gamemode === Gamemodes.Creative
				? 0.1
				: getBlockBreakTime(blockId, item?.itemId) || 0.001;

		if (this.#isSameTarget(hit, boatContext)) {
			this.#breakTimer += dt;

			const frac = Math.min(this.#breakTimer / breakTime, 1);
			this.#updateCrackVisual(
				x,
				y,
				z,
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

				this.#breakBlock(x, y, z, blockId, packedLight, boatContext);
			}

			return;
		}

		this.#cacheTarget(hit, boatContext);
		this.#breakTimer = 0;

		this.#updateCrackVisual(
			x,
			y,
			z,
			0,
			blockId,
			blockState,
			hit.dynamicContext,
		);
		this.#emitMiningParticles(hit, x, y, z, blockId);
	}

	#isSameTarget(
		hit: BlockRaycastHit,
		boatContext: BoatBlockHitContext | null,
	): boolean {
		if (!this.#hasCachedBlock) {
			return false;
		}

		if (
			hit.blockId !== this.#cachedBlockId ||
			hit.blockState !== this.#cachedBlockState
		) {
			return false;
		}

		if (boatContext) {
			return (
				this.#cachedBoatChunk === boatContext.boatChunk &&
				this.#cachedLocalX === boatContext.localX &&
				this.#cachedLocalY === boatContext.localY &&
				this.#cachedLocalZ === boatContext.localZ
			);
		}

		return (
			this.#cachedBoatChunk === null &&
			hit.x === this.#cachedX &&
			hit.y === this.#cachedY &&
			hit.z === this.#cachedZ
		);
	}

	#cacheTarget(
		hit: BlockRaycastHit,
		boatContext: BoatBlockHitContext | null,
	): void {
		this.#cachedX = hit.x;
		this.#cachedY = hit.y;
		this.#cachedZ = hit.z;
		this.#cachedBlockId = hit.blockId;
		this.#cachedBlockState = hit.blockState;
		this.#hasCachedBlock = true;

		if (boatContext) {
			this.#cachedBoatChunk = boatContext.boatChunk;
			this.#cachedLocalX = boatContext.localX;
			this.#cachedLocalY = boatContext.localY;
			this.#cachedLocalZ = boatContext.localZ;
		} else {
			this.#cachedBoatChunk = null;
			this.#cachedLocalX = 0;
			this.#cachedLocalY = 0;
			this.#cachedLocalZ = 0;
		}
	}

	#updateCrackVisual(
		x: number,
		y: number,
		z: number,
		progress: number,
		blockId: number,
		blockState: number,
		dynamicContext: unknown,
	): void {
		const crackBlock = this.#crackBlock;
		crackBlock.x = x;
		crackBlock.y = y;
		crackBlock.z = z;

		updateCrackingState(
			crackBlock,
			progress,
			blockId,
			blockState,
			dynamicContext,
		);
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

	#breakBlock(
		x: number,
		y: number,
		z: number,
		blockId: number,
		packedLight: number,
		boatContext: BoatBlockHitContext | null,
	): void {
		const info = getBlockInfo(blockId);
		if (!info) return;

		const dropId = getDroppedBlockId(blockId);
		const worldItem = Item.createById(dropId);
		worldItem.stackSize = 1;
		worldItem.itemId = dropId;

		const v = computeDeterministicDropVelocity(blockId, 0.67);
		const di = dropWorldItem(
			worldItem,
			x + 0.5,
			y + 0.5,
			z + 0.5,
			v.x,
			v.y,
			v.z,
			this.#player,
		);

		// The item spawns inside the still-solid block, whose voxel stores no
		// light until the deferred light propagation lands. Tint it from the
		// lit air voxel beside the mined face instead.
		di?.setInitialLight(packedLight);

		const particlePos = _scratchParticlePos;
		setVec3(particlePos, x + 0.5, y + 0.5, z + 0.5);

		play(this.#player.sceneRef, particlePos, blockId, packedLight);
		playDebris(
			this.#player.sceneRef,
			particlePos.x,
			particlePos.y,
			particlePos.z,
			blockId,
			packedLight,
		);

		this.reset();

		// Notify multiplayer of block break.
		this.#onBlockBroken?.(x, y, z, blockId);

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
					if (!savedItem) continue;

					const item = Item.createById(savedItem.itemId);
					item.stackSize = savedItem.stackSize;

					const v = computeDeterministicDropVelocity(savedItem.itemId, 0.5);
					const droppedItem = dropWorldItem(
						item,
						dropX,
						dropY,
						dropZ,
						v.x,
						v.y,
						v.z,
						this.#player,
					);
					droppedItem?.setInitialLight(packedLight);
				}
			}

			const emptyInv = createEmptyInventory(
				blockInventory.width,
				blockInventory.height,
			);
			saveBlockInventory(x, y, z, emptyInv);
		}

		if (di && this.#player.stats.gamemode === Gamemodes.Creative) {
			di.use(this.#player);
		}
	}
}
