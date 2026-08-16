/**
 * Personality presets: config-driven behavior layer.
 *
 * A personality is plain data: which interaction gesture fires for a click,
 * how an activity key maps onto the sprite atlas rows, and what the bubble
 * says. The shared pet kernel only reads this object — adding a new mood or
 * a new personality never requires kernel changes.
 */
export const DEFAULT_PERSONALITY = Object.freeze({
	id: "default",
	displayName: "经典",
	interactions: Object.freeze({
		click: "waving",
		contextMenu: "failed",
	}),
	// Pending-interaction reminder rhythm. The first cue is immediate; a long
	// wait repeats more often and may ask the desktop shell for one native
	// notification. Preset files can tune this without changing the renderer.
	attention: Object.freeze({
		gesture: "waiting",
		repeatMs: 30000,
		escalateAfterMs: 120000,
		escalatedRepeatMs: 15000,
	}),
	// Activity key -> sprite atlas row. Unknown keys fall back to "idle".
	stateMapping: Object.freeze({
		idle: "idle",
		review: "review",
		running: "running",
		waiting: "waiting",
		failed: "failed",
		waving: "waving",
		jumping: "jumping",
	}),
	// Activity key -> bubble label (empty string = no bubble).
	bubbles: Object.freeze({
		idle: "闲着",
		review: "思考中",
		running: "干活中",
		waiting: "等你",
		failed: "出错了",
		waving: "打招呼",
		jumping: "开心",
	}),
});

/** Resolve the display label for an activity key, honoring empty bubbles. */
export function bubbleTextFor(personality, state) {
	const text = personality?.bubbles?.[state];
	return typeof text === "string" ? text : "";
}

/** Resolve an activity key to a sprite atlas row name (fallback: idle). */
export function spriteRowFor(personality, state) {
	const row = personality?.stateMapping?.[state];
	return typeof row === "string" ? row : "idle";
}

/** Resolve an interaction gesture name for a local event. */
export function gestureFor(personality, event) {
	const gesture = personality?.interactions?.[event];
	return typeof gesture === "string" ? gesture : null;
}
