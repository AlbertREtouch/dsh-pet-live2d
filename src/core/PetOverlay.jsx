/**
 * Shared pet overlay (the render kernel's React surface).
 *
 * Consumes a PetStateSource through the PetStateBus store contract and a
 * fetchPets() catalog loader. Everything DSH-specific lives in the entry
 * files and adapters — this component only knows about assetBase, probe and
 * personality config.
 */
import { Component, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import PetLive2D, { LIVE2D_W, LIVE2D_H } from "../client/live2d/PetLive2D.js";
import { DEFAULT_PERSONALITY, bubbleTextFor, gestureFor, spriteRowFor } from "./personality.js";

const CELL_W = 192;
const CELL_H = 208;
const COLS = 8;
const SCALE = 0.55;
const PET_W = Math.round(CELL_W * SCALE);
const PET_H = Math.round(CELL_H * SCALE);

// Compact Electron shell layout: the window is exactly these paddings plus
// the pet element. Kept in sync with electron/main.cjs (SHELL_PAD).
const SHELL_SIDE_PAD = 24;
const SHELL_MIN_WIDTH = 320;
const SHELL_PAD_TOP = 96;
const SHELL_PAD_RIGHT = 24;
const SHELL_PAD_BOTTOM = 8;

function desktopPetPosition(petWidth) {
	const shellWidth = Math.max(SHELL_MIN_WIDTH, petWidth + SHELL_SIDE_PAD + SHELL_PAD_RIGHT);
	return { x: Math.round((shellWidth - petWidth) / 2), y: SHELL_PAD_TOP };
}

const ROWS = { idle: 0, runningRight: 1, runningLeft: 2, waving: 3, jumping: 4, failed: 5, waiting: 6, running: 7, review: 8 };
const FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6];
const FPS = { idle: 4, runningRight: 10, runningLeft: 10, waving: 8, jumping: 8, failed: 6, waiting: 4, running: 8, review: 8 };

