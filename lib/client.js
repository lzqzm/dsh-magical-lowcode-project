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
 *
 * 工程模式的交互面（对齐上游 DSH Desktop 的工程模式补丁）：
 *   - 项目树是**多级**的：目录点名字展开/收起，展开时才向 host 拉那一层。
 *   - 树的每一行按 host 的 projectPushStatus 内联出「待推送 / 已推送」与 ↑ 推送。
 *   - 下拉与推送都走**确认弹窗**：先把要执行的 node 命令原样亮出来，确认后执行；
 *     下拉成功清空推送状态记录（本地已被线上覆盖），推送成功把该目标标记为已推送。
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

		const React = pickModule(require("react"), ["createElement", "useState", "useCallback", "useEffect", "useRef", "Fragment"]);
		const UI = pickModule(require("@deepseek-ai/dsh-client-ui-primitives"), ["Button", "Input", "Modal", "Pill", "Tag"]);
		const h = React.createElement;
		const { useState, useCallback, useEffect, useRef, Fragment } = React;

		/**
		 * host 半边暴露的 Remote 方法，顺序与 lib/index.js 的 markRemote 循环逐字一致。
		 */
		const METHODS = [
			"listProjectEntries",
			"projectPushStatus",
			"projectRunScript",
			"projectResolveScript",
			"projectSearchEntries",
			"projectMarkPushed",
			"projectResetPushState",
			"projectRenameEntry",
			"projectSetProjectName",
			"projectDeleteEntry",
			"projectReadFile",
			"projectWriteFile",
			"projectOpenExternal",
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
			projectResolveScript: ["script", "cwd"],
			projectSearchEntries: ["dir", "query"],
			projectMarkPushed: ["workspacePath", "relDir", "scope", "target"],
			projectResetPushState: [],
			projectRenameEntry: ["path", "newName"],
			projectSetProjectName: ["workspacePath", "uuid", "name"],
			projectDeleteEntry: ["path"],
			projectReadFile: ["path"],
			projectWriteFile: ["path", "content"],
			projectOpenExternal: ["path"],
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

		/**
		 * 四个页签共用同一个「工程目录」记忆键：目录本来就是同一个概念，
		 * 分开记的话每换一个页签都得重新粘一遍路径。
		 */
		const DIR_KEY = "dsh-magical-lowcode-project:dir";

		/** 受控输入 + localStorage 记忆。 */
		function useRememberedPath(storageKey) {
			const [value, setValue] = useState(() => readStoredPath(storageKey));
			const update = useCallback((next) => {
				setValue(next);
				writeStored(storageKey, next);
			}, [storageKey]);
			return [value, update];
		}

		/** 写记忆（隐私模式、桩环境下静默失败 —— 记忆是锦上添花，不该影响主流程）。 */
		function writeStored(key, value) {
			try {
				window.localStorage.setItem(key, value);
			} catch (error) {
				/* 忽略 */
			}
		}

		/** 读字符串数组记忆（坏数据一律当空数组）。 */
		function readStoredList(key) {
			try {
				const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
				return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
			} catch (error) {
				return [];
			}
		}

		/*
		 * 面板状态的会话级缓存（0.2.15）。三个入口（设置页 / 侧栏浮层 / 会话页签）
		 * 各挂载一套面板，切换入口或页签就是重新挂载 —— 原来的 state 全部丢掉，
		 * 用户看到的就是「之前的树又清空了」。已经拉到手的树先存在这个模块级缓存里，
		 * 挂载时原样恢复、后台再重扫一遍；页签、展开项与选中文件另存 localStorage，
		 * 这样连刷新页面也还在。
		 */
		const DETAIL_KEY = "dsh-magical-lowcode-project:detail";
		const EXPANDED_KEY = "dsh-magical-lowcode-project:expanded";
		const SELECTED_KEY = "dsh-magical-lowcode-project:selected";
		const panelCache = { root: "", children: null, pushIndex: null, pushInfo: null };

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
		/**
		 * 「文件内容」的编辑区样式。**刻意不复用 preStyle**：那是给只读 <pre> 的，带着
		 * maxHeight / overflow / wordBreak，textarea 上全无用处，却会跟着换行与选区的排版一起算。
		 * 另外浏览器在「可手动 resize 的大 textarea」上反复拖选有崩溃记录（用户反馈多选几次整个浏览器会挂），
		 * 所以这里关掉 resize：高度由下面的 height 固定跟窗口走，不靠右下角手柄。
		 */
		const editorStyle = {
			width: "100%",
			minHeight: 240,
			height: "min(62vh, 760px)",
			maxHeight: "none",
			resize: "none",
			boxSizing: "border-box",
			fontFamily: "monospace",
			fontSize: 12,
			lineHeight: 1.55,
			padding: 8,
			borderRadius: 6,
			border: "1px solid rgba(127,127,127,0.22)",
			background: "rgba(127,127,127,0.08)",
			whiteSpace: "pre-wrap",
			overflowWrap: "break-word",
		};
		/**
		 * 编辑控件一次最多装多少行（0.2.21）。**这就是 0.2.21 修复的核心。**
		 *
		 * Blink 154 的拖选死锁（issues.chromium.org/issues/568602800）只在「大编辑区 +
		 * 长距离拖选」这条路上复现，而 0.2.20 的「编辑」是把**整份文件**塞进一个
		 * textarea：用户的 index.html 有 90399 字符，编辑区里于是躺着一个 9 万字符的原生
		 * 选区，一拖就死。现在换掉这条路：任何编辑控件都只装一页，要改一段（或整份）就按
		 * EDITOR_PAGE_LINES 行切页，一页一页改。文件再大，编辑区里的量级也不变。
		 */
		const EDITOR_PAGE_LINES = 120;
		/**
		 * 0.2.23：页大小可调（[120, 300, 1000, 整份]）。用户嫌「一页 120 行」翻着累，
		 * 而分页本身只是为了**别让一个编辑控件一次装下整份文件** —— 页越大越省事，
		 * 也越接近那条会把渲染进程拖死的路（大 textarea + 长距离拖选）。所以给出档位，
		 * 默认仍然 120，把风险与省事的取舍交回用户手里；选「整份」时对话框里会明确警告。
		 */
		const EDITOR_PAGE_SIZES = [120, 300, 1000];
		/**
		 * 「查看」态（默认态）的只读区：0.2.19 起点开文件先进这里，点「编辑」才换成 textarea。
		 * Blink 在「大编辑区上反复拖选」这条路上有死锁记录（Chromium 154 的
		 * Blink>Editing>Selection，issues.chromium.org/issues/568602800 —— 用户的 Edge 正好是
		 * 154.0.8037.98，与该单的 154.0.8037.97 同一条构建），只读 <pre> 不进编辑控件那条排版/选区
		 * 路径。高度与编辑态一致，不许再缩回一条缝。
		 *
		 * 0.2.20 起 userSelect 是 none：只读区**不再产生原生选区**。拖选死锁与 Edge 的划词
		 * 迷你菜单都挂在原生选区上；关掉它，用户改用下面插件自己的行级选择 —— 照样能选，
		 * 但那条路走不到了。
		 */
		const viewerStyle = Object.assign({}, editorStyle, {
			display: "block",
			margin: 0,
			overflow: "auto",
			whiteSpace: "pre-wrap",
			wordBreak: "break-word",
			userSelect: "none",
		});
		/**
		 * textarea 上再钉一层「别让第三方扩展插进来」：Grammarly 一类的划词/拼写扩展会往大
		 * textarea 上挂浮层与 selectionchange 监听，是拖选卡死的常见帮凶；Edge/Chrome 自带的
		 * 拼写与自动更正也一并关掉，少一条后台计算的路径。
		 */
		const EDITOR_ATTRS = {
			spellCheck: false,
			autoCorrect: "off",
			autoCapitalize: "off",
			autoComplete: "off",
			"data-gramm": "false",
			"data-gramm_editor": "false",
			"data-enable-grammarly": "false",
		};
		/**
		 * 「查看」态的行级选择（0.2.20）。
		 *
		 * 用户要的是「能选中文本，再让 DSH 里的 AI 帮我改」。原生选区正是崩溃的那条路
		 * （见 viewerStyle 的 userSelect: none），于是选区由插件自己算：内容按行切成
		 * 一行一个 <div>（前面挂行号），点一行定起点、拖过或 Shift+点另一行定终点，高亮
		 * 选中的行，再把这几行拼回文本 —— 「复制选中」走剪贴板，「发给 AI 改」额外带上
		 * 绝对路径与行号范围。上游能把文本直接塞进对话输入框的是它补丁里的私有函数
		 * （dshPmInjectComposer），客户端插件拿不到，所以退化成「复制上下文，粘进对话即可」。
		 */
		const VIEW_LINE_LIMIT = 3000;
		const viewRowStyle = { display: "flex", alignItems: "flex-start", padding: "0 2px", borderRadius: 3 };
		const viewGutterStyle = {
			flex: "0 0 auto",
			width: 44,
			textAlign: "right",
			paddingRight: 10,
			opacity: 0.4,
			userSelect: "none",
			fontVariantNumeric: "tabular-nums",
		};
		const viewTextStyle = { flex: "1 1 auto", minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "break-word" };
		const gridStyle = { display: "flex", flexDirection: "column", gap: 10 };
		/** 项目树一次渲染的行数上限（预算在 renderLevel 里逐层扣减）。 */
		const RENDER_LIMIT = 600;
		/** 用文字前缀表达状态，避免依赖未证实的 Tag tone 取值。 */
		const statusText = (status) => (status === "pushed" ? "✔ 已推送" : status === "dirty" ? "● 待推送" : String(status ?? ""));
		/** 状态 Tag：待推送（dirty）标红，其余保持基元原样。 */
		const statusTag = (status) =>
			status === "dirty" ? h("span", { className: "dshml-dirty" }, h(UI.Tag, null, statusText(status))) : h(UI.Tag, null, statusText(status));

		/**
		 * 工程浏览器样式。插件注册不了全局样式表，但 React 允许直接渲染 <style> 元素，
		 * 于是把浏览器需要的类名一次写进面板（三个入口共用同一份文本）。
		 *
		 * 两条关键规则：行内操作按钮默认隐藏，只在鼠标悬停或该行被选中时出现
		 * （.dshml-acts），这样树才像文件浏览器而不是一排按钮墙；缩进靠 padding 层叠。
		 */
		const BROWSER_CSS = [
			".dshml-browser{display:flex;flex-direction:column;gap:8px;width:100%;box-sizing:border-box}",
			".dshml-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
			/*
			 * 横向行里的「输入框吃满剩余宽度」。flex-basis 必须是 auto：写成 480px 时，
			 * 它在纵向容器（gridStyle 那一类）里会被当成高度基准，把整行撑到 480px 高
			 * —— 环境配置弹窗里标签与输入框被拉开的那个排版问题就是这么来的。
			 */
			".dshml-grow{flex:1 1 auto;min-width:220px;display:flex;align-items:center}",
			".dshml-grow > *{flex:1 1 auto;min-width:0;width:100%}",
			".dshml-grow input{width:100% !important;max-width:none !important;box-sizing:border-box}",
			/* 纵向字段：一行说明 + 一行输入框，两者贴近成组。 */
			".dshml-field{display:flex;flex-direction:column;gap:6px;min-width:0}",
			".dshml-field input{width:100% !important;max-width:none !important;box-sizing:border-box}",
			".dshml-body{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}",
			".dshml-tree{flex:0 0 auto;width:min(330px,40%);min-width:230px;max-height:min(80vh,900px);overflow:auto;border:1px solid rgba(127,127,127,0.22);border-radius:8px;padding:4px 6px;background:rgba(127,127,127,0.04)}",
			".dshml-detail{flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:8px}",
			".dshml-subs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;border-bottom:1px solid rgba(127,127,127,0.16);padding-bottom:6px}",
			".dshml-pane{border:1px solid rgba(127,127,127,0.18);border-radius:8px;padding:8px 10px;min-height:180px;max-height:min(82vh,1000px);overflow:auto}",
			".dshml-browser input{width:100% !important;max-width:none !important;box-sizing:border-box}",
			".dshml-browser *:has(> input){width:100% !important;max-width:none !important;min-width:0;box-sizing:border-box}",
			".dshml-rows{list-style:none;margin:0;padding:0}",
			/* 模糊查找条：输入框吃满，右边一个「清空」。 */
			".dshml-find{display:flex;gap:6px;align-items:center;padding:2px 0 6px;position:sticky;top:0;background:inherit;z-index:1}",
			/* 查找结果里的相对路径：右对齐、超出省略，别把名字挤掉。 */
			".dshml-hitpath{font-size:11px;opacity:0.65;margin-left:auto;max-width:58%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dshml-row{display:flex;align-items:center;gap:6px;padding:1px 4px;border-radius:5px}",
			".dshml-row:hover{background:rgba(127,127,127,0.14)}",
			".dshml-row[data-selected='1']{background:rgba(80,140,255,0.18)}",
			".dshml-acts{display:none;gap:4px;align-items:center}",
			".dshml-row:hover .dshml-acts,.dshml-row[data-selected='1'] .dshml-acts{display:flex}",
			/*
			 * 「● 待推送」标红。Tag 是别人的基元、颜色由它内部决定，所以外面套一层 span，
			 * 再用 inherit 把内部文字色与边框色一起拉回来（不依赖 Tag 是否接受 style/className）。
			 */
			".dshml-dirty{color:#e5484d}",
			".dshml-dirty *{color:inherit !important;border-color:currentColor !important}",
			".dshml-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dshml-dir{cursor:pointer}",
			".dshml-hint{font-size:12px;opacity:0.72}",
			/*
			 * 行级选择（0.2.20）：原生选区已关，这里的 [data-sel='1'] 就是唯一的「选中」。
			 * 鼠标停在哪一行哪一行淡亮，选中的行整行压蓝；行号槽固定宽度、等宽数字。
			 */
			".dshml-view{cursor:text}",
			".dshml-view .dshml-line:hover{background:rgba(127,127,127,0.10)}",
			".dshml-line[data-sel='1']{background:rgba(80,140,255,0.22)}",
			".dshml-gutter{font-size:11px;font-family:monospace}",
			".dshml-selbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
			/* 行内编辑（0.2.23）：双击一行后就地出现的单行输入框。 */
			".dshml-lineinput{background:rgba(127,127,127,0.12);border:1px solid rgba(80,140,255,0.65);border-radius:3px;padding:0 2px;font:inherit;color:inherit}",
			".dshml-path{flex:1 1 auto;min-width:0;font-size:12px;font-weight:600;line-height:1.45;word-break:break-all;opacity:0.92}",
			".dshml-align{flex:0 0 auto;display:flex;align-items:center;gap:6px}",
			".dshml-wide{width:min(1180px,94vw)}",
		].join("\n");
		/** 右侧详情区的子页签（左侧工程树常驻，不再整页切换）。 */
		const DETAIL_TABS = [
			{ key: "content", label: "tab.content" },
			{ key: "preview", label: "tab.preview" },
			{ key: "push", label: "tab.push" },
			{ key: "script", label: "tab.script" },
			{ key: "preset", label: "tab.preset" },
		];

		/* ------------------------------------------------------------------ i18n */

		/**
		 * 界面文案的命名空间与字典。**默认走内置中文**：两个桩检都没有 locale 服务，
		 * 只有默认值能让它们继续断言中文文案；apply 里若宿主提供了 locale 服务，
		 * 再把 T 换成宿主绑定（见 apply）。
		 */
		const NS = PACKAGE_NAME;
		const MESSAGES = {
			zh: {
				"entry.title": "低代码工程模式",
				"view.project": "低代码工程",
				"tab.content": "文件内容",
				"tab.preview": "体检与预览",
				"tab.push": "推送状态",
				"tab.script": "工程脚本",
				"tab.preset": "预设包",
				"mode.on": "工程模式：开",
				"mode.off": "工程模式：关",
				"mode.hint.on": "会话里已出现「低代码工程」页签，点左侧按钮可以收起来。",
				"mode.hint.off": "会话里不显示工程页签；面板仍可从设置页与侧栏打开。",
			},
			en: {
				"entry.title": "Low-code project mode",
				"view.project": "Low-code project",
				"tab.content": "File content",
				"tab.preview": "Lint & preview",
				"tab.push": "Push status",
				"tab.script": "Project scripts",
				"tab.preset": "Preset package",
				"mode.on": "Project mode: on",
				"mode.off": "Project mode: off",
				"mode.hint.on": "A “Low-code project” tab is shown in sessions; click the button to hide it.",
				"mode.hint.off": "No project tab in sessions; the panel stays available from Settings and the sidebar.",
			},
		};
		/**
		 * 当前翻译函数。组件里必须调用 T(...)（而不是把 T 解构进局部变量），
		 * apply 换绑之后所有已注册的 label 与后续渲染才会跟着换语言。
		 */
		let T = (key) => (Object.prototype.hasOwnProperty.call(MESSAGES.zh, key) ? MESSAGES.zh[key] : key);

		/* -------------------------------------------------------- 工程模式开关 */

		/**
		 * 工程模式：控制「会话里要不要出现低代码工程页签」（conversation.view）。
		 * 状态存 localStorage；变化通过 document 事件广播给同一页面的多个实例，
		 * 并靠 storage 事件跟随多标签页。默认**开启** —— 装了插件就是想用工程模式。
		 */
		const MODE_KEY = "dsh-magical-lowcode-project:project-mode";
		const MODE_EVENT = "dsh-magical-lowcode-project:project-mode-changed";

		function readProjectMode() {
			try {
				return window.localStorage.getItem(MODE_KEY) !== "off";
			} catch (error) {
				/* 没有 localStorage（桩环境、隐私模式）：按默认开启处理 */
				return true;
			}
		}

		/**
		 * 订阅模式变化，返回取消订阅函数。桩环境里既没有 document 也没有
		 * window.addEventListener，所以两处都要先探再挂。
		 */
		function subscribeProjectMode(handler) {
			const hasDocument = typeof document !== "undefined" && document !== null && typeof document.addEventListener === "function";
			const hasWindow = typeof window !== "undefined" && window !== null && typeof window.addEventListener === "function";
			if (hasDocument) document.addEventListener(MODE_EVENT, handler);
			if (hasWindow) window.addEventListener("storage", handler);
			return () => {
				if (hasDocument) document.removeEventListener(MODE_EVENT, handler);
				if (hasWindow) window.removeEventListener("storage", handler);
			};
		}

		function writeProjectMode(enabled) {
			try {
				window.localStorage.setItem(MODE_KEY, enabled ? "on" : "off");
			} catch (error) {
				/* 隐私模式下写不进去，忽略 */
			}
			const hasDocument = typeof document !== "undefined" && document !== null && typeof document.dispatchEvent === "function";
			if (!hasDocument) return;
			try {
				document.dispatchEvent(new Event(MODE_EVENT));
			} catch (error) {
				/* 老浏览器没有 Event 构造器：退化成「只写不广播」 */
			}
		}

		/** 面板与侧栏共用的开关状态：返回 [是否开启, 切换函数]。 */
		function useProjectMode() {
			const [enabled, setEnabled] = useState(readProjectMode);
			useEffect(() => subscribeProjectMode(() => setEnabled(readProjectMode())), []);
			const toggle = useCallback(() => writeProjectMode(!readProjectMode()), []);
			return [enabled, toggle];
		}

		/** 工程模式开关按钮 + 一行动态说明（放在面板顶部）。 */
		function ProjectModeRow() {
			const [enabled, toggle] = useProjectMode();
			return h(
				"div",
				{ style: Object.assign({}, rowStyle, { flexWrap: "wrap" }) },
				h(UI.Button, { variant: "ghost", size: "sm", onClick: toggle }, enabled ? T("mode.on") : T("mode.off")),
				h("span", { style: muted }, enabled ? T("mode.hint.on") : T("mode.hint.off")),
			);
		}
		const warnStyle = { color: "var(--dsh-danger, #d33)" };
		/** 推送目标的 scope → 中文标签。 */
		const SCOPE_LABEL = { page: "页面", api: "API", db: "数据库", databases: "数据库" };

		/*
		 * 右键菜单样式。插件不能注册 <style>，也没有 portal 可用的 require，
		 * 所以菜单用 position: fixed 直接画在树容器里（fixed 不受父级布局影响），
		 * 坐标用鼠标位置并夹在视口内。
		 */
		const menuPanelStyle = {
			position: "fixed",
			zIndex: 9999,
			minWidth: 200,
			maxWidth: 260,
			padding: 4,
			display: "flex",
			flexDirection: "column",
			gap: 1,
			borderRadius: 8,
			border: "1px solid rgba(127,127,127,0.28)",
			background: "var(--dsh-surface, #ffffff)",
			boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
		};
		const menuTitleStyle = {
			padding: "4px 10px 6px",
			fontSize: 12,
			...muted,
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis",
		};
		const menuItemStyle = { padding: "5px 10px", borderRadius: 6, fontSize: 13, whiteSpace: "nowrap", userSelect: "none" };
		const menuDisabledStyle = { opacity: 0.45, cursor: "default" };
		const menuSepStyle = { height: 1, margin: "4px 6px", background: "rgba(127,127,127,0.25)" };

		function Notice({ error, children }) {
			if (error !== undefined && error !== null) {
				return h("div", { style: Object.assign({}, wrapStyle, warnStyle) }, "✗ " + error);
			}
			if (children === undefined || children === null || children === false) return null;
			return h("div", { style: muted }, children);
		}

		/** 校验结果列表：项目树的右键「校验」与预览页签共用同一份渲染。 */
		function LintIssues({ issues }) {
			if (issues.length === 0) return null;
			return h(
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
			);
		}

		/*
		 * 校验结果不再走弹窗：右键「推送前校验」的结果直接渲染在右栏「体检与预览」
		 * 页签里（见 TreeTab 的 lintReport → PreviewTab 的 report），所以这里只留
		 * LintIssues 这一个纯展示组件。
		 */

		/**
		 * 面板级错误边界。渲染期抛出的异常会让 React 卸载整棵子树 —— 使用者看到的
		 * 就是「点一下整个面板变白」，既没有报错也没有线索。把子树包在这里之后，
		 * 异常会变成一行可读的文字（含错误原文），并提示重启恢复。
		 *
		 * 只兜渲染期异常；事件处理器里的异常不经过这里（那些已经被折成提示）。
		 */
		class PaneBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}

			static getDerivedStateFromError(error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}

			render() {
				if (this.state.error !== null) {
					return h(
						"div",
						{ style: Object.assign({}, warnStyle, { padding: "8px 10px" }) },
						"✗ 面板渲染出错：" + this.state.error,
						h("div", { style: muted }, "把这一行原文反馈给插件作者即可定位；重启 DSH 可先恢复。"),
					);
				}
				return this.props.children;
			}
		}

		/** 环境配置对话框的默认字段：工程目录 .env 的两个键（对齐上游 ProjectEnvDialog）。 */
		const DEFAULT_ENV_FIELDS = [
			{ key: "SERVER_URL", label: "SERVER_URL —— 线上平台地址（推送/下拉脚本读它）", placeholder: "https://example.com" },
			{ key: "PROJECT_UUID", label: "PROJECT_UUID —— 当前工程的项目 ID（32 位十六进制）", placeholder: "0123456789abcdef0123456789abcdef" },
		];

		/** 脚本目录 .env 要维护的键：脚本自己的 utils.loadEnv() 读的就是这一份（0.2.14 起运行前先预检）。 */
		const SCRIPT_ENV_FIELDS = [
			{ key: "SERVER_URL", label: "SERVER_URL —— 线上平台地址（推送/下拉脚本读它）", placeholder: "https://example.com" },
			{ key: "USERNAME", label: "USERNAME —— 平台登录账号", placeholder: "admin" },
			{ key: "PASSWORD", label: "PASSWORD —— 平台登录密码", placeholder: "••••••" },
			{ key: "PROJECT_UUID", label: "PROJECT_UUID —— 目标工程的项目 ID（32 位十六进制，脚本用它定位工程子目录）", placeholder: "0123456789abcdef0123456789abcdef" },
		];

		/**
		 * .env 配置对话框（对齐上游 DSH Desktop 的 ProjectEnvDialog）。
		 *
		 * `state.values` 是 { 键: 值 } 字典，`fields` 决定编辑哪几个键 —— 工程目录那份
		 * （默认两键）与脚本目录那份（SCRIPT_ENV_FIELDS，四键）共用这一个组件。
		 * 写入时命中同名行就替换那一行、否则追加，其它行原样保留（见 envUpsert）。
		 */
		function EnvDialog({ state, onChange, onSave, onClose, fields }) {
			if (state === null) return null;
			const ready = state.status === "ready";
			const values = state.values ?? {};
			const list = Array.isArray(fields) && fields.length > 0 ? fields : DEFAULT_ENV_FIELDS;
			const info =
				state.status === "loading"
					? "读取 " + state.path + " …"
					: state.status === "ready"
						? "将写入 " + state.path
						: null;
			return h(
				UI.Modal,
				{ open: true, onClose: onClose, title: "环境配置 · .env" },
				h(
					"div",
					{ style: gridStyle },
					h(Notice, { error: state.status === "error" ? state.error : undefined }, info),
					state.missing === true ? h("div", { style: muted }, "本地没有这个 .env（保存会新建一个）。") : null,
					list.map((field) =>
						h(
							"div",
							{ className: "dshml-field", key: field.key },
							h("label", { style: muted }, field.label),
							h(UI.Input, {
								value: values[field.key] ?? "",
								disabled: ready === false,
								placeholder: field.placeholder,
								onChange: (event) => onChange(field.key, event.target.value),
							}),
						),
					),
					h("div", { style: muted }, "只改上面这几个键；.env 里的注释、未列出的键原样保留。"),
					h(
						"div",
						{ style: rowStyle },
						h(
							UI.Button,
							{ variant: "primary", disabled: ready === false || state.saving === true, onClick: onSave },
							state.saving === true ? "保存中…" : "保存",
						),
						h(UI.Button, { onClick: onClose }, "关闭"),
						state.saved === true ? h("span", { style: muted }, "已保存") : null,
					),
					state.saveError === undefined ? null : h(Notice, { error: state.saveError }),
				),
			);
		}

		/**
		 * 行范围编辑器（0.2.20 的「改这段」，0.2.21 起兼作「编辑」，0.2.23 起页大小可调）。
		 *
		 * 关键在「分页」：选中的行（或整份文件）按页大小切成若干页，一次只把 **一页** 放进
		 * textarea。于是文件再大，编辑控件里也只有一页文本 —— 「大 textarea + 长距离拖选」
		 * 那条会把渲染进程拖死的路，就再也走不到了。0.2.23 把页大小做成可选（120/300/1000/
		 * 整份）：分页只是保险，不是目的，省事与风险交给用户自己权衡 —— 选「整份」时会写明
		 * 「别在里面长距离拖选」。
		 */
		function PatchDialog({ state, path, onChange, onPage, onPageSize, onSave, onCopy, onOpenExternal, onClose }) {
			if (state === null) return null;
			const count = state.to - state.from + 1;
			const pages = state.drafts.length;
			const page = Math.max(0, Math.min(state.page, pages - 1));
			const size = state.pageSize === undefined ? EDITOR_PAGE_LINES : state.pageSize;
			const pageLines = size > 0 ? size : Math.max(1, count);
			const pageFrom = state.from + page * pageLines;
			const pageTo = Math.min(state.to, pageFrom + pageLines - 1);
			const draftLines = String(state.drafts[page]).split("\n").length;
			/* 整份文件（点「编辑」）与「改这段」是同一个编辑器，只是范围不同 —— 文案上分开说。 */
			const whole = state.from === 0 && state.total === state.to + 1;
			const title =
				(whole ? "编辑整份 · 共 " + state.total + " 行" : "改这段 · 第 " + (state.from + 1) + "–" + (state.to + 1) + " 行") +
				(pages > 1 ? "（分页）" : "");
			return h(
				UI.Modal,
				{ open: true, onClose: onClose, title: title, className: "dshml-editor" },
				h(
					"div",
					{ style: gridStyle },
					/* UI.Modal 的元素自带固定宽度，className 落到对话框本身，用 <style> 改成近全屏。 */
					h("style", null, ".dshml-editor{width:min(94vw,1200px)}"),
					h("div", { className: "dshml-path" }, path),
					h(
						"div",
						{ className: "dshml-hint" },
						(whole ? "整份文件（共 " + count + " 行）" : "这里只有第 " + (state.from + 1) + "–" + (state.to + 1) + " 行（共 " + count + " 行）") +
							"。" +
							(size > 0
								? "当前每页 " + size + " 行（一次只把一页放进编辑框）：分页是保险 —— 大编辑区 + 长距离拖选会把窗口拖死。"
								: "当前是整份一页：文件再大也全在这一个编辑框里，**别在里面长距离拖选**（那就是会把窗口拖死的那条路），要选就用点击 / 方向键 / Shift+方向键。") +
							(whole ? "保存时写回原文件（无备份）。" : "点「替换这 " + count + " 行」只改这一段，文件其余部分逐字保留。") +
							" 只改一两行的话，关掉这个框、在内容里双击那一行更快。",
					),
					h(
						"div",
						{ style: rowStyle },
						h("span", { className: "dshml-hint" }, "每页行数："),
						EDITOR_PAGE_SIZES.map((option) =>
							h(
								UI.Button,
								{ key: option, size: "sm", variant: size === option ? "primary" : "default", onClick: () => onPageSize(option) },
								option + " 行",
							),
						),
						h(
							UI.Button,
							{ size: "sm", variant: size <= 0 ? "primary" : "default", onClick: () => onPageSize(0) },
							"整份",
						),
					),
					pages > 1
						? h(
								"div",
								{ style: rowStyle },
								h(UI.Button, { size: "sm", disabled: page <= 0, onClick: () => onPage(page - 1) }, "上一页"),
								h("span", { className: "dshml-hint" }, "第 " + (page + 1) + "/" + pages + " 页 · 这一页是第 " + (pageFrom + 1) + "–" + (pageTo + 1) + " 行"),
								h(UI.Button, { size: "sm", disabled: page >= pages - 1, onClick: () => onPage(page + 1) }, "下一页"),
							)
						: null,
					h(
						"textarea",
						Object.assign(
							{
								style: Object.assign({}, editorStyle, { height: "min(76vh, 820px)" }),
								value: state.drafts[page],
								onChange: (event) => onChange(event.target.value),
							},
							EDITOR_ATTRS,
						),
					),
					h(
						"div",
						{ style: rowStyle },
						h(UI.Button, { variant: "primary", disabled: state.saving === true, onClick: onSave }, state.saving === true ? "写入中…" : "替换这 " + count + " 行"),
						h(UI.Button, { onClick: onCopy }, "复制给 AI 改"),
						h(UI.Button, { onClick: onOpenExternal }, "用编辑器打开"),
						h(UI.Button, { onClick: onClose }, "取消"),
						h("span", { style: muted }, "这一页 " + draftLines + " 行"),
					),
					state.error === undefined ? null : h(Notice, { error: state.error }),
				),
			);
		}

		/**
		 * 右键菜单（对齐上游 DSH Desktop 的 ProjectContextMenu）。
		 *
		 * 上游把菜单 portal 到 body；客户端插件没有 createPortal 可 require，
		 * 所以用 position: fixed 就地渲染 —— 视觉与交互等价：
		 * 点菜单外任何地方（mousedown 捕获）、按 Escape、窗口失焦或改变尺寸都会关闭。
		 */
		function ContextMenu({ menu, onClose }) {
			const ref = useRef(null);
			useEffect(() => {
				if (menu === null) return undefined;
				const onPointerDown = (event) => {
					const node = ref.current;
					if (node !== null && node !== undefined && typeof node.contains === "function" && node.contains(event.target) === true) return;
					onClose();
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("mousedown", onPointerDown, true);
				window.addEventListener("keydown", onKeyDown, true);
				window.addEventListener("blur", onClose, true);
				window.addEventListener("resize", onClose, true);
				return () => {
					window.removeEventListener("mousedown", onPointerDown, true);
					window.removeEventListener("keydown", onKeyDown, true);
					window.removeEventListener("blur", onClose, true);
					window.removeEventListener("resize", onClose, true);
				};
			}, [menu, onClose]);

			if (menu === null) return null;
			const width = 240;
			const height = 36 + menu.items.length * 27;
			const left = Math.max(4, Math.min(menu.x, (window.innerWidth || 1024) - width - 8));
			const top = Math.max(4, Math.min(menu.y, (window.innerHeight || 768) - height - 8));
			const rows = [];
			menu.items.forEach((item, index) => {
				if (item.separator === true) {
					rows.push(h("div", { key: "sep-" + index, style: menuSepStyle }));
					return;
				}
				const disabled = item.disabled === true;
				rows.push(
					h(
						"div",
						{
							key: item.id === undefined ? "item-" + index : item.id,
							role: "menuitem",
							title: item.title,
							style: Object.assign(
								{},
								menuItemStyle,
								item.danger === true ? warnStyle : null,
								disabled ? menuDisabledStyle : { cursor: "pointer" },
							),
							onClick:
								disabled === true
									? undefined
									: () => {
											onClose();
											if (typeof item.onSelect === "function") item.onSelect();
										},
						},
						item.label,
					),
				);
			});

			return h(
				"div",
				{ ref: ref, role: "menu", style: Object.assign({}, menuPanelStyle, { left: left, top: top }) },
				menu.title === undefined || menu.title === null || menu.title === "" ? null : h("div", { style: menuTitleStyle }, menu.title),
				rows,
			);
		}

		/* --------------------------------------------- 路径工具与脚本工作流闭环 */

		/**
		 * Windows 下 host 返回的路径与 UI 拼出来的路径可能大小写/分隔符不一致，
		 * 直接比较会失配（推送状态匹配不到任何行）。统一成反斜杠、去尾、小写。
		 */
		function normPath(value) {
			return String(value).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
		}

		/** 取父目录（用于改名/删除后只重载那一层）。 */
		function parentOf(value) {
			const text = String(value);
			const index = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
			return index <= 0 ? text : text.slice(0, index);
		}

		/**
		 * 工作区根之下的相对路径（正斜杠）；不在根之下时返回 null。
		 * 对齐上游右键菜单的「复制相对路径」。
		 */
		function relUnder(rootPath, target) {
			const rootParts = normPath(rootPath).split("\\");
			const targetParts = normPath(target).split("\\");
			if (targetParts.length <= rootParts.length) return null;
			for (let index = 0; index < rootParts.length; index += 1) {
				if (rootParts[index] !== targetParts[index]) return null;
			}
			return targetParts.slice(rootParts.length).join("/");
		}

		/**
		 * 从 .env 文本里取某个键的值（支持 `export KEY=`、引号包裹、行尾注释不管）。
		 * 找不到返回空串 —— 对齐上游 dshPmEnvValue。
		 */
		function envValue(text, key) {
			const pattern = new RegExp("^[ \\t]*(?:export[ \\t]+)?" + key + "[ \\t]*=[ \\t]*(.*)$", "m");
			const match = String(text).match(pattern);
			if (match === null) return "";
			let value = match[1].trim();
			if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
				value = value.slice(1, -1);
			}
			return value;
		}

		/**
		 * 把某个键写回 .env 文本：命中同名行（含 `export KEY=`）就只替换那一行，
		 * 否则追加到末尾；其它行（注释、账号密码等）原样保留 —— 对齐上游 dshPmEnvUpsert。
		 * 值里有空白或 `#` 时加双引号，避免被当成行尾注释。
		 * 替换时保留原来的缩进与 `export ` 前缀，不改动用户的既有写法。
		 */
		function envUpsert(text, key, value) {
			const raw = String(text);
			const lines = raw === "" ? [] : raw.split(/\r?\n/);
			const serialized = /[\s#]/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value;
			const pattern = new RegExp("^([ \\t]*(?:export[ \\t]+)?" + key + ")[ \\t]*=");
			let replaced = false;
			const next = lines.map((line) => {
				const match = replaced === false ? line.match(pattern) : null;
				if (match !== null) {
					replaced = true;
					return match[1] + "=" + serialized;
				}
				return line;
			});
			// 先清掉尾部空行再按需追加，否则会在既有内容和新键之间留下一排空行。
			while (next.length > 0 && next[next.length - 1].trim() === "") next.pop();
			if (replaced === false) next.push(key + "=" + serialized);
			return next.join("\n") + "\n";
		}

		/** 取一批键的值（缺失的键也给空串，保证受控输入框有初值）。 */
		function envValues(text, keys) {
			const values = {};
			for (const key of keys) values[key] = envValue(text, key);
			return values;
		}

		/** 把 { 键: 值 } 里的每个键 upsert 进 .env 文本（空值会把该键写成空）。 */
		function upsertEnvValues(text, values) {
			let next = text;
			for (const key of Object.keys(values)) next = envUpsert(next, key, String(values[key] ?? "").trim());
			return next;
		}

		/** 脚本名 → 工作流种类：下拉/克隆要清推送记录，推送要标记已推送。 */
		function kindOfScript(name) {
			const text = String(name);
			if (text.includes("pull") || text.includes("clone")) return "pull";
			if (text.includes("push")) return "push";
			return "none";
		}

		/**
		 * 下拉 / 推送脚本的统一执行器：先弹确认（把要执行的 node 命令原样亮出来），
		 * 再调 host 的 projectRunScript；成功后按 kind 收尾 ——
		 * pull 清空推送状态记录（本地已被线上覆盖），push 把该目标标记为已推送。
		 * 这是上游 DSH Desktop 的 requestScript / requestPush / runPending 闭环。
		 */
		function useScriptRunner() {
			const [pending, setPending] = useState(null);
			const [busy, setBusy] = useState(false);
			const [result, setResult] = useState(null);

			const request = useCallback((next) => {
				const argv = (next.args ?? []).filter((item) => item !== "" && item !== undefined && item !== null);
				const cmd = "node " + next.script + (argv.length > 0 ? " " + argv.join(" ") : "");
				setResult(null);
				setPending(Object.assign({}, next, { args: argv, cmd: cmd }));
			}, []);

			const cancel = useCallback(() => {
				setPending(null);
				setBusy(false);
			}, []);

			const confirm = useCallback(async () => {
				if (pending === null) return;
				setBusy(true);
				const run = await call("projectRunScript", pending.script, pending.args, pending.cwd);
				if (!run.ok) {
					setBusy(false);
					setPending(null);
					setResult({ ok: false, name: pending.name, cmd: pending.cmd, error: run.error });
					return;
				}
				const data = run.value !== null && typeof run.value === "object" ? run.value : {};
				if (data.ok !== true) {
					setBusy(false);
					setPending(null);
					setResult({
						ok: false,
						name: pending.name,
						cmd: pending.cmd,
						output: typeof data.output === "string" ? data.output : "",
						error: "退出码 " + String(data.code) + "（输出见下）",
					});
					return;
				}
				if (pending.kind === "pull") await call("projectResetPushState");
				if (pending.kind === "push" && pending.after !== undefined && pending.after !== null) {
					const after = pending.after;
					await call("projectMarkPushed", after.workspacePath, after.relDir, after.scope, after.target);
				}
				setBusy(false);
				setPending(null);
				setResult({
					ok: true,
					name: pending.name,
					cmd: typeof data.cmd === "string" ? data.cmd : pending.cmd,
					output: typeof data.output === "string" ? data.output : "",
				});
				if (typeof pending.onDone === "function") pending.onDone();
			}, [pending]);

			const clear = useCallback(() => setResult(null), []);

			return { pending: pending, busy: busy, result: result, request: request, cancel: cancel, confirm: confirm, clear: clear };
		}

		/** 确认弹窗与执行结果共用同一个 Modal，避免同时叠两层。 */
		function ScriptDialog({ runner }) {
			if (runner.pending !== null) {
				const pending = runner.pending;
				return h(
					UI.Modal,
					{ open: true, onClose: runner.cancel, title: "操作确认 · " + pending.name },
					h(
						"div",
						{ style: gridStyle },
						h("div", null, "将执行以下指令："),
						h("pre", { style: preStyle }, "$ " + pending.cmd),
						pending.kind === "pull"
							? h("div", { style: warnStyle }, "⚠ 这是下拉/克隆操作，会从线上拉取并覆盖本地文件（page-pull 会删除并重建本地页面目录，db-pull 会清空本地 databases），执行前请确认。")
							: pending.kind === "push"
								? h("div", { style: muted }, "推送会更新线上平台，请确认 .env 中 SERVER_URL、账号密码正确。")
								: null,
						h(
							"div",
							{ style: rowStyle },
							h(UI.Button, { onClick: runner.cancel }, "取消"),
							h(UI.Button, { variant: "primary", onClick: runner.confirm }, runner.busy ? "执行中…" : "确认执行"),
						),
					),
				);
			}
			if (runner.result === null) return null;
			const result = runner.result;
			return h(
				UI.Modal,
				{ open: true, onClose: runner.clear, title: (result.ok ? "执行完成 · " : "执行失败 · ") + result.name },
				h(
					"div",
					{ style: gridStyle },
					h(Notice, { error: result.ok ? undefined : result.error }, "$ " + result.cmd),
					result.output === "" || result.output === undefined ? null : h("pre", { style: preStyle }, result.output),
					h("div", { style: rowStyle }, h(UI.Button, { onClick: runner.clear }, "关闭")),
				),
			);
		}

		/* ------------------------------ 工程浏览器：左侧常驻树 + 右侧详情区 */

		/**
		 * 工程浏览器。左栏是常驻的多级工程树，右栏是详情区（文件内容 / 体检与预览 /
		 * 推送状态 / 工程脚本 / 预设包）。detail 与 onDetail 由 Panel 传入 —— 详情页签
		 * 的状态放在 Panel 的第一个 useState 上，渲染层桩检靠拨动它逐个页签渲染。
		 */
		function TreeTab({ runner, detail, onDetail, inputActions }) {
			const [dir, setDir] = useRememberedPath(DIR_KEY);
			/* 缓存恢复：同一页面会话里已拉过的树直接拿来用，切回来不会先白一下再重拉。 */
			const [expanded, setExpanded] = useState(() => new Set(readStoredList(EXPANDED_KEY)));
			const [children, setChildren] = useState(() => (panelCache.children instanceof Map ? panelCache.children : new Map()));
			const [selected, setSelected] = useState(null);
			const [pushIndex, setPushIndex] = useState(() => (panelCache.pushIndex instanceof Map ? panelCache.pushIndex : new Map()));
			const [pushInfo, setPushInfo] = useState(() => panelCache.pushInfo ?? null);
			const [notice, setNotice] = useState(null);
			const [state, setState] = useState(() =>
				panelCache.children instanceof Map && panelCache.children.size > 0 && panelCache.root === readStoredPath(DIR_KEY).trim()
					? { status: "ready" }
					: { status: "idle" },
			);
			const [menu, setMenu] = useState(null);
			const [lintReport, setLintReport] = useState(null);
			const [envDialog, setEnvDialog] = useState(null);
			const [query, setQuery] = useState("");
			const [hits, setHits] = useState(null);
			/** 行级选择：{ a, b } 是起止行（0 基），null 表示还没选。 */
			const [sel, setSel] = useState(null);
			/**
			 * 行范围编辑器（「改这段」与「编辑」共用）：{ from, to, drafts, page, saving, error }。
			 * drafts 是切好的页 —— 一页一段文本，编辑控件一次只渲染 drafts[page]。
			 */
			const [patch, setPatch] = useState(null);
			/**
			 * 行内编辑（0.2.23）：{ index, draft, saving, error }，null 表示没有哪一行正在改。
			 * 双击只读区的一行进入，回车/失焦写回，Escape 取消。
			 */
			const [lineEdit, setLineEdit] = useState(null);
			/** 左键是否按着：拖选时经过哪一行就把终点挪到哪一行。 */
			const dragRef = useRef(false);

			const root = dir.trim();
			const expandedRef = useRef(expanded);
			expandedRef.current = expanded;
			const childrenRef = useRef(children);
			childrenRef.current = children;

			/** 拉一层目录，结果按路径存进 children：展开与刷新互不干扰。 */
			const load = useCallback(async (path) => {
				setChildren((previous) => {
					const next = new Map(previous);
					next.set(path, { status: "loading" });
					return next;
				});
				const result = await call("listProjectEntries", path);
				setChildren((previous) => {
					const next = new Map(previous);
					if (result.ok) {
						const value = result.value !== null && typeof result.value === "object" ? result.value : {};
						next.set(path, { status: "ready", entries: value.entries ?? [], truncated: value.truncated === true });
					} else {
						next.set(path, { status: "error", error: result.error });
					}
					return next;
				});
			}, []);

			/**
			 * 重扫推送状态并建索引。host 的节点可能同时给出 dir（绝对）与
			 * relPath/key（相对工作区），两种都登记，匹配时按规范化后的绝对路径命中。
			 */
			const scanPush = useCallback(async (path) => {
				const result = await call("projectPushStatus", path);
				if (!result.ok) {
					setPushIndex(new Map());
					setPushInfo(null);
					return;
				}
				const data = result.value !== null && typeof result.value === "object" ? result.value : {};
				const index = new Map();
				const put = (key, node) => {
					if (key === undefined || key === null || key === "") return;
					/* 只登记真正的对象：后面按 node.status 取值，null/标量会直接炸渲染。 */
					if (node === null || typeof node !== "object") return;
					index.set(normPath(key), node);
				};
				for (const node of data.nodes ?? []) {
					put(node.dir, node);
					put(node.path, node);
					const rel = node.relPath ?? node.key;
					if (rel !== undefined && rel !== null) {
						put(String(rel).replace(/\//g, "\\"));
						put(path + "\\" + String(rel).replace(/\//g, "\\"));
					}
				}
				setPushIndex(index);
				setPushInfo({ projectUuid: data.projectUuid ?? "", projectNames: data.projectNames ?? {} });
			}, []);

			/** 重新加载根目录与所有已展开的子目录，再重扫推送状态。 */
			const refreshAll = useCallback(
				async (path) => {
					const paths = new Set([path]);
					for (const candidate of expandedRef.current) {
						if (normPath(candidate).startsWith(normPath(path))) paths.add(candidate);
					}
					await Promise.all([...paths].map((item) => load(item)));
					await scanPush(path);
				},
				[load, scanPush],
			);

			const list = useCallback(async () => {
				if (root === "") return;
				setNotice(null);
				setState({ status: "loading" });
				setChildren(new Map());
				setExpanded(new Set());
				/*
				 * 整段兜住：任何一步意外抛出都不能让状态停在 loading（那会让面板看起来
				 * 一片空白、又没有报错）。失败一律落成可读的错误行。
				 */
				try {
					await load(root);
					await scanPush(root);
					setState({ status: "ready" });
				} catch (error) {
					setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
				}
			}, [root, load, scanPush]);

			const toggle = useCallback(
				(path) => {
					if (expandedRef.current.has(path)) {
						setExpanded((previous) => {
							const next = new Set(previous);
							next.delete(path);
							return next;
						});
						return;
					}
					setExpanded((previous) => {
						const next = new Set(previous);
						next.add(path);
						return next;
					});
					if (children.get(path) === undefined) load(path);
				},
				[children, load],
			);

			const open = useCallback(async (path) => {
				setSel(null);
				setLineEdit(null);
				setSelected({ status: "loading", path });
				const result = await call("projectReadFile", path);
				setSelected(
					result.ok
						? { status: "ready", path, content: result.value === null || result.value === undefined ? "" : result.value.content ?? "" }
						: { status: "error", path, error: result.error },
				);
			}, []);

			/*
			 * 挂载时恢复这一次「低代码工程」会话（0.2.15）：
			 * - 树还在模块缓存里（同一个页面会话）→ 先按缓存显示，再后台重扫一遍：
			 *   切入口 / 切页签回来是瞬时的，数据也不会停在旧快照上；
			 * - 否则按记忆的目录自动列一次（原来切回来得再点一次「列出」）；
			 * - 上次打开的文件也一并读回来。
			 */
			const bootedRef = useRef(false);
			useEffect(() => {
				if (bootedRef.current || root === "") return;
				bootedRef.current = true;
				if (panelCache.children instanceof Map && panelCache.children.size > 0 && panelCache.root === root) {
					setState({ status: "ready" });
					void refreshAll(root);
				} else {
					void list();
				}
				const remembered = readStoredPath(SELECTED_KEY);
				if (remembered !== "") void open(remembered);
			}, [root, list, refreshAll, open]);

			/* 记忆：展开到哪一层、选中哪个文件。 */
			useEffect(() => {
				writeStored(EXPANDED_KEY, JSON.stringify([...expanded].slice(0, 200)));
			}, [expanded]);

			useEffect(() => {
				if (selected !== null && typeof selected.path === "string") writeStored(SELECTED_KEY, selected.path);
			}, [selected]);

			/* 模块缓存跟着 state 走：下一次挂载（另一个入口）才有东西可恢复。 */
			useEffect(() => {
				panelCache.root = root;
				panelCache.children = children;
				panelCache.pushIndex = pushIndex;
				panelCache.pushInfo = pushInfo;
			}, [root, children, pushIndex, pushInfo]);

			/**
			 * 「复制全文」：整份内容一次复制走，省得在编辑区里长距离拖选 ——
			 * 恰恰是那条正在坑上的路径（见 viewerStyle 的注释）。
			 */
			const copyAll = useCallback(async () => {
				if (selected === null || selected.status !== "ready") return;
				try {
					await navigator.clipboard.writeText(selected.content);
					setNotice("已复制全文（" + selected.content.length + " 字符）。");
				} catch (error) {
					setNotice("剪贴板不可用，可点「编辑」后 Ctrl+A 复制。");
				}
			}, [selected]);

			/* 行级选择（0.2.20）：松开左键就结束拖选，Esc 清掉选中的行。 */
			useEffect(() => {
				if (typeof window === "undefined" || window === null || typeof window.addEventListener !== "function") return undefined;
				const stopDrag = () => {
					dragRef.current = false;
				};
				const onKey = (event) => {
					if (event.key === "Escape") setSel(null);
				};
				window.addEventListener("mouseup", stopDrag);
				window.addEventListener("keydown", onKey);
				return () => {
					window.removeEventListener("mouseup", stopDrag);
					window.removeEventListener("keydown", onKey);
				};
			}, []);

			/**
			 * 把 sel 折算成真正的一段：行号夹在文件范围内，文本按行拼回（末尾不加换行）。
			 * 没选中时返回 null，调用方据此提示先选一段。
			 */
			const selectedRange = (content) => {
				if (sel === null) return null;
				const lines = String(content ?? "").split("\n");
				const from = Math.max(0, Math.min(sel.a, sel.b));
				const to = Math.min(lines.length - 1, Math.max(sel.a, sel.b));
				if (to < from) return null;
				const text = lines.slice(from, to + 1).join("\n");
				return { from, to, count: to - from + 1, text: text };
			};

			/** 「复制选中」：只把选中的那几行送进剪贴板（不再需要长距离拖选）。 */
			const copySelection = useCallback(async () => {
				if (selected === null || selected.status !== "ready") return;
				const range = selectedRange(selected.content);
				if (range === null) {
					setNotice("先在内容里点一行、再拖过或 Shift+点另一行，选出要复制的范围。");
					return;
				}
				try {
					await navigator.clipboard.writeText(range.text);
					setNotice("已复制第 " + (range.from + 1) + "–" + (range.to + 1) + " 行（共 " + range.count + " 行，" + range.text.length + " 字符）。");
				} catch (error) {
					setNotice("剪贴板不可用，请改用「复制全文」。");
				}
			}, [selected, sel]);

			/**
			 * 把一段文字插进**下面的对话输入框**（0.2.23）。
			 *
			 * 「低代码工程」页签是会话作用域的 slot，宿主会把 `InputActions`
			 * （`captureInsertion` / `insertText` / `setDraft` / `submit` …）当 props 一起递进来 ——
			 * 这是官方公开面，不用碰 conversation 包里那些「不得跨插件边界」的私有键盘面
			 * （ComposerKeyboard / InputHub.keyboard / ComposerBarInjected）。
			 *
			 * 拿不到 inputActions（设置页与侧栏浮层不在会话里）时返回 false，调用方退化成剪贴板。
			 */
			const insertIntoComposer = useCallback(
				(text) => {
					const actions = inputActions;
					if (actions === undefined || actions === null) return false;
					if (typeof actions.insertText !== "function" || typeof actions.captureInsertion !== "function") return false;
					try {
						return actions.insertText(text, actions.captureInsertion()) === true;
					} catch (error) {
						return false;
					}
				},
				[inputActions],
			);

			/** `@路径`；路径里有空格时用官方语法的 `@"路径"`。 */
			const mentionOf = useCallback((filePath) => (/\s/.test(filePath) ? '@"' + filePath + '"' : "@" + filePath), []);

			/**
			 * 「引用到输入框」：把文件 / 目录以 `@路径` 插进下面的输入框，让 AI 自己按路径读整份文件。
			 *
			 * 插的是**纯文本** `@路径`：官方 `@` 引用源的 codec 就是恒等映射（`serialize: (ref) => ref`），
			 * chip 发给模型的内容与 `@路径` 原文一致，所以效果等价；而纯文本不会被「chip owner 缺失」
			 * 在发送时拒掉（自造 chip 的序列化失败会**阻断发送**并回滚草稿）。
			 */
			const referenceToComposer = useCallback(
				async (target) => {
					const path = typeof target === "string" && target !== "" ? target : selected === null ? "" : selected.path;
					if (path === "") {
						setNotice("先选一个文件或目录，再点「引用到输入框」。");
						return;
					}
					const mention = mentionOf(path);
					if (insertIntoComposer(mention + " ")) {
						setNotice("已把 " + mention + " 插到下面的输入框：接着写要改成什么，发给我就行。");
						return;
					}
					/* 设置页 / 侧栏浮层不在会话里，拿不到输入框，退化成剪贴板。 */
					try {
						await navigator.clipboard.writeText(mention + " ");
						setNotice("已复制 " + mention + "：粘到下面的输入框，再写要改成什么。");
					} catch (error) {
						setNotice("剪贴板不可用，文件路径：" + path);
					}
				},
				[insertIntoComposer, mentionOf, selected],
			);

			/**
			 * 「发给 AI 改」：绝对路径 + 行号范围 + 选中内容 + 留一句要求的空位。
			 * 能拿到输入框就直接插进去（0.2.23 起），否则退回剪贴板 —— 粘进对话即可，
			 * AI 还能按路径自己读整份文件。
			 */
			const sendSelectionToAI = useCallback(async () => {
				if (selected === null || selected.status !== "ready") return;
				const range = selectedRange(selected.content);
				if (range === null) {
					setNotice("先选一段（点一行，再拖过或 Shift+点另一行），再点「发给 AI 改」。");
					return;
				}
				const heading =
					"【工程文件】" +
					selected.path +
					"\n【选中范围】第 " +
					(range.from + 1) +
					"–" +
					(range.to + 1) +
					" 行（共 " +
					range.count +
					" 行）\n【选中内容】\n" +
					range.text +
					"\n\n【我的要求】（在这里补一句要改成什么，然后发给我）";
				if (insertIntoComposer(heading + "\n")) {
					setNotice("已把第 " + (range.from + 1) + "–" + (range.to + 1) + " 行插到下面的输入框：把「我的要求」写完发给我就行。");
					return;
				}
				try {
					await navigator.clipboard.writeText(heading);
					setNotice(
						"已复制：文件路径 + 第 " +
							(range.from + 1) +
							"–" +
							(range.to + 1) +
							" 行 + 这段内容。粘到下面的对话框，把「我的要求」写完发给我就行。",
					);
				} catch (error) {
					setNotice("剪贴板不可用，文件路径：" + selected.path);
				}
			}, [insertIntoComposer, selected, sel]);


			/**
			 * 把 [from, to] 这一段按 EDITOR_PAGE_LINES 行切成一页一页的草稿。
			 * 编辑控件永远只装其中一页 —— 这是 0.2.21 绕开拖选死锁的办法：
			 * 出事的不是「打开文件」，而是把整份文件塞进一个原生文本控件。
			 */
			const sliceDrafts = (lines, from, to) => {
				const drafts = [];
				for (let start = from; start <= to; start += EDITOR_PAGE_LINES) {
					const end = Math.min(to, start + EDITOR_PAGE_LINES - 1);
					drafts.push(lines.slice(start, end + 1).join("\n"));
				}
				return drafts.length === 0 ? [""] : drafts;
			};

			/**
			 * 换页大小（0.2.23）：size <= 0 表示「整份一页」，否则每 size 行一页。
			 * 换档时先把**当前所有页草稿**拼回整段，再按新档重切 —— 用户已经改过的内容不丢，
			 * 页码按行偏移折算，视线大致停在原来那一行。
			 */
			const resliceDrafts = (drafts, size, page, oldSize) => {
				const all = [];
				drafts.forEach((draft) => {
					String(draft).split("\n").forEach((line) => all.push(line));
				});
				if (!(size > 0)) return { drafts: [all.join("\n")], page: 0 };
				const next = [];
				for (let start = 0; start < Math.max(all.length, 1); start += size) {
					next.push(all.slice(start, start + size).join("\n"));
				}
				const line = (oldSize > 0 ? page * oldSize : 0) + 0;
				return { drafts: next, page: Math.max(0, Math.min(Math.floor(line / size), next.length - 1)) };
			};

			/**
			 * 打开行范围编辑器：「改这段」给选中的几行，「编辑」给整份文件 —— 同一个分页编辑器。
			 * 整份文件进来也只**按页**渲染，textarea 里永远只有一页的量级。
			 */
			const openRange = useCallback(
				(from, to) => {
					if (selected === null || selected.status !== "ready") return;
					const lines = String(selected.content ?? "").split("\n");
					const start = Math.max(0, Math.min(from, lines.length - 1));
					const end = Math.max(start, Math.min(to, lines.length - 1));
					setPatch({ from: start, to: end, total: lines.length, drafts: sliceDrafts(lines, start, end), page: 0, pageSize: EDITOR_PAGE_LINES, saving: false });
				},
				[selected],
			);

			/**
			 * 「改这段」：只把选中的这几行放进小文本框里改，保存时按行号替换回原文件
			 * （文件其余部分逐字不动）。选中的行多过一页就自动分页，一页一页改 ——
			 * 大编辑区 + 长距离拖选正是把窗口拖死的那条路。
			 */
			const openPatch = useCallback(() => {
				if (selected === null || selected.status !== "ready") return;
				const range = selectedRange(selected.content);
				if (range === null) {
					setNotice("先选一段（点一行，再拖过或 Shift+点另一行），再点「改这段」。");
					return;
				}
				openRange(range.from, range.to);
			}, [selected, sel, openRange]);

			/** 改当前这一页的草稿（别的页原样留着）。 */
			const changePatch = useCallback((value) => {
				setPatch((previous) => {
					if (previous === null) return previous;
					const drafts = previous.drafts.slice();
					drafts[previous.page] = value;
					return Object.assign({}, previous, { drafts: drafts });
				});
			}, []);

			/** 翻页（夹在 0..末页 之间）。 */
			const gotoPatchPage = useCallback((page) => {
				setPatch((previous) => {
					if (previous === null) return previous;
					const last = previous.drafts.length - 1;
					const next = Math.max(0, Math.min(page, last));
					return next === previous.page ? previous : Object.assign({}, previous, { page: next });
				});
			}, []);

			/**
			 * 换页大小（0.2.23）：120 / 300 / 1000 行，或「整份」（size = 0）。
			 * 换档只重切草稿，不碰文件；保存走的还是同一条「按行替换后整份写回」。
			 */
			const setPatchPageSize = useCallback((size) => {
				setPatch((previous) => {
					if (previous === null) return previous;
					if ((previous.pageSize === undefined ? EDITOR_PAGE_LINES : previous.pageSize) === size) return previous;
					const oldSize = previous.pageSize === undefined ? EDITOR_PAGE_LINES : previous.pageSize;
					const sliced = resliceDrafts(previous.drafts, size, previous.page, oldSize);
					return Object.assign({}, previous, { drafts: sliced.drafts, page: sliced.page, pageSize: size, error: undefined });
				});
			}, []);

			/**
			 * 行内编辑（0.2.23）：双击只读区某一行，那一行就地变成单行输入框。
			 *
			 * 为什么是「单行」而不是又能整份编辑：崩溃那条路要的是**可编辑控件里的长距离拖选**，
			 * 单行输入框里最多选中一行文本，跨行拖选根本无从发生 —— 于是浏览器内也能真的改代码，
			 * 又不必赌渲染进程。回车/失焦写回，Escape 取消。
			 */
			const saveLineEdit = useCallback(
				async () => {
					if (lineEdit === null || selected === null || selected.status !== "ready") return;
					const lines = String(selected.content ?? "").split("\n");
					if (lineEdit.index < 0 || lineEdit.index >= lines.length) {
						setLineEdit(null);
						return;
					}
					if (lines[lineEdit.index] === lineEdit.draft) {
						setLineEdit(null);
						return;
					}
					const next = lines.slice();
					next[lineEdit.index] = lineEdit.draft;
					const text = next.join("\n");
					setLineEdit(Object.assign({}, lineEdit, { saving: true }));
					const result = await call("projectWriteFile", selected.path, text);
					if (!result.ok) {
						setLineEdit(Object.assign({}, lineEdit, { saving: false, error: result.error }));
						return;
					}
					setSelected(Object.assign({}, selected, { content: text, saved: true, saveError: undefined }));
					setLineEdit(null);
					setNotice("已改第 " + (lineEdit.index + 1) + " 行，文件其余部分未动。");
				},
				[lineEdit, selected],
			);

			/** 按行替换后整份写回（UTF-8 直写，无备份），并把内存里的内容同步成新版本。 */
			const savePatch = useCallback(async () => {
				if (patch === null || selected === null || selected.status !== "ready") return;
				setPatch(Object.assign({}, patch, { saving: true }));
				const lines = String(selected.content ?? "").split("\n");
				const replaced = patch.to - patch.from + 1;
				/* 各页草稿按顺序拼回一段：页是按连续行切的，顺序拼即等价于整段替换。 */
				const middle = [];
				patch.drafts.forEach((draft) => {
					String(draft).split("\n").forEach((line) => middle.push(line));
				});
				const text = lines.slice(0, patch.from).concat(middle, lines.slice(patch.to + 1)).join("\n");
				const result = await call("projectWriteFile", selected.path, text);
				if (!result.ok) {
					setPatch(Object.assign({}, patch, { saving: false, error: result.error }));
					return;
				}
				setSelected(Object.assign({}, selected, { content: text, saved: true, saveError: undefined }));
				setPatch(null);
				setNotice(
					"已用改后的 " + middle.length + " 行替换第 " + (patch.from + 1) + "–" + (patch.to + 1) + " 行（原 " + replaced + " 行），文件其余部分未动。",
				);
			}, [patch, selected]);

			/**
			 * 0.2.22：交给系统里的编辑器打开（VS Code / 记事本 / 文件管理器）。
			 *
			 * 崩溃的根因是浏览器在**可编辑文本控件**里做长距离原生选区（Chromium 154 的
			 * Blink>Editing>Selection 死锁），所以大文件的正解是根本不把文本交给浏览器：
			 * 点一下就交给外面的编辑器，改完在插件里点「刷新」重新读。这条路既没有分页，
			 * 也没有文本域，插件侧只发一个路径出去。
			 */
			const openExternal = useCallback(
				async (path) => {
					const target = typeof path === "string" && path !== "" ? path : selected === null ? "" : selected.path;
					if (target === "") {
						setNotice("先选一个文件，再点「用编辑器打开」。");
						return;
					}
					const result = await call("projectOpenExternal", target);
					if (!result.ok) setNotice(result.error);
					else {
						const value = result.value ?? {};
						setNotice("已用 " + (value.editor ?? "系统编辑器") + " 打开：" + target + "（外面改完，回插件点「刷新」重新读）");
					}
				},
				[call, selected],
			);

			const rename = useCallback(
				async (entry) => {
					const next = window.prompt("新名称", entry.name);
					if (next === null || next.trim() === "" || next === entry.name) return;
					const result = await call("projectRenameEntry", entry.path, next.trim());
					if (!result.ok) setNotice(result.error);
					else {
						setNotice(null);
						await load(parentOf(entry.path));
					}
				},
				[load],
			);

			const remove = useCallback(
				async (entry) => {
					const what = entry.kind === "directory" ? "目录（含其中全部内容）" : "文件";
					if (!window.confirm("删除" + what + " " + entry.name + "？此操作不可撤销。")) return;
					const result = await call("projectDeleteEntry", entry.path);
					if (!result.ok) setNotice(result.error);
					else {
						setNotice(null);
						await refreshAll(root);
					}
				},
				[root, refreshAll],
			);

			const copyPath = useCallback(async (path) => {
				try {
					await navigator.clipboard.writeText(path);
					setNotice("已复制路径：" + path);
				} catch (error) {
					setNotice("剪贴板不可用，路径：" + path);
				}
			}, []);

			/**
			 * 定位到一条搜索结果（0.2.15）：沿途每一级目录先拉下来再展开，
			 * 否则树里根本没有这一层，点了等于没反应；命中文件则顺手打开。
			 */
			const reveal = useCallback(
				async (item) => {
					const target = item.kind === "directory" ? item.path : parentOf(item.path);
					const chain = [];
					let cursor = target;
					while (cursor !== "" && normPath(cursor) !== normPath(root) && normPath(cursor).startsWith(normPath(root))) {
						chain.unshift(cursor);
						const parent = parentOf(cursor);
						if (parent === cursor || parent === "") break;
						cursor = parent;
					}
					try {
						for (const path of [root, ...chain]) {
							if (childrenRef.current.get(path) === undefined) await load(path);
						}
						setExpanded((previous) => {
							const next = new Set(previous);
							for (const path of chain) next.add(path);
							return next;
						});
						setQuery("");
						if (item.kind === "directory") {
							setSelected(null);
							setNotice("已定位到目录：" + item.path);
						} else {
							await open(item.path);
						}
					} catch (error) {
						setNotice(error instanceof Error ? error.message : String(error));
					}
				},
				[load, open, root],
			);

			/*
			 * 模糊查找：输入停 250ms 后问一次 host（它递归整棵树，所以还没展开的层也能搜到）。
			 * 输入变了就把上一次的结果作废，免得旧结果盖住新输入。
			 */
			useEffect(() => {
				const needle = query.trim();
				if (needle === "" || root === "") {
					setHits(null);
					return undefined;
				}
				let alive = true;
				const timer = window.setTimeout(() => {
					setHits({ status: "loading", query: needle });
					void call("projectSearchEntries", root, needle).then((result) => {
						if (!alive) return;
						if (!result.ok) {
							setHits({ status: "error", query: needle, error: result.error });
							return;
						}
						const value = result.value !== null && typeof result.value === "object" ? result.value : {};
						setHits({
							status: "ready",
							query: needle,
							items: Array.isArray(value.hits) ? value.hits : [],
							truncated: value.truncated === true,
						});
					});
				}, 250);
				return () => {
					alive = false;
					window.clearTimeout(timer);
				};
			}, [query, root]);

			/** 树内 ↑ 推送：知道 scope/target，所以推送成功后能自动标记该目标。 */
			const requestPush = useCallback(
				(node) => {
					const scope = node.scope ?? "page";
					const target = node.target ?? "";
					const script = scope === "api" ? "source-api-push.js" : "source-page-push.js";
					const label = SCOPE_LABEL[scope] ?? scope;
					runner.request({
						script: script,
						args: [target],
						name: "推送" + label + (target === "" ? "" : " " + target),
						kind: "push",
						cwd: root,
						after: { workspacePath: root, relDir: node.relPath ?? node.key ?? "", scope: scope, target: target },
						onDone: () => refreshAll(root),
					});
					setNotice(null);
				},
				[root, runner, refreshAll],
			);

			/** ↓ 下拉：按目录语义挑脚本（原版 onPullById / pullAll* 的等价物）。 */
			const pullFor = useCallback(
				(entry) => {
					const name = String(entry.name);
					const done = () => refreshAll(root);
					if (name === "pages") {
						runner.request({ script: "source-page-pull.js", args: [], name: "下拉所有页面", kind: "pull", cwd: root, onDone: done });
						return;
					}
					if (name === "apis") {
						runner.request({ script: "source-api-pull.js", args: [], name: "下拉所有 API", kind: "pull", cwd: root, onDone: done });
						return;
					}
					if (name === "databases") {
						runner.request({ script: "source-db-pull.js", args: [], name: "下拉数据库", kind: "pull", cwd: root, onDone: done });
						return;
					}
					if (/^[0-9a-f]{32}$/i.test(name)) {
						runner.request({ script: "source-clone.js", args: [name], name: "下拉项目（克隆）", kind: "pull", cwd: root, onDone: done });
						return;
					}
					const segments = normPath(entry.path).split("\\");
					const zone = segments.includes("pages") ? "pages" : segments.includes("apis") ? "apis" : null;
					if (zone === null) {
						setNotice("该目录不在 pages/apis 区里，没有可下拉的对象；项目目录名形如 32 位 UUID。");
						return;
					}
					const id = window.prompt(zone === "pages" ? "请输入要下拉的页面 ID：" : "请输入要下拉的 API ID：", "");
					if (id === null || id.trim() === "") return;
					const label = zone === "pages" ? "页面" : "API";
					runner.request({
						script: zone === "pages" ? "source-page-pull.js" : "source-api-pull.js",
						args: [id.trim()],
						name: "下拉" + label + " " + id.trim(),
						kind: "pull",
						cwd: root,
						onDone: done,
					});
				},
				[root, runner, refreshAll],
			);

			/** UUID 项目目录的「项目命名」：只改显示名，不动物理目录。 */
			const renameProject = useCallback(
				async (entry) => {
					const uuid = String(entry.name);
					const names = pushInfo === null ? {} : pushInfo.projectNames ?? {};
					const current = names[uuid];
					const name = window.prompt("显示用的项目名（清空则删除该条映射）", current === undefined ? "" : current);
					if (name === null) return;
					const result = await call("projectSetProjectName", root, uuid, name.trim());
					if (!result.ok) setNotice(result.error);
					else {
						setNotice(null);
						await scanPush(root);
					}
				},
				[pushInfo, root, scanPush],
			);

			/** 右键「推送前校验」：跑 projectLint，结果显示在右栏「体检与预览」页签里。 */
			const lintEntry = useCallback(
				async (entry) => {
					if (typeof onDetail === "function") onDetail("preview");
					setLintReport({ status: "loading", name: entry.name });
					const result = await call("projectLint", entry.path);
					setLintReport(
						result.ok
							? { status: "ready", name: entry.name, data: result.value }
							: { status: "error", name: entry.name, error: result.error },
					);
				},
				[onDetail],
			);

			/**
			 * 右键「复制内容（发给 AI）」：把绝对路径 + 文件内容复制到剪贴板。
			 * 上游能把文本直接注入对话输入框，但那是它补丁里的私有函数（dshPmInjectComposer），
			 * 客户端插件拿不到那个入口，所以退化成「复制上下文，粘进对话即可」。
			 */
			const sendToAI = useCallback(async (entry) => {
				const result = await call("projectReadFile", entry.path);
				if (!result.ok) {
					setNotice(result.error);
					return;
				}
				const content = result.value === null || result.value === undefined ? "" : result.value.content ?? "";
				const text = "【工程文件上下文】" + entry.path + "\n\n--- " + entry.name + " ---\n" + content;
				try {
					await navigator.clipboard.writeText(text);
					setNotice("已复制 " + entry.name + " 的内容与路径，粘贴到对话里即可交给 AI。");
				} catch (error) {
					setNotice("剪贴板不可用，文件路径：" + entry.path);
				}
			}, []);

			/**
			 * 打开环境配置：读工作区根的 .env 并解析出两个键。
			 * 读不到（文件不存在 / 无权限）就当成空 .env —— 保存时会新建一个。
			 */
			const openEnvDialog = useCallback(async () => {
				if (root === "") {
					setNotice("先填工程目录，再改环境配置。");
					return;
				}
				const path = root.replace(/[\\/]+$/, "") + "\\.env";
				setEnvDialog({ status: "loading", path: path, values: {} });
				const result = await call("projectReadFile", path);
				if (result.ok) {
					const content = result.value === null || result.value === undefined ? "" : result.value.content ?? "";
					setEnvDialog({
						status: "ready",
						path: path,
						content: content,
						values: envValues(content, DEFAULT_ENV_FIELDS.map((field) => field.key)),
					});
					return;
				}
				setEnvDialog({
					status: "ready",
					path: path,
					content: "",
					missing: true,
					values: envValues("", DEFAULT_ENV_FIELDS.map((field) => field.key)),
				});
			}, [root]);

			const changeEnv = useCallback((key, value) => {
				setEnvDialog((previous) =>
					previous === null
						? null
						: Object.assign({}, previous, { values: Object.assign({}, previous.values, { [key]: value }), saved: undefined }),
				);
			}, []);

			/** 保存：把字段集合 upsert 进 .env 文本后整体写回，其它行原样保留。 */
			const saveEnvDialog = useCallback(async () => {
				if (envDialog === null || envDialog.status !== "ready" || envDialog.saving === true) return;
				const text = upsertEnvValues(envDialog.content ?? "", envDialog.values ?? {});
				setEnvDialog(Object.assign({}, envDialog, { saving: true, saveError: undefined }));
				const result = await call("projectWriteFile", envDialog.path, text);
				setEnvDialog(
					result.ok
						? Object.assign({}, envDialog, { saving: false, saved: true, missing: false, content: text, saveError: undefined })
						: Object.assign({}, envDialog, { saving: false, saved: undefined, saveError: result.error }),
				);
			}, [envDialog]);

			const closeMenu = useCallback(() => setMenu(null), []);

			/**
			 * 组装某一行的右键菜单 —— 对齐上游 ProjectContextMenu：
			 * 分隔线分组、危险项红字、当前不适用的项灰显禁用（而不是隐藏，位置稳定）。
			 */
			const menuFor = (entry, event) => {
				const isDir = entry.kind === "directory";
				const pushable = pushIndex.get(normPath(entry.path));
				const dirty = pushable !== undefined && pushable.status === "dirty";
				const isProjectDir = /^[0-9a-f]{32}$/i.test(String(entry.name));
				const relative = relUnder(root, entry.path);
				const items = [];
				if (isDir === false) items.push({ id: "view", label: "👁 查看内容", onSelect: () => open(entry.path) });
				if (isDir === false) items.push({ id: "ai", label: "🤖 复制内容（发给 AI）", onSelect: () => sendToAI(entry) });
				items.push({ id: "refToComposer", label: "🤖 引用到输入框（让 AI 改）", onSelect: () => referenceToComposer(entry.path) });
				if (isDir === false) items.push({ id: "openEditor", label: "🖥 用编辑器打开", onSelect: () => openExternal(entry.path) });
				items.push({
					id: "push",
					label: "↑ 推送",
					title: pushable === undefined ? "该条目不在推送清单里" : "",
					disabled: dirty === false,
					onSelect: () => {
						if (pushable !== undefined) requestPush(pushable);
					},
				});
				items.push({ id: "pull", label: "⬇ 下拉", disabled: isDir === false, onSelect: () => pullFor(entry) });
				items.push({ id: "name", label: "✏ 项目命名", disabled: isProjectDir === false, onSelect: () => renameProject(entry) });
				items.push({ id: "lint", label: "🔍 推送前校验", disabled: isDir === false, onSelect: () => lintEntry(entry) });
				items.push({ separator: true });
				items.push({ id: "refresh", label: "⟳ 刷新", disabled: root === "", onSelect: () => refreshAll(root) });
				items.push({ id: "rescan", label: "⟳ 重扫推送状态", disabled: root === "", onSelect: () => scanPush(root) });
				items.push({ id: "env", label: "⚙ 修改环境配置", disabled: root === "", onSelect: () => openEnvDialog() });
				items.push({ separator: true });
				items.push({ id: "copyPath", label: "📋 复制绝对路径", onSelect: () => copyPath(entry.path) });
				items.push({
					id: "copyRel",
					label: "📋 复制相对路径",
					title: relative === null ? "该条目不在当前工程目录之下" : relative,
					disabled: relative === null,
					onSelect: () => copyPath(relative),
				});
				items.push({ separator: true });
				items.push({ id: "rename", label: "✏ 改名", onSelect: () => rename(entry) });
				items.push({ id: "delete", label: "🗑 删除", danger: true, onSelect: () => remove(entry) });
				return { x: event.clientX, y: event.clientY, title: entry.name, items: items };
			};

			const openMenu = (entry, event) => {
				event.preventDefault();
				event.stopPropagation();
				setMenu(menuFor(entry, event));
			};

			const entriesAt = (path) => {
				const node = children.get(path);
				if (node === undefined) return null;
				return node;
			};

			const renderLevel = (path, depth, budget) => {
				const node = entriesAt(path);
				const items = [];
				const indent = { paddingLeft: depth * 14 };
				if (node === null || node.status === "loading") {
					items.push(h("li", { key: path + "|loading", style: Object.assign({}, itemStyle, indent) }, h("span", { style: muted }, "加载中…")));
					return items;
				}
				if (node.status === "error") {
					items.push(h("li", { key: path + "|error", style: Object.assign({}, itemStyle, indent) }, h(Notice, { error: node.error })));
					return items;
				}
				const entries = Array.isArray(node.entries) ? node.entries : [];
				if (entries.length === 0) {
					items.push(h("li", { key: path + "|empty", style: Object.assign({}, itemStyle, indent) }, h("span", { style: muted }, "空文件夹")));
					return items;
				}
				for (const entry of entries) {
					/*
					 * 一次渲染的行数上限：展开几层大目录时，几千行 DOM 会把整个 shell 拖住。
					 * 用共享预算（子层递归时继续扣），到顶就在树尾说明一句。
					 */
					if (budget.left <= 0) break;
					budget.left -= 1;
					const isDir = entry.kind === "directory";
					const isOpen = isDir && expanded.has(entry.path);
					const hit = pushIndex.get(normPath(entry.path));
					const pushable = hit !== null && typeof hit === "object" ? hit : undefined;
					const dirty = pushable !== undefined && pushable.status === "dirty";
					const isProjectDir = /^[0-9a-f]{32}$/i.test(String(entry.name));
					items.push(
						h(
							"li",
							{ key: entry.path, style: indent },
							h(
								"div",
								{
									className: "dshml-row",
									"data-selected": selected !== null && selected.path === entry.path ? "1" : "0",
									onContextMenu: (event) => openMenu(entry, event),
								},
								isDir
									? h(
											"span",
											{
												className: "dshml-name dshml-dir",
												title: entry.path,
												onClick: () => toggle(entry.path),
											},
											(isOpen ? "▾ " : "▸ ") + "📁 " + entry.name,
										)
									: h(
											"span",
											{
												className: entry.hidden ? "dshml-name dshml-hint" : "dshml-name",
												title: entry.path,
												onClick: () => open(entry.path),
											},
											"📄 " + entry.name,
										),
								pushable === undefined ? null : statusTag(pushable.status),
								h(
									"span",
									{ className: "dshml-acts" },
									dirty ? h(UI.Button, { size: "sm", title: "推送", onClick: () => requestPush(pushable, entry.path) }, "↑") : null,
									isDir ? h(UI.Button, { size: "sm", title: "下拉", onClick: () => pullFor(entry) }, "↓") : null,
									isProjectDir ? h(UI.Button, { size: "sm", title: "项目命名", onClick: () => renameProject(entry) }, "✏") : null,
									isDir ? null : h(UI.Button, { size: "sm", title: "查看内容", onClick: () => open(entry.path) }, "查看"),
									h(UI.Button, { size: "sm", title: "复制绝对路径", onClick: () => copyPath(entry.path) }, "📋"),
								),
							),
							isOpen ? renderLevel(entry.path, depth + 1, budget) : null,
						),
					);
				}
				if (budget.left <= 0 && budget.notified !== true) {
					budget.notified = true;
					items.push(
						h(
							"li",
							{ key: path + "|budget", style: Object.assign({}, itemStyle, indent) },
							h("span", { style: muted }, "已达一次渲染上限（" + RENDER_LIMIT + " 行），收起部分目录、或换个更小的目录再看。"),
						),
					);
				}
				return items;
			};

			/**
			 * 树的入口。renderLevel 是同步构造 vnode，异常会冒到 React 之外 ——
			 * 在这里兜住，白屏就变成一行可读文字。
			 */
			const renderTree = () => {
				try {
					return h("ul", { className: "dshml-rows" }, renderLevel(root, 0, { left: RENDER_LIMIT }));
				} catch (error) {
					return h("div", { className: "dshml-hint" }, "✗ 项目树渲染出错：" + (error instanceof Error ? error.message : String(error)));
				}
			};

			/** 查找结果列表：点一条就回树里定位过去（文件顺便打开）。 */
			const renderHits = () => {
				if (hits === null) return null;
				if (hits.status === "loading") return h("div", { className: "dshml-hint" }, "查找中…");
				if (hits.status === "error") return h(Notice, { error: hits.error });
				if (hits.items.length === 0) return h("div", { className: "dshml-hint" }, "没有匹配「" + hits.query + "」的页面、目录或文件。");
				return h(
					Fragment,
					null,
					h(
						"div",
						{ className: "dshml-hint" },
						"匹配 " + hits.items.length + " 项" + (hits.truncated ? "（已截断，只显示最像的前 " + hits.items.length + " 项）" : "") + "，点一条定位到树里：",
					),
					h(
						"ul",
						{ className: "dshml-rows" },
						hits.items.map((item) =>
							h(
								"li",
								{ key: item.path, style: itemStyle },
								h(
									"div",
									{ className: "dshml-row" },
									h(
										"span",
										{ className: "dshml-name", title: item.path, onClick: () => reveal(item) },
										(item.kind === "directory" ? "📁 " : "📄 ") + item.name,
									),
									h("span", { className: "dshml-hitpath", title: item.relPath }, item.relPath),
								),
							),
						),
					),
				);
			};

			const info =
				state.status === "loading"
					? "读取中…"
					: state.status === "ready"
						? "工程目录已列出" +
							(pushInfo === null ? "" : " · 待推送 " + [...pushIndex.values()].filter((node) => node.status === "dirty").length + " 项") +
							(pushInfo === null || pushInfo.projectUuid === "" ? "" : " · PROJECT_UUID " + pushInfo.projectUuid)
						: null;

			/**
			 * 「查看」态正文（0.2.20）：一行一个 <div>（行号槽 + 文本），容器是 user-select: none，
			 * 拖过多少行都不会产生原生选区 —— 选区完全由 sel 这个状态决定，于是既绕开了 Blink
			 * 的拖选死锁与 Edge 的划词迷你菜单，又能让用户真的「选中一段」再去复制 / 交给 AI。
			 */
			const renderViewer = () => {
				const lines = String(selected.content ?? "").split("\n");
				const shown = Math.min(lines.length, VIEW_LINE_LIMIT);
				const from = sel === null ? -1 : Math.max(0, Math.min(sel.a, sel.b));
				const to = sel === null ? -1 : Math.min(lines.length - 1, Math.max(sel.a, sel.b));
				const pick = (index) => {
					setSel({ a: index, b: index });
					dragRef.current = true;
				};
				const extend = (index) => {
					if (!dragRef.current) return;
					setSel((previous) => (previous === null ? previous : { a: previous.a, b: index }));
				};
				const rows = [];
				for (let index = 0; index < shown; index += 1) {
					const editing = lineEdit !== null && lineEdit.index === index;
					rows.push(
						h(
							"div",
							{
								key: index,
								className: "dshml-line",
								"data-sel": index >= from && index <= to ? "1" : undefined,
								style: viewRowStyle,
								onMouseDown: (event) => {
									if (editing) return;
									if (event.shiftKey && sel !== null) setSel({ a: sel.a, b: index });
									else pick(index);
								},
								onMouseEnter: () => extend(index),
								/* 0.2.23：双击走进行内编辑 —— 单行输入框里选中范围最大就是一行，跨行长拖选无从发生。 */
								onDoubleClick: () => setLineEdit({ index: index, draft: lines[index] }),
								title: "双击这一行可以直接改（只写回这一行）",
							},
							h("span", { className: "dshml-gutter", style: viewGutterStyle }, String(index + 1)),
							editing
								? h("input", Object.assign({
										className: "dshml-lineinput",
										style: viewTextStyle,
										value: lineEdit.draft,
										disabled: lineEdit.saving === true,
										autoFocus: true,
										onChange: (event) => setLineEdit(Object.assign({}, lineEdit, { draft: event.target.value })),
										onKeyDown: (event) => {
											if (event.key === "Enter") {
												event.preventDefault();
												void saveLineEdit();
											} else if (event.key === "Escape") {
												event.preventDefault();
												setLineEdit(null);
											}
										},
										onBlur: () => void saveLineEdit(),
									}, EDITOR_ATTRS))
								: h("span", { style: viewTextStyle }, lines[index] === "" ? " " : lines[index]),
						),
					);
				}
				const range = sel === null ? null : { from: from + 1, to: to + 1, count: to - from + 1, chars: lines.slice(from, to + 1).join("\n").length };
				return h(
					"div",
					{ style: gridStyle },
					h("pre", { style: viewerStyle, className: "dshml-view" }, rows),
					range === null
						? h("div", { className: "dshml-hint" }, "选中：点一行定起点，拖过（或 Shift+点）另一行定终点 —— 原生文本选区已经关掉（浏览器那条路会把窗口拖死），改由插件自己算选中。只改一行的话，直接**双击**那一行就地编辑。")
						: h(
								"div",
								{ className: "dshml-selbar" },
								h("span", { className: "dshml-hint" }, "已选 第 " + range.from + "–" + range.to + " 行 · 共 " + range.count + " 行 · " + range.chars + " 字符"),
								h(UI.Button, { size: "sm", onClick: copySelection }, "复制选中"),
								h(UI.Button, { size: "sm", variant: "primary", onClick: sendSelectionToAI }, "发给 AI 改"),
								h(UI.Button, { size: "sm", onClick: openPatch }, "改这段"),
								range.count === 1 ? h(UI.Button, { size: "sm", onClick: () => setLineEdit({ index: range.from - 1, draft: lines[range.from - 1] }) }, "改这一行") : null,
								h(UI.Button, { size: "sm", onClick: () => setSel(null) }, "清除选择"),
							),
					shown < lines.length
						? h("div", { className: "dshml-hint" }, "内容较长：只渲染了前 " + shown + " 行（共 " + lines.length + " 行，行号就是真实行号）。要整份内容点「复制全文」。")
						: null,
				);
			};

			/**
			 * 右栏「文件内容」页签。默认是**只读查看**（<pre> + 行级选择），「编辑」另开一个
			 * 对话框来改（0.2.21）。
			 *
			 * 0.2.21 把最后一条大编辑区路径也去掉了：以前「编辑」是把整份文件塞进右栏那个受控
			 * textarea，用户的 index.html（90399 字符）于是躺在一个 9 万字符的原生选区里，一拖就
			 * 把渲染进程拖死。现在「编辑」打开的是**分页**的行范围编辑器（见 PatchDialog /
			 * EDITOR_PAGE_LINES）：一次只装一页，文件多大都一样。查看态仍是行级选择 —— 只读不等于不能选。
			 */
			const renderContentPane = () => {
				if (selected === null) {
					return h(
						"div",
						{ style: gridStyle },
						h("div", { className: "dshml-hint" }, "点左侧文件名查看内容，点目录名展开/收起；每行右键有推送、下拉、校验、项目命名、改名、删除、复制路径等操作。"),
						h("div", { className: "dshml-hint" }, "行尾 ● 待推送 / ✔ 已推送 来自 projectPushStatus；↑ 推送与 ↓ 下拉都会先弹出要执行的 node 命令，确认后才执行。"),
					);
				}
				const lines = selected.status === "ready" ? String(selected.content ?? "").split("\n") : [];
				return h(
					"div",
					{ style: gridStyle },
					h(
						"div",
						{ style: Object.assign({}, rowStyle, { flexWrap: "nowrap", alignItems: "center" }) },
						h("span", { className: "dshml-path", title: selected.path }, selected.path),
						h(
							"span",
							{ className: "dshml-align" },
							selected.status !== "ready" ? null : h(UI.Button, { size: "sm", variant: "primary", onClick: () => referenceToComposer(selected.path) }, "引用到输入框"),
							selected.status !== "ready" ? null : h(UI.Button, { size: "sm", onClick: () => openExternal(selected.path) }, "用编辑器打开"),
							selected.status !== "ready" ? null : h(UI.Button, { size: "sm", onClick: () => openRange(0, lines.length - 1) }, "编辑"),
							selected.status !== "ready" ? null : h(UI.Button, { size: "sm", onClick: copyAll }, "复制全文"),
							selected.saved === true ? h("span", { style: muted }, "已保存") : null,
							h(UI.Button, { size: "sm", onClick: () => setSelected(null) }, "关闭"),
						),
					),
					h(Notice, { error: selected.status === "error" ? selected.error : selected.saveError }, selected.status === "loading" ? "读取中…" : null),
					selected.status === "ready" ? renderViewer() : null,
					selected.status === "ready" && lineEdit !== null && lineEdit.error !== undefined
						? h(Notice, { error: lineEdit.error })
						: null,
					selected.status === "ready"
						? h(
								"div",
								{ className: "dshml-hint" },
								"浏览器内就能改：**双击一行**改那一行（单行输入框，不会有拖选死锁那条路）；要改一段就先点一行、再 Shift+点另一行，用「改这段」；点「编辑」是分页的整份编辑器（页大小可选 120 / 300 / 1000 行或整份）。想让 AI 改就点「**引用到输入框**」—— 路径会直接插进下面的对话输入框，接着写要改成什么就行（插不进去时会复制到剪贴板）。「用编辑器打开」留给想在外面的 VS Code 里改的情况。",
							)
						: null,
				);
			};

			const activeDetail = detail === undefined || detail === null ? "content" : detail;
			const detailPanes = {
				content: renderContentPane(),
				preview: h(PreviewTab, { report: lintReport }),
				push: h(PushTab, { runner: runner }),
				script: h(ScriptTab, { runner: runner }),
				preset: h(PresetTab),
			};

			return h(
				"div",
				{ className: "dshml-browser" },
				h(
					"div",
					{ className: "dshml-toolbar" },
					h(
						"div",
						{ className: "dshml-grow" },
						h(UI.Input, {
							value: dir,
							onChange: (event) => setDir(event.target.value),
							placeholder: "工程目录绝对路径（须落在已注册工作区内）",
						}),
					),
					h(UI.Button, { variant: "primary", onClick: list }, "列出"),
					h(UI.Button, { onClick: () => refreshAll(root), disabled: root === "" }, "刷新"),
					h(UI.Button, { onClick: () => scanPush(root), disabled: root === "" }, "重扫推送状态"),
					h(UI.Button, { onClick: openEnvDialog, disabled: root === "" }, "环境配置"),
				),
				h(Notice, { error: state.status === "error" ? state.error : undefined }, info),
				h(Notice, { error: notice }, null),
				h(
					"div",
					{ className: "dshml-body" },
					h(
						"div",
						{ className: "dshml-tree" },
						h(
							"div",
							{ className: "dshml-find" },
							h(
								"div",
								{ className: "dshml-grow" },
								h(UI.Input, {
									value: query,
									onChange: (event) => setQuery(event.target.value),
									placeholder: "模糊查找：页面 / 目录 / 文件名（“备管”也能命中「备件管理」）",
								}),
							),
							query.trim() === "" ? null : h(UI.Button, { size: "sm", onClick: () => setQuery("") }, "清空"),
						),
						children.get(root) === undefined || state.status !== "ready"
							? h("div", { className: "dshml-hint" }, "填好工程目录后点「列出」。")
							: query.trim() !== ""
								? renderHits()
								: renderTree(),
					),
					h(
						"div",
						{ className: "dshml-detail" },
						h(
							"div",
							{ className: "dshml-subs" },
							DETAIL_TABS.map((tab) =>
								h(
									UI.Pill,
									{
										key: tab.key,
										active: tab.key === activeDetail,
										onClick: () => {
											if (typeof onDetail === "function") onDetail(tab.key);
										},
									},
									T(tab.label),
								),
							),
						),
						h("div", { className: "dshml-pane" }, detailPanes[activeDetail]),
					),
				),
				h(ContextMenu, { menu: menu, onClose: closeMenu }),
				h(EnvDialog, { state: envDialog, onChange: changeEnv, onSave: saveEnvDialog, onClose: () => setEnvDialog(null) }),
				h(PatchDialog, {
					state: patch,
					path: selected === null ? "" : selected.path,
					onChange: changePatch,
					onPage: gotoPatchPage,
					onPageSize: setPatchPageSize,
					onSave: savePatch,
					onCopy: sendSelectionToAI,
					onOpenExternal: openExternal,
					onClose: () => setPatch(null),
				}),
			);
		}

		/* ------------------------------------------------------ 页签 2：推送状态 */

		function PushTab({ runner }) {
			const [dir, setDir] = useRememberedPath(DIR_KEY);
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

			/** 一键推送：走同一个执行器，成功后自动标记已推送。 */
			const pushNode = useCallback((node) => {
				const scope = node.scope ?? "page";
				const target = node.target ?? "";
				const label = SCOPE_LABEL[scope] ?? scope;
				runner.request({
					script: scope === "api" ? "source-api-push.js" : "source-page-push.js",
					args: [target],
					name: "推送" + label + (target === "" ? "" : " " + target),
					kind: "push",
					cwd: dir.trim(),
					after: {
						workspacePath: dir.trim(),
						relDir: node.relPath === undefined ? node.key ?? "" : node.relPath,
						scope: scope,
						target: target,
					},
					onDone: () => refresh(),
				});
			}, [dir, runner, refresh]);

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
					h("span", { className: "dshml-grow" }, h(UI.Input, { value: dir, onChange: (event) => setDir(event.target.value), placeholder: "工作区绝对路径" })),
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
									node.status === undefined ? null : statusTag(node.status),
									node.status === "dirty" ? h(UI.Button, { size: "sm", variant: "primary", onClick: () => pushNode(node) }, "↑ 推送") : null,
									node.status === "dirty" ? h(UI.Button, { size: "sm", onClick: () => markPushed(node) }, "标记已推送") : null,
								);
							}),
						)
					: null,
			);
		}

		/* ------------------------------------------------ 页签 3：预览与体检 */

		/** 体检与预览：自带「推送前体检」，也接收树里右键触发的校验结果（report）。 */
		function PreviewTab({ report }) {
			const [dir, setDir] = useRememberedPath(DIR_KEY);
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

			const treeIssues =
				report === undefined || report === null || report.data === undefined || report.data === null ? [] : report.data.issues ?? [];

			return h(
				"div",
				{ style: gridStyle },
				report === undefined || report === null
					? null
					: h(
							"div",
							{ style: gridStyle },
							h("div", { style: Object.assign({}, rowStyle, wrapStyle) }, h("strong", null, "树内校验 · " + report.name)),
							h(
								Notice,
								{ error: report.status === "error" ? report.error : undefined },
								report.status === "loading" ? "校验中…" : report.status === "ready" ? "命中 " + treeIssues.length + " 条规则问题" : null,
							),
							report.status === "ready" && treeIssues.length === 0
								? h("div", { style: muted }, "没有发现问题，可以推送。")
								: h(LintIssues, { issues: treeIssues }),
						),
				h(
					"div",
					{ style: rowStyle },
					h("span", { className: "dshml-grow" }, h(UI.Input, { value: dir, onChange: (event) => setDir(event.target.value), placeholder: "页面目录绝对路径（含 page.json）" })),
					h(UI.Button, { variant: "primary", onClick: runLint }, "推送前体检"),
					h(UI.Button, { onClick: runAssemble }, "装配预览"),
				),
				h(Notice, { error: lint.status === "error" ? lint.error : undefined }, lintInfo),
				h(LintIssues, { issues: issues }),
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
					if (!window.confirm("导入预设「" + payload.agentPreset + "」（" + (payload.pluginCount ?? payload.fileCount) + " 个插件项）？")) {
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
					"预设包走 host 半边的 /api/agent-preset.export 与 /api/agent-preset.import：导出 DSH 0.2.0 里那套预设（含内置）的插件清单，导入会往本机 profile 的 cordis.patch.yml 追加一行预设声明，先预览、同名不覆盖。",
				),
				h(
					"div",
					{ style: rowStyle },
					h("span", { className: "dshml-grow" }, h(UI.Input, { value: presetId, onChange: (event) => setPresetId(event.target.value), placeholder: "预设标识符（小写字母/数字/连字符，留空则用包内 id）" })),
					h(UI.Button, { variant: "primary", onClick: exportPreset, disabled: presetId.trim() === "" }, "导出"),
					h(UI.Button, { onClick: () => fileRef.current.click() }, "导入…"),
					h("input", { ref: fileRef, type: "file", accept: ".dshpreset,application/zip", style: { display: "none" }, onChange: importPreset }),
				),
				h(Notice, { error: state.status === "error" ? state.error : undefined }, state.status === "loading" || state.status === "done" ? state.message : null),
			);
		}

		/* ------------------------------------------------------ 页签 5：工程脚本 */

		/** 常用脚本的快捷入口，省掉手打文件名。 */
		const SCRIPT_PRESETS = [
			{ script: "source-page-push.js", label: "推送页面" },
			{ script: "source-api-push.js", label: "推送 API" },
			{ script: "source-page-pull.js", label: "下拉页面" },
			{ script: "source-api-pull.js", label: "下拉 API" },
			{ script: "source-db-pull.js", label: "下拉数据库" },
			{ script: "source-clone.js", label: "下拉项目（克隆）" },
		];

		function ScriptTab({ runner }) {
			const [dir, setDir] = useRememberedPath(DIR_KEY);
			const [script, setScript] = useState("source-page-push.js");
			const [args, setArgs] = useState("");
			const [last, setLast] = useState(null);
			/** 运行前预检的结论：脚本找不到 / 环境变量没维护。 */
			const [block, setBlock] = useState(null);
			/** 脚本目录那份 .env 的编辑对话框（缺变量时一键打开）。 */
			const [envDialog, setEnvDialog] = useState(null);

			const openEnvEditor = useCallback(async (path) => {
				const keys = SCRIPT_ENV_FIELDS.map((field) => field.key);
				setEnvDialog({ status: "loading", path: path, values: {} });
				const result = await call("projectReadFile", path);
				if (result.ok) {
					const content = result.value === null || result.value === undefined ? "" : result.value.content ?? "";
					setEnvDialog({ status: "ready", path: path, content: content, values: envValues(content, keys) });
					return;
				}
				setEnvDialog({ status: "ready", path: path, content: "", missing: true, values: envValues("", keys) });
			}, []);

			const changeScriptEnv = useCallback((key, value) => {
				setEnvDialog((previous) =>
					previous === null
						? null
						: Object.assign({}, previous, { values: Object.assign({}, previous.values, { [key]: value }), saved: undefined }),
				);
			}, []);

			const saveScriptEnv = useCallback(async () => {
				if (envDialog === null || envDialog.status !== "ready" || envDialog.saving === true) return;
				const text = upsertEnvValues(envDialog.content ?? "", envDialog.values ?? {});
				setEnvDialog(Object.assign({}, envDialog, { saving: true, saveError: undefined }));
				const result = await call("projectWriteFile", envDialog.path, text);
				setEnvDialog(
					result.ok
						? Object.assign({}, envDialog, { saving: false, saved: true, missing: false, content: text, saveError: undefined })
						: Object.assign({}, envDialog, { saving: false, saved: undefined, saveError: result.error }),
				);
			}, [envDialog]);

			/**
			 * 运行前先问 host：脚本真正在哪一层、那一层的 .env 缺哪几个键。
			 * 缺键就只亮提示（附「去维护环境变量」按钮），不弹执行确认 —— 否则脚本
			 * 一定以登录失败或找不到工程结束，白跑一趟。
			 */
			const run = useCallback(async () => {
				const cwd = dir.trim();
				const name = script.trim();
				if (cwd === "" || name === "") return;
				const argv = args.trim() === "" ? [] : args.trim().split(/\s+/);
				setLast({ script: name, args: argv });
				setBlock(null);
				const probe = await call("projectResolveScript", name, cwd);
				if (!probe.ok) {
					setBlock({ kind: "error", error: probe.error });
					return;
				}
				const info = probe.value !== null && typeof probe.value === "object" ? probe.value : {};
				const missing = Array.isArray(info.missing) ? info.missing : [];
				if (missing.length > 0) {
					setBlock({
						kind: "env",
						missing: missing,
						envPath: typeof info.envPath === "string" ? info.envPath : "",
						scriptDir: typeof info.scriptDir === "string" ? info.scriptDir : "",
					});
					return;
				}
				runner.request({
					script: name,
					args: argv,
					name: "运行 " + name,
					kind: kindOfScript(name),
					cwd: cwd,
				});
			}, [dir, script, args, runner]);

			return h(
				"div",
				{ style: gridStyle },
				h(
					"div",
					{ style: Object.assign({}, muted, wrapStyle) },
					"只允许工作区根目录下的 source-*.js，用宿主自带的 node 执行（shell: false，stdout 超 400000 字符会被中止）。执行前会弹出确认框，执行后按脚本名自动收尾：下拉类清空推送记录，推送类在项目树里点 ↑ 推送时才会自动标记目标。",
				),
				h("span", { className: "dshml-grow" }, h(UI.Input, { value: dir, onChange: (event) => setDir(event.target.value), placeholder: "工作区绝对路径（脚本可在这一层，也可在工作区根）" })),
				h(
					"div",
					{ style: Object.assign({}, rowStyle, { flexWrap: "wrap" }) },
					SCRIPT_PRESETS.map((preset) => h(UI.Pill, { key: preset.script, active: preset.script === script, onClick: () => setScript(preset.script) }, preset.label)),
				),
				h(
					"div",
					{ style: rowStyle },
					h("span", { className: "dshml-grow" }, h(UI.Input, { value: script, onChange: (event) => setScript(event.target.value), placeholder: "source-xxx.js" })),
					h("span", { className: "dshml-grow" }, h(UI.Input, { value: args, onChange: (event) => setArgs(event.target.value), placeholder: "参数（空格分隔，可留空）" })),
					h(UI.Button, { variant: "primary", onClick: run }, "运行…"),
				),
				block === null
					? null
					: block.kind === "error"
						? h("div", { style: warnStyle }, "✗ " + block.error)
						: h(
								"div",
								{ style: gridStyle },
								h(
									"div",
									{ style: warnStyle },
									"⚠ 环境变量未维护：" +
										(block.envPath === "" ? "脚本所在目录" : block.envPath) +
										" 缺少 " +
										block.missing.join("、") +
										"。先把这几个键补上，再运行 " +
										script.trim() +
										" —— 否则脚本会以登录失败或找不到工程结束。",
								),
								h(
									"div",
									{ style: rowStyle },
									h(
										UI.Button,
										{
											variant: "primary",
											onClick: () => openEnvEditor(block.envPath !== "" ? block.envPath : dir.trim().replace(/[\\/]+$/, "") + "\\.env"),
										},
										"去维护环境变量",
									),
								),
							),
				last === null ? null : h("div", { style: muted }, "最近一次：" + last.script + (last.args.length > 0 ? " " + last.args.join(" ") : "")),
				last === null || runner.result === null || runner.result.name !== "运行 " + last.script
					? null
					: h("pre", { style: preStyle }, runner.result.output === "" ? runner.result.error ?? "" : runner.result.output),
				h(EnvDialog, { state: envDialog, fields: SCRIPT_ENV_FIELDS, onChange: changeScriptEnv, onSave: saveScriptEnv, onClose: () => setEnvDialog(null) }),
			);
		}

		/* ---------------------------------------------------------- 面板外壳 */

		/**
		 * 面板外壳：顶部一行工程模式开关，下面就是工程浏览器本体 —— 左侧常驻项目树、
		 * 右侧详情区。详情页签的状态刻意放在**第一个 useState** 上：渲染层桩检靠
		 * 「本次渲染的第 1 次 useState 可被覆盖」来逐个页签渲染，挪动它会让
		 * test/render-check.mjs 整节失败。
		 *
		 * 初值从 localStorage 恢复（0.2.15）：切走再回来时右栏停在同一页签，
		 * 而不是每次都弹回「文件内容」。
		 */
		function Panel(props) {
			const inputActions = props === undefined ? undefined : props.inputActions;
			const [detail, setDetail] = useState(() => {
				const remembered = readStoredPath(DETAIL_KEY);
				return remembered === "" ? "content" : remembered;
			});
			useEffect(() => {
				writeStored(DETAIL_KEY, detail);
			}, [detail]);
			/** 浏览器内共用一个脚本执行器：一次只可能有一个待确认/结果弹窗。 */
			const runner = useScriptRunner();
			return h(
				PaneBoundary,
				null,
				h(
					"div",
					{ style: gridStyle },
					h("style", null, BROWSER_CSS),
					h(ProjectModeRow),
					h(TreeTab, { runner: runner, detail: detail, onDetail: setDetail, inputActions: inputActions }),
					h(ScriptDialog, { runner: runner }),
				),
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
				// UI.Modal 的对话框元素自带固定宽度（实测 380px）且不随内容伸展、还把溢出裁掉，
				// 所以只给子节点写宽度没用。className 落到对话框本身（实测挂上的是
				// `_dialog_xxx dshml-wide`），再用 <style> 把宽度改掉；子节点用 100% 而不是
				// 再写一遍像素宽度 —— 再写一遍会超出对话框内边距那一段，行尾按钮被裁。
				h("style", null, ".dshml-wide{width:min(900px,88vw)}"),
				h(UI.Button, { size: "icon", title: T("entry.title"), onClick: () => setOpen(true) }, "▤"),
				h(
					UI.Modal,
					{ open: open, onClose: () => setOpen(false), title: T("entry.title"), className: "dshml-wide" },
					h("div", { style: { width: "100%" } }, h(Panel)),
				),
			);
		}

		/**
		 * 会话页签里的工程视图（conversation.view）：与设置页、侧栏浮层共用同一个
		 * 自包含面板。会话区的宽度由宿主给，所以这里只管纵向留白。
		 */
		function ProjectView(props) {
			return h(
				"div",
				{ style: Object.assign({}, gridStyle, { padding: "8px 4px" }) },
				h(Panel, { inputActions: props === undefined ? undefined : props.inputActions }),
			);
		}

		/* ---------------------------------------------------------- 插件入口 */

		/**
		 * cordis 服务注入。只依赖 slots —— RPC 走同源 fetch 信封（见 call），
		 * 不需要 remote 服务，也就不需要构建期生成的 typed contribution。
		 * locale 刻意**不**写进这里（见 apply 里的说明）。
		 */
		const inject = ["slots"];

		async function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			/*
			 * locale 走「有就用」：不写进 inject，因为 inject 是硬依赖 ——
			 * 某个环境没装 locale 服务时插件会整个不 apply，而这里最坏只是
			 * 标签停留在内置中文。
			 */
			try {
				const locale = ctx.get("locale");
				if (locale !== undefined && locale !== null && typeof locale.register === "function" && typeof locale.bind === "function") {
					locale.register(NS, MESSAGES);
					T = locale.bind(NS);
				}
			} catch (error) {
				/* 取不到 locale 服务：继续用内置中文 */
			}
			slots.inject("settings.section", () =>
				slots.register({ name: "settings.section", id: ENTRY_ID, order: 100, locale: NS, label: () => T("entry.title") }, SettingsSection),
			);
			slots.inject("sidebar.footer.action", () =>
				slots.register({ name: "sidebar.footer.action", id: ENTRY_ID, order: 100 }, SidebarAction),
			);
			/*
			 * 会话页签（conversation.view）按工程模式动态挂载/摘除。ctx.effect 把
			 * 事件监听与 disposer 都挂在本插件 fiber 上：插件卸载、或用户在面板里
			 * 关掉工程模式时，页签都会随之消失。
			 */
			if (typeof ctx.effect !== "function") return;
			ctx.effect(() => {
				let dispose = null;
				const sync = () => {
					if (typeof dispose === "function") dispose();
					dispose = null;
					if (!readProjectMode()) return;
					dispose = slots.inject("conversation.view", () =>
						slots.register(
							{ name: "conversation.view", id: ENTRY_ID, order: 20, locale: NS, label: () => T("view.project") },
							ProjectView,
						),
					);
				};
				sync();
				const off = subscribeProjectMode(sync);
				return () => {
					if (typeof off === "function") off();
					if (typeof dispose === "function") dispose();
					dispose = null;
				};
			}, "dsh-magical-lowcode-project: conversation view");
		}

		return { apply: apply, inject: inject };
	},
});
