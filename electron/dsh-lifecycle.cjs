"use strict";

const { spawn } = require("node:child_process");
const { existsSync, readdirSync, statSync } = require("node:fs");
const { get } = require("node:http");
const path = require("node:path");

const DEFAULT_PORT = 3080;

function portNumber(value, fallback = DEFAULT_PORT) {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function parseArgs(value, fallback) {
	if (typeof value !== "string" || value.trim().length === 0) return fallback;
	try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && item.length <= 512)) return parsed;
	} catch {
		/* invalid override falls back to the safe argv array */
	}
	return fallback;
}

function resolveDshCommand(env = process.env) {
	if (typeof env.DSH_PET_DSH_COMMAND === "string" && env.DSH_PET_DSH_COMMAND.trim().length > 0) {
		return env.DSH_PET_DSH_COMMAND.trim();
	}
	const executableNames = process.platform === "win32" ? ["dsh.exe", "dsh.cmd", "dsh.bat"] : ["dsh"];
	const candidates = [];
	for (const directory of String(env.PATH ?? "").split(path.delimiter)) {
		if (directory.length === 0) continue;
		for (const name of executableNames) candidates.push(path.join(directory, name));
	}
	if (process.platform === "win32" && typeof env.APPDATA === "string") {
		candidates.push(path.join(env.APPDATA, "npm", "dsh.cmd"));
	}
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	// `npx @deepseek-ai/dsh` installs a stable shim inside npm's exec cache but
	// does not add it to PATH. Reuse the newest already-installed shim without
	// downloading anything; an explicit DSH_PET_DSH_COMMAND still wins.
	if (process.platform === "win32" && typeof env.LOCALAPPDATA === "string") {
		const npxRoot = path.join(env.LOCALAPPDATA, "npm-cache", "_npx");
		try {
			const cached = readdirSync(npxRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => path.join(npxRoot, entry.name, "node_modules", ".bin", "dsh.cmd"))
				.filter((candidate) => existsSync(candidate))
				.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
			if (cached.length > 0) return cached[0];
		} catch {
			/* cache absent/unreadable */
		}
	}
	return "dsh";
}

function resolveDshConfig(env = process.env) {
	const port = portNumber(env.DSH_PET_DSH_PORT);
	const command = resolveDshCommand(env);
	return {
		port,
		origin: `http://127.0.0.1:${port}`,
		probePath: "/api/pets",
		command,
		args: parseArgs(env.DSH_PET_DSH_ARGS, ["web", "--port", String(port)]),
		autostart: env.DSH_PET_DSH_AUTOSTART !== "0",
	};
}

function probeHttp(config, pathname, { getImpl, timeoutMs }) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let request;
		try {
			request = getImpl(
				{
					host: "127.0.0.1",
					port: config.port,
					path: pathname,
					timeout: timeoutMs,
					headers: { accept: "application/json" },
				},
				(response) => {
					response.resume?.();
					finish({ reached: true, statusCode: response.statusCode ?? 0 });
				},
			);
		} catch {
			finish({ reached: false, statusCode: 0 });
			return;
		}
		request.once?.("timeout", () => {
			request.destroy?.();
			finish({ reached: false, statusCode: 0 });
		});
		request.once?.("error", () => finish({ reached: false, statusCode: 0 }));
	});
}

async function probeDsh(config, { getImpl = get, timeoutMs = 1200 } = {}) {
	const bridge = await probeHttp(config, config.probePath, { getImpl, timeoutMs });
	if (bridge.reached && bridge.statusCode === 200) return { running: true, bridge: true };
	// Any HTTP response from the configured loopback port means something is
	// already listening. Do not launch a second DSH merely because the plugin
	// route returned 404/500.
	return { running: bridge.reached, bridge: false };
}

function probeResult(value) {
	if (value === true) return { running: true, bridge: true };
	if (value === false || value === null || value === undefined) return { running: false, bridge: false };
	return { running: value.running === true, bridge: value.bridge === true };
}

