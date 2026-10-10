/**
 * dsh-project-panel — 客户端半边（web 端「工程面板」）。
 *
 * 为什么是手写的经典 script 而不是打包产物：
 *   React、cordis、UI 基元都由 shell 的种子表（PLATFORM_MODULES）提供，本插件
 *   客户端代码没有第三方依赖需要内联，所以 esbuild 这一环纯属多余。手写省掉一个
 *   devDependency 与一个必须在发布前跑到的构建步骤。
 *
 * 契约（来自对宿主 @deepseek-ai/dsh-client-modules 与 dsh-web-frontend 种子表的实测）：
 *   - 产物必须是经典 <script> payload，形如
 *     window.__ModuleLoader__.load({ id: <包名>, factory: (require) => exports })；
 *     id 必须逐字等于 npm 包名，宿主靠它把 bundle 与 boot graph 行对上。
 *   - 只能 require 种子表那 9 个说明符：react、react/jsx-runtime、react-dom、
 *     react-dom/client、@deepseek-ai/cordis、@deepseek-ai/dsh-client-store、
 *     @deepseek-ai/dsh-client-ui-slots、@deepseek-ai/dsh-client-ui-primitives、
 *     @deepseek-ai/dsh-client-ui-dockkit。别的说明符运行时直接抛错。
 *   - 入口必须具名导出 apply 与 inject，没有 default export；
 *     inject 是 cordis 服务键数组，不是包名数组。
 *   - 所有 slot 注册都走 slots.inject(key, () => slots.register(...))，
 *     让 disposer 落在本插件 fiber 上，插件卸载时 UI 才不会悬挂。
 *   - 不能注册 'root' slot（single 且被 shell 独占，注册会 shadow 整个 AppFrame）。
 *   - 不能在模块体做副作用：整个文件只定义函数并调用一次 load()，apply 才做挂载。
 *
 * 席位（**只用两个空闲的 list 席位，绝不碰 single 席位**）：
 *   - sidebar.footer.action —— list，侧栏底部的开合按钮。
 *   - shell.overlay         —— list，框架级浮层，自己定位成左侧一列。
 *
 *   历史教训（2026-10-10）：早先的版本注册了 sidebar.panellist + main，
 *   点图标会让 ctx.layout.selectPanel(ENTRY_ID) 把**中栏整块**换成工程浏览器，
 *   会话界面连同底部输入框一起消失 —— 用户就再也无法把问题发给 AI。已废弃。
 *   同样不能碰 sidebar.workspaces（single，被 ui-workspace 占，抢它会顶掉会话列表）。
 *
 *   另外：**浏览工作区文件这件事官方已经内置**，见
 *   @deepseek-ai/dsh-client-ui-sidebar-files（右侧栏工作区文件树，走 workspaceFiles
 *   Remote 命名空间，天然只在工作区内）+ @deepseek-ai/dsh-client-ui-sidebar-documentpreview
 *   （代码/Markdown/图片/PDF 预览）。本插件只补充官方没有的工程语义
 *   （推送状态、脚本运行、工程体检、预设包导入导出）。
 *
 * 数据面：本插件**自带** host 半边（lib/index.js），自建
 * POST /api/desktopProject/<method> 路由，不依赖任何已装的第三方插件。
 */
window.__ModuleLoader__.load({
	id: "dsh-project-panel",
	factory: (require) => {
		"use strict";

		/** 包名；__ModuleLoader__ 信封 id 与 RPC 的 rpcId 前缀都用它。 */
		const PACKAGE_NAME = "dsh-project-panel";
		/** host 半边 super(ctx, "desktopProjectController", { namespace: "desktopProject" }) 的 namespace。 */
		const NAMESPACE = "desktopProject";
		/** 本插件在两个 list 席位（sidebar.footer.action / shell.overlay）里的注册 id。 */
		const ENTRY_ID = "project-panel";
		/** 右侧栏 tab 的类型名与实例 id（id 用包名，与官方 files tab 同风格）。 */
		const TAB_KIND = "dsh-project-panel:project";
		const TAB_ID = "dsh-project-panel";
		/** 工程目录的记忆键。 */
		const DIR_KEY = "dsh-project-panel:dir";
		/** 旧的 web 重实现用过的键：自己没有记忆时借它的目录，省得用户重填一遍。 */
		const LEGACY_DIR_KEY = "dsh-magical-lowcode-project:dir";

		/** html / htm 共用一份骨架。 */
		const HTML_SKELETON =
			'<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n\t<meta charset="utf-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1">\n\t<title>新页面</title>\n</head>\n<body>\n\t\n</body>\n</html>\n';

		/**
		 * 新建文件时按扩展名套的骨架。
		 *
		 * 刻意短：模板该省掉的是「每次都得敲的那几行」，而不是替用户决定结构 ——
		 * 塞进一整套目录约定，用户第一步就是先删掉一半。**没列出的扩展名一律
		 * 按空文件处理**，不要为了凑数往里塞写上去就被删掉的样板。
		 *
		 * 值是字符串，或者接收「去掉扩展名的文件名」的函数（`.md` 要用它当标题）。
		 */
		const FILE_TEMPLATES = {
			html: HTML_SKELETON,
			htm: HTML_SKELETON,
			vue: "<template>\n\t<div></div>\n</template>\n\n<script setup>\n</script>\n\n<style scoped>\n</style>\n",
			json: "{}\n",
			sh: "#!/usr/bin/env bash\nset -euo pipefail\n\n",
			bash: "#!/usr/bin/env bash\nset -euo pipefail\n\n",
			svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">\n\t\n</svg>\n',
			/* 拿文件名当一级标题 —— 省掉每次都要重敲一遍标题。 */
			md: (stem) => "# " + stem + "\n",
			markdown: (stem) => "# " + stem + "\n",
		};

		/**
		 * 按扩展名取模板；没有就返回 null（新建空文件）。
		 *
		 * `.env`、`.gitignore` 这种「点开头、后面再没有点」的整名不算扩展名 ——
		 * `cut <= 0` 把它们挡掉，和 host 的 `freeName()` 判断有没有扩展名是同一个口径。
		 */
		function templateFor(name) {
			const text = String(name);
			const cut = text.lastIndexOf(".");
			if (cut <= 0 || cut === text.length - 1) return null;
			const ext = text.slice(cut + 1).toLowerCase();
			if (Object.prototype.hasOwnProperty.call(FILE_TEMPLATES, ext) !== true) return null;
			const entry = FILE_TEMPLATES[ext];
			return typeof entry === "function" ? entry(text.slice(0, cut)) : entry;
		}

		/**
		 * 种子表给的是模块命名空间还是裸实例，取决于 shell 怎么注册；
		 * 两种形状都认（先看本体有没有要的键，再看 default 上有没有）。
		 */
		function pickModule(value, keys) {
			const has = (target) => {
				if (target === null || (typeof target !== "object" && typeof target !== "function")) return false;
				for (const key of keys) if (key in target) return true;
				return false;
			};
			if (has(value)) return value;
			if (value !== null && typeof value === "object" && has(value.default)) return value.default;
			return value;
		}

		const React = pickModule(require("react"), [
			"createElement",
			"useState",
			"useCallback",
			"useEffect",
			"useRef",
		]);
		const h = React.createElement;
		const { useState, useCallback, useEffect, useRef } = React;

		/* ------------------------------------------------- 主机侧 RPC */

		/**
		 * 每个方法在 wire 上收的是**具名参数对象**，不是位置实参。
		 * 上游原版 DSH Desktop 补丁就是这么调的：desktopProjectRpc("listProjectEntries", { path })。
		 * 这里只列本插件真正用到的几个。
		 */
		const METHOD_PARAMS = {
			listProjectEntries: ["path"],
			projectReadFile: ["path"],
			projectWriteFile: ["path", "content"],
			projectCreateEntry: ["parent", "name", "kind", "content"],
			projectRenameEntry: ["path", "name"],
			projectMoveEntry: ["path", "parent"],
			projectDeleteEntry: ["path"],
			projectSearchEntries: ["path", "query"],
			projectGrepFiles: ["path", "query", "ignoreCase"],
			projectPushStatus: ["path"],
			projectMarkPushed: ["path", "relDir", "scope", "target", "noAncestors"],
			projectResetPushState: ["path"],
			projectLint: ["path"],
			projectListScripts: ["path"],
			projectRunScript: ["path", "script", "args", "confirm"],
			projectRunScriptPoll: ["runId", "since"],
			projectRunScriptStop: ["runId"],
			projectResyncPush: ["path", "zone", "project"],
			projectGetConfig: ["path"],
			projectSaveServer: ["id", "label", "serverUrl", "username", "password", "env"],
			projectDeleteServer: ["id"],
			projectBindWorkspace: ["path", "serverId", "projectUuid"],
			projectSetProjects: ["serverId", "projects"],
			projectApplyConfig: ["path", "serverId", "projectUuid"],
			projectScaffold: ["path"],
			projectScaffoldDeps: [],
		};

		/** wire 信封里的 rpcId 序号。 */
		let rpcSeq = 0;

		/** 位置实参 → wire 具名参数。 */
		function namedArgs(method, args) {
			const names = METHOD_PARAMS[method] ?? [];
			const payload = {};
			for (let index = 0; index < names.length; index += 1) {
				if (args[index] !== undefined) payload[names[index]] = args[index];
			}
			return payload;
		}

		/**
		 * 调用 host 半边的 desktopProject/* Remote。
		 *
		 * 走**浏览器 fetch 信封**（POST /api/desktopProject/<method>），与上游原版
		 * DSH Desktop 补丁逐字同构。**不能改用 ctx.remote.$mount**：那条路要的是
		 * 构建期生成的 typed contribution（带 codec / schema / parameters 与
		 * sourceLocation），插件在运行期手写不出来 —— 真实浏览器里会在 apply 阶段以
		 * `descriptor.parameters is not iterable` 崩掉，面板根本挂不起来。
		 *
		 * 同源 fetch 自带会话 cookie，连接认证由 shell 负责。
		 * 业务失败与传输失败都折成 { ok:false, error }（不 reject），调用方统一处理。
		 */
		async function call(method, ...args) {
			if (typeof fetch !== "function") {
				return { ok: false, error: "当前环境没有 fetch，无法调用主机侧 RPC。" };
			}
			const endpoint = NAMESPACE + "/" + method;
			const rpcId = PACKAGE_NAME + "-" + (rpcSeq += 1) + "-" + Date.now();
			let response;
			try {
				response = await fetch("/api/" + endpoint, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						type: "client-request",
						rpcId: rpcId,
						method: endpoint,
						payload: { args: namedArgs(method, args) },
					}),
				});
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
			if (response.ok !== true) {
				return {
					ok: false,
					error: "主机侧 RPC " + method + " 失败：HTTP " + response.status,
					code: "http-" + response.status,
				};
			}
			let body;
			try {
				body = await response.json();
			} catch (error) {
				return { ok: false, error: "主机侧 RPC " + method + " 返回了非 JSON 响应。" };
			}
			/* 网关可能把信封裹在 result 里，也可能直接就是信封，两种形状都认。 */
			const envelope =
				body !== null && typeof body === "object" && body.result !== undefined ? body.result : body;
			if (envelope === null || typeof envelope !== "object" || envelope.ok !== true) {
				const failure = envelope !== null && typeof envelope === "object" ? envelope.error : undefined;
				if (failure !== null && typeof failure === "object") {
					const message = failure.message ?? failure.code ?? JSON.stringify(failure);
					return { ok: false, error: String(message), code: failure.code };
				}
				if (typeof failure === "string") return { ok: false, error: failure };
				return { ok: false, error: "主机侧 RPC " + method + " 返回了无法识别的信封。" };
			}
			return { ok: true, value: envelope.value };
		}

		/* ------------------------------------------------- 路径记忆 */

		function readStored(key) {
			try {
				const value = window.localStorage.getItem(key);
				return typeof value === "string" ? value : "";
			} catch (error) {
				return "";
			}
		}

		/** 写记忆（隐私模式、桩环境下静默失败 —— 记忆是锦上添花，不该影响主流程）。 */
		function writeStored(key, value) {
			try {
				window.localStorage.setItem(key, value);
			} catch (error) {
				/* 忽略 */
			}
		}

		/** 首次打开时的目录：先用自己的记忆，没有就借旧实现留下的那一份。 */
		function initialDir() {
			const own = readStored(DIR_KEY).trim();
			if (own !== "") return own;
			return readStored(LEGACY_DIR_KEY).trim();
		}

		/* ------------------------------------------------- 资源地址 */

		/*
			把绝对路径变成右侧栏认得的 `dsh-resource://file/…` 地址，交给官方
			documentpreview 预览。逻辑逐字取自
			@deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js 的 file-address 段，
			因为插件只能 require 种子表那 9 个说明符，拿不到那个包的运行时导出。
		*/
		const FILE_ADDRESS_PREFIX = "dsh-resource://file/";

		/** 逐段编码，但保留 `:` 字面量（Windows 盘符）。 */
		function encodeSegment(segment) {
			return encodeURIComponent(segment).replace(/%3A/gi, ":");
		}

		function encodePath(path) {
			return path.split("/").map(encodeSegment).join("/");
		}

		/**
		 * 绝对路径 → 会话作用域的文件地址。
		 * @param {string} sessionId 右侧栏注入的当前会话 id
		 * @param {string} cwd 该会话的工作区根（已知时），根内的路径会被折成相对路径
		 * @param {string} path 绝对路径
		 */
		function fileAddressFor(sessionId, cwd, path) {
			const normalized = String(path).replace(/\\/g, "/");
			const root = typeof cwd === "string" ? cwd.replace(/\\/g, "/").replace(/\/+$/, "") : "";
			const isAbsolute =
				normalized.startsWith("/") || /^[A-Za-z]:[/\\]/.test(normalized) || normalized.startsWith("//");
			let relative = normalized;
			if (isAbsolute && root !== "" && normalized.startsWith(root + "/")) {
				relative = normalized.slice(root.length + 1);
			}
			relative = relative.replace(/^(?:\.\/)+/, "");
			return FILE_ADDRESS_PREFIX + "session/" + encodeSegment(sessionId) + "/" + encodePath(relative);
		}

		/**
		 * useTabInfo 是 slot 运行时注入的 prop；hook 不能被条件调用，所以拿不到时
		 * 给一个恒等函数兜底，而不是在组件里写 if。
		 */
		const EMPTY_TAB_INFO = () => ({});
		/** useSessions 拿不到时的兜底：选择器统一返回 undefined。 */
		const EMPTY_SESSIONS = () => undefined;

		/** child 是否等于 parent 或位于其下（两侧都归一化分隔符与大小写）。 */
		function isUnder(child, parent) {
			const a = String(child).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
			const b = String(parent).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
			if (b === "" || a === "") return false;
			return a === b || a.startsWith(b + "/");
		}

		/**
		 * 路径的查表键：统一分隔符 + 折成小写（Windows 上大小写不敏感）。
		 * 推送状态的 Map 用它做 key，免得 host 返回的反斜杠路径和树里的正斜杠对不上。
		 */
		function pathKey(value) {
			return String(value).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
		}

		/**
		 * 相对路径（一律 `/` 分隔），基准是会话工作目录。
		 *
		 * 输入框里的 `@` 引用、右侧栏预览地址都用这个基准，两处必须一致，
		 * 否则 lexicon 装饰匹配不上、预览也会指向不存在的文件。
		 */
		function relativeUnder(base, full) {
			const b = String(base).replace(/\\/g, "/").replace(/\/+$/, "");
			const f = String(full).replace(/\\/g, "/");
			if (b === "") return f.replace(/^\/+/, "");
			if (f.toLowerCase() === b.toLowerCase()) return "";
			if (f.toLowerCase().startsWith(b.toLowerCase() + "/")) return f.slice(b.length + 1);
			return f.replace(/^\/+/, "");
		}

		/**
		 * 打开编辑器时要落在哪一行；0 表示从头看。
		 * 搜索结果带来的 1 基行号存在标签的 `caret` 上，没有这条就是 0。
		 */
		function caretOf(shot) {
			if (shot === null || shot === undefined) return 0;
			return Number(shot.caret) > 0 ? Math.floor(Number(shot.caret)) : 0;
		}

		/**
		 * 取父目录。纯字符串裁剪 —— host 只收绝对路径，我们这边没有 node:path。
		 * 已经是盘根（如 `D:\`）时原样返回，调用方据此判断"改不了了"。
		 */
		function parentOf(path) {
			const text = String(path).replace(/[\\/]+$/, "");
			const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
			if (cut <= 0) return text;
			const head = text.slice(0, cut);
			/* `D:\` 这种盘根裁完会剩 `D:`，补回分隔符。 */
			return /^[a-zA-Z]:$/u.test(head) ? head + "\\" : head;
		}

		/** 路径最后一段（`parentOf` 的反面）。 */
		function baseNameOf(path) {
			const text = String(path).replace(/[\\/]+$/, "");
			const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
			return cut < 0 ? text : text.slice(cut + 1);
		}

		/**
		 * child 是不是 parent 本身或它底下的东西。比的是绝对路径，
		 * Windows 上大小写不敏感，两边都折成小写。
		 */
		function under(parent, child) {
			const p = String(parent).replace(/[\\/]+$/, "").toLowerCase();
			const c = String(child).replace(/[\\/]+$/, "").toLowerCase();
			if (p === "" || c === "" || c === p) return c === p;
			return c.startsWith(p + "\\") || c.startsWith(p + "/");
		}

		/**
		 * 把一条路径格式化成输入框里的引用文本 —— 逐字照抄官方 grammar 的
		 * `formatFileMention`（`@deepseek-ai/dsh-client-ui-reference/lib/client.js:17-23`），
		 * 这样我们插进去的 token 和官方 `@` 菜单自己插出来的完全同形，装饰器才认。
		 *
		 * - 目录一律补尾斜杠：`@src/`
		 * - 含空白就走引号语法：文件 `@"a b.ts"`；目录 `@"a b/`（**故意不闭合**，
		 *   官方靠这个让光标停在下钻位置，用户接着打字就能补全目录内的文件）
		 * - 路径含控制字符或引号 → undefined（编辑器表示不了，调用方应放弃插入）
		 */
		function formatMention(path, isDir) {
			const text = isDir === true ? String(path) + "/" : String(path);
			if (/[\u0000-\u001f\u007f-\u009f"]/u.test(text)) return undefined;
			if (!/\s/u.test(text)) return "@" + text;
			if (isDir === true) return '@"' + text;
			return '@"' + text + '"';
		}

		/** 按扩展名猜一个 markdown 代码块语言标识；猜不出就留空（空着也是合法的代码块）。 */
		function languageOf(path) {
			const name = String(path).toLowerCase();
			const dot = name.lastIndexOf(".");
			if (dot < 0) return "";
			const ext = name.slice(dot + 1);
			const table = {
				js: "js", jsx: "jsx", mjs: "js", cjs: "js",
				ts: "ts", tsx: "tsx", mts: "ts", cts: "ts",
				py: "python", rb: "ruby", go: "go", rs: "rust",
				java: "java", kt: "kotlin", php: "php", cs: "csharp",
				c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
				swift: "swift", sh: "bash", bash: "bash", ps1: "powershell",
				sql: "sql", css: "css", scss: "scss", less: "less",
				html: "html", htm: "html", xml: "xml", vue: "vue",
				json: "json", jsonc: "json", yml: "yaml", yaml: "yaml",
				toml: "toml", ini: "ini", md: "markdown", markdown: "markdown",
			};
			const hit = table[ext];
			return hit === undefined ? "" : hit;
		}

		/**
		 * 把「某个文件的一段行区间」拼成能贴进输入框的文本。
		 *
		 * 只给行号时，官方引用芯片投喂的是整份文件，AI 得自己数行，常常数不准；
		 * 所以勾了「带行内容」就把这几行的原文一起贴成代码块。
		 * 返回 undefined 表示这个路径表达不成引用（工作区根、或含编辑器表示不了的字符）。
		 */
		function rangePromptText(shot, cwd) {
			const relative = relativeUnder(cwd, shot.path);
			if (relative === "") return undefined;
			const mention = formatMention(relative, false);
			if (mention === undefined) return undefined;
			const lo = Math.min(shot.anchor, shot.focus);
			const hi = Math.max(shot.anchor, shot.focus);
			const range = lo === hi ? "L" + lo : "L" + lo + "-" + hi;
			let text = mention + " " + range + " ";
			if (shot.withBody === true) {
				const body = String(shot.content ?? "").split("\n").slice(lo - 1, hi).join("\n");
				text += "\n\n```" + languageOf(relative) + "\n" + body + "\n```\n";
			}
			return text;
		}

		/**
		 * 从浏览器自己的选区算出它盖住了哪几行（行元素上带着 `data-line`）。
		 *
		 * 自己维护的 anchor/focus 在「先拉选区、再按住选区拖」时会被那次按下重置，
		 * 所以拖放要用原生选区算，才拿得到用户真正选中的范围。拿不到就返回 null。
		 */
		function selectionLines() {
			try {
				const selection = window.getSelection();
				if (selection === null || selection.isCollapsed === true || selection.rangeCount === 0) return null;
				const range = selection.getRangeAt(0);
				const pick = (node) => {
					let element = node === null || node === undefined ? null : node.nodeType === 1 ? node : node.parentElement;
					while (element !== null && element !== undefined) {
						const raw = typeof element.getAttribute === "function" ? element.getAttribute("data-line") : null;
						if (raw !== null && raw !== undefined) return Number(raw);
						element = element.parentElement;
					}
					return null;
				};
				const from = pick(range.startContainer);
				const to = pick(range.endContainer);
				if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to)) return null;
				return { lo: Math.min(from, to), hi: Math.max(from, to) };
			} catch (error) {
				return null;
			}
		}

		/* ------------------------------------------------- 样式 */

		const BORDER = "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22))";

		const CSS = {
			root: {
				display: "flex",
				/* flex 与 height 都留着：父容器是 flex 就靠 flex 撑，是块级就靠 height。 */
				flex: 1,
				flexDirection: "column",
				height: "100%",
				minHeight: 0,
				/* 内部各段自己滚，整块绝不往外长。 */
				overflow: "hidden",
				fontSize: 13,
				color: "var(--dsw-alias-label-primary, inherit)",
			},
			bar: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "10px 14px",
				borderBottom: BORDER,
				flex: "0 0 auto",
			},
			input: {
				flex: 1,
				minWidth: 0,
				height: 28,
				padding: "0 8px",
				borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.32))",
				background: "var(--dsw-alias-bg-base, transparent)",
				color: "inherit",
				font: "inherit",
				outline: "none",
			},
			button: {
				height: 28,
				padding: "0 10px",
				borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.32))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				cursor: "pointer",
				flex: "0 0 auto",
			},
			/* 右侧栏是窄列：树与详情区上下排，不做左右分栏。 */
			body: { display: "flex", flex: 1, minHeight: 0, flexDirection: "column", position: "relative" },
			/* 文件树与源码各占一个页签：一次只看一个，源码区就能吃满整列高度。 */
			tabs: {
				display: "flex",
				alignItems: "stretch",
				gap: 2,
				padding: "0 10px",
				borderBottom: BORDER,
				flex: "0 0 auto",
			},
			tab: {
				height: 30,
				padding: "0 12px",
				border: "none",
				borderBottom: "2px solid transparent",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				cursor: "pointer",
				maxWidth: "60%",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
			},
			/* 选中的页签：底下压一道主题色。追加到 CSS.tab 上。 */
			tabOn: { borderBottom: "2px solid var(--dsw-alias-brand-primary, #4d6bfe)" },
			tree: {
				flex: 1,
				minHeight: 0,
				overflow: "auto",
				padding: "6px 0",
			},
			row: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				padding: "3px 10px 3px 0",
				cursor: "pointer",
				whiteSpace: "nowrap",
				userSelect: "none",
			},
			detail: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
			/* 源码页签的外壳：标签条 + 正文。标签多了让它横向滚动，不挤正文。 */
			codePane: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
			/* 源码页签里的标签条。名字带 code 前缀 —— 别和上面页签的 tabs/tab/tabOn 撞键。 */
			codeTabs: {
				display: "flex",
				alignItems: "center",
				gap: 2,
				padding: "0 8px",
				borderBottom: BORDER,
				flex: "0 0 auto",
				overflowX: "auto",
			},
			codeTab: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				maxWidth: 180,
				padding: "6px 6px 6px 10px",
				borderRadius: 6,
				cursor: "pointer",
				whiteSpace: "nowrap",
				color: "var(--dsw-alias-label-secondary, rgba(128,128,128,1))",
			},
			codeTabOn: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				maxWidth: 180,
				padding: "6px 6px 6px 10px",
				borderRadius: 6,
				cursor: "pointer",
				whiteSpace: "nowrap",
				background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.14))",
			},
			tabX: {
				flex: "0 0 auto",
				padding: "0 2px",
				borderRadius: 3,
				opacity: 0.6,
				fontSize: 13,
				lineHeight: 1,
			},
			detailBar: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "8px 14px",
				borderBottom: BORDER,
				flex: "0 0 auto",
			},
			code: {
				flex: 1,
				minHeight: 0,
				margin: 0,
				padding: 14,
				overflow: "auto",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12,
				lineHeight: 1.55,
				whiteSpace: "pre",
			},
			editor: {
				flex: 1,
				minHeight: 0,
				margin: 0,
				padding: 14,
				overflow: "auto",
				resize: "none",
				border: "none",
				outline: "none",
				background: "transparent",
				color: "inherit",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12,
				lineHeight: 1.55,
			},
			/*
				CodeMirror 的宿主容器。CM 用 height:100% 撑满 + 内部滚动，
				所以这里得是「高度确定的 flex 列」，光有 flex:1 不够。
			*/
			editorHost: {
				flex: 1,
				minHeight: 0,
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
			},
			muted: {
				color: "var(--dsw-alias-label-secondary, rgba(128,128,128,.95))",
				padding: 14,
				lineHeight: 1.8,
			},
			/* 选行视图：文件按行渲染，行号 + 行文本，按住拖动选一个行区间。 */
			lines: {
				flex: 1,
				minHeight: 0,
				overflow: "auto",
				padding: "6px 0",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12,
				lineHeight: 1.55,
				cursor: "text",
			},
			line: {
				display: "flex",
				alignItems: "flex-start",
				gap: 10,
				padding: "0 14px",
				whiteSpace: "pre",
			},
			lineOn: {
				display: "flex",
				alignItems: "flex-start",
				gap: 10,
				padding: "0 14px",
				whiteSpace: "pre",
				background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16))",
			},
			gutter: {
				flex: "0 0 auto",
				width: 44,
				textAlign: "right",
				opacity: 0.45,
				userSelect: "none",
			},
			lineText: { flex: "1 1 auto", minWidth: 0 },
			/*
				推送状态徽章：✔ 已推送 / ● 待推送。
				用绿/橙两色区分，色值优先取主题变量，取不到再退回硬编码。
			*/
			badgeOk: {
				flex: "0 0 auto",
				padding: "0 4px",
				borderRadius: 3,
				fontSize: 11,
				lineHeight: "16px",
				color: "var(--dsw-alias-label-success, #2e9e5b)",
				background: "rgba(46,158,91,.14)",
			},
			badgeDirty: {
				flex: "0 0 auto",
				padding: "0 4px",
				borderRadius: 3,
				fontSize: 11,
				lineHeight: "16px",
				color: "var(--dsw-alias-label-warning, #c8811a)",
				background: "rgba(200,129,26,.16)",
			},
			/* 推送徽章 + 校验计数并排时不换行、彼此留一点缝。 */
			badgeGroup: {
				flex: "0 0 auto",
				display: "inline-flex",
				alignItems: "center",
				gap: 4,
			},
			/* 校验有错：跟「推送状态」无关，是这个单元推上去会失败。 */
			badgeError: {
				flex: "0 0 auto",
				padding: "0 4px",
				borderRadius: 3,
				fontSize: 11,
				lineHeight: "16px",
				color: "var(--dsw-alias-label-error, #c4342c)",
				background: "rgba(196,52,44,.14)",
			},
			/* 记不了账的单元（缺 uuid / id）：它不是「待推送」，是「推不了」。 */
			badgeBroken: {
				flex: "0 0 auto",
				padding: "0 4px",
				borderRadius: 3,
				fontSize: 11,
				lineHeight: "16px",
				color: "var(--dsw-alias-label-error, #c4342c)",
				background: "rgba(196,52,44,.18)",
			},
			/* ---- 「脚本」页签：跑工作区根下的 source-*.js ---- */
			/* 一张卡一个脚本，横向铺开。 */
			runGrid: {
				flex: "0 0 auto",
				display: "flex",
				flexWrap: "wrap",
				gap: 8,
				padding: "10px 14px",
				borderBottom: BORDER,
			},
			runCard: {
				display: "flex",
				flexDirection: "column",
				gap: 4,
				width: 208,
				padding: "8px 10px",
				borderRadius: 8,
				border: BORDER,
			},
			/* 卡里的脚本名 + 默认参数：等宽、压一行、太长省略。 */
			runName: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 11,
				opacity: 0.65,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
			},
			/* 「确认运行」和外网地址下的运行按钮：颜色上先跟普通按钮区分开。 */
			dangerButton: {
				borderColor: "var(--dsw-alias-label-error, #c4342c)",
				color: "var(--dsw-alias-label-error, #c4342c)",
			},
			/* 项目下拉：占满卡片一行，字号跟脚本名一档。 */
			runSelect: {
				width: "100%",
				minWidth: 0,
				marginTop: 2,
				fontSize: 12,
			},
			/* 「脚本」页签顶部的连接配置区：档案 + 项目 + 写入 .env。 */
			configBox: {
				flex: "0 0 auto",
				display: "flex",
				flexDirection: "column",
				gap: 6,
				padding: "0 12px 10px",
				borderBottom: BORDER,
			},
			configRow: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				minWidth: 0,
			},
			/* 配置行左侧的字段名：定宽，右边控件才对得齐。 */
			field: {
				flex: "0 0 52px",
				opacity: 0.6,
				fontSize: 12,
				whiteSpace: "nowrap",
			},
			runConsole: {
				flex: "1 1 auto",
				minHeight: 0,
				display: "flex",
				flexDirection: "column",
			},
			/* 脚本输出：等宽、可滚、贴底。行高必须写死，继承下来会糊成一片。 */
			runLog: {
				flex: "1 1 auto",
				minHeight: 0,
				margin: 0,
				padding: 12,
				overflow: "auto",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12,
				lineHeight: "18px",
				whiteSpace: "pre-wrap",
				wordBreak: "break-all",
			},
			/* 树里每个文件行右侧的「引用」小按钮。 */
			refButton: {
				flex: "0 0 auto",
				height: 20,
				padding: "0 6px",
				borderRadius: 4,
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.32))",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary, rgba(128,128,128,.95))",
				font: "inherit",
				fontSize: 11,
				lineHeight: "18px",
				cursor: "pointer",
				opacity: 0.7,
			},
			/* 文件树页签顶部的新建工具条。 */
			tools: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				flex: "0 0 auto",
				padding: "6px 10px",
				borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22))",
			},
			/* 工具条和行内改名共用的小按钮。 */
			miniButton: {
				flex: "0 0 auto",
				height: 22,
				padding: "0 8px",
				borderRadius: 5,
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.32))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 11,
				lineHeight: "20px",
				cursor: "pointer",
			},
			/* 搜索框旁边那两个「文件名 / 内容」切换按钮的选中态。 */
			modeOn: {
				background: "var(--dsw-alias-bg-module-platform, rgba(128,128,128,.16))",
				borderColor: "var(--dsw-alias-brand-primary, #4d6bfe)",
				color: "var(--dsw-alias-brand-primary, #4d6bfe)",
			},
			toolInput: {
				flex: 1,
				minWidth: 0,
				height: 24,
				padding: "0 8px",
				borderRadius: 5,
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.32))",
				background: "var(--dsw-alias-bg-base, transparent)",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				outline: "none",
			},
			toolHint: {
				flex: "0 1 auto",
				marginLeft: "auto",
				minWidth: 0,
				opacity: 0.55,
				fontSize: 11,
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis",
			},
			/* 右键菜单。absolute 定位，坐标相对 body（body 自己 position: relative）。 */
			menu: {
				position: "absolute",
				zIndex: 40,
				minWidth: 128,
				padding: "4px 0",
				borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.32))",
				background: "var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base, #2b2b2b))",
				boxShadow: "0 8px 24px rgba(0,0,0,.28)",
			},
			menuItem: {
				display: "flex",
				alignItems: "center",
				height: 26,
				padding: "0 12px",
				fontSize: 12,
				lineHeight: "26px",
				whiteSpace: "nowrap",
				cursor: "pointer",
			},
			menuSep: {
				height: 1,
				margin: "4px 0",
				background: "var(--dsw-alias-border-l1, rgba(128,128,128,.22))",
			},
			/* 菜单里那句不能点的说明（确认推拉时写清楚要连到哪个地址）。 */
			menuNote: {
				padding: "6px 12px 4px",
				maxWidth: 260,
				fontSize: 11,
				lineHeight: "16px",
				opacity: 0.62,
				whiteSpace: "normal",
			},
			/* 行尾 ⋯ 展开的操作条，缩进跟着树的层级走。 */
			menuRow: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				flex: "0 0 auto",
				padding: "4px 10px 4px 0",
				background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.10))",
			},
			/* 选行视图工具条上的「带行内容」勾选框。 */
			check: {
				display: "flex",
				alignItems: "center",
				gap: 5,
				whiteSpace: "nowrap",
				fontSize: 11,
				opacity: 0.75,
				cursor: "pointer",
			},
			/* 侧栏底部的「工程」按钮（sidebar.footer.action 席位）。 */
			footerAction: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				width: "100%",
				height: 30,
				padding: "0 8px",
				borderRadius: 6,
				border: "1px solid transparent",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				cursor: "pointer",
				textAlign: "left",
			},
		};

		/* --------------------------------------------- 侧栏底部按钮 */

		/** apply 时抓到的 ctx：按钮回调在组件里跑，需要一个稳定入口来 openTab。 */
		let panelCtx;

		/**
		 * 侧栏底部的「工程」按钮：一键展开右侧栏并跳到工程 tab。
		 * `ctx.sidebarRight.openTab(kind)` 自己会展开面板（用户看不到的内容不算打开）。
		 *
		 * **刻意不注册 sidebar.panellist / main**：那一路会让
		 * ctx.layout.selectPanel(id) 把中栏（会话 + 底部输入框）整块换成插件面板，
		 * 用户就再也发不出消息 —— 这是上一版的教训。
		 */
		function ProjectToggleButton() {
			const open = useCallback(() => {
				const right = panelCtx === undefined ? undefined : panelCtx.get("sidebarRight");
				if (right === undefined || right === null || typeof right.openTab !== "function") return;
				try {
					right.openTab(TAB_KIND);
				} catch (error) {
					console.warn("[dsh-project-panel] openTab 失败：", error);
				}
			}, []);
			return h(
				"button",
				{ type: "button", title: "工程面板", style: CSS.footerAction, onClick: open },
				h(ProjectIcon, { size: 16 }),
				h("span", null, "工程"),
			);
		}

		/** 图标按钮（开合按钮与浮层标题都用它）。 */
		function ProjectIcon(props) {
			const size = props !== null && props !== undefined && typeof props.size === "number" ? props.size : 16;
			const active = props !== null && props !== undefined && props.active === true;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.3,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					style: { display: "block", opacity: active === true ? 1 : 0.8 },
				},
				h("path", {
					d: "M1.9 4.3a1.4 1.4 0 0 1 1.4-1.4h2.9l1.4 1.7h5.1a1.4 1.4 0 0 1 1.4 1.4v5.7a1.4 1.4 0 0 1-1.4 1.4H3.3a1.4 1.4 0 0 1-1.4-1.4z",
				}),
			);
		}

		/* ------------------------------------------------- 工程面板正文 */

		/**
		 * 右侧栏 tab 的正文。
		 *
		 * props 由 slot 运行时注入：`sessionId`（当前会话）、`useTabInfo`（拿 tab
		 * 自己的 actions）。点文件时优先把 `dsh-resource://file/…` 地址交给官方
		 * documentpreview；只有拿不到 actions 时才退回内置详情区。
		 */
		function ProjectBody(props) {
			const useTabInfo = typeof props.useTabInfo === "function" ? props.useTabInfo : EMPTY_TAB_INFO;
			const info = useTabInfo();
			const tab = info !== null && typeof info === "object" ? info.tab : undefined;
			const actions = tab !== null && typeof tab === "object" ? tab.actions : undefined;
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			/*
				会话工作目录。这是官方 ui-sidebar-files 用的同一个基准 —— 预览地址里
				的相对路径必须以它为根，否则 dsh-resource://file/… 解析不到文件。
			*/
			const useSessions = typeof props.useSessions === "function" ? props.useSessions : EMPTY_SESSIONS;
			const cwd = useSessions((sessions) => {
				const byId = sessions !== null && sessions !== undefined ? sessions.byId : undefined;
				const entry = byId !== null && byId !== undefined ? byId[sessionId] : undefined;
				return entry !== null && entry !== undefined ? entry.cwd : undefined;
			});
			/*
				inputActions 是 ui-conversation 提供给**所有 session scope slot 组件**
				的公开输入面（契约原文："The public input action face provided to every
				session-scope slot component"）。右侧栏 tab 的 scope 正是 session，
				所以这里拿得到：captureInsertion() 取当前插入点，insertText(text, span)
				在一个撤销步里插入纯文本，且不会顶掉用户已经插好的引用芯片。
			*/
			const inputActions = props !== null && props !== undefined ? props.inputActions : undefined;
			return h(ProjectPanel, { sessionId, actions, cwd, inputActions });
		}

		function ProjectPanel(props) {
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			const actions = props !== null && props !== undefined ? props.actions : undefined;
			const cwd = props !== null && props !== undefined && typeof props.cwd === "string" ? props.cwd : "";
			const inputActions = props !== null && props !== undefined ? props.inputActions : undefined;
			const [dir, setDir] = useState(initialDir);
			/*
				顶部只有一个模糊搜索框：树是逐层展开的，想找深层文件只能靠它。
				留空就是普通树视图，有内容就切成搜索结果列表。
			*/
			const [search, setSearch] = useState("");
			const [searchHits, setSearchHits] = useState(null);
			const [searchBusy, setSearchBusy] = useState(false);
			/*
				`name` 搜文件名（子序列模糊匹配），`content` 搜文件里的文字（按行列出）。
				两件事的受众完全一样，但代价差一个量级 —— 内容搜索要真读文件，所以
				不自动降级，让用户自己按那个 `文` 开关说话。
			*/
			const [searchMode, setSearchMode] = useState("name");
			/* 内容搜索结果：{ hits, files, matched, skipped, truncated }。 */
			const [grep, setGrep] = useState(null);
			const [nodes, setNodes] = useState(() => new Map());
			const [expanded, setExpanded] = useState(() => new Set());
			const [selected, setSelected] = useState(null);
			/*
				键盘光标落在哪一行。和 selected 分开：selected 是「当前打开的那个文件」
				（写回、标签都认它），cursor 只是键盘走到哪儿了 —— 合成一份的话，
				上下走一圈就会顺手把开着的标签全换掉。
			*/
			const [cursor, setCursor] = useState(null);
			/* 行内改名：正在改哪一条、草稿是什么。 */
			const [editPath, setEditPath] = useState(null);
			const [editName, setEditName] = useState("");
			/* 右键菜单：{ x, y, entry }。entry 为 null 表示右键落在空白处，落点算工程根。 */
			const [menu, setMenu] = useState(null);
			/*
				「移动到…」选中了源、正等用户点目标目录；null = 不在这个模式里。
				存的是**源路径**（原本是多选后的一整片，多选撤掉后就是一条）。
			*/
			const [moveList, setMoveList] = useState(null);
			/* 拖着东西悬停到哪个目录上（只用来画高亮，值和上次相同时不触发重渲染）。 */
			const [dragOver, setDragOver] = useState("");
			/*
				拖拽中的条目路径。不能指望在 dragover 里读 dataTransfer ——
				浏览器只在 drop 时才让读，所以另存一份。
			*/
			const dragPathRef = useRef(null);
			/* 正在新建：{ parent, kind } 配上草稿名，那一层的开头长出输入行。 */
			const [newAt, setNewAt] = useState(null);
			const [newName, setNewName] = useState("");
			/*
				打开的源码标签，每项是：
				{ mode: "code"|"edit", status, path, name, content, error, withBody, anchor, focus, dragging }
				"code" 是选行视图（拖选行区间、只引用那几行），"edit" 是可写回的文本编辑器。
			*/
			const [shots, setShots] = useState([]);
			/* 当前激活的标签下标；-1 表示一个都没开。 */
			const [shotAt, setShotAt] = useState(-1);
			/* 当前页签：文件树 / 源码。点「源码」或拖文件行时自动切过去。 */
			const [view, setView] = useState("tree");
			const [notice, setNotice] = useState("");

			/* 右键菜单的定位基准（body）和它自己的容器（判断点击在不在菜单里）。 */
			const bodyRef = useRef(null);
			const menuRef = useRef(null);

			/*
				推送状态账本：绝对目录路径（小写归一）→ 扫描节点
				{ key, scope, target, name, relPath, dir, status, aggregate }。
				只有带 page.json / meta.json 的目录才有条目，普通工程的 Map 是空的，
				树里也就不显示徽章 —— 不打扰跟推送无关的项目。
			*/
			const [pushMap, setPushMap] = useState(new Map());
			const [pushBusy, setPushBusy] = useState(false);
			/*
				扫描的「附件」：{ remote, targetLabel, scripts }。
				树上的右键菜单要拿 scripts 判断「脚本真的在不在」（不在就别摆入口），
				拿 remote / targetLabel 决定要不要走二次确认、确认文案里写哪个地址。
			*/
			const [pushInfo, setPushInfo] = useState(null);

			/*
				推送前静态校验的结果：null = 这次会话还没校验过（页签不给切），
				否则是 { dir, kind, issues } 或 { dir, failed: "错误信息" }。
				跟 pushMap 一样按目录走，换工作区就作废。
			*/
			const [lint, setLint] = useState(null);
			const [lintBusy, setLintBusy] = useState(false);

			/*
				「脚本」页签：工作区根下那批 source-*.js（推送 / 拉取 / 克隆）。
				scripts 是 host 给的清单（null = 还没读过），runJob 是当前 / 最近一次运行，log 是拼起来的输出。
			*/
			const [scripts, setScripts] = useState(null);
			const [scriptsBusy, setScriptsBusy] = useState(false);
			const [runJob, setRunJob] = useState(null);
			/* 目标地址不是本机时点「推送」的二次确认：{ name, label }，null = 没在问。 */
			const [runAsk, setRunAsk] = useState(null);
			/* 项目下拉选中的 uuid（"" = 不传，让脚本回落到 .env 的 PROJECT_UUID）。 */
			const [runProject, setRunProject] = useState("");

			/*
				面板自己维护的配置（服务器档案 + 本项目绑定）。workspace 是空目录也能拉项目的前提 ——
				那种目录里根本没有 .env，凭据只能从这儿来。
				null = 还没读过；edit 是正在编辑的档案（{ id, label, serverUrl, username,
				password, cleared }，id 为空就是新建，cleared 表示「要把密码清掉」）；
				password 只在用户刚敲进去时非空，读回来的档案永远是掩码。ENV 不在里面 ——
				它恒写 local，不给用户改。
			*/
			const [config, setConfig] = useState(null);
			const [configBusy, setConfigBusy] = useState(false);
			const [configEdit, setConfigEdit] = useState(null);
			const [configOpen, setConfigOpen] = useState(true);
			/*
				正在手动维护的项目：{ uuid, name }，null = 那张小表单没开着。
				新建时 uuid 为空；改名时 uuid 是原来那个（全量替换靠 uuid 认人）。
			*/
			const [projectEdit, setProjectEdit] = useState(null);

			/*
				编辑器分片（lib/client.editor.js —— esbuild 打出来的 CodeMirror 6）。
				状态机 idle → loading → ready / error；error 时「编辑」退回内置 textarea，
				只是没有高亮和多光标，别的照旧。
			*/
			const [editorMod, setEditorMod] = useState({ status: "idle", mod: null, error: "" });
			const editorViewRef = useRef(null);
			/* 文件树容器：键盘导航得按 DOM 顺序数可见行，从这里捞。 */
			const treeRef = useRef(null);
			/* 脚本输出区：每来一段新输出就滚到底。 */
			const runLogRef = useRef(null);
			/* 运行中的任务：轮询回调只能依赖稳定的身份，最新值从这里读。 */
			const runJobRef = useRef(null);
			runJobRef.current = runJob;
			/* 这一次运行的「推送完了顺手重扫徽章」已经做过没有，防止每轮轮询都重扫。 */
			const runPushDoneRef = useRef("");

			/**
			 * 在鼠标位置弹出右键菜单。
			 *
			 * 坐标换算成相对 body 的偏移，这样 body 滚动、面板宽度变化都不会让菜单飘走
			 * （用 fixed + clientX 的话，外层一旦有 transform 就会偏）。
			 */
			const openMenu = useCallback((event, entry) => {
				const host = bodyRef.current;
				if (host === null) return;
				const rect = host.getBoundingClientRect();
				setMenu({
					x: Math.max(0, Math.min(event.clientX - rect.left, host.clientWidth - 168)),
					/*
						最长的菜单（页面单元：新建两项 + 引用 + 推送前校验 + 重命名 / 移动 / 删除
						+ 推 / 拉这个页面 + 标记已推送 + 刷新 / 重置）有 12 项加两条分隔线
						≈ 360px。贴底时往上顶，别被面板裁掉。
					*/
					y: Math.max(0, Math.min(event.clientY - rect.top, host.clientHeight - 372)),
					entry,
				});
			}, []);

			/* 点到别处就把菜单收掉。capture 阶段监听，免得被行自己的 onClick 先吃掉。 */
			useEffect(() => {
				if (menu === null) return undefined;
				const close = (event) => {
					const node = menuRef.current;
					if (node !== null && node.contains(event.target) === true) return;
					setMenu(null);
				};
				window.addEventListener("mousedown", close, true);
				window.addEventListener("resize", close, true);
				return () => {
					window.removeEventListener("mousedown", close, true);
					window.removeEventListener("resize", close, true);
				};
			}, [menu]);

			const snippet = shotAt >= 0 && shotAt < shots.length ? shots[shotAt] : null;

			/* setShots 的回调里读不到最新的 shotAt，用 ref 带一份（和 nodesRef 一个路数）。 */
			const shotAtRef = useRef(shotAt);
			shotAtRef.current = shotAt;

			/**
			 * 改当前标签；传 null 等于把它关掉。
			 *
			 * 包成和原来的 useState setter 一样的形状，拖选、勾选、编辑器输入这些调用点就不用挨个改。
			 */
			const setSnippet = useCallback((updater) => {
				setShots((prev) => {
					const at = shotAtRef.current;
					if (at < 0 || at >= prev.length) return prev;
					const next = typeof updater === "function" ? updater(prev[at]) : updater;
					const copy = prev.slice();
					if (next === null || next === undefined) {
						copy.splice(at, 1);
						return copy;
					}
					copy[at] = next;
					return copy;
				});
			}, []);

			/*
				回调 ref 里读的是最新的 snippet / editorMod，但它自己的身份必须稳定 ——
				身份一变 React 就会先 ref(null) 再 ref(节点)，等于每渲染一次就把编辑器
				销毁重建一遍（撤销栈、滚动位置全丢）。所以状态经 ref 转发，不写进依赖。
			*/
			const snippetRef = useRef(snippet);
			snippetRef.current = snippet;
			const editorModRef = useRef(editorMod);
			editorModRef.current = editorMod;

			/*
				挂 CodeMirror 的容器。**必须是回调 ref**，不能是 useRef + useEffect。

				切走页签（源码 → 校验 / 文件树）时 renderDetail() 整个被换掉，容器从 DOM
				上卸了，可实例还在 editorViewRef 里没销毁 —— 因为那个 effect 的依赖
				（snippet / editorMod）一个都没变，它根本不跑。切回来时新容器是空的，
			而 effect 就算跑了也会被 `editorViewRef.current !== null` 挡回去，
				于是源码页签只剩一片空白。回调 ref 跟着 DOM 的挂载/卸载走，没这个空档。
			*/
			const editorHostRef = useCallback((node) => {
				const previous = editorViewRef.current;
				if (previous !== null) {
					previous.handle.destroy();
					editorViewRef.current = null;
				}
				if (node === null) return;
				const target = snippetRef.current;
				const mod = editorModRef.current;
				/* 容器只在「编辑态 + 分片就绪」时才渲染，这两条是防手滑的兜底。 */
				if (target === null || target.mode !== "edit") return;
				if (mod.status !== "ready") return;
				const caret = caretOf(target);
				try {
					const handle = mod.mod.createEditor(node, {
						path: target.path,
						doc: target.content,
						line: caret,
						onChange: (text) => {
							setSnippet((prev) => (prev === null ? prev : Object.assign({}, prev, { content: text })));
						},
					});
					editorViewRef.current = { path: target.path, caret, handle };
					handle.focus();
				} catch (error) {
					setEditorMod({
						status: "error",
						mod: null,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}, []);

			/*
				按需拉编辑器分片：require.async 走宿主的分片协议，第一次真要用编辑器才发请求。
				拉不到不算致命 —— 编辑态退回内置 textarea，只是没有高亮和多光标。
			*/
			useEffect(() => {
				let alive = true;
				setEditorMod((prev) => (prev.status === "idle" ? { status: "loading", mod: null, error: "" } : prev));
				require.async("./client.editor.js").then(
					(mod) => {
						if (alive) setEditorMod({ status: "ready", mod, error: "" });
					},
					(error) => {
						if (alive) {
							setEditorMod({
								status: "error",
								mod: null,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					},
				);
				return () => {
					alive = false;
				};
			}, []);

			/*
				同一个文件里又点了一条命中行：不重建编辑器（那会丢掉滚动位置和撤销栈），
				只把光标挪过去。`current.caret` 记着已经跳过的行，重复点同一行不折腾。

				换文件不用管：容器的 key 是路径，路径一变 React 就换节点，
				重建交给上面的回调 ref。
			*/
			useEffect(() => {
				const current = editorViewRef.current;
				if (current === null || snippet === null || snippet.mode !== "edit") return;
				if (current.path !== snippet.path) return;
				const caret = caretOf(snippet);
				if (caret === 0 || current.caret === caret) return;
				current.handle.revealLine(caret);
				current.caret = caret;
				current.handle.focus();
			}, [snippet]);

			/* 面板整个被卸载时（比如关掉工程 tab）别把编辑器实例和它的监听留在那儿。 */
			useEffect(
				() => () => {
					if (editorViewRef.current !== null) {
						editorViewRef.current.handle.destroy();
						editorViewRef.current = null;
					}
				},
				[],
			);

			/** 按路径改某个标签：读取是异步的，回来时下标可能已经被别的操作挪过了。 */
			const patchShot = useCallback((path, patch) => {
				setShots((prev) => {
					const at = prev.findIndex((shot) => shot.path === path);
					if (at < 0) return prev;
					const copy = prev.slice();
					copy[at] = Object.assign({}, copy[at], patch);
					return copy;
				});
			}, []);

			/* 标签被关掉后把下标夹回合法范围；一个都不剩就退回文件树。 */
			useEffect(() => {
				if (shots.length === 0) {
					if (shotAt !== -1) setShotAt(-1);
					if (view === "code") setView("tree");
					return;
				}
				if (shotAt < 0 || shotAt >= shots.length) setShotAt(shots.length - 1);
			}, [shots.length, shotAt, view]);

			/** 展开前查「这一层拉过没有」需要读到最新的 nodes，又不该进依赖数组。 */
			const nodesRef = useRef(nodes);
			nodesRef.current = nodes;

			const dirRef = useRef(dir);
			dirRef.current = dir;

			/* 拖选时松开鼠标就结束：mouseup 可能落在任何元素上，所以挂在 window 上。 */
			useEffect(() => {
				const stop = () =>
					setSnippet((prev) => (prev !== null && prev.dragging === true ? Object.assign({}, prev, { dragging: false }) : prev));
				window.addEventListener("mouseup", stop);
				return () => window.removeEventListener("mouseup", stop);
			}, []);

			/*
				Esc 退出「移动到…」模式：这个模式里点哪儿都是在指目标，得留个出口。
			*/
			useEffect(() => {
				if (moveList === null) return undefined;
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					setMoveList(null);
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [moveList]);

			/*
				默认根：用户上次打开过的目录优先（initialDir 已从 localStorage 读过），
				但它必须落在**当前会话的 cwd** 之下 —— 必须与官方文件树同一个基准，
				预览地址里的相对路径才解析得到文件。
				cwd 是异步到位的，所以单独跟着它走；记忆已失效（比如记着别的工作区）
				时直接改落到 cwd。
			*/
			useEffect(() => {
				if (cwd === "") return;
				const remembered = dirRef.current.trim();
				if (remembered !== "" && isUnder(remembered, cwd)) return;
				if (remembered === cwd) return;
				writeStored(DIR_KEY, cwd);
				setDir(cwd);
			}, [cwd]);

			/** 拉某一层的目录清单。 */
			const loadLevel = useCallback(async (path) => {
				setNodes((prev) => new Map(prev).set(path, { status: "loading", entries: [] }));
				const result = await call("listProjectEntries", path);
				setNodes((prev) => {
					const next = new Map(prev);
					if (result.ok !== true) {
						next.set(path, { status: "error", error: result.error ?? "读取失败", entries: [] });
						return next;
					}
					const value = result.value ?? {};
					next.set(path, {
						status: "ready",
						entries: Array.isArray(value.entries) ? value.entries : [],
						truncated: value.truncated === true,
						error: "",
					});
					return next;
				});
			}, []);

			/**
			 * 拉一次推送状态账本。
			 *
			 * 扫描是递归遍历 + 逐文件 stat，工程大了要几百毫秒，所以做成显式动作：
			 * 换工作区时自动来一次，之后靠右键菜单里的「刷新推送状态」。
			 */
			const loadPushStatus = useCallback(async (target) => {
				const root = String(target ?? "").trim();
				if (root === "") {
					setPushMap(new Map());
					setPushInfo(null);
					return;
				}
				setPushBusy(true);
				/*
					这一次扫描连着跑校验（host 侧带 mtime 缓存：真项目冷缓存约 1.3 秒、全命中约 0.5 秒），
					所以拿回来的节点自带 errors / warns / lintable / pushable，
					树里那些 ✔ 和 ✗N 徽章就是从这里来的。没有额外参数。
				*/
				const result = await call("projectPushStatus", root);
				setPushBusy(false);
				if (result.ok !== true) {
					/* 扫不动（比如根本不是低代码工程）就当没有账本，树里不显示徽章。 */
					setPushMap(new Map());
					setPushInfo(null);
					setNotice("推送状态扫描失败：" + (result.error ?? ""));
					return;
				}
				const value = result.value ?? {};
				const next = new Map();
				for (const item of Array.isArray(value.nodes) ? value.nodes : []) {
					if (item === null || typeof item !== "object" || typeof item.dir !== "string") continue;
					next.set(pathKey(item.dir), item);
				}
				setPushMap(next);
				setPushInfo({
					path: root,
					remote: value.remote === true,
					targetLabel: String(value.targetLabel ?? ""),
					scripts: Array.isArray(value.scripts) ? value.scripts.map((name) => String(name)) : [],
				});
			}, []);

			/**
			 * 标记某个节点为已推送，然后重扫一遍刷新徽章。
			 *
			 * 右键「标记已推送」走默认那套（祖先、自己、子孙全刷）；跑完单个页面 / API 的
			 * 推拉之后自动记账传 `noAncestors: true` —— 推一个子页面并没有把父页面**自己的
			 * 内容**推上去，把父页面也点绿就是撒谎。子孙那一半照刷，因为推一个目录
			 * 确实会把里面所有页面一起推上去（`source-page-push.js` 就是这么干的）。
			 */
			const markPushed = useCallback(
				async (node, noAncestors) => {
					if (node === null || node === undefined) return;
					const relDir = relativeUnder(dir, node.dir);
					const result = await call("projectMarkPushed", dir, relDir, node.scope, node.target, noAncestors === true ? true : undefined);
					setNotice(
						result.ok === true
							? "已标记为已推送：" + String(node.name ?? node.relPath ?? "")
							: "标记失败：" + (result.error ?? ""),
					);
					await loadPushStatus(dir);
				},
				[dir, loadPushStatus],
			);

			/**
			 * 单个页面 / API 跑完（退出码 0）之后，把它记成已推送。
			 *
			 * 不这么做的话徽章永远停在跑之前那个样子，两个方向都解释得通、都错：
			 * 推送**不改本地文件**，所以重扫一遍快照还是旧的、照样是「待推送」；
			 * 拉取改了本地文件，但通用重扫只在推送类脚本跑完才触发——连扫都不扫。
			 *
			 * `noAncestors: true`：不连带祖先。子孙照记 —— 推 / 拉一个目录会把里面所有
			 * 页面一起带上去，只记目录自己会让子页面挂着「待推送」（用户实测报过）。
			 */
			const markUnitPushed = useCallback(
				async (node, wasPush) => {
					if (node === null || node === undefined) return;
					const relDir = relativeUnder(dir, node.dir);
					const result = await call("projectMarkPushed", dir, relDir, node.scope, node.target, true);
					if (result.ok !== true) {
						setNotice("这一步跑完了，但状态没记上：" + (result.error ?? ""));
						return;
					}
					setNotice(
						(wasPush === true ? "推送完成：" : "拉取完成：") +
							String(node.name ?? node.relPath ?? "") +
							"（状态已更新）",
					);
					await loadPushStatus(dir);
				},
				[dir, loadPushStatus],
			);

			/**
			 * 拉取类脚本跑完（退出码 0）之后，把刚被服务器盖过的那一片重记成「已推送」。
			 *
			 * 为什么不能只重扫：账本记的是**本地文件的 mtime**，而徽章回答的是「本地有没有
			 * 服务器上还没有的改动」。刚拉下来时本地 == 服务器 —— 答案是「没有」，可文件
			 * 是重写的、mtime 全变了。不重记的话，删掉本地重新拉一次，一进去就是整片橙。
			 *
			 * `zone` 由 host 在脚本清单里给（`syncZone`）：`pages` / `apis` / `databases`，
			 * 或 `*` 表示整个项目目录（clone 用）。`project` 是项目下拉选中的 uuid，
			 * 空串就让 host 回落到 `.env` 里生效的那条。
			 */
			const resyncPush = useCallback(
				async (zone, project) => {
					const result = await call("projectResyncPush", dir, zone, project);
					if (result.ok !== true) {
						setNotice("拉取完成，但推送状态没跟着重记：" + (result.error ?? ""));
						return;
					}
					const dropped = Number((result.value ?? {}).dropped);
					setNotice(
						"拉取完成，本地内容已与服务器一致" +
							(Number.isFinite(dropped) && dropped > 0 ? "（同步了 " + dropped + " 个单元的推送状态）" : "") +
							"。",
					);
					await loadPushStatus(dir);
				},
				[dir, loadPushStatus],
			);

			/**
			 * 清空**这个工作区**的推送账（账本按工作区隔离，别的工作区那几份不动）。
			 * 下次扫描会把现存单元重新登记成「已推送」。
			 */
			const resetPushState = useCallback(
				async () => {
					const result = await call("projectResetPushState", dir);
					if (result.ok !== true) {
						setNotice("重置失败：" + (result.error ?? ""));
					} else {
						const dropped = Number((result.value ?? {}).dropped);
						setNotice(Number.isFinite(dropped) ? "已清掉这个工作区的 " + dropped + " 条推送记录。" : "这个工作区的推送记录已清空。");
					}
					await loadPushStatus(dir);
				},
				[dir, loadPushStatus],
			);

			/**
			 * 对一个目录（页面目录 / API 目录）跑推送前静态校验，结果送去「校验」页签。
			 *
			 * 不在这里拦「这目录有没有 page.json」：host 会把 not-a-page-or-api 当
			 * 正常失败报回来，那本身就是要给用户看的一句话，界面上说清楚比在这里沉默好。
			 */
			const runLint = useCallback(async (target) => {
				const root = String(target ?? "").trim();
				if (root === "") return;
				setLintBusy(true);
				const result = await call("projectLint", root);
				setLintBusy(false);
				if (result.ok === true) {
					setLint(Object.assign({ issues: [] }, result.value ?? {}));
				} else {
					/* 校验本身没跑起来（不是「发现了问题」），页签里如实报这一条。 */
					setLint({ dir: root, kind: "", issues: [], failed: String(result.error ?? "校验失败") });
				}
				setView("lint");
			}, []);

			/**
			 * 拉工作区根下那批脚本（推送 / 拉取 / 克隆的 source-*.js）。
			 *
			 * 清单里带 .env 的 SERVER_URL 与「是不是外网」：地址在外网时跑推送类脚本，
			 * host 会用 needs-confirm 拒回来，得用户在界面上再点一次才带 confirm 重来 ——
			 * 「发到外面」不该是一次点击的事。另外顺带把 .env 注释里那批项目 uuid 收成
			 * 候选清单，界面上给带 project 标记的脚本渲染项目下拉。
			 */
			const loadScripts = useCallback(async (target) => {
				const root = String(target ?? "").trim();
				if (root === "") return;
				setScriptsBusy(true);
				const result = await call("projectListScripts", root);
				setScriptsBusy(false);
				if (result.ok === true) {
					setScripts(
						Object.assign(
							{ path: root, env: "", remote: false, targetLabel: "", projectUuid: "", projects: [], scripts: [] },
							result.value ?? {},
						),
					);
				} else {
					setScripts({
						path: root,
						env: "",
						remote: false,
						targetLabel: "",
						projectUuid: "",
						projects: [],
						scripts: [],
						failed: String(result.error ?? "读取脚本清单失败"),
					});
				}
			}, []);

			/**
			 * 跑一个脚本。host 不等它跑完（推送要好几分钟），只回一个 runId，
			 * 之后靠 projectRunScriptPoll 一段段把输出取回来。
			 *
			 * confirmed === true 才把 confirm 传上去；目标是外网时的推送类脚本不传会被 host 拒。
			 */
			const startRun = useCallback(
				async (item, confirmed) => {
					const root = String(dir ?? "").trim();
					if (root === "" || item === null || item === undefined || typeof item.name !== "string") return;
					setRunAsk(null);
					/*
						project: true 的脚本第一个位置参数就是项目 uuid（脚本里是
						`process.argv[2] || process.env.PROJECT_UUID`）。下拉选了就用选的，
						没选就不传，让脚本自己回落到 .env 那行 —— 这样默认行为和以前完全一样。
					*/
					const picked = item.project === true ? String(runProject ?? "").trim() : "";
					const extra = picked === "" ? (Array.isArray(item.args) ? item.args : []) : [picked];
					const result = await call("projectRunScript", root, item.name, extra, confirmed === true);
					const label = String(item.label ?? item.name);
					if (result.ok === true) {
						const value = result.value ?? {};
						setRunJob({
							runId: String(value.runId ?? ""),
							script: String(value.script ?? item.name),
							label,
							cmd: String(value.cmd ?? ""),
							push: item.mode === "push",
							/* 从树右键发起的单单元运行会带上节点；跑完要凭它记账（见 pollRun）。 */
							unit: item.unit === undefined ? null : item.unit,
							/* 拉取类才有：跑完要把这一片重记一遍（`""` = 不用重记）。 */
							syncZone: item.syncZone === undefined ? "" : String(item.syncZone),
							project: item.project === true ? picked : "",
							log: "",
							next: 0,
							running: true,
							code: null,
							killed: false,
							truncated: false,
							error: "",
						});
						return;
					}
					/*
						needs-confirm 说明手里这份清单过期了（.env 刚被改到外网地址）——
						顺手重拉清单，把「线上」的标红和二次确认补上。
					*/
					if (result.code === "needs-confirm") {
						setRunAsk({ name: item.name, label });
						void loadScripts(root);
						return;
					}
					setRunJob({
						runId: "",
						script: item.name,
						label,
						cmd: "",
						push: item.mode === "push",
						unit: item.unit === undefined ? null : item.unit,
						syncZone: item.syncZone === undefined ? "" : String(item.syncZone),
						project: item.project === true ? picked : "",
						log: "",
						next: 0,
						running: false,
						code: null,
						killed: false,
						truncated: false,
						error: String(result.error ?? "启动失败"),
					});
				},
				[dir, loadScripts, runProject],
			);

			/** 取一段新输出（只取 since 之后的，日志长了也不会整份重传）。 */
			const pollRun = useCallback(
				async () => {
					const job = runJobRef.current;
					if (job === null || job.runId === "") return;
					const result = await call("projectRunScriptPoll", job.runId, job.next);
					if (result.ok !== true) {
						setRunJob((prev) =>
							prev === null || prev.runId !== job.runId
								? prev
								: Object.assign({}, prev, { running: false, error: String(result.error ?? "取输出失败") }),
						);
						return;
					}
					const value = result.value ?? {};
					setRunJob((prev) => {
						if (prev === null || prev.runId !== job.runId) return prev;
						return Object.assign({}, prev, {
							log: prev.log + String(value.chunk ?? ""),
							next: Number(value.next) >= 0 ? Number(value.next) : prev.next,
							running: value.running === true,
							code: typeof value.code === "number" ? value.code : prev.code,
							killed: value.killed === true,
							truncated: value.truncated === true,
						});
					});
					/*
						跑完一波，只对这一次 runId 做一遍收尾。

						- 单个页面 / API 的推或拉：退出码 0 就把它（连同子孙）记成已推送
						  （`markUnitPushed` 自己会重扫）。不记的话徽章永远停在跑之前那样 ——
						  推送不改本地文件，重扫也看不出差异。
						- 拉取类脚本（脚本页签发的整片拉取）：退出码 0 就把这一片重记一遍
						  （`resyncPush`）。拉下来的内容跟服务器一致，本地没有「服务器上还没有
						  的改动」，可 mtime 全变了 —— 不重记就会整片显示「待推送」。
						- 其余情况（推送类脚本）：重扫一遍就够了。
						  被停掉（killed）和输出超限（truncated）都不算成功，不记账。
					*/
					if (value.running !== true && value.killed !== true && runPushDoneRef.current !== job.runId) {
						const unit = job.unit === undefined ? null : job.unit;
						const zone = typeof job.syncZone === "string" ? job.syncZone : "";
						if (value.code === 0 && unit !== null) {
							runPushDoneRef.current = job.runId;
							await markUnitPushed(unit, job.push === true);
						} else if (value.code === 0 && zone !== "") {
							runPushDoneRef.current = job.runId;
							await resyncPush(zone, typeof job.project === "string" ? job.project : "");
						} else if (job.push === true) {
							runPushDoneRef.current = job.runId;
							void loadPushStatus(String(dir ?? ""));
						}
					}
				},
				[dir, loadPushStatus, markUnitPushed, resyncPush],
			);

			const stopRun = useCallback(async () => {
				const job = runJobRef.current;
				if (job === null || job.runId === "") return;
				const result = await call("projectRunScriptStop", job.runId);
				if (result.ok !== true) setNotice("停止失败：" + (result.error ?? ""));
				/* 不在这里把 running 改掉：host 报 running:false 才算真结束，等下一次轮询。 */
				await pollRun();
			}, [pollRun]);

			/* ------------------------------------------------- 面板自己维护的配置 */

			/**
			 * 读面板自己维护的配置（服务器档案 + 本工作区的绑定）。
			 *
			 * 为什么要有这个东西：凭据原本只从工作区的 .env 来，可是**空目录里根本没有 .env** ——
			 * 想在一个空白文件夹里拉服务器上的项目，地址 / 账号 / 项目 id 就没处填。
			 * 现在存在 DSH_HOME 下的 project-config.json 里，由面板维护；跑脚本前 host 再
			 * 合并写进工作区的 .env（脚本只认 .env 和 process.env）。
			 *
			 * 密码读回来永远是掩码：host 只给 hasPassword，值留在磁盘上，界面上看不见也不需要看见。
			 */
			const loadConfig = useCallback(async (target) => {
				const root = String(target ?? "").trim();
				setConfigBusy(true);
				const result = await call("projectGetConfig", root);
				setConfigBusy(false);
				if (result.ok !== true) {
					setNotice("读取配置失败：" + (result.error ?? ""));
					return;
				}
				setConfig(
					Object.assign(
						{
							path: root,
							servers: [],
							binding: { serverId: "", projectUuid: "" },
							hasEnv: false,
							env: null,
							scaffold: { modules: "", ready: false, busy: false, code: null, error: "", log: "" },
						},
						result.value ?? {},
					),
				);
			}, []);

			/**
			 * 存一个服务器档案（draft.id 为空是新建）。密码不是字符串就不传 —— host 会保留原来的。
			 *
			 * ENV **不读 draft.env，恒传 `local`** —— 这是面板级的约定（没有本地 / 线上的环境之分，
			 * 见 NOTES「再往前一步：ENV 也删了」）。写死在这一处而不是让调用方带：哪天有人从别处
			 * 调 saveServer 忘了带，档案就存成空串，而 host 那边空串 = 不写 ENV 行。
			 */
			const saveServer = useCallback(
				async (draft) => {
					const result = await call(
						"projectSaveServer",
						String(draft.id ?? ""),
						String(draft.label ?? ""),
						String(draft.serverUrl ?? ""),
						String(draft.username ?? ""),
						typeof draft.password === "string" ? draft.password : undefined,
						"local",
					);
					if (result.ok !== true) {
						setNotice("保存档案失败：" + (result.error ?? ""));
						return false;
					}
					setConfigEdit(null);
					await loadConfig(dir);
					return true;
				},
				[dir, loadConfig],
			);

			const deleteServer = useCallback(
				async (id) => {
					const result = await call("projectDeleteServer", String(id ?? ""));
					if (result.ok !== true) {
						setNotice("删除档案失败：" + (result.error ?? ""));
						return;
					}
					await loadConfig(dir);
				},
				[dir, loadConfig],
			);

			/** 换档案 / 换项目：只改配置里的绑定，不碰 .env（落盘走「写入 .env」按钮）。 */
			const bindWorkspace = useCallback(
				async (serverId, projectUuid) => {
					const root = String(dir ?? "").trim();
					if (root === "") return;
					const result = await call("projectBindWorkspace", root, String(serverId ?? ""), String(projectUuid ?? ""));
					if (result.ok !== true) {
						setNotice("绑定失败：" + (result.error ?? ""));
						return;
					}
					await loadConfig(root);
				},
				[dir, loadConfig],
			);

			/**
			 * 全量存某个档案下的项目清单（改名 = 用同一个 uuid 再存一次）。
			 *
			 * 这是「空目录也能拉项目」缺的最后一块：可选项目原先只从 `.env` 注释里捡，
			 * 新铺的 `.env` 一条注释都没有，下拉是空的，脚本就没得拉。
			 */
			const saveProjects = useCallback(
				async (serverId, list) => {
					const id = String(serverId ?? "");
					if (id === "") return false;
					setConfigBusy(true);
					const result = await call("projectSetProjects", id, Array.isArray(list) ? list : []);
					setConfigBusy(false);
					if (result.ok !== true) {
						setNotice("保存项目失败：" + (result.error ?? ""));
						return false;
					}
					setProjectEdit(null);
					await loadConfig(dir);
					return true;
				},
				[dir, loadConfig],
			);

			/** 把当前绑定写进工作区的 .env。host 会先备份、注释行一行不动。 */
			const applyConfig = useCallback(async () => {
				const root = String(dir ?? "").trim();
				if (root === "") return;
				setConfigBusy(true);
				const result = await call("projectApplyConfig", root, "", "");
				setConfigBusy(false);
				if (result.ok !== true) {
					setNotice("写入 .env 失败：" + (result.error ?? ""));
					return;
				}
				const value = result.value ?? {};
				const backup = String(value.backup ?? "");
				if (value.unchanged === true) setNotice(String(value.path ?? ".env") + " 已经是当前配置，没动它");
				else setNotice("已写入 " + String(value.path ?? ".env") + (backup === "" ? "（原来没有 .env，新建的）" : "（旧文件备份在 " + backup + "）"));
				await loadConfig(root);
				await loadScripts(root);
				/* 新写的 .env 得在左边的文件树里露头。 */
				await loadLevel(root);
			}, [dir, loadConfig, loadScripts, loadLevel]);

			/** 把插件自带的脚手架铺到工作区根下 —— 空目录要能拉项目，先得有那几个 source-*.js。 */
			const scaffoldWorkspace = useCallback(async () => {
				const root = String(dir ?? "").trim();
				if (root === "") return;
				setConfigBusy(true);
				const result = await call("projectScaffold", root);
				if (result.ok !== true) {
					setConfigBusy(false);
					setNotice("铺脚手架失败：" + (result.error ?? ""));
					return;
				}
				const value = result.value ?? {};
				/* 模板要用的 npm 依赖没装就顺手装上：只装一次，装在插件目录里，以后所有工作区共用。 */
				if (value.needDeps === true) {
					const deps = await call("projectScaffoldDeps");
					if (deps.ok !== true) setNotice("脚手架已铺好，但装依赖失败：" + (deps.error ?? ""));
				}
				setConfigBusy(false);
				setNotice("铺好了 " + (Array.isArray(value.copied) ? value.copied.length : 0) + " 个文件（跳过 " + (Array.isArray(value.skipped) ? value.skipped.length : 0) + " 个已存在的）");
				await loadConfig(root);
				await loadScripts(root);
				/* 铺进来的 source-*.js 得在左边的文件树里露头，否则用户以为没生效。 */
				await loadLevel(root);
			}, [dir, loadConfig, loadScripts, loadLevel]);

			/* 装依赖是在 host 那边后台跑的，装的时候每秒看一眼进度。 */
			const scaffoldBusy = config !== null && config.scaffold !== null && config.scaffold.busy === true;
			useEffect(() => {
				if (scaffoldBusy !== true) return undefined;
				const timer = setInterval(() => {
					void loadConfig(dir);
				}, 1000);
				return () => clearInterval(timer);
			}, [scaffoldBusy, dir, loadConfig]);

			/* 进了「脚本」页签才读配置；页签外不麻烦 host。 */
			useEffect(() => {
				if (view !== "run") return;
				if (config !== null && String(config.path ?? "") === String(dir ?? "")) return;
				void loadConfig(dir);
			}, [view, config, dir, loadConfig]);

			/* 跑着的时候每 500ms 取一段输出；runId 一换就换一个定时器。 */
			const runId = runJob === null ? "" : String(runJob.runId ?? "");
			const runRunning = runJob !== null && runJob.running === true;

			/**
			 * 在树上直接推 / 拉**一个**页面或 API（不是整个项目）。
			 *
			 * 这四个脚本本来就吃一个 uuid / id 当第一个参数（`source-page-push.js <uuid>`），
			 * 面板只是把树上这一颗的 `target` 递下去 —— 脚本一行都不用改。
			 *
			 * `confirmed` 只有 `.env` 的 SERVER_URL 指向外网时才有意义：那边一律要二次
			 * 确认（推和拉一样），而确认是在**菜单里**问的（`menu.confirm` 那一屏），
			 * 问完才带着 `true` 进来。所以这里不再自己弹东西。
			 *
			 * 放在这个位置是有原因的：它要用 `runRunning`，而 `runRunning` 在
			 * `startRun` 后面才声明 —— 塞进 `startRun` 的依赖数组会踩 TDZ。
			 */
			const startUnit = useCallback(
				async (node, verb, confirmed) => {
					if (runRunning === true) {
						setNotice("已经有一个任务在跑 —— 等它结束，或者先去「脚本」页签把它停掉");
						return;
					}
					const kind = String(node === null || node === undefined ? "" : node.scope ?? "");
					if (kind !== "page" && kind !== "api") return;
					const noun = kind === "page" ? "页面" : "API";
					const name = String(node.name ?? node.target ?? "");
					/* 输出在「脚本」页签那个控制台里，跑起来就把人送过去 —— 和「校验」跳页签同一套先例。 */
					setView("run");
					await startRun(
						{
							name: (kind === "page" ? "source-page-" : "source-api-") + verb + ".js",
							label: (verb === "push" ? "推送" : "拉取") + noun + "「" + name + "」",
							args: [String(node.target ?? "")],
							mode: verb,
							project: false,
							/* 跑完要凭这个节点记账，见 pollRun / markUnitPushed。 */
							unit: node,
						},
						confirmed === true,
					);
				},
				[runRunning, setView, startRun],
			);

			useEffect(() => {
				if (runRunning !== true || runId === "") return undefined;
				const timer = setInterval(() => {
					void pollRun();
				}, 500);
				return () => clearInterval(timer);
			}, [runId, runRunning, pollRun]);

			/* 有新输出就把控制台滚到底 —— 这种地方人永远只想看最后几行。 */
			const runLog = runJob === null ? "" : String(runJob.log ?? "");
			useEffect(() => {
				const node = runLogRef.current;
				if (node !== null) node.scrollTop = node.scrollHeight;
			}, [runLog]);

			/* 进了「脚本」页签（或在这个页签上换了工作区）才去读清单，不进就不麻烦 host。 */
			useEffect(() => {
				if (view !== "run") return;
				if (scripts !== null || scriptsBusy === true) return;
				void loadScripts(dir);
			}, [view, scripts, scriptsBusy, dir, loadScripts]);

			/** 换工程目录时清掉行内编辑态、新建输入行、右键菜单、校验结果，并重拉推送状态。 */
			useEffect(() => {
				setNewAt(null);
				setNewName("");
				setEditPath(null);
				setEditName("");
				setMenu(null);
				/* 校验结果属于上一个工作区，留着会误导；页签自己会退化成不可点。 */
				setLint(null);
				setView((prev) => (prev === "lint" ? "tree" : prev));
				/* 脚本清单同理：跟上一条工作区绑定，换目录后由页签里那个 effect 重新拉。 */
				setScripts(null);
				setRunJob(null);
				setRunAsk(null);
				/* 项目下拉的选中项也属于上一条工作区的 .env，跟着清掉。 */
				setRunProject("");
				/* 配置属于上一条工作区（绑定是按工作区存的）；页签里那个 effect 会重新拉。 */
				setConfig(null);
				setConfigEdit(null);
				setProjectEdit(null);
				void loadPushStatus(dir);
			}, [dir, loadPushStatus]);

			/** 改名或删除之后，路径已经作废的源码标签直接关掉，别留悬空引用。 */
			const dropShotsUnder = useCallback((path) => {
				const stem = String(path).replace(/[\\/]+$/, "");
				const back = stem + "\\";
				const forward = stem + "/";
				setShots((prev) => {
					const next = prev.filter((shot) => shot.path !== stem && !shot.path.startsWith(back) && !shot.path.startsWith(forward));
					return next.length === prev.length ? prev : next;
				});
			}, []);

			/** 工具条那一行（新建）回车 / 点「创建」。 */
			const submitNew = useCallback(async () => {
				if (newAt === null) return;
				const name = newName.trim();
				if (name === "") {
					setNotice("先给个名字。");
					return;
				}
				/* 目录没有模板；文件按扩展名套一份骨架，没命中（null）就传空串。 */
				const body = newAt.kind === "directory" ? null : templateFor(name);
				const result = await call("projectCreateEntry", newAt.parent, name, newAt.kind, body === null ? "" : body);
				if (result.ok !== true) {
					setNotice("新建失败：" + (result.error ?? ""));
					return;
				}
				const created = result.value ?? {};
				const shown = typeof created.path === "string" ? created.path : name;
				/* 套了模板才提这一句 —— 空文件本来就是这个面板一贯的行为，不用报。 */
				setNotice(body === null ? "已新建 " + shown : "已新建 " + shown + "（套用了 ." + name.slice(name.lastIndexOf(".") + 1) + " 模板）");
				setExpanded((prev) => new Set(prev).add(newAt.parent));
				void loadLevel(newAt.parent);
				setNewAt(null);
				setNewName("");
			}, [newAt, newName, loadLevel]);

			/** 行内改名的输入框回车 / 点「确定」。 */
			const submitRename = useCallback(
				async (entry) => {
					const name = editName.trim();
					if (name === "") {
						setNotice("先给个名字。");
						return;
					}
					if (name === entry.name) {
						setEditPath(null);
						return;
					}
					const result = await call("projectRenameEntry", entry.path, name);
					if (result.ok !== true) {
						setNotice("改名失败：" + (result.error ?? ""));
						return;
					}
					setEditPath(null);
					setEditName("");
					setNotice("已改名为 " + name);
					dropShotsUnder(entry.path);
					if (selected === entry.path) setSelected(null);
					/* 光标还钉在旧路径上的话，接下来按方向键会找不到它。 */
					if (cursor === entry.path) setCursor(null);
					void loadLevel(parentOf(entry.path));
				},
				[editName, selected, cursor, dropShotsUnder, loadLevel],
			);

			/**
			 * 删除。目录会连着里面的东西一起没，所以必须先问一句。
			 */
			const removeEntry = useCallback(
				async (entry) => {
					if (typeof window.confirm === "function") {
						const ask =
							"删掉这个" + (entry.kind === "directory" ? "文件夹（连同里面的全部内容）" : "文件") + "？\n\n" + entry.path;
						if (window.confirm(ask) !== true) return;
					}
					const result = await call("projectDeleteEntry", entry.path);
					if (result.ok !== true) {
						setNotice(result.error ?? "删除失败");
						return;
					}
					dropShotsUnder(entry.path);
					if (selected === entry.path) setSelected(null);
					if (cursor === entry.path) setCursor(null);
					setNotice("已删除 " + entry.name);
					void loadLevel(parentOf(entry.path));
				},
				[selected, cursor, dropShotsUnder, loadLevel],
			);

			/**
			 * 把开着源码标签的路径跟着搬家一起挪。
			 *
			 * 不挪的话标签还挂在旧路径上 —— 点「写回」会往一个已经不存在的位置写，
			 * 轻则报错，重则把文件在旧地方重新创建出来（那才是最糟的）。
			 */
			const remapShots = useCallback((from, to) => {
				const stem = String(from).replace(/[\\/]+$/, "");
				setShots((prev) => {
					if (!prev.some((shot) => under(stem, shot.path))) return prev;
					return prev.map((shot) => {
						if (!under(stem, shot.path)) return shot;
						const moved = to + shot.path.slice(stem.length);
						return Object.assign({}, shot, { path: moved, name: baseNameOf(moved) });
					});
				});
				/*
					编辑器实例自己也记着一份路径。不跟着改的话，挂载 effect 会以为
					「换文件了」，把实例销毁重建 —— 内容还在（shots 里留着），
					但滚动位置和撤销栈就没了。
				*/
				const view = editorViewRef.current;
				if (view !== null && under(stem, view.path)) view.path = to + view.path.slice(stem.length);
			}, []);

			/**
			 * 把一个条目搬进另一个目录（文件树右键「移动到…」和拖拽都走这里）。
			 *
			 * 搬完要刷新源和目标**两边的**层级 —— 只刷一边的话，
			 * 旧位置会留下一行幽灵（盘上已经没了，界面上还挂着）。
			 */
			const moveEntry = useCallback(
				async (path, parent) => {
					setMoveList(null);
					setDragOver("");
					const from = typeof path === "string" ? path : "";
					if (from === "") return;
					const want = String(parent);
					/* 已经在目标目录里的先剔掉：搬到原地是白跑，还会刷出一堆没用的报错。 */
					if (parentOf(from).toLowerCase() === want.toLowerCase()) {
						setNotice("它已经在那个目录里了。");
						return;
					}
					const result = await call("projectMoveEntry", from, want);
					if (result.ok !== true) {
						setNotice(result.error ?? "移动失败");
						return;
					}
					const value = result.value !== null && typeof result.value === "object" ? result.value : {};
					const moved = typeof value.path === "string" && value.path !== "" ? value.path : want + "\\" + baseNameOf(from);
					remapShots(from, moved);
					if (selected === from) setSelected(moved);
					if (cursor === from) setCursor(moved);
					setNotice("已移动到 " + moved);
					/* 目标目录可能是收着的，展开它，不然看不出东西搬进去了。 */
					setExpanded((prev) => new Set(prev).add(want));
					void loadLevel(parentOf(from));
					void loadLevel(want);
				},
				[selected, cursor, remapShots, loadLevel],
			);

			/**
			 * 每个工程目录各留一份浏览状态（展开的目录、拉过的层级、开着的源码标签）。
				切走再切回来就直接接上，不用重新点一遍。
			*/
			const dirStatesRef = useRef(new Map());
			/*
				故意从 null 起步，不能写成 useRef(dir)。
				写成 useRef(dir) 的话首屏那次 effect 里 prev === dir 直接 return，
				第一次永远发不出请求，树就卡在「读取中」，非要点一下打开/刷新才行。
			*/
			const prevDirRef = useRef(null);

			/** 换目录：能接上缓存就接上，接不上才整棵树推倒重来。 */
			useEffect(() => {
				const prev = prevDirRef.current;
				/* loadLevel 换了个身份也会跑到这里，那种情况什么都不该动。 */
				if (prev === dir) return;
				prevDirRef.current = dir;
				/* 存旧的（此刻闭包里还是旧目录的状态，还没被下面的 set 冲掉）。 */
				if (prev !== null) dirStatesRef.current.set(prev, { expanded, nodes, selected, shots, shotAt, view });
				const saved = dirStatesRef.current.get(dir);
				if (saved !== undefined) {
					setExpanded(saved.expanded);
					setNodes(saved.nodes);
					setSelected(saved.selected);
					setShots(saved.shots);
					setShotAt(saved.shotAt);
					setView(saved.view);
					if (dir.trim() === "") setNotice("先在上面填工程目录的绝对路径，回车打开。");
					else setNotice("");
					return;
				}
				setExpanded(new Set());
				setNodes(new Map());
				setSelected(null);
				setCursor(null);
				setShots([]);
				setShotAt(-1);
				if (dir.trim() === "") {
					setNotice("先在上面填工程目录的绝对路径，回车打开。");
					return;
				}
				setNotice("");
				void loadLevel(dir);
			}, [dir, loadLevel, expanded, nodes, selected, shots, shotAt, view]);

			/*
				模糊搜索：250ms 防抖，输入停下来才扫盘 —— 每敲一个字就全量遍历一遍
				目录会明显卡手。搜索结果是独立于树的一套视图，互不干扰。
			*/
			useEffect(() => {
				const query = search.trim();
				if (query === "" || dir.trim() === "") {
					setSearchHits(null);
					setGrep(null);
					setSearchBusy(false);
					return;
				}
				setSearchBusy(true);
				let alive = true;
				const timer = setTimeout(() => {
					const pending =
						searchMode === "content"
							? call("projectGrepFiles", dir, query, true).then((result) => {
									if (alive === false) return;
									if (result.ok !== true) {
										setNotice("搜索失败：" + (result.error ?? ""));
										setGrep({ hits: [], files: 0, matched: 0, skipped: 0, truncated: false });
										return;
									}
									const value = result.value !== null && typeof result.value === "object" ? result.value : {};
									const hits = Array.isArray(value.hits) ? value.hits : [];
									setGrep({
										hits,
										files: Number(value.files) || 0,
										matched: Number(value.matched) || 0,
										skipped: Number(value.skipped) || 0,
										truncated: value.truncated === true,
									});
									setNotice(
										value.truncated === true
											? "结果太多，只显示了前 " + hits.length + " 条，把关键字写细一点。"
											: "",
									);
								})
							: call("projectSearchEntries", dir, query).then((result) => {
									if (alive === false) return;
									if (result.ok !== true) {
										setNotice("搜索失败：" + (result.error ?? ""));
										setSearchHits([]);
										return;
									}
									const value = result.value !== null && typeof result.value === "object" ? result.value : {};
									const hits = Array.isArray(value.hits) ? value.hits : [];
									setSearchHits(hits);
									setNotice(
										value.truncated === true
											? "结果太多，只显示了前 " + hits.length + " 条，把关键字写细一点。"
											: "",
									);
								});
					void pending.finally(() => {
						if (alive === true) setSearchBusy(false);
					});
				}, 250);
				return () => {
					alive = false;
					clearTimeout(timer);
				};
			}, [search, searchMode, dir]);

			const refresh = useCallback(() => {
				if (dir.trim() === "") return;
				const openPaths = Array.from(expanded);
				setNodes(new Map());
				void loadLevel(dir).then(() => {
					for (const path of openPaths) {
						if (path !== dir) void loadLevel(path);
					}
				});
			}, [dir, expanded, loadLevel]);

			const toggle = useCallback(
				(path) => {
					setExpanded((prev) => {
						const next = new Set(prev);
						if (next.has(path)) next.delete(path);
						else next.add(path);
						return next;
					});
					if (nodesRef.current.has(path) === false) void loadLevel(path);
				},
				[loadLevel],
			);

			/**
			 * 开一个源码标签（已经开过就切过去），并把面板切到源码页签。
			 *
			 * 这里只管「哪个标签是当前的」，内容由调用方去拉：它要能同时应付
			 * 树里点「源码」（选行视图）和委托不出去时的降级编辑器两种来路。
			 */
			const openShotTab = useCallback(
				(entry, mode, line) => {
					setSelected(entry.path);
					setNotice("");
					setView("code");
					/*
						搜索命中带来的 1 基行号（没有就是 0）。它只决定「打开后滚到哪一行」，
						和选行视图里的 anchor/focus 是两回事 —— 后者是用户要引用哪几行。
					*/
					const wanted = Number(line) > 0 ? Math.floor(Number(line)) : 0;
					const at = shots.findIndex((shot) => shot.path === entry.path);
					if (at >= 0) {
						/* 开过的标签只切过去：用户改过的内容、选好的行区间都留着。 */
						setShotAt(at);
						setShots((prev) => {
							const copy = prev.slice();
							copy[at] = Object.assign(
								{},
								copy[at],
								{ mode, name: entry.name },
								/* 又点了同一个文件里的另一条命中时，把落点挪过去。 */
								wanted > 0 ? { caret: wanted } : null,
							);
							return copy;
						});
						return;
					}
					/* 「带行内容」跟着上一个标签走，省得每换一个文件都要重勾一次。 */
					const carried = shots.length > 0 && shots[shots.length - 1].withBody === true;
					setShotAt(shots.length);
					setShots((prev) => {
						if (prev.some((shot) => shot.path === entry.path)) return prev;
						return prev.concat([
							{
								mode,
								status: "loading",
								path: entry.path,
								name: entry.name,
								content: "",
								saved: "",
								error: "",
								withBody: carried,
								anchor: 1,
								focus: 1,
								/* 打开编辑器时要落在哪一行（0 = 从头看）；搜索结果带过来的。 */
								caret: wanted,
								dragging: false,
							},
						]);
					});
				},
				[shots],
			);

			/** 开标签 + 拉内容。已经开过且读好了就只切过去，不重读（用户可能改过内容）。 */
			const openLocal = useCallback(
				async (entry, mode, line) => {
					const known = shots.find((shot) => shot.path === entry.path);
					openShotTab(entry, mode, line);
					if (known !== undefined && known.status === "ready") return;
					const result = await call("projectReadFile", entry.path);
					const value = result.ok === true ? result.value ?? {} : {};
					patchShot(entry.path, {
						status: result.ok === true ? "ready" : "error",
						content: typeof value.content === "string" ? value.content : "",
						/* 刚读回来的内容和盘上一致，先记一份做「有没有改过」的基准。 */
						saved: typeof value.content === "string" ? value.content : "",
						error: result.ok === true ? "" : result.error ?? "读取失败",
					});
				},
				[shots, openShotTab, patchShot],
			);

			/**
			 * 点一个文件。
			 *
			 * 首选把 `dsh-resource://file/…` 地址交给 tab 自己的 actions，
			 * 官方 documentpreview 会接管渲染（高亮、折行、图片、Markdown 全都有）。
			 * 只有在拿不到 actions（比如组件被单独挂在别处）时才在面板里开一个可写回的标签。
			 */
			const openFile = useCallback(
				async (entry, line) => {
					setSelected(entry.path);
					setNotice("");
					/*
						交给官方预览器的前提：有 actions、有 sessionId，且**当前根位于
						会话 cwd 之下** —— 预览端拿 cwd 拼相对路径，根跑到 cwd 外面就会
						指向一个不存在的文件（"文件不存在，可能已被移动或删除"）。
					*/
					const canDelegate =
						actions !== undefined &&
						actions !== null &&
						typeof actions.openResource === "function" &&
						sessionId !== "" &&
						cwd !== "" &&
						isUnder(dir, cwd);
					if (canDelegate === true) {
						/*
							params.line 是文件资源唯一认得的导航参数（1 基），预览器会把那
							一行滚进视野；不传就维持原来的位置。
						*/
						const at = typeof line === "number" && line > 0 ? { params: { line } } : undefined;
						actions.openResource(fileAddressFor(sessionId, cwd, entry.path), at);
						return;
					}
					/* 委托不出去（在工作区外面，或这个 tab 没给 actions）就在面板里开一个可写回的标签。 */
					await openLocal(entry, "edit");
				},
				[actions, sessionId, dir, cwd, openLocal],
			);

			const saveShot = useCallback(async () => {
				if (snippet === null || snippet.status !== "ready") return;
				const content = snippet.content;
				const result = await call("projectWriteFile", snippet.path, content);
				setNotice(result.ok === true ? "已写回 " + snippet.path : "写回失败：" + (result.error ?? ""));
				/* 写成了才认，否则「未写回」标记不能消。 */
				if (result.ok === true) {
					patchShot(snippet.path, { saved: content });
					/*
						文件内容变了，它所属推送单元的快照就对不上了，徽章会一直停在
						「已推送」。立刻重扫一遍，用户写完就能看见它翻成 ●。
					*/
					void loadPushStatus(dir);
				}
			}, [snippet, patchShot, loadPushStatus, dir]);

			/**
			 * 把一个文件引用进会话输入框。
			 *
			 * 走官方输入面：captureInsertion() 取当前插入点（带 draft 修订号做 CAS），
			 * insertText(引用文本, span) 在一个撤销步里插入短文本。插入的是纯文本，
			 * 官方 ui-reference 的 lexicon 会把它装饰成可点击的引用芯片 —— 点芯片就在
			 * 右侧栏预览该文件，发消息给 AI 时它也就有了明确的文件上下文。
			 * 目录同样可引：文本按官方 grammar 补尾斜杠（`@src/`），AI 拿到的是整个文件夹。
			 *
			 * 基准必须是**会话 cwd**：ui-reference 的候选来自 fileReferences/list，
			 * 那也是以会话工作区为根的相对路径；两处不一致就装饰不上。
			 */
			/**
			 * 把一段引用文本送进会话输入框。
			 *
			 * 走官方输入面：captureInsertion() 取当前插入点（带 draft 修订号做 CAS），
			 * insertText(text, span) 在一个撤销步里插入。送不进去就退到剪贴板 + 提示。
			 */
			const insertPrompt = useCallback(
				(text, okNotice) => {
					const usable =
						inputActions !== undefined &&
						inputActions !== null &&
						typeof inputActions.captureInsertion === "function" &&
						typeof inputActions.insertText === "function";
					if (usable === true) {
						try {
							/* captureInsertion 与 insertText 之间有极小概率被别的编辑插队，
								insertText 会返回 false —— 这时再退到剪贴板。 */
							const span = inputActions.captureInsertion();
							if (inputActions.insertText(text, span) === true) {
								setNotice(okNotice);
								return;
							}
						} catch (error) {
							/* 一下都插不进去也不能打断整块面板：落回剪贴板。 */
						}
					}
					setNotice("已复制 " + text.trim() + "，粘贴到输入框即可。");
					try {
						void navigator.clipboard.writeText(text);
					} catch (error) {
						/* 剪贴板不可用就算了，上面提示已经给出。 */
					}
				},
				[inputActions],
			);

			const insertReference = useCallback(
				(entry) => {
					if (cwd === "") {
						setNotice("还不知道当前会话的工作目录，暂时无法生成引用。");
						return;
					}
					const relative = relativeUnder(cwd, entry.path);
					if (relative === "") {
						setNotice("这是工作区根目录，不能当作文件引用。");
						return;
					}
					const isDir = entry.kind === "directory";
					const mention = formatMention(relative, isDir);
					if (mention === undefined) {
						setNotice("这个路径名里有编辑器表示不了的字符，换一个条目吧。");
						return;
					}
					insertPrompt(mention + " ", "已引用 " + mention);
				},
				[cwd, insertPrompt],
			);

			/**
			 * 树里点「源码」：开一个选行视图标签，把文件内容拉下来按行渲染。
			 *
			 * 多个文件可以同时开着 —— 每个标签各记各的行区间和「带行内容」勾选，
			 * 上头的标签条负责来回切。
			 */
			/** `line` 是搜索命中带来的 1 基行号：带了就让编辑器打开后落在那一行。 */
			const openSnippet = useCallback((entry, line) => openLocal(entry, "code", line), [openLocal]);

			/*
				树上的键盘导航。监听挂在 window 上：树行是普通 div（不接焦点），要让它们收焦点
				就得每次先点一下再按键，手感很别扭。所以改成「只要焦点不在输入类元素里就接管
				方向键」—— 在输入框 / 编辑器里打字时完全不插手。
			*/
			useEffect(() => {
				const onKey = (event) => {
					const active = document.activeElement;
					const typing =
						active !== null &&
						active !== undefined &&
						(active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT" || active.isContentEditable === true);
					if (event.altKey === true || event.ctrlKey === true || event.metaKey === true) return;
					if (typing === true) return;
					const host = treeRef.current;
					/* 切到「源码」页签时树不渲染，这里自然就空了；offsetParent 再兜一层，防它只是被藏起来。 */
					if (host === null || host === undefined || host.offsetParent === null) return;
					const rows = Array.prototype.slice.call(host.querySelectorAll("[data-path]"));
					if (rows.length === 0) return;
					const paths = rows.map((element) => String(element.getAttribute("data-path") ?? ""));
					const here = cursor === null ? -1 : paths.indexOf(cursor);
					const go = (next) => {
						const at = Math.max(0, Math.min(paths.length - 1, next));
						setCursor(paths[at]);
						const element = rows[at];
						if (element !== undefined && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
					};
					/* 光标还没落过：↓ 从第一行走起、↑ 从最后一行倒着走，一按就有反应。 */
					if (event.key === "ArrowDown") {
						event.preventDefault();
						go(here < 0 ? 0 : here + 1);
						return;
					}
					if (event.key === "ArrowUp") {
						event.preventDefault();
						go(here < 0 ? paths.length - 1 : here - 1);
						return;
					}
					if (event.key === "Home") {
						event.preventDefault();
						go(0);
						return;
					}
					if (event.key === "End") {
						event.preventDefault();
						go(paths.length - 1);
						return;
					}
					if (here < 0) return;
					const row = rows[here];
					const path = paths[here];
					const isDir = String(row.getAttribute("data-kind")) === "directory";
					const entry = { path, name: String(row.getAttribute("data-name") ?? ""), kind: isDir === true ? "directory" : "file" };
					if (event.key === "Enter") {
						event.preventDefault();
						if (isDir === true) toggle(path);
						else void openFile(entry);
						return;
					}
					if (event.key === "ArrowRight") {
						/* 文件没有「展开」这回事，别白吃掉这个键。 */
						if (isDir !== true) return;
						event.preventDefault();
						if (expanded.has(path) !== true) toggle(path);
						return;
					}
					if (event.key === "ArrowLeft") {
						event.preventDefault();
						/* 展开着的目录先收起；已经收着的（或者本来就是个文件）就往上跳到它爹那儿。 */
						if (isDir === true && expanded.has(path) === true) {
							toggle(path);
							return;
						}
						const parent = parentOf(path);
						if (parent === path || paths.includes(parent) !== true) return;
						setCursor(parent);
						const element = rows[paths.indexOf(parent)];
						if (element !== undefined && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
						return;
					}
					if (event.key === "F2") {
						event.preventDefault();
						setEditPath(path);
						setEditName(entry.name);
						return;
					}
					if (event.key === "Delete") {
						event.preventDefault();
						void removeEntry(entry);
					}
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [cursor, expanded, toggle, openFile, removeEntry]);

			/**
			 * 内容搜索里点一条命中：在面板自己的源码页签打开，并落在那一行。
			 *
			 * 这里开的是 `"edit"`（CodeMirror 那个形态）而不是 `"code"`（选行视图）：
			 * 选行视图是用来「引用某几行」的，行是它自己渲染的，接不了「滚到第 N 行」；
			 * 编辑器分片从 0.2.0 起认 `line` 参数。看命中行本来也需要语法高亮。
			 */
			const openGrepHit = useCallback((entry, line) => openLocal(entry, "edit", line), [openLocal]);

			/** 关掉一个源码标签，顺手把当前标签挪到还开着的邻居上。 */
			const closeShot = useCallback(
				(path) => {
					const at = shots.findIndex((shot) => shot.path === path);
					if (at < 0) return;
					const next = shots.filter((shot) => shot.path !== path);
					setShots(next);
					setShotAt((cur) => {
						if (next.length === 0) return -1;
						if (at < cur) return cur - 1;
						if (at === cur) return Math.min(at, next.length - 1);
						return cur;
					});
				},
				[shots],
			);

			/** 一次收掉所有源码标签。 */
			const closeAllShots = useCallback(() => {
				setShots([]);
				setShotAt(-1);
				setSelected(null);
			}, []);

			/**
			 * 把选行视图里选中的行区间引成 `@文件 L起-止`。
			 *
			 * 勾了「带行内容」就把这几行的原文一起贴成代码块 —— 只给行号的话，
			 * 官方引用芯片投喂的是整份文件，AI 得自己数行，常常数不准。
			 */
			const insertRange = useCallback(() => {
				if (snippet === null || snippet.status !== "ready") return;
				if (cwd === "") {
					setNotice("还不知道当前会话的工作目录，暂时无法生成引用。");
					return;
				}
				const text = rangePromptText(snippet, cwd);
				if (text === undefined) {
					setNotice("这个路径表达不成引用（工作区根，或路径名里有编辑器表示不了的字符）。");
					return;
				}
				const lo = Math.min(snippet.anchor, snippet.focus);
				const hi = Math.max(snippet.anchor, snippet.focus);
				const range = lo === hi ? "L" + lo : "L" + lo + "-" + hi;
				const mention = formatMention(relativeUnder(cwd, snippet.path), false) ?? "";
				insertPrompt(text, "已引用 " + mention + " " + range + (snippet.withBody === true ? "（连行内容）" : ""));
			}, [snippet, cwd, insertPrompt]);

			/** 把选行视图里这个文件交给官方预览器，并滚到选区的起始行。 */
			const previewFile = useCallback(() => {
				if (snippet === null) return;
				const at = Math.min(snippet.anchor, snippet.focus);
				const target = { path: snippet.path, name: snippet.name };
				setSnippet(null);
				/* 预览是交给官方预览器的，面板这边退回文件树等用户继续挑。 */
				setView("tree");
				void openFile(target, at);
			}, [snippet, openFile]);

			/*
				把一个节点下面**带明细的**错误攒成一份清单。

				单元节点自带 issues（host 扫描时顺手挂上的，它的 errors 就是自己那几条），
				直接用。聚合节点自己不带明细 —— 它的 errors 是子孙的和，每个子孙各带一份、
				再往聚合上抄一遍就重复了 —— 所以按路径前缀从扁平的 pushMap 里捞子孙的。
				pushMap 已经是整棵树的快照，不必再问 host 一趟。
			*/
			function badIssuesOf(node) {
				if (node.aggregate !== true) return Array.isArray(node.issues) ? node.issues : [];
				const issues = [];
				for (const item of pushMap.values()) {
					if (item.aggregate === true) continue;
					if (String(item.relPath ?? "") === "") continue;
					if (isUnder(item.dir, node.dir) !== true) continue;
					if (Array.isArray(item.issues) === true) issues.push(...item.issues);
				}
				return issues;
			}

			/**
			 * ✗N 的悬停提示：直接写清楚是哪个文件、哪条规则 —— 这就是用户看到 ✗ 之后
			 * 要问的那句话，不该逼他逐个目录右键去试。
			 */
			function badIssuesTitle(node, issues) {
				const errors = Number(node.errors ?? 0);
				const warns = Number(node.warns ?? 0);
				const lines = [
					(node.aggregate === true ? "这个目录下面有 " : "这个单元有 ") + errors + " 个错误" +
						(warns > 0 ? "、" + warns + " 个警告" : "")
				];
				const shown = issues.slice(0, 10);
				if (shown.length > 0) lines.push("");
				for (const issue of shown) {
					lines.push(
						relativeUnder(String(node.dir ?? ""), String(issue.path ?? "")) +
							(Number(issue.line ?? 0) > 0 ? ":" + issue.line : "") +
							"  " +
							String(issue.rule ?? "")
					);
				}
				if (issues.length > shown.length) lines.push("…还有 " + (issues.length - shown.length) + " 条");
				if (issues.length < errors) lines.push("（明细太多，这里只列了一部分）");
				lines.push("");
				lines.push("点一下看明细");
				return lines.join("\n");
			}

			/**
			 * 点徽章上的 ✗N：把这份明细直接送进「校验」页签。
			 *
			 * 页签的每一行本来就能点开、能跳到文件那一行，所以这里只要把 issues 拼好 ——
			 * 用户不必先猜是哪个目录有问题、再右键「推送前校验」。
			 */
			function openBadIssues(node) {
				const issues = badIssuesOf(node);
				if (issues.length === 0) {
					/* 明细被预算截掉了（或这轮扫描没挂上），退回老办法：现场算那个目录。 */
					const target = String(node.dir ?? "");
					if (target !== "") void runLint(target);
					return;
				}
				setLint({
					dir: String(node.dir ?? ""),
					kind: "",
					/* 徽章只标错误，所以这里也只有错误 —— 把总数一并带上，摘要那行才不撒谎。 */
					issues: issues,
					errors: Number(node.errors ?? 0),
					warns: Number(node.warns ?? 0),
					from: "badge",
					relPath: String(node.relPath ?? "")
				});
				setView("lint");
			}

			/** 递归渲染某一层。返回数组，交给父层展开。 */
			/*
				推送状态徽章。只有 host 扫描认得这个目录（pages / apis / databases
				里带 page.json 或 meta.json）才显示，别的目录返回 null，树保持干净。
			*/
			function renderPushBadge(path) {
				const node = pushMap.get(pathKey(path));
				if (node === undefined) return null;
				const pushed = node.status === "pushed";
				/*
					pushable === false：目录里有 page.json / meta.json，但缺 uuid / id（或
					JSON 坏到读不出来），平台定位不到它 —— 这种连账都记不了，也就永远没法
					标记为已推送，徽章得是另一种颜色，别让人以为点一下就能推。
				*/
				const usable = node.pushable !== false;
				const title =
					(usable === false
						? "缺 uuid / id，平台定位不到这个单元"
						: pushed === true
							? "已推送"
							: "待推送") +
					(node.aggregate === true
						? "（聚合节点：" + String(node.relPath ?? "") + "）"
						: "（" + String(node.scope ?? "") + "：" + String(node.name ?? "") + "）") +
					(usable === true ? "，右键可标记已推送" : "，先在「推送前校验」里看问题");
				/*
					徽章上**带字**。光摆一个 ✔ / ● / ✗，得先知道这三个符号各自什么意思才看得懂；
					而「已推送 / 待推送 / 定位不到」本来就在悬停提示里写着，直接摆出来更省事。
					颜色照旧 —— 扫一眼找橙色的那几行，仍然是最快的用法。
				*/
				const mark = usable === false ? "✗" : pushed === true ? "✔" : "●";
				const word = usable === false ? "定位不到" : pushed === true ? "已推送" : "待推送";
				const badge = h(
					"span",
					{ style: usable === false ? CSS.badgeBroken : pushed === true ? CSS.badgeOk : CSS.badgeDirty, title },
					mark + " " + word
				);
				/*
					顺带把校验结果标出来。**只标错误，不标警告** —— 真项目量过：2179 个
					单元里 1236 个会命中 no-return 那条警告（平台容忍 `return '成功'` 这种
					非对象返回），全标出来就是满屏黄标，等于没有信息量。警告留在「校验」
					页签里看，徽章只回答「这个单元推送会不会挂」。
				节点上还带着错误明细（host 扫描时顺手挂的），所以 ✗N 能把「哪个文件、
					哪条规则」直接写进悬停提示，点一下还能摊开成清单 —— 光给一个数字，
					用户看完不知道该从哪下手。
					node.linted === false 表示这个单元这一轮没算过（不是页面/API 目录，或者
					明细预算用完了），这时不显示校验状态，免得把「没算过」显示成「没问题」。
				*/
				if (node.linted !== true) return badge;
				const errors = Number(node.errors ?? 0);
				if (errors === 0) return badge;
				const badIssues = badIssuesOf(node);
				/*
					把「哪个文件」摊在提示里，并且让这一小块能点开看明细 —— 只写一个数字
					的话，用户看着 ✗1 完全不知道该从哪下手（这正是他提的那句话）。
				*/
				return h("span", { style: CSS.badgeGroup }, [
					badge,
					h(
						"span",
						{
							style: Object.assign({}, CSS.badgeError, { cursor: "pointer" }),
							title: badIssuesTitle(node, badIssues),
							onClick: (event) => {
								/* 别让点击冒泡到行上（那会触发展开/收起）。 */
								event.stopPropagation();
								openBadIssues(node);
							}
						},
						"校验 ✗" + errors
					)
				]);
			}

			function renderLevel(path, depth) {
				const node = nodes.get(path);
				const rows = [];
				/*
					新建的输入行落在地层最前面 —— 在哪个目录上右键，输入框就长在那个目录
					的子项位置，一眼能看出文件会建到哪（顶部工具条那种全局入口容易搞错）。
				*/
				if (newAt !== null && newAt.parent === path) {
					rows.push(
						h(
							"div",
							{ key: path + "|new", style: Object.assign({}, CSS.row, { paddingLeft: 12 + depth * 14, gap: 6 }) },
							h("span", { style: { opacity: 0.85 } }, newAt.kind === "directory" ? "📁" : "📄"),
							h("input", {
								style: CSS.toolInput,
								value: newName,
								autoFocus: true,
								placeholder: newAt.kind === "directory" ? "新文件夹名" : "新文件名",
								onChange: (event) => setNewName(event.target.value),
								onKeyDown: (event) => {
									if (event.key === "Enter") void submitNew();
									else if (event.key === "Escape") {
										setNewAt(null);
										setNewName("");
									}
								},
							}),
							h(
								"button",
								{ type: "button", style: CSS.miniButton, onClick: () => void submitNew() },
								"创建",
							),
							h(
								"button",
								{
									type: "button",
									style: CSS.miniButton,
									onClick: () => {
										setNewAt(null);
										setNewName("");
									},
								},
								"取消",
							),
						),
					);
				}
				/* 这一层还没拉回来 / 拉失败：只可能显示上面的新建输入行，没有别的行。 */
				if (node === undefined || node.status !== "ready") return rows;
				for (const entry of node.entries) {
					const isDir = entry.kind === "directory";
					/* 正在改这一条：整行换成输入框，改完或取消再退回普通行。 */
					if (editPath === entry.path) {
						rows.push(
							h(
								"div",
								{ key: entry.path, style: Object.assign({}, CSS.row, { paddingLeft: 12 + depth * 14, gap: 6 }) },
								h("span", { style: { opacity: 0.85 } }, isDir === true ? "📁" : "📄"),
								h("input", {
									style: CSS.toolInput,
									value: editName,
									autoFocus: true,
									onChange: (event) => setEditName(event.target.value),
									onKeyDown: (event) => {
										if (event.key === "Enter") void submitRename(entry);
										else if (event.key === "Escape") setEditPath(null);
									},
								}),
								h(
									"button",
									{
										type: "button",
										style: CSS.miniButton,
										onClick: () => void submitRename(entry),
									},
									"确定",
								),
								h(
									"button",
									{
										type: "button",
										style: CSS.miniButton,
										onClick: () => setEditPath(null),
									},
									"取消",
								),
							),
						);
						continue;
					}
					const isOpen = isDir === true && expanded.has(entry.path);
					const isSelected = selected !== null && selected === entry.path;
					const rowStyle = Object.assign({}, CSS.row, { paddingLeft: 12 + depth * 14 });
					if (isSelected === true) {
						rowStyle.background = "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))";
						rowStyle.borderRadius = 4;
					}
					/*
						拖着东西悬在这一行上时，落点目录是它自己（目录）或者它的父目录（文件）。
						高亮永远画在目录行上，所以拖到文件上会看到它所在的文件夹被圈出来。
					*/
					const dropTarget = isDir === true ? entry.path : parentOf(entry.path);
					if (dragOver !== "" && dragOver === dropTarget) {
						rowStyle.outline = "1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.55))";
						rowStyle.outlineOffset = "-1px";
						rowStyle.borderRadius = 4;
					}
					/* 键盘光标那条竖线走 boxShadow（单独一个属性，不会和上面的 outline 打架）。 */
					if (cursor !== null && cursor === entry.path) {
						rowStyle.boxShadow = "inset 2px 0 0 0 var(--dsw-alias-brand-primary, #4c8dff)";
					}
					rows.push(
						h(
							"div",
							{
								key: entry.path,
								title: entry.path,
								/* 键盘导航靠这三个属性从 DOM 反查「这一行是什么」，省得再回 nodes 里翻一遍。 */
								"data-path": entry.path,
								"data-kind": isDir === true ? "directory" : "file",
								"data-name": String(entry.name),
								style: rowStyle,
								draggable: true,
								onDragStart: (event) => {
									dragPathRef.current = entry.path;
									setDragOver("");
									/* 拖拽必须带点数据，否则 Firefox 直接不开始拖。 */
									event.dataTransfer.setData("text/plain", entry.path);
									event.dataTransfer.effectAllowed = "move";
								},
								onDragEnd: () => {
									dragPathRef.current = null;
									setDragOver("");
								},
								/*
									拖到这一行上。dragover 里读不到 dataTransfer（浏览器只在 drop 时
									才让读），所以只看 dragPathRef 里有没有东西。
								*/
								onDragOver: (event) => {
									if (dragPathRef.current === null) return;
									event.preventDefault();
									event.stopPropagation();
									event.dataTransfer.dropEffect = "move";
									if (dragOver !== dropTarget) setDragOver(dropTarget);
								},
								onDragLeave: () => {
									setDragOver((prev) => (prev === dropTarget ? "" : prev));
								},
								onDrop: (event) => {
									const src = dragPathRef.current;
									if (src === null) return;
									event.preventDefault();
									event.stopPropagation();
									void moveEntry(src, dropTarget);
								},
								onClick: () => {
									/* 「移动到…」模式下，点哪儿就是搬到哪儿。 */
									if (moveList !== null) {
										void moveEntry(moveList, dropTarget);
										return;
									}
									if (isDir === true) toggle(entry.path);
									else void openFile(entry);
								},
								/* 右键出菜单：新建 / 重命名 / 删除。落点就是右键点中的那一条。 */
								onContextMenu: (event) => {
									event.preventDefault();
									event.stopPropagation();
									openMenu(event, entry);
								},
							},
							h("span", { style: { width: 10, textAlign: "center", opacity: 0.7 } }, isDir === true ? (isOpen === true ? "▾" : "▸") : ""),
							h("span", { style: { opacity: 0.85 } }, isDir === true ? "📁" : "📄"),
							h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, String(entry.name)),
							renderPushBadge(entry.path),
							h("span", { style: { flex: 1, minWidth: 0 } }),
							/* 只有文件能选行：打开选行视图，拖选一个行区间后只引那几行。 */
						isDir === true
							? null
							: h(
									"button",
									{
										type: "button",
										style: CSS.refButton,
										title: "在面板里看这个文件的源码（官方预览会把 HTML / Markdown 渲染成页面，要看代码点这个）：" + entry.path,
										onClick: (event) => {
											/* 行本身也绑了点击（目录展开 / 文件打开），这里必须掐掉冒泡。 */
											event.stopPropagation();
											void openSnippet(entry);
										},
									},
									"源码",
								),
						/* 工作区根目录（相对路径为空）不给引用按钮：引一个根没有意义。 */
							isDir === true && relativeUnder(cwd, entry.path) === ""
								? null
								: h(
										"button",
										{
											type: "button",
											style: CSS.refButton,
											title: (isDir === true ? "引用整个文件夹到输入框：" : "引用到输入框：") + (formatMention(relativeUnder(cwd, entry.path), isDir) ?? ""),
											onClick: (event) => {
												/* 行本身也绑了点击（目录展开 / 文件打开），这里必须掐掉冒泡。 */
												event.stopPropagation();
												insertReference(entry);
											},
										},
										"引用",
									),
						/* 重命名、删除挪到右键菜单里了（见行上的 onContextMenu）。 */
						null,
						),
					);
					/* 操作条已删：重命名 / 删除改走右键菜单。 */
					if (isDir === true && isOpen === true) {
						const child = nodes.get(entry.path);
						if (child === undefined || child.status === "loading") {
							rows.push(
								h(
									"div",
									{ key: entry.path + "|loading", style: Object.assign({}, CSS.row, { paddingLeft: 12 + (depth + 1) * 14, opacity: 0.55 }) },
									"读取中…",
								),
							);
						} else if (child.status === "error") {
							rows.push(
								h(
									"div",
									{ key: entry.path + "|error", style: Object.assign({}, CSS.row, { paddingLeft: 12 + (depth + 1) * 14, opacity: 0.55 }) },
									child.error ?? "读取失败",
								),
							);
						} else {
							for (const row of renderLevel(entry.path, depth + 1)) rows.push(row);
							if (child.entries.length === 0) {
								rows.push(
									h(
										"div",
										{ key: entry.path + "|empty", style: Object.assign({}, CSS.row, { paddingLeft: 12 + (depth + 1) * 14, opacity: 0.5 }) },
										"空文件夹",
									),
								);
							}
						}
					}
				}
				if (node.truncated === true) {
					rows.push(
						h(
							"div",
							{ key: path + "|truncated", style: Object.assign({}, CSS.row, { paddingLeft: 12 + depth * 14, opacity: 0.55 }) },
							"（条目过多，已截断）",
						),
					);
				}
				return rows;
			}

			/**
			 * 右键菜单：在哪个条目上右键，就在那里新建 / 重命名 / 删除。
			 *
			 * 落点由右键命中的那一条决定 —— 目录建在它里面、文件建在它旁边、
			 * 空白处算工程根。这样就不用再猜「新建会落到哪个文件夹」。
			 */
			function renderMenu() {
				if (menu === null) return null;
				const entry = menu.entry;
				const isDir = entry !== null && entry !== undefined && entry.kind === "directory";
				const base = entry === null || entry === undefined ? dir : isDir === true ? entry.path : parentOf(entry.path);
				const item = (key, label, run) => h("div", { key, style: CSS.menuItem, onClick: run }, label);

				/*
					二次确认那一屏。从树上发起推 / 拉时，`runAsk` 那套（「脚本」页签卡片上的
					确认运行 / 取消）在这儿没人渲染 —— 树里根本没有那张卡。所以确认就地做：
					整个菜单换成一个问句加两个按钮，问完才带 `true` 去调 host。
				*/
				if (menu.confirm !== undefined) {
					const ask = menu.confirm;
					return h(
						"div",
						{
							ref: menuRef,
							style: Object.assign({}, CSS.menu, { left: menu.x, top: menu.y }),
							onContextMenu: (event) => event.preventDefault(),
						},
						h(
							"div",
							{ style: CSS.menuNote },
							"会连到 " + (String(ask.targetLabel ?? "") === "" ? "外网地址" : String(ask.targetLabel)) +
								"（不是本机）。" + String(ask.verb) + String(ask.noun) +
								(ask.verb === "推送" ? "会把本地的内容发到服务器上。" : "会用服务器上的内容覆盖本地文件。"),
						),
						item("confirm-yes", "确认" + String(ask.verb), () => {
							setMenu(null);
							void startUnit(ask.node, String(ask.mode), true);
						}),
						item("confirm-no", "取消", () => {
							setMenu(Object.assign({}, menu, { confirm: undefined }));
						}),
					);
				}

				const isRoot = entry === null || entry === undefined;
				const pushNode = isRoot === true ? undefined : pushMap.get(pathKey(entry.path));
				/*
					「推送 / 拉取这一个页面（API）」要三个条件同时成立才出现：账本认得这一颗
					（`scope` 是 page / api）、它在 pages 或 apis 区里、对应脚本真的在工作区根下。
					最后那条是为什么 host 要在扫描回值里多带一个 `scripts` —— 菜单里摆一个点了
					必然报 not-found 的入口，不如不摆。
					为什么不给 `databases`：那边的单元在账本里也是 `api:` 键，但它归
					`source-db-pull.js` 管，参数是项目 uuid 而不是单元 id。
				*/
				const unitScope = pushNode === undefined ? "" : String(pushNode.scope ?? "");
				const unitZone = pushNode === undefined ? "" : String(pushNode.zone ?? "");
				const unitKind =
					pushNode === undefined || pushNode.pushable === false
						? ""
						: unitScope === "page" && unitZone === "pages"
							? "page"
							: unitScope === "api" && unitZone === "apis"
								? "api"
								: "";
				const unitScripts = pushInfo === null || Array.isArray(pushInfo.scripts) !== true ? [] : pushInfo.scripts;
				const unitRemote = pushInfo !== null && pushInfo.remote === true;
				const unitTargetLabel = pushInfo === null ? "" : String(pushInfo.targetLabel ?? "");
				/* 加两个菜单项；脚本不在、或者这一颗不是页面 / API 单元，就什么也不加。 */
				const pushUnitItems = () => {
					if (unitKind === "" || pushNode === undefined) return;
					const noun = unitKind === "page" ? "这个页面" : "这个 API";
					for (const verb of ["push", "pull"]) {
						const script = (unitKind === "page" ? "source-page-" : "source-api-") + verb + ".js";
						if (unitScripts.includes(script) !== true) continue;
						const label = (verb === "push" ? "推送" : "拉取") + noun;
						kids.push(
							item("unit-" + verb, runRunning === true ? label + "（有任务在跑）" : label, () => {
								/* `.env` 的地址在外网 —— 先换成问句那一屏，问完才带 true 真跑。 */
								if (unitRemote === true) {
									setMenu(
										Object.assign({}, menu, {
											confirm: { node: pushNode, mode: verb, verb: verb === "push" ? "推送" : "拉取", noun, targetLabel: unitTargetLabel },
										}),
									);
									return;
								}
								setMenu(null);
								void startUnit(pushNode, verb, false);
							}),
						);
					}
				};
				const kids = [
					item("new-file", "新建文件", () => {
						setMenu(null);
						setNewName("");
						/* 目标目录可能是收着的，先展开，否则输入行没地方长。 */
						setExpanded((prev) => new Set(prev).add(base));
						setNewAt({ parent: base, kind: "file" });
					}),
					item("new-dir", "新建文件夹", () => {
						setMenu(null);
						setNewName("");
						setExpanded((prev) => new Set(prev).add(base));
						setNewAt({ parent: base, kind: "directory" });
					}),
				];
				if (entry !== null && entry !== undefined) {
					kids.push(h("div", { key: "sep", style: CSS.menuSep }));
					/*
						「引用 / 查看源码」跟行尾那两个小按钮是同一对动作 —— 右键的人多半就是要
						干这两件事，别逼他先瞄准一个 12px 的按钮。放在整段最前：读排在改前面，
						破坏性的「删除」压到最后。行尾按钮怎么判、这里就怎么判，两条路不许分岔。
					*/
					if (isDir !== true) {
						kids.push(
							item("source", "查看源码", () => {
								setMenu(null);
								void openSnippet(entry);
							}),
						);
					}
					/* 工作区根（相对路径为空）不给引用：引一个根没有意义。 */
					if (relativeUnder(cwd, entry.path) !== "") {
						kids.push(
							item("reference", "引用", () => {
								setMenu(null);
								insertReference(entry);
							}),
						);
					}
					/* 目录没有「打开来编辑」这回事。 */
					if (isDir !== true) {
						kids.push(
							item("edit", "编辑", () => {
								setMenu(null);
								setView("code");
								void openLocal(entry, "edit");
							}),
						);
					} else {
						/* 只有目录才可能是页面目录 / API 目录，文件上不给这一项。 */
						kids.push(
							item("lint", lintBusy === true ? "校验中…" : "推送前校验", () => {
								setMenu(null);
								void runLint(entry.path);
							}),
						);
					}
					kids.push(
						item("rename", "重命名", () => {
							setMenu(null);
							setEditName(String(entry.name));
							setEditPath(entry.path);
						}),
					);
					/* 「移动到…」不直接搬：先记下源，让用户点一个目标目录。 */
					kids.push(
						item("move", "移动到…", () => {
							setMenu(null);
							setMoveList(entry.path);
						}),
					);
					kids.push(
						item("remove", "删除", () => {
							setMenu(null);
							void removeEntry(entry);
						}),
					);
				}
				/*
					推送状态：命中的节点可以标记；空白处（= 工程根）则给「刷新 / 重置」。
					扫描认得这个目录才有条目，普通工程这三个项一个都不出现。
				*/
				if (isRoot === true || pushNode !== undefined) {
					kids.push(h("div", { key: "sep-push", style: CSS.menuSep }));
					/* 先给「这一个单元」的推 / 拉，再给记账和全局那几个。 */
					pushUnitItems();
					if (pushNode !== undefined) {
						/* 记不了账的单元（缺 uuid / id）没有「已推」这个概念，只给校验入口。 */
						if (pushNode.pushable !== false) {
							kids.push(
								item("mark-pushed", pushNode.status === "pushed" ? "标记已推送（当前已推）" : "标记已推送", () => {
									setMenu(null);
									void markPushed(pushNode);
								}),
							);
						} else {
							kids.push(
								item("lint-broken", lintBusy === true ? "校验中…" : "推送前校验（缺 uuid / id）", () => {
									setMenu(null);
									void runLint(entry.path);
								}),
							);
						}
					}
					kids.push(
						item("refresh-push", pushBusy === true ? "扫描中…" : "刷新推送状态", () => {
							setMenu(null);
							void loadPushStatus(dir);
						}),
					);
					kids.push(
						item("reset-push", "重置推送状态", () => {
							setMenu(null);
							void resetPushState();
						}),
					);
				}
				return h(
					"div",
					{
						ref: menuRef,
						style: Object.assign({}, CSS.menu, { left: menu.x, top: menu.y }),
						onContextMenu: (event) => event.preventDefault(),
					},
					kids,
				);
			}

			/** 点搜索结果：目录就地展开，文件直接打开；路径上的祖先一并展开，切回树也能看见它。 */
			function revealHit(hit, line) {
				const separator = dir.indexOf("/") !== -1 && dir.indexOf("\\") === -1 ? "/" : "\\";
				const parts = String(hit.relPath ?? "").split("/");
				const chain = [];
				let walk = dir;
				for (let index = 0; index < parts.length - 1; index += 1) {
					walk = walk + separator + parts[index];
					chain.push(walk);
				}
				if (hit.kind === "directory") chain.push(hit.path);
				if (chain.length > 0) {
					setExpanded((prev) => {
						const next = new Set(prev);
						for (const path of chain) next.add(path);
						return next;
					});
					for (const path of chain) void loadLevel(path);
				}
				if (hit.kind !== "directory") void openFile(hit, line);
			}

			/**
			 * 搜索结果列表。
			 *
			 * 跟树共用一套行样式，但行里显示的是相对路径 —— 全量搜索的命中可能来自
			 * 任意深度，只给文件名根本认不出是哪个。行尾照样有「源码 / 引用」和右键菜单。
			 */
			function renderSearch() {
				const hits = searchHits;
				const summary =
					searchBusy === true || hits === null
						? "搜索中…"
						: hits.length === 0
							? "没有匹配的文件。"
							: "匹配 " + hits.length + " 条";
				return h(
					"div",
					{ style: CSS.tree },
					h(
						"div",
						{ style: Object.assign({}, CSS.muted, { padding: "2px 12px 8px", display: "flex", gap: 8, alignItems: "center" }) },
						h("span", { style: { flex: 1, minWidth: 0 } }, summary),
					),
					(hits ?? []).map((hit) => {
						const isDir = hit.kind === "directory";
						return h(
							"div",
							{
								key: hit.path,
								title: hit.path,
								style: Object.assign({}, CSS.row, { paddingLeft: 12 }),
								onClick: () => revealHit(hit),
								onContextMenu: (event) => {
									event.preventDefault();
									event.stopPropagation();
									openMenu(event, hit);
								},
							},
							h("span", { style: { width: 10, textAlign: "center", opacity: 0.7 } }, isDir === true ? "▸" : ""),
							h("span", { style: { opacity: 0.85 } }, isDir === true ? "📁" : "📄"),
							h("span", { style: { flexShrink: 0 } }, String(hit.name)),
							h(
								"span",
								{
									style: Object.assign({}, CSS.muted, {
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
										flex: 1,
										minWidth: 0,
									}),
								},
								String(hit.relPath ?? ""),
							),
							renderPushBadge(hit.path),
							isDir === true
								? null
								: h(
										"button",
										{
											type: "button",
											style: CSS.refButton,
											title: "在面板里看这个文件的源码：" + hit.path,
											onClick: (event) => {
												event.stopPropagation();
												void openSnippet(hit);
											},
										},
										"源码",
									),
							h(
								"button",
								{
									type: "button",
									style: CSS.refButton,
									title: (isDir === true ? "引用整个文件夹到输入框：" : "引用到输入框：") + (formatMention(relativeUnder(cwd, hit.path), isDir) ?? ""),
									onClick: (event) => {
										event.stopPropagation();
										insertReference(hit);
									},
								},
								"引用",
							),
						);
					}),
				);
			}

			/**
			 * 内容搜索的结果列表。
			 *
			 * 一个文件可能命中几十行，所以按「文件 → 行」两层显示：文件名占一行，
			 * 命中行缩进挂在下面。行号是 1 基的真实行号，点一下把源码页签滚到那一行。
			 */
			function renderGrepSearch() {
				const result = grep;
				const hits = result === null ? null : result.hits;
				const summary =
					searchBusy === true || result === null
						? "搜索中…"
						: hits.length === 0
							? "读了 " + result.files + " 个文件，没有匹配的内容。"
							: "读了 " +
								result.files +
								" 个文件，" +
								result.matched +
								" 个文件命中 " +
								hits.length +
								" 行" +
								(result.skipped > 0 ? "，跳过 " + result.skipped + " 个（太大或是二进制）" : "");
				/* 同一个文件连续的行合并成一组，省掉重复的文件名行。 */
				const groups = [];
				for (const hit of hits ?? []) {
					const last = groups[groups.length - 1];
					if (last !== void 0 && last.path === hit.path) last.hits.push(hit);
					else groups.push({ path: hit.path, relPath: hit.relPath, name: hit.name, hits: [hit] });
				}
				return h(
					"div",
					{ style: CSS.tree },
					h(
						"div",
						{ style: Object.assign({}, CSS.muted, { padding: "2px 12px 8px", display: "flex", gap: 8, alignItems: "center" }) },
						h("span", { style: { flex: 1, minWidth: 0 } }, summary),
					),
					groups.map((group) => {
						/*
							host 只回了命中行，没回 `kind`；这里补齐成和树行一样的完整 entry，
							好让 openSnippet / openMenu 这些老代码原样吃下去。
							`name` 必须带上 —— openShotTab 拿它当标签标题，缺了就是个 undefined 标签。
						*/
						const entry = {
							path: group.path,
							relPath: group.relPath,
							name: group.name,
							kind: "file",
						};
						return h(
							"div",
							{ key: group.path },
							h(
								"div",
								{
									title: group.path,
									style: Object.assign({}, CSS.row, { paddingLeft: 12 }),
									onClick: () => void openGrepHit(entry, group.hits[0].line),
									onContextMenu: (event) => {
										event.preventDefault();
										event.stopPropagation();
										openMenu(event, entry);
									},
								},
								h("span", { style: { opacity: 0.85 } }, "📄"),
								h("span", { style: { flexShrink: 0 } }, String(group.name)),
								h(
									"span",
									{
										style: Object.assign({}, CSS.muted, {
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
											flex: 1,
											minWidth: 0,
										}),
									},
									String(group.relPath ?? ""),
								),
								h("span", { style: Object.assign({}, CSS.muted, { flex: "0 0 auto" }) }, group.hits.length + " 行"),
								h(
									"button",
									{
										type: "button",
										style: CSS.refButton,
										/*
											跟命中行一样走面板内的编辑器（openGrepHit），只是落在
											这个文件的第一条命中上 —— 以前这里调 openSnippet，
											开出来的是选行视图，跳不了行。
										*/
										title: "在面板里打开并跳到第一条命中：" + group.path,
										onClick: (event) => {
											event.stopPropagation();
											void openGrepHit(entry, group.hits[0].line);
										},
									},
									"源码",
								),
							),
							group.hits.map((hit) =>
								h(
									"div",
									{
										key: group.path + ":" + hit.line,
										title: "跳到第 " + hit.line + " 行：" + hit.path,
										style: Object.assign({}, CSS.row, { paddingLeft: 42, cursor: "pointer" }),
										onClick: () => void openGrepHit(entry, hit.line),
									},
									h(
										"span",
										{
											style: Object.assign({}, CSS.muted, {
												flex: "0 0 auto",
												fontSize: 11,
												minWidth: 42,
												textAlign: "right",
											}),
										},
										String(hit.line),
									),
									h(
										"span",
										{
											style: {
												fontFamily: "var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
												fontSize: 11,
												whiteSpace: "pre",
												overflow: "hidden",
												textOverflow: "ellipsis",
												flex: 1,
												minWidth: 0,
												opacity: 0.9,
											},
										},
										String(hit.text ?? ""),
									),
								),
							),
						);
					}),
				);
			}

			/**
			 * 「校验」页签：把 host 的 lint 结果列成一张能点的清单。
			 *
			 * 点一行就开那个文件跳到那一行 —— 光告诉人「page.js 第 7 行有问题」但还得
			 * 自己去树里翻，等于只做了一半。issue 自带绝对路径（host 一起给了）。
			 */
			function renderLint() {
				const result = lint;
				const issues = result === null || Array.isArray(result.issues) !== true ? [] : result.issues;
				const shownErrors = issues.filter((issue) => issue.level === "error").length;
				/*
					从树上 ✗N 点进来的那份清单只带错误（徽章本来就只标错误），所以不能拿
					issues 现数级数当摘要 —— 那样本该显示成警告的那些会被算成 0。host 把这
					个单元原本的错误/警告计数一起给过来了，有就用它。
				*/
				const fromBadge = result !== null && result.from === "badge";
				const errors = result !== null && typeof result.errors === "number" ? result.errors : shownErrors;
				const warns = result !== null && typeof result.warns === "number" ? result.warns : issues.length - shownErrors;
				/*
				 * 过期 = 这次结果针对的目录已经不在当前工作区里了（也就是中途换过工作区）。
				 *
				 * 早先这里写的是 pathKey(result.dir) !== pathKey(dir)，拿「校验的那个目录」和
				 * 「工作区根」比相等 —— 可在子目录上右键本来就 ≠ 根，于是每校验一次子目录都会
				 * 多出一句「属于另一个工作区」。判据要的是「还在不在这棵树里」，不是「等不等于根」。
				 */
				const stale = result !== null && result.dir !== undefined && isUnder(String(result.dir), dir) !== true;
				const summary =
					result === null
						? "还没校验过。在文件树的目录上右键，选「推送前校验」。"
						: typeof result.failed === "string" && result.failed !== ""
							? "校验没跑起来：" + result.failed
							: fromBadge === true
								? String(result.relPath ?? "") +
									"：" +
									errors +
									" 个错误" +
									(warns > 0 ? "、" + warns + " 个警告" : "") +
									(issues.length < errors ? "（明细只列了 " + issues.length + " 条）" : "") +
									" —— 只列错误，点一行打开出问题的文件"
								: issues.length === 0
									? "没有问题，可以推送。"
									: errors + " 个错误，" + warns + " 个警告（错误会让推送失败，警告是平台踩过的坑）";
				return h(
					"div",
					{ style: CSS.tree },
					h(
						"div",
						{
							style: Object.assign({}, CSS.muted, {
								padding: "2px 12px 8px",
								display: "flex",
								gap: 8,
								alignItems: "center",
							}),
						},
						h("span", { style: { flex: 1, minWidth: 0 } }, summary),
						/* 换过工作区之后结果就过期了，提醒一句比默默展示旧清单诚实。 */
						stale === true ? h("span", { style: { flex: "0 0 auto", opacity: 0.8 } }, "（属于另一个工作区）") : null,
					),
					issues.length === 0
						? null
						: issues.map((issue, index) => {
								const bad = issue.level === "error";
								const entry = { path: String(issue.path ?? ""), name: String(issue.file ?? ""), kind: "file" };
								/*
									徽章点进来的清单是跨目录合并的，只写个 page.js 看不出是哪个单元的。
									基准用**这次校验的那个目录**（lint.dir），不是工作区根 ——
									拿工作区根做基准会从四个项目已经相同的那一长串 uuid 开始显示，
									前端截断之后剩下的信息量恰好为零（用户就是这么被坑的）。
								*/
								const label = fromBadge === true ? relativeUnder(String(result.dir ?? ""), entry.path) : entry.name;
								return h(
									"div",
									{
										key: String(issue.rule ?? "issue") + ":" + String(issue.file ?? "") + ":" + index,
										title: String(issue.path ?? ""),
										style: Object.assign({}, CSS.row, { alignItems: "flex-start", gap: 8 }),
										onClick: () => {
											if (entry.path !== "") void openGrepHit(entry, issue.line);
										},
									},
									h(
										"span",
										{
											style: {
												flex: "0 0 auto",
												fontSize: 11,
												padding: "1px 6px",
												borderRadius: 4,
												marginTop: 1,
												color: bad === true ? "rgb(200,60,60)" : "rgb(160,120,20)",
												background: bad === true ? "rgba(220,80,80,.14)" : "rgba(220,180,60,.16)",
											},
										},
										bad === true ? "错误" : "警告",
									),
									h(
										"span",
										{
											style: {
												/* 徽章清单里的路径要能一眼认出是哪个文件，别一上来就被截掉。 */
												flex: fromBadge === true ? "0 1 auto" : "0 0 auto",
												minWidth: 0,
												maxWidth: fromBadge === true ? 420 : undefined,
												overflow: "hidden",
												textOverflow: "ellipsis",
												fontSize: 12,
											},
											title: String(issue.path ?? ""),
										},
										label + (issue.line > 0 ? ":" + issue.line : ""),
									),
									h(
										"span",
										{
											style: Object.assign({}, CSS.muted, {
												flex: "0 0 auto",
												fontSize: 11,
												fontFamily: "var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
											}),
										},
										String(issue.rule ?? ""),
									),
									h(
										"span",
										{ style: { flex: 1, minWidth: 0, fontSize: 12, opacity: 0.9, lineHeight: "17px" } },
										String(issue.message ?? ""),
									),
								);
							}),
				);
			}

			/**
			 * 「脚本」页签：把工作区根下那批 source-*.js 摆成卡片，点一下就跑，下面挂输出控制台。
			 *
			 * 目标地址在外网时，跑任何脚本都要先在这里确认一次（推和拉一样）：按钮先变成
			 * 「确认运行 / 取消」，点确认才带 confirm 去调 RPC —— host 那边也拦了一道，
			 * 两边都拦是因为「连到外面」不该是一次误点就能发生的事。
			 *
			 * 判据是「地址是不是外网」而不是 .env 里的 ENV：ENV 只改脚本自己的文案，
			 * 不切 URL，光看它会漏掉「写着 local、实际连外网」这种最该拦的情况。
			 */
			function renderScripts() {
				const info = scripts;
				const list = info === null || Array.isArray(info.scripts) !== true ? [] : info.scripts;
				const remote = info !== null && info.remote === true;
				const projects = info !== null && Array.isArray(info.projects) ? info.projects : [];
				/*
					项目候选 = **面板里手动维护的**（挂在当前档案上）∪ `.env` 注释里捡的。
					手动那份必须排前面：新铺出来的 `.env` 一条注释都没有，此时它是唯一来源 ——
					而「空目录要去服务器上拉项目」正卡在这一步。
				*/
				const confNow = config;
				const bindingNow =
					confNow !== null && confNow.binding !== null && typeof confNow.binding === "object"
						? confNow.binding
						: { serverId: "", projectUuid: "" };
				const chosenNow =
					confNow === null || Array.isArray(confNow.servers) !== true
						? undefined
						: confNow.servers.find((item) => item !== null && typeof item === "object" && item.id === bindingNow.serverId);
				const manualProjects =
					chosenNow !== undefined && Array.isArray(chosenNow.projects) ? chosenNow.projects : [];
				/*
					两个来源合并去重：**手动那份先入**（面板里存的是用户刚录的，比 `.env`
					注释里那批新），`.env` 注释里捡的排后面；同一个 uuid 先到的赢。
				*/
				const projectList = (() => {
					const seen = new Set();
					const out = [];
					for (const item of manualProjects) {
						if (item === null || typeof item !== "object") continue;
						const uuid = String(item.uuid ?? "");
						if (uuid === "" || seen.has(uuid)) continue;
						seen.add(uuid);
						out.push({ uuid, name: String(item.name ?? "") });
					}
					for (const item of projects) {
						if (item === null || typeof item !== "object") continue;
						const uuid = String(item.uuid ?? "");
						if (uuid === "" || seen.has(uuid)) continue;
						seen.add(uuid);
						out.push({ uuid, name: String(item.name ?? "") });
					}
					return out;
				})();
				/*
					`.env` 里生效的是哪条，只有 host 知道（它在 `projects` 里标了 `active`）。
					必须从**原始** `projects` 里取，不能从合并后的 `projectList` 里 find ——
					手动那份排前面，同一个 uuid 时它会把 host 的标记顶掉。
				*/
				const envActive = projects.find((item) => item !== null && typeof item === "object" && item.active === true);
				const envUuid = envActive === undefined ? "" : String(envActive.uuid ?? "");
				const envLabel = envActive === undefined ? "" : String(envActive.name ?? "") === "" ? envUuid : String(envActive.name);
				/*
					`.env` 里那条本来就在清单里的话，下拉里再摆一个「不指定」就是同一个项目的
					第二个化身 —— 两个选项、一个效果，用户只会问「为什么能选两个」。
					这种情况干脆不摆占位项，直接选中真身（选中它和「不指定」对脚本是一回事：
					`process.argv[2] || process.env.PROJECT_UUID`）。
				*/
				const dupEnv = envUuid !== "" && projectList.some((item) => item.uuid === envUuid);
				const job = runJob;
				const busy = job !== null && job.running === true;

				const status = () => {
					if (job === null) return null;
					if (job.error !== "") return h("span", { style: CSS.badgeError }, String(job.error));
					if (job.running === true) return h("span", { style: CSS.badgeDirty }, "运行中");
					if (job.truncated === true) return h("span", { style: CSS.badgeError }, "输出超限，已终止");
					if (job.killed === true) return h("span", { style: CSS.badgeDirty }, "已停止");
					if (job.code === 0) return h("span", { style: CSS.badgeOk }, "退出码 0");
					return h("span", { style: CSS.badgeError }, "退出码 " + String(job.code === null ? "?" : job.code));
				};

				/*
					项目下拉：面板手动维护的 + `.env` 注释里捡的那批 uuid 合并去重，
					选中的 uuid 会当成脚本的第一个参数传下去。
				*/
				const projectPicker = () =>
					h(
						"select",
						{
							style: CSS.runSelect,
							value: runProject !== "" ? runProject : dupEnv === true ? envUuid : "",
							title: "这个脚本吃一个项目 uuid（不选就用 .env 里生效的那条）",
							onChange: (event) => setRunProject(String(event.target.value ?? "")),
						},
						dupEnv !== true ? h("option", { key: "", value: "" }, envUuid === "" ? "（不指定）" : "（不指定，用 .env 里的 " + envLabel + "）") : null,
						...projectList.map((item, index) =>
							h(
								"option",
								{ key: String(item.uuid ?? index), value: String(item.uuid ?? "") },
								String(item.name ?? "") === "" ? String(item.uuid ?? "") : String(item.name),
							),
						),
					);

				/*
					连接配置区。
					凭据原先只能从工作区的 .env 来 —— 可是空目录里根本没有 .env，「打开一个空白
					文件夹去拉服务器上的项目」就无从填起。现在地址 / 账号 / 项目由面板维护，
					存在 DSH_HOME 下；跑脚本前 host 会把它合并进工作区的 .env（脚本只认 .env）。
					密码读回来永远是掩码，只在输入框里以 password 类型出现。

					ENV 这一行不让用户选，恒写 `local`（脚本也不再按它分支，见 NOTES）。
					本插件没有「本地环境 / 线上环境」的区分：真连哪个地址由 SERVER_URL 说了
					算，外网地址要不要二次确认也按真实主机名判，跟 ENV 无关。
				*/
				const configPanel = () => {
					const conf = config;
					/* 还没读过（刚开始进页签）——别摆一张空表单，先说清楚在读取。 */
					if (conf === null) {
						return h(
							"div",
							{ style: CSS.configBox },
							h(
								"div",
								{ style: CSS.configRow },
								h("span", { style: { flex: "1 1 auto", fontWeight: 600 } }, "连接配置"),
								h("span", { style: Object.assign({}, CSS.muted, { fontSize: 12 }) }, "读取配置…"),
							),
						);
					}
					const servers = conf !== null && Array.isArray(conf.servers) ? conf.servers : [];
					const binding =
						conf !== null && conf.binding !== null && typeof conf.binding === "object"
							? conf.binding
							: { serverId: "", projectUuid: "" };
					const chosen = servers.find((item) => item !== null && typeof item === "object" && item.id === binding.serverId);
					const scaf =
						conf !== null && conf.scaffold !== null && typeof conf.scaffold === "object"
							? conf.scaffold
							: { ready: false, busy: false, code: null, error: "", log: "" };
					const envNow = conf === null || conf.env === null || typeof conf.env !== "object" ? null : conf.env;
					/* .env 里的地址和选中的档案对不上：改了配置但还没落盘。 */
					const envUrl = envNow === null ? "" : String(envNow.SERVER_URL ?? "");
					const wantUrl = chosen === undefined ? "" : String(chosen.serverUrl ?? "");
					const stale = conf !== null && conf.path !== "" && envUrl !== wantUrl;

					const row = (key, label, control) =>
						h("div", { key, style: CSS.configRow }, h("span", { style: CSS.field }, label), control);

					const picker = (kind, value, options, onChange, title) =>
						h(
							"select",
							{ style: Object.assign({}, CSS.runSelect, { marginTop: 0, flex: "1 1 auto" }), value, title, onChange: (event) => onChange(String(event.target.value ?? "")) },
							...options,
						);

					const summary =
						chosen === undefined
							? "还没选服务器"
							: String(chosen.label ?? "") === ""
								? String(chosen.serverUrl ?? "")
								: String(chosen.label) + " · " + String(chosen.serverUrl ?? "");

					const body = [];
					if (configOpen === true) {
						/* 服务器档案 */
						body.push(
							row(
								"server",
								"服务器",
								picker(
									"server",
									String(binding.serverId ?? ""),
									[
										h("option", { key: "", value: "" }, servers.length === 0 ? "（还没有档案，先新建一个）" : "（未选）"),
										...servers.map((item) =>
											h("option", { key: String(item.id ?? ""), value: String(item.id ?? "") }, String(item.label ?? "") === "" ? String(item.serverUrl ?? "") : String(item.label)),
										),
									],
									(serverId) => {
										void bindWorkspace(serverId, String(binding.projectUuid ?? ""));
									},
									"选一个服务器档案（地址 / 账号 / 密码）",
								),
							),
						);
						/*
							项目：面板手动维护的 ∪ `.env` 注释里捡的那批。
							`shownUuid` 是**下拉显示**的选中项：没绑过就退回 `.env` 里生效的那条
							（它本来就在清单里），这样「选中一条」和「不指定」不会并排出现两个
							其实是同一个项目的条目。「改名 / 删除」认的也是 `shownUuid` ——
							显示的是哪条就操作哪条。
						*/
						const shownUuid = String(binding.projectUuid ?? "") !== "" ? String(binding.projectUuid ?? "") : dupEnv === true ? envUuid : "";
						const manualBound = manualProjects.find((item) => String(item.uuid ?? "") === shownUuid);
						body.push(
							h(
								"div",
								{ key: "project", style: CSS.configRow },
								h("span", { style: CSS.field }, "项目"),
								picker(
									"project",
									shownUuid,
									[
										dupEnv === true ? null : h("option", { key: "", value: "" }, "（不指定）"),
										...projectList.map((item) =>
											h(
												"option",
												{ key: String(item.uuid ?? ""), value: String(item.uuid ?? "") },
												String(item.name ?? "") === "" ? String(item.uuid ?? "") : String(item.name),
											),
										),
									],
									(projectUuid) => {
										void bindWorkspace(String(binding.serverId ?? ""), projectUuid);
									},
									"拉取 / 推送整个项目时用的项目 id",
								),
								h(
									"button",
									{
										type: "button",
										style: CSS.miniButton,
										/* 项目挂在档案名下，没选档案就没处放。 */
										disabled: String(binding.serverId ?? "") === "" || configBusy === true,
										title:
											String(binding.serverId ?? "") === ""
												? "先在左边选一个服务器档案 —— 项目清单是挂在档案上的"
												: "手动加一个项目 uuid（新铺的 .env 里没有注释可选，只能手动录）",
										onClick: () => {
											setProjectEdit({ uuid: "", name: "" });
										},
									},
									"＋ 项目",
								),
								manualBound === undefined
									? null
									: h(
											"button",
											{
												type: "button",
												style: CSS.miniButton,
												disabled: configBusy === true,
												onClick: () => {
													setProjectEdit({ uuid: String(manualBound.uuid ?? ""), name: String(manualBound.name ?? "") });
												},
											},
											"改名",
										),
								manualBound === undefined
									? null
									: h(
											"button",
											{
												type: "button",
												style: Object.assign({}, CSS.miniButton, CSS.dangerButton),
												disabled: configBusy === true,
												title: "只从面板的清单里去掉，服务器上的项目不动",
												onClick: async () => {
													const gone = String(manualBound.uuid ?? "");
													const rest = manualProjects.filter((item) => String(item.uuid ?? "") !== gone);
													const saved = await saveProjects(String(binding.serverId ?? ""), rest);
													/* 删掉的正是当前绑定的那个 —— 留着会指向一个列表里没有的项目。 */
													if (saved === true && String(binding.projectUuid ?? "") === gone) {
														await bindWorkspace(String(binding.serverId ?? ""), "");
													}
												},
											},
											"删除",
										),
							),
						);
						/* 手动维护项目的那张小表单 */
						if (projectEdit !== null) {
							const edit = projectEdit;
							const set = (key, value) => setProjectEdit(Object.assign({}, edit, { [key]: value }));
							body.push(
								h(
									"div",
									{ key: "projectedit", style: CSS.configRow },
									h("span", { style: CSS.field }, String(edit.uuid ?? "") === "" ? "新项目" : "改项目"),
									h("input", {
										style: CSS.toolInput,
										value: String(edit.uuid ?? ""),
										placeholder: "项目 uuid",
										onChange: (event) => set("uuid", String(event.target.value ?? "")),
									}),
									h("input", {
										style: CSS.toolInput,
										value: String(edit.name ?? ""),
										placeholder: "名字（可空）",
										onChange: (event) => set("name", String(event.target.value ?? "")),
									}),
									h(
										"button",
										{
											type: "button",
											style: Object.assign({}, CSS.miniButton, CSS.dangerButton),
											onClick: async () => {
												const uuid = String(edit.uuid ?? "").trim();
												if (uuid === "") {
													setNotice("项目 uuid 不能空");
													return;
												}
												/* 按 uuid 认人：同号再存一次就是改名。 */
												const rest = manualProjects.filter((item) => String(item.uuid ?? "") !== uuid);
												const saved = await saveProjects(
													String(binding.serverId ?? ""),
													rest.concat([{ uuid, name: String(edit.name ?? "").trim() }]),
												);
												/* 原来没绑项目的话，加完就顺手绑上 —— 少一步点击。 */
												if (saved === true && String(binding.projectUuid ?? "") === "") {
													await bindWorkspace(String(binding.serverId ?? ""), uuid);
												}
											},
										},
										"保存",
									),
									h("button", { type: "button", style: CSS.miniButton, onClick: () => setProjectEdit(null) }, "取消"),
								),
							);
						}
						/*
							动作**按要操作的顺序排**：新建档案 → 铺脚手架 → 写入 .env → 刷新。
							顺序本身就是说明书 —— 空目录开张那四步（见下面「空白目录」那段）里
							前三步正是这三个按钮；摆成别的顺序，等于让人自己去找该先点哪个。
							「装依赖」不在这排里：它只在该装的时候冒出来，要跟着自己那句说明一起。
						*/
						body.push(
							h(
								"div",
								{ key: "acts", style: CSS.configRow },
								h(
									"button",
									{
										type: "button",
										style: CSS.miniButton,
										title: "填服务器地址 / 账号 / 密码，存进面板（这一步还不会写 .env）",
										onClick: () => {
											setConfigEdit({ id: "", label: "", serverUrl: "", username: "", password: "", cleared: false });
										},
									},
									"新建档案",
								),
								h(
									"button",
									{
										type: "button",
										style: CSS.miniButton,
										disabled: configBusy === true,
										title: "把插件自带的 source-*.js / utils.js / package.json 铺到这个目录（已存在的不动）",
										onClick: () => {
											/*
												在任意目录点一下就会倒进 9 个文件（其中 package.json 还会改变那个
												目录的 Node 模块解析边界）—— 所以先把目标路径摆到眼前问一句。
												面板标题上也写着工作区，但那行字离按钮太远，点下去之前不会去看。
											*/
											const target = String(conf.path ?? "").trim() === "" ? String(dir ?? "") : String(conf.path);
											if (window.confirm("把插件自带的脚本模板铺到：\n\n" + target + "\n\n已存在的文件不会被改动。继续？") !== true) return;
											void scaffoldWorkspace();
										},
									},
									"铺脚手架",
								),
								h(
									"button",
									{
										type: "button",
										style: Object.assign({}, CSS.miniButton, stale === true && servers.length > 0 ? CSS.dangerButton : {}),
										/* 一个档案都没有时 host 必然抛 no-server，不如直接不让点。 */
										disabled: servers.length === 0 || configBusy === true,
										title:
											servers.length === 0
												? "还没有服务器档案 —— 先点「新建档案」填地址 / 账号 / 密码"
												: "把上面选中的档案写进工作区的 .env（写前会备份，注释行不动）",
										onClick: () => {
											void applyConfig();
										},
									},
									configBusy === true ? "写入中…" : "写入 .env",
								),
								h(
									"button",
									{
										type: "button",
										style: CSS.miniButton,
										disabled: configBusy === true,
										onClick: () => {
											void loadConfig(dir);
										},
									},
									configBusy === true ? "读取中…" : "刷新",
								),
							),
						);
						/* .env 现状 */
						body.push(
							h(
								"div",
								{ key: "envnow", style: Object.assign({}, CSS.muted, { fontSize: 11 }) },
								(conf !== null && conf.hasEnv === true ? ".env：" : "还没有 .env（点「写入 .env」会新建一个）：") +
									"地址 " + (envUrl === "" ? "未设" : envUrl) +
									" ｜ 账号 " + (envNow !== null && envNow.hasUsername === true ? "有" : "无") +
									" ｜ 密码 " + (envNow !== null && envNow.hasPassword === true ? "有" : "无") +
									(envNow !== null && String(envNow.PROJECT_UUID ?? "") !== "" ? " ｜ 项目 " + String(envNow.PROJECT_UUID) : ""),
							),
						);
						if (stale === true) {
							body.push(
								h(
									"div",
									{ key: "stale", style: Object.assign({}, CSS.muted, { fontSize: 11, color: "var(--dsw-alias-label-error, #c4342c)" }) },
									"选中的档案是 " + wantUrl + "，.env 里还是 " + (envUrl === "" ? "（空）" : envUrl) + " —— 点「写入 .env」才生效（跑脚本时 host 也会顺手同步一次）。",
								),
							);
						}
						/* 模板依赖 */
						if (scaf.busy === true) {
							body.push(
								h("div", { key: "depsbusy", style: Object.assign({}, CSS.muted, { fontSize: 11 }) }, "正在装模板依赖（axios / archiver / form-data / unzipper）…"),
							);
						} else if (scaf.ready === false) {
							body.push(
								h(
									"div",
									{ key: "deps", style: CSS.configRow },
									h("span", { style: Object.assign({}, CSS.muted, { fontSize: 11, flex: "1 1 auto" }) }, "模板依赖没装：铺好脚手架也跑不起来（脚本要 require axios / archiver / unzipper）。"),
									h(
										"button",
										{
											type: "button",
											style: CSS.miniButton,
											disabled: configBusy === true,
											onClick: () => {
												void scaffoldWorkspace();
											},
										},
										"装依赖",
									),
								),
							);
						}
						/* 档案清单 */
						for (const item of servers) {
							body.push(
								h(
									"div",
									{ key: "srv-" + String(item.id ?? ""), style: CSS.configRow },
									h(
										"span",
										{ style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: String(item.serverUrl ?? "") },
										String(item.label ?? "") === "" ? String(item.serverUrl ?? "") : String(item.label) + " · " + String(item.username ?? ""),
									),
									/*
										这里**不标「外网 / 本机」**：地址就摆在左边，用户自己的服务器
										是内是外他比面板清楚，多一个标签只是噪音。推送前的二次确认
										照旧按真实主机名判（判据在 host，跟这行显示无关）。
									*/
									item.hasPassword === true ? null : h("span", { style: CSS.badgeDirty }, "没密码"),
									h(
										"button",
										{
											type: "button",
											style: CSS.miniButton,
											onClick: () => {
												setConfigEdit({ id: String(item.id ?? ""), label: String(item.label ?? ""), serverUrl: String(item.serverUrl ?? ""), username: String(item.username ?? ""), password: undefined, cleared: false });
											},
										},
										"编辑",
									),
									h(
										"button",
										{
											type: "button",
											style: Object.assign({}, CSS.miniButton, CSS.dangerButton),
											onClick: () => {
												if (window.confirm("删掉这个服务器档案？引用它的工作区绑定会一起清空。")) void deleteServer(String(item.id ?? ""));
											},
										},
										"删除",
									),
								),
							);
						}
						/* 编辑表单 */
						if (configEdit !== null) {
							const edit = configEdit;
							const known = String(edit.id ?? "") !== "";
							const set = (key, value) => setConfigEdit(Object.assign({}, edit, { [key]: value }));
							const line = (key, label, control) =>
								h("div", { key, style: CSS.configRow }, h("span", { style: CSS.field }, label), control);
							/*
								这是「某台开发服务器的登录凭据」，跟浏览器密码库里存的网站登录
								不是一回事 —— 让它自动填只会把不相干的密码塞进来，还会连带把
								账号也顶掉。一律关掉（Chrome 对 password 认 new-password）。
							*/
							const input = (key, placeholder, secret, value) =>
								h("input", {
									style: CSS.toolInput,
									type: secret === true ? "password" : "text",
									value,
									placeholder,
									autoComplete: secret === true ? "new-password" : "off",
									onChange: (event) => set(key, String(event.target.value ?? "")),
								});
							body.push(
								h(
									"div",
									{ key: "edit", style: Object.assign({}, CSS.configBox, { padding: "8px 0 0", borderBottom: "none" }) },
									line("e-label", "名称", input("label", "给自己看的，比如 智家排程 / 测试服", false, String(edit.label ?? ""))),
									line("e-url", "地址", input("serverUrl", "http://主机:端口", false, String(edit.serverUrl ?? ""))),
									line("e-user", "账号", input("username", "登录用户名", false, String(edit.username ?? ""))),
									line(
										"e-pass",
										"密码",
										h(
											"div",
											{ style: { display: "flex", gap: 6, flex: "1 1 auto", minWidth: 0 } },
											input(
												"password",
												known === true ? "留空即不改" : "登录密码",
												true,
												edit.cleared === true ? "" : String(edit.password ?? ""),
											),
											known === true
												? h(
														"button",
														{
															type: "button",
															style: CSS.miniButton,
															onClick: () => setConfigEdit(Object.assign({}, edit, { cleared: true, password: undefined })),
														},
														"清空",
													)
												: null,
										),
									),
									h(
										"div",
										{ style: { ...CSS.configRow, marginTop: 2 } },
										h(
											"button",
											{
												type: "button",
												style: Object.assign({}, CSS.miniButton, CSS.dangerButton),
												onClick: () => {
													if (String(edit.serverUrl ?? "").trim() === "") {
														setNotice("地址不能空（形如 http://主机:端口）");
														return;
													}
													void saveServer(
														Object.assign({}, edit, {
															password: edit.cleared === true ? "" : String(edit.password ?? "") === "" ? undefined : edit.password,
														}),
													);
												},
											},
											known === true ? "保存" : "新建",
										),
										h("button", { type: "button", style: CSS.miniButton, onClick: () => setConfigEdit(null) }, "取消"),
									),
								),
							);
						}
					}

					return h(
						"div",
						{ style: CSS.configBox },
						h(
							"div",
							{ style: CSS.configRow },
							h("span", { style: { flex: "1 1 auto", minWidth: 0, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "连接配置"),
							h("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.6, fontSize: 12 } }, summary),
							h(
								"button",
								{
									type: "button",
									style: CSS.miniButton,
									onClick: () => setConfigOpen(configOpen !== true),
								},
								configOpen === true ? "收起" : "展开",
							),
						),
						configOpen === true ? body : null,
					);
				};

				const card = (item) => {
					const asking = runAsk !== null && runAsk.name === item.name;
					/*
						外网地址下**所有**脚本都要确认，推和拉一样 —— 拉取也是拿服务器上的
						东西覆盖本地文件。配色跟着一起红：要二次确认的按钮长得跟不用确认的
						一样，用户只会被突然冒出来的确认框绊一下。
					*/
					const danger = remote === true;
					return h(
						"div",
						{ key: String(item.name ?? ""), style: CSS.runCard },
						h(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
							h(
								"span",
								{
									style: { flex: "1 1 auto", minWidth: 0, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
									title: String(item.label ?? ""),
								},
								String(item.label ?? item.name ?? ""),
							),
							/*
								这里**不挂「线上」角标**：卡片是不是往外发，点「运行」那一步的
								二次确认会自己说清楚（按钮先变成「确认运行」）。每张 push 卡都顶着
								同一个标签，看久了只会变成背景噪音。配色照旧偏红（`dangerButton`）。
							*/
							item.known === false ? h("span", { style: CSS.badgeDirty }, "未登记") : null,
						),
						h(
							"div",
							{ style: CSS.runName, title: String(item.name ?? "") },
							String(item.name ?? "") + (Array.isArray(item.args) && item.args.length > 0 ? " " + item.args.join(" ") : ""),
						),
						item.project === true ? projectPicker() : null,
						asking === true
							? h(
									"div",
									{ style: { display: "flex", gap: 6, marginTop: 2 } },
									h(
										"button",
										{
											type: "button",
											style: Object.assign({}, CSS.miniButton, CSS.dangerButton),
											onClick: () => {
												void startRun(item, true);
											},
										},
										"确认运行",
									),
									h("button", { type: "button", style: CSS.miniButton, onClick: () => setRunAsk(null) }, "取消"),
								)
							: h(
									"button",
									{
										type: "button",
										style: Object.assign({}, CSS.miniButton, danger === true ? CSS.dangerButton : {}, busy === true ? { opacity: 0.5 } : {}),
										onClick: () => {
											/* 同一时刻只留一个运行：有任务在跑就先别叠上去。 */
											if (busy === true) return;
											if (danger === true) setRunAsk({ name: item.name, label: String(item.label ?? item.name ?? "") });
											else void startRun(item, false);
										},
									},
									"运行",
								),
					);
				};

				return h(
					"div",
					{ style: CSS.detail },
					h(
						"div",
						{
							style: Object.assign({}, CSS.muted, {
								flex: "0 0 auto",
								padding: "4px 12px 8px",
								display: "flex",
								gap: 8,
								alignItems: "center",
							}),
						},
						h(
							"span",
							{
								style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
								title: info === null ? "" : String(info.path ?? ""),
							},
							info === null ? "读取脚本清单…" : String(info.path ?? dir),
						),
						info !== null && String(info.targetLabel ?? "") !== "" ? h("span", { style: remote === true ? CSS.badgeError : CSS.badgeOk, title: info === null ? "" : String(info.serverUrl ?? "") }, String(info.targetLabel)) : null,
						h(
							"button",
							{
								type: "button",
								style: CSS.miniButton,
								onClick: () => {
									void loadScripts(dir);
								},
							},
							scriptsBusy === true ? "读取中…" : "刷新",
						),
					),
					configPanel(),
					info !== null && typeof info.failed === "string" && info.failed !== ""
						? h("div", { style: Object.assign({}, CSS.muted, { padding: "0 12px 8px" }) }, info.failed)
						: null,
					list.length === 0
						? h(
								"div",
								{ style: Object.assign({}, CSS.muted, { padding: "0 12px", lineHeight: 1.7 }) },
								info === null
									? ""
									: "这个目录下没有 source-*.js。面板跑的就是工作区根下这一层的脚本 —— 推送、拉取、克隆都靠它们。" +
										"空白目录可以这样开张：① 上面「连接配置」里「新建档案」填服务器地址 / 账号 / 密码；② 点「铺脚手架」把模版脚本铺进来；③ 点「写入 .env」落盘；④ 再点「装依赖」。之后这张卡片就会长出来。",
							)
						: h("div", { style: CSS.runGrid }, list.map(card)),
					job === null
						? null
						: h(
								"div",
								{ style: CSS.runConsole },
								h(
									"div",
									{ style: Object.assign({}, CSS.detailBar, { gap: 8 }) },
									h(
										"span",
										{
											style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
											title: String(job.cmd ?? ""),
										},
										"$ " + String(job.cmd ?? ""),
									),
									status(),
									job.running === true
										? h(
												"button",
												{
													type: "button",
													style: CSS.miniButton,
													onClick: () => {
														void stopRun();
													},
												},
												"停止",
											)
										: h("button", { type: "button", style: CSS.miniButton, onClick: () => setRunJob(null) }, "清空"),
								),
								h(
									"pre",
									{ ref: runLogRef, style: CSS.runLog },
									/* 只有空白（脚本光打回车不打字）也当没输出，别给个大空框。 */
									String(job.log ?? "").trim() === "" ? (job.running === true ? "（等待输出…）" : "（没有输出）") : String(job.log),
								),
							),
				);
			}

			/** 页签标题：把错误/警告数直接摊在标题上，不用切进去才知道要不要看。 */
			function lintTabTitle() {
				if (lint === null) return "校验";
				if (typeof lint.failed === "string" && lint.failed !== "") return "校验 ×";
				const issues = Array.isArray(lint.issues) ? lint.issues : [];
				if (issues.length === 0) return "校验 ✓";
				/* 徽章点进来的清单只带错误，级数要用 host 一起给的计数，不能拿 issues 现数。 */
				const errors = typeof lint.errors === "number" ? lint.errors : issues.filter((issue) => issue.level === "error").length;
				const warns = typeof lint.warns === "number" ? lint.warns : issues.length - errors;
				return "校验 " + errors + "✗ " + warns + "!";
			}

			function renderTree() {
				if (dir.trim() === "") return h("div", { style: CSS.muted }, "还没有工程目录。");
				/* 有搜索词就整块换成结果列表：树是逐层展开的，两者没法混着显示。 */
				if (search.trim() !== "") return searchMode === "content" ? renderGrepSearch() : renderSearch();
				const root = nodes.get(dir);
				/*
					行是拼平的一整个数组，必须自己包一层滚动容器：直接把数组丢进 body，
					长目录会把面板顶高、连滚动条都长不出来。

					未就绪 / 报错 / 空目录这三种情况也走同一个容器，理由是右键菜单：
					空目录里没有行可以右键，只能靠容器上这一层拿到「在工程根新建」。
					输入行则由 renderLevel 负责吐出来（它不管这一层拉没拉回来）。
				*/
				const shell = (child) =>
					h(
						"div",
						{
							ref: treeRef,
							style: CSS.tree,
							/* 空白处右键 = 在工程根新建。 */
							onContextMenu: (event) => {
								event.preventDefault();
								openMenu(event, null);
							},
							/*
								行里的点击会冒泡到这里。正常模式下这里什么都不做；
								「移动到…」模式下落到空白 = 放弃（空白不是一个明确的目录，
								真要搬到根上，把东西拖到第一层的目录旁边松手就行）。
							*/
							onClick: () => {
								if (moveList !== null) setMoveList(null);
							},
							/* 拖到行之间的空隙上 = 搬到工作区根。 */
							onDragOver: (event) => {
								if (dragPathRef.current === null) return;
								event.preventDefault();
								event.dataTransfer.dropEffect = "move";
								if (dragOver !== dir) setDragOver(dir);
							},
							onDrop: (event) => {
								const src = dragPathRef.current;
								if (src === null) return;
								event.preventDefault();
								void moveEntry(src, dir);
							},
						},
						child,
						renderLevel(dir, 0),
					);
				if (root === undefined || root.status === "loading") return shell(h("div", { style: CSS.muted }, "读取中…"));
				if (root.status === "error") return shell(h("div", { style: CSS.muted }, "读取失败：" + (root.error ?? "")));
				if (root.entries.length === 0) return shell(h("div", { style: CSS.muted }, "空文件夹（右键可新建）"));
				return shell(null);
			}

			/** 源码页签顶上的标签条：一个文件一个签，点着切，× 关掉。 */
			function renderCodeTabs() {
				if (shots.length === 0) return null;
				return h(
					"div",
					{ style: CSS.codeTabs },
					shots.map((shot, index) =>
						h(
							"div",
							{
								key: shot.path,
								title: shot.path,
								style: index === shotAt ? CSS.codeTabOn : CSS.codeTab,
								onClick: () => setShotAt(index),
							},
							h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, shot.name),
							h(
								"span",
								{
									style: CSS.tabX,
									title: "关掉这个标签",
									onClick: (event) => {
										event.stopPropagation();
										closeShot(shot.path);
									},
								},
								"×",
							),
						),
					),
					h("span", { style: { flex: 1, minWidth: 0 } }),
					h(
						"button",
						{ type: "button", style: CSS.button, title: "关掉全部源码标签", onClick: () => closeAllShots() },
						"全部关闭",
					),
				);
			}

			/** 选行视图：行号 + 行文本，按住拖动选一个行区间，再引成 `@文件 L起-止`。 */
			function renderCodeBody() {
				const lo = Math.min(snippet.anchor, snippet.focus);
				const hi = Math.max(snippet.anchor, snippet.focus);
				const bar = h(
					"div",
					{ style: CSS.detailBar },
					h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, snippet.name),
					h("span", { style: { flex: 1, minWidth: 0 } }),
					h("span", { style: { opacity: 0.6, whiteSpace: "nowrap" } }, lo === hi ? "L" + lo : "L" + lo + "-" + hi),
					h(
						"label",
						{ style: CSS.check, title: "勾上以后连这几行的原文一起贴进输入框，AI 不用再自己数行" },
						h("input", {
							type: "checkbox",
							checked: snippet.withBody === true,
							onChange: (event) => {
								const on = event.target.checked;
								setSnippet((prev) => (prev === null ? prev : Object.assign({}, prev, { withBody: on })));
							},
						}),
						"带行内容",
					),
					h(
						"button",
						{ type: "button", style: CSS.button, onClick: () => insertRange(), disabled: snippet.status !== "ready" },
						"引用这段",
					),
					h(
						"button",
						{
							type: "button",
							style: CSS.button,
							title: "换成可写回的编辑器，改完点「写回」存盘",
							onClick: () =>
								setSnippet((prev) => (prev === null ? prev : Object.assign({}, prev, { mode: "edit" }))),
						},
						"编辑",
					),
					h(
						"button",
						{
							type: "button",
							style: CSS.button,
							title: "交给官方预览器打开（HTML、Markdown 这类会渲染成页面）",
							onClick: () => previewFile(),
						},
						"预览",
					),
					h(
						"button",
						{
							type: "button",
							style: CSS.button,
							onClick: () => closeShot(snippet.path),
						},
						"关闭",
					),
				);
				if (snippet.status === "loading") return h("div", { style: CSS.detail }, bar, h("div", { style: CSS.muted }, "读取中…"));
				if (snippet.status === "error") {
					return h("div", { style: CSS.detail }, bar, h("div", { style: CSS.muted }, "读取失败：" + (snippet.error ?? "")));
				}
				const all = snippet.content.split("\n");
				const capped = all.length > 4000;
				const rows = (capped === true ? all.slice(0, 4000) : all).map((text, index) => {
					const n = index + 1;
					const on = n >= lo && n <= hi;
					return h(
						"div",
						{
							key: n,
							"data-line": n,
							style: on === true ? CSS.lineOn : CSS.line,
							onMouseDown: () => {
								/* 这里故意不 preventDefault：高亮出来的文本要能直接拖进输入框。
								   只记下起点，按住往下拉就能框住一片行。 */
								setSnippet((prev) => (prev === null ? prev : Object.assign({}, prev, { anchor: n, focus: n, dragging: true })));
							},
							onMouseEnter: () => {
								setSnippet((prev) => (prev !== null && prev.dragging === true ? Object.assign({}, prev, { focus: n }) : prev));
							},
							onDragStart: (event) => {
								/* 拖出去的不是光秃秃的代码，而是带行号的引用 —— AI 才知道这段来自哪个文件。
								   行号以浏览器自己的选区为准：先拉选区、再按住选区拖时，
								   我们记的 anchor 会被那次按下重置，只有原生选区还留着真实范围。 */
								const picked = selectionLines();
								const shot = picked === null ? snippet : Object.assign({}, snippet, { anchor: picked.lo, focus: picked.hi });
								const text = cwd === "" ? undefined : rangePromptText(shot, cwd);
								if (text === undefined) return;
								event.dataTransfer.setData("text/plain", text);
								event.dataTransfer.effectAllowed = "copy";
							},
						},
						h("span", { style: CSS.gutter }, String(n)),
						h("span", { style: CSS.lineText }, text === "" ? " " : text),
					);
				});
				return h(
					"div",
					{ style: CSS.detail },
					bar,
					capped === true ? h("div", { style: CSS.muted }, "文件太大，只显示前 4000 行。") : null,
					h("div", { style: CSS.lines }, rows),
				);
			}

			/** 源码页签的正文：选行视图、面板内编辑器，或者「还没打开」的提示。 */
			function renderCodePane() {
				if (snippet === null) {
					return h(
						"div",
						{ style: CSS.muted },
						"还没选文件。回「文件树」页签，点某个文件行右边的「源码」就能在这里看。",
						h("br"),
						"可以同时开好几个文件，上面的标签条负责来回切。",
						h("br"),
						"选中以后按住行往下拖框出一段，再拖进输入框——出去的就是带行号的引用。",
						h("br"),
						"想渲染 HTML / Markdown 用「预览」，那个走官方预览器。",
					);
				}
				if (snippet.mode !== "edit") return renderCodeBody();
				const shot = snippet;
				const bar = h(
					"div",
					{ style: CSS.detailBar },
					h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, shot.path),
					h("span", { style: { flex: 1, minWidth: 0 } }),
					h(
						"button",
						{
							type: "button",
							style: CSS.button,
							title: "回到带行号的只读视图，可以在那里拖选行做引用",
							onClick: () =>
								setSnippet((prev) => (prev === null ? prev : Object.assign({}, prev, { mode: "code" }))),
						},
						"选行",
					),
					h(
						"button",
						{
							type: "button",
							style: CSS.button,
							onClick: () => void saveShot(),
							disabled: shot.status !== "ready",
							title: shot.content === shot.saved ? "存盘（Ctrl+S）" : "有改动还没写回（Ctrl+S）",
						},
						shot.content === shot.saved ? "写回" : "写回 •",
					),
					h(
						"button",
						{
							type: "button",
							style: CSS.button,
							onClick: () => setSnippet(null),
						},
						"关闭",
					),
				);
				if (shot.status === "loading") return h("div", { style: CSS.detail }, bar, h("div", { style: CSS.muted }, "读取中…"));
				if (shot.status === "error") {
					return h("div", { style: CSS.detail }, bar, h("div", { style: CSS.muted }, "读取失败：" + (shot.error ?? "")));
				}
				/*
					Ctrl/Cmd+S 当「写回」。CodeMirror 的按键会冒泡到宿主容器上，
					所以这个处理器挂在容器那一层，两种编辑器共用一份。
				*/
				const onSaveKey = (event) => {
					if ((event.ctrlKey === true || event.metaKey === true) && event.key.toLowerCase() === "s") {
						event.preventDefault();
						void saveShot();
					}
				};
				return h(
					"div",
					{ style: CSS.detail },
					bar,
					editorMod.status === "error"
						? h(
								"div",
								{ style: CSS.muted },
								"编辑器分片没加载起来（" + editorMod.error + "），已经退回内置文本框。",
							)
						: null,
					editorMod.status === "ready"
						? h("div", {
								/*
									key 用路径：换文件时让 React 换掉整个节点，回调 ref 就会
									先销毁旧实例、再按新文件建一个，不必再手写「路径变了要重建」。
								*/
								key: snippet.path,
								ref: editorHostRef,
								style: CSS.editorHost,
								onKeyDown: onSaveKey,
							})
						: h("textarea", {
								style: CSS.editor,
								spellCheck: false,
								value: shot.content,
								/* Ctrl/Cmd+S 也当「写回」，不然手会先去摸那个按钮。 */
								onKeyDown: onSaveKey,
								onChange: (event) => {
									const next = event.target.value;
									setSnippet((prev) => (prev === null ? prev : Object.assign({}, prev, { content: next })));
								},
							}),
				);
			}

			/** 源码页签 = 标签条 + 正文。没开标签时就连标签条一起省掉。 */
			function renderDetail() {
				if (shots.length === 0) return renderCodePane();
				return h("div", { style: CSS.codePane }, renderCodeTabs(), renderCodePane());
			}

			/* 源码页签的标题跟着当前标签走。 */
			const codeOpen = snippet !== null;
			const codeTitle = snippet === null ? "源码" : "源码 · " + snippet.name;

			/*
				顶栏只剩一个模糊搜索框 + 刷新。

				原来这里是「工作区下拉 + 路径输入框 + 打开」，但工作区就是会话目录，
				本来就没什么可输的；树才是每天要用的东西，而树只能一层层点。所以这个
				位置让给搜索框，切换工作区挪到空白处右键菜单里。
			*/
			return h(
				"div",
				{ style: CSS.root },
				h(
					"div",
					{ style: CSS.bar },
					h("input", {
						style: CSS.input,
						spellCheck: false,
						placeholder:
							searchMode === "content"
								? "搜索文件内容（纯文本，忽略大小写）"
								: "搜索文件名（模糊匹配，如 dsprjp）",
						value: search,
						onChange: (event) => {
							setSearch(event.target.value);
							/* 结果在「文件树」页签里，人在「源码」页签时敲字必须把他带回去。 */
							if (event.target.value !== "") setView("tree");
						},
						onKeyDown: (event) => {
							if (event.key === "Escape") setSearch("");
						},
					}),
					h(
						"button",
						{
							type: "button",
							style: searchMode === "name" ? Object.assign({}, CSS.miniButton, CSS.modeOn) : CSS.miniButton,
							title: "按文件名搜：子序列模糊匹配，只翻目录不读文件，很快",
							onClick: () => {
								setSearchMode("name");
								setGrep(null);
							},
						},
						"文件名",
					),
					h(
						"button",
						{
							type: "button",
							style: searchMode === "content" ? Object.assign({}, CSS.miniButton, CSS.modeOn) : CSS.miniButton,
							title: "按文件内容搜：逐行找这段文字，命中的行会带行号列出来，点一下跳到源码",
							onClick: () => {
								setSearchMode("content");
								setSearchHits(null);
							},
						},
						"内容",
					),
					search === "" ? null : h("button", { type: "button", style: CSS.button, onClick: () => setSearch("") }, "清空"),
					h("button", { type: "button", style: CSS.button, onClick: refresh }, "刷新"),
				),
				/*
					「移动到…」模式：源已经选好，等用户点一个目标目录。
					这条必须显眼而且带出口 —— 进了模式却不提示的话，接下来每一次点击
					都变成搬家，用户只会以为面板坏了。
				*/
				moveList === null
					? null
					: h(
							"div",
							{
								style: Object.assign({}, CSS.muted, {
									padding: "6px 14px",
									display: "flex",
									alignItems: "center",
									gap: 8,
									background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))",
								}),
							},
							h(
								"span",
								{ style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } },
								"把「" + baseNameOf(moveList) + "」移到哪儿？点一个目录（拖过去也行），Esc 取消。",
							),
							h("button", { type: "button", style: CSS.miniButton, onClick: () => setMoveList(null) }, "取消"),
						),
				notice === "" ? null : h("div", { style: Object.assign({}, CSS.muted, { padding: "8px 14px" }) }, notice),
				h(
					"div",
					{ style: CSS.tabs },
					h(
						"button",
						{
							type: "button",
							style: view === "tree" ? Object.assign({}, CSS.tab, CSS.tabOn) : CSS.tab,
							onClick: () => {
								setView("tree");
								/*
									回到树就顺手重扫一次推送状态：文件可能是 AI 在会话里改的、
									或用别的工具改的，面板没经手就不知道账本已经过期。
								*/
								void loadPushStatus(dir);
							},
						},
						"文件树",
					),
					/* 没东西可看时不给切：不然会跳到一个空白页签上。 */
					h(
						"button",
						{
							type: "button",
							style: view === "code" ? Object.assign({}, CSS.tab, CSS.tabOn) : CSS.tab,
							opacity: codeOpen === true ? 1 : 0.4,
							disabled: codeOpen !== true,
							title: codeOpen === true ? "看这个文件的源码，按住拖选一段行区间就能只引用那几行" : "先点某个文件行的「源码」",
							onClick: () => {
								if (codeOpen === true) setView("code");
							},
						},
						codeTitle,
					),
					/* 没校验过就不给切 —— 空白页签比灰着更让人困惑。 */
					h(
						"button",
						{
							type: "button",
							style: view === "lint" ? Object.assign({}, CSS.tab, CSS.tabOn) : CSS.tab,
							opacity: lint === null ? 0.4 : 1,
							disabled: lint === null,
							title: lint === null ? "在目录上右键选「推送前校验」" : String(lint.dir ?? "") + " 的静态校验结果",
							onClick: () => {
								if (lint !== null) setView("lint");
							},
						},
						lintTabTitle(),
					),
					/*
						「脚本」：跑工作区根下那批 source-*.js（推送 / 拉取 / 克隆）。
						这个页签永远可点 —— 清单是进了页签才去读的，没脚本也要能进去看到这句话。
					*/
					h(
						"button",
						{
							type: "button",
							style: view === "run" ? Object.assign({}, CSS.tab, CSS.tabOn) : CSS.tab,
							title: "跑工程根目录下的 source-*.js：推送、拉取、克隆",
							onClick: () => setView("run"),
						},
						runRunning === true ? "脚本 ●" : "脚本",
					),
				),
				h(
					"div",
					{ ref: bodyRef, style: CSS.body },
					view === "code" ? renderDetail() : null,
					view === "lint" ? renderLint() : null,
					view === "run" ? renderScripts() : null,
					view === "tree" ? renderTree() : null,
					renderMenu(),
				),
			);
		}

		/* ------------------------------------------------- 注册 */

		const inject = ["slots", "sidebarRightTabs"];

		function apply(ctx) {
			panelCtx = ctx;
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			const tabs = ctx.get("sidebarRightTabs");
			if (tabs === undefined || tabs === null || typeof tabs.register !== "function") {
				/*
					不抛错：抛错会让插件激活失败，进而拖累整个 profile。
					只是工程面板挂不出来，其余功能不受影响。
				*/
				console.warn("[dsh-project-panel] sidebarRightTabs 不可用，工程 tab 未注册。");
				return;
			}
			ctx.effect(
				() =>
					tabs.register({
						id: TAB_ID,
						kind: TAB_KIND,
						priority: "extension",
						/*
							点文件会把这个 tab 换成官方预览器，切回来时要原样接上 ——
							没有 keepMounted 的话组件会被卸载，展开的树和源码标签全丢。
						*/
						keepMounted: true,
						title: () => "工程",
						guide: [
							{
								id: "project",
								order: 20,
								title: () => "工程",
								description: () => "工作区文件树、推送状态与工程体检",
							},
						],
					}),
				"dsh-project-panel: project tab type",
			);
			slots.inject("sidebar.right.pane.tab", () =>
				slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, ProjectBody),
			);
			/*
				侧栏底部只挂一个按钮。
				**绝不注册 main / sidebar.panellist / sidebar.workspaces**：
				- main + sidebar.panellist 会让 ctx.layout.selectPanel 把中栏
				  （会话 + 底部输入框）整块换成插件面板 —— 用户就再也发不出消息；
				- sidebar.workspaces 是 single 席位，被 ui-workspace 占着，
				  抢它会顶掉会话列表。
			*/
			slots.inject("sidebar.footer.action", () =>
				slots.register({ name: "sidebar.footer.action", id: ENTRY_ID, order: 40 }, ProjectToggleButton),
			);
		}

		return { apply, inject };
	},
});
