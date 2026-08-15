/**
 * e2e-sprite: headless Edge regression against the live DSH web GUI with a
 * pixel sprite pet. Verifies the plugin boot path, overlay mount, sprite
 * rendering, drag persistence, and absence of page errors. Complements
 * e2e-live2d.mjs (which needs a Live2D model installed).
 */
import puppeteer from "puppeteer-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.DSH_E2E_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.DSH_E2E_URL ?? "http://127.0.0.1:3080/?dsh-pet=dsh-kitten";

const profile = mkdtempSync(join(tmpdir(), "dsh-pet-sprite-e2e-"));
const browser = await puppeteer.launch({
	executablePath: EDGE,
	headless: "new",
	userDataDir: profile,
	protocolTimeout: 300000,
	args: ["--enable-unsafe-swiftshader", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--mute-audio"],
});
const logs = [];
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on("console", (msg) => logs.push(`[console.${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));
page.on("requestfailed", (req) => logs.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText ?? ""}`));

try {
	await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
	await new Promise((r) => setTimeout(r, 60000));
	const boot = await page.evaluate(() => {
		const boot = window.__DSH_BOOT__ ?? {};
		return {
			keys: Object.keys(boot),
			hasPet: JSON.stringify(boot).includes("dsh-pet"),
			hasAnchor: Boolean(document.querySelector(".dsh-pet-anchor")),
			bodyTextStart: (document.body?.innerText ?? "").slice(0, 120),
		};
	});
	console.log("BOOT:", JSON.stringify(boot, null, 2));
	await page.waitForSelector(".dsh-pet", { timeout: 45000 });
	const state = await page.evaluate(() => {
		const sprite = document.querySelector(".dsh-pet-sprite");
		return {
			anchor: Boolean(document.querySelector(".dsh-pet-anchor")),
			sprite: Boolean(sprite),
			backgroundImage: sprite?.style.backgroundImage ?? null,
			title: document.querySelector(".dsh-pet")?.title ?? null,
			bootHasPet: JSON.stringify(window.__DSH_BOOT__ ?? {}).includes("dsh-pet"),
		};
	});
	console.log("PAGE STATE:", JSON.stringify(state, null, 2));

	// Drag: a slow synthetic drag moves the pet and persists the position.
	const initialLeft = await page.evaluate(() => Number.parseFloat(document.querySelector(".dsh-pet").style.left) || 0);
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
		stored: localStorage.getItem("dsh-pet:position"),
	}));
	console.log("DRAG:", dragResult);

	// Click gesture: triggers the mood one-shot without page errors.
	await page.evaluate(() => {
		const el = document.querySelector(".dsh-pet");
		const r = el.getBoundingClientRect();
		const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
		el.dispatchEvent(new MouseEvent("click", opts));
	});
	await new Promise((r) => setTimeout(r, 300));

	const pageErrors = logs.filter((line) => line.startsWith("[pageerror]"));
	const failedRequests = logs.filter((line) => line.startsWith("[requestfailed]"));
	const ok =
		state.anchor === true &&
		state.sprite === true &&
		typeof state.backgroundImage === "string" &&
		state.backgroundImage.includes("/spritesheet") &&
		state.title?.includes("DSH Kitten") === true &&
		dragResult.left < initialLeft - 100 &&
		dragResult.stored !== null &&
		pageErrors.length === 0 &&
		failedRequests.length === 0;
	console.log("VERDICT:", JSON.stringify({ ok, pageErrors, failedRequests }, null, 2));
	if (!ok) {
		console.log("--- console/page logs ---");
		for (const line of logs.slice(-40)) console.log(line);
		process.exitCode = 1;
	} else {
		console.log("E2E SPRITE PASS");
	}
} catch (error) {
	console.error("E2E SPRITE FAIL:", error.message);
	console.log("--- console/page logs ---");
	for (const line of logs.slice(-40)) console.log(line);
	process.exitCode = 1;
} finally {
	await browser.close();
	rmSync(profile, { recursive: true, force: true });
}
