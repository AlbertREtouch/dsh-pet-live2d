/**
 * Parameter cockpit (试驾台) — a floating debug panel that drives the
 * Live2D model's parameters directly, for calibrating "parameter -> look"
 * mappings. Enabled by `?dsh-pet-debug=1`, localStorage dsh-pet:debug=1, or
 * the host-controlled `debugPanel` prop (Electron tray menu).
 *
 * Sliders write into a shared overrides map; while an override exists the
 * automatic drivers leave that parameter alone, so each parameter can be
 * auditioned in isolation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const RANGE_PATTERNS = [
	[/Angle|BrowAngle/i, [-30, 30]],
	[/EyeBall/i, [-1, 1]],
	[/Brow|BrowForm/i, [-1, 1]],
	[/EyeL?Open|EyeR?Open|EyeL?Smile|EyeR?Smile|Mouth|Cheek|Breath/i, [0, 1]],
	[/Hair/i, [-30, 30]],
];

function defaultRange(id) {
	for (const [re, range] of RANGE_PATTERNS) {
		if (re.test(id)) return range;
	}
	return [-1, 1];
}

/**
 * The .cdi3.json parameter table normally sits next to the .model3.json with
 * the same basename ("foo.model3.json" -> "foo.cdi3.json"). Derive it from
 * the manifest instead of hardcoding a model-specific file.
 */
function cdi3Url(pet, assetBase) {
	const base = String(pet?.model ?? "").replace(/(?:\.model3)?\.json$/i, "");
	const cdiName = `${base.length > 0 ? base : pet.id}.cdi3.json`;
	return `${assetBase}/pets/${encodeURIComponent(pet.id)}/assets/${encodeURIComponent(cdiName)}`;
}

export default function DebugPanel({ pet, overrides, assetBase = "/api" }) {
	const [params, setParams] = useState([]);
	const [open, setOpen] = useState(false);
	const [values, setValues] = useState({});

	useEffect(() => {
		let alive = true;
		fetch(cdi3Url(pet, assetBase), { cache: "no-store" })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
			.then((cdi) => {
				if (!alive) return;
				const list = (cdi.Parameters ?? []).map((p) => ({ ...p, range: defaultRange(p.Id) }));
				setParams(list);
			})
			.catch(() => {
				if (alive) setParams([]);
			});
		return () => {
			alive = false;
		};
	}, [pet.id, pet.model, assetBase]);

	const setParam = useCallback(
		(id, value) => {
			setValues((prev) => ({ ...prev, [id]: value }));
			overrides.current[id] = value;
		},
		[overrides],
	);
	const resetAll = useCallback(() => {
		for (const key of Object.keys(overrides.current)) delete overrides.current[key];
		setValues({});
	}, [overrides]);

	const activeCount = useMemo(() => Object.keys(values).length, [values]);

	// Panel position: draggable via the header; defaults to the left edge so
	// it never covers the pet's default bottom-right spot.
	const [panelPos, setPanelPos] = useState(null); // { x, y } | null = default
	const headDragRef = useRef(null);
	const onHeadPointerDown = (e) => {
		if (e.target.tagName === "BUTTON") return;
		e.stopPropagation();
		headDragRef.current = { startX: e.clientX, startY: e.clientY, base: panelPos ?? { x: 16, y: 16 }, pointerId: e.pointerId };
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			/* best-effort */
		}
	};
	const onHeadPointerMove = (e) => {
		const d = headDragRef.current;
		if (d === null || e.pointerId !== d.pointerId) return;
		setPanelPos({ x: d.base.x + (e.clientX - d.startX), y: d.base.y + (e.clientY - d.startY) });
	};
	const onHeadPointerUp = (e) => {
		if (headDragRef.current?.pointerId === e.pointerId) headDragRef.current = null;
	};

	// The pet wrapper's drag handler captures the pointer on any pointerdown
	// inside it, which would redirect clicks away from the debug UI (and make
	// sliders drag the pet) — stop propagation so the tab and panel stay
	// independently interactive.
	const stop = (e) => e.stopPropagation();

	if (!open) {
		return (
			<div
				className="dsh-pet-debug-tab"
				title="参数试驾台"
				onPointerDown={stop}
				onPointerUp={stop}
				onClick={(e) => {
					e.stopPropagation();
					setOpen(true);
				}}
			>
				试驾台{activeCount > 0 ? ` (${activeCount})` : ""}
			</div>
		);
	}
	return (
		<div
			className="dsh-pet-debug-panel"
			style={panelPos !== null ? { left: panelPos.x, top: panelPos.y } : undefined}
			onPointerDown={stop}
			onPointerUp={stop}
			onPointerMove={stop}
			onClick={stop}
		>
			<div className="dsh-pet-debug-head" onPointerDown={onHeadPointerDown} onPointerMove={onHeadPointerMove} onPointerUp={onHeadPointerUp}>
				<span>参数试驾台 — {pet.displayName}（拖动标题可移动面板）</span>
				<button onClick={resetAll}>重置</button>
				<button onClick={() => setOpen(false)}>收起</button>
			</div>
			<div className="dsh-pet-debug-body">
				{params.length === 0 && <div className="dsh-pet-debug-empty">cdi3 加载失败</div>}
				{params.map((p) => (
					<label key={p.Id} className="dsh-pet-debug-row" title={p.Id}>
						<span className="dsh-pet-debug-name">{p.Name}</span>
						<input
							type="range"
							min={p.range[0]}
							max={p.range[1]}
							step={(p.range[1] - p.range[0]) / 200}
							value={values[p.Id] ?? 0}
							onChange={(e) => setParam(p.Id, Number(e.target.value))}
						/>
						<span className="dsh-pet-debug-value">{(values[p.Id] ?? 0).toFixed(2)}</span>
					</label>
				))}
			</div>
		</div>
	);
}

export function debugEnabled() {
	try {
		return new URLSearchParams(location.search).has("dsh-pet-debug") || localStorage.getItem("dsh-pet:debug") === "1";
	} catch {
		return false;
	}
}
