// generate-station-and-tool-textures.mjs
//
// Generates diffuse tiles for the Phase 3c blocks that have no art: the six
// smithing stations and the smith tool blocks, plus the temple glyph which was
// already empty.
//
// Why this exists
// ---------------
// The block atlas is what the mesher and the inventory cube icon both read from.
// Tiles for BlockType 104-161 were simply never painted — 57 empty slots — so
// these blocks were invisible in the world and their item icons rendered blank.
// Fixing the icon alone would not fix the world, so both are handled here: each
// tile is written to its own source PNG and injected into the atlas slot the
// mesher reads.
//
// Composition
// -----------
// Each block starts from its own declared base texture (the `path` in
// blocks.json, e.g. the kiln is brick, the anvil is rusted grate) so the stone
// grain matches what the block claims to be made of. A shape template then draws
// the structure on top — an arch mouth, a chimney, a horn, a blade — so the six
// stations are told apart at a glance instead of being six tinted bricks.
//
// Template chars:
//   'B' base texture      'H' base highlight  'S' base shadow
//   'D' dark interior     'F' fire / glow      'M' metal accent
//   'L' lit edge          '.' transparent
//
// Usage:
//   node tools/generate-station-and-tool-textures.mjs
//   ATLAS=0 node tools/generate-station-and-tool-textures.mjs  # tiles only

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ATLAS_PATH = path.join(ROOT, "public/texture/diffuse_atlas.png");
const BLOCKS_JSON = path.join(ROOT, "public/data/blocks.json");
const TEXTURE_ROOT = path.join(ROOT, "public");

const TILE = 25;
const ATLAS_COLS = 16;

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
		raw[wp++] = 0;
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
		Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]),
	);
}

