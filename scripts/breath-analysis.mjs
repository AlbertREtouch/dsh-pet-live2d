/**
 * Breath-effect analysis: freeze every effective parameter via cockpit
 * overrides, then pixel-diff the render between ParamBreath = 0 and = 1 on a
 * grid — answers "which parts of the model does breathing move".
 */
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.DSH_E2E_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE_URL = "http://127.0.0.1:3080/?dsh-pet=anko";

const profile = mkdtempSync(join(tmpdir(), "dsh-pet-breath-"));
const browser = await puppeteer.launch({
	executablePath: EDGE,
	headless: "new",
	userDataDir: profile,
	args: ["--enable-unsafe-swiftshader", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--mute-audio"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto(PAGE_URL, { waitUntil: "networkidle2", timeout: 90000 });
await page.waitForFunction(() => window.__dshPetDebug?.model !== undefined, { timeout: 45000 });

const box = await page.$(".dsh-pet-live2d");

// Freeze everything effective except the parameter under test.
const freeze = (breath) => ({
	ParamAngleX: 0,
	ParamAngleY: 0,
	ParamAngleZ: 0,
	ParamEyeLOpen: 1,
	ParamEyeROpen: 1,
	ParamHairFront: 0,
	ParamBreath: breath,
});
const shot = async (breath) => {
	await page.evaluate((overrides) => {
		window.__dshPetDebug.overrides.current = overrides;
	}, freeze(breath));
	await new Promise((r) => setTimeout(r, 600));
	return box.screenshot({ encoding: "binary" });
};

const shotLo = await shot(0);
const shotHi = await shot(1);

// Noise floor: same overrides twice (breath=0 both times).
const shotCtlA = await shot(0);
const shotCtlB = await shot(0);

const diff = async (a, b) => {
	const { default: sharp2 } = await import("sharp");
	const [bufA, bufB] = await Promise.all([sharp2(a).ensureAlpha().raw().toBuffer(), sharp2(b).ensureAlpha().raw().toBuffer()]);
	const meta = await sharp2(a).metadata();
	const out = new Float32Array(bufA.length / 4);
	for (let i = 0; i < bufA.length; i += 4) {
		out[i / 4] = Math.abs(bufA[i] - bufB[i]) + Math.abs(bufA[i + 1] - bufB[i + 1]) + Math.abs(bufA[i + 2] - bufB[i + 2]);
	}
	return { out, width: meta.width, height: meta.height };
};

const signal = await diff(shotLo, shotHi);
const noise = await diff(shotCtlA, shotCtlB);

const COLS = 4;
const ROWS = 6;
const cellW = Math.floor(signal.width / COLS);
const cellH = Math.floor(signal.height / ROWS);
const rows = [];
for (let r = 0; r < ROWS; r++) {
	const row = [];
	for (let c = 0; c < COLS; c++) {
		let sig = 0;
		let nz = 0;
		let n = 0;
		for (let y = r * cellH; y < (r + 1) * cellH; y++) {
			for (let x = c * cellW; x < (c + 1) * cellW; x++) {
				const idx = y * signal.width + x;
				sig += signal.out[idx];
				nz += noise.out[idx];
				n++;
			}
		}
		row.push({ sig: Math.round(sig / n), nz: Math.round(nz / n), ratio: nz > 0 ? (sig / nz).toFixed(1) : "∞" });
	}
	rows.push(row);
}

console.log("网格(4列×6行，上→下)，每格 = 信号/噪声比（呼吸0↔1 差异 ÷ 无变化噪声）:");
console.log("            列1      列2      列3      列4");
const labels = ["顶部", "头/眼", "面部", "颈/胸", "躯干", "底部"];
rows.forEach((row, r) => {
	const cells = row.map((cell) => `${String(cell.ratio).padStart(6)} (${String(cell.sig).padStart(4)})`).join("  ");
	console.log(`${labels[r].padEnd(4)}: ${cells}`);
});
const totalSig = rows.flat().reduce((s, c) => s + c.sig, 0);
const totalNz = rows.flat().reduce((s, c) => s + c.nz, 0);
console.log(`整体: 信号 ${totalSig} / 噪声 ${totalNz} = ${(totalSig / Math.max(1, totalNz)).toFixed(2)}x`);

await browser.close();
rmSync(profile, { recursive: true, force: true });
