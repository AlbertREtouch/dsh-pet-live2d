/**
 * Live2D pet renderer: mounts a transparent PixiJS canvas, loads a
 * Cubism 4 model from the host plugin's asset route, and drives it:
 *  - physics + idle motion come from the model itself (physics3.json)
 *  - eye blink, gaze follow (angle/eyeball params), mood pulses
 *    (waving = smile + head tilt, jumping = parabolic hop) are driven
 *    from a ticker against the model's parameters
 *  - DOM-level dragging/clicking stays on the shared pet wrapper
 */
import { Component, useCallback, useEffect, useRef, useState } from "react";
import * as PIXI from "pixi.js";
import "./setup.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";
import { probe } from "../probe.js";
import DebugPanel, { debugEnabled } from "./DebugPanel.js";

export const LIVE2D_W = 240;
export const LIVE2D_H = 340;

const BLINK_INTERVAL = 3200; // ms between blinks (approx)

/** Which motion group plays for which effective pet state (null = fall back
 *  to the parameter animation drivers). Extended as more motions are made. */
function motionForState(state) {
	switch (state) {
		case "waving": return ["TapBody", 0]; // nod
		case "failed": return ["Sad", 0]; // shake
		default: return null;
	}
}

/** Set a core model parameter, ignoring unknown ids. */
function safeParam(coreModel, id, value) {
	try {
		coreModel.setParameterValueById(id, value);
	} catch {
		/* parameter not present in this model */
	}
}

/** Read a core model parameter, ignoring unknown ids. */
function readParam(coreModel, id, fallback) {
	try {
		return coreModel.getParameterValueById(id);
	} catch {
		return fallback;
	}
}

