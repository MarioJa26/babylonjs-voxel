const EMPTY_U8 = new Uint8Array(0);

export class MeshData {
	faceDataA: Uint8Array = EMPTY_U8;
	faceDataB: Uint8Array = EMPTY_U8;
	faceDataC: Uint8Array = EMPTY_U8;
	faceCount = 0;
}
