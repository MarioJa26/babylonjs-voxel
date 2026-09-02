// generate-tool-icons.mjs
//
// Generates Minecraft-style placeholder item icons by compositing two block
// tiles sampled from the diffuse texture atlas.
//
//   - the HILT block id   (the "handle" of the tool)
//   - the HEAD block id   (the "blade", "pick", "axe head", "shovel head"...)
//
// Each tool is drawn on a 25x25 grid, which is then scaled up to a PNG.
//
// Usage:
//   node scripts/generate-tool-icons.mjs
//
// Or override block ids / output via env vars, e.g.:
//   HILT_BLOCK=35 HEAD_BLOCK=1 SIZE=4 node scripts/generate-tool-icons.mjs
//
// The tool shape templates below describe which 25x25 cells use the HILT
// (h) vs the HEAD (H). Edit them to tweak each tool silhouette.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ATLAS_PATH = path.join(ROOT, "public/texture/diffuse_atlas.png");
const TEMPLATE_DIR = path.join(ROOT, "public/texture/items/template");
const OUT_DIR = path.join(ROOT, "public/texture/items");

// ---------------------------------------------------------------------------
// Atlas geometry (must match TextureDefinitions / BlockTextures.ts mapping)
// ---------------------------------------------------------------------------
const ATLAS_SIZE = 400; // px, square
const ATLAS_COLS = 16; // tiles per row
const TILE = ATLAS_SIZE / ATLAS_COLS; // px per tile (25)

// Block id -> atlas tile (col,row). Mirrors BlockTextures.getAtlasTileForBlockId:
// atlasIndex = blockId - 1, col = index % 16, row = floor(index / 16).
function blockIdToTile(blockId) {
	const idx = blockId - 1;
	if (idx < 0) throw new Error(`Invalid block id: ${blockId}`);
	return { col: idx % ATLAS_COLS, row: Math.floor(idx / ATLAS_COLS) };
}

// ---------------------------------------------------------------------------
// PNG helpers (minimal encoder using zlib deflate)
// ---------------------------------------------------------------------------
function readPng(filepath) {
	const buf = fs.readFileSync(filepath);
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG");
	let pos = 8;
	let width = 0;
	let height = 0;
	const idat = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}
		pos += 12 + len;
	}
	const raw = zlib.inflateSync(Buffer.concat(idat));
	// Assume 8-bit RGBA, filter byte per row.
	const channels = 4;
	const stride = width * channels;
	const pixels = Buffer.alloc(width * height * channels);
	let rp = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[rp++];
		for (let x = 0; x < stride; x++) {
			const cur = raw[rp++];
			const a = x >= channels ? pixels[y * stride + x - channels] : 0;
			const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
			const c =
				x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
			let val;
			switch (filter) {
				case 0:
					val = cur;
					break;
				case 1:
					val = cur + a;
					break;
				case 2:
					val = cur + b;
					break;
				case 3:
					val = cur + ((a + b) >> 1);
					break;
				case 4: {
					const p = a + b - c;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					val = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
					break;
				}
				default:
					throw new Error(`Unsupported PNG filter: ${filter}`);
			}
			pixels[y * stride + x] = val & 0xff;
		}
	}
	return { width, height, channels, pixels };
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
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const png = Buffer.concat([
		sig,
		chunk("IHDR", ihdr),
		chunk("IDAT", idat),
		chunk("IEND", Buffer.alloc(0)),
	]);
	fs.writeFileSync(filepath, png);
}

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
	for (let i = 0; i < buf.length; i++)
		c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Tile sampling from the atlas (returns a TILE x TILE RGBA buffer)
