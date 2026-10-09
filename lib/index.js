// dsh-magical-lowcode-project — DSH 低代码工程模式宿主插件（host 半边）
// 衍生自 DSH Desktop 的 plugins/dsh-desktop-project（MIT, Copyright (c) 2026 DataElement）。
// 原 rc.6 时代打在 dsh-host-apiproxy 补丁里的工程模式 RPC，迁移为独立插件：
// alpha.5 架构下 host.* 点号命名空间已废除，这里用 TypertRemoteService 的
// SRC 模式（源码参数名即 wire 字段）注册 desktopProject/<method> 端点，
// 客户端通过 /api fetch envelope（POST /api/desktopProject/<method>）直调。
//
// 12 个工程模式 RPC（业务体从旧 apiproxy 补丁整体搬运）：
//   listProjectEntries   工程模式文件树（一层目录含文件，限工作区内）
//   projectPushStatus    推送状态扫描（page.json uuid / meta.json id，mtime 快照比对）
//   projectRunScript     白名单 source-*.js 脚本执行（spawn process.execPath）
//   projectMarkPushed    标记已推送（含祖先/子孙快照递归更新）
//   projectResetPushState 重置全部推送状态
//   projectRenameEntry   重命名（Windows EPERM/EBUSY 退避重试 + page.json/meta.json 同步）
//   projectSetProjectName 虚拟项目名（.dsh-project-names.json，只影响显示）
//   projectDeleteEntry   删除（禁删工作区根）
//   projectReadFile      读文件（UTF-8，限 2MB）
//   projectWriteFile     写文件（UTF-8）
//   projectAssemblePreview 页面预览沙箱组装（三件套内联 + 平台 runtime）
//   projectLint          推送前静态校验（V1.01~V1.06 踩坑规则）
//
// 另有两条带认证的 Fetch 路由（connection.fetch.register，与
// /api/session.export 同机制）：
//   GET  /api/agent-preset.export?agentPreset=<id>   导出 .dshpreset 包
//   POST /api/agent-preset.import?agentPreset=&install=1  导入（dry-run 预览/落盘）
//
// 0.2.0 起上游把 preset 从「磁盘目录 + agent-presets 服务」改成
// 「profile patch 里的一行 @deepseek-ai/dsh-agent-preset 声明 + agentPresets 注册表」：
//   - 导出 = agentPresets.readDocument(id) 拿到的插件清单 YAML，打成一个包内
//     只有 preset/agent.cordis.yml 的 .dshpreset（沿用旧包路径，新旧可互换）。
//   - 导入 = 把这份清单作为一行声明 INSERT 进 profile 的 cordis.patch.yml，
//     由 profile 配置重载生效（不再有用户可写 preset 根目录的概念）。
//
// 推送状态文件：rc.6 存 ~/.dsh-desktop-push-state.json（全局单实例）；
// 现挪到 DSH_HOME 下（dev/stable 多实例互不干扰），读取时兼容旧路径迁移。
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { isMap, isSeq, parseDocument } from "yaml";

const name = "dsh-magical-lowcode-project";
const inject = ["workspaceRegistry", "connection"];

/* 导出 .dshpreset 时写进 manifest 的“来源 DSH 版本”，导入时不一致只产生
 * version-mismatch 警告。取本插件所对照的 @deepseek-ai/dsh-* 版本线。 */
const DSH_SOURCE_VERSION = "0.2.0-rc.2";

