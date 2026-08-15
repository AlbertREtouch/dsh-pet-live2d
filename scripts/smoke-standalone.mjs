/**
 * smoke-standalone: execute the standalone bundle (IIFE, React bundled) in
 * Node with a stubbed browser environment. Verifies the bundle self-registers
 * `window.PetStandalone` and exposes `mount`, and that no platform seed table
 * (React externals) is required to execute it.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const bundle = readFileSync(new URL("../lib/standalone.js", import.meta.url), "utf8");

// --- browser-ish global stubs -------------------------------------------------
const noop = () => {};
const elementStub = () => ({
	style: {},
	dataset: {},
	nodeType: 1,
	tagName: "DIV",
	appendChild: noop,
	remove: noop,
	setPointerCapture: noop,
	setAttribute: noop,
	removeAttribute: noop,
	addEventListener: noop,
	removeEventListener: noop,
	contains: () => false,
});
globalThis.window = globalThis;
globalThis.document = {
	createElement: elementStub,
	createTextNode: () => ({ nodeType: 3, textContent: "" }),
	querySelector: () => null,
	querySelectorAll: () => [],
	head: { appendChild: noop },
	body: {},
};
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node-smoke", platform: "Win32" }, configurable: true });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(16), 16);
globalThis.cancelAnimationFrame = clearTimeout;
Object.defineProperty(globalThis, "location", { value: { href: "http://127.0.0.1:3410/", search: "" }, configurable: true });
globalThis.HTMLCanvasElement = class {
	constructor() { this.style = {}; }
	getContext() { return null; }
	addEventListener() {}
};
globalThis.localStorage = { getItem: () => null, setItem: noop };
globalThis.fetch = noop;

try {
	vm.runInThisContext(bundle, { filename: "standalone.js" });
} catch (error) {
	console.error("SMOKE FAIL (standalone bundle execution):", error.message);
	console.error(error.stack?.split("\n").slice(0, 6).join("\n"));
	process.exit(1);
}

if (typeof globalThis.PetStandalone?.mount !== "function") {
	console.error("SMOKE FAIL: PetStandalone.mount missing");
	process.exit(1);
}
console.log("standalone bundle OK: global =", Object.keys(globalThis.PetStandalone).sort().join(", "));
console.log("standalone executes without a platform seed table (React bundled)");
console.log("SMOKE STANDALONE PASS");
