/**
 * Build the two client bundles:
 *
 * 1. DSH plugin bundle (`lib/client.js`): the DSH browser runtime loads
 *    client plugins as classic scripts that call
 *    `window.__ModuleLoader__.load({ id, factory })`. Platform modules
 *    (react family) stay external — they resolve against the shell's frozen
 *    seed table — everything else is bundled.
 *
 * 2. Standalone bundle (`lib/standalone.js`): same shared kernel, IIFE with
 *    React BUNDLED. The pet.html dev preview and the future Electron shell
 *    load this file with no platform seed table.
 *
 * Both share the node-builtin stubs and the Cubism Core TEXT packaging.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleId = process.env.DSH_PET_BUNDLE_ID ?? "dsh-pet";

const dshOutfile = join(root, "lib", `client${bundleId === "dsh-pet" ? "" : `-${bundleId}`}.js`);
const standaloneOutfile = join(root, "lib", "standalone.js");

// The seed table the web shell shares with every bundle (PLATFORM_MODULES +
// react family). Everything else must be bundled.
const externals = [
	"react",
	"react/jsx-runtime",
	"react-dom",
	"react-dom/client",
	"@deepseek-ai/cordis",
	"@deepseek-ai/dsh-client-ui-slots",
	"@deepseek-ai/dsh-client-web-react",
	"@deepseek-ai/dsh-client-ui-primitives",
	"@deepseek-ai/dsh-client-ui-attachment",
	"@deepseek-ai/dsh-client-schema-form",
];

// Node-only code paths inside browser bundles (emscripten FS, pixi node
// adapters) never execute in the page, but esbuild still has to resolve the
// bare builtins at build time — stub them out.
const NODE_BUILTIN_STUBS = new Set(["fs", "path", "os", "url", "http", "https", "net", "tls", "stream", "zlib", "crypto", "child_process", "worker_threads", "util", "events", "assert", "buffer", "string_decoder"]);
const nodeBuiltinsPlugin = {
	name: "node-builtins",
	setup(buildApi) {
		buildApi.onResolve({ filter: /^(fs|path|os|url|http|https|net|tls|stream|zlib|crypto|child_process|worker_threads|util|events|assert|buffer|string_decoder)$/ }, (args) => {
			// pixi-live2d-display calls Node's `url.resolve` — map to the real
			// node-url polyfill package (browser-safe, pure JS).
			if (args.path === "url") {
				return { path: join(root, "node_modules", "url", "url.js"), namespace: "file" };
			}
			return { path: args.path, namespace: "node-stub" };
		});
		buildApi.onLoad({ filter: /.*/, namespace: "node-stub" }, (args) => ({
			contents: `module.exports = {};`,
			loader: "js",
		}));
	},
};

// The Cubism Core UMD, when bundled as code, would execute its CJS branch
// against the factory scope and overwrite the bundle's module.exports — load
// it as TEXT instead; the client executes it in a clean scope at runtime so
// the browser-global branch runs (same as the official <script> tag).
const live2dCoreTextPlugin = {
	name: "live2dcubismcore-text",
	setup(buildApi) {
		buildApi.onLoad({ filter: /live2dcubismcore\.min\.js$/ }, (args) => ({
			contents: readFileSync(args.path, "utf8"),
			loader: "text",
		}));
	},
};

async function bundle({ entry, outfile, format, globalName, external }) {
	const result = await build({
		entryPoints: [join(root, entry)],
		outfile,
		bundle: true,
		format,
		globalName,
		platform: "browser",
		target: ["es2020"],
		jsx: "automatic",
		loader: { ".js": "jsx", ".jsx": "jsx" },
		external,
		plugins: [nodeBuiltinsPlugin, live2dCoreTextPlugin],
		sourcemap: "external",
		minify: false,
		logLevel: "info",
		write: false,
	});
	const body = result.outputFiles.find((f) => f.path.endsWith(".js"))?.text;
	const map = result.outputFiles.find((f) => f.path.endsWith(".map"))?.text;
	if (body === undefined) throw new Error(`esbuild produced no bundle output for ${entry}`);
	return { body, map };
}

// 1) DSH plugin bundle, wrapped in the loader factory.
const dsh = await bundle({
	entry: "src/client/index.js",
	outfile: dshOutfile,
	format: "cjs",
	external: externals,
});
const wrapper = [
	"window.__ModuleLoader__.load({",
	`\tid: ${JSON.stringify(bundleId)},`,
	"\tfactory: (require) => {",
	"\t\tvar module = { exports: {} };",
	"\t\tvar exports = module.exports;",
	"\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });",
	dsh.body,
	"\t\treturn module.exports;",
	"\t}",
	"});",
	"",
].join("\n");
writeFileSync(dshOutfile, wrapper);
if (dsh.map !== undefined) writeFileSync(`${dshOutfile}.map`, dsh.map);
console.log(`dsh-pet client bundle written: ${dshOutfile} (${readFileSync(dshOutfile).length} bytes)`);

// 2) Standalone bundle: React must be included (no DSH seed table).
const standalone = await bundle({
	entry: "src/entries/standalone.js",
	outfile: standaloneOutfile,
	format: "iife",
	globalName: "PetStandalone",
	external: [],
});
writeFileSync(standaloneOutfile, standalone.body);
if (standalone.map !== undefined) writeFileSync(`${standaloneOutfile}.map`, standalone.map);
console.log(`standalone bundle written: ${standaloneOutfile} (${readFileSync(standaloneOutfile).length} bytes)`);
