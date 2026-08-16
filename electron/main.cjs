/**
 * dsh-pet Electron shell — Phase 2 "宠物反客为主".
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
 * DSH is probed/reused or launched detached. The shell intentionally keeps no
 * kill path: "pet quits, harness lives" remains structurally guaranteed.
 */
const { app, BrowserWindow, ipcMain, Menu, Notification, Tray, nativeImage, screen, shell } = require("electron");
const { createServer } = require("node:http");
const { existsSync, mkdirSync, readFile, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { createDshLifecycle, resolveDshConfig } = require("./dsh-lifecycle.cjs");
const {
	buildWindowShape,
	clampBoundsToVisiblePet,
	clampBoundsToWorkArea,
	defaultPositionForSize,
	resolveDragMove,
} = require("./window-geometry.cjs");

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const E2E_FLAG = "--dsh-pet-e2e";
const E2E_TIMEOUT_MS = 30000;
const IS_E2E = process.argv.includes(E2E_FLAG);

// Must match the shell-mode paddings used by PetOverlay when desktopWindow
// is provided (renderer reports only pet width/height; main derives size).
const SHELL_PAD = { left: 24, top: 96, right: 24, bottom: 8 };
const SHELL_MIN_WIDTH = 320;
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
	dragOffset: null,
	e2eCursor: null,
	windowShape: [],
	needsDefaultPlacement: false,
	dshLifecycle: null,
	dshConfig: resolveDshConfig(),
	dshStatus: null,
	attentionKeys: new Set(),
	notifications: new Set(),
};

async function loadPetModule() {
	// lib/index.js is ESM ("type": "module"); the shell stays CJS for
	// maximum Electron compatibility and imports it dynamically.
	return import("../lib/index.js");
}

function buildAssetBase() {
	return `http://127.0.0.1:${state.port}/api`;
}

function buildShellOrigin() {
	return `http://127.0.0.1:${state.port}`;
}

const SHELL_ASSETS = new Map([
	["/", { file: path.join(__dirname, "..", "standalone.html"), type: "text/html; charset=utf-8" }],
	["/standalone.html", { file: path.join(__dirname, "..", "standalone.html"), type: "text/html; charset=utf-8" }],
	["/lib/standalone.js", { file: path.join(__dirname, "..", "lib", "standalone.js"), type: "text/javascript; charset=utf-8" }],
	["/lib/standalone.js.map", { file: path.join(__dirname, "..", "lib", "standalone.js.map"), type: "application/json; charset=utf-8" }],
]);

function serveShellAsset(req, res) {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
	let pathname;
	try {
		pathname = new URL(req.url, buildShellOrigin()).pathname;
	} catch {
		return false;
	}
	const asset = SHELL_ASSETS.get(pathname);
	if (asset === undefined) return false;
	readFile(asset.file, (error, body) => {
		if (error !== null) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("Not found");
			return;
		}
		res.writeHead(200, {
			"content-type": asset.type,
			"content-length": body.length,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		});
		res.end(req.method === "HEAD" ? undefined : body);
	});
	return true;
}

function workAreaFor(rect) {
	return screen.getDisplayMatching(rect).workArea;
}

function clampBounds(bounds) {
	return clampBoundsToWorkArea(bounds, workAreaFor(bounds));
}

