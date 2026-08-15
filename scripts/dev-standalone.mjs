/**
 * dev-standalone: minimal preview server for the standalone pet.
 *
 * Serves pet.html + lib/standalone.js and mounts the pet route factory on
 * /api. Phase 1 turns this into the Electron in-process server; for now it
 * doubles as the real-browser regression harness for the shared kernel.
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

const PET_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-pet standalone preview</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
#pet-root{position:fixed;inset:0}
</style>
</head>
<body>
<div id="pet-root"></div>
<script src="/standalone.js"></script>
<script>
PetStandalone.mount({
  target: document.getElementById("pet-root"),
  assetBase: ${JSON.stringify(`http://127.0.0.1:${port}/api`)},
});
</script>
</body>
</html>`;

const server = createServer((req, res) => {
	const pathname = new URL(req.url ?? "/", "http://x").pathname;
	if (pathname === "/" || pathname === "/pet.html") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(PET_HTML);
		return;
	}
	if (pathname === "/standalone.js") {
		const body = readFileSync(join(root, "lib", "standalone.js"));
		res.writeHead(200, { "content-type": "text/javascript" });
		res.end(body);
		return;
	}
	if (pathname === "/standalone.js.map") {
		const body = readFileSync(join(root, "lib", "standalone.js.map"));
		res.writeHead(200, { "content-type": "application/json" });
		res.end(body);
		return;
	}
	petServer.handleRequest(req, res);
});

server.listen(port, "127.0.0.1", () => {
	console.log(`standalone preview: http://127.0.0.1:${port}/ (petsRoot: ${petServer.petsRoot})`);
});
