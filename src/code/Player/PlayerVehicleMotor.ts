import {
	Color3,
	type Mesh,
	MeshBuilder,
	Quaternion,
	type Scene,
	StandardMaterial,
	Vector3,
} from "@babylonjs/core";
import {
	Axis,
	VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import type { Mount } from "../Entities/Mount";
import { BlockType, isCollidableBlock } from "../World/BlockType";
import { ChunkLoadingSystem } from "../World/Chunk/ChunkLoadingSystem";
import type { PlayerBodyControlState, SavedBodyPosition } from "./PlayerBody";
import type { PlayerCamera } from "./PlayerCamera";
import {
	CharacterSupportedState,
	type CharacterSurfaceInfo,
	SimpleCharacterController,
} from "./SimpleCharacterController";

enum PlayerState {
	IN_AIR,
	ON_GROUND,
	START_JUMP,
}

type PlayerVehicleMotorOptions = {
	scene: Scene;
	camera: PlayerCamera;
	controls: PlayerBodyControlState;
	getMount: () => Mount | null;
};

export class PlayerVehicleMotor {
	readonly #scene: Scene;
	readonly #camera: PlayerCamera;
	readonly #controls: PlayerBodyControlState;
	readonly #getMount: () => Mount | null;

	#displayCapsule!: Mesh;
	#characterController!: SimpleCharacterController;
	#characterOrientation = Quaternion.Identity();
	#characterGravity = new Vector3(0, -18, 0);
	#movementLocked = false;
	#lockedPosition: Vector3 | null = null;
	readonly #zeroVelocity = Vector3.Zero();

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
	private readonly useVoxelCollision = true;
	private readonly colliderHalfWidth = 0.3;
	private readonly colliderHalfHeight = 0.875;
	private readonly voxelStepSize = 0.25;
	private readonly collisionEpsilon = 0.001;
	private readonly swimSpeed = 4.0;
	private readonly swimAcceleration = 14;
	private readonly swimSinkSpeed = -2.2;
	private readonly swimRiseSpeed = 3.2;
	private readonly swimVerticalAcceleration = 18;
	private readonly swimHorizontalDrag = 0.97;
	private readonly stepUpHeight = 2.01; // Maximum height (in blocks) to step up
	private readonly stepUpCooldown = 0.1; // Cooldown between step-ups in seconds
	private readonly voxelCollider: VoxelAabbCollider;
	private voxelPosition = new Vector3(0, 165, 0);
	private voxelVelocity = Vector3.Zero();
	private voxelIsGrounded = false;
	private lastStepUpTime = 0; // Cooldown to prevent multiple step-ups in quick succession

	constructor(options: PlayerVehicleMotorOptions) {
		this.#scene = options.scene;
		this.#camera = options.camera;
		this.#controls = options.controls;
		this.#getMount = options.getMount;

		this.voxelCollider = new VoxelAabbCollider(
			new Vector3(
				this.colliderHalfWidth,
				this.colliderHalfHeight,
				this.colliderHalfWidth,
			),
			(x, y, z) => {
				const blockId = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
				return isCollidableBlock(blockId);
			},
			this.collisionEpsilon,
			{
				scene: this.#scene,
				name: "playerAABB",
				position: this.voxelPosition,
				renderingGroupId: 1,
			},
		);

		this.initializeCharacter();
	}

	public get characterController(): SimpleCharacterController {
		return this.#characterController;
	}

	public get displayCapsule(): Mesh {
		return this.#displayCapsule;
	}

	public get isMovementLocked(): boolean {
		return this.#movementLocked;
	}

	private get inputDirection(): Vector3 {
		return this.#controls.inputDirection;
	}

	private get wantJump(): number {
		return this.#controls.wantJump;
	}

	private set wantJump(value: number) {
		this.#controls.wantJump = value;
	}

	private get isSprinting(): boolean {
		return this.#controls.isSprinting;
	}

	private get isFlying(): boolean {
		return this.#controls.isFlying;
	}

	private get isJumpHeld(): boolean {
		return this.#controls.isJumpHeld;
	}

	public updateCameraAndVisuals(): void {
		// Character orientation (only yaw affects horizontal rotation)
		this.#characterOrientation = Quaternion.RotationYawPitchRoll(
			this.#camera.cameraYaw,
			0,
			0,
		);

		this.#camera.moveWithPlayer(this.getPositionInternal());
		this.#displayCapsule.position.copyFrom(this.getPositionInternal());
	}

	public update(deltaTime: number): void {
		if (this.isJumpHeld) {
			this.wantJump = Math.max(this.wantJump, 1);
		}

		if (this.#movementLocked) {
			if (this.#lockedPosition) {
				this.voxelPosition.copyFrom(this.#lockedPosition);
				this.#characterController.setPosition(this.#lockedPosition);
			}
			this.voxelVelocity.copyFromFloats(0, 0, 0);
			this.#characterController.setVelocity(this.#zeroVelocity);
			this.voxelCollider.syncDebugMesh(this.voxelPosition);
			return;
		}

		const mount = this.#getMount();
		if (mount) {
			mount.update();
			if (this.useVoxelCollision) {
				this.voxelPosition.copyFrom(this.#characterController.getPosition());
				this.voxelVelocity.copyFromFloats(0, 0, 0);
			}
		} else {
			if (this.isFlying) {
				const desiredVelocity = this.calculateFlyingVelocity(deltaTime);
				this.setVelocityInternal(desiredVelocity);
				if (this.useVoxelCollision) {
					const next = this.voxelPosition.add(desiredVelocity.scale(deltaTime));
					this.voxelPosition.copyFrom(next);
					this.#characterController.setPosition(this.voxelPosition);
					this.#characterController.setVelocity(this.#zeroVelocity);
				} else {
					this.#characterController.setVelocity(desiredVelocity);
				}
				this.voxelCollider.syncDebugMesh(this.voxelPosition);
				return;
			}
			this.integrateMovement(deltaTime);
		}

		if (this.useVoxelCollision) {
			this.voxelCollider.syncDebugMesh(this.voxelPosition);
		}
	}

	public lockMovementAtCurrentPosition(): void {
		this.#lockedPosition = this.getPositionInternal().clone();
		this.#movementLocked = true;
		this.voxelPosition.copyFrom(this.#lockedPosition);
		this.#characterController.setPosition(this.#lockedPosition);
		this.#characterController.setVelocity(this.#zeroVelocity);
		this.#camera.moveWithPlayer(this.#lockedPosition);
		this.#displayCapsule.position.copyFrom(this.#lockedPosition);
		this.voxelCollider.syncDebugMesh(this.voxelPosition);
	}

	public unlockMovement(): void {
		this.#movementLocked = false;
		this.#lockedPosition = null;
		this.voxelVelocity.copyFromFloats(0, 0, 0);
		this.#characterController.setVelocity(this.#zeroVelocity);
	}

	public getSavedPosition(): SavedBodyPosition {
		const position = this.getPositionInternal();
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

		const restoredPosition = new Vector3(
			position.x,
			position.y < -1000 ? 32 : position.y,
			position.z,
		);
		this.voxelPosition.copyFrom(restoredPosition);
		this.voxelVelocity.copyFromFloats(0, 0, 0);
		this.#characterController.setPosition(restoredPosition);
		if (this.#movementLocked) {
			this.#lockedPosition = restoredPosition.clone();
		}
		this.#camera.moveWithPlayer(restoredPosition);
		this.#displayCapsule.position.copyFrom(restoredPosition);
		this.voxelCollider.syncDebugMesh(this.voxelPosition);
		return true;
	}

	private initializeCharacter(): void {
		const height = 1.75;
		const width = 0.6;
		this.#displayCapsule = this.createCharacterMesh(height, width);

		const startPosition = new Vector3(0, 165, 0);
		this.#characterController = new SimpleCharacterController(startPosition);

		this.configureCharacterController();
		this.voxelPosition.copyFrom(startPosition);
		this.voxelVelocity.copyFromFloats(0, 0, 0);
		this.voxelCollider.syncDebugMesh(this.voxelPosition);
		this.#camera.target = startPosition;
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
			this.#scene,
		);

		const material = new StandardMaterial("box", this.#scene);
		material.diffuseColor = new Color3(0.2, 0.9, 0.8);
		box.material = material;
		box.isPickable = false;
		box.renderingGroupId = 1;

		return box;
	}

	private integrateMovement(deltaTime: number): void {
		if (this.useVoxelCollision) {
			this.integrateVoxelMovement(deltaTime);
			return;
		}
		if (deltaTime <= 1 / 60) {
			this.integrateMovementStep(deltaTime);
			return;
		}

		const targetSubStep = 1 / 120;
		const maxSubSteps = 8;
		const subSteps = Math.min(
			maxSubSteps,
			Math.ceil(deltaTime / targetSubStep),
		);
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
		const flySpeed = this.onGroundSpeed * 112.5;
		const desiredVelocity = this.getInputVelocity(flySpeed);

		if (this.wantJump > 0) {
			desiredVelocity.addInPlace(upWorld.scale(flySpeed));
		}
		if (this.isSprinting) {
			desiredVelocity.addInPlace(upWorld.scale(-flySpeed));
		}

		const currentVelocity = this.getVelocityInternal();
		let newVelocity = currentVelocity.clone();
		if (desiredVelocity.lengthSquared() < 0.01) {
			newVelocity.scaleInPlace(this.deacceleration);
		} else {
			newVelocity = this.accelerate(
				currentVelocity,
				desiredVelocity,
				this.accelRateGround,
				deltaTime,
			);
		}

		return newVelocity;
	}

	private calculateDesiredVelocity(
		deltaTime: number,
		supportInfo: CharacterSurfaceInfo,
	): Vector3 {
		const previousState = this.state;
		this.updatePlayerState(supportInfo);
		const currentVelocity = this.getVelocityInternal();

		switch (this.state) {
			case PlayerState.IN_AIR:
				return this.calculateInAirVelocity(deltaTime, currentVelocity);
			case PlayerState.ON_GROUND:
				return this.calculateOnGroundVelocity(currentVelocity, supportInfo);
			case PlayerState.START_JUMP:
				return this.calculateJumpVelocity(currentVelocity, previousState);
			default:
				return currentVelocity;
		}
	}

	private updatePlayerState(supportInfo: CharacterSurfaceInfo): void {
		this.state = this.determineNextState(supportInfo);
	}

	private determineNextState(supportInfo: CharacterSurfaceInfo): PlayerState {
		const isSupported =
			supportInfo.supportedState === CharacterSupportedState.SUPPORTED;

		switch (this.state) {
			case PlayerState.IN_AIR:
				if (isSupported) {
					return PlayerState.ON_GROUND;
				}
				if (this.wantJump > 0) {
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

	private calculateInAirVelocity(
		deltaTime: number,
		currentVelocity: Vector3,
	): Vector3 {
		const upWorld = this.getUpVector();
		const outputVelocity = currentVelocity.clone();

		outputVelocity.addInPlace(upWorld.scale(-outputVelocity.dot(upWorld)));
		outputVelocity.addInPlace(upWorld.scale(currentVelocity.dot(upWorld)));
		outputVelocity.addInPlace(this.#characterGravity.scale(deltaTime));

		return outputVelocity;
	}

	private calculateOnGroundVelocity(
		currentVelocity: Vector3,
		supportInfo: CharacterSurfaceInfo,
	): Vector3 {
		const upWorld = this.getUpVector();

		const desiredVelocity = this.getInputVelocity(this.onGroundSpeed);

		if (
			this.isSprinting &&
			(this.inputDirection.x !== 0 || this.inputDirection.z !== 0)
		) {
			desiredVelocity.scaleInPlace(this.sprintMultiplier);
		}

		return this.applyHorizontalProjectionCorrection(
			currentVelocity.clone(),
			supportInfo,
			upWorld,
		);
	}

	private applyHorizontalProjectionCorrection(
		velocity: Vector3,
		supportInfo: CharacterSurfaceInfo,
		upWorld: Vector3,
	): Vector3 {
		const v = velocity.subtract(supportInfo.averageSurfaceVelocity);
		const n = supportInfo.averageSurfaceNormal;
		if (n.dot(upWorld) < this.minFloorNormalDot) {
			return velocity;
		}

		const vDotN = v.dot(n);
		const vTangent = v.subtract(n.scale(vDotN));
		vTangent.addInPlace(n.scale(this.penetrationRecoveryEps));
		return vTangent.addInPlace(supportInfo.averageSurfaceVelocity);
	}

	private calculateJumpVelocity(
		currentVelocity: Vector3,
		previousState: PlayerState,
	): Vector3 {
		const upWorld = this.getUpVector();
		const verticalJumpVelocity = this.calculateVerticalJumpVelocity(
			currentVelocity,
			upWorld,
		);

		const horizontalVelocity = this.getInputVelocity(this.onGroundSpeed);
		if (this.isSprinting) {
			horizontalVelocity.scaleInPlace(this.sprintMultiplier);
		}

		const finalVelocity = upWorld
			.scale(verticalJumpVelocity)
			.add(horizontalVelocity);

		if (previousState === PlayerState.IN_AIR) {
			const viewDirection = this.#camera.playerCamera.getForwardRay().direction;
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
		// Cap jump vertical speed so repeated jumps don't stack extra upward velocity.
		return Math.max(jumpSpeed, currentUpwardVelocity);
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
		if (delta.length() < 0.1) {
			return current.clone();
		}
		const change = delta
			.normalize()
			.scale(Math.min(delta.length(), maxAccel * dt));
		return current.add(change);
	}

	private getUpVector(): Vector3 {
		return this.#characterGravity.normalizeToNew().scaleInPlace(-1.0);
	}

	private isValidSavedPosition(
		position: unknown,
	): position is SavedBodyPosition {
		if (!position || typeof position !== "object") {
			return false;
		}

		const candidate = position as Partial<SavedBodyPosition>;
		return (
			Number.isFinite(candidate.x) &&
			Number.isFinite(candidate.y) &&
			Number.isFinite(candidate.z)
		);
	}

	private getPositionInternal(): Vector3 {
		return this.useVoxelCollision
			? this.voxelPosition
			: this.#characterController.getPosition();
	}

	private getVelocityInternal(): Vector3 {
		return this.useVoxelCollision
			? this.voxelVelocity
			: this.#characterController.getVelocity();
	}

	private setVelocityInternal(velocity: Vector3): void {
		if (this.useVoxelCollision) {
			this.voxelVelocity.copyFrom(velocity);
			return;
		}
		this.#characterController.setVelocity(velocity);
	}

	private integrateVoxelMovement(deltaTime: number): void {
		if (deltaTime <= 1 / 60) {
			this.integrateVoxelMovementStep(deltaTime);
			return;
		}

		const targetSubStep = 1 / 120;
		const maxSubSteps = 8;
		const subSteps = Math.min(
			maxSubSteps,
			Math.ceil(deltaTime / targetSubStep),
		);
		const stepDt = deltaTime / subSteps;
		for (let i = 0; i < subSteps; i++) {
			this.integrateVoxelMovementStep(stepDt);
		}
	}

	private integrateVoxelMovementStep(deltaTime: number): void {
		const isInWater = this.isInWater();
		const desiredVelocity = this.getInputVelocity(
			isInWater
				? this.swimSpeed
				: this.voxelIsGrounded
					? this.onGroundSpeed
					: this.inAirSpeed,
		);

		if (
			this.isSprinting &&
			!isInWater &&
			this.voxelIsGrounded &&
			(this.inputDirection.x !== 0 || this.inputDirection.z !== 0)
		) {
			desiredVelocity.scaleInPlace(this.sprintMultiplier);
		}

		const currentHorizontal = new Vector3(
			this.voxelVelocity.x,
			0,
			this.voxelVelocity.z,
		);
		const targetHorizontal = new Vector3(
			desiredVelocity.x,
			0,
			desiredVelocity.z,
		);
		const accelRate = isInWater
			? this.swimAcceleration
			: this.voxelIsGrounded
				? this.accelRateGround
				: this.accelRateGround * 0.5;
		const nextHorizontal = this.accelerate(
			currentHorizontal,
			targetHorizontal,
			accelRate,
			deltaTime,
		);
		this.voxelVelocity.x = nextHorizontal.x;
		this.voxelVelocity.z = nextHorizontal.z;

		if (
			!isInWater &&
			this.voxelIsGrounded &&
			this.inputDirection.x === 0 &&
			this.inputDirection.z === 0
		) {
			this.voxelVelocity.x *= this.deacceleration;
			this.voxelVelocity.z *= this.deacceleration;
		}

		if (isInWater) {
			const wantsToRise = this.isJumpHeld || this.wantJump > 0;
			const targetVerticalVelocity = wantsToRise
				? this.swimRiseSpeed
				: this.swimSinkSpeed;
			const verticalDelta = targetVerticalVelocity - this.voxelVelocity.y;
			const maxVerticalStep = this.swimVerticalAcceleration * deltaTime;
			const clampedVerticalStep = Math.max(
				-maxVerticalStep,
				Math.min(verticalDelta, maxVerticalStep),
			);
			this.voxelVelocity.y += clampedVerticalStep;
			this.voxelVelocity.y *= this.swimHorizontalDrag;
			this.voxelVelocity.x *= this.swimHorizontalDrag;
			this.voxelVelocity.z *= this.swimHorizontalDrag;
			this.wantJump = 0;
		} else {
			if (this.wantJump > 0 && this.voxelIsGrounded) {
				this.wantJump--;
				this.voxelVelocity.y = this.calculateVerticalJumpVelocity(
					this.voxelVelocity,
					this.getUpVector(),
				);
				this.voxelIsGrounded = false;
			}

			this.voxelVelocity.y += this.#characterGravity.y * deltaTime;
		}

		this.moveVoxelAxis(Axis.X, this.voxelVelocity.x * deltaTime);
		this.moveVoxelAxis(Axis.Y, this.voxelVelocity.y * deltaTime);
		this.moveVoxelAxis(Axis.Z, this.voxelVelocity.z * deltaTime);

		this.#characterController.setPosition(this.voxelPosition);
		this.#characterController.setVelocity(this.#zeroVelocity);

		this.voxelIsGrounded = this.checkVoxelGrounded();
		if (this.voxelIsGrounded && this.voxelVelocity.y < 0) {
			this.voxelVelocity.y = 0;
		}
	}

	private moveVoxelAxis(axis: Axis, delta: number): void {
		if (axis === Axis.Y) {
			// Handle Y axis normally
			this.voxelCollider.moveAxis(
				this.voxelPosition,
				this.voxelVelocity,
				axis,
				delta,
				this.voxelStepSize,
			);
			return;
		}

		// For horizontal movement, try step-up first
		if (
			this.voxelIsGrounded &&
			(this.inputDirection.x !== 0 || this.inputDirection.z !== 0) &&
			Date.now() - this.lastStepUpTime > this.stepUpCooldown * 1000
		) {
			// Save current position
			const prevPosition = this.voxelPosition.clone();

			// Try to step up
			if (this.attemptStepUp(axis, delta)) {
				return; // Step up succeeded
			}

			// Step up failed, restore position and try normal movement
			this.voxelPosition.copyFrom(prevPosition);
		}

		// Normal horizontal movement
		this.voxelCollider.moveAxis(
			this.voxelPosition,
			this.voxelVelocity,
			axis,
			delta,
			this.voxelStepSize,
		);
	}

	private attemptStepUp(axis: Axis.X | Axis.Z, delta: number): boolean {
		const testPosition = this.voxelPosition.clone();

		// First, try moving forward at current height
		if (axis === Axis.X) {
			testPosition.x += delta;
		} else {
			testPosition.z += delta;
		}

		// If blocked at current height, try stepping up
		if (this.overlapsSolidVoxel(testPosition)) {
			// Try stepping up in increments
			for (let step = 0.25; step <= this.stepUpHeight; step += 0.25) {
				const upPosition = this.voxelPosition.clone();
				upPosition.y += step;

				// Check if there's space to step up to
				if (!this.overlapsSolidVoxel(upPosition)) {
					// Now try moving forward from this higher position
					const upAndForward = upPosition.clone();
					if (axis === Axis.X) {
						upAndForward.x += delta;
					} else {
						upAndForward.z += delta;
					}

					// Check if forward movement is possible
					if (!this.overlapsSolidVoxel(upAndForward)) {
						// Check if there's ground below the new position
						const groundCheck = upAndForward.clone();
						groundCheck.y -= 0.01; // Small probe downward

						if (this.overlapsSolidVoxel(groundCheck)) {
							// Valid step up position found!
							this.voxelPosition.copyFrom(upAndForward);
							this.voxelVelocity.y = 0;
							this.lastStepUpTime = Date.now();
							return true;
						}
					}
				}
			}
		} else {
			// Movement succeeded without stepping
			this.voxelPosition.copyFrom(testPosition);
			return true;
		}

		return false;
	}

	private overlapsSolidVoxel(position: Vector3): boolean {
		return this.voxelCollider.overlaps(position);
	}

	private checkVoxelGrounded(): boolean {
		const probe = this.voxelPosition.clone();
		probe.y -= 0.06;
		return this.overlapsSolidVoxel(probe);
	}

	private isInWater(): boolean {
		const pos = this.voxelPosition;
		const radius = this.colliderHalfWidth * 0.9;
		const ySamples = [
			-this.colliderHalfHeight + 0.12,
			-this.colliderHalfHeight * 0.2,
			this.colliderHalfHeight * 0.2,
		];
		const xzSamples = [
			[0, 0],
			[radius, 0],
			[-radius, 0],
			[0, radius],
			[0, -radius],
		];

		for (const yOffset of ySamples) {
			const y = pos.y + yOffset;
			for (const [xOffset, zOffset] of xzSamples) {
				const blockId = ChunkLoadingSystem.getBlockByWorldCoords(
					pos.x + xOffset,
					y,
					pos.z + zOffset,
				);
				if (blockId === BlockType.Water) {
					return true;
				}
			}
		}

		return false;
	}
}
