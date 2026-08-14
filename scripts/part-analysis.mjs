/**
 * Vertex-level part analysis: read the model's raw drawable meshes from the
 * Cubism Core and measure, per component, how much each parameter moves it.
 *
 * For the given parameter (default ParamBreath): freeze everything else via
 * cockpit overrides, sample the parameter at its min and max, then report per
 * drawable (render component) its vertex displacement and per part its opacity
 * delta — a precise "which components does this parameter move, by how much".
 *
 * Usage: node scripts/part-analysis.mjs [ParamName]
 */
import puppeteer from "puppeteer-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.DSH_E2E_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE_URL = "http://127.0.0.1:3080/?dsh-pet=anko";
const PARAM = process.argv[2] ?? "ParamBreath";
const MIN = process.argv[3] !== undefined ? Number(process.argv[3]) : 0;
const MAX = process.argv[4] !== undefined ? Number(process.argv[4]) : 1;

const profile = mkdtempSync(join(tmpdir(), "dsh-pet-part-"));
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

// Freeze all effective params except the one under test.
const freeze = (value) => ({
	ParamAngleX: 0,
	ParamAngleY: 0,
	ParamAngleZ: 0,
	ParamEyeLOpen: 1,
	ParamEyeROpen: 1,
	ParamHairFront: 0,
	[PARAM]: value,
});
const sample = async (value) => {
	await page.evaluate((overrides) => {
		window.__dshPetDebug.overrides.current = overrides;
	}, freeze(value));
	await new Promise((r) => setTimeout(r, 500));
	return page.evaluate(() => {
		const debug = window.__dshPetDebug;
		const coreModel = debug.model.internalModel.coreModel;
		const raw = coreModel._model; // Cubism Core Model object
		const drawables = raw.drawables;
		const count = drawables.count;
		const ids = drawables.ids; // string names per drawable
		const vertexCounts = drawables.vertexCounts;
		// Per-drawable Float32Array of deformed vertices (core keeps them fresh).
		const positions = [];
		for (let i = 0; i < count; i++) positions.push(Array.from(drawables.vertexPositions[i]));
		const opacities = Array.from(drawables.opacities);
		const partOpacities = Array.from(raw.parts.opacities);
		return { count, ids: [...ids], vertexCounts: [...vertexCounts], positions, opacities, partOpacities };
	});
};

const lo = await sample(MIN);
const hi = await sample(MAX);

// Per-drawable mean vertex displacement (model units).
const results = [];
for (let i = 0; i < lo.count; i++) {
	const n = lo.vertexCounts[i];
	let disp = 0;
	for (let k = 0; k < n; k++) {
		const dx = hi.positions[i][k * 2] - lo.positions[i][k * 2];
		const dy = hi.positions[i][k * 2 + 1] - lo.positions[i][k * 2 + 1];
		disp += Math.hypot(dx, dy);
	}
	results.push({ drawable: i, id: lo.ids[i], vertices: n, meanDisp: disp / n, opacityDelta: Math.abs((hi.opacities[i] ?? 1) - (lo.opacities[i] ?? 1)) });
}
results.sort((a, b) => b.meanDisp - a.meanDisp);

console.log(`参数 ${PARAM} (${MIN} → ${MAX}) 对各 drawable 组件的影响（顶点平均位移，模型单位）:`);
console.log("组件名                顶点数  平均位移  透明度变化");
for (const r of results.slice(0, 15)) {
	console.log(`  ${String(r.id).padEnd(20)} ${String(r.vertices).padStart(5)}   ${r.meanDisp.toFixed(4).padStart(8)}   ${r.opacityDelta.toFixed(3).padStart(8)}`);
}
const moved = results.filter((r) => r.meanDisp > 0.01);
const opacityChanged = results.filter((r) => r.opacityDelta > 0.001);
console.log(`\n总计: ${lo.count} 个 drawable，其中 ${moved.length} 个顶点位移 > 0.01，${opacityChanged.length} 个透明度变化 > 0.001`);
console.log(`part opacity 变化: ${lo.partOpacities.map((v, i) => (Math.abs((hi.partOpacities[i] ?? v) - v) > 0.001 ? `part#${i}: ${v.toFixed(3)}→${(hi.partOpacities[i] ?? v).toFixed(3)}` : null)).filter(Boolean).join(", ") || "无"}`);

await browser.close();
rmSync(profile, { recursive: true, force: true });
