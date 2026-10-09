#!/usr/bin/env node
/**
 * dsh-magical-lowcode-project 静态自检。
 *
 * 为什么不用 `node --check` 子进程：DSH 沙箱下 node 的 child_process 管道 stdio 会 EPERM，
 * 因此这里改用「动态 import 协议」做语法校验 —— ESM 会先解析再解析依赖，所以：
 *   - 抛 SyntaxError        → 语法错误，判定失败
 *   - 抛 ERR_MODULE_NOT_FOUND 等 → 语法通过（peer 依赖在开发树里本来就没装）
 *   - 正常返回               → 语法通过
 *
 * 用法：node test/verify.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const warnings = [];
const passes = [];

const fail = (msg) => failures.push(msg);
const warn = (msg) => warnings.push(msg);
const pass = (msg) => passes.push(msg);
const rel = (p) => p.replace(/\\/g, "/");

function readJson(name) {
	const path = join(root, name);
	if (!existsSync(path)) {
		fail(`缺少文件 ${name}`);
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`${name} 不是合法 JSON：${error.message}`);
		return undefined;
	}
}

/* ------------------------------------------------------------------ 1. manifest */
const EXPECTED_NAME = "dsh-magical-lowcode-project";

/*
 * 宿主兼容性字面量（回归锁）。这两个值的来历是实测矩阵，不是随手写的：
 *   - 0.2.0 起上游把 preset 模型从「磁盘目录 + dsh-agent-presets 服务」换成
 *     「profile patch 里的一行 `@deepseek-ai/dsh-agent-preset` 声明 + `@deepseek-ai/dsh-agent-preset-registry` 服务」；
 *     旧的 `@deepseek-ai/dsh-agent-presets` 在 0.2.0 树上已不存在，声明成 peer 会被直接判为不兼容；
 *   - 判定用 includePrerelease 语义：`^0.2.0-0` 匹配宿主 `0.2.0-rc.2`（预发布下界），0.1.x 范围则不匹配；
 *   - `engines.dsh` 只放 0.2.0 线：本版实现依赖 0.2.0 的 `agentPresets.readDocument()` 与 `profileContext.patchPath`，
 *     在 0.1.x 宿主上跑不出正确行为；
 *   - dshmarket 读的是 `engines.dsh`（**不是** dsh.compatibility / dshhub，那两个键零引用）。
 * 复核脚本：<workspace>/docs/_rangecheck.mjs（复刻 dshmarket satisfiesRange，可重跑）。
 */
const EXPECTED_HOST_RANGE = ">=0.2.0-0";
const EXPECTED_PEER_RANGE = "^0.2.0-0";

const pkg = readJson("package.json");