const CSS = `
.dsh-pet-anchor{position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483000;pointer-events:none;user-select:none;-webkit-user-select:none}
.dsh-pet-anchor *{box-sizing:border-box}
.dsh-pet{position:absolute;pointer-events:auto;cursor:grab;touch-action:none;filter:drop-shadow(0 3px 6px rgba(0,0,0,.35))}
.dsh-pet:active{cursor:grabbing}
.dsh-pet-sprite{width:${PET_W}px;height:${PET_H}px;image-rendering:pixelated;background-repeat:no-repeat}
.dsh-pet-bubble{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);white-space:nowrap;
  background:var(--dsw-alias-bg-float,rgba(28,30,36,.92));color:var(--dsw-alias-text-primary,#eee);
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:10px;padding:4px 10px;
  font:12px/1.4 system-ui,sans-serif;opacity:0;transition:opacity .15s;pointer-events:none}
.dsh-pet:hover .dsh-pet-bubble,.dsh-pet.dsh-pet-bubble-on .dsh-pet-bubble{opacity:1}
.dsh-pet-bubble-pending{width:max-content;min-width:190px;max-width:min(300px,calc(100vw - 12px));padding:7px 9px;
  white-space:normal;pointer-events:auto;cursor:default;filter:none}
.dsh-pet-pending-message{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;font-weight:500}
.dsh-pet-pending-actions{display:flex;justify-content:center;gap:6px;margin-top:6px;max-width:280px}
.dsh-pet-pending-actions button{min-width:32px;max-width:132px;height:25px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  cursor:pointer;background:var(--dsw-alias-button-fill,rgba(255,255,255,.1));color:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.22));border-radius:7px;padding:2px 8px;font:12px/1.2 system-ui,sans-serif}
.dsh-pet-pending-actions button:hover:not(:disabled){background:var(--dsw-alias-button-fill-hover,rgba(255,255,255,.18))}
.dsh-pet-pending-actions button:disabled{cursor:wait;opacity:.55}
.dsh-pet-pending-approve{color:#8de6a5!important}
.dsh-pet-pending-reject{color:#ff9b9b!important}
.dsh-pet-pending-error{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;color:#ffb2b2;font-size:11px}
.dsh-pet-hint{position:absolute;pointer-events:auto;bottom:16px;right:16px;max-width:260px;
  background:var(--dsw-alias-bg-float,rgba(28,30,36,.92));color:var(--dsw-alias-text-secondary,#ccc);
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:12px;padding:10px 12px;
  font:12px/1.5 system-ui,sans-serif}
.dsh-pet-hint code{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-text-primary,#eee)}
.dsh-pet-hint-close{margin-left:10px;cursor:pointer;color:var(--dsw-alias-text-tertiary,#999);border:0;background:none;padding:0;font-size:14px;line-height:1}
.dsh-pet-live2d{position:relative;overflow:hidden}
.dsh-pet-live2d canvas{display:block}
.dsh-pet-live2d-status{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;padding-bottom:6px;
  font:12px/1.4 system-ui,sans-serif;color:var(--dsw-alias-text-secondary,#ccc);pointer-events:none}
.dsh-pet-debug-tab{position:absolute;right:4px;top:4px;z-index:5;pointer-events:auto;cursor:pointer;
  background:var(--dsw-alias-bg-float,rgba(28,30,36,.92));color:var(--dsw-alias-text-secondary,#ccc);
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:8px;padding:3px 8px;font:11px/1.4 system-ui,sans-serif}
.dsh-pet-debug-panel{position:fixed;left:16px;top:16px;z-index:2147483001;width:300px;max-height:70vh;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-float,rgba(24,26,32,.96));color:var(--dsw-alias-text-primary,#eee);
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-radius:12px;font:12px/1.5 system-ui,sans-serif;
  box-shadow:0 8px 30px rgba(0,0,0,.4)}
.dsh-pet-debug-panel-right{left:auto;right:16px}
.dsh-pet-debug-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));cursor:grab;touch-action:none}
.dsh-pet-debug-head span{flex:1;font-weight:600}
.dsh-pet-debug-head button{cursor:pointer;background:var(--dsw-alias-button-fill,rgba(255,255,255,.1));color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.2));border-radius:6px;padding:2px 8px;font:11px/1.4 system-ui,sans-serif}
.dsh-pet-debug-body{overflow:auto;padding:8px 10px}
.dsh-pet-debug-empty{color:var(--dsw-alias-text-tertiary,#999)}
.dsh-pet-debug-row{display:grid;grid-template-columns:86px 1fr 40px;align-items:center;gap:6px;padding:2px 0}
.dsh-pet-debug-name{color:var(--dsw-alias-text-secondary,#ccc);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pet-debug-row input{width:100%;accent-color:#7d92c4}
.dsh-pet-debug-value{color:var(--dsw-alias-text-tertiary,#999);text-align:right;font-variant-numeric:tabular-nums}
`;

export const PET_CSS = CSS;

const STORAGE_POS = "dsh-pet:position";
const STORAGE_PET = "dsh-pet:selected";
const STORAGE_HINT = "dsh-pet:hint-dismissed";

function usePets(fetchPets, probe) {
	const [pets, setPets] = useState([]);
	useEffect(() => {
		let alive = true;
		const load = () => {
			Promise.resolve()
				.then(() => fetchPets())
				.then((list) => {
					if (!alive) return;
					setPets(Array.isArray(list) ? list : []);
					probe("pets-loaded", { count: Array.isArray(list) ? list.length : -1, ids: Array.isArray(list) ? list.map((p) => p.id) : [] });
				})
				.catch((error) => {
					if (alive) probe("pets-error", { message: String(error?.message ?? error) });
				});
		};
		load();
		const timer = setInterval(load, 30000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [fetchPets, probe]);
	return pets;
}

/** Stable 100ms re-render ticker driving sprite frames and mood expiry. */
function useTicker() {
	const [, setTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setTick((t) => t + 1), 100);
		return () => clearInterval(timer);
	}, []);
}

function loadPosition() {
	try {
		const raw = localStorage.getItem(STORAGE_POS);
		if (raw !== null) {
			const parsed = JSON.parse(raw);
			if (typeof parsed?.x === "number" && typeof parsed?.y === "number") return { x: parsed.x, y: parsed.y };
		}
	} catch {
		/* storage unavailable */
	}
	return null;
}

