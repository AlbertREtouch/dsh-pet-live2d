#!/usr/bin/env node
/**
 * pet-hatch atlas builder — turn one image into a Codex-compatible pet.
 *
 * Produces the same artifact the official Codex `hatch-pet` skill produces:
 *
 *   <out>/pet.json          { id, displayName, description, spritesheetPath }
 *   <out>/spritesheet.webp  1536x1872 atlas: 8 columns x 9 rows of 192x208
 *                           cells, transparent background (PNG when WebP
 *                           is unavailable).
 *
 * The 9 rows are Codex's animation contract:
 *   0 idle (6)   1 running-right (8)  2 running-left (8)  3 waving (4)
 *   4 jumping (5)  5 failed (8)  6 waiting (6)  7 running (6)  8 review (6)
 *
 * Runs with ZERO dependencies on PNG sources (bundled PNG codec). When the
 * `sharp` package is resolvable next to this script, JPEG/WebP/GIF sources
 * and WebP output are supported too.
 *
 * Usage:
 *   node build-atlas.mjs --source pet.png --name blobcat \
 *     --display-name "Blob Cat" --description "..." [--out dir] \
 *     [--chroma auto|#RRGGBB|none] [--format png|webp]
 */
import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// ── args ────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
	options: {
		source: { type: "string" },
		name: { type: "string" },
		"display-name": { type: "string" },
		description: { type: "string", default: "" },
		out: { type: "string" },
		chroma: { type: "string", default: "auto" },
		format: { type: "string", default: "webp" },
	},
});

const SOURCE = values.source;
const NAME = values.name;
if (SOURCE === undefined || NAME === undefined) {
	console.error("usage: build-atlas.mjs --source <image> --name <id> [--display-name <s>] [--description <s>] [--out <dir>] [--chroma auto|#RRGGBB|none] [--format png|webp]");
	process.exit(64);
}
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(NAME)) {
	console.error(`error: --name must be kebab-case ([a-z0-9-]), got ${JSON.stringify(NAME)}`);
	process.exit(64);
}
const DISPLAY_NAME = values["display-name"] ?? NAME;
const CHROMA = String(values.chroma).toLowerCase();
const FORMAT = values.format === "png" ? "png" : "webp";
const OUT = resolve(values.out ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "pets", NAME));

// ── optional sharp ──────────────────────────────────────────────────────────

let sharp = null;
try {
	sharp = (await import("sharp")).default;
} catch {
	/* pure-JS path */
}

// ── tiny PNG codec (pure JS) ────────────────────────────────────────────────

const CRC_TABLE = new Int32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c;
});
function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

