#!/usr/bin/env node
/**
 * dsh-magical-lowcode-project · 「用编辑器打开」挑程序桩检（0.2.22）。
 *
 * 为什么单独测：`resolveExternalEditor` 决定一个纯行为 —— 点「用编辑器打开」时到底谁来开这个文件。
 * 挑错了不会报错，只会静默没反应（比如把 `%LOCALAPPDATA%` 写成 `%APPDATA%`，或者在
 * `PROGRAMFILES(x86)` 这种大小写敏感的键上取空字符串），而用户在页面上只会看到「点了没动静」。
 * 所以这里把 host 源码里的纯函数抠出来，用桩 `env` / `exists` / `platform` 把每条分支跑一遍：
 *
 *   1. DSHML_EDITOR（用户显式指定，且文件真的存在）
 *   2. VS Code 四处置（LOCALAPPDATA 稳定版 → LOCALAPPDATA Insiders → ProgramFiles → ProgramFiles(x86)）
 *   3. %SystemRoot%\System32\notepad.exe
 *   4. 兜底 %SystemRoot%\explorer.exe + `/select,`（只选中，不开文件）
 *   5. macOS 用 `open`、其他非 Windows 用 `xdg-open`
 *
 * 抠函数按「函数声明行的缩进 + 同名缩进的收尾大括号」切分，不做大括号配平
 * （与 test/search-check.mjs / test/env-check.mjs 同一套做法）。
 *
 * 用法：node test/open-check.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "index.js"), "utf8");

/** 从源码里抠出具名函数声明的完整文本（含收尾大括号）；找不到返回 null。 */
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
	/* 抠出来的函数在 vm 里跑，返回值是那个 realm 的对象 —— 只能按内容比，不能按引用比。 */
	const same = actual !== null && typeof actual === "object" && expected !== null && typeof expected === "object" ? JSON.stringify(actual) === JSON.stringify(expected) : actual === expected;
	if (same) {
		passed += 1;
		console.log("  ok    " + label);
		return;
	}
	failures.push(label);
	console.log("  FAIL  " + label + "\n        期望 " + JSON.stringify(expected) + "\n        实际 " + JSON.stringify(actual));
}

console.log("dsh-magical-lowcode-project · 「用编辑器打开」挑程序桩检");
console.log("------------------------------------------------------------------------");

/* 先锁住源码里的接口形状：抠不到函数、或换了环境变量名，这里就该拦住。 */
if (!source.includes('const EXTERNAL_EDITOR_ENV = "DSHML_EDITOR"')) {
	console.log("  FAIL  lib/index.js 里没有 const EXTERNAL_EDITOR_ENV = \"DSHML_EDITOR\"");
	process.exit(1);
}
if (!source.includes("function openFileExternally(") || !source.includes("detached: true") || !source.includes('stdio: "ignore"')) {
	console.log("  FAIL  lib/index.js 缺少 openFileExternally 的 detached/stdio:ignore spawn 形态");
	process.exit(1);
}
passed += 2;
console.log("  ok    host 源码里有 EXTERNAL_EDITOR_ENV 与 detached spawn 的 openFileExternally");

const pieces = [extractFunction(source, "resolveExternalEditor")];
if (pieces.some((piece) => piece === null)) {
	console.log("  FAIL  没能在 lib/index.js 里定位 resolveExternalEditor（改名或删掉了？）");
	console.log("------------------------------------------------------------------------");
	console.log("通过 0 · 失败 1");
	process.exit(1);
}

/*
 * 注入一个确定性的 join（Windows 反斜杠），而不用宿主 node:path 的那个：
 * 否则同一条断言在 ubuntu runner 上会因为我们拼的是 `C:\a/b` 这种混合分隔符而对不上，
 * 于是「CI 红了但本地全绿」。这里要测的是**挑哪个候选**，不是路径拼接本身。
 */
const winJoin = (...parts) => parts.filter((part) => part !== "" && part !== undefined).join("\\");

const sandbox = { join: winJoin, existsSync: () => false, process: { platform: "win32", env: {} } };
createContext(sandbox);
runInContext(
	'const EXTERNAL_EDITOR_ENV = "DSHML_EDITOR";\n' + pieces.join("\n\n") + "\nthis.resolveExternalEditor = resolveExternalEditor;\n",
	sandbox,
);
const { resolveExternalEditor } = sandbox;

const winEnv = (extra = {}) =>
	Object.assign(
		{
			LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
			ProgramFiles: "C:\\Program Files",
			"ProgramFiles(x86)": "C:\\Program Files (x86)",
			SystemRoot: "C:\\Windows",
		},
		extra,
	);

/** 只有列出来的路径算存在。 */
const existsOnly = (paths) => (candidate) => paths.includes(candidate);

