# dsh-magical-lowcode-project

> DeepSeek Harness 插件：**低代码工程模式** —— 在工作区里直接管理一个 MagicalCoder 风格的低代码工程。

把「低代码工程目录」搬进 DSH 会话侧边栏：看文件树、看推送状态、跑工程脚本、装配页面预览、推送前跑静态校验，并且能导入导出 Agent 预设包（`.dshpreset`）。

这是一个 **host + client 双半边** 插件：host 半边提供 12 个 RPC 与 2 条 HTTP 端点，client 半边在 DSH Web 界面里自带面板，**不修改任何 `@deepseek-ai/*` 核心包**。

---

## 它解决什么问题

MagicalCoder 风格的低代码工程是一套约定目录：页面用 `page.json` + `index.html` + `page.js` 三件套，接口用 `meta.json`，工程脚本叫 `source-*.js`，页面里必须有 `magicalDragScene` 容器，调平台接口要走 `/magical_lowcode/openapi/` 前缀……

这些约定在普通编辑器/Agent 会话里全靠记忆和手工检查。这个插件把它们变成：

- 一个**看得见的工程树**（一层目录 + 文件，可就地读写、改名、删除）
- 一个**推送状态账本**（哪些页面/接口已经同步到平台、哪些改过没同步）
- 一组**可执行的检查**（推送前静态校验，把踩过的坑变成 V1.01~V1.06 规则）
- 一个**能直接看的预览**（不用推送到平台就能在沙箱里装配页面）
- 一个**脚本入口**（跑工作区根目录下的 `source-*.js`，就是工程里那套推送/拉取脚本）

## 功能

### 工程模式 RPC（host 半边，`desktopProject/*`）

| RPC | 作用 |
| --- | --- |
| `listProjectEntries` | 工程文件树：列一层目录与文件，限已注册工作区内 |
| `projectPushStatus` | 扫描推送状态（`page.json` 的 uuid / `meta.json` 的 id，走 mtime 快照比对） |
| `projectRunScript` | 运行工程脚本（白名单 `source-*.js`，用 `process.execPath` 起子进程） |
| `projectMarkPushed` | 手工标记「已推送」（含祖先/子孙快照递归更新） |
| `projectResetPushState` | 重置全部推送状态 |
| `projectRenameEntry` | 重命名（Windows EPERM/EBUSY 退避重试，同步改写 `page.json` / `meta.json`） |
| `projectSetProjectName` | 设虚拟项目名（存在 `.dsh-project-names.json`，只影响显示） |
| `projectDeleteEntry` | 删除条目（禁止删除工作区根） |
| `projectReadFile` | 读文件（UTF-8，单文件限 2MB） |
| `projectWriteFile` | 写文件（UTF-8） |
| `projectAssemblePreview` | 装配页面预览沙箱（三件套内联 + 平台 runtime） |
| `projectLint` | 推送前静态校验（V1.01~V1.06 踩坑规则） |

所有带路径参数的 RPC 都会被校验：路径必须落在**已注册的工作区**之内，否则抛 `path-outside-workspace`。

### Agent 预设包端点（host 半边，带连接认证的 Fetch 路由）

| 端点 | 作用 |
| --- | --- |
| `GET /api/agent-preset.export?agentPreset=<id>` | 导出 `.dshpreset` 包（ZIP，内含 `manifest.json` + `preset/`） |
| `POST /api/agent-preset.import` | 导入**预览**：校验包并回一份 dry-run 报告 |
| `POST /api/agent-preset.import?agentPreset=<id>&install=1` | 校验通过后**原子安装**（同名冲突返回 409，绝不覆盖） |

包格式上限：压缩 ≤16MB、解压 ≤32MB、单文件 ≤12MB、≤512 个文件。拒绝绝对路径、父目录穿越、反斜杠路径与符号链接。只有 `trust === "user"` 的自定义预设可导出。

### Web 面板（client 半边）

在 DSH Web 界面里自带一个面板，五个页签：

- **项目树** —— 浏览工程目录、重命名/删除条目、读写文件（可就地编辑并保存）
- **推送状态** —— 一眼看出哪些改了没推；可标记已推送、重置记录、设虚拟项目名
- **预览与体检** —— 装配预览（在新标签打开沙箱页）、跑静态校验并列出问题
- **工程脚本** —— 跑工作区根目录下的 `source-*.js`，带参数，回显 exit code、命令与输出
- **预设包** —— 导出/导入 `.dshpreset`

外加一个侧边栏快捷入口（同一面板的浮层副本）。

## 安装

在 DSH 的 **设置 → 插件市场** 里搜索 `dsh-magical-lowcode-project` 一键安装；或手工：

```bash
dsh plugin --profile web add dsh-magical-lowcode-project
```

## 兼容性

