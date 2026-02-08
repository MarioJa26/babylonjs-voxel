import {
  Color3,
  Mesh,
  MeshBuilder,
  PhysicsAggregate,
  PhysicsShapeType,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF";
import { IUsable } from "../Inferface/IUsable";
import { Mount } from "./Mount";
import { MetadataContainer } from "./MetaDataContainer";
import { Player } from "../Player/Player";
import { PaddleBoatControls } from "../Player/Controls/PaddleBoatControls";
import { GenerationParams } from "../World/Generation/NoiseAndParameters/GenerationParams";

export class AdvancedBoat implements IUsable {
  #boat!: Mesh;
  #physicsAggregate!: PhysicsAggregate;
  #mount: Mount;
  #waterLevel = GenerationParams.SEA_LEVEL;
  #buoyancyPoints: Vector3[] = [];
  #playersOnBoard: Set<Player> = new Set();
  #baseBuoyancyForce = 20;
  #playerWeightCompensation = 14; // Extra buoyancy per player

  static #boatControls: PaddleBoatControls;

  #submergedPoints = 0;

  constructor(
    scene: Scene,
    player: Player,
    waterLevel: number,
    position?: Vector3,
  ) {
    this.createBoat(scene, position);
    this.#waterLevel = waterLevel;

    this.#boat.metadata = new MetadataContainer();
    this.#boat.metadata.add("use", (player: Player) => this.use(player));

    this.setupBuoyancyPoints();
    this.setupAdvancedPhysics(scene);
    AdvancedBoat.#boatControls = new PaddleBoatControls(this, player);

    this.#mount = new Mount(this.#boat, AdvancedBoat.#boatControls);
  }

  private createBoat(scene: Scene, position?: Vector3): void {
    // Create the physics root (invisible collision/buoyancy box)
    const boatHull = MeshBuilder.CreateCylinder(
      "boatHull",
      {
        height: 1.2,
        diameterTop: 2.5,
        diameterBottom: 2,
        tessellation: 8,
      },
      scene,
    );

    boatHull.scaling = new Vector3(1.3, 1.3, 1.3);
    boatHull.position = new Vector3(
      position?.x || 0,
      position?.y || this.#waterLevel + 10,
      position?.z || 0,
    );

    const hullMaterial = new StandardMaterial("hullMat", scene);
    hullMaterial.diffuseColor = new Color3(0.8, 0.6, 0.2);
    boatHull.material = hullMaterial;
    boatHull.isPickable = true;
    boatHull.renderingGroupId = 1;

    // Set to false to see the physics shape during debugging, true to hide it
    boatHull.isVisible = false;
    this.#boat = boatHull;

    ImportMeshAsync("models/boat-row-small.glb", scene)
      .then((result) => {
        const root = result.meshes[0];
        root.parent = this.#boat;
        root.position.y = -0.5;

        result.meshes.forEach((m) => {
          m.isPickable = true;
          m.renderingGroupId = 1;
          m.metadata = this.#boat.metadata;
        });
      })
      .catch((err) => {
        console.error("Model failed to load:", err);
      });
  }

  private setupBuoyancyPoints(): void {
    // Distributed points to ensure the boat stays level even with movement
    const y = -1.5;
    this.#buoyancyPoints = [
      new Vector3(-3, y, -3), // Front left
      new Vector3(3, y, -3), // Front right
      new Vector3(-3, y, 3), // Back left
      new Vector3(3, y, 3), // Back right
      new Vector3(0, y, 0), // Center
      new Vector3(-1.5, y, -1.5),
      new Vector3(1.5, y, -1.5),
      new Vector3(-1.5, y, 1.5),
      new Vector3(1.5, y, 1.5),
    ];
  }

  private setupAdvancedPhysics(scene: Scene): void {
    this.#physicsAggregate = new PhysicsAggregate(
      this.#boat,
      PhysicsShapeType.BOX,
      {
        mass: 10,
        restitution: 0.2,
        friction: 10,
      },
      scene,
    );

    scene.registerBeforeRender(() => {
      this.#submergedPoints = 0;
      const worldMatrix = this.#boat.getWorldMatrix();

      // Calculate total buoyancy force needed based on player count
      const totalBuoyancyMultiplier =
        this.#baseBuoyancyForce +
        this.#playersOnBoard.size * this.#playerWeightCompensation;

      // Check each buoyancy point for submersion
      this.#buoyancyPoints.forEach((localPoint) => {
        const worldPoint = Vector3.TransformCoordinates(
          localPoint,
          worldMatrix,
        );

        if (worldPoint.y < this.#waterLevel) {
          const submersion = this.#waterLevel - worldPoint.y;
          const buoyancyForce = submersion * totalBuoyancyMultiplier;

          this.#physicsAggregate.body.applyForce(
            new Vector3(0, buoyancyForce, 0),
            worldPoint,
          );

          this.#submergedPoints++;
        }
      });

      // Water Resistance (Drag)
      if (this.#submergedPoints > 0) {
        const velocity = this.#physicsAggregate.body.getLinearVelocity();
        const angularVelocity =
          this.#physicsAggregate.body.getAngularVelocity();

        // Linear dampening (slows forward/backward movement)
        this.#physicsAggregate.body.setLinearVelocity(velocity.scale(0.98));

        // Angular dampening (stops the boat from spinning infinitely)
        this.#physicsAggregate.body.setAngularVelocity(
          angularVelocity.scale(0.8),
        );
      }
    });
  }

  public addPlayer(player: Player): void {
    this.#playersOnBoard.add(player);
    console.log(`Player added. Total: ${this.#playersOnBoard.size}`);
  }

  public removePlayer(player: Player): void {
    this.#playersOnBoard.delete(player);
    console.log(`Player removed. Total: ${this.#playersOnBoard.size}`);
  }

  public get boatMesh(): Mesh {
    return this.#boat;
  }
  public get boatPosition(): Vector3 {
    return this.#boat.position.clone();
  }
  public get physicsAggregate(): PhysicsAggregate {
    return this.#physicsAggregate;
  }
  public get mount(): Mount {
    return this.#mount;
  }
  public get submergedPoints(): number {
    return this.#submergedPoints;
  }

  public getBoatTopY(): Vector3 {
    const boatBounds = this.#boat.getBoundingInfo();
    return new Vector3(
      this.#boat.position.x,
      boatBounds.boundingBox.maximumWorld.y,
      this.#boat.position.z,
    );
  }

  use(player: Player): void {
    this.#mount.mount(player);
  }
}
