#!/usr/bin/env node
/**
 * dsh-magical-lowcode-project 已安装副本的解析自检。
 *
 * verify.mjs 检查的是「源码树里的字节长什么样」；这个脚本检查的是
 * **装进某个 DSH profile 之后的副本能不能真的被 import 并求值** —— 也就是
 * `dsh plugin --profile <name> add <tarball|dir>` 之后宿主启动时走的同一条路径。
 *
 * 为什么不能直接 `import("dsh-magical-lowcode-project")`：Node 的裸说明符解析
 * 相对**发起 import 的文件**所在目录，而不是 cwd，所以脚本放哪儿都解得不对。
 * 因此这里显式拿到已安装包目录，用绝对 file URL 去 import，让包内
 * `import "fflate"` / `import "@deepseek-ai/dsh-agent-presets"` 按真实安装布局
 * 逐级向上解析 —— 这才是要测的东西。
 *
 * 用法：
 *   node test/installed-check.mjs "<profile>/node_modules/dsh-magical-lowcode-project"
 *   node test/installed-check.mjs --from-profile <profileDir>
 *
 * 一次性的真机验证流程：
 *   DSH_HOME=<scratch> dsh plugin --profile <p> add <abs path to .tgz>
 *   node test/installed-check.mjs --from-profile <scratch>/profiles/<p>
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_NAME = "dsh-magical-lowcode-project";
const failures = [];
const passes = [];
const fail = (msg) => failures.push(msg);
const pass = (msg) => passes.push(msg);

/* ------------------------------------------------------------ 定位已安装包 */

const argv = process.argv.slice(2);
let packageDir;

if (argv[0] === "--from-profile") {
	if (typeof argv[1] !== "string") {
		console.error("用法：node test/installed-check.mjs --from-profile <profileDir>");
		process.exit(2);
	}
	packageDir = join(resolve(argv[1]), "node_modules", EXPECTED_NAME);
} else if (typeof argv[0] === "string") {
	packageDir = resolve(argv[0]);
} else {
	console.error("用法：node test/installed-check.mjs <已安装包目录> | --from-profile <profileDir>");
	process.exit(2);
}

console.log(`已安装副本：${packageDir}`);

if (!existsSync(packageDir)) {
	console.log(`  FAIL  目录不存在（先跑 dsh plugin --profile <p> add <tarball>）`);
	process.exit(1);
}

const manifestPath = join(packageDir, "package.json");
if (!existsSync(manifestPath)) {
	console.log("  FAIL  副本里没有 package.json");
	process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.name !== EXPECTED_NAME) fail(`package.json name 是 ${manifest.name}，应为 ${EXPECTED_NAME}`);
else pass("副本 package.json 包名正确");

/* ------------------------------------------------- 1. host 半边：导入图可解析 */

const entry = join(packageDir, "lib", "index.js");
if (!existsSync(entry)) fail("副本缺少 lib/index.js");
else {
	try {
		const module = await import(pathToFileURL(entry).href);
		pass("lib/index.js 在已安装布局下完成求值（fflate 与两个 peer 都解析到了）");
		if (module.name !== EXPECTED_NAME) fail(`导出的 name 是 ${module.name}`);
		else pass(`导出 name = ${module.name}`);
		if (typeof module.apply !== "function") fail("未导出 apply 函数");
		else pass("导出 apply 函数");
		if (!Array.isArray(module.inject) || module.inject.length === 0) fail("未导出 inject 数组");
		else pass(`导出 inject = [${module.inject.join(", ")}]`);
	} catch (error) {
		if (error?.code === "ERR_MODULE_NOT_FOUND") {
			fail(`副本的依赖解析失败（profile 里缺这个包，宿主启动时整个 profile 会挂）：${error.message.split("\n")[0]}`);
		} else if (error instanceof SyntaxError) {
			fail(`副本 lib/index.js 语法错误：${error.message}`);
		} else {
			fail(`副本求值失败：${error?.name}: ${error?.message}`);
		}
	}
}

/* --------------------------------------------- 2. client 半边：exports 映射可达 */

const clientRel = manifest.exports?.["./client"];
const clientTarget = typeof clientRel === "string" ? clientRel : undefined;
if (clientTarget === undefined) fail('package.json 里没有 exports["./client"]');
else {
	const clientPath = join(packageDir, clientTarget);
	if (!existsSync(clientPath)) fail(`exports["./client"] 指向的 ${clientTarget} 在副本里不存在（客户端半边会 404）`);
	else if (statSync(clientPath).size < 2000) fail(`副本 ${clientTarget} 体积异常（${statSync(clientPath).size} 字节）`);
	else {
		pass(`exports["./client"] → ${clientTarget}（${statSync(clientPath).size} 字节）`);
		const source = readFileSync(clientPath, "utf8");
		if (!/window\.__ModuleLoader__\.load\s*\(/.test(source)) fail("客户端副本没有 __ModuleLoader__.load 信封");
		else {
			const idMatch = source.match(/id\s*:\s*["']([^"']+)["']/);
			if (idMatch === null || idMatch[1] !== EXPECTED_NAME) fail(`客户端信封 id 与包名不一致：${idMatch?.[1]}`);
			else pass(`客户端信封 id = ${idMatch[1]}`);
		}
	}
}

/* ------------------------------------------------ 3. cordis patch 与 bundle 声明 */

if (!existsSync(join(packageDir, "cordis.patch.yml"))) fail("副本缺少 cordis.patch.yml（profile 会启动失败）");
else pass("副本含 cordis.patch.yml");
if (manifest.dsh?.bundle?.patch !== "./cordis.patch.yml") fail("副本的 dsh.bundle.patch 声明不对（市场准入检查读的是它）");
else pass("dsh.bundle.patch 声明正确");

/* -------------------------------------------------------------------- 输出 */

const line = "-".repeat(72);
console.log(line);
for (const item of passes) console.log(`  ok    ${item}`);
for (const item of failures) console.log(`  FAIL  ${item}`);
console.log(line);
console.log(`通过 ${passes.length} · 失败 ${failures.length}`);
process.exit(failures.length > 0 ? 1 : 0);
