// ---------------------------------------------------------------------------
// The world feature list, shared between the generator and the streaming
// controller.
//
// WHY A SHARED FACTORY
// --------------------
// The generator (worker side) instantiates the features and runs them per
// chunk. The streaming controller (main thread) needs to know where a
// structure REACHES, so it can keep the chunks a tall structure occupies
// instead of treating them as empty sky.
//
// Both must agree on the feature list and on the seed, otherwise the
// controller would keep chunks the generator never fills (or drop chunks it
// does). One factory, two consumers.
//
// The features are stateless apart from the tower's decision cache (a pure
// memo of region -> placement), so instantiating them on both sides is safe.
// ---------------------------------------------------------------------------

import { AbyssalTempleFeature } from "./Structure/AbyssalTempleFeature";
import { AbandonedCabinFeature } from "./Structure/AbandonedCabinFeature";
import { BadlandsSpireFeature } from "./Structure/BadlandsSpireFeature";
import { BambooShrineFeature } from "./Structure/BambooShrineFeature";
import { CaravanCampFeature } from "./Structure/CaravanCampFeature";
import { CliffDwellingFeature } from "./Structure/CliffDwellingFeature";
import { CrystalShrineFeature } from "./Structure/CrystalShrineFeature";
import { DesertOasisFeature } from "./Structure/DesertOasisFeature";
import { DockFeature } from "./Structure/DockFeature";
import { DungeonFeature } from "./Structure/DungeonFeature";
import { FossilBedFeature } from "./Structure/FossilBedFeature";
import { FrozenShrineFeature } from "./Structure/FrozenShrineFeature";
import { GeodeFeature } from "./Structure/GeodeFeature";
import { IglooFeature } from "./Structure/IglooFeature";
import { InfernalPitFeature } from "./Structure/InfernalPitFeature";
import type { IWorldFeature } from "./Structure/IWorldFeature";
import { LavaPoolFeature } from "./Structure/LavaPoolFeature";
import { LighthouseFeature } from "./Structure/LighthouseFeature";
import { MayaTempleFeature } from "./Structure/MayaTempleFeature";
import { MineshaftFeature } from "./Structure/MineshaftFeature";
import { MountainCabinFeature } from "./Structure/MountainCabinFeature";
import { MushroomHutFeature } from "./Structure/MushroomHutFeature";
import { ObservatoryFeature } from "./Structure/ObservatoryFeature";
import { PetrifiedShrineFeature } from "./Structure/PetrifiedShrineFeature";
import { PondFeature } from "./Structure/PondFeature";
import { PyramidFeature } from "./Structure/PyramidFeature";
import { RavineFeature } from "./Structure/RavineFeature";
import { RuinFeature } from "./Structure/RuinFeature";
import { ShipwreckFeature } from "./Structure/ShipwreckFeature";
import { SnowFortFeature } from "./Structure/SnowFortFeature";
import { StoneCircleFeature } from "./Structure/StoneCircleFeature";
import { StructureSpawnerFeature } from "./Structure/StructureFeature";
import { TowerFeature } from "./Structure/TowerFeature";
import { TropicalTempleFeature } from "./Structure/TropicalTempleFeature";
import { TreehouseFeature } from "./Structure/TreehouseFeature";
import { WatchtowerFeature } from "./Structure/WatchtowerFeature";
import { WellFeature } from "./Structure/WellFeature";
import { WindmillFeature } from "./Structure/WindmillFeature";

/**
 * Instantiate the world feature list.
 *
 * ORDER MATTERS for the generator: features are run in this order and a later
 * feature may overwrite an earlier one's blocks, so the list must not be
 * reordered casually.
 */
export function createWorldFeatures(): IWorldFeature[] {
	return [
		new TowerFeature(),
		new LavaPoolFeature(),
		new StructureSpawnerFeature(),
		new DungeonFeature(),
		new RavineFeature(),
		new GeodeFeature(),
		new MineshaftFeature(),
		new InfernalPitFeature(),
		new BadlandsSpireFeature(),
		// Coastal
		new ShipwreckFeature(),
		new LighthouseFeature(),
		new DockFeature(),
		// Cold
		new IglooFeature(),
		new FrozenShrineFeature(),
		new SnowFortFeature(),
		// Temperate
		new AbandonedCabinFeature(),
		new WindmillFeature(),
		new StoneCircleFeature(),
		new WellFeature(),
		new PondFeature(),
		// Hot
		new PyramidFeature(),
		new DesertOasisFeature(),
		new WatchtowerFeature(),
		new CaravanCampFeature(),
		// Tropical
		new TropicalTempleFeature(),
		new TreehouseFeature(),
		new BambooShrineFeature(),
		// Maya — large surface temple with a multi-level dungeon beneath
		new MayaTempleFeature(),
		// Mountain
		new MountainCabinFeature(),
		new CliffDwellingFeature(),
		new ObservatoryFeature(),
		// Geological
		new CrystalShrineFeature(),
		new MushroomHutFeature(),
		// Exotic
		new RuinFeature(),
		new PetrifiedShrineFeature(),
		// Underground
		new AbyssalTempleFeature(),
		new FossilBedFeature(),
	];
}
