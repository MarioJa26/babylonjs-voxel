import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl"; // npm install vite-plugin-glsl --save-dev

export default defineConfig({
	plugins: [
		glsl(), // This replaces your old 'raw-loader' for .glsl files
	],
	resolve: {
		alias: [
			{
				find: "@",
				replacement: fileURLToPath(new URL("./src", import.meta.url)),
			},
		],
	},
	// Optimize Worker loading

	worker: {
		format: "es",
		plugins: () => [glsl()],
	},

	server: {
		hmr: false,
		port: 8080,

		// These enable SharedArrayBuffer (Fastest chunk loading)
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Resource-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
	},
	preview: {
		port: 8080,

		// Mirror server.headers so `vite preview` (serving dist/) also sets
		// crossOriginIsolated = true, which DistantTerrain requires
		// (SharedArrayBuffer gate in DistantTerrain.ts). Production hosts must
		// send the same three headers or distant terrain stays disabled.
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Resource-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
	},
	build: {
		target: "esnext",
		minify: "oxc",
		sourcemap: false,
		assetsInlineLimit: 0,
		cssCodeSplit: true,
	},
	json: {
		stringify: true,
	},
});
