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
 * @module dsh-pet
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

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

/** Default pets root: `$DSH_PET_ROOT` > `$DSH_HOME/pets` > `~/.dsh/pets`. */
function defaultPetsRoot() {
	const override = process.env.DSH_PET_ROOT;
	if (override !== void 0 && override.trim().length > 0) return resolve(override);
	const home = process.env.DSH_HOME;
	return join(home !== void 0 && home.trim().length > 0 ? home : join(homedir(), ".dsh"), "pets");
}

/** Read one pet folder's manifest defensively; folder name is the identity. */
function readPet(root, folder) {
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

/** Scan the pets root; missing root is a valid empty catalog. */
function listPets(root) {
	let entries;
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	const pets = [];
	for (const folder of entries) {
		if (!SAFE_ID.test(folder)) continue;
		const dir = join(root, folder);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		const pet = readPet(root, folder);
		const adoptable = pet.kind === "live2d" ? pet.model.length > 0 : pet.spritesheetPath.length > 0;
		if (!adoptable) continue; // manifest without a renderable asset is not adoptable
		pets.push(pet);
	}
	pets.sort((a, b) => a.id.localeCompare(b.id));
	return pets;
}

/** Answer `GET /api/pets`, `GET /api/pets/<id>/spritesheet`, and `POST /api/pets/echo`. */
function routeHandler(root) {
	const prefix = "/api/pets";
	const echoPath = join(homedir(), ".dsh", "pets-echo.log");
	const readBody = (req) =>
		new Promise((resolveBody) => {
			const chunks = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
		});
	return (req, res) => {
		const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
		if (pathname === `${prefix}/echo` && req.method === "POST") {
			readBody(req).then((body) => {
				try {
					appendFileSync(echoPath, `${new Date().toISOString()} ${body}\n`);
				} catch {
					/* diagnostics are best-effort */
				}
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end("{}");
			});
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405);
			res.end();
			return;
		}
		if (pathname === prefix) {
			const body = JSON.stringify(listPets(root));
			res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
			res.end(body);
			return;
		}
		// Live2D model assets: any file under the pet folder (model3.json,
		// .moc3, textures, physics...) with path-traversal protection.
		const assetMatch = /^\/api\/pets\/([^/]+)\/assets\/(.+)$/.exec(pathname);
		if (assetMatch !== null) {
			const id = assetMatch[1];
			if (!SAFE_ID.test(id)) {
				res.writeHead(404);
				res.end();
				return;
			}
			const petDir = resolve(root, id);
			const file = resolve(petDir, assetMatch[2]);
			if (file !== petDir && !file.startsWith(petDir + sep)) {
				res.writeHead(403);
				res.end();
				return;
			}
			try {
				const body = readFileSync(file);
				const ext = basename(file).slice(basename(file).lastIndexOf(".")).toLowerCase();
				res.writeHead(200, {
					"content-type": MIME[ext] ?? "application/octet-stream",
					"cache-control": "no-cache",
				});
				res.end(body);
			} catch {
				res.writeHead(404);
				res.end();
			}
			return;
		}
		const match = /^\/api\/pets\/([^/]+)\/spritesheet$/.exec(pathname);
		if (match === null) {
			res.writeHead(404);
			res.end();
			return;
		}
		const id = match[1];
		if (!SAFE_ID.test(id)) {
			res.writeHead(404);
			res.end();
			return;
		}
		const pet = readPet(root, id);
		if (pet.spritesheetPath.length === 0) {
			res.writeHead(404);
			res.end();
			return;
		}
		const file = join(root, id, pet.spritesheetPath);
		try {
			const body = readFileSync(file);
			const ext = MIME[basename(file).slice(basename(file).lastIndexOf(".")).toLowerCase()];
			res.writeHead(200, {
				"content-type": ext ?? "application/octet-stream",
				"cache-control": "no-cache",
			});
			res.end(body);
		} catch {
			res.writeHead(404);
			res.end();
		}
	};
}

export function apply(ctx) {
	const root = defaultPetsRoot();
	ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/api/pets", handler: routeHandler(root) }), "dsh-pet: /api/pets routes");
}

export { defaultPetsRoot, listPets, readPet };
