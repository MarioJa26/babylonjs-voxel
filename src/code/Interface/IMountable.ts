export interface IMountable {
	mount(user: any): void; // Called when something (player) mounts this object
	dismount(user: any): void; // Called when something dismounts this object
	isMounted(): boolean; // Returns whether it is currently mounted
	getMountedUser?(): any; // Optionally returns the current user if mounted
}
