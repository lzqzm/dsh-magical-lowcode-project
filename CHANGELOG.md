# 变更记录

本文件只记面向使用者的变更。插件市场在「更新内容」处会展示版本说明或提交记录，
所以每个版本都留一条。

## 0.2.1

把工程模式的**交互闭环**补上：项目树从「一层列表」变成可展开的多级树，树里就能下拉/推送，
而且每一次脚本执行都先把要跑的 node 命令亮出来再确认。

- **新增：多级项目树。** 目录行点名字展开/收起，**展开时才**向 host 拉那一层；「刷新」重载根
  与所有已展开的子目录；空目录、加载失败、截断各有提示。
- **新增：树内联推送状态与一键推送。** 每行按 `projectPushStatus` 标出 `● 待推送` / `✔ 已推送`；
  待推送的行直接给出 **↑ 推送**，推完自动对同一目标 `projectMarkPushed` 记账（不再需要去另一个页签手动标记）。
- **新增：下拉入口（按目录语义挑脚本）。** `pages` / `apis` / `databases` 目录分别对应
  `source-page-pull.js` / `source-api-pull.js` / `source-db-pull.js`；32 位 UUID 的项目目录对应
  `source-clone.js <uuid>`；pages/apis 区里的其它目录先问 ID 再下拉。下拉成功后**清空推送状态记录**
  （本地文件已被线上覆盖，旧的「已推送」账目不再成立）。
- **新增：命令预览确认弹窗。** 下拉/推送/脚本运行都先弹「操作确认」，把要执行的命令原样亮出来
  （`$ node source-page-push.js xxx`）：下拉带红字「会覆盖本地文件」警告，推送灰字提示核对 `.env`；
  执行完在同一个弹窗里显示 exit code 与输出。
- **新增：行内「复制路径」与「项目命名」。** 32 位 UUID 的项目目录可设显示名
  （只改 `.dsh-project-names.json`，不动物理目录名）。
- **改：工程脚本页签**加了 6 个常用脚本快捷入口，运行同样走确认弹窗；文案说明下拉类自动清记录、
  推送类要在项目树里点 ↑ 才会自动标记。
- 自检：渲染层桩检新增「脚本页签渲染出 6 个快捷脚本入口」断言（项数 9 → 11）。它顺带暴露了
  「页签 Pill 与快捷脚本 Pill 混在一起计数」的脆弱断言，页签断言已改为按标签识别。

## 0.2.0

跟随 DSH 0.2.0 的 Agent 预设模型改造；装到 0.2.0 宿主上不再被判为不兼容。

- **修：与 DSH 0.2.0 不兼容。** 0.2.0 把 `@deepseek-ai/dsh-agent-presets` 拆成了
  `@deepseek-ai/dsh-agent-preset`（预设声明行）+ `@deepseek-ai/dsh-agent-preset-registry`（提供 `agentPresets` 服务），
  预设不再是磁盘目录。旧的 peer 范围 `^0.1.5-0` 会让 `evaluatePluginCompatibility` 在 0.2.0 宿主上直接判不兼容，
  插件管理器连装都不让装。现在 peer 是 `@deepseek-ai/dsh-agent-preset-registry` 与
  `@deepseek-ai/dsh-typert-protocol`（均 `^0.2.0-0`），`engines.dsh` / `dshhub.compatibility.dsh` 升到 `>=0.2.0-0`。
- **改：`.dshpreset` 导出改为读预设声明。** 不再遍历预设目录，改用 `agentPresets.list()`
  + `agentPresets.readDocument(id)` 取插件清单，写进包内 `preset/agent.cordis.yml`（沿用 0.1.x 的
  `COMPOSITION_FILE` 值；包格式仍是 `format: "dsh-preset"` / `version: 1`）。0.2.0 里内置与自定义都是声明，
  不再有 `trust` 之分，所以内置预设也可以导出，旧的 403 分支已删除。
- **改：`.dshpreset` 导入改为写 profile patch。** 0.2.0 没有「用户预设根」可写，安装时把
  `{id, name, description, plugins}` 作为一行 `@deepseek-ai/dsh-agent-preset` 声明 INSERT 进 profile 的
  `cordis.patch.yml`（取自 `ctx.get("profileContext").patchPath`），先写临时文件再原子 rename；
  已有同 id 声明时返回 409。插件清单必须是 YAML 序列，`!!js` 表达式原样保留；预览新增 `pluginCount`。
- 新增依赖 `yaml`（读写 profile patch）；`test/verify.mjs` 的宿主区间与 peer 名单、README、使用文档同步更新。

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
