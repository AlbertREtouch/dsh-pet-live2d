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
let smokeListSnapshot = { current: undefined, ids: [], byId: {} };
let backgroundSnapshot = { running: true, pending: [], partial: null, runningCalls: [], openState: "idle" };
let backgroundListener = noop;
let backgroundOpenCalls = 0;
const backgroundSession = {
	getSnapshot: () => backgroundSnapshot,
	subscribe: (listener) => {
		backgroundListener = listener;
		return noop;
	},
	open: async () => {
		backgroundOpenCalls += 1;
		backgroundSnapshot = {
			running: true,
			pending: [],
			partial: null,
			runningCalls: [{ name: "background-tool" }],
			openState: "open",
		};
		backgroundListener();
	},
};
const fakeCtx = {
	sessions: {
		list: { getSnapshot: () => smokeListSnapshot, subscribe: () => noop },
		binding: (id) => id === "background-session" ? { session: backgroundSession } : undefined,
	},
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

// Explicit iframe embed mode must expose only the state/action bridge and
// never register a second pet overlay inside DSH.
const bridgeMessages = [];
const parentWindow = {
	postMessage: (message, targetOrigin) => bridgeMessages.push({ message, targetOrigin }),
};
window.self = window;
window.top = parentWindow;
window.parent = parentWindow;
window.addEventListener = noop;
window.removeEventListener = noop;
location.search = "?dsh-pet-embed=1&dsh-pet-parent-origin=http%3A%2F%2F127.0.0.1%3A43123";
smokeListSnapshot = {
	current: undefined,
	ids: ["background-session"],
	byId: {
		"background-session": { id: "background-session", displayTitle: "后台会话", running: true },
	},
};
const beforeEmbedRegistrations = registrations.length;
try {
	plugin.apply(fakeCtx);
} catch (error) {
	console.error("SMOKE FAIL (embed apply):", error.message);
	process.exit(1);
}
if (registrations.length !== beforeEmbedRegistrations) {
	console.error("SMOKE FAIL: embed mode registered a duplicate overlay");
	process.exit(1);
}
await new Promise((resolve) => setTimeout(resolve, 0));
const embeddedStates = bridgeMessages.filter((entry) => entry.message?.type === "state" && entry.targetOrigin === "http://127.0.0.1:43123");
const embeddedState = embeddedStates.at(-1);
if (embeddedState === undefined) {
	console.error("SMOKE FAIL: embed bridge did not publish state to the exact parent origin");
	process.exit(1);
}
if (
	backgroundOpenCalls !== 1 ||
	embeddedState.message.state?.activity !== "running" ||
	embeddedState.message.state?.detail?.sessionTitle !== "后台会话" ||
	embeddedState.message.state?.detail?.toolName !== "background-tool"
) {
	console.error("SMOKE FAIL: embed bridge did not aggregate a background running session", JSON.stringify(embeddedState.message.state));
	process.exit(1);
}
console.log("embed apply OK: lazy session hydrated, all-session state bridge, exact targetOrigin");
console.log("SMOKE PASS");
