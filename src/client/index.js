/**
 * dsh-pet client plugin.
 *
 * Registers a floating pet into the `shell.overlay` slot of the DSH web GUI.
 * The pet is a CSS sprite animation over a Codex-format atlas
 * (1536x1872, 8 columns x 9 rows of 192x208 cells) served by the host plugin
 * at `/api/pets/<id>/spritesheet`.
 *
 * State mapping (session -> atlas row):
 *   idle      (0) no activity            review  (8) assistant streaming/thinking
 *   failed    (5) lastAgentError         waiting (6) pending interaction / idle running
 *   running   (7) running tool calls     waving (3) / jumping (4) click / double-click
 *
 * Interactions: drag to move, click to wave, double-click to jump,
 * right-click to cycle through installed pets.
 */
import { Component, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import "./live2d/setup.js";
import PetLive2D, { LIVE2D_W, LIVE2D_H } from "./live2d/PetLive2D.js";
import { probe } from "./probe.js";

export const inject = ["slots", "sessions"];

const CELL_W = 192;
const CELL_H = 208;
const COLS = 8;
const SCALE = 0.55;
const PET_W = Math.round(CELL_W * SCALE);
const PET_H = Math.round(CELL_H * SCALE);

const ROWS = { idle: 0, runningRight: 1, runningLeft: 2, waving: 3, jumping: 4, failed: 5, waiting: 6, running: 7, review: 8 };
const FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6];
const FPS = { idle: 4, runningRight: 10, runningLeft: 10, waving: 8, jumping: 8, failed: 6, waiting: 4, running: 8, review: 8 };
const STATE_LABEL = {
	idle: "闲着",
	review: "思考中",
	running: "干活中",
	waiting: "等你",
	failed: "出错了",
	waving: "打招呼",
	jumping: "开心",
};

