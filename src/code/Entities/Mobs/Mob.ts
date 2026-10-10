import type { SceneContext, Vec3 } from "@babylonjs/lite";
import type { SavedChunkEntityData } from "@/code/World/WorldStorage";

export interface Mob {
	position: Vec3;

	/** Facing angle around Y in radians; rotates with wandering AI. */
	readonly facingYaw: number;

	/** Half-extents of the mob's hit box, matching its visual body. */
	readonly hitHalfExtents: Vec3;

	hp: number;
	maxHp: number;
	readonly mobType: string;

	/**
	 * False for player-spawned mobs. Set before registration and treated as
	 * immutable while the mob remains in the registry.
	 */
	countsTowardMobCap: boolean;

	takeDamage(amount: number, impactPosition?: Vec3): void;
	setPlayerPosition(pos: Vec3): void;
	dispose(): void;

	/** True once disposed; stuck projectiles stop following after this. */
	readonly isDisposed: boolean;

	serializeForChunkReload(): SavedChunkEntityData | null;
}

export type MobSpawnConfig = {
	mobType: string;
	factory: (x: number, y: number, z: number, scene: SceneContext) => Mob;
	maxCount: number;
	spawnWeight: number;
	spawnBlockId: number;
	despawnable?: boolean;
	spawnYOffset?: number;

	/**
	 * Natural spawning only runs at night and skips the daylight skylight
	 * gate. Spawn eggs ignore this setting.
	 */
	nightSpawn?: boolean;

	/**
	 * Natural spawning only runs during the day. Spawn eggs ignore this
	 * setting.
	 */
	daySpawn?: boolean;

	/**
	 * The spawn finder selects a mid-air cell rather than scanning ground.
	 */
	airSpawn?: boolean;

	/**
	 * Number of members created by a group-spawn event.
	 */
	flockSize?: {
		min: number;
		max: number;
	};
};

const SPATIAL_CELL_SIZE = 8;
const INVERSE_SPATIAL_CELL_SIZE = 1 / SPATIAL_CELL_SIZE;

type SpatialCell = Set<Mob>;
type SpatialZMap = Map<number, SpatialCell>;
type SpatialYMap = Map<number, SpatialZMap>;
type SpatialGrid = Map<number, SpatialYMap>;

type CellPosition = {
	x: number;
	y: number;
	z: number;
};

function toCellCoordinate(worldCoordinate: number): number {
	return Math.floor(worldCoordinate * INVERSE_SPATIAL_CELL_SIZE);
}

function incrementCount(counts: Map<string, number>, mobType: string): void {
	counts.set(mobType, (counts.get(mobType) ?? 0) + 1);
}

function decrementCount(counts: Map<string, number>, mobType: string): void {
	const count = counts.get(mobType);

	if (count === undefined) {
		return;
	}

	if (count <= 1) {
		counts.delete(mobType);
		return;
	}

	counts.set(mobType, count - 1);
}

export class MobRegistry {
	#configs = new Map<string, MobSpawnConfig>();
	#allMobs = new Set<Mob>();

	/** Includes both natural and player-spawned mobs. */
	#countsByType = new Map<string, number>();

	/** Includes only mobs that count toward natural spawn caps. */
	#naturalCountsByType = new Map<string, number>();
	#naturalTotal = 0;

	/**
	 * Collision-free spatial hierarchy:
	 *
	 * cell X -> cell Y -> cell Z -> mobs
	 */
	#spatialGrid: SpatialGrid = new Map();

	/**
	 * Tracks the cell in which each mob is currently indexed.
	 *
	 * This makes removal reliable even when the mob's current position differs
	 * from the position at which it was inserted.
	 */
	#indexedCells = new Map<Mob, CellPosition>();

	register(config: MobSpawnConfig): void {
		this.#configs.set(config.mobType, config);
	}