/** Decode a non-interlaced PNG (gray/RGB/palette/grayA/RGBA, 1-16 bit). */
function decodePng(buf) {
	if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG file");
	let pos = 8;
	let width = 0, height = 0, bitDepth = 8, colorType = 6, interlace = 0;
	let palette = null, trns = null;
	const idat = [];
	while (pos + 8 <= buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + len);
		pos += 12 + len;
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8];
			colorType = data[9];
			interlace = data[12];
		} else if (type === "PLTE") palette = data;
		else if (type === "tRNS") trns = data;
		else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
	}
	if (width === 0 || height === 0) throw new Error("PNG missing IHDR");
	if (interlace !== 0) throw new Error("interlaced PNG is not supported — re-save without interlacing");
	const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
	const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
	const stride = Math.ceil((width * channels * bitDepth) / 8);
	const raw = inflateSync(Buffer.concat(idat));
	const out = Buffer.alloc(stride * height);
	const paeth = (a, b, c) => {
		const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
		return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
	};
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
		const cur = out.subarray(y * stride, (y + 1) * stride);
		for (let i = 0; i < stride; i++) {
			const left = i >= bpp ? cur[i - bpp] : 0;
			const up = prev !== null ? prev[i] : 0;
			const upLeft = prev !== null && i >= bpp ? prev[i - bpp] : 0;
			let v = row[i];
			if (filter === 1) v = (v + left) & 0xff;
			else if (filter === 2) v = (v + up) & 0xff;
			else if (filter === 3) v = (v + ((left + up) >> 1)) & 0xff;
			else if (filter === 4) v = (v + paeth(left, up, upLeft)) & 0xff;
			cur[i] = v;
		}
	}
	// Expand to RGBA8.
	const rgba = Buffer.alloc(width * height * 4);
	const bits = bitDepth < 8 ? bitDepth : bitDepth === 16 ? 8 : 8;
	const samplesPerByte = Math.floor(8 / bits);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let r, g, b, a = 255;
			if (bitDepth === 16) {
				const base = y * stride + x * channels * 2;
				const v = (c) => out[base + c * 2]; // take the high byte
				if (channels >= 3) [r, g, b] = [v(0), v(1), v(2)];
				else [r, g, b] = [v(0), v(0), v(0)];
				if (channels === 2 || channels === 4) a = v(channels - 1);
			} else if (bitDepth === 8) {
				const base = y * stride + x * channels;
				if (channels >= 3) [r, g, b] = [out[base], out[base + 1], out[base + 2]];
				else [r, g, b] = [out[base], out[base], out[base]];
				if (channels === 2 || channels === 4) a = out[base + channels - 1];
			} else {
				const bit = (x * channels) % 8 === 0 ? 7 : 7 - ((x * channels) % 8);
				const byteIdx = y * stride + Math.floor((x * channels) / 8);
				const byte = out[byteIdx];
				let sample = (byte >> bit) & ((1 << bits) - 1);
				sample = Math.round((sample * 255) / ((1 << bits) - 1));
				if (colorType === 3) {
					const pi = sample * 3;
					if (palette !== null && pi + 2 < palette.length) [r, g, b] = [palette[pi], palette[pi + 1], palette[pi + 2]];
					else [r, g, b] = [0, 0, 0];
					if (trns !== null && sample < trns.length) a = trns[sample];
				} else {
					[r, g, b] = [sample, sample, sample];
				}
			}
			if (colorType === 3 && bitDepth === 8) {
				const pi = out[y * stride + x] * 3;
				if (palette !== null && pi + 2 < palette.length) [r, g, b] = [palette[pi], palette[pi + 1], palette[pi + 2]];
				else [r, g, b] = [0, 0, 0];
				if (trns !== null && out[y * stride + x] < trns.length) a = trns[out[y * stride + x]];
			}
			const o = (y * width + x) * 4;
			rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
		}
	}
	return { width, height, data: rgba };
}

/** Encode RGBA8 to PNG (color type 6, bit depth 8, filter 0). */
function encodePng(width, height, rgba) {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ── canvas ops ──────────────────────────────────────────────────────────────

function canvas(w, h) {
	return { w, h, data: Buffer.alloc(w * h * 4) };
}
function clone(src) {
	const c = canvas(src.w, src.h);
	src.data.copy(c.data);
	return c;
}
function alphaAt(c, x, y) {
	return c.data[(y * c.w + x) * 4 + 3];
}

/** Chroma-key near `[r,g,b]` (fuzz 0-255) to transparent. */
function chromaKey(c, rgb, fuzz) {
	const [kr, kg, kb] = rgb;
	for (let i = 0; i < c.data.length; i += 4) {
		const dr = Math.abs(c.data[i] - kr), dg = Math.abs(c.data[i + 1] - kg), db = Math.abs(c.data[i + 2] - kb);
		if (Math.max(dr, dg, db) <= fuzz) c.data[i + 3] = 0;
	}
	return c;
}

/** Trim to the non-transparent bounding box (alpha > 12). */
function trim(c) {
	let x0 = c.w, y0 = c.h, x1 = -1, y1 = -1;
	for (let y = 0; y < c.h; y++) {
		for (let x = 0; x < c.w; x++) {
			if (alphaAt(c, x, y) > 12) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
		}
	}
	if (x1 < x0) return canvas(1, 1);
	const out = canvas(x1 - x0 + 1, y1 - y0 + 1);
	for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) {
		const s = ((y + y0) * c.w + (x + x0)) * 4;
		const d = (y * out.w + x) * 4;
		out.data[d] = c.data[s]; out.data[d + 1] = c.data[s + 1]; out.data[d + 2] = c.data[s + 2]; out.data[d + 3] = c.data[s + 3];
	}
	return out;
}

