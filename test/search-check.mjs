#!/usr/bin/env node
/**
 * dsh-magical-lowcode-project · 工程目录模糊搜索打分桩检。
 *
 * 为什么单独测：「像不像」完全由 `lib/index.js` 里的 `normalizeForSearch` / `fuzzyScore` /
 * `scoreEntry` 三个纯函数决定 —— 它们同时决定**是否命中**与**排序**。改权重、改归一化规则会让
 * 「备管」再也搜不到「备件管理」，而 `scoreEntry` 写错更糟：0.2.15 就把名字那一路的 +20 分
 * 加在了未命中（-1）上，导致搜索等于没过滤。这类退化在页面上只表现为「结果怪怪的」，
 * 所以直接从 host 源码里把三个函数抠出来在 vm 里跑。
 *
 * 抠函数按「函数声明行的缩进 + 同名缩进的收尾大括号」切分，不做大括号配平 ——
 * 函数体里的正则字面量会让朴素的引号/花括号扫描器错乱（与 test/env-check.mjs 同一套做法）。
 *
 * 用法：node test/search-check.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "index.js"), "utf8");

/**
 * 从源码里抠出具名函数声明的完整文本（含收尾大括号）；找不到返回 null。
 *
 * 只认「独占一行、行首缩进里没有其它字符」的 `function <name>(` 声明，
 * 于是注释里提到的同名函数不会被当成真身；收尾取与声明同缩进的那一行 `}`。
 */
function extractFunction(text, name) {
	const marker = "function " + name + "(";
	let from = 0;
	for (;;) {
		const start = text.indexOf(marker, from);
		if (start < 0) return null;
		from = start + marker.length;
		const lineStart = text.lastIndexOf("\n", start) + 1;
		const indent = text.slice(lineStart, start);
		if (indent.trim() !== "") continue;
		const lines = text.slice(start).split(/\r?\n/);
		const endMark = indent + "}";
		for (let index = 1; index < lines.length; index += 1) {
			if (lines[index] === endMark) return lines.slice(0, index + 1).join("\n");
		}
		return null;
	}
}

let passed = 0;
const failures = [];

function check(label, actual, expected) {
	if (actual === expected) {
		passed += 1;
		console.log("  ok    " + label);
		return;
	}
	failures.push(label);
	console.log("  FAIL  " + label + "\n        期望 " + JSON.stringify(expected) + "\n        实际 " + JSON.stringify(actual));
}

const pieces = [extractFunction(source, "normalizeForSearch"), extractFunction(source, "fuzzyScore"), extractFunction(source, "scoreEntry")];
if (pieces.some((piece) => piece === null)) {
	console.log("  FAIL  没能在 lib/index.js 里定位 normalizeForSearch / fuzzyScore / scoreEntry（改名或删掉了？）");
	console.log("------------------------------------------------------------------------");
	console.log("通过 0 · 失败 1");
	process.exit(1);
}

const sandbox = {};
createContext(sandbox);
runInContext(
	pieces.join("\n\n") +
		"\nthis.normalizeForSearch = normalizeForSearch;\nthis.fuzzyScore = fuzzyScore;\nthis.scoreEntry = scoreEntry;\n",
	sandbox,
);
const { normalizeForSearch, fuzzyScore, scoreEntry } = sandbox;

console.log("dsh-magical-lowcode-project · 模糊搜索打分桩检");
console.log("------------------------------------------------------------------------");

/* 归一化：大小写与所有分隔符都不参与匹配，简写才能跨分隔符命中。 */
check("归一化抹掉大小写", normalizeForSearch("AbC"), "abc");
check(
	"归一化抹掉空格、下划线、连字符、点、两种斜杠",
	normalizeForSearch("source page_push\\x.y/z"),
	"sourcepagepushxyz",
);
check("归一化吃 null / undefined", normalizeForSearch(null) + "|" + normalizeForSearch(undefined), "|");

/* 不命中的边界：空查询、空文本、顺序对不上。 */
check("空查询不命中", fuzzyScore("", "备件管理"), -1);
check("空文本不命中", fuzzyScore("备件", ""), -1);
check("完全不沾边不命中", fuzzyScore("zzz", "备件管理"), -1);
check("子序列顺序颠倒不命中（管备 不命中 备件管理）", fuzzyScore("管备", "备件管理"), -1);

/* 命中：中文简写、英文简写、大小写与分隔符无关。 */
check("中文简写「备管」命中「备件管理」", fuzzyScore("备管", "备件管理") > 0, true);
check("全称命中自身", fuzzyScore("备件管理", "备件管理") > 0, true);
check("大小写与分隔符无关：SOURCE_PAGE 命中 source-page-push.js", fuzzyScore("SOURCE_PAGE", "source-page-push.js") > 0, true);
check("英文简写 spp 命中 source-page-push.js", fuzzyScore("spp", "source-page-push.js") > 0, true);

/* 打分：连续命中 > 分散命中；前缀命中 > 靠后命中；名字越短越靠前。 */
check("相邻命中比分散命中分高", fuzzyScore("abc", "abc") > fuzzyScore("abc", "axbxc"), true);
check("前缀命中比靠后命中分高", fuzzyScore("page", "pagepush") > fuzzyScore("page", "xpagepush"), true);
check("短名字比长名字分高（备件 > 备件管理 > 备件管理移动端）",
	fuzzyScore("备件", "备件管理") > fuzzyScore("备件", "备件管理移动端"),
	true,
);

/*
 * 条目得分（0.2.16 修的过滤 bug）：名字那一路的 +20 分只能加在**已命中**的名字上。
 * 写成 `fuzzyScore(name) + 20` 时，不命中（-1）也变成 19 分，于是 `score >= 0` 全通过，
 * 输入 `index.html` 会把同目录的 `page.js` / `page.css` / `page.json` 一起列出来。
 */
check("名字与路径都不命中就不列出（index.html 不带出同目录的 page.js）", scoreEntry("index.html", "page.js", "pages/home/page.js"), -1);
check("名字命中：index.html 命中自己", scoreEntry("index.html", "index.html", "pages/home/index.html") > 0, true);
check("只在路径里命中也算命中（备管 命中 pages/备件管理 下的 page.js）", scoreEntry("备管", "page.js", "pages/备件管理/page.js") > 0, true);
check("名字命中比只在路径里命中分高", scoreEntry("index", "index.html", "pages/index.html") > scoreEntry("index", "page.js", "pages/index/index.html"), true);
check("完全不沾边仍然不命中", scoreEntry("zzz", "page.js", "pages/home/page.js"), -1);
check("空查询不列出任何条目", scoreEntry("", "index.html", "pages/home/index.html"), -1);

console.log("------------------------------------------------------------------------");
if (failures.length > 0) {
	console.log("通过 " + passed + " · 失败 " + failures.length);
	console.log("\n模糊搜索打分桩检未通过。");
	process.exit(1);
}
console.log("通过 " + passed + " · 失败 0");
console.log("\n模糊搜索打分桩检通过。");
