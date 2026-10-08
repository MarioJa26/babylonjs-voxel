// generate-armor-icons.mjs
//
// Generates armour item icons: the four leather pieces and the four chain
// under-layers. Same conventions as generate-tool-icons.mjs so the art sits
// consistently in the inventory grid — authored on a 25x25 grid, scaled up by
// SCALE (4) with nearest-neighbour, and written as 8-bit RGBA PNG.
//
// Unlike the tool icons these are not composited from atlas tiles. Armour has
// no block tile to sample, so each piece is drawn from a shape template plus a
// material palette: 'M' is the material body, 'H' a lit edge, 'S' a shaded
// edge, 'L' a lining or strap in a darker tone of the same material.
//
// Usage:
//   node tools/generate-armor-icons.mjs
//
// Editing a TEMPLATE changes the silhouette. Editing a PALETTE recolors the
// piece. Both are meant to be tweaked freely; nothing else reads these files.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public/texture/items");

const GRID = 25;
const SCALE = Number(process.env.SIZE ?? 4); // output = GRID * SCALE px

// ---------------------------------------------------------------------------
// PNG writer (minimal, zlib deflate)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function writePng(filepath, width, height, rgba) {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	let wp = 0;
	for (let y = 0; y < height; y++) {
		raw[wp++] = 0; // filter: none
		rgba.copy(raw, wp, y * stride, y * stride + stride);
		wp += stride;
	}
	const idat = zlib.deflateSync(raw);

	function chunk(type, data) {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length, 0);
		const typeBuf = Buffer.from(type, "ascii");
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
		return Buffer.concat([len, typeBuf, data, crc]);
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA

	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	fs.writeFileSync(
		filepath,
		Buffer.concat([
			sig,
			chunk("IHDR", ihdr),
			chunk("IDAT", idat),
			chunk("IEND", Buffer.alloc(0)),
		]),
	);
}

// ---------------------------------------------------------------------------
// Material palettes. `base` drives the body, `lining` the straps.
// ---------------------------------------------------------------------------
const PALETTES = {
	leather: { base: [139, 90, 43], lining: [92, 58, 26] },
	bronze: { base: [177, 115, 60], lining: [122, 78, 39] },
	iron: { base: [150, 150, 152], lining: [104, 104, 108] },
	underworld: { base: [74, 68, 80], lining: [44, 40, 50] },
};

