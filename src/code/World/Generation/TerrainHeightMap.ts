import { createNoise2D } from "simplex-noise";
import Alea from "alea";
import { Squirrel3 } from "./NoiseAndParameters/Squirrel13";
import { Biome, getBiomeFor } from "./Biome/Biomes";
import {
  GenerationParams,
  GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
//import { Voronoi } from "./NoiseAndParameters/Voronoi";
import { Spline } from "./NoiseAndParameters/Spline";
import { RiverGenerator } from "./RiverGeneration";

/**
 * A static utility class to calculate terrain height at any world coordinate.
 * This is used to determine if chunks are fully underground before generating them.
 */
export class TerrainHeightMap {
  private static params: GenerationParamsType;
  //private static continentalNoise: Voronoi;
  private static riverGenerator: RiverGenerator;
  public static temperatureNoise: ReturnType<typeof createNoise2D>;
  private static humidityNoise: ReturnType<typeof createNoise2D>;
  private static continentalnessNoise: ReturnType<typeof createNoise2D>;
  private static erosionNoise: ReturnType<typeof createNoise2D>;
  private static peaksAndValleysNoise: ReturnType<typeof createNoise2D>;
  private static continentalnessSpline: Spline;
  private static erosionSpline: Spline;
  private static peaksAndValleysSpline: Spline;

  private static seedAsInt: number;

  // Static initializer block. This runs once when the class is loaded.
  static {
    this.params = GenerationParams;
    this.riverGenerator = new RiverGenerator(this.params);
    const prng = Alea(this.params.SEED);

    // Separate PRNGs for different noise types to avoid correlation
    TerrainHeightMap.seedAsInt = Squirrel3.get(0, (prng() * 0xffffffff) | 0);
    const tempPrng = Alea(prng());
    const humidityPrng = Alea(prng());
    //const detailPrng = Alea(prng());
    const continentalnessPrng = Alea(prng());
    const erosionPrng = Alea(prng());
    const pvPrng = Alea(prng());

    this.temperatureNoise = createNoise2D(tempPrng);
    this.humidityNoise = createNoise2D(humidityPrng);
    this.continentalnessNoise = createNoise2D(continentalnessPrng);
    this.erosionNoise = createNoise2D(erosionPrng);
    this.peaksAndValleysNoise = createNoise2D(pvPrng);
    // this.continentalNoise = new Voronoi(TerrainHeightMap.seedAsInt, 5555);

    this.continentalnessSpline = new Spline([
      { t: -1.0, v: -16 },
      { t: -0.4, v: 0 },
      { t: -0.35, v: 11 },
      { t: -0.3, v: -3 },
      { t: -0.29, v: 5 },

      { t: -0.1, v: 6 },
      { t: 0.0, v: 0 },
      { t: 0.2, v: 32 },

      { t: 0.3, v: 46 },
      { t: 0.36, v: 120 },
      { t: 0.45, v: 120 },
      { t: 0.455, v: 130 },

      { t: 0.5, v: 120 },
      { t: 0.55, v: 130 },

      { t: 0.59, v: 120 },

      { t: 0.595, v: 130 },
      { t: 0.6, v: 167 },
      { t: 0.7, v: 180 },
      { t: 0.74, v: 201 },
      { t: 0.8, v: 340 },
      { t: 0.9, v: 365 },
      { t: 0.98, v: 500 },
      { t: 1.0, v: 512 },
    ]);

    this.erosionSpline = new Spline([
      { t: -1.0, v: 1.0 },
      { t: -0.8, v: 0.8 },
      { t: -0.5, v: 0.6 },
      { t: 0.0, v: 0.4 },
      { t: 0.5, v: 0.2 },
      { t: 0.8, v: 0.1 },
      { t: 1.0, v: 0 },
    ]);

    this.peaksAndValleysSpline = new Spline([
      { t: -1.0, v: -60 },
      { t: -0.6, v: -25 },
      { t: -0.2, v: -5 },
      { t: 0.2, v: 5 },
      { t: 0.5, v: 30 },
      { t: 0.8, v: 60 },
      { t: 1.0, v: 90 },
    ]);
  }

  public static getBiome(x: number, z: number): Biome {
    const CONTINENTALNESS_NOISE_SCALE =
      GenerationParams.CONTINENTALNESS_NOISE_SCALE;

    const continentalness = this.continentalnessNoise(
      x * CONTINENTALNESS_NOISE_SCALE,
      z * CONTINENTALNESS_NOISE_SCALE
    );
    const temperature =
      (this.temperatureNoise(
        x * GenerationParams.TEMPERATURE_NOISE_SCALE,
        z * GenerationParams.TEMPERATURE_NOISE_SCALE
      ) +
        1) /
      2;
    const humidity =
      (this.humidityNoise(
        x * GenerationParams.HUMIDITY_NOISE_SCALE,
        z * GenerationParams.HUMIDITY_NOISE_SCALE
      ) +
        1) /
      2;
    const river = Math.abs(this.riverGenerator.getRiverNoise(x, z));

    // Fast approximation: If continentalness is high (mountains), the river is underground.
    // We skip the expensive spline calculation here.
    let effectiveRiver = river;
    if (continentalness > 0.07) {
      effectiveRiver = 1.0;
    }

    return getBiomeFor(temperature, humidity, continentalness, effectiveRiver);
  }

  private static computeBaseHeight(x: number, z: number): number {
    const continentalness = this.continentalnessNoise(
      x * GenerationParams.CONTINENTALNESS_NOISE_SCALE,
      z * GenerationParams.CONTINENTALNESS_NOISE_SCALE
    );
    const SEA_LEVEL = GenerationParams.SEA_LEVEL;
    return SEA_LEVEL + this.continentalnessSpline.getValue(continentalness);
  }

  private static computeDetail(
    x: number,
    z: number,
    baseHeight: number
  ): number {
    const erosion = this.erosionNoise(
      x * GenerationParams.EROSION_NOISE_SCALE,
      z * GenerationParams.EROSION_NOISE_SCALE
    );
    const pv = this.peaksAndValleysNoise(
      x * GenerationParams.PV_NOISE_SCALE,
      z * GenerationParams.PV_NOISE_SCALE
    );
    const river = Math.abs(this.riverGenerator.getRiverNoise(x, z));

    // Dampen detail in river
    const riverEdge = 0.1;
    const riverFactor = river < riverEdge ? river / riverEdge : 1.0;

    // --- Tunnel / Roof Logic ---
    // If the base terrain is high (mountain), we stop carving the surface river
    // so it becomes a tunnel underneath.
    const TUNNEL_THRESHOLD =
      GenerationParams.SEA_LEVEL +
      GenerationParams.RIVER_TUNNEL_THRESHOLD_OFFSET;
    const TRANSITION_RANGE = GenerationParams.RIVER_TRANSITION_RANGE;

    // 1.0 = Full Surface River, 0.0 = Full Tunnel (No surface carving)
    let surfaceRiverInfluence = 1.0;

    if (baseHeight > TUNNEL_THRESHOLD + TRANSITION_RANGE) {
      surfaceRiverInfluence = 0.0;
    } else if (baseHeight > TUNNEL_THRESHOLD) {
      surfaceRiverInfluence =
        1.0 - (baseHeight - TUNNEL_THRESHOLD) / TRANSITION_RANGE;
    }

    // If we are tunneling, we shouldn't flatten the mountain top (riverFactor should be 1)
    const effectiveRiverFactor =
      riverFactor + (1.0 - riverFactor) * (1.0 - surfaceRiverInfluence);

    // Erosion: Determines roughness/amplitude of local features
    const roughness =
      this.erosionSpline.getValue(erosion) * effectiveRiverFactor;

    // Peaks & Valleys: Determines local shape (valleys, peaks)
    const detail = this.peaksAndValleysSpline.getValue(pv) * roughness;

    // Only apply river depth if we are on the surface
    const riverDepth =
      this.riverGenerator.getRiverDepth(river) * surfaceRiverInfluence;
    return detail + riverDepth;
  }

  public static getInterpolatedBaseHeight(
    x: number,
    z: number,
    sampleDistance: number
  ): number {
    const x0 = Math.floor(x / sampleDistance) * sampleDistance;
    const z0 = Math.floor(z / sampleDistance) * sampleDistance;
    const x1 = x0 + sampleDistance;
    const z1 = z0 + sampleDistance;

    const tx = (x - x0) / sampleDistance;
    const tz = (z - z0) / sampleDistance;

    // Compute height for (x,z) using each corner's definition
    const h00 = this.computeBaseHeight(x0, z0);
    const h10 = this.computeBaseHeight(x1, z0);
    const h01 = this.computeBaseHeight(x0, z1);
    const h11 = this.computeBaseHeight(x1, z1);

    // Bilinear interpolation of heights
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const top = lerp(h00, h10, tx);
    const bottom = lerp(h01, h11, tx);
    return lerp(top, bottom, tz);
  }

  public static getOctaveNoise(x: number, z: number): number {
    const base = this.getInterpolatedBaseHeight(x, z, 32);
    const detail = this.computeDetail(x, z, base);
    return base + detail;
  }

  public static getFinalTerrainHeight(worldX: number, worldZ: number): number {
    const potentialHeight = this.getOctaveNoise(worldX, worldZ);

    let finalHeight = potentialHeight;
    finalHeight = Math.max(17, finalHeight);
    return Math.floor(finalHeight);
  }
}