	addMob(mob: Mob): void {
		if (this.#allMobs.has(mob)) {
			return;
		}

		this.#allMobs.add(mob);
		incrementCount(this.#countsByType, mob.mobType);

		if (mob.countsTowardMobCap) {
			this.#naturalTotal++;

			incrementCount(this.#naturalCountsByType, mob.mobType);
		}

		this.#insertIntoCurrentCell(mob);
	}

	removeMob(mob: Mob): void {
		if (!this.#allMobs.delete(mob)) {
			return;
		}

		decrementCount(this.#countsByType, mob.mobType);

		if (mob.countsTowardMobCap) {
			if (this.#naturalTotal > 0) {
				this.#naturalTotal--;
			}

			decrementCount(this.#naturalCountsByType, mob.mobType);
		}

		const indexedCell = this.#indexedCells.get(mob);

		if (indexedCell !== undefined) {
			this.#removeFromCell(mob, indexedCell.x, indexedCell.y, indexedCell.z);
		}
	}

	/**
	 * Update a mob's spatial membership after its position changes.
	 *
	 * Calls that remain inside the same spatial cell perform no map mutation,
	 * so this may safely be called after every movement update.
	 */
	updateMobPosition(mob: Mob): void {
		const previous = this.#indexedCells.get(mob);

		if (previous === undefined) {
			return;
		}

		const nextX = toCellCoordinate(mob.position.x);
		const nextY = toCellCoordinate(mob.position.y);
		const nextZ = toCellCoordinate(mob.position.z);

		if (previous.x === nextX && previous.y === nextY && previous.z === nextZ) {
			return;
		}

		this.#removeFromCell(mob, previous.x, previous.y, previous.z);

		/*
		 * External movement logic could theoretically unregister the mob while
		 * its position is being changed. Do not reinsert an unregistered mob.
		 */
		if (this.#allMobs.has(mob)) {
			this.#insertIntoCell(mob, nextX, nextY, nextZ);
		}
	}

	getMobsInRegion(
		minX: number,
		minY: number,
		minZ: number,
		maxX: number,
		maxY: number,
		maxZ: number,
	): Mob[] {
		const result: Mob[] = [];

		const minCellX = toCellCoordinate(minX);
		const minCellY = toCellCoordinate(minY);
		const minCellZ = toCellCoordinate(minZ);

		const maxCellX = toCellCoordinate(maxX);
		const maxCellY = toCellCoordinate(maxY);
		const maxCellZ = toCellCoordinate(maxZ);

		for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
			const yMap = this.#spatialGrid.get(cellX);

			if (yMap === undefined) {
				continue;
			}

			for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
				const zMap = yMap.get(cellY);

				if (zMap === undefined) {
					continue;
				}

				for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
					const cell = zMap.get(cellZ);

					if (cell === undefined) {
						continue;
					}

					for (const mob of cell) {
						if (!mob.isDisposed) {
							result.push(mob);
						}
					}
				}
			}
		}

		return result;
	}

	getAllMobs(): ReadonlySet<Mob> {
		return this.#allMobs;
	}

	getConfigs(): IterableIterator<MobSpawnConfig> {
		return this.#configs.values();
	}

	getConfig(mobType: string): MobSpawnConfig | undefined {
		return this.#configs.get(mobType);
	}

	getCountByType(mobType: string): number {
		return this.#countsByType.get(mobType) ?? 0;
	}

	getTotalCount(): number {
		return this.#allMobs.size;
	}

	/** Number of mobs that count toward the natural mob cap. */
	getNaturalTotal(): number {
		return this.#naturalTotal;
	}

	disposeAll(): void {
		/*
		 * Avoid allocating `[...this.#allMobs]`. Fetching one mob at a time is
		 * also safe when Mob.dispose() calls removeMob().
		 */
		while (this.#allMobs.size > 0) {
			const result = this.#allMobs.values().next();

			if (result.done) {
				break;
			}

			const mob = result.value;

			/*
			 * Delete first to guarantee forward progress even if this mob's
			 * dispose implementation does not unregister itself.
			 */
			this.#allMobs.delete(mob);
			mob.dispose();
		}

		this.#allMobs.clear();
		this.#countsByType.clear();
		this.#naturalCountsByType.clear();
		this.#naturalTotal = 0;

		this.#spatialGrid.clear();
		this.#indexedCells.clear();
	}

	pickSpawnType(): MobSpawnConfig | null {
		let totalWeight = 0;
		let fallback: MobSpawnConfig | null = null;

		/*
		 * First pass calculates the total without allocating an eligible
		 * configuration array.
		 */
		for (const config of this.#configs.values()) {
			const naturalCount = this.#naturalCountsByType.get(config.mobType) ?? 0;

			if (naturalCount >= config.maxCount || config.spawnWeight <= 0) {
				continue;
			}

			totalWeight += config.spawnWeight;
			fallback = config;
		}

		if (fallback === null || totalWeight <= 0) {
			return null;
		}

		let roll = Math.random() * totalWeight;

		/*
		 * Second pass performs weighted selection using constant temporary
		 * memory.
		 */
		for (const config of this.#configs.values()) {
			const naturalCount = this.#naturalCountsByType.get(config.mobType) ?? 0;

			if (naturalCount >= config.maxCount || config.spawnWeight <= 0) {
				continue;
			}

			roll -= config.spawnWeight;

			if (roll <= 0) {
				return config;
			}
		}

		/*
		 * Floating-point accumulation can theoretically leave a tiny positive
		 * remainder after the second pass.
		 */
		return fallback;
	}

	getDebugStats(): {
		total: number;
		naturalTotal: number;
		cap: number;
		perType: {
			type: string;
			count: number;
			natural: number;
			max: number;
		}[];
	} {
		let cap = 0;

		const perType: {
			type: string;
			count: number;
			natural: number;
			max: number;
		}[] = [];

		for (const config of this.#configs.values()) {
			cap += config.maxCount;

			perType.push({
				type: config.mobType,
				count: this.#countsByType.get(config.mobType) ?? 0,
				natural: this.#naturalCountsByType.get(config.mobType) ?? 0,
				max: config.maxCount,
			});
		}

		return {
			total: this.#allMobs.size,
			naturalTotal: this.#naturalTotal,
			cap,
			perType,
		};
	}

	#insertIntoCurrentCell(mob: Mob): void {
		this.#insertIntoCell(
			mob,
			toCellCoordinate(mob.position.x),
			toCellCoordinate(mob.position.y),
			toCellCoordinate(mob.position.z),
		);
	}

	#insertIntoCell(mob: Mob, cellX: number, cellY: number, cellZ: number): void {
		let yMap = this.#spatialGrid.get(cellX);

		if (yMap === undefined) {
			yMap = new Map();
			this.#spatialGrid.set(cellX, yMap);
		}

		let zMap = yMap.get(cellY);

		if (zMap === undefined) {
			zMap = new Map();
			yMap.set(cellY, zMap);
		}

		let cell = zMap.get(cellZ);

		if (cell === undefined) {
			cell = new Set();
			zMap.set(cellZ, cell);
		}

		cell.add(mob);

		this.#indexedCells.set(mob, {
			x: cellX,
			y: cellY,
			z: cellZ,
		});
	}

	#removeFromCell(mob: Mob, cellX: number, cellY: number, cellZ: number): void {
		this.#indexedCells.delete(mob);

		const yMap = this.#spatialGrid.get(cellX);

		if (yMap === undefined) {
			return;
		}

		const zMap = yMap.get(cellY);

		if (zMap === undefined) {
			return;
		}

		const cell = zMap.get(cellZ);

		if (cell === undefined) {
			return;
		}

		cell.delete(mob);

		if (cell.size !== 0) {
			return;
		}

		zMap.delete(cellZ);

		if (zMap.size !== 0) {
			return;
		}

		yMap.delete(cellY);

		if (yMap.size === 0) {
			this.#spatialGrid.delete(cellX);
		}
	}
}