function moodDurationMs(moodState) {
	const rowName = moodState in ROWS ? moodState : "idle";
	const row = ROWS[rowName];
	const frames = FRAMES[row] ?? 1;
	const fps = FPS[rowName] ?? 4;
	return (frames / fps) * 1000 + 500;
}


function sessionPrefix(title) {
	return typeof title === "string" && title.length > 0 ? `【${title}】` : "";
}

function pendingMessage(pending, total = 1) {
	const prefix = sessionPrefix(pending?.sessionTitle);
	const suffix = total > 1 ? `（另有 ${total - 1} 项）` : "";
	if (pending?.kind === "approval") {
		return `${prefix}${pending.reason ?? `需要你批准：${pending.toolName ?? "操作"}`}${suffix}`;
	}
	if (pending?.kind === "question") {
		const question = pending.questions?.[0];
		return `${prefix}${question?.question ?? "DSH 正在等你回答"}${suffix}`;
	}
	return `${prefix}DSH 正在等你${suffix}`;
}

function positiveNumber(value, fallback, minimum = 1000) {
	return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : fallback;
}

export function PetOverlay({
	stateSource,
	fetchPets,
	probe = () => {},
	assetBase = "/api",
	personality = DEFAULT_PERSONALITY,
	selectedPetId = null,
	onPetChange = null,
	debugPanel = false,
	desktopWindow = null,
}) {
	class RenderBoundary extends Component {
		constructor(props) {
			super(props);
			this.state = { error: null };
		}
		static getDerivedStateFromError(error) {
			return { error };
		}
		componentDidCatch(error) {
			const probeFn = typeof this.props.probe === "function" ? this.props.probe : () => {};
			probeFn("render-error", { message: String(error?.message ?? error), stack: String(error?.stack ?? "") });
		}
		render() {
			if (this.state.error !== null) return null;
			return this.props.children;
		}
	}

	// Stable component identity across prop updates (Electron tray toggles
	// skin/debug by re-rendering the same root): a component type recreated on
	// every render would remount the pet, wipe its state and flash the hint.
	const Overlay = useCallback(function Overlay({
		stateSource,
		fetchPets,
		probe = () => {},
		assetBase = "/api",
		personality = DEFAULT_PERSONALITY,
		selectedPetId = null,
		onPetChange = null,
		debugPanel = false,
		desktopWindow = null,
	}) {
		const isDesktop = desktopWindow !== null && typeof desktopWindow?.beginDrag === "function";
		const desktopRef = useRef(desktopWindow);
		desktopRef.current = desktopWindow;
		const pets = usePets(fetchPets, probe);
		const subscribeState = useCallback((cb) => stateSource.subscribe(cb), [stateSource]);
		const petState = useSyncExternalStore(
			subscribeState,
			() => {
				try {
					return stateSource.getSnapshot();
				} catch {
					return null;
				}
			},
			() => null,
		);
		useTicker();
		const pendingList = Array.isArray(petState?.detail?.pending) ? petState.detail.pending : [];
		const pending = pendingList[0] ?? null;
		const pendingKey = typeof pending?.key === "string" ? pending.key : null;
		const pendingSessionId = typeof pending?.sessionId === "string" ? pending.sessionId : null;
		const pendingActionId = pendingKey === null ? null : `${pendingSessionId ?? ""}\u0000${pendingKey}`;

		const [selected, setSelected] = useState(() => {
			try {
				// Deep link: ?dsh-pet=<id> wins for the first mount of the page.
				const query = new URLSearchParams(location.search).get("dsh-pet");
				if (query !== null && query.length > 0) return query;
				return localStorage.getItem(STORAGE_PET) ?? null;
			} catch {
				return null;
			}
		});
		const [position, setPosition] = useState(() => (isDesktop ? desktopPetPosition(PET_W) : loadPosition()));
		const [mood, setMood] = useState(null); // { state, start } one-shot override
		const [pendingAction, setPendingAction] = useState({ key: null, busy: false, error: null });
		const [hintDismissed, setHintDismissed] = useState(() => {
			try {
				return localStorage.getItem(STORAGE_HINT) === "1";
			} catch {
				return true;
			}
		});
		const dragRef = useRef(null);
		const dimsRef = useRef({ w: PET_W, h: PET_H });
		const positionRef = useRef(position);
		positionRef.current = position;

		// Pick the effective pet: sticky selection when still installed, else first.
		const pet =
			pets.find((candidate) => candidate.id === selected) ?? pets.find((candidate) => candidate.id === "dsh-kitten") ?? pets[0] ?? null;
		const petDims = pet !== null && pet.kind === "live2d" ? { w: LIVE2D_W, h: LIVE2D_H } : { w: PET_W, h: PET_H };
		dimsRef.current = petDims;

		useEffect(() => {
			if (pet !== null && pet.id !== selected) {
				setSelected(pet.id);
				try {
					localStorage.setItem(STORAGE_PET, pet.id);
				} catch {
					/* ignore */
				}
			}
		}, [pet, selected]);

		// External skin switch (Electron tray menu / standalone hosts): the
		// host keeps the authoritative id in a prop; DSH never passes it and
		// is therefore unaffected. Only honor ids that actually exist in the
		// catalog — a stale menu entry must not fight the fallback selection.
		useEffect(() => {
			if (typeof selectedPetId !== "string" || selectedPetId.length === 0 || selectedPetId === selected) return;
			if (!pets.some((candidate) => candidate.id === selectedPetId)) return;
			setSelected(selectedPetId);
			try {
				localStorage.setItem(STORAGE_PET, selectedPetId);
			} catch {
				/* ignore */
			}
		}, [selectedPetId, selected, pets]);

		// Report which pet actually got mounted (fallback selection included)
		// so the Electron shell can check the matching tray menu item.
		useEffect(() => {
			if (typeof onPetChange === "function" && pet !== null) onPetChange(pet.id);
		}, [pet === null ? null : pet.id, onPetChange]);

		// Compact Electron shell: the main process sizes the window around the
		// pet element. DSH/dev previews never pass desktopWindow.
		useEffect(() => {
			if (isDesktop && pet !== null && typeof desktopWindow?.setPetBounds === "function") {
				desktopWindow.setPetBounds({ width: petDims.w, height: petDims.h });
			}
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [isDesktop, petDims.w, petDims.h, desktopWindow, pet === null ? null : pet.id]);

		// Keep the initial position in view (bottom-right, 16px margin).
		useEffect(() => {
			if (isDesktop || position !== null) return;
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			setPosition({ x: Math.max(16, vw - dimsRef.current.w - 16), y: Math.max(16, vh - dimsRef.current.h - 16) });
		}, [isDesktop, position]);

		// Re-clamp into the viewport when the pet's kind/dimensions change.
		useEffect(() => {
			if (isDesktop || position === null) return;
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const dims = dimsRef.current;
			const cx = Math.min(position.x, vw - dims.w);
			const cy = Math.min(position.y, vh - dims.h);
			if (cx !== position.x || cy !== position.y) setPosition({ x: cx, y: cy });
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [petDims.w, petDims.h]);

		const triggerMood = useCallback(
			(state) => {
				setMood({ state, start: Date.now() });
				probe("mood", { state });
			},
			[probe],
		);

		useEffect(() => {
			setPendingAction({ key: pendingActionId, busy: false, error: null });
		}, [pendingActionId]);

		const runPendingAction = useCallback(
			(action) => {
				if (pendingKey === null || typeof stateSource?.perform !== "function") {
					setPendingAction({ key: pendingActionId, busy: false, error: "请打开 DSH 处理" });
					return;
				}
				setPendingAction({ key: pendingActionId, busy: true, error: null });
				Promise.resolve()
					.then(() => stateSource.perform(action))
					.catch((error) => {
						setPendingAction({ key: pendingActionId, busy: false, error: String(error?.message ?? error).slice(0, 160) });
					});
			},
			[pendingKey, pendingActionId, stateSource],
		);

		const openDsh = useCallback(() => {
			const desktop = desktopRef.current;
			if (desktop !== null && typeof desktop.openDsh === "function") desktop.openDsh();
		}, []);

		// Pending interactions own a configurable attention rhythm. Each stable
		// request key gets an immediate gesture, then repeats; after the preset's
		// escalation threshold the cadence tightens and the desktop shell may show
		// one native notification (the main process deduplicates by request key).
		useEffect(() => {
			if (pendingKey === null || pending === null) return;
			let timer = null;
			let active = true;
			const attention = personality?.attention ?? {};
			const gesture = typeof attention.gesture === "string" ? attention.gesture : "waiting";
			const repeatMs = positiveNumber(attention.repeatMs, 30000);
			const escalateAfterMs = positiveNumber(attention.escalateAfterMs, 120000);
			const escalatedRepeatMs = positiveNumber(attention.escalatedRepeatMs, 15000);
			const requestedAt = typeof pending.requestedAt === "number" ? pending.requestedAt : Date.now();
			const message = pendingMessage(pending, pendingList.length);
			const pulse = () => {
				if (!active) return;
				const escalated = Date.now() - requestedAt >= escalateAfterMs;
				triggerMood(gesture);
				const desktop = desktopRef.current;
				if (desktop !== null && typeof desktop.requestAttention === "function") {
					desktop.requestAttention({ key: pendingKey, level: escalated ? "escalated" : "normal", message });
				}
				timer = setTimeout(pulse, escalated ? escalatedRepeatMs : repeatMs);
			};
			pulse();
			return () => {
				active = false;
				if (timer !== null) clearTimeout(timer);
			};
		}, [pendingKey, pendingSessionId, pendingList.length, personality, triggerMood]);

		// Single click / right-click gestures come from the personality preset.
		const onPetClick = useCallback(() => {
			const gesture = gestureFor(personality, "click");
			if (gesture !== null) triggerMood(gesture);
		}, [personality, triggerMood]);

		const onPetContextMenu = useCallback(
			(e) => {
				e.preventDefault();
				const gesture = gestureFor(personality, "contextMenu");
				if (gesture !== null) triggerMood(gesture);
			},
			[personality, triggerMood],
		);

		// One-shot mood expiry.
		useEffect(() => {
			if (mood === null) return;
			const timer = setTimeout(() => setMood(null), moodDurationMs(mood.state));
			return () => clearTimeout(timer);
		}, [mood]);

		// Drag to move. In the compact Electron shell the pet stays fixed inside
		// its window and the WINDOW is moved: the renderer only reports the grab
		// offset once and then asks the main process to re-read the OS cursor —
		// never feed renderer screenX/screenY back while the window is moving.
		const onPointerDown = useCallback((e) => {
			if (e.button !== 0) return;
			const target = e.currentTarget;
			const base = positionRef.current ?? { x: 0, y: 0 };
			const rect = target.getBoundingClientRect();
			const grabX = e.clientX - rect.left;
			const grabY = e.clientY - rect.top;
			dragRef.current = {
				startX: e.clientX,
				startY: e.clientY,
				baseX: base.x,
				baseY: base.y,
				x: base.x,
				y: base.y,
				grabX,
				grabY,
				moved: false,
				pointerId: e.pointerId,
			};
			const desktop = desktopRef.current;
			if (desktop !== null && typeof desktop.beginDrag === "function") {
				// Offset must be relative to the WINDOW, not to the pet element:
				// the shell has bubble padding above/left of the pet, and using
				// pet-relative offsets makes every horizontal drag drift right by
				// the left padding and every drag drift down by the top padding.
				desktop.beginDrag({ offsetX: e.clientX, offsetY: e.clientY });
			}
			try {
				target.setPointerCapture(e.pointerId);
			} catch {
				/* capture is best-effort; handlers fall back to bubbling */
			}
		}, []);
		const finishDrag = useCallback((drag) => {
			const desktop = desktopRef.current;
			// Main receives drag-start even for a click that never crosses the
			// movement threshold, so it must always receive the matching drag-end.
			if (desktop !== null && typeof desktop.dragEnd === "function") {
				desktop.dragEnd();
				return;
			}
			if (!drag.moved) return;
			try {
				localStorage.setItem(STORAGE_POS, JSON.stringify({ x: drag.x, y: drag.y }));
			} catch {
				/* ignore */
			}
		}, []);
		const onPointerMove = useCallback((e) => {
			const drag = dragRef.current;
			if (drag === null || e.pointerId !== drag.pointerId) return;
			// Pointer capture can be lost while a transparent native window moves.
			// A later move with the primary button released is an authoritative
			// cleanup signal even if Chromium missed pointerup/pointercancel.
			if ((e.buttons & 1) === 0) {
				dragRef.current = null;
				finishDrag(drag);
				return;
			}
			const dx = e.clientX - drag.startX;
			const dy = e.clientY - drag.startY;
			if (!drag.moved && Math.hypot(dx, dy) < 4) return;
			if (!drag.moved) drag.moved = true;
			const desktop = desktopRef.current;
			if (desktop !== null && typeof desktop.dragMove === "function") {
				desktop.dragMove();
				return;
			}
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const dims = dimsRef.current;
			const x = Math.min(Math.max(0, drag.baseX + dx), vw - dims.w);
			const y = Math.min(Math.max(0, drag.baseY + dy), vh - dims.h);
			drag.x = x;
			drag.y = y;
			setPosition({ x, y });
		}, [finishDrag]);
		const endDrag = useCallback((e) => {
			const drag = dragRef.current;
			if (drag === null || e.pointerId !== drag.pointerId) return;
			dragRef.current = null;
			finishDrag(drag);
		}, [finishDrag]);

		let content = null;
		if (pets.length === 0) {
			if (!hintDismissed) {
				content = (
					<div className="dsh-pet-anchor">
						<div className="dsh-pet-hint">
							<span>
								把宠物放进 <code>~/.dsh/pets/&lt;名字&gt;/</code>（pet.json + spritesheet），刷新页面就会出现桌宠。
							</span>
							<button
								className="dsh-pet-hint-close"
								aria-label="关闭提示"
								onClick={() => {
									setHintDismissed(true);
									try {
										localStorage.setItem(STORAGE_HINT, "1");
									} catch {
										/* ignore */
									}
								}}
							>
								✕
							</button>
						</div>
					</div>
				);
			}
		} else if (pet !== null && position !== null) {
			const isLive2D = pet.kind === "live2d";
			const effectivePosition = isDesktop ? desktopPetPosition(petDims.w) : position;
			const now = Date.now();
			const activity = petState?.activity ?? "idle";
			const moodActive = mood !== null && now - mood.start < moodDurationMs(mood.state);
			const state = moodActive ? mood.state : activity;
			const toolName = petState?.detail?.toolName;
			const activeSessionTitle = petState?.detail?.sessionTitle;
			const label = bubbleTextFor(personality, state);
			const stateMessage = petState?.detail?.message;
			const bubbleText = state === "running" && toolName !== undefined
				? `${sessionPrefix(activeSessionTitle)}${label}：${toolName}`
				: state === "failed" && typeof stateMessage === "string"
					? `${sessionPrefix(activeSessionTitle)}${label}：${stateMessage}`
					: `${sessionPrefix(activeSessionTitle)}${label}`;
			const actionBusy = pendingAction.key === pendingActionId && pendingAction.busy;
			const actionError = pendingAction.key === pendingActionId ? pendingAction.error : null;
			let bubbleContent = bubbleText;
			if (pending !== null && pendingKey !== null) {
				let actions = null;
				if (pending.kind === "approval") {
					actions = (
						<>
							<button
								type="button"
								className="dsh-pet-pending-reject"
								aria-label="拒绝"
								disabled={actionBusy}
								onClick={() => runPendingAction({ type: "pending/reject", key: pendingKey, sessionId: pendingSessionId })}
							>
								✕
							</button>
							<button
								type="button"
								className="dsh-pet-pending-approve"
								aria-label="批准一次"
								disabled={actionBusy}
								onClick={() => runPendingAction({ type: "pending/approve", key: pendingKey, sessionId: pendingSessionId })}
							>
								✓
							</button>
						</>
					);
				} else if (pending.kind === "question" && pending.quickAnswer === true) {
					const question = pending.questions?.[0];
					actions = (question?.options ?? []).map((option) => (
						<button
							type="button"
							key={option.label}
							title={option.description}
							disabled={actionBusy}
							onClick={() => runPendingAction({ type: "pending/answer-option", key: pendingKey, sessionId: pendingSessionId, option: option.label })}
						>
							{option.label}
						</button>
					));
				} else if (isDesktop) {
					actions = (
						<button type="button" disabled={actionBusy} onClick={openDsh}>
							打开 DSH
						</button>
					);
				}
				bubbleContent = (
					<div
						className="dsh-pet-pending"
						onClick={(event) => event.stopPropagation()}
						onContextMenu={(event) => {
							event.preventDefault();
							event.stopPropagation();
						}}
						onPointerDown={(event) => event.stopPropagation()}
					>
						<div className="dsh-pet-pending-message" title={pendingMessage(pending, pendingList.length)}>{pendingMessage(pending, pendingList.length)}</div>
						{actions !== null ? <div className="dsh-pet-pending-actions">{actions}</div> : null}
						{actionError !== null ? <div className="dsh-pet-pending-error" title={actionError}>{actionError}</div> : null}
					</div>
				);
			}

			// Player-side parabolic lift for sprite pets only: the atlas jump row
			// is subtle and clipped at the cell edges; Live2D models hop in-model.
			let jumpLift = 0;
			let spriteStyle = null;
			if (!isLive2D) {
				const rowName = spriteRowFor(personality, state);
				const row = ROWS[rowName] ?? ROWS.idle;
				const frameMs = 1000 / (FPS[rowName] ?? 4);
				const frame = moodActive
					? Math.min(Math.floor((now - mood.start) / frameMs), (FRAMES[row] ?? 1) - 1)
					: Math.floor(now / frameMs) % (FRAMES[row] ?? 1);
				spriteStyle = {
					backgroundImage: `url(${assetBase}/pets/${encodeURIComponent(pet.id)}/spritesheet)`,
					backgroundSize: `${CELL_W * COLS * SCALE}px ${CELL_H * 9 * SCALE}px`,
					backgroundPosition: `-${frame * CELL_W * SCALE}px -${row * CELL_H * SCALE}px`,
				};
				if (state === "jumping" && moodActive) {
					const progress = Math.min((now - mood.start) / ((FRAMES[row] ?? 1) * frameMs), 1);
					jumpLift = Math.round(Math.sin(Math.PI * progress) * 40);
				}
			}

			content = (
				<div className="dsh-pet-anchor">
					<div
						className={`dsh-pet${pending !== null || (state !== "idle" && state !== "waving" && state !== "jumping") ? " dsh-pet-bubble-on" : ""}`}
						style={{ left: effectivePosition.x, top: effectivePosition.y, transform: jumpLift > 0 ? `translateY(-${jumpLift}px)` : undefined }}
						title={`${pet.displayName} — ${pet.description}`}
						onClick={onPetClick}
						onContextMenu={onPetContextMenu}
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onPointerUp={endDrag}
						onPointerCancel={endDrag}
					>
						{isLive2D ? (
							<PetLive2D
								pet={pet}
								mood={mood}
								state={state}
								assetBase={assetBase}
								probe={probe}
								debugPanel={debugPanel}
								debugPanelAlign={isDesktop ? "right" : "left"}
							/>
						) : (
							<div className="dsh-pet-sprite" style={spriteStyle} />
						)}
						<div className={`dsh-pet-bubble${pending !== null ? " dsh-pet-bubble-pending" : ""}`}>{bubbleContent}</div>
					</div>
				</div>
			);
		}
		return <RenderBoundary probe={probe}>{content}</RenderBoundary>;
	}, []);

	return (
		<Overlay
			stateSource={stateSource}
			fetchPets={fetchPets}
			probe={probe}
			assetBase={assetBase}
			personality={personality}
			selectedPetId={selectedPetId}
			onPetChange={onPetChange}
			debugPanel={debugPanel}
			desktopWindow={desktopWindow}
		/>
	);
}
