export class MeshData {
	faceDataA: Uint8Array = new Uint8Array();
	faceDataB: Uint8Array = new Uint8Array();
	faceDataC: Uint8Array = new Uint8Array();
	faceCount = 0;

	public static deserialize(data: any): MeshData {
		const meshData = new MeshData();
		if (!data) return meshData;

		const rawA = data.faceDataA;
		const rawB = data.faceDataB;
		const rawC = data.faceDataC;

		meshData.faceDataA =
			rawA instanceof Uint8Array
				? rawA
				: rawA
					? new Uint8Array(rawA)
					: new Uint8Array();

		meshData.faceDataB =
			rawB instanceof Uint8Array
				? rawB
				: rawB
					? new Uint8Array(rawB)
					: new Uint8Array();

		meshData.faceDataC =
			rawC instanceof Uint8Array
				? rawC
				: rawC
					? new Uint8Array(rawC)
					: new Uint8Array();

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
