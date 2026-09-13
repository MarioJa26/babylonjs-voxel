/**
 * workerProtocol.ts — shared constants for the chunk worker message
 * protocol, used by both ChunkWorkerPool and chunkWorker.
 */
export const enum PendingTaskKindType {
	SINGLE,
	BATCH,
	RELIGHT,
}