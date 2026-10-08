/**
 * dsh-magical-lowcode-project — 客户端半边（自包含 Web 面板）。
 *
 * 为什么是手写的经典 script 而不是打包产物：
 *   React、cordis、以及 UI 基元都由 shell 的种子表（PLATFORM_MODULES）提供，
 *   本插件的客户端代码没有任何第三方依赖需要内联，所以 esbuild 这一环纯属多余。
 *   手写省掉一个 devDependency 与一个必须在发布前跑到的构建步骤，
 *   符合「host 半边手写直发、客户端半边也手写直发」的决策。
 *
 * 契约（全部来自对宿主 @deepseek-ai/dsh-client-modules@0.1.5-rc.2 与
 * dsh-web-frontend 种子表的实测，见 <workspace>/docs/research-client-plugin-api.md）：
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
 *     本插件只占用 settings.section（官方占 general/models/plugins/agent-presets）
 *     与 sidebar.footer.action（官方占 cordis-panel），用的都是新 id，互不遮蔽。
 *   - 不能在模块体做副作用：整个文件只定义函数并调用一次 load()，apply 才做挂载。
 */
window.__ModuleLoader__.load({
	id: "dsh-magical-lowcode-project",
	factory: (require) => {
		"use strict";

		/** 包名；下面的 __ModuleLoader__ 信封 id 与 RPC 的 rpcId 前缀都用它。 */
		const PACKAGE_NAME = "dsh-magical-lowcode-project";
		/** host 半边 super(ctx, "desktopProjectController", { namespace: "desktopProject" }) 的 namespace。 */
		const NAMESPACE = "desktopProject";
		/** 两个 slot 条目共用的 id。 */
		const ENTRY_ID = "magical-lowcode-project";

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

		const React = pickModule(require("react"), ["createElement", "useState", "useCallback", "useRef", "Fragment"]);
		const UI = pickModule(require("@deepseek-ai/dsh-client-ui-primitives"), ["Button", "Input", "Modal", "Pill", "Tag"]);
		const h = React.createElement;
		const { useState, useCallback, useRef, Fragment } = React;

		/**
		 * host 半边暴露的 12 个 Remote 方法，顺序与 lib/index.js 的 markRemote 循环逐字一致。
		 */
		const METHODS = [
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
			"projectLint",
		];

		/**
		 * 每个方法在 wire 上收的是**具名参数对象**，不是位置实参。
		 * 上游原版 DSH Desktop 补丁就是这么调的：desktopProjectRpc("listProjectEntries", { path })。
		 */
		const METHOD_PARAMS = {
			listProjectEntries: ["path"],
			projectPushStatus: ["dir"],
			projectRunScript: ["script", "args", "cwd"],
			projectMarkPushed: ["workspacePath", "relDir", "scope", "target"],
			projectResetPushState: [],
			projectRenameEntry: ["path", "newName"],
			projectSetProjectName: ["workspacePath", "uuid", "name"],
			projectDeleteEntry: ["path"],
			projectReadFile: ["path"],
			projectWriteFile: ["path", "content"],
			projectAssemblePreview: ["dir"],
			projectLint: ["dir"],
		};

		/** wire 信封里的 rpcId 序号。 */
		let rpcSeq = 0;

		/** 位置实参 → wire 具名参数，并补上游原版的两个默认值。 */
		function namedArgs(method, args) {
			const names = METHOD_PARAMS[method] ?? [];
			const payload = {};
			for (let index = 0; index < names.length; index += 1) {
				if (args[index] !== undefined) payload[names[index]] = args[index];
			}
			if (method === "projectRunScript" && payload.args === undefined) payload.args = [];
			if (method === "projectMarkPushed" && payload.relDir === undefined) payload.relDir = "";
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

		/* ------------------------------------------------- 路径记忆（localStorage） */

		function readStoredPath(key) {
			try {
				const value = window.localStorage.getItem(key);
				return typeof value === "string" ? value : "";
			} catch (error) {
				return "";
			}
		}

		/** 受控输入 + localStorage 记忆，面板里每个页签各记一个目录。 */
		function useRememberedPath(storageKey) {
			const [value, setValue] = useState(() => readStoredPath(storageKey));
			const update = useCallback((next) => {
				setValue(next);
				try {
					window.localStorage.setItem(storageKey, next);
				} catch (error) {
					/* 隐私模式下写不进去，忽略 */
				}
			}, [storageKey]);
			return [value, update];
		}

		/* ------------------------------------------------------------------ 样式 */

		const muted = { opacity: 0.7 };
		const rowStyle = { display: "flex", alignItems: "center", gap: 8 };
		const wrapStyle = { wordBreak: "break-all" };
		const listStyle = { margin: 0, padding: 0, listStyle: "none", maxHeight: 320, overflow: "auto" };
		const itemStyle = { display: "flex", alignItems: "center", gap: 8, padding: "2px 0" };
		const preStyle = {
			margin: 0,
			padding: 8,
			maxHeight: 320,
			overflow: "auto",
			fontSize: 12,
			whiteSpace: "pre-wrap",
			wordBreak: "break-all",
			background: "rgba(127,127,127,0.08)",
			borderRadius: 6,
		};
		const gridStyle = { display: "flex", flexDirection: "column", gap: 10 };
		/** 用文字前缀表达状态，避免依赖未证实的 Tag tone 取值。 */
		const statusText = (status) => (status === "pushed" ? "✔ 已推送" : status === "dirty" ? "● 待推送" : String(status ?? ""));

		function Notice({ error, children }) {
			if (error !== undefined && error !== null) {
				return h("div", { style: Object.assign({}, wrapStyle, { color: "var(--dsh-danger, #d33)" }) }, "✗ " + error);
			}
			if (children === undefined || children === null || children === false) return null;
			return h("div", { style: muted }, children);
		}

		/* ------------------------------------------------------ 页签 1：项目树 */

		function TreeTab() {
			const [dir, setDir] = useRememberedPath("dsh-magical-lowcode-project:tree-dir");
			const [state, setState] = useState({ status: "idle" });
			const [selected, setSelected] = useState(null);

			const refresh = useCallback(async () => {
				const target = dir.trim();
				if (target === "") return;
				setState({ status: "loading" });
				const result = await call("listProjectEntries", target);
				setState(result.ok ? { status: "ready", data: result.value } : { status: "error", error: result.error });
			}, [dir]);

			const open = useCallback(async (path) => {
				setSelected({ status: "loading", path });
				const result = await call("projectReadFile", path);
				setSelected(
					result.ok
						? { status: "ready", path, content: result.value === null || result.value === undefined ? "" : result.value.content ?? "" }
						: { status: "error", path, error: result.error },
				);
			}, []);

			/** 保存当前打开文件的编辑内容（UTF-8 直写，无备份）。 */
			const save = useCallback(async () => {
				if (selected === null || selected.status !== "ready") return;
				const result = await call("projectWriteFile", selected.path, selected.content);
				if (!result.ok) setSelected(Object.assign({}, selected, { saveError: result.error, saved: undefined }));
				else setSelected(Object.assign({}, selected, { saved: true, saveError: undefined }));
			}, [selected]);

			const rename = useCallback(async (entry) => {
				const next = window.prompt("新名称", entry.name);
				if (next === null || next.trim() === "" || next === entry.name) return;
				const result = await call("projectRenameEntry", entry.path, next.trim());
				if (!result.ok) setState({ status: "error", error: result.error });
				else await refresh();
			}, [refresh]);

			const remove = useCallback(async (entry) => {
				const what = entry.kind === "directory" ? "目录（含其中全部内容）" : "文件";
				if (!window.confirm("删除" + what + " " + entry.name + "？此操作不可撤销。")) return;
				const result = await call("projectDeleteEntry", entry.path);
				if (!result.ok) setState({ status: "error", error: result.error });
				else await refresh();
			}, [refresh]);

			const entries = state.data === undefined || state.data === null ? [] : state.data.entries ?? [];
			const info =
				state.status === "loading"
					? "读取中…"
					: state.status === "ready"
						? entries.length + " 个条目" + (state.data.truncated ? "（已截断到 1000）" : "")
						: null;

			return h(
				"div",
				{ style: gridStyle },
				h(
					"div",
					{ style: rowStyle },
					h(UI.Input, {
						value: dir,
						onChange: (event) => setDir(event.target.value),
						placeholder: "工程目录绝对路径（须落在已注册工作区内）",
					}),
					h(UI.Button, { variant: "primary", onClick: refresh }, "列出"),
				),
				h(Notice, { error: state.status === "error" ? state.error : undefined }, info),
				entries.length > 0
					? h(
							"ul",
							{ style: listStyle },
							entries.map((entry) =>
								h(
									"li",
									{ key: entry.path, style: itemStyle },
									h("span", null, entry.kind === "directory" ? "📁" : "📄"),
									h(
										"span",
										{ style: entry.hidden ? Object.assign({}, wrapStyle, { flex: 1 }, muted) : Object.assign({}, wrapStyle, { flex: 1 }) },
										entry.name,
									),
									entry.kind === "file" ? h(UI.Button, { size: "sm", onClick: () => open(entry.path) }, "查看") : null,
									h(UI.Button, { size: "sm", onClick: () => rename(entry) }, "改名"),
									h(UI.Button, { size: "sm", onClick: () => remove(entry) }, "删除"),
								),
							),
						)
					: null,
				selected === null
					? null
					: h(
							"div",
							{ style: gridStyle },
							h(
								"div",
								{ style: Object.assign({}, rowStyle, wrapStyle) },
								h("strong", { style: { flex: 1 } }, selected.path),
								selected.status === "ready" ? h(UI.Button, { size: "sm", variant: "primary", onClick: save }, "保存") : null,
								selected.saved === true ? h("span", { style: muted }, "已保存") : null,
								h(UI.Button, { size: "sm", onClick: () => setSelected(null) }, "关闭"),
							),
							h(Notice, { error: selected.status === "error" ? selected.error : selected.saveError }, selected.status === "loading" ? "读取中…" : null),
							selected.status === "ready"
								? h("textarea", {
										style: Object.assign({}, preStyle, { width: "100%", minHeight: 240, boxSizing: "border-box", fontFamily: "monospace" }),
										value: selected.content,
										spellCheck: false,
										onChange: (event) => setSelected(Object.assign({}, selected, { content: event.target.value, saved: undefined, saveError: undefined })),
									})
								: null,
						),
			);
		}

		/* -------------------------------------------------- 页签 2：推送状态 */

		function PushTab() {
			const [dir, setDir] = useRememberedPath("dsh-magical-lowcode-project:push-dir");
			const [state, setState] = useState({ status: "idle" });

			const refresh = useCallback(async () => {
				const target = dir.trim();
				if (target === "") return;
				setState({ status: "loading" });
				const result = await call("projectPushStatus", target);
				setState(result.ok ? { status: "ready", data: result.value } : { status: "error", error: result.error });
			}, [dir]);

			const markPushed = useCallback(async (node) => {
				const result = await call(
					"projectMarkPushed",
					dir.trim(),
					node.relPath === undefined ? node.key ?? "" : node.relPath,
					node.scope === undefined ? "page" : node.scope,
					node.target === undefined ? "" : node.target,
				);
				if (!result.ok) setState({ status: "error", error: result.error });
				else await refresh();
			}, [dir, refresh]);

			const reset = useCallback(async () => {
				if (!window.confirm("清空全部推送状态记录？下次扫描会把所有页面/API 视为未推送。")) return;
				const result = await call("projectResetPushState");
				if (!result.ok) setState({ status: "error", error: result.error });
				else await refresh();
			}, [refresh]);

			/** 虚拟项目名（.dsh-project-names.json）只影响显示，不改工程内容。 */
			const setProjectName = useCallback(async () => {
				const data = state.data === undefined || state.data === null ? {} : state.data;
				const fallbackUuid = data.projectUuid === undefined ? "" : data.projectUuid;
				const uuid = window.prompt("项目 UUID（32 位十六进制；默认取工作区 .env 的 PROJECT_UUID）", fallbackUuid);
				if (uuid === null || uuid.trim() === "") return;
				const names = data.projectNames === undefined || data.projectNames === null ? {} : data.projectNames;
				const current = names[uuid.trim()];
				const name = window.prompt("显示用的项目名（清空则删除该条映射）", current === undefined ? "" : current);
				if (name === null) return;
				const result = await call("projectSetProjectName", dir.trim(), uuid.trim(), name.trim());
				if (!result.ok) setState({ status: "error", error: result.error });
				else await refresh();
			}, [dir, refresh, state.data]);

			const nodes = state.data === undefined || state.data === null ? [] : state.data.nodes ?? [];
			let dirty = 0;
			for (const node of nodes) if (node.status === "dirty") dirty += 1;

			let info = null;
			if (state.status === "loading") info = "扫描中…";
			else if (state.status === "ready") {
				info = "共 " + nodes.length + " 项，待推送 " + dirty + " 项";
				if (state.data.projectUuid) info += " · PROJECT_UUID " + state.data.projectUuid;
			}

			return h(
				"div",
				{ style: gridStyle },
				h(
					"div",
					{ style: rowStyle },
					h(UI.Input, { value: dir, onChange: (event) => setDir(event.target.value), placeholder: "工作区绝对路径" }),
					h(UI.Button, { variant: "primary", onClick: refresh }, "扫描"),
					h(UI.Button, { onClick: setProjectName }, "设置项目名"),
					h(UI.Button, { onClick: reset }, "重置记录"),
				),
				h(Notice, { error: state.status === "error" ? state.error : undefined }, info),
				nodes.length > 0
					? h(
							"ul",
							{ style: listStyle },
							nodes.map((node, index) => {
								const rel = node.relPath === undefined ? node.key ?? String(index) : node.relPath;
								const depth = String(rel).split("/").length - 1;
								return h(
									"li",
									{ key: String(rel) + "|" + index, style: Object.assign({}, itemStyle, { paddingLeft: depth * 12 }) },
									h("span", { style: Object.assign({}, wrapStyle, { flex: 1 }) }, node.name === undefined ? String(rel) : node.name),
									node.scope === undefined ? null : h(UI.Tag, null, node.scope),
									node.status === undefined ? null : h(UI.Tag, null, statusText(node.status)),
									node.status === "dirty" ? h(UI.Button, { size: "sm", onClick: () => markPushed(node) }, "标记已推送") : null,
								);
							}),
						)
					: null,
			);
		}

		/* ------------------------------------------------ 页签 3：预览与体检 */

		function PreviewTab() {
			const [dir, setDir] = useRememberedPath("dsh-magical-lowcode-project:preview-dir");
			const [lint, setLint] = useState({ status: "idle" });
			const [preview, setPreview] = useState({ status: "idle" });

			const runLint = useCallback(async () => {
				const target = dir.trim();
				if (target === "") return;
				setLint({ status: "loading" });
				const result = await call("projectLint", target);
				setLint(result.ok ? { status: "ready", data: result.value } : { status: "error", error: result.error });
			}, [dir]);

			const runAssemble = useCallback(async () => {
				const target = dir.trim();
				if (target === "") return;
				setPreview({ status: "loading" });
				const result = await call("projectAssemblePreview", target);
				setPreview(result.ok ? { status: "ready", data: result.value } : { status: "error", error: result.error });
			}, [dir]);

			const issues = lint.data === undefined || lint.data === null ? [] : lint.data.issues ?? [];
			const html = preview.data === undefined || preview.data === null ? "" : preview.data.html ?? "";

			const openInTab = useCallback(() => {
				if (html === "") return;
				const blob = new Blob([html], { type: "text/html" });
				const url = URL.createObjectURL(blob);
				window.open(url, "_blank", "noopener");
				window.setTimeout(() => URL.revokeObjectURL(url), 60000);
			}, [html]);

			let lintInfo = null;
			if (lint.status === "loading") lintInfo = "校验中…";
			else if (lint.status === "ready") lintInfo = "静态规则命中 " + issues.length + " 条";

			let previewInfo = null;
			if (preview.status === "loading") previewInfo = "装配中…";
			else if (preview.status === "ready") {
				previewInfo = "预览就绪";
				if (preview.data.pageUuid) previewInfo += " · page uuid " + preview.data.pageUuid;
			}

			return h(
				"div",
				{ style: gridStyle },
				h(
					"div",
					{ style: rowStyle },
					h(UI.Input, { value: dir, onChange: (event) => setDir(event.target.value), placeholder: "页面目录绝对路径（含 page.json）" }),
					h(UI.Button, { variant: "primary", onClick: runLint }, "推送前体检"),
					h(UI.Button, { onClick: runAssemble }, "装配预览"),
				),
				h(Notice, { error: lint.status === "error" ? lint.error : undefined }, lintInfo),
				issues.length > 0
					? h(
							"ul",
							{ style: listStyle },
							issues.map((issue, index) =>
								h(
									"li",
									{ key: index, style: itemStyle },
									h(UI.Tag, null, issue.level),
									h("span", { style: { whiteSpace: "nowrap" } }, String(issue.file) + (issue.line ? ":" + issue.line : "")),
									h("span", { style: Object.assign({}, wrapStyle, { flex: 1 }) }, issue.message),
								),
							),
						)
					: null,
				h(Notice, { error: preview.status === "error" ? preview.error : undefined }, previewInfo),
				html === ""
					? null
					: h(
							"div",
							{ style: rowStyle },
							h(UI.Button, { variant: "primary", onClick: openInTab }, "在新标签打开预览"),
							h("span", { style: muted }, "装配产物 " + html.length + " 字节（预览页会从 cdn.jsdelivr.net 取 echarts）"),
						),
			);
		}

		/* ------------------------------------------------------ 页签 4：预设包 */

		function PresetTab() {
			const [presetId, setPresetId] = useState("");
			const [state, setState] = useState({ status: "idle" });
			const fileRef = useRef(null);

			const exportPreset = useCallback(async () => {
				const id = presetId.trim();
				if (id === "") return;
				setState({ status: "loading", message: "导出中…" });
				try {
					const response = await fetch("/api/agent-preset.export?agentPreset=" + encodeURIComponent(id), { cache: "no-store" });
					if (!response.ok) throw new Error("HTTP " + response.status + " " + (await response.text()));
					const blob = await response.blob();
					const url = URL.createObjectURL(blob);
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = id + ".dshpreset";
					anchor.click();
					window.setTimeout(() => URL.revokeObjectURL(url), 60000);
					setState({ status: "done", message: "已导出 " + id + ".dshpreset（" + blob.size + " 字节）" });
				} catch (error) {
					setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
				}
			}, [presetId]);

			const importPreset = useCallback(async (event) => {
				const file = event.target.files === null || event.target.files === undefined ? undefined : event.target.files[0];
				if (file === undefined) return;
				setState({ status: "loading", message: "导入 " + file.name + "…" });
				try {
					const body = await file.arrayBuffer();
					const query = presetId.trim() === "" ? "" : "?agentPreset=" + encodeURIComponent(presetId.trim());
					const headers = { "content-type": "application/vnd.dsh.preset+zip" };
					const preview = await fetch("/api/agent-preset.import" + query, { method: "POST", headers, body });
					const payload = await preview.json();
					if (!preview.ok) throw new Error(payload === null || payload === undefined ? "HTTP " + preview.status : payload.error ?? "HTTP " + preview.status);
					if (payload.conflict) throw new Error("已存在同名预设「" + payload.agentPreset + "」，请换一个标识符。");
					if (!window.confirm("导入预设「" + payload.agentPreset + "」（" + payload.fileCount + " 个文件）？")) {
						setState({ status: "idle" });
						return;
					}
					const install = await fetch("/api/agent-preset.import" + (query === "" ? "?" : query + "&") + "install=1", { method: "POST", headers, body });
					const installed = await install.json();
					if (!install.ok) throw new Error(installed === null || installed === undefined ? "HTTP " + install.status : installed.error ?? "HTTP " + install.status);
					setState({ status: "done", message: "已安装预设「" + installed.agentPreset + "」。" });
				} catch (error) {
					setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
				} finally {
					event.target.value = "";
				}
			}, [presetId]);

			return h(
				"div",
				{ style: gridStyle },
				h(
					"div",
					{ style: Object.assign({}, muted, wrapStyle) },
					"预设包走 host 半边的 /api/agent-preset.export 与 /api/agent-preset.import：导出只对自定义（trust = user）预设开放，导入先预览、同名不覆盖。",
				),
				h(
					"div",
					{ style: rowStyle },
					h(UI.Input, {
						value: presetId,
						onChange: (event) => setPresetId(event.target.value),
						placeholder: "预设标识符（小写字母/数字/连字符，留空则用包内 id）",
					}),
					h(UI.Button, { variant: "primary", onClick: exportPreset, disabled: presetId.trim() === "" }, "导出"),
					h(UI.Button, { onClick: () => fileRef.current.click() }, "导入…"),
					h("input", { ref: fileRef, type: "file", accept: ".dshpreset,application/zip", style: { display: "none" }, onChange: importPreset }),
				),
				h(Notice, { error: state.status === "error" ? state.error : undefined }, state.status === "loading" || state.status === "done" ? state.message : null),
			);
		}

		/* ------------------------------------------------------ 页签 5：工程脚本 */

		function ScriptTab() {
			const [dir, setDir] = useRememberedPath("dsh-magical-lowcode-project:script-dir");
			const [script, setScript] = useState("source-page-push.js");
			const [args, setArgs] = useState("");
			const [state, setState] = useState({ status: "idle" });

			const run = useCallback(async () => {
				const cwd = dir.trim();
				const name = script.trim();
				if (cwd === "" || name === "") return;
				const argv = args.trim() === "" ? [] : args.trim().split(/\s+/);
				setState({ status: "loading" });
				const result = await call("projectRunScript", name, argv, cwd);
				setState(result.ok ? { status: "ready", data: result.value } : { status: "error", error: result.error });
			}, [dir, script, args]);

			const data = state.data;
			const isObject = data !== null && data !== undefined && typeof data === "object";
			const output = isObject && typeof data.output === "string" ? data.output : "";

			let info = null;
			if (state.status === "loading") info = "执行中…";
			else if (state.status === "ready" && isObject) {
				info = (data.ok === true ? "成功" : "失败") + "（exit code " + data.code + "）";
				if (typeof data.cmd === "string") info += " · " + data.cmd;
			}

			return h(
				"div",
				{ style: gridStyle },
				h(
					"div",
					{ style: Object.assign({}, muted, wrapStyle) },
					"只允许工作区根目录下的 source-*.js，用宿主自带的 node 执行（shell: false，stdout 超 400000 字符会被中止）。执行前会自动清理上次遗留的 .temp_page_push_* / .temp_api_push_* 目录。",
				),
				h(UI.Input, { value: dir, onChange: (event) => setDir(event.target.value), placeholder: "工作区绝对路径（脚本必须直接位于该目录下）" }),
				h(
					"div",
					{ style: rowStyle },
					h(UI.Input, { value: script, onChange: (event) => setScript(event.target.value), placeholder: "source-xxx.js" }),
					h(UI.Input, { value: args, onChange: (event) => setArgs(event.target.value), placeholder: "参数（空格分隔，可留空）" }),
					h(UI.Button, { variant: "primary", onClick: run }, "运行"),
				),
				h(Notice, { error: state.status === "error" ? state.error : undefined }, info),
				output === "" ? null : h("pre", { style: preStyle }, output),
			);
		}

		/* ---------------------------------------------------------- 面板外壳 */

		const TABS = [
			{ key: "tree", label: "项目树", render: () => h(TreeTab) },
			{ key: "push", label: "推送状态", render: () => h(PushTab) },
			{ key: "preview", label: "预览与体检", render: () => h(PreviewTab) },
			{ key: "script", label: "工程脚本", render: () => h(ScriptTab) },
			{ key: "preset", label: "预设包", render: () => h(PresetTab) },
		];

		function Panel() {
			const [active, setActive] = useState("tree");
			let current = TABS[0];
			for (const tab of TABS) if (tab.key === active) current = tab;
			return h(
				"div",
				{ style: gridStyle },
				h(
					"div",
					{ style: Object.assign({}, rowStyle, { flexWrap: "wrap" }) },
					TABS.map((tab) => h(UI.Pill, { key: tab.key, active: tab.key === active, onClick: () => setActive(tab.key) }, tab.label)),
				),
				current.render(),
			);
		}

		/**
		 * 设置页入口：settings.section 是 list/root slot，ownerProps 是 { close }。
		 * 本插件面板自包含、不接管关闭动作，所以不消费 close。
		 */
		function SettingsSection() {
			return h(Panel);
		}

		/** 侧边栏底部动作：点开同一面板的浮层副本（自包含，不依赖 shell 的导航 API）。 */
		function SidebarAction() {
			const [open, setOpen] = useState(false);
			return h(
				Fragment,
				null,
				h(UI.Button, { size: "icon", title: "低代码工程模式", onClick: () => setOpen(true) }, "▤"),
				h(UI.Modal, { open: open, onClose: () => setOpen(false), title: "低代码工程模式" }, h(Panel)),
			);
		}

		/* ---------------------------------------------------------- 插件入口 */

		/**
		 * cordis 服务注入。只依赖 slots —— RPC 走同源 fetch 信封（见 call），
		 * 不需要 remote 服务，也就不需要构建期生成的 typed contribution。
		 */
		const inject = ["slots"];

		async function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			slots.inject("settings.section", () =>
				slots.register({ name: "settings.section", id: ENTRY_ID, order: 100, label: "低代码工程模式" }, SettingsSection),
			);
			slots.inject("sidebar.footer.action", () =>
				slots.register({ name: "sidebar.footer.action", id: ENTRY_ID, order: 100 }, SidebarAction),
			);
		}

		return { apply: apply, inject: inject };
	},
});
