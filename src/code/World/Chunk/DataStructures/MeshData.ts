export class MeshData {
  faceDataA: Uint8Array = new Uint8Array();
  faceDataB: Uint16Array = new Uint16Array();
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
      rawB instanceof Uint16Array
        ? rawB
        : rawB
          ? new Uint16Array(rawB)
          : new Uint16Array();
    meshData.faceDataC =
      rawC instanceof Uint8Array
        ? rawC
        : rawC
          ? new Uint8Array(rawC)
          : new Uint8Array();
    meshData.faceCount =
      typeof data.faceCount === "number"
        ? data.faceCount
        : Math.floor(meshData.faceDataA.length / 4);

    return meshData;
  }
}
