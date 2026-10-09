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
const reactStub = {
	createElement: (type, props, ...children) => ({ __element: true, type, props: props ?? {}, children }),
	useState: (initial) => {
		useStateCallIndex += 1;
		const value =
			useStateCallIndex === 1 && activeOverride !== undefined
				? activeOverride
				: typeof initial === "function"
					? initial()
					: initial;
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
if (typeof SettingsSection !== "function") fail("没能从 settings.section 截获组件函数");
if (typeof SidebarAction !== "function") fail("没能从 sidebar.footer.action 截获组件函数");

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
			const produced = isClass ? new type(withChildren).render() : type(withChildren);
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
	activeOverride = tabKey;
	try {
		return render(reactStub.createElement(SettingsSection, {}));
	} finally {
		activeOverride = undefined;
	}
}

/** 不拨动 active，渲染侧边栏入口。 */
function renderSidebar() {
	useStateCallIndex = 0;
	activeOverride = undefined;
	return render(reactStub.createElement(SidebarAction, {}));
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
 * maxHeight 320 —— 宽屏下右栏一大半是空白。钉住：编辑器把 maxHeight 解开、高度跟窗口走、
 * 还能手动往下拉；左右两栏的上限也一起放宽（否则 pane 会把编辑器裁掉再套一层滚动）。
 */
{
	if (!/maxHeight: "none"/.test(clientSource)) fail("文件内容编辑器仍被 preStyle 的 maxHeight 320 压住（高度只有一屏的零头）");
	else pass("编辑器解开 preStyle 的 maxHeight：高度跟窗口走");

	if (!/height: "min\(62vh, 760px\)"/.test(clientSource)) fail("编辑器没有给随窗口变化的高度");
	else pass("编辑器高度 min(62vh, 760px)，宽屏下不再是一条缝");

	if (!/resize: "vertical"/.test(clientSource)) fail("编辑器不能手动往下拉");
	else pass("编辑器可手动下拉（resize: vertical）");

	if (!/\.dshml-pane\{[^}]*max-height:min\(82vh,1000px\)/.test(clientSource)) fail("右栏容器 .dshml-pane 的上限太小，会把编辑器裁掉");
	else pass("右栏容器上限放宽到 min(82vh, 1000px)");

	if (!/\.dshml-tree\{[^}]*max-height:min\(80vh,900px\)/.test(clientSource)) fail("左树上限没跟着放宽（左右两栏高度差太明显）");
	else pass("左树上限同步放宽到 min(80vh, 900px)");
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
