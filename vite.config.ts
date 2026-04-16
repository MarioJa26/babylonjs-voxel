import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import glsl from "vite-plugin-glsl"; // npm install vite-plugin-glsl --save-dev

export default defineConfig({
	plugins: [
		vue(),
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
		plugins: () => [glsl()], // Allows workers to also import shaders
	},
	server: {
		hmr: false,
		port: 8080,

		// These enable SharedArrayBuffer (Fastest chunk loading)
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
	},
	build: {
		sourcemap: true,
	},
});