// ---------------------------------------------------------------------------
function sampleTile(atlas, blockId) {
	const { col, row } = blockIdToTile(blockId);
	const out = Buffer.alloc(TILE * TILE * 4);
	const aStride = atlas.width * atlas.channels;
	for (let y = 0; y < TILE; y++) {
		for (let x = 0; x < TILE; x++) {
			const ax = col * TILE + x;
			const ay = row * TILE + y;
			const src = ay * aStride + ax * atlas.channels;
			const dst = (y * TILE + x) * 4;
			out[dst] = atlas.pixels[src];
			out[dst + 1] = atlas.pixels[src + 1];
			out[dst + 2] = atlas.pixels[src + 2];
			out[dst + 3] = atlas.pixels[src + 3];
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Tool shape templates (25x25). 'h' = hilt block, 'H' = head block, '.' = empty.
// Coordinates are row-major; row 0 is the top of the icon.
// ---------------------------------------------------------------------------
const TEMPLATES = {
	pickaxe: [
		".........................",
		".........................",
		"...............HHHHHHH...",
		".............HHHHHHHHHH..",
		"...........HHHHHHHHHHHHH.",
		"..........HHHHHHh..HHHHH.",
		".........HHHHHHhh...HHHH.",
		"........HHHHHHhh.....HHH.",
		".......HHHHH.hh.......HH.",
		"......HHHHH.hh.........H.",
		".....HHHH..hh............",
		"....HHHH..hh.............",
		"...HHH...hh..............",
		"..HH....hh...............",
		"..H....hh................",
		"......hh.................",
		".....hh..................",
		"....hh...................",
		"...hh....................",
		"..hh.....................",
		".hh......................",
		"hh.......................",
		"h........................",
		".........................",
		".........................",
	],
	sword: [
		".........................",
		"......................H..",
		".....................HHH.",
		"....................HHHH.",
		"...................HHHH..",
		"..................HHHH...",
		".................HHHH....",
		"................HHHH.....",
		"...............HHHH......",
		"..............HHHH.......",
		".............HHHH........",
		"............HHHH.........",
		"...........HHHH..........",
		"..........HHHH...........",
		"....H....HHHH............",
		"...HHH..HHHH.............",
		"..HHHH.HHHH..............",
		".HHHHHhHHH...............",
		"..HHHHhhh................",
		"...HHhhh.................",
		"....hhh..................",
		"...hhh...................",
		"..hhh....................",
		".hh......................",
		"h........................",
	],
	axe: [
		".........................",
		".........................",
		"...................HHH...",
		".................HHHHHH..",
		"................HHHHHHHH.",
		"...............HHHHHHHHH.",
		"...............HHHHHHHHH.",
		"...............HHHHhHHHH.",
		"................HHhh.HHH.",
		".................hh...HH.",
		"................hh.......",
		"...............hh........",
		"..............hh.........",
		".............hh..........",
		"............hh...........",
		"...........hh............",
		"..........hh.............",
		".........hh..............",
		"........hh...............",
		".......hh................",
		"......hh.................",
		".....hh..................",
		"....hh...................",
		"...hh....................",
		"..hh.....................",
	],
	shovel: [
		".........................",
		".........................",
		"...................HHH...",
		"..................HHHHH..",
		".................HHHHHHH.",
		".................HHHHHHH.",
		".................HHHHHHH.",
		"..................HHHHH..",
		"...................HH....",
		"...................hh....",
		"..................hh.....",
		".................hh......",
		"................hh.......",
		"...............hh........",
		"..............hh.........",
		".............hh..........",
		"............hh...........",
		"...........hh............",
		"..........hh.............",
		".........hh..............",
		"........hh...............",
		".......hh................",
		".....hHHh................",
		"....hHHh.................",
		".........................",
	],
	hoe: [
		".........................",
		".........................",
		".............HHHHHHHHHH..",
		"............HHHHHHHHHHH..",
		"...........HHHHHHHHHHHH..",
		"..........HHHH....hhHHH..",
		".........HHH......hh.HH..",
		"........HH.......hh......",
		"........H.......hh.......",
		"...............hh........",
		"..............hh.........",
		".............hh..........",
		"............hh...........",
		"...........hh............",
		"..........hh.............",
		".........hh..............",
		"........hh...............",
		".......hh................",
		"......hh.................",
		".....hh..................",
		"....hh...................",
		"...hh....................",
		"..hh.....................",
		".hh......................",
		"hh.......................",
	],
};

// Default block ids. Wooden tools: wood-planks hilt (id 35) + respective head.
// Stone tools: wood-planks hilt (id 35) + stone head (id 1). Override via env.
const HILT_BLOCK = Number(process.env.HILT_BLOCK ?? 35);
const HEAD_BLOCK = Number(process.env.HEAD_BLOCK ?? 1);
const SCALE = Number(process.env.SIZE ?? 4); // output = GRID * SCALE px

// Material sets: each generates its own subfolder. Edit the head block ids to
// recolor the tool heads (e.g. iron head = 21, gold = ..., diamond = ...).
// Materials using a template PNG load the head from that file instead of sampling
// the atlas. The template is a 25x25 image whose pixels are used directly for the
// tool-head cells ('H' in the grid below).
const MATERIALS = {
	wood: { hilt: HILT_BLOCK, head: Number(process.env.WOOD_HEAD ?? 35) },
	stone: { hilt: HILT_BLOCK, head: Number(process.env.STONE_HEAD ?? 1) },
	copper: {
		hilt: HILT_BLOCK,
		template: path.join(TEMPLATE_DIR, "copper_template.png"),
	},
	gold: {
		hilt: HILT_BLOCK,
		template: path.join(TEMPLATE_DIR, "gold_template.png"),
	},
	iron: {
		hilt: HILT_BLOCK,
		template: path.join(TEMPLATE_DIR, "iron_template.png"),
	},
};

function main() {
	const atlas = readPng(ATLAS_PATH);
	const GRID = 25;
	const outSize = GRID * SCALE;
	const outPixels = Buffer.alloc(outSize * outSize * 4);

	for (const [mat, { hilt, head, template }] of Object.entries(MATERIALS)) {
		const matDir = path.join(OUT_DIR, mat);
		fs.mkdirSync(matDir, { recursive: true });
		const hiltTile = sampleTile(atlas, hilt);

		// Head can come from an atlas block id or a template PNG.
		let headTile;
		let headLabel;
		if (template) {
			const tpl = readPng(template);
			if (tpl.width !== GRID || tpl.height !== GRID) {
				throw new Error(
					`Template ${template} must be ${GRID}x${GRID}, got ${tpl.width}x${tpl.height}`,
				);
			}
			headTile = tpl.pixels;
			headLabel = `template:${path.basename(template)}`;
		} else {
			headTile = sampleTile(atlas, head);
			headLabel = `block:${head}`;
		}

		for (const [tool, tpl] of Object.entries(TEMPLATES)) {
			// Build 25x25 icon.
			const icon = Buffer.alloc(GRID * GRID * 4);
			for (let y = 0; y < GRID; y++) {
				const row = tpl[y] ?? "";
				for (let x = 0; x < GRID; x++) {
					const ch = row[x] ?? ".";
					const dst = (y * GRID + x) * 4;
					if (ch === "H") {
						// Head: use the template/atlas pixels directly at this position
						const s = (y * GRID + x) * 4;
						icon[dst] = headTile[s];
						icon[dst + 1] = headTile[s + 1];
						icon[dst + 2] = headTile[s + 2];
						icon[dst + 3] = 255;
					} else if (ch === "h") {
						// Hilt: sample from the hilt tile
						const sx = x % TILE;
						const sy = y % TILE;
						const s = (sy * TILE + sx) * 4;
						icon[dst] = hiltTile[s];
						icon[dst + 1] = hiltTile[s + 1];
						icon[dst + 2] = hiltTile[s + 2];
						icon[dst + 3] = 255;
					} else {
						icon[dst + 3] = 0; // transparent
					}
				}
			}

			// Scale up nearest-neighbor.
			for (let y = 0; y < outSize; y++) {
				const sy = Math.floor(y / SCALE);
				for (let x = 0; x < outSize; x++) {
					const sx = Math.floor(x / SCALE);
					const s = (sy * GRID + sx) * 4;
					const d = (y * outSize + x) * 4;
					outPixels[d] = icon[s];
					outPixels[d + 1] = icon[s + 1];
					outPixels[d + 2] = icon[s + 2];
					outPixels[d + 3] = icon[s + 3];
				}
			}

			const outPath = path.join(matDir, `${tool}.png`);
			writePng(outPath, outSize, outSize, outPixels);
			console.log(
				`wrote ${outPath} (${outSize}x${outSize}) hilt=${hilt} head=${headLabel}`,
			);
		}
	}
}

main();
