import {
  CharacterSupportedState,
  CharacterSurfaceInfo,
  Color3,
  Mesh,
  MeshBuilder,
  PhysicsCharacterController,
  PhysicsShapeCapsule,
  Quaternion,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";

import { Mount } from "../Entities/Mount";
import { PlayerCamera } from "./PlayerCamera";

enum PlayerState {
  IN_AIR = "IN_AIR",
  ON_GROUND = "ON_GROUND",
  START_JUMP = "START_JUMP",
}

export type SavedPlayerPosition = {
  x: number;
  y: number;
  z: number;
};

export class PlayerVehicle {
  public scene: Scene;
  public camera: PlayerCamera;

  public inputDirection = new Vector3(0, 0, 0);
  public wantJump = 0;
  public isSprinting = false;
  public isFlying = false;
  public isMounted = false;
  public DASH = true;

  #displayCapsule!: Mesh;
  #characterController!: PhysicsCharacterController;
  readonly #forwardLocalSpace = new Vector3(0, 0, 1);
  #characterOrientation = Quaternion.Identity();
  #characterGravity = new Vector3(0, -18, 0);
  #movementLocked = false;
  #lockedPosition: Vector3 | null = null;
  readonly #zeroVelocity = Vector3.Zero();
  public mount!: Mount | null;

  private state: PlayerState = PlayerState.IN_AIR;

  // Movement parameters
  private readonly deacceleration = 0.85;
  private readonly inAirSpeed = 7.0;
  private readonly onGroundSpeed = 5.0;
  private readonly jumpHeight = 0.35;
  private readonly accelRateGround = 36;
  private readonly sprintMultiplier = 1.6;
  private readonly penetrationRecoveryEps = 0.0001;
  private readonly airJumpForwardBoost = 5.5;
  private readonly minFloorNormalDot = 0.55;

  constructor(scene: Scene, camera: PlayerCamera) {
    this.scene = scene;
    this.camera = camera;
    this.initializeCharacter();
  }

  public toggleFlying(): void {
    this.isFlying = !this.isFlying;
  }

  private initializeCharacter(): void {
    // Create visual representation
    const height = 1.75;
    const width = 0.6;
    this.#displayCapsule = this.createCharacterMesh(height, width);

    // Create physics controller
    const startPosition = new Vector3(-7000, 165, 2400);
    const radius = width * 0.5;
    const halfSegment = Math.max(0.01, (height - 2 * radius) * 0.5);
    const characterShape = new PhysicsShapeCapsule(
      new Vector3(0, -halfSegment, 0),
      new Vector3(0, halfSegment, 0),
      radius,
      this.scene,
    );

    this.#characterController = new PhysicsCharacterController(
      startPosition,
      { shape: characterShape },
      this.scene,
    );
    this.configureCharacterController();

    this.camera.target = startPosition;
  }

  private configureCharacterController(): void {
    this.#characterController.keepDistance = 0.08;
    this.#characterController.keepContactTolerance = 0.12;
    this.#characterController.maxCastIterations = 20;
    this.#characterController.penetrationRecoverySpeed = 3.0;
    this.#characterController.maxSlopeCosine = Math.cos((50 * Math.PI) / 180);
  }

  private createCharacterMesh(height: number, width: number): Mesh {
    const box = MeshBuilder.CreateBox(
      "CharacterDisplay",
      { width: width, height: height, depth: width },
      this.scene,
    );

    const material = new StandardMaterial("box", this.scene);
    material.diffuseColor = new Color3(0.2, 0.9, 0.8);
    box.material = material;
    box.isPickable = false;
    box.renderingGroupId = 1;

    return box;
  }

  public updateCameraAndVisuals(): void {
    // Character orientation (only yaw affects horizontal rotation)
    this.#characterOrientation = Quaternion.RotationYawPitchRoll(
      this.camera.cameraYaw,
      0,
      0,
    );

    this.camera.moveWithPlayer(this.#characterController.getPosition());

    this.#displayCapsule.position.copyFrom(
      this.#characterController.getPosition(),
    );
  }
  /**
   * Main update function called every frame
   * @param deltaTime Time since last frame in seconds
   */
  public update(deltaTime: number): void {
    if (this.#movementLocked) {
      if (this.#lockedPosition) {
        this.#characterController.setPosition(this.#lockedPosition);
      }
      this.#characterController.setVelocity(this.#zeroVelocity);
      return;
    }

    if (this.mount) {
      this.mount.update();
    } else {
      if (this.isFlying) {
        const desiredVelocity = this.calculateFlyingVelocity(deltaTime);
        this.#characterController.setVelocity(desiredVelocity);
        return; // Skip normal physics integration
      }
      this.integrateMovement(deltaTime);
    }
  }

  private integrateMovement(deltaTime: number): void {
    if (deltaTime <= 1 / 60) {
      this.integrateMovementStep(deltaTime);
      return;
    }

    const targetSubStep = 1 / 120;
    const maxSubSteps = 8;
    const subSteps = Math.min(maxSubSteps, Math.ceil(deltaTime / targetSubStep));
    const stepDt = deltaTime / subSteps;

    for (let i = 0; i < subSteps; i++) {
      this.integrateMovementStep(stepDt);
    }
  }

  private integrateMovementStep(deltaTime: number): void {
    const support = this.#characterController.checkSupport(
      deltaTime,
      new Vector3(0, -1, 0),
    );
    const desiredVelocity = this.calculateDesiredVelocity(deltaTime, support);

    this.#characterController.setVelocity(desiredVelocity);
    this.#characterController.integrate(
      deltaTime,
      support,
      this.#characterGravity,
    );
  }
  private calculateFlyingVelocity(deltaTime: number): Vector3 {
    const upWorld = this.getUpVector();
    const flySpeed = this.onGroundSpeed * 112.5; // Use a dedicated fly speed
    const desiredVelocity = this.getInputVelocity(flySpeed);

    // Vertical movement
    if (this.wantJump > 0) {
      // Ascend
      desiredVelocity.addInPlace(upWorld.scale(flySpeed));
    }
    if (this.isSprinting) {
      // Descend
      desiredVelocity.addInPlace(upWorld.scale(-flySpeed));
    }

    // Apply deceleration
    const currentVelocity = this.#characterController.getVelocity();
    let newVelocity = currentVelocity.clone();
    if (desiredVelocity.lengthSquared() < 0.01) {
      newVelocity.scaleInPlace(this.deacceleration);
    } else {
      // Accelerate towards desired velocity
      newVelocity = this.accelerate(
        currentVelocity,
        desiredVelocity,
        this.accelRateGround, // Can use a different accel rate for flying if desired
        deltaTime,
      );
    }

    return newVelocity;
  }

  private calculateDesiredVelocity(
    deltaTime: number,
    supportInfo: CharacterSurfaceInfo,
  ): Vector3 {
    // Update player state based on support info
    const previousState = this.state;
    this.updatePlayerState(supportInfo);

    // Get current velocity
    const currentVelocity = this.#characterController.getVelocity();

    // Calculate desired velocity based on current state
    switch (this.state) {
      case PlayerState.IN_AIR:
        return this.calculateInAirVelocity(deltaTime, currentVelocity);
      case PlayerState.ON_GROUND:
        return this.calculateOnGroundVelocity(
          deltaTime,
          currentVelocity,
          supportInfo,
        );
      case PlayerState.START_JUMP:
        return this.calculateJumpVelocity(currentVelocity, previousState);
      default:
        return currentVelocity;
    }
  }

  /**
   * Update the player's state based on support information
   */
  private updatePlayerState(supportInfo: CharacterSurfaceInfo): void {
    this.state = this.determineNextState(supportInfo);
  }

  /**
   * Determine the next state based on current state and support info
   */
  private determineNextState(supportInfo: CharacterSurfaceInfo): PlayerState {
    const isSupported =
      supportInfo.supportedState === CharacterSupportedState.SUPPORTED;

    switch (this.state) {
      case PlayerState.IN_AIR:
        if (isSupported) {
          return PlayerState.ON_GROUND;
        }
        if (this.wantJump > 0 && this.DASH) {
          return PlayerState.START_JUMP;
        }
        return PlayerState.IN_AIR;

      case PlayerState.ON_GROUND:
        if (!isSupported) {
          return PlayerState.IN_AIR;
        }
        if (this.wantJump > 0) {
          this.wantJump--;
          return PlayerState.START_JUMP;
        }
        return PlayerState.ON_GROUND;

      case PlayerState.START_JUMP:
        return PlayerState.IN_AIR;

      default:
        return this.state;
    }
  }

  /**
   * Calculate velocity when in air
   */
  private calculateInAirVelocity(
    deltaTime: number,
    currentVelocity: Vector3,
  ): Vector3 {
    const upWorld = this.getUpVector();
    const forwardWorld = this.getForwardVector();

    // Calculate desired movement direction
    const desiredVelocity = this.getInputVelocity(this.inAirSpeed);

    // Calculate movement with physics
    const outputVelocity = this.#characterController.calculateMovement(
      deltaTime,
      forwardWorld,
      upWorld,
      currentVelocity,
      Vector3.ZeroReadOnly,
      desiredVelocity,
      upWorld,
    );

    // Remove vertical component and add back current vertical velocity
    outputVelocity.addInPlace(upWorld.scale(-outputVelocity.dot(upWorld)));
    outputVelocity.addInPlace(upWorld.scale(currentVelocity.dot(upWorld)));

    // Apply gravity
    outputVelocity.addInPlace(this.#characterGravity.scale(deltaTime));

    return outputVelocity;
  }

  /**
   * Calculate velocity when on ground
   */
  private calculateOnGroundVelocity(
    deltaTime: number,
    currentVelocity: Vector3,
    supportInfo: CharacterSurfaceInfo,
  ): Vector3 {
    const upWorld = this.getUpVector();
    const forwardWorld = this.getForwardVector();
    const surfaceNormal = supportInfo.averageSurfaceNormal;
    const floorNormal =
      surfaceNormal.dot(upWorld) >= this.minFloorNormalDot
        ? surfaceNormal
        : upWorld;

    // Calculate desired velocity based on input
    const desiredVelocity = this.getInputVelocity(this.onGroundSpeed);

    // Apply sprint multiplier if sprinting
    if (
      this.isSprinting &&
      (this.inputDirection.x !== 0 || this.inputDirection.z !== 0)
    ) {
      desiredVelocity.scaleInPlace(this.sprintMultiplier);
    }

    // Apply deceleration if no input
    let newVelocity = currentVelocity.clone();
    if (this.inputDirection.x === 0 && this.inputDirection.z === 0) {
      if (currentVelocity.length() < 0.2) {
        newVelocity.x = 0;
        newVelocity.z = 0;
      } else {
        newVelocity.x *= this.deacceleration;
        newVelocity.z *= this.deacceleration;
      }
    } else {
      // Accelerate towards desired velocity
      newVelocity = this.accelerate(
        currentVelocity,
        desiredVelocity,
        this.accelRateGround,
        deltaTime,
      );
    }

    // Calculate movement with physics
    let outputVelocity = this.#characterController.calculateMovement(
      deltaTime,
      forwardWorld,
      floorNormal,
      newVelocity,
      supportInfo.averageSurfaceVelocity,
      desiredVelocity,
      upWorld,
    );

    outputVelocity = this.applyHorizontalProjectionCorrection(
      outputVelocity,
      supportInfo,
      upWorld,
    );

    return outputVelocity;
  }
  // tiny push-away to help penetration recovery (avoid sticking)
  private applyHorizontalProjectionCorrection(
    velocity: Vector3,
    supportInfo: CharacterSurfaceInfo,
    upWorld: Vector3,
  ): Vector3 {
    // Remove surface velocity
    const v = velocity.subtract(supportInfo.averageSurfaceVelocity);
    const n = supportInfo.averageSurfaceNormal;
    if (n.dot(upWorld) < this.minFloorNormalDot) {
      return velocity;
    }

    // Project onto tangent plane: v_tangent = v - (v·n)n
    const vDotN = v.dot(n);
    const vTangent = v.subtract(n.scale(vDotN));

    // Add small push-away to recover from penetration
    vTangent.addInPlace(n.scale(this.penetrationRecoveryEps));

    // Reapply surface velocity
    return vTangent.addInPlace(supportInfo.averageSurfaceVelocity);
  }

  private calculateJumpVelocity(
    currentVelocity: Vector3,
    previousState: PlayerState,
  ): Vector3 {
    const upWorld = this.getUpVector();

    // Calculate vertical jump component
    const verticalJumpVelocity = this.calculateVerticalJumpVelocity(
      currentVelocity,
      upWorld,
    );

    // Calculate horizontal movement component
    const horizontalVelocity = this.getInputVelocity(this.onGroundSpeed);
    if (this.isSprinting) {
      horizontalVelocity.scaleInPlace(this.sprintMultiplier);
    }

    // Combine vertical + horizontal
    const finalVelocity = upWorld
      .scale(verticalJumpVelocity)
      .add(horizontalVelocity);

    // Air-jump boost: add forward momentum from camera direction
    if (previousState === PlayerState.IN_AIR) {
      const viewDirection = this.camera.playerCamera.getForwardRay().direction;
      finalVelocity.addInPlace(
        viewDirection
          .normalize()
          .scale(this.inAirSpeed * this.airJumpForwardBoost),
      );
    }

    return finalVelocity;
  }

  private calculateVerticalJumpVelocity(
    currentVelocity: Vector3,
    upWorld: Vector3,
  ): number {
    const jumpSpeed = this.#characterGravity.length() * this.jumpHeight;
    const currentUpwardVelocity = currentVelocity.dot(upWorld);
    return Math.max(jumpSpeed, currentUpwardVelocity + jumpSpeed);
  }

  private getInputVelocity(speed: number): Vector3 {
    return this.inputDirection
      .scale(speed)
      .applyRotationQuaternion(this.#characterOrientation);
  }
  private accelerate(
    current: Vector3,
    target: Vector3,
    maxAccel: number,
    dt: number,
  ): Vector3 {
    const delta = target.subtract(current);

    if (delta.length() < 1) {
      return current.clone();
    }

    const change = delta
      .normalize()
      .scale(Math.min(delta.length(), maxAccel * dt));

    return current.add(change);
  }
  public get characterController(): PhysicsCharacterController {
    return this.#characterController;
  }

  public get displayCapsule(): Mesh {
    return this.#displayCapsule;
  }
  private getUpVector(): Vector3 {
    return this.#characterGravity.normalizeToNew().scaleInPlace(-1.0);
  }

  private getForwardVector(): Vector3 {
    return this.#forwardLocalSpace.applyRotationQuaternion(
      this.#characterOrientation,
    );
  }

  setMount(mount: Mount): void {
    this.mount = mount;
  }

  public lockMovementAtCurrentPosition(): void {
    this.#lockedPosition = this.#characterController.getPosition().clone();
    this.#movementLocked = true;
    this.#characterController.setPosition(this.#lockedPosition);
    this.#characterController.setVelocity(this.#zeroVelocity);
    this.camera.moveWithPlayer(this.#lockedPosition);
    this.#displayCapsule.position.copyFrom(this.#lockedPosition);
  }

  public unlockMovement(): void {
    this.#movementLocked = false;
    this.#lockedPosition = null;
    this.#characterController.setVelocity(this.#zeroVelocity);
  }

  public get isMovementLocked(): boolean {
    return this.#movementLocked;
  }

  public getSavedPosition(): SavedPlayerPosition {
    const position = this.#characterController.getPosition();
    return {
      x: position.x,
      y: position.y,
      z: position.z,
    };
  }

  public restoreSavedPosition(position: unknown): boolean {
    if (!this.isValidSavedPosition(position)) {
      return false;
    }

    const restoredPosition = new Vector3(position.x, position.y, position.z);
    this.#characterController.setPosition(restoredPosition);
    if (this.#movementLocked) {
      this.#lockedPosition = restoredPosition.clone();
    }
    this.camera.moveWithPlayer(restoredPosition);
    this.#displayCapsule.position.copyFrom(restoredPosition);
    return true;
  }

  private isValidSavedPosition(position: unknown): position is SavedPlayerPosition {
    if (!position || typeof position !== "object") {
      return false;
    }

    const candidate = position as Partial<SavedPlayerPosition>;
    return (
      Number.isFinite(candidate.x) &&
      Number.isFinite(candidate.y) &&
      Number.isFinite(candidate.z)
    );
  }
}
