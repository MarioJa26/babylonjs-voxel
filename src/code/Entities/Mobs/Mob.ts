import type { SceneContext, Vec3 } from "@babylonjs/lite";
import type { SavedChunkEntityData } from "@/code/World/WorldStorage";

export interface Mob {
	position: Vec3;
	hp: number;
	maxHp: number;
	readonly mobType: string;

	takeDamage(amount: number): void;
	setPlayerPosition(pos: Vec3): void;
	dispose(): void;
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
	#countsByType = new Map<string, number>();

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
	}

	removeMob(mob: Mob): void {
		if (!this.#allMobs.delete(mob)) return;

		const currentCount = this.#countsByType.get(mob.mobType) || 0;
		if (currentCount <= 1) {
			this.#countsByType.delete(mob.mobType);
		} else {
			this.#countsByType.set(mob.mobType, currentCount - 1);
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

	disposeAll(): void {
		for (const mob of [...this.#allMobs]) {
			mob.dispose();
		}

		this.#allMobs.clear();
		this.#countsByType.clear();
	}

	pickSpawnType(): MobSpawnConfig | null {
		if (this.#configs.size === 0) return null;

		let totalWeight = 0;
		const eligible: MobSpawnConfig[] = [];

		for (const config of this.#configs.values()) {
			if ((this.#countsByType.get(config.mobType) || 0) < config.maxCount) {
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
		cap: number;
		perType: { type: string; count: number; max: number }[];
	} {
		let cap = 0;
		const perType: { type: string; count: number; max: number }[] = [];

		for (const config of this.#configs.values()) {
			cap += config.maxCount;
			perType.push({
				type: config.mobType,
				count: this.#countsByType.get(config.mobType) || 0,
				max: config.maxCount,
			});
		}

		return {
			total: this.#allMobs.size,
			cap,
			perType,
		};
	}
}
