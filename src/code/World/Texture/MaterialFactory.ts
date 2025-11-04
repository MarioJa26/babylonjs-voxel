import { Scene, StandardMaterial, Texture } from "@babylonjs/core";

export class MaterialFactory {
  // A cache to store and reuse materials. This is a major performance optimization.
  private static materialCache = new Map<string, StandardMaterial>();

  /**
   * Creates and returns a texture.
   */
  private static createTexture(
    scene: Scene,
    path: string,
    uvScale: number
  ): Texture {
    const tex = new Texture(path, scene);
    tex.uScale = uvScale;
    tex.vScale = uvScale;
    return tex;
  }

  /**
   * Creates a StandardMaterial from a folder, assuming a specific naming convention.
   *
   * @param scene The Babylon scene.
   * @param folder The path to the folder containing the textures.
   * - e.g., "./texture/stone/concrete_tile_facade_1k"
   *
   * @param namingConvention An object defining how to find the texture components.
   * - ASSUMPTION: The folder name is like "basename_resolution" (e.g., "concrete_tile_facade_1k").
   * - The files inside are like "basename_type_resolution.ext" (e.g., "concrete_tile_facade_diff_1k.jpg").
   *
   * @param uvScale How much to scale the UVs.
   * @param extension The file extension (e.g., ".jpg" or ".png").
   * @param diff Boolean to load the diffuse/albedo texture.
   * @param nor Boolean to load the normal/bump texture.
   * @param ao Boolean to load the ambient occlusion texture.
   * @param spec Boolean to load the specular/metallic/roughness texture.
   * @returns A StandardMaterial.
   */
  static createMaterialByFolder(
    scene: Scene,
    folder: string,
    uvScale = 1,
    extension = ".png",
    diff = true,
    nor = false,
    ao = false,
    spec = false
  ): StandardMaterial {
    // Generate a unique key for the cache based on all parameters
    const cacheKey = `${folder},${uvScale},${extension},${diff},${nor},${ao},${spec}`;

    if (this.materialCache.has(cacheKey)) {
      return this.materialCache.get(cacheKey)!;
    }

    const mat = new StandardMaterial(folder, scene);

    // --- Parse the folder name to build file paths ---
    // 1. Get the last part of the folder path
    // e.g., "concrete_tile_facade_1k"
    const baseNameWithRes = folder.split("/").pop();
    if (!baseNameWithRes) {
      console.error("Could not parse folder name:", folder);
      return mat; // Return untextured material
    }

    // 2. Split the base name from its resolution suffix
    // e.g., ["concrete", "tile", "facade", "1k"]
    const parts = baseNameWithRes.split("_");
    if (parts.length < 2) {
      console.error("Invalid folder name:", folder);
      return mat; // Return untextured material
    }

    // 3. Re-assemble the parts
    // e.g., resolution = "_1k"
    const resolution = "_" + parts.pop();
    // e.g., baseName = "concrete_tile_facade"
    const baseName = parts.join("_");
    return this.buildMaterial(
      scene,
      mat,
      folder,
      baseName,
      resolution,
      extension,
      uvScale,
      diff,
      nor,
      ao,
      spec,
      cacheKey
    );
  }

  /**
   * Helper function to build the material and cache it.
   * This logic was separated to handle cases with and without a resolution suffix.
   */
  private static buildMaterial(
    scene: Scene,
    mat: StandardMaterial,
    directory: string,
    baseName: string,
    resolution: string,
    extension: string,
    uvScale: number,
    diff: boolean,
    nor: boolean,
    ao: boolean,
    spec: boolean,
    cacheKey: string
  ): StandardMaterial {
    // 4. Build paths and assign textures
    // e.g., path = "./texture/stone/concrete_tile_facade_1k/concrete_tile_facade_diff_1k.jpg"
    if (diff) {
      const path = `${directory}/${baseName}_diff${resolution}${extension}`;
      mat.diffuseTexture = this.createTexture(scene, path, uvScale);
    }

    if (nor) {
      const path = `${directory}/${baseName}_nor${resolution}${extension}`;
      mat.bumpTexture = this.createTexture(scene, path, uvScale);
    }

    if (ao) {
      const path = `${directory}/${baseName}_ao${resolution}${extension}`;
      mat.ambientTexture = this.createTexture(scene, path, uvScale);
    }

    if (spec) {
      // Note: StandardMaterial uses specularTexture. PBRMaterial would use
      // metallicTexture, roughnessTexture, etc. "spec" is ambiguous.
      // Assuming _spec for specular.
      const path = `${directory}/${baseName}_spec${resolution}${extension}`;
      mat.specularTexture = this.createTexture(scene, path, uvScale);
    }

    // 5. Save the new material to the cache and return it
    this.materialCache.set(cacheKey, mat);
    return mat;
  }

  /**
   * Calculates the full path for the texture file
   * based on the folder path and expected naming convention.
   *
   * @param folder The path to the folder (e.g., "./texture/stone/concrete_tile_facade_1k").
   * @param type The type of texture (e.g., "diff" for diffuse).
   * @param extension The file extension (e.g., ".png").
   * @returns The full path to the diffuse texture file, or null if parsing fails.
   */
  public static getTexturePathFromFolder(
    folder: string,
    type = "diff",
    extension = ".png"
  ): string | null {
    // 1. Get the last part of the folder path
    // e.g., "concrete_tile_facade_1k"
    const baseNameWithRes = folder.split("/").pop();
    if (!baseNameWithRes) {
      console.error("Could not parse folder name:", folder);
      return null;
    }

    // 2. Split the base name from its resolution suffix
    const parts = baseNameWithRes.split("_");

    let baseName: string;
    let resolution: string;

    if (parts.length < 2) {
      // Handles names like "cobblestone" (assuming no resolution suffix)
      baseName = parts.join("_");
      resolution = "";
    } else {
      // Handles names like "concrete_tile_facade_1k"
      resolution = "_" + parts.pop()!; // e.g., "_1k"
      baseName = parts.join("_"); // e.g., "concrete_tile_facade"
    }
    return `${folder}/${baseName}_${type}${resolution}${extension}`;
  }
}
