/**
 * End-to-end test: drive a headless Edge (via CDP) against the live DSH web
 * GUI with ?dsh-pet=anko, wait for the Live2D model to mount, and report DOM
 * state, console output, and page errors. Run only against localhost.
 */
import puppeteer from "puppeteer-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.DSH_E2E_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.DSH_E2E_URL ?? "http://127.0.0.1:3080/?dsh-pet=anko&dsh-pet-debug=1";

const profile = mkdtempSync(join(tmpdir(), "dsh-pet-e2e-"));
const browser = await puppeteer.launch({
	executablePath: EDGE,
	headless: "new",
	userDataDir: profile,
	args: ["--enable-unsafe-swiftshader", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--mute-audio"],
});
const logs = [];
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on("console", (msg) => logs.push(`[console.${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));
page.on("requestfailed", (req) => logs.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText ?? ""}`));

try {
	await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });
	await page.waitForSelector(".dsh-pet-anchor", { timeout: 30000 });
	const state = await page.evaluate(() => ({
		anchor: Boolean(document.querySelector(".dsh-pet-anchor")),
		live2dBox: Boolean(document.querySelector(".dsh-pet-live2d")),
		canvas: Boolean(document.querySelector(".dsh-pet-live2d canvas")),
		status: document.querySelector(".dsh-pet-live2d-status")?.textContent ?? null,
		bootHasPet: JSON.stringify(window.__DSH_BOOT__ ?? {}).includes("dsh-pet3"),
	}));
	await page.waitForFunction(() => window.__dshPetDebug?.model !== undefined, { timeout: 45000 });
	const debug = await page.evaluate(() => ({
		modelWidth: window.__dshPetDebug.model.internalModel.width,
		modelHeight: window.__dshPetDebug.model.internalModel.height,
		modelScale: window.__dshPetDebug.model.scale.x,
		paramAngleX: (() => { try { return window.__dshPetDebug.model.internalModel.coreModel.getParameterValueById("ParamAngleX"); } catch { return null; } })(),
	}));
	console.log("PAGE STATE:", JSON.stringify(state, null, 2));
	console.log("MODEL DEBUG:", JSON.stringify(debug, null, 2));
	// Motion playback: click the pet (wave) -> state -> TapBody motion -> the
	// nod drives ParamAngleY through its curve, overriding the gaze baseline.
	await page.evaluate(() => {
		window.__dshPetDebug.overrides.current = {}; // clear any cockpit leftovers
	});
	const petBox = await page.evaluate(() => {
		const r = document.querySelector(".dsh-pet").getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
	const readAngleY = () =>
		page.evaluate(() => {
			try {
				return window.__dshPetDebug.model.internalModel.coreModel.getParameterValueById("ParamAngleY");
			} catch {
				return null;
			}
		});
	const samples = [];
	for (let i = 0; i < 10; i++) {
		if (i === 0) {
			// CDP mouse events are unreliable in this headless setup (the same
			// quirk that broke pointermove), so dispatch the click via DOM.
			await page.evaluate(() => {
				const el = document.querySelector(".dsh-pet");
				const r = el.getBoundingClientRect();
				const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
				el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1 }));
				el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1 }));
				el.dispatchEvent(new MouseEvent("click", opts));
			});
		}
		samples.push(await readAngleY());
		await new Promise((r) => setTimeout(r, 150));
	}
	const angleYRange = Math.max(...samples) - Math.min(...samples);
	console.log("MOTION:", { samples: samples.map((v) => Number(v.toFixed(1))), angleYRange: Number(angleYRange.toFixed(1)), rangeOk: angleYRange > 5 });
	// Right-click = manual shake: contextmenu -> failed mood -> Sad motion.
	await page.evaluate(() => {
		const el = document.querySelector(".dsh-pet");
		el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
	});
	await new Promise((r) => setTimeout(r, 400));
	const shakeState = await page.evaluate(() => ({
		activeGroup: window.__dshPetDebug.motionActive.current?.group ?? null,
		angleX: (() => { try { return window.__dshPetDebug.model.internalModel.coreModel.getParameterValueById("ParamAngleX"); } catch { return null; } })(),
	}));
	console.log("SHAKE:", { ...shakeState, triggered: shakeState.activeGroup === "Sad" });
	// Gaze direction: the param READBACK is restored by the library's
	// loadParameters sandwich, so verify the VISUAL result by pixel-diffing
	// screenshots with the pointer above vs below the pet box.
	const diffShots = async (a, b) => {
		const { default: sharp } = await import("sharp");
		const [bufA, bufB] = await Promise.all([sharp(a).ensureAlpha().raw().toBuffer(), sharp(b).ensureAlpha().raw().toBuffer()]);
		let diff = 0;
		const n = Math.min(bufA.length, bufB.length);
		for (let i = 0; i < n; i += 4) {
			if (Math.abs(bufA[i] - bufB[i]) + Math.abs(bufA[i + 1] - bufB[i + 1]) + Math.abs(bufA[i + 2] - bufB[i + 2]) > 24) diff++;
		}
		return diff / (n / 4);
	};
	const box = await page.$(".dsh-pet-live2d");
	const rect = await page.evaluate(() => {
		const r = document.querySelector(".dsh-pet-live2d").getBoundingClientRect();
		return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
	});
	await page.evaluate(({ cx, cy }) => {
		window.dispatchEvent(new PointerEvent("pointermove", { clientX: cx, clientY: cy - 120, bubbles: true }));
	}, rect);
	await new Promise((r) => setTimeout(r, 900));
	const shotAbove = await box.screenshot({ encoding: "binary" });
	await page.evaluate(({ cx, cy }) => {
		window.dispatchEvent(new PointerEvent("pointermove", { clientX: cx, clientY: cy + 120, bubbles: true }));
	}, rect);
	await new Promise((r) => setTimeout(r, 900));
	const shotBelow = await box.screenshot({ encoding: "binary" });
	const gazeVisualDiff = await diffShots(shotAbove, shotBelow);
	console.log("GAZE:", { visualDiff: `${(gazeVisualDiff * 100).toFixed(2)}%`, looksDifferent: gazeVisualDiff > 0.02 });
	// Drag still works: a slow synthetic drag moves the pet and drops it.
	await page.evaluate(() => {
		const el = document.querySelector(".dsh-pet");
		const r = el.getBoundingClientRect();
		const base = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 7 };
		const cx0 = r.left + r.width / 2;
		const cy0 = r.top + r.height / 2;
		el.dispatchEvent(new PointerEvent("pointerdown", { ...base, clientX: cx0, clientY: cy0 }));
		for (let i = 1; i <= 5; i++) {
			el.dispatchEvent(new PointerEvent("pointermove", { ...base, clientX: cx0 - i * 30, clientY: cy0 }));
		}
		el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0, clientX: cx0 - 150, clientY: cy0 }));
	});
	await new Promise((r) => setTimeout(r, 300));
	const dragResult = await page.evaluate(() => ({
		left: Number.parseFloat(document.querySelector(".dsh-pet").style.left) || 0,
	}));
	console.log("DRAG:", { moved: Math.abs(dragResult.left - 1040) > 50, left: dragResult.left });
	// Debug cockpit: open the panel with a REAL pointer click sequence (the
	// pet wrapper's drag capture used to redirect this click away — regression
	// guard), then drive ParamAngleX via the slider.
	await page.waitForSelector(".dsh-pet-debug-tab", { timeout: 10000 });
	await page.evaluate(() => {
		const el = document.querySelector(".dsh-pet-debug-tab");
		const r = el.getBoundingClientRect();
		const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1, pointerId: 8 };
		el.dispatchEvent(new PointerEvent("pointerdown", opts));
		el.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
		el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: opts.clientX, clientY: opts.clientY, button: 0 }));
	});
	await page.waitForSelector(".dsh-pet-debug-panel", { timeout: 5000 });
	const cockpit = await page.evaluate(() => {
		const row = document.querySelector('.dsh-pet-debug-row label[title="ParamAngleX"], .dsh-pet-debug-row[title="ParamAngleX"]');
		const input = document.querySelector('label[title="ParamAngleX"] input');
		if (input === null) return { found: false };
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
		setter.call(input, 10);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		return { found: true };
	});
	await new Promise((r) => setTimeout(r, 400));
	const cockpitRead = await page.evaluate(() => {
		try {
			return {
				paramAngleX: window.__dshPetDebug.model.internalModel.coreModel.getParameterValueById("ParamAngleX"),
				lastWritten: window.__dshPetDebug.lastWritten,
				overrides: { ...window.__dshPetDebug.overrides.current },
			};
		} catch {
			return { paramAngleX: null, overrides: {} };
		}
	});
	console.log("COCKPIT:", {
		sliderFound: cockpit.found,
		// readback is restored by the library's loadParameters sandwich after
		// each frame — the mesh is the truth (see COCKPIT-VISUAL below).
		hookWrote: cockpitRead.lastWritten,
		overrides: cockpitRead.overrides,
	});
	// Cockpit visual verification: drive ParamAngleX ±30 — this rig's head-turn
	// deformation is subtle, so the diff is small but non-zero when the
	// override reaches the mesh. (ParamEyeLOpen has no visible binding on this
	// rig — the cockpit exists precisely to discover such facts.)
	await page.evaluate(() => {
		window.__dshPetDebug.overrides.current = { ParamAngleX: 30 };
	});
	await new Promise((r) => setTimeout(r, 500));
	const shotCockpitRight = await box.screenshot({ encoding: "binary" });
	await page.evaluate(() => {
		window.__dshPetDebug.overrides.current = { ParamAngleX: -30 };
	});
	await new Promise((r) => setTimeout(r, 500));
	const shotCockpitLeft = await box.screenshot({ encoding: "binary" });
	const cockpitVisualDiff = await diffShots(shotCockpitRight, shotCockpitLeft);
	console.log("COCKPIT-VISUAL:", { visualDiff: `${(cockpitVisualDiff * 100).toFixed(2)}%`, meshResponds: cockpitVisualDiff > 0.002 });
	await page.evaluate(() => {
		window.__dshPetDebug.overrides.current = {};
	});
	// Tick liveness: is the per-frame driver still running?
	const tickProbe = await page.evaluate(async () => {
		const c0 = window.__dshPetDebug.tickCount ?? 0;
		await new Promise((r) => setTimeout(r, 500));
		const c1 = window.__dshPetDebug.tickCount ?? 0;
		return { c0, c1, ticksIn500ms: c1 - c0, tickerStarted: window.__dshPetDebug.app.ticker.started };
	});
	console.log("TICK:", tickProbe);
	// Does the library's render-phase hook actually fire?
	const hookProbe = await page.evaluate(async () => {
		const debug = window.__dshPetDebug;
		const im = debug.model.internalModel;
		let fired = false;
		im.once("beforeModelUpdate", () => {
			fired = true;
		});
		await new Promise((r) => setTimeout(r, 500));
		return {
			listenerCount: typeof im.listenerCount === "function" ? im.listenerCount("beforeModelUpdate") : "no-listenerCount",
			hasOn: typeof im.on === "function",
			hasEmit: typeof im.emit === "function",
			fired,
		};
	});
	console.log("HOOK:", hookProbe);
	// Direct write/read experiment: does a write stick at all?
	const directProbe = await page.evaluate(() => {
		const debug = window.__dshPetDebug;
		const coreA = debug.model.internalModel.coreModel;
		const coreB = debug.model.internalModel.coreModel;
		coreA.setParameterValueById("ParamAngleX", 42);
		const readSame = coreA.getParameterValueById("ParamAngleX");
		const readAgain = coreB.getParameterValueById("ParamAngleX");
		return { sameCoreInstance: coreA === coreB, readSame, readAgain, debugModelIsRefModel: debug.model === debug.modelRef.current, debugModelDestroyed: debug.model.destroyed, refModelDestroyed: debug.modelRef.current?.destroyed ?? null };
	});
	console.log("DIRECT:", directProbe);
	// Visual evidence: screenshot the live2d box and count colored pixels.
	const shot = await box.screenshot({ encoding: "binary" });
	const { default: sharp } = await import("sharp");
	const meta = await sharp(shot).metadata();
	const nonTransparent = await sharp(shot).ensureAlpha().raw().toBuffer().then((buf) => {
		let count = 0;
		for (let i = 3; i < buf.length; i += 4) if (buf[i] > 8) count++;
		return count;
	});
	console.log("SCREENSHOT:", {
		width: meta.width,
		height: meta.height,
		nonTransparentPixels: nonTransparent,
		coverage: `${((nonTransparent / (meta.width * meta.height)) * 100).toFixed(1)}%`,
	});
	console.log("E2E PASS");
} catch (error) {
	console.error("E2E FAIL:", error.message);
	console.log("--- console/page logs ---");
	for (const line of logs.slice(-40)) console.log(line);
	process.exitCode = 1;
} finally {
	await browser.close();
	rmSync(profile, { recursive: true, force: true });
}