const VSCODE = winJoin("C:\\Users\\me\\AppData\\Local", "Programs", "Microsoft VS Code", "Code.exe");
const VSCODE_INSIDERS = winJoin("C:\\Users\\me\\AppData\\Local", "Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe");
const VSCODE_PF = winJoin("C:\\Program Files", "Microsoft VS Code", "Code.exe");
const VSCODE_PF86 = winJoin("C:\\Program Files (x86)", "Microsoft VS Code", "Code.exe");
const NOTEPAD = winJoin("C:\\Windows", "System32", "notepad.exe");
const EXPLORER = winJoin("C:\\Windows", "explorer.exe");

/* 1. DSHML_EDITOR：用户说了算，只要那个文件真的存在。 */
check(
	"DSHML_EDITOR 存在时优先用它",
	resolveExternalEditor({ platform: "win32", env: winEnv({ DSHML_EDITOR: "D:\\tools\\zed.exe" }), exists: existsOnly(["D:\\tools\\zed.exe", VSCODE]) }),
	{ command: "D:\\tools\\zed.exe", args: [], label: "自定义编辑器（DSHML_EDITOR）" },
);
check(
	"DSHML_EDITOR 指向不存在的文件时被忽略，继续往下挑",
	resolveExternalEditor({ platform: "win32", env: winEnv({ DSHML_EDITOR: "D:\\nope\\zed.exe" }), exists: existsOnly([VSCODE]) }).command,
	VSCODE,
);

/* 2. VS Code 四处置，按稳定版 → Insiders → ProgramFiles → ProgramFiles(x86) 的顺序。 */
check(
	"LOCALAPPDATA 的 VS Code 稳定版命中",
	resolveExternalEditor({ platform: "win32", env: winEnv(), exists: existsOnly([VSCODE]) }),
	{ command: VSCODE, args: [], label: "VS Code" },
);
check(
	"稳定版没装就试 Insiders",
	resolveExternalEditor({ platform: "win32", env: winEnv(), exists: existsOnly([VSCODE_INSIDERS]) }).command,
	VSCODE_INSIDERS,
);
check(
	"LOCALAPPDATA 都没有就试 Program Files",
	resolveExternalEditor({ platform: "win32", env: winEnv(), exists: existsOnly([VSCODE_PF]) }).command,
	VSCODE_PF,
);
check(
	"Program Files 也没有就试 Program Files (x86)",
	resolveExternalEditor({
		platform: "win32",
		env: winEnv({ "ProgramFiles(x86)": "C:\\Program Files (x86)" }),
		exists: existsOnly([VSCODE_PF86]),
	}).command,
	VSCODE_PF86,
);
check(
	"环境变量缺失时不崩，直接跳过该候选（LOCALAPPDATA 为空）",
	resolveExternalEditor({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, exists: existsOnly([NOTEPAD]) }).command,
	NOTEPAD,
);

/* 3. 记事本兜底。 */
check(
	"没有 VS Code 就用系统记事本",
	resolveExternalEditor({ platform: "win32", env: winEnv(), exists: existsOnly([NOTEPAD]) }),
	{ command: NOTEPAD, args: [], label: "记事本" },
);

/* 4. 什么都没有：用文件管理器只选中该文件（selectOnly，参数是「/select, + 路径」单串）。 */
check(
	"连记事本都没有就退文件管理器，并且只选中不开文件",
	resolveExternalEditor({ platform: "win32", env: winEnv(), exists: existsOnly([EXPLORER]) }),
	{ command: EXPLORER, args: ["/select,"], label: "文件管理器", selectOnly: true },
);

/* 5. 跨平台：macOS 用 open、其他类 Unix 用 xdg-open，且不再走 Windows 候选。 */
check(
	"macOS 用 open（不看 Windows 那些路径）",
	resolveExternalEditor({ platform: "darwin", env: winEnv(), exists: () => true }),
	{ command: "open", args: [], label: "访达" },
);
check(
	"非 win32/darwin 用 xdg-open",
	resolveExternalEditor({ platform: "linux", env: winEnv(), exists: () => true }),
	{ command: "xdg-open", args: [], label: "默认程序" },
);
check(
	"macOS / Linux 也认 DSHML_EDITOR",
	resolveExternalEditor({ platform: "linux", env: { DSHML_EDITOR: "/usr/bin/vim" }, exists: existsOnly(["/usr/bin/vim"]) }).command,
	"/usr/bin/vim",
);

/* 6. 默认参数：什么都不传也不能抛错（真实运行时走 process.env / existsSync）。 */
check(
	"不传任何参数也能给出结果",
	typeof resolveExternalEditor().command,
	"string",
);

console.log("------------------------------------------------------------------------");
if (failures.length > 0) {
	console.log("通过 " + passed + " · 失败 " + failures.length);
	console.log("\n「用编辑器打开」挑程序桩检未通过。");
	process.exit(1);
}
console.log("通过 " + passed + " · 失败 0");
console.log("\n「用编辑器打开」挑程序桩检通过。");