function loadPosition() {
	const fallback = {
		x: null,
		y: null,
	};
	try {
		if (IS_E2E) return fallback;
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
	if (IS_E2E) return;
	if (state.saveTimer !== null) clearTimeout(state.saveTimer);
	state.saveTimer = setTimeout(() => {
		state.saveTimer = null;
		savePosition();
	}, SAVE_DEBOUNCE_MS);
}

function savePosition() {
	if (IS_E2E) return;
	if (state.positionFile === null || state.position.x === null || state.position.y === null) return;
	try {
		mkdirSync(path.dirname(state.positionFile), { recursive: true });
		writeFileSync(state.positionFile, JSON.stringify({ x: state.position.x, y: state.position.y }, null, 2));
	} catch {
		/* position persistence is best-effort */
	}
}

function currentSize() {
	if (state.win !== null && !state.win.isDestroyed()) {
		const bounds = state.win.getBounds();
		return { width: bounds.width, height: bounds.height };
	}
	return DEFAULT_WINDOW;
}

/**
 * The OS cursor position is authoritative during a drag. Renderer-reported
 * screenX/screenY can feed back on themselves once the window starts moving
 * under the pointer, which drifts the window toward the bottom-right. The
 * e2eCursor override exists only for the synthetic drag smoke test.
 */
function readCursor() {
	return state.e2eCursor ?? screen.getCursorScreenPoint();
}

function shellLayout() {
	const petWidth = state.petBounds.width ?? 106;
	const petHeight = state.petBounds.height ?? 114;
	const width = Math.max(SHELL_MIN_WIDTH, petWidth + SHELL_PAD.left + SHELL_PAD.right);
	const left = Math.round((width - petWidth) / 2);
	return {
		size: { width, height: petHeight + SHELL_PAD.top + SHELL_PAD.bottom },
		pet: { x: left, y: SHELL_PAD.top, width: petWidth, height: petHeight },
		pad: { left, top: SHELL_PAD.top, right: width - left - petWidth, bottom: SHELL_PAD.bottom },
	};
}

function applyWindowShape() {
	if (state.win === null || state.win.isDestroyed()) return;
	const bounds = state.win.getBounds();
	const layout = shellLayout();
	state.windowShape = buildWindowShape({
		windowSize: { width: bounds.width, height: bounds.height },
		petBounds:
			state.petBounds.width === null || state.petBounds.height === null
				? null
				: { width: state.petBounds.width, height: state.petBounds.height },
		debugPanel: state.debugPanel,
		pad: layout.pad,
	});
	// Electron exposes native window shapes on Windows/Linux. Phase 1's
	// transparent-input bug is Windows-specific, so keep other platforms on
	// their existing rectangular behavior until they are tested explicitly.
	if (process.platform === "win32" && typeof state.win.setShape === "function") {
		state.win.setShape(state.windowShape);
	}
}

function moveWindowForDrag(cursor) {
	if (state.win === null || state.win.isDestroyed() || state.dragOffset === null) return;
	const size = currentSize();
	const requested = {
		x: cursor.x - state.dragOffset.x,
		y: cursor.y - state.dragOffset.y,
		width: size.width,
		height: size.height,
	};
	const movement = resolveDragMove({
		cursor,
		dragOffset: state.dragOffset,
		size,
		workArea: screen.getDisplayNearestPoint(cursor).workArea,
		petBounds: state.petBounds,
		pad: shellLayout().pad,
	});
	const { bounds } = movement;
	// Rebase on a clamped axis so moving the cursor one pixel back from an edge
	// moves the pet one pixel immediately instead of traversing accumulated
	// off-screen overshoot first.
	state.dragOffset = movement.dragOffset;
	state.position = { x: bounds.x, y: bounds.y };
	state.win.setPosition(bounds.x, bounds.y, false);
	scheduleSavePosition();
}

function compactSize() {
	return shellLayout().size;
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

/** Resize the shell while keeping the pet, rather than its transparent canvas, recoverable. */
function applyWindowSize({ placeDefault = false } = {}) {
	if (state.win === null || state.win.isDestroyed() || state.petBounds.width === null) return;
	const current = state.win.getBounds();
	const size = state.debugPanel ? cockpitSize() : compactSize();
	const layout = shellLayout();
	let bounds;
	if (placeDefault) {
		const workArea = screen.getPrimaryDisplay().workArea;
		bounds = {
			x: Math.round(workArea.x + workArea.width - (layout.pet.x + layout.pet.width) - 16),
			y: Math.round(workArea.y + workArea.height - (layout.pet.y + layout.pet.height) - 16),
			width: size.width,
			height: size.height,
		};
	} else if (state.debugPanel) {
		// The cockpit is a conventional control panel and should remain wholly
		// usable when explicitly opened.
		bounds = clampBounds({ x: current.x, y: current.y, width: size.width, height: size.height });
	} else {
		const proposed = { x: current.x, y: current.y, width: size.width, height: size.height };
		bounds = clampBoundsToVisiblePet(proposed, workAreaFor(proposed), state.petBounds, layout.pad);
	}
	state.position = { x: bounds.x, y: bounds.y };
	state.win.setBounds(bounds, false);
	applyWindowShape();
	scheduleSavePosition();
}

function createWindow() {
	const saved = loadPosition();
	const { workArea } = screen.getPrimaryDisplay();
	// Migrate users of the old full-screen shell: that window was saved at
	// the work-area origin, which is meaningless for the compact window.
	const savedIsLegacyFullscreen =
		saved.x !== null && saved.y !== null && Math.abs(saved.x - workArea.x) < 2 && Math.abs(saved.y - workArea.y) < 2;
	const hasUsableSavedPosition = saved.x !== null && saved.y !== null && !savedIsLegacyFullscreen;
	const fallback = defaultPositionForSize(DEFAULT_WINDOW, workArea);
	// Preserve a saved partially-offscreen position until the real pet size is
	// known. applyWindowSize will recover the pet itself if display geometry
	// changed. A fresh/legacy launch is placed again after real-size reporting.
	const initial = {
		x: Math.round(hasUsableSavedPosition ? saved.x : fallback.x),
		y: Math.round(hasUsableSavedPosition ? saved.y : fallback.y),
		width: DEFAULT_WINDOW.width,
		height: DEFAULT_WINDOW.height,
	};
	state.needsDefaultPlacement = !hasUsableSavedPosition;
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
	// Start rectangular so the no-pet hint remains usable. Once the renderer
	// reports a pet size, applyWindowShape narrows native drawing/input to the
	// bubble + pet regions and transparent margins fall through.
	applyWindowShape();
	const shellUrl = new URL("/standalone.html", buildShellOrigin());
	shellUrl.searchParams.set("assetBase", buildAssetBase());
	shellUrl.searchParams.set("dshOrigin", state.dshConfig.origin);
	state.win.loadURL(shellUrl.href);
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

async function openDshInterface() {
	const available = await state.dshLifecycle?.ensureAvailable();
	if (available === true || state.dshStatus?.online === true || state.dshStatus?.running === true) {
		await shell.openExternal(state.dshConfig.origin);
		return true;
	}
	if (state.tray !== null && process.platform === "win32") {
		state.tray.displayBalloon?.({ title: "DSH Pet", content: state.dshStatus?.message ?? "DSH 当前不可用" });
	}
	return false;
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
		{
			label: `打开 DSH（${state.dshStatus?.online === true ? "已连接" : state.dshStatus?.phase === "plugin-missing" ? "缺少桌宠插件" : "连接中"}）`,
			click: () => openDshInterface().catch(() => {}),
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

function updateDshStatus(status) {
	state.dshStatus = status;
	if (state.win !== null && !state.win.isDestroyed()) {
		state.win.webContents.send("dsh-pet:dsh-status", status);
	}
	rebuildMenu();
}

async function startPetServer() {
	const { createPetServer } = await loadPetModule();
	state.petServer = createPetServer({ petsRoot: process.env.DSH_PET_ROOT });
	state.server = createServer((req, res) => {
		if (serveShellAsset(req, res)) return;
		state.petServer.handleRequest(req, res);
	});
	await new Promise((resolve, reject) => {
		state.server.once("error", reject);
		state.server.listen(0, "127.0.0.1", resolve);
	});
	state.port = state.server.address().port;
}

function installIpc() {
	ipcMain.handle("dsh-pet:get-dsh-status", (event) => {
		if (state.win === null || event.sender !== state.win.webContents) return null;
		return state.dshStatus;
	});
	ipcMain.on("dsh-pet:open-dsh", (event) => {
		if (state.win === null || event.sender !== state.win.webContents) return;
		openDshInterface().catch(() => {});
	});
	ipcMain.on("dsh-pet:attention", (event, payload) => {
		if (state.win === null || event.sender !== state.win.webContents) return;
		const key = typeof payload?.key === "string" ? payload.key : "";
		const level = payload?.level;
		const message = typeof payload?.message === "string" ? payload.message.slice(0, 240) : "DSH 正在等待你的操作";
		if (key.length === 0 || key.length > 256 || (level !== "normal" && level !== "escalated")) return;
		if (level !== "escalated" || state.attentionKeys.has(key)) return;
		state.attentionKeys.add(key);
		if (state.attentionKeys.size > 64) state.attentionKeys.delete(state.attentionKeys.values().next().value);
		if (Notification.isSupported()) {
			const notification = new Notification({ title: "DSH 等待你的操作", body: message, silent: false });
			state.notifications.add(notification);
			notification.on("click", () => openDshInterface().catch(() => {}));
			notification.on("close", () => state.notifications.delete(notification));
			notification.show();
		}
	});
	ipcMain.on("dsh-pet:report-pet", (event, raw) => {
		if (state.win === null || event.sender !== state.win.webContents) return;
		if (typeof raw === "string" && SAFE_ID.test(raw) && raw !== state.currentPetId) {
			state.currentPetId = raw;
			rebuildMenu();
		}
	});
	// Renderer signals drag start with the grab offset inside the pet; every
	// subsequent move reads the OS cursor position here in the main process.
	// Do NOT trust renderer screenX/screenY while the window is moving under
	// the pointer — they feed back on themselves and drift the window.
	ipcMain.on("dsh-pet:drag-start", (event, payload) => {
		if (state.win === null || event.sender !== state.win.webContents) return;
		const offsetX = payload?.offsetX;
		const offsetY = payload?.offsetY;
		if (typeof offsetX !== "number" || typeof offsetY !== "number" || !Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return;
		state.dragOffset = { x: offsetX, y: offsetY };
	});
	ipcMain.on("dsh-pet:drag-move", (event) => {
		if (state.win === null || event.sender !== state.win.webContents || state.dragOffset === null) return;
		const cursor = readCursor();
		moveWindowForDrag(cursor);
	});
	ipcMain.on("dsh-pet:drag-end", (event) => {
		if (state.win === null || event.sender !== state.win.webContents) return;
		state.dragOffset = null;
		savePosition();
	});
	ipcMain.on("dsh-pet:set-pet-bounds", (event, payload) => {
		if (state.win === null || event.sender !== state.win.webContents) return;
		const width = payload?.width;
		const height = payload?.height;
		if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return;
		const isFirstRealSize = state.petBounds.width === null;
		state.petBounds = { width: Math.round(width), height: Math.round(height) };
		applyWindowSize({ placeDefault: isFirstRealSize && state.needsDefaultPlacement });
		if (isFirstRealSize) state.needsDefaultPlacement = false;
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
		await waitFor(() => state.dshStatus?.online === true, "DSH bridge endpoint to be online", deadline);
		const startupBounds = state.win.getBounds();
		const startupWorkArea = screen.getDisplayMatching(startupBounds).workArea;
		const startupLayout = shellLayout();
		const startupPlacedWithRealSize =
			startupBounds.x + startupLayout.pet.x + startupLayout.pet.width === startupWorkArea.x + startupWorkArea.width - 16 &&
			startupBounds.y + startupLayout.pet.y + startupLayout.pet.height === startupWorkArea.y + startupWorkArea.height - 16;
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
		let pendingApprovalVisible = false;
		let pendingSessionTitleVisible = false;
		try {
			await waitFor(
				async () => (await state.win.webContents.executeJavaScript(`document.querySelector(".dsh-pet-pending-approve") !== null`)) === true,
				"pending approval bubble",
				deadline,
			);
			pendingApprovalVisible = true;
			pendingSessionTitleVisible = await state.win.webContents.executeJavaScript(
				`document.querySelector(".dsh-pet-pending-message")?.textContent?.includes("后台审批会话") === true`,
			);
		} catch {
			pendingApprovalVisible = false;
			pendingSessionTitleVisible = false;
		}
		const spriteDiagnostics = await state.win.webContents.executeJavaScript(`(async () => {
			const node = document.querySelector(".dsh-pet-sprite");
			if (node === null) return null;
			const style = getComputedStyle(node);
			let imageLoaded = false;
			const match = /^url\\(["']?(.*?)["']?\\)$/.exec(style.backgroundImage);
			if (match !== null) {
				const image = new Image();
				image.src = match[1];
				try {
					await image.decode();
					imageLoaded = image.naturalWidth > 0;
					await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
				} catch {}
			}
			const rect = node.getBoundingClientRect();
			return {
				backgroundImage: style.backgroundImage,
				backgroundPosition: style.backgroundPosition,
				display: style.display,
				opacity: style.opacity,
				imageLoaded,
				rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			};
		})()`);
		const screenshotPath = process.env.DSH_PET_E2E_SCREENSHOT;
		if (typeof screenshotPath === "string" && screenshotPath.length > 0) {
			const image = await state.win.webContents.capturePage();
			writeFileSync(screenshotPath, image.toPNG());
		}

		// Synthetic pointer drag: verifies the renderer turns a pet drag into a
		// main-process cursor read + window move (the whole point of the
		// compact shell). e2eCursor stands in for the real OS cursor.
		let dragMoved = null;
		const beforeDrag = state.win.getPosition();
		state.e2eCursor = { x: beforeDrag[0] + 48, y: beforeDrag[1] + 36 };
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
		state.e2eCursor = null;

		// A click still sends drag-start, but never crosses the movement
		// threshold. Verify renderer cleanup sends the matching drag-end so the
		// main process cannot retain a stale drag after ordinary clicks.
		state.dragOffset = { x: -999, y: -999 };
		const clickDispatched = await state.win.webContents.executeJavaScript(
			`(() => {
				const pet = document.querySelector(".dsh-pet");
				if (pet === null) return "no-pet";
				const r = pet.getBoundingClientRect();
				const base = { bubbles: true, button: 0, buttons: 1, pointerId: 23, clientX: r.left + 16, clientY: r.top + 16 };
				pet.dispatchEvent(new PointerEvent("pointerdown", base));
				pet.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
				return "ok";
			})()`,
		);
		let clickDragStateCleared = false;
		if (clickDispatched === "ok") {
			try {
				await waitFor(() => state.dragOffset === null, "ordinary click to clear drag state", deadline);
				clickDragStateCleared = true;
			} catch {
				clickDragStateCleared = false;
			}
		}

		// Exercise the actual main-process edge geometry. A center grab should
		// continue following the cursor all the way to the work-area corner even
		// though most of the transparent shell rectangle extends beyond it; one
		// pixel of reverse cursor movement must then move the window one pixel.
		const beforeEdgeBounds = state.win.getBounds();
		const edgeWorkArea = screen.getDisplayMatching(beforeEdgeBounds).workArea;
		const edgeLayout = shellLayout();
		const edgeGrab = {
			x: edgeLayout.pet.x + Math.floor(state.petBounds.width / 2),
			y: edgeLayout.pet.y + Math.floor(state.petBounds.height / 2),
		};
		const edgeCursor = {
			x: edgeWorkArea.x + edgeWorkArea.width - 1,
			y: edgeWorkArea.y + edgeWorkArea.height - 1,
		};
		state.dragOffset = edgeGrab;
		moveWindowForDrag(edgeCursor);
		const atEdge = state.win.getBounds();
		moveWindowForDrag({ x: edgeCursor.x - 1, y: edgeCursor.y - 1 });
		const afterReverse = state.win.getBounds();
		const edgeDragFollowed =
			atEdge.x === edgeCursor.x - edgeGrab.x &&
			atEdge.y === edgeCursor.y - edgeGrab.y &&
			afterReverse.x === atEdge.x - 1 &&
			afterReverse.y === atEdge.y - 1;
		state.dragOffset = null;
		const bounds = state.win.getBounds();
		const shapeCornerFallsThrough =
			state.windowShape.length > 0 &&
			!state.windowShape.some(
				(rect) =>
					bounds.width - 1 >= rect.x &&
					bounds.height - 1 >= rect.y &&
					bounds.width - 1 < rect.x + rect.width &&
					bounds.height - 1 < rect.y + rect.height,
			);
		const result = {
			port: state.port,
			pet: state.currentPetId,
			startupPlacedWithRealSize,
			startupWindowBounds: startupBounds,
			catalog: Array.isArray(catalog) ? catalog.length : -1,
			renderer: JSON.parse(renderer),
			switchedPet,
			switchedKind,
			cockpitToggled,
			dshConnected: state.dshStatus?.online === true,
			pendingApprovalVisible,
			pendingSessionTitleVisible,
			spriteDiagnostics,
			dragMoved,
			edgeDragFollowed,
			clickDragStateCleared,
			shapeCornerFallsThrough,
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
		state.dshLifecycle = createDshLifecycle({
			config: state.dshConfig,
			onStatus: updateDshStatus,
		});
		state.dshStatus = state.dshLifecycle.getStatus();
		state.dshLifecycle.start();
		await refreshPets();
		state.refreshTimer = setInterval(() => {
			refreshPets().catch(() => {});
		}, 30000);
		state.refreshTimer.unref?.();
		if (IS_E2E) {
			runE2E();
		}
	});

	app.on("before-quit", () => {
		state.quitting = true;
		state.dshLifecycle?.stop();
		savePosition();
		if (state.refreshTimer !== null) clearInterval(state.refreshTimer);
		if (state.server !== null) state.server.close();
	});

	app.on("window-all-closed", () => {
		// Tray app: closing the window hides it, so this only fires on quit.
		if (state.quitting) app.quit();
	});
}
