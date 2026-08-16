/**
 * DSH state adapter: wraps ctx.sessions as a PetStateSource.
 *
 * DSH-page overlays retain the original current-session behavior. The desktop
 * iframe opts into watch=all, which follows list-level running/pending signals
 * and subscribes only those interesting sessions (falling back to current when
 * all sessions are idle).
 */

/**
 * Derive the pet mood from the current session's conversation snapshot.
 * Exact order matters (and is covered by DEVLOG/README):
 * lastAgentError -> failed; running===true: runningCalls -> running,
 * partial -> review, otherwise waiting; pending>0 -> waiting; else idle.
 */
export function deriveState(snap) {
	if (snap === null || snap === undefined) return "idle";
	if (snap.lastAgentError) return "failed";
	if (snap.running === true) {
		if (snap.runningCalls !== undefined && snap.runningCalls.length > 0) return "running";
		if (snap.partial) return "review";
		return "waiting";
	}
	if (snap.pending !== undefined && snap.pending.length > 0) return "waiting";
	return "idle";
}

const MAX_PENDING = 8;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;

function clippedText(value, maxLength = 240) {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (text.length === 0) return undefined;
	return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function summarizeQuestion(question) {
	if (question === null || typeof question !== "object") return null;
	const id = clippedText(question.id, 128);
	const prompt = clippedText(question.question, 320);
	if (id === undefined || prompt === undefined) return null;
	const options = Array.isArray(question.options)
		? question.options
			.slice(0, MAX_OPTIONS)
			.map((option) => {
				const label = clippedText(option?.label, 120);
				if (label === undefined) return null;
				const description = clippedText(option?.description, 240);
				return description === undefined ? { label } : { label, description };
			})
			.filter(Boolean)
		: [];
	const header = clippedText(question.header, 80);
	const detail = clippedText(question.detail, 480);
	const intentKind = clippedText(question.intent?.kind, 64);
	return {
		id,
		question: prompt,
		...(header === undefined ? {} : { header }),
		...(detail === undefined ? {} : { detail }),
		...(options.length === 0 ? {} : { options }),
		...(question.multiSelect === true ? { multiSelect: true } : {}),
		...(intentKind === undefined ? {} : { intent: intentKind }),
	};
}

function isQuickQuestion(questions) {
	return (
		questions.length === 1 &&
		questions[0].multiSelect !== true &&
		questions[0].intent === undefined &&
		Array.isArray(questions[0].options) &&
		questions[0].options.length > 0
	);
}

function pendingIdentity(sessionId, key) {
	return `${String(sessionId).length}:${String(sessionId)}${String(key)}`;
}

function waitIdentity(wait, fallbackSessionId = "") {
	return pendingIdentity(wait?.sessionId ?? fallbackSessionId, wait?.key ?? "");
}

function summarizePending(wait, requestedAt, sessionTitle) {
	const key = clippedText(wait?.key, 256);
	const sessionId = clippedText(wait?.sessionId, 256);
	if (key === undefined || sessionId === undefined) return null;
	const session = clippedText(sessionTitle, 160);
	if (wait.kind === "approval") {
		const toolName = clippedText(wait.payload?.toolName, 160) ?? "操作";
		const reason = clippedText(wait.payload?.reason, 320);
		return {
			key,
			kind: "approval",
			sessionId,
			...(session === undefined ? {} : { sessionTitle: session }),
			requestedAt,
			toolName,
			...(reason === undefined ? {} : { reason }),
		};
	}
	if (wait.kind === "question") {
		const questions = Array.isArray(wait.payload?.questions)
			? wait.payload.questions.slice(0, MAX_QUESTIONS).map(summarizeQuestion).filter(Boolean)
			: [];
		return {
			key,
			kind: "question",
			sessionId,
			...(session === undefined ? {} : { sessionTitle: session }),
			requestedAt,
			questions,
			quickAnswer: isQuickQuestion(questions),
		};
	}
	return null;
}

/** Convert a DSH ConversationSnapshot into the wire-safe PetState contract. */
export function normalizeDshSnapshot(snap, { pendingSince = new Map(), now = Date.now() } = {}) {
	const detail = {};
	if (snap !== null && snap !== undefined) {
		const toolName = snap.runningCalls?.[0]?.name;
		if (toolName !== undefined) detail.toolName = toolName;
		if (snap.lastAgentError) {
			const message = typeof snap.lastAgentError === "string" ? snap.lastAgentError : snap.lastAgentError?.message;
			if (typeof message === "string" && message.length > 0) detail.message = message;
		}
		const liveKeys = new Set();
		const pending = Array.isArray(snap.pending)
			? snap.pending.slice(0, MAX_PENDING).map((wait) => {
				const key = typeof wait?.key === "string" ? wait.key : null;
				if (key === null) return null;
				const identity = waitIdentity(wait);
				liveKeys.add(identity);
				if (!pendingSince.has(identity)) pendingSince.set(identity, now);
				return summarizePending(wait, pendingSince.get(identity));
			}).filter(Boolean)
			: [];
		for (const key of pendingSince.keys()) {
			if (!liveKeys.has(key)) pendingSince.delete(key);
		}
		if (pending.length > 0) {
			detail.pending = pending;
			detail.since = Math.min(...pending.map((item) => item.requestedAt));
		}
	} else {
		pendingSince.clear();
	}
	return {
		version: 1,
		source: "dsh",
		activity: deriveState(snap),
		detail: Object.keys(detail).length > 0 ? detail : undefined,
	};
}

function sessionTitle(entry) {
	return entry?.row?.displayTitle ?? entry?.row?.title ?? entry?.sessionId;
}

function stateForEntry(entry) {
	if (entry?.snapshot !== null && entry?.snapshot !== undefined) {
		// A binding is intentionally lazy in DSH: before session.open() hydrates
		// the event window it carries the coarse running bit but has no partial or
		// runningCalls. Treat that loading gap as running; once open, the original
		// detailed mapping (tool -> running, partial -> review, otherwise waiting)
		// becomes authoritative again.
		if (
			entry.row?.running === true &&
			entry.snapshot.running === true &&
			entry.snapshot.openState !== "open" &&
			!entry.snapshot.partial &&
			(!Array.isArray(entry.snapshot.runningCalls) || entry.snapshot.runningCalls.length === 0)
		) return "running";
		return deriveState(entry.snapshot);
	}
	if (entry?.row?.pendingInteraction !== undefined || entry?.row?.running === true) return "waiting";
	return "idle";
}

/** Aggregate the interesting sessions used by the standalone desktop pet. */
export function normalizeDshSessions(entries, { pendingSince = new Map(), now = Date.now() } = {}) {
	const safeEntries = Array.isArray(entries) ? entries.filter((entry) => entry?.sessionId !== undefined) : [];
	const liveKeys = new Set();
	const pending = [];
	for (const entry of safeEntries) {
		const waits = Array.isArray(entry.snapshot?.pending) ? entry.snapshot.pending.slice(0, MAX_PENDING) : [];
		for (const wait of waits) {
			if (typeof wait?.key !== "string") continue;
			const identity = waitIdentity(wait, entry.sessionId);
			liveKeys.add(identity);
			if (!pendingSince.has(identity)) pendingSince.set(identity, now);
			const summary = summarizePending(wait, pendingSince.get(identity), sessionTitle(entry));
			if (summary !== null) pending.push(summary);
			if (pending.length >= MAX_PENDING) break;
		}
		if (pending.length >= MAX_PENDING) break;
	}
	for (const key of pendingSince.keys()) {
		if (!liveKeys.has(key)) pendingSince.delete(key);
	}
	pending.sort((left, right) => left.requestedAt - right.requestedAt || left.sessionId.localeCompare(right.sessionId));

	const states = safeEntries.map((entry) => ({ entry, activity: stateForEntry(entry) }));
	let activity = "idle";
	if (pending.length > 0 || safeEntries.some((entry) => entry.row?.pendingInteraction !== undefined)) {
		activity = "waiting";
	} else {
		for (const candidate of ["failed", "running", "review", "waiting"]) {
			if (states.some((state) => state.activity === candidate)) {
				activity = candidate;
				break;
			}
		}
	}

	const preferred = pending.length > 0
		? safeEntries.find((entry) => entry.sessionId === pending[0].sessionId)
		: states.find((state) => state.activity === activity)?.entry;
	const detail = {};
	if (preferred !== undefined) {
		const title = clippedText(sessionTitle(preferred), 160);
		if (title !== undefined) detail.sessionTitle = title;
		const toolName = preferred.snapshot?.runningCalls?.[0]?.name;
		if (toolName !== undefined) detail.toolName = toolName;
		if (preferred.snapshot?.lastAgentError) {
			const message = typeof preferred.snapshot.lastAgentError === "string"
				? preferred.snapshot.lastAgentError
				: preferred.snapshot.lastAgentError?.message;
			if (typeof message === "string" && message.length > 0) detail.message = message;
		}
	}
	if (safeEntries.length > 1) detail.sessionCount = safeEntries.length;
	if (pending.length > 0) {
		detail.pending = pending;
		detail.since = Math.min(...pending.map((item) => item.requestedAt));
	}
	return {
		version: 1,
		source: "dsh",
		activity,
		detail: Object.keys(detail).length > 0 ? detail : undefined,
	};
}

function actionError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function directQuestion(wait) {
	const questions = Array.isArray(wait?.payload?.questions) ? wait.payload.questions : [];
	if (questions.length !== 1) return null;
	const question = questions[0];
	if (question?.multiSelect === true || question?.intent !== undefined) return null;
	if (!Array.isArray(question?.options) || question.options.length === 0) return null;
	return question;
}

export function createDshStateSource(sessions, { watch = "current" } = {}) {
	if (watch !== "current" && watch !== "all") throw new TypeError("createDshStateSource: watch must be current or all");
	const listeners = new Set();
	let disposed = false;
	let listUnsubscribe = null;
	const sessionSubscriptions = new Map();
	const sessionOpenRequests = new Map();
	let snapshot = normalizeDshSnapshot(null);
	const pendingSince = new Map();
	const pendingByIdentity = new Map();
	const pendingActions = new Set();

	const readList = () => {
		try {
			return sessions.list.getSnapshot();
		} catch {
			return null;
		}
	};

	const desiredSessionIds = (list) => {
		const currentId = list?.current;
		if (watch === "current") return currentId === undefined ? [] : [currentId];
		const interesting = [];
		for (const id of Array.isArray(list?.ids) ? list.ids : []) {
			const row = list?.byId?.[id];
			if (row?.running === true || row?.pendingInteraction !== undefined) interesting.push(id);
		}
		const currentRow = currentId === undefined ? undefined : list?.byId?.[currentId];
		if (
			currentId !== undefined &&
			!interesting.includes(currentId) &&
			(currentRow?.running === true || currentRow?.pendingInteraction !== undefined)
		) interesting.push(currentId);
		if (interesting.length > 0) return interesting;
		return currentId === undefined ? [] : [currentId];
	};

	const resolveSession = (id) => {
		const subscribed = sessionSubscriptions.get(id)?.session;
		if (subscribed !== undefined) return subscribed;
		try {
			return sessions.binding(id)?.session ?? null;
		} catch {
			return null;
		}
	};

	const readEntries = (list) => desiredSessionIds(list).map((sessionId) => {
		const session = resolveSession(sessionId);
		let sessionSnapshot = null;
		if (session !== null) {
			try {
				sessionSnapshot = session.getSnapshot();
			} catch {
				sessionSnapshot = null;
			}
		}
		return { sessionId, row: list?.byId?.[sessionId], snapshot: sessionSnapshot };
	});

	const readSnapshot = (list = readList()) => {
		const entries = readEntries(list);
		pendingByIdentity.clear();
		for (const entry of entries) {
			if (!Array.isArray(entry.snapshot?.pending)) continue;
			for (const wait of entry.snapshot.pending) {
				if (typeof wait?.key !== "string") continue;
				const identity = waitIdentity(wait, entry.sessionId);
				pendingByIdentity.set(identity, { identity, wait });
			}
		}
		for (const key of pendingActions) {
			if (!pendingByIdentity.has(key)) pendingActions.delete(key);
		}
		if (watch === "all") return normalizeDshSessions(entries, { pendingSince });
		return normalizeDshSnapshot(entries[0]?.snapshot ?? null, { pendingSince });
	};

	const emit = (list = readList()) => {
		if (disposed) return;
		snapshot = readSnapshot(list);
		for (const listener of listeners) listener();
	};

	const shouldOpenSession = (id, list) => {
		if (watch !== "all") return false;
		const row = list?.byId?.[id];
		return row?.running === true || row?.pendingInteraction !== undefined;
	};

	const ensureSessionOpen = (id, session, list) => {
		if (!shouldOpenSession(id, list) || typeof session?.open !== "function") return;
		try {
			if (session.getSnapshot()?.openState === "open") return;
		} catch {
			/* open() remains the authoritative retry path */
		}
		if (sessionOpenRequests.has(id)) return;
		const request = Promise.resolve()
			.then(() => session.open())
			.catch(() => undefined)
			.finally(() => {
				if (sessionOpenRequests.get(id) === request) sessionOpenRequests.delete(id);
				if (!disposed && listeners.size > 0 && sessionSubscriptions.get(id)?.session === session) emit();
			});
		sessionOpenRequests.set(id, request);
	};

	const syncSessionSubscriptions = (list) => {
		const desired = new Set(desiredSessionIds(list));
		for (const [id, entry] of sessionSubscriptions) {
			if (desired.has(id)) continue;
			try {
				entry.unsubscribe();
			} catch {
				/* ignore */
			}
			sessionSubscriptions.delete(id);
		}
		for (const id of desired) {
			const existing = sessionSubscriptions.get(id);
			if (existing !== undefined) {
				ensureSessionOpen(id, existing.session, list);
				continue;
			}
			const session = resolveSession(id);
			if (session === null) continue;
			try {
				const unsubscribe = session.subscribe(() => emit());
				sessionSubscriptions.set(id, { session, unsubscribe: typeof unsubscribe === "function" ? unsubscribe : () => {} });
				ensureSessionOpen(id, session, list);
			} catch {
				/* ignore */
			}
		}
	};

	const onListChange = () => {
		const list = readList();
		syncSessionSubscriptions(list);
		emit(list);
	};

	const subscribe = (listener) => {
		if (disposed) return () => {};
		listeners.add(listener);
		if (listUnsubscribe === null) {
			try {
				listUnsubscribe = sessions.list.subscribe(onListChange);
			} catch {
				listUnsubscribe = () => {};
			}
			const list = readList();
			syncSessionSubscriptions(list);
			snapshot = readSnapshot(list);
		}
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0 && listUnsubscribe !== null) {
				try {
					listUnsubscribe();
				} catch {
					/* ignore */
				}
				listUnsubscribe = null;
				for (const entry of sessionSubscriptions.values()) {
					try {
						entry.unsubscribe();
					} catch {
						/* ignore */
					}
				}
				sessionSubscriptions.clear();
			}
		};
	};

	const getSnapshot = () => (disposed ? null : snapshot);

	const perform = async (action) => {
		if (disposed) throw actionError("disposed", "DSH 状态源已关闭");
		if (action === null || typeof action !== "object") throw actionError("invalid-action", "动作格式无效");
		const key = typeof action.key === "string" ? action.key : "";
		if (key.length === 0 || key.length > 256) throw actionError("invalid-action", "动作缺少有效 pending key");
		// Refresh the carrier map immediately before acting so stale bubble clicks
		// can never answer a wait that has already disappeared or changed.
		const list = readList();
		if (listUnsubscribe !== null) syncSessionSubscriptions(list);
		snapshot = readSnapshot(list);
		const requestedSessionId = typeof action.sessionId === "string" ? action.sessionId : null;
		const matches = [...pendingByIdentity.values()].filter(({ wait }) => (
			wait.key === key && (requestedSessionId === null || wait.sessionId === requestedSessionId)
		));
		if (matches.length === 0) throw actionError("stale-action", "该请求已经处理或失效");
		if (matches.length > 1) throw actionError("ambiguous-action", "多个会话存在同名请求，请指定 sessionId");
		const { identity, wait } = matches[0];
		if (pendingActions.has(identity)) throw actionError("action-in-flight", "该请求正在处理");

		let result;
		if (action.type === "pending/approve" || action.type === "pending/reject") {
			if (wait.kind !== "approval") throw actionError("kind-mismatch", "该请求不是审批请求");
			result = {
				ok: true,
				value: {
					sessionId: wait.sessionId,
					approvalId: wait.payload.approvalId,
					outcome: action.type === "pending/approve" ? "allowed-once" : "rejected",
				},
			};
		} else if (action.type === "pending/answer-option") {
			if (wait.kind !== "question") throw actionError("kind-mismatch", "该请求不是提问请求");
			const question = directQuestion(wait);
			if (question === null) throw actionError("requires-dsh-ui", "这个问题需要在 DSH 界面中回答");
			const option = typeof action.option === "string" ? action.option : "";
			if (!question.options.some((candidate) => candidate?.label === option)) {
				throw actionError("invalid-option", "所选答案不属于当前问题");
			}
			result = {
				ok: true,
				value: {
					sessionId: wait.sessionId,
					answer: { answers: [{ id: question.id, selected: [option] }] },
				},
			};
		} else {
			throw actionError("unsupported-action", "不支持的宠物动作");
		}

		pendingActions.add(identity);
		try {
			const receipt = await wait.respond(result);
			if (receipt?.accepted === false) throw actionError("response-rejected", receipt.reason ?? "DSH 拒绝了响应");
			return { ok: true, key };
		} catch (error) {
			pendingActions.delete(identity);
			throw error;
		}
	};

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		try {
			listUnsubscribe?.();
		} catch {
			/* ignore */
		}
		listUnsubscribe = null;
		for (const entry of sessionSubscriptions.values()) {
			try {
				entry.unsubscribe();
			} catch {
				/* ignore */
			}
		}
		sessionSubscriptions.clear();
		sessionOpenRequests.clear();
		listeners.clear();
		pendingByIdentity.clear();
		pendingSince.clear();
		pendingActions.clear();
	};

	return { subscribe, getSnapshot, perform, dispose };
}
