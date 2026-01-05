import { Squirrel3 } from "./Squirrel13";

/**
 * A simple class for generating 2D Voronoi noise, useful for creating river-like patterns.
 * It calculates F2-F1, the difference in distance between the closest and second-closest feature points.
 */
export class Voronoi {
  private seed: number;
  private scale: number;

  constructor(seed: number, scale = 500) {
    this.seed = seed;
    this.scale = scale;
  }

  /**
   * Generates a deterministic, pseudo-random feature point within a given grid cell.
   * @param cellX - The integer x-coordinate of the grid cell.
   * @param cellZ - The integer z-coordinate of the grid cell.
   * @returns A [x, z] tuple for the feature point's position within the world.
   */
  private getFeaturePoint(cellX: number, cellZ: number): [number, number] {
    // Use Squirrel3 to get a deterministic hash for the cell coordinates
    const cellHash = Squirrel3.get(
      cellX * 374761393 + cellZ * 678446653,
      this.seed
    );

    // Generate random offsets within the cell, ensuring the point is not on the edge
    const offsetX =
      ((Squirrel3.get(cellHash, this.seed) & 0x7fffffff) / 0x7fffffff) *
      this.scale;
    const offsetZ =
      ((Squirrel3.get(cellHash + 1, this.seed) & 0x7fffffff) / 0x7fffffff) *
      this.scale;

    return [cellX * this.scale + offsetX, cellZ * this.scale + offsetZ];
  }

  /**
   * Calculates the Voronoi value (F2 - F1) for a given world coordinate.
   * @param worldX - The world x-coordinate.
   * @param worldZ - The world z-coordinate.
   * @returns A value typically between 0 and 1. Lower values are closer to a cell boundary.
   */
  public getValue(worldX: number, worldZ: number): number {
    const currentCellX = Math.floor(worldX / this.scale);
    const currentCellZ = Math.floor(worldZ / this.scale);

    let minDist1 = Infinity; // F1: Distance to the closest point
    let minDist2 = Infinity; // F2: Distance to the second closest point

    // Check the 3x3 grid of cells around the current point
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const cellX = currentCellX + i;
        const cellZ = currentCellZ + j;
        const featurePoint = this.getFeaturePoint(cellX, cellZ);
        const dist = Math.hypot(
          featurePoint[0] - worldX,
          featurePoint[1] - worldZ
        );

        if (dist < minDist1) {
          minDist2 = minDist1;
          minDist1 = dist;
        } else if (dist < minDist2) {
          minDist2 = dist;
        }
      }
    }

    // Return (F2 - F1) normalized by the scale to get a value roughly in [0, 1]
    return (minDist2 - minDist1) / this.scale;
  }

  /**
   * Calculates the Voronoi F1 value (distance to the closest feature point) for a given world coordinate.
   * @param worldX - The world x-coordinate.
   * @param worldZ - The world z-coordinate.
   * @returns A normalized value typically between 0 and 1. Lower values are closer to a feature point's center.
   */
  public getF1Value(worldX: number, worldZ: number): number {
    const currentCellX = Math.floor(worldX / this.scale);
    const currentCellZ = Math.floor(worldZ / this.scale);

    let minDist1 = Infinity;

    // Check the 3x3 grid of cells around the current point
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const cellX = currentCellX + i;
        const cellZ = currentCellZ + j;
        const featurePoint = this.getFeaturePoint(cellX, cellZ);
        const dist = Math.hypot(
          featurePoint[0] - worldX,
          featurePoint[1] - worldZ
        );

        if (dist < minDist1) {
          minDist1 = dist;
        }
      }
    }

    // Return F1 normalized by the scale.
    return minDist1 / this.scale;
  }
}
