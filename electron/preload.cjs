/**
 * Sandboxed preload bridge for the dsh-pet Electron shell.
 *
 * The page only ever sees a few tiny, validated capabilities:
 *  - onSelectPet(cb): tray menu asks the renderer to switch skin
 *  - onSetDebug(cb): tray menu toggles the Live2D parameter cockpit
 *  - beginDrag({offsetX, offsetY}): start a pet drag (grab offset in window)
 *  - dragMove(): main process re-reads the OS cursor and moves the window
 *  - setPetBounds({width, height}): pet element size (shell resizes around it)
 *  - dragEnd(): persist the final window position after a drag
 *  - reportPet(id): tell the main process which skin is actually mounted
 *  - getDshStatus/onDshStatus: observe the detached DSH connection lifecycle
 *  - openDsh(): open the full DSH UI for interactions too complex for a bubble
 *  - requestAttention(): ask the main process for a deduplicated escalation
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
	getDshStatus() {
		return ipcRenderer.invoke("dsh-pet:get-dsh-status");
	},
	onDshStatus(callback) {
		if (typeof callback !== "function") return;
		ipcRenderer.on("dsh-pet:dsh-status", (_event, status) => {
			if (status !== null && typeof status === "object") callback(status);
		});
	},
	openDsh() {
		ipcRenderer.send("dsh-pet:open-dsh");
	},
	requestAttention(payload) {
		ipcRenderer.send("dsh-pet:attention", {
			key: typeof payload?.key === "string" ? payload.key : "",
			level: payload?.level === "escalated" ? "escalated" : "normal",
			message: typeof payload?.message === "string" ? payload.message : "",
		});
	},
	beginDrag(offset) {
		ipcRenderer.send("dsh-pet:drag-start", {
			offsetX: Number(offset?.offsetX),
			offsetY: Number(offset?.offsetY),
		});
	},
	dragMove() {
		ipcRenderer.send("dsh-pet:drag-move");
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
