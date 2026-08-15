/**
 * dsh-pet Electron shell — Phase 1 "独立宠物（双击图标即开）".
 *
 * Responsibilities (keep this file thin; all pet logic lives in the shared
 * kernel / pet server):
 *  - start the DSH-agnostic pet server on 127.0.0.1:<random free port>
 *  - open a frameless, transparent, always-on-top window spanning the
 *    primary work area; mouse events pass through everywhere except over
 *    the pet itself (renderer toggles this via IPC)
 *  - tray menu: show/hide, skin switching (pets already installed under
 *    the pets root), built-in personality, refresh, quit
 *
 * The shell never spawns or touches DSH in this phase; "pet quits, harness
 * lives" is structurally guaranteed because no DSH handle exists here.
 */
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } = require("electron");
const { createServer } = require("node:http");
const { existsSync } = require("node:fs");
const path = require("node:path");

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const E2E_FLAG = "--dsh-pet-e2e";
const E2E_TIMEOUT_MS = 30000;

const state = {
	win: null,
	tray: null,
	server: null,
	petServer: null,
	port: 0,
	pets: [],
	currentPetId: null,
	quitting: false,
	refreshTimer: null,
};

async function loadPetModule() {
	// lib/index.js is ESM ("type": "module"); the shell stays CJS for
	// maximum Electron compatibility and imports it dynamically.
	return import("../lib/index.js");
}

function buildAssetBase() {
	return `http://127.0.0.1:${state.port}/api`;
}

function createWindow() {
	const { workArea } = screen.getPrimaryDisplay();
	state.win = new BrowserWindow({
		x: workArea.x,
		y: workArea.y,
		width: workArea.width,
		height: workArea.height,
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		resizable: false,
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
	// Start click-through; the renderer re-enables interaction only while the
	// pointer is over the pet/hint/debug surfaces (forward keeps mousemove).
	state.win.setIgnoreMouseEvents(true, { forward: true });
	state.win.loadFile(path.join(__dirname, "..", "standalone.html"), {
		query: { assetBase: buildAssetBase() },
	});
	state.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
		if (Array.isArray(catalog) && catalog.length > 1) {
			switchedPet = catalog.find((pet) => pet.id !== state.currentPetId)?.id ?? null;
			if (switchedPet !== null) {
				selectPet(switchedPet);
				await waitFor(
					async () => (await state.win.webContents.executeJavaScript("window.__dshPetCurrentId")) === switchedPet,
					"renderer to switch skin",
					deadline,
				);
				switchedKind = await state.win.webContents.executeJavaScript(
					`document.querySelector(".dsh-pet-live2d") !== null
						? "live2d"
						: document.querySelector(".dsh-pet-sprite") !== null
							? "sprite"
							: null`,
				);
			}
		}
		const result = {
			port: state.port,
			pet: state.currentPetId,
			catalog: Array.isArray(catalog) ? catalog.length : -1,
			renderer: JSON.parse(renderer),
			switchedPet,
			switchedKind,
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
		if (state.refreshTimer !== null) clearInterval(state.refreshTimer);
		if (state.server !== null) state.server.close();
	});

	app.on("window-all-closed", () => {
		// Tray app: closing the window hides it, so this only fires on quit.
		if (state.quitting) app.quit();
	});
}
