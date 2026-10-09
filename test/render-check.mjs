#!/usr/bin/env node
/**
 * dsh-magical-lowcode-project 客户端半边 · 渲染层桩检。
 *
 * 为什么需要它：`client-stub-check.mjs` 证明了「apply() 注册了什么」，但注册的
 * 组件函数**一次都没有被调用过**——也就是说面板到底能不能渲染出东西、五个页签
 * 是不是都画得出来、页签切换之外的入口结构对不对，之前无人验证。真机浏览器检查
 * （`browser-check.mjs`）在拒绝启动浏览器进程的机器上跑不了，于是中间这一层只能
 * 靠桩 React 顶。
 *
 * 做法：把桩 `react` 的 `useState` 做成「本次渲染的第 1 次调用可被覆盖」。由于
 * `Panel()` 一定是渲染树里第一个被调用的组件、它的第 1 个 hook 就是 `useState(active)`，
 * 这样就可以把 active 依次设成五个页签的 key，把**每个页签**都真正渲染一遍，
 * 而不需要真实的 react-dom。
 *
 * 这个脚本零第三方依赖（React 是桩），所以可以直接挂进 `npm test` 与 CI。
 *
 * 用法：node test/render-check.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const passes = [];
const infos = [];
const fail = (m) => failures.push(m);
const pass = (m) => passes.push(m);
const info = (m) => infos.push(m);
const read = (rel) => readFileSync(join(root, rel), "utf8");

/* ------------------------------------------------- 1. 以经典 script 执行 bundle */

const clientSource = read("lib/client.js");
const captured = {};
const store = new Map();
const sandbox = {
	window: {
		__ModuleLoader__: {
			load(registration) {
				captured.registration = registration;
			},
		},
		localStorage: {
			getItem: (key) => (store.has(key) ? store.get(key) : null),
			setItem: (key, value) => store.set(key, String(value)),
		},
	},
};
createContext(sandbox);
try {
	runInContext(clientSource, sandbox, { filename: "lib/client.js" });
} catch (error) {
	fail(`以经典 script 方式执行 lib/client.js 抛错：${error?.message ?? error}`);
}
const registration = captured.registration;
if (registration === undefined) fail("lib/client.js 没有调用 window.__ModuleLoader__.load(...)");

/* --------------------------------------------------------- 2. 桩 react（可覆盖） */

/** 本次渲染是否要把第 1 次 useState 的初始值替换掉（用来拨动 Panel 的 active）。 */
let activeOverride;
let useStateCallIndex = 0;
/** 当前正在执行的组件名与它内部的第几次 useState —— 用来定点覆盖某个状态（0.2.20 起）。 */
let currentComponent = "";
let componentCallIndex = 0;
/** 形如 { "TreeTab#4": <初值> } 的定点覆盖表：把某个组件的某个状态直接摆成目标值。 */
let stateOverrides;
const reactStub = {
	createElement: (type, props, ...children) => ({ __element: true, type, props: props ?? {}, children }),
	useState: (initial) => {
		useStateCallIndex += 1;
		componentCallIndex += 1;
		const fallback = typeof initial === "function" ? initial() : initial;
		if (stateOverrides !== undefined && Object.prototype.hasOwnProperty.call(stateOverrides, currentComponent + "#" + componentCallIndex)) {
			return [stateOverrides[currentComponent + "#" + componentCallIndex], () => {}];
		}
		const value = useStateCallIndex === 1 && activeOverride !== undefined ? activeOverride : fallback;
		return [value, () => {}];
	},
	useCallback: (fn) => fn,
	useRef: (initial) => ({ current: initial === undefined ? null : initial }),
	useEffect: () => {},
	Fragment: Symbol("Fragment"),
	/* 面板级错误边界是个 class 组件（PaneBoundary extends React.Component）。 */
	Component: class Component {
		constructor(props) {
			this.props = props ?? {};
			this.state = {};
		}
		setState(next) {
			this.state = Object.assign({}, this.state, typeof next === "function" ? next(this.state) : next);
		}
	},
};
const primitivesStub = { Button: "UI.Button", Input: "UI.Input", Modal: "UI.Modal", Pill: "UI.Pill", Tag: "UI.Tag" };
const requireStub = (specifier) => {
	if (specifier === "react") return reactStub;
	if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
	throw new Error(`桩 require 收到预期外的说明符：${specifier}`);
};

/* --------------------------------------------- 3. apply 一遍，截下两个注册组件 */

function makeCtx(options = {}) {
	const registers = [];
	const slots = {
		inject(key, callback) {
			const disposer = callback();
			return typeof disposer === "function" ? disposer : () => {};
		},
		register(contribution, component) {
			registers.push({ contribution, component });
			return () => {};
		},
	};
	const ctx = {
		remote: {
			async $mount() {
				return () => {};
			},
		},
		get(name) {
			if (name === "slots") return slots;
			if (name === "remote.desktopProject") return { __rpc: true };
			if (name === "locale" && options.locale !== undefined) return options.locale;
			return undefined;
		},
		effect(execute) {
			const disposer = execute();
			return typeof disposer === "function" ? disposer : () => {};
		},
	};
	return { ctx, registers };
}

let exported;
let components = new Map();
if (registration?.factory !== undefined) {
	try {
		exported = registration.factory(requireStub);
	} catch (error) {
		fail(`factory(require) 执行抛错：${error?.message ?? error}`);
	}
	if (exported !== undefined && exported !== null) {
		const probe = makeCtx();
		try {
			await exported.apply(probe.ctx);
			components = new Map(probe.registers.map((r) => [r.contribution?.name, r.component]));
		} catch (error) {
			fail(`apply(ctx) 执行抛错：${error?.message ?? error}`);
		}
	}
}
const SettingsSection = components.get("settings.section");
const SidebarAction = components.get("sidebar.footer.action");
const ProjectView = components.get("conversation.view");
if (typeof SettingsSection !== "function") fail("没能从 settings.section 截获组件函数");
if (typeof SidebarAction !== "function") fail("没能从 sidebar.footer.action 截获组件函数");
if (typeof ProjectView !== "function") fail("没能从 conversation.view 截获组件函数");

/* ------------------------------------------------------------------ 4. 渲染器 */

/**
 * 递归求值元素树：函数组件就地调用，宿主元素（含桩基元的字符串类型）保留结构。
 * 桩 useState 只在「本次渲染的第 1 次调用」上可能被覆盖，后续调用都返回真初始值。
 */
function render(element, depth = 0) {
	if (depth > 400) throw new Error("渲染树超过 400 层，疑似无限递归");
	if (element === null || element === undefined || element === true || element === false) return null;
	const kind = typeof element;
	if (kind === "string" || kind === "number") return { kind: "text", text: String(element) };
	if (Array.isArray(element)) {
		const children = [];
		for (const child of element) {
			const rendered = render(child, depth + 1);
			if (rendered !== null) children.push(rendered);
		}
		return { kind: "list", children };
	}
	if (kind === "object" && element.__element === true) {
		const { type, props, children } = element;
		if (typeof type === "function") {
			const name = type.name === "" ? "<anonymous>" : type.name;
			/*
			 * 类组件（面板级错误边界 PaneBoundary）：桩里 new 出实例再取 render()。
			 * 真 React 的「抛错就切错误态」桩模拟不了，这里只需要它把 children 透出来。
			 */
			const isClass = type.prototype !== undefined && typeof type.prototype.render === "function";
			/*
			 * 真 React 会把尾巴参数折进 props.children；桩也得还原这一点，
			 * 否则类组件里读 this.props.children 会拿到 undefined。
			 */
			const withChildren = Object.assign({}, props, { children: children.length <= 1 ? children[0] : children });
			/* 换组件时把「组件内第几次 useState」归零，渲染完再恢复外层计数（栈式）。 */
			const outerName = currentComponent;
			const outerIndex = componentCallIndex;
			currentComponent = name;
			componentCallIndex = 0;
			let produced;
			try {
				produced = isClass ? new type(withChildren).render() : type(withChildren);
			} finally {
				currentComponent = outerName;
				componentCallIndex = outerIndex;
			}
			return { kind: "component", name, props, inner: render(produced, depth + 1) };
		}
		const kids = [];
		for (const child of children ?? []) {
			const rendered = render(child, depth + 1);
			if (rendered !== null) kids.push(rendered);
		}
		return { kind: "host", name: String(type), props, children: kids };
	}
	return { kind: "unknown", value: String(element) };
}

