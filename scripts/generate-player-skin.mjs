/**
 * Generates public/texture/player/skin.png — a 64x64 Minecraft-layout skin
 * (classic base layer) painted procedurally so no external asset is needed.
 *
 * Run: node scripts/generate-player-skin.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZE = 64;
const px = new Uint8Array(SIZE * SIZE * 4);

const clamp = (v) => Math.max(0, Math.min(255, v | 0));

function setPx(x, y, [r, g, b], jitter = 0) {
	if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
	const i = (y * SIZE + x) * 4;
	px[i] = clamp(r + jitter);
	px[i + 1] = clamp(g + jitter);
	px[i + 2] = clamp(b + jitter);
	px[i + 3] = 255;
}

// Deterministic per-pixel noise so surfaces don't look flat.
const noise = (x, y) =>
	(((((x * 73856093) ^ (y * 19349663)) % 13) + 13) % 13) - 6;

function fill(x, y, w, h, color) {
	for (let j = 0; j < h; j++) {
		for (let i = 0; i < w; i++) {
			setPx(x + i, y + j, color, noise(x + i, y + j));
		}
	}
}

// ── Palette ─────────────────────────────────────────────────────────────────

const SKIN = [198, 138, 94];
const SKIN_DARK = [172, 116, 78];
const HAIR = [58, 42, 28];
const EYE_WHITE = [238, 238, 238];
const EYE_IRIS = [74, 63, 160];
const MOUTH = [120, 74, 48];
const SHIRT = [26, 163, 148]; // matches the game's player accent
const SHIRT_DARK = [20, 126, 114];
const PANTS = [61, 60, 110];
const SHOES = [84, 86, 92];

// ── Head (8x8 faces) ────────────────────────────────────────────────────────

fill(8, 0, 8, 8, HAIR); // top
fill(16, 0, 8, 8, SKIN_DARK); // bottom

for (const rx of [0, 16]) {
	// right / left sides: hair cap over skin
	fill(rx, 8, 8, 4, HAIR);
	fill(rx, 12, 8, 4, SKIN);
}

// back of head: hair down the neck
fill(24, 8, 8, 5, HAIR);
fill(24, 13, 8, 3, SKIN);

// front face (rect at 8,8; local fx/fy)
fill(8, 8, 8, 8, SKIN);
for (let i = 0; i < 8; i++) setPx(8 + i, 8, HAIR); // hairline row
for (let i = 0; i < 8; i++) setPx(8 + i, 9, HAIR); // fringe row
setPx(8, 10, HAIR); // sideburns
setPx(15, 10, HAIR);
setPx(9, 12, EYE_WHITE);
setPx(10, 12, EYE_IRIS);
setPx(13, 12, EYE_IRIS);
setPx(14, 12, EYE_WHITE);
setPx(11, 13, SKIN_DARK); // nose shade
setPx(12, 13, SKIN_DARK);
setPx(11, 14, MOUTH);
setPx(12, 14, MOUTH);

// ── Body (8 wide x 12 tall x 4 deep) ────────────────────────────────────────

fill(20, 16, 8, 4, SHIRT); // top
fill(28, 16, 8, 4, SHIRT_DARK); // bottom
for (const [bx, bw] of [
	[16, 4],
	[20, 8],
	[28, 4],
	[32, 8],
]) {
	fill(bx, 20, bw, 12, SHIRT);
	for (let j = 0; j < 12; j += 4) {
		// subtle horizontal weave stripes
		for (let i = 0; i < bw; i++) setPx(bx + i, 20 + j, SHIRT_DARK, 2);
	}
}
fill(20, 30, 8, 2, SHIRT_DARK); // hem

// ── Limb template (4x12 sides, 4x4 caps) ────────────────────────────────────

function paintLimb(ox, oy, upper, lower) {
	fill(ox + 4, oy, 4, 4, upper); // top cap
	fill(ox + 8, oy, 4, 4, lower); // bottom cap
	for (const sx of [ox, ox + 4, ox + 8, ox + 12]) {
		fill(sx, oy + 4, 4, 8, upper); // rows 0-8 of the side faces
		fill(sx, oy + 12, 4, 4, lower); // rows 9-12 (hands / shoes)
	}
}

paintLimb(0, 16, PANTS, SHOES); // right leg
paintLimb(16, 48, PANTS, SHOES); // left leg
paintLimb(40, 16, SHIRT, SKIN); // right arm (skin hand)
paintLimb(32, 48, SHIRT, SKIN); // left arm

// ── PNG encoding ────────────────────────────────────────────────────────────

let crcTable;
function crc32(buf) {
	crcTable ??= (() => {
		const t = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			t[n] = c >>> 0;
		}
		return t;
	})();
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++)
		c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const out = Buffer.alloc(8 + data.length + 4);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	data.copy(out, 8);
	out.writeUInt32BE(
		crc32(Buffer.concat([Buffer.from(type, "ascii"), data])),
		8 + data.length,
	);
	return out;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// compression / filter / interlace remain 0

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
	raw[y * (1 + SIZE * 4)] = 0; // filter: none
	Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(
		raw,
		y * (1 + SIZE * 4) + 1,
	);
}

const png = Buffer.concat([
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	chunk("IHDR", ihdr),
	chunk("IDAT", deflateSync(raw, { level: 9 })),
	chunk("IEND", Buffer.alloc(0)),
]);

const outPath = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../public/texture/player/skin.png",
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes)`);
