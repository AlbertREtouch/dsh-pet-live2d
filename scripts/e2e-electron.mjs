/**
 * e2e-electron: smoke-test the Electron shell end to end.
 *
 * Launches `electron electron/main.cjs --dsh-pet-e2e` with a workspace-local
 * pets root (a copy of sample-pet), then waits for the main process to print
 * `DSH_PET_E2E_OK {…}`. The shell's e2e mode verifies:
 *   - the in-process pet server answers GET /api/pets on 127.0.0.1
 *   - the renderer mounted PetStandalone and reported the active skin
 *   - the transparent window rendered the pet DOM node
 * This is intentionally a smoke test: shell stays thin, kernel logic is
 * covered by the existing browser-level suites.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// DSH_PET_E2E_BINARY can point at dist/win-unpacked/DSH Pet.exe to smoke-test
// the packaged artifact as well as the dev binary.
const electronBinary =
	process.env.DSH_PET_E2E_BINARY ?? join(root, "node_modules", "electron", "dist", "electron.exe");
// DSH_PET_E2E_ROOT overrides the fixture root, e.g. point it at ~/.dsh/pets to
// also exercise the Live2D skin path with a real model.
const fixtureRoot = process.env.DSH_PET_E2E_ROOT ?? null;
const tmpRoot = fixtureRoot !== null ? fixtureRoot : join(root, ".tmp-pet-root");

if (!existsSync(join(root, "lib", "standalone.js"))) {
	console.error("e2e-electron: lib/standalone.js missing — run `npm run build:client` first");
	process.exit(1);
}
if (!existsSync(electronBinary)) {
	console.error("e2e-electron: electron binary missing — reinstall the electron package");
	process.exit(1);
}

if (fixtureRoot === null) {
	rmSync(tmpRoot, { recursive: true, force: true });
	mkdirSync(tmpRoot, { recursive: true });
	// Two skins so the e2e can exercise the tray-driven skin-switch IPC path.
	cpSync(join(root, "sample-pet"), join(tmpRoot, "dsh-kitten"), { recursive: true });
	cpSync(join(root, "sample-pet"), join(tmpRoot, "dsh-cat"), { recursive: true });
} else if (!existsSync(tmpRoot)) {
	console.error(`e2e-electron: DSH_PET_E2E_ROOT not found: ${tmpRoot}`);
	process.exit(1);
}

const isPackaged = process.env.DSH_PET_E2E_BINARY !== undefined;
const child = spawn(
	electronBinary,
	isPackaged ? ["--dsh-pet-e2e"] : [join(root, "electron", "main.cjs"), "--dsh-pet-e2e"],
	{
		cwd: root,
		env: {
			...process.env,
			DSH_PET_ROOT: tmpRoot,
			ELECTRON_ENABLE_LOGGING: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	},
);

let stdout = "";
let stderr = "";
const timeoutMs = 60000;
const deadline = Date.now() + timeoutMs;

child.stdout.on("data", (chunk) => {
	stdout += chunk.toString("utf8");
});
child.stderr.on("data", (chunk) => {
	stderr += chunk.toString("utf8");
});

const finished = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

const okIndex = () => stdout.indexOf("DSH_PET_E2E_OK");
while (Date.now() < deadline && okIndex() === -1 && child.exitCode === null) {
	await new Promise((resolve) => setTimeout(resolve, 250));
}

const result = await finished;
try {
	if (okIndex() === -1) {
		console.error("E2E ELECTRON FAIL (no OK marker)");
		if (stdout.trim().length > 0) console.error(stdout.trim());
		if (stderr.trim().length > 0) console.error(stderr.trim().slice(-2000));
		process.exit(1);
	}
	const line = stdout.slice(okIndex()).split("\n")[0];
	console.log(line);
	if (result.code !== 0) {
		console.error(`E2E ELECTRON FAIL (exit ${result.code})`);
		if (stderr.trim().length > 0) console.error(stderr.trim().slice(-2000));
		process.exit(1);
	}
	console.log("E2E ELECTRON PASS");
} finally {
	if (fixtureRoot === null) rmSync(tmpRoot, { recursive: true, force: true });
}
