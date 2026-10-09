#!/usr/bin/env node
/**
 * dsh-magical-lowcode-project 0.2.0 预设端点自检。
 *
 * 检查 host 半边两条 fetch 端点在新 preset 模型下的行为：
 *   导出 = agentPresets.list() + readDocument() → .dshpreset（内含 preset/agent.cordis.yml）
 *   导入 = 先预览，再把 @deepseek-ai/dsh-agent-preset 声明 INSERT 进 profile 的 cordis.patch.yml
 *
 * 为什么要生成「探针模块」：lib/index.js 只导出 { apply, inject, name }，两个端点函数没有导出；
 * 而用假 ctx 调 apply() 会在 `new DesktopProjectService(ctx)` 处炸（cordis 的 Service 基类要真实 Context）。
 * 所以这里把源码原样复制到同目录的临时模块、末尾补一行 export 再 import 它 —— 依赖解析与真实插件完全一致。
 *
 * 用法：node test/preset-check.mjs
 * 可选：设置环境变量 DSH_APP_BOOT 指向宿主 @deepseek-ai/dsh-app-boot 的 lib/index.js，
 *       脚本会额外用真实的 evaluatePluginCompatibility() 复核 package.json 是否还有不兼容 peer。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { parseDocument } from "yaml";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const MIME = "application/vnd.dsh.preset+zip";
const probePath = join(root, "lib", ".preset-check-probe.mjs");

let failures = 0;
function check(ok, label, detail) {
	if (ok) console.log(`  ok   ${label}`);
	else {
		failures += 1;
		console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
	}
}

/* 真实 profile patch 的形态：注释 + flow 风格 insert + 一处 !!js 表达式。 */
const REAL_PATCH = `# a top-level YAML array of loader patch entries
- insert: [ {id: dsh-zh, name: 'deepseek-harness-zh-cn'}, {id: ui-settings-general, name: "@deepseek-ai/dsh-client-ui-settings-general", config: {welcomeNoticeVersion: 2026-09-28.1}} ]
- id: skills
  name: !!js process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')
`;

function pack(id, name, declaration) {
	return zipSync({
		"manifest.json": strToU8(JSON.stringify({ format: "dsh-preset", version: 1, id, name, sourceDshVersion: "0.2.0-rc.2" })),
		"preset/agent.cordis.yml": strToU8(declaration)
	}, { level: 6 });
}
const DECLARATION = "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n- id: plan-mode\n  name: '@deepseek-ai/dsh-plan-mode'\n";

const source = await readFile(join(root, "lib", "index.js"), "utf8");
await writeFile(probePath, `${source}\nexport { presetExportResponse, presetImportResponse };\n`, "utf8");

