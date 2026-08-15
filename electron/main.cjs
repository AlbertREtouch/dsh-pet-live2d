/**
 * dsh-pet Electron shell — Phase 1 "独立宠物（双击图标即开）".
 *
 * Responsibilities (keep this file thin; all pet logic lives in the shared
 * kernel / pet server):
 *  - start the DSH-agnostic pet server on 127.0.0.1:<random free port>
 *  - open a frameless, transparent, always-on-top window that is ONLY as
 *    large as the pet (+ a small bubble margin) and moves with the pet when
 *    it is dragged — never a full-screen transparent mask, so apps/videos
 *    behind the pet keep rendering normally
 *  - tray menu: show/hide, skin switching, Live2D parameter cockpit,
 *    built-in personality, refresh, quit
 *  - remember the shell window position in the app userData directory
 *
 * The shell never spawns or touches DSH in this phase; "pet quits, harness
 * lives" is structurally guaranteed because no DSH handle exists here.
 */
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } = require("electron");
const { createServer } = require("node:http");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const E2E_FLAG = "--dsh-pet-e2e";
const E2E_TIMEOUT_MS = 30000;

// Must match the shell-mode paddings used by PetOverlay when desktopWindow
// is provided (renderer reports only pet width/height; main derives size).
const SHELL_PAD = { left: 24, top: 64, right: 24, bottom: 8 };
const DEFAULT_WINDOW = { width: 360, height: 224 };
const COCKPIT_EXTRA_WIDTH = 360;
const COCKPIT_MAX_HEIGHT = 600;
const SAVE_DEBOUNCE_MS = 250;

const state = {
	win: null,
	tray: null,
	server: null,
	petServer: null,
	port: 0,
	pets: [],
	currentPetId: null,
	debugPanel: false,
	quitting: false,
	refreshTimer: null,
	petBounds: { width: null, height: null },
	position: { x: null, y: null },
	saveTimer: null,
	positionFile: null,
};

async function loadPetModule() {
	// lib/index.js is ESM ("type": "module"); the shell stays CJS for
	// maximum Electron compatibility and imports it dynamically.
	return import("../lib/index.js");
}

function buildAssetBase() {
	return `http://127.0.0.1:${state.port}/api`;
}

function workAreaFor(rect) {
	return screen.getDisplayMatching(rect).workArea;
}

