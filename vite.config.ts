import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl"; // npm install vite-plugin-glsl --save-dev

export default defineConfig({
	plugins: [
		glsl(), // This replaces your old 'raw-loader' for .glsl files
	],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
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
	build: {
		target: "esnext",
		minify: "oxc",
		sourcemap: false,
		assetsInlineLimit: 0,
		cssCodeSplit: true,
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (id.includes("node_modules")) {
						if (id.includes("@babylonjs/core")) return "babylon-core";
						if (id.includes("@babylonjs/loaders")) return "babylon-loaders";
						if (id.includes("@babylonjs/materials")) return "babylon-materials";
						return "vendor";
					}
				},
			},
		},
	},
	json: {
		stringify: true,
	},
});
