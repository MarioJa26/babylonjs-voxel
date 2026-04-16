import { Quaternion, type TransformNode, Vector3 } from "@babylonjs/core";
import type { IControls } from "../Inferface/IControls";
import type { IMountable } from "../Inferface/IMountable";
import { Player } from "../Player/Player";
import type { IPlayerBody } from "../Player/PlayerBody";
import type MountOptions from "./MountOptions";

export class Mount implements IMountable {
	public user: Player | null = null;
	public vehicle: TransformNode;
	#keyBoardControls: IControls<unknown>;

	// Mount position and rotation offset relative to vehicle
	#mountOffset: Vector3;
	#mountRotationOffset: Quaternion;

	// Track if physics is disabled
	#physicsDisabled = false;

	constructor(
		vehicle: TransformNode,
		keyBoardControls: IControls<unknown>,
		options: MountOptions = {},
	) {
		this.vehicle = vehicle;
		this.#keyBoardControls = keyBoardControls;
		this.#mountOffset = options.mountOffset ?? new Vector3(0, 0.9, 0);
		this.#mountRotationOffset =
			options.mountRotationOffset ?? Quaternion.Identity();
	}

	isMounted(): boolean {
		return this.user !== null;
	}

	/**
	 * Mount a user to the vehicle
	 * @param user The user to mount (currently only Player is supported)
	 * @returns True if mounting was successful, false otherwise
	 */
	mount(user: unknown): boolean {
		if (user instanceof Player) {
			return this.#mountVehicle(user as Player);
		}
		return false;
	}

	dismount(): boolean {
		if (!this.user) return false;

		const player = this.user;
		const vehicle = player.playerVehicle;

		//Prevent stuck keys on remount
		player.keyboardControls.pressedKeys.clear();
		player.keyboardControls = player.defaultKeyboardControls;
		vehicle.clearControlState();

		if (this.#physicsDisabled && vehicle.characterController) {
			this.enablePlayerPhysics(vehicle);
		}

		vehicle.displayCapsule.setParent(null);

		this.user = null;
		this.#physicsDisabled = false;

		return true;
	}

	getMountedUser(): Player | null {
		return this.user;
	}

	getKeyBoardControls(): IControls<unknown> {
		return this.#keyBoardControls;
	}

	setMountOffset(offset: Vector3): void {
		this.#mountOffset = offset;

		// Update position if someone is mounted
		if (this.user) {
			this.updateMountedPosition();
		}
	}

	setMountRotationOffset(rotationOffset: Quaternion): void {
		this.#mountRotationOffset = rotationOffset;

		// Update position if someone is mounted
		if (this.user) {
			this.updateMountedPosition();
		}
	}

	/**
	 * Update the vehicle's position and rotation
	 * This should be called in the vehicle's update loop
	 */
	update(): void {
		if (this.user && this.#physicsDisabled) {
			this.updateMountedPosition();
		}
	}

	/**
	 * Mount a player to the vehicle
	 * @param player The player to mount
	 * @returns True if mounting was successful, false otherwise
	 */
	#mountVehicle(player: Player): boolean {
		if (this.user) {
			if (this.user === player) this.dismount();
			return false;
		}

		this.user = player;
		this.user.keyboardControls = this.#keyBoardControls;
		player.playerVehicle.mount = this;

		this.disablePlayerPhysics(player.playerVehicle);
		this.updateMountedPosition();

		return true;
	}

	/**
	 * Update the mounted player's position based on vehicle position and mount offset
	 */
	private updateMountedPosition(): void {
		if (!this.user) return;
		const playerBody = this.user.playerVehicle;
		playerBody.characterController.setPosition(
			this.vehicle.position.clone().add(this.#mountOffset),
		);
		const vehicleRotation =
			this.vehicle.rotationQuaternion ?? Quaternion.Identity();
		playerBody.displayCapsule.rotationQuaternion = vehicleRotation.multiply(
			this.#mountRotationOffset,
		);
	}

	private disablePlayerPhysics(player: IPlayerBody): void {
		player.characterController.setVelocity(Vector3.Zero());
		player.clearControlState();
		player.isMounted = true;
		// Disable gravity effect by setting a flag
		this.#physicsDisabled = true;
	}

	private enablePlayerPhysics(playerVehicle: IPlayerBody): void {
		playerVehicle.isMounted = false;
		playerVehicle.mount = null;
		playerVehicle.clearControlState();
		this.#physicsDisabled = false;
	}
}