/** 深度优先收集整棵树里的节点。 */
function walk(node, visit) {
	if (node === null || node === undefined) return;
	visit(node);
	if (node.kind === "list") for (const child of node.children) walk(child, visit);
	if (node.kind === "component") walk(node.inner, visit);
	if (node.kind === "host") for (const child of node.children) walk(child, visit);
}

/** 取一个子树的纯文本（用来断言页签标签之类）。 */
function textOf(node) {
	let out = "";
	walk(node, (n) => {
		if (n.kind === "text") out += n.text;
	});
	return out;
}

/** 拨动 active 后渲染一次设置页入口。 */
function renderSettings(tabKey) {
	useStateCallIndex = 0;
	currentComponent = "";
	componentCallIndex = 0;
	activeOverride = tabKey;
	try {
		return render(reactStub.createElement(SettingsSection, {}));
	} finally {
		activeOverride = undefined;
	}
}

/**
 * 定点覆盖某些状态后渲染设置页（0.2.20 起）。
 * overrides 形如 { "TreeTab#4": <值> } —— 组件名 + 该组件内第几次 useState。
 * 有了它，「文件已经打开」这种中间态才能被真正渲染出来（桩 useState 不会自己改值）。
 */
function renderSettingsWith(overrides, tabKey = "content") {
	useStateCallIndex = 0;
	currentComponent = "";
	componentCallIndex = 0;
	activeOverride = tabKey;
	stateOverrides = overrides;
	try {
		return render(reactStub.createElement(SettingsSection, {}));
	} finally {
		activeOverride = undefined;
		stateOverrides = undefined;
	}
}

/** 不拨动 active，渲染侧边栏入口。 */
function renderSidebar() {
	useStateCallIndex = 0;
	currentComponent = "";
	componentCallIndex = 0;
	activeOverride = undefined;
	return render(reactStub.createElement(SidebarAction, {}));
}

/**
 * 渲染会话页签（conversation.view）并把宿主注入的 props 一起递进去（0.2.23）。
 * 宿主会给会话作用域的 slot 组件塞 `inputActions`（captureInsertion / insertText / …），
 * 这里就是把它接上，看「引用到输入框」到底有没有真写进输入框。
 */
function renderProjectView(props, overrides) {
	useStateCallIndex = 0;
	currentComponent = "";
	componentCallIndex = 0;
	activeOverride = "content";
	stateOverrides = overrides;
	try {
		return render(reactStub.createElement(ProjectView, props ?? {}));
	} finally {
		activeOverride = undefined;
		stateOverrides = undefined;
	}
}

/* ------------------------------- 5. 设置页：工程浏览器（左树常驻 + 右栏五页签） */

/**
 * 右栏详情页签。顺序必须与 lib/client.js 的 `DETAIL_TABS` 一致；`render` 是
 * 该页签应当渲染出来的组件名（左树 TreeTab 在任何页签下都常驻，单独断言）。
 */
const TABS = [
	{ key: "content", label: "文件内容", render: "TreeTab" },
	{ key: "preview", label: "体检与预览", render: "PreviewTab" },
	{ key: "push", label: "推送状态", render: "PushTab" },
	{ key: "script", label: "工程脚本", render: "ScriptTab" },
	{ key: "preset", label: "预设包", render: "PresetTab" },
];
/** 页签 Pill 的标签集合：脚本页签里还有一组快捷脚本 Pill，用标签把两组分开。 */
const TAB_LABELS = new Set(TABS.map((t) => t.label));

if (typeof SettingsSection === "function") {
	let firstTree;
	for (const tab of TABS) {
		let tree;
		try {
			tree = renderSettings(tab.key);
			if (tab.key === "content") firstTree = tree;
		} catch (error) {
			fail(`active="${tab.key}" 时渲染设置页抛错：${error?.message ?? error}`);
			continue;
		}
		if (tree === null) {
			fail(`active="${tab.key}" 时渲染结果是 null`);
			continue;
		}
		const pills = [];
		const hosts = new Set();
		walk(tree, (n) => {
			if (n.kind === "host") {
				hosts.add(n.name);
				/* 只认页签 Pill；脚本页签里的快捷脚本 Pill 由下面的专项断言负责。 */
				if (n.name === primitivesStub.Pill && TAB_LABELS.has(textOf(n))) pills.push(n);
			}
		});
		if (pills.length !== TABS.length) {
			fail(`active="${tab.key}" 时页签按钮应有 ${TABS.length} 个，实际 ${pills.length} 个`);
			continue;
		}
		const labels = pills.map((p) => textOf(p));
		if (labels.join("|") !== TABS.map((t) => t.label).join("|")) {
			fail(`页签标签顺序不对：实际 [${labels.join(", ")}]`);
			continue;
		}
		pass(`设置页 active="${tab.key}" 渲染成功（${hosts.size} 种宿主元素，页签 ${labels.join("/")}）`);

		if (tab.key === "script") {
			const quick = [];
			walk(tree, (n) => {
				if (n.kind === "host" && n.name === primitivesStub.Pill && !TAB_LABELS.has(textOf(n))) quick.push(textOf(n));
			});
			if (quick.length !== 6) fail(`脚本页签应有 6 个快捷脚本入口，实际 ${quick.length} 个`);
			else pass(`脚本页签渲染出 6 个快捷脚本入口（${quick.join("/")}）`);
		}

		/* 左树常驻，右栏渲染当前页签自己的组件，而不是空白。 */
		const tabNodes = [];
		walk(tree, (n) => {
			if (n.kind === "component" && n.name !== "SettingsSection" && n.name !== "Panel") tabNodes.push(n.name);
		});
		if (tabNodes.length === 0) fail(`active="${tab.key}" 时没有任何页签组件被渲染`);
		else if (!tabNodes.includes("TreeTab")) fail(`左树应当常驻渲染 TreeTab，实际渲染了 [${tabNodes.join(", ")}]`);
		else if (!tabNodes.includes(tab.render)) fail(`active="${tab.key}" 时右栏应当渲染 ${tab.render}，实际渲染了 [${tabNodes.join(", ")}]`);
		else pass(`active="${tab.key}" 时左树常驻 + 右栏渲染 ${tab.render}`);
	}

	/* 首屏默认落在「文件内容」：不拨动 detail 时左树 + 文件内容区应当都在。 */
	if (firstTree !== null) {
		let natural;
		try {
			useStateCallIndex = 0;
			activeOverride = undefined;
			natural = render(reactStub.createElement(SettingsSection, {}));
		} catch (error) {
			fail(`不拨动 active 时渲染抛错：${error?.message ?? error}`);
		}
		if (natural !== undefined && natural !== null) {
			const names = [];
			walk(natural, (n) => {
				if (n.kind === "component") names.push(n.name);
			});
			if (!names.includes("TreeTab")) fail(`默认渲染没有出现 TreeTab（实际 [${names.join(", ")}]）`);
			else if (names.includes("PreviewTab") || names.includes("PushTab") || names.includes("ScriptTab") || names.includes("PresetTab")) {
				fail(`默认右栏应当只渲染文件内容区，实际 [${names.join(", ")}]`);
			} else pass("不拨动 detail 时默认渲染左树 + 文件内容区（首屏与 active=\"content\" 一致）");
		}
	}
}

/* ------------------------------------------------------ 6. 侧边栏入口结构 */

if (typeof SidebarAction === "function") {
	let tree;
	try {
		tree = renderSidebar();
	} catch (error) {
		fail(`渲染侧边栏入口抛错：${error?.message ?? error}`);
	}
	if (tree !== undefined && tree !== null) {
		const hosts = [];
		const comps = [];
		walk(tree, (n) => {
			if (n.kind === "host") hosts.push(n);
			if (n.kind === "component") comps.push(n.name);
		});
		const button = hosts.find((n) => n.name === primitivesStub.Button);
		const modal = hosts.find((n) => n.name === primitivesStub.Modal);
		if (button === undefined) fail("侧边栏入口没有渲染出 Button");
		else {
			if (button.props.title !== "低代码工程模式") fail(`侧边栏按钮 title 应为「低代码工程模式」，实际 ${JSON.stringify(button.props.title)}`);
			else pass(`侧边栏入口渲染出 Button（title="${button.props.title}"）`);
			if (typeof button.props.onClick !== "function") fail("侧边栏按钮的 onClick 不是函数");
			else pass("侧边栏按钮的 onClick 是可调用函数");
		}
		if (modal === undefined) fail("侧边栏入口没有渲染出 Modal");
		else {
			if (modal.props.open !== false) fail(`Modal 初始 open 应为 false，实际 ${JSON.stringify(modal.props.open)}`);
			else pass("侧边栏 Modal 初始 open=false（点击后才展开）");
			if (!comps.includes("Panel")) fail("Modal 里没有渲染 Panel");
			else pass("侧边栏 Modal 内嵌 Panel（同一面板的浮层副本）");
		}
	}
}

