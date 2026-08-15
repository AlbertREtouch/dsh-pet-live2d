/**
 * make-tray-icon: generate the 32x32 RGBA tray icon used by the Electron
 * shell (electron/tray.png). Zero dependencies — a hand-rolled PNG encoder
 * plus node:zlib, deterministic on every platform.
 *
 * The glyph is deliberately simple (a dark cat head with white eyes) so it
 * stays legible at 16px taskbar scale on both light and dark system themes.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 32;

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const typeBuffer = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([typeBuffer, data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

// RGBA scanlines, each prefixed with filter byte 0.
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y += 1) {
	const rowStart = y * (1 + SIZE * 4);
	raw[rowStart] = 0; // filter: none
	for (let x = 0; x < SIZE; x += 1) {
		const offset = rowStart + 1 + x * 4;
		const head = inCircle(x + 0.5, y + 0.5, 16, 17, 13.5);
		const earLeft = inCircle(x + 0.5, y + 0.5, 8.5, 6.5, 5.5);
		const earRight = inCircle(x + 0.5, y + 0.5, 23.5, 6.5, 5.5);
		const eye = inCircle(x + 0.5, y + 0.5, 11.5, 14.5, 2.8) || inCircle(x + 0.5, y + 0.5, 20.5, 14.5, 2.8);
		const pupil = inCircle(x + 0.5, y + 0.5, 11.5, 14.5, 1.4) || inCircle(x + 0.5, y + 0.5, 20.5, 14.5, 1.4);
		const mouth = inCircle(x + 0.5, y + 0.5, 16, 20.5, 1.6) && y < 21;
		if (!head && !earLeft && !earRight) continue; // transparent
		raw[offset] = 43; // R
		raw[offset + 1] = 52; // G
		raw[offset + 2] = 64; // B
		raw[offset + 3] = 255; // A
		if (eye) {
			raw[offset] = 255;
			raw[offset + 1] = 255;
			raw[offset + 2] = 255;
			raw[offset + 3] = 255;
		}
		if (pupil) {
			raw[offset] = 20;
			raw[offset + 1] = 22;
			raw[offset + 2] = 27;
		}
		if (mouth) {
			raw[offset] = 236;
			raw[offset + 1] = 154;
			raw[offset + 2] = 173;
		}
	}
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
// compression/filter/interlace remain 0

const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	chunk("IHDR", ihdr),
	chunk("IDAT", deflateSync(raw, { level: 9 })),
	chunk("IEND", Buffer.alloc(0)),
]);

const outfile = join(dirname(fileURLToPath(import.meta.url)), "..", "electron", "tray.png");
mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(outfile, png);
console.log(`tray icon written: ${outfile} (${png.length} bytes)`);
