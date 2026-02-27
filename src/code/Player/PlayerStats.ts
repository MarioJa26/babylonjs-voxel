export class PlayerStats {
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
  public hungerDepletionRate = 0.03;

  public update(deltaTime: number, isSprinting: boolean): void {
    // Regenerate stamina if not sprinting
    if (!isSprinting && this.stamina < this.maxStamina) {
      this.stamina = Math.min(
        this.maxStamina,
        this.stamina + this.staminaRegenRate * deltaTime,
      );
    }

    // Regenerate mana
    if (this.mana < this.maxMana) {
      this.mana = Math.min(
        this.maxMana,
        this.mana + this.manaRegenRate * deltaTime,
      );
    }

    // Deplete hunger
    if (this.hunger > 0) {
      this.hunger = Math.max(
        0,
        this.hunger - this.hungerDepletionRate * deltaTime,
      );
    }

    // Regenerate health if well fed
    if (this.hunger > 90 && this.health < this.maxHealth) {
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
