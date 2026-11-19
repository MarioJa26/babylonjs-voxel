import { CHUNK_SIZE } from "@/code/Lib/VoxelMath";

/** Minecraft-style random-tick input: one loaded 32³ chunk contains 8 sections. */
export interface RandomTickChunkAccess {
	readonly chunkX: number;
	readonly chunkY: number;
	readonly chunkZ: number;
	readonly isLoaded?: boolean;
	readonly hasVoxelData?: boolean;
	getBlock(localX: number, localY: number, localZ: number): number;
}

export type RandomTickHandler = (
	worldX: number,
	worldY: number,
	worldZ: number,
	blockId: number,
) => void;

const RANDOM_TICK_SECTION_SIZE = 16;
const SECTIONS_PER_AXIS = Math.max(
	1,
	Math.ceil(CHUNK_SIZE / RANDOM_TICK_SECTION_SIZE),
);

export class RandomTickEngine {
	private randomTickSpeed: number;

	constructor(
		private readonly onRandomTick: RandomTickHandler,
		randomTickSpeed = 3,
		private readonly random: () => number = Math.random,
	) {
		this.randomTickSpeed = Math.max(0, Math.floor(randomTickSpeed));
	}

	setRandomTickSpeed(speed: number): void {
		this.randomTickSpeed = Math.max(0, Math.floor(speed));
	}

	/**
	 * Samples random blocks in loaded chunk sections.
	 *
	 * When centerChunkX is supplied, chunks outside chunkRadius are skipped.
	 * Y and Z filtering is only applied when their respective centers are supplied.
	 */
	tick(
		chunks: Iterable<RandomTickChunkAccess>,
		centerChunkX?: number,
		centerChunkY?: number,
		centerChunkZ?: number,
		chunkRadius = Infinity,
	): void {
		const tickSpeed = this.randomTickSpeed;
		if (tickSpeed <= 0) return;

		const random = this.random;
		const onRandomTick = this.onRandomTick;

		const filterByDistance = centerChunkX !== undefined;
		const filterY = centerChunkY !== undefined;
		const filterZ = centerChunkZ !== undefined;

		for (const chunk of chunks) {
			if (chunk.isLoaded === false || chunk.hasVoxelData === false) {
				continue;
			}

			const chunkX = chunk.chunkX;
			const chunkY = chunk.chunkY;
			const chunkZ = chunk.chunkZ;

			if (
				filterByDistance &&
				(Math.abs(chunkX - centerChunkX) > chunkRadius ||
					(filterY && Math.abs(chunkY - centerChunkY) > chunkRadius) ||
					(filterZ && Math.abs(chunkZ - centerChunkZ) > chunkRadius))
			) {
				continue;
			}

			const worldBaseX = chunkX * CHUNK_SIZE;
			const worldBaseY = chunkY * CHUNK_SIZE;
			const worldBaseZ = chunkZ * CHUNK_SIZE;
			const getBlock = chunk.getBlock.bind(chunk);

			for (let sectionY = 0; sectionY < SECTIONS_PER_AXIS; sectionY++) {
				const sectionBaseY = sectionY * RANDOM_TICK_SECTION_SIZE;

				for (let sectionZ = 0; sectionZ < SECTIONS_PER_AXIS; sectionZ++) {
					const sectionBaseZ = sectionZ * RANDOM_TICK_SECTION_SIZE;

					for (let sectionX = 0; sectionX < SECTIONS_PER_AXIS; sectionX++) {
						const sectionBaseX = sectionX * RANDOM_TICK_SECTION_SIZE;

						for (let i = 0; i < tickSpeed; i++) {
							const localX =
								sectionBaseX + Math.floor(random() * RANDOM_TICK_SECTION_SIZE);
							const localY =
								sectionBaseY + Math.floor(random() * RANDOM_TICK_SECTION_SIZE);
							const localZ =
								sectionBaseZ + Math.floor(random() * RANDOM_TICK_SECTION_SIZE);

							onRandomTick(
								worldBaseX + localX,
								worldBaseY + localY,
								worldBaseZ + localZ,
								getBlock(localX, localY, localZ),
							);
						}
					}
				}
			}
		}
	}
}