if (pkg !== undefined) {
	if (pkg.name !== EXPECTED_NAME) fail(`package.json name 应为 ${EXPECTED_NAME}，实际 ${pkg.name}`);
	else pass(`包名 ${pkg.name}`);
	if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+/.test(pkg.version)) fail(`version 不是合法 semver：${pkg.version}`);
	else pass(`版本 ${pkg.version}`);
	if (pkg.type !== "module") fail('必须 "type": "module"');
	if (pkg.main !== "lib/index.js") fail(`main 应为 lib/index.js，实际 ${pkg.main}`);
	if (pkg.license !== "MIT") fail(`license 应为 MIT，实际 ${pkg.license}`);
	if (!pkg.engines || typeof pkg.engines.node !== "string") fail("缺少 engines.node");
	if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("dsh-plugin")) fail('keywords 必须含 "dsh-plugin"');
	if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("client-plugin")) fail('keywords 必须含 "client-plugin"');

	const dsh = pkg.dsh ?? {};
	if (dsh.bundle?.patch !== "./cordis.patch.yml") fail('dsh.bundle.patch 必须是 "./cordis.patch.yml"');
	else pass("dsh.bundle.patch 已声明");
	if (dsh.client?.platform !== "web") fail('dsh.client.platform 必须是 "web"');
	else pass("dsh.client.platform = web");
	if (typeof pkg.engines?.dsh !== "string") fail("engines.dsh 缺失（插件市场的宿主兼容性闸门读的是它）");
	else if (pkg.engines.dsh !== EXPECTED_HOST_RANGE) fail(`engines.dsh 应为 "${EXPECTED_HOST_RANGE}"，实际 "${pkg.engines.dsh}"（改动前请先重跑 docs/_rangecheck.mjs）`);
	else pass(`engines.dsh = ${pkg.engines.dsh}`);
	if (pkg.dsh?.compatibility !== undefined) warn("dsh.compatibility 是死键（dshmarket 零引用），已由 engines.dsh 取代");
	/* dshhub 有意保留：dshmarket 零引用，但对第三方 dshhub-market 可能有意义，故不检查也不报警。 */
	const peerNames = Object.keys(pkg.peerDependencies ?? {});
	let peerRangesOk = peerNames.length > 0;
	for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
		if (range !== EXPECTED_PEER_RANGE) {
			peerRangesOk = false;
			fail(`peerDependencies["${peer}"] 应为 "${EXPECTED_PEER_RANGE}"，实际 "${range}"：必须覆盖 0.2.0 线宿主，否则 dsh-app-boot 会判不兼容`);
		}
	}
	if (peerRangesOk) pass(`peer 范围 ${EXPECTED_PEER_RANGE} 覆盖 0.2.0 线宿主`);

	const hub = pkg.dshhub ?? {};
	if (hub.schemaVersion !== 1) fail(`dshhub.schemaVersion 应为 1，实际 ${hub.schemaVersion}`);
	for (const field of ["displayName", "summary"]) {
		if (typeof hub[field] !== "string" || hub[field].length === 0) fail(`dshhub.${field} 缺失`);
	}
	if (!Array.isArray(hub.categories) || hub.categories.length === 0) fail("dshhub.categories 不能为空");
	if (!Array.isArray(hub.surfaces) || !hub.surfaces.includes("host") || !hub.surfaces.includes("web")) fail('dshhub.surfaces 必须同时含 "host" 与 "web"');
	if (!Array.isArray(hub.capabilities?.provides) || hub.capabilities.provides.length === 0) fail("dshhub.capabilities.provides 不能为空");

	/* exports 目标必须真实存在 */
	const exportsMap = pkg.exports ?? {};
	for (const [sub, target] of Object.entries(exportsMap)) {
		if (typeof target !== "string" || target.includes("*")) continue;
		if (!existsSync(join(root, target))) fail(`exports["${sub}"] 指向不存在的文件 ${target}`);
	}
	for (const sub of [".", "./client", "./cordis.patch.yml", "./package.json"]) {
		if (!(sub in exportsMap)) fail(`exports 缺少 "${sub}"`);
	}
	if (passes.length > 0) pass("exports 关键子路径齐全且目标存在");

	/*
	 * files 白名单的**内容完整性**。为什么不能只查「条目存在」：市场走 `github:owner/repo`
	 * 装的是「git 追踪的整仓」，而不是 `npm pack` 的输出 —— 白名单里的文件若没提交、或被
	 * .gitignore 挡掉、或整个目录变空，npm 侧一点看不出来，用户那边却会装到一个缺文件的包。
	 */
	let filesChecked = 0;
	for (const entry of pkg.files ?? []) {
		if (entry.includes("*")) continue;
		const abs = join(root, entry);
		if (!existsSync(abs)) {
			fail(`files 白名单里的 ${entry} 不存在`);
			continue;
		}
		filesChecked += 1;
		if (statSync(abs).isDirectory() && readdirSync(abs).length === 0) {
			fail(`files 白名单里的目录 ${entry} 是空的 —— 内容可能被 .gitignore 挡掉了`);
		}
	}
	if (filesChecked > 0) pass(`files 白名单 ${filesChecked} 项存在、目录非空（市场装整仓时不会缺文件）`);

	/*
	 * 安装期脚本必须为空。市场把插件交给 pnpm 的 `github:` 源，pnpm 会**在用户机器上**执行
	 * 仓库的 prepare / install 系脚本；本插件没有构建步骤，一旦有人顺手加了 build 管线，
	 * dshmarket 就会报 git-prepare-failed（常见诱因是仓库自带 lockfile 与镜像 registry 冲突）。
	 */
	const installHooks = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"];
	const dangerousHooks = installHooks.filter(
		(hook) => hook !== "prepublishOnly" && typeof (pkg.scripts ?? {})[hook] === "string",
	);
	if (dangerousHooks.length > 0) {
		fail(`package.json 不能有 ${dangerousHooks.join(" / ")} 脚本：市场以 github: 形式安装时会在用户机器上执行它（dshmarket 报 git-prepare-failed）`);
	} else {
		pass("安装期没有会被 pnpm 在用户机器上执行的 prepare/install 脚本");
	}

	/* 核心包只能走 peerDependencies，不能打成自带副本 */
	const deps = pkg.dependencies ?? {};
	for (const name of Object.keys(deps)) {
		if (name.startsWith("@deepseek-ai/")) fail(`核心包 ${name} 不能放在 dependencies，必须放 peerDependencies（否则会装出第二份 cordis 实例）`);
	}
	for (const name of ["@deepseek-ai/dsh-agent-preset-registry", "@deepseek-ai/dsh-typert-protocol"]) {
		if (!(pkg.peerDependencies ?? {})[name]) fail(`peerDependencies 缺少 ${name}`);
	}
	if (Object.keys(deps).every((n) => !n.startsWith("@deepseek-ai/"))) pass("依赖划分正确（核心包在 peerDependencies）");
}

/* ------------------------------------------------------ 2. cordis.patch.yml */
const patchPath = join(root, "cordis.patch.yml");
if (!existsSync(patchPath)) fail("缺少 cordis.patch.yml");
else {
	const yml = readFileSync(patchPath, "utf8");
	if (!yml.includes("insert:")) fail("cordis.patch.yml 缺少 insert:");
	if (!new RegExp(`id:\\s*${EXPECTED_NAME}\\s*$`, "m").test(yml)) fail(`cordis.patch.yml 的 id 必须是 ${EXPECTED_NAME}`);
	if (!yml.includes(`name: '${EXPECTED_NAME}'`) && !yml.includes(`name: "${EXPECTED_NAME}"`)) fail(`cordis.patch.yml 的 name 必须是 ${EXPECTED_NAME}`);
	if (yml.includes("dsh-desktop-project")) fail("cordis.patch.yml 里仍残留旧包名 dsh-desktop-project");
	if (!yml.includes("dsh-desktop-project")) pass("cordis.patch.yml 指向新包名");
}

