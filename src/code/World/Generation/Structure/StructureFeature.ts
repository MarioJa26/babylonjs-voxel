import { Biome } from "../Biome/Biomes";
import { IWorldFeature } from "./IWorldFeature";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { Structure, StructureData } from "./Structure";

export class StructureSpawnerFeature implements IWorldFeature {
  private static structures: Map<string, Structure> = new Map();

  constructor() {
    this.loadStructures();
  }

  private loadStructures() {
    const opulentHouseData: StructureData = {
      name: "Opulent House",
      width: 5,
      height: 4,
      depth: 5,
      palette: {
        "0": 0, // air
        "1": 43, // Marble
        "2": 41, // Gold Block
        "3": 19, // glass
        "4": 42, // Lapis Block
      },
      blocks: [
        // Layer Y=0 (Foundation: Solid Marble)
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        1,
        // Layer Y=1 (Walls: Marble with Gold corners, Gold floor)
        2, 1, 1, 1, 2, 1, 2, 2, 2, 1, 1, 2, 0, 2, 1, 1, 2, 2, 2, 1, 2, 1, 1, 1,
        2,
        // Layer Y=2 (Windows: Marble walls, Gold pillars, Glass)
        2, 1, 1, 1, 2, 1, 3, 0, 3, 1, 1, 0, 0, 0, 1, 1, 3, 0, 3, 1, 2, 1, 1, 1,
        2,

        // Layer Y=3 (Roof: Lapis Lazuli with Marble trim)
        1, 4, 4, 4, 1, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 1, 4, 4, 4,
        1,
      ],
    };

    StructureSpawnerFeature.structures.set(
      "Opulent House",
      new Structure(opulentHouseData),
    );
  }

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
    getTerrainHeight: (x: number, z: number, biome: Biome) => number,
  ) {
    if (StructureSpawnerFeature.structures.size === 0) return;

    const REGION_SIZE = 16;
    const SPAWN_CHANCE = 10;

    const regionX = Math.floor(chunkX / REGION_SIZE);
    const regionZ = Math.floor(chunkZ / REGION_SIZE);

    const regionHash = Squirrel3.get(
      regionX * 584661329 + regionZ * 957346603,
      seed,
    );

    if (Math.abs(regionHash) % 100 < SPAWN_CHANCE) {
      const structureNames = Array.from(
        StructureSpawnerFeature.structures.keys(),
      );
      const structureName =
        structureNames[Math.abs(regionHash) % structureNames.length];
      const structure = StructureSpawnerFeature.structures.get(structureName);

      if (!structure) return;

      const offsetX =
        Math.abs(Squirrel3.get(regionHash, seed)) % (REGION_SIZE * chunkSize);
      const offsetZ =
        Math.abs(Squirrel3.get(regionHash + 1, seed)) %
        (REGION_SIZE * chunkSize);

      const structureOriginX = regionX * REGION_SIZE * chunkSize + offsetX;
      const structureOriginZ = regionZ * REGION_SIZE * chunkSize + offsetZ;

      const groundHeight = getTerrainHeight(
        structureOriginX,
        structureOriginZ,
        biome,
      );

      structure.place(
        structureOriginX,
        groundHeight,
        structureOriginZ,
        placeBlock,
      );
    }
  }
}