/** Nearest-neighbor scale. */
function scale(c, nw, nh) {
	const out = canvas(nw, nh);
	for (let y = 0; y < nh; y++) {
		const sy = Math.min(c.h - 1, Math.floor((y * c.h) / nh));
		for (let x = 0; x < nw; x++) {
			const sx = Math.min(c.w - 1, Math.floor((x * c.w) / nw));
			const s = (sy * c.w + sx) * 4;
			const d = (y * nw + x) * 4;
			out.data[d] = c.data[s]; out.data[d + 1] = c.data[s + 1]; out.data[d + 2] = c.data[s + 2]; out.data[d + 3] = c.data[s + 3];
		}
	}
	return out;
}

/** Aspect-fit into a w x h transparent cell (nearest sampling keeps hard pixel edges). */
function fitCell(c, w, h) {
	const s = Math.min(w / c.w, h / c.h);
	const nw = Math.max(1, Math.round(c.w * s));
	const nh = Math.max(1, Math.round(c.h * s));
	const scaled = scale(c, nw, nh);
	const out = canvas(w, h);
	const ox = Math.floor((w - nw) / 2);
	const oy = Math.floor((h - nh) / 2);
	for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
		const sIdx = (y * nw + x) * 4;
		const dIdx = ((y + oy) * w + (x + ox)) * 4;
		out.data[dIdx] = scaled.data[sIdx]; out.data[dIdx + 1] = scaled.data[sIdx + 1]; out.data[dIdx + 2] = scaled.data[sIdx + 2]; out.data[dIdx + 3] = scaled.data[sIdx + 3];
	}
	return out;
}

/** Paste at an integer offset (transparent fill, clamped). */
function shift(c, dx, dy) {
	const out = canvas(c.w, c.h);
	for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
		const sx = x - dx, sy = y - dy;
		if (sx < 0 || sy < 0 || sx >= c.w || sy >= c.h) continue;
		const s = (sy * c.w + sx) * 4;
		const d = (y * c.w + x) * 4;
		out.data[d] = c.data[s]; out.data[d + 1] = c.data[s + 1]; out.data[d + 2] = c.data[s + 2]; out.data[d + 3] = c.data[s + 3];
	}
	return out;
}

/** Horizontal mirror. */
function flipH(c) {
	const out = canvas(c.w, c.h);
	for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
		const s = (y * c.w + (c.w - 1 - x)) * 4;
		const d = (y * c.w + x) * 4;
		out.data[d] = c.data[s]; out.data[d + 1] = c.data[s + 1]; out.data[d + 2] = c.data[s + 2]; out.data[d + 3] = c.data[s + 3];
	}
	return out;
}

/** Small-angle rotation (degrees, nearest sampling, about the center). */
function rotate(c, degrees) {
	const rad = (degrees * Math.PI) / 180;
	const cos = Math.cos(rad), sin = Math.sin(rad);
	const cx = (c.w - 1) / 2, cy = (c.h - 1) / 2;
	const out = canvas(c.w, c.h);
	for (let y = 0; y < c.h; y++) {
		for (let x = 0; x < c.w; x++) {
			const dx = x - cx, dy = y - cy;
			const sx = Math.round(cx + dx * cos + dy * sin);
			const sy = Math.round(cy - dx * sin + dy * cos);
			if (sx < 0 || sy < 0 || sx >= c.w || sy >= c.h) continue;
			const s = (sy * c.w + sx) * 4;
			const d = (y * c.w + x) * 4;
			out.data[d] = c.data[s]; out.data[d + 1] = c.data[s + 1]; out.data[d + 2] = c.data[s + 2]; out.data[d + 3] = c.data[s + 3];
		}
	}
	return out;
}