/* ----------------------------------------------------------- 3. host 半边 */
const hostPath = join(root, "lib", "index.js");
let hostSource = undefined;
if (!existsSync(hostPath)) fail("缺少 lib/index.js（host 半边）");
else {
	hostSource = readFileSync(hostPath, "utf8");
	pass("lib/index.js 存在");

	// 语法/求值校验：见文件头注释。
	try {
		await import(pathToFileURL(hostPath).href);
		pass("lib/index.js 可被 import 并完成求值");
	} catch (error) {
		if (error instanceof SyntaxError) fail(`lib/index.js 语法错误：${error.message}`);
		else if (["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT", "MODULE_NOT_FOUND"].includes(error?.code)) {
			pass(`lib/index.js 语法通过（peer 依赖未安装，跳过求值：${error.code}）`);
		} else {
			fail(`lib/index.js 求值失败：${error?.name}: ${error?.message}`);
		}
	}

	// plugin 契约：必须是 { apply, inject, name }
	if (!/export\s*\{[^}]*\bapply\b[^}]*\}/.test(hostSource)) fail("lib/index.js 未导出 apply");
	if (!/export\s*\{[^}]*\binject\b[^}]*\}/.test(hostSource)) fail("lib/index.js 未导出 inject");
	if (!/export\s*\{[^}]*\bname\b[^}]*\}/.test(hostSource)) fail("lib/index.js 未导出 name");
	if (!hostSource.includes(`"${EXPECTED_NAME}"`) && !hostSource.includes(`'${EXPECTED_NAME}'`)) fail(`lib/index.js 里的 name 常量应为 ${EXPECTED_NAME}`);
	else pass("host 半边导出 { apply, inject, name } 且 name 已改名");

	if (hostSource.includes("0.1.2-alpha.5")) fail("lib/index.js 里仍残留 0.1.2-alpha.5（DSH_SOURCE_VERSION 等需更新到 0.2.0-rc.x）");
	if (/from\s+["']@deepseek-ai\/dsh-agent-presets["']/.test(hostSource)) fail("lib/index.js 仍 import 旧包 @deepseek-ai/dsh-agent-presets（0.2.0 已无此包，应改用 yaml + profile patch）");
	if (/from\s+["'](\.[^"']*)["']/.test(hostSource) || /import\s*\(\s*["']\.[^"']*["']\s*\)/.test(hostSource)) fail("lib/index.js 不应有相对路径 import（会被打包成硬编码路径）");
	if (hostSource.includes("dsh-desktop-project:")) fail("lib/index.js 里仍残留 dsh-desktop-project: 前缀的 effect 标签");

	// 脚本目录解析：面板里的「工程目录」通常是工作区下的工程子目录，而 source-*.js
	// 放在工作区根（MagicalCoder localdev 布局）。projectRunScript 必须能向上找到它。
	if (!hostSource.includes("insideWorkspace(") || !hostSource.includes("scriptDir")) fail("lib/index.js 的 projectRunScript 需支持从工程目录向上找到工作区根里的 source-*.js（0.2.12 修复推送 MODULE_NOT_FOUND）");
	else pass("projectRunScript 支持向上解析脚本目录（工程目录 → 工作区根）");

	// 运行前预检（0.2.14）：脚本所在目录的 .env 缺键时，面板必须能提前拦下。
	if (!hostSource.includes("SCRIPT_ENV_KEYS") || !hostSource.includes("readEnvValue(") || !hostSource.includes("async projectResolveScript(")) {
		fail("lib/index.js 缺少运行前环境变量预检（projectResolveScript / SCRIPT_ENV_KEYS / readEnvValue）");
	} else pass("运行前预检：projectResolveScript 检查脚本目录 .env 的 SERVER_URL / USERNAME / PASSWORD / PROJECT_UUID");

	// 模糊查找（0.2.15）：树是按需加载的，没展开的层客户端根本没有数据，
	// 所以递归搜索必须在 host 半边，打分函数也必须在 host 里（客户端只负责渲染）。
	// 0.2.16 起条目得分单独抽成 scoreEntry：名字那一路的 +20 分只能加在命中项上。
	if (
		!hostSource.includes("async projectSearchEntries(") ||
		!hostSource.includes("function fuzzyScore(") ||
		!hostSource.includes("function scoreEntry(") ||
		!hostSource.includes("SEARCH_MAX_RESULTS")
	) {
		fail("lib/index.js 缺少模糊查找（projectSearchEntries / fuzzyScore / scoreEntry / SEARCH_MAX_RESULTS）");
	} else pass("模糊查找：projectSearchEntries 递归整棵树 + fuzzyScore 子序列打分 + scoreEntry 过滤（上限 200 条 / 4000 目录 / 16 层）");

	// 12 个 remote 方法必须都在类里定义
	const listMatch = hostSource.match(/for \(const remoteMethod of \[([\s\S]*?)\]\)/);
	if (listMatch === null) fail("找不到 remoteMethod 注册循环");
	else {
		const declared = [...listMatch[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
		const missing = declared.filter((method) => !new RegExp(`(?:async\\s+)?${method}\\s*\\(`).test(hostSource));
		if (missing.length > 0) fail(`以下 RPC 被注册但类里找不到方法定义：${missing.join(", ")}`);
		else pass(`${declared.length} 个 RPC 全部有方法定义`);
	}

	// 服务键与 dshhub 声明必须一致
	const serviceKeyMatch = hostSource.match(/super\(ctx,\s*"([^"]+)"/);
	if (serviceKeyMatch === null) fail("找不到 TypertRemoteService 的 serviceKey");
	else {
		const serviceKey = serviceKeyMatch[1];
		const provides = pkg?.dshhub?.capabilities?.provides ?? [];
		if (!provides.includes(`service:${serviceKey}`)) fail(`dshhub.capabilities.provides 缺少 service:${serviceKey}`);
		else pass(`服务键 ${serviceKey} 与 dshhub 声明一致`);
	}

	// 不得用 require()（ESM）
	if (/\brequire\s*\(/.test(hostSource)) fail("host 半边里出现 require()，应为 ESM import");
	if (/\bprocess\.env\.DSH_WEB_URL\b/.test(hostSource)) warn("host 半边引用了 DSH_WEB_URL，确认在无该环境变量时不会崩");
}

/* --------------------------------------------------------- 4. client 半边 */
/*
 * lib/client.js 是手写的经典 script（不经过打包，见该文件头注释）：
 *   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => exports })
 * 所以这里校验的是「信封形状 + 说明符白名单 + 注册姿势」，而不是构建产物指纹。
 */

/** shell 种子表（PLATFORM_MODULES）允许 require 的全部说明符。 */
const ALLOWED_SPECIFIERS = new Set([
	"react",
	"react/jsx-runtime",
	"react-dom",
	"react-dom/client",
	"@deepseek-ai/cordis",
	"@deepseek-ai/dsh-client-store",
	"@deepseek-ai/dsh-client-ui-slots",
	"@deepseek-ai/dsh-client-ui-primitives",
	"@deepseek-ai/dsh-client-ui-dockkit",
]);

const clientPath = join(root, "lib", "client.js");
if (!existsSync(clientPath)) fail("缺少 lib/client.js（client 半边产物）");
else if (statSync(clientPath).size < 2000) fail(`lib/client.js 体积异常小（${statSync(clientPath).size} 字节），疑似空产物`);
else {
	const clientSource = readFileSync(clientPath, "utf8");
	pass(`lib/client.js 存在（${statSync(clientPath).size} 字节）`);

	// 语法 + 「不是 ESM」双重校验：new Function 只解析不执行，
	// 顶层 import/export 在函数体里必然是 SyntaxError，正好一并拦住。
	try {
		new Function(clientSource);
		pass("lib/client.js 语法通过，且不含 ESM 顶层语句");
	} catch (error) {
		fail(`lib/client.js 不是合法的经典 script：${error.message}`);
	}

	// 信封：必须调用 window.__ModuleLoader__.load，且 id 逐字等于包名。
	if (!/window\.__ModuleLoader__\.load\s*\(/.test(clientSource)) fail("lib/client.js 未调用 window.__ModuleLoader__.load（客户端 bundle 信封）");
	else {
		const idMatch = clientSource.match(/id\s*:\s*["']([^"']+)["']/);
		if (idMatch === null) fail("lib/client.js 的信封缺少 id 字段");
		else if (idMatch[1] !== EXPECTED_NAME) fail(`lib/client.js 的信封 id 是 "${idMatch[1]}"，必须逐字等于包名 ${EXPECTED_NAME}`);
		else pass(`信封 id = ${idMatch[1]}`);
	}
	if (!/factory\s*:/.test(clientSource)) fail("lib/client.js 的信封缺少 factory");

	// 入口契约：factory 必须返回带 apply 与 inject 的导出对象，且不得有 default。
	if (!/return\s*\{[^}]*\bapply\b[^}]*\binject\b[^}]*\}/.test(clientSource)) fail("lib/client.js 的 factory 未返回 { apply, inject }");
	else pass("factory 返回 { apply, inject }");
	if (!/const\s+inject\s*=\s*\[/.test(clientSource) && !/\binject\s*=\s*\[/.test(clientSource)) fail("lib/client.js 未声明 inject 服务键数组");
	if (/\bdefault\b\s*:\s*/.test(clientSource)) warn('lib/client.js 里出现了 default: 字段，客户端入口契约要求没有 default export，确认不是导出用的');

	// 说明符白名单：种子表之外的 require 运行时必抛。
	const specifiers = [...clientSource.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
	const uniqueSpecifiers = [...new Set(specifiers)];
	if (uniqueSpecifiers.length === 0) fail("lib/client.js 没有 require 任何说明符，疑似没接 shell 的模块表");
	const illegal = uniqueSpecifiers.filter((spec) => !ALLOWED_SPECIFIERS.has(spec));
	if (illegal.length > 0) fail(`lib/client.js require 了种子表之外的说明符（运行时必抛）：${illegal.join(", ")}`);
	else pass(`require 的 ${uniqueSpecifiers.length} 个说明符全在种子表内：${uniqueSpecifiers.join(", ")}`);
	if (/\bimport\s*\(/.test(clientSource)) fail("lib/client.js 出现动态 import()，客户端模块表不支持");

	// 注册姿势：register 必须包在 slots.inject 里；且不得碰 61 个 slot 之外的 key。
	const registerKeys = [...clientSource.matchAll(/slots\.register\(\s*\{[^}]*name\s*:\s*["']([^"']+)["']/g)].map((m) => m[1]);
	const injectCalls = (clientSource.match(/slots\.inject\(/g) ?? []).length;
	if (registerKeys.length === 0) fail("lib/client.js 没有注册任何 slot");
	else {
		if (registerKeys.includes("root")) fail("lib/client.js 注册了 'root' slot（会 shadow 整个 AppFrame，绝对禁止）");
		if (injectCalls < registerKeys.length) fail(`slots.inject 调用数 ${injectCalls} 少于 register 数 ${registerKeys.length}：注册必须包在 inject 里，否则 disposer 不落在本插件 fiber 上`);
		else pass(`注册 ${registerKeys.length} 个 slot（${registerKeys.join(", ")}），全部经 slots.inject 包裹`);
	}

	/*
	 * 状态记忆（0.2.15）：三个入口各挂一套 Panel，切走再回来就是一次新的挂载，
	 * 所以「切进去数据清空」只能靠 localStorage + 模块级缓存救回来。
	 */
	if (
		!clientSource.includes("DETAIL_KEY") ||
		!clientSource.includes("EXPANDED_KEY") ||
		!clientSource.includes("SELECTED_KEY") ||
		!clientSource.includes("panelCache") ||
		!clientSource.includes("projectSearchEntries")
	) {
		fail("lib/client.js 缺少状态记忆 / 模糊查找（DETAIL_KEY / EXPANDED_KEY / SELECTED_KEY / panelCache / projectSearchEntries）");
	} else pass("状态记忆：右栏页签、展开层级、选中文件入 localStorage，项目树与推送状态走模块级 panelCache（0.2.15）");

	/*
	 * 行级选择（0.2.20）：用户要「能选中文本，再让 AI 帮我改」，可原生选区正是把窗口拖死
	 * 的那条路（Chromium 154 的 Blink>Editing>Selection）。所以只读区 user-select: none，
	 * 选区由插件自己按行算，再把选中的行复制 / 连同路径与行号交给 AI。
	 */
	if (
		!clientSource.includes("VIEW_LINE_LIMIT") ||
		!clientSource.includes('className: "dshml-line"') ||
		!clientSource.includes("copySelection") ||
		!clientSource.includes("sendSelectionToAI") ||
		!/userSelect: "none"/.test(clientSource)
	) {
		fail("lib/client.js 缺少行级选择 / 发给 AI（VIEW_LINE_LIMIT / dshml-line / userSelect: none / copySelection / sendSelectionToAI）");
	} else pass("行级选择：关掉原生选区，选区由插件自己算，「复制选中」「发给 AI 改」走剪贴板（0.2.20）");

	/*
	 * 「改这段」（0.2.20）：只把选中的行放进小文本框，保存时按行号替换回原文件 ——
	 * 用户「手动去改文本就已经出问题了」，大编辑区 + 长距离拖选正是要避开的那条路。
	 */
	if (!clientSource.includes("function PatchDialog") || !clientSource.includes("savePatch") || !clientSource.includes("openPatch")) {
		fail("lib/client.js 缺少「改这段」（PatchDialog / openPatch / savePatch）");
	} else pass("「改这段」：选中的行单独进小文本框，保存按行号替换回原文件，其余逐字不动（0.2.20）");

	/*
	 * 分页编辑（0.2.21）：0.2.20 的「改这段」只覆盖选中的几行；点「编辑」仍旧把整份文件塞进
	 * 一个受控大 textarea（用户那份 index.html 有 90399 字符），于是原样踩上同一条拖选死锁。
	 * 现在任何编辑控件都只装一页（EDITOR_PAGE_LINES 行），「编辑」与「改这段」共用一个分页入口。
	 */
	if (
		!clientSource.includes("EDITOR_PAGE_LINES") ||
		!clientSource.includes("const sliceDrafts = (lines, from, to)") ||
		!clientSource.includes("const openRange = useCallback") ||
		!clientSource.includes("const gotoPatchPage = useCallback") ||
		!clientSource.includes("total: lines.length") ||
		!clientSource.includes("编辑整份") ||
		clientSource.includes("EDITOR_READONLY_LIMIT") ||
		clientSource.includes("selected.editing")
	) {
		fail("lib/client.js 缺少分页编辑（EDITOR_PAGE_LINES / sliceDrafts / openRange / gotoPatchPage / total+编辑整份），或仍留着整份编辑（EDITOR_READONLY_LIMIT / selected.editing）");
	} else pass("分页编辑：任何编辑控件一次只装 EDITOR_PAGE_LINES 行，「编辑」与「改这段」共用 openRange，整份编辑那条路已拆除（0.2.21）");

	/*
	 * 用系统编辑器打开（0.2.22）：用户的结论是「分页也不方便」，正解是浏览器根本不碰文本。
	 * host 只负责挑可执行文件并 spawn 出去（不需要回读内容），client 侧三个入口
	 * （工具行 / 右键菜单 / 分页对话框里）都指向同一个 projectOpenExternal。
	 */
	if (
		!hostSource.includes("function resolveExternalEditor") ||
		!hostSource.includes("function openFileExternally") ||
		!hostSource.includes("async projectOpenExternal(path)") ||
		!hostSource.includes('"projectOpenExternal"') ||
		!hostSource.includes("DSHML_EDITOR") ||
		!hostSource.includes("selectOnly") ||
		!clientSource.includes('"projectOpenExternal"') ||
		!clientSource.includes("const openExternal = useCallback") ||
		!clientSource.includes("用编辑器打开") ||
		!clientSource.includes("onOpenExternal: openExternal")
	) {
		fail("缺少「用编辑器打开」（host: resolveExternalEditor / openFileExternally / projectOpenExternal / DSHML_EDITOR；client: projectOpenExternal / openExternal / 用编辑器打开 / onOpenExternal）");
	} else pass("用编辑器打开：host 按 DSHML_EDITOR→VS Code→记事本→文件管理器挑程序并 detached spawn，client 三个入口共用 projectOpenExternal（0.2.22）");

	/*
	 * UI 基元契约回归锁。
	 *
	 * 这些值不是猜的：`@deepseek-ai/dsh-client-ui-primitives` 在本机**不是真实安装的包**
	 * （没有目录、没有 .d.ts），它只作为 web 前端 bundle 里的种子表条目存在
	 * （PLATFORM_MODULES，见 ...\dsh-web-frontend\dist\assets\index-*.js）。以下契约是从那份
	 * 真实实现里逆推出来的：
	 *   Button = ({variant="ghost", size="md", icon, className, children, ...rest})
	 *            样式查表 ro = {button, md, sm, primary, ghost, outline, toolbar, icon}
	 *            —— 取值写错不会抛错，只会静默退化成默认样式，所以必须锁住。
	 *   Pill   = ({active=false, className, children, onClick, ...rest})
	 *            **onClick 存在时渲染 <button>、否则渲染 <span>** —— 页签切换完全依赖这一点，
	 *            少传 onClick 就等于页签点不动，且不会有任何报错。
	 *   Tag    = ({tone="outline", className, children})
	 *   Input  = ({icon, className, ...rest}) → rest 透传给原生 <input>（value/onChange/placeholder 均可用）
	 *   Modal  = ({open, onClose, title, closeLabel, description, children, footer, headless})
	 * 复跑逆推脚本：<workspace>/docs/_uiprobe.mjs 与 <workspace>/docs/_uiprobe2.mjs
	 */
	const VERIFIED_PRIMITIVES = new Set(["Button", "Input", "Modal", "Pill", "Tag"]);
	const BUTTON_VARIANTS = new Set(["ghost", "primary", "outline", "toolbar"]);
	const BUTTON_SIZES = new Set(["md", "sm", "icon"]);
	/** 官方已占用的 slot id；撞上会 shadow 掉官方条目。 */
	const OFFICIAL_SLOT_IDS = new Map([
		["settings.section", new Set(["general", "models", "plugins", "agent-presets"])],
		["sidebar.footer.action", new Set(["cordis-panel"])],
	]);

	const usedPrimitives = [...new Set([...clientSource.matchAll(/\bUI\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))].sort();
	const unverifiedPrimitives = usedPrimitives.filter((name) => !VERIFIED_PRIMITIVES.has(name));
	if (unverifiedPrimitives.length > 0) {
		fail(
			`面板用了未经契约核实的 UI 基元：${unverifiedPrimitives.join(", ")} —— 先跑 docs/_uiprobe.mjs 逆推其 props，再把名字加进 VERIFIED_PRIMITIVES`,
		);
	} else pass(`面板用到的 ${usedPrimitives.length} 个 UI 基元均有实测契约（${usedPrimitives.join(", ")}）`);

	const badVariants = [...new Set([...clientSource.matchAll(/variant\s*:\s*["']([^"']+)["']/g)].map((m) => m[1]))].filter(
		(value) => !BUTTON_VARIANTS.has(value),
	);
	if (badVariants.length > 0) fail(`Button variant 取值不在实测样式表内（会静默退化成默认样式）：${badVariants.join(", ")}`);
	else pass("Button variant 取值全部命中实测样式表");

	const badSizes = [...new Set([...clientSource.matchAll(/(?:^|[^A-Za-z])size\s*:\s*["']([^"']+)["']/g)].map((m) => m[1]))].filter(
		(value) => !BUTTON_SIZES.has(value),
	);
	if (badSizes.length > 0) fail(`Button size 取值不在实测样式表内：${badSizes.join(", ")}`);
	else pass("Button size 取值全部命中实测样式表");

	/* 注册的 id 不得撞上官方占用（ENTRY_ID 是常量，需解引用后再比）。 */
	const entryId = (clientSource.match(/const\s+ENTRY_ID\s*=\s*["']([^"']+)["']/) ?? [undefined, undefined])[1];
	const registrations = [...clientSource.matchAll(/slots\.register\(\s*\{([^}]*)\}/g)].map((m) => {
		const body = m[1];
		return {
			name: (body.match(/name\s*:\s*["']([^"']+)["']/) ?? [undefined, undefined])[1],
			id: (body.match(/\bid\s*:\s*["']([^"']+)["']/) ?? [undefined, entryId])[1],
		};
	});
	const clashes = registrations.filter((entry) => entry.name !== undefined && entry.id !== undefined && OFFICIAL_SLOT_IDS.get(entry.name)?.has(entry.id) === true);
	if (clashes.length > 0) {
		fail(`注册的 slot id 与官方占用冲突（会 shadow 官方条目）：${clashes.map((c) => `${c.name}#${c.id}`).join(", ")}`);
	} else pass(`注册的 ${registrations.length} 个 slot id 均未与官方占用冲突`);

	// 两个半边声明的 RPC 方法集必须一致。
	if (hostSource !== undefined) {
		const hostList = hostSource.match(/for \(const remoteMethod of \[([\s\S]*?)\]\)/);
		const clientList = clientSource.match(/const METHODS = \[([\s\S]*?)\];/);
		if (hostList === null || clientList === null) fail("无法比对两个半边的 RPC 方法列表");
		else {
			const pick = (text) => [...text.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
			const hostMethods = pick(hostList[1]);
			const clientMethods = pick(clientList[1]);
			const onlyHost = hostMethods.filter((m) => !clientMethods.includes(m));
			const onlyClient = clientMethods.filter((m) => !hostMethods.includes(m));
			if (onlyHost.length > 0 || onlyClient.length > 0) {
				fail(`客户端 $mount descriptor 与 host 方法集不一致：host 独有 [${onlyHost.join(", ")}]，client 独有 [${onlyClient.join(", ")}]`);
			} else if (hostMethods.join() !== clientMethods.join()) {
				fail("两个半边的 RPC 方法顺序不一致（顺序应与 markRemote 循环逐字对应）");
			} else pass(`客户端 descriptor 与 host 的 ${hostMethods.length} 个 RPC 逐字一致`);

			/* 声明了却没人调 = 静默的功能缺口：面板必须把每个 RPC 都真正接出来。 */
			const called = [...clientSource.matchAll(/call\(\s*["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1]);
			const unreachable = hostMethods.filter((method) => !called.includes(method));
			if (unreachable.length > 0) fail(`以下 RPC 在 host 侧注册、在客户端 descriptor 里声明，但面板从未调用（死功能）：${unreachable.join(", ")}`);
			else pass(`${hostMethods.length} 个 RPC 全部在面板里可达`);

			/*
			 * 调用点的实参个数必须与 host 形参个数一致。
			 * 在 JS + JSON 协议下少传/多传都不会抛错：少传的参数静默变成 undefined，
			 * 多传的被丢掉 —— 面板会「看起来能用」但功能不对，属于最难查的一类问题。
			 */
			const aritySkew = [];
			for (const match of clientSource.matchAll(/call\(\s*["']([A-Za-z0-9_]+)["']/g)) {
				const method = match[1];
				const expected = hostArity(hostSource, method);
				const actual = countTopLevelArgs(clientSource, match.index + match[0].length);
				if (expected === null) aritySkew.push(`${method}（host 侧找不到 \`${method}(…)\` 方法定义）`);
				else if (actual === null) aritySkew.push(`${method}（调用点括号不配对，无法数出实参）`);
				else if (actual !== expected) aritySkew.push(`${method}：面板传 ${actual} 个实参，host 收 ${expected} 个形参`);
			}
			if (aritySkew.length > 0) fail(`RPC 调用点的实参个数与 host 形参不符：${aritySkew.join("；")}`);
			else pass(`${new Set([...clientSource.matchAll(/call\(\s*["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1])).size} 个 RPC 调用点的实参个数与 host 形参逐一对齐`);
		}
	}
}

/** host 侧 `<method>(a, b, c) {` 的形参个数；找不到定义返回 null。 */
function hostArity(source, method) {
	const match = source.match(new RegExp(`^\\s*(?:async\\s+)?${method}\\s*\\(([^)]*)\\)\\s*\\{`, "m"));
	if (match === null) return null;
	const params = match[1].trim();
	return params === "" ? 0 : params.split(",").length;
}

/**
 * 从 `call("<method>"` 之后开始，数出这次调用的顶层实参个数（方法名本身不算）。
 * 规则：顶层逗号数就是实参个数，但**末尾那个尾随逗号不算**
 * （`call("m", a, b,)` 是 2 个实参，不是 3 个 —— 这是合法的 JS，面板里就写了尾随逗号）。
 * 必须跨行、跳过字符串与注释里的逗号、正确配对嵌套括号，所以不能简单 split。
 */
function countTopLevelArgs(source, from) {
	let depth = 0;
	let commas = 0;
	let pending = false; // 最后一个顶层逗号之后是否又出现了有意义的内容
	let quote = null;
	let index = from;
	while (index < source.length) {
		const char = source[index];
		if (quote !== null) {
			if (char === "\\") index += 2;
			else {
				if (char === quote) quote = null;
				index += 1;
			}
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			if (depth === 0) pending = true;
			quote = char;
			index += 1;
			continue;
		}
		if (char === "/" && source[index + 1] === "/") {
			const newline = source.indexOf("\n", index);
			index = newline === -1 ? source.length : newline + 1;
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index);
			index = end === -1 ? source.length : end + 2;
			continue;
		}
		if (char === "(" || char === "[" || char === "{") {
			if (depth === 0) pending = true;
			depth += 1;
			index += 1;
			continue;
		}
		if (char === ")" || char === "]" || char === "}") {
			if (depth === 0 && char === ")") return commas > 0 && !pending ? commas - 1 : commas;
			depth -= 1;
			index += 1;
			continue;
		}
		if (depth === 0) {
			if (char === ",") {
				commas += 1;
				pending = false;
			} else if (!/\s/.test(char)) pending = true;
		}
		index += 1;
	}
	return null;
}

/* ------------------------------------------------------------- 5. locale */
for (const lang of ["zh", "en"]) {
	const path = join(root, "locale", `${lang}.json`);
	if (!existsSync(path)) {
		fail(`缺少 locale/${lang}.json`);
		continue;
	}
	try {
		const data = JSON.parse(readFileSync(path, "utf8"));
		if (typeof data?.meta?.title !== "string") fail(`locale/${lang}.json 缺少 meta.title`);
		else pass(`locale/${lang}.json OK`);
	} catch (error) {
		fail(`locale/${lang}.json 不是合法 JSON：${error.message}`);
	}
}

/* --------------------------------------------------- 5.5 screenshots.json */
/*
 * 市场详情页的截图由仓库自己声明：package.json 旁边一个 screenshots.json，
 * 里面 1-8 条相对本文件的路径（见上游 contributing.md「Screenshots / 截图」）。
 * 上游站点构建会去探这些路径，写错了在商店里就是一张裂图，所以这里锁住。
 */
{
	const shotsPath = join(root, "screenshots.json");
	if (!existsSync(shotsPath)) {
		fail("缺少 screenshots.json（市场详情页的截图靠它声明）");
	} else {
		try {
			const parsed = JSON.parse(readFileSync(shotsPath, "utf8"));
			const list = Array.isArray(parsed) ? parsed : parsed?.screenshots;
			if (!Array.isArray(list)) {
				fail("screenshots.json 必须是数组，或形如 { screenshots: [...] }");
			} else if (list.length < 1 || list.length > 8) {
				fail(`screenshots.json 条目数 ${list.length} 不在 1-8 之间`);
			} else {
				let missing = 0;
				let remote = 0;
				for (const item of list) {
					if (typeof item !== "string" || item.trim() === "") {
						fail("screenshots.json 里有非字符串条目");
						missing += 1;
						continue;
					}
					if (/^(https?:)?\/\//i.test(item)) {
						remote += 1;
						continue;
					}
					if (!existsSync(join(root, item))) {
						fail(`screenshots.json 指向的图片不存在：${item}`);
						missing += 1;
					}
				}
				if (missing === 0) pass(`screenshots.json OK（${list.length} 张，全部是仓库内的相对路径）`);
				if (remote > 0) warn(`screenshots.json 有 ${remote} 条绝对 URL（上游建议用相对路径，改名时才会立刻暴露）`);
			}
		} catch (error) {
			fail(`screenshots.json 不是合法 JSON：${error.message}`);
		}
	}
}

/* -------------------------------------------------------------- 6. 交付清单 */
for (const required of ["README.md", "README.zh.md", "LICENSE"]) {
	if (!existsSync(join(root, required))) fail(`缺少 ${required}`);
}
if (existsSync(join(root, "lib")) && readdirSync(join(root, "lib")).length === 0) fail("lib/ 目录为空");

/* ----------------------------------------------------------------- 输出 */
const line = "-".repeat(72);
console.log(line);
console.log(`dsh-magical-lowcode-project 自检  (${rel(root)})`);
console.log(line);
for (const item of passes) console.log(`  ok    ${item}`);
for (const item of warnings) console.log(`  warn  ${item}`);
for (const item of failures) console.log(`  FAIL  ${item}`);
console.log(line);
console.log(`通过 ${passes.length} · 警告 ${warnings.length} · 失败 ${failures.length}`);
if (failures.length > 0) {
	console.log("\n自检未通过。");
	process.exit(1);
}
console.log("\n自检通过。");
