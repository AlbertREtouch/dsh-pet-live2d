/**
 * dev-standalone: minimal preview server for the standalone pet.
 *
 * Serves the shared standalone.html + lib/standalone.js and mounts the pet
 * route factory on /api. Phase 1 uses the same page in the Electron shell;
 * this server remains the no-shell debug/preview entry for real browsers.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPetServer } from "../lib/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.DSH_PET_DEV_PORT ?? 3410);
const petsRoot = process.env.DSH_PET_ROOT ?? undefined;
const petServer = createPetServer({ petsRoot });

const HTML = readFileSync(join(root, "standalone.html"), "utf8");
const BUNDLE = () => readFileSync(join(root, "lib", "standalone.js"));
const MAP = () => readFileSync(join(root, "lib", "standalone.js.map"));

const server = createServer((req, res) => {
	const pathname = new URL(req.url ?? "/", "http://x").pathname;
	if (pathname === "/" || pathname === "/standalone.html" || pathname === "/pet.html") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(HTML);
		return;
	}
	if (pathname === "/standalone.js" || pathname === "/lib/standalone.js") {
		try {
			const body = BUNDLE();
			res.writeHead(200, { "content-type": "text/javascript" });
			res.end(body);
		} catch {
			res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
			res.end("lib/standalone.js missing — run `npm run build:client` first");
		}
		return;
	}
	if (pathname === "/standalone.js.map" || pathname === "/lib/standalone.js.map") {
		try {
			const body = MAP();
			res.writeHead(200, { "content-type": "application/json" });
			res.end(body);
		} catch {
			res.writeHead(404, {});
			res.end();
		}
		return;
	}
	petServer.handleRequest(req, res);
});

server.listen(port, "127.0.0.1", () => {
	console.log(`standalone preview: http://127.0.0.1:${port}/ (petsRoot: ${petServer.petsRoot})`);
});
