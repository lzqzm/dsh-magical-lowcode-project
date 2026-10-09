/**
 * 真实 cordis 进程内集成冒烟测试（无测试框架、无子进程、单进程 ESM）。
 *
 * 目的：证实 host 半边 `lib/index.js` 能在真实 cordis 应用里被 plugin() 挂载，
 * 并且 `markRemote()` 那套「伪造装饰器上下文」确实把 12 个 Remote marker
 * 真实写到了 DesktopProjectService.prototype 上。
 *
 * 运行：node test/smoke.mjs
 * 依赖解析：包内 node_modules/@deepseek-ai -> 宿主 DSH 安装里的同名目录（junction），
 *          包内 node_modules/fflate        -> 宿主 DSH 安装里的 fflate（junction）。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* 上游 marker 描述符写在原型上的**字符串** key（不是 Symbol），
 * 见 @deepseek-ai/dsh-typert-protocol lib/index.js 的 REMOTE_METHOD_DESCRIPTOR。 */
const DESCRIPTOR_KEY = "@deepseek-ai/dsh-typert-protocol/remote-methods";

const EXPECTED_INJECT = ["workspaceRegistry", "connection"];
const EXPECTED_METHODS = [
	"listProjectEntries",
	"projectPushStatus",
	"projectRunScript",
	"projectResolveScript",
	"projectMarkPushed",
	"projectResetPushState",
	"projectRenameEntry",
	"projectSetProjectName",
	"projectDeleteEntry",
	"projectReadFile",
	"projectWriteFile",
	"projectAssemblePreview",
	"projectLint"
];

let failed = 0;
function check(label, condition, detail) {
	const ok = Boolean(condition);
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : `  :: ${detail}`}`);
	return ok;
}
function info(label, detail) {
	console.log(`info  ${label}${detail === undefined ? "" : `  :: ${detail}`}`);
}
function json(value) {
	try {
		return JSON.stringify(value);
	} catch (error) {
		return `<unserializable: ${error.message}>`;
	}
}

console.log(`# dsh-magical-lowcode-project smoke test`);
console.log(`# root = ${ROOT}`);
console.log(`# node = ${process.version} (${process.platform})`);
console.log("");

/* ---------------------------------------------------------------- 1. 导入 host 半边 */
let host;
try {
	host = await import(pathToFileURL(join(ROOT, "lib", "index.js")).href);
	check("import lib/index.js evaluates", true);
} catch (error) {
	check("import lib/index.js evaluates", false, error?.stack ?? String(error));
	console.log(`\nRESULT: FAIL (host module did not evaluate)`);
	process.exit(1);
}

check("typeof host.name === 'string'", typeof host.name === "string", `name=${json(host.name)}`);
check("host.name === 'dsh-magical-lowcode-project'", host.name === "dsh-magical-lowcode-project", `got ${json(host.name)}`);
check("host.inject deep-equals ['workspaceRegistry','connection']", json(host.inject) === json(EXPECTED_INJECT), `got ${json(host.inject)}`);
check("typeof host.apply === 'function'", typeof host.apply === "function", `got typeof ${typeof host.apply}`);
check("host default export absent (named exports only)", host.default === undefined, `got ${json(host.default)}`);

/* ---------------------------------------------------------------- 2. 真实 cordis 应用 */
const { Context } = await import("@deepseek-ai/cordis");
check("import @deepseek-ai/cordis provides Context", typeof Context === "function");

const { remoteMethods } = await import("@deepseek-ai/dsh-typert-protocol");
check("import @deepseek-ai/dsh-typert-protocol provides remoteMethods", typeof remoteMethods === "function");

/* 最小假服务：workspaceRegistry.list() 是 ownerOf()/项目根枚举的唯一入口；
 * connection.fetch.register() 只需要存在；agentPresets 提供 list()/readDocument() 两个
 * 0.2.0 端点用得到的方法 —— 它一到场，apply 里 ctx.inject(["agentPresets"]) 的回调就会跑，
 * 于是两条 preset fetch 路由被注册（0.2.0 起插件不再 import 旧的 dsh-agent-presets 包）。 */
