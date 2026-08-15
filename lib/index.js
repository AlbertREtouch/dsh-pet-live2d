/**
 * dsh-pet host plugin.
 *
 * Serves the pet catalog and sprite bytes to the DSH web GUI over the
 * harness webserver (`webServer` service, exact/prefix route registry):
 *
 *   GET /api/pets                     -> [{ id, displayName, description, spritesheetPath }]
 *   GET /api/pets/<id>/spritesheet    -> raw sprite atlas bytes (webp/png/gif)
 *
 * The catalog mirrors the Codex layout convention, rooted at the DSH home
 * pets directory instead of `${CODEX_HOME}/pets`:
 *
 *   <petsRoot>/<pet-id>/
 *     pet.json          # { id?, displayName?, description?, spritesheetPath? } — all optional
 *     spritesheet.webp  # 1536x1872 atlas, 8 cols x 9 rows of 192x208 cells (.png/.gif also accepted)
 *
 * `petsRoot` resolution: `$DSH_PET_ROOT` when set, otherwise `$DSH_HOME/pets`
 * (falling back to `~/.dsh/pets`). The directory is scanned per request, so
 * a newly hatched pet appears on the next list fetch without any reload.
 *
 * The route implementation is DSH-agnostic: `createPetServer()` returns a
 * `handleRequest(req, res)` function usable from `http.createServer` as well
 * as a `register(webServer)` helper for the DSH plugin protocol.
 *
 * @module dsh-pet
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const name = "dsh-pet";
export const inject = ["webServer"];

const MIME = {
	".webp": "image/webp",
	".png": "image/png",
	".gif": "image/gif",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".json": "application/json",
	".js": "text/javascript",
	".moc3": "application/octet-stream",
	".bin": "application/octet-stream",
	".lpk": "application/octet-stream",
};
const SPRITE_FALLBACKS = ["spritesheet.webp", "spritesheet.png", "spritesheet.gif"];
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_ECHO_BODY = 64 * 1024; // diagnostic channel must not be a disk-filling pipe

/** Default pets root: `$DSH_PET_ROOT` > `$DSH_HOME/pets` > `~/.dsh/pets`. */
export function defaultPetsRoot() {
	const override = process.env.DSH_PET_ROOT;
	if (override !== void 0 && override.trim().length > 0) return resolve(override);
	const home = process.env.DSH_HOME;
	return join(home !== void 0 && home.trim().length > 0 ? home : join(homedir(), ".dsh"), "pets");
}

/** Read one pet folder's manifest defensively; folder name is the identity. */
export function readPet(root, folder) {
	const dir = join(root, folder);
	const manifestPath = join(dir, "pet.json");
	let manifest = {};
	if (existsSync(manifestPath)) {
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) manifest = {};
		} catch {
			// Malformed manifest: fall through to defaults.
		}
	}
	const field = (key, fallback) => {
		const value = manifest[key];
		return typeof value === "string" && value.length > 0 ? value : fallback;
	};
	let spritesheetPath = field("spritesheetPath", "");
	if (spritesheetPath.length === 0) {
		spritesheetPath = SPRITE_FALLBACKS.find((candidate) => existsSync(join(dir, candidate))) ?? "";
	} else {
		const dirResolved = resolve(dir);
		const resolved = resolve(dir, spritesheetPath);
		if (resolved !== dirResolved && !resolved.startsWith(dirResolved + sep)) spritesheetPath = "";
	}
	const kind = field("kind", "sprite");
	let model = "";
	if (kind === "live2d") {
		model = field("model", "");
		if (model.length > 0) {
			const dirResolved = resolve(dir);
			const resolved = resolve(dir, model);
			if (resolved !== dirResolved && !resolved.startsWith(dirResolved + sep)) model = "";
		}
	}
	return {
		id: folder,
		displayName: field("displayName", folder),
		description: field("description", ""),
		kind,
		model,
		spritesheetPath,
	};
}

/**
 * Scan the pets root; missing root is a valid empty catalog. A pet whose
 * folder resolves (through junctions/symlinks) outside the root is skipped.
 */
export function listPets(root) {
	let rootReal;
	try {
		rootReal = realpathSync(root);
	} catch {
		return [];
	}
	let entries;
	try {
		entries = readdirSync(rootReal);
	} catch {
		return [];
	}
	const pets = [];
	for (const folder of entries) {
		if (!SAFE_ID.test(folder)) continue;
		const dir = join(rootReal, folder);
		let dirReal;
		try {
			if (!statSync(dir).isDirectory()) continue;
			dirReal = realpathSync(dir);
		} catch {
			continue;
		}
		const rel = relative(rootReal, dirReal);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue; // escape hatch, not a pet
		const pet = readPet(rootReal, folder);
		const adoptable = pet.kind === "live2d" ? pet.model.length > 0 : pet.spritesheetPath.length > 0;
		if (!adoptable) continue; // manifest without a renderable asset is not adoptable
		pets.push(pet);
	}
	pets.sort((a, b) => a.id.localeCompare(b.id));
	return pets;
}