const dirs = [];
try {
	const plugin = await import(pathToFileURL(probePath).href);
	check(typeof plugin.presetExportResponse === "function" && typeof plugin.presetImportResponse === "function", "两个端点函数存在");

	const presets = {
		list: async () => [{ id: "demo", name: "演示预设", order: 4 }],
		readDocument: async (id) => ({ agentPreset: id, content: "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n" })
	};
	const makeCtx = async (patchText) => {
		const dir = await mkdtemp(join(tmpdir(), "dsh-preset-check-"));
		dirs.push(dir);
		const patchPath = join(dir, "cordis.patch.yml");
		await writeFile(patchPath, patchText, "utf8");
		return { ctx: { baseUrl: pathToFileURL(join(root, "lib", "index.js")).href, get: (s) => (s === "agentPresets" ? presets : s === "profileContext" ? { patchPath } : undefined) }, patchPath };
	};
	const post = (query, body) => new Request(`http://local/api/agent-preset.import${query}`, { method: "POST", headers: { "content-type": MIME }, body });

	console.log("\n[1] 导出：list() + readDocument() → .dshpreset");
	const { ctx } = await makeCtx("[]\n");
	const exported = await plugin.presetExportResponse(ctx, new Request("http://local/api/agent-preset.export?agentPreset=demo"));
	check(exported.status === 200, "GET 导出返回 200", `status=${exported.status}`);
	check(exported.headers.get("content-disposition") === 'attachment; filename="demo.dshpreset"', "下载名用预设 id", String(exported.headers.get("content-disposition")));
	const archive = unzipSync(new Uint8Array(await exported.arrayBuffer()));
	check(Object.keys(archive).join(",") === "manifest.json,preset/agent.cordis.yml", "包内只有 manifest.json 与 preset/agent.cordis.yml", Object.keys(archive).join(","));
	const manifest = JSON.parse(strFromU8(archive["manifest.json"]));
	check(manifest.format === "dsh-preset" && manifest.version === 1 && manifest.id === "demo" && manifest.name === "演示预设", "manifest 字段来自 readDocument 对应的预设行", JSON.stringify(manifest));
	check(strFromU8(archive["preset/agent.cordis.yml"]).includes("@deepseek-ai/dsh-persona"), "插件清单写进了 preset/agent.cordis.yml");
	const unknown = await plugin.presetExportResponse(ctx, new Request("http://local/api/agent-preset.export?agentPreset=nope"));
	check(unknown.status === 404, "未知预设 id 返回 404", `status=${unknown.status}`);

	console.log("\n[2] 导入：先预览");
	const { ctx: installCtx, patchPath } = await makeCtx("[]\n");
	const body = pack("imported-demo", "导入演示", DECLARATION);
	const preview = await plugin.presetImportResponse(installCtx, post("", body));
	const previewBody = await preview.json();
	check(preview.status === 200 && previewBody.installed === false && previewBody.conflict === false, "预览返回 200 / installed=false", JSON.stringify(previewBody));
	check(previewBody.pluginCount === 2 && previewBody.fileCount === 1, "预览报告 pluginCount 与 fileCount", `pluginCount=${previewBody.pluginCount} fileCount=${previewBody.fileCount}`);
	check(Array.isArray(previewBody.warnings) && previewBody.warnings.length === 0, "同版本来源无警告", JSON.stringify(previewBody.warnings));

	console.log("\n[3] 导入：install=1 写 profile patch");
	const installed = await plugin.presetImportResponse(installCtx, post("?install=1", body));
	const installedBody = await installed.json();
	check(installed.status === 200 && installedBody.installed === true, "安装返回 200 / installed=true", JSON.stringify(installedBody));
	const patchText = await readFile(patchPath, "utf8");
	const document = parseDocument(patchText);
	check(document.errors.length === 0, "写回后的 cordis.patch.yml 仍是合法 YAML", String(document.errors[0]?.message));
	const rows = document.toJS();
	const inserted = rows.flatMap((row) => (Array.isArray(row?.insert) ? row.insert : [])).find((row) => row.id === "preset-imported-demo");
	check(inserted?.name === "@deepseek-ai/dsh-agent-preset" && inserted?.config?.id === "imported-demo" && inserted?.config?.plugins?.length === 2, "追加了 @deepseek-ai/dsh-agent-preset 声明行", JSON.stringify(inserted));
	check(inserted?.config?.name === "导入演示", "声明的 name 来自包内 manifest", JSON.stringify(inserted?.config?.name));

	console.log("\n[4] 冲突与保真");
	const again = await plugin.presetImportResponse(installCtx, post("?install=1", body));
	check(again.status === 409, "同 id 重复安装返回 409", `status=${again.status}`);
	const { ctx: keepCtx, patchPath: keepPath } = await makeCtx(REAL_PATCH);
	const keep = await plugin.presetImportResponse(keepCtx, post("?install=1&agentPreset=kept-demo", body));
	check(keep.status === 200, "在含注释/flow/!!js 的真实 patch 上安装成功", `status=${keep.status}`);
	const kept = await readFile(keepPath, "utf8");
	check(kept.includes("!!js process.getBuiltinModule"), "!!js 表达式原样保留");
	check(kept.includes("# a top-level YAML array of loader patch entries"), "注释保留");
	const keptRows = parseDocument(kept).toJS();
	check(keptRows[0]?.insert?.[0]?.id === "dsh-zh" && keptRows[0]?.insert?.[1]?.id === "ui-settings-general" && keptRows[1]?.id === "skills", "原有条目与顺序保留", JSON.stringify(keptRows.slice(0, 2)));
	check(keptRows[2]?.insert?.[0]?.id === "preset-kept-demo", "新声明追加在末尾", JSON.stringify(keptRows[2]));

	console.log("\n[5] 宿主兼容性");
	if (process.env.DSH_APP_BOOT === undefined) {
		console.log("  skip 未设置 DSH_APP_BOOT，跳过 evaluatePluginCompatibility 复核");
	} else {
		const appBoot = await import(pathToFileURL(process.env.DSH_APP_BOOT).href);
		const issue = appBoot.evaluatePluginCompatibility(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
		check(issue === undefined, "package.json 没有不兼容的 @deepseek-ai/dsh* peer", JSON.stringify(issue));
	}
} finally {
	await rm(probePath, { force: true });
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\npreset 端点自检通过" : `\npreset 端点自检失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