const workspaceRegistryStub = {
	list() {
		return [];
	}
};
const agentPresetsStub = {
	async list() {
		return [];
	},
	async readDocument(id) {
		return { agentPreset: id, content: "[]\n" };
	}
};
const registeredFetchRoutes = [];
const connectionStub = {
	fetch: {
		register(route) {
			registeredFetchRoutes.push(route?.path);
			return () => {};
		}
	}
};

const app = new Context();

/* 先挂一个 stub 插件提供三个必需服务，避免 host 插件停在 PENDING。 */
const stubFiber = await app.plugin({
	name: "smoke/stubs",
	apply(ctx) {
		ctx.provide("workspaceRegistry", workspaceRegistryStub);
		ctx.provide("connection", connectionStub);
		ctx.provide("agentPresets", agentPresetsStub);
	}
});
check("stub services registered (workspaceRegistry)", app.get("workspaceRegistry") === workspaceRegistryStub);
check("stub services registered (connection)", app.get("connection") === connectionStub);
check("stub services registered (agentPresets)", app.get("agentPresets") === agentPresetsStub);

let hostFiber;
try {
	hostFiber = app.plugin(host);
	await hostFiber.await();
	check("app.plugin(host) settles without throwing", true);
} catch (error) {
	check("app.plugin(host) settles without throwing", false, error?.stack ?? String(error));
	console.log(`\nRESULT: FAIL (plugin load threw)`);
	process.exit(1);
}

/* FiberState: PENDING=0 LOADING=1 ACTIVE=2 FAILED=3 */
check("host fiber state === ACTIVE (2)", hostFiber.state === 2, `got state=${hostFiber.state}`);

/* ---------------------------------------------------------------- 3. 服务实例 */
const service = app.get("desktopProjectController");
check("app.get('desktopProjectController') returns a service instance", service !== undefined && service !== null, `got ${inspect(service, { depth: 0 })}`);

if (service === undefined || service === null) {
	console.log(`\nRESULT: FAIL (DesktopProjectService was not registered as a cordis service)`);
	process.exit(1);
}

check("service.name === 'desktopProjectController'", service.name === "desktopProjectController", `got ${json(service.name)}`);
/* inject 回调由 cordis 异步触发：等到两条 preset 路由就位再断言。 */
await new Promise((resolve) => setTimeout(resolve, 50));
info("routes registered during apply", `${registeredFetchRoutes.length} (${json(registeredFetchRoutes)})`);
check(
	"both preset fetch routes registered once agentPresets exists",
	registeredFetchRoutes.length === 2 && registeredFetchRoutes.includes("/api/agent-preset.export") && registeredFetchRoutes.includes("/api/agent-preset.import"),
	json(registeredFetchRoutes)
);

/* ---------------------------------------------------------------- 4. Remote markers */
const markers = remoteMethods(service);
check("remoteMethods(service) returns an array", Array.isArray(markers), `got ${inspect(markers, { depth: 2 })}`);

const actualMethods = markers.map((marker) => marker.method);
check(
	`marker count === ${EXPECTED_METHODS.length}`,
	markers.length === EXPECTED_METHODS.length,
	`got ${markers.length}: ${json(actualMethods)}`
);
check(
	"marker method names match declaration order exactly (no missing, no extra)",
	json(actualMethods) === json(EXPECTED_METHODS),
	`got ${json(actualMethods)}`
);
for (const expected of EXPECTED_METHODS) {
	check(`marker present: ${expected}`, actualMethods.includes(expected));
}
const unexpected = actualMethods.filter((method) => !EXPECTED_METHODS.includes(method));
check("no unexpected markers", unexpected.length === 0, `unexpected ${json(unexpected)}`);

check(
	"every marker invocation.kind === 'direct'",
	markers.every((marker) => marker.invocation?.kind === "direct"),
	json(markers.map((marker) => marker.invocation))
);

/* remoteMethods() 返回的是 marker 的浅拷贝：字段只有 method / invocation，
 * version 与 namespace **不在** marker 上，必须从原型描述符与 typertRemote 读。 */
