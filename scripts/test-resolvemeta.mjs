import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const baseUrl = "file:///C:/Users/Yilun/.dsh/profiles/web/";
const require = createRequire(baseUrl);
const resolvePkgJson = (spec) => require.resolve(`${spec}/package.json`);

function parseDshClient(pkgName, value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
	const decl = value;
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	return { platform: decl.platform };
}

function clientExportOf(pkgName, exportsField) {
	if (typeof exportsField !== "object" || exportsField === null) return void 0;
	const client = exportsField["./client"];
	if (client === void 0) return void 0;
	if (typeof client === "string") return client;
	if (typeof client === "object" && client !== null) {
		const fallback = client.default;
		if (typeof fallback === "string") return fallback;
	}
	throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`);
}

for (const name of ["dsh-pet", "dsh-pet-live", "dsh-pet-live2", "dsh-pet-live3", "dsh-pet-live4"]) {
	try {
		const pkgPath = resolvePkgJson(name);
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		const decl = parseDshClient(name, pkg?.dsh !== null && typeof pkg?.dsh === "object" ? pkg.dsh.client : void 0);
		const clientRel = clientExportOf(name, pkg.exports);
		const clientPath = join(dirname(pkgPath), clientRel);
		console.log(name, "->", pkgPath, "| decl:", JSON.stringify(decl), "| client:", clientPath);
	} catch (err) {
		console.log(name, "ERROR:", err.message);
	}
}
