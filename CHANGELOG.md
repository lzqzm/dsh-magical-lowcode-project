# 变更记录

本文件只记面向使用者的变更。插件市场在「更新内容」处会展示版本说明或提交记录，
所以每个版本都留一条。

## 0.1.1

面板在真实界面上被看到之后修的版式缺陷，外加一处日常使用上的便利改动。

- **修：面板太窄，内容被裁。** `UI.Modal` 的对话框自带固定宽度（实测 380px）且 `overflow: hidden`，
  五个页签被挤成两行，每行行尾的「查看 / 改名 / 删除」只露一半。现在通过 `Modal` 的 `className`
  把面板自己的窄样式挂到对话框元素上（`.dshml-wide{width:min(900px,88vw)}`），页签回到一行，
  行尾按钮完整可见。
  （第一版修法只给子节点加了宽度 —— 对话框不随内容伸展，因此完全无效；子节点必须用 `width:100%`。）
- **改：四个页签共用同一个工程目录。** 目录输入框原本每个页签各记一个键，换个页签就得重粘路径；
  现在共用一个键，在「项目树」填过的目录在「推送状态 / 预览与体检 / 工程脚本」里已经预填。
- **新增：面板截图与 `screenshots.json`。** 三张真实运行截图（项目树 / 推送状态 / 预览与体检）
  放在 `assets/`，按插件市场详情页的约定在根目录 `screenshots.json` 里声明。
- 自检从 31 项加到 **32 项**（新增 `screenshots.json` 的格式与路径存在性校验）。

## 0.1.0

首个版本。

**host 半边**（12 个 `desktopProject/*` RPC）

- 工程文件树 `listProjectEntries`：列一层目录与文件，限已注册工作区内
- 推送状态 `projectPushStatus` / `projectMarkPushed` / `projectResetPushState`：
  以 `page.json` 的 uuid、`meta.json` 的 id 为推送键，走 mtime 快照比对，区分已推送/待推送
- 脚本运行 `projectRunScript`：只允许工作区根目录下的 `source-*.js`，用宿主自带的 node 执行
- 推送前静态校验 `projectLint`：V1.01~V1.06 规则（裸 `{{}}` 插值、缺 `magicalDragScene`、
  `myMethod` 合并循环、系统合并区外改 `vueMethod`、CSS 花括号不平衡、平台 API 路径惯例等）
- 预览装配 `projectAssemblePreview`：把 `page.json` / `index.html` / `page.css` / `page.js` 内联成沙箱页
- 文件操作 `projectReadFile` / `projectWriteFile` / `projectRenameEntry` / `projectDeleteEntry` /
  `projectSetProjectName`

**host 半边**（2 条带认证的 HTTP 端点）

- `GET  /api/agent-preset.export?agentPreset=<id>`：导出自定义预设为 `.dshpreset`
- `POST /api/agent-preset.import[?agentPreset=<id>&install=1]`：先预览校验，再原子安装；
  同名冲突返回 409，绝不覆盖。压缩 ≤16MB / 解压 ≤32MB / 单文件 ≤12MB / ≤512 文件；
  拒绝绝对路径、父目录穿越、反斜杠路径与符号链接

**client 半边**

- 自包含 Web 面板，五个页签：项目树 / 推送状态 / 预览与体检 / 工程脚本 / 预设包
- 侧边栏底部一个入口，打开同一面板的浮层副本
- 手写经典 script 产物，React 与 UI 基元全部复用宿主 shell 的种子表（不打包、不重复引入 React）
- 面板与 host 的 RPC 走**同源 fetch 信封**（`POST /api/desktopProject/<method>`），
  不依赖构建期产出的 typed contribution，也不需要宿主提供 `remote` 服务
- 已在真实浏览器（headless Chromium）里实测：点开入口、五个页签逐个切换、
  点「重置记录」触发一次真实 RPC 往返（7/0）
- **不修改任何 `@deepseek-ai/*` 核心包**

**兼容性与依赖**

- `engines.dsh = ">=0.1.0-rc.5 <0.2.0-0"`；对照 `@deepseek-ai/dsh-*` `0.1.5-rc.2` 开发，
  已在 `0.1.5-rc.1` 宿主上实测（含真实 web 实例上的 RPC 调用）
- Node `^22.19.0 || >=24.0.0`
- 核心包走 `peerDependencies`，复用宿主自带那一份

**来源**

衍生自 DSH Desktop（MIT, Copyright (c) 2026 DataElement）的 `plugins/dsh-desktop-project`：
工程模式 RPC 与 `.dshpreset` 端点沿用其实现，客户端面板为全新自包含实现。
