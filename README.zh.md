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

包格式上限：压缩 ≤16MB、解压 ≤32MB、单文件 ≤12MB、≤512 个文件。拒绝绝对路径、父目录穿越、反斜杠路径与符号链接。0.2.0 起内置与自定义预设都是 profile patch 里的一行声明，没有 `trust` 之分，所以内置预设也可以导出。

### Web 面板（client 半边）

在 DSH Web 界面里自带一个**工程浏览器**：**左栏是常驻的多级项目树，右栏是详情区**（文件内容 / 体检与预览 /
推送状态 / 工程脚本 / 预设包 五个页签），顶部一行是共用的路径输入框与工具栏按钮。**设置页分节 /
侧栏浮层 / 会话页签** 三处入口共用这一个浏览器。

- **左栏 · 项目树** —— **多级**浏览工程目录（点目录名展开/收起，展开时才向 host 拉那一层）；树顶有
  **模糊查找框**：递归搜整棵工程目录，按子序列匹配（「备管」命中「备件管理」、`spp` 命中 `source-page-push.js`），
  名字或相对路径命中才列出（输入 `index.html` 不会再带出同目录的 `page.js`）；
  点一条结果逐级展开定位过去；每行内联 `● 待推送` / `✔ 已推送`；行尾动作按钮
  （**↑ 推送**／**↓ 下拉**／**✏ 项目命名**／**查看**／**📋 复制路径**）
  只在**鼠标悬停该行或该行被选中**时出现，平铺状态下每行只有文件名与状态标签；**右键**任意行还有一整套
  动作：查看内容、复制内容（发给 AI）、推送前校验、刷新、重扫推送状态、修改环境配置、复制绝对/相对路径、
  改名、删除（不适用的项灰显禁用）。点文件名在**右栏「文件内容」**里就地编辑并保存，32 位 UUID 的
  项目目录还能设显示名；工具栏的**环境配置**一键读写工作区根 `.env` 的 `SERVER_URL` / `PROJECT_UUID`
- **右栏 · 文件内容** —— 选中文件后**默认只读查看**；**选区由插件按行算**（原生选区在只读区里关掉了，浏览器那条拖选会把窗口拖死）：点一行定起点、拖过或 Shift+点另一行定终点，选中的行整行高亮，可选则**复制选中**、**发给 AI 改**（路径 + 行号范围 + 选中内容 + `【我的要求】` 一起进剪贴板，粘进对话补一句要求即可）、**改这段**（只把这几行放进小文本框，保存时按行号替换回原文件，其余逐字不动）；整份内容用**复制全文**；点**编辑**才进编辑框 —— 0.2.19 起默认不进编辑框，避开浏览器的拖选死锁，也少一次误改；**0.2.21 起编辑框按 120 行分页**（`EDITOR_PAGE_LINES`），「编辑」与「改这段」用同一个分页编辑器（多页时给「上一页 / 第 x/y 页 / 下一页」），所以文件是 900 行还是 9 万行，控件里都只有一页的量级，不再有整份内容进大文本域那条路；对话框标题会写「编辑整份 · 共 N 行（分页）」或「改这段 · 第 X–Y 行」；没选文件时给浏览提示（行级选择与「改这段」在 0.2.20 起，分页编辑在 0.2.21 起）
- **右栏 · 体检与预览** —— 「树内校验」的结果就在这一页（右键点校验后自动切过来），其后是装配预览
  （在新标签打开沙箱页）与静态校验问题列表
- **右栏 · 推送状态** —— 一眼看出哪些改了没推；可标记已推送、重置记录、设虚拟项目名
- **右栏 · 工程脚本** —— 跑工作区根目录下的 `source-*.js`（含 6 个常用脚本快捷入口），带参数，回显命令与输出；
  点运行前先由 host 定位脚本目录并预检那层 `.env` 的四个键（`SERVER_URL` / `USERNAME` / `PASSWORD` / `PROJECT_UUID`），
  缺键就只提示「环境变量未维护」并给一个就地维护入口，**不弹执行确认**
- **右栏 · 预设包** —— 导出/导入 `.dshpreset`

下拉与推送都走**命令预览确认**：先把要执行的 `node source-*.js …` 原样亮出来（下拉带覆盖警告），
确认后才执行；下拉成功清空推送状态记录（本地已被线上覆盖），推送成功自动给该目标记账。

**环境配置**对话框读写工作区根 `.env` 的 `SERVER_URL` / `PROJECT_UUID`：命中同名行只替换那一行
（保留原缩进与 `export ` 前缀），否则追加到末尾，注释与其它键原样保留；值里有空白或 `#` 时自动加引号。
本地还没有 `.env` 会提示「保存会新建一个」。
「工程脚本」页签的运行前预检改的是**脚本所在那层**的 `.env`（四键，多 `USERNAME` / `PASSWORD`），
与这里的工作区根 `.env` 不是同一个文件（localdev 布局下脚本在上一层）。

三个入口共用同一个工程浏览器：**设置 → 低代码工程模式**、**侧边栏最底部的 `▤` 按钮**（浮层副本），
以及**会话里的「低代码工程」页签**（`slot: conversation.view`，`order: 20`）。会话页签由面板顶部的
**工程模式开关**控制：开关默认打开，关掉就即时从会话里摘掉该页签（设置页与侧栏两个入口不受影响）。
状态存在 `localStorage` 的 `dsh-magical-lowcode-project:project-mode`，同页面多实例与多标签页都会同步。

