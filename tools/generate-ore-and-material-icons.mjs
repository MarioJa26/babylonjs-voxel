// generate-ore-and-material-icons.mjs
//
// Generates two things:
//
//   1. Item icons for the Phase 3c materials that have no art yet — cow hide,
//      leather, tin ingot, bronze ingot, iron wire.
//
//   2. The TinOre diffuse tile, built the way the existing ores are: plain
//      cobble as the background, then a faint vein composited on top.
//
// Conventions match generate-armor-icons.mjs and generate-tool-icons.mjs:
// authored on a 25x25 grid, scaled up by SCALE with nearest-neighbour, written
// as 8-bit RGBA PNG.
//
// The ore tile is also injected into diffuse_atlas.png at the slot for
// BlockType.TinOre, because that is where the mesher actually reads from — the
// standalone PNG is the source of truth, the atlas entry is what ships.
//
// Usage:
//   node tools/generate-ore-and-material-icons.mjs
//   ATLAS=0 node tools/generate-ore-and-material-icons.mjs   # icons only

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public/texture/items");
const ORE_DIR = path.join(ROOT, "public/texture/ore/tin_ore_1k");
const ATLAS_PATH = path.join(ROOT, "public/texture/diffuse_atlas.png");

const GRID = 25;
const SCALE = Number(process.env.SIZE ?? 4); // item icons: GRID * SCALE px

/** BlockType.TinOre. Keep in sync with src/code/World/Texture/BlockType.ts. */
const TIN_ORE_BLOCK_ID = 111;
const ATLAS_COLS = 16;

/**
 * Vein coverage for the tin ore, 0-9 per cell.
 *
 * Sampled off ruby_ore_diff_1k.png by diffing it against the plain cobble tile
 * (block id 1) it was painted on, so tin gets the same vein shape as the ores
 * already in the game rather than a new one. Re-derived by re-running the
 * diff if the ore art changes.
 */
const TIN_VEIN_MASK = [
	"0000000000000000000000000",
	"0000000000000000000000000",
	"0000000000000000000000000",
	"0000000000000000000000000",
	"0000000000000000000000000",
	"0000000000560000000000000",
	"0000000055566005000000000",
	"0000006456474555540000000",
	"0000054566777455555000000",
	"0000054579987683645540000",
	"0000005467876646444446000",
	"0000006455766645575446000",
	"0000005455575555545460000",
	"0000005555545555546550000",
	"0000000556524556555550000",
	"0000000544444555555550000",
	"0000000444454555556500000",
	"0000000056765000055500000",
	"0000000066000000000300000",
	"0000000000000000000000000",
	"0000000000000000000000000",
	"0000000000000000000000000",
	"0000000000000000000000000",
	"0000000000000000000000000",
	"0000000000000000000000000",
];

/**
 * Tin. Pale and slightly warm — tin is nearly colourless in daylight, which is
 * exactly why bronze reads as an achievement over it.
 */
const TIN_LIGHT = [226, 230, 236];
const TIN_MID = [186, 191, 200];
const TIN_DARK = [132, 138, 148];

/**
 * How strongly the vein reads.
 *
 * Lower than the gem ores on purpose: tin is a common ore and a trace metal, so
 * it should be recognisable without shouting. Raise this toward 1.0 to match
 * the gems.
 */
const TIN_VEIN_OPACITY = 0.55;

// ---------------------------------------------------------------------------
// PNG read / write
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