/**
 * DSH-agnostic pet route factory.
 *
 * @param {object} options
 * @param {string} [options.petsRoot]  pet directory; defaults to `defaultPetsRoot()`
 * @param {string} [options.echoPath]  diagnostic log file; defaults to `~/.dsh/pets-echo.log`
 * @param {(line: string) => void} [options.log]  optional sink that replaces file appends
 * @returns {{ petsRoot: string, echoPath: string, handleRequest: (req: any, res: any) => void, register: (webServer: any) => void }}
 */
export function createPetServer(options = {}) {
	const petsRoot = resolve(options.petsRoot ?? defaultPetsRoot());
	const echoPath = resolve(options.echoPath ?? join(homedir(), ".dsh", "pets-echo.log"));
	const log = options.log ?? null;
	const prefix = "/api/pets";

	const writeEcho = (line) => {
		if (typeof log === "function") {
			try {
				log(line);
			} catch {
				/* diagnostics are best-effort */
			}
			return;
		}
		try {
			mkdirSync(dirname(echoPath), { recursive: true });
			appendFileSync(echoPath, `${new Date().toISOString()} ${line}\n`);
		} catch {
			/* diagnostics are best-effort */
		}
	};

	// Resolves with `null` when the request body exceeds MAX_ECHO_BODY.
	const readBody = (req) =>
		new Promise((resolveBody) => {
			const chunks = [];
			let size = 0;
			let tooLarge = false;
			req.on("data", (chunk) => {
				if (tooLarge) return;
				size += chunk.length;
				if (size > MAX_ECHO_BODY) {
					tooLarge = true;
					chunks.length = 0;
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => resolveBody(tooLarge ? null : Buffer.concat(chunks).toString("utf8")));
			req.on("error", () => resolveBody(null));
		});

	const respond = (res, status, headers, body) => {
		res.writeHead(status, headers);
		res.end(body);
	};

	const handleRequest = (req, res) => {
		let pathname;
		try {
			pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
		} catch {
			respond(res, 400, {}, undefined);
			return;
		}

		if (pathname === `${prefix}/echo` && req.method === "POST") {
			readBody(req).then((body) => {
				if (body === null) {
					respond(res, 413, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ error: "body too large" }));
					return;
				}
				writeEcho(body);
				respond(res, 200, { "content-type": "application/json; charset=utf-8" }, "{}");
			});
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			respond(res, 405, {}, undefined);
			return;
		}
		const head = req.method === "HEAD";

		if (pathname === prefix) {
			const body = JSON.stringify(listPets(petsRoot));
			respond(res, 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" }, head ? undefined : body);
			return;
		}

		// Live2D model assets: any file under the pet folder (model3.json,
		// .moc3, textures, physics...) with path-traversal and symlink
		// containment protection (realpath + relative, so Windows junctions
		// pointing outside the pet folder cannot be followed).
		const assetMatch = /^\/api\/pets\/([^/]+)\/assets\/(.+)$/.exec(pathname);
		if (assetMatch !== null) {
			const id = assetMatch[1];
			if (!SAFE_ID.test(id)) {
				respond(res, 404, {}, undefined);
				return;
			}
			const petDir = resolve(petsRoot, id);
			const file = resolve(petDir, assetMatch[2]);
			if (file !== petDir && !file.startsWith(petDir + sep)) {
				respond(res, 403, {}, undefined);
				return;
			}
			let petReal;
			let fileReal;
			try {
				petReal = realpathSync(petDir);
				fileReal = realpathSync(file);
			} catch {
				respond(res, 404, {}, undefined);
				return;
			}
			const rel = relative(petReal, fileReal);
			if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
				respond(res, 403, {}, undefined);
				return;
			}
			try {
				const body = readFileSync(fileReal);
				const ext = basename(fileReal).slice(basename(fileReal).lastIndexOf(".")).toLowerCase();
				respond(res, 200, {
					"content-type": MIME[ext] ?? "application/octet-stream",
					"cache-control": "no-cache",
				}, head ? undefined : body);
			} catch {
				respond(res, 404, {}, undefined);
			}
			return;
		}

		const match = /^\/api\/pets\/([^/]+)\/spritesheet$/.exec(pathname);
		if (match === null) {
			respond(res, 404, {}, undefined);
			return;
		}
		const id = match[1];
		if (!SAFE_ID.test(id)) {
			respond(res, 404, {}, undefined);
			return;
		}
		const pet = readPet(petsRoot, id);
		if (pet.spritesheetPath.length === 0) {
			respond(res, 404, {}, undefined);
			return;
		}
		const file = join(petsRoot, id, pet.spritesheetPath);
		try {
			const body = readFileSync(file);
			const ext = MIME[basename(file).slice(basename(file).lastIndexOf(".")).toLowerCase()];
			respond(res, 200, {
				"content-type": ext ?? "application/octet-stream",
				"cache-control": "no-cache",
			}, head ? undefined : body);
		} catch {
			respond(res, 404, {}, undefined);
		}
	};

	const register = (webServer) => webServer.register({ kind: "prefix", path: "/api/pets", handler: handleRequest });

	return { petsRoot, echoPath, handleRequest, register };
}

export function apply(ctx) {
	const server = createPetServer();
	ctx.effect(() => server.register(ctx.webServer), "dsh-pet: /api/pets routes");
}

export { createPetServer as routeHandlerFactory };
