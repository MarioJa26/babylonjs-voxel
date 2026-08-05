// Builds the AssemblyScript SIMD noise kernels to src/code/wasm/kernels.wasm.
//
// Run with: node scripts/build-wasm.mjs
// Requires: npm i -D assemblyscript (asc is invoked from node_modules)

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const asc = join(root, "node_modules/assemblyscript/bin/asc.js");
if (!existsSync(asc)) {
	console.error("asc not found - run: npm i -D assemblyscript");
	process.exit(1);
}

const entry = join(root, "src/code/wasm/kernels.ts");
const out = join(root, "src/code/wasm/kernels.wasm");
const publicOut = join(root, "public/wasm/kernels.wasm");
const tablesFile = join(root, "src/code/wasm/gradient_tables.ts");

const args = [
	entry,
	"--outFile", out,
	"--enable", "simd",
	"--optimizeLevel", "3",
	"--shrinkLevel", "0",
	"--noAssert",
	"--runtime", "minimal",
];

console.log(`asc ${entry} -> ${out}`);
try {
	execFileSync(process.execPath, [asc, ...args], { stdio: "inherit" });
} catch {
	process.exit(1);
}

const size = existsSync(out) ? (await import("node:fs")).statSync(out).size : 0;
console.log(`ok: kernels.wasm (${size} bytes), tables: ${existsSync(tablesFile) ? "present" : "MISSING"}`);

// Mirror to public/wasm so the browser can fetch /wasm/kernels.wasm
// (dev server + `vite build` both serve public/ verbatim at the site root).
await (async () => {
	const { mkdirSync, copyFileSync } = await import("node:fs");
	mkdirSync(join(root, "public/wasm"), { recursive: true });
	copyFileSync(out, publicOut);
	console.log(`ok: ${publicOut} (${size} bytes)`);
})();
