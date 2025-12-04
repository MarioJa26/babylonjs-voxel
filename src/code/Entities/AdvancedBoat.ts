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
import { IUsable } from "../Inferface/IUsable";
import { Mount } from "./Mount";
import { MetadataContainer } from "./MetaDataContainer";
import { Player } from "../Player/Player";
import { PaddleBoatControls } from "../Player/Controls/PaddleBoatControls";

export class AdvancedBoat implements IUsable {
  #boat!: Mesh;
  #physicsAggregate!: PhysicsAggregate;
  #mount: Mount;
  #waterLevel = 2;
  #buoyancyPoints: Vector3[] = [];
  #playersOnBoard: Set<Player> = new Set();
  #baseBuoyancyForce = 20;
  #playerWeightCompensation = 14; // Extra buoyancy per player

  static #boatControls: PaddleBoatControls;

  #submergedPoints = 0;

  constructor(scene: Scene, player: Player, waterLevel: number) {
    this.createBoat(scene);
    this.#waterLevel = waterLevel;

    this.#boat.metadata = new MetadataContainer();
    this.#boat.metadata.add("use", (player: Player) => this.use(player));

    this.setupBuoyancyPoints();
    this.setupAdvancedPhysics(scene);
    AdvancedBoat.#boatControls = new PaddleBoatControls(this, player);

    this.#mount = new Mount(this.#boat, AdvancedBoat.#boatControls);
  }

  private createBoat(scene: Scene): void {
    const boatHull = MeshBuilder.CreateCylinder(
      "boatHull",
      {
        height: 1.2,
        diameterTop: 2.5,
        diameterBottom: 2,
        tessellation: 8,
      },
      scene
    );

    boatHull.scaling = new Vector3(1.3, 1.3, 3.5);
    boatHull.position = new Vector3(0, this.#waterLevel + 150, 0);

    const hullMaterial = new StandardMaterial("hullMat", scene);
    hullMaterial.diffuseColor = new Color3(0.8, 0.6, 0.2);
    boatHull.material = hullMaterial;
    boatHull.isPickable = true;

    this.#boat = boatHull;
  }

  private setupBuoyancyPoints(): void {
    // More buoyancy points for better stability with player weight
    this.#buoyancyPoints = [
      new Vector3(-1, -0.5, -2), // Front left
      new Vector3(1, -0.5, -2), // Front right
      new Vector3(-1, -0.5, 2), // Back left
      new Vector3(1, -0.5, 2), // Back right
      new Vector3(0, -0.5, 0), // Center
      new Vector3(-0.5, -0.5, -1),
      new Vector3(0.5, -0.5, -1),
      new Vector3(-0.5, -0.5, 1),
      new Vector3(0.5, -0.5, 1),
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
      scene
    );
    const worldMatrix = this.#boat.getWorldMatrix();
    scene.registerBeforeRender(() => {
      this.#submergedPoints = 0;

      // Calculate total buoyancy force needed
      const totalBuoyancyMultiplier =
        this.#baseBuoyancyForce +
        this.#playersOnBoard.size * this.#playerWeightCompensation;

      // Check each buoyancy point
      this.#buoyancyPoints.forEach((localPoint) => {
        const worldPoint = Vector3.TransformCoordinates(
          localPoint,
          worldMatrix
        );

        if (worldPoint.y < this.#waterLevel) {
          const submersion = this.#waterLevel - worldPoint.y;
          const buoyancyForce = submersion * totalBuoyancyMultiplier;

          this.#physicsAggregate.body.applyForce(
            new Vector3(0, buoyancyForce, 0),
            worldPoint
          );

          this.#submergedPoints++;
        }
      });

      // Add drag when in water
      if (this.#submergedPoints > 0) {
        const velocity = this.#physicsAggregate.body.getLinearVelocity();
        const angularVelocity =
          this.#physicsAggregate.body.getAngularVelocity();

        this.#physicsAggregate.body.setLinearVelocity(velocity.scale(0.98));

        this.#physicsAggregate.body.setAngularVelocity(
          angularVelocity.scale(0.8)
        );
      }
    });
  }

  // Method to register when player steps on boat
  public addPlayer(player: Player): void {
    this.#playersOnBoard.add(player);
    console.log(
      `Player added to boat. Total players: ${this.#playersOnBoard.size}`
    );
  }

  // Method to register when player leaves boat
  public removePlayer(player: Player): void {
    this.#playersOnBoard.delete(player);
    console.log(
      `Player removed from boat. Total players: ${this.#playersOnBoard.size}`
    );
  }

  // Get boat mesh for collision detection
  public get boatMesh(): Mesh {
    return this.#boat;
  }

  // Get boat position for player positioning
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

  // Get boat top surface Y position
  public getBoatTopY(): Vector3 {
    const boatBounds = this.#boat.getBoundingInfo();
    return new Vector3(
      this.#boat.position.x,
      boatBounds.boundingBox.maximumWorld.y,
      this.#boat.position.z
    );
  }

  use(player: Player): void {
    this.#mount.mount(player);
  }
}