- 宿主：`engines.dsh = ">=0.1.0-rc.5 <0.2.0-0"`（对照 `@deepseek-ai/dsh-*` `0.1.5-rc.2` 开发，已在 `0.1.5-rc.1` 宿主上实测）
- Node.js：`^22.19.0 || >=24.0.0`
- 平台：Windows / macOS / Linux

上界 `<0.2.0-0` 是有意的：0.2.x 尚未验证。插件市场安装前会读 `engines.dsh` 做兼容性判定，落在范围外会被拒绝安装（而不是装上一个坏插件）。

核心包（`@deepseek-ai/dsh-agent-presets`、`@deepseek-ai/dsh-typert-protocol`）声明为 `peerDependencies`，**复用宿主自带那一份**，不会装出第二份实例。

## 权限与安全边界

- 文件访问**只限已注册的工作区**，路径先规范化再与工作区前缀比对，越界直接拒绝
- 脚本执行有白名单：只允许工作区根目录下的 `source-*.js`，用宿主自带的 node 执行（`shell: false`），stdout 超 400000 字符会被中止，输出截断到 20000 字符
- 推送状态文件写在 `$DSH_HOME/project-push-state.json`（读取时兼容从旧路径一次性迁移）
- **host 半边自身不发起任何对外网络请求**，两条 HTTP 端点走 DSH 自己的 connection 认证通道
- ⚠️ **预览页会外联**：`projectAssemblePreview` 装配出的 HTML 里含
  `<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>`，
  在浏览器里打开该预览就会请求 jsdelivr。这是从上游 DSH Desktop 原样继承的行为，此处如实披露。

## 开发

没有构建步骤：host 半边与 client 半边都是手写产物，直接改 `lib/index.js` / `lib/client.js` 即可。

```bash
# npm test 串两个检查（零依赖，CI 与 prepublishOnly 跑的是同一条命令）
npm test
#  1) test/verify.mjs           静态自检：manifest / 兼容性字面量 / 两个半边的导出契约 /
#                               slot 注册姿势 / 说明符白名单 / 12 个 RPC 的声明-定义-可达一致性 / locale
#  2) test/client-stub-check.mjs 客户端逻辑层桩检：用桩 require + 桩 ctx **真的执行**
#                               factory 与 apply，断言 $mount 的 contribution 与两个 slot 的注册
```

桩检补的是空档：`verify.mjs` 只看字节，浏览器检查在拒绝启动浏览器的环境里跑不了，
而桩检既不需要浏览器也不需要网络，还能覆盖 `apply` 的降级分支（`remote` / `slots` 缺失时是否优雅退出）。

`prepublishOnly` 跑同样这两步，所以发布前必然过一遍。

已安装副本的解析自检（验证「装进 profile 之后还能不能 import」）：

```bash
node test/installed-check.mjs <profile>/node_modules/dsh-magical-lowcode-project
node test/installed-check.mjs --from-profile <profileDir>
```

客户端半边的**浏览器真机检查**（唯一能证明 `apply()` 真在浏览器里跑成功的检查）：

```bash
node test/browser-check.mjs "http://127.0.0.1:<port>/?token=<token>"
```

它用 headless Chromium 打开真实界面，断言 `__DSH_BOOT__` 里有本插件的 boot 行、
侧边栏出现本插件注册的按钮（`title="低代码工程模式"`），且没有涉及本插件的运行时异常。
⚠️ 它需要能启动 Chromium 的环境；在拒绝启动浏览器的沙箱里会停在「连不上调试端口」。

一次性的真机验证流程：

```bash
# 用隔离的 DSH_HOME，避免动到你自己正在用的 profile
npm pack
DSH_HOME=<scratch> dsh plugin --profile verify add "$PWD/dsh-magical-lowcode-project-<version>.tgz"
DSH_HOME=<scratch> dsh --profile verify --dump-config | tail -n 3     # 应能看到本插件的层
node test/installed-check.mjs --from-profile <scratch>/profiles/verify
```

> **别用 `dsh plugin add <目录>` 做开发安装**：那会走 pnpm 的 `link:`，**不会安装传递依赖**，
> 于是 `fflate` 缺失、`lib/index.js` 顶层 `import "fflate"` 抛 `ERR_MODULE_NOT_FOUND`，
> 而插件的模块级导入失败会**打挂整个 profile**。请用 `npm pack` 出的 tarball 安装，或
> 直接在插件目录里 `npm install` 补齐依赖。

## 许可

MIT。本包是 **DSH Desktop**（[dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop)，MIT，Copyright (c) 2026 DataElement）中 `plugins/dsh-desktop-project` 的衍生作品：host 半边的工程模式 RPC 与 `.dshpreset` 端点沿用其 MIT 授权，client 半边是全新实现。详见 `LICENSE`。
