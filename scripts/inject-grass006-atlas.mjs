// inject-grass006-atlas.mjs
// One-off: stitches Grass006 diffuse tile into diffuse_atlas.png at the slot
// for BlockType.Grass006 = 91 (atlasIndex = 90 -> col 14, row 5).
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ATLAS = path.join(ROOT, "public/texture/diffuse_atlas.png");
const SRC = path.join(ROOT, "public/texture/dirt/Grass006_1K/Grass006_diff_1K.png");

// --- minimal PNG decode/encode (RGBA, filter 0) ---
function readPng(filepath) {
	const buf = fs.readFileSync(filepath);
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG: " + filepath);
	let pos = 8, width = 0, height = 0, bitDepth = 8, colorType = 6;
	const idat = [];
	let palette = null, transparency = null;
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
		else if (type === "PLTE") { palette = data; }
		else if (type === "tRNS") { transparency = data; }
		else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		pos += 12 + len;
	}
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const channels = 4, stride = width * channels;
	const pixels = Buffer.alloc(width * height * channels);
	const channelsIn = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 3 ? 1 : 4;
	const bpp = channelsIn; // bytes per pixel in raw (filter operates per byte)
	let rp = 0;
	const outStride = width * bpp;
	const tmp = Buffer.alloc(height * outStride);
	for (let y = 0; y < height; y++) {
		const filter = raw[rp++];
		for (let x = 0; x < outStride; x++) {
			const cur = raw[rp++];
			const a = x >= bpp ? tmp[y * outStride + x - bpp] : 0;
			const b = y > 0 ? tmp[(y - 1) * outStride + x] : 0;
			const c = x >= bpp && y > 0 ? tmp[(y - 1) * outStride + x - bpp] : 0;
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
				default: throw new Error("PNG filter " + filter);
			}
			tmp[y * outStride + x] = val & 0xff;
		}
	}
	// Expand to RGBA
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const sin = y * outStride + x * bpp;
			const dout = (y * width + x) * 4;
			if (colorType === 6) {
				tmp.copy(pixels, dout, sin, sin + 4);
			} else if (colorType === 2) {
				pixels[dout] = tmp[sin]; pixels[dout + 1] = tmp[sin + 1]; pixels[dout + 2] = tmp[sin + 2]; pixels[dout + 3] = 255;
			} else if (colorType === 0) {
				pixels[dout] = pixels[dout + 1] = pixels[dout + 2] = tmp[sin]; pixels[dout + 3] = 255;
			} else if (colorType === 3) {
				const idx = tmp[sin];
				const po = idx * 3;
				pixels[dout] = palette[po]; pixels[dout + 1] = palette[po + 1]; pixels[dout + 2] = palette[po + 2];
				pixels[dout + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
			}
		}
	}
	return { width, height, channels, pixels };
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
	return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function writePng(filepath, width, height, rgba) {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	let wp = 0;
	for (let y = 0; y < height; y++) { raw[wp++] = 0; rgba.copy(raw, wp, y * stride, y * stride + stride); wp += stride; }
	const idat = zlib.deflateSync(raw);
	function chunk(type, data) {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
		const typeBuf = Buffer.from(type, "ascii");
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
		return Buffer.concat([len, typeBuf, data, crc]);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	fs.writeFileSync(filepath, Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]));
}

// --- do the work ---
const atlas = readPng(ATLAS);
const src = readPng(SRC);
const TILE = 25;

// tile 90 -> col 14, row 5 (atlasIndex = blockId - 1 = 90; 16 cols)
const blockId = 91;
const atlasIndex = blockId - 1;
const col = atlasIndex % 16;
const row = Math.floor(atlasIndex / 16);

// scale source (any size) down/up to TILE x TILE via nearest-neighbor
function blit(srcImg, dstImg, dstX, dstY, size) {
	const sw = srcImg.width, sh = srcImg.height;
	const sStride = sw * srcImg.channels;
	const dStride = dstImg.width * dstImg.channels;
	for (let y = 0; y < size; y++) {
		const sy = Math.min(sh - 1, Math.floor(y / size * sh));
		for (let x = 0; x < size; x++) {
			const sx = Math.min(sw - 1, Math.floor(x / size * sw));
			const s = sy * sStride + sx * srcImg.channels;
			const d = (dstY + y) * dStride + (dstX + x) * dstImg.channels;
			dstImg.pixels[d] = srcImg.pixels[s];
			dstImg.pixels[d + 1] = srcImg.pixels[s + 1];
			dstImg.pixels[d + 2] = srcImg.pixels[s + 2];
			dstImg.pixels[d + 3] = srcImg.pixels[s + 3];
		}
	}
}

blit(src, atlas, col * TILE, row * TILE, TILE);
writePng(ATLAS, atlas.width, atlas.height, atlas.pixels);
console.log(`Injected Grass006 into diffuse_atlas.png at tile col=${col} row=${row} (blockId ${blockId})`);