/* ---------------------------------------------- 7. 工程模式开关 → 会话页签 */

const MODE_KEY = "dsh-magical-lowcode-project:project-mode";

if (!components.has("conversation.view")) {
	fail("默认应当注册 conversation.view（工程模式默认开启）");
} else {
	pass("默认注册 conversation.view（工程模式默认开启）");
	const ProjectView = components.get("conversation.view");
	if (typeof ProjectView === "function") {
		try {
			useStateCallIndex = 0;
			activeOverride = undefined;
			const tree = render(reactStub.createElement(ProjectView, {}));
			const names = [];
			walk(tree, (n) => {
				if (n.kind === "component") names.push(n.name);
			});
			if (!names.includes("Panel")) fail("会话视图里没有渲染 Panel");
			else pass("会话视图渲染出 Panel（与设置页共用同一个面板）");
			if (!names.includes("TreeTab")) fail("会话视图首屏没有渲染出工程浏览器的左树");
			else pass("会话视图首屏渲染出左树 + 文件内容区（默认页签）");
			const texts = textOf(tree);
			if (!texts.includes("工程模式：开")) fail(`会话视图没有渲染工程模式开关行（文本：${texts.slice(0, 80)}）`);
			else pass("会话视图顶部渲染出「工程模式：开」开关行");
		} catch (error) {
			fail(`渲染会话视图抛错：${error?.message ?? error}`);
		}
	}
}

{
	store.set(MODE_KEY, "off");
	const probe = makeCtx();
	try {
		await exported.apply(probe.ctx);
	} catch (error) {
		fail(`工程模式关闭时 apply 抛错：${error?.message ?? error}`);
	}
	const names = probe.registers.map((r) => r.contribution?.name);
	if (names.includes("conversation.view")) fail("工程模式关闭后仍然注册了 conversation.view");
	else pass("工程模式关闭后不再注册 conversation.view（其余两个入口不受影响）");
	if (!names.includes("settings.section") || !names.includes("sidebar.footer.action")) {
		fail(`工程模式关闭时两个固定入口丢了（实际 [${names.join(", ")}]）`);
	} else pass("工程模式关闭时 settings.section 与 sidebar.footer.action 仍在");
	store.delete(MODE_KEY);
}

/* ------------------------------------------------- 8. locale 服务存在时换绑 */

{
	const registered = [];
	const bound = [];
	const localeStub = {
		register(ns, messages) {
			registered.push({ ns, messages });
		},
		bind(ns) {
			bound.push(ns);
			return (key) => `en:${key}`;
		},
	};
	const probe = makeCtx({ locale: localeStub });
	try {
		await exported.apply(probe.ctx);
	} catch (error) {
		fail(`带 locale 服务时 apply 抛错：${error?.message ?? error}`);
	}
	const entry = registered.find((r) => r.ns === "dsh-magical-lowcode-project");
	if (entry === undefined) {
		fail("apply 没有向 locale 注册本插件的命名空间与字典");
	} else {
		const zh = entry.messages?.zh ?? {};
		const en = entry.messages?.en ?? {};
		const missing = Object.keys(zh).filter((key) => en[key] === undefined);
		if (Object.keys(zh).length === 0) fail("中文字典是空的");
		else if (missing.length > 0) fail(`英文字典缺 ${missing.length} 条：${missing.slice(0, 6).join(", ")}`);
		else pass(`locale 注册命名空间（zh/en 各 ${Object.keys(zh).length} / ${Object.keys(en).length} 条，键一一对应）`);
	}
	if (bound.length === 0) {
		fail("apply 没有调用 locale.bind");
	} else {
		const section = probe.registers.find((r) => r.contribution?.name === "settings.section");
		const sectionLabel = section?.contribution?.label;
		const sectionText = typeof sectionLabel === "function" ? sectionLabel() : sectionLabel;
		if (sectionText !== "en:entry.title") fail(`settings.section 的 label 没跟着 locale 换绑（实际 ${JSON.stringify(sectionText)}）`);
		else pass("settings.section 的 label 跟着 locale 换绑（函数型 label + locale: NS）");
		const view = probe.registers.find((r) => r.contribution?.name === "conversation.view");
		const viewLabel = view?.contribution?.label;
		const viewText = typeof viewLabel === "function" ? viewLabel() : viewLabel;
		if (viewText !== "en:view.project") fail(`conversation.view 的 label 没跟着 locale 换绑（实际 ${JSON.stringify(viewText)}）`);
		else pass("conversation.view 的 label 跟着 locale 换绑");
	}
}

/* ------------------------------------------------- 7. 面板样式表的布局陷阱 */