console.log("");
console.log("--- remoteMethods(service)[0] (util.inspect) ---");
console.log(inspect(markers[0], { depth: 6, breakLength: 120 }));
console.log("--- remoteMethods(service)[0] (JSON.stringify) ---");
console.log(json(markers[0]));
console.log("--- remoteMethods(service) full JSON ---");
console.log(json(markers));

const prototype = Object.getPrototypeOf(service);
const descriptor = Object.getOwnPropertyDescriptor(prototype, DESCRIPTOR_KEY)?.value;
console.log("--- prototype descriptor ---");
console.log(inspect(descriptor, { depth: 4, breakLength: 120 }));
check(`prototype['${DESCRIPTOR_KEY}'] exists with version === 1`, descriptor?.version === 1, `got version=${json(descriptor?.version)}`);
check(`descriptor.methods is a frozen array of ${EXPECTED_METHODS.length}`, Array.isArray(descriptor?.methods) && descriptor.methods.length === EXPECTED_METHODS.length, `got length=${descriptor?.methods?.length}`);
check("descriptor is frozen", Object.isFrozen(descriptor) && Object.isFrozen(descriptor?.methods));

/* ---------------------------------------------------------------- 5. typertRemote 绑定（namespace 来源） */
const binding = service.typertRemote;
console.log("--- service.typertRemote (util.inspect) ---");
console.log(inspect(binding, { depth: 3, breakLength: 120 }));
check("service.typertRemote exists", binding !== undefined && binding !== null, inspect(binding, { depth: 1 }));
check("typertRemote.serviceKey === 'desktopProjectController'", binding?.serviceKey === "desktopProjectController", `got ${json(binding?.serviceKey)}`);
check("typertRemote.namespace === 'desktopProject'", binding?.namespace === "desktopProject", `got ${json(binding?.namespace)}`);
/* cordis 的 ctx.get()/app.get() 返回的是 traceable service proxy，不是裸实例，
 * 所以能和 binding.service 比的是「自引用关系」而不是对象身份。 */
info("binding.service identity vs app.get() value", `same object? ${binding?.service === service}`);
check(
	"typertRemote.service is the service instance (name matches, self-referential binding)",
	binding?.service?.name === "desktopProjectController" && binding?.service?.typertRemote === binding,
	`name=${json(binding?.service?.name)} selfRef=${binding?.service?.typertRemote === binding}`
);
info("client must resolve via ctx.get('remote.desktopProject')", `namespace=${json(binding?.namespace)}`);

/* ---------------------------------------------------------------- 6. 反向对照：缺 connection 时插件不激活 */
const appWithoutConnection = new Context();
await appWithoutConnection.plugin({
	name: "smoke/stubs-workspace-only",
	apply(ctx) {
		ctx.provide("workspaceRegistry", workspaceRegistryStub);
	}
});
appWithoutConnection.plugin(host);
await new Promise((resolve) => setTimeout(resolve, 50));
const leaked = appWithoutConnection.get("desktopProjectController");
info(
	"without 'connection': desktopProjectController visible?",
	`${leaked === undefined ? "no (plugin stays PENDING — connection 是必需注入)" : "yes (unexpected: inject 未阻塞加载)"}`
);
check("without 'connection', service is NOT registered (proves connection stub was required)", leaked === undefined, `got ${inspect(leaked, { depth: 0 })}`);
await appWithoutConnection.fiber.dispose();

/* ---------------------------------------------------------------- 7. 幂等 / 清理 */
const markersAgain = remoteMethods(app.get("desktopProjectController"));
check("second remoteMethods() call is stable (idempotent)", json(markersAgain) === json(markers));
await hostFiber.dispose();
await stubFiber.dispose();
await app.fiber.dispose();
check("host fiber state after dispose === DISPOSED (4) or UNLOADING (5)", hostFiber.state === 4 || hostFiber.state === 5, `got state=${hostFiber.state}`);

console.log("");
if (failed === 0) {
	console.log(`RESULT: PASS (${EXPECTED_METHODS.length}/${EXPECTED_METHODS.length} Remote markers bound, namespace=desktopProject)`);
	process.exit(0);
}
console.log(`RESULT: FAIL (${failed} failing check(s))`);
process.exit(1);
