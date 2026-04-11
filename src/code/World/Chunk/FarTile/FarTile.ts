type TileId = {
  lod: number; // 0 = finest far LOD, higher = coarser
  regionX: number;
  regionZ: number;
  regionY?: number;
};
export type FarTileSurfaceSummary = {
  // assuming world heights fit in int16; adjust to your engine ranges
  minHeight: number; // int16
  maxHeight: number; // int16
  averageHeight: number; // maybe float or fixed-point (int16 or int32)
  // optional: a tiny histogram of block/material IDs for quick shading
  dominantBlockId: number; // uint16
  dominantWaterBlockId?: number; // uint16, if you distinguish water
  waterCoverage?: number; // 0..255, percentage of tile area with water
};

export type FarTileLightSummary = {
  // coarse baked lighting, optional
  skyLightAverage: number; // 0..15
  blockLightAverage: number; // 0..15
  // or just a packed low-res 2D/3D light map:
  packedLight?: Uint8Array;
};
export type FarTileMeshBlob = {
  opaque: Uint8Array | null;
  transparent: Uint8Array | null;
  // maybe compression flag / version marker
  compression?: "none" | "gzip" | "brotli";
};
