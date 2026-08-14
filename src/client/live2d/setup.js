/**
 * Live2D bootstrap — MUST be evaluated before pixi-live2d-display/cubism4,
 * whose module body throws when `window.Live2DCubismCore` is missing.
 *
 * The Cubism Core is bundled as TEXT (see scripts/build-client.mjs): bundling
 * it as code would execute its CJS branch against the factory scope and
 * clobber the bundle's module.exports. Executing the source with
 * `new Function` in a scope that has no `module`/`exports` makes the UMD take
 * the browser-global branch — `Live2DCubismCore = Live2DCubismCore || {}` —
 * exactly how the official <script> tag loads it. (The DSH page ships no
 * Content-Security-Policy, so dynamic code evaluation is available.)
 */
import coreSource from "./live2dcubismcore.min.js";

if (globalThis.Live2DCubismCore === undefined || typeof globalThis.Live2DCubismCore.Moc === "undefined") {
	// Indirect eval runs in global scope, so the core's top-level
	// `var Live2DCubismCore` lands on globalThis exactly as it would from a
	// <script> tag (a `new Function` scope would keep the var local).
	(0, eval)(coreSource);
}
