export interface IMountable {
	mount(user: unknown): void; // Called when something (player) mounts this object
	dismount(user: unknown): void; // Called when something dismounts this object
	isMounted(): boolean; // Returns whether it is currently mounted
	getMountedUser?(): unknown; // Optionally returns the current user if mounted
}
