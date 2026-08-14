/**
 * Frame-strip preview: render each anko motion as a sequence of frames in a
 * headless browser and compose horizontal PNG strips for review without
 * triggering every motion by hand. Output: frame-strips/<name>.png and
 * frame-strips/all.png.
 */
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.DSH_E2E_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE_URL = "http://127.0.0.1:3080/?dsh-pet=anko";
const OUT = new URL("../frame-strips/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const MOTIONS = [
	{ name: "nod", group: "TapBody", index: 0, frames: 8, stepMs: 200 },
	{ name: "shake", group: "Sad", index: 0, frames: 7, stepMs: 170 },
	{ name: "shy", group: "Shy", index: 0, frames: 8, stepMs: 220 },
	{ name: "drowse", group: "Drowse", index: 0, frames: 6, stepMs: 1200 },
	{ name: "idle-var", group: "IdleVar", index: 0, frames: 6, stepMs: 500 },
];

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "dsh-pet-strip-"));
const browser = await puppeteer.launch({
	executablePath: EDGE,
	headless: "new",
	userDataDir: profile,
	args: ["--enable-unsafe-swiftshader", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--mute-audio"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });

await page.goto(PAGE_URL, { waitUntil: "networkidle2", timeout: 90000 });
await page.waitForSelector(".dsh-pet-live2d", { timeout: 30000 });
await page.waitForFunction(() => window.__dshPetDebug?.model !== undefined, { timeout: 45000 });

const box = await page.$(".dsh-pet-live2d");
const strips = [];
for (const spec of MOTIONS) {
	// Park the pointer far away so gaze doesn't fight the motion, mark the
	// motion as owning the params, and trigger it.
	await page.evaluate(({ group, index }) => {
		window.dispatchEvent(new PointerEvent("pointermove", { clientX: 9999, clientY: 9999, bubbles: true }));
		const debug = window.__dshPetDebug;
		debug.overrides.current = {};
		debug.motionActive.current = { until: Date.now() + 10000 };
		debug.model.motion(group, index, 1);
	}, spec);
	const frames = [];
	for (let i = 0; i < spec.frames; i++) {
		await new Promise((r) => setTimeout(r, spec.stepMs));
		frames.push(await box.screenshot({ encoding: "binary" }));
	}
	// Compose the strip: frames side by side, uniform height.
	const metas = await Promise.all(frames.map((f) => sharp(f).metadata()));
	const height = 300;
	const resized = await Promise.all(frames.map((f) => sharp(f).resize({ height }).png().toBuffer()));
	const width = (await sharp(resized[0]).metadata()).width;
	const strip = sharp({ create: { width: width * spec.frames, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
		.composite(resized.map((buf, i) => ({ input: buf, left: i * width, top: 0 })))
		.png();
	await strip.toFile(join(OUT, `${spec.name}.png`));
	strips.push({ name: spec.name, width: width * spec.frames, buffer: await strip.toBuffer() });
	console.log(`strip: ${spec.name}.png (${spec.frames} frames)`);
}

// Montage: all strips stacked with a title bar per row.
const titleHeight = 28;
const maxWidth = Math.max(...strips.map((s) => s.width));
const all = sharp({
	create: {
		width: maxWidth,
		height: strips.length * (300 + titleHeight),
		channels: 4,
		background: { r: 16, g: 18, b: 24, alpha: 1 },
	},
});
const composites = [];
strips.forEach((s, i) => {
	const y = i * (300 + titleHeight);
	const label = Buffer.from(`<svg width="${maxWidth}" height="${titleHeight}" xmlns="http://www.w3.org/2000/svg"><text x="8" y="19" font-family="Consolas,monospace" font-size="15" fill="#eee">${s.name}</text></svg>`);
	composites.push({ input: label, left: 0, top: y });
	composites.push({ input: s.buffer, left: 0, top: y + titleHeight });
});
await all.composite(composites).png().toFile(join(OUT, "all.png"));
console.log(`montage: all.png`);
console.log(`done -> ${OUT}`);

await browser.close();
rmSync(profile, { recursive: true, force: true });
