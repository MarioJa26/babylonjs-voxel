import type { SceneContext, Vec3 } from "@babylonjs/lite";
import type { SavedChunkEntityData } from "@/code/World/WorldStorage";

export interface Mob {
	position: Vec3;
	/** Facing angle around Y (radians); rotates with wandering AI. */
	readonly facingYaw: number;
	/** Half-extents of the mob's hit box (matches its visual body). */
	readonly hitHalfExtents: Vec3;
	hp: number;
	maxHp: number;
	readonly mobType: string;

	/**
	 * False for player-spawned mobs (spawn eggs): they are exempt from the
	 * mob cap, which only limits naturally spawned mobs. Set before the mob
	 * is added to the MobRegistry and treated as immutable afterwards.
	 */
	countsTowardMobCap: boolean;

	takeDamage(amount: number): void;
	setPlayerPosition(pos: Vec3): void;
	dispose(): void;
	/** True once disposed — stuck projectiles stop following after this. */
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
};

export class MobRegistry {
	#configs = new Map<string, MobSpawnConfig>();
	#allMobs = new Set<Mob>();
	// Cap accounting tracks only naturally spawned mobs; spawn-egg mobs
	// (countsTowardMobCap === false) never block natural spawning.
	#countsByType = new Map<string, number>();
	#naturalCountsByType = new Map<string, number>();
	#naturalTotal = 0;

	register(config: MobSpawnConfig): void {
		this.#configs.set(config.mobType, config);
	}

	addMob(mob: Mob): void {
		if (this.#allMobs.has(mob)) return;

		this.#allMobs.add(mob);
		this.#countsByType.set(
			mob.mobType,
			(this.#countsByType.get(mob.mobType) || 0) + 1,
		);

		if (mob.countsTowardMobCap) {
			this.#naturalTotal++;
			this.#naturalCountsByType.set(
				mob.mobType,
				(this.#naturalCountsByType.get(mob.mobType) || 0) + 1,
			);
		}
	}

	removeMob(mob: Mob): void {
		if (!this.#allMobs.delete(mob)) return;

		const currentCount = this.#countsByType.get(mob.mobType) || 0;
		if (currentCount <= 1) {
			this.#countsByType.delete(mob.mobType);
		} else {
			this.#countsByType.set(mob.mobType, currentCount - 1);
		}

		if (mob.countsTowardMobCap) {
			this.#naturalTotal = Math.max(0, this.#naturalTotal - 1);

			const naturalCount = this.#naturalCountsByType.get(mob.mobType) || 0;
			if (naturalCount <= 1) {
				this.#naturalCountsByType.delete(mob.mobType);
			} else {
				this.#naturalCountsByType.set(mob.mobType, naturalCount - 1);
			}
		}
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
		return this.#countsByType.get(mobType) || 0;
	}

	getTotalCount(): number {
		return this.#allMobs.size;
	}

	/** Number of mobs that count toward the mob cap (naturally spawned). */
	getNaturalTotal(): number {
		return this.#naturalTotal;
	}

	disposeAll(): void {
		for (const mob of [...this.#allMobs]) {
			mob.dispose();
		}

		this.#allMobs.clear();
		this.#countsByType.clear();
		this.#naturalCountsByType.clear();
		this.#naturalTotal = 0;
	}

	pickSpawnType(): MobSpawnConfig | null {
		if (this.#configs.size === 0) return null;

		let totalWeight = 0;
		const eligible: MobSpawnConfig[] = [];

		for (const config of this.#configs.values()) {
			const naturalCount = this.#naturalCountsByType.get(config.mobType) || 0;
			if (naturalCount < config.maxCount) {
				eligible.push(config);
				totalWeight += config.spawnWeight;
			}
		}

		if (eligible.length === 0) return null;

		let roll = Math.random() * totalWeight;
		for (const config of eligible) {
			roll -= config.spawnWeight;
			if (roll <= 0) return config;
		}

		return eligible[eligible.length - 1];
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
				count: this.#countsByType.get(config.mobType) || 0,
				natural: this.#naturalCountsByType.get(config.mobType) || 0,
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
}
