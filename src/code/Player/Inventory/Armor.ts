// ─── Armour mitigation ───
//
// The armour curve. Pure functions only, kept apart from `Equipment` so it can
// be tested without the DOM and the item registry — `Equipment` needs `Item`,
// which transitively reaches Babylon and `document`.
//
// Shape of the curve: `cap * value / (value + cap)`. It rises with armour but
// flattens toward `cap`, so the first helmet is a real improvement while a full
// reinforced set is survivable rather than trivial. It also never reaches the
// cap, so there is always a floor of incoming damage and the game can still be
// lost.
//
// Note the numerator is the armour value, not the cap: `cap / (cap + value)`
// is a *decreasing* function and would make a better armour set protect the
// player less. Reaching exactly `cap / 2` at `value === cap` is what makes the
// curve easy to sanity-check.

/** Ceiling on total damage reduction. 0.6 means a full set takes 40% less. */
export const ARMOR_MITIGATION_CAP = 0.6;

/** Fraction of incoming damage absorbed by `armorValue` armour points. */
export function mitigationForArmorValue(armorValue: number): number {
	if (armorValue <= 0) return 0;
	return (
		(ARMOR_MITIGATION_CAP * armorValue) / (armorValue + ARMOR_MITIGATION_CAP)
	);
}

/**
 * Effective armour points from a piece's base value.
 *
 * A spent piece counts at half rather than zero: armour is passive, so the
 * player never chooses to "use" it, and zeroing it would be pure punishment.
 */
export function effectiveArmorValue(
	armorValue: number,
	spent: boolean,
	depletedMultiplier: number,
): number {
	if (armorValue <= 0) return 0;
	return spent ? armorValue * depletedMultiplier : armorValue;
}