/** Vertical squash about the center (sy < 1 flattens). */
function squash(c, sy) {
	const cy = (c.h - 1) / 2;
	const out = canvas(c.w, c.h);
	for (let y = 0; y < c.h; y++) {
		const sy2 = Math.round(cy + (y - cy) / sy);
		if (sy2 < 0 || sy2 >= c.h) continue;
		for (let x = 0; x < c.w; x++) {
			const s = (sy2 * c.w + x) * 4;
			const d = (y * c.w + x) * 4;
			out.data[d] = c.data[s]; out.data[d + 1] = c.data[s + 1]; out.data[d + 2] = c.data[s + 2]; out.data[d + 3] = c.data[s + 3];
		}
	}
	return out;
}

// ── animation contract ──────────────────────────────────────────────────────

const CELL_W = 192, CELL_H = 208, COLS = 8;
/** Each row: per-frame micro-transform specs (leading frames; rest blank). */
const ROWS = [
	["base", "shift:0:-1", "squash:0.97", "base", "shift:0:1", "squash:0.97"], // 0 idle (6)
	["shift:1:0", "shift:2:-1", "shift:1:0", "base", "shift:-1:0", "shift:-2:-1", "shift:-1:0", "base"], // 1 running-right (8)
	null, // 2 running-left = mirror of row 1
	["base", "rotate:3", "shift:0:-2", "rotate:-3"], // 3 waving (4)
	["shift:0:2", "shift:0:-4", "shift:0:-10", "shift:0:-4", "base"], // 4 jumping (5)
	["base", "shift:0:1", "squash:0.9", "shift:0:2", "rotate:-3", "squash:0.92", "rotate:3", "base"], // 5 failed (8)
	["base", "base", "shift:0:-1", "base", "base", "shift:0:1"], // 6 waiting (6)
	["base", "shift:0:-1", "rotate:2", "shift:0:-1", "rotate:-2", "base"], // 7 running (6)
	["rotate:-3", "base", "rotate:3", "base", "rotate:-2", "base"], // 8 review (6)
];

function applyTransform(src, spec) {
	if (spec === "base") return clone(src);
	if (spec === "flip") return flipH(src);
	if (spec.startsWith("shift:")) {
		const [, x, y] = spec.split(":");
		return shift(src, Number(x), Number(y));
	}
	if (spec.startsWith("rotate:")) return rotate(src, Number(spec.slice(7)));
	if (spec.startsWith("squash:")) return squash(src, Number(spec.slice(7)));
	throw new Error(`unknown transform: ${spec}`);
}

function buildRow(cell, specs) {
	const frames = specs.map((spec) => applyTransform(cell, spec));
	while (frames.length < COLS) frames.push(canvas(CELL_W, CELL_H));
	const row = canvas(CELL_W * COLS, CELL_H);
	frames.forEach((frame, i) => {
		for (let y = 0; y < CELL_H; y++) for (let x = 0; x < CELL_W; x++) {
			const s = (y * CELL_W + x) * 4;
			const d = (y * (CELL_W * COLS) + (i * CELL_W + x)) * 4;
			row.data[d] = frame.data[s]; row.data[d + 1] = frame.data[s + 1]; row.data[d + 2] = frame.data[s + 2]; row.data[d + 3] = frame.data[s + 3];
		}
	});
	return row;
}

// ── main ────────────────────────────────────────────────────────────────────

let source;
if (sharp !== null) {
	source = await sharp(readFileSync(SOURCE)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	source = { width: source.info.width, height: source.info.height, data: Buffer.from(source.data) };
} else {
	const ext = SOURCE.toLowerCase().slice(SOURCE.toLowerCase().lastIndexOf("."));
	if (ext !== ".png") {
		console.error("error: pure-JS path reads PNG only (JPEG/WebP/GIF need `sharp`). Install sharp next to this script or re-save the source as PNG.");
		process.exit(65);
	}
	source = decodePng(readFileSync(SOURCE));
}

let cell = canvas(source.width, source.height);
source.data.copy(cell.data);

if (CHROMA !== "none") {
	let key = null;
	if (CHROMA === "auto") {
		// Most frequent corner color = background key.
		const corners = [];
		const sample = (x, y) => {
			const i = (y * cell.w + x) * 4;
			corners.push([cell.data[i], cell.data[i + 1], cell.data[i + 2]]);
		};
		for (const [x, y] of [[0, 0], [cell.w - 1, 0], [0, cell.h - 1], [cell.w - 1, cell.h - 1]]) sample(x, y);
		const counts = new Map();
		for (const c of corners) {
			const k = c.join(",");
			counts.set(k, (counts.get(k) ?? 0) + 1);
		}
		key = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
		console.log(`chroma: auto keyed on corner color rgb(${key.join(",")})`);
	} else if (/^#[0-9a-f]{6}$/.test(CHROMA)) {
		key = [parseInt(CHROMA.slice(1, 3), 16), parseInt(CHROMA.slice(3, 5), 16), parseInt(CHROMA.slice(5, 7), 16)];
	} else {
		console.error(`error: --chroma must be auto, none, or #RRGGBB, got ${JSON.stringify(values.chroma)}`);
		process.exit(64);
	}
	if (key !== null) chromaKey(cell, key, Math.round(255 * 0.18));
}

cell = trim(cell);
console.log(`sprite bbox: ${cell.w}x${cell.h}`);
cell = fitCell(cell, CELL_W, CELL_H);

const strips = ROWS.map((specs, row) => {
	if (specs === null) return null; // running-left: mirror after building row 1
	return buildRow(cell, specs);
});
strips[2] = flipH(strips[1]);

const atlas = canvas(CELL_W * COLS, CELL_H * 9);
strips.forEach((row, r) => {
	for (let y = 0; y < CELL_H; y++) for (let x = 0; x < CELL_W * COLS; x++) {
		const s = (y * (CELL_W * COLS) + x) * 4;
		const d = ((r * CELL_H + y) * (CELL_W * COLS) + x) * 4;
		atlas.data[d] = row.data[s]; atlas.data[d + 1] = row.data[s + 1]; atlas.data[d + 2] = row.data[s + 2]; atlas.data[d + 3] = row.data[s + 3];
	}
});

mkdirSync(OUT, { recursive: true });
const spriteName = FORMAT === "webp" && sharp !== null ? "spritesheet.webp" : "spritesheet.png";
if (spriteName.endsWith(".webp")) {
	writeFileSync(join(OUT, spriteName), await sharp(atlas.data, { raw: { width: atlas.w, height: atlas.h, channels: 4 } }).webp({ quality: 90, alphaQuality: 100 }).toBuffer());
} else {
	writeFileSync(join(OUT, spriteName), encodePng(atlas.w, atlas.h, atlas.data));
}
if (FORMAT === "webp" && sharp === null) console.log("note: sharp unavailable — wrote spritesheet.png instead of .webp");

const manifest = {
	id: NAME,
	displayName: DISPLAY_NAME,
	description: values.description,
	spritesheetPath: spriteName,
};
writeFileSync(join(OUT, "pet.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`pet hatched at ${OUT}`);
console.log(`  ${spriteName}  ${atlas.w}x${atlas.h} (${COLS}x9 cells of ${CELL_W}x${CELL_H})`);
