/**
 * dsh-project-panel — host 半边：工程面板的数据面。
 *
 * 提供 `desktopProject/*` RPC，走 DSH connection 的认证 Fetch 路由
 * （`connection.fetch.register`，与 /api/agent-preset.export 同机制）：
 *   POST /api/desktopProject/<method>
 * 请求体是 shell 的 client-request 信封：
 *   { type: "client-request", rpcId, method: "desktopProject/<method>", payload: { args: {...} } }
 * 响应体统一为 { ok: true, value } 或 { ok: false, error: { code, message, detail } }。
 *
 * 两条硬约束（都是踩过的坑）：
 *   1. **不 import 任何 @deepseek-ai/***：本插件以 link: 方式装进 profile，
 *      Node 会从插件的真实路径（D:\...\dsh-project-panel\lib\）向上解析，
 *      够不到 profile/node_modules；顶层 import 失败会把整个 profile 打挂。
 *      上游原版用 TypertRemoteService 注册 RPC，而 connection.fetch.register
 *      能直接注册 HTTP 路由，等价且无依赖。
 *   2. **零第三方依赖**：link: 安装不装传递依赖，fflate / yaml 之类一律不用。
 *      因此这里只做文件树 + 读 + 写；zip 预设包那套（.dshpreset）不在此列。
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsh-project-panel";

/** 等这两个服务：workspaceRegistry 给出工作区边界，connection 提供 Fetch 路由挂载点。 */
export const inject = ["workspaceRegistry", "connection"];

const NAMESPACE = "desktopProject";
const ROUTE_PREFIX = "/api/" + NAMESPACE + "/";
const MAX_ENTRIES = 1000;
const MAX_READ_BYTES = 2 * 1024 * 1024;

/*
	推送状态账本：pages / apis / databases 三个区里，带 page.json（取 uuid）
	或 meta.json（取 id）的目录算一个「可推送单元」，把该目录下所有文件的
	mtime 拍成快照存起来；下次扫描比对，全等 = 已推送，任一不同 = 待推送。
	首次见到的单元直接登记为已推送 —— 否则第一天满屏红点，没法用。
	账本落在 DSH_HOME 下，dev / stable 两个实例互不干扰。
*/
const DSH_HOME_DIR = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
const PUSH_STATE_FILE = join(DSH_HOME_DIR, "project-push-state.json");
/*
	插件自己维护的配置：服务器档案（地址 / 账号 / 密码）+ 每个工作区绑哪个档案、
	默认拉哪个项目。以前这些东西只存在于工作区根的 .env 里 —— 打开一个空文件夹
	就什么也拉不了（没有 .env，更别说脚本）。现在 .env 变成「产物」：真正可编辑的
	那份在 DSH_HOME 下，跑脚本之前自动合并过去。
*/
const CONFIG_FILE = join(DSH_HOME_DIR, "project-config.json");
/** 改写 .env 之前的原件备份放这儿，按时间戳留最近若干份。 */
const ENV_BACKUP_DIR = join(DSH_HOME_DIR, "project-env-backups");
const ENV_BACKUP_KEEP = 10;
/** 插件根目录（package.json 与 node_modules 都在这儿）。 */
const PANEL_ROOT = fileURLToPath(new URL("../", import.meta.url));
/** 插件自带的脚手架模板（source-*.js + utils.js + package.json），铺到空目录用。 */
const SCAFFOLD_SRC = join(PANEL_ROOT, "scaffold");
/** 模板要用的 npm 依赖装在插件自己目录下，只装一次；工作区靠 NODE_PATH 复用。 */
const SCAFFOLD_MODULES = join(PANEL_ROOT, "node_modules");
/** 铺到工作区的只有这些（外加 source-*.js）；node_modules / package-lock 之类一律不复制。 */
const SCAFFOLD_FILES = ["utils.js", "package.json"];
/* rc.6 时代的位置，只在首次读取时迁一次；写入永远走新位置。 */
const PUSH_STATE_FILE_LEGACY = resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh-desktop-push-state.json");
const PUSH_ZONES = new Set(["pages", "apis", "databases"]);
const PUSH_SCAN_MAX_DEPTH = 12;
const PUSH_FIND_MAX_DEPTH = 4;
/** 扫区时这些目录一律跳过：太大，而且里面不可能有推送单元。 */
const PUSH_SKIP_DIRS = new Set(["node_modules", "release", "dist", ".git"]);
/** L1 项目目录名：纯 32 位 uuid，或者「名称（uuid）」（全角括号）。 */
const L1_PROJECT_NAME_RE = /^([0-9a-f]{32}|.+?（[0-9a-f]{32}）)$/i;

/* lint：同一类问题报几条就够定位了，全列出来只会把真正该修的那条挤下去。 */
const BARE_MUSTACHE_MAX = 5;
const NUMBER_STRICT_MAX = 3;

/* 模糊搜索：命中上限、递归深度、跳过的重目录。 */
const MAX_SEARCH_HITS = 200;
const SEARCH_MAX_DEPTH = 12;
/** 搜索是给人找文件的，不是给打包器找依赖的 —— 这些目录不跳会卡死。 */
const SEARCH_SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"release",
	"out",
	"coverage",
	"target",
	"__pycache__",
	".venv",
	"venv",
	".next",
	".nuxt",
	".cache"
]);

/* 内容搜索（grep）：命中 / 文件 / 单文件大小 / 单行展示长度的上限。 */
const MAX_GREP_HITS = 400;
/** 文件数上限：撞上就提前收工，宁可结果不全也不能把面板卡死。 */
const MAX_GREP_FILES = 3000;
/** 单个文件超过这个大小直接跳过（压缩过的 bundle、日志之类）。 */
const MAX_GREP_FILE_BYTES = 512 * 1024;
const MAX_GREP_LINE_CHARS = 200;
/** 只嗅前 8KB 判断是不是二进制，整块扫太贵。 */
const BINARY_SNIFF_BYTES = 8192;

/* ------------------------------------------------- 工作区边界校验 */

const PATH_CASE_INSENSITIVE = process.platform === "win32";

/** 两侧统一分隔符与（win32 上的）大小写后再比较，避免正反斜杠混用误报越界。 */
function normalizeForCompare(value) {
	const unified = String(value).replace(/[\\/]+/g, sep).replace(/[\\/]+$/, "");
	return PATH_CASE_INSENSITIVE ? unified.toLowerCase() : unified;
}

class PanelError extends Error {
	constructor(code, message, detail) {
		super(message);
		this.name = "PanelError";
		this.code = code;
		this.detail = detail;
	}
}

/** cordis 的 ctx 既能属性直取也能 ctx.get()，两种都试一遍。 */
function serviceOf(ctx, key) {
	try {
		if (typeof ctx.get === "function") {
			const direct = ctx.get(key);
			if (direct !== undefined && direct !== null) return direct;
		}
	} catch { /* 落到属性访问 */ }
	try {
		const viaProxy = ctx[key];
		if (viaProxy !== undefined && viaProxy !== null) return viaProxy;
	} catch { /* 服务缺席 */ }
	return undefined;
}

function workspacesOf(ctx) {
	const registry = serviceOf(ctx, "workspaceRegistry");
	if (registry === undefined || typeof registry.list !== "function") return [];
	try {
		const list = registry.list();
		return Array.isArray(list) ? list : [];
	} catch {
		return [];
	}
}

/** 路径必须落在某个已注册工作区内；返回命中的 workspace 实体。 */
function ownerOf(ctx, resolved, endpoint) {
	const target = normalizeForCompare(resolved);
	for (const workspace of workspacesOf(ctx)) {
		if (workspace === null || typeof workspace !== "object") continue;
		const base = normalizeForCompare(workspace.path ?? "");
		if (base !== "" && (target === base || target.startsWith(base + sep))) return workspace;
	}
	throw new PanelError(
		"path-outside-workspace",
		endpoint + " 只允许访问已注册工作区内的路径（当前：" + resolved + "）",
		{ path: resolved }
	);
}

function messageOf(error) {
	if (error instanceof Error && typeof error.message === "string" && error.message !== "") return error.message;
	return String(error);
}

/** fs 错误 → PanelError；已经是 PanelError 的原样抛出。 */
function fsError(error, prefix) {
	if (error instanceof PanelError) return error;
	const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "";
	if (code === "ENOENT" || code === "ENOTDIR") return new PanelError("not-found", "路径不存在：" + messageOf(error), {});
	if (code === "EACCES" || code === "EPERM") return new PanelError("forbidden", "没有访问权限：" + messageOf(error), {});
	return new PanelError("internal", prefix + " 失败：" + messageOf(error), {});
}

function requirePath(args, endpoint) {
	const value = args === null || typeof args !== "object" ? undefined : args.path;
	if (typeof value !== "string" || value.trim() === "") {
		throw new PanelError("bad-request", endpoint + " 缺少参数 path", {});
	}
	return resolve(value);
}

/** 名字里带斜杠就等于偷偷换目录，控制字符则会让树渲染出鬼东西 —— 一律拦掉。 */
const BAD_NAME = /[\\/\u0000-\u001f\u007f]/;

function requireName(args, endpoint) {
	const value = args === null || typeof args !== "object" ? undefined : args.name;
	if (typeof value !== "string") {
		throw new PanelError("bad-request", endpoint + " 缺少参数 name", {});
	}
	const name = value.trim();
	if (name === "" || name === "." || name === "..") {
		throw new PanelError("bad-request", "名字不能为空，也不能是 . 或 ..", { name: value });
	}
	if (name === "CON" || name === "PRN" || name === "AUX" || name === "NUL" || /^(COM|LPT)[1-9]$/i.test(name)) {
		throw new PanelError("bad-request", "这是 Windows 保留设备名：" + name, { name });
	}
	if (BAD_NAME.test(name)) {
		throw new PanelError("bad-request", "名字里不能带斜杠或控制字符", { name: value });
	}
	return name;
}

/** 删除、改名都不许把工作区根自己动掉，否则整个工程就没了。 */
function rejectWorkspaceRoot(ctx, resolved, endpoint) {
	const owner = ownerOf(ctx, resolved, endpoint);
	if (normalizeForCompare(resolved) === normalizeForCompare(owner.path ?? "")) {
		throw new PanelError("path-outside-workspace", endpoint + " 不能作用于工作区根目录", { path: resolved });
	}
	return owner;
}

/** stat 一次；ENOENT 时返回 null 而不是抛错。 */
async function statOrNull(path) {
	try {
		return await stat(path);
	} catch (error) {
		const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "";
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw error;
	}
}

/* ------------------------------------------------- 推送状态账本 */

/* 旧账本只迁一次，避免每回读不到都把整个文件翻一遍。 */
let pushStateMigrated = false;

async function readPushState() {
	try {
		return JSON.parse(await readFile(PUSH_STATE_FILE, "utf8"));
	} catch {
		if (!pushStateMigrated) {
			pushStateMigrated = true;
			try {
				const legacy = JSON.parse(await readFile(PUSH_STATE_FILE_LEGACY, "utf8"));
				await writePushState(legacy);
				return legacy;
			} catch { /* 没有旧账本 */ }
		}
		return {};
	}
}