切换入口或页签**不会丢数据**（0.2.15 起）：项目树、已展开的层与推送状态走模块级缓存，重新挂载先显示旧数据、
随后后台重扫；展开到哪一层、上次打开的文件、右栏停在哪个页签另外记在 `localStorage`
（`…:expanded` / `…:selected` / `…:detail`），回到面板会自动列出并读回上次的文件。

界面文案跟随宿主语言：设置页导航名、会话页签、侧栏按钮标题、五个页签名与开关行都有中英两套
（`locale` 服务可用时 `locale.register` + `locale.bind` 跟随宿主语言；不可用时回落内置中文）。
面板内部的说明性长文案暂时保持中文。

## 安装

在 DSH 的 **设置 → 插件市场** 里搜索 `dsh-magical-lowcode-project` 一键安装；或手工：

```bash
dsh plugin --profile web add dsh-magical-lowcode-project
```

## 兼容性

- 宿主：`engines.dsh = ">=0.2.0-0"`（对照 `@deepseek-ai/dsh-*` `0.2.0-rc.2` 开发并实测）
- Node.js：`^22.19.0 || >=24.0.0`
- 平台：Windows / macOS / Linux

下界 `0.2.0` 是有意的：0.2.0 换了 Agent 预设模型（预设变成 profile patch 里的一行声明，由 `@deepseek-ai/dsh-agent-preset-registry` 提供；旧的 `@deepseek-ai/dsh-agent-presets` 与其磁盘预设根已不存在），本版就是按这套模型实现的。插件市场安装前会读 `engines.dsh` 做兼容性判定，落在范围外会被拒绝安装（而不是装上一个坏插件）。

核心包（`@deepseek-ai/dsh-agent-preset-registry`、`@deepseek-ai/dsh-typert-protocol`）声明为 `peerDependencies`，**复用宿主自带那一份**，不会装出第二份实例。

## 权限与安全边界

- 文件访问**只限已注册的工作区**，路径先规范化再与工作区前缀比对，越界直接拒绝
- 脚本执行有白名单：只允许 `source-*.js`，从传入目录**逐级向上找到工作区根**（脚本放工作区根或工程子目录都行），用宿主自带的 node 执行（`shell: false`），stdout 超 400000 字符会被中止，输出截断到 20000 字符
- 推送状态文件写在 `$DSH_HOME/project-push-state.json`（读取时兼容从旧路径一次性迁移）
- **host 半边自身不发起任何对外网络请求**，两条 HTTP 端点走 DSH 自己的 connection 认证通道
- ⚠️ **预览页会外联**：`projectAssemblePreview` 装配出的 HTML 里含
  `<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>`，
  在浏览器里打开该预览就会请求 jsdelivr。这是从上游 DSH Desktop 原样继承的行为，此处如实披露。

## 开发

没有构建步骤：host 半边与 client 半边都是手写产物，直接改 `lib/index.js` / `lib/client.js` 即可。

```bash
# npm test 串三个检查（零依赖，CI 与 prepublishOnly 跑的是同一条命令）
npm test
#  1) test/verify.mjs           静态自检：manifest / 兼容性字面量 / 两个半边的导出契约 /
#                               slot 注册姿势 / 说明符白名单 / 12 个 RPC 的声明-定义-可达一致性 / locale
#  2) test/client-stub-check.mjs 客户端逻辑层桩检：用桩 require + 桩 ctx **真的执行**
#                               factory 与 apply，断言每次 RPC 都走同源 fetch 信封
#                               （POST /api/desktopProject/<method>，12 个方法与 host 逐字含序比对），
#                               以及两个 slot 的注册姿势
#  3) test/render-check.mjs     客户端渲染层桩检：用桩 React **真的渲染**两个 slot 组件，
#                               逐个拨动右栏五个页签，断言左树常驻、每个页签渲染出的组件、
#                               页签标签顺序、脚本页签的 6 个快捷入口与侧边栏入口结构（25 项）
```

两个桩检补的是空档：`verify.mjs` 只看字节，而桩检既不需要浏览器也不需要网络 ——
逻辑层还能覆盖 `apply` 的降级分支（`slots` 缺失时是否优雅退出），渲染层则证明
左树常驻、五个页签都真的画得出来。

但它们覆盖不到**真实 loader 与真实点击**：客户端半边曾经在真实浏览器里以
`descriptor.parameters is not iterable` **整体加载失败**，而三个桩检当时全是绿的。
只有下面那条浏览器真机检查抓得出来 —— 所以它不是可选项。

`prepublishOnly` 跑同样这三步，所以发布前必然过一遍。

已安装副本的解析自检（验证「装进 profile 之后还能不能 import」）：

```bash
node test/installed-check.mjs <profile>/node_modules/dsh-magical-lowcode-project
node test/installed-check.mjs --from-profile <profileDir>
```

客户端半边的**浏览器真机检查**（唯一能证明 `apply()` 真在浏览器里跑成功的检查）：

```bash
node test/browser-check.mjs "http://127.0.0.1:<port>/?token=<token>"
```

它用 headless Chromium 打开真实界面，点开侧边栏入口、逐个拨动右栏五个页签，并断言：
`__DSH_BOOT__` 里有本插件的 boot 行；侧边栏出现本插件注册的按钮
（`title="低代码工程模式"`）；五个页签都在且都能点得动；点「重置记录」时一次真实
RPC 走 `/api/desktopProject/projectResetPushState` 并返回 `ok=true`；没有任何涉及
本插件的运行时异常。
⚠️ 它需要能启动 Chromium（以及创建命名管道）的环境；受限沙箱里 Chrome 会以
`OpenProcess: 拒绝访问 (0x5)` 直接退出。

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
