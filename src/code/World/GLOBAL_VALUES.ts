import { Vector3 } from "@babylonjs/core";

export const GLOBAL_VALUES = {
	DEBUG: false,
	CREATE_ATLAS: false,

	INIT_CONNECTION: false,
	CACHE_TEXTURES: true,
	TEXTURE_VERSION: 1,

	// When true, prevents chunks from being saved to IndexedDB. Useful for testing generation.
	DISABLE_CHUNK_SAVING: false,
	DISABLE_CHUNK_LOADING: false,

	skyLightDirection: new Vector3(-1, -2, -1),
	GLOBAL_TIME: 0,
	DAY_DURATION_MS: 10 * 60 * 1000,
};
