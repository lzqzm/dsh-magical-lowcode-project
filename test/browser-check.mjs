#!/usr/bin/env node
/**
 * dsh-magical-lowcode-project 客户端半边的**浏览器真机检查**。
 *
 * 前面的三道校验各自有盲区：
 *   - verify.mjs        只检查源码树的字节长什么样
 *   - smoke.mjs         只覆盖 host 半边（真实 cordis 应用内）
 *   - installed-check   只检查已安装副本的导入图与 exports 映射
 * 没有一道能回答「客户端半边在浏览器里 apply 成功了吗」。这个脚本补上：
 * 用一个 headless Chromium 打开真实的 DSH Web 界面，然后断言
 *   (1) window.__DSH_BOOT__ 里确实有本插件的 boot 行（combo URL + rev）
 *   (2) 侧边栏底部出现了本插件注册的按钮（title="低代码工程模式"）
 *       —— 这一条直接证明 client 的 apply() 跑到了 slots.inject + slots.register 并成功
 *   (3) 页面没有抛异常，且没有一条 console error 提到本插件
 *
 * 用法：
 *   node test/browser-check.mjs "<带 token 的 GUI URL>"
 *   node test/browser-check.mjs "http://127.0.0.1:39311/?token=…" --timeout 60000
 *   node test/browser-check.mjs "<url>" --cdp http://127.0.0.1:9223   # 复用已开的浏览器
 *
 * 说明：
 *   - 自动探测 Chrome / Edge；用 stdio:"ignore" + detached 起进程，不碰管道
 *     （DSH 沙箱下 node 的 child_process 管道 stdio 会 EPERM）。
 *   - 需要 Node 22+（用到内建全局 WebSocket 与 fetch），与插件 engines.node 一致。
 *
 * ⚠️ **这个脚本的 CDP 交互路径尚未在开发机上跑通过**：本机的 DSH 沙箱
 * **拒绝启动浏览器进程**（`Start-Process chrome --version` → `Access is denied`，
 * crashpad 也报 `OpenProcess: 拒绝访问 (0x5)`），所以只实测了它的
 * 「连不上调试端口 → 打印报告 → exit 1」这条错误路径。
 * 请在能起 Chromium 的机器上运行，或把它接进带浏览器的 CI。
 * 它要断言的第三件事（侧边栏出现 title="低代码工程模式" 的按钮）是唯一能证明
 * client 的 `apply()` 真的执行过的检查 —— 别的三道校验都覆盖不到这一点。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ------------------------------------------------------------------ 参数解析 */

const argv = process.argv.slice(2);
const url = argv.find((item) => !item.startsWith("--") && item.includes("://"));
const flag = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const TIMEOUT_MS = Number(flag("timeout", "60000"));
const CDP_REUSE = flag("cdp", undefined);
const CHROME_FLAG = flag("chrome", undefined);

if (url === undefined) {
	console.error('用法：node test/browser-check.mjs "<带 token 的 GUI URL>" [--timeout 60000] [--cdp http://127.0.0.1:9223] [--chrome <path>]');
	process.exit(2);
}

const failures = [];
const passes = [];
const infos = [];
const fail = (message) => failures.push(message);
const pass = (message) => passes.push(message);
const info = (message) => infos.push(message);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------ 找到浏览器 */

