/**
 * DSH state adapter: wraps ctx.sessions as a PetStateSource.
 *
 * The subscription logic below is the original useCurrentSnapshot flow moved
 * out of src/client/index.js unchanged in behavior:
 * sessions.list -> current session -> session snapshot -> normalized PetState.
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

function normalize(snap) {
	const detail = {};
	if (snap !== null && snap !== undefined) {
		const toolName = snap.runningCalls?.[0]?.name;
		if (toolName !== undefined) detail.toolName = toolName;
		if (snap.lastAgentError) {
			const message = typeof snap.lastAgentError === "string" ? snap.lastAgentError : snap.lastAgentError?.message;
			if (typeof message === "string" && message.length > 0) detail.message = message;
		}
	}
	return {
		version: 1,
		source: "dsh",
		activity: deriveState(snap),
		detail: Object.keys(detail).length > 0 ? detail : undefined,
	};
}

export function createDshStateSource(sessions) {
	const listeners = new Set();
	let disposed = false;
	let listUnsubscribe = null;
	let sessionUnsubscribe = null;
	let snapshot = normalize(null);

	const currentSession = () => {
		let list;
		try {
			list = sessions.list.getSnapshot();
		} catch {
			return null;
		}
		const currentId = list?.current;
		if (currentId === undefined) return null;
		try {
			return sessions.binding(currentId)?.session ?? null;
		} catch {
			return null;
		}
	};

	const readSnapshot = () => {
		let snap = null;
		const session = currentSession();
		if (session !== null) {
			try {
				snap = session.getSnapshot();
			} catch {
				snap = null;
			}
		}
		return normalize(snap);
	};

	const emit = () => {
		if (disposed) return;
		snapshot = readSnapshot();
		for (const listener of listeners) listener();
	};

	const resubscribeSession = () => {
		if (sessionUnsubscribe !== null) {
			try {
				sessionUnsubscribe();
			} catch {
				/* ignore */
			}
			sessionUnsubscribe = null;
		}
		const session = currentSession();
		if (session !== null) {
			try {
				sessionUnsubscribe = session.subscribe(emit);
			} catch {
				sessionUnsubscribe = null;
			}
		}
	};

	const onListChange = () => {
		resubscribeSession();
		emit();
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
			resubscribeSession();
			snapshot = readSnapshot();
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
				try {
					sessionUnsubscribe?.();
				} catch {
					/* ignore */
				}
				sessionUnsubscribe = null;
			}
		};
	};

	const getSnapshot = () => (disposed ? null : snapshot);

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		try {
			listUnsubscribe?.();
		} catch {
			/* ignore */
		}
		try {
			sessionUnsubscribe?.();
		} catch {
			/* ignore */
		}
		listUnsubscribe = null;
		sessionUnsubscribe = null;
		listeners.clear();
	};

	return { subscribe, getSnapshot, dispose };
}
