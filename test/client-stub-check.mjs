#!/usr/bin/env node
/**
 * dsh-magical-lowcode-project 客户端半边 · 逻辑层桩检。
 *
 * 为什么需要它：`verify.mjs` 只对 `lib/client.js` 做**静态**检查（字节、正则、语法），
 * 而浏览器内的真机检查（`browser-check.mjs`）在拒绝启动浏览器的沙箱里跑不了。
 * 中间这一层 —— 「把 factory 真的执行一遍，看 apply() 到底注册了什么」——
 * 不需要浏览器也不需要网络，靠桩件就能覆盖，而且能覆盖 apply 的全部分支
 * （含 remote/slots 缺失时的降级路径）。
 *
 * 做法：用 `node:vm` 以经典 script 的方式执行 `lib/client.js`（它的顶层只有一次
 * `window.__ModuleLoader__.load(...)` 调用），截下它的注册信封，再用桩 `require`
 * 调 `factory(require)` 拿到导出，最后用一个记录型的假 ctx 调 `apply(ctx)`，
 * 逐条断言它挂载的 contribution 与注册的 slot。
 *
 * 用法：node test/client-stub-check.mjs
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

/* ------------------------------------------------------------ 1. 执行 bundle、截信封 */

const clientSource = read("lib/client.js");
const captured = {};
const sandbox = {
	window: {
		__ModuleLoader__: {
			load(registration) {
				captured.registration = registration;
			},
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
if (registration === undefined) {
	fail("lib/client.js 没有调用 window.__ModuleLoader__.load(...)");
} else {
	pass("顶层只做了一次 __ModuleLoader__.load 注册");
}

/* ------------------------------------------------------------ 2. 桩件 */

/** 与 lib/index.js 的 markRemote 列表交叉校准，避免两边各写一份常量。 */
const hostSource = read("lib/index.js");
const hostListMatch = hostSource.match(/for \(const remoteMethod of \[([\s\S]*?)\]\)/);
const hostMethods = hostListMatch === null ? [] : [...hostListMatch[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
if (hostMethods.length === 0) fail("无法从 lib/index.js 解析出 RPC 方法列表");

const reactStub = {
	createElement: (type, props, ...children) => ({ __element: true, type, props, children }),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useCallback: (fn) => fn,
	useRef: (initial) => ({ current: initial === undefined ? null : initial }),
	Fragment: Symbol("Fragment"),
};
const primitivesStub = {
	Button: "stub.Button",
	Input: "stub.Input",
	Modal: "stub.Modal",
	Pill: "stub.Pill",
	Tag: "stub.Tag",
};
const requiredSpecifiers = [];
const requireStub = (specifier) => {
	requiredSpecifiers.push(specifier);
	if (specifier === "react") return reactStub;
	if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
	throw new Error(`桩 require 收到预期外的说明符：${specifier}`);
};

/** 造一个记录型的假 ctx；`options` 用来模拟服务缺失的降级场景。 */
function makeCtx(options = {}) {
	const record = { mounts: [], effects: [], gets: [], injects: [], registers: [] };
	const slots = {
		inject(key, callback) {
			record.injects.push(key);
			const disposer = callback();
			return typeof disposer === "function" ? disposer : () => {};
		},
		register(contribution, component) {
			record.registers.push({ contribution, component });
			return () => {};
		},
	};
	const rpcHandle = { __rpc: true };
	const ctx = {
		remote:
			options.withoutRemote === true
				? undefined
				: {
						async $mount(contribution) {
							record.mounts.push(contribution);
							if (options.mountThrows === true) throw new Error("mount failed (桩)");
							return () => {};
						},
					},
		get(name) {
			record.gets.push(name);
			if (name === "slots") return options.withoutSlots === true ? undefined : slots;
			if (name === "remote.desktopProject") return rpcHandle;
			return undefined;
		},
		effect(execute, label) {
			record.effects.push(label);
			const disposer = execute();
			return typeof disposer === "function" ? disposer : () => {};
		},
	};
	return { ctx, record };
}

/* ------------------------------------------------------------ 3. 正常路径 */

if (registration !== undefined) {
	if (registration.id !== "dsh-magical-lowcode-project") {
		fail(`信封 id 是 "${registration.id}"，必须逐字等于包名`);
	} else {
		pass(`信封 id = ${registration.id}`);
	}
	if (typeof registration.factory !== "function") {
		fail("信封 factory 不是函数");
	} else {
		let exported;
		try {
			exported = registration.factory(requireStub);
		} catch (error) {
			fail(`factory(require) 执行抛错：${error?.message ?? error}`);
		}
		if (exported !== undefined && exported !== null) {
			pass(`factory(require) 返回导出；require 命中 [${[...new Set(requiredSpecifiers)].join(", ")}]`);

			if (typeof exported.apply !== "function") fail("导出里没有 apply 函数");
			else pass("导出含 apply 函数");
			if (!Array.isArray(exported.inject)) fail("导出里没有 inject 数组");
			else if (exported.inject.join() !== "remote") fail(`inject 应为 ["remote"]，实际 [${exported.inject.join(", ")}]`);
			else pass('导出 inject = ["remote"]');

			if (typeof exported.apply === "function") {
				const { ctx, record } = makeCtx();
				let thrown;
				try {
					const returned = exported.apply(ctx);
					if (returned === null || typeof returned?.then !== "function") {
						info("apply 返回的不是 Promise（当前实现是 async，预期是 Promise）");
					}
					await returned;
				} catch (error) {
					thrown = error;
				}
				if (thrown !== undefined) {
					fail(`apply(ctx) 在正常路径下抛错：${thrown?.message ?? thrown}`);
				} else {
					pass("apply(ctx) 正常路径未抛错");

					/* 3.1 $mount 的 contribution */
					if (record.mounts.length !== 1) fail(`apply 应恰好调用一次 remote.$mount，实际 ${record.mounts.length} 次`);
					else {
						const contribution = record.mounts[0];
						if (contribution.package !== "dsh-magical-lowcode-project") {
							fail(`contribution.package 是 "${contribution.package}"，必须等于包名`);
						} else pass(`contribution.package = ${contribution.package}`);
						const descriptors = Array.isArray(contribution.descriptors) ? contribution.descriptors : [];
						const names = descriptors.map((d) => d?.method);
						if (names.join() !== hostMethods.join()) {
							fail(`descriptor 方法表与 host 的 markRemote 列表不一致：\n  mount  = [${names.join(", ")}]\n  host   = [${hostMethods.join(", ")}]`);
						} else {
							pass(`$mount 声明的 ${names.length} 个 method 与 lib/index.js 的 markRemote 列表逐字一致（含顺序）`);
						}
						const withCodec = descriptors.filter((d) => d !== null && typeof d === "object" && Object.keys(d).length > 1);
						if (withCodec.length > 0) info(`${withCodec.length} 个 descriptor 带了额外字段（预期只有 { method }）`);
					}

					/* 3.2 服务查询 */
					for (const needed of ["remote.desktopProject", "slots"]) {
						if (!record.gets.includes(needed)) fail(`apply 从未查询服务 "${needed}"`);
					}
					if (record.gets.includes("remote.desktopProject") && record.gets.includes("slots")) {
						pass(`apply 查询了 remote.desktopProject 与 slots（共 ${record.gets.length} 次 get）`);
					}

					/* 3.3 slot 注册 */
					const expectedSlots = ["settings.section", "sidebar.footer.action"];
					if (record.injects.join() !== expectedSlots.join()) {
						fail(`slots.inject 的 key 应为 [${expectedSlots.join(", ")}]，实际 [${record.injects.join(", ")}]`);
					} else pass(`slots.inject 命中 ${expectedSlots.join(" + ")}`);

					if (record.registers.length !== expectedSlots.length) {
						fail(`应注册 ${expectedSlots.length} 个 slot，实际 ${record.registers.length} 个`);
					} else {
						const byName = new Map(record.registers.map((r) => [r.contribution?.name, r]));
						let allOk = true;
						for (const name of expectedSlots) {
							const entry = byName.get(name);
							if (entry === undefined) {
								fail(`没有注册 name === "${name}" 的条目（注册姿势：必须把 key 同时写进 contribution.name）`);
								allOk = false;
								continue;
							}
							if (entry.contribution.id !== "magical-lowcode-project") {
								fail(`"${name}" 的 id 应为 magical-lowcode-project，实际 ${entry.contribution.id}`);
								allOk = false;
							}
							if (typeof entry.contribution.order !== "number") {
								fail(`"${name}" 缺少数字 order`);
								allOk = false;
							}
							if (typeof entry.component !== "function") {
								fail(`"${name}" 注册的组件不是函数`);
								allOk = false;
							}
							if (!record.injects.includes(name)) {
								fail(`"${name}" 被注册但从未 slots.inject —— disposer 不会落在本插件 fiber 上`);
								allOk = false;
							}
						}
						const section = byName.get("settings.section");
						if (section !== undefined && typeof section.contribution.label !== "string") {
							fail("settings.section 必须带 label（设置页的导航名）");
							allOk = false;
						}
						if (allOk) pass("两个 slot 的 contribution 字段齐全、组件可调用、且都经 slots.inject 包裹");
					}

					/* 3.4 effect 清理 */
					if (record.effects.length === 0) fail("apply 没有通过 ctx.effect 建立任何清理");
					else {
						const labelled = record.effects.filter((label) => typeof label === "string" && label.includes("dsh-magical-lowcode-project"));
						if (labelled.length !== record.effects.length) {
							info(`有 ${record.effects.length - labelled.length} 条 effect 的 label 没有带包名前缀：[${record.effects.join(" | ")}]`);
						} else pass(`${record.effects.length} 条 ctx.effect 都带了包名前缀的 label`);
					}
				}
			}
		}
	}
}

/* ------------------------------------------------------------ 4. 降级路径 */

async function degrade(label, options, expectMount) {
	if (registration?.factory === undefined) return;
	const exported = registration.factory(requireStub);
	const { ctx, record } = makeCtx(options);
	let thrown;
	try {
		await exported.apply(ctx);
	} catch (error) {
		thrown = error;
	}
	if (thrown !== undefined) {
		fail(`${label}：apply 应当优雅退出，却抛了 ${thrown?.message ?? thrown}`);
		return;
	}
	const mounted = record.mounts.length > 0;
	if (mounted !== expectMount) {
		fail(`${label}：预期 ${expectMount ? "发生" : "不发生"} $mount，实际 ${mounted ? "发生" : "未发生"}`);
		return;
	}
	pass(`${label}：优雅退出，未抛错（$mount ${mounted ? "发生" : "跳过"}）`);
}

await degrade("remote 服务缺失", { withoutRemote: true }, false);
await degrade("slots 服务缺失", { withoutSlots: true }, true);

/* ------------------------------------------------------------ 输出 */

const line = "-".repeat(72);
console.log(line);
console.log("dsh-magical-lowcode-project 客户端半边 · 逻辑层桩检");
console.log(line);
for (const item of passes) console.log(`  ok    ${item}`);
for (const item of infos) console.log(`  info  ${item}`);
for (const item of failures) console.log(`  FAIL  ${item}`);
console.log(line);
console.log(`通过 ${passes.length} · 失败 ${failures.length}`);
if (failures.length > 0) {
	console.log("\n桩检未通过。");
	process.exit(1);
}
console.log("\n桩检通过。");
