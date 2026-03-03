export class MeshData {
  positions: Uint8Array = new Uint8Array();
  indices: Uint16Array = new Uint16Array();
  normals: Int8Array = new Int8Array();
  uvData: Uint8Array = new Uint8Array();
  cornerIds: Uint8Array = new Uint8Array(); // float
  ao: Uint8Array = new Uint8Array(); // Ambient Occlusion values
  light: Uint8Array = new Uint8Array(); // Light values
  materialType: Uint8Array = new Uint8Array(); // Material type (0 = glass, 1 = water)

  public static deserialize(data: any): MeshData {
    const meshData = new MeshData();
    if (!data) return meshData;

    // The data from the worker is a plain object with typed arrays.
    // We just need to assign them to the properties of our new MeshData instance.
    meshData.positions = data.positions || new Uint8Array();
    meshData.indices = data.indices || new Uint16Array();
    meshData.normals = data.normals || new Int8Array();
    meshData.uvData = data.uvData || new Uint8Array();
    meshData.cornerIds = data.cornerIds || new Uint8Array();
    meshData.ao = data.ao || new Uint8Array();
    meshData.light = data.light || new Uint8Array();
    meshData.materialType = data.materialType || new Uint8Array();

    return meshData;
  }
}