async function writePushState(state) {
	try {
		await mkdir(dirname(PUSH_STATE_FILE), { recursive: true });
		await writeFile(PUSH_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
	} catch { /* 尽力而为：账本写不进去不该让扫描整个失败 */ }
}

/*
	------------------------------------------------- 插件维护的配置

	结构（都存在 CONFIG_FILE 一个文件里）：

		{
		  version: 1,
		  servers: [ { id, label, serverUrl, username, password, env } ],
		  workspaces: { "<归一化后的工作区根>": { serverId, projectUuid } },
		  scaffold: { depsAt: 0 }
		}

	**密码是明文的**，和它要写进去的那份 .env 一个级别（都在本机 DSH_HOME 下）。
	对外一律只发 publicServer()（抹掉 password，只留 hasPassword）—— 面板没有
	任何地方需要把密码读回来，能不出 host 就不出。
*/

/**
 * 项目清单（面板里手动维护的）捋成可信形状：uuid 非空、按 uuid 去重、名字抹平换行。
 *
 * 为什么要有这份清单：候选项目原先只从 `.env` 的注释里捡，可**新铺出来的 `.env`
 * 一条注释都没有**，于是「空目录要去服务器上拉项目」卡在第一步 —— 下拉里没东西可选，
 * 脚本也就没得拉。
 */
function cleanProjects(input) {
	const out = [];
	const seen = new Set();
	for (const item of Array.isArray(input) ? input : []) {
		if (item === null || typeof item !== "object") continue;
		const uuid = envValue(item.uuid ?? "");
		if (uuid === "" || seen.has(uuid)) continue;
		seen.add(uuid);
		out.push({ uuid, name: envValue(item.name ?? "") });
	}
	return out;
}

/** 服务器档案里除密码外的字段，纯函数，随时可以重算。 */
function publicServer(server) {
	const url = typeof server.serverUrl === "string" ? server.serverUrl : "";
	const remote = isRemoteUrl(url);
	return {
		id: server.id,
		label: typeof server.label === "string" ? server.label : "",
		serverUrl: url,
		username: typeof server.username === "string" ? server.username : "",
		hasPassword: typeof server.password === "string" && server.password !== "",
		env: typeof server.env === "string" ? server.env : "",
		remote,
		targetLabel: labelOfUrl(url),
		projects: cleanProjects(server.projects)
	};
}

/** 工作区在配置里的键：大小写与斜杠归一化过，跟账本用的是同一套。 */
function workspaceKey(root) {
	return normalizeForCompare(resolve(root));
}

function newServerId() {
	return "srv-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

/** 把磁盘上读来的东西捋成可信形状：字段全、类型对，多余的丢掉。 */
function normalizeConfig(raw) {
	const source = raw !== null && typeof raw === "object" ? raw : {};
	const servers = [];
	for (const item of Array.isArray(source.servers) ? source.servers : []) {
		if (item === null || typeof item !== "object") continue;
		const id = typeof item.id === "string" && item.id !== "" ? item.id : "";
		if (id === "") continue;
		servers.push({
			id,
			label: typeof item.label === "string" ? item.label : "",
			serverUrl: typeof item.serverUrl === "string" ? item.serverUrl.trim() : "",
			username: typeof item.username === "string" ? item.username : "",
			password: typeof item.password === "string" ? item.password : "",
			env: typeof item.env === "string" ? item.env : "",
			projects: cleanProjects(item.projects)
		});
	}
	const workspaces = {};
	const rawWorkspaces = source.workspaces !== null && typeof source.workspaces === "object" ? source.workspaces : {};
	for (const key of Object.keys(rawWorkspaces)) {
		const item = rawWorkspaces[key];
		if (item === null || typeof item !== "object") continue;
		workspaces[key] = {
			serverId: typeof item.serverId === "string" ? item.serverId : "",
			projectUuid: typeof item.projectUuid === "string" ? item.projectUuid.trim() : ""
		};
	}
	const rawScaffold = source.scaffold !== null && typeof source.scaffold === "object" ? Number(source.scaffold.depsAt) : 0;
	return {
		version: 1,
		servers,
		workspaces,
		scaffold: { depsAt: Number.isFinite(rawScaffold) && rawScaffold > 0 ? rawScaffold : 0 }
	};
}

async function readConfig() {
	try {
		return normalizeConfig(JSON.parse(await readFile(CONFIG_FILE, "utf8")));
	} catch {
		return normalizeConfig(null);
	}
}

async function writeConfig(config) {
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

/** 改配置的统一入口：读 → 改 → 写。 */
async function updateConfig(mutate) {
	const config = await readConfig();
	const result = await mutate(config);
	await writeConfig(config);
	return result;
}

/**
 * 把一段配置合并进 .env 文本。
 *
 * 规则：`KEY=value` 的生效行就地替换；注释行**一行都不动** —— 平台把十个项目
 * uuid、几个服务器地址都注释着堆在同一份文件里，那是值钱的东西，覆盖掉就没了。
 * 键在文件里只有注释版本（或压根没有）时，在末尾追加一行生效的。
 */
function mergeEnvText(text, patch) {
	const lines = String(text ?? "").split(/\r?\n/);
	const written = [];
	const missing = new Set(Object.keys(patch));
	for (let i = 0; i < lines.length; i += 1) {
		const assign = ENV_ASSIGN_RE.exec(lines[i]);
		if (assign === null || assign[1] !== undefined) continue;
		const key = assign[2];
		if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
		missing.delete(key);
		/* 已经就是这个值 —— 别动那一行，也别把它算进 written（written 是「真改了什么」）。 */
		if (lines[i] === key + "=" + patch[key]) continue;
		lines[i] = key + "=" + patch[key];
		written.push(key);
	}
	/* 文件末尾的空行先去掉，免得追加的行和上文隔着一个空行。 */
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	for (const key of Object.keys(patch)) {
		if (!missing.has(key)) continue;
		lines.push(key + "=" + patch[key]);
		written.push(key);
	}
	return { text: lines.join("\n") + "\n", written };
}

/** 写入前留一份原件；只留最近 ENV_BACKUP_KEEP 份。返回备份文件名，失败给空串。 */
async function backupEnvFile(root) {
	try {
		await mkdir(ENV_BACKUP_DIR, { recursive: true });
		const prefix = basename(root) + "-";
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const name = prefix + stamp + ".env";
		await copyFile(join(root, ".env"), join(ENV_BACKUP_DIR, name));
		const olds = [];
		for (const dirent of await readdir(ENV_BACKUP_DIR, { withFileTypes: true })) {
			if (!dirent.isFile() || !dirent.name.startsWith(prefix)) continue;
			const info = await statOrNull(join(ENV_BACKUP_DIR, dirent.name));
			olds.push({ name: dirent.name, at: info === null ? 0 : info.mtimeMs });
		}
		olds.sort((left, right) => right.at - left.at);
		for (const old of olds.slice(ENV_BACKUP_KEEP)) {
			await rm(join(ENV_BACKUP_DIR, old.name), { force: true }).catch(() => {});
		}
		return name;
	} catch {
		/* 备份失败不该拦住写 .env，但要把「没备份成」如实告诉调用方。 */
		return "";
	}
}

/**
 * 把面板里存的档案写进工作区的 .env。
 *
 * 脚本只认 .env 与 process.env，别的它看不见 —— 配置存在 DSH_HOME 下，
 * 跑之前必须落到工作上。注释行一行不动（平台把项目 uuid、备选地址都注释着
 * 堆在同一份文件里，覆盖掉就没了），有原件先备份。
 *
 * serverId / projectUuid 给空串就用工作区已绑定的；没绑定返回 null（不动磁盘）。
 */
async function applyConfigToEnv(root, serverId, projectUuid) {
	const config = await readConfig();
	const key = workspaceKey(root);
	const current = config.workspaces[key] === undefined
		? { serverId: "", projectUuid: "" }
		: config.workspaces[key];
	const wantedId = typeof serverId === "string" && serverId !== "" ? serverId : current.serverId;
	const wantedUuid = typeof projectUuid === "string" && projectUuid !== "" ? projectUuid : current.projectUuid;
	if (wantedId === "") return null;
	const server = config.servers.find((item) => item.id === wantedId);
	if (server === undefined) return null;
	const patch = {
		SERVER_URL: envValue(server.serverUrl),
		USERNAME: envValue(server.username),
		PASSWORD: secretValue(server.password)
	};
	if (server.env !== "") patch.ENV = envValue(server.env);
	if (wantedUuid !== "") patch.PROJECT_UUID = wantedUuid;
	const file = join(root, ".env");
	const before = await readOpt(file);
	const merged = mergeEnvText(before === null ? "" : before, patch);
	let backup = "";
	/*
		内容没变化就别动它。每跑一次脚本都拷一份一模一样的备份的话，10 份的上限很快被
		这种垃圾挤满 —— 真出事那天想找的那一份早被顶掉了。
		判据看的是**整份文本**，不是 written：file 末尾多余的空行也会被规范化，
		那种情况下 written 是空的、文本却真的变了。
	*/
	const needsWrite = before === null || merged.text !== before;
	if (needsWrite) {
		backup = before === null ? "" : await backupEnvFile(root);
		try {
			await writeFile(file, merged.text, "utf8");
		} catch (error) {
			throw fsError(error, "projectApplyConfig");
		}
	}
	if (current.serverId !== server.id || current.projectUuid !== wantedUuid) {
		await updateConfig((draft) => {
			draft.workspaces[key] = { serverId: server.id, projectUuid: wantedUuid };
		});
	}
	return { path: file, created: before === null, backup, written: merged.written, unchanged: needsWrite !== true, server, projectUuid: wantedUuid };
}

/** 值里的换行会把 .env 撕成两行，写之前拍平。 */
function envValue(value) {
	return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

/** 密码不做 trim（前后空格可能就是密码的一部分），只把换行摘掉。 */
function secretValue(value) {
	return String(value ?? "").replace(/[\r\n]+/g, "");
}

/* ------------------------------------------------- 自带脚手架 */

/*
	空目录里没有 source-*.js，平台那套拉取脚本根本跑不起来 —— 光把 .env 变成
	「插件可维护」还不够。模板随插件走（scaffold/ 目录），铺到目标工作区。

	npm 依赖不在每个新目录里各装一遍：插件自身 package.json 里声明了
	axios / archiver / form-data / unzipper，装一份就够，跑脚本时用 NODE_PATH
	指过去复用。目标目录若自带 node_modules（平台拉的），那边优先，NODE_PATH 用不上。
*/

/** 插件自己那份 node_modules；没装好给空串。 */
async function scaffoldModules() {
	const info = await statOrNull(SCAFFOLD_MODULES);
	return info !== null && info.isDirectory() ? SCAFFOLD_MODULES : "";
}

/**
 * npm 的入口脚本路径。
 * Windows 上 node 从 20.12 起禁止 shell:false 直接跑 .cmd（CVE-2024-27980），
 * 所以统一用 host 自己的 node 去跑 npm-cli.js，不碰 npm.cmd。
 */
async function npmCli() {
	const home = dirname(process.execPath);
	for (const candidate of [
		join(home, "node_modules", "npm", "bin", "npm-cli.js"),
		join(home, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
		join(home, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
	]) {
		if ((await statOrNull(candidate)) !== null) return candidate;
	}
	return "";
}

/** 装依赖的进度；一次只允许一个。 */
const scaffoldInstall = { busy: false, doneAt: 0, code: null, log: "", error: "" };

function startScaffoldInstall(npm) {
	scaffoldInstall.busy = true;
	scaffoldInstall.code = null;
	scaffoldInstall.log = "";
	scaffoldInstall.error = "";
	const child = spawn(process.execPath, [npm, "install", "--no-audit", "--no-fund"], {
		cwd: PANEL_ROOT,
		shell: false,
		windowsHide: true
	});
	const append = (chunk) => {
		scaffoldInstall.log = (scaffoldInstall.log + chunk).slice(-8000);
	};
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", append);
	child.stderr.on("data", append);
	child.on("error", (error) => {
		scaffoldInstall.busy = false;
		scaffoldInstall.doneAt = Date.now();
		scaffoldInstall.code = -1;
		scaffoldInstall.error = messageOf(error);
	});
	child.on("close", (code) => {
		scaffoldInstall.busy = false;
		scaffoldInstall.doneAt = Date.now();
		scaffoldInstall.code = typeof code === "number" ? code : -1;
	});
	try { child.stdin.end(); } catch { /* 已经退了 */ }
	return typeof child.pid === "number" ? child.pid : 0;
}

/**
 * 把模板实际拷进 root。**不管并发** —— 并发的调用由 scaffoldInto 合成。
 *
 * 只拷两批：`RUN_SCRIPT_RE` 匹配的 `source-*.js`，以及 `SCAFFOLD_FILES`
 * （`utils.js` / `package.json`）。**已存在的文件一律不动** —— 平台拉过的目录里
 * 那几个脚本可能已经比模板新，用户手改过的更不能覆盖。
 */
async function scaffoldCopy(root, endpoint) {
	let dirents;
	try {
		dirents = await readdir(SCAFFOLD_SRC, { withFileTypes: true });
	} catch {
		throw new PanelError("internal", endpoint + " 读不到插件自带的脚手架模板", { path: SCAFFOLD_SRC });
	}
	const copied = [];
	const skipped = [];
	for (const dirent of dirents) {
		if (!dirent.isFile()) continue;
		if (!RUN_SCRIPT_RE.test(dirent.name) && !SCAFFOLD_FILES.includes(dirent.name)) continue;
		const target = join(root, dirent.name);
		if ((await statOrNull(target)) !== null) {
			skipped.push(dirent.name);
			continue;
		}
		try {
			await copyFile(join(SCAFFOLD_SRC, dirent.name), target);
		} catch (error) {
			throw fsError(error, endpoint);
		}
		copied.push(dirent.name);
	}
	const modules = await scaffoldModules();
	return {
		path: root,
		copied,
		skipped,
		modules,
		needDeps: modules === "" && (await statOrNull(join(root, "node_modules"))) === null
	};
}

/*
	同一个根上并发的 projectScaffold 合成一次。

	客户端虽然把「铺脚手架」按钮 disabled 了，但那是下一次渲染才生效的 —— 同一帧里
	连点两下仍可能并发进来。两个 copyFile 抢同一个目标，输的那个在 Windows 上会
	EBUSY / EPERM，用户只看到一句莫名其妙的「铺脚手架失败」，而实际上文件已经铺好了。
*/
const scaffoldRuns = new Map();

async function scaffoldInto(root, endpoint) {
	const key = normalizeForCompare(root);
	const running = scaffoldRuns.get(key);
	if (running !== undefined) return running;
	/* 先把 promise 放进表里再 await —— 中间不能让出控制权，否则第二次调用看不到它。 */
	const task = scaffoldCopy(root, endpoint);
	scaffoldRuns.set(key, task);
	try {
		return await task;
	} finally {
		scaffoldRuns.delete(key);
	}
}

/**
 * 有上限的并发闸门。
 *
 * 扫描和校验全是 await 串行的 fs 调用，一次只放一个请求进 libuv 线程池（默认 4 个
 * 工作线程），线程池大半时间是闲的 —— 真项目上 2200 多个目录、12000 多个文件，
 * 串行跑要五秒以上。包一层就能把线程池喂饱。
 *
 * **不要拿它包住整个递归调用**：父调用握着名额等子调用，名额耗尽就死锁。
 * 只包真正做 I/O 的那一小段，递归本身用 Promise.all 铺开。
 */
function limiter(max) {
	let active = 0;
	const queue = [];
	const pump = () => {
		if (active >= max || queue.length === 0) return;
		active += 1;
		const job = queue.shift();
		Promise.resolve()
			.then(job.run)
			.then(job.resolve, job.reject)
			.finally(() => {
				active -= 1;
				pump();
			});
	};
	return (run) => new Promise((resolve, reject) => {
		queue.push({ run, resolve, reject });
		pump();
	});
}

/** 扫描用的并发上限：16 够喂饱线程池，又不会把文件句柄堆到上限。 */
const SCAN_LIMIT = 16;
const scanSlot = limiter(SCAN_LIMIT);

/**
 * 把一个目录（含子孙）拍成两样东西：
 *  - files：{ 相对路径: mtimeMs }，推送账本比的快照；
 *  - names：这一层**直接子项**的名字集合，给校验用。
 *
 * names 是顺手捞的：这次 readdir 本来就要做，把它留下来，校验就不必再去盲读
 * 「page.css 在不在」这种事 —— 真项目上 2179 个单元各盲读 6 个候选文件、其中大半
 * 不存在，光这些 ENOENT 就要三秒。
 */
async function snapshotOf(dir) {
	const files = {};
	const names = new Set();
	const walk = async (current, rel) => {
		let dirents;
		try {
			dirents = await scanSlot(() => readdir(current, { withFileTypes: true }));
		} catch {
			return;
		}
		const subdirs = [];
		const stats = [];
		for (const dirent of dirents) {
			if (/^(\.|.*\.temp-)/.test(dirent.name)) continue;
			if (rel === "") names.add(dirent.name);
			const abs = join(current, dirent.name);
			const next = rel === "" ? dirent.name : rel + "/" + dirent.name;
			if (dirent.isDirectory()) subdirs.push([abs, next]);
			else if (dirent.isFile()) stats.push([abs, next]);
		}
		await Promise.all(stats.map(async ([abs, next]) => {
			try {
				const info = await scanSlot(() => stat(abs));
				files[next] = Math.round(info.mtimeMs);
			} catch { /* 扫描途中被删了 */ }
		}));
		await Promise.all(subdirs.map(([abs, next]) => walk(abs, next)));
	};
	await walk(dir, "");
	return { files, names };
}

/** 只要快照（账本那几个调用点用）。 */
async function snapshotDir(dir) {
	return (await snapshotOf(dir)).files;
}

/** 比对快照：没记录过就登记为已推送；否则两边文件集合取并集逐个比 mtime。 */
function computePushStatus(state, key, current) {
	const record = state[key];
	if (record === undefined || record === null) {
		state[key] = { files: current };
		return { status: "pushed", changed: true };
	}
	const previous = record.files ?? {};
	const names = new Set([...Object.keys(current), ...Object.keys(previous)]);
	for (const fileName of names) {
		if ((current[fileName] ?? 0) !== (previous[fileName] ?? 0)) return { status: "dirty", changed: false };
	}
	return { status: "pushed", changed: false };
}

/*
	账本键的命名空间：**一个工作区一份**。

	早先键就是 `page:<uuid>` / `api:<id>` —— 服务端的身份，不带工作区。于是同一个项目
	在 A 目录被扫过一次，在 B 目录里新拉一份，键还是同一批：新文件的时间戳跟旧记录对
	不上，一进去就一片橙。用户实测拿三个文件把这事钉死了（见 NOTES「账本按单元 uuid 记，
	不区分工作区」那一节）。

	现在统一加一层工作区前缀。老键里没有 `|`，读出来就是永远命不中的孤儿。
*/
function pushKeyPrefix(root) {
	return normalizeForCompare(root) + "|";
}

/** 读一个目录的推送键：page.json 的 uuid 优先，其次 meta.json 的 id。 */
async function pushKeyOf(dir, prefix) {
	const page = await readJsonIn(dir, "page.json");
	if (page !== null && typeof page.uuid === "string" && page.uuid !== "") {
		return { key: prefix + "page:" + page.uuid, scope: "page", target: page.uuid, name: page.name };
	}
	const meta = await readJsonIn(dir, "meta.json");
	if (meta !== null && typeof meta.id === "string" && meta.id !== "") {
		return { key: prefix + "api:" + meta.id, scope: "api", target: meta.id, name: meta.name };
	}
	return null;
}

/**
 * 这个目录看起来像不像一个页面 / API。
 *
 * 只看文件在不在，**不看 JSON 是否合法** —— 一个坏到 JSON.parse 都过不去的
 * page.json 恰恰是校验最该报的情况，不能因为读不出来就把它当普通目录。
 */
async function hasManifest(dir) {
	if ((await statOrNull(join(dir, "page.json"))) !== null) return true;
	return (await statOrNull(join(dir, "meta.json"))) !== null;
}

async function readJsonIn(dir, file) {
	try {
		return JSON.parse(await readFile(join(dir, file), "utf8"));
	} catch {
		return null;
	}
}

/**
 * 子序列模糊打分：needle 的字符按顺序出现在 haystack 里就算命中，不要求连续。
 *
 * 输入 `dsprjp` 能命中 `dsh-project-panel/lib/client.js`。打分让结果更符合直觉：
 * 连续命中的字符叠加加分、命中越靠前越值钱、整条路径越短越优先 ——
 * 所以搜 `clientjs` 时 `lib/client.js` 会排在 `lib/client.editor.js` 前面。
 * 不命中返回 null。
 */
function fuzzyScore(haystack, needle) {
	let score = 0;
	let at = 0;
	let streak = 0;
	for (const char of needle) {
		const found = haystack.indexOf(char, at);
		if (found === -1) return null;
		/* 紧跟上一次命中的字符（连续片段）额外加分。 */
		streak = found === at ? streak + 1 : 0;
		score += 1 + streak * 2;
		/* 靠前的位置更值钱，位置惩罚分段而不是线性，免得长路径被一刀砍死。 */
		score += Math.max(0, 8 - Math.floor(found / 8));
		at = found + 1;
	}
	/* 越短的路径越可能是用户想要的那个。 */
	score -= Math.floor(haystack.length / 6);
	return score;
}

/**
 * 深度优先遍历工作区，跳过 `SEARCH_SKIP_DIRS` 和符号链接。
 *
 * visit(absPath, relPath, dirent, kind) 返回 false 就**立刻停整棵树** ——
 * 两个调用方（文件名模糊搜索、内容搜索）都靠它实现「命中到上限就收工」。
 * visit 允许是 async；这里统一 await，同步函数也一样能用。
 *
 * relPath 一律用 `/` 分隔（跨平台，client 直接显示），绝对路径交给 join 处理。
 */
async function walkWorkspace(root, visit) {
	const step = async (dir, rel, depth) => {
		if (depth > SEARCH_MAX_DEPTH) return true;
		let dirents;
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch {
			/* 读不动这一层就跳过（权限、竞态删除），不要连累整棵树。 */
			return true;
		}
		dirents.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }));
		for (const dirent of dirents) {
			if (dirent.isSymbolicLink()) continue;
			const isDirectory = dirent.isDirectory();
			const kind = isDirectory ? "directory" : dirent.isFile() ? "file" : void 0;
			if (kind === void 0) continue;
			/* 跳过的目录连自己都不进结果：用户不会想搜到 node_modules 本身。 */
			if (isDirectory && SEARCH_SKIP_DIRS.has(dirent.name)) continue;
			const abs = join(dir, dirent.name);
			const next = rel === "" ? dirent.name : rel + "/" + dirent.name;
			if ((await visit(abs, next, dirent, kind)) === false) return false;
			if (isDirectory === true && (await step(abs, next, depth + 1)) === false) return false;
		}
		return true;
	};
	return step(root, "", 0);
}

/**
 * 在一行里切出适合展示的一段（命中在很靠右时不至于看不见）。
 *
 * 命中列号仍然按真实位置返回，这里只管 `text`。两头被切掉的地方补 `…`。
 */
function clipLine(raw, hitAt) {
	const start = hitAt > 80 ? hitAt - 60 : 0;
	const shown = raw.slice(start, start + MAX_GREP_LINE_CHARS);
	return (start > 0 ? "…" : "") + shown + (start + MAX_GREP_LINE_CHARS < raw.length ? "…" : "");
}

/**
 * 一行是不是「八成是二进制」。
 *
 * 只看前 8KB 里有没有 NUL —— 图片、exe、压缩包一读一个准，而按扩展名列白名单
 * 永远会漏。真扫到 NUL 就整块跳过，免得把乱码当结果喂给用户。
 */
function looksBinary(buffer) {
	return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/* ------------------------------------------------- 推送前静态校验的零件 */

/** 读文本；读不到（不存在 / 目录 / 权限）一律返回 null —— lint 里「文件缺席」不算错误。 */
async function readOpt(file) {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

/** 1 基行号；找不到给 0（和 PanelError.detail 里 0 = 未知同一套约定）。 */
function lineOf(text, needle) {
	if (needle === "" || needle === undefined) return 0;
	const at = text.indexOf(needle);
	if (at === -1) return 0;
	let line = 1;
	for (let index = 0; index < at; index += 1) {
		if (text.charCodeAt(index) === 10) line += 1;
	}
	return line;
}

/**
 * 拿 new Function 让引擎解析一遍，只问「能不能编译」，**不执行**。
 * 少个逗号、少个右括号这类硬错当场现形，而静态分析做不到这么准。
 */
function syntaxErrorOf(text) {
	try {
		/* eslint-disable-next-line no-new-func */
		new Function(text);
		return null;
	} catch (error) {
		return messageOf(error);
	}
}

/**
 * 找出所有带 v-pre 的元素内部区间。
 *
 * v-pre 的语义就是「这段子树不要编译」，里面的 {{}} 本来就该原样显示 ——
 * 原版正则光看有没有 {{}}，加了 v-pre 也照样报「应加 v-pre」，自相矛盾。
 * 这里手工压栈扫标签（host 侧没有 DOM），v-pre 状态沿栈向下继承。
 */
function vPreRanges(html) {
	const ranges = [];
	const stack = [];
	const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
	let match;
	while ((match = tag.exec(html)) !== null) {
		const name = match[2].toLowerCase();
		if (match[1] === "/") {
			for (let index = stack.length - 1; index >= 0; index -= 1) {
				if (stack[index].name !== name) continue;
				const open = stack[index];
				if (open.vpre === true) ranges.push([open.start, match.index]);
				stack.length = index;
				break;
			}
			continue;
		}
		/* 自闭合标签（<br/>、<img/>）不产生子树，也不该压栈。 */
		if (/\/\s*$/.test(match[3])) continue;
		const inherited = stack.length > 0 && stack[stack.length - 1].vpre === true;
		stack.push({
			name,
			start: match.index + match[0].length,
			vpre: inherited || /\bv-pre\b/.test(match[3])
		});
	}
	return ranges;
}

/** 从 `v-for="(item,index) in list"` 里抠出循环变量：(item,index) in list → [item, index]。 */
function forAliases(attrs) {
	const match = /\bv-for\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
	if (match === null) return [];
	const value = match[1] !== undefined ? match[1] : match[2];
	const head = String(value).split(/\bin\b/)[0] ?? "";
	return head
		.replace(/[()]/g, "")
		.split(",")
		.map((part) => part.trim().split(/[\s.]+/)[0])
		.filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
}

/**
 * 插槽声明里的作用域变量：`<template #option="scope">`、`v-slot:default="{ row }"`、
 * 老写法的 `slot-scope="scope"` 都会往子树里带一个只在子树内有效的名字。
 *
 * 组件库的表格和下拉框几乎全靠这个（{{scope.row.xxx}}、{{scope.label}}），
 * 不认它就会把整片模板报成「找不到定义」。
 */
function slotAliases(attrs) {
	const aliases = [];
	const push = (raw) => {
		const value = String(raw ?? "").trim();
		if (value === "") return;
		/* 值可能是 `scope`，也可能是 `{ row, index }` / `{ row: r }` 这样的解构。 */
		const body = value.startsWith("{") ? value.replace(/^\{|\}$/g, "") : value;
		for (const part of body.split(",")) {
			const name = part.trim().replace(/^\.\.\./, "").split(":")[0].trim();
			if (/^[A-Za-z_$][\w$]*$/.test(name)) aliases.push(name);
		}
	};
	const slots = /(?:#|v-slot:)\s*[A-Za-z_$][\w$.-]*\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	let match;
	while ((match = slots.exec(attrs)) !== null) push(match[1] !== undefined ? match[1] : match[2]);
	const legacy = /\bslot-scope\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
	if (legacy !== null) push(legacy[1] !== undefined ? legacy[1] : legacy[2]);
	return aliases;
}

/** 一个元素会往子树里带进去的所有作用域名字。 */
function scopeAliases(attrs) {
	return forAliases(attrs).concat(slotAliases(attrs));
}

/**
 * 所有带 v-for 的元素子树区间 + 该子树里可用的循环变量（含祖先传来的）。
 *
 * 「文本节点有 {{}} 就报错」这条原版规则在真实页面里成片误报：平台设计器生成的
 * 列表页到处是
 *     <div v-for="(item,index) in maintenance"><h3>{{item.deviceName}}</h3></div>
 * 这里的 {{item.deviceName}} 就是标准 Vue 插值，而报错却叫人加 v-pre —— 加了之后
 * 页面上会原样印出 {{item.deviceName}}，等于把功能改坏。所以先问一句
 * 「这个 {{}} 引用的是不是当前作用域里的变量」，是就不报。
 */
function vForScopes(html) {
	const scopes = [];
	const stack = [];
	const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
	let match;
	while ((match = tag.exec(html)) !== null) {
		const name = match[2].toLowerCase();
		if (match[1] === "/") {
			for (let index = stack.length - 1; index >= 0; index -= 1) {
				if (stack[index].name !== name) continue;
				const open = stack[index];
				if (open.aliases.length > 0) scopes.push([open.start, match.index, open.aliases]);
				stack.length = index;
				break;
			}
			continue;
		}
		if (/\/\s*$/.test(match[3])) continue;
		const inherited = stack.length > 0 ? stack[stack.length - 1].aliases : [];
		stack.push({
			name,
			start: match.index + match[0].length,
			aliases: inherited.concat(scopeAliases(match[3]))
		});
	}
	return scopes;
}

/** `{{ … }}` 里最靠左的那个标识符就是它的根对象；取不到返回 ""。 */
function mustacheRoot(expression) {
	const match = /[A-Za-z_$][\w$]*/.exec(String(expression));
	return match === null ? "" : match[0];
}

/* ------------------------------------------------- 推送前静态校验 */

function notAPageOrApi(resolved) {
	return new PanelError(
		"not-a-page-or-api",
		"该目录既不是页面目录（无 page.json）也不是 API 目录（无 meta.json）",
		{ path: resolved }
	);
}

/**
 * 跑一遍某个页面/API 目录的静态校验，返回 { dir, kind, issues }。
 *
 * soft 为 true 时，既没有 page.json 也没有 meta.json 的目录返回 null 而不抛错 —— 全量
 * 扫描会拿工作区里每个推送单元来问一遍，不该因为撞见一个不像页面/API 的目录就整个中断。
 *
 * names 是这一层已经存在的文件名集合（snapshotOf 顺手捞的）。给了它就只读真实存在的
 * 文件：每个单元最多 6 个候选文件，真项目上大半不存在，盲读的 ENOENT 是校验里最贵的
 * 一项。不给（null）就退回盲读，语义不变。
 */
async function lintDir(resolved, soft = false, names = null) {
	/** 只读确实存在的文件；没给 names 就照旧盲读。 */
	const readIn = (name) => (names === null || names.has(name) ? readOpt(join(resolved, name)) : Promise.resolve(null));
	const pageJson = await readIn("page.json");
	const metaJson = await readIn("meta.json");
	if (pageJson === null && metaJson === null) {
		if (soft === true) return null;
		throw notAPageOrApi(resolved);
	}

	/** 页面/CSS 两处都要数花括号，抽出来省得写两遍。 */
	const issues = [];
	const push = (level, file, rule, message, line) => {
		issues.push({
			level,
			file,
			/* 绝对路径一起给：client 点一条就能直接开那个文件跳到那一行，不用自己拼路径。 */
			path: join(resolved, file),
			rule,
			message,
			line: typeof line === "number" && line > 0 ? line : 0
		});
	};

	if (pageJson !== null) {
		/* --- page.json --- */
		let page = null;
		try {
			page = JSON.parse(pageJson);
		} catch {
			push("error", "page.json", "json-invalid", "page.json 不是合法 JSON，推送会失败", 0);
		}
		if (page !== null && (page.uuid === undefined || page.uuid === null || page.uuid === "")) {
			push("error", "page.json", "uuid-missing", "page.json 缺少 uuid 字段，平台无法定位页面", lineOf(pageJson, "\"uuid\""));
		}

		/* --- index.html --- */
		/*
		 * page.js 先读出来：判断 {{}} 是不是合法插值，要看它引用的根对象在不在
		 * 这个页面里定义过（myData / myMethod）。下面 page.js 那一段仍然用这个 js。
		 */
		const js = await readIn("page.js");
		const html = await readIn("index.html");
		if (html !== null) {
			if (html.includes("magicalDragScene") === false) {
				push("warn", "index.html", "no-scene", "未包含 magicalDragScene 容器，平台布局器可能无法识别该页面结构", 0);
			}
			/*
			 * V1.06 文本节点裸 {{}}。
			 *
			 * 原版见到就报 error 并叫人加 v-pre，可平台设计器生成的列表页在 v-for 里
			 * 嵌 {{item.x}} 是常态（page.js 的 myData 里放着那个数组），加 v-pre
			 * 反而会把 {{item.x}} 原样印在页面上。所以只在「这个根对象既不是循环变量、
			 * 也不以 $ 开头、page.js 里压根没出现过」时才提一句，而且降成 warn ——
			 * 那种情况更像是名字写错了，而不是缺 v-pre。
			 */
			const guarded = vPreRanges(html);
			const inVPre = (at) => guarded.some(([start, end]) => at >= start && at < end);
			const scopes = vForScopes(html);
			const aliasesAt = (at) => {
				for (const [start, end, aliases] of scopes) {
					if (at >= start && at < end) return aliases;
				}
				return null;
			};
			const knownInJs = (name) => js !== null && new RegExp("\\b" + name + "\\b").test(js);
			const bareRe = />[^<]*\{\{([^}]*)\}\}[^<]*</g;
			let bareHit;
			let bareCount = 0;
			while ((bareHit = bareRe.exec(html)) !== null) {
				if (bareCount >= BARE_MUSTACHE_MAX) break;
				/* match[0] 以 '>' 开头，真正的问题文本从 +1 开始。 */
				const at = bareHit.index + 1;
				if (inVPre(at) === true) continue;
				const root = mustacheRoot(bareHit[1]);
				if (root === "" || root.startsWith("$")) continue;
				const aliases = aliasesAt(at);
				if (aliases !== null && aliases.includes(root)) continue;
				if (knownInJs(root) === true) continue;
				bareCount += 1;
				const text = bareHit[0];
				push("warn", "index.html", "bare-mustache",
					"文本节点里的 {{}} 会被 Vue 当插值解析，但 " + root + " 在这个页面里找不到定义：" + text.trim() + "（只有本意要显示字面量时才需要加 v-pre）",
					lineOf(html, text));
			}
			/* V1.06：属性值里的裸 {{}} 连编译都过不去。 */
			for (const text of (html.match(/(="[^"]*\{\{[^"]*"|='[^']*\{\{[^']*')/g) ?? []).slice(0, BARE_MUSTACHE_MAX)) {
				push("error", "index.html", "attr-mustache",
					"属性值出现裸 {{}}，会编译错误：" + text.trim() + "（应使用 :prop 传字符串字面量）",
					lineOf(html, text));
			}
		}

		/* --- page.js --- */
		if (js !== null) {
			const bad = syntaxErrorOf(js);
			if (bad !== null) push("error", "page.js", "js-syntax", "JS 语法错误：" + bad, 0);
			const at = js.search(/var\s+myMethod\s*=/);
			if (at === -1) {
				push("warn", "page.js", "no-myMethod", "未定义 myMethod（平台装配依赖 myMethod 合并自定义方法）", 0);
			} else {
				if (/for\s*\(\s*var\s+key\s+in\s+myMethod\s*\)/.test(js) === false) {
					push("warn", "page.js", "no-merge-loop", "缺少 for(key in myMethod) 合并循环，自定义方法可能不生效（V1.01）", lineOf(js, "myMethod"));
				}
				/* V1.01：myMethod 字面量之外碰 vueMethod 就是改系统合并区，运行时 is not a function。 */
				const touched = js.slice(0, at).match(/vueMethod\.[A-Za-z0-9_$]+\s*=/);
				if (touched !== null) {
					push("error", "page.js", "sys-zone-modified",
						"在 myMethod 字面量外直接给 vueMethod 赋值（系统合并区外修改方法，运行时 is not a function）：" + touched[0].trim(),
						lineOf(js, touched[0]));
				}
			}
			if ((js.includes("$magicaltool.request") || js.includes("magicaltool.request")) && js.includes("magical_lowcode/openapi") === false) {
				push("warn", "page.js", "api-url", "调用平台 API 的 url 建议使用 /magical_lowcode/openapi/ 前缀路径", 0);
			}
		}

		/* --- page.css --- */
		const css = await readIn("page.css");
		if (css !== null) {
			const open = (css.match(/\{/g) ?? []).length;
			const close = (css.match(/\}/g) ?? []).length;
			if (open !== close) {
				push("error", "page.css", "css-brace", "CSS 花括号不平衡（{ 共 " + open + "，} 共 " + close + "），样式可能全部失效", 0);
			}
		}
	} else {
		/* --- meta.json --- */
		let meta = null;
		try {
			meta = JSON.parse(metaJson);
		} catch {
			push("error", "meta.json", "json-invalid", "meta.json 不是合法 JSON", 0);
		}
		if (meta !== null && (meta.id === undefined || meta.id === null || meta.id === "")) {
			push("error", "meta.json", "id-missing", "meta.json 缺少 id 字段", lineOf(metaJson, "\"id\""));
		}

		/* --- script.js --- */
		const script = await readIn("script.js");
		if (script !== null) {
			const bad = syntaxErrorOf(script);
			if (bad !== null) push("error", "script.js", "js-syntax", "JS 语法错误：" + bad, 0);
			/* V1.05：_body 里是 Java 包装类型，=== 数字恒不成立，必须先 Number()。 */
			for (const text of (script.match(/_body\.[A-Za-z0-9_$]+\s*===\s*\d+/g) ?? []).slice(0, NUMBER_STRICT_MAX)) {
				push("warn", "script.js", "number-strict",
					"「" + text + "」：_body 数字是 Java 包装类型，=== 严格比较会失效，请先 Number() 归一（V1.05）",
					lineOf(script, text));
			}
			if (/\breturn\s+\{/.test(script) === false) {
				push("warn", "script.js", "no-return", "未发现 return 对象，平台脚本通常以 return { code, data } 结构返回结果", 0);
			}
		}
	}

	/* 两级排序：错误在前，同级按文件、再按行号 —— 面板里从上往下读就是修复顺序。 */
	issues.sort((a, b) =>
		(a.level === b.level ? 0 : a.level === "error" ? -1 : 1)
		|| a.file.localeCompare(b.file, "en")
		|| a.line - b.line
	);
	return { dir: resolved, kind: pageJson !== null ? "page" : "api", issues };
}

/*
	推送状态扫描要把每个推送单元的校验结果挂到徽章上，而扫描在每次写回之后都会重跑。
	好在 snapshotOf 已经把每个目录的 mtime 快照算出来了，而校验只读目录顶层的那几个
	文件：快照没变，就说明校验关心的东西一个都没被碰过，直接复用上次的结果。

	键用 snapshotOf 的 files（它递归覆盖子孙，只会多失效、不会漏失效 —— 宁可白算
	一次，也不能把改过的目录错报成干净的）。
*/
const lintCache = new Map();

/** 把快照压成一个与键顺序无关的字符串当缓存键。 */
function stampKey(files) {
	const names = Object.keys(files).sort();
	let out = "";
	for (const name of names) out += name + ":" + files[name] + ";";
	return out;
}

/** snapshot 是 snapshotOf 的返回值 { files, names }。 */
async function lintCached(dir, snapshot) {
	const key = stampKey(snapshot.files);
	const hit = lintCache.get(dir);
	if (hit !== undefined && hit.key === key) return hit.value;
	const value = await scanSlot(() => lintDir(dir, true, snapshot.names));
	lintCache.set(dir, { key, value });
	return value;
}

/**
 * 从被写的文件往上找它所属的推送单元（最近的带 page.json / meta.json 的祖先目录），
 * 只把那一个单元的校验重算一遍。
 *
 * 写回之后必须让徽章跟上，但绝不能为此重扫整个工作区 —— 写回有且只有一个单元会变。
 */
async function lintUnitOf(file, root) {
	const stop = normalizeForCompare(root);
	let dir = dirname(file);
	for (let up = 0; up <= PUSH_SCAN_MAX_DEPTH; up += 1) {
		if (normalizeForCompare(dir) === stop) return null;
		if ((await hasManifest(dir)) === true) {
			return { dir, lint: await lintCached(dir, await snapshotOf(dir)) };
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/** 数校验结果里某一级的条数；lint 为 null（不是页面/API 目录）时算 0。 */
function countLevel(lint, level) {
	if (lint === null) return 0;
	let total = 0;
	for (const issue of lint.issues) {
		if (issue.level === level) total += 1;
	}
	return total;
}

/** 错误 / 警告的条数，徽章和写回回执都用这一份形状。 */
function countLevels(lint) {
	return { errors: countLevel(lint, "error"), warns: countLevel(lint, "warn") };
}

/*
	徽章上的 ✗N 只回答了「几个」，用户下一句话必然是「哪个文件」。

	扫描手里本来就有刚算完的明细，顺手挂到节点上最省事 —— 反过来让用户自己挑一个
	目录再点「推送前校验」，等于让他先猜是哪个目录，正是徽章该替他回答的事。

	只带**错误**，不带警告：真项目上警告有一千两百多条（1236 条 no-return），全带上
	既把响应吹大，又把真正要看的那几条埋掉。两个上限是防烂工程 —— 一份满是语法错误
	的工程不该把响应顶到几兆。
*/
const MAX_NODE_ISSUES = 20;
const MAX_TOTAL_ISSUES = 800;

/** lint 结果里的错误明细；一条都没有时返回 null（省得节点上挂个空数组）。 */
function errorIssuesOf(lint) {
	if (lint === null) return null;
	const bad = [];
	for (const issue of lint.issues) {
		if (issue.level === "error") bad.push(issue);
	}
	return bad.length === 0 ? null : bad;
}

/* ------------------------------------------------- 跑工作区根下的 source-*.js */

/*
	工程根下的那几个 source-*.js 是平台自带的运维脚本（拉取 / 推送 / 克隆）。
	面板不去理解它们，只负责「按名字跑、把输出接回来」：白名单是**名字**不是内容，
	所以脚本怎么变都不用改这里。
*/
const RUN_SCRIPT_RE = /^source-[a-z0-9-]+\.js$/;
/** 一次运行最多留这么多字符的输出；超了就杀掉，免得把 host 内存顶爆。 */
const RUN_MAX_OUTPUT = 400000;
/** 记录跑完后再留这么久，够 client 轮询到最终状态和收尾输出。 */
const RUN_KEEP_MS = 10 * 60 * 1000;
/** 同时最多留几条记录（只淘汰已结束的）。 */
const RUN_KEEP_MAX = 20;

/*
	已知脚本的参数约定与语义。表在 host 这边，client 只拿结果渲染按钮 ——
	以后脚本参数变了，改一处。

	`mode` 分推 / 拉，**但不参与「要不要确认」** —— 那是按真实地址判的（见下）。
	client 拿它认「这次跑的是不是推送」，好在跑完之后重扫一遍推送状态。

	要不要确认只看一件事：**目标是外网地址**（.env 里 SERVER_URL 不是本机）。推和拉
	一视同仁 —— 拉取也是拿服务器上的东西覆盖本地文件，破坏性一点不比推送小。判据是
	**真实地址**，不是某个「环境名」：本插件没有本地 / 线上的环境之分，ENV 只是脚本文案
	（现在还恒写 local），按它判断会出现「写着本地、实际连外面、还不问一声」。

	`project: true` 的脚本吃一个「项目 uuid」当第一个参数（脚本里是
	`process.argv[2] || process.env.PROJECT_UUID`），client 给它们渲染项目下拉。
	默认参数非空的不算 —— 那些位置已经被 `-a` 占了。

	`syncZone` 只给**拉取类**脚本配，说明「它把哪一片整个盖掉」：
	`pages` / `apis` / `databases` 是项目目录下的三个区，`*` 是整个项目目录。
	跑完（退出码 0）之后要把这一片的推送账重记一遍 —— 拉下来的内容跟服务器一致，
	本地已经没有「服务器上还没有的改动」了，但文件是重写的、mtime 全变，
	不重记就会整片显示「待推送」（见 `projectResyncPush`）。推送类不配：
	推不改本地文件，重扫一遍就够。
*/
const RUN_CATALOG = {
	"source-push.js": { label: "推送整个项目", mode: "push", args: [], project: true },
	"source-api-push.js": { label: "推送全部 API", mode: "push", args: ["-a"] },
	"source-page-push.js": { label: "推送全部页面", mode: "push", args: ["-a"] },
	"source-api-pull.js": { label: "拉取全部 API", mode: "pull", args: ["-a"], syncZone: "apis" },
	"source-page-pull.js": { label: "拉取全部页面", mode: "pull", args: ["-a"], syncZone: "pages" },
	"source-db-pull.js": { label: "拉取数据库", mode: "pull", args: [], project: true, syncZone: "databases" },
	"source-clone.js": { label: "克隆整个项目", mode: "pull", args: [], project: true, syncZone: "*" }
};

/** 运行记录：runId → { id, script, cmd, log, done, code, killed, ... }。 */
const runs = new Map();
let runSeq = 0;

/*
	.env 的解析，以及「脚本到底会连到哪」的判断。

	.env 里凡是备选项都写成两行：上面一行 `# 名字`、下面一行被注释掉的赋值 ——
	平台把十个项目 uuid 和几个服务器地址都堆在同一份文件里就是这种排法。
	所以顺手把它们捡成候选清单，面板的项目下拉就有内容了，不用另外维护一份表。
*/
/** `KEY=value`；前面可能带 `#`，那就是被注释掉的备选。 */
const ENV_ASSIGN_RE = /^\s*(#\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
/** 纯标签行：`# 智家排程`。 */
const ENV_LABEL_RE = /^\s*#\s*([^=\s][^=]*)$/;

/**
 * 把 .env 文本拆成 { values, projects, servers }。
 * values 只有生效的行；projects / servers 是带名字的候选清单（生效那条 active:true）。
 */
function parseEnvText(text) {
	const values = {};
	const projects = [];
	const servers = [];
	let label = "";
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "") {
			label = "";
			continue;
		}
		const assign = ENV_ASSIGN_RE.exec(line);
		if (assign !== null) {
			const off = assign[1] !== undefined;
			const key = assign[2];
			const value = assign[3].trim();
			if (!off) values[key] = value;
			if (key === "PROJECT_UUID" || key === "SERVER_URL") {
				const isProject = key === "PROJECT_UUID";
				const list = isProject ? projects : servers;
				if (!off) {
					list.push(isProject ? { name: label, uuid: value, active: true } : { name: label, url: value, active: true });
				} else if (label !== "") {
					list.push(isProject ? { name: label, uuid: value, active: false } : { name: label, url: value, active: false });
				}
			}
			/* 生效行之后标签就不该再被复用了；注释行之间则保留。 */
			if (!off) label = "";
			continue;
		}
		const tag = ENV_LABEL_RE.exec(line);
		label = tag === null ? "" : tag[1].trim();
	}
	return { values, projects, servers };
}

/** 读工作区根的 .env；没有就返回空壳（工程没放 .env 时页签照样能开）。 */
async function readProjectEnv(dir) {
	const text = await readOpt(join(dir, ".env"));
	if (text === null) return { values: {}, projects: [], servers: [] };
	return parseEnvText(text);
}

/** 从 URL（或裸的 `host:port`）里抠主机名与端口；抠不出来返回 null。 */
function splitHost(url) {
	const text = String(url ?? "").trim();
	if (text === "") return null;
	const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(text);
	const rest = scheme === null ? text : text.slice(scheme[0].length);
	const cut = rest.search(/[/?#]/);
	const authority = cut < 0 ? rest : rest.slice(0, cut);
	const at = authority.lastIndexOf("@");
	const body = at >= 0 ? authority.slice(at + 1) : authority;
	if (body.startsWith("[")) {
		const end = body.indexOf("]");
		if (end < 0) return null;
		return { host: body.slice(1, end).toLowerCase(), port: body.slice(end + 1).replace(/^:/, "") };
	}
	const colon = body.lastIndexOf(":");
	if (colon >= 0 && /^\d+$/.test(body.slice(colon + 1))) {
		return { host: body.slice(0, colon).toLowerCase(), port: body.slice(colon + 1) };
	}
	return body === "" ? null : { host: body.toLowerCase(), port: "" };
}

function isLocalHost(host) {
	return host === "localhost" || host === "::1" || host === "0.0.0.0" ||
		host === "127.0.0.1" || /^127\./.test(host) || host.endsWith(".localhost");
}

/**
 * 目标是不是外网 —— 决定 push 类脚本要不要先确认一次。
 * 抠不出主机名的（.env 里没写、或写了个莫名其妙的值）当「不是外网」：那种情况下
 * 脚本自己也连不上，没必要先拦一道。
 */
function isRemoteUrl(url) {
	const parts = splitHost(url);
	return parts === null ? false : !isLocalHost(parts.host);
}

/**
 * 给面板显示的目标：**只有主机名和端口**，不带「线上 / 本地」这种前缀。
 * 面板没有环境之分 —— 前缀既没信息量，看久了还会变成背景噪音；要判断
 * 「这是不是外面」看 `remote` 字段，要拦就在动作上拦。
 */
function labelOfUrl(url) {
	const parts = splitHost(url);
	if (parts === null) return "未配置 SERVER_URL";
	/* IPv6 的主机名自己带冒号，不套方括号的话 `::1:18080` 分不清哪一段是端口。 */
	const host = parts.host.includes(":") ? "[" + parts.host + "]" : parts.host;
	return parts.port === "" ? host : host + ":" + parts.port;
}

/** 淘汰过期的运行记录；只动已经结束的，不碰正在跑的。 */
function pruneRuns() {
	const now = Date.now();
	const finished = [];
	for (const run of [...runs.values()]) {
		if (!run.done) continue;
		if (run.doneAt > 0 && now - run.doneAt > RUN_KEEP_MS) {
			runs.delete(run.id);
			continue;
		}
		finished.push(run);
	}
	if (runs.size <= RUN_KEEP_MAX) return;
	finished.sort((left, right) => left.doneAt - right.doneAt);
	while (runs.size > RUN_KEEP_MAX && finished.length > 0) runs.delete(finished.shift().id);
}

/**
 * 杀一棵进程树。
 *
 * Windows 上只有 `child.kill()` 会漏掉孙子进程 —— 而 source-push.js 正是用
 * execSync 去调 source-api-push.js，真正的推送跑在孙子进程里。所以 win32 上
 * 走 taskkill /T，别的平台直接 kill。
 */
function killTree(child) {
	const pid = child.pid;
	if (process.platform === "win32" && typeof pid === "number" && pid > 0) {
		try {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			return;
		} catch { /* 落到 child.kill */ }
	}
	try {
		child.kill();
	} catch { /* 已经没了 */ }
}

/* ------------------------------------------------- RPC 实现 */

const HANDLERS = {
	/**
	 * 已注册工作区清单。
	 * 面板启动时问它一次，把第一个工作区自动填进路径框 —— 用户不必手输路径，
	 * 同时也就解释了「为什么只有这些目录能看」。
	 */
	async listProjectWorkspaces(ctx) {
		const workspaces = workspacesOf(ctx);
		const items = [];
		for (const workspace of workspaces) {
			if (workspace === null || typeof workspace !== "object") continue;
			const path = typeof workspace.path === "string" ? workspace.path : "";
			if (path === "") continue;
			const resolved = resolve(path);
			items.push({
				id: typeof workspace.id === "string" && workspace.id !== "" ? workspace.id : resolved,
				path: resolved,
				name: typeof workspace.name === "string" && workspace.name !== "" ? workspace.name : basename(resolved)
			});
		}
		return { workspaces: items };
	},

	/** 工程文件树：列一层目录（含文件），自带截断标记。 */
	async listProjectEntries(ctx, args) {
		const endpoint = NAMESPACE + "/listProjectEntries";
		const resolved = requirePath(args, endpoint);
		ownerOf(ctx, resolved, endpoint);
		let dirents;
		try {
			dirents = await readdir(resolved, { withFileTypes: true });
		} catch (error) {
			throw fsError(error, "listProjectEntries");
		}
		dirents.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }));
		const entries = [];
		let truncated = false;
		for (const dirent of dirents) {
			if (entries.length >= MAX_ENTRIES) {
				truncated = true;
				break;
			}
			if (dirent.name === "." || dirent.name === ".." || dirent.isSymbolicLink()) continue;
			const kind = dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : void 0;
			if (kind === void 0) continue;
			entries.push({
				name: dirent.name,
				path: join(resolved, dirent.name),
				kind,
				hidden: dirent.name.startsWith(".")
			});
		}
		return { path: resolved, entries, truncated };
	},

	/** 读一个工作区内文件（UTF-8，限 2MB）到面板右栏。 */
	async projectReadFile(ctx, args) {
		const endpoint = NAMESPACE + "/projectReadFile";
		const resolved = requirePath(args, endpoint);
		ownerOf(ctx, resolved, endpoint);
		let info;
		try {
			info = await stat(resolved);
		} catch (error) {
			throw fsError(error, "projectReadFile");
		}
		if (!info.isFile()) throw new PanelError("not-a-file", "只能读取文件：" + resolved, {});
		if (info.size > MAX_READ_BYTES) {
			throw new PanelError("file-too-large", "文件超过 2MB，不支持预览：" + resolved, { size: info.size });
		}
		let content;
		try {
			content = await readFile(resolved, "utf8");
		} catch (error) {
			throw fsError(error, "projectReadFile");
		}
		return { path: resolved, content };
	},

	/** 面板右栏「写回」：把编辑框内容写回文件（不允许落到工作区根目录）。 */
	async projectWriteFile(ctx, args) {
		const endpoint = NAMESPACE + "/projectWriteFile";
		const resolved = requirePath(args, endpoint);
		const owner = ownerOf(ctx, resolved, endpoint);
		if (normalizeForCompare(resolved) === normalizeForCompare(owner.path ?? "")) {
			throw new PanelError("path-outside-workspace", endpoint + " 不能把工作区根目录当文件写", { path: resolved });
		}
		const content = args !== null && typeof args === "object" && typeof args.content === "string" ? args.content : "";
		try {
			await writeFile(resolved, content, "utf8");
		} catch (error) {
			throw fsError(error, "projectWriteFile");
		}
		/*
			写完顺手把「这个文件所属的那个推送单元」重新校验一遍，让树上的徽章跟着变。
			只算这一个单元：写回不可能影响到别的单元，全量重算在真项目上要好几秒。
			找不到所属单元（改的是工作区里一个普通文件）就什么都不做，不是错误。
		*/
		const unit = await lintUnitOf(resolved, owner.path ?? "");
		return { ok: true, path: resolved, lint: unit === null ? null : { dir: unit.dir, ...countLevels(unit.lint) } };
	},

	/** 在某个目录下新建一个文件或文件夹（文件可以带初始内容）。 */
	async projectCreateEntry(ctx, args) {
		const endpoint = NAMESPACE + "/projectCreateEntry";
		const parentArg = args !== null && typeof args === "object" ? args.parent : undefined;
		if (typeof parentArg !== "string" || parentArg.trim() === "") {
			throw new PanelError("bad-request", endpoint + " 缺少参数 parent", {});
		}
		const parent = resolve(parentArg);
		ownerOf(ctx, parent, endpoint);
		const name = requireName(args, endpoint);
		const kind = args !== null && typeof args === "object" && args.kind === "directory" ? "directory" : "file";
		const info = await statOrNull(parent);
		if (info === null) throw new PanelError("not-found", "要建在哪儿的目录不存在：" + parent, { path: parent });
		if (!info.isDirectory()) throw new PanelError("not-a-directory", "只能在目录下新建：" + parent, { path: parent });
		const target = join(parent, name);
		/* 目标也过一遍边界：名字已经滤过斜杠，这步是给符号链接之类留的保险。 */
		ownerOf(ctx, target, endpoint);
		try {
			if (kind === "directory") await mkdir(target);
			else {
				/*
					可选初始内容：client 按扩展名挑的模板（见它的 `templateFor`）。
					和创建放在**同一次写**里，而不是建完再补一次 —— 拆两步会在中间
					留下一个空文件，文件监视器和 git 都会看到两次写入，补内容那一步
					失败时还多出一个不该存在的空壳。
				*/
				const body = args !== null && typeof args === "object" && typeof args.content === "string" ? args.content : "";
				/* wx 让「已存在」直接报 EEXIST，不会悄悄覆盖别人。 */
				await writeFile(target, body, { encoding: "utf8", flag: "wx" });
			}
		} catch (error) {
			const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "";
			if (code === "EEXIST") throw new PanelError("already-exists", "已经有同名的了：" + name, { path: target });
			throw fsError(error, "projectCreateEntry");
		}
		return { path: target, kind };
	},

	/** 改名：只在原目录里换 basename，不跨目录搬。 */
	async projectRenameEntry(ctx, args) {
		const endpoint = NAMESPACE + "/projectRenameEntry";
		const source = requirePath(args, endpoint);
		rejectWorkspaceRoot(ctx, source, endpoint);
		const name = requireName(args, endpoint);
		const target = join(dirname(source), name);
		ownerOf(ctx, target, endpoint);
		if (normalizeForCompare(source) === normalizeForCompare(target)) {
			return { path: source, unchanged: true };
		}
		if ((await statOrNull(target)) !== null) {
			throw new PanelError("already-exists", "已经有同名的了：" + name, { path: target });
		}
		if ((await statOrNull(source)) === null) {
			throw new PanelError("not-found", "路径不存在：" + source, { path: source });
		}
		try {
			await rename(source, target);
		} catch (error) {
			throw fsError(error, "projectRenameEntry");
		}
		return { path: target };
	},

	/**
	 * 把一个文件/文件夹搬到另一个目录里，名字不变。
	 *
	 * 和 `projectRenameEntry` 的分工：那个只在原目录里换 basename，这个**跨目录搬**。
	 * args: { path, parent } —— path 是要搬的东西，parent 是目标目录（不是目标全路径，
	 * 免得 client 还要自己拼名字，拼错了又得回来查）。
	 */
	async projectMoveEntry(ctx, args) {
		const endpoint = NAMESPACE + "/projectMoveEntry";
		const source = requirePath(args, endpoint);
		/* 搬走工作区根 = 把整个工程弄没，和删、改名一个待遇。 */
		rejectWorkspaceRoot(ctx, source, endpoint);
		const parentArg = args !== null && typeof args === "object" ? args.parent : undefined;
		if (typeof parentArg !== "string" || parentArg.trim() === "") {
			throw new PanelError("bad-request", endpoint + " 缺少参数 parent", {});
		}
		const parent = resolve(parentArg);
		ownerOf(ctx, parent, endpoint);
		const parentInfo = await statOrNull(parent);
		if (parentInfo === null) throw new PanelError("not-found", "目标目录不存在：" + parent, { path: parent });
		if (!parentInfo.isDirectory()) throw new PanelError("not-a-directory", "目标不是目录：" + parent, { path: parent });

		const name = basename(source);
		const target = join(parent, name);
		ownerOf(ctx, target, endpoint);
		if (normalizeForCompare(source) === normalizeForCompare(target)) {
			return { path: source, unchanged: true };
		}
		const sourceInfo = await statOrNull(source);
		if (sourceInfo === null) throw new PanelError("not-found", "路径不存在：" + source, { path: source });
		/*
			目录不能搬进它自己或它的子孙里。rename 自己会报 EINVAL，但报出来的话
			看不出是哪儿错了，而且有些平台会先把一半东西搬走 —— 提前挡掉干净。
		*/
		const srcKey = normalizeForCompare(source);
		const dstKey = normalizeForCompare(parent);
		if (sourceInfo.isDirectory() && (dstKey === srcKey || dstKey.startsWith(srcKey + sep))) {
			throw new PanelError("bad-target", "不能把目录搬进它自己里面：" + parent, { path: target });
		}
		if ((await statOrNull(target)) !== null) {
			throw new PanelError("already-exists", "目标目录里已经有同名的了：" + name, { path: target });
		}
		try {
			await rename(source, target);
		} catch (error) {
			const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "";
			/* 跨盘符搬不了（C: → D:）：不是权限问题，说清楚免得用户去翻权限。 */
			if (code === "EXDEV") {
				throw new PanelError("cross-device", "不能跨盘符搬动（只能在同一个盘里移动）：" + source, { path: source });
			}
			throw fsError(error, "projectMoveEntry");
		}
		return { path: target, kind: sourceInfo.isDirectory() ? "directory" : "file" };
	},

	/** 删掉一个文件，或者整个目录（递归）。 */
	async projectDeleteEntry(ctx, args) {
		const endpoint = NAMESPACE + "/projectDeleteEntry";
		const resolved = requirePath(args, endpoint);
		rejectWorkspaceRoot(ctx, resolved, endpoint);
		const info = await statOrNull(resolved);
		if (info === null) throw new PanelError("not-found", "路径不存在：" + resolved, { path: resolved });
		const isDirectory = info.isDirectory();
		try {
			await rm(resolved, { recursive: isDirectory, force: false });
		} catch (error) {
			throw fsError(error, "projectDeleteEntry");
		}
		return { path: resolved, kind: isDirectory ? "directory" : "file" };
	},

	/**
	 * 文件树模糊搜索。
	 *
	 * args: { path, query } —— 工作区根 + 关键字。
	 * 返回 { hits, truncated }，hits 每项 { name, relPath, path, kind, score }，
	 * 已按得分从高到低排好。
	 *
	 * 面板顶部那个框就是走这里：树只能一层层展开，搜深层文件必须靠全量遍历。
	 * 所以自动跳过 node_modules / .git / dist 这些目录 —— 不跳的话一个前端工程
	 * 动辄几万条，面板会卡住好几秒，而用户要搜的从来不是依赖里的东西。
	 */
	async projectSearchEntries(ctx, args) {
		const endpoint = NAMESPACE + "/projectSearchEntries";
		const resolved = requirePath(args, endpoint);
		ownerOf(ctx, resolved, endpoint);
		const query = args !== null && typeof args === "object" && typeof args.query === "string" ? args.query.trim() : "";
		if (query === "") return { hits: [], truncated: false };
		const needle = query.toLowerCase();
		const hits = [];
		let truncated = false;

		await walkWorkspace(resolved, (abs, rel, dirent, kind) => {
			const score = fuzzyScore(rel.toLowerCase(), needle);
			if (score === null) return true;
			if (hits.length >= MAX_SEARCH_HITS) {
				truncated = true;
				return false;
			}
			hits.push({
				name: dirent.name,
				relPath: rel,
				path: abs,
				kind,
				score,
				hidden: dirent.name.startsWith(".")
			});
			return true;
		});
		hits.sort(
			(a, b) =>
				b.score - a.score ||
				a.relPath.localeCompare(b.relPath, "en", { numeric: true, sensitivity: "base" })
		);
		return { hits: hits.slice(0, MAX_SEARCH_HITS), truncated };
	},

	/**
	 * 文件**内容**搜索（grep）。
	 *
	 * args: { path, query, ignoreCase } —— 工作区根 + 关键字 + 是否忽略大小写（默认忽略）。
	 * 返回 { hits, files, matched, skipped, truncated }：
	 *   hits    每项 { name, relPath, path, line, column, text }，按文件、行号升序
	 *   files   实际读过的文件数；matched 命中的文件数；skipped 跳过（太大 / 二进制）的文件数
	 *
	 * 匹配是**纯字面量**，不做正则 —— 用户十次有九次找的是一段普通文本，而让
	 * 正则悄悄吃掉 `(` 或 `.` 反而更难解释。命中行按真实列号返回，`text` 只在
	 * 命中太靠右时从左边切一段（见 clipLine），这样预览里还能看见命中本身。
	 *
	 * 遍历规则和 projectSearchEntries 完全一致（同一个 walkWorkspace）。
	 */
	async projectGrepFiles(ctx, args) {
		const endpoint = NAMESPACE + "/projectGrepFiles";
		const resolved = requirePath(args, endpoint);
		ownerOf(ctx, resolved, endpoint);
		const query = args !== null && typeof args === "object" && typeof args.query === "string" ? args.query.trim() : "";
		if (query === "") return { hits: [], files: 0, matched: 0, skipped: 0, truncated: false };
		const ignoreCase = args.ignoreCase !== false;
		const needle = ignoreCase === true ? query.toLowerCase() : query;
		const hits = [];
		let files = 0;
		let matched = 0;
		let skipped = 0;
		let truncated = false;

		await walkWorkspace(resolved, async (abs, rel, dirent, kind) => {
			if (kind !== "file") return true;
			if (files >= MAX_GREP_FILES) {
				truncated = true;
				return false;
			}
			files += 1;
			let buffer;
			try {
				const info = await stat(abs);
				if (info.size > MAX_GREP_FILE_BYTES) {
					skipped += 1;
					return true;
				}
				buffer = await readFile(abs);
			} catch {
				skipped += 1;
				return true;
			}
			if (looksBinary(buffer) === true) {
				skipped += 1;
				return true;
			}
			const lines = buffer.toString("utf8").split(/\r?\n/);
			let fileMatched = false;
			for (let index = 0; index < lines.length; index += 1) {
				const raw = lines[index];
				const hay = ignoreCase === true ? raw.toLowerCase() : raw;
				const at = hay.indexOf(needle);
				if (at === -1) continue;
				if (hits.length >= MAX_GREP_HITS) {
					truncated = true;
					return false;
				}
				fileMatched = true;
				hits.push({
					name: dirent.name,
					relPath: rel,
					path: abs,
					/* 行号 1 基，直接能喂给预览器的 params.line。 */
					line: index + 1,
					column: at + 1,
					text: clipLine(raw, at)
				});
			}
			if (fileMatched === true) matched += 1;
			return true;
		});
		return { hits, files, matched, skipped, truncated };
	},

	/**
	 * 推送前静态校验（lint）。
	 *
	 * args: { path } —— 页面目录或 API 目录。
	 * 返回 { dir, kind, issues }，kind 是 "page" | "api"；
	 * issues 每项 { level: "error"|"warn", file, rule, message, line }（line 1 基，0 = 定位不到）。
	 *
	 * 只读，**不执行任何工程代码**：JS 那几条拿 new Function 只做语法解析、不运行，
	 * 其余全是正则/子串匹配。规则照搬魔改低代码平台 V1.01~V1.06 踩过的坑。
	 */
	async projectLint(ctx, args) {
		const endpoint = NAMESPACE + "/projectLint";
		const resolved = requirePath(args, endpoint);
		ownerOf(ctx, resolved, endpoint);
		/*
			走缓存：树上的徽章和这个页签读的是同一份结果，别让两边对同一堆文件说不同的话。
			快照在这里现拍一次，它同时也充当缓存键。
		*/
		const result = await lintCached(resolved, await snapshotOf(resolved));
		if (result === null) throw notAPageOrApi(resolved);
		return result;
	},

	/**
	 * 推送状态扫描（顺带登记第一次见到的单元，并给每个单元挂上校验计数）。
	 *
	 * args: { path } —— 工作区根。
	 * 返回 { nodes, projectUuid, projectNames, remote, targetLabel, scripts }。nodes 是扁平的
	 * 「推送单元」清单，每项自带 dir（绝对路径）与 zone（pages / apis / databases），
	 * client 拿它跟树节点路径对齐就能挂徽章、并且在树上直接推拉单个单元。
	 *
	 * 校验结果走 mtime 缓存（lintCache）：没被碰过的单元不重算，所以只有第一次扫
	 * 是真全量。这条路径能扛住 2000 多个单元，靠的是三件事 —— 并发闸门扫目录、
	 * 快照里顺手捞到的文件名集合（免得盲读 ENOENT）、以及这个缓存。
	 *
	 * 纯只读之外唯一副作用是首次登记，扫描本身不碰工程文件。
	 */
	async projectPushStatus(ctx, args) {
		const endpoint = NAMESPACE + "/projectPushStatus";
		const resolved = requirePath(args, endpoint);
		ownerOf(ctx, resolved, endpoint);
		const state = await readPushState();
		/* 账本键按工作区隔离：扫描时拿的就是这个工作区的根（见 pushKeyPrefix）。 */
		const prefix = pushKeyPrefix(resolved);
		let stateChanged = false;
		const nodes = [];
		/*
			明细预算按「一次请求」算，所以计数器在 handler 里而不是模块级。正常工程远远
			用不完（真项目上二十来个错误），上限只是不让一份烂工程把响应吹起来。
		*/
		let issueBudget = MAX_TOTAL_ISSUES;
		const attachIssues = (node, lint) => {
			if (node.errors === 0 || issueBudget <= 0) return node;
			const bad = errorIssuesOf(lint);
			if (bad === null) return node;
			const take = bad.slice(0, Math.min(MAX_NODE_ISSUES, issueBudget));
			issueBudget -= take.length;
			node.issues = take;
			return node;
		};

		/**
		 * 递归扫一个区（pages / apis / databases）里的推送单元。
		 *
		 * `zone` 一路带下去（`pages` / `apis` / `databases`）：账本里 `databases` 底下的
		 * 单元也是 `api:` 键（那边只有 meta.json），光看 scope 分不出它归谁管，
		 * 而「单个单元推送 / 拉取」用的脚本是按区分的。
		 */
		const scanZone = async (dir, rel, depth, zone) => {
			if (depth > PUSH_SCAN_MAX_DEPTH) return null;
			let dirents;
			try {
				dirents = await scanSlot(() => readdir(dir, { withFileTypes: true }));
			} catch {
				return null;
			}
			const self = await scanSlot(() => pushKeyOf(dir, prefix));
			/*
				有 page.json / meta.json 却拿不到推送键（缺 uuid / id，或者 JSON 坏到读不出来）
				—— 这恰恰是校验最该报的那一类，不能因为「记不了账」就当它不存在，否则坏得
				最彻底的页面反而没有徽章。这种目录给一个不落账的节点：永远算待推送，也永远
				不给「标记已推送」的入口。
			*/
			const broken = self === null && (await scanSlot(() => hasManifest(dir)));
			/*
				子目录**并发**铺开。递归调用本身不占 scanSlot 名额 —— 占了会死锁
				（父调用握着名额等子调用，名额一满就谁也走不动）。名额只发给真正做 I/O
				的那几段，这样 2200 多个目录能一起排队喂饱线程池。
			*/
			const kids = [];
			for (const dirent of dirents) {
				if (!dirent.isDirectory() || /^(\.|.*\.temp-)/.test(dirent.name)) continue;
				kids.push([join(dir, dirent.name), rel === "" ? dirent.name : rel + "/" + dirent.name]);
			}
			const parts = await Promise.all(kids.map(([abs, childRel]) => scanZone(abs, childRel, depth + 1, zone)));
			const children = [];
			for (const part of parts) {
				if (part !== null) children.push(...part.nodes);
			}
			const hasPushableDescendant = children.some((node) => node.pushable === true);
			const hasLintableDescendant = children.some((node) => node.lintable === true);
			if (broken === true) {
				const lint = await lintCached(dir, await snapshotOf(dir));
				const node = {
					key: null,
					scope: "broken",
					target: rel,
					zone,
					name: rel.split("/").pop() ?? "",
					relPath: rel,
					dir,
					status: "dirty",
					errors: countLevel(lint, "error"),
					warns: countLevel(lint, "warn"),
					linted: lint !== null,
					aggregate: false,
					pushable: false,
					lintable: true
				};
				attachIssues(node, lint);
				nodes.push(node);
				return { nodes: [node, ...children], pushable: false, lintable: true, anyDirty: true };
			}
			if (self !== null) {
				const current = await snapshotOf(dir);
				const verdict = computePushStatus(state, self.key, current.files);
				if (verdict.changed) stateChanged = true;
				let status = verdict.status;
				/* 自己快照没变，但有子孙还没推 —— 聚合看也是「待推送」。 */
				if (hasPushableDescendant && children.some((node) => node.pushable === true && node.status !== "pushed")) {
					status = "dirty";
				}
				/*
					顺带把校验结果挂上去：树上的徽章要能一眼看出哪个页面推送会挂，
					不必挨个右键去点。快照刚才已经拍过，直接当缓存键复用 —— 没被碰过的
					单元不会重算，所以「全量」只在第一次是真的全量。
				*/
				const lint = await lintCached(dir, current);
				const node = {
					key: self.key,
					/*
						scope / target 直接取 pushKeyOf 给的，**不要拿 key 去 indexOf(":") 切** ——
						key 里现在带着工作区根，Windows 盘符 `C:` 会先把那个冒号撞上。
					*/
					scope: self.scope,
					target: self.target,
					zone,
					name: self.name ?? rel.split("/").pop() ?? self.target,
					relPath: rel,
					dir,
					status,
					errors: countLevel(lint, "error"),
					warns: countLevel(lint, "warn"),
					linted: lint !== null,
					aggregate: false,
					pushable: true,
					lintable: true
				};
				attachIssues(node, lint);
				nodes.push(node);
				return { nodes: [node, ...children], pushable: true, lintable: true, anyDirty: status !== "pushed" };
			}
			if (children.length === 0) return null;
			/* 全是坏目录（校验能报、但记不了账）时也要有聚合节点，否则父层连汇总都不显示。 */
			if (!hasPushableDescendant && !hasLintableDescendant) return { nodes: children, pushable: false, lintable: false, anyDirty: false };
			const allPushed = children.every((node) => node.pushable !== true || node.status === "pushed");
			/*
				聚合节点自己不是推送单元，报的是子树的合计数。只数 aggregate === false
				的子孙 —— 每个真实页面/API 在扁平列表里正好出现一次，不会被层层重复计。
			*/
			const units = children.filter((node) => node.lintable === true && node.aggregate !== true);
			const lintedUnits = units.filter((node) => node.linted === true);
			const aggregate = {
				key: "agg:" + rel,
				scope: "aggregate",
				target: rel,
				zone,
				name: rel.split("/").pop(),
				relPath: rel,
				dir,
				/* 自己不是推送单元，所以「已推」只可能由子孙全绿得来；一个能推的都没有就只能是待推送。 */
				status: hasPushableDescendant && allPushed ? "pushed" : "dirty",
				errors: lintedUnits.reduce((sum, node) => sum + (node.errors ?? 0), 0),
				warns: lintedUnits.reduce((sum, node) => sum + (node.warns ?? 0), 0),
				/* 聚合节点自己没被校验过，只知道「子孙里有没有算过的」—— 一个都没有时别显示 ✓。 */
				linted: lintedUnits.length > 0,
				lintedUnits: lintedUnits.length,
				totalUnits: units.length,
				aggregate: true,
				pushable: hasPushableDescendant,
				lintable: true
			};
			nodes.push(aggregate);
			return {
				nodes: [aggregate, ...children],
				pushable: hasPushableDescendant,
				lintable: true,
				anyDirty: !(hasPushableDescendant && allPushed)
			};
		};

		/** 在工作区里找 pages / apis / databases 区；找到就扫，别的一律不下钻。 */
		const findZones = async (dir, rel, depth) => {
			if (depth > PUSH_FIND_MAX_DEPTH) return;
			let dirents;
			try {
				dirents = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const dirent of dirents) {
				if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
				const childRel = rel === "" ? dirent.name : rel + "/" + dirent.name;
				if (PUSH_ZONES.has(dirent.name)) {
					const result = await scanZone(join(dir, dirent.name), childRel, 0, dirent.name);
					if (result !== null) nodes.push(...result.nodes);
				} else if (PUSH_SKIP_DIRS.has(dirent.name)) {
					continue;
				} else {
					await findZones(join(dir, dirent.name), childRel, depth + 1);
				}
			}
		};

		let projectUuid = "";
		let serverUrl = "";
		try {
			const envText = await readFile(join(resolved, ".env"), "utf8");
			const matched = envText.match(/^\s*PROJECT_UUID\s*=\s*(\S+)\s*$/m);
			if (matched !== null) projectUuid = matched[1];
			const parsedEnv = parseEnvText(envText);
			serverUrl = parsedEnv.values.SERVER_URL === undefined ? "" : parsedEnv.values.SERVER_URL;
		} catch { /* 没有 .env */ }
		const remote = isRemoteUrl(serverUrl);

		/*
			工作区根下现有的 source-*.js。树上那个右键菜单要按「脚本真的在不在」决定给不给
			「推送这个页面 / 这个 API」这类入口 —— 摆一个点了必然报 not-found 的菜单项，
			不如不摆。顺手列这一层，比让 client 再问一遍 projectListScripts 便宜。
		*/
		let scripts = [];
		try {
			scripts = (await readdir(resolved, { withFileTypes: true }))
				.filter((dirent) => dirent.isFile() && RUN_SCRIPT_RE.test(dirent.name))
				.map((dirent) => dirent.name)
				.sort();
		} catch { /* 列不动就是没有 */ }

		/*
			工作区下可能同时躺着多个 L1 项目目录（纯 uuid 或「名称（uuid）」）。
			识别到就逐个扫，保证每个项目的页面/API 都有状态；识别不到就整棵扫。
		*/
		const l1ProjectDirs = [];
		try {
			const top = await readdir(resolved, { withFileTypes: true });
			for (const dirent of top) {
				if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
				if (L1_PROJECT_NAME_RE.test(dirent.name)) l1ProjectDirs.push(dirent.name);
			}
		} catch { /* 列不动就退化成全扫 */ }

		if (l1ProjectDirs.length === 0) {
			await findZones(resolved, "", 0);
		} else {
			for (const projectDir of l1ProjectDirs) {
				await findZones(join(resolved, projectDir), projectDir, 0);
			}
		}

		if (stateChanged) await writePushState(state);

		const unique = new Map();
		for (const node of nodes) unique.set(node.key + "|" + node.relPath, node);

		let projectNames = {};
		try {
			projectNames = JSON.parse(await readFile(join(resolved, ".dsh-project-names.json"), "utf8"));
		} catch { /* 没有虚拟项目名 */ }

		return { nodes: [...unique.values()], projectUuid, projectNames, remote, targetLabel: labelOfUrl(serverUrl), scripts };
	},

	/**
	 * 标记已推送：把本节点（以及祖先、子孙）的快照刷成当前值。
	 *
	 * args: { path, relDir, scope, target, noAncestors? }
	 *
	 * 两半的语义不一样，别一起关：
	 *
	 * - **祖先**只在**右键「标记已推送」**时刷 —— 用户是手动宣布「这些我都推过了」。
	 *   跑完单个单元的推 / 拉之后自动记账必须传 `noAncestors: true`：推一个子页面
	 *   并没有把父页面自己的内容推上去，把父页面一并点绿就是撒谎。
	 * - **子孙**什么时候都刷。推 / 拉一个目录就是把里面所有页面一起推 / 拉 ——
	 *   `source-page-push.js` 拿到目录 uuid 时走的就是 `copyAllPages`，整棵子树打成一个包。
	 *   早先这里连子孙也一起关掉了，结果是「推了父页面，子页面还挂着待推送」。
	 */
	async projectMarkPushed(ctx, args) {
		const endpoint = NAMESPACE + "/projectMarkPushed";
		const root = requirePath(args, endpoint);
		ownerOf(ctx, root, endpoint);
		const relDir = args !== null && typeof args === "object" && typeof args.relDir === "string" ? args.relDir : "";
		const scope = args !== null && typeof args === "object" && typeof args.scope === "string" ? args.scope : "";
		const target = args !== null && typeof args === "object" && typeof args.target === "string" ? args.target : "";
		const noAncestors = args !== null && typeof args === "object" && args.noAncestors === true;
		if (scope === "" || target === "") {
			throw new PanelError("bad-request", endpoint + " 缺少参数 scope / target", {});
		}
		const selfDir = join(root, relDir);
		if (selfDir !== root && !normalizeForCompare(selfDir).startsWith(normalizeForCompare(root) + sep)) {
			throw new PanelError("path-outside-workspace", endpoint + " 的 relDir 越出了工作区", { relDir });
		}
		const state = await readPushState();
		const prefix = pushKeyPrefix(root);
		state[prefix + scope + ":" + target] = { files: await snapshotDir(selfDir), pushedAt: Date.now() };

		/* 祖先：relDir 的每一层前缀，有 page.json / meta.json 的也一并刷。 */
		if (noAncestors !== true) {
			const parts = relDir.split(/[\\/]/).filter((part) => part !== "");
			for (let index = parts.length - 1; index >= 1; index -= 1) {
				const ancestorDir = join(root, parts.slice(0, index).join("/"));
				const key = await pushKeyOf(ancestorDir, prefix);
				if (key !== null) state[key.key] = { files: await snapshotDir(ancestorDir), pushedAt: Date.now() };
			}
		}

		/* 子孙：推目录等于把里面所有页面/API 一起推了（这一半不受 noAncestors 影响）。 */
		const markDescendants = async (dir) => {
			let dirents;
			try {
				dirents = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const dirent of dirents) {
				if (!dirent.isDirectory() || /^(\.|.*\.temp-)/.test(dirent.name)) continue;
				const sub = join(dir, dirent.name);
				const key = await pushKeyOf(sub, prefix);
				if (key !== null) state[key.key] = { files: await snapshotDir(sub), pushedAt: Date.now() };
				await markDescendants(sub);
			}
		};
		await markDescendants(selfDir);

		await writePushState(state);
		return { ok: true, key: prefix + scope + ":" + target };
	},

	/**
	 * 重置推送状态。
	 *
	 * **只清这个工作区的账**（账本按工作区隔离，见 `pushKeyPrefix`）—— 别人那份推送
	 * 记忆不该被顺手抹掉。不给 `path` 时才整份清空。
	 *
	 * 清完下次扫描会把所有单元重新登记成「已推送」，所以这更像是「把这个工程的推送
	 * 记忆擦掉」，而不是「全标成未推送」。
	 */
	async projectResetPushState(ctx, args) {
		const endpoint = NAMESPACE + "/projectResetPushState";
		const raw = args !== null && typeof args === "object" && typeof args.path === "string" ? args.path.trim() : "";
		pushStateMigrated = true;
		if (raw === "") {
			await writePushState({});
			return { ok: true, scope: "all", kept: 0 };
		}
		const root = resolve(raw);
		ownerOf(ctx, root, endpoint);
		const prefix = pushKeyPrefix(root);
		const state = await readPushState();
		const next = {};
		let dropped = 0;
		for (const key of Object.keys(state)) {
			if (key.startsWith(prefix)) {
				dropped += 1;
				continue;
			}
			next[key] = state[key];
		}
		await writePushState(next);
		return { ok: true, scope: "workspace", dropped, kept: Object.keys(next).length };
	},

	/**
	 * 把「刚被服务器盖过」的那一片如实记成「已推送」。
	 *
	 * args: { path, zone, project? }。`zone` 是 `pages` / `apis` / `databases` 之一，
	 * 或 `*` 表示整个项目目录；`project` 不给就用 `.env` 里生效的 `PROJECT_UUID`。
	 *
	 * **为什么需要它**：账本记的是**本地文件的 mtime**，而徽章回答的是「本地有没有
	 * 服务器上还没有的改动」。刚拉下来时本地 == 服务器，答案是「没有」—— 可文件是
	 * 重写的，mtime 全是新的。不重记的话，用户删掉本地重新拉一次，一进去就是整片
	 * 「待推送」（这条是用户实测报上来的：删了项目目录再 clone 回来，全橙）。
	 *
	 * **做法是删掉这一片的账，不是逐单元写当前快照**：扫描时 `computePushStatus`
	 * 见到没有记录的键会直接登记为「已推送」，两者等价，但删记录不用把整棵子树
	 * 先读一遍。删完由 client 重扫，那些键会被重新写上当前快照。
	 */
	async projectResyncPush(ctx, args) {
		const endpoint = NAMESPACE + "/projectResyncPush";
		const root = requirePath(args, endpoint);
		ownerOf(ctx, root, endpoint);
		const zone = args !== null && typeof args === "object" && typeof args.zone === "string" ? args.zone : "";
		if (zone !== "*" && PUSH_ZONES.has(zone) !== true) {
			throw new PanelError(
				"bad-request",
				endpoint + " 的 zone 只能是 " + ["*", ...PUSH_ZONES].join(" / ") + "，给的是：" + (zone === "" ? "(空)" : zone),
				{ zone }
			);
		}
		/* 项目 uuid：调用方给了就用，否则回落到 .env 里生效的那条。 */
		const raw = args !== null && typeof args === "object" && typeof args.project === "string" ? args.project.trim() : "";
		const parsed = raw === "" ? await readProjectEnv(root) : { values: {} };
		const project = raw !== "" ? raw : (parsed.values.PROJECT_UUID ?? "");
		const base = project === "" ? root : join(root, project);
		const baseInfo = await statOrNull(base);
		if (baseInfo === null || baseInfo.isDirectory() !== true) {
			return { ok: true, zone, dropped: 0, path: base, note: "项目目录不存在，没动账本" };
		}
		const start = zone === "*" ? base : join(base, zone);
		const prefix = pushKeyPrefix(root);
		const state = await readPushState();
		let dropped = 0;
		const collect = async (dir) => {
			const key = await pushKeyOf(dir, prefix);
			if (key !== null && state[key.key] !== undefined) {
				delete state[key.key];
				dropped += 1;
			}
			let dirents;
			try {
				dirents = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const dirent of dirents) {
				if (!dirent.isDirectory() || /^(\.|.*\.temp-)/.test(dirent.name)) continue;
				await collect(join(dir, dirent.name));
			}
		};
		if ((await statOrNull(start)) !== null) await collect(start);
		if (dropped > 0) await writePushState(state);
		return { ok: true, zone, dropped, path: start, project };
	},

	/**
	 * 工作区根下有哪些能跑的脚本，以及它们会连到哪个地址。
	 *
	 * args: { path } —— 工作区根。返回
	 * { path, env, serverUrl, remote, targetLabel, projectUuid, projects, servers, scripts }。
	 * 只 readdir 一层 + 读一次 .env，很便宜；client 进「脚本」页签时问一次即可。
	 */
	async projectListScripts(ctx, args) {
		const endpoint = NAMESPACE + "/projectListScripts";
		const root = requirePath(args, endpoint);
		ownerOf(ctx, root, endpoint);
		const parsed = await readProjectEnv(root);
		const env = parsed.values.ENV === undefined ? "" : parsed.values.ENV;
		const serverUrl = parsed.values.SERVER_URL === undefined ? "" : parsed.values.SERVER_URL;
		const remote = isRemoteUrl(serverUrl);
		let dirents;
		try {
			dirents = await readdir(root, { withFileTypes: true });
		} catch (error) {
			throw fsError(error, endpoint);
		}
		const scripts = [];
		for (const dirent of dirents) {
			if (!dirent.isFile() || !RUN_SCRIPT_RE.test(dirent.name)) continue;
			const preset = RUN_CATALOG[dirent.name];
			const mode = preset === undefined ? "run" : preset.mode;
			const info = await statOrNull(join(root, dirent.name));
			scripts.push({
				name: dirent.name,
				label: preset === undefined ? dirent.name : preset.label,
				args: preset === undefined ? [] : preset.args.slice(),
				mode,
				known: preset !== undefined,
				project: preset !== undefined && preset.project === true,
				/* 拉取类才有：跑完要把这一片的推送账重记（`""` = 不用重记）。 */
				syncZone: preset === undefined || typeof preset.syncZone !== "string" ? "" : preset.syncZone,
				needsConfirm: remote,
				size: info === null ? 0 : info.size,
				mtime: info === null ? 0 : Math.round(info.mtimeMs)
			});
		}
		scripts.sort((left, right) => left.name.localeCompare(right.name));
		return {
			path: root,
			env,
			serverUrl,
			remote,
			targetLabel: labelOfUrl(serverUrl),
			projectUuid: parsed.values.PROJECT_UUID === undefined ? "" : parsed.values.PROJECT_UUID,
			projects: parsed.projects,
			servers: parsed.servers,
			scripts
		};
	},

	/**
	 * 在工作区根下跑一个 source-*.js。
	 *
	 * args: { path, script, args?, confirm? } → { runId, script, cmd, env, serverUrl, remote, needsConfirm, pid }。
	 *
	 * `confirm` 只要 `.env` 里的 SERVER_URL 指向外网就要（看真实地址，不看 ENV ——
	 * ENV 只影响脚本自己的文案）。**推和拉一样**：拉取也是拿服务器上的东西覆盖本地。
	 *
	 * **不等它跑完**：推送动辄几分钟，同步等会一直占着这条请求。起好就返回 runId，
	 * 输出与退出码走 projectRunScriptPoll 增量取。
	 */
	async projectRunScript(ctx, args) {
		const endpoint = NAMESPACE + "/projectRunScript";
		const root = requirePath(args, endpoint);
		ownerOf(ctx, root, endpoint);
		const raw = args !== null && typeof args === "object" ? args.script : undefined;
		const script = typeof raw === "string" ? raw : "";
		if (!RUN_SCRIPT_RE.test(script)) {
			throw new PanelError(
				"script-not-allowed",
				endpoint + " 只跑工作区根下的 source-*.js（给的是：" + (script === "" ? "空" : script) + "）",
				{ script }
			);
		}
		/* 名字过了白名单也还要钉住位置：resolve 之后必须仍在 root 这一层。 */
		const scriptPath = resolve(root, script);
		if (dirname(scriptPath) !== root) {
			throw new PanelError("script-not-allowed", endpoint + " 的脚本必须直接放在工作区根下：" + script, { script });
		}
		if ((await statOrNull(scriptPath)) === null) {
			throw new PanelError("not-found", "脚本不存在：" + scriptPath, { path: scriptPath });
		}
		const extra = Array.isArray(args === null ? undefined : args.args) ? args.args.map((item) => String(item)) : [];
		const confirm = args !== null && typeof args === "object" && args.confirm === true;
		/* 面板里存的档案先落到 .env —— 脚本只认 .env 与 process.env。没绑定就什么都不做。 */
		await applyConfigToEnv(root, "", "");
		const parsed = await readProjectEnv(root);
		const env = parsed.values.ENV === undefined ? "" : parsed.values.ENV;
		const serverUrl = parsed.values.SERVER_URL === undefined ? "" : parsed.values.SERVER_URL;
		const remote = isRemoteUrl(serverUrl);
		/*
			外网地址下**所有**脚本都要确认，不分推还是拉。
			拉取看着「只是把东西取回来」，实际是往本地覆盖文件 —— 破坏性和推送一个级别，
			而且它读的是别的机器上的状态，本地有什么它不管。原来只有 push 类要确认，
			等于放过了更该问一声的那一半。
		*/
		const needsConfirm = remote;
		if (needsConfirm && !confirm) {
			throw new PanelError(
				"needs-confirm",
				"这段脚本会连到 " + labelOfUrl(serverUrl) + "（不是本机），跑 " + script + " 之前要先确认一次",
				{ script, env, serverUrl, remote }
			);
		}

		/* 上次异常退出或被强杀会在根下留 .temp_page_push_* / .temp_api_push_*，清掉再跑。 */
		try {
			for (const dirent of await readdir(root, { withFileTypes: true })) {
				if (dirent.isDirectory() && /^\.temp_(page|api)_push_/.test(dirent.name)) {
					await rm(join(root, dirent.name), { recursive: true, force: true }).catch(() => {});
				}
			}
		} catch { /* 清理失败不影响执行 */ }

		pruneRuns();
		const cmd = "node " + script + (extra.length > 0 ? " " + extra.join(" ") : "");
		/*
			新目录里没有 node_modules 时，把插件自己那份依赖的路径递下去（NODE_PATH）。
			平台拉过的目录自带 node_modules，那边优先，不设 NODE_PATH。
		*/
		const spawnEnv = Object.assign({}, process.env);
		if ((await statOrNull(join(root, "node_modules"))) === null) {
			const modules = await scaffoldModules();
			if (modules !== "") spawnEnv.NODE_PATH = modules;
		}
		/* 用 host 自己的 node（process.execPath），不依赖系统 PATH；shell:false 防注入。 */
		const child = spawn(process.execPath, [scriptPath, ...extra], {
			cwd: root,
			shell: false,
			windowsHide: true,
			env: spawnEnv
		});
		const runId = "run-" + String((runSeq += 1)) + "-" + Date.now().toString(36);
		const run = {
			id: runId,
			script,
			cmd,
			root,
			pid: typeof child.pid === "number" ? child.pid : 0,
			log: "",
			done: false,
			code: null,
			killed: false,
			truncated: false,
			at: Date.now(),
			doneAt: 0,
			child
		};
		runs.set(runId, run);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		/* stdout 和 stderr 进同一条日志：真实终端就是交错的，分开拼反而会错位。 */
		const append = (chunk) => {
			run.log += chunk;
			if (run.log.length > RUN_MAX_OUTPUT) {
				run.truncated = true;
				run.log = run.log.slice(0, RUN_MAX_OUTPUT);
				run.killed = true;
				killTree(child);
			}
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("error", (error) => {
			run.log += "\n[启动失败] " + messageOf(error) + "\n";
			run.done = true;
			run.code = -1;
			run.doneAt = Date.now();
		});
		child.on("close", (code) => {
			if (run.done) return;
			run.done = true;
			run.code = typeof code === "number" ? code : -1;
			run.doneAt = Date.now();
		});
		/*
			把 stdin 收掉。ENV=server 的 source-push.js 会 readline 问一句「确认发布?」，
			能跑到这儿就说明已经确认过了，替它答 yes。needsConfirm 现在看的是地址是
			不是外网（可能要确认的情况比 ENV=server 更宽），多写一句进去没有副作用：
			不读 stdin 的脚本看不见它，读的那个正好拿到想要的答案。不 end 的话管道一直
			开着，脚本只要等输入就会永远挂着。
		*/
		try {
			if (needsConfirm) child.stdin.write("yes\n");
			child.stdin.end();
		} catch { /* 脚本可能已经退出了 */ }

		return { runId, script, cmd, env, serverUrl, remote, needsConfirm, pid: run.pid };
	},

	/**
	 * 取某次运行的新输出。
	 *
	 * args: { runId, since? } —— since 是上次拿到的 next（字符下标）。
	 * 返回 { runId, script, cmd, running, code, next, chunk, truncated, killed }。
	 * 只回增量，client 自己拼：一次请求的报文与「新增多少输出」成正比，
	 * 而不是与总输出成正比。
	 */
	async projectRunScriptPoll(ctx, args) {
		const endpoint = NAMESPACE + "/projectRunScriptPoll";
		const runId = args !== null && typeof args === "object" && typeof args.runId === "string" ? args.runId : "";
		const run = runs.get(runId);
		if (run === undefined) {
			throw new PanelError("not-found", "找不到这次运行（记录可能已经过期）：" + (runId === "" ? "空" : runId), { runId });
		}
		const raw = args !== null && typeof args === "object" ? args.since : undefined;
		const since = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
		return {
			runId,
			script: run.script,
			cmd: run.cmd,
			running: !run.done,
			code: run.code,
			next: run.log.length,
			chunk: run.log.slice(Math.min(since, run.log.length)),
			truncated: run.truncated,
			killed: run.killed
		};
	},

	/**
	 * 停掉某次运行。
	 *
	 * args: { runId }。已经结束的直接如实回答，不当成错误 —— 用户点「停止」时
	 * 脚本恰好自己跑完是很正常的事。
	 */
	async projectRunScriptStop(ctx, args) {
		const endpoint = NAMESPACE + "/projectRunScriptStop";
		const runId = args !== null && typeof args === "object" && typeof args.runId === "string" ? args.runId : "";
		const run = runs.get(runId);
		if (run === undefined) {
			throw new PanelError("not-found", "找不到这次运行（记录可能已经过期）：" + (runId === "" ? "空" : runId), { runId });
		}
		if (run.done) return { ok: true, killed: false, code: run.code };
		run.killed = true;
		run.log += "\n[已请求停止]\n";
		killTree(run.child);
		return { ok: true, killed: true, code: null };
	},

	/**
	 * 面板自己维护的配置。args: { path? }。
	 *
	 * 给 path 就顺带返回该工作区的绑定与 .env 概览。**绝不返回密码** —— 只给
	 * hasPassword；密码明文存在 DSH_HOME 下（与 .env 同级，位置在本机），
	 * 界面上打码、能一键清空。
	 */
	async projectGetConfig(ctx, args) {
		const endpoint = NAMESPACE + "/projectGetConfig";
		const raw = args !== null && typeof args === "object" ? args.path : undefined;
		const config = await readConfig();
		let root = "";
		if (typeof raw === "string" && raw.trim() !== "") {
			root = resolve(raw);
			ownerOf(ctx, root, endpoint);
		}
		const key = root === "" ? "" : workspaceKey(root);
		const stored = key === "" ? undefined : config.workspaces[key];
		const binding = stored === undefined
			? { serverId: "", projectUuid: "" }
			: { serverId: stored.serverId, projectUuid: stored.projectUuid };
		let env = null;
		let hasEnv = false;
		if (root !== "") {
			const text = await readOpt(join(root, ".env"));
			hasEnv = text !== null;
			const parsed = text === null ? { values: {}, projects: [] } : parseEnvText(text);
			const pick = (name) => (parsed.values[name] === undefined ? "" : parsed.values[name]);
			env = {
				ENV: pick("ENV"),
				SERVER_URL: pick("SERVER_URL"),
				PROJECT_UUID: pick("PROJECT_UUID"),
				hasUsername: pick("USERNAME") !== "",
				hasPassword: pick("PASSWORD") !== "",
				projects: parsed.projects
			};
		}
		const modules = await scaffoldModules();
		return {
			path: root,
			servers: config.servers.map(publicServer),
			binding,
			hasEnv,
			env,
			scaffold: {
				modules,
				ready: modules !== "",
				busy: scaffoldInstall.busy,
				code: scaffoldInstall.code,
				error: scaffoldInstall.error,
				log: scaffoldInstall.log.slice(-4000)
			}
		};
	},

	/**
	 * 新增 / 改一个服务器档案。
	 *
	 * args: { id?, label, serverUrl, username, password?, env? }。
	 * `password` 不是字符串就原样保留（改个标签不用重敲密码）；给空串才是清掉。
	 */
	async projectSaveServer(ctx, args) {
		const endpoint = NAMESPACE + "/projectSaveServer";
		const source = args !== null && typeof args === "object" ? args : {};
		const id = typeof source.id === "string" ? source.id : "";
		const serverUrl = envValue(source.serverUrl ?? "");
		if (serverUrl === "") {
			throw new PanelError("bad-request", endpoint + " 需要 serverUrl（形如 http://主机:端口）", {});
		}
		const saved = await updateConfig((config) => {
			let server = id === "" ? undefined : config.servers.find((item) => item.id === id);
			if (server === undefined) {
				server = { id: id === "" ? newServerId() : id, label: "", serverUrl: "", username: "", password: "", env: "", projects: [] };
				config.servers.push(server);
			}
			server.label = envValue(source.label ?? "");
			server.serverUrl = serverUrl;
			server.username = envValue(source.username ?? "");
			server.env = envValue(source.env ?? "");
			if (typeof source.password === "string") server.password = secretValue(source.password);
			return server;
		});
		return { server: publicServer(saved) };
	},

	/**
	 * 删一个服务器档案（args: { id }）。
	 * 引用它的工作区绑定一并清空 —— 留着会指到一个不存在的档案上。
	 */
	async projectDeleteServer(ctx, args) {
		const endpoint = NAMESPACE + "/projectDeleteServer";
		const id = args !== null && typeof args === "object" && typeof args.id === "string" ? args.id : "";
		if (id === "") throw new PanelError("bad-request", endpoint + " 需要 id", {});
		const removed = await updateConfig((config) => {
			const before = config.servers.length;
			config.servers = config.servers.filter((item) => item.id !== id);
			for (const key of Object.keys(config.workspaces)) {
				if (config.workspaces[key].serverId === id) config.workspaces[key].serverId = "";
			}
			return before !== config.servers.length;
		});
		return { ok: true, removed };
	},

	/**
	 * 手动维护某个服务器档案下的项目清单。
	 *
	 * args: { serverId, projects: [{ uuid, name? }] } —— **全量替换**（改名的语义就是
	 * 用同一个 uuid 再存一次）。返回 { server, projects }。
	 *
	 * 为什么要有它：候选项目原先只从 `.env` 的注释里捡，而新铺出来的 `.env` 一条注释
	 * 都没有 —— 下拉里空着，脚本就没得拉，整条路卡在第一步。清单挂在**档案**上而不是
	 * 工作区上：项目是服务器上的资源，同一台服务器下的工作区看到的是同一份。
	 */
	async projectSetProjects(ctx, args) {
		const endpoint = NAMESPACE + "/projectSetProjects";
		const raw = args !== null && typeof args === "object" ? args : {};
		const serverId = typeof raw.serverId === "string" ? raw.serverId : "";
		if (serverId === "") throw new PanelError("bad-request", endpoint + " 需要 serverId", {});
		const cleaned = cleanProjects(raw.projects);
		const saved = await updateConfig((config) => {
			const server = config.servers.find((item) => item.id === serverId);
			if (server === undefined) {
				throw new PanelError("not-found", endpoint + " 找不到这个服务器档案：" + serverId, { serverId });
			}
			server.projects = cleaned;
			return server;
		});
		return { server: publicServer(saved), projects: cleaned };
	},

	/**
	 * 记住「这个工作区用哪个档案、哪个项目」。
	 * args: { path, serverId, projectUuid }。只动配置，不碰 .env —— 落盘走 projectApplyConfig。
	 */
	async projectBindWorkspace(ctx, args) {
		const endpoint = NAMESPACE + "/projectBindWorkspace";
		const root = requirePath(args, endpoint);
		ownerOf(ctx, root, endpoint);
		const raw = args !== null && typeof args === "object" ? args : {};
		const serverId = typeof raw.serverId === "string" ? raw.serverId : "";
		const projectUuid = envValue(raw.projectUuid ?? "");
		const binding = await updateConfig((config) => {
			if (serverId !== "" && !config.servers.some((item) => item.id === serverId)) {
				throw new PanelError("not-found", endpoint + " 找不到这个服务器档案：" + serverId, { serverId });
			}
			config.workspaces[workspaceKey(root)] = { serverId, projectUuid };
			return { serverId, projectUuid };
		});
		return { path: root, binding };
	},

	/**
	 * 把配置写进工作区的 .env（脚本只认 .env 与 process.env）。
	 *
	 * args: { path, serverId?, projectUuid? } —— 不给就用已绑定的。
	 * 有 .env 先备份、注释行不动。返回写进去的键名，**不含密码值**。
	 */
	async projectApplyConfig(ctx, args) {
		const endpoint = NAMESPACE + "/projectApplyConfig";
		const root = requirePath(args, endpoint);
		ownerOf(ctx, root, endpoint);
		const raw = args !== null && typeof args === "object" ? args : {};
		const serverId = typeof raw.serverId === "string" ? raw.serverId : "";
		const projectUuid = typeof raw.projectUuid === "string" ? raw.projectUuid : "";
		const applied = await applyConfigToEnv(root, serverId, projectUuid);
		if (applied === null) {
			throw new PanelError(
				"no-server",
				endpoint + " 还没有可用的服务器档案（先在页签里加一个地址 / 账号）",
				{ path: root }
			);
		}
		return {
			path: applied.path,
			created: applied.created,
			backup: applied.backup,
			written: applied.written,
			unchanged: applied.unchanged,
			projectUuid: applied.projectUuid,
			server: publicServer(applied.server)
		};
	},

	/**
	 * 把插件自带的脚手架铺到工作区根下。
	 *
	 * args: { path }。**已存在的文件一律不动** —— 平台拉过的目录里那几个
	 * source-*.js 可能已经比模板新。只补缺的，返回 {copied, skipped, modules, needDeps}。
	 * 重复点只会一直回 `copied: []` + 9 个 skipped，**不会重复生成、也不会覆盖**；
	 * 真正干活的是 scaffoldCopy，并发去重由 scaffoldInto 管。
	 */
	async projectScaffold(ctx, args) {
		const endpoint = NAMESPACE + "/projectScaffold";
		const root = requirePath(args, endpoint);
		ownerOf(ctx, root, endpoint);
		return await scaffoldInto(root, endpoint);
	},

	/**
	 * 装模板要用的 npm 依赖（axios / archiver / form-data / unzipper）。
	 *
	 * **只装一次**，装在插件自己目录里；新工作区靠 NODE_PATH 复用，不必每个目录
	 * 都 npm install。不等它跑完 —— 起好就回 {busy:true}，进度看 projectGetConfig
	 * 的 scaffold 字段（busy / code / log / error）。
	 */
	async projectScaffoldDeps(ctx, args) {
		const endpoint = NAMESPACE + "/projectScaffoldDeps";
		const modules = await scaffoldModules();
		if (modules !== "") return { ok: true, reused: true, modules, busy: false, code: 0 };
		if (scaffoldInstall.busy) return { ok: true, reused: false, modules: "", busy: true, code: null };
		const npm = await npmCli();
		if (npm === "") {
			throw new PanelError(
				"no-npm",
				endpoint + " 找不到 npm（没在 " + dirname(process.execPath) + " 里找到 npm-cli.js），请在插件目录手动跑一次 npm install",
				{ node: process.execPath }
			);
		}
		const pid = startScaffoldInstall(npm);
		return { ok: true, reused: false, modules: "", busy: true, code: null, pid };
	}
};

/* ------------------------------------------------- HTTP 信封 */

/** 拆 client-request 信封取 args；裸参数体也认。 */
async function readArgs(request) {
	let text = "";
	try {
		text = await request.text();
	} catch {
		return {};
	}
	if (text.trim() === "") return {};
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		throw new PanelError("bad-request", "请求体不是合法 JSON", {});
	}
	if (body === null || typeof body !== "object") return {};
	const args = body.payload !== null && typeof body.payload === "object" ? body.payload.args : undefined;
	if (args !== null && typeof args === "object") return args;
	return body;
}

function jsonResponse(payload, status) {
	return Response.json(payload, {
		status: status ?? 200,
		headers: { "cache-control": "no-store" }
	});
}

async function serve(ctx, method, request) {
	try {
		const handler = HANDLERS[method];
		if (handler === undefined) {
			return jsonResponse({ ok: false, error: { code: "not-implemented", message: "未实现的主机方法：" + method } });
		}
		const args = await readArgs(request);
		const value = await handler(ctx, args);
		return jsonResponse({ ok: true, value });
	} catch (error) {
		if (error instanceof PanelError) {
			return jsonResponse({ ok: false, error: { code: error.code, message: error.message, detail: error.detail } });
		}
		return jsonResponse({ ok: false, error: { code: "internal", message: messageOf(error) } });
	}
}

/* ------------------------------------------------- 装配 */

export function apply(ctx) {
	const connection = serviceOf(ctx, "connection");
	if (connection === undefined || connection.fetch === undefined || typeof connection.fetch.register !== "function") {
		/* 不抛错：抛错会让插件激活失败，进而拖累整个 profile。 */
		console.warn("[dsh-project-panel] connection.fetch.register 不可用，工程面板 RPC 未挂载。");
		return;
	}
	for (const method of Object.keys(HANDLERS)) {
		ctx.effect(
			() => connection.fetch.register({
				path: ROUTE_PREFIX + method,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: (request) => serve(ctx, method, request)
			}),
			"dsh-project-panel: " + method + " route"
		);
	}
}