function clampBounds(bounds) {
	const workArea = workAreaFor(bounds);
	const x = Math.min(Math.max(bounds.x, workArea.x), Math.max(workArea.x, workArea.x + workArea.width - bounds.width));
	const y = Math.min(Math.max(bounds.y, workArea.y), Math.max(workArea.y, workArea.y + workArea.height - bounds.height));
	return { x: Math.round(x), y: Math.round(y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
}

function loadPosition() {
	const fallback = {
		x: null,
		y: null,
	};
	try {
		if (state.positionFile === null) return fallback;
		const parsed = JSON.parse(readFileSync(state.positionFile, "utf8"));
		if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
			return { x: parsed.x, y: parsed.y };
		}
	} catch {
		/* first run / corrupt file */
	}
	return fallback;
}

function scheduleSavePosition() {
	if (state.saveTimer !== null) clearTimeout(state.saveTimer);
	state.saveTimer = setTimeout(() => {
		state.saveTimer = null;
		savePosition();
	}, SAVE_DEBOUNCE_MS);
}

function savePosition() {
	if (state.positionFile === null || state.position.x === null || state.position.y === null) return;
	try {
		mkdirSync(path.dirname(state.positionFile), { recursive: true });
		writeFileSync(state.positionFile, JSON.stringify({ x: state.position.x, y: state.position.y }, null, 2));
	} catch {
		/* position persistence is best-effort */
	}
}

function defaultPosition() {
	const { workArea } = screen.getPrimaryDisplay();
	return {
		x: workArea.x + workArea.width - DEFAULT_WINDOW.width - 16,
		y: workArea.y + workArea.height - DEFAULT_WINDOW.height - 16,
	};
}

function currentSize() {
	if (state.win !== null && !state.win.isDestroyed()) {
		const bounds = state.win.getBounds();
		return { width: bounds.width, height: bounds.height };
	}
	return DEFAULT_WINDOW;
}

function compactSize() {
	const petWidth = state.petBounds.width ?? 106;
	const petHeight = state.petBounds.height ?? 114;
	return {
		width: petWidth + SHELL_PAD.left + SHELL_PAD.right,
		height: petHeight + SHELL_PAD.top + SHELL_PAD.bottom,
	};
}

function cockpitSize() {
	const compact = compactSize();
	const current = state.win !== null && !state.win.isDestroyed() ? state.win.getBounds() : null;
	const workArea = workAreaFor(current ?? { x: state.position.x ?? 0, y: state.position.y ?? 0, width: compact.width, height: compact.height });
	return {
		width: Math.max(compact.width, compact.width + COCKPIT_EXTRA_WIDTH),
		height: Math.max(compact.height, Math.min(COCKPIT_MAX_HEIGHT, workArea.height - 24)),
	};
}

/** Resize (and re-clamp) the shell around its current top-left position. */
function applyWindowSize() {
	if (state.win === null || state.win.isDestroyed() || state.petBounds.width === null) return;
	const current = state.win.getBounds();
	const size = state.debugPanel ? cockpitSize() : compactSize();
	const bounds = clampBounds({ x: current.x, y: current.y, width: size.width, height: size.height });
	state.position = { x: bounds.x, y: bounds.y };
	state.win.setBounds(bounds, false);
	scheduleSavePosition();
}

function createWindow() {
	const saved = loadPosition();
	const { workArea } = screen.getPrimaryDisplay();
	// Migrate users of the old full-screen shell: that window was saved at
	// the work-area origin, which is meaningless for the compact window.
	const savedIsLegacyFullscreen =
		saved.x !== null && saved.y !== null && Math.abs(saved.x - workArea.x) < 2 && Math.abs(saved.y - workArea.y) < 2;
	const fallback = defaultPosition();
	const initial = clampBounds({
		x: saved.x !== null && !savedIsLegacyFullscreen ? saved.x : fallback.x,
		y: saved.y !== null && !savedIsLegacyFullscreen ? saved.y : fallback.y,
		width: DEFAULT_WINDOW.width,
		height: DEFAULT_WINDOW.height,
	});
	state.position = { x: initial.x, y: initial.y };
	state.win = new BrowserWindow({
		x: initial.x,
		y: initial.y,
		width: initial.width,
		height: initial.height,
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		resizable: false,
		movable: false,
		focusable: false,
		fullscreenable: false,
		hasShadow: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	state.win.setAlwaysOnTop(true, "floating");
	// Transparent margins of the compact window are click-through; the
	// renderer re-enables interaction only over the pet/hint/debug surfaces.
	state.win.setIgnoreMouseEvents(true, { forward: true });
	state.win.loadFile(path.join(__dirname, "..", "standalone.html"), {
		query: { assetBase: buildAssetBase() },
	});
	state.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	// Hard guarantee: the pet is a pure mouse overlay and must NEVER take
	// keyboard/activation focus from the app the user is working in. This
	// covers Windows "activate on hover" settings and any transient focus
	// caused by the click-through hit-test toggling.
	state.win.on("focus", () => {
		if (!state.quitting && state.win !== null && !state.win.isDestroyed()) {
			state.win.blur();
		}
	});
	state.win.on("close", (event) => {
		if (!state.quitting) {
			event.preventDefault();
			state.win.hide();
		}
	});
}

function trayIcon() {
	const candidates = [
		path.join(__dirname, "tray.png"),
		path.join(__dirname, "..", "electron", "tray.png"), // same file; defensive
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			const image = nativeImage.createFromPath(candidate);
			if (!image.isEmpty()) return image;
		}
	}
	// Fallback: an empty transparent image is better than no tray at all.
	return nativeImage.createEmpty();
}

function rebuildMenu() {
	if (state.tray === null) return;
	const skinItems = state.pets.map((pet) => ({
		label: pet.displayName || pet.id,
		type: "radio",
		checked: pet.id === state.currentPetId,
		click: () => selectPet(pet.id),
	}));
	if (skinItems.length === 0) {
		skinItems.push({ label: "（未发现宠物）", enabled: false });
	}
	const menu = Menu.buildFromTemplate([
		{
			label: state.win !== null && state.win.isVisible() ? "隐藏宠物" : "显示宠物",
			click: toggleWindow,
		},
		{ type: "separator" },
		{ label: "皮肤", submenu: skinItems.concat([{ type: "separator" }, { label: "刷新皮肤列表", click: refreshPets }]) },
		{
			label: "Live2D 参数试驾台",
			type: "checkbox",
			checked: state.debugPanel,
			click: toggleDebugPanel,
		},
		{
			label: "性格",
			submenu: [{ label: "经典（内置）", type: "radio", checked: true }],
		},
		{ type: "separator" },
		{
			label: "退出 DSH Pet",
			click: () => {
				state.quitting = true;
				app.quit();
			},
		},
	]);
	state.tray.setContextMenu(menu);
}

async function refreshPets() {
	if (state.petServer === null) return;
	const { listPets } = await loadPetModule();
	state.pets = listPets(state.petServer.petsRoot);
	rebuildMenu();
}

function selectPet(id) {
	if (typeof id !== "string" || !SAFE_ID.test(id)) return;
	if (!state.pets.some((pet) => pet.id === id)) {
		refreshPets().catch(() => {});
		return;
	}
	state.currentPetId = id;
	if (state.win !== null && !state.win.isDestroyed()) {
		state.win.webContents.send("dsh-pet:select-pet", id);
	}
	rebuildMenu();
}

function toggleDebugPanel() {
	state.debugPanel = !state.debugPanel;
	if (state.win !== null && !state.win.isDestroyed()) {
		state.win.webContents.send("dsh-pet:set-debug", state.debugPanel);
	}
	applyWindowSize();
	rebuildMenu();
}

function toggleWindow() {
	if (state.win === null) return;
	if (state.win.isVisible()) state.win.hide();
	else state.win.show();
}

function createTray() {
	state.tray = new Tray(trayIcon());
	state.tray.setToolTip("DSH Pet");
	// Rebuilding on click also refreshes the pet list cheaply.
	state.tray.on("click", refreshPets);
	state.tray.on("right-click", refreshPets);
	rebuildMenu();
}

async function startPetServer() {
	const { createPetServer } = await loadPetModule();
	state.petServer = createPetServer({ petsRoot: process.env.DSH_PET_ROOT });
	state.server = createServer((req, res) => state.petServer.handleRequest(req, res));
	await new Promise((resolve, reject) => {
		state.server.once("error", reject);
		state.server.listen(0, "127.0.0.1", resolve);
	});
	state.port = state.server.address().port;
}

function installIpc() {
	ipcMain.on("dsh-pet:set-ignore-mouse", (event, ignore) => {
		if (state.win === null || event.sender !== state.win.webContents) return;
		state.win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
	});
	ipcMain.on("dsh-pet:report-pet", (event, raw) => {
		if (state.win === null || event.sender !== state.win.webContents) return;
		if (typeof raw === "string" && SAFE_ID.test(raw) && raw !== state.currentPetId) {
			state.currentPetId = raw;
			rebuildMenu();
		}
	});
	// Renderer computes the screen-space top-left of the window while the
	// pet is dragged (pointer screenX/Y minus the grab offset inside the pet).
	ipcMain.on("dsh-pet:move-window", (event, x, y) => {
		if (state.win === null || event.sender !== state.win.webContents) return;
		if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return;
		const size = currentSize();
		const bounds = clampBounds({ x, y, width: size.width, height: size.height });
		state.position = { x: bounds.x, y: bounds.y };
		state.win.setPosition(bounds.x, bounds.y, false);
		scheduleSavePosition();
	});
	ipcMain.on("dsh-pet:drag-end", (event) => {
		if (state.win === null || event.sender !== state.win.webContents) return;
		savePosition();
	});
	ipcMain.on("dsh-pet:set-pet-bounds", (event, payload) => {
		if (state.win === null || event.sender !== state.win.webContents) return;
		const width = payload?.width;
		const height = payload?.height;
		if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return;
		state.petBounds = { width: Math.round(width), height: Math.round(height) };
		applyWindowSize();
	});
}

// ---------------------------------------------------------------------------
// e2e harness: `electron electron/main.cjs --dsh-pet-e2e`
// ---------------------------------------------------------------------------

function httpGetJson(pathname) {
	return new Promise((resolve, reject) => {
		const request = require("node:http").get(
			{ host: "127.0.0.1", port: state.port, path: pathname, timeout: 5000 },
			(response) => {
				if (response.statusCode !== 200) {
					response.resume();
					reject(new Error(`GET ${pathname} -> ${response.statusCode}`));
					return;
				}
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		request.on("error", reject);
	});
}

async function waitFor(predicate, label, deadline) {
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`timeout waiting for ${label}`);
}

async function runE2E() {
	const deadline = Date.now() + E2E_TIMEOUT_MS;
	try {
		await waitFor(() => state.currentPetId !== null, "renderer to report the mounted pet", deadline);
		await waitFor(() => state.petBounds.width !== null, "renderer to report pet bounds", deadline);
		const catalog = await httpGetJson("/api/pets");
		const renderer = await state.win.webContents.executeJavaScript(
			`JSON.stringify({
				mount: typeof PetStandalone?.mount,
				petVisible: document.querySelector(".dsh-pet") !== null,
				title: document.title,
			})`,
		);
		let switchedPet = null;
		let switchedKind = null;
		if (Array.isArray(catalog) && catalog.length > 0) {
			// Prefer a Live2D skin so the cockpit toggle can be exercised when
			// the fixture provides one; otherwise switch to any other skin.
			const targetPet =
				catalog.find((pet) => pet.kind === "live2d") ??
				catalog.find((pet) => pet.id !== state.currentPetId) ??
				catalog[0];
			switchedPet = targetPet?.id ?? null;
			const expectedKind = targetPet?.kind === "live2d" || targetPet?.kind === "sprite" ? targetPet.kind : null;
			if (switchedPet !== null && state.currentPetId !== null && expectedKind !== null) {
				selectPet(switchedPet);
				await waitFor(
					async () => (await state.win.webContents.executeJavaScript("window.__dshPetCurrentId")) === switchedPet,
					"renderer to select skin",
					deadline,
				);
				const kindExpression = `document.querySelector(".dsh-pet-live2d") !== null
					? "live2d"
					: document.querySelector(".dsh-pet-sprite") !== null
						? "sprite"
						: null`;
				await waitFor(
					async () => (await state.win.webContents.executeJavaScript(kindExpression)) === expectedKind,
					"renderer DOM to reflect the switched skin",
					deadline,
				);
				switchedKind = expectedKind;
			}
		}
		let cockpitToggled = null;
		if (switchedKind === "live2d") {
			toggleDebugPanel();
			await waitFor(
				async () => (await state.win.webContents.executeJavaScript(`document.querySelector(".dsh-pet-debug-tab") !== null`)) === true,
				"cockpit tab to appear",
				deadline,
			);
			toggleDebugPanel();
			await waitFor(
				async () => (await state.win.webContents.executeJavaScript(`document.querySelector(".dsh-pet-debug-tab") !== null`)) === false,
				"cockpit tab to disappear",
				deadline,
			);
			cockpitToggled = true;
		}

		// Synthetic pointer drag: verifies the renderer turns a pet drag into
		// a screen-space window move (the whole point of the compact shell).
		let dragMoved = null;
		const beforeDrag = state.win.getPosition();
		const dragDispatched = await state.win.webContents.executeJavaScript(
			`(() => {
				const pet = document.querySelector(".dsh-pet");
				if (pet === null) return "no-pet";
				try {
					const r = pet.getBoundingClientRect();
					const startX = window.screenX + r.left + 12;
					const startY = window.screenY + r.top + 12;
					const base = { bubbles: true, button: 0, buttons: 1, pointerId: 17, clientX: r.left + 12, clientY: r.top + 12, screenX: startX, screenY: startY };
					pet.dispatchEvent(new PointerEvent("pointerdown", base));
					pet.dispatchEvent(new PointerEvent("pointermove", { ...base, clientX: base.clientX + 48, clientY: base.clientY + 36, screenX: startX + 48, screenY: startY + 36 }));
					pet.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0, clientX: base.clientX + 48, clientY: base.clientY + 36, screenX: startX + 48, screenY: startY + 36 }));
					return "ok";
				} catch {
					return "err";
				}
			})()`,
		);
		if (dragDispatched === "ok") {
			try {
				await waitFor(
					() => {
						const [x, y] = state.win.getPosition();
						return Math.abs(x - beforeDrag[0]) > 8 || Math.abs(y - beforeDrag[1]) > 8;
					},
					"window to follow the synthetic pet drag",
					deadline,
				);
				dragMoved = true;
			} catch {
				dragMoved = false;
			}
		}
		const bounds = state.win.getBounds();
		const result = {
			port: state.port,
			pet: state.currentPetId,
			catalog: Array.isArray(catalog) ? catalog.length : -1,
			renderer: JSON.parse(renderer),
			switchedPet,
			switchedKind,
			cockpitToggled,
			dragMoved,
			windowBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
			petBounds: state.petBounds,
		};
		console.log(`DSH_PET_E2E_OK ${JSON.stringify(result)}`);
		state.quitting = true;
		app.exit(0);
	} catch (error) {
		console.error(`DSH_PET_E2E_FAIL ${error.message}`);
		state.quitting = true;
		app.exit(1);
	}
}

// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (state.win !== null && !state.win.isDestroyed()) {
			state.win.show();
		}
	});
	app.setAppUserModelId("dev.dsh.pet");
	installIpc();

	app.whenReady().then(async () => {
		state.positionFile = path.join(app.getPath("userData"), "shell-position.json");
		await startPetServer();
		createWindow();
		createTray();
		await refreshPets();
		state.refreshTimer = setInterval(() => {
			refreshPets().catch(() => {});
		}, 30000);
		state.refreshTimer.unref?.();
		if (process.argv.includes(E2E_FLAG)) {
			runE2E();
		}
	});

	app.on("before-quit", () => {
		state.quitting = true;
		savePosition();
		if (state.refreshTimer !== null) clearInterval(state.refreshTimer);
		if (state.server !== null) state.server.close();
	});

	app.on("window-all-closed", () => {
		// Tray app: closing the window hides it, so this only fires on quit.
		if (state.quitting) app.quit();
	});
}
