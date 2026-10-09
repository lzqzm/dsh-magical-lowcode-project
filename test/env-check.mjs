#!/usr/bin/env node
/**
 * dsh-magical-lowcode-project · 客户端 `.env` 编辑逻辑桩检。
 *
 * 为什么单独测：`EnvDialog` 保存时会把整个 `.env` 文本写回磁盘（`projectWriteFile`），
 * 写坏了就是用户本地文件损坏。`envValue` / `envUpsert` 是这条写回路径上仅有的纯函数，
 * 所以这里直接从 `lib/client.js` 的源码里把两个函数抠出来在 vm 里执行，覆盖：
 * 读键（export 前缀 / 引号 / 注释行不算键）、替换已有行、追加新键、保留注释与其它键、
 * 值含空白或 `#` 时加引号、CRLF 归一、尾部空行清理、重复写入幂等。
 *
 * 抠函数按「函数声明行的缩进 + 同名缩进的收尾大括号」切分，不做大括号配平 ——
 * 函数体里的正则字面量（例如 `replace(/"/g, ...)`）会让朴素的引号/花括号扫描器错乱。
 *
 * 用法：node test/env-check.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib/client.js"), "utf8");

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

const pieces = [
	extractFunction(source, "envValue"),
	extractFunction(source, "envUpsert"),
	extractFunction(source, "envValues"),
	extractFunction(source, "upsertEnvValues"),
];
if (pieces.some((piece) => piece === null)) {
	console.log("  FAIL  没能在 lib/client.js 里定位 envValue / envUpsert / envValues / upsertEnvValues（改名或删掉了？）");
	console.log("------------------------------------------------------------------------");
	console.log("通过 0 · 失败 1");
	process.exit(1);
}

const sandbox = {};
createContext(sandbox);
runInContext(
	pieces.join("\n\n") + "\nthis.envValue = envValue;\nthis.envUpsert = envUpsert;\nthis.envValues = envValues;\nthis.upsertEnvValues = upsertEnvValues;\n",
	sandbox,
);
const { envValue, envUpsert, envValues, upsertEnvValues } = sandbox;

console.log("--- envValue（读键）---");
check("裸键值", envValue("SERVER_URL=https://a.example.com\n", "SERVER_URL"), "https://a.example.com");
check("export 前缀 + 多余空格", envValue("export   SERVER_URL = https://b.example.com\n", "SERVER_URL"), "https://b.example.com");
check("双引号包裹剥掉引号", envValue('SERVER_URL="https://c.example.com/x y"\n', "SERVER_URL"), "https://c.example.com/x y");
check("单引号包裹剥掉引号", envValue("PROJECT_UUID='abc123'\n", "PROJECT_UUID"), "abc123");
check("键不存在返回空串", envValue("OTHER=1\n", "SERVER_URL"), "");
check("注释行不算键", envValue("# SERVER_URL=nope\n", "SERVER_URL"), "");
check("不命中前缀更长的键", envValue("SERVER_URL_OLD=x\n", "SERVER_URL"), "");

console.log("--- envUpsert（写回）---");
const base = "# 线上环境\nACCOUNT=admin\nSERVER_URL=https://old\nPASSWORD=pw#1\n";
check(
	"替换已有行、注释与其它键原样保留",
	envUpsert(base, "SERVER_URL", "https://new"),
	"# 线上环境\nACCOUNT=admin\nSERVER_URL=https://new\nPASSWORD=pw#1\n",
);
check("追加新键到末尾", envUpsert("ACCOUNT=admin\n", "PROJECT_UUID", "abc"), "ACCOUNT=admin\nPROJECT_UUID=abc\n");
check("空文本新建", envUpsert("", "SERVER_URL", "https://x"), "SERVER_URL=https://x\n");
check("值含空格加双引号", envUpsert("", "SERVER_URL", "a b"), 'SERVER_URL="a b"\n');
check("值含 # 加双引号", envUpsert("", "PASSWORD", "p#ss"), 'PASSWORD="p#ss"\n');
check("值内双引号被转义", envUpsert("", "K", 'a "b"'), 'K="a \\"b\\""\n');
check("值含制表符加双引号", envUpsert("", "K", "a\tb"), 'K="a\tb"\n');
check("尾部空行被清掉", envUpsert("A=1\n\n\n", "B", "2"), "A=1\nB=2\n");
check("CRLF 归一为 LF", envUpsert("A=1\r\n", "B", "2"), "A=1\nB=2\n");
check("保留 export 前缀", envUpsert("export SERVER_URL=https://old\nOTHER=1\n", "SERVER_URL", "https://new"), "export SERVER_URL=https://new\nOTHER=1\n");
check("注释行不被当成已有键", envUpsert("# PROJECT_UUID=old\n", "PROJECT_UUID", "new"), "# PROJECT_UUID=old\nPROJECT_UUID=new\n");

const twice = envUpsert(envUpsert("A=1\n", "SERVER_URL", "https://a b"), "SERVER_URL", "https://a b");
check("重复写入幂等", twice, 'A=1\nSERVER_URL="https://a b"\n');
check("同一键只留一处", twice.split("\n").filter((line) => line.startsWith("SERVER_URL=")).length, 1);
check("写回后可读回（引号往返）", envValue(envUpsert("", "SERVER_URL", "https://z/x y"), "SERVER_URL"), "https://z/x y");

console.log("--- envValues / upsertEnvValues（脚本目录四键）---");
check(
	"envValues 一次取多个键，缺失键给空串",
	JSON.stringify(envValues("SERVER_URL=https://a\nUSERNAME=admin\n", ["SERVER_URL", "USERNAME", "PASSWORD", "PROJECT_UUID"])),
	JSON.stringify({ SERVER_URL: "https://a", USERNAME: "admin", PASSWORD: "", PROJECT_UUID: "" }),
);
check(
	"upsertEnvValues 多键写回，注释与其它键原样保留",
	upsertEnvValues("# 注释\nACCOUNT=admin\nSERVER_URL=https://old\n", {
		SERVER_URL: "https://new",
		USERNAME: "root",
		PASSWORD: "p#1",
		PROJECT_UUID: "abc",
	}),
	'# 注释\nACCOUNT=admin\nSERVER_URL=https://new\nUSERNAME=root\nPASSWORD="p#1"\nPROJECT_UUID=abc\n',
);
check("upsertEnvValues 空值写成空键（不删行）", upsertEnvValues("A=1\n", { USERNAME: "" }), "A=1\nUSERNAME=\n");
check("upsertEnvValues 后可原样读回", envValue(upsertEnvValues("", { SERVER_URL: "https://x y" }), "SERVER_URL"), "https://x y");
check(
	"空文本 + 四个空值 = 四行空键（新建 .env 的形状）",
	upsertEnvValues("", { SERVER_URL: "", USERNAME: "", PASSWORD: "", PROJECT_UUID: "" }),
	"SERVER_URL=\nUSERNAME=\nPASSWORD=\nPROJECT_UUID=\n",
);

console.log("------------------------------------------------------------------------");
if (failures.length > 0) {
	console.log("通过 " + passed + " · 失败 " + failures.length);
	console.log("\n.env 编辑逻辑桩检未通过。");
	process.exit(1);
}
console.log("通过 " + passed + " · 失败 0");
console.log("\n.env 编辑逻辑桩检通过。");
