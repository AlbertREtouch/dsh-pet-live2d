#!/usr/bin/env node
/**
 * motion-gen — hand-authored motion3.json generator for Live2D Cubism 4.
 *
 * Turns a readable curve spec into a valid .motion3.json, validated against a
 * parameter table (id -> [min, max]) so every parameter id exists on the
 * target model and every value stays inside a sane range.
 *
 * motion3.json segment encoding (decoded from the official CubismWebFramework
 * parser and verified against Live2D's Haru sample):
 *   Segments = [ t0, v0, segType1, t1, v1, segType2, t2, v2, ... ]
 *   - points are (time, value)
 *   - segType: 0 = Linear (one end point), 1 = Bezier (three points),
 *              2 = Stepped, 3 = InverseStepped
 *   - this generator emits Linear segments only (AreBeziersRestricted: true)
 *
 * Usage:
 *   node scripts/motion-gen.mjs <spec.json> --out <dir> [--apply]
 *     --out <dir>   write <name>.motion3.json there
 *     --apply       also install into ~/.dsh/pets/anko/motions/ and patch
 *                   352.model3.json's FileReferences.Motions with the spec's
 *                   "group" (default "Custom")
 *
 * Spec (JSON):
 * {
 *   "name": "nod", "loop": false, "duration": 1.2, "fps": 30,
 *   "group": "TapBody", "fadeIn": 0.05, "fadeOut": 0.2,
 *   "curves": [
 *     { "id": "ParamAngleY", "shape": { "type": "sine", "amp": 14, "cycles": 2, "phase": -90 } }
 *   ]
 * }
 * Shapes: sine | damped | pulse | ramp | keys
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const ANKO_DIR = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "pets", "anko");

/** Live2D-standard parameter range conventions (cdi3 files often omit them). */
const RANGE_PATTERNS = [
	[/Angle|BrowAngle/i, [-30, 30]],
	[/EyeBall/i, [-1, 1]],
	[/Brow|BrowForm/i, [-1, 1]],
	[/EyeL?Open|EyeR?Open|EyeL?Smile|EyeR?Smile|Mouth|Cheek|Breath/i, [0, 1]],
	[/Hair/i, [-30, 30]],
];

/** id -> [min, max] from a cdi3.json (missing ranges fall back to conventions). */
function paramTable(cdiPath) {
	const cdi = JSON.parse(readFileSync(cdiPath, "utf8"));
	const table = {};
	for (const p of cdi.Parameters ?? []) {
		let [min, max] = [-1, 1];
		if (typeof p.Min === "number" && typeof p.Max === "number") [min, max] = [p.Min, p.Max];
		else {
			for (const [re, range] of RANGE_PATTERNS) {
				if (re.test(p.Id)) {
					[min, max] = range;
					break;
				}
			}
		}
		table[p.Id] = { min, max };
	}
	return table;
}

// --- curve shapes (sampled in seconds) --------------------------------------

const TAU = Math.PI * 2;
const smoothstep = (x) => {
	const t = Math.max(0, Math.min(1, x));
	return t * t * (3 - 2 * t);
};

function sampleShape(shape, t, duration) {
	const base = shape.base ?? 0;
	switch (shape.type) {
		case "sine": {
			const phase = ((shape.phase ?? 0) * Math.PI) / 180;
			return base + (shape.amp ?? 0) * Math.sin(phase + TAU * (shape.cycles ?? 1) * (t / duration));
		}
		case "damped": {
			const phase = ((shape.phase ?? 0) * Math.PI) / 180;
			return base + (shape.amp ?? 0) * Math.sin(phase + TAU * (shape.cycles ?? 1) * (t / duration)) * Math.exp(-(shape.decay ?? 1.5) * (t / duration));
		}
		case "pulse": {
			// base -> peak (rise s) -> base (fall s); returns base outside.
			const rise = shape.rise ?? 0.2;
			const fall = shape.fall ?? 0.4;
			const peak = shape.peak ?? 1;
			if (t < rise) return base + (peak - base) * smoothstep(t / rise);
			if (t < rise + fall) return base + (peak - base) * (1 - smoothstep((t - rise) / fall));
			return base;
		}
		case "ramp": {
			const from = shape.from ?? base;
			const to = shape.to ?? base;
			const start = shape.start ?? 0;
			const end = shape.end ?? duration;
			if (t <= start) return from;
			if (t >= end) return to;
			const p = (t - start) / (end - start);
			return from + (to - from) * (shape.ease === false ? p : smoothstep(p));
		}
		case "keys": {
			const keys = shape.keys ?? [[0, base]];
			if (t <= keys[0][0]) return keys[0][1];
			for (let i = 1; i < keys.length; i++) {
				if (t <= keys[i][0]) {
					const [t0, v0] = keys[i - 1];
					const [t1, v1] = keys[i];
					const p = (t - t0) / Math.max(1e-6, t1 - t0);
					return v0 + (v1 - v0) * p;
				}
			}
			return keys[keys.length - 1][1];
		}
		default:
			throw new Error(`unknown shape type: ${shape.type}`);
	}
}

