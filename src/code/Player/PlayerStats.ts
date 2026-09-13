export const enum Gamemodes {
	Survival = 0,
	Creative = 1,
	Adventure = 2,
	Spectator = 3,
}

//Mining Placing Interaction
export const REACH_DISTANCE = 64;
//Pickup Aura
export const REACH_AURA = 3;
// Max distance for picking up SERVER-authoritative dropped items. The server
// only accepts ItemPickup within its own radius (2.5) of the last reported
// player position, so requests beyond this are guaranteed rejections —
// clamping client-side keeps optimistic pickups from silently desyncing.
// Local (singleplayer) items keep the full interaction reach.
export const ITEM_PICKUP_MAX_REACH = 2.0;

export type SavedPlayerStats = {
	xp: number;
	xpLevel: number;
};

export class PlayerStats {
	public gamemode: Gamemodes = Gamemodes.Creative;

	public maxHealth = 100;
	public health = 100;

	public maxHunger = 100;
	public hunger = 100;

	public maxStamina = 100;
	public stamina = 100;

	public maxMana = 100;
	public mana = 100;

	/** Experience points banked from XP orbs (zombie/skeleton kills). */
	public xp = 0;
	/** Experience level derived from total xp (see addXp). */
	public xpLevel = 0;

	// Rates per second
	public healthRegenRate = 1;
	public staminaRegenRate = 15;
	public manaRegenRate = 5;
	public hungerDepletionRate = 0.01;
	// Stamina regen scale while climbing (slow recovery on walls).
	public climbingStaminaRegenMultiplier = 0.25;

	public update(
		deltaTime: number,
		isSprinting: boolean,
		staminaRegenScale = 1,
	): void {
		// Regenerate stamina if not sprinting
		const scale = Math.max(0, staminaRegenScale); // climbing slows recovery; never drains via regen
		if (!isSprinting && this.stamina < this.maxStamina) {
			this.stamina = Math.min(
				this.maxStamina,
				this.stamina + this.staminaRegenRate * deltaTime * scale,
			);
			// Deplete hunger (only ever decreases — uses the non-negative scale)
			if (this.hunger > 0) {
				this.hunger = Math.max(
					0,
					this.hunger -
						this.staminaRegenRate *
							this.hungerDepletionRate *
							deltaTime *
							scale,
				);
			}
		}

		// Regenerate mana
		if (this.mana < this.maxMana) {
			this.mana = Math.min(
				this.maxMana,
				this.mana + this.manaRegenRate * deltaTime,
			);
		}

		// Regenerate health if well fed
		if (this.hunger > 50 && this.health < this.maxHealth) {
			this.health = Math.min(
				this.maxHealth,
				this.health + this.healthRegenRate * deltaTime,
			);
		}

		// Starvation damage
		if (this.hunger <= 0) {
			this.takeDamage(2 * deltaTime);
		}
	}

	public takeDamage(amount: number): void {
		this.health = Math.max(0, this.health - amount);
	}

	/** XP for the next level: 7 + level * 4 (cheap early, grindy late). */
	public xpForNextLevel(): number {
		return 7 + this.xpLevel * 4;
	}

	/** Bank XP, leveling up (and keeping overflow) whenever affordable. */
	public addXp(amount: number): void {
		if (!(amount > 0)) return;
		this.xp += Math.floor(amount);
		let need = this.xpForNextLevel();
		while (this.xp >= need) {
			this.xp -= need;
			this.xpLevel++;
			need = this.xpForNextLevel();
		}
	}

	/** Serializable XP snapshot for PlayerStatePersistence. */
	public getSavedStatsState(): SavedPlayerStats {
		return {
			xp: Math.max(0, Math.floor(this.xp)),
			xpLevel: Math.max(0, Math.floor(this.xpLevel)),
		};
	}

	/**
	 * Restore a persisted XP snapshot. Returns false (keeping current
	 * values) when the payload is malformed.
	 */
	public restoreSavedStatsState(saved: SavedPlayerStats): boolean {
		if (saved === null || typeof saved !== "object") return false;
		const xp = (saved as { xp?: unknown }).xp;
		const xpLevel = (saved as { xpLevel?: unknown }).xpLevel;
		if (
			typeof xp !== "number" ||
			typeof xpLevel !== "number" ||
			!Number.isFinite(xp) ||
			!Number.isFinite(xpLevel) ||
			xp < 0 ||
			xpLevel < 0
		) {
			return false;
		}
		this.xp = Math.floor(xp);
		this.xpLevel = Math.floor(xpLevel);
		return true;
	}

	public heal(amount: number): void {
		this.health = Math.min(this.maxHealth, this.health + amount);
	}

	public consumeStamina(amount: number): boolean {
		if (this.stamina >= amount) {
			this.stamina -= amount;
			return true;
		}
		return false;
	}

	public consumeMana(amount: number): boolean {
		if (this.mana >= amount) {
			this.mana -= amount;
			return true;
		}
		return false;
	}

	public eat(amount: number): void {
		this.hunger = Math.min(this.maxHunger, this.hunger + amount);
	}
}