const CANDIDATES = [
	CHROME_FLAG,
	`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
	`${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
	`${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
	`${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
	`${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((value) => typeof value === "string" && value.length > 0);

const browserPath = CANDIDATES.find((candidate) => existsSync(candidate));
if (browserPath === undefined) {
	console.error("找不到 Chrome / Edge，请用 --chrome <path> 指定。已尝试：");
	for (const candidate of CANDIDATES) console.error("  " + candidate);
	process.exit(2);
}

/* ------------------------------------------------------------ 起浏览器（或复用） */

const CDP_PORT = Number(flag("port", "9223"));
let child;
let profileDir;

if (CDP_REUSE === undefined) {
	profileDir = mkdtempSync(join(tmpdir(), "dsh-browser-check-"));
	child = spawn(
		browserPath,
		[
			"--headless=new",
			`--remote-debugging-port=${CDP_PORT}`,
			`--user-data-dir=${profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-gpu",
			"--disable-extensions",
			"--disable-background-networking",
			"--window-size=1440,900",
			url,
		],
		{ stdio: "ignore", detached: true },
	);
	child.unref();
}

const cdpBase = CDP_REUSE ?? `http://127.0.0.1:${CDP_PORT}`;

function cleanup() {
	if (child !== undefined) {
		try {
			child.kill();
		} catch {
			/* 已经退出 */
		}
	}
	if (profileDir !== undefined) {
		try {
			rmSync(profileDir, { recursive: true, force: true });
		} catch {
			/* 文件被占用就留给系统清理 */
		}
	}
}

/* ------------------------------------------------------------ 等 CDP 就绪并拿页面目标 */

async function waitForPageTarget() {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${cdpBase}/json/list`);
			if (response.ok) {
				const targets = await response.json();
				const page = targets.find((target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string");
				if (page !== undefined) return page;
			}
		} catch {
			/* 还没起来 */
		}
		await sleep(400);
	}
	return undefined;
}

/* ------------------------------------------------------------------ CDP 客户端 */

class Cdp {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		this.listeners = [];
		socket.addEventListener("message", (event) => {
			let message;
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}
			if (message.id !== undefined && this.pending.has(message.id)) {
				const { resolve } = this.pending.get(message.id);
				this.pending.delete(message.id);
				resolve(message);
				return;
			}
			for (const listener of this.listeners) listener(message);
		});
	}

	send(method, params = {}) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`CDP 超时：${method}`));
				}
			}, 30000);
		});
	}

	onEvent(listener) {
		this.listeners.push(listener);
	}

	async evaluate(expression) {
		const response = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (response.result?.exceptionDetails !== undefined) return { error: response.result.exceptionDetails.text };
		return { value: response.result?.result?.value };
	}
}

/* ------------------------------------------------------------------------ 主流程 */

let exitCode = 0;
try {
	const page = await waitForPageTarget();
	if (page === undefined) {
		fail(`等不到可调试的页面目标（${cdpBase}/json/list，超时 ${TIMEOUT_MS}ms）`);
		throw new Error("no-page-target");
	}
	pass(`已连上 headless Chromium 的页面目标：${page.url}`);

	const socket = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
	});

	const cdp = new Cdp(socket);
	const exceptions = [];
	const consoleErrors = [];
	cdp.onEvent((message) => {
		if (message.method === "Runtime.exceptionThrown") {
			const details = message.params?.exceptionDetails;
			exceptions.push(details?.exception?.description ?? details?.text ?? "unknown exception");
		}
		if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
			consoleErrors.push((message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" "));
		}
	});

	await cdp.send("Runtime.enable");
	await cdp.send("Page.enable");

	// 等应用起来：轮询侧边栏按钮，最多到超时。
	const markerSelector = '[title="低代码工程模式"]';
	const deadline = Date.now() + TIMEOUT_MS;
	let markerFound = false;
	let bootRow = undefined;
	let evaluated = false;

	while (Date.now() < deadline) {
		const probe = await cdp.evaluate(`(() => {
			const boot = globalThis.__DSH_BOOT__;
			let row;
			if (boot !== undefined && boot !== null) {
				const rows = Array.isArray(boot) ? boot : (Array.isArray(boot.entries) ? boot.entries : []);
				row = rows.find((entry) => entry !== null && entry !== undefined && entry.id === "dsh-magical-lowcode-project");
			}
			return {
				marker: document.querySelector(${JSON.stringify(markerSelector)}) !== null,
				row: row === undefined ? null : { id: row.id, url: row.url, rev: row.rev },
				ready: document.readyState,
			};
		})()`);
		if (probe.error !== undefined) {
			if (!evaluated) info(`首次求值失败（可能是页面还在导航）：${probe.error}`);
			evaluated = true;
		} else if (probe.value !== undefined) {
			evaluated = true;
			if (probe.value.row !== null && probe.value.row !== undefined) bootRow = probe.value.row;
			if (probe.value.marker === true) {
				markerFound = true;
				break;
			}
		}
		await sleep(1000);
	}

	if (!evaluated) fail("整个等待期内都无法在页面里求值（Runtime 没建立起来）");

	if (bootRow === undefined) fail("window.__DSH_BOOT__ 里找不到本插件的 boot 行");
	else pass(`boot graph 含本插件行：${JSON.stringify(bootRow)}`);

	if (!markerFound) {
		fail(`页面上找不到侧边栏按钮 ${markerSelector} —— 客户端 apply() 可能没跑成功，或 slots.register 被拒`);
	} else {
		pass(`侧边栏出现了本插件注册的按钮（${markerSelector}），证明 client 的 apply() 已执行且 slot 注册成功`);
	}

	// 设置页里的 section 需要用户打开设置面板才会渲染，这里只做存在性提示。
	const sectionProbe = await cdp.evaluate(`document.body.innerText.includes("低代码工程模式")`);
	if (sectionProbe.value === true) pass("页面文本里已经能看到「低代码工程模式」（设置入口已渲染）");
	else info("设置区入口未渲染（正常：settings.section 要打开设置面板才挂载）");

	const ours = [...exceptions, ...consoleErrors].filter((text) => /dsh-magical-lowcode-project|desktopProject/.test(String(text)));
	if (ours.length > 0) {
		fail(`有 ${ours.length} 条与本插件相关的运行时错误：`);
		for (const text of ours.slice(0, 5)) failures.push("      " + String(text).slice(0, 300));
	} else {
		pass("没有与本插件相关的运行时异常或 console error");
	}
	if (exceptions.length > 0) info(`页面共 ${exceptions.length} 条未捕获异常（不涉及本插件）`);
	if (consoleErrors.length > 0) info(`页面共 ${consoleErrors.length} 条 console error（不涉及本插件）`);

	socket.close();
} catch (error) {
	if (error?.message !== "no-page-target") fail(`执行失败：${error?.message ?? String(error)}`);
	exitCode = 1;
} finally {
	cleanup();
}

/* ------------------------------------------------------------------------ 输出 */

const line = "-".repeat(72);
console.log(line);
console.log("dsh-magical-lowcode-project 客户端半边 · 浏览器真机检查");
console.log(`页面：${url}`);
console.log(line);
for (const item of passes) console.log(`  ok    ${item}`);
for (const item of infos) console.log(`  info  ${item}`);
for (const item of failures) console.log(`  FAIL  ${item}`);
console.log(line);
console.log(`通过 ${passes.length} · 失败 ${failures.length}`);
process.exit(failures.length > 0 ? 1 : exitCode);
