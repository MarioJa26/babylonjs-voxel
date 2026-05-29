import type { Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import type { IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds } from "./RegionFeature";

export class DungeonFeature implements IWorldFeature {
	public generate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		biome: Biome,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void,
		seed: number,
		chunkSize: number,
		generatingChunkX: number,
		generatingChunkZ: number,
	) {
		const DUNGEON_CHANCE = 1;
		const regionHash = Squirrel3.get(chunkX * 892374 + chunkZ * 234897, seed);

		if (Math.abs(regionHash) % 100 >= DUNGEON_CHANCE) return;

		const dungeonY = 15 + (Math.abs(Squirrel3.get(regionHash, seed)) % 20);
		const numRooms = 3 + (Math.abs(Squirrel3.get(regionHash + 1, seed)) % 4);

		const centerX = chunkX * chunkSize + chunkSize / 2;
		const centerZ = chunkZ * chunkSize + chunkSize / 2;

		const rooms: { x: number; z: number; w: number; d: number }[] = [];
		let currentSeed = regionHash + 2;

		for (let i = 0; i < numRooms; i++) {
			const w = 7 + (Math.abs(Squirrel3.get(currentSeed++, seed)) % 6);
			const d = 7 + (Math.abs(Squirrel3.get(currentSeed++, seed)) % 6);

			const dx = (Math.abs(Squirrel3.get(currentSeed++, seed)) % 32) - 16;
			const dz = (Math.abs(Squirrel3.get(currentSeed++, seed)) % 32) - 16;

			rooms.push({
				x: centerX + dx,
				z: centerZ + dz,
				w,
				d,
			});
		}

		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				centerX - 40,
				centerX + 40,
				centerZ - 40,
				centerZ + 40,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const FLOOR_BLOCK = 4;
		const WALL_BLOCK = 48;
		const AIR = 0;

		for (const room of rooms) {
			if (
				room.x + room.w <= bounds.minX ||
				room.x >= bounds.maxX ||
				room.z + room.d <= bounds.minZ ||
				room.z >= bounds.maxZ
			)
				continue;

			for (let x = room.x; x < room.x + room.w; x++) {
				for (let z = room.z; z < room.z + room.d; z++) {
					for (let y = dungeonY; y < dungeonY + 6; y++) {
						let blockId = AIR;
						if (y === dungeonY) blockId = FLOOR_BLOCK;
						else if (y === dungeonY + 5) blockId = WALL_BLOCK;
						else if (
							x === room.x ||
							x === room.x + room.w - 1 ||
							z === room.z ||
							z === room.z + room.d - 1
						) {
							blockId = WALL_BLOCK;
						}

						placeBlock(x, y, z, blockId, true);
					}
				}
			}
		}

		for (let i = 0; i < rooms.length - 1; i++) {
			const r1 = rooms[i];
			const r2 = rooms[i + 1];

			const c1x = Math.floor(r1.x + r1.w / 2);
			const c1z = Math.floor(r1.z + r1.d / 2);
			const c2x = Math.floor(r2.x + r2.w / 2);
			const c2z = Math.floor(r2.z + r2.d / 2);

			const xStart = Math.min(c1x, c2x);
			const xEnd = Math.max(c1x, c2x);
			this.carveCorridor(
				xStart,
				xEnd,
				c1z,
				c1z,
				dungeonY,
				placeBlock,
				FLOOR_BLOCK,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			);

			const zStart = Math.min(c1z, c2z);
			const zEnd = Math.max(c1z, c2z);
			this.carveCorridor(
				c2x,
				c2x,
				zStart,
				zEnd,
				dungeonY,
				placeBlock,
				FLOOR_BLOCK,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			);
		}
	}

	private carveCorridor(
		x1: number,
		x2: number,
		z1: number,
		z2: number,
		yBase: number,
		placeBlock: any,
		floorBlock: number,
		minX: number,
		maxX: number,
		minZ: number,
		maxZ: number,
	) {
		if (
			Math.max(x1, x2) + 2 <= minX ||
			Math.min(x1, x2) - 1 >= maxX ||
			Math.max(z1, z2) + 2 <= minZ ||
			Math.min(z1, z2) - 1 >= maxZ
		) {
			return;
		}

		for (let x = x1 - 1; x <= x2 + 1; x++) {
			for (let z = z1 - 1; z <= z2 + 1; z++) {
				placeBlock(x, yBase, z, floorBlock, true);
				placeBlock(x, yBase + 1, z, 0, true);
				placeBlock(x, yBase + 2, z, 0, true);
				placeBlock(x, yBase + 3, z, 0, true);
				placeBlock(x, yBase + 4, z, floorBlock, true);
			}
		}
	}
}
