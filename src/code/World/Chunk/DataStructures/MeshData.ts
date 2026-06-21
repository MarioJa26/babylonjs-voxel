// Shared zero-length sentinel. Every "empty" MeshData (the overwhelming
// majority of deserialize() calls for chunks with no faces on a given
// buffer, plus the `new MeshData()` default) previously allocated a fresh
// `new Uint8Array()` per field per call. Nothing can write into a
// zero-length view, so a single shared instance is safe across all
// owners and removes that allocation entirely.
const EMPTY_U8 = new Uint8Array(0);

function toU8(raw: unknown): Uint8Array {
	if (raw instanceof Uint8Array) return raw;
	return raw ? new Uint8Array(raw as ArrayBufferLike) : EMPTY_U8;
}

export class MeshData {
	faceDataA: Uint8Array = EMPTY_U8;
	faceDataB: Uint8Array = EMPTY_U8;
	faceDataC: Uint8Array = EMPTY_U8;
	faceCount = 0;

	public static deserialize(data: any): MeshData {
		const meshData = new MeshData();
		if (!data) return meshData;

		meshData.faceDataA = toU8(data.faceDataA);
		meshData.faceDataB = toU8(data.faceDataB);
		meshData.faceDataC = toU8(data.faceDataC);

		const derivedFaceCount = Math.min(
			Math.floor(meshData.faceDataA.length / 4),
			Math.floor(meshData.faceDataB.length / 4),
			Math.floor(meshData.faceDataC.length / 4),
		);

		meshData.faceCount =
			typeof data.faceCount === "number"
				? Math.max(0, Math.min(data.faceCount, derivedFaceCount))
				: derivedFaceCount;

		return meshData;
	}
}
