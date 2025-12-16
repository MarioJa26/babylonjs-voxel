export interface StructureData {
  name?: string;
  width: number;
  height: number;
  depth: number;
  blocks: number[];
  palette: { [key: string]: number };
}

type PlaceBlockFunction = (
  x: number,
  y: number,
  z: number,
  blockId: number,
  overwrite: boolean
) => void;

export class Structure {
  public readonly width: number;
  public readonly height: number;
  public readonly depth: number;
  private blocks: Uint8Array;

  constructor(data: StructureData) {
    this.width = data.width;
    this.height = data.height;
    this.depth = data.depth;

    // Map the palette indices from the file to the actual block IDs
    this.blocks = new Uint8Array(data.blocks.length);
    for (let i = 0; i < data.blocks.length; i++) {
      const paletteIndex = data.blocks[i].toString();
      this.blocks[i] = data.palette[paletteIndex] ?? 0;
    }
  }

  /**
   * Places the structure into the world.
   * @param originX The world X coordinate of the structure's corner.
   * @param originY The world Y coordinate of the structure's corner.
   * @param originZ The world Z coordinate of the structure's corner.
   * @param placeBlock The function to call to place a block in the world.
   */
  public place(
    originX: number,
    originY: number,
    originZ: number,
    placeBlock: PlaceBlockFunction
  ) {
    for (let y = 0; y < this.height; y++) {
      for (let z = 0; z < this.depth; z++) {
        for (let x = 0; x < this.width; x++) {
          const index = x + z * this.width + y * this.width * this.depth;
          const blockId = this.blocks[index];

          // A block ID of 0 is considered air; we don't place it.
          if (blockId !== 0) {
            placeBlock(originX + x, originY + y, originZ + z, blockId, true);
          }
        }
      }
    }
  }
}
