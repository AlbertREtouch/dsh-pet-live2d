/**
 * Sandboxed preload bridge for the dsh-pet Electron shell.
 *
 * The page only ever sees a few tiny, validated capabilities:
 *  - onSelectPet(cb): tray menu asks the renderer to switch skin
 *  - onSetDebug(cb): tray menu toggles the Live2D parameter cockpit
 *  - setIgnoreMouse(bool): click-through hit-testing
 *  - reportPet(id): tell the main process which skin is actually mounted
 * No Node.js access is exposed to the page (contextIsolation + sandbox).
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshPetDesktop", {
	onSelectPet(callback) {
		if (typeof callback !== "function") return;
		ipcRenderer.on("dsh-pet:select-pet", (_event, id) => {
			if (typeof id === "string") callback(id);
		});
	},
	onSetDebug(callback) {
		if (typeof callback !== "function") return;
		ipcRenderer.on("dsh-pet:set-debug", (_event, enabled) => {
			callback(Boolean(enabled));
		});
	},
	setIgnoreMouse(ignore) {
		ipcRenderer.send("dsh-pet:set-ignore-mouse", Boolean(ignore));
	},
	reportPet(id) {
		if (typeof id === "string") ipcRenderer.send("dsh-pet:report-pet", id);
	},
});
