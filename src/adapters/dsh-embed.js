/**
 * Versioned, origin-locked postMessage transport used by Phase 2.
 *
 * The DSH plugin runs the host side inside an explicitly opted-in iframe.
 * The standalone pet owns the client side. Neither side ever uses `*` as a
 * postMessage target, and both validate origin, source window, channel and
 * protocol version before reading a payload.
 */

export const DSH_PET_BRIDGE_CHANNEL = "dsh-pet/bridge";
export const DSH_PET_BRIDGE_VERSION = 1;

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loopbackOrigin(raw) {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
	try {
		const url = new URL(raw);
		const hostname = url.hostname.toLowerCase();
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") return null;
		return url.origin;
	} catch {
		return null;
	}
}

function bridgeMessage(type, payload = {}) {
	return {
		channel: DSH_PET_BRIDGE_CHANNEL,
		version: DSH_PET_BRIDGE_VERSION,
		type,
		...payload,
	};
}

function isBridgeMessage(data, type = null) {
	return (
		isRecord(data) &&
		data.channel === DSH_PET_BRIDGE_CHANNEL &&
		data.version === DSH_PET_BRIDGE_VERSION &&
		(typeof type !== "string" || data.type === type)
	);
}

function safeRequestId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

function safeAction(value) {
	if (!isRecord(value)) return null;
	if (!["pending/approve", "pending/reject", "pending/answer-option"].includes(value.type)) return null;
	if (typeof value.key !== "string" || value.key.length === 0 || value.key.length > 256) return null;
	const sessionId = value.sessionId === undefined
		? undefined
		: typeof value.sessionId === "string" && value.sessionId.length > 0 && value.sessionId.length <= 256
			? value.sessionId
			: null;
	if (sessionId === null) return null;
	if (value.type === "pending/answer-option") {
		if (typeof value.option !== "string" || value.option.length === 0 || value.option.length > 120) return null;
		return { type: value.type, key: value.key, ...(sessionId === undefined ? {} : { sessionId }), option: value.option };
	}
	return { type: value.type, key: value.key, ...(sessionId === undefined ? {} : { sessionId }) };
}

function connectionState(phase, message) {
	return {
		version: 1,
		source: "dsh",
		activity: phase === "offline" ? "failed" : "waiting",
		detail: {
			connection: phase,
			message,
		},
	};
}

/** Detect the explicit DSH iframe mode and validate its loopback parent. */
export function readDshEmbedConfig({ locationRef = globalThis.location, windowRef = globalThis.window } = {}) {
	try {
		const params = new URLSearchParams(locationRef.search);
		if (params.get("dsh-pet-embed") !== "1") return null;
		if (windowRef.self === windowRef.top) return null;
		const parentOrigin = loopbackOrigin(params.get("dsh-pet-parent-origin"));
		return parentOrigin === null ? null : { parentOrigin };
	} catch {
		return null;
	}
}

/** Install the DSH-iframe side of the bridge. */
export function installDshEmbedHostBridge({ stateSource, parentOrigin, windowRef = globalThis.window }) {
	const targetOrigin = loopbackOrigin(parentOrigin);
	if (targetOrigin === null) throw new TypeError("installDshEmbedHostBridge: invalid loopback parent origin");
	if (stateSource === null || typeof stateSource?.subscribe !== "function" || typeof stateSource?.getSnapshot !== "function") {
		throw new TypeError("installDshEmbedHostBridge: invalid state source");
	}
	let disposed = false;

	const post = (message) => {
		if (!disposed) windowRef.parent.postMessage(message, targetOrigin);
	};
	const sendState = () => {
		let state = null;
		try {
			state = stateSource.getSnapshot();
		} catch {
			state = null;
		}
		post(bridgeMessage("state", { state }));
	};
	const unsubscribe = stateSource.subscribe(sendState);
	const onMessage = (event) => {
		if (disposed || event.origin !== targetOrigin || event.source !== windowRef.parent) return;
		if (!isBridgeMessage(event.data, "action")) return;
		const requestId = safeRequestId(event.data.requestId);
		const action = safeAction(event.data.action);
		if (requestId === null || action === null) return;
		if (typeof stateSource.perform !== "function") {
			post(bridgeMessage("action-result", {
				requestId,
				ok: false,
				error: { code: "unsupported-action", message: "DSH 状态源不支持动作" },
			}));
			return;
		}
		Promise.resolve()
			.then(() => stateSource.perform(action))
			.then(() => {
				post(bridgeMessage("action-result", { requestId, ok: true }));
			})
			.catch((error) => {
				post(bridgeMessage("action-result", {
					requestId,
					ok: false,
					error: {
						code: typeof error?.code === "string" ? error.code.slice(0, 80) : "action-failed",
						message: String(error?.message ?? error).slice(0, 320),
					},
				}));
			});
	};

	windowRef.addEventListener("message", onMessage);
	post(bridgeMessage("ready"));
	sendState();

	return () => {
		if (disposed) return;
		disposed = true;
		windowRef.removeEventListener("message", onMessage);
		try {
			unsubscribe?.();
		} catch {
			/* ignore */
		}
	};
}