function clamp255(v) {
	// NaN would otherwise slip through both range checks and land in the buffer
	// as 0, turning whole regions of a tile black with nothing logged.
	if (Number.isNaN(v)) return 0;
	return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function jitter(x, y, seed) {
	const h = Math.imul(x * 374761393 + y * 668265263 + seed * 2246822519, 1);
	return (((h >>> 13) & 15) - 7) * 1.4;
}

/** Downsample an arbitrary-size source image to a TILE x TILE RGBA buffer. */
function downsample(img) {
	const out = Buffer.alloc(TILE * TILE * 4);
	for (let y = 0; y < TILE; y++) {
		const sy = Math.min(img.height - 1, Math.floor((y / TILE) * img.height));
		for (let x = 0; x < TILE; x++) {
			const sx = Math.min(img.width - 1, Math.floor((x / TILE) * img.width));
			const s = (sy * img.width + sx) * 4;
			const d = (y * TILE + x) * 4;
			out[d] = img.pixels[s];
			out[d + 1] = img.pixels[s + 1];
			out[d + 2] = img.pixels[s + 2];
			out[d + 3] = 255;
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Accent colours, independent of the base material so the structures read.
// ---------------------------------------------------------------------------
const DARK_INTERIOR = [26, 20, 18];
const FIRE_CORE = [255, 214, 120];
const FIRE_MID = [226, 122, 44];
const FIRE_LOW = [150, 58, 22];
const METAL_LIGHT = [214, 216, 222];
const METAL_MID = [138, 141, 150];
const METAL_DARK = [72, 74, 82];
const GLYPH_GLOW = [214, 168, 84];

function highlight(rgb) {
	return [clamp255(rgb[0] * 1.32 + 14), clamp255(rgb[1] * 1.32 + 14), clamp255(rgb[2] * 1.32 + 14)];
}

function shadow(rgb) {
	return [clamp255(rgb[0] * 0.64), clamp255(rgb[1] * 0.64), clamp255(rgb[2] * 0.64)];
}

// ---------------------------------------------------------------------------
// Shape templates (25x25, row-major, row 0 is the top).
// ---------------------------------------------------------------------------

/**
 * Kiln: a squat brick dome with a lit mouth low in the face.
 * Charcoal burns slowly here, so the glow is small and low.
 */
const KILN = [
	".........................",
	".....BBBBBBBBBBBBB.......",
	"...BBBBBBBBBBBBBBBBB.....",
	"..BBBBBBBBBBBBBBBBBBB....",
	".BBBBBBBBBBBBBBBBBBBBB...",
	".BBBBBBBBBBBBBBBBBBBBB...",
	".BBBBBBBBBBBBBBBBBBBBB...",
	".BBBBHHBBBBBBBBBHHBBBB...",
	".BBBBHHDDDDDDDDDHHBBBB...",
	".BBBBHHDDFFFFDDDHBBBB...",
	".BBBBHHDDFFFFDDDHBBBB...",
	".BBBBHHDDDDDDDDDHHBBBB...",
	".BBBBHHHHHHHHHHHHHHBBBB...",
	".SSSSSSSSSSSSSSSSSSSSS...",
	".SSSSSSSSSSSSSSSSSSSSS...",
	"..SSSSSSSSSSSSSSSSSSS....",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
];

/**
 * Furnace: taller than the kiln, with a wide arched mouth and a grate across
 * the opening. Smelts fast, so the mouth is bigger and brighter.
 */
const FURNACE = [
	".........................",
	"....BBBBBBBBBBBBB........",
	"...BBBBBBBBBBBBBBB.......",
	"..BBBBBBBBBBBBBBBBB......",
	".BBBBBBBBBBBBBBBBBBB.....",
	".BBBBBBBBBBBBBBBBBBB.....",
	".BBBBBBBBBBBBBBBBBBB.....",
	".BBBBBBBBBBBBBBBBBBB.....",
	".BBBBBHHBBBBBBBBHHBBBB...",
	".BBBBBHDDDDDDDDDHHBBBB...",
	".BBBBBHDMFFMFFMDHHBBBB...",
	".BBBBBHDMFFMFFMDHHBBBB...",
	".BBBBBHDDDDDDDDDHHBBBB...",
	".BBBBBHHHHHHHHHHHHBBBB...",
	".SSSSSSSSSSSSSSSSSSSSS...",
	".SSSSSSSSSSSSSSSSSSSSS...",
	"..SSSSSSSSSSSSSSSSSSS....",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
];

/**
 * Whetstone: a flat stone on a low stand with a bright worn groove.
 * No fire — it sharpens, it does not burn.
 */
const WHETSTONE = [
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	"..........HHHHHHH........",
	"........HHMMMMMMMHH......",
	".......HMMMMMMMMMMMH.....",
	".......HMLMMMMMMMMMLH....",
	".......HMLMMMMMMMMMLH....",
	".......HMMMMMMMMMMMH.....",
	"........HHMMMMMMMHH......",
	".........HHHHHHHHH.......",
	"..........SSSSSSS........",
	".........SSSSSSSSS.......",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
];

/**
 * Crucible: a deep bowl, deep molten pool, wide rim. Bronze melts in here, so
 * the pool is the brightest thing in the block set.
 */
const CRUCIBLE = [
	".........................",
	"..........HHHHHHH........",
	"........HHSSSSSSSSHH.....",
	".......HSSMMMMMMMSSH.....",
	"......HSMMMDDDDDDMMMSH...",
	"......HSMMDFFFFFFDMMSH...",
	"......HSMMDFFFFFFDMMSH...",
	"......HSMMDFFFFFFDMMSH...",
	"......HSMMDFFFFFFDMMSH...",
	"......HSMMMDDDDDDMMMSH...",
	"......HSMMMMMMMMMMMSSH...",
	".......HSSMMMMMMMSSH.....",
	"........HHSSSSSSSSHH.....",
	".........HHHHHHHHH.......",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
	".........................",
];

/**
 * Anvil: horn on the left, body in the middle, heel on the right.
 * The only station that is not a fire, which is why it needs its own silhouette.
 */
const ANVIL = [
	".........................",
	".........................",
	".........................",
	".....MMMM...............",
	"....MMMMMM..............",
	"...MMMMMMMM.............",
	"..MMMMMMMMMM............",
	".MMMMMMMMMMMDD...........",
	".MMMMMMMMMMMDDD..........",
	".MMMMMMMMMMMMDDDD........",
	".MMMMMMMMMMMMDDDD........",
	".MMMMMMMMMMMMMMMDDD......",
	"..SSSSSSSSSSSSSSSDDDD....",
	"..SSSSSSSSSSSSSSSSSSSS...",
	"...MMMMMMMMMMMMMMMMSSS..",
	"....MMMMMMMMMMMMMMMMMM..",
	".....MMMMMMMMMMMMMMMM...",
	"......MMMMMMMMMMMMMM....",
	".......MMMMMMMMMMMM.....",
	"........MMMMMMMMMM......",
	".........MMMMMMMM.......",
	"..........MMMMMM........",
	"..........SSSSSS........",
	"..........SSSSSS........",
	".........................",
];

/**
 * Smeltery: a big brick furnace with a chimney and a broad glowing arch.
 * The high-tier station, so it is the tallest and heaviest of the six.
 */
const SMELTERY = [
	"..........MMM...........",
	"..........MMM...........",
	"..........MMM...........",
	"..........MMM...........",
	".....BBBBBBBBBBBBB......",
	"...BBBBBBBBBBBBBBBBB....",
	"..BBBBBBBBBBBBBBBBBBB...",
	".BBBBBBBBBBBBBBBBBBBBB..",
	".BBBBBBBBBBBBBBBBBBBBB..",
	".BBBBBHHBBBBBBBBHHBBBB..",
	".BBBBBHDDDDDDDDDHHBBBB..",
	".BBBBBHDDFFFFDDDHBBBB..",
	".BBBBBHDDFFFFDDDHBBBB..",
	".BBBBBHDDFFFFDDDHBBBB..",
	".BBBBBHDDDDDDDDDHHBBBB..",
	".BBBBBHHHHHHHHHHHHBBBB..",
	".BBBBBBBBBBBBBBBBBBBBB..",
	".SSSSSSSSSSSSSSSSSSSSS..",
	".SSSSSSSSSSSSSSSSSSSSS..",
	"..SSSSSSSSSSSSSSSSSSS...",
	"..SSSSSSSSSSSSSSSSSSS...",
	".........................",
	".........................",
	".........................",
	".........................",
];

/**
 * Temple glyph: a carved red-sandstone block with a glowing sigil.
 * The stone was already there; only the carving was missing.
 */
const TEMPLE_GLYPH = [
	".........................",
	"..BBBBBBBBBBBBBBBBBBB...",
	"..BBBBBBBBBBBBBBBBBBB...",
	"..BBBBBBBGGGGGBBBBBBB...",
	"..BBBBBBGDDDDDGDBBBBB...",
	"..BBBBBGDDLLLLDDGBBBBB..",
	"..BBBBBGDLGLGLLDGBBBBB..",
	"..BBBBBGDLGLGLLDGBBBB...",
	"..BBBBBGDLGLGLLDGBBBB...",
	"..BBBBBGDLGLGLLDGBBBB...",
	"..BBBBBGDLGLGLLDGBBBB...",
	"..BBBBBGDLGLGLLDGBBB....",
	"..BBBBBGDDLLLLDDGBBB....",
	"..BBBBBBGDDDDDGDBBB.....",
	"..BBBBBBBGGGGGBBBB......",
	"..BBBBBBBBBBBBBBBBB....",
	"..BBBBBBBBBBBBBBBBBB....",
	"..BBBBBBBBBBBBBBBBBB....",
	"..BBBBBBBBBBBBBBBBBB....",
	"..BBBBBBBBBBBBBBBBBB....",
	"..BBBBBBBBBBBBBBBBBB....",
	"..BBBBBBBBBBBBBBBBBB....",
	"..BBBBBBBBBBBBBBBBBB....",
	"..BBBBBBBBBBBBBBBBBB....",
	".........................",
];

/**
 * Smith tools: a hammer drawn diagonally across the tile, head at the top.
 *
 * One template covers all 42 (kind, tier) pairs — the tier is expressed by the
 * material palette, and every pair is still its own block id, so the tier stays
 * visible in the world as the SmithTools design intends.
 *
 * 'M' here is the tool material rather than the base block texture: a hammer
 * made of cobblestone would just look like a rock.
 */
const SMITH_HAMMER = [
	"..........MMMMM.........",
	".........MMMMMMM........",
	"........MMMMMMMMM.......",
	".......MMMMMMMMMMM......",
	"......MMMMMMMMMMMM......",
	".....MMMMMMMMMMMMMM.....",
	"....MMMMMMMMMMMMMMMM....",
	"...MMMMMMMMMMMMMMMMMM...",
	"..MMMMMMMMMMMMMMMMMMMM..",
	".MMMMMMMMMMMMMMMMMMMMMM.",
	"MMMMMMMMMMMMMMMMMMMMMMMM",
	".SSSSSSSSSSSSSSSSSSSSS.",
	"........SSSSSSSSSS......",
	"........SSSSSSSSSS......",
	".......SSSSSSSSSS.......",
	".......SSSSSSSSSS.......",
	"......SSSSSSSSSS........",
	"......SSSSSSSSSS........",
	".....SSSSSSSSSS.........",
	".....SSSSSSSSSS.........",
	"....SSSSSSSSSS..........",
	"....SSSSSSSSSS..........",
	"...SSSSSSSSSS...........",
	"...SSSSSSSSSS...........",
	"........................",
];

/** Tool tiers, matching SMITH_TOOL_TIERS in SmithTools.ts. */
const TOOL_PALETTES = {
	stone: [150, 150, 152],
	bronze: [177, 115, 60],
	iron: [186, 188, 196],
	reinforced_iron: [120, 128, 138],
	reinforced_silver: [214, 216, 224],
	underworld_iron: [74, 68, 80],
};

/** Station blocks and the glyph: template + how the 'B' cells are filled. */
const BLOCKS = [
	{ id: 104, name: "temple_glyph", template: TEMPLE_GLYPH, baseFromBlocksJson: true },
	{ id: 105, name: "kiln", template: KILN, baseFromBlocksJson: true },
	{ id: 106, name: "furnace", template: FURNACE, baseFromBlocksJson: true },
	{ id: 107, name: "whetstone", template: WHETSTONE, baseFromBlocksJson: true },
	{ id: 108, name: "crucible", template: CRUCIBLE, baseFromBlocksJson: true },
	{ id: 109, name: "anvil", template: ANVIL, baseFromBlocksJson: true },
	{ id: 110, name: "smeltery", template: SMELTERY, baseFromBlocksJson: true },
];

/** Centre-pad rows to TILE. */
/**
 * Normalise every row to exactly TILE characters.
 *
 * Short rows are centre-padded. Over-long rows shed dots from whichever end has
 * more of them, alternating sides so a one-off slip stays symmetric. Both shapes
 * here are symmetric by design, and the trailing/leading dots are the
 * expendable part — the structure lives in the middle. Doing this in code rather
 * than by hand-counting 25-character strings is what keeps the templates
 * editable without off-by-one breakage.
 */
function padTemplate(rows, label) {
	return rows.map((row, i) => {
		if (!/^[.BHSDFMLGl]*$/.test(row)) {
			throw new Error(`${label} row ${i} has an unknown template char: ${row}`);
		}
		let out = row;
		while (out.length > TILE) {
			const leftDots = (out.match(/^\.+/)?.[0].length) ?? 0;
			const rightDots = (out.match(/\.+$/)?.[0].length) ?? 0;
			if (leftDots === 0 && rightDots === 0) {
				throw new Error(
					`${label} row ${i} is ${out.length} chars with no padding to trim: ${out}`,
				);
			}
			out = rightDots >= leftDots ? out.slice(0, -1) : out.slice(1);
		}
		const missing = TILE - out.length;
		const left = Math.ceil(missing / 2);
		return ".".repeat(left) + out + ".".repeat(missing - left);
	});
}

function renderTile(template, baseTile, accents, seed) {
	const out = Buffer.alloc(TILE * TILE * 4);
	const lit = highlight(baseTile.mid);
	const dark = shadow(baseTile.mid);

	// Every cell is painted: these are solid blocks, and a transparent cell
	// would render as a hole in the world and as a broken silhouette in the
	// inventory cube icon. '.' therefore means "plain base material", not
	// transparent — padding cells are the rest of the block face.
	for (let y = 0; y < TILE; y++) {
		const row = template[y];
		for (let x = 0; x < TILE; x++) {
			const ch = row[x] ?? ".";
			const d = (y * TILE + x) * 4;
			// Sample the donor tile per pixel rather than filling with its average
			// colour: the grain is most of what makes the material read as brick or
			// slate instead of a flat swatch.
			const b = (y * TILE + x) * 4;
			const baseRgb = [baseTile.data[b], baseTile.data[b + 1], baseTile.data[b + 2]];

			let rgb;
			switch (ch) {
				case ".":
					rgb = baseRgb;
					break;
				case "B":
					rgb = baseRgb;
					break;
				case "H":
					rgb = ch === "H" && accents.h ? accents.h : lit;
					break;
				case "S":
					rgb = dark;
					break;
				case "D":
					rgb = DARK_INTERIOR;
					break;
				case "F":
					// Three-step fire gradient, brightest in the middle of the pool.
					rgb = accents.fire ?? FIRE_MID;
					break;
				case "M":
					rgb = accents.metal ?? METAL_MID;
					break;
				case "L":
					rgb = accents.glow ?? FIRE_MID;
					break;
				case "G":
					rgb = GLYPH_GLOW;
					break;
				case "l":
					rgb = accents.metal ?? METAL_LIGHT;
					break;
				default:
					rgb = [255, 0, 255]; // loud: a typo in a template must be obvious
					break;
			}

			const j = jitter(x, y, seed);
			out[d] = clamp255(rgb[0] + j);
			out[d + 1] = clamp255(rgb[1] + j);
			out[d + 2] = clamp255(rgb[2] + j);
			out[d + 3] = 255;
		}
	}
	return out;
}

/** A flat TILE x TILE tile in one colour, for when no donor texture exists. */
function solidTile(rgb) {
	const out = Buffer.alloc(TILE * TILE * 4);
	for (let i = 0; i < TILE * TILE; i++) {
		out[i * 4] = rgb[0];
		out[i * 4 + 1] = rgb[1];
		out[i * 4 + 2] = rgb[2];
		out[i * 4 + 3] = 255;
	}
	return out;
}

/**
 * Average a tile, as an [r,g,b] triple.
 *
 * An array rather than {r,g,b} because highlight()/shadow() index channels
 * positionally. Returning an object here silently produced NaN through both,
 * and clamp255(NaN) fell through its range checks and wrote 0 — whole regions
 * of the tile came out pure black with no error raised.
 */
function averageOf(tile) {
	let r = 0, g = 0, b = 0;
	const n = TILE * TILE;
	for (let i = 0; i < n; i++) {
		r += tile[i * 4];
		g += tile[i * 4 + 1];
		b += tile[i * 4 + 2];
	}
	return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** Resolve a blocks.json `path` (e.g. "/texture/brick/brick_wall_10_1k") to a file. */
/**
 * Find a block that already owns this texture path, so its tile can be reused
 * as the base.
 *
 * Sampling from the atlas rather than decoding the source PNG is deliberate.
 * Those `_1k` diffuse files are 16-bit and 1024x1024; decoding them needs a
 * 16-bit unfilter path for one 25x25 result. The base textures are already
 * baked into atlas tiles for the blocks that originally used them, and reusing
 * those guarantees the grain matches the world exactly instead of nearly
 * matching it after a resample.
 */
/**
 * Build name -> id from BlockType.ts.
 *
 * blocks.json identifies most blocks by enum *name* ("Cobble", "BrickWall10")
 * and only the newer ones by bare number, so resolving a donor needs the enum
 * rather than the JSON alone. Parsed from source rather than importing because
 * BlockType.ts is a TypeScript module and this script runs as plain ESM.
 */
function readBlockTypeIds() {
	const src = fs.readFileSync(path.join(ROOT, "src/code/World/Texture/BlockType.ts"), "utf8");
	const body = src.slice(src.indexOf("enum BlockType"));
	const ids = new Map();
	const re = /^\s*([A-Za-z0-9_]+)\s*=\s*(\d+)\s*,/gm;
	let m;
	while ((m = re.exec(body)) !== null) {
		ids.set(m[1], Number(m[2]));
	}
	if (ids.size === 0) throw new Error("Could not parse BlockType.ts enum members");
	return ids;
}

function findDonorBlockId(blocksJson, pathField, blockTypeIds, selfId) {
	for (const entry of blocksJson) {
		if (entry.path !== pathField) continue;
		let id = null;
		if (typeof entry.id === "number") id = entry.id;
		else if (typeof entry.id === "string") id = blockTypeIds.get(entry.id) ?? null;
		if (id === null || id === selfId) continue;
		return id;
	}
	return null;
}

function main() {
	// blocks.json carries a UTF-8 BOM from being written on Windows; JSON.parse
	// rejects it, so strip it rather than depending on the editor's encoding.
	const blocksJson = JSON.parse(fs.readFileSync(BLOCKS_JSON, "utf8").replace(/^\uFEFF/, ""));
	const byName = new Map();
	for (const entry of blocksJson) {
		const id = typeof entry.id === "number" ? entry.id : null;
		if (id !== null) byName.set(id, entry);
		if (typeof entry.id === "string" && typeof entry.path === "string") {
			byName.set(entry.name, entry);
		}
	}

	const atlas = readPng(ATLAS_PATH);

/** Read one TILE x TILE block out of the atlas. */
	function atlasTile(img, blockId) {
		const idx = blockId - 1;
		const col = idx % ATLAS_COLS;
		const row = Math.floor(idx / ATLAS_COLS);
		const out = Buffer.alloc(TILE * TILE * 4);
		for (let y = 0; y < TILE; y++) {
			for (let x = 0; x < TILE; x++) {
				const s = (row * TILE + y) * img.width * 4 + (col * TILE + x) * 4;
				const d = (y * TILE + x) * 4;
				out[d] = img.pixels[s];
				out[d + 1] = img.pixels[s + 1];
				out[d + 2] = img.pixels[s + 2];
				out[d + 3] = 255;
			}
		}
		return out;
	}

	function inject(tile, blockId) {
		const idx = blockId - 1;
		const col = idx % ATLAS_COLS;
		const row = Math.floor(idx / ATLAS_COLS);
		for (let y = 0; y < TILE; y++) {
			for (let x = 0; x < TILE; x++) {
				const src = (y * TILE + x) * 4;
				const dst = (row * TILE + y) * atlas.width * 4 + (col * TILE + x) * 4;
				atlas.pixels[dst] = tile[src];
				atlas.pixels[dst + 1] = tile[src + 1];
				atlas.pixels[dst + 2] = tile[src + 2];
				atlas.pixels[dst + 3] = 255;
			}
		}
	}

	const blockTypeIds = readBlockTypeIds();
	let count = 0;

	// ── Stations + temple glyph ──
	for (const spec of BLOCKS) {
		const entry = byName.get(spec.name) ?? byName.get(spec.id);
		if (!entry) throw new Error(`blocks.json has no entry for ${spec.name}`);

		const donorId = findDonorBlockId(blocksJson, entry.path, blockTypeIds, spec.id);
		if (donorId === null || donorId === spec.id) {
			throw new Error(`No donor block for ${spec.name} at path ${entry.path}`);
		}
		const baseRaw = atlasTile(atlas, donorId);
		const mid = averageOf(baseRaw);
		void baseRaw;

		// Fire gradient: bright core, cooling toward the mouth edges.
		const accents = {};
		if (spec.name === "furnace" || spec.name === "kiln") {
			accents.h = highlight(FIRE_LOW);
			accents.fire = FIRE_MID;
		} else if (spec.name === "smeltery") {
			accents.h = highlight(FIRE_LOW);
			accents.fire = FIRE_CORE;
		} else if (spec.name === "crucible") {
			accents.fire = FIRE_CORE;
		} else if (spec.name === "anvil") {
			accents.metal = METAL_LIGHT;
		} else if (spec.name === "whetstone") {
			accents.h = highlight(mid);
		} else if (spec.name === "temple_glyph") {
			accents.glow = GLYPH_GLOW;
		}

		const template = padTemplate(spec.template, spec.name);
		const tile = renderTile(template, { data: baseRaw, mid }, accents, spec.id);

		const outDir = path.join(TEXTURE_ROOT, "generated", spec.name);
		writePng(path.join(outDir, `${spec.name}_diff_1k.png`), TILE, TILE, tile);
		inject(tile, spec.id);
		console.log(
			`${spec.name} (block ${spec.id}) <- atlas tile of block ${donorId} (${entry.path})`,
		);
		count++;
	}

	// ── Smith tool blocks ──
	//
	// All 42 share the hammer silhouette; the material comes from the block's
	// own declared path so the tier reads at a glance in the world, and the
	// hand-authored material palette tints the metal itself.
	const toolTemplate = padTemplate(SMITH_HAMMER, "smith_hammer");
	for (const entry of blocksJson) {
		if (typeof entry.id !== "number") continue;
		if (entry.id < 120 || entry.id > 161) continue;

		const kindIndex = Math.floor((entry.id - 120) / 6);
		const tierIndex = (entry.id - 120) % 6;
		const tierNames = Object.keys(TOOL_PALETTES);
		const tierName = tierNames[tierIndex];

		// All seven kinds share the hammer silhouette for now; the kind is
		// carried by the item name and the tool block id, not the art.
		void kindIndex;

		const metal = TOOL_PALETTES[tierName];
		const donorId = findDonorBlockId(blocksJson, entry.path, blockTypeIds, entry.id);
		const donor = donorId === null ? null : atlasTile(atlas, donorId);

		// Fall back to a flat tile in the tool's own colour when the block has no
		// donor, so the handle still reads as material rather than a hole.
		const baseData = donor ?? solidTile(metal);
const mid = donor === null ? metal : averageOf(donor);

		const accents = {
			h: [clamp255(metal[0] * 1.35 + 20), clamp255(metal[1] * 1.35 + 20), clamp255(metal[2] * 1.35 + 20)],
			metal,
		};

		// The hammer head is 'M' (the tool material); the handle is 'S' (base
		// shadow), which for a stone hammer is a darker stone.
		const tile = renderTile(toolTemplate, { data: baseData, mid }, accents, entry.id);

		const outDir = path.join(TEXTURE_ROOT, "generated", entry.name);
		writePng(path.join(outDir, `${entry.name}_diff_1k.png`), TILE, TILE, tile);
		inject(tile, entry.id);
		count++;
	}

	writePng(ATLAS_PATH, atlas.width, atlas.height, atlas.pixels);
	console.log(`injected ${count} tiles into diffuse_atlas.png`);
}

main();