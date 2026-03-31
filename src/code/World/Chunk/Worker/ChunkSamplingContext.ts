export type SamplingBlockArray = Uint8Array | Uint16Array;

export type ChunkSamplingContextArgs = {
  block_array: SamplingBlockArray;
  chunk_size: number;
  light_array?: Uint8Array;
  neighbors: (SamplingBlockArray | undefined)[];
  neighborLights?: (Uint8Array | undefined)[];
};

export class ChunkSamplingContext {
  public readonly size: number;
  public readonly size2: number;
  public readonly fullBright: number = 15 << 4;

  private readonly block_array: SamplingBlockArray;
  private readonly light_array?: Uint8Array;
  private readonly neighbors: (SamplingBlockArray | undefined)[];
  private readonly neighborLights?: (Uint8Array | undefined)[];

  constructor(args: ChunkSamplingContextArgs) {
    this.block_array = args.block_array;
    this.light_array = args.light_array;
    this.neighbors = args.neighbors;
    this.neighborLights = args.neighborLights;
    this.size = args.chunk_size;
    this.size2 = this.size * this.size;
  }

  public static toCompactNeighborIndex(fullIndex: number): number {
    return fullIndex > 13 ? fullIndex - 1 : fullIndex;
  }

  public getBlock = (x: number, y: number, z: number, fallback = 0): number => {
    if (
      x >= 0 &&
      x < this.size &&
      y >= 0 &&
      y < this.size &&
      z >= 0 &&
      z < this.size
    ) {
      return this.block_array[x + y * this.size + z * this.size2];
    }

    const dx = x < 0 ? -1 : x >= this.size ? 1 : 0;
    const dy = y < 0 ? -1 : y >= this.size ? 1 : 0;
    const dz = z < 0 ? -1 : z >= this.size ? 1 : 0;

    const neighbor =
      this.neighbors[
        ChunkSamplingContext.toCompactNeighborIndex(
          dx + 1 + (dy + 1) * 3 + (dz + 1) * 9,
        )
      ];

    if (!neighbor) {
      return fallback;
    }

    return neighbor[
      x -
        dx * this.size +
        (y - dy * this.size) * this.size +
        (z - dz * this.size) * this.size2
    ];
  };

  public getLight = (x: number, y: number, z: number, fallback = 0): number => {
    if (!this.light_array) {
      return this.fullBright;
    }

    if (
      x >= 0 &&
      x < this.size &&
      y >= 0 &&
      y < this.size &&
      z >= 0 &&
      z < this.size
    ) {
      return this.light_array[x + y * this.size + z * this.size2];
    }

    const dx = x < 0 ? -1 : x >= this.size ? 1 : 0;
    const dy = y < 0 ? -1 : y >= this.size ? 1 : 0;
    const dz = z < 0 ? -1 : z >= this.size ? 1 : 0;

    const neighbor = this.neighborLights
      ? this.neighborLights[
          ChunkSamplingContext.toCompactNeighborIndex(
            dx + 1 + (dy + 1) * 3 + (dz + 1) * 9,
          )
        ]
      : undefined;

    if (!neighbor) {
      return fallback;
    }

    return neighbor[
      x -
        dx * this.size +
        (y - dy * this.size) * this.size +
        (z - dz * this.size) * this.size2
    ];
  };
}