/**
 * 0.2.8 用 `flex: 1 1 480px` 让输入框吃掉剩余宽度，结果在纵向容器（gridStyle 那一类）里
 * 被当成高度基准，把环境配置弹窗的标签与输入框拉得极开。这里把「横向撑开」与「纵向字段」
 * 两套规则钉住，避免再犯。
 */
{
	const grow = /\.dshml-grow\{([^}]*)\}/.exec(clientSource);
	if (grow === null) fail("样式表里没有 .dshml-grow 规则");
	else if (/flex:1 1 480px/.test(grow[1])) fail(".dshml-grow 仍带 flex-basis 480px（在纵向容器里会撑高整行）");
	else if (!/flex:1 1 auto/.test(grow[1])) fail(`.dshml-grow 的 flex 简写不是 1 1 auto（实际 ${JSON.stringify(grow[1])}）`);
	else pass(".dshml-grow 用 flex:1 1 auto（横向撑开、纵向不撑高）");

	if (!/\.dshml-field\{/.test(clientSource)) fail("样式表里没有 .dshml-field 规则（纵向字段）");
	else if (!/className: "dshml-field"/.test(clientSource)) fail("没有组件使用 .dshml-field");
	else pass(".dshml-field 纵向字段规则存在且被 EnvDialog 使用");

	if (!/\.dshml-dirty\{/.test(clientSource)) fail("样式表里没有 .dshml-dirty 规则（待推送标红）");
	else if (!/const statusTag = /.test(clientSource)) fail("没有 statusTag 助手（状态 Tag 标红）");
	else pass("待推送状态标红（.dshml-dirty + statusTag）");
}

/* ------------------------------------------- 9. 运行前的环境变量预检（0.2.14） */

/**
 * 用户诉求：点「运行…」时如果环境变量没维护，先提示去维护，而不是让脚本白跑一趟。
 * 钉住四件事：① 运行前先问 host 脚本落在哪一层、缺哪些键；② 缺键时只亮提示；
 * ③ 提示里给出「去维护环境变量」入口；④ 那个入口编辑的是脚本目录 .env 的四个键。
 */
{
	if (!/call\("projectResolveScript"/.test(clientSource)) fail("ScriptTab 运行前没有调用 projectResolveScript（无法提前发现环境变量缺失）");
	else pass("点「运行…」先调 projectResolveScript 预检");

	if (!/环境变量未维护/.test(clientSource)) fail("缺少「环境变量未维护」的提示文案");
	else pass("缺键时提示「环境变量未维护」");

	if (!/去维护环境变量/.test(clientSource)) fail("提示里没有「去维护环境变量」入口");
	else pass("提示里给出「去维护环境变量」入口");

	if (!/const SCRIPT_ENV_FIELDS = \[/.test(clientSource) || !/key: "USERNAME"/.test(clientSource) || !/key: "PASSWORD"/.test(clientSource)) {
		fail("SCRIPT_ENV_FIELDS 未定义或缺少 USERNAME / PASSWORD");
	} else pass("脚本目录 .env 的四个键有独立字段表 SCRIPT_ENV_FIELDS");

	if (!/function EnvDialog\(\{ state, onChange, onSave, onClose, fields \}\)/.test(clientSource)) {
		fail("EnvDialog 没有 fields 形参（脚本页签无法复用它编辑四键）");
	} else pass("EnvDialog 支持 fields（工程目录两键 / 脚本目录四键共用）");

	if (!/block\.missing\.join/.test(clientSource)) fail("预检返回的缺失键列表没有被渲染出来");
	else pass("预检缺失键列表进入面板 state 并渲染成提示");
}

/* --------------------------------- 10. 状态记忆与模糊查找（0.2.15） */

/**
 * 用户诉求：① 每次切进低代码工程，之前列出的数据、展开的层级、选中的文件都没了；
 * ② 列目录要能模糊找文件。钉住：三处记忆键 + 模块缓存恢复路径 + 查找框与递归搜索调用。
 */
{
	if (!/readStoredList\(EXPANDED_KEY\)/.test(clientSource)) fail("TreeTab 的展开层级没有从 EXPANDED_KEY 恢复");
	else pass("展开层级存 localStorage，重新挂载时恢复");

	if (!/readStoredPath\(SELECTED_KEY\)/.test(clientSource)) fail("上次选中的文件没有从 SELECTED_KEY 读回（切回来右栏是空的）");
	else pass("选中文件存 localStorage，重新挂载时读回");

	if (!/panelCache\.children instanceof Map/.test(clientSource)) fail("项目树没有走模块级 panelCache（重新挂载会退化成空白树 + 再点一次列出）");
	else pass("项目树 / 推送状态走模块级 panelCache：挂载即显示，再后台重扫");

	if (!/readStoredPath\(DETAIL_KEY\)/.test(clientSource)) fail("Panel 的右栏页签没有从 DETAIL_KEY 恢复（切回来总是弹回「文件内容」）");
	else pass("右栏页签存 localStorage，重新挂载时恢复");

	if (!/placeholder: "模糊查找/.test(clientSource)) fail("树栏没有模糊查找输入框");
	else pass("树栏顶部有模糊查找输入框");

	if (!/call\("projectSearchEntries"/.test(clientSource)) fail("模糊查找没有调用 host 的 projectSearchEntries（深层文件搜不到）");
	else pass("查找走 host 递归搜索 projectSearchEntries（没展开的层也能命中）");

	if (!/const reveal = useCallback/.test(clientSource)) fail("查找结果点不回去（缺少 reveal 定位助手）");
	else pass("命中结果可点击：reveal 逐级拉取、展开后定位过去");

	if (!/\.dshml-find\{/.test(clientSource) || !/\.dshml-hitpath\{/.test(clientSource)) fail("缺少 .dshml-find / .dshml-hitpath 样式（查找条与结果路径）");
	else pass("查找条与结果路径有独立样式（.dshml-find / .dshml-hitpath）");
}

/* --------------------------------- 11. 右栏编辑器高度（0.2.17） */

/**
 * 用户诉求：「文件内容」这边显示区域的高度不够。编辑器沿用了 preStyle，而它带
 * maxHeight 320 —— 宽屏下右栏一大半是空白。钉住：编辑器有自己的样式表、高度跟窗口走；
 * 左右两栏的上限也一起放宽（否则 pane 会把编辑器裁掉再套一层滚动）。
 */
{
	if (!/const editorStyle = \{/.test(clientSource)) fail("文件内容编辑器没有自己的样式表（仍从 preStyle 拼）");
	else pass("编辑器有独立样式 editorStyle");

	if (!/maxHeight: "none"/.test(clientSource)) fail("文件内容编辑器仍被 preStyle 的 maxHeight 320 压住（高度只有一屏的零头）");
	else pass("编辑器解开 preStyle 的 maxHeight：高度跟窗口走");

	if (!/height: "min\(62vh, 760px\)"/.test(clientSource)) fail("编辑器没有给随窗口变化的高度");
	else pass("编辑器高度 min(62vh, 760px)，宽屏下不再是一条缝");

	if (!/\.dshml-pane\{[^}]*max-height:min\(82vh,1000px\)/.test(clientSource)) fail("右栏容器 .dshml-pane 的上限太小，会把编辑器裁掉");
	else pass("右栏容器上限放宽到 min(82vh, 1000px)");

	if (!/\.dshml-tree\{[^}]*max-height:min\(80vh,900px\)/.test(clientSource)) fail("左树上限没跟着放宽（左右两栏高度差太明显）");
	else pass("左树上限同步放宽到 min(80vh, 900px)");
}

/* ------------------------- 12. 编辑器的渲染稳定性（0.2.18） */

/**
 * 用户诉求：在「文件内容」里多选几次，有几率整个浏览器崩溃。可疑面逐个钉住：
 * ① 编辑区不再从 preStyle 继承一批给 <pre> 用的属性（maxHeight/overflow/wordBreak）；
 * ② 关掉可拖拽的 resize 手柄（浏览器在可 resize 的大 textarea 上反复拖选有崩溃记录）；
 * ③ 编辑控件一次只装一页（0.2.21）：0.2.18/0.2.19 的「超大文件只读」只把路让开一半 ——
 *    一点「编辑」仍会回到受控大 textarea；现在改成按行分页（EDITOR_PAGE_LINES 行一页）。
 */
{
	if (/style: Object\.assign\(\{\}, preStyle/.test(clientSource)) fail("编辑器还在拼 preStyle（给 <pre> 的 maxHeight / overflow / wordBreak 会跟着进 textarea）");
	else pass("编辑器不再继承 preStyle：maxHeight / overflow / wordBreak 都留在 <pre> 那边");

	if (!/resize: "none"/.test(clientSource)) fail("编辑器仍带可拖拽的 resize 手柄（拖选崩溃的可疑点）");
	else pass("编辑器关掉 resize 手柄（resize: none），高度只由样式决定");

	if (!/const EDITOR_PAGE_LINES = [0-9]+/.test(clientSource)) fail("没有分页行数阈值（编辑控件又会一次装下整份文件）");
	else pass("编辑控件分页阈值 EDITOR_PAGE_LINES（一次只装一页）");

	if (/EDITOR_READONLY_LIMIT/.test(clientSource)) fail("还留着 EDITOR_READONLY_LIMIT —— 整份编辑那条路没拆干净");
	else pass("整份只读阈值 EDITOR_READONLY_LIMIT 已拆掉（改成逐页渲染）");

	if (!/const sliceDrafts = \(lines, from, to\)/.test(clientSource)) fail("没有 sliceDrafts：行范围不会按页切开");
	else pass("sliceDrafts 按 EDITOR_PAGE_LINES 把行范围切成一页一页");
}

/* ---------------------- 13. 默认只读查看 + 一次复制全文（0.2.19） */

/**
 * 用户证据：Edge 154.0.4258.62 里在编辑区拖选，窗口变「（未响应）」；选中时弹出的是 Edge 的
 * 划词迷你菜单。上游对得上号的是 Chromium 154 的 Blink>Editing>Selection 拖选死锁
 * （issues.chromium.org/issues/568602800，构建 154.0.8037.97），浏览器侧的问题网页改不动，
 * 只能少走那条路：默认只读 <pre>、「编辑」显式进入、外加「复制全文」绕开长距离拖选，
 * 并把 Grammarly 一类的划词扩展挡在 textarea 外。
 */
{
	if (!/const viewerStyle = Object\.assign\(\{\}, editorStyle, \{/.test(clientSource)) fail("没有只读查看区的样式 viewerStyle");
	else pass("只读查看区有独立样式 viewerStyle（不从 preStyle 拼）");

	if (!/h\("pre", \{ style: viewerStyle/.test(clientSource)) fail("默认态没有用只读 <pre> 显示内容（还是直接给 textarea）");
	else pass("默认态是只读 <pre>：不点「编辑」就不进编辑控件那条路");

	if (/const editing = selected\.status === "ready"/.test(clientSource)) fail("还留着「整份编辑」的 editing 开关（点编辑又会把整份文件塞进一个受控 textarea）");
	else pass("没有「整份编辑」态：点「编辑」不再把整份文件塞进一个受控 textarea");

	if (/const tooBig = selected\.status === "ready"/.test(clientSource)) fail("还留着 tooBig 整份只读分支（超长文件仍然只能只读看）");
	else pass("没有 tooBig 整份只读分支（超长文件也能分页编辑）");

	if (!/onClick: copyAll \}, "复制全文"\)/.test(clientSource)) fail("没有「复制全文」按钮（复制还得靠长距离拖选）");
	else pass("「复制全文」按钮：整份内容一次进剪贴板");

	if (!/data-enable-grammarly|data-gramm_editor/.test(clientSource)) fail("没有挡第三方划词扩展的属性（Grammarly 一类会往 textarea 挂浮层）");
	else pass("textarea 上钉了 spellCheck / autoCorrect / data-gramm 一类属性");
}

/* ------------------- 14. 行级选择 + 复制选中 + 发给 AI 改（0.2.20） */

/**
 * 用户诉求：「我要的是可以选择文本，因为目前还只是手动去改文本就已经出问题了，还没有实现
 * 选择文本让 DeepSeek Harness 的 ai 去帮我改呢」。原生选区正是崩溃那条路，于是：
 * ① 只读区 user-select: none —— 不再产生原生选区，Blink 的拖选死锁与 Edge 的划词迷你菜单都走不到；
 * ② 内容按行切开、每行带行号，点一行定起点、拖过或 Shift+点定终点，选中的行整行高亮；
 * ③ 「复制选中」只复制这几行；「发给 AI 改」把路径 + 行号范围 + 选中内容 + 留空的要求一起进剪贴板。
 */
{
	if (!/userSelect: "none"/.test(clientSource)) fail("只读区还开着原生选区（user-select 不是 none）—— 拖选崩溃那条路仍在");
	else pass("只读区 user-select: none：不再产生原生选区");

	if (!/const VIEW_LINE_LIMIT = \d+/.test(clientSource)) fail("没有行级选择的行数上限（超长文件一次性铺开会很重）");
	else pass("行级选择有行数上限 VIEW_LINE_LIMIT");

	if (!/className: "dshml-line"/.test(clientSource)) fail("查看态没有按行渲染（还是整块文本，选不了行）");
	else pass("查看态按行渲染：每行一个 .dshml-line（带行号槽）");

	if (!/\.dshml-line\[data-sel='1'\]\{background:/.test(clientSource)) fail("选中的行没有高亮样式（选了看不出来）");
	else pass("选中的行整行高亮（.dshml-line[data-sel='1']）");

	if (!/const selectedRange = \(content\) => \{/.test(clientSource)) fail("没有把选中行折算成一段文本的 selectedRange");
	else pass("selectedRange 把起止行折算成文本（行号夹在文件范围内）");

	if (!/"发给 AI 改"\)/.test(clientSource)) fail("没有「发给 AI 改」按钮");
	else pass("「发给 AI 改」按钮：路径 + 行号范围 + 选中内容 + 待补的要求");

	if (!/【我的要求】/.test(clientSource)) fail("发给 AI 的上下文里没有留给用户写要求的空位");
	else pass("发给 AI 的上下文里留了「我的要求」空位，粘进对话即可");

	if (!/window\.addEventListener\("mouseup", stopDrag\)/.test(clientSource)) fail("拖选没有在松开左键时结束（会一直粘着鼠标）");
	else pass("松开左键结束拖选，Esc 清除选择");

	if (!/onClick: copyAll \}, "复制全文"\)/.test(clientSource)) fail("「复制全文」按钮丢了");
	else pass("查看态仍然保留「复制全文」（整份一次复制）");

	/*
	 * 真渲染一遍「文件已经打开」的查看态：TreeTab 的 selected 是它第 4 个 useState，
	 * sel（行级选择）是第 14 个 —— 定点覆盖这两个，就能把中间态画出来。
	 */
	const FILE = { status: "ready", path: "C:\\proj\\pages\\index.html", content: "line one\nline two\nline three", editing: false };
	try {
		const tree = renderSettingsWith({ "TreeTab#4": FILE });
		const rows = [];
		let userSelect = null;
		walk(tree, (n) => {
			if (n.kind !== "host") return;
			if (n.props?.className === "dshml-line") rows.push(n);
			if (n.props?.className === "dshml-view") userSelect = n.props.style?.userSelect;
		});
		if (rows.length !== 3) fail(`查看态应按行渲染出 3 行，实际 ${rows.length} 行`);
		else pass("查看态真渲染：3 行内容切成 3 个 .dshml-line");
		if (userSelect !== "none") fail(`查看态容器 style.userSelect 应为 none，实际 ${String(userSelect)}`);
		else pass("查看态容器的 userSelect 是 none（原生选区真的关掉了）");
		if (!textOf(rows[0]).startsWith("1")) fail(`第一行没带行号，实际「${textOf(rows[0])}」`);
		else pass("每行前面带行号（「发给 AI 改」给的行号范围就是指它）");
		if (!textOf(tree).includes("复制全文")) fail("查看态里找不到「复制全文」按钮");
		else pass("查看态顶部仍是「编辑 / 复制全文 / 关闭」");
	} catch (error) {
		fail(`查看态渲染抛错：${error?.message ?? error}`);
	}

	try {
		const tree = renderSettingsWith({ "TreeTab#4": FILE, "TreeTab#14": { a: 0, b: 1 } });
		const selectedRows = [];
		walk(tree, (n) => {
			if (n.kind === "host" && n.props?.className === "dshml-line" && n.props?.["data-sel"] === "1") selectedRows.push(n);
		});
		const text = textOf(tree);
		if (selectedRows.length !== 2) fail(`选中第 1–2 行时应高亮 2 行，实际 ${selectedRows.length} 行`);
		else pass("选中第 1–2 行时整行高亮（data-sel=1）");
		for (const label of ["已选 第 1–2 行", "复制选中", "发给 AI 改", "清除选择"]) {
			if (!text.includes(label)) fail(`选中一段后界面上缺少「${label}」`);
			else pass(`选中一段后出现「${label}」`);
		}
	} catch (error) {
		fail(`选中态渲染抛错：${error?.message ?? error}`);
	}

	/*
	 * 「改这段」：选中的这几行单独进一个小文本框，保存时按行号替换回原文件
	 * （不必再进「整份文本」的大 textarea —— 那正是拖选崩溃那条路）。
	 */
	if (!/onClick: openPatch \}, "改这段"\)/.test(clientSource)) fail("选中后没有「改这段」按钮（只能整份文件进大文本框改）");
	else pass("选中后出现「改这段」：只把这几行放进小文本框");

	if (!/function PatchDialog\(/.test(clientSource)) fail("没有 PatchDialog 组件");
	else pass("PatchDialog 组件在（标题带行号范围）");

	if (!/function savePatch|const savePatch = useCallback/.test(clientSource)) fail("「改这段」没有写回逻辑");
	else pass("savePatch 按行号把改后的内容拼回整份文本再写文件");

	try {
		const tree = renderSettingsWith({ "TreeTab#4": FILE, "TreeTab#14": { a: 0, b: 1 }, "TreeTab#15": { from: 0, to: 1, drafts: ["line one\nline two"], page: 0, saving: false } });
		const text = textOf(tree);
		for (const label of ["替换这 2 行", "复制给 AI 改", "文件其余部分逐字保留"]) {
			if (!text.includes(label)) fail(`「改这段」对话框里缺少「${label}」`);
			else pass(`「改这段」对话框渲染出「${label}」`);
		}
		const titles = [];
		walk(tree, (n) => {
			if (n.kind === "host" && n.name === primitivesStub.Modal) titles.push(n.props?.title);
		});
		if (!titles.includes("改这段 · 第 1–2 行")) fail(`对话框标题没带行号范围，实际 ${JSON.stringify(titles)}`);
		else pass("「改这段」对话框标题写清行号范围（改这段 · 第 1–2 行）");
		const boxes = [];
		walk(tree, (n) => {
			if (n.kind === "host" && n.name === "textarea") boxes.push(n);
		});
		if (boxes.length !== 1) fail(`「改这段」对话框里应有 1 个 textarea，实际 ${boxes.length} 个`);
		else pass("「改这段」对话框里就是一个小 textarea（只装选中的行）");
	} catch (error) {
		fail(`「改这段」渲染抛错：${error?.message ?? error}`);
	}
}

/* ------------- 15. 编辑改走分页：一个编辑控件只装一页（0.2.21） */

/**
 * 用户证据：Chrome 与 Edge 都是 154（同一个 Chromium 构建），点「编辑」后窗口标题变
 * 「（无响应）」、编辑区里拖出一大片蓝底 —— 上游是 Blink>Editing>Selection 拖选死锁
 * （issues.chromium.org/issues/568602800）。
 * 0.2.20 只把**查看态**换成 user-select: none 的行级渲染；一点「编辑」又回到受控大 textarea
 * （出事那份 index.html 有 90399 字符），于是原样踩死。0.2.21 把这条路拆掉：
 * ① 任何编辑控件都不装整份文件 —— 按 EDITOR_PAGE_LINES 行分页，一次只渲染一页；
 * ② 「改这段」（选中的几行）与「编辑」（整份）共用同一个分页编辑器 openRange；
 * ③ 保存时把各页草稿按顺序拼回，替换原来的行范围，其余行逐字不动。
 */
{
	if (!/const openRange = useCallback/.test(clientSource)) fail("没有 openRange（「编辑」与「改这段」共用的分页入口）");
	else pass("openRange：「改这段」与「编辑」共用同一个分页编辑器");

	if (!/onClick: \(\) => openRange\(0, lines\.length - 1\) \}, "编辑"\)/.test(clientSource)) fail("「编辑」没有接到分页编辑器（应写成 openRange(0, lines.length - 1)）");
	else pass("「编辑」打开整份范围的分页编辑器（不是一个大 textarea）");

	if (!/onPage: gotoPatchPage/.test(clientSource)) fail("PatchDialog 没接上翻页回调 onPage");
	else pass("PatchDialog 接上 onPage（翻页只换页码，不动已经改好的草稿）");

	if (!/drafts: sliceDrafts\(lines, start, end\)/.test(clientSource)) fail("openRange 没有把行范围切成页");
	else pass("openRange 用 sliceDrafts 把选中的行范围切成页");

	if (!/middle\.push\(line\)/.test(clientSource)) fail("savePatch 没有把各页草稿拼回整份文本");
	else pass("savePatch 把各页草稿按顺序拼回，再替换原来的行范围");

	/* 真渲染「2 页」的编辑态：控件里只该有当前那一页。 */
	const PAGE_ONE = "line one\nline two";
	const PAGE_TWO = "line three";
	const BIGFILE = { status: "ready", path: "C:\\proj\\pages\\index.html", content: "line one\nline two\nline three\nline four" };
	try {
		const first = renderSettingsWith({
			"TreeTab#4": BIGFILE,
			"TreeTab#15": { from: 0, to: 3, drafts: [PAGE_ONE, PAGE_TWO], page: 0, saving: false },
		});
		const boxes = [];
		walk(first, (n) => {
			if (n.kind === "host" && n.name === "textarea") boxes.push(n);
		});
		const firstText = textOf(first);
		if (boxes.length !== 1) fail(`多页编辑态应只有 1 个 textarea，实际 ${boxes.length} 个`);
		else if (String(boxes[0].props?.value) !== PAGE_ONE) fail(`第 1 页时 textarea 装的不是第 1 页，实际「${String(boxes[0].props?.value)}」`);
		else pass("分页编辑态：textarea 里只有当前这一页的文本");

		for (const label of ["上一页", "下一页", "第 1/2 页"]) {
			if (!firstText.includes(label)) fail(`多页编辑态缺少翻页元素「${label}」`);
			else pass(`多页编辑态渲染出「${label}」`);
		}

		const second = renderSettingsWith({
			"TreeTab#4": BIGFILE,
			"TreeTab#15": { from: 0, to: 3, drafts: [PAGE_ONE, PAGE_TWO], page: 1, saving: false },
		});
		const secondBoxes = [];
		walk(second, (n) => {
			if (n.kind === "host" && n.name === "textarea") secondBoxes.push(n);
		});
		if (secondBoxes.length !== 1) fail(`翻到第 2 页后应仍是 1 个 textarea，实际 ${secondBoxes.length} 个`);
		else if (String(secondBoxes[0].props?.value) !== PAGE_TWO) fail(`翻到第 2 页后 textarea 没换成第 2 页，实际「${String(secondBoxes[0].props?.value)}」`);
		else if (!textOf(second).includes("第 2/2 页")) fail("翻到第 2 页后页码没更新");
		else pass("翻页只换 textarea 里的那一页（第 2/2 页）");

		if (!/total: lines\.length/.test(clientSource)) fail("openRange 没把总行数放进 state.total —— 分不清「编辑整份」与「改这段」");
		else pass("openRange 带上 state.total，编辑整份与改这段共用入口但文案分得开");

		/* 整份（点「编辑」）与「改这段」同一个对话框，标题/提示要分得开。 */
		const titlesOf = (node) => {
			const out = [];
			walk(node, (n) => {
				if (n.kind === "host" && n.name === primitivesStub.Modal) out.push(n.props?.title);
			});
			return out;
		};

		const wholeTree = renderSettingsWith({
			"TreeTab#4": BIGFILE,
			"TreeTab#15": { from: 0, to: 3, total: 4, drafts: [PAGE_ONE, PAGE_TWO], page: 0, saving: false },
		});
		const wholeTitles = titlesOf(wholeTree);
		const wholeText = textOf(wholeTree);
		if (!wholeTitles.includes("编辑整份 · 共 4 行（分页）")) fail(`整份编辑的标题应写「编辑整份 · 共 4 行（分页）」，实际 ${JSON.stringify(wholeTitles)}`);
		else pass("整份编辑的标题写「编辑整份 · 共 4 行（分页）」");
		if (!wholeText.includes("整份文件（共 4 行）")) fail("整份编辑的提示语没按整份口径说");
		else if (wholeText.includes("文件其余部分逐字保留")) fail("整份编辑还在说「文件其余部分逐字保留」（这话只对「改这段」成立）");
		else pass("整份编辑的提示语按整份口径说（不再提「其余部分逐字保留」）");

		const rangeTree = renderSettingsWith({
			"TreeTab#4": BIGFILE,
			"TreeTab#15": { from: 0, to: 2, total: 4, drafts: ["line one\nline two\nline three"], page: 0, saving: false },
		});
		if (!titlesOf(rangeTree).includes("改这段 · 第 1–3 行")) fail(`只改一段时标题应仍是「改这段 · 第 1–3 行」，实际 ${JSON.stringify(titlesOf(rangeTree))}`);
		else pass("只改一段时标题仍是「改这段 · 第 X–Y 行」（没被整份口径盖掉）");
	} catch (error) {
		fail(`分页编辑态渲染抛错：${error?.message ?? error}`);
	}
}

/* ------------- 16. 大文件改走系统编辑器：浏览器不碰文本（0.2.22） */

/**
 * 用户在 0.2.21 截图后的结论：「太小了，而且这样子把代码分页处理不方便」。
 * 根因没变：浏览器在**可编辑文本控件**里做长距离原生选区会死锁（Chromium 154 的
 * Blink>Editing>Selection）。所以正解不是把编辑区做大，而是浏览器根本不碰文本：
 * 插件只把路径交给宿主，宿主 detached spawn 系统编辑器（VS Code / 记事本 / 文件管理器）。
 * 插件内分页编辑器保留，但三个入口（工具行 / 右键菜单 / 分页对话框）都以「用编辑器打开」为先。
 */
{
	if (!/projectOpenExternal: \["path"\]/.test(clientSource)) fail("METHOD_PARAMS 里没有 projectOpenExternal");
	else pass("projectOpenExternal 登记进 METHODS / METHOD_PARAMS（对应 host 同名 RPC）");

	if (!/const openExternal = useCallback/.test(clientSource)) fail("没有 openExternal 回调");
	else pass("openExternal 把路径发给宿主，由系统里的编辑器打开");

	if (!/onClick: \(\) => openExternal\(selected\.path\) \}, "用编辑器打开"\)/.test(clientSource)) fail("工具行没有「用编辑器打开」按钮");
	else pass("工具行的「用编辑器打开」直接开当前文件");

	if (!/label: "🖥 用编辑器打开"/.test(clientSource)) fail("文件右键菜单没有「用编辑器打开」");
	else pass("文件右键菜单也有「用编辑器打开」");

	if (!/onOpenExternal: openExternal/.test(clientSource)) fail("PatchDialog 没接上 onOpenExternal");
	else pass("PatchDialog 接上 onOpenExternal（分页框里也能一键交给系统编辑器）");

	const FILE = { status: "ready", path: "C:\\proj\\pages\\index.html", content: "line one\nline two", editing: false };
	try {
		const tree = renderSettingsWith({ "TreeTab#4": FILE });
		const all = textOf(tree);
		if (!all.includes("用编辑器打开")) fail("查看态没渲染「用编辑器打开」");
		else if (all.indexOf("用编辑器打开") > all.indexOf("复制全文")) fail("「用编辑器打开」应排在「编辑」「复制全文」之前（它现在是主路）");
		else pass("查看态里「用编辑器打开」排在「编辑」「复制全文」之前（主路）");

		const editing = renderSettingsWith({
			"TreeTab#4": FILE,
			"TreeTab#15": { from: 0, to: 1, total: 2, drafts: ["line one"], page: 0, saving: false },
		});
		let modal = null;
		walk(editing, (n) => {
			if (modal === null && n.kind === "host" && n.name === primitivesStub.Modal) modal = n;
		});
		if (modal === null) fail("编辑态没渲染出分页对话框");
		else if (!textOf(modal).includes("用编辑器打开")) fail("分页对话框里没有「用编辑器打开」");
		else if (!/编辑框大小：/.test(clientSource)) fail("分页对话框里没有「编辑框大小：」这一行");
		else pass("分页对话框里也能一键交给系统编辑器，并给出「编辑框大小」三档（0.2.24）");
	} catch (error) {
		fail(`外部编辑器渲染抛错：${error?.message ?? error}`);
	}
}

/* ------------- 17. 浏览器内编辑：双击改一行 + 页大小可选（0.2.23） */

/**
 * 用户（m04283）的结论：「这样子是用外部的编辑器打开了，没有在浏览器上的编辑器吗？」
 * —— 「用编辑器打开」只是旁路，正解是浏览器内就能改，而且别再分页分到烦。
 * 0.2.23 两条腿：
 * ① 行内编辑：双击一行 → 该行变成单行 input，回车 / 失焦写回**这一行**。单行输入框里不可能
 *    做长距离拖选，所以既没有「编辑区太大」的问题，也不会碰到 Blink 拖选死锁；
 * ② 页大小可选：120 / 300 / 1000 / 整份，默认 120。分页从「唯一出路」降级成「保险」。
 */
{
	if (!/const EDITOR_PAGE_SIZES = \[/.test(clientSource)) fail("没有 EDITOR_PAGE_SIZES（页大小不可选）");
	else pass("页大小可选：EDITOR_PAGE_SIZES（120 / 300 / 1000 / 整份=0）");

	if (!/const resliceDrafts = /.test(clientSource)) fail("没有 resliceDrafts（改页大小时草稿要按新页长重切）");
	else pass("resliceDrafts：先拼回整段，再按新页长重切并折算页码");

	if (!/const setPatchPageSize = useCallback/.test(clientSource)) fail("没有 setPatchPageSize 回调");
	else pass("setPatchPageSize 接上「每页行数」按钮");

	if (!/onPageSize: setPatchPageSize/.test(clientSource)) fail("PatchDialog 调用点没接上 onPageSize");
	else pass("PatchDialog 调用点接上 onPageSize");

	if (!/onPageSize\(0\)/.test(clientSource)) fail("没有「整份」这一档（整份=0）");
	else pass("「整份」档位接上 onPageSize(0)");

	if (!/const saveLineEdit = useCallback/.test(clientSource)) fail("没有 saveLineEdit（行内编辑改完写不回去）");
	else pass("saveLineEdit：把改后的那一行替换回整份文本再 projectWriteFile");

	if (!/className: "dshml-lineinput"/.test(clientSource)) fail("行内编辑没有渲染 input.dshml-lineinput");
	else pass("行内编辑渲染单行 input.dshml-lineinput");

	if (!/\.dshml-lineinput\{background:/.test(clientSource)) fail("行内输入框没有样式（看不出来在编辑）");
	else pass("行内输入框有自己的样式（.dshml-lineinput）");

	if (!/onDoubleClick: \(\) => setLineEdit/.test(clientSource)) fail("查看态那一行没有双击进入编辑");
	else pass("双击一行 → setLineEdit，就地变成单行输入框");

	if (!/"改这一行"/.test(clientSource)) fail("选中一行时没有「改这一行」按钮");
	else pass("选中恰好一行时给出「改这一行」");

	if (!/className: "dshml-editor " \+ "dshml-editor-|className: "dshml-editor dshml-editor-" \+ sizeKey/.test(clientSource)) fail("编辑对话框没有按档加 className（dshml-editor-<档>）");
	else if (!/\.dshml-editor-" \+ key \+ "\{width:"/.test(clientSource)) fail("编辑对话框没有按档生成宽度规则");
	else pass("编辑对话框宽度按档生成：.dshml-editor-<档>{width:…}（0.2.24）");

	const FILE = { status: "ready", path: "C:\\proj\\pages\\index.html", content: "line one\nline two" };
	try {
		/* ① 行内编辑：TreeTab 的第 16 个 state 就是 lineEdit（#14 sel、#15 patch 之后）。 */
		const editTree = renderSettingsWith({
			"TreeTab#4": FILE,
			"TreeTab#16": { index: 1, draft: "line two!", saving: false },
		});
		const inputs = [];
		walk(editTree, (n) => {
			if (n.kind === "host" && n.name === "input" && n.props?.className === "dshml-lineinput") inputs.push(n);
		});
		if (inputs.length !== 1) fail(`行内编辑态应恰好 1 个 input.dshml-lineinput，实际 ${inputs.length} 个`);
		else if (String(inputs[0].props?.value) !== "line two!") fail(`行内输入框没装第 2 行草稿，实际「${String(inputs[0].props?.value)}」`);
		else pass("行内编辑态：第 2 行变成单行输入框，装着该行草稿");

		/* ② 页大小那一行：四档都在，当前档用 primary。 */
		const sizeTree = renderSettingsWith({
			"TreeTab#4": FILE,
			"TreeTab#15": { from: 0, to: 1, total: 2, drafts: ["line one\nline two"], page: 0, saving: false, pageSize: 1000 },
		});
		const sizeText = textOf(sizeTree);
		if (!sizeText.includes("每页行数：")) fail("编辑对话框里没有「每页行数：」这一行");
		else {
			const missing = ["120 行", "300 行", "1000 行", "整份"].filter((label) => !sizeText.includes(label));
			if (missing.length > 0) fail(`页大小档位缺 ${JSON.stringify(missing)}`);
			else pass("页大小四档都渲染出来（120 行 / 300 行 / 1000 行 / 整份）");
		}
		if (!/height: sizeStyle\.height/.test(clientSource)) fail("编辑区高度没有跟着尺寸档走（应为 height: sizeStyle.height）");
		else pass("编辑区高度跟着尺寸档走（height: sizeStyle.height）");
	} catch (error) {
		fail(`浏览器内编辑渲染抛错：${error?.message ?? error}`);
	}
}

/* ------------- 18. 引用到输入框：会话作用域的 props.inputActions（0.2.23） */

/**
 * 用户（m04283）：「我需要在选择好文件后在 DeepSeek Harness 下面的输入框里引用对应的文件
 * 让 ai 帮我改代码」。
 *
 * 「低代码工程」是 conversation.view（会话作用域 slot），宿主会把官方公开的 `InputActions`
 * 当 props 递进来（@deepseek-ai/dsh-client-ui-conversation 的 contract/input.d.ts:200-226）。
 * 插件只走这个面，不碰 conversation 包里注释写着「不得跨插件边界」的键盘面。
 *
 * 插的是纯文本 `@路径`：官方 @ 源的 codec 是恒等映射（serialize: (ref) => ref），
 * 效果与真 chip 一致，而自造 chip 缺 owner 时会在发送阶段被拒并回滚草稿。
 */
{
	if (!/const insertIntoComposer = useCallback/.test(clientSource)) fail("没有 insertIntoComposer（拿不到输入框就插不进去）");
	else pass("insertIntoComposer：从 props.inputActions 取 captureInsertion / insertText");

	if (!/const mentionOf = useCallback/.test(clientSource) || !/\\s\/\.test\(filePath\)/.test(clientSource)) fail("没有 mentionOf（含空格的路径要用 @\"…\" 语法）");
	else pass("mentionOf：普通路径 `@路径`，含空格用 `@\"路径\"`");

	if (!/inputActions: inputActions/.test(clientSource) || !/h\(Panel, \{ inputActions:/.test(clientSource)) fail("Panel / ProjectView 没有把 inputActions 透传到 TreeTab");
	else pass("Panel / ProjectView 把宿主给的 inputActions 透传到 TreeTab");

	if (!/onClick: \(\) => referenceToComposer\(selected\.path\)/.test(clientSource)) fail("工具行没有「引用到输入框」按钮");
	else pass("工具行有「引用到输入框」");

	if (!/label: "🤖 引用到输入框（让 AI 改）"/.test(clientSource)) fail("右键菜单没有「引用到输入框」");
	else pass("右键菜单（文件与目录都能点）也有「引用到输入框」");

	const FILE = { status: "ready", path: "C:\\proj\\pages\\index.html", content: "line one\nline two" };
	const written = [];
	const actions = {
		captureInsertion: () => ({ start: 0, end: 0, draftRev: 7 }),
		insertText: (text, span) => {
			written.push({ text, span });
			return true;
		},
		setDraft: () => {},
		submit: () => {},
	};
	try {
		const tree = renderProjectView({ inputActions: actions }, { "TreeTab#4": FILE });
		const all = textOf(tree);
		if (!all.includes("引用到输入框")) fail("查看态没渲染「引用到输入框」");
		else if (all.indexOf("引用到输入框") > all.indexOf("用编辑器打开")) fail("「引用到输入框」应排在「用编辑器打开」之前（让 AI 改才是主路）");
		else pass("查看态里「引用到输入框」排在「用编辑器打开」之前");

		let button = null;
		walk(tree, (n) => {
			if (button === null && n.kind === "host" && n.name === primitivesStub.Button && textOf(n).includes("引用到输入框")) button = n;
		});
		if (button === null) fail("树里找不到「引用到输入框」按钮节点");
		else {
			await button.props.onClick();
			if (written.length !== 1) fail(`点「引用到输入框」应往输入框写 1 次，实际 ${written.length} 次`);
			else if (written[0].text !== "@C:\\proj\\pages\\index.html ") fail(`写进输入框的不是 @路径，而是「${written[0].text}」`);
			else if (written[0].span?.draftRev !== 7) fail("insertText 没用 captureInsertion() 拿到的 span");
			else pass("点「引用到输入框」→ inputActions.insertText(\"@绝对路径 \", captureInsertion())");
		}

		/* 设置页 / 侧栏浮层不在会话里：没有 inputActions 也不能抛错（退化成剪贴板）。 */
		const bare = renderProjectView({}, { "TreeTab#4": FILE });
		let bareButton = null;
		walk(bare, (n) => {
			if (bareButton === null && n.kind === "host" && n.name === primitivesStub.Button && textOf(n).includes("引用到输入框")) bareButton = n;
		});
		if (bareButton === null) fail("没有 inputActions 时「引用到输入框」不该消失");
		else {
			await bareButton.props.onClick();
			if (written.length !== 1) fail("拿不到输入框时不该再往输入框写东西");
			else pass("拿不到 inputActions（设置页 / 侧栏浮层）时不抛错，退化成剪贴板");
		}
	} catch (error) {
		fail(`引用到输入框渲染抛错：${error?.message ?? error}`);
	}
}

/* ------------- 19. 编辑框尺寸三档：别再铺满屏幕（0.2.24） */

/**
 * 用户（m04851）在 0.2.23 截图下只说了一句：「编辑打开的内容太大了」。
 *
 * 0.2.23 刚把它做成近全屏（宽 min(94vw,1200px)、编辑区 min(76vh,820px)），而 0.2.17 又有人嫌
 * 编辑区太矮 —— 同一条诉求其实是：**尺寸不该由插件钉死**。于是三档 compact / normal / wide，
 * 默认 normal，选择记 localStorage；宽度按 className 生成，高度进 textarea 的内联 style。
 */
{
	if (!/const EDITOR_SIZES = \{/.test(clientSource)) fail("没有 EDITOR_SIZES（编辑框尺寸不可选）");
	else pass("编辑框尺寸三档：EDITOR_SIZES = { compact, normal, wide }");

	if (!/const EDITOR_SIZE_ORDER = \["compact", "normal", "wide"\]/.test(clientSource)) fail("没有 EDITOR_SIZE_ORDER（档位顺序丢失）");
	else pass("档位顺序 EDITOR_SIZE_ORDER = [compact, normal, wide]");

	if (!/return EDITOR_SIZES\[raw\] === undefined \? "normal" : raw;/.test(clientSource)) fail("readStoredEditorSize 的默认档不是 normal");
	else pass("readStoredEditorSize：坏值 / 没记过 → 默认「标准」（normal）");

	if (!/const changeEditorSize = useCallback/.test(clientSource) || !/writeStored\(EDITOR_SIZE_KEY, next\)/.test(clientSource)) fail("没有 changeEditorSize（选了尺寸记不住）");
	else pass("changeEditorSize：切档同时写进 localStorage");

	const FILE = { status: "ready", path: "C:\\proj\\pages\\index.html", content: "line one\nline two" };
	const PATCH = { from: 0, to: 1, total: 2, drafts: ["line one\nline two"], page: 0, saving: false, pageSize: 120 };
	/** 渲染一次对话框，回传 { className, height, text }。 */
	const dialog = (size) => {
		const tree = renderSettingsWith({ "TreeTab#4": FILE, "TreeTab#15": PATCH, "TreeTab#17": size });
		let modal = null;
		let area = null;
		walk(tree, (n) => {
			if (modal === null && n.kind === "host" && n.name === primitivesStub.Modal) modal = n;
			if (area === null && n.kind === "host" && n.name === "textarea") area = n;
		});
		return {
			className: String(modal?.props?.className ?? ""),
			height: String(area?.props?.style?.height ?? ""),
			text: modal === null ? "" : textOf(modal),
		};
	};
	try {
		const normal = dialog(undefined);
		if (!normal.className.includes("dshml-editor-normal")) fail(`默认档不是「标准」，className 是「${normal.className}」`);
		else if (normal.height !== "min(58vh,560px)") fail(`默认档的编辑区高度是「${normal.height}」，应为 min(58vh,560px)`);
		else pass("默认「标准」档：.dshml-editor-normal + 编辑区 min(58vh,560px)");

		const compact = dialog("compact");
		if (!compact.className.includes("dshml-editor-compact")) fail(`紧凑档 className 不对：「${compact.className}」`);
		else if (compact.height !== "min(40vh,320px)") fail(`紧凑档编辑区高度是「${compact.height}」，应为 min(40vh,320px)`);
		else pass("「紧凑」档：.dshml-editor-compact + 编辑区 min(40vh,320px)（右栏与左树不再被挡住）");

		const wide = dialog("wide");
		if (!wide.className.includes("dshml-editor-wide")) fail(`放大档 className 不对：「${wide.className}」`);
		else if (wide.height !== "min(76vh,820px)") fail(`放大档编辑区高度是「${wide.height}」，应为 min(76vh,820px)`);
		else pass("「放大」档：.dshml-editor-wide + 编辑区 min(76vh,820px)（0.2.23 的那一档还在）");

		const labels = ["紧凑", "标准", "放大"];
		const missing = labels.filter((label) => !normal.text.includes(label));
		if (!normal.text.includes("编辑框大小：")) fail("对话框里没有「编辑框大小：」这一行");
		else if (missing.length > 0) fail(`尺寸档位缺 ${JSON.stringify(missing)}`);
		else pass("三个尺寸按钮都渲染出来（紧凑 / 标准 / 放大）");

		/* 当前档必须是 primary，其余 default —— 否则看不出自己在哪一档。 */
		const tiers = [];
		walk(renderSettingsWith({ "TreeTab#4": FILE, "TreeTab#15": PATCH, "TreeTab#17": "compact" }), (n) => {
			if (n.kind === "host" && n.name === primitivesStub.Button && labels.includes(textOf(n))) tiers.push({ label: textOf(n), variant: n.props?.variant });
		});
		const primary = tiers.filter((item) => item.variant === "primary").map((item) => item.label);
		if (tiers.length !== 3) fail(`尺寸按钮应有 3 个，实际 ${tiers.length} 个`);
		else if (primary.length !== 1 || primary[0] !== "紧凑") fail(`当前档没有唯一高亮：${JSON.stringify(primary)}`);
		else pass("当前档唯一高亮（选了紧凑就只有「紧凑」是 primary）");
	} catch (error) {
		fail(`编辑框尺寸渲染抛错：${error?.message ?? error}`);
	}
}

/* ------------------------------------------------------------------- 输出 */

const line = "-".repeat(72);
console.log(line);
console.log("dsh-magical-lowcode-project 客户端半边 · 渲染层桩检");
console.log(line);
for (const item of passes) console.log(`  ok    ${item}`);
for (const item of infos) console.log(`  info  ${item}`);
for (const item of failures) console.log(`  FAIL  ${item}`);
console.log(line);
console.log(`通过 ${passes.length} · 失败 ${failures.length}`);
if (failures.length > 0) {
	console.log("\n渲染层桩检未通过。");
	process.exit(1);
}
console.log("\n渲染层桩检通过。");