/* ---- 推送状态持久化（T4/T5 mtime 快照） ---- */
const PUSH_STATE_FILE = join(
	resolve(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh")),
	"project-push-state.json"
);
/* rc.6 旧位置：首次读取做一次性迁移，写入永远走新位置 */
const PUSH_STATE_FILE_LEGACY = resolve(process.env.USERPROFILE || process.env.HOME || ".", ".dsh-desktop-push-state.json");
let pushStateMigrated = false;

async function projectReadPushState() {
	try {
		return JSON.parse(await readFile(PUSH_STATE_FILE, "utf8"));
	} catch {
		if (!pushStateMigrated) {
			pushStateMigrated = true;
			try {
				const legacy = JSON.parse(await readFile(PUSH_STATE_FILE_LEGACY, "utf8"));
				await writeFile(PUSH_STATE_FILE, JSON.stringify(legacy, null, 2), "utf8");
				return legacy;
			} catch { /* no legacy state */ }
		}
		return {};
	}
}

async function projectWritePushState(state) {
	try {
		await mkdir(dirname(PUSH_STATE_FILE), { recursive: true });
		await writeFile(PUSH_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
	} catch { /* best effort */ }
}

async function projectSnapshotDir(dir) {
	const files = {};
	const walk = async (d, rel) => {
		let dirents;
		try { dirents = await readdir(d, { withFileTypes: true }); } catch { return; }
		for (const dirent of dirents) {
			if (/^(\.|.*\.temp-)/.test(dirent.name)) continue;
			const abs = join(d, dirent.name);
			const r = rel ? rel + "/" + dirent.name : dirent.name;
			if (dirent.isDirectory()) await walk(abs, r);
			else if (dirent.isFile()) {
				try { const st = await stat(abs); files[r] = Math.round(st.mtimeMs); } catch { /* vanished */ }
			}
		}
	};
	await walk(dir, "");
	return files;
}

function projectComputeStatus(state, key, cur) {
	const rec = state[key];
	if (!rec) { state[key] = { files: cur }; return { status: "pushed", changed: true }; }
	const all = new Set([...Object.keys(cur), ...Object.keys(rec.files || {})]);
	for (const k of all) if ((cur[k] || 0) !== (rec.files[k] || 0)) return { status: "dirty", changed: false };
	return { status: "pushed", changed: false };
}

async function readJsonIfPossible(dir, file) {
	try { return JSON.parse(await readFile(join(dir, file), "utf8")); } catch { return null; }
}

/* fs 错误 → RemoteError（原 directoryError 辅助的精简版） */
function directoryError(error) {
	const code = error && typeof error.code === "string" ? error.code : "";
	if (code === "ENOENT" || code === "ENOTDIR") return new RemoteError("not-found", "路径不存在：" + (errorMessage(error)), {});
	if (code === "EACCES" || code === "EPERM") return new RemoteError("forbidden", "没有访问权限：" + (errorMessage(error)), {});
	return new RemoteError("internal", errorMessage(error), {});
}

function internalError(prefix, error) {
	return new RemoteError("internal", `${prefix} failed: ${errorMessage(error)}`, {});
}

//#region preset-archive（原 apiproxy 补丁 preset-archive.js 整体搬运）
const PRESET_ARCHIVE_FORMAT = "dsh-preset";
const PRESET_ARCHIVE_VERSION = 1;
const PRESET_ARCHIVE_MIME = "application/vnd.dsh.preset+zip";
const PRESET_ARCHIVE_MAX_COMPRESSED = 16 * 1024 * 1024;
const PRESET_ARCHIVE_MAX_UNCOMPRESSED = 32 * 1024 * 1024;
const PRESET_ARCHIVE_MAX_FILE = 12 * 1024 * 1024;
const PRESET_ARCHIVE_MAX_FILES = 512;
const PRESET_ARCHIVE_ID = /^[a-z0-9][a-z0-9-]*$/;
/* .dshpreset 包内承载 preset 声明的文件。沿用 0.1.x 的 COMPOSITION_FILE 值，
 * 使旧版本导出的包仍可导入、新包也能被旧版本读出。 */
const PRESET_COMPOSITION_FILE = "agent.cordis.yml";
/* profile patch 允许 !!js 表达式（动态解析模块路径等），读写都必须原样保留。 */
const PRESET_YAML_JS_TAG = {
	tag: "tag:yaml.org,2002:js",
	resolve: (value) => value
};
const PRESET_ARCHIVE_IGNORED_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const PRESET_TEXT_EXTENSIONS = new Set([".json", ".jsonc", ".md", ".txt", ".yaml", ".yml", ".toml", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".sh", ".ps1", ".html", ".css"]);

function presetArchiveFailure(message, status = 400) {
	return Response.json({
		ok: false,
		error: message
	}, { status });
}

/* RemoteError 跨 bundle/realm 时 instanceof 不可靠（上游明确要求按 code 判别），
 * 统一用一个取值器把任意 catch 到的值转成人类可读消息。 */
function errorMessage(error) {
	if (error instanceof Error) return error.message;
	const failure = remoteErrorOf(error);
	return failure !== undefined && typeof failure.message === "string" ? failure.message : String(error);
}

function safePresetArchivePath(name) {
	if (name === "" || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return false;
	const segments = name.split("/");
	return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function presetArchiveWarnings(files) {
	let hasAbsolutePath = false;
	let hasPossibleSecret = false;
	for (const [name, data] of Object.entries(files)) {
		if (!PRESET_TEXT_EXTENSIONS.has(extname(name).toLowerCase()) || data.length > 1024 * 1024 || data.includes(0)) continue;
		const text = strFromU8(data);
		if (/(?:^|[\s"'(:=])(?:\/Users\/|\/home\/)/m.test(text) || /[A-Za-z]:[\\/]/.test(text) || /\\\\[^\\\s]+[\\/]/.test(text)) hasAbsolutePath = true;
		if (/(?:api[_-]?key|secret|token)\s*[:=]\s*["']?[^\s"']{12,}|\bsk-[A-Za-z0-9_-]{16,}/i.test(text)) hasPossibleSecret = true;
	}
	return [
		...hasAbsolutePath ? ["absolute-paths"] : [],
		...hasPossibleSecret ? ["possible-secrets"] : []
	];
}

/* .dshpreset 包内的 preset 声明 = 一份 YAML 插件清单（0.2.0 起 preset 本身就是
 * profile patch 里的一行 @deepseek-ai/dsh-agent-preset 声明，声明体即 plugins 列表）。 */
function presetArchiveDeclaration(files) {
	const bytes = files[PRESET_COMPOSITION_FILE];
	if (bytes === void 0) throw new Error(`Preset package is missing ${PRESET_COMPOSITION_FILE}`);
	const document = parseDocument(strFromU8(bytes), { customTags: [PRESET_YAML_JS_TAG] });
	if (document.errors.length > 0) throw new Error(`Preset declaration is not valid YAML: ${document.errors[0].message}`);
	if (document.contents === null || !isSeq(document.contents)) throw new Error("Preset declaration must be a YAML sequence of plugin entries.");
	return document.contents;
}

/* profile 的 cordis.patch.yml 绝对路径（dsh profile-boot 提供的公开字段）。 */
function profilePatchPath(ctx) {
	const patchPath = ctx.get("profileContext")?.patchPath;
	if (typeof patchPath !== "string" || patchPath === "") throw new Error("This deployment has no writable profile patch file.");
	return patchPath;
}

/* 把一条 preset 声明 INSERT 进 profile patch。官方 dsh-plugin-manager 改写同一
 * 文件用的就是这套手法：yaml 的 parseDocument + document.add + 原子替换。 */
async function presetImportWritePatch(ctx, agentPreset, declaration) {
	const filename = profilePatchPath(ctx);
	let text;
	try {
		text = await readFile(filename, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		text = "[]\n";
	}
	const document = parseDocument(text, { customTags: [PRESET_YAML_JS_TAG] });
	if (document.errors.length > 0) throw new Error(`The profile patch is not valid YAML: ${document.errors[0].message}`);
	/* 顶层必须是序列（loader 的 patch 协议要求）；空文档补一个空序列。 */
	if (document.contents === null) document.contents = document.createNode([]);
	if (!isSeq(document.contents)) throw new Error("The profile patch must be a YAML sequence.");
	const rowId = `preset-${agentPreset}`;
	for (const row of document.contents.items) {
		if (!isMap(row)) continue;
		const inserted = row.get("insert", true);
		if (!isSeq(inserted)) continue;
		for (const candidate of inserted.items) {
			if (isMap(candidate) && candidate.get("id") === rowId) return false;
		}
	}
	document.contents.add({
		insert: [{
			id: rowId,
			name: "@deepseek-ai/dsh-agent-preset",
			config: {
				id: agentPreset,
				...declaration.name === void 0 ? {} : { name: declaration.name },
				...declaration.description === void 0 ? {} : { description: declaration.description },
				plugins: declaration.plugins
			}
		}]
	});
	const temporary = `${filename}.${process.pid}.tmp`;
	await writeFile(temporary, String(document), { mode: 0o600 });
	try {
		await rename(temporary, filename);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
	return true;
}

function parsePresetArchive(data) {
	if (data.length > PRESET_ARCHIVE_MAX_COMPRESSED) throw new Error("Preset package is larger than 16 MB");
	let count = 0;
	let total = 0;
	const archive = unzipSync(data, { filter(file) {
		if (!safePresetArchivePath(file.name)) throw new Error(`Preset package contains an unsafe path: ${file.name}`);
		if (++count > PRESET_ARCHIVE_MAX_FILES + 1) throw new Error(`Preset package contains more than ${PRESET_ARCHIVE_MAX_FILES} files`);
		if (file.originalSize > PRESET_ARCHIVE_MAX_FILE) throw new Error(`Preset package contains an oversized file: ${file.name}`);
		total += file.originalSize;
		if (total > PRESET_ARCHIVE_MAX_UNCOMPRESSED) throw new Error("Expanded preset package is larger than 32 MB");
		return true;
	} });
	const manifestBytes = archive["manifest.json"];
	if (manifestBytes === void 0) throw new Error("Preset package has no manifest.json");
	let manifest;
	try {
		manifest = JSON.parse(strFromU8(manifestBytes));
	} catch {
		throw new Error("Preset package manifest is not valid JSON");
	}
	if (typeof manifest !== "object" || manifest === null || manifest.format !== PRESET_ARCHIVE_FORMAT || manifest.version !== PRESET_ARCHIVE_VERSION || typeof manifest.id !== "string" || !PRESET_ARCHIVE_ID.test(manifest.id)) throw new Error("Preset package manifest is unsupported or invalid");
	if (manifest.name !== void 0 && (typeof manifest.name !== "string" || manifest.name.length > 160)) throw new Error("Preset package manifest has an invalid name");
	if (manifest.description !== void 0 && (typeof manifest.description !== "string" || manifest.description.length > 4e3)) throw new Error("Preset package manifest has an invalid description");
	if (manifest.sourceDshVersion !== void 0 && (typeof manifest.sourceDshVersion !== "string" || manifest.sourceDshVersion.length > 64)) throw new Error("Preset package manifest has an invalid DSH version");
	const files = Object.create(null);
	for (const [name, bytes] of Object.entries(archive)) {
		if (name === "manifest.json") continue;
		if (!name.startsWith("preset/") || name === "preset/") throw new Error(`Unexpected file outside the preset directory: ${name}`);
		const rel = name.slice("preset/".length);
		if (!safePresetArchivePath(rel)) throw new Error(`Preset package contains an unsafe path: ${rel}`);
		if (PRESET_ARCHIVE_IGNORED_FILES.has(rel.split("/").at(-1))) continue;
		files[rel] = bytes;
	}
	if (files[PRESET_COMPOSITION_FILE] === void 0) throw new Error(`Preset package is missing ${PRESET_COMPOSITION_FILE}`);
	return {
		manifest,
		files,
		warnings: presetArchiveWarnings(files)
	};
}
//#endregion

//#region 工程模式 RPC 服务（SRC 模式：参数名为纯标识符，即 wire 字段）
/* Node 22 不支持原生装饰器语法（上游 lib 是 tsdown 编译产物），这里用 Remote 的
 * 公开函数形态手工应用：模拟装饰器上下文，捕获 addInitializer 回调后以
 * Object.create(prototype) 为 this 执行，把方法标记写到类原型上。 */
function markRemote(Class, methodName) {
	const method = Object.getOwnPropertyDescriptor(Class.prototype, methodName).value;
	let initializer = null;
	Remote(method, {
		kind: "method",
		name: methodName,
		static: false,
		private: false,
		access: {
			has: (obj) => methodName in obj,
			get: (obj) => obj[methodName]
		},
		addInitializer(fn) { initializer = fn; }
	});
	initializer.call(Object.create(Class.prototype));
}

/* 工作区内路径校验：返回命中的 workspace entity，未命中抛错。
 * 注意不能做成 #private 方法——gateway 经 cordis traceable 代理调用，
 * 代理 this 会触发 V8 私有成员的 receiver 实例检查直接报
 * "Receiver must be an instance of class ..."。 */

/* 路径比较规范化：Windows 大小写不敏感，正反斜杠混用也会让朴素 startsWith 误报
 * path-outside-workspace。两侧统一分隔符与（win32 上的）大小写后再比较。
 * 已知局限：不解析符号链接/8.3 短名，workspace.path 已 realpath 化而入参未解析时
 * 仍可能误判，需要更严格时可在这里补 fs.realpath。 */
const PATH_CASE_INSENSITIVE = process.platform === "win32";

function normalizeForCompare(value) {
	const unified = value.replace(/[\\/]+/g, sep).replace(/[\\/]+$/, "");
	return PATH_CASE_INSENSITIVE ? unified.toLowerCase() : unified;
}

function ownerOf(ctx, resolved, endpoint) {
	const target = normalizeForCompare(resolved);
	const owner = ctx.workspaceRegistry.list().find((workspace) => {
		const base = normalizeForCompare(workspace.path);
		return target === base || target.startsWith(base + sep);
	});
	if (!owner) throw new RemoteError("path-outside-workspace", `${endpoint} requires a path inside a registered workspace`, { path: resolved });
	return owner;
}

class DesktopProjectService extends TypertRemoteService {
	static inject = ["workspaceRegistry"];

	constructor(ctx) {
		super(ctx, "desktopProjectController", { namespace: "desktopProject" });
	}

	/**
	* 工程模式文件树：一层目录（含文件）。host 的目录浏览（browse）仍是
	* 只列目录的能力，这里才是文件树的取数通道。
	*/
	async listProjectEntries(path) {
		const resolved = resolve(path);
		ownerOf(this.ctx, resolved, "desktopProject/listProjectEntries");
		try {
			const dirents = await readdir(resolved, { withFileTypes: true });
			dirents.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }));
			const entries = [];
			let truncated = false;
			for (const dirent of dirents) {
				if (entries.length >= 1000) {
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
		} catch (error) {
			throw directoryError(error);
		}
	}

	/**
	* T4-T7 推送状态：扫描 pages/apis/databases 三区，page.json uuid /
	* meta.json id 为推送键，mtime 快照比对得出 pushed/dirty。
	*/
	async projectPushStatus(dir) {
		const resolved = resolve(dir);
		ownerOf(this.ctx, resolved, "desktopProject/projectPushStatus");
		try {
			const state = await projectReadPushState();
			let stateChanged = false;
			const nodes = [];
			const ZONES = new Set(["pages", "apis", "databases"]);
			const MAX_DEPTH = 12;
			const readJsonSafe = async (file) => {
				try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
			};
			const scanZoneDir = async (dir2, rel, depth) => {
				if (depth > MAX_DEPTH) return null;
				let dirents;
				try { dirents = await readdir(dir2, { withFileTypes: true }); } catch { return null; }
				const children = [];
				let selfNode = null;
				const pageJson = dirents.find((d) => d.name === "page.json" && d.isFile());
				const metaJson = pageJson ? void 0 : dirents.find((d) => d.name === "meta.json" && d.isFile());
				if (pageJson) {
					const pj = await readJsonSafe(join(dir2, "page.json"));
					if (pj && typeof pj.uuid === "string" && pj.uuid) selfNode = { scope: "page", target: pj.uuid, name: pj.name };
				} else if (metaJson) {
					const mj = await readJsonSafe(join(dir2, "meta.json"));
					if (mj && typeof mj.id === "string" && mj.id) selfNode = { scope: "api", target: mj.id, name: mj.name };
				}
				const childResults = [];
				for (const dirent of dirents) {
					if (!dirent.isDirectory() || /^(\.|.*\.temp-)/.test(dirent.name)) continue;
					const child = await scanZoneDir(join(dir2, dirent.name), rel ? rel + "/" + dirent.name : dirent.name, depth + 1);
					if (child) childResults.push(child);
				}
				for (const child of childResults) children.push(...child.nodes);
				const hasPushableDescendant = children.some((n) => n.pushable);
				if (selfNode) {
					const key = selfNode.scope + ":" + selfNode.target;
					const cur = await projectSnapshotDir(dir2);
					const verdict = projectComputeStatus(state, key, cur);
					if (verdict.changed) stateChanged = true;
					let status = verdict.status;
					if (hasPushableDescendant && children.some((n) => n.pushable && n.status !== "pushed")) status = "dirty";
					const node = {
						key,
						scope: selfNode.scope,
						target: selfNode.target,
						name: selfNode.name || rel.split("/").pop() || key,
						relPath: rel,
						dir: dir2,
						status,
						aggregate: false,
						pushable: true
					};
					nodes.push(node);
					return { nodes: [node, ...children], pushable: true, anyDirty: status !== "pushed" };
				}
				if (childResults.length === 0) return null;
				const allPushed = children.every((n) => !n.pushable || n.status === "pushed");
				if (!hasPushableDescendant) return { nodes: children, pushable: false, anyDirty: false };
				const agg = {
					key: "agg:" + rel,
					scope: "aggregate",
					target: rel,
					name: rel.split("/").pop(),
					relPath: rel,
					dir: dir2,
					status: allPushed ? "pushed" : "dirty",
					aggregate: true,
					pushable: true
				};
				nodes.push(agg);
				return { nodes: [agg, ...children], pushable: true, anyDirty: !allPushed };
			};
			const findZones = async (dir2, rel, depth) => {
				if (depth > 4) return;
				let dirents;
				try { dirents = await readdir(dir2, { withFileTypes: true }); } catch { return; }
				for (const dirent of dirents) {
					if (!dirent.isDirectory() || /^(\.)/.test(dirent.name)) continue;
					const childRel = rel ? rel + "/" + dirent.name : dirent.name;
					if (ZONES.has(dirent.name)) {
						const result = await scanZoneDir(join(dir2, dirent.name), childRel, 0);
						if (result) nodes.push(...result.nodes);
					} else if (dirent.name === "node_modules" || dirent.name === "release" || dirent.name === "dist" || dirent.name === ".git") {
						continue;
					} else {
						await findZones(join(dir2, dirent.name), childRel, depth + 1);
					}
				}
			};
			/* 项目定位：工作区下可能同时存在多个 L1 项目目录（纯 UUID 或「名称（uuid）」），
			 * 全部扫描（每个目录独立 findZones），保证每个项目的页面/API 都有推送状态；
			 * .env 的 PROJECT_UUID 仅用于返回 projectUuid 字段，不再决定扫描范围。 */
			let projectUuid = "";
			try {
				const envText = await readFile(join(resolved, ".env"), "utf8");
				const m = envText.match(/^\s*PROJECT_UUID\s*=\s*(\S+)\s*$/m);
				if (m) projectUuid = m[1];
			} catch { /* no .env */ }
			const L1_PROJECT_NAME_RE = /^([0-9a-f]{32}|.+?（[0-9a-f]{32}）)$/i;
			const l1ProjectDirs = [];
			try {
				const top = await readdir(resolved, { withFileTypes: true });
				for (const de of top) {
					if (!de.isDirectory() || /^(\.)/.test(de.name)) continue;
					if (L1_PROJECT_NAME_RE.test(de.name)) l1ProjectDirs.push(de.name);
				}
			} catch { /* ignore */ }
			if (l1ProjectDirs.length === 0) {
				/* 没有识别到 L1 项目目录（如虚拟层/未拉取项目），fallback 全扫。 */
				await findZones(resolved, "", 0);
			} else {
				for (const projDir of l1ProjectDirs) {
					await findZones(join(resolved, projDir), projDir, 0);
				}
			}
			if (stateChanged) await projectWritePushState(state);
			const uniq = new Map();
			for (const node of nodes) uniq.set(node.key + "|" + node.relPath, node);
			/* 附带虚拟项目名映射（.dsh-project-names.json），供 UI 显示「项目名（uuid）」。 */
			let projectNameMap = {};
			try {
				const namesFile = join(resolved, ".dsh-project-names.json");
				projectNameMap = JSON.parse(await readFile(namesFile, "utf8"));
			} catch { /* no names file */ }
			return { nodes: [...uniq.values()], projectUuid, projectNames: projectNameMap };
		} catch (error) {
			if (error instanceof RemoteError) throw error;
			throw internalError("project push status", error);
		}
	}

	async projectRunScript(script, args, cwd) {
		if (!/^source-[a-z0-9-]+\.js$/.test(script)) throw new RemoteError("script-not-allowed", "desktopProject/projectRunScript only allows source-*.js project scripts", { script });
		const root = resolve(cwd);
		ownerOf(this.ctx, root, "desktopProject/projectRunScript");
		const scriptPath = resolve(root, script);
		if (!scriptPath.startsWith(root + sep) || dirname(scriptPath) !== root) throw new RemoteError("script-not-allowed", "script must resolve directly inside the workspace root", { script });
		/* 执行前清理历史推送残留：工作区内 .temp_page_push_* / .temp_api_push_* 目录
		 * （上次异常退出/强杀遗留），防止累积。 */
		try {
			const dirents = await readdir(root, { withFileTypes: true });
			for (const de of dirents) {
				if (!de.isDirectory()) continue;
				if (/^\.temp_(page|api)_push_/.test(de.name)) {
					await rm(join(root, de.name), { recursive: true, force: true }).catch(() => {});
				}
			}
		} catch { /* 清理失败不影响执行 */ }
		const finalArgs = (args ?? []).map((a) => String(a));
		const cmd = `node ${script}${finalArgs.length ? " " + finalArgs.join(" ") : ""}`;
		return await new Promise((settle) => {
			/* 用 host 自身的 node 可执行文件（process.execPath）跑脚本，
			 * 不依赖系统 PATH；shell:false 防注入。 */
			const child = spawn(process.execPath, [scriptPath, ...finalArgs], { cwd: root, shell: false });
			let out = "";
			let errOut = "";
			child.stdout.on("data", (d) => {
				out += d.toString();
				if (out.length > 400000) try { child.kill(); } catch { /* already gone */ }
			});
			child.stderr.on("data", (d) => {
				errOut += d.toString();
			});
			child.on("error", (e) => {
				settle({ ok: false, code: -1, cmd, output: "spawn 失败（请确认系统已安装 node 且在 PATH 中）：" + (e instanceof Error ? e.message : String(e)) });
			});
			child.on("close", (code) => {
				settle({ ok: code === 0, code: code ?? -1, cmd, output: (out + (errOut ? "\n" + errOut : "")).slice(0, 20000) });
			});
		});
	}

	async projectMarkPushed(workspacePath, relDir, scope, target) {
		const root = resolve(workspacePath);
		ownerOf(this.ctx, root, "desktopProject/projectMarkPushed");
		try {
			const state = await projectReadPushState();
			const selfDir = join(root, relDir || "");
			state[scope + ":" + target] = { files: await projectSnapshotDir(selfDir), pushedAt: Date.now() };
			const parts = String(relDir || "").split(/[\\/]/).filter(Boolean);
			for (let i = parts.length - 1; i >= 1; i--) {
				const ancRel = parts.slice(0, i).join("/");
				const ancDir = join(root, ancRel);
				let key = null;
				const pj = await readJsonIfPossible(ancDir, "page.json");
				if (pj && typeof pj.uuid === "string" && pj.uuid) key = "page:" + pj.uuid;
				if (!key) {
					const mj = await readJsonIfPossible(ancDir, "meta.json");
					if (mj && typeof mj.id === "string" && mj.id) key = "api:" + mj.id;
				}
				if (key) state[key] = { files: await projectSnapshotDir(ancDir), pushedAt: Date.now() };
			}
			/* 推送目录时（source-page-push/api-push.js 传目录 UUID 会推整个目录），
			 * 目录下所有子孙页面/API 一并被推送，此处必须递归更新子孙节点快照，
			 * 否则子节点 mtime 对比旧快照仍显示"未推"，父目录也因子孙 dirty 被强制标 dirty
			 * （表现为：推送成功但"未推"标签不变）。 */
			const markDescendants = async (dir) => {
				let dirents;
				try { dirents = await readdir(dir, { withFileTypes: true }); } catch { return; }
				for (const de of dirents) {
					if (!de.isDirectory() || /^(\.|.*\.temp-)/.test(de.name)) continue;
					const sub = join(dir, de.name);
					let key = null;
					const subPj = await readJsonIfPossible(sub, "page.json");
					if (subPj && typeof subPj.uuid === "string" && subPj.uuid) key = "page:" + subPj.uuid;
					if (!key) {
						const subMj = await readJsonIfPossible(sub, "meta.json");
						if (subMj && typeof subMj.id === "string" && subMj.id) key = "api:" + subMj.id;
					}
					if (key) state[key] = { files: await projectSnapshotDir(sub), pushedAt: Date.now() };
					await markDescendants(sub);
				}
			};
			await markDescendants(selfDir);
			await projectWritePushState(state);
			return { ok: true };
		} catch (error) {
			throw internalError("mark pushed", error);
		}
	}

	async projectResetPushState() {
		try {
			pushStateMigrated = true; /* 重置后不再做旧文件迁移 */
			await projectWritePushState({});
			return { ok: true };
		} catch (error) {
			throw internalError("reset push state", error);
		}
	}

	async projectRenameEntry(path, newName) {
		if (typeof newName !== "string" || newName.trim() === "" || /[\\/]/.test(newName)) throw new RemoteError("invalid-name", "名称不能包含路径分隔符", { newName });
		const resolved = resolve(path);
		const owner = ownerOf(this.ctx, resolved, "desktopProject/projectRenameEntry");
		try {
			const st = await stat(resolved);
			const newFull = join(dirname(resolved), newName);
			try {
				await stat(newFull);
				throw new RemoteError("target-exists", "目标已存在：" + newName, { target: newFull });
			} catch (error) {
				if (error instanceof RemoteError) throw error;
				/* not exists — proceed */
			}
			/* Windows 下 rename 目录易因目标被占用（资源管理器/IDE/杀毒/句柄未释放）而
			 * EPERM/EBUSY。退避重试若干次；仍失败则给出可操作的中文提示。 */
			const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
			let lastErr = null;
			let renamed = false;
			for (let attempt = 0; attempt < 6 && !renamed; attempt++) {
				try {
					await rename(resolved, newFull);
					renamed = true;
				} catch (e) {
					lastErr = e;
					const code = e && e.code;
					if (!code || !RETRYABLE.has(code)) break;
					if (attempt < 5) await new Promise((r) => setTimeout(r, 150 + attempt * 100));
				}
			}
			if (!renamed) {
				const hint = "目录被其他程序占用无法重命名：最常见是 VSCode / Claude Code / 资源管理器正打开着该工作区，Windows 会锁定被监视的目录。请关闭占用窗口后重试；";
				const msg = lastErr instanceof Error ? (lastErr.code || "") + ": " + lastErr.message : String(lastErr);
				throw new RemoteError("rename-busy", hint + "[" + msg + "]", { from: resolved, to: newFull });
			}
			if (st.isDirectory()) {
				for (const metaFile of ["page.json", "meta.json"]) {
					const mf = join(newFull, metaFile);
					try {
						const meta = JSON.parse(await readFile(mf, "utf8"));
						let touched = false;
						if (meta.name !== void 0 && meta.name !== newName) { meta.name = newName; touched = true; }
						if (meta.pageData && meta.pageData.name !== void 0 && meta.pageData.name !== newName) { meta.pageData.name = newName; touched = true; }
						if (touched) await writeFile(mf, JSON.stringify(meta, null, 2), "utf8");
					} catch { /* no meta file or parse error */ }
				}
			}
			return { ok: true, newPath: relative(owner.path, newFull).split(sep).join("/") };
		} catch (error) {
			if (error instanceof RemoteError) throw error;
			throw internalError("rename", error);
		}
	}

	/* 虚拟项目命名：把「项目名（uuid）」映射写入工作区 .dsh-project-names.json，
	 * 只影响左侧树的显示，不改动物理目录名（避免 Windows 目录占用导致 rename 失败）。 */
	async projectSetProjectName(workspacePath, uuid, name) {
		const root = resolve(workspacePath);
		const owner = this.ctx.workspaceRegistry.list().find((workspace) => root === workspace.path);
		if (!owner) throw new RemoteError("path-outside-workspace", "desktopProject/projectSetProjectName requires a registered workspace root", { path: root });
		try {
			const namesFile = join(root, ".dsh-project-names.json");
			let names = {};
			try { names = JSON.parse(await readFile(namesFile, "utf8")); } catch { /* no file yet */ }
			const clean = String(name || "").trim();
			if (clean) names[uuid] = clean;
			else delete names[uuid];
			await writeFile(namesFile, JSON.stringify(names, null, 2), "utf8");
			return { ok: true, names };
		} catch (error) {
			throw internalError("set project name", error);
		}
	}

	async projectDeleteEntry(path) {
		const resolved = resolve(path);
		const owner = this.ctx.workspaceRegistry.list().find((workspace) => resolved === workspace.path || resolved.startsWith(workspace.path + sep));
		if (!owner || resolved === owner.path) throw new RemoteError("path-outside-workspace", "desktopProject/projectDeleteEntry cannot delete a workspace root; remove the workspace instead", { path: resolved });
		try {
			const st = await stat(resolved);
			if (!st.isFile() && !st.isDirectory()) throw new RemoteError("unsupported-entry", "只支持删除文件或目录", {});
			await rm(resolved, { recursive: st.isDirectory(), force: false });
			return { ok: true };
		} catch (error) {
			if (error instanceof RemoteError) throw error;
			throw internalError("delete", error);
		}
	}

	/** 工程模式文件预览/编辑：读一个工作区内文件（UTF-8，限 2MB）。 */
	async projectReadFile(path) {
		const resolved = resolve(path);
		ownerOf(this.ctx, resolved, "desktopProject/projectReadFile");
		try {
			const st = await stat(resolved);
			if (!st.isFile()) throw new RemoteError("not-a-file", "只能读取文件", {});
			if (st.size > 2 * 1024 * 1024) throw new RemoteError("file-too-large", "文件超过 2MB，不支持预览", { size: st.size });
			const content = await readFile(resolved, "utf8");
			return { path: resolved, content };
		} catch (error) {
			if (error instanceof RemoteError) throw error;
			throw internalError("read file", error);
		}
	}

	/** 工程模式文件预览/编辑：写一个工作区内文件（UTF-8）。 */
	async projectWriteFile(path, content) {
		const resolved = resolve(path);
		const owner = this.ctx.workspaceRegistry.list().find((workspace) => resolved === workspace.path || resolved.startsWith(workspace.path + sep));
		if (!owner || resolved === owner.path) throw new RemoteError("path-outside-workspace", "desktopProject/projectWriteFile requires a file inside a registered workspace (not the root)", { path: resolved });
		try {
			await writeFile(resolved, typeof content === "string" ? content : "", "utf8");
			return { ok: true };
		} catch (error) {
			throw internalError("write file", error);
		}
	}

	/**
	* #1 页面预览沙箱：读取页面目录三件套 + 平台 runtime 链接（SERVER_URL），
	* 组装成可独立运行的完整 HTML（iframe srcdoc 用）。
	*/
	async projectAssemblePreview(dir) {
		const resolvedDir = resolve(dir);
		const owner = ownerOf(this.ctx, resolvedDir, "desktopProject/projectAssemblePreview");
		try {
			const readIfExists = async (fileName) => {
				try { return await readFile(join(resolvedDir, fileName), "utf8"); } catch { return null; }
			};
			const pjText = await readIfExists("page.json");
			if (pjText === null) throw new RemoteError("not-a-page", "该目录不是页面目录（缺少 page.json）", {});
			let pj = {};
			try { pj = JSON.parse(pjText); } catch { /* 容忍损坏的 page.json */ }
			const html = (await readIfExists("index.html")) || "<div id=\"magicalDragScene\"></div>";
			const css = (await readIfExists("page.css")) || "";
			const js = (await readIfExists("page.js")) || "";
			/* 从工作区 .env 解析平台服务器（runtime 资源与 API 前缀的基准）。 */
			let serverUrl = "";
			try {
				const envText = await readFile(join(owner.path, ".env"), "utf8");
				const m = envText.match(/^\s*SERVER_URL\s*=\s*(\S+)\s*$/m);
				if (m) serverUrl = m[1].replace(/\/+$/, "");
			} catch { /* no .env */ }
			const pageUuid = pj.uuid || "";
			/* 组装：平台 runtime（vue/axios/组件库）从平台服务拉取；本地三件套内联。
			 * page.js 按平台装配惯例：vueData 初始化 + vueMethod 合并在页面脚本内完成。 */
			const doc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>预览 · ${String(pj.name || resolvedDir.split(sep).pop() || "")}</title>
<script src="${serverUrl}/assets/drag/js/user/iframe/element/latest/components/import.js"></script>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
<style>
body { margin: 0; padding: 0; background: #fff; }
.mc-root { min-height: 100vh; }
</style>
<style>
${css}
</style>
</head>
<body>
${html}
<script>
/* DSH 工程模式本地预览：API 走平台线上（与发布后行为一致） */
window.__DSH_PM_PREVIEW__ = { serverUrl: ${JSON.stringify(serverUrl)}, pageUuid: ${JSON.stringify(pageUuid)} };
</script>
<script>
${js}
</script>
<script>
/* 平台装配尾部：初始化 vueData（参照平台 publish 装配模板） */
try {
  if (typeof vueData !== "undefined" && typeof myData !== "undefined") {
    vueData.scope = { row: {} };
    Object.assign(vueData, myData || {});
  }
  if (typeof vueWatch !== "undefined" && typeof myWatch !== "undefined") Object.assign(vueWatch, myWatch || {});
  if (typeof vueComputed !== "undefined" && typeof myComputed !== "undefined") Object.assign(vueComputed, myComputed || {});
} catch (e) { console.warn("[preview] assemble tail failed:", e); }
try { if (typeof vueMounted === "function") vueMounted(); } catch (e) { console.warn("[preview] mounted failed:", e); }
</script>
</body>
</html>`;
			return { html: doc, serverUrl, pageUuid };
		} catch (error) {
			if (error instanceof RemoteError) throw error;
			throw internalError("assemble preview", error);
		}
	}

	/**
	* #Lint：页面/API 目录推送前静态校验。
	* 规则来自 project-rules.md 踩坑纪要（V1.01~V1.06）与平台组装机制。
	* 返回 issues: [{ level: error|warn, file, rule, message, line }]
	*/
	async projectLint(dir) {
		const resolvedDir = resolve(dir);
		ownerOf(this.ctx, resolvedDir, "desktopProject/projectLint");
		try {
			const issues = [];
			const readOpt = async (fileName) => {
				try { return await readFile(join(resolvedDir, fileName), "utf8"); } catch { return null; }
			};
			const lineOf = (text, needle) => {
				const idx = text.indexOf(needle);
				if (idx < 0) return 0;
				return (text.slice(0, idx).split("\n").length);
			};
			const push = (level, file, rule, message, line) => {
				issues.push({ level, file, rule, message, line: line || 0 });
			};
			const pjRaw = await readOpt("page.json");
			const isPage = pjRaw !== null;
			const isApi = (await readOpt("meta.json")) !== null;
			if (!isPage && !isApi) throw new RemoteError("not-a-page-or-api", "该目录既不是页面目录（无 page.json）也不是 API 目录（无 meta.json）", {});
			if (isPage) {
				/* page.json 合法性 + uuid */
				try {
					const pj = JSON.parse(pjRaw);
					if (!pj.uuid) push("error", "page.json", "uuid-missing", "page.json 缺少 uuid 字段，平台无法定位页面");
				} catch {
					push("error", "page.json", "json-invalid", "page.json 不是合法 JSON，推送会失败");
				}
				const html = await readOpt("index.html");
				if (html !== null) {
					if (!/magicalDragScene/.test(html)) {
						push("warn", "index.html", "no-scene", "未包含 magicalDragScene 容器，平台布局器可能无法识别该页面结构");
					}
					/* V1.06：文本节点裸 {{}} */
					const textMatches = html.match(/>[^<]*\{\{[^}]*\}\}[^<]*</g) || [];
					for (const m of textMatches.slice(0, 5)) {
						push("error", "index.html", "bare-mustache", "文本节点出现裸 {{}}，会被 Vue 当插值解析：…" + m.slice(0, 50) + "…（应加 v-pre）", lineOf(html, m));
					}
					/* V1.06：属性裸 {{}} */
					const attrMatches = html.match(/(="[^"]*\{\{[^"]*"|='[^']*\{\{[^']*')/g) || [];
					for (const m of attrMatches.slice(0, 5)) {
						push("error", "index.html", "attr-mustache", "属性值出现裸 {{}}，会编译错误：…" + m.slice(0, 50) + "…（应使用 :prop=\"'...'\"）", lineOf(html, m));
					}
				}
				const js = await readOpt("page.js");
				if (js !== null) {
					try { new Function(js); } catch (e) {
						push("error", "page.js", "js-syntax", "JS 语法错误：" + (e instanceof Error ? e.message : String(e)));
					}
					if (!/var myMethod\s*=/.test(js)) {
						push("warn", "page.js", "no-myMethod", "未定义 myMethod（平台装配依赖 myMethod 合并自定义方法）");
					} else if (!/for\s*\(\s*var key in myMethod\s*\)/.test(js)) {
						push("warn", "page.js", "no-merge-loop", "缺少 for(key in myMethod) 合并循环，自定义方法可能不生效（V1.01）");
					}
					/* V1.01：myMethod 字面量外直接给 vueMethod 赋值 */
					const beforeMyMethod = String(js).split("var myMethod")[0] || "";
					if (/vueMethod\.[A-Za-z0-9_$]+\s*=/.test(beforeMyMethod)) {
						push("error", "page.js", "sys-zone-modified", "在 myMethod 字面量外直接给 vueMethod 赋值（系统合并区外修改方法，运行时 is not a function）");
					}
					/* 平台 API 调用路径惯例 */
					if (/\$magicaltool\.request\b|magicaltool\.request/.test(js) && !/magical_lowcode\/openapi/.test(js)) {
						push("warn", "page.js", "api-url", "调用平台 API 的 url 建议使用 /magical_lowcode/openapi/ 前缀路径");
					}
				}
				const css = await readOpt("page.css");
				if (css !== null) {
					const open = (css.match(/\{/g) || []).length;
					const close = (css.match(/\}/g) || []).length;
					if (open !== close) push("error", "page.css", "css-brace", "CSS 花括号不平衡（{ 共 " + open + "，} 共 " + close + "），样式可能全部失效");
				}
			} else {
				/* API 目录 */
				try {
					const mj = JSON.parse(await readOpt("meta.json"));
					if (!mj.id) push("error", "meta.json", "id-missing", "meta.json 缺少 id 字段");
				} catch {
					push("error", "meta.json", "json-invalid", "meta.json 不是合法 JSON");
				}
				const script = await readOpt("script.js");
				if (script !== null) {
					try { new Function(script); } catch (e) {
						push("error", "script.js", "js-syntax", "JS 语法错误：" + (e instanceof Error ? e.message : String(e)));
					}
					/* V1.05：_body 数字 === 严格比较 */
					const strictMatches = script.match(/_body\.[A-Za-z0-9_$]+\s*===\s*\d+/g) || [];
					for (const m of strictMatches.slice(0, 3)) {
						push("warn", "script.js", "number-strict", "「" + m + "」：_body 数字是 Java 包装类型，=== 严格比较会失效，请先 Number() 归一（V1.05）");
					}
					if (!/\breturn\s+\{/.test(script)) {
						push("warn", "script.js", "no-return", "未发现 return 对象，平台脚本通常以 return { code, data } 结构返回结果");
					}
				}
			}
			return { dir: resolvedDir, issues };
		} catch (error) {
			if (error instanceof RemoteError) throw error;
			throw internalError("lint", error);
		}
	}
}

for (const remoteMethod of [
	"listProjectEntries",
	"projectPushStatus",
	"projectRunScript",
	"projectMarkPushed",
	"projectResetPushState",
	"projectRenameEntry",
	"projectSetProjectName",
	"projectDeleteEntry",
	"projectReadFile",
	"projectWriteFile",
	"projectAssemblePreview",
	"projectLint"
]) markRemote(DesktopProjectService, remoteMethod);
//#endregion

//#region preset archive 端点（fetch 路由，带连接认证）
async function presetExportResponse(ctx, request) {
	const url = new URL(request.url);
	const agentPreset = url.searchParams.get("agentPreset");
	if (agentPreset === null || !PRESET_ARCHIVE_ID.test(agentPreset)) return presetArchiveFailure("Missing or invalid agentPreset query parameter.");
	const presets = ctx.get("agentPresets");
	if (presets === void 0) return presetArchiveFailure("This deployment has no agent presets.", 503);
	try {
		request.signal?.throwIfAborted();
		/* 0.2.0 起 preset 不再是磁盘目录：注册表只提供 list()/readDocument()，
		 * 于是导出 = 当前生效的插件清单（YAML）+ manifest。 */
		const rows = await presets.list();
		const row = rows.find((candidate) => candidate.id === agentPreset);
		if (row === void 0) return presetArchiveFailure(`Unknown agent preset: ${agentPreset}`, 404);
		if (row.broken !== void 0) return presetArchiveFailure(`This preset cannot be exported because it failed to load: ${row.broken}`);
		const source = await presets.readDocument(row.id);
		const content = typeof source.content === "string" ? source.content : "";
		const files = Object.create(null);
		files[`preset/${PRESET_COMPOSITION_FILE}`] = strToU8(content === "" ? "[]\n" : content.endsWith("\n") ? content : `${content}\n`);
		const manifest = {
			format: PRESET_ARCHIVE_FORMAT,
			version: PRESET_ARCHIVE_VERSION,
			id: row.id,
			...row.name === void 0 ? {} : { name: row.name },
			...row.description === void 0 ? {} : { description: row.description },
			sourceDshVersion: DSH_SOURCE_VERSION,
			exportedAt: new Date().toISOString()
		};
		const data = zipSync({
			"manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
			...files
		}, { level: 6 });
		if (data.length > PRESET_ARCHIVE_MAX_COMPRESSED) return presetArchiveFailure("The compressed preset package is larger than 16 MB.", 413);
		request.signal?.throwIfAborted();
		return new Response(data, { headers: {
			"content-type": PRESET_ARCHIVE_MIME,
			"content-disposition": `attachment; filename="${row.id}.dshpreset"`,
			"cache-control": "no-store"
		} });
	} catch (error) {
		if (request.signal?.aborted) return presetArchiveFailure("Preset export was cancelled.", 499);
		return presetArchiveFailure(errorMessage(error));
	}
}

async function presetImportResponse(ctx, request) {
	if (request.method !== "POST") return presetArchiveFailure("Use POST with the preset package body.");
	const url = new URL(request.url);
	const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== PRESET_ARCHIVE_MIME && contentType !== "application/zip" && contentType !== "application/octet-stream") return presetArchiveFailure("Content type must be a DSH preset package.", 415);
	const contentLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > PRESET_ARCHIVE_MAX_COMPRESSED) return presetArchiveFailure("Preset package is larger than 16 MB.", 413);
	const presets = ctx.get("agentPresets");
	if (presets === void 0) return presetArchiveFailure("This deployment has no agent presets.", 503);
	let data;
	try {
		data = new Uint8Array(await request.arrayBuffer());
	} catch {
		return presetArchiveFailure("Could not read the preset package.");
	}
	if (data.length > PRESET_ARCHIVE_MAX_COMPRESSED) return presetArchiveFailure("Preset package is larger than 16 MB.", 413);
	let parsed;
	try {
		parsed = parsePresetArchive(data);
	} catch (error) {
		return presetArchiveFailure(errorMessage(error));
	}
	const agentPreset = url.searchParams.get("agentPreset") ?? parsed.manifest.id;
	if (!PRESET_ARCHIVE_ID.test(agentPreset)) return presetArchiveFailure("Use lowercase letters, digits, and hyphens, starting with a letter or digit.");
	let rows;
	try {
		rows = await presets.list();
	} catch (error) {
		return presetArchiveFailure(`Could not read the existing preset list: ${errorMessage(error)}`, 500);
	}
	const conflict = rows.some((row) => row.id === agentPreset);
	let declaration;
	try {
		declaration = presetArchiveDeclaration(parsed.files);
	} catch (error) {
		return presetArchiveFailure(errorMessage(error));
	}
	const warnings = [
		...parsed.warnings,
		...typeof parsed.manifest.sourceDshVersion === "string" && parsed.manifest.sourceDshVersion !== DSH_SOURCE_VERSION ? ["version-mismatch"] : []
	];
	const preview = {
		ok: true,
		agentPreset,
		sourceAgentPreset: parsed.manifest.id,
		...typeof parsed.manifest.name === "string" ? { name: parsed.manifest.name } : {},
		...typeof parsed.manifest.description === "string" ? { description: parsed.manifest.description } : {},
		...typeof parsed.manifest.sourceDshVersion === "string" ? { sourceDshVersion: parsed.manifest.sourceDshVersion } : {},
		fileCount: Object.keys(parsed.files).length,
		pluginCount: declaration.items.length,
		warnings,
		conflict,
		installed: false
	};
	if (url.searchParams.get("install") !== "1") return Response.json(preview, { headers: { "cache-control": "no-store" } });
	if (conflict) return presetArchiveFailure(`A preset named "${agentPreset}" already exists. Choose another identifier.`, 409);
	try {
		request.signal?.throwIfAborted();
		/* 0.2.0 起预设的落点不再是用户可写目录，而是 profile patch 里的一行
		 * @deepseek-ai/dsh-agent-preset 声明；profile 配置重载后即出现在预设列表。 */
		const written = await presetImportWritePatch(ctx, agentPreset, {
			plugins: declaration,
			...typeof parsed.manifest.name === "string" ? { name: parsed.manifest.name } : {},
			...typeof parsed.manifest.description === "string" ? { description: parsed.manifest.description } : {}
		});
		if (!written) return presetArchiveFailure(`A preset named "${agentPreset}" already exists. Choose another identifier.`, 409);
		return Response.json({
			...preview,
			conflict: false,
			installed: true
		}, { headers: { "cache-control": "no-store" } });
	} catch (error) {
		if (request.signal?.aborted) return presetArchiveFailure("Preset import was cancelled.", 499);
		return presetArchiveFailure(errorMessage(error));
	}
}
//#endregion

function apply(ctx) {
	new DesktopProjectService(ctx);
	/* preset archive 端点：等 agentPresets 服务可用后挂到 connection 的认证 Fetch 路由。 */
	ctx.inject(["agentPresets"], () => {
		const connection = Reflect.get(ctx, "connection");
		if (connection === void 0) return;
		ctx.effect(() => connection.fetch.register({
			path: "/api/agent-preset.export",
			methods: ["GET", "HEAD"],
			/* rc.2 起 ConnectionFetchRoute.requestBody 是必填字段：
			 * buffered 走 JSON 体积上限，streaming 走背压无聚合上限。
			 * 导出只读 query、不看请求体，但字段必须显式声明。 */
			requestBody: "buffered",
			fetch: async (request) => {
				const response = await presetExportResponse(ctx, request);
				if (request.method === "GET") return response;
				await response.body?.cancel();
				return new Response(null, {
					status: response.status,
					headers: response.headers
				});
			}
		}), "dsh-magical-lowcode-project: preset export route");
		ctx.effect(() => connection.fetch.register({
			path: "/api/agent-preset.import",
			methods: ["POST"],
			/* 导入要把整个 zip 读进内存（parsePresetArchive 要全量字节），
			 * buffered 才符合上限受控的语义。 */
			requestBody: "buffered",
			fetch: async (request) => presetImportResponse(ctx, request)
		}), "dsh-magical-lowcode-project: preset import route");
	});
}

export { apply, inject, name };