export function buildDshEmbedUrl(dshOrigin, parentOrigin) {
	const sourceOrigin = loopbackOrigin(dshOrigin);
	const safeParentOrigin = loopbackOrigin(parentOrigin);
	if (sourceOrigin === null || safeParentOrigin === null) throw new TypeError("buildDshEmbedUrl: origins must be loopback HTTP(S)");
	const url = new URL("/", sourceOrigin);
	url.searchParams.set("dsh-pet-embed", "1");
	url.searchParams.set("dsh-pet-parent-origin", safeParentOrigin);
	return url.href;
}

function requestId() {
	try {
		return globalThis.crypto.randomUUID();
	} catch {
		return `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	}
}

/** Create the standalone-pet side PetStateSource over a hidden DSH iframe. */
export function createDshBridgeStateSource({
	frame,
	dshOrigin,
	parentOrigin = globalThis.location?.origin,
	windowRef = globalThis.window,
	timeoutMs = 8000,
} = {}) {
	const sourceOrigin = loopbackOrigin(dshOrigin);
	const safeParentOrigin = loopbackOrigin(parentOrigin);
	if (sourceOrigin === null || safeParentOrigin === null) throw new TypeError("createDshBridgeStateSource: invalid loopback origin");
	if (frame === null || typeof frame !== "object") throw new TypeError("createDshBridgeStateSource: iframe is required");

	const listeners = new Set();
	const requests = new Map();
	let disposed = false;
	let online = false;
	let snapshot = connectionState("connecting", "正在连接 DSH");
	const embedUrl = buildDshEmbedUrl(sourceOrigin, safeParentOrigin);

	const emit = () => {
		for (const listener of listeners) listener();
	};
	const rejectRequests = (message) => {
		for (const pending of requests.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(message));
		}
		requests.clear();
	};
	const onMessage = (event) => {
		if (disposed || event.origin !== sourceOrigin || event.source !== frame.contentWindow) return;
		if (!isBridgeMessage(event.data)) return;
		if (event.data.type === "state") {
			const next = event.data.state;
			if (!isRecord(next) || next.version !== 1 || typeof next.source !== "string" || typeof next.activity !== "string") return;
			online = true;
			snapshot = next;
			emit();
			return;
		}
		if (event.data.type === "action-result") {
			const id = safeRequestId(event.data.requestId);
			if (id === null) return;
			const pending = requests.get(id);
			if (pending === undefined) return;
			requests.delete(id);
			clearTimeout(pending.timer);
			if (event.data.ok === true) pending.resolve({ ok: true });
			else {
				const error = new Error(String(event.data.error?.message ?? "DSH 动作失败"));
				if (typeof event.data.error?.code === "string") error.code = event.data.error.code;
				pending.reject(error);
			}
		}
	};

	windowRef.addEventListener("message", onMessage);

	const subscribe = (listener) => {
		if (disposed) return () => {};
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	const getSnapshot = () => (disposed ? null : snapshot);
	const setConnectionStatus = (status) => {
		if (disposed || !isRecord(status)) return;
		if (status.online === true) {
			if (!online || frame.src !== embedUrl) {
				online = true;
				snapshot = connectionState("connecting", "正在同步 DSH 会话");
				emit();
				frame.src = embedUrl;
			}
			return;
		}
		online = false;
		rejectRequests("DSH 连接已断开");
		const phase = status.phase === "offline" || status.phase === "plugin-missing" ? "offline" : "connecting";
		const message = typeof status.message === "string"
			? status.message.slice(0, 320)
			: phase === "offline" ? "DSH 当前不可用" : "正在启动 DSH";
		snapshot = connectionState(phase, message);
		emit();
		if (phase === "offline") frame.src = "about:blank";
	};
	const perform = (action) => {
		if (disposed) return Promise.reject(new Error("DSH bridge 已关闭"));
		const safe = safeAction(action);
		if (safe === null) return Promise.reject(new Error("动作格式无效"));
		if (!online || frame.contentWindow === null) return Promise.reject(new Error("DSH 尚未连接"));
		const id = requestId();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				requests.delete(id);
				reject(new Error("DSH 动作响应超时"));
			}, timeoutMs);
			requests.set(id, { resolve, reject, timer });
			frame.contentWindow.postMessage(bridgeMessage("action", { requestId: id, action: safe }), sourceOrigin);
		});
	};
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		windowRef.removeEventListener("message", onMessage);
		rejectRequests("DSH bridge 已关闭");
		listeners.clear();
		try {
			frame.remove();
		} catch {
			/* ignore */
		}
	};

	return { subscribe, getSnapshot, perform, setConnectionStatus, dispose, dshOrigin: sourceOrigin };
}