export default function PetLive2D({ pet, mood, state }) {
	const mountRef = useRef(null);
	const appRef = useRef(null);
	const modelRef = useRef(null);
	const moodRef = useRef(mood);
	const targetRef = useRef({ x: 0, y: 0 });
	const blinkRef = useRef({ next: BLINK_INTERVAL, phase: null, start: 0, eyeOpen: 1 });
	const overridesRef = useRef({}); // 试驾台 debug overrides: id -> value
	const motionActiveRef = useRef(null); // { until, loop?, group? } while a motion owns the params
	const idleRef = useRef({ accum: 0, drowsed: false, varAt: 8000 + Math.random() * 12000 });
	const [status, setStatus] = useState("loading");

	moodRef.current = mood;
	const stateRef = useRef(state);
	stateRef.current = state;

	// Re-mount only when the pet's identity or model path changes — NOT on
	// every pets-list poll (the list fetch mints fresh pet objects every
	// 30s, which would otherwise destroy and reload the model each time).
	const petId = pet.id;
	const petModel = pet.model;

	/** Play a motion group/index; loop motions own the params until stopped. */
	const playMotion = useCallback((group, index, { loop = false } = {}) => {
		const model = modelRef.current;
		if (model === null) return;
		try {
			model.motion(group, index, 1); // priority FORCE
			const def = model.internalModel.settings.motions?.[group]?.[index];
			const durationMs = (typeof def?.Duration === "number" ? def.Duration : 2) * 1000;
			motionActiveRef.current = { until: loop ? Infinity : Date.now() + durationMs, loop, group };
			probe("live2d-motion", { state: stateRef.current, group, index, loop, durationMs });
		} catch (error) {
			probe("live2d-motion-error", { state: stateRef.current, message: String(error?.message ?? error) });
		}
	}, []);
	const playMotionRef = useRef(playMotion);
	playMotionRef.current = playMotion;

	// State -> motion trigger (runs when the model is ready).
	const prevStateRef = useRef(null);
	useEffect(() => {
		if (state === prevStateRef.current) return;
		const prev = prevStateRef.current;
		prevStateRef.current = state;
		if (prev === "idle") idleRef.current = { accum: 0, drowsed: false, varAt: 8000 + Math.random() * 12000 };
		if (state !== "idle") {
			// Leaving idle stops looping idle motions (drowse).
			const active = motionActiveRef.current;
			if (active?.loop === true) {
				try {
					modelRef.current?.internalModel.motionManager.stopAllMotions();
				} catch {
					/* ignore */
				}
				motionActiveRef.current = null;
			}
		}
		const mapping = motionForState(state);
		if (mapping !== null) playMotion(mapping[0], mapping[1]);
	}, [state, playMotion]);

	useEffect(() => {
		const mount = mountRef.current;
		if (mount === null) return;
		let disposed = false;

		const app = new PIXI.Application({
			width: LIVE2D_W,
			height: LIVE2D_H,
			backgroundAlpha: 0,
			antialias: true,
			autoStart: true,
			sharedTicker: true, // app.ticker === Ticker.shared: our per-frame
			// driver runs AFTER the library's motion update (listener order),
			// so gating param writes on active motions is deterministic.
		});
		appRef.current = app;
		app.view.style.pointerEvents = "none";
		mount.appendChild(app.view);
		// The library wants the Ticker CLASS (it uses Ticker.shared).
		Live2DModel.registerTicker(PIXI.Ticker);

		const url = `/api/pets/${encodeURIComponent(petId)}/assets/${encodeURIComponent(petModel)}`;
		// The tick is registered INSIDE the load resolution so the library's
		// model-update listener (added at model creation) always runs FIRST on
		// the shared ticker — otherwise the model update would overwrite our
		// parameter writes at the end of every frame.
		let disposeTick = null;
		// autoUpdate is disabled so OUR tick owns the frame order: it calls
		// model.update() (motions + physics) first and writes parameters
		// after — otherwise the physics system would overwrite our values at
		// the end of every frame.
		Live2DModel.from(url, { autoInteract: false, autoUpdate: false })
			.then((model) => {
				if (disposed) {
					model.destroy();
					return;
				}
				modelRef.current = model;
				const scale = LIVE2D_H / Math.max(1, model.internalModel.height);
				model.scale.set(scale);
				model.anchor.set(0.5, 1);
				model.position.set(LIVE2D_W / 2, LIVE2D_H);
				app.stage.addChild(model);
				// Testability hook (also handy for manual debugging).
				window.__dshPetDebug = { app, model, modelRef, live2d: true, target: targetRef, overrides: overridesRef, motionActive: motionActiveRef };
				setStatus("ready");
				// Parameter writes must happen in the library's render-phase
				// "beforeModelUpdate" hook (after physics, before the mesh is
				// computed from the parameters) — ticker writes are wiped by the
				// render-phase save/load sandwich.
				model.internalModel.on("beforeModelUpdate", applyParams);
				app.ticker.add(tick);
				disposeTick = () => app.ticker.remove(tick);
				probe("live2d-loaded", { id: pet.id, scale, modelWidth: model.internalModel.width, modelHeight: model.internalModel.height });
			})
			.catch((error) => {
				if (disposed) return;
				probe("live2d-error", { id: pet.id, message: String(error?.message ?? error), stack: String(error?.stack ?? "").slice(0, 500) });
				setStatus("error");
			});

		// Gaze follow: track the pointer relative to the pet's box.
		const onPointerMove = (e) => {
			const rect = mount.getBoundingClientRect();
			const nx = Math.max(-1, Math.min(1, ((e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2))));
			const ny = Math.max(-1, Math.min(1, ((e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2))));
			targetRef.current = { x: nx, y: ny };
		};
		window.addEventListener("pointermove", onPointerMove, { passive: true });

		// All parameter writes land here — the library's render phase emits
		// beforeModelUpdate AFTER physics and BEFORE the mesh is computed from
		// the parameters, which is the only slot where writes affect the
		// rendered model.
		const applyParams = () => {
			const model = modelRef.current;
			if (model === null || model === undefined) return;
			const core = model.internalModel.coreModel;
			const now = Date.now();
			const motionOwns = motionActiveRef.current !== null && now < motionActiveRef.current.until;
			if (!motionOwns) motionActiveRef.current = null;

			if (!motionOwns) {
				// Gaze params (lerped for smoothness). Live2D convention: positive
				// ParamAngleY looks UP while screen Y grows downward, so the
				// vertical component is negated. Eyeball params have no visual
				// binding on this rig (cockpit calibration).
				const t = targetRef.current;
				const lerp = (current, next, k) => current + (next - current) * k;
				safeParam(core, "ParamAngleX", lerp(readParam(core, "ParamAngleX", 0), t.x * 30, 0.08));
				safeParam(core, "ParamAngleY", lerp(readParam(core, "ParamAngleY", 0), -t.y * 20, 0.08));

				// Mood pulses: head tilt only (smile params are unbound here).
				const moodState = moodRef.current;
				let tiltZ = 0;
				if (moodState !== null) {
					const duration = moodState.state === "jumping" ? 650 : 550;
					const p = Math.max(0, Math.min(1, (now - moodState.start) / duration));
					if (moodState.state === "waving") {
						tiltZ = Math.sin(p * Math.PI * 2) * 10;
					}
				}
				safeParam(core, "ParamAngleZ", tiltZ);

				// Blink (state machine advanced in the tick; value applied here).
				safeParam(core, "ParamEyeLOpen", blinkRef.current.eyeOpen);
				safeParam(core, "ParamEyeROpen", blinkRef.current.eyeOpen);
			}

			// 试驾台 overrides always win (calibration must override everything).
			const overrides = overridesRef.current;
			for (const [id, value] of Object.entries(overrides)) safeParam(core, id, value);

			// Diagnostic: what did we actually write this frame?
			if (window.__dshPetDebug !== undefined) {
				window.__dshPetDebug.lastWritten = readParam(core, "ParamAngleX", NaN);
			}
		};

		// Per-frame driver: blink state machine, idle timers, model update
		// (accumulates delta; the library applies it during the render phase),
		// and the jump hop transform.
		const tick = () => {
			const model = modelRef.current;
			if (model === null || model === undefined) return;
			const debug = window.__dshPetDebug;
			if (debug !== undefined) debug.tickCount = (debug.tickCount ?? 0) + 1;
			const delta = app.ticker.deltaMS;
			const now = Date.now();

			// Model update accumulates deltaTime; the render phase runs the
			// internal update (physics/motions) and fires beforeModelUpdate.
			try {
				model.update(delta);
			} catch {
				/* model update must not break the driver */
			}

			// Blink state machine (the eye values are applied in applyParams).
			const blink = blinkRef.current;
			if (blink.phase === null) {
				blink.next -= delta;
				if (blink.next <= 0) {
					blink.phase = "closing";
					blink.start = now;
				}
			} else if (blink.phase === "closing") {
				if (now - blink.start > 80) {
					blink.phase = "closed";
					blink.start = now;
				}
			} else if (blink.phase === "closed") {
				if (now - blink.start > 50) {
					blink.phase = "opening";
					blink.start = now;
				}
			} else if (now - blink.start > 100) {
				blink.phase = null;
				blink.next = BLINK_INTERVAL * (0.7 + Math.random() * 0.6);
			}
			let eyeOpen = 1;
			if (blink.phase === "closing") eyeOpen = 1 - (now - blink.start) / 80;
			else if (blink.phase === "closed") eyeOpen = 0;
			else if (blink.phase === "opening") eyeOpen = (now - blink.start) / 100;
			blink.eyeOpen = Math.max(0, Math.min(1, eyeOpen));

			// Idle behaviors: drowse after ~30s of stillness, occasional
			// idle variants in between.
			if (stateRef.current === "idle") {
				const idle = idleRef.current;
				idle.accum += delta;
				if (!idle.drowsed && idle.accum >= 30000) {
					idle.drowsed = true;
					playMotionRef.current("Drowse", 0, { loop: true });
				} else if (idle.accum >= idle.varAt) {
					idle.varAt = idle.accum + 8000 + Math.random() * 12000;
					playMotionRef.current("IdleVar", 0);
				}
			}
		};
		// (tick registration moved into the model-load resolution above)

		return () => {
			disposed = true;
			window.removeEventListener("pointermove", onPointerMove);
			disposeTick?.();
			try {
				modelRef.current?.internalModel.off("beforeModelUpdate", applyParams);
			} catch {
				/* ignore */
			}
			window.__dshPetDebug = undefined;
			try {
				modelRef.current?.destroy();
			} catch {
				/* ignore */
			}
			modelRef.current = null;
			try {
				app.destroy(true, { children: true, texture: true, baseTexture: true });
			} catch {
				/* ignore */
			}
			appRef.current = null;
		};
	}, [petId, petModel]);

	return (
		<div className="dsh-pet-live2d" ref={mountRef} style={{ width: LIVE2D_W, height: LIVE2D_H }}>
			{status === "loading" && <div className="dsh-pet-live2d-status">加载中…</div>}
			{status === "error" && <div className="dsh-pet-live2d-status">模型加载失败</div>}
			{status === "ready" && debugEnabled() && <DebugPanel pet={pet} overrides={overridesRef} />}
		</div>
	);
}
