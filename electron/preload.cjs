/**
 * Sandboxed preload bridge for the dsh-pet Electron shell.
 *
 * The page only ever sees a few tiny, validated capabilities:
 *  - onSelectPet(cb): tray menu asks the renderer to switch skin
 *  - onSetDebug(cb): tray menu toggles the Live2D parameter cockpit
 *  - setIgnoreMouse(bool): click-through hit-testing for transparent margins
 *  - moveWindow(x, y): screen-space top-left of the compact shell window
 *  - setPetBounds({width, height}): pet element size (shell resizes around it)
 *  - dragEnd(): persist the final window position after a drag
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
	moveWindow(x, y) {
		ipcRenderer.send("dsh-pet:move-window", Number(x), Number(y));
	},
	setPetBounds(bounds) {
		ipcRenderer.send("dsh-pet:set-pet-bounds", {
			width: Number(bounds?.width),
			height: Number(bounds?.height),
		});
	},
	dragEnd() {
		ipcRenderer.send("dsh-pet:drag-end");
	},
	reportPet(id) {
		if (typeof id === "string") ipcRenderer.send("dsh-pet:report-pet", id);
	},
});
