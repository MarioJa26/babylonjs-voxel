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
