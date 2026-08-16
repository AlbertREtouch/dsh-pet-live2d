/** Phase 2 contract tests: pending actions, bridge security and DSH lifecycle. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import {
	createDshBridgeStateSource,
	installDshEmbedHostBridge,
	readDshEmbedConfig,
} from "../src/adapters/dsh-embed.js";
import { createDshStateSource } from "../src/adapters/dsh-state.js";

const require = createRequire(import.meta.url);
const { createDshLifecycle, resolveDshConfig, spawnDetachedDsh } = require("../electron/dsh-lifecycle.cjs");

function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// DSH PendingWait -> wire-safe PetState + perform(action)
// ---------------------------------------------------------------------------

let currentSnapshot;
let sessionListener = () => {};
const responses = [];
const approvalWait = {
	kind: "approval",
	key: "a:rpc-1",
	sessionId: "session-1",
	payload: { approvalId: "approval-1", toolName: "shell_command", reason: "运行测试" },
	respond: async (result) => {
		responses.push(result);
		return { accepted: true };
	},
};
const session = {
	getSnapshot: () => currentSnapshot,
	subscribe: (listener) => {
		sessionListener = listener;
		return () => {};
	},
};
const sessions = {
	list: {
		getSnapshot: () => ({ current: "session-1" }),
		subscribe: () => () => {},
	},
	binding: () => ({ session }),
};

currentSnapshot = { running: false, pending: [approvalWait], runningCalls: [] };
const dshSource = createDshStateSource(sessions);
const unsubscribeDsh = dshSource.subscribe(() => {});
const firstPending = dshSource.getSnapshot().detail.pending[0];
assert.equal(firstPending.kind, "approval");
assert.equal(firstPending.toolName, "shell_command");
assert.equal("approvalId" in firstPending, false, "approval ids must stay inside the DSH iframe");
const firstRequestedAt = firstPending.requestedAt;
sessionListener();
assert.equal(dshSource.getSnapshot().detail.pending[0].requestedAt, firstRequestedAt, "pending timestamp must stay stable");

await dshSource.perform({ type: "pending/approve", key: "a:rpc-1" });
assert.deepEqual(responses[0], {
	ok: true,
	value: { sessionId: "session-1", approvalId: "approval-1", outcome: "allowed-once" },
});
await assert.rejects(
	() => dshSource.perform({ type: "pending/reject", key: "a:rpc-1" }),
	(error) => error.code === "action-in-flight",
);

const questionWait = {
	kind: "question",
	key: "q:rpc-2",
	sessionId: "session-1",
	payload: {
		questions: [{
			id: "choice",
			question: "选哪一个？",
			options: [{ label: "A", description: "第一项" }, { label: "B" }],
		}],
	},
	respond: async (result) => {
		responses.push(result);
		return { accepted: true };
	},
};
currentSnapshot = { running: false, pending: [questionWait], runningCalls: [] };
sessionListener();
assert.equal(dshSource.getSnapshot().detail.pending[0].quickAnswer, true);
await dshSource.perform({ type: "pending/answer-option", key: "q:rpc-2", option: "B" });
assert.deepEqual(responses[1], {
	ok: true,
	value: { sessionId: "session-1", answer: { answers: [{ id: "choice", selected: ["B"] }] } },
});

currentSnapshot = {
	running: false,
	pending: [{
		...questionWait,
		key: "q:rpc-3",
		payload: { questions: [{ ...questionWait.payload.questions[0], multiSelect: true }] },
	}],
	runningCalls: [],
};
sessionListener();
assert.equal(dshSource.getSnapshot().detail.pending[0].quickAnswer, false);
await assert.rejects(
	() => dshSource.perform({ type: "pending/answer-option", key: "q:rpc-3", option: "A" }),
	(error) => error.code === "requires-dsh-ui",
);
unsubscribeDsh();
dshSource.dispose();

// ---------------------------------------------------------------------------
// Desktop watch=all: background running/pending sessions beat stale current
// ---------------------------------------------------------------------------

let aggregateListListener = () => {};
const aggregateResponses = [];
const aggregateSnapshots = new Map();
const aggregateSessions = new Map();
const aggregateSessionListeners = new Map();
let runningOpenCalls = 0;
let resolveRunningOpen = null;
let selectionOpenCalls = 0;
const makeAggregateApproval = (sessionId, approvalId, reason) => ({
	kind: "approval",
	key: "a:shared-key",
	sessionId,
	payload: { approvalId, toolName: "shell_command", reason },
	respond: async (result) => {
		aggregateResponses.push({ sessionId, result });
		return { accepted: true };
	},
});
const pendingA = makeAggregateApproval("session-pending-a", "approval-a", "批准 A");
const pendingB = makeAggregateApproval("session-pending-b", "approval-b", "批准 B");
aggregateSnapshots.set("session-idle", { running: false, pending: [], partial: null, runningCalls: [], openState: "idle" });
aggregateSnapshots.set("session-running", { running: true, pending: [], partial: null, runningCalls: [], openState: "idle" });
aggregateSnapshots.set("session-pending-a", { running: false, pending: [pendingA], partial: null, runningCalls: [], openState: "idle" });
aggregateSnapshots.set("session-pending-b", { running: false, pending: [pendingB], partial: null, runningCalls: [], openState: "idle" });
for (const sessionId of aggregateSnapshots.keys()) {
	aggregateSessions.set(sessionId, {
		getSnapshot: () => aggregateSnapshots.get(sessionId),
		subscribe: (listener) => {
			aggregateSessionListeners.set(sessionId, listener);
			return () => {
				if (aggregateSessionListeners.get(sessionId) === listener) aggregateSessionListeners.delete(sessionId);
			};
		},
	});
}
aggregateSessions.get("session-running").open = () => {
	runningOpenCalls += 1;
	return new Promise((resolve) => {
		resolveRunningOpen = () => {
			aggregateSnapshots.set("session-running", {
				running: true,
				pending: [],
				partial: null,
				runningCalls: [{ name: "web_search" }],
				openState: "open",
			});
			aggregateSessionListeners.get("session-running")?.();
			resolve();
		};
	});
};
let aggregateList = {
	current: "session-idle",
	ids: ["session-idle", "session-running", "session-pending-a", "session-pending-b"],
	byId: {
		"session-idle": { id: "session-idle", displayTitle: "旧的空闲会话", running: false },
		"session-running": { id: "session-running", displayTitle: "后台运行会话", running: true },
		"session-pending-a": { id: "session-pending-a", displayTitle: "等待审批 A", running: false, pendingInteraction: "approval" },
		"session-pending-b": { id: "session-pending-b", displayTitle: "等待审批 B", running: false, pendingInteraction: "approval" },
	},
};
const aggregateBindings = [];
const aggregateSource = createDshStateSource({
	list: {
		getSnapshot: () => aggregateList,
		subscribe: (listener) => {
			aggregateListListener = listener;
			return () => {};
		},
	},
	binding: (sessionId) => {
		aggregateBindings.push(sessionId);
		return { session: aggregateSessions.get(sessionId) };
	},
	open: () => { selectionOpenCalls += 1; },
}, { watch: "all" });
const unsubscribeAggregate = aggregateSource.subscribe(() => {});
await tick();
assert.equal(runningOpenCalls, 1, "an active lazy session must hydrate its event window");
assert.equal(selectionOpenCalls, 0, "hydration must never change the DSH current selection");
const aggregatePendingState = aggregateSource.getSnapshot();
assert.equal(aggregatePendingState.activity, "waiting", "background pending must beat a stale idle current session");
assert.equal(aggregatePendingState.detail.pending.length, 2);
assert.deepEqual(
	aggregatePendingState.detail.pending.map((item) => item.sessionTitle),
	["等待审批 A", "等待审批 B"],
);
assert.equal(aggregateBindings.includes("session-idle"), false, "stale idle current session must not be watched while work is active");
await assert.rejects(
	() => aggregateSource.perform({ type: "pending/approve", key: "a:shared-key" }),
	(error) => error.code === "ambiguous-action",
);
await aggregateSource.perform({
	type: "pending/approve",
	key: "a:shared-key",
	sessionId: "session-pending-b",
});
assert.deepEqual(aggregateResponses, [{
	sessionId: "session-pending-b",
	result: {
		ok: true,
		value: { sessionId: "session-pending-b", approvalId: "approval-b", outcome: "allowed-once" },
	},
}]);

aggregateSnapshots.set("session-pending-a", { running: false, pending: [], partial: null, runningCalls: [], openState: "idle" });
aggregateSnapshots.set("session-pending-b", { running: false, pending: [], partial: null, runningCalls: [], openState: "idle" });
aggregateList = {
	...aggregateList,
	byId: {
		...aggregateList.byId,
		"session-pending-a": { ...aggregateList.byId["session-pending-a"], pendingInteraction: undefined },
		"session-pending-b": { ...aggregateList.byId["session-pending-b"], pendingInteraction: undefined },
	},
};
aggregateListListener();
assert.equal(aggregateSource.getSnapshot().activity, "running");
assert.equal(aggregateSource.getSnapshot().detail.sessionTitle, "后台运行会话");
assert.equal(aggregateSource.getSnapshot().detail.toolName, undefined, "coarse running fallback must work while session.open is pending");

resolveRunningOpen();
await tick();
assert.equal(aggregateSource.getSnapshot().activity, "running");
assert.equal(aggregateSource.getSnapshot().detail.toolName, "web_search");

aggregateSnapshots.set("session-running", {
	running: true,
	pending: [],
	partial: { text: "正在组织回复" },
	runningCalls: [],
	openState: "open",
});
aggregateSessionListeners.get("session-running")?.();
assert.equal(aggregateSource.getSnapshot().activity, "review", "hydrated partial output must map to review");

aggregateSnapshots.set("session-running", {
	running: true,
	pending: [],
	partial: null,
	runningCalls: [],
	openState: "open",
});
aggregateSessionListeners.get("session-running")?.();
assert.equal(aggregateSource.getSnapshot().activity, "waiting", "an open session with no output/tool is the legitimate waiting state");

aggregateSnapshots.set("session-running", { running: false, pending: [], partial: null, runningCalls: [], openState: "open" });
aggregateList = {
	...aggregateList,
	byId: {
		...aggregateList.byId,
		"session-running": { ...aggregateList.byId["session-running"], running: false },
	},
};
aggregateListListener();
assert.equal(aggregateSource.getSnapshot().activity, "idle", "all idle sessions must fall back to the current session");
unsubscribeAggregate();
aggregateSource.dispose();

// ---------------------------------------------------------------------------
// Strict postMessage origin/source/version checks in both directions
// ---------------------------------------------------------------------------

class FakeWindow {
	constructor() {
		this.listeners = new Set();
		this.parentMessages = [];
		this.parent = {
			postMessage: (message, targetOrigin) => this.parentMessages.push({ message, targetOrigin }),
		};
		this.self = {};
		this.top = {};
	}
	addEventListener(type, listener) {
		if (type === "message") this.listeners.add(listener);
	}
	removeEventListener(type, listener) {
		if (type === "message") this.listeners.delete(listener);
	}
	dispatch(event) {
		for (const listener of this.listeners) listener(event);
	}
}

const embedWindow = new FakeWindow();
const embedConfig = readDshEmbedConfig({
	locationRef: { search: "?dsh-pet-embed=1&dsh-pet-parent-origin=http%3A%2F%2F127.0.0.1%3A43123" },
	windowRef: embedWindow,
});
assert.deepEqual(embedConfig, { parentOrigin: "http://127.0.0.1:43123" });
assert.equal(readDshEmbedConfig({
	locationRef: { search: "?dsh-pet-embed=1&dsh-pet-parent-origin=https%3A%2F%2Fevil.example" },
	windowRef: embedWindow,
}), null, "non-loopback parent origins must be rejected");

const hostActions = [];
const hostSource = {
	subscribe: () => () => {},
	getSnapshot: () => ({ version: 1, source: "dsh", activity: "waiting" }),
	perform: async (action) => hostActions.push(action),
};
const disposeHost = installDshEmbedHostBridge({
	stateSource: hostSource,
	parentOrigin: embedConfig.parentOrigin,
	windowRef: embedWindow,
});
assert.ok(embedWindow.parentMessages.every((entry) => entry.targetOrigin === embedConfig.parentOrigin));
const actionMessage = {
	channel: "dsh-pet/bridge",
	version: 1,
	type: "action",
	requestId: "request-1",
	action: { type: "pending/approve", key: "a:rpc-1", sessionId: "session-1" },
};
embedWindow.dispatch({ origin: "http://127.0.0.1:9999", source: embedWindow.parent, data: actionMessage });
embedWindow.dispatch({ origin: embedConfig.parentOrigin, source: {}, data: actionMessage });
assert.equal(hostActions.length, 0);
embedWindow.dispatch({ origin: embedConfig.parentOrigin, source: embedWindow.parent, data: actionMessage });
await tick();
assert.deepEqual(hostActions, [{ type: "pending/approve", key: "a:rpc-1", sessionId: "session-1" }]);
assert.equal(embedWindow.parentMessages.at(-1).message.type, "action-result");
disposeHost();

const clientWindow = new FakeWindow();
const frameMessages = [];
const contentWindow = {
	postMessage: (message, targetOrigin) => frameMessages.push({ message, targetOrigin }),
};
const frame = { src: "about:blank", contentWindow, remove() {} };
const bridgeSource = createDshBridgeStateSource({
	frame,
	dshOrigin: "http://127.0.0.1:3080",
	parentOrigin: "http://127.0.0.1:43123",
	windowRef: clientWindow,
	timeoutMs: 1000,
});
bridgeSource.setConnectionStatus({ online: true });
assert.match(frame.src, /dsh-pet-embed=1/);
const bridgedState = { version: 1, source: "dsh", activity: "waiting", detail: { pending: [] } };
clientWindow.dispatch({
	origin: "http://127.0.0.1:9999",
	source: contentWindow,
	data: { channel: "dsh-pet/bridge", version: 1, type: "state", state: bridgedState },
});
assert.notDeepEqual(bridgeSource.getSnapshot(), bridgedState);
clientWindow.dispatch({
	origin: "http://127.0.0.1:3080",
	source: contentWindow,
	data: { channel: "dsh-pet/bridge", version: 1, type: "state", state: bridgedState },
});
assert.deepEqual(bridgeSource.getSnapshot(), bridgedState);
const actionPromise = bridgeSource.perform({ type: "pending/reject", key: "a:rpc-9", sessionId: "session-9" });
assert.equal(frameMessages[0].targetOrigin, "http://127.0.0.1:3080");
const sentAction = frameMessages[0].message;
assert.equal(sentAction.action.sessionId, "session-9");
clientWindow.dispatch({
	origin: "http://127.0.0.1:3080",
	source: contentWindow,
	data: { channel: "dsh-pet/bridge", version: 1, type: "action-result", requestId: sentAction.requestId, ok: true },
});
await actionPromise;
bridgeSource.dispose();

// ---------------------------------------------------------------------------
// DSH lifecycle: reuse before launch, detached spawn, bounded readiness
// ---------------------------------------------------------------------------

assert.deepEqual(resolveDshConfig({ DSH_PET_DSH_PORT: "4090" }), {
	port: 4090,
	origin: "http://127.0.0.1:4090",
	probePath: "/api/pets",
	command: "dsh",
	args: ["web", "--port", "4090"],
	autostart: true,
});

let launchCount = 0;
const inertTimer = () => ({ unref() {} });
const reusedLifecycle = createDshLifecycle({
	config: resolveDshConfig({}),
	probe: async () => true,
	launch: async () => { launchCount += 1; },
	setTimer: inertTimer,
	clearTimer: () => {},
});
reusedLifecycle.start();
assert.equal(await reusedLifecycle.ensureAvailable(), true);
assert.equal(launchCount, 0, "an already-running DSH must never be launched twice");
assert.equal(reusedLifecycle.getStatus().reused, true);
reusedLifecycle.stop();

const missingPluginLifecycle = createDshLifecycle({
	config: resolveDshConfig({}),
	probe: async () => ({ running: true, bridge: false }),
	launch: async () => { launchCount += 1; },
	setTimer: inertTimer,
	clearTimer: () => {},
});
missingPluginLifecycle.start();
assert.equal(await missingPluginLifecycle.ensureAvailable(), false);
assert.equal(launchCount, 0, "a listening DSH without the plugin must not be double-started");
assert.equal(missingPluginLifecycle.getStatus().phase, "plugin-missing");
missingPluginLifecycle.stop();

let clock = 0;
const probeResults = [false, true];
const launchedLifecycle = createDshLifecycle({
	config: resolveDshConfig({ DSH_PET_DSH_PORT: "4091" }),
	probe: async () => probeResults.shift() ?? true,
	launch: async () => { launchCount += 1; },
	now: () => clock,
	delay: async (ms) => { clock += ms; },
	setTimer: inertTimer,
	clearTimer: () => {},
});
launchedLifecycle.start();
assert.equal(await launchedLifecycle.ensureAvailable(), true);
assert.equal(launchCount, 1);
assert.equal(launchedLifecycle.getStatus().online, true);
launchedLifecycle.stop();

let spawnOptions = null;
let spawnCommand = null;
let spawnArgs = null;
let unrefCalled = false;
const spawned = new EventEmitter();
spawned.pid = 42;
spawned.unref = () => { unrefCalled = true; };
const spawnConfig = { ...resolveDshConfig({}), command: "C:\\fixture path\\dsh.cmd" };
const spawnedPromise = spawnDetachedDsh(spawnConfig, {
	spawnImpl: (command, args, options) => {
		spawnCommand = command;
		spawnArgs = args;
		spawnOptions = options;
		queueMicrotask(() => spawned.emit("spawn"));
		return spawned;
	},
});
assert.equal((await spawnedPromise).pid, 42);
assert.equal(spawnOptions.detached, true);
assert.equal(spawnOptions.stdio, "ignore");
assert.equal(unrefCalled, true);
if (process.platform === "win32") {
	assert.equal(spawnCommand.toLowerCase(), (process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe").toLowerCase());
	assert.deepEqual(spawnArgs.slice(0, 4), ["/d", "/s", "/c", spawnConfig.command]);
}

console.log("PHASE 2 UNIT PASS");
