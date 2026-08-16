/**
 * PetStateBus: subscribes to one or more PetStateSource adapters and exposes
 * a useSyncExternalStore-compatible store to the renderer.
 *
 * Phase 0 keeps a single source; the API is already the multi-source shape
 * so Phase 3 can add priority merging without touching the renderer.
 */

export function createPetStateBus(source) {
	if (source === null || typeof source?.subscribe !== "function" || typeof source?.getSnapshot !== "function") {
		throw new TypeError("createPetStateBus: source must implement subscribe/getSnapshot");
	}
	const listeners = new Set();
	let snapshot = null;
	let unsubscribed = null;
	let disposed = false;

	const emit = () => {
		if (disposed) return;
		try {
			snapshot = source.getSnapshot();
		} catch {
			snapshot = null;
		}
		for (const listener of listeners) listener();
	};

	const subscribe = (listener) => {
		if (disposed) return () => {};
		listeners.add(listener);
		if (unsubscribed === null) {
			try {
				unsubscribed = source.subscribe(emit);
			} catch {
				unsubscribed = () => {};
			}
			emit();
		}
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0 && unsubscribed !== null) {
				try {
					unsubscribed();
				} catch {
					/* ignore */
				}
				unsubscribed = null;
			}
		};
	};

	const getSnapshot = () => (disposed ? null : snapshot);
	const perform = (action) => {
		if (disposed) return Promise.reject(new Error("PetStateBus is disposed"));
		if (typeof source.perform !== "function") return Promise.reject(new Error("PetStateSource does not support actions"));
		return Promise.resolve().then(() => source.perform(action));
	};

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		try {
			unsubscribed?.();
		} catch {
			/* ignore */
		}
		unsubscribed = null;
		listeners.clear();
		try {
			source.dispose?.();
		} catch {
			/* ignore */
		}
	};

	return { subscribe, getSnapshot, perform, dispose };
}
