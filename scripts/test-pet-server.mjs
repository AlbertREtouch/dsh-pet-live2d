/**
 * test-pet-server: DSH-agnostic route factory tests.
 *
 * Covers catalog listing, sprite bytes, asset containment (path traversal +
 * directory junction escape), malformed URI, echo body cap and HEAD requests
 * against a bare node:http server.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPetServer } from "../lib/index.js";

const tmp = mkdtempSync(join(tmpdir(), "dsh-pet-server-"));
const petsRoot = join(tmp, "pets");
const petDir = join(petsRoot, "kitty");
mkdirSync(petDir, { recursive: true });
writeFileSync(join(petDir, "pet.json"), JSON.stringify({ id: "kitty", displayName: "Kitty", spritesheetPath: "spritesheet.png" }));
const spriteBytes = Buffer.from("fake-png-bytes");
writeFileSync(join(petDir, "spritesheet.png"), spriteBytes);

const secretFile = join(tmp, "secret.txt");
writeFileSync(secretFile, "top secret");
const secretDir = join(tmp, "secret-dir");
mkdirSync(secretDir);
writeFileSync(join(secretDir, "inside.txt"), "escaped");

const echoPath = join(tmp, "logs", "echo.log");
const { handleRequest } = createPetServer({ petsRoot, echoPath });
const server = createServer(handleRequest);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const rawRequest = (path) =>
	new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
			res.resume();
			res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
		});
		req.on("error", reject);
		req.end();
	});

const failures = [];
const check = (name, fn) =>
	fn()
		.then(() => console.log(`PASS ${name}`))
		.catch((error) => {
			failures.push(name);
			console.error(`FAIL ${name}: ${error.message}`);
		});

await check("catalog lists the pet", async () => {
	const list = await (await fetch(`${base}/api/pets`)).json();
	assert.deepEqual(list.map((p) => p.id), ["kitty"]);
});

await check("sprite bytes + HEAD has no body", async () => {
	const response = await fetch(`${base}/api/pets/kitty/spritesheet`);
	assert.equal(response.status, 200);
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), spriteBytes);
	const head = await fetch(`${base}/api/pets/kitty/spritesheet`, { method: "HEAD" });
	assert.equal(head.status, 200);
	assert.equal((await head.arrayBuffer()).byteLength, 0);
});

await check("asset traversal is rejected", async () => {
	// Send raw request paths with node:http — WHATWG fetch normalizes
	// percent-encoded dot segments before the server ever sees them.
	const dotDot = await rawRequest("/api/pets/kitty/assets/%2e%2e/secret.txt");
	assert.ok([403, 404].includes(dotDot.status), `dot-dot path must be rejected, got ${dotDot.status}`);
	// Backslash traversal survives URL parsing as %5c and is decoded by the
	// handler into `..\`, which must hit the containment check.
	const backslash = await rawRequest("/api/pets/kitty/assets/%5c..%5csecret.txt");
	assert.equal(backslash.status, 403);
});

await check("malformed URI is a 400, not a crash", async () => {
	const response = await fetch(`${base}/api/pets/%ZZ`);
	assert.equal(response.status, 400);
});

await check("echo writes small bodies", async () => {
	const response = await fetch(`${base}/api/pets/echo`, {
		method: "POST",
		body: JSON.stringify({ event: "hello" }),
	});
	assert.equal(response.status, 200);
	assert.match(readFileSync(echoPath, "utf8"), /"hello"/);
});

await check("echo rejects oversized bodies", async () => {
	const before = readFileSync(echoPath, "utf8");
	const response = await fetch(`${base}/api/pets/echo`, {
		method: "POST",
		body: "x".repeat(70 * 1024),
	});
	assert.equal(response.status, 413);
	assert.equal(readFileSync(echoPath, "utf8"), before);
});

await check("directory junction cannot escape the pet folder", async () => {
	let linked = false;
	try {
		symlinkSync(secretDir, join(petDir, "leak"), "junction");
		linked = true;
	} catch (error) {
		console.log(`SKIP junction test (${error.code ?? error.message})`);
	}
	if (!linked) return;
	const response = await fetch(`${base}/api/pets/kitty/assets/leak/inside.txt`);
	assert.equal(response.status, 403);
});

server.close();
rmSync(tmp, { recursive: true, force: true });
if (failures.length > 0) {
	console.error(`${failures.length} test(s) failed`);
	process.exitCode = 1;
} else {
	console.log("PET-SERVER PASS");
}
