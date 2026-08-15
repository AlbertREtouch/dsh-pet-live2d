/**
 * Mock state source: cycles through a configurable activity list on a timer.
 * Used by the standalone preview until real sources (DSH/Codex/...) attach.
 */
export function createMockStateSource({ intervalMs = 8000, activities = ["idle", "review", "running", "waiting", "idle", "failed"] } = {}) {
	const listeners = new Set();
	let index = 0;
	let timer = null;
	let snapshot = {
		version: 1,
		source: "mock",
		activity: activities[0] ?? "idle",
		detail: undefined,
	};

	const emit = () => {
		const activity = activities[index % activities.length];
		index += 1;
		snapshot = {
			version: 1,
			source: "mock",
			activity,
			detail: activity === "running" ? { toolName: "demo-tool" } : undefined,
		};
		for (const listener of listeners) listener();
	};

	const subscribe = (listener) => {
		listeners.add(listener);
		if (timer === null && activities.length > 0) timer = setInterval(emit, intervalMs);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0 && timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
	};

	const getSnapshot = () => snapshot;
	const dispose = () => {
		if (timer !== null) clearInterval(timer);
		timer = null;
		listeners.clear();
	};

	return { subscribe, getSnapshot, dispose };
}