function readPng(filepath) {
	const buf = fs.readFileSync(filepath);
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`Not a PNG: ${filepath}`);
	let pos = 8, width = 0, height = 0, colorType = 6;
	const idat = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			colorType = data[9];
		} else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		pos += 12 + len;
	}

	const raw = zlib.inflateSync(Buffer.concat(idat));
	const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
	const stride = width * bpp;
	const tmp = Buffer.alloc(height * stride);
	let rp = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[rp++];
		for (let x = 0; x < stride; x++) {
			const cur = raw[rp++];
			const a = x >= bpp ? tmp[y * stride + x - bpp] : 0;
			const b = y > 0 ? tmp[(y - 1) * stride + x] : 0;
			const c = x >= bpp && y > 0 ? tmp[(y - 1) * stride + x - bpp] : 0;
			let val;
			switch (filter) {
				case 0: val = cur; break;
				case 1: val = cur + a; break;
				case 2: val = cur + b; break;
				case 3: val = cur + ((a + b) >> 1); break;
				case 4: {
					const p = a + b - c;
					const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
					val = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
					break;
				}
				default: throw new Error(`Unsupported PNG filter: ${filter}`);
			}
			tmp[y * stride + x] = val & 0xff;
		}
	}

	const pixels = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const s = y * stride + x * bpp;
			const d = (y * width + x) * 4;
			if (colorType === 6) {
				tmp.copy(pixels, d, s, s + 4);
			} else if (colorType === 2) {
				pixels[d] = tmp[s];
				pixels[d + 1] = tmp[s + 1];
				pixels[d + 2] = tmp[s + 2];
				pixels[d + 3] = 255;
			} else {
				pixels[d] = pixels[d + 1] = pixels[d + 2] = tmp[s];
				pixels[d + 3] = 255;
			}
		}
	}
	return { width, height, pixels };
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
	ihdr[8] = 8;
	ihdr[9] = 6;

	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	fs.mkdirSync(path.dirname(filepath), { recursive: true });
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

