// World/MeshPipeline/core/ShapePipeline.ts
//
// Re-export shim: the shape/flags caches formerly defined here (SHAPE_INFO_CACHE,
// RUNTIME_BOX_CACHE, GREEDY_COMPAT_CACHE, FLAGS_ID_CACHE, BlockTint, material
// type LUT) were consolidated into the unified BlockInfoCache module. The
// functions keep their public names here so existing importers (including
// main-thread code such as PlayerVehicle.ts) continue to work unchanged.

export {
	BlockTint,
	getMaterialType,
	getRuntimeShapeBoxes,
	getShapeInfo,
	isGreedyCompatiblePackedBlock,
} from "./BlockInfoCache";
