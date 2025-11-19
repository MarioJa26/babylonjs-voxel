export class MeshData {
  positions: Float32Array = new Float32Array();
  indices: Uint32Array = new Uint32Array();
  normals: Float32Array = new Float32Array();
  tangents: Float32Array = new Float32Array();
  uvs: Float32Array = new Float32Array();
  uvs2: Float32Array = new Float32Array();
  uvs3: Float32Array = new Float32Array();

  public static deserialize(data: any): MeshData {
    const meshData = new MeshData();
    if (!data) return meshData;

    // The data from the worker is a plain object with typed arrays.
    // We just need to assign them to the properties of our new MeshData instance.
    meshData.positions = data.positions || new Float32Array();
    meshData.indices = data.indices || new Uint32Array();
    meshData.normals = data.normals || new Float32Array();
    meshData.tangents = data.tangents || new Float32Array();
    meshData.uvs = data.uvs || new Float32Array();
    meshData.uvs2 = data.uvs2 || new Float32Array();
    meshData.uvs3 = data.uvs3 || new Float32Array();

    return meshData;
  }
}
