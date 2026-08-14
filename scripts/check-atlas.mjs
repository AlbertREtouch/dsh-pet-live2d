import sharp from "sharp";

const meta = await sharp("sample-pet/spritesheet.webp").metadata();
console.log("atlas size:", `${meta.width}x${meta.height}`, "format:", meta.format);

const raw = await sharp("sample-pet/spritesheet.webp").ensureAlpha().raw().toBuffer();
const count = (x0, y0) => {
	let n = 0;
	for (let y = y0; y < y0 + 208; y++) for (let x = x0; x < x0 + 192; x++) {
		if (raw[((y * 1536) + x) * 4 + 3] > 12) n++;
	}
	return n;
};
const bbox = (x0, y0) => {
	let xmin = 192, xmax = -1, ymin = 208, ymax = -1;
	for (let y = 0; y < 208; y++) for (let x = 0; x < 192; x++) {
		if (raw[(((y0 + y) * 1536) + x0 + x) * 4 + 3] > 12) {
			if (x < xmin) xmin = x;
			if (x > xmax) xmax = x;
			if (y < ymin) ymin = y;
			if (y > ymax) ymax = y;
		}
	}
	return xmax < 0 ? "empty" : `${xmax - xmin + 1}x${ymax - ymin + 1}@(${xmin},${ymin})`;
};
console.log("idle(0,0) bbox:", bbox(0, 0));
console.log("run-right(1,0) bbox:", bbox(0, 208));
console.log("run-left(2,0) bbox:", bbox(0, 2 * 208));
console.log("jump row cells:");
for (let f = 0; f < 5; f++) console.log("  frame", f, "bbox:", bbox(f * 192, 4 * 208));
console.log("failed(5,0) bbox:", bbox(0, 5 * 208));
console.log("review(8,0) bbox:", bbox(0, 8 * 208));
console.log("blank pad (idle col7) px:", count(7 * 192, 0));