function clamp255(v) {
	return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function highlight(rgb) {
	return [clamp255(rgb[0] * 1.3 + 16), clamp255(rgb[1] * 1.3 + 16), clamp255(rgb[2] * 1.3 + 16)];
}

function shadow(rgb) {
	return [clamp255(rgb[0] * 0.66), clamp255(rgb[1] * 0.66), clamp255(rgb[2] * 0.66)];
}

/**
 * Deterministic per-pixel brightness jitter.
 *
 * The existing tool icons are sampled from the atlas and carry that noise
 * naturally. Flat fills would read as cleaner but more synthetic next to them,
 * so the same subtle grain is added here.
 */
function jitter(x, y, seed) {
	const h = Math.imul(x * 374761393 + y * 668265263 + seed * 2246822519, 1);
	return (((h >>> 13) & 15) - 7) * 1.4;
}

function shade(rgb, x, y, seed) {
	const j = jitter(x, y, seed);
	return [
		clamp255(rgb[0] + j),
		clamp255(rgb[1] + j),
		clamp255(rgb[2] + j),
	];
}

// ---------------------------------------------------------------------------
// Shape templates (25x25, row-major, row 0 is the top).
//
// 'M' body, 'H' lit edge, 'S' shaded edge, 'L' lining/strap, '.' transparent.
// ---------------------------------------------------------------------------
const TEMPLATES = {
	// Head: a rounded cap with a brim and a stitched band.
	cap: [
		".........................",
		".........................",
		"......MMMMMMMMMMM........",
		".....MMMMMMMMMMMMM.......",
		"....MMMMMMMMMMMMMMM......",
		"...MMMMMMMMMMMMMMMMM.....",
		"...MMMMMMMMMMMMMMMMM.....",
		"..MMMMMMMMMMMMMMMMMMM....",
		"..MMMMMMMMMMMMMMMMMMM....",
		"..MMMMMMMMMMMMMMMMMMM....",
		"..MMMMMHHHHHHHHMMMMM.....",
		"..MMMMHHLLLLLLLLHHHH.....",
		"..MMMMHLLLSSSSSSLLHH.....",
		"..MMMMMMMMMMMMMMMMMMM....",
		"..MMMMMMMMMMMMMMMMMMM....",
		"...MMMMMMMMMMMMMMMMM.....",
		"...MMMMMMMMMMMMMMMMM.....",
		"....MMMMMMMMMMMMMMM......",
		".....SSSSSSSSSSSSS.......",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
	],

	// Chest: shoulders, short sleeves, a laced neckline and a belt.
	tunic: [
		".........................",
		".........................",
		"....MMMMM.....MMMMM......",
		"...MMMMMM.....MMMMMM.....",
		"..MMMMMMM.....MMMMMMM....",
		"..MMMMMMMMMMMMMMMMMMMM...",
		".MMMMMMMMMMMMMMMMMMMMMM..",
		".MMMMMMMHHHHHHHHMMMMMMM..",
		".MMMMMMHLLLLLLLLLHHHHMM..",
		".MMMMMMHLLSSSSSSLLHHHMM..",
		"..MMMMMMMMMMMMMMMMMMMMMM.",
		"..MMMMMMMMMMMMMMMMMMMMMM.",
		"...MMMMMMMMMMMMMMMMMMMM..",
		"...MMMMMMMMMMMMMMMMMMMM..",
		"...MMMMMMMMMMMMMMMMMMMM..",
		"....MMMMMMMMMMMMMMMMMM...",
		"....MMMMMMMMMMMMMMMMMM...",
		"....MMMMMMM....MMMMMMM...",
		".....MMMMMM....MMMMMM....",
		"......SSSSS....SSSSS.....",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
	],

	// Legs: a waistband across the top, then two legs tapering to the ankle.
	trousers: [
		".........................",
		".........................",
		".........................",
		"...MMMMMMMMMMMMMMMMMM....",
		"...MMMMMMHLLLLLLLHHHHH...",
		"..MMMMMMMMMMMMMMMMMMMM...",
		"..MMMMMMMMMMMMMMMMMMMM...",
		"..MMMMMMMMMMMMMMMMMMMM...",
		"..MMMMMMMMMMMMMMMMMMMM...",
		"..MMMMMMMMMMMMMMMMMMMM...",
		"..MMMMMMMMMMMMMMMMMMMM...",
		"..MMMMMMMMMMMMMMMMMMMM...",
		"..MMMMMMMMMMMMMMMMMMMM...",
		"..MMMMMMM....MMMMMMM.....",
		".MMMMMMM......MMMMMMM....",
		".MMMMMM........MMMMMM....",
		".MMMMMM........MMMMMM....",
		".MMMMM..........MMMMM....",
		".SSSSS..........SSSSS....",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
	],

	// Feet: a pair of boots, shaft above, foot below, dark soles.
	boots: [
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
		"..MMMMM......MMMMM.......",
		"..MMMMM......MMMMM.......",
		"..MMMMM......MMMMM.......",
		"..MMMMM......MMMMM.......",
		"..MMMMM......MMMMM.......",
		"..MMMMM......MMMMM.......",
		"..MMMMM......MMMMM.......",
		"..MMMMM......MMMMM.......",
		".MMMMMM......MMMMMM......",
		".MMMMMMM....MMMMMMM......",
		".MMMMMMMMMMMMMMMMMMM.....",
		".MMMMMMMMMMMMMMMMMMM.....",
		".SSSSSSSSSSSSSSSSSSS.....",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
	],

	// Chain: a mail swatch. The weave is applied procedurally rather than
	// baked into the template, so one template covers every metal.
	chain: [
		".........................",
		".........................",
		"....MMMMMMMMMMMMMMMMM....",
		"...MMMMMMMMMMMMMMMMMMMM..",
		"..MMMMMMMMMMMMMMMMMMMMMM.",
		"..MMMMMMMMMMMMMMMMMMMMMM.",
		"MMMMMMMMMMMMMMMMMMMMMMMMM",
		"MMMMMMMMMMMMMMMMMMMMMMMMM",
		"MMMMMMMMMMMMMMMMMMMMMMMMM",
		"MMMMMMMMMMMMMMMMMMMMMMMMM",
		"MMMMMMMMMMMMMMMMMMMMMMMMM",
		"MMMMMMMMMMMMMMMMMMMMMMMMM",
		"..MMMMMMMMMMMMMMMMMMMMMM.",
		"..MMMMMMMMMMMMMMMMMMMMMM.",
		"...MMMMMMMMMMMMMMMMMMMM..",
		"...MMMMMMMMMMMMMMMMMMMM..",
		"....MMMMMMMMMMMMMMMMM....",
		".....MMMMMMMMMMMMMMMM....",
		"......MMMMMMMMMMMMMM.....",
		".......MMMMMMMMMMMM......",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
	],
};

// ---------------------------------------------------------------------------
// Output map: template -> per-material file paths.
//
// The four outer pieces are leather only for now, matching the item table. The
// chain is generated per material because every metal tier gets its own.
// ---------------------------------------------------------------------------
function outputs() {
	const out = [];
	for (const piece of ["cap", "tunic", "trousers", "boots"]) {
		out.push({
			piece,
			material: "leather",
			dir: "leather",
			file: `${piece}.png`,
		});
	}
	for (const material of ["leather", "bronze", "iron", "underworld"]) {
		out.push({
			piece: "chain",
			material,
			dir: "chain",
			file: `${material}_chain.png`,
		});
	}
	return out;
}

function render(template, paletteName, weave) {
	const { base, lining } = PALETTES[paletteName];
	const lit = highlight(base);
	const dark = shadow(base);
	const liningDark = shadow(lining);

	const icon = Buffer.alloc(GRID * GRID * 4);

	for (let y = 0; y < GRID; y++) {
		const row = template[y] ?? "";
		for (let x = 0; x < GRID; x++) {
			const ch = row[x] ?? ".";
			const d = (y * GRID + x) * 4;

			if (ch === ".") {
				icon[d + 3] = 0;
				continue;
			}

			let rgb;
			if (ch === "H") rgb = lit;
			else if (ch === "S") rgb = dark;
			else if (ch === "L") rgb = liningDark;
			else if (ch === "l") rgb = lining;
			else {
				// 'M': the body. Mail weaves light/dark on a diagonal so it reads
				// as interlocked rings at inventory size.
				rgb = weave ? ((x + y) % 2 === 0 ? lit : dark) : base;
			}

			const c = shade(rgb, x, y, base[0]);
			icon[d] = c[0];
			icon[d + 1] = c[1];
			icon[d + 2] = c[2];
			icon[d + 3] = 255;
		}
	}

	return icon;
}

function scaleUp(icon) {
	const outSize = GRID * SCALE;
	const out = Buffer.alloc(outSize * outSize * 4);
	for (let y = 0; y < outSize; y++) {
		const sy = Math.floor(y / SCALE);
		for (let x = 0; x < outSize; x++) {
			const sx = Math.floor(x / SCALE);
			const s = (sy * GRID + sx) * 4;
			const d = (y * outSize + x) * 4;
			out[d] = icon[s];
			out[d + 1] = icon[s + 1];
			out[d + 2] = icon[s + 2];
			out[d + 3] = icon[s + 3];
		}
	}
	return { pixels: out, size: outSize };
}

function main() {
	let written = 0;
	for (const { piece, material, dir, file } of outputs()) {
		const template = TEMPLATES[piece];
		if (!template) throw new Error(`No template named "${piece}"`);
		for (const row of template) {
			if (row.length !== GRID) {
				throw new Error(
					`Template "${piece}" row is ${row.length} chars, expected ${GRID}: ${row}`,
				);
			}
		}

		const icon = render(template, material, piece === "chain");
		const { pixels, size } = scaleUp(icon);

		const outDir = path.join(OUT_DIR, dir);
		fs.mkdirSync(outDir, { recursive: true });
		const outPath = path.join(outDir, file);
		writePng(outPath, size, size, pixels);
		written++;
		console.log(`wrote ${path.relative(ROOT, outPath)} (${size}x${size})`);
	}
	console.log(`${written} armour icons written`);
}

main();