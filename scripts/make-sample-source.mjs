/**
 * Draw the sample pet source — a chunky pixel kitten on a transparent
 * background — and write it to sample-source.png.
 *
 * Pure Node (tiny PNG encoder inline); uses sharp when resolvable.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PALETTE = {
	".": null, // transparent
	"X": [125, 146, 196], // body blue
	"B": [125, 146, 196], // body blue
	"D": [90, 107, 147], // darker shade (ear inner / outline hint)
	"E": [43, 50, 69], // eye
	"N": [232, 155, 180], // nose pink
	"W": [242, 240, 234], // white paw / belly
};

// 32 wide x 30 tall; every row must be exactly 32 chars.
const ART = [
	"..........X..........X..........",
	".........XX..........XX.........",
	".........XXX........XXX.........",
	"........XXXX........XXXX........",
	"........XXXX........XXXX........",
	".......XXXXX........XXXXX.......",
	".......XXXXXXXXXXXXXXXXXX.......",
	"......XXXXXXXXXXXXXXXXXXXX......",
	"......XXXXXXXXXXXXXXXXXXXX......",
	"......XXXXXXXXXXXXXXXXXXXX......",
	".....XXXXXXXXXXXXXXXXXXXXXX.....",
	".....XXXXEEXXXXXXXXXXEEXXXX.....",
	".....XXXXEEXXXXXXXXXXEEXXXX.....",
	".....XXXXXEXXXXXXXXXXEXXXXX.....",
	".....XXXXXXXXXXXXXXXXXXXXXX.....",
	"......XXXXXXXXXXXXXXXXXXXX......",
	"..............NN................",
	".......XXXXXXXXXXXXXXXXXX.......",
	"........XXXXXXXXXXXXXX..........",
	".........XXXXXXXXXXXX...........",
	".........XXXWWWWWWXXX...........",
	"........XXXXXXXXXXXXXX..........",
	"........XXXXXXXXXXXXXX..........",
	"........XXXXXXXXXXXXXX..........",
	".........XXXXXXXXXXXX...........",
	".........XX..........XX.........",
	".........XX..........XX.........",
	"........XX............XX........",
	"................................",
	"................................",
];

const SCALE = 5;
const W = 32, H = ART.length;
const OUT_W = W * SCALE, OUT_H = H * SCALE;
const rgba = Buffer.alloc(OUT_W * OUT_H * 4);

for (let y = 0; y < H; y++) {
	const row = ART[y];
	if (row.length !== W) throw new Error(`art row ${y} is ${row.length} chars, expected ${W}`);
	for (let x = 0; x < W; x++) {
		const color = PALETTE[row[x]];
		if (color === null) continue;
		for (let dy = 0; dy < SCALE; dy++) {
			for (let dx = 0; dx < SCALE; dx++) {
				const i = ((y * SCALE + dy) * OUT_W + (x * SCALE + dx)) * 4;
				rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = 255;
			}
		}
	}
}

const out = join(import.meta.dirname, "..", "sample-source.png");
let sharp = null;
try {
	sharp = (await import("sharp")).default;
} catch {
	/* pure path */
}
if (sharp !== null) {
	await sharp(rgba, { raw: { width: OUT_W, height: OUT_H, channels: 4 } }).png().toFile(out);
} else {
	writeFileSync(out, encodePng(OUT_W, OUT_H, rgba));
}
console.log(`sample source written: ${out} (${OUT_W}x${OUT_H})`);

/** Minimal PNG encoder (RGBA8, filter 0) — only used without sharp. */
function encodePng(w, h, data) {
	const CRC_TABLE = new Int32Array(256).map((_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c;
	});
	const crc32 = (buf) => {
		let c = -1;
		for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
		return (c ^ -1) >>> 0;
	};
	const chunk = (type, d) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(d.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), d]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const stride = w * 4;
	const raw = Buffer.alloc((stride + 1) * h);
	for (let y = 0; y < h; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
