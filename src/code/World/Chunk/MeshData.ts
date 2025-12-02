export class MeshData {
  positions: Uint8Array = new Uint8Array();
  indices: Uint16Array = new Uint16Array();
  normals: Int8Array = new Int8Array();
  tangents: Int8Array = new Int8Array();
  uvs2: Float32Array = new Float32Array();
  uvs3: Float32Array = new Float32Array();
  cornerIds: Uint8Array = new Uint8Array();

  public static deserialize(data: any): MeshData {
    const meshData = new MeshData();
    if (!data) return meshData;

    // The data from the worker is a plain object with typed arrays.
    // We just need to assign them to the properties of our new MeshData instance.
    meshData.positions = data.positions || new Uint8Array();
    meshData.indices = data.indices || new Uint16Array();
    meshData.normals = data.normals || new Int8Array();
    meshData.tangents = data.tangents || new Int8Array();
    meshData.uvs2 = data.uvs2 || new Float32Array();
    meshData.uvs3 = data.uvs3 || new Float32Array();
    meshData.cornerIds = data.cornerIds || new Uint8Array();

    return meshData;
  }
}
