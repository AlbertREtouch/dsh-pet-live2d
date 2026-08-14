/**
 * Smoke-test the built client bundle in Node with a stubbed browser
 * environment: executes the factory (runs pixi/live2d module bodies and the
 * Cubism-core init), then wires `apply()` against a fake ctx to verify the
 * slot registration path. Catches load-time errors before a browser refresh.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const bundle = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// --- browser-ish global stubs -------------------------------------------------
const noop = () => {};
globalThis.window = globalThis;
globalThis.document = {
	createElement: () => ({ style: {}, dataset: {}, appendChild: noop, remove: noop, setPointerCapture: noop }),
	querySelector: () => null,
	querySelectorAll: () => [],
	head: { appendChild: noop },
	body: {},
};
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node-smoke", platform: "Win32" }, configurable: true });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(16), 16);
globalThis.cancelAnimationFrame = clearTimeout;
Object.defineProperty(globalThis, "location", { value: { href: "http://127.0.0.1:3080/" }, configurable: true });
globalThis.HTMLCanvasElement = class {
	constructor() { this.style = {}; }
	getContext() { return null; }
	addEventListener() {}
};

let factory = null;
window.__ModuleLoader__ = {
	load: ({ id, factory: f }) => {
		if (id !== "dsh-pet") throw new Error(`unexpected bundle id ${id}`);
		factory = f;
	},
};

try {
	vm.runInThisContext(bundle, { filename: "client.js" });
} catch (error) {
	console.error("SMOKE FAIL (bundle execution):", error.message);
	process.exit(1);
}
if (factory === null) {
	console.error("SMOKE FAIL: factory never registered");
	process.exit(1);
}

// react / jsx-runtime are platform seeds; provide minimal stubs (components
// never render in this smoke test).
const reactStub = {
	Component: class {},
	createElement: () => ({}),
};
const requireStub = (spec) => {
	if (spec === "react") return reactStub;
	if (spec === "react/jsx-runtime") return { jsx: () => ({}), jsxs: () => ({}), Fragment: {} };
	throw new Error(`unexpected external require: ${spec}`);
};

let plugin;
try {
	plugin = factory(requireStub);
} catch (error) {
	console.error("SMOKE FAIL (factory execution):", error.message);
	console.error(error.stack?.split("\n").slice(0, 6).join("\n"));
	process.exit(1);
}

console.log("factory OK; exports:", Object.keys(plugin).sort().join(", "));
if (typeof plugin.apply !== "function" || !Array.isArray(plugin.inject)) {
	console.error("SMOKE FAIL: missing apply/inject");
	process.exit(1);
}
if (typeof globalThis.Live2DCubismCore?.Moc !== "function" || typeof globalThis.Live2DCubismCore?.Model !== "function") {
	console.error("SMOKE FAIL: Live2DCubismCore API missing after init");
	process.exit(1);
}
console.log("Cubism Core global OK (Moc/Model present)");

// --- apply wiring ------------------------------------------------------------
const registrations = [];
const fakeCtx = {
	sessions: { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => noop } },
	slots: { register: (decl, component) => { registrations.push(decl); return noop; } },
	effect: (fn) => fn(),
	logger: { warn: noop },
};
try {
	plugin.apply(fakeCtx);
} catch (error) {
	console.error("SMOKE FAIL (apply):", error.message);
	process.exit(1);
}
const overlay = registrations.find((r) => r.name === "shell.overlay");
if (overlay === undefined || overlay.id !== "dsh-pet") {
	console.error("SMOKE FAIL: shell.overlay registration missing:", JSON.stringify(registrations));
	process.exit(1);
}
console.log("apply OK: slot registration =", JSON.stringify(overlay));
console.log("SMOKE PASS");
