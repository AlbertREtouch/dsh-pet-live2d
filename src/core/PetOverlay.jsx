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

const ROWS = { idle: 0, runningRight: 1, runningLeft: 2, waving: 3, jumping: 4, failed: 5, waiting: 6, running: 7, review: 8 };
const FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6];
const FPS = { idle: 4, runningRight: 10, runningLeft: 10, waving: 8, jumping: 8, failed: 6, waiting: 4, running: 8, review: 8 };

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

export function PetOverlay({ stateSource, fetchPets, probe = () => {}, assetBase = "/api", personality = DEFAULT_PERSONALITY }) {
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

	function Overlay() {
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

		// Re-clamp into the viewport when the pet's kind/dimensions change.
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

		const triggerMood = useCallback(
			(state) => {
				setMood({ state, start: Date.now() });
				probe("mood", { state });
			},
			[probe],
		);

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

		// Drag to move. Capture is taken on the pet element itself; the base
		// position is read from the dragged element, and the final position
		// travels in the drag record so the release handler sees fresh values.
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
			const activity = petState?.activity ?? "idle";
			const moodActive = mood !== null && now - mood.start < moodDurationMs(mood.state);
			const state = moodActive ? mood.state : activity;
			const toolName = petState?.detail?.toolName;
			const label = bubbleTextFor(personality, state);
			const bubbleText = state === "running" && toolName !== undefined ? `${label}：${toolName}` : label;

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
						{isLive2D ? (
							<PetLive2D pet={pet} mood={mood} state={state} assetBase={assetBase} probe={probe} />
						) : (
							<div className="dsh-pet-sprite" style={spriteStyle} />
						)}
						<div className="dsh-pet-bubble">{bubbleText}</div>
					</div>
				</div>
			);
		}
		return <RenderBoundary>{content}</RenderBoundary>;
	}

	return <Overlay />;
}