function spawnDetachedDsh(config, { spawnImpl = spawn } = {}) {
	return new Promise((resolve, reject) => {
		let child;
		try {
			const isCommandScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(config.command);
			const command = isCommandScript ? process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe" : config.command;
			const args = isCommandScript ? ["/d", "/s", "/c", config.command, ...config.args] : config.args;
			child = spawnImpl(command, args, {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
		} catch (error) {
			reject(error);
			return;
		}
		child.unref?.();
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			fn(value);
		};
		child.once?.("error", (error) => finish(reject, error));
		child.once?.("spawn", () => finish(resolve, { pid: child.pid ?? null }));
		// Small injected test doubles may not implement EventEmitter. Production
		// ChildProcess always does, so resolving here is only for those doubles.
		if (typeof child.once !== "function") finish(resolve, { pid: child.pid ?? null });
	});
}

function createDshLifecycle({
	config = resolveDshConfig(),
	probe = () => probeDsh(config),
	launch = () => spawnDetachedDsh(config),
	onStatus = () => {},
	now = () => Date.now(),
	delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	setTimer = setTimeout,
	clearTimer = clearTimeout,
	monitorMs = 2500,
	offlineRetryMs = 10000,
	launchCooldownMs = 30000,
	readinessMs = 20000,
} = {}) {
	let active = false;
	let timer = null;
	let ensurePromise = null;
	let online = false;
	let lastLaunchAt = Number.NEGATIVE_INFINITY;
	let everLaunched = false;
	let status = {
		phase: "idle",
		online: false,
		running: false,
		origin: config.origin,
		port: config.port,
		launched: false,
		reused: false,
		message: "DSH 尚未连接",
	};

	const publish = (next) => {
		status = { ...status, ...next, origin: config.origin, port: config.port };
		try {
			onStatus({ ...status });
		} catch {
			/* observers must never break lifecycle management */
		}
	};
	const schedule = (ms) => {
		if (!active) return;
		if (timer !== null) clearTimer(timer);
		timer = setTimer(() => {
			timer = null;
			ensureAvailable().catch(() => {});
		}, ms);
		timer.unref?.();
	};

	const run = async () => {
		publish({ phase: online ? "checking" : "probing", message: online ? "正在确认 DSH 连接" : "正在探测 DSH" });
		const firstProbe = probeResult(await probe());
		if (firstProbe.bridge) {
			online = true;
			publish({
				phase: "online",
				online: true,
				running: true,
				launched: everLaunched,
				reused: !everLaunched,
				message: "DSH 已连接",
			});
			schedule(monitorMs);
			return true;
		}
		if (firstProbe.running) {
			online = false;
			publish({
				phase: "plugin-missing",
				online: false,
				running: true,
				reused: true,
				message: "DSH 已运行，但未加载 dsh-pet 插件",
			});
			schedule(offlineRetryMs);
			return false;
		}

		online = false;
		const canLaunch = config.autostart && now() - lastLaunchAt >= launchCooldownMs;
		if (!canLaunch) {
			publish({ phase: "offline", online: false, running: false, message: config.autostart ? "DSH 暂时不可用，稍后重连" : "DSH 未连接（自动启动已关闭）" });
			schedule(offlineRetryMs);
			return false;
		}

		// Probe has just failed and only one ensure call can be active, so this is
		// the single launch point. The detached child is deliberately never stored
		// or terminated: closing/crashing the pet cannot stop DSH.
		lastLaunchAt = now();
		publish({ phase: "starting", online: false, running: false, message: "正在启动 DSH" });
		try {
			await launch();
			everLaunched = true;
		} catch (error) {
			publish({
				phase: "offline",
				online: false,
				running: false,
				message: `无法启动 DSH：${String(error?.message ?? error).slice(0, 220)}`,
			});
			schedule(offlineRetryMs);
			return false;
		}

		const deadline = now() + readinessMs;
		let backoff = 500;
		while (active && now() < deadline) {
			await delay(backoff);
			if (!active) return false;
			const readiness = probeResult(await probe());
			if (readiness.bridge) {
				online = true;
				publish({ phase: "online", online: true, running: true, launched: true, reused: false, message: "DSH 已启动并连接" });
				schedule(monitorMs);
				return true;
			}
			backoff = Math.min(Math.round(backoff * 1.7), 4000);
		}
		const finalProbe = probeResult(await probe());
		publish(finalProbe.running
			? { phase: "plugin-missing", online: false, running: true, launched: true, message: "DSH 已启动，但 dsh-pet 插件尚未就绪" }
			: { phase: "offline", online: false, running: false, launched: true, message: "DSH 启动后尚未就绪，稍后重连" });
		schedule(offlineRetryMs);
		return false;
	};

	function ensureAvailable() {
		if (!active) return Promise.resolve(false);
		if (ensurePromise !== null) return ensurePromise;
		ensurePromise = run().finally(() => {
			ensurePromise = null;
		});
		return ensurePromise;
	}

	const start = () => {
		if (active) return;
		active = true;
		ensureAvailable().catch(() => {});
	};
	const stop = () => {
		active = false;
		if (timer !== null) clearTimer(timer);
		timer = null;
		// Intentionally no child-process handle and no kill call.
	};
	const getStatus = () => ({ ...status });

	return { start, stop, ensureAvailable, getStatus };
}

module.exports = {
	DEFAULT_PORT,
	createDshLifecycle,
	probeDsh,
	resolveDshConfig,
	resolveDshCommand,
	spawnDetachedDsh,
};
