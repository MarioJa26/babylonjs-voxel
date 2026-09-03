import { addVec3ToRef, type Mesh, type Quat, type Vec3 } from "@babylonjs/lite";
import { Quaternion, vec3Zero } from "@/code/Lib/Math";
import type { IControls } from "../Interface/IControls";
import type { IMountable } from "../Interface/IMountable";
import type { IPlayerBody } from "../Player/PlayerBody";
import type MountOptions from "./MountOptions";

/**
 * Minimal interface for the Player properties that Mount needs.
 * Avoids a direct import of Player, breaking the Mount ↔ Player cycle.
 *
 * Exported so the owner (Player) can register the `isMountableUser`
 * predicate below without importing Player back into this module.
 */
export interface IMountableUser {
	readonly playerVehicle: IPlayerBody;
	readonly playerCamera: { zoomIn(): void; zoomOut(): void };
	keyboardControls: IControls<unknown>;
	readonly defaultKeyboardControls: IControls<unknown>;
}

export class Mount implements IMountable {
	public user: IMountableUser | null = null;
	public vehicle: Mesh;
	#keyBoardControls: IControls<unknown>;

	// Mount position and rotation offset relative to vehicle
	#mountOffset: Vec3;
	#mountRotationOffset: Quat;

	// Track if physics is disabled
	#physicsDisabled = false;
	#scratchPos = vec3Zero();
	#scratchRot = new Quaternion(0, 0, 0, 1);
	// PERF: reused vehicle-rotation input — updateMountedPosition runs every
	// frame while mounted, and vec4()/Quaternion.Identity() each allocated a
	// fresh object per call.
	#scratchVehicleRot = new Quaternion(0, 0, 0, 1);

	/**
	 * Predicate to check if a value is a mountable user.
	 * Set by Player (or other callers) to avoid Mount importing Player.
	 */
	static isMountableUser: (value: unknown) => value is IMountableUser = ((
		v: unknown,
	): v is IMountableUser => false) as (
		value: unknown,
	) => value is IMountableUser;

	constructor(
		vehicle: Mesh,
		keyBoardControls: IControls<unknown>,
		options: MountOptions = {},
	) {
		this.vehicle = vehicle;
		this.#keyBoardControls = keyBoardControls;
		this.#mountOffset = options.mountOffset ?? { x: 0, y: 0.9, z: 0 };
		this.#mountRotationOffset = options.mountRotationOffset ?? {
			x: 0,
			y: 0,
			z: 0,
			w: 1,
		};
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
		if (Mount.isMountableUser(user)) {
			return this.#mountVehicle(user);
		}
		return false;
	}

	dismount(): boolean {
		if (!this.user) return false;

		const player = this.user;
		const vehicle = player.playerVehicle;

		// Prevent stuck keys on scheme switch: clear the outgoing (vehicle)
		// keys and the incoming (walking) keys. A movement key held across
		// the transition (e.g. W held while pressing E) would otherwise stay
		// stuck in the other scheme's set and drive input with no key held.
		player.keyboardControls.pressedKeys.clear();
		player.keyboardControls = player.defaultKeyboardControls;
		player.keyboardControls.pressedKeys.clear();
		vehicle.clearControlState();

		if (this.#physicsDisabled && vehicle.characterController) {
			this.enablePlayerPhysics(vehicle);
		}

		vehicle.displayCapsule.parent = null;

		this.user = null;
		this.#physicsDisabled = false;

		return true;
	}

	getMountedUser(): IMountableUser | null {
		return this.user;
	}

	getKeyBoardControls(): IControls<unknown> {
		return this.#keyBoardControls;
	}

	setMountOffset(offset: Vec3): void {
		this.#mountOffset = offset;

		// Update position if someone is mounted
		if (this.user) {
			this.updateMountedPosition();
		}
	}

	setMountRotationOffset(rotationOffset: Quat): void {
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
	#mountVehicle(player: IMountableUser): boolean {
		if (this.user) {
			if (this.user === player) this.dismount();
			return false;
		}

		// Prevent stuck keys on scheme switch (see dismount): a key held
		// while boarding must not linger in either scheme's pressed set.
		player.keyboardControls.pressedKeys.clear();
		this.#keyBoardControls.pressedKeys.clear();

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
		addVec3ToRef(this.vehicle.position, this.#mountOffset, this.#scratchPos);

		playerBody.characterController.setPosition(this.#scratchPos);
		const rp = this.vehicle.rotationQuaternion;
		if (rp) {
			this.#scratchVehicleRot.copyFromFloats(rp.x, rp.y, rp.z, rp.w);
		} else {
			this.#scratchVehicleRot.copyFromFloats(0, 0, 0, 1);
		}
		// mountRotationOffset is the lightweight Quat shape; the math helper
		// only reads x/y/z/w, so a structural cast keeps this alloc-free.
		this.#scratchVehicleRot.multiplyToRef(
			this.#mountRotationOffset as unknown as Quaternion,
			this.#scratchRot,
		);
		playerBody.displayCapsule.rotationQuaternion.copyFrom(this.#scratchRot);
	}

	private disablePlayerPhysics(player: IPlayerBody): void {
		player.characterController.setVelocity(vec3Zero());
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
