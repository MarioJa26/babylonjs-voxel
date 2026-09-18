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
		// PERF: keep the ~400-file Babylon shard + colyseus out of the
		// entry chunk. Menu route loads a small entry; the game chunk
		// (via main.ts dynamic import) pulls these vendors on demand.
		rollupOptions: {
			output: {
				manualChunks: (id: string) => {
					if (id.includes("node_modules/@babylonjs/lite")) {
						return "vendor-lite";
					}
					if (id.includes("node_modules/@colyseus")) {
						return "vendor-colyseus";
					}
					if (id.includes("node_modules/alea")) {
						return "vendor-alea";
					}
					return undefined;
				},
			},
		},
	},
	define: {
		global: "globalThis",
	},
	json: {
		stringify: true,
	},
});
