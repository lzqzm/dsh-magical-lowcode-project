/**
 * dsh-project-panel — 编辑器分片的源码。
 *
 * 这一份**不直接跑**，要用 esbuild 打成 `lib/client.editor.js`：
 *
 *     npm run build:editor
 *
 * 为什么要绕这一道：本插件的 client 半边是宿主 __ModuleLoader__ 下的经典 script，
 * factory 里的 require 只认种子表那 9 个说明符，CodeMirror 这种第三方代码**必须
 * 内联进 bundle**。把它单独内联成一份、按需 require.async 加载，主 bundle
 * lib/client.js 才能继续手写、改完刷新就生效。
 *
 * 注册契约（实测 dsh-client-modules 0.2.0-rc.2 的 client.js:569-581、707-742）：
 *   - id     必须是**包名**（owner）—— 宿主自己用 chunkId() 拼内部 key，写成
 *            "包名/文件名" 会被当成第二个入口，把主 bundle 顶掉。
 *   - chunk  就是文件名，必须匹配 /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/。
 *   - 分片必须自包含：不能再 require 另一个相对 client*.js 产物。
 *   - 宿主按 /plugins/<包名>/client.<name>.js?rev=<rev> 现场取文件，不扫描也不预加载。
 *
 * 一个已知的取舍：esbuild 是静态打包，CM 的 import 会被提到**顶层**，也就是脚本
 * 一加载就执行，早于 factory 被调用。CM6 的包在 import 时只定义类和纯对象（不碰
 * DOM），所以安全；要是哪天它变了，症状是「点编辑时页面报错」，很容易定位。
 */
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";

/** 分片自称的版本；改动这个文件时一起改，方便在弹窗里认出旧缓存。 */
const VERSION = "0.2.0";

/**
 * 扩展名 → 语言扩展。认不出来的（.env、.txt、无后缀…）当纯文本，不给扩展。
 * 语言包是静态 import，所以全都进了 bundle；这也意味着新增语言要重新 build。
 */
function languageFor(path) {
	const name = String(path ?? "").toLowerCase();
	const dot = name.lastIndexOf(".");
	const ext = dot < 0 ? "" : name.slice(dot + 1);
	switch (ext) {
		case "js":
		case "mjs":
		case "cjs":
		case "jsx":
			return javascript({ jsx: true });
		case "ts":
		case "tsx":
			return javascript({ jsx: true, typescript: true });
		case "json":
		case "jsonc":
			return json();
		case "html":
		case "htm":
			return html();
		case "css":
			return css();
		case "md":
		case "markdown":
			return markdown();
		case "py":
		case "pyw":
			return python();
		default:
			return [];
	}
}

/**
 * 让编辑器融进面板：去掉自身边框与聚焦描边（外层 CSS 已经有边框了），
 * 字体和行高跟「选行」视图保持一致，免得两种模式看起来像两个东西。
 */
const panelTheme = EditorView.theme({
	"&": { height: "100%", fontSize: "12px" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": {
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
		lineHeight: "1.55",
	},
	".cm-content": { padding: "12px 0" },
	".cm-gutters": { border: "none" },
});

/**
 * 1 基行号 → 文档内光标位置。
 *
 * 行号是外面给的（搜索结果），文件可能在搜索之后被改短了，所以夹到
 * `[1, doc.lines]` —— 越界不该抛异常，顶多停在最后一行。
 */
function caretAtLine(doc, line) {
	const total = doc.lines;
	const target = Math.min(Math.max(1, Math.floor(line)), total);
	return doc.line(target).from;
}

/**
 * 把光标挪到第 `line` 行并滚到视口中间（行号 <= 0 / 非数字时什么都不做）。
 *
 * 只动 selection、不动 doc，所以不会触发 onChange —— 「跳过去看一眼」不该被
 * 记成一次编辑。
 */
function revealLine(view, line) {
	const wanted = Number(line);
	if (!Number.isFinite(wanted) || wanted <= 0) return;
	const pos = caretAtLine(view.state.doc, wanted);
	view.dispatch({
		selection: { anchor: pos },
		effects: EditorView.scrollIntoView(pos, { y: "center" }),
	});
}

/**
 * 把一个 DOM 容器变成代码编辑器。
 *
 * @param parent  挂载点（会被 CM 接管内部 DOM，调用方不要往里塞别的东西）。
 * @param options `{ path, doc, line, onChange }` —— path 决定语言，line 是打开时要
 *                落到的**1 基行号**（0/缺省 = 停在文档开头），onChange 每次改动回调。
 * @returns 一个受控句柄：`{ getValue, setValue, revealLine, focus, destroy }`。
 */
function createEditor(parent, options = {}) {
	const onChange = typeof options.onChange === "function" ? options.onChange : null;
	const view = new EditorView({
		doc: typeof options.doc === "string" ? options.doc : "",
		parent,
		extensions: [
			basicSetup,
			languageFor(options.path),
			panelTheme,
			EditorView.lineWrapping,
			/* 宿主面板里没有全局保存快捷键，这里只把改动交回调用方，不做落盘。 */
			EditorView.updateListener.of((update) => {
				if (update.docChanged && onChange !== null) onChange(update.state.doc.toString());
			}),
		],
	});
	revealLine(view, options.line);
	return {
		getValue: () => view.state.doc.toString(),
		setValue: (text) => {
			const next = typeof text === "string" ? text : "";
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
		},
		revealLine: (line) => revealLine(view, line),
		focus: () => view.focus(),
		destroy: () => view.destroy(),
	};
}

window.__ModuleLoader__.load({
	id: "dsh-project-panel",
	chunk: "client.editor.js",
	factory: () => {
		"use strict";
		return { probe: "editor-chunk-ok", version: VERSION, createEditor, languageFor };
	},
});