function clamp255(v) {
	return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Deterministic per-pixel grain, matching the armour generator. */
function jitter(x, y, seed) {
	const h = Math.imul(x * 374761393 + y * 668265263 + seed * 2246822519, 1);
	return (((h >>> 13) & 15) - 7) * 1.4;
}

// ---------------------------------------------------------------------------
// Item icons
// ---------------------------------------------------------------------------

/** 'M' body, 'H' lit edge, 'S' shaded edge, 'L' lining/strap, '.' empty. */
const MATERIAL_TEMPLATES = {
	// A raw hide, roughly triangular with a neck notch and a tail.
	hide: [
		".........................",
		"..........MMM............",
		"........MMMMMMM..........",
		".......MMMMMMMMMM........",
		"......MMMMMMMMMMMM.......",
		".....MMMMMMMMMMMMMM......",
		"....MMMMMMMMMMMMMMMM.....",
		"....MMMMMMMMMMMMMMMM.....",
		"...MMMMMMMMMMMMMMMMMM....",
		"...MMMMMMMMMMMMMMMMMM....",
		"...MMMMMMHHHHMMMMMMMM....",
		"...MMMMMMHLLLMMMMMMMM....",
		"...MMMMMMMMMMLMMMMMMM....",
		"..MMMMMMMMMMMLMMMMMMMM...",
		"..MMMMMMMMMMMMMMMMMMMM...",
		"..MMMMMMMMMMMMMMMMMMMM...",
		"..MMMMMMMMMMMMMMMMMMMM...",
		"...MMMMMMMMMMMMMMMMMM...",
		"...MMMMMMMMMMMMMMMMMM...",
		"....MMMMMMMMMMMMMMMM....",
		".....MMMMMMMMMMMMMM.....",
		"......MMMMMMMMMMMM......",
		"........MMMMMMMM........",
		"...........MMM..........",
		".........................",
	],

	// A folded, cured sheet with a visible fold line.
	leather: [
		".........................",
		".........................",
		"....HHHHHHHHHHHHHHH....",
		"..HHMMMMMMMMMMMMMMHH..",
		".HMMMMMMMMMMMMMMMMMMH.",
		".MMMMMMMMMMMMMMMMMMMM.",
		".MMMMMMMMMMMMMMMMMMMM.",
		".MMMMMMMMMMMMMMMMMMMM.",
		".HMMMMMMMLLLMMMMMMMMH.",
		".HMMMMMMMLLLMMMMMMMMH.",
		".MMMMMMMMMMMMMMMMMMMM.",
		".MMMMMMMMMMMMMMMMMMMM.",
		".MMMMMMMMMMMMMMMMMMMM.",
		".SSSSSSSSSSSSSSSSSSSS.",
		".SSSSSSSSSSSSSSSSSSSS.",
		"..SSSSSSSSSSSSSSSSSS..",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
	],

	// Ingots: a trapezoid bar, wide at the base, with a lit top face.
	ingot: [
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
		"...........HHHHH.........",
		".........HHMMMMMHH.......",
		".......HHMMMMMMMMMHH.....",
		"......HMMMMMMMMMMMMMH....",
		".....HMMMMMMMMMMMMMMMH...",
		"....MMMMMMMMMMMMMMMMMM...",
		"...MMMMMMMMMMMMMMMMMMM...",
		"...MMMMMMMMMMMMMMMMMMM...",
		"...MMMMMMMMMMMMMMMMMMM...",
		"...MMMMMMMMMMMMMMMMMMM...",
		"....MMMMMMMMMMMMMMMMMM...",
		"....SSSSSSSSSSSSSSSSSS...",
		".....SSSSSSSSSSSSSSSSS...",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
		".........................",
	],

	// Wire: a spool with the coil wrapped around it.
	wire: [
		".........................",
		".........................",
		".........................",
		"......MMMMMMMMMMMMM.....",
		"....MMMSSSSSSSSSSSMMM...",
		"...MMSSSSSSSSSSSSSSMM..",
		"..MMSSMMMMMMMMMMMMSSMM.",
		".MMSSMMMSSSSSSSSMMMSSMM",
		".MSSMMMSSMMMMMMSSMMMSSM",
		".MSSMMSSMMMMMMMMSSMMSSM",
		".MSSMMSSMMSSSSMMSSMMSSM",
		".MSSMMMSSMMMMMMSSMMMSSM",
		".MMSSMMMSSSSSSSSMMMSSMM",
		"..MMSSMMMMMMMMMMMMSSMM.",
		"...MMSSSSSSSSSSSSSSMM..",
		"....MMMSSSSSSSSSSSMMM...",
		"......MMMMMMMMMMMMM.....",
		".........SSSSSSSSS.......",
		"..........SSSSSSSS.......",
		"..........SS....SS.......",
		"..........SS....SS.......",
		".........................",
		".........................",
		".........................",
		".........................",
	],
};

/**
 * Centre-pad rows to GRID.
 *
 * The shapes below are symmetric, so centring is the intended alignment, and
 * doing it here rather than by hand removes the off-by-one that hand-counted
 * 25-char rows invite. Row widths above are deliberately allowed to drift.
 */
function padTemplate(rows) {
	return rows.map((row) => {
		if (row.length > GRID) {
			throw new Error(`Template row is ${row.length} chars, exceeds ${GRID}: ${row}`);
		}
		const missing = GRID - row.length;
		const left = Math.ceil(missing / 2);
		return ".".repeat(left) + row + ".".repeat(missing - left);
	});
}

const MATERIAL_PALETTES = {
	hide: { base: [196, 168, 132], lining: [138, 106, 74] },
	leather: { base: [166, 118, 68], lining: [110, 74, 40] },
	tin: { base: [196, 201, 210], lining: [136, 142, 152] },
	bronze: { base: [193, 122, 62], lining: [132, 82, 40] },
	wire: { base: [156, 156, 160], lining: [104, 104, 110] },
};

function renderMaterial(template, paletteName) {
	const { base, lining } = MATERIAL_PALETTES[paletteName];
	const lit = [clamp255(base[0] * 1.3 + 16), clamp255(base[1] * 1.3 + 16), clamp255(base[2] * 1.3 + 16)];
	const dark = [clamp255(base[0] * 0.66), clamp255(base[1] * 0.66), clamp255(base[2] * 0.66)];
	const liningDark = [clamp255(lining[0] * 0.66), clamp255(lining[1] * 0.66), clamp255(lining[2] * 0.66)];

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
			else rgb = base;
			const j = jitter(x, y, base[0]);
			icon[d] = clamp255(rgb[0] + j);
			icon[d + 1] = clamp255(rgb[1] + j);
			icon[d + 2] = clamp255(rgb[2] + j);
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

function writeIcons() {
	const jobs = [
		{ template: "hide", palette: "hide", dir: "leather", file: "hide.png" },
		{ template: "leather", palette: "leather", dir: "leather", file: "leather.png" },
		{ template: "ingot", palette: "tin", dir: "item", file: "tin_ingot.png" },
		{ template: "ingot", palette: "bronze", dir: "item", file: "bronze_ingot.png" },
		{ template: "wire", palette: "wire", dir: "item", file: "iron_wire.png" },
	];

	for (const { template, palette, dir, file } of jobs) {
		const tpl = padTemplate(MATERIAL_TEMPLATES[template]);
		const { pixels, size } = scaleUp(renderMaterial(tpl, palette));
		const outPath = path.join(OUT_DIR, dir, file);
		writePng(outPath, size, size, pixels);
		console.log(`wrote ${path.relative(ROOT, outPath)} (${size}x${size})`);
	}
}

// ---------------------------------------------------------------------------
// Tin ore tile: cobble background + faint vein
// ---------------------------------------------------------------------------

/**
 * Build the TinOre diffuse tile.
 *
 * `base` is the plain cobble tile read from the atlas slot for block id 1,
 * which is what the other ores were painted on — reusing it verbatim keeps the
 * stone grain identical to the surrounding cobble instead of introducing a
 * second, slightly different rock texture.
 */
function buildTinOreTile(cobbleTile) {
	const out = Buffer.alloc(GRID * GRID * 4);

	for (let y = 0; y < GRID; y++) {
		for (let x = 0; x < GRID; x++) {
			const s = (y * GRID + x) * 4;
			const d = s;

			let r = cobbleTile[s];
			let g = cobbleTile[s + 1];
			let b = cobbleTile[s + 2];

			const coverage = TIN_VEIN_MASK[y].charCodeAt(x) - 48; // '0'..'9'
			if (coverage > 0) {
				// Colour by depth so the vein has internal form rather than reading
				// as a flat blob: high coverage is the lit core, low is the fringe.
				let ore;
				if (coverage >= 7) ore = TIN_LIGHT;
				else if (coverage >= 4) ore = TIN_MID;
				else ore = TIN_DARK;

				// Square the digit so the fringe stays genuinely faint and the
				// coverage ramp is not linear.
				const k = (coverage / 9) ** 2 * TIN_VEIN_OPACITY;
				r = clamp255(r + (ore[0] - r) * k);
				g = clamp255(g + (ore[1] - g) * k);
				b = clamp255(b + (ore[2] - b) * k);
			}

			// The cobble tile is 25x25 of pre-shaded art; carry its grain through
			// so the injected tile matches its neighbours in the atlas.
			const j = jitter(x, y, 111);
			out[d] = clamp255(r + j);
			out[d + 1] = clamp255(g + j);
			out[d + 2] = clamp255(b + j);
			out[d + 3] = 255;
		}
	}

	return out;
}

function writeTinOre() {
	const atlas = readPng(ATLAS_PATH);

	// Block id 1 -> atlas index 0 -> col 0, row 0.
	const baseCol = 0;
	const baseRow = 0;
	const cobbleTile = Buffer.alloc(GRID * GRID * 4);
	for (let y = 0; y < GRID; y++) {
		for (let x = 0; x < GRID; x++) {
			const src = ((baseRow * GRID + y) * atlas.width + (baseCol * GRID + x)) * 4;
			const dst = (y * GRID + x) * 4;
			cobbleTile[dst] = atlas.pixels[src];
			cobbleTile[dst + 1] = atlas.pixels[src + 1];
			cobbleTile[dst + 2] = atlas.pixels[src + 2];
			cobbleTile[dst + 3] = 255;
		}
	}

	const tile = buildTinOreTile(cobbleTile);

	// Standalone source of truth, at the same 25x25 as the other ore tiles.
	const orePath = path.join(ORE_DIR, "tin_ore_diff_1k.png");
	writePng(orePath, GRID, GRID, tile);
	console.log(`wrote ${path.relative(ROOT, orePath)} (${GRID}x${GRID})`);

	if (process.env.ATLAS === "0") {
		console.log("ATLAS=0: skipping diffuse_atlas.png injection");
		return;
	}

	// Inject into the atlas slot the mesher reads. atlasIndex = blockId - 1.
	const idx = TIN_ORE_BLOCK_ID - 1;
	const col = idx % ATLAS_COLS;
	const row = Math.floor(idx / ATLAS_COLS);
	for (let y = 0; y < GRID; y++) {
		for (let x = 0; x < GRID; x++) {
			const src = (y * GRID + x) * 4;
			const dst = (row * GRID + y) * atlas.width * 4 + (col * GRID + x) * 4;
			atlas.pixels[dst] = tile[src];
			atlas.pixels[dst + 1] = tile[src + 1];
			atlas.pixels[dst + 2] = tile[src + 2];
			atlas.pixels[dst + 3] = 255;
		}
	}
	writePng(ATLAS_PATH, atlas.width, atlas.height, atlas.pixels);
	console.log(
		`injected TinOre into diffuse_atlas.png at col=${col} row=${row} (blockId ${TIN_ORE_BLOCK_ID})`,
	);
}

writeIcons();
writeTinOre();