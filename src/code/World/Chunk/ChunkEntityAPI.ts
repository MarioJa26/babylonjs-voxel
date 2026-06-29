// ---------------------------------------------------------------------------
// ChunkEntityAPI
//
// Thin facade that entities (CustomBoat, AdvancedBoat, Mobs) import instead of
// ChunkLoadingSystem. This module re-exports the subset of ChunkLoadingSystem
// that entities need, breaking the Entities → ChunkLoadingSystem cycle by
// inserting an intermediate node in the import graph.
//
// NOTE: This is a re-export facade. The implementations remain in
// ChunkLoadingSystem. TypeScript resolves the re-exports at compile time, so
// there is zero runtime overhead.
// ---------------------------------------------------------------------------

export {
	type DynamicBlockSample,
	getBlockByWorldCoords,
	getBlockStateByWorldCoords,
	getLightByWorldCoords,
	registerChunkBoundEntity,
	registerChunkEntityLoader,
	registerDynamicBlockProvider,
	setBlock,
	unregisterChunkBoundEntity,
	unregisterDynamicBlockProvider,
	validateChunksAround,
} from "./ChunkLoadingSystem";