const CSS = `
.dsh-pet-anchor{position:fixed;left:0;top:0;z-index:2147483000;pointer-events:none;user-select:none;-webkit-user-select:none}
.dsh-pet-anchor *{box-sizing:border-box}
.dsh-pet{position:absolute;pointer-events:auto;cursor:grab;touch-action:none;filter:drop-shadow(0 3px 6px rgba(0,0,0,.35))}
.dsh-pet:active{cursor:grabbing}
.dsh-pet-sprite{width:${PET_W}px;height:${PET_H}px;image-rendering:pixelated;background-repeat:no-repeat}
.dsh-pet-bubble{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);white-space:nowrap;
  background:var(--dsw-alias-bg-float,rgba(28,30,36,.92));color:var(--dsw-alias-text-primary,#eee);
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:10px;padding:4px 10px;
  font:12px/1.4 system-ui,sans-serif;opacity:0;transition:opacity .15s;pointer-events:none}
.dsh-pet:hover .dsh-pet-bubble,.dsh-pet.dsh-pet-bubble-on .dsh-pet-bubble{opacity:1}
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

const STORAGE_POS = "dsh-pet:position";
const STORAGE_PET = "dsh-pet:selected";
const STORAGE_HINT = "dsh-pet:hint-dismissed";

/** Derive the pet mood from the current session's conversation snapshot. */
function deriveState(snap) {
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

/** Read the current session's live conversation snapshot (null when none). */
function useCurrentSnapshot(sessions) {
	const list = useSyncExternalStore(
		(cb) => sessions.list.subscribe(cb),
		() => sessions.list.getSnapshot(),
		() => sessions.list.getSnapshot(),
	);
	const currentId = list.current;
	const face = currentId !== undefined ? (sessions.binding(currentId)?.session ?? null) : null;
	const subscribe = useCallback(
		(cb) => {
			if (face === null) return () => {};
			return face.subscribe(cb);
		},
		[face],
	);
	return useSyncExternalStore(
		subscribe,
		() => (face === null ? null : face.getSnapshot()),
		() => null,
	);
}

/** Pet catalog, fetched from the host plugin and polled so new pets appear. */
function usePets() {
	const [pets, setPets] = useState([]);
	useEffect(() => {
		let alive = true;
		const load = () => {
			fetch("/api/pets", { cache: "no-store" })
				.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
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
	}, []);
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

function createPetOverlay(sessions) {
	class RenderBoundary extends Component {
		constructor(props) {
			super(props);
			this.state = { error: null };
		}
		static getDerivedStateFromError(error) {
			return { error };
		}
		componentDidCatch(error) {
			probe("render-error", { message: String(error?.message ?? error), stack: String(error?.stack ?? "") });
		}
		render() {
			if (this.state.error !== null) return null;
			return this.props.children;
		}
	}
	return function PetOverlay() {
	const pets = usePets();
	const snapshot = useCurrentSnapshot(sessions);
	useTicker();

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
	const [position, setPosition] = useState(() => loadPosition());
	const [mood, setMood] = useState(null); // { state, start } one-shot override
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

	// Keep the initial position in view (bottom-right, 16px margin).
	useEffect(() => {
		if (position !== null) return;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		setPosition({ x: Math.max(16, vw - dimsRef.current.w - 16), y: Math.max(16, vh - dimsRef.current.h - 16) });
	}, [position]);

	// Re-clamp into the viewport when the pet's kind/dimensions change (the
	// initial spot is computed with sprite dims before the pet list loads).
	useEffect(() => {
		if (position === null) return;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const dims = dimsRef.current;
		const cx = Math.min(position.x, vw - dims.w);
		const cy = Math.min(position.y, vh - dims.h);
		if (cx !== position.x || cy !== position.y) setPosition({ x: cx, y: cy });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [petDims.w, petDims.h]);

	const triggerMood = useCallback((state) => {
		setMood({ state, start: Date.now() });
		probe("mood", { state });
	}, []);

	// Single click = nod (点头). Double-click deliberately has no animation.
	const onPetClick = useCallback(() => {
		triggerMood("waving");
	}, [triggerMood]);

	// Right-click: manual shake (摇头). With a single installed pet there is
	// nothing to cycle, and the failed state otherwise only appears when a
	// session errors — this makes the shake auditionable on demand.
	const onPetContextMenu = useCallback(
		(e) => {
			e.preventDefault();
			triggerMood("failed");
		},
		[triggerMood],
	);

	// One-shot mood expiry.
	useEffect(() => {
		if (mood === null) return;
		const frames = FRAMES[ROWS[mood.state]];
		const duration = (frames / FPS[mood.state]) * 1000 + 500;
		const timer = setTimeout(() => setMood(null), duration);
		return () => clearTimeout(timer);
	}, [mood]);

	// Drag to move. Capture is taken on the pet element itself so that
	// pointermove/pointerup keep targeting the element that owns the handlers;
	// the base position is read from the dragged element (its offsetParent is
	// the fixed anchor), and the final position travels in the drag record so
	// the release handler never sees a stale state closure.
	const onPointerDown = useCallback((e) => {
		if (e.button !== 0) return;
		const target = e.currentTarget;
		const base = positionRef.current ?? { x: 0, y: 0 };
		dragRef.current = {
			startX: e.clientX,
			startY: e.clientY,
			baseX: base.x,
			baseY: base.y,
			x: base.x,
			y: base.y,
			lastX: e.clientX,
			lastY: e.clientY,
			lastT: e.timeStamp,
			vx: 0,
			vy: 0,
			moved: false,
			pointerId: e.pointerId,
		};
		try {
			target.setPointerCapture(e.pointerId);
		} catch {
			/* capture is best-effort; handlers fall back to bubbling */
		}
	}, []);
	const onPointerMove = useCallback((e) => {
		const drag = dragRef.current;
		if (drag === null || e.pointerId !== drag.pointerId || (e.buttons & 1) === 0) return;
		const dx = e.clientX - drag.startX;
		const dy = e.clientY - drag.startY;
		if (!drag.moved && Math.hypot(dx, dy) < 4) return;
		drag.moved = true;
		// Track velocity for fling detection.
		const now = e.timeStamp;
		const dt = Math.max(1, now - drag.lastT);
		drag.vx = ((e.clientX - drag.lastX) / dt) * 1000; // px/s
		drag.vy = ((e.clientY - drag.lastY) / dt) * 1000;
		drag.lastX = e.clientX;
		drag.lastY = e.clientY;
		drag.lastT = now;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const dims = dimsRef.current;
		const x = Math.min(Math.max(0, drag.baseX + dx), vw - dims.w);
		const y = Math.min(Math.max(0, drag.baseY + dy), vh - dims.h);
		drag.x = x;
		drag.y = y;
		setPosition({ x, y });
	}, []);
	const endDrag = useCallback((e) => {
		const drag = dragRef.current;
		if (drag === null || e.pointerId !== drag.pointerId) return;
		dragRef.current = null;
		if (!drag.moved) return;
		try {
			localStorage.setItem(STORAGE_POS, JSON.stringify({ x: drag.x, y: drag.y }));
		} catch {
			/* ignore */
		}
	}, []);

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
		const now = Date.now();
		const derived = deriveState(snapshot);
		const state = mood !== null && now - mood.start < (FRAMES[ROWS[mood.state]] / FPS[mood.state]) * 1000 ? mood.state : derived;
		const toolName = snapshot?.runningCalls?.[0]?.name;
		const bubbleText =
			state === "running" && toolName !== undefined
				? `${STATE_LABEL.running}：${toolName}`
				: STATE_LABEL[state] ?? "";

		// Player-side parabolic lift for sprite pets only: the atlas jump row
		// is subtle and clipped at the cell edges; Live2D models hop in-model.
		let jumpLift = 0;
		let spriteStyle = null;
		if (!isLive2D) {
			const row = ROWS[state];
			const frameMs = 1000 / FPS[state];
			const frame = mood !== null && state === mood.state
				? Math.min(Math.floor((now - mood.start) / frameMs), FRAMES[row] - 1)
				: Math.floor(now / frameMs) % FRAMES[row];
			spriteStyle = {
				backgroundImage: `url(/api/pets/${encodeURIComponent(pet.id)}/spritesheet)`,
				backgroundSize: `${CELL_W * COLS * SCALE}px ${CELL_H * 9 * SCALE}px`,
				backgroundPosition: `-${frame * CELL_W * SCALE}px -${row * CELL_H * SCALE}px`,
			};
			if (state === "jumping" && mood !== null) {
				const progress = Math.min((now - mood.start) / (FRAMES[row] * frameMs), 1);
				jumpLift = Math.round(Math.sin(Math.PI * progress) * 40);
			}
		}

		content = (
			<div className="dsh-pet-anchor">
				<div
					className={`dsh-pet${state !== "idle" && state !== "waving" && state !== "jumping" ? " dsh-pet-bubble-on" : ""}`}
					style={{ left: position.x, top: position.y, transform: jumpLift > 0 ? `translateY(-${jumpLift}px)` : undefined }}
					title={`${pet.displayName} — ${pet.description}`}
					onClick={onPetClick}
					onContextMenu={onPetContextMenu}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
				>
					{isLive2D ? <PetLive2D pet={pet} mood={mood} state={state} /> : <div className="dsh-pet-sprite" style={spriteStyle} />}
					<div className="dsh-pet-bubble">{bubbleText}</div>
				</div>
			</div>
		);
	}
	return <RenderBoundary>{content}</RenderBoundary>;
	};
}

export function apply(ctx) {
	const PetOverlay = createPetOverlay(ctx.sessions);
	ctx.effect(() => {
		try {
			const dispose = ctx.slots.register({ name: "shell.overlay", id: "dsh-pet" }, PetOverlay);
			probe("mounted", { hasSlots: ctx.slots !== undefined, hasSessions: ctx.sessions !== undefined });
			return () => dispose();
		} catch (error) {
			probe("apply-error", { message: String(error?.message ?? error), stack: String(error?.stack ?? "") });
			ctx.logger?.warn?.(error);
			return () => {};
		}
	}, "dsh-pet: shell.overlay registration");
	ctx.effect(() => {
		const tagId = "dsh-pet/pet.css";
		if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-pet";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		return () => {
			document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`)?.remove();
		};
	}, "dsh-pet: style tag");
}
