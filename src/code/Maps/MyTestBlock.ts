import {
  Scene,
  Mesh,
  MeshBuilder,
  MultiMaterial,
  Color3,
  SubMesh,
  Vector3,
  PhysicsAggregate,
  PhysicsShapeType,
  ShadowGenerator,
} from "@babylonjs/core";
import { GridMaterial } from "@babylonjs/materials";
import { Map1 } from "./Map1";

export class MyTestBlock {
  public mesh: Mesh;

  constructor(scene: Scene, x: number, y: number, z: number) {
    // Helper to create a grid material with the same base color
    const createGridMat = (name: string, color: Color3): GridMaterial => {
      const mat = new GridMaterial(name, scene);
      mat.mainColor = color;
      mat.lineColor = color.scale(0.5); // darker lines for visibility
      mat.majorUnitFrequency = 1;
      mat.minorUnitVisibility = 0.2;
      mat.gridRatio = 0.1;
      mat.backFaceCulling = true;
      mat.opacity = 1;
      return mat;
    };

    // Create grid materials
    const topMat = createGridMat(`topMat`, new Color3(0.4, 0.8, 0.4)); // grassy green
    const sideMat = createGridMat(`sideMat`, new Color3(0.55, 0.27, 0.07)); // dirt brown
    const bottomMat = createGridMat(`bottomMat`, new Color3(0.35, 0.2, 0.1)); // darker dirt

    // Create box
    const box = MeshBuilder.CreateBox(`box${x},${y},${z}`, { size: 1 }, scene);
    box.position = new Vector3(x, y, z);
    box.checkCollisions = true;
    box.isPickable = true;

    // Create MultiMaterial
    const multiMat = new MultiMaterial(`multiMat${x},${y},${z}`, scene);
    multiMat.subMaterials.push(topMat); // 0 - top
    multiMat.subMaterials.push(bottomMat); // 1 - bottom
    multiMat.subMaterials.push(sideMat); // 2 - right
    multiMat.subMaterials.push(sideMat); // 3 - left
    multiMat.subMaterials.push(sideMat); // 4 - front
    multiMat.subMaterials.push(sideMat); // 5 - back

    // Apply MultiMaterial
    box.material = multiMat;

    // Set up submeshes (face material mapping)
    box.subMeshes = [];
    const verticesCount = box.getTotalVertices();

    // Mapping order depends on Babylon's CreateBox vertex order
    box.subMeshes.push(new SubMesh(2, 0, verticesCount, 0, 6, box)); // right → brown sides
    box.subMeshes.push(new SubMesh(3, 0, verticesCount, 6, 6, box)); // left → brown sides
    box.subMeshes.push(new SubMesh(4, 0, verticesCount, 12, 6, box)); // top → green grass
    box.subMeshes.push(new SubMesh(5, 0, verticesCount, 18, 6, box)); // bottom → darker dirt
    box.subMeshes.push(new SubMesh(0, 0, verticesCount, 24, 6, box)); // front → brown sides
    box.subMeshes.push(new SubMesh(1, 0, verticesCount, 30, 6, box)); // back → brown sides

    // Physics
    box.metadata = new PhysicsAggregate(
      box,
      PhysicsShapeType.BOX,
      { mass: 0.01, restitution: 0.5, friction: 0.5 },
      scene
    );
    Map1.shadowGenerator.addShadowCaster(box);
    // Store reference
    this.mesh = box;
  }
}
