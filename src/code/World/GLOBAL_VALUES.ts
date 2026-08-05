import { vec3 } from "@babylonjs/lite";

export const GLOBAL_VALUES = {
	DEBUG: false,
	INIT_CONNECTION: false,
	CACHE_TEXTURES: false,
	TEXTURE_VERSION: 1,

	// When true, prevents chunks from being saved to IndexedDB. Useful for testing generation.
	DISABLE_CHUNK_SAVING: false,
	DISABLE_CHUNK_LOADING: false,

	skyLightDirection: vec3(-1, -2, -1),
	GLOBAL_TIME: 0,
};