// --- motion3.json emission ---------------------------------------------------

function buildMotion(spec, table) {
	const duration = spec.duration;
	const fps = spec.fps ?? 30;
	const segments = Math.max(1, Math.round(duration * fps));
	const curves = [];
	let totalSegments = 0;
	let totalPoints = 0;
	for (const curveSpec of spec.curves ?? []) {
		const entry = table[curveSpec.id];
		if (entry === undefined) {
			console.warn(`warn: unknown parameter "${curveSpec.id}" — curve skipped`);
			continue;
		}
		const segs = [];
		let clamped = false;
		const clamp = (v) => {
			const cv = Math.min(entry.max, Math.max(entry.min, v));
			if (cv !== v) clamped = true;
			return cv;
		};
		// Start point (time, value), then one [Linear, t, v] triple per segment.
		segs.push(0, clamp(sampleShape(curveSpec.shape, 0, duration)));
		for (let i = 1; i <= segments; i++) {
			const t = i === segments ? duration : i / fps;
			segs.push(0, t, clamp(sampleShape(curveSpec.shape, t, duration)));
		}
		if (clamped) console.warn(`warn: "${curveSpec.id}" values clamped to [${entry.min}, ${entry.max}]`);
		const curve = {
			Target: "Parameter",
			Id: curveSpec.id,
			Segments: segs,
		};
		if (curveSpec.fadeIn !== undefined) curve.FadeInTime = curveSpec.fadeIn;
		if (curveSpec.fadeOut !== undefined) curve.FadeOutTime = curveSpec.fadeOut;
		curves.push(curve);
		totalSegments += segments;
		totalPoints += segments + 1;
	}
	return {
		Version: 3,
		Meta: {
			Duration: duration,
			Fps: fps,
			Loop: spec.loop === true,
			AreBeziersRestricted: true,
			CurveCount: curves.length,
			TotalSegmentCount: totalSegments,
			TotalPointCount: totalPoints,
			UserDataCount: 0,
			TotalUserDataSize: 0,
		},
		Curves: curves,
	};
}

// --- cli ---------------------------------------------------------------------

const { values, positionals } = parseArgs({
	options: {
		out: { type: "string" },
		apply: { type: "boolean", default: false },
		cdi: { type: "string" },
	},
	allowPositionals: true,
});

const specPath = positionals[0];
if (specPath === undefined) {
	console.error("usage: motion-gen.mjs <spec.json> --out <dir> [--apply] [--cdi <cdi3.json>]");
	process.exit(64);
}
const spec = JSON.parse(readFileSync(resolve(specPath), "utf8"));
if (!/^[a-zA-Z0-9_-]+$/.test(spec.name ?? "")) {
	console.error(`error: spec.name must be [a-zA-Z0-9_-]+, got ${JSON.stringify(spec.name)}`);
	process.exit(64);
}
if (typeof spec.duration !== "number" || spec.duration <= 0) {
	console.error("error: spec.duration must be a positive number (seconds)");
	process.exit(64);
}

const cdiPath = resolve(values.cdi ?? join(ANKO_DIR, "352.cdi3.json"));
if (!existsSync(cdiPath)) {
	console.error(`error: cdi3 not found at ${cdiPath} (pass --cdi)`);
	process.exit(66);
}
const table = paramTable(cdiPath);
const motion = buildMotion(spec, table);

const outDir = resolve(values.out ?? ".");
mkdirSync(outDir, { recursive: true });
const motionPath = join(outDir, `${spec.name}.motion3.json`);
writeFileSync(motionPath, JSON.stringify(motion, null, "\t") + "\n");
console.log(`motion written: ${motionPath} (${motion.Curves.length} curves, ${motion.Meta.TotalSegmentCount} segments, ${motion.Meta.Duration}s${motion.Meta.Loop ? ", loop" : ""})`);

if (values.apply) {
	const motionsDir = join(ANKO_DIR, "motions");
	mkdirSync(motionsDir, { recursive: true });
	const installed = join(motionsDir, `${spec.name}.motion3.json`);
	writeFileSync(installed, JSON.stringify(motion, null, "\t") + "\n");
	const group = spec.group ?? "Custom";
	const model3Path = join(ANKO_DIR, "352.model3.json");
	const model3 = JSON.parse(readFileSync(model3Path, "utf8"));
	const refs = (model3.FileReferences ??= {});
	const motions = (refs.Motions ??= {});
	const list = (motions[group] ??= []);
	const entry = { File: `motions/${spec.name}.motion3.json`, FadeInTime: spec.fadeIn ?? 0.5, FadeOutTime: spec.fadeOut ?? 0.5 };
	const existing = list.findIndex((e) => e.File === entry.File);
	if (existing >= 0) list[existing] = entry;
	else list.push(entry);
	writeFileSync(model3Path, JSON.stringify(model3, null, "\t") + "\n");
	console.log(`installed to anko motions group "${group}" and patched 352.model3.json`);
}
