# dsh-project-panel 开发笔记

面向 DSH web 端（`0.2.0-rc.2`）的工程面板插件。当前形态：**右侧栏的一个 tab**
+ 侧栏底部一个「工程」按钮。中间栏（会话 + 输入框）保持原样，绝不占用。

## 目录

```
dsh-project-panel/
  package.json          依赖只有给脚手架用的那 4 个（见下）；dsh.bundle.patch / dsh.client.platform = "web"
  cordis.patch.yml      insert: dsh-project-panel
  lib/index.js          host 半边：desktopProject/* RPC
  lib/client.js         client 半边：手写 ESM，改了刷新即生效
  lib/client.editor.js  ⚠ 构建产物（644 KB，CodeMirror 6）—— 不要手改
  src/editor.js         编辑器分片的源码，npm run build:editor 生成上面那个
  scaffold/             自带的平台脚本模板（source-*.js + utils.js + package.json）
  NOTES.md              这份笔记
```

### 仓库里**没有**的东西

开发时用过、但不进仓库的两个目录（`.gitignore` 里挡着，本地重新建也不会被提交）：

- `_dbg/lintprobe/` —— 24 个 `.mjs` 探针，是改这个插件时的**唯一回归网**。套路是
  「复制一份 `lib/index.js`，把 `const HANDLERS = {` 换成 `export`，再 import 真模块」；
  `scriptsui.mjs` / `runcallbacks.mjs` / `treemenu.mjs` / `pushbadge.mjs` 那类则是从
  `lib/client.js` 里**原文抠出** `renderScripts` / 回调 / `renderPushBadge`，喂一个假的
  `h` 再断言。**笔记里凡是写 `_dbg/lintprobe/xxx.mjs` 的地方，路径都已经不存在** ——
  留下的只是「当时怎么验的」和结论，要重跑得照描述重建那个探针。
- `_ref/` —— 两个第三方仓库的克隆，只用来对照原版实现：
  `gitee-dsh` ← `https://gitee.com/nblt_1/dsh.git`（`176afdc`）、
  `magical-src` ← `https://github.com/lzqzm/dsh-magical-lowcode-project.git`（`b5f5f20`）。
  笔记里 `_ref/gitee-dsh/plugins/dsh-desktop-project/lib/index.js:532-584` 指的是前者里
  那三个**还没移植**的 RPC：`projectSetProjectName` / `projectAssemblePreview` /
  `projectRenameEntry` —— 要接着做就按上面的地址重新 clone 一份。

  ⚠ 那个 `magical-src` 的地址要打折扣看：**这个仓库后来被改名成
  `https://github.com/lzqzm/dsh-project-panel`，内容也被本插件整体覆盖了**（commit
  `5deb8fa`）。当时 clone 的 `b5f5f20` 是它的前身 —— 一个 0.2.28 的旧版实现，
  git 历史里还在，想对照得 `git show b5f5f20:lib/index.js`。

（`_dbg/scriptbak/` 是平台脚本改造前的备份，连同 `_dbg/` 一起移除了；脚本本体在
`scaffold/` 里。）

装进 profile，两种装法：

```
dsh plugin --profile web add github:lzqzm/dsh-project-panel   # 从仓库装：市场能给一键更新
dsh plugin --profile web add <本仓库的绝对路径>                # link: 装本地这份：改代码即时生效
```

仓库名在 2026-10 从 `dsh-magical-lowcode-project` 改成了 `dsh-project-panel`；旧地址
GitHub 会 301 重定向，所以按旧名装过的机器照样能用，只是依赖里那行 spec 是旧字符串。

`link:` 安装不装传递依赖，所以**两个半边都不许 import 第三方包，也不许
import `@deepseek-ai/*`**（Node 从插件真实路径向上解析，够不到
`profile/node_modules`）。顶层 import 失败会打挂整个 profile。

`node_modules/` 里分两类，**运行时都不参与 host / client 的 import**：

- 构建期：esbuild + CodeMirror（编辑器代码已经打进 `lib/client.editor.js`）。
- 给**脚手架**用的：axios / archiver / form-data / unzipper。铺到新工作区的
  `source-*.js` 要 require 它们，但那边的目录里没有 `node_modules` —— 所以由
  `projectRunScript` 给子进程塞 `NODE_PATH=<插件根>/node_modules`（详见
  「空目录也能拉项目」一节）。`package.json` 里那个 `"//dependencies"` 注释键
  就是给未来的自己留的说明：这几个不属于本插件的运行依赖。

改了东西之后要做什么：

| 改了哪 | 要做什么 |
| --- | --- |
| `lib/client.js` | 刷新页面 |
| `lib/index.js`（host） | 重启 `dsh web` |
| `src/editor.js` | `npm run build:editor`，再刷新页面 |

## client 半边的硬约束

- 产物必须是 `window.__ModuleLoader__.load({ id: "<npm 包名>", factory: (require) => exports })`。
  `id` 必须逐字等于 npm 包名。
- **只能 require 这 9 个说明符**：`react`、`react/jsx-runtime`、`react-dom`、
  `react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
  `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
  `@deepseek-ai/dsh-client-ui-dockkit`。其他说明符运行时直接抛错。
- 具名导出 `apply` 与 `inject`，**没有 default export**。`inject` 是 cordis
  服务键数组。
- 所有注册都走 `slots.inject(key, () => slots.register(...))`，让 disposer
  落在本插件 fiber 上。
- **不能在模块体做副作用**：整个文件只定义函数并调用一次 `load()`。
- **绝不注册 `root` scope 的 slot**（`sidebar` / `main` / `rightbar` /
  `shell.overlay` / `shell.leading`）：single 且被 shell 独占，注册会 shadow
  整个 AppFrame。

## 右侧栏 tab 的注册（两段式）

**第一段**——`ctx.sidebarRightTabs.register(definition)`，声明这个类型是
什么。契约见 `@deepseek-ai/dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts`：

```ts
interface SidebarRightTabDefinition {
  id: string;                 // 实现身份，唯一；body/title 在这个 key 下注册
  kind: string;               // 类型判别符
  multiple?: boolean;         // 省略 = 每个 pane 只保留一个页面
  keepMounted?: boolean;
  patterns?: readonly string[];   // 资源地址 glob；页面类型省略
  priority?: 'extension' | 'builtin' | 'fallback';   // 默认 extension
  canOpen?: (address: string) => boolean;
  title: (address: string) => string;
  guide?: readonly { id: string; order: number; title: () => string;
                     description?: () => string; icon?: ComponentType }[];
}
```

- 一个 kind 可以同时有一个 `builtin` 和一个 `extension`，**extension 生效**。
- 同一 band 内重复注册、或 id 重复 → 抛错。
- 默认页规则：恰好一个 guide 入口时直接打开该页；0 个或多个时打开引导页。
- 布局存 `localStorage` 键 `dsh.sidebar-right.v1.<sessionId>`。

**第二段**——正文注册进 keyed 席位：

```js
slots.inject("sidebar.right.pane.tab", () =>
  slots.register({ name: "sidebar.right.pane.tab", key: id }, Body));
```

`sidebar.right.pane.tab` 的 `children` 声明在 `ui-sidebar-right` 里带了
`inject: { hooks: { tabInfo: tabInfoFactory } }`，所以**正文组件自动收到
`useTabInfo` prop**，无需自己 inject。`useTabInfo()` 返回：

```js
{ sidebar: { expanded, fullscreen },
  panel:   { id },
  tab:     { ...record, visible, navigation, signal, actions, refreshShortcut } }
```

`tab.actions` 有 `openResource(address, options?)` / `openTab(kind, options?)`
/ `close()` / `bindCommands(commands)`。

**打开 tab**：`ctx.sidebarRight.openTab(kind, options?)`（跨插件服务面，
`lib/types/client/service.d.ts` 的 `ISidebarRight`）。**同一步会自动展开
右侧栏**——"content the user cannot see is not opened"。

## 文件预览怎么走

点文件时把绝对路径折成 `dsh-resource://file/session/<sessionId>/<相对路径>`
交给 `tab.actions.openResource(...)`，官方 `dsh-client-ui-sidebar-documentpreview`
接管渲染（高亮、折行、图片、Markdown）。地址构造逻辑抄自
`@deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js` 的 file-address 段：

```js
const FILE_ADDRESS_PREFIX = "dsh-resource://file/";
encodeSegment = (s) => encodeURIComponent(s).replace(/%3A/gi, ":");
encodePath = (p) => p.split("/").map(encodeSegment).join("/");
```

一定要带 `//`：`new URL("dsh-resource://file")` 会把裸 `file` 当主机名丢掉。

## host 半边的 RPC

走 `connection.fetch.register`（认证 Fetch 路由，与 `/api/agent-preset.export`
同机制），**不需要 `@deepseek-ai/dsh-typert-protocol`**：

```
POST /api/desktopProject/<method>
body: { type: "client-request", rpcId, method: "desktopProject/<method>",
        payload: { args: { ...} } }
resp: { ok: true, value } | { ok: false, error: { code, message, detail } }
```

已实现（共 18 个）：
`listProjectWorkspaces`、`listProjectEntries`、`projectReadFile`、`projectWriteFile`、
`projectCreateEntry`（可带 `content`，见下面的模板一节）、`projectRenameEntry`、`projectMoveEntry`、`projectDeleteEntry`、
`projectSearchEntries`、`projectGrepFiles`、`projectLint`（见「推送前静态校验」一节）、
`projectPushStatus`（会连校验一起算，见「徽章上的校验计数」一节）、
`projectMarkPushed`、`projectResetPushState`、
`projectListScripts`、`projectRunScript`、`projectRunScriptPoll`、`projectRunScriptStop`
（后四个见「『脚本』页签」一节）。

**曾经有过 `projectCopyEntry`**（连同 client 的复制 / 粘贴一起在 2026 年那轮被撤掉了）。
它当时是 `projectMoveEntry` 的复制版，唯一区别是重名不报错、靠 `freeName()` 往后找空位
（`a.txt` → `a (2).txt`），目录用自写的 `copyTree()` 递归、**不用**实验性的 `fs.cp`。
要恢复的话按这个形状写回去，注意 `copyFile` 的 import 也已经一起删了。

**路由是一次性注册的**：`apply()` 里按 `Object.keys(HANDLERS)` 建表挂上去。
所以往 `HANDLERS` 里加 RPC 之后**必须重启 `dsh web`**，光刷新页面拿到的还是旧路由 ——
症状是新 RPC 返回 `HTTP 404`，而旧的照常能用。

**连通性自检**：拿一个已注册工作区内的路径调 `listProjectEntries`；报
`path-outside-workspace` 就说明路由通了（这是应用层错误，不是 404）。

## 路径边界

一切路径必须落在 `ctx.workspaceRegistry.list()` 给出的某个工作区内，否则抛
`path-outside-workspace`。比较前统一分隔符并在 win32 上转小写。
`projectWriteFile` 额外禁止把工作区根当文件写。

**所以用户的工程目录必须先在 DSH 里注册成工作区**，否则面板看不见它。

## 环境事实

- host RPC 或 client bundle 改动后**必须重启 `dsh web`**；`dsh` CLI 没有
  reload 子命令，client 插件清单在启动时固化。
- 真实安装路径前缀（**不在 `profiles/web/node_modules` 下**）：
  `<pnpm 全局目录>\…\.pnpm\@deepseek-ai+dsh-web-app@<版本哈希>\node_modules\@deepseek-ai\`
- profile 备份：`<用户目录>\.dsh\profiles\web\package.json.bak-before-project-panel`、
  `cordis.patch.yml.bak-before-project-panel`。

## 走过的弯路（别再踩）

1. **注册 `main` + `sidebar.panellist`** → `ctx.layout.selectPanel(id)` 把中栏
   整块换成插件面板，用户的会话和底部输入框全没了。
2. **注册 `shell.overlay` 做浮层** → `dsh` 的 overlay 层级里 `position: fixed`
   不可靠，主区被挤窄；窄浮层里树 300px + 详情区只剩 20px，文件基本没法看。
3. **用 `ctx.remote.$mount`** → 要走构建期生成的 typed contribution，运行期
   手写不出来，真实浏览器里以 `descriptor.parameters is not iterable` 崩掉。
   必须走 fetch 信封。
4. **手写 `git clone` 上游桌面端插件直接装** → 上游锚 `0.1.2-alpha.5`，且
   `dsh-agent-presets` 在 0.2.0 已改名 `dsh-agent-preset-registry`。

## 输入框引用（工程树 → `@` 引用）

树里每个条目（文件、目录都有）行尾一个「引用」按钮：点它把一条引用 token 插进
会话输入框。走官方输入面，**不要自己注册 `@` source**（会和官方
`dsh-client-ui-reference` 抢同一个 trigger，同 trigger 重复注册直接抛错）：

```js
const span = inputActions.captureInsertion();   // 带 draftRev 做 CAS
inputActions.insertText(text, span);            // 一个撤销步
```

`inputActions` 由 ui-conversation 通过 `ctx.uiSession.provide({ props: ["inputActions"] })`
登记（`dsh-client-ui-conversation/lib/client.js:18126-18142`），再经 `UiSession.adapter`
按 scope 自动注入到**所有 session scope 的 slot 组件**，`sidebar.right.pane.tab`
就在其中 —— 不必在 `slots.register` 里声明 inject。取不到时退到剪贴板 + 提示。

**格式逐字照抄官方 grammar**（`dsh-client-ui-reference/lib/client.js:17-23` 的
`formatFileMention`），否则装饰匹配不上、显示成普通文本：

- 目录补尾斜杠：`@src/`
- 含空白走引号：文件 `@"a b.ts"`；目录 `@"a b/`（**故意不闭合**，光标停在下钻位）
- 含控制字符或 `"` → undefined，放弃插入

**路径基准必须是会话工作目录**（`useSessions((s) => s.byId[sessionId]?.cwd)`），
与官方文件树、预览地址同一个根。改用面板自己选的目录当基准，一旦两者不同，
预览地址就退化成带盘符的绝对路径 → 「文件不存在，可能已被移动或删除」。

实测：目录引用同样被渲染成蓝色可点击芯片 ✓

**「引用 / 查看源码」两个入口必须同判据。** 行尾那两个小按钮（「源码」「引用」）和
右键菜单里同样的两项，用的是同一套判断：

- 「查看源码」只给文件（目录没有源码可看，走进编辑器只会弹「无法预览」）；
- 「引用」不给工作区根（引一个根没有意义）—— 判据就是
  `relativeUnder(cwd, entry.path) !== ""`，和行尾按钮**一模一样**。

用户提过「右键的时候把引用和查看源码也放进去吧，这样子更方便操作」—— 右键是这类
面板里最顺手的入口，但复制一份逻辑就等于埋一个分岔点：哪天行尾改了判据、菜单忘了
改，用户看到的就是「按钮有、菜单里没有」。所以两处共用同一个 helper、同一个判据，
`treemenu.mjs`（27 项）专门钉这条 —— 文件菜单 8 项、目录菜单 7 项、工作区根既无
「引用」也无「查看源码」、空白处只剩新建 + 推送状态那几项。

菜单位置：文件在「新建文件 / 新建文件夹」之后、「编辑」之前（**读在改前面**）；
目录在「新建文件 / 新建文件夹」之后、「推送前校验」之前。

## 源码页签与多标签

面板只有两个页签：**文件树** / **源码**（`view` 状态）。源码页签里可以**同时开多个
文件**，顶部一条标签条来回切 —— 状态是数组：

```js
const [shots, setShots] = useState([]);   // { mode, status, path, name, content, error, withBody, anchor, focus, dragging }
const [shotAt, setShotAt] = useState(-1); // 当前标签下标，-1 = 一个都没开
const snippet = shotAt >= 0 && shotAt < shots.length ? shots[shotAt] : null;
```

- `mode: "code"` —— 选行视图，拖选行区间引 `@文件 L起-止`。
- `mode: "edit"` —— 面板内文本编辑器，带「写回」。**现在有主动入口了**
  （见下面「面板内编辑文件」）；它最初只是委托官方预览器失败时的兜底
  （工作区外的文件，或组件拿不到 `tab.actions`）。
- `setSnippet(updater)` 保留成原单例 setter 的形状（改当前标签，传 `null` 关掉它），
  拖选、勾选、编辑器输入这些调用点不用挨个改。
- `patchShot(path, patch)` 按路径改标签：`projectReadFile` 回来时下标可能已经被挪过。
- 关掉标签后由一个 effect 把 `shotAt` 夹回合法范围；一个都不剩就退回文件树。
- 换工程目录（`dir` 变）时所有标签作废 —— 它们记的是旧根下的相对路径。

### 行号引用

`insertRange()` 取 `Math.min/max(anchor, focus)` 算出 `L12` 或 `L12-25`，拼成
`@相对路径 L12-25 ` 一次插进输入框。勾了「带行内容」还会把这几行的原文贴成代码块 ——
只给行号的话，官方引用芯片投喂的是整份文件，AI 得自己数行，常常数不准。

**拖出去的行号以浏览器原生选区为准**（`selectionLines()`），不是我们记的 `anchor`：
先拉选区、再按住选区往外拖时，那次 `mousedown` 会把 `anchor` 重置，只有原生选区
还留着真实范围。所以行上**不能**加 `userSelect: none`。

## 状态保持（两处坑）

1. **tab 注册必须写 `keepMounted: true`。** 点树里的文件会把当前 tab 换成官方
   documentpreview，切回「工程」时如果组件已被卸载，展开的树、拉过的层级、
   所有源码标签全部归零。默认（省略）是**不**保活。
2. **每个工程目录各留一份浏览状态**（`dirStatesRef`，key 是 `dir`）。
   换目录时先把当前这份存进去，再看新目录有没有缓存 —— 有就直接接上，
   没有才清空重拉。没有这层缓存的话，切到工作区 B 再切回 A，A 的树和
   源码标签都会被重置。

`dirStatesRef` 的存取放在监听 `dir` 的 effect 里，并且**靠 `prevDirRef` 判断
是不是真的换了目录**：`loadLevel` 换身份也会让 effect 重跑，那种情况必须原样返回，
否则会把用户刚展开的状态又覆盖回缓存里的旧快照。

## 文件的增删改 + 移动

树里**没有任何新建按钮**，一律右键：目录上右键建在它**里面**，文件上右键建在它**旁边**，
空白处右键算工程根。菜单项 = 新建文件 / 新建文件夹 / 重命名 / 移动到… / 删除
（后四项只在条目上出现）。
重命名和删除另有键盘入口（`F2` / `Delete`，见下面的「键盘导航」），
但**菜单仍然是唯一能新建和移动的入口**。

```js
onContextMenu: (event) => { event.preventDefault(); openMenu(event, entry); }
```

- 新建的**输入行长在目标那一层的开头**（`renderLevel` 里按 `newAt.parent === path` 插一行），
  不再有顶部工具条 —— 工具条那种全局入口在多级目录下根本看不出会建到哪个文件夹。
- 菜单用 `position: absolute`、坐标相对 `CSS.body`（`bodyRef`），**不要 `fixed` + `clientX`**：
  外层一旦有 transform 就会偏。贴底时把 `y` 往上顶，免得被面板裁掉。
- 关菜单用 **window `mousedown`（capture）监听**：命中 `menuRef.current.contains(target)` 放过，
  点别处关掉。菜单项自己的 `onClick` 在 `mousedown` 之后跑，所以不会误关。
- 右键**收着的**目录也要先 `setExpanded` 展开，否则输入行没地方长。
- `renderTree` 的未就绪 / 报错 / 空目录三个分支也套同一层带 `onContextMenu` 的容器 ——
  空目录里一行都没有，不然连新建都点不到。

### 新建文件时的模板（`templateFor`）

新建文件会按扩展名套一份骨架 —— 表放在 **client**（`lib/client.js` 的 `FILE_TEMPLATES`），
**不是 host**：它是纯静态数据，为它加一个 RPC 不值当。

判据是**文件名最后一个点之后**那段：`lastIndexOf(".") > 0` 且不是结尾的那个点。
所以 `.env` / `.gitignore` 这类「点开头、后面再没有点」的整名不算扩展名，和 host
`freeName()` 判「有没有扩展名」是同一个口径；扩展名一律 `toLowerCase()` 比（`UPPER.HTML` 也认）。
表的值可以写成**函数**，参数是去掉扩展名的文件名 —— `.md` 拿它当一级标题：`README.md` → `# README`。

**内容跟创建放在同一次写里**：`projectCreateEntry` 多了一个可选 `content`，client 挑好模板当
第 4 个实参传过去（没命中传 `""`，就是原来那个空文件）。**不要改成「建完再补一次写」** ——
中间会留下一个空文件，文件监视器和 git 都会看到两次写入，补内容那一步失败时还多出一个
本不该存在的空壳。

目前有模板的扩展名：`html`/`htm`、`vue`、`json`、`sh`/`bash`、`svg`、`md`/`markdown`。
其余一律空文件 —— 模板该省掉的是「每次都得敲的那几行」，**不要为了凑数往里塞写上去
就会被删掉的样板**。

### 移动 / 拖拽整理

两种入口，都落到同一个 `moveEntry(path, parent)`（`path` 是**源的那一条**，`parent` 是**目标目录**，不是目标全路径）：

- 右键「移动到…」→ `setMoveList(entry.path)` 进模式，之后**点哪儿就是搬到哪儿**，Esc 或提示条上的
  「取消」退出。顶栏下面会出一条提示条 —— 进了模式却不提示的话，接下来每一次点击都变成搬家，
  用户只会以为面板坏了。
- 直接把行拖到目标上松手。树行 `draggable`；目录行和文件行都是 drop 区（拖到文件上算落到
  它的父目录），行之间的空隙落到工作区根。

**`dataTransfer.getData` 在 `dragover` 里读不到** —— 浏览器只在 `drop` 时才允许读。所以拖拽中的
源路径另存 `dragPathRef`（`useRef(null)`），`dragover` / `drop` 都只看它；`drop` 时用
`{ path: src, name: baseNameOf(src) }` 现造一个最小 entry 就够了。

搬到别处之后有两件事必须跟着做，漏一个都是 bug：

1. **刷新源和目标两边的层级**（`loadLevel(here)` + `loadLevel(parent)`）。只刷一边的话，旧位置
   会留下一行幽灵：盘上已经没了，界面上还挂着。
2. **`remapShots(from, to)`** —— 把开着源码标签的路径前缀换掉，连同 `editorViewRef.current.path`。
   不换标签还挂在旧路径上，点「写回」会往一个不存在的位置写，重则把文件在**旧地方重新创建出来**；
   不换 ref 则挂载 effect 会以为「换文件了」而销毁重建，内容还在（`setSnippet` 改的本来就是
   `shots`），但滚动位置和撤销栈全丢。

host 侧 `projectMoveEntry` 的拒绝理由：目标不是目录、目标已存在（`already-exists`）、把目录搬进
它自己里面（`bad-target`）、搬工作区根、跨盘符（`EXDEV` → `cross-device`）。最后一条是
`fs.rename` 的硬限制，Windows 上换盘符一定撞上，只能提示没法绕。

### 键盘导航

| 键 | 作用 |
| --- | --- |
| `↑` `↓` | 上下走行（光标还没落过时：`↓` 从第一行、`↑` 从最后一行起） |
| `Home` `End` | 跳到首 / 末行 |
| `Enter` | 目录展开/收起；文件打开（和点击一致） |
| `→` | 展开目录。文件不响应，**不白吃这个键** |
| `←` | 展开着的目录收起；已经收着的（或文件）跳到父目录 |
| `F2` | 行内改名（复用右键那套 `editPath` / `editName`） |
| `Delete` | 删除 —— 走 `removeEntry`，目录仍会弹确认 |

**监听挂在 `window` 上，不给树加 `tabIndex`。** 树行是普通 `div`，要让它收焦点就得
「先点一下、再按键」，手感很别扭。改成「只要焦点不在输入类元素里就接管方向键」：
`INPUT` / `TEXTAREA` / `SELECT` / `isContentEditable` 一律不插手 —— 最后一条正好把
CodeMirror 也算进去了，在编辑器里打字不会触发导航。另外带 `alt` / `ctrl` / `meta` 的组合键
直接放行，不抢系统的。

**行上挂了 `data-path` / `data-kind` / `data-name`**，键盘处理按 DOM 顺序
`querySelectorAll("[data-path]")` 捞可见行，再从属性反查这一行是什么。不遍历 `nodes` 查表 ——
DOM 顺序天然就是「展开树从上到下」的顺序，省一次查表也省一类不同步的 bug。
`host.offsetParent === null` 用来兜「切到源码页签、树被藏起来了」这种情况。

**`cursor` 和 `selected` 是两份 state，不能合并。** `selected` 是「当前打开的那个文件」
（写回、标签都认它），`cursor` 只是键盘走到哪儿了 —— 合并的话上下走一圈就会顺手把开着的
标签全换掉。三种行高亮也因此能同时存在、互不打架：

- 整块底色 = `selected`（打开中）
- 虚线轮廓 = `dragOver`（拖拽落点）
- 左侧内阴影 = `cursor`（键盘光标）

光标失效的四个口子都补了：切工作区（`setCursor(null)`）、删除、改名（指向的路径已经不存在了，
按方向键会找不到它）、移动（跟着 `moved` 走）。漏掉不崩 —— `paths.indexOf(cursor)` 返回 -1，
`↓` 从头、`↑` 从尾重新开始 —— 但光标会在视觉上凭空消失。

### 首屏卡在「读取中」

`prevDirRef` 必须从 `null` 起步：

```js
const prevDirRef = useRef(null);   // 写成 useRef(dir) 就完了
```

写成 `useRef(dir)` 时，首屏那次 effect 里 `prev === dir` 当场 return，
**第一次请求永远发不出去**，树一直停在「读取中」，非要点一下打开 / 刷新才行。

## 搜索：文件名 + 文件内容（顶栏那个输入框）

顶栏原来是「工作区下拉 + 路径输入框 + 打开」三件套，已撤掉 —— 工作区就是会话
目录，没得选也不用选；真正麻烦的是树只能一层层点。现在顶栏是：

```
[ 搜索… ] [文件名] [内容] [清空] [刷新]
```

两个模式不是自动降级的，用户按 `文件名` / `内容` 自己选（选中态 = `CSS.modeOn`）。
**理由是代价差一个量级**：文件名搜索只翻目录，内容搜索要真读每个文件；
自动降级会让「怎么突然卡了两秒」变得无法解释。

### 文件名模式（`projectSearchEntries`）
- **host RPC** `projectSearchEntries({ path, query })` → `{ hits, truncated }`，
  每项 `{ name, relPath, path, kind, score, hidden }`，已按 `score` 降序排好。
- **打分是子序列匹配**（`fuzzyScore`，host 侧 `lib/index.js`）：needle 的字符按顺序
  出现在**相对路径**里就算命中，不要求连续 —— `dsprjp` 能命中
  `dsh-project-panel/lib/client.js`。加分项：连续命中（streak）、命中位置靠前、
  整条路径短。实测 `clientjs` 让 `lib/client.js`(98) 排在 `lib/client.editor.js`(95) 前面。
  打分对象是 `relPath` 而不是文件名，所以带目录的关键字（`libcli`）也能用。
- 上限 `MAX_SEARCH_HITS = 200`；超了返回 `truncated: true`，client 提示写细关键字。

### 内容模式（`projectGrepFiles`）
- **host RPC** `projectGrepFiles({ path, query, ignoreCase })` →
  `{ hits, files, matched, skipped, truncated }`。`hits` 每项
  `{ name, relPath, path, line, column, text }`，`line` / `column` 都是 **1 基**。
- **纯字面量匹配，不做正则**：用户十次有九次找的是一段普通文本，让正则悄悄吃掉
  `(` 或 `.` 反而更难解释。`ignoreCase` 默认 `true`（client 固定传 `true`）。
- **`text` 会从左边切一段**（`clipLine`）：命中列号超过 80 时从 `hitAt - 60` 开始截
  200 字符，两头补 `…`。`line` / `column` 仍是真实位置，只有展示被裁了 ——
  不然命中在长行尾部时预览里根本看不见命中本身。
- **二进制靠嗅 NUL 判断**（`looksBinary`）：只看前 8 KB（`BINARY_SNIFF_BYTES`）。
  按扩展名列白名单永远会漏，而图片 / exe / 压缩包一读一个准。
- 上限：`MAX_GREP_HITS = 400`、`MAX_GREP_FILES = 3000`、
  `MAX_GREP_FILE_BYTES = 512 KB`（超了算 `skipped` 而不是 `truncated`）、
  `MAX_GREP_LINE_CHARS = 200`。摘要行会报「读了 N 个文件，M 个文件命中 K 行，
  跳过 X 个（太大或是二进制）」，所以被跳过的量用户看得见。
- **client 侧渲染是「文件 → 行」两层**（`renderGrepSearch()`）：文件名占一行、
  右侧标「N 行」，命中行缩进挂在下面（行号右对齐 + 等宽字体的 `text`）。
  同一文件连续的行合并成一组，省掉重复文件名。
- **点命中行（或那个文件行尾的「源码」按钮）→ `openGrepHit(entry, line)` →
  `openLocal(entry, "edit", line)`**：在**面板自己的编辑器**里打开，并落在那一行。
  这里故意开 `"edit"` 而不是 `"code"`（选行视图）—— 选行视图的行是它自己渲染的，
  接不了「滚到第 N 行」；编辑器分片从 0.2.0 起认 `line`。看命中行本来也要语法高亮。
  早先这条路走的是 `revealHit` → 官方预览器的 `params.line`（跳到右侧栏去），
  在面板里搜完却要跑别处看，很别扭，所以换掉了。**文件名模式点文件行仍是 `revealHit`。**
- **`params.line` 是 1 基**（`dsh-api-workspace-files/lib/types/client/types.d.ts:14` 原文：
  “1-based line to scroll into view; absent leaves the position alone”），
  `openFile(entry, line)` 就是往那里塞的。`openShotTab(entry, mode, line)` 的 `line`
  同样 1 基，落到 shot 的 `caret` 字段上，只影响滚动位置，和选行引用的 `anchor`/`focus` 无关。

### 两边共用的部分
- **遍历是同一个 `walkWorkspace(root, visit)`**（host 侧）：DFS，跳过
  `SEARCH_SKIP_DIRS` 和符号链接，`visit` 返回 `false` 就**立刻停整棵树** ——
  两个调用方都靠它实现「命中到上限就收工」。`relPath` 一律 `/` 分隔。
  改遍历规则只改这一处。
- **跳过重目录**：`SEARCH_SKIP_DIRS` = node_modules / .git / dist / build / release /
  out / coverage / target / \_\_pycache\_\_ / .venv / venv / .next / .nuxt / .cache。
  不跳的话一个前端工程动辄几万条，面板会卡好几秒。递归深度 `SEARCH_MAX_DEPTH = 12`。
- **client 侧**：输入 250 ms 防抖（每敲一个字全量扫盘会卡手），`search` 非空时
  `renderTree()` 改道 `renderSearch()` / `renderGrepSearch()` —— 搜索结果和树是
  两套视图，不混着显示。文件名模式的行显示 `relPath`（命中可能在任意深度，
  只给文件名认不出是哪个），点目录就地展开、点文件直接打开，行尾的「源码 / 引用」
  和右键菜单与树行完全一致。
- **切模式时清掉对面那份结果**（`setGrep(null)` / `setSearchHits(null)`），
  否则旧结果会在新模式的渲染分支里短暂闪一下。
- **没有手动切换工作区的入口，这是故意的**：面板的根跟着**会话的 cwd** 走
  （`useSessions((s) => s.byId[sessionId]?.cwd)`），换会话就是换工作区。
  曾经加过「空白处右键列出工作区」，用户明确否掉了 —— 和切会话重复，多一个入口
  只会让人猜哪个才是生效的那个。`workspaces` 状态、`listProjectWorkspaces` 调用、
  `switchWorkspace()` / `CSS.select` 一并删干净。**别再往菜单里加回来。**
- 删掉 `draft` / `openDir` / `workspacePicker` 后**记得搜一遍残留引用**：
  `setDraft(cwd)` 还挂在 cwd 那个 effect 里，漏掉就是运行时错误。
- `walkWorkspace` 的 `visit` 允许是 async（内容搜索要 `await readFile`），
  内部统一 `await visit(...)` —— 同步函数也一样能用。

## CodeMirror 编辑器（分片，全插件唯一有构建步骤的一块）

编辑态默认是内置 `<textarea>`。语法高亮和多光标来自 **CodeMirror 6**，但它没法直接
`import` —— client 半边是经典 script，只能 `require` 宿主给的那几个固定模块，别的一律报错。

办法是**分片**：宿主支持 `require.async("./xxx.js")` 去取同一插件目录下的另一个 js 文件
（官方 `dsh-client-ui-sidebar-documentpreview` 就是这么把 pdf / excel 拆出去的）。

- `src/editor.js` 是分片源码，`npm run build:editor`（esbuild `--format=iife --minify`）
  打包成 `lib/client.editor.js`，**644 KB，按需加载**。
- 主文件这边：`useEffect` 里 `require.async("./client.editor.js")` 拿到 `mod`；
  再调 `mod.createEditor(host, { path, doc, line, onChange })`，返回
  `{ getValue, setValue, revealLine, focus, destroy }`。
- **`line` / `revealLine`（分片 0.2.0 加的）**：`line` 是打开时要落到的 **1 基行号**
  （0 / 缺省 = 停在开头），`revealLine` 是给已经挂着的实例挪光标。两者都只动 selection、
  不动 doc，所以「跳过去看一眼」不会触发 `onChange`（不该被记成一次编辑）。行号越界会夹到
  `[1, doc.lines]`，不抛。搜索命中跳行就靠它，见上面「搜索」一节。
- **改了 `src/editor.js` 就把 `VERSION` 也往上抬一格**：宿主按 `?rev=` 取分片文件，
  版本号不动时浏览器可能还在用旧缓存，而弹窗里显示的就是这个号。
- **主文件仍然是手写的**，改了刷新页面就生效；只有编辑器这一块要重跑 `npm run build:editor`。
- 拉不到分片（没打包 / 路径错）就退回 textarea，编辑本身不受影响 ——
  `editorMod.status === "error"` 时界面上会写一行原因。
- **实例生命周期得自己管**：CodeMirror 是命令式的，`editorViewRef` 里握着当前实例；
  换文件、切回选行视图、面板卸载，都要先 `destroy()`，否则会往同一个容器里叠 DOM。
  但**同一个文件里换落点别重建实例**（会丢滚动位置和撤销栈），调 `revealLine` 即可；
  `editorViewRef.current.caret` 记着已经跳到第几行 —— 这个判断不能省，否则每次
  `setSnippet`（打字时每个键都会触发）都会把光标拽回那一行。
- `CSS.editorHost` 必须是「高度确定的 flex 列」（`flex:1` + `minHeight:0` + `flexDirection:column`），
  因为 CM 用 `height: 100%` 撑满、内部自己滚。光给 `flex: 1` 它撑不开。
- 分片里用的是 `codemirror` 包的整个 `basicSetup`，再按扩展名叠
  javascript / typescript / html / css / json / markdown / python。
- **不要图省事把分片内联回主文件**：那样每改一次面板代码都得重新打包，等于把
  「改完刷新就生效」的手感换掉了。

## 面板内编辑文件

点**文件名**走的是官方预览器（只读，它没有写回接口）。要改内容有两条入口，最终都落到
`mode: "edit"` 的标签：

- 树里点「源码」→ 只读视图 → 工具条上的 **「编辑」**（进去后工具条上有 **「选行」** 切回只读）
- 文件行**右键 → 编辑**（直接开成编辑态）

编辑态默认是一个 `<textarea>`（`CSS.editor`：等宽、`flex: 1`，靠 `CSS.detail` 的
`flex-direction: column` 撑满），分片就绪后换成 CodeMirror。
**「写回」** 调 `projectWriteFile`，**Ctrl/Cmd+S** 等价（CM 的按键会冒泡到宿主容器，
所以两种编辑器共用同一个 `onKeyDown`）。

- `openShotTab` 对**已打开**的标签会 `Object.assign({}, copy[at], { mode, name })`，
  所以「编辑」对已经开着的只读标签同样生效，不会因为「反正开过了」而无动于衷。
- `saved` 是「盘上那份」的基准：`openLocal` 读回来时和 `content` 写成同一个值，
  新标签初始化成 `""`。按钮显示 `写回 •` 表示有改动还没存；写回**成功**才刷新基准，
  失败时标记不能消。

## 推送状态账本（低代码工程的已推 / 待推）

树里每个推送单元的**名字后面**挂一个徽章：`✔ 已推送`（绿）、`● 待推送`（橙）、
`✗ 定位不到`（红，缺 uuid / id，记不了账）。只有 host 扫描认得这个目录
（`pages` / `apis` / `databases` 区里带 `page.json` 或 `meta.json`）才显示 ——
**普通工程一个徽章都不出现**，`pushMap` 是空的，不打扰跟推送无关的项目。

徽章上那三个字是后加的：以前只有一个 `✔` / `●` / `✗`，符号的含义全靠悬停提示，
用户直接问「这些图标把对应的文字显示出来吧」。颜色留着 —— 扫一眼找橙色的那几行，
仍然是最快的用法。挨着它的校验计数也一并写成 `校验 ✗3`，免得跟推送状态那个 `✗`
混成一个东西（`pushbadge.mjs` 25 项专门钉这套渲染）。

### host 半边（4 个 RPC）

- `projectPushStatus(path)` → `{ nodes, projectUuid, projectNames, remote, targetLabel, scripts }`
- `projectMarkPushed(path, relDir, scope, target, noAncestors?)` —— 标记一个单元，**子孙一律跟着记**
  （推送 / 拉取都是整棵子树一起走的，见「推父目录，子页面也得记账」）。
  `noAncestors: true` 时**不刷祖先**（单个页面 / API 跑完自动记账用 —— 否则推一个子页面
  会把父目录也刷成已推送，父目录其实还是脏的）；不传就是老行为，祖先子孙一起刷
  （右键「标记已推送」的语义）
- `projectResyncPush(path, zone, project?)` —— **把某个 zone 下的记账整批删掉**，让下一次扫描
  按「首次见到即已推送」重新开张。给拉取类脚本跑完之后用（见「拉取跑完为什么要重记一遍」）
- `projectResetPushState(path?)` —— 带 `path` 只清这个工作区那批键（回 `dropped` / `kept`），
  不带才整份清空

节点形状：`{ key, scope, target, name, relPath, dir, status, aggregate, pushable }`，
`status` 只有 `"pushed"` / `"dirty"` 两个值。

**扫描边界**：只找 `pages` / `apis` / `databases` 三个区（`PUSH_FIND_MAX_DEPTH`），
找到才往下钻到 `PUSH_SCAN_MAX_DEPTH`，别的一律不下钻 —— 不设这道闸，一个
`node_modules` 就能把面板拖死。

**账本**存在 `~/.dsh/project-push-state.json`，内容是 `"<scope>:<target>" → { files, pushedAt }`，
`files` 是这个目录下所有文件的 `路径 → 大小 + mtime` 快照。`computePushStatus` 拿当前快照
跟账本比：一致 = 已推送；**账本里没这条 → 登记一次并当场算已推送**（首次扫描不报全脏）；
不一致 = 待推送。

#### 账本的键带工作区前缀（**后来改的，原先不分工作区**）

键是 `<归一化工作区根>|<scope>:<target>`，例如
`<工作区绝对路径>|page:afc7393…`。`pushKeyPrefix(root)` 造前缀，
`pushKeyOf(dir, prefix)` 拼键，节点上的 `scope` / `target` 单独留着。

**为什么改。** 用户在一个**全新目录**里 clone 下来一个项目，树里有的显示已推送、
有的显示待推送。根因是两条规则叠在一起：

- 原来的键是 `page:<page.json 的 uuid>` / `api:<meta.json 的 id>` —— **服务端的身份**，
  没有工作区、也没有路径参与。同一个项目在 A 目录里被面板扫过一次，在 B 目录里再拉
  一份，键是同一批。
- 首次见到记成已推送；**见过且时间戳对不上就是待推送**。新拉下来的文件 mtime 全是
  新的，于是「本该全新开局」的项目一进去就一片橙色。

现场核对（`<工作区>/5853ca14…`）：

| 单元 | 账本里的时间戳来自 | 原来 | 现在 |
| --- | --- | --- | --- |
| `apis/基础档案`（`api:9a59810c…`，145 个文件） | **本工作区**（145/145 一致） | ✔ 已推送 | ✔ 已推送 |
| `pages/产品建档`（36 个文件） | **另一个工作区 `localdev`**（36/36 全不一致） | ● 待推送 | ✔ 已推送（本工作区第一次见） |

`apis/基础档案` 之所以原本就是绿的，只是因为那个 uuid 那次才第一次见到 —— 同一套规则
的另一面。改完两边都从自己的第一眼开始算，代价是**同一个项目在两个目录里各记一份、
互不同步**（推过一个之后另一个还显示待推送）。用户明确要了这个取舍。

**坑：不要再拿 key 切冒号。** 节点构造原来写的是
`scope: key.slice(0, key.indexOf(":"))` / `target: key.slice(key.indexOf(":") + 1)`。
键里加了工作区根之后，Windows 的盘符 `C:` 会先把那个冒号撞上，切出来全是错的。
现在 `pushKeyOf` 直接回 `scope` / `target`，节点直接用它们。

**老键怎么办：不迁移、也不删。** 迁移需要知道每条记录属于哪个工作区，而那正是当初
丢掉的信息 —— 猜不出来。老格式的裸键（`page:<uuid>`）永远命不中，只是占几行；
`projectResetPushState` 按前缀清账时也不会碰它们（删老数据是另一件事）。

**重置的范围**：带 `path` 只清这个工作区那批键，回 `{ ok, scope: "workspace", dropped, kept }`；
不带 `path` 才整份清空，回 `{ ok, scope: "all", kept: 0 }`。界面上那句提示直接报出
清了几条（`resetPushState` 在 `runcallbacks.mjs` 里有 7 条断言）。

**聚合节点**：`pages/` 这种自己没 `page.json`、但底下有推送单元的目录，造一个
`aggregate: true` 的节点，状态由子孙决定。`markPushed` 对聚合写进去的键
（`aggregate:<rel>`）扫描时根本读不到，**但它会递归标记所有子孙** —— 子孙变已推，
聚合自然跟着变 `pushed`。所以聚合标记照样生效，只是绕了一层。

**聚合节点**：`pages/` 这种自己没 `page.json`、但底下有推送单元的目录，造一个
`aggregate: true` 的节点，状态由子孙决定。`markPushed` 对聚合写进去的键
（`aggregate:<rel>`）扫描时根本读不到，**但它会递归标记所有子孙** —— 子孙变已推，
聚合自然跟着变 `pushed`。所以聚合标记照样生效，只是绕了一层。

### client 半边

```js
const [pushMap, setPushMap] = useState(new Map());   // pathKey(绝对路径) → 节点
const [pushBusy, setPushBusy] = useState(false);
```

- `pathKey(value)` = 反斜杠折正斜杠 + 去尾斜杠 + 折小写。**必须有这一层**：host 用
  `node:path` 拼路径（Windows 下是 `\`），树里的 `entry.path` 是正斜杠，不归一永远查不到。
- `loadPushStatus(target)` 是**显式动作**，不做成每次展开目录都自动拉 —— 递归遍历 +
  逐文件 stat 在工程大了要几百毫秒。只在换工作区时自动来一次，之后靠右键菜单。
- 徽章挂在 `renderLevel` 里名字 span 之后、`flex spacer` 之前，靠
  `renderPushBadge(entry.path)` 按路径查表。
- 右键菜单：命中的**页面 / API 单元**先多两项「推送这个页面 / 拉取这个页面」（API 写
  「这个 API」，`databases` 底下的不给），下面才是「标记已推送」；空白处（= 工程根）是
  「刷新推送状态 / 重置推送状态」。
- `openMenu` 的钳位值跟着菜单变长调大了（`clientWidth - 168` / `clientHeight - 236`）：
  最长那份菜单有 8 项，贴底时得往上顶得更多，不然会被面板裁掉。
- `METHOD_PARAMS` 里这几个 RPC 的参数名**必须跟 host 的 `args.xxx` 对齐**
  （`projectPushStatus: ["path"]`、`projectMarkPushed: ["path", "relDir", "scope", "target", "noAncestors"]`、
  `projectResyncPush: ["path", "zone", "project"]`、`projectResetPushState: ["path"]`）——
  之前它们是占位，写的是 `dir`，host 读 `args.path`
  会拿到 `undefined`，报「缺少参数」。

#### 推 / 拉**单个**页面或 API（右键菜单里）

用户：「需要新增单个页面和api的推送和拉起」。

**脚本一行没改** —— 那四个脚本本来就吃单个目标，只是面板一直只喂 `-a`：

| 脚本 | 单个目标 | 全部 |
| --- | --- | --- |
| `source-page-push.js` | `argv[2]` = page uuid | `-a` |
| `source-page-pull.js` | `argv[2]` = page uuid | `-a` |
| `source-api-push.js` | `argv[2]` = api id | `-a` |
| `source-api-pull.js` | `argv[2]` = api id | `-a` |

于是要补的只有**面板这一侧**：把树上那个单元的 `target`（扫描时刚从 `page.json` 的
`uuid` / `meta.json` 的 `id` 读出来的）当成脚本第一个参数递下去。为了做到这点，
`projectPushStatus` 的回值多了四样东西：

- `scripts` —— 工作区根下现有哪些 `source-*.js`。**脚本不在就不摆入口**，点了必然
  `not-found`；只装了 push 脚本就只给「推送」。
- `remote` / `targetLabel` —— 外网地址下从菜单发起的运行同样要二次确认，而树这边
  原先只留了 `nodes`（`loadPushStatus` 把回值其余字段都丢了），所以多了一个 `pushInfo`
  state 专门存这几项。
- 每个节点多了 `zone`。**光看 `scope` 分不出区**：`databases` 底下的单元在账本里也是
  `api:<meta.json 的 id>` 键，但它归 `source-db-pull.js` 管，那个脚本吃的是项目 uuid、
  不是单元 id。`scanZone(dir, rel, depth, zone)` 就是为这个把区名一路带下去。
  菜单只在 `page+pages` / `api+apis` 两种组合上出现。

**外网地址的确认放在菜单里**，没有复用「脚本」页签那套 `runAsk`：`runAsk` 只有页签里
的卡片会渲染，从树里发起的话确认按钮根本没人画，点了就卡住。做法是给 `menu` 挂一个
可选的 `confirm: { node, mode, verb, noun, targetLabel }`，`renderMenu` 见到它就整份
换成一张确认屏（`menuNote` 那行说明 + 「确认推送 / 取消」两项）—— 菜单本来就是
`position: absolute` 的一块浮层，原地换内容不用另起一套状态。

运行起来后 `setView("run")` 切到「脚本」页签看输出（和 `runLint` 切「校验」页签同一
套先例）。有任务在跑时菜单项写「推送这个页面（有任务在跑）」，点了只给一句提示，
不排队 —— 和「同一时刻只留一个运行」的既有约定一致。

`startUnit` 这个 `useCallback` 必须放在 `const runRunning = …` **之后**：它的依赖数组
要读 `runRunning`，而 `const` 在依赖数组求值时就进 TDZ 了，放前面会直接
`ReferenceError`（`runcallbacks.mjs` 的「自由变量体检」不查这个，是跑起来才炸的）。

跑完之后的**记账**是后补的（第一版只重扫，用户报「单个页面推送和拉起后状态没有
刷新」）。`startUnit` 发起时把节点挂到 job 上（`unit: node` → `startRun` 透传成
`unit: item.unit ?? null`），`pollRun` 见到 `code === 0` 就 `markUnitPushed` ——
详见下一节。


### 什么时候重扫（徽章为什么会「不更新」）

徽章是**扫描那一刻**的结论，不重扫就永远不变。三条触发路径：

1. 换工作区（`dir` 变）—— 自动一次。
2. **面板内写回成功**（`saveShot`）—— 文件刚被改，不立刻重扫，徽章当场就是错的。
3. **切回「文件树」页签** —— AI 在会话里改的文件、外部编辑器改的文件，面板都没经手，
   只有这次重扫才知道账本已经过期。

外加右键菜单的「刷新推送状态 / 重置推送状态」当手动兜底。

#### 单个页面 / API 跑完，重扫是不够的 —— 得**记账**

用户报的「单个页面推送和拉起后状态没有刷新」就是因为只重扫。两条路都不通：

- **推送不改本地文件**，重扫拿到的快照跟账本里那份一模一样 → 徽章还是「待推送」。
- **拉取会改本地文件**，但原来的重扫条件是 `job.push === true`（`mode === "push"`），
  拉取根本不触发。

所以 `pollRun` 里跑完那一支改成：

```js
if (value.running !== true && value.killed !== true && runPushDoneRef.current !== job.runId) {
    const unit = job.unit === undefined ? null : job.unit;   // startUnit 发起时挂上的节点
    const zone = typeof job.syncZone === "string" ? job.syncZone : "";
    if (value.code === 0 && unit !== null) {                 // 只有真的成功才点绿
        runPushDoneRef.current = job.runId;
        await markUnitPushed(unit, job.push === true);       // 记账（推 / 拉都记）
    } else if (value.code === 0 && zone !== "") {
        runPushDoneRef.current = job.runId;
        await resyncPush(zone, job.project);                 // 拉取类脚本：整片重记
    } else if (job.push === true) {                          // 普通推送 / 失败 / 非单单元
        runPushDoneRef.current = job.runId;
        void loadPushStatus(String(dir ?? ""));
    }
}
```

`markUnitPushed(node, wasPush)` 调 `projectMarkPushed(root, relDir, scope, target, noAncestors=true)`
再 `loadPushStatus(dir)` 重扫一遍，并给一句「推送完成 / 拉取完成 —— <名字>」（失败时
说「跑完了，但状态没记上」，不重扫）。

#### 推父目录，子页面也得记账（用户报的问题 2）

用户报的第二个问题：「我在父页面那边执行推送页面把子页面推送了，子页面的状态还是待推送，
实际上是已经推了的」。

机理在脚本里：`scaffold/source-page-push.js` 的头注写着 `page-uuid - 页面 UUID 或目录 UUID /
如果是目录 UUID，则推送该目录及目录下的所有页面 / 如果是页面 UUID，则只推送该页面` ——
面板右键「推送这个页面」传的是**目录 uuid**，脚本 `:373-406` 的 `copyAllPages` 会把
**整棵子树**推上去。

原来的 `only: true` 把**祖先和子孙一起关掉**了。这就关错了：

- **祖先该关**：推一个子页面并没有把父页面的内容推上去，把父目录点绿是撒谎；
- **子孙不该关**：脚本明明把子孙一起推了，子孙还留着橙点就是漏记账。

所以参数改名成 `noAncestors`，语义收窄成「只护住祖先」：

```js
if (noAncestors !== true) { /* 祖先那一圈照旧刷 */ }
await markDescendants(selfDir);   // 无条件：子孙本来就被推上去了
```

- 右键「标记已推送」→ 不带 `noAncestors`，祖先子孙一起刷；
- 单页 / 单接口跑完自动记账 → `noAncestors: true`，只护祖先。

界面上的表现：推完 `产品信息建档(新)`，它自己变绿，**它下面**的也一起变绿，
父目录 `产品建档` 还是橙的。

#### 拉取跑完为什么要重记一遍（用户报的问题 1）

用户报的第一个问题：「我在本地把这个项目删了后重新从服务器上拉下来，结果这边的状态
全部变成待推送了」。

账本记的是**本地文件的 mtime**（`computePushStatus(state, key, current)` 比对每个文件的
mtime；首次见到的键登记成已推送）。重新 clone / pull 下来的文件，内容跟服务器一模一样，
但 **mtime 全是新的** → 全部判成脏。

这个判据本身没错（mtime 是最便宜的「自上次推送后动过没有」代理），错的是**没人告诉账本
「这一片刚刚跟服务器对齐了」**。所以给拉取类脚本在 `RUN_CATALOG` 里标一个 `syncZone`：

| 脚本 | `syncZone` |
| --- | --- |
| `source-api-pull.js` | `"apis"` |
| `source-page-pull.js` | `"pages"` |
| `source-db-pull.js` | `"databases"` |
| `source-clone.js` | `"*"`（整个项目） |

`projectListScripts` 把这个字段一并回给 client；跑完且 `code === 0` 就
`resyncPush(zone, project)` → host 的 `projectResyncPush` 把 `<root>/<project>/<zone>/…`
那一批键**删掉**，下一次扫描按「首次见到即已推送」重新开张。

- **只删，不直接写「已推送」**：写需要伪造一份 mtime 清单，删掉让扫描自己登记更诚实，
  也顺带把已经不在磁盘上的陈旧键一起清掉。
- **范围必须是 zone**：整个工作区重记会把**没拉过的**那部分也点绿（比如只拉了 pages，
  本地改过的 api 就被洗白了）。`zone: "*"` 只有 clone 用。
- `project` 取自脚本任务（`item.project === true ? picked : ""`），空则回落 `.env` 的
  `PROJECT_UUID` —— 拉取脚本自己也是读那个，两边一致。

**每次重扫都连校验一起重算**（走 mtime 缓存，只有被改过的单元才真算），所以徽章上
的红框会跟着变。写回那一步另外还会用 `lintUnitOf()` 单独重算被写文件所属的那一个
单元 —— 见「徽章上的校验计数」节。

**`computePushStatus` 的语义很关键**（`lib/index.js:234`）：账本里没记录 → 登记当前
快照并算「已推送」（`changed: true`，所以首次扫描不会满树橙点）；**有记录但不一致 →
只返回 `dirty`，绝不改账本**。这一条不能动：一旦它顺手把新快照写回去，
「待推送」就永远显示不出来。快照存的是 `Math.round(mtimeMs)`，所以文件只要被写过
（哪怕长度一字不差）就会翻成 dirty。

## 推送前静态校验（`projectLint`）

照着原版插件 `_ref/gitee-dsh/plugins/dsh-desktop-project/lib/index.js:729-827` 搬的，
规则是魔改低代码平台 V1.01~V1.06 踩过的坑。**host 只读，不执行任何工程代码**：
JS 那几条拿 `new Function` 只做语法解析（`syntaxErrorOf`），其余全是文本匹配。

`projectLint(path)` → `{ dir, kind: "page"|"api", issues }`，每条 issue
`{ level: "error"|"warn", file, path, rule, message, line }`。**`path` 是 host 拼好的
绝对路径**，client 点一条就能直接 `openGrepHit` 打开文件跳到那一行，不用自己拼路径。
`line` 找不到给 0（面板里就只显示文件名）。`issues` 出来前已经排过序：错误在前，
同级按文件、再按行号 —— 面板从上往下读就是修复顺序。

目录既没 `page.json` 也没 `meta.json` → 抛 `not-a-page-or-api`。**这条是应用层错误、
不是「没问题」**，client 会把它当「校验没跑起来」显示在页签里。

**页面分支**（11 条）：`json-invalid` / `uuid-missing`（page.json）、`no-scene` /
`bare-mustache` / `attr-mustache`（index.html）、`js-syntax` / `no-myMethod` /
`no-merge-loop` / `sys-zone-modified` / `api-url`（page.js）、`css-brace`（page.css）。
**API 分支**（5 条）：`json-invalid` / `id-missing`（meta.json）、`js-syntax` /
`number-strict` / `no-return`（script.js）。

### 三处和原版不一样的地方

- **`bare-mustache` 的判据收紧了一大截，级别也从 error 降到 warn**。原版是
  「文本节点里出现 `{{}}` 就报 error，让你加 v-pre」——这在真实项目里会**成片误报**，
  而且照着改会把页面弄坏。平台设计器生成的列表页长这样：

  ```html
  <div class="card" v-for="(item,index) in maintenance" :key="item.id">
      <h3>{{item.deviceName}}</h3>
      <van-tag>{{item.status}}</van-tag>
  </div>
  ```

  `item` 是 `v-for` 的循环变量，`maintenance` 就在 `page.js` 的 `var myData={…}` 里，
  这些 `{{}}` **本来就是想让 Vue 渲染的**。加 `v-pre`（= 这棵子树别编译）会让页面上
  原样印出 `{{item.deviceName}}`，功能直接废掉。所以现在要满足**全部**下面几条才提一句：

  1. 不在 `v-pre` 子树里（`vPreRanges()`）；
  2. `{{}}` 的**根标识符**（`mustacheRoot()`，最靠左那个）不在当前作用域里 ——
     作用域由 `vForScopes()` 扫出来，包含两类名字：
     - `v-for` 的循环变量（`forAliases()`，支持 `(item,index) in list`）；
     - **插槽作用域变量**（`slotAliases()`）：`<template #option="scope">`、
       `v-slot:default="{ row }"`、老写法 `slot-scope="scope"` 都会往子树里带名字。
       组件库的表格 / 下拉框几乎全靠这个（`{{scope.row.name}}`、`{{scope.label}}`），
       不认它就会把整片模板报成「找不到定义」—— 这一步是**第二波误报**教会我的。
  3. 不以 `$` 开头（`$route`、`$magicaltool` 这类运行时对象）；
  4. 这个标识符在 `page.js` 里**根本没出现过**（词边界正则）。
     因此 `page.js` **提前到 `index.html` 之前读**（`const js = await readOpt(…)`，
     下面 page.js 那一段继续复用它，别再声明一次）。

  全都躲过了才报，而且是 **warn**：那种情况更像名字写错了，而不是缺 v-pre，
  措辞也改成「只有本意要显示字面量时才需要加 v-pre」。

- **`bare-mustache` 会跳过 `v-pre` 子树**（`vPreRanges()`）。原版正则
  `/>[^<]*\{\{[^}]*\}\}[^<]*</g` 只看有没有 `{{}}`，于是消息说「应加 v-pre」、
  加了 v-pre 却照样报 —— 自相矛盾。host 侧没有 DOM，这里手工压栈扫标签，
  `v-pre` 状态沿栈向下继承；自闭合标签不压栈。**`attr-mustache` 不跳**：
  `v-pre` 只管文本插值，属性上的 `{{}}` 该编译错还是编译错。
- **每条 issue 多带一个 `path`**（原版只有相对 `file`）。

### 教训：照搬正则之前先拿真实项目扫一遍

上面这条规则是**第一版照着原版写完、fixture 全绿之后才发现错的** —— 一上真实项目
就是成片的假阳性。所以每次动 lint 规则都要跑一遍 `_dbg/lintprobe/sweep.mjs`：
它递归找出 `localdev` 下所有含 `page.json` / `meta.json` 的目录（当前 **48 个**），
逐个真跑 `projectLint` 并统计每条规则的命中数。**48 个目录、零命中**是现在的基线；
哪天改完突然冒出几十条同一条规则，那基本是新引入的误报，不是项目真的坏了。

同样值得记住的是误报的**代价方向**：lint 说「应加 v-pre」，人会真去加，
而 v-pre 会让页面印出字面量 —— **误报在这里等于「照着修就把页面修坏」，
比漏报危险得多**，所以判据宁可放宽。真的漏了，人自己会看见页面不对；
误报一次，人可能就把好好的页面改坏了。

几个常量：`BARE_MUSTACHE_MAX = 5`（html 两类各最多报 5 条）、
`NUMBER_STRICT_MAX = 3`。`readOpt()` 读不到文件返回 `null` —— **lint 里「文件缺席」
不是错误，跳过即可**。

### client 半边

- state：`lint`（`null` = 这次会话没校验过 / `{dir,kind,issues}` / `{dir,issues:[],failed}`）、
  `lintBusy`。`runLint(target)` 跑完顺手 `setView("lint")`。
- 入口：**目录**的右键菜单「推送前校验」（文件上不给这一项 —— 只有目录才可能带
  `page.json` / `meta.json`）。空白处也不给。
- 页签「校验」，标题 `lintTabTitle()` 把错误/警告数摊开（`校验 2✗ 3!`、`校验 ✓`、
  `校验 ×`）。**`lint === null` 时页签是 disabled + 半透明**：空白页签比灰着更让人困惑。
- `renderLint()`：一条一行，`错误/警告` 徽章 + `文件:行` + `rule` + `message`，
  整行可点 → `openGrepHit({ path: issue.path, name: issue.file, kind: "file" }, issue.line)`。
- 换工作区的 effect 里 `setLint(null)` 并把 `view` 从 `"lint"` 退回 `"tree"`；
  `renderLint` 里另有 `stale` 判断（结果目录**已经不在当前工作区里**时提示
  「（属于另一个工作区）」）。

  这个 `stale` 判据踩过一次坑：最早写的是
  `pathKey(result.dir) !== pathKey(dir)` —— 拿「校验的那个目录」和「工作区根」
  **比相等**。但右键校验的绝大多数时候是在**子目录**上（`pages/DEMO/...`），
  子目录本来就不等于根，于是**每校验一次子目录都会多出一句「属于另一个工作区」**。
  要的是「还在不在这棵树里」，不是「等不等于根」，所以改成
  `isUnder(String(result.dir), dir) !== true`（`isUnder` 在 `lib/client.js:299`，
  `child === parent` 或落在其下都算）。教训：**判「同一个工作区」永远用「包含」，
  别用「相等」** —— 面板里所有的基准都是工作区根，而用户操作的对象几乎从来不是根。

### 验证手法（值得复用）

`_dbg/lintprobe/probe.mjs`：把 `lib/index.js` **复制一份，只把 `const HANDLERS = {`
改成 `export const HANDLERS = {`**，然后 `import` 真模块、传假 ctx
（`{ get: (k) => k === "workspaceRegistry" ? { list: () => [{ path: fixture }] } : undefined }`）
直接调 `HANDLERS.projectLint`。比把函数体抠出来求值靠谱得多 —— 依赖太多。
fixture 覆盖 `page`（踩满坑）/ `api` / `clean`（**必须零问题**）/ `nothing`（抛错）。
跑完删掉那份 patched 副本。

改账本的探针还要**先把 `process.env.DSH_HOME` 指到临时目录再 `import`** ——
`PUSH_STATE_FILE` 是模块加载时算出来的，设晚了就写到真账本上了。

| 探针 | 管什么 |
| --- | --- |
| `probe.mjs` | 规则回归：四条 fixture 的命中数与基线逐条对齐（改规则必跑） |
| `status.mjs` | 扫描带校验 + mtime 缓存：冷缓存算满、第二次全命中、失效后重算 |
| `writeback.mjs` | 写回只重算所属单元；写在单元外返回 `null` 且不污染缓存 |
| `realscan.mjs` | 真项目计时（冷 / 热）与已校验单元数 |
| `tally.mjs` | 真项目逐条规则的命中数（找噪音源用） |
| `profile.mjs` | 把扫描拆成四个阶段分别计时（找瓶颈用） |
| `gate.mjs` | 给 `lintCached` 开闸，对比「带校验 / 不带校验」的扫描耗时 |
| `badge.mjs` | 真项目上重放 `badIssuesOf`，并对比「校验页签那一行」新旧两种路径基准 |
| `editorref.mjs` | 从 `lib/client.js` 原文抠出回调 ref，用假 React 跑编辑器挂载/卸载/重建 |
| `clientcss.mjs` | 把 `const CSS = { … }` 抠出来配平，查悬空引用 / 重复键 / 死键（纯静态，最快） |
| `scriptsui.mjs` | 从 `lib/client.js` 原文抠出 `renderScripts`，喂假 `h`，按状态断言脚本页签渲染、下拉与点击（166 项） |
| `runcallbacks.mjs` | 抠出十二个回调，喂记账版 `call` / `setState` 跑行为，外加一项「自由变量都在 `PARAMS` 里」的静态体检（147 项） |
| `runscript.mjs` | 四个脚本 RPC：白名单、二次确认（外网推拉都拦、本机全放行）、增量轮询、停止、输出截断（60 项） |
| `pushbadge.mjs` | 从 `lib/client.js` 抠出 `renderPushBadge`，断言三种推送状态各自显示哪几个字、底色、悬停提示，以及校验计数并排那一块（25 项） |
| `treemenu.mjs` | 抠出 `renderMenu` + `pathKey` / `relativeUnder` / `parentOf` 三个真身，断言四种菜单各有哪些项、「引用 / 查看源码」点下去调谁，以及单单元推拉的入口与菜单内的二次确认（51 项） |
| `pushscope.mjs` | 推送账本按工作区隔离：同一个 uuid 在两个工作区里各自开张、改一个不动另一个、标记与重置都只落在自己那份、老格式裸键既不命中也不被误删；外加扫描回值里 `zone` / `scripts` / `remote` / `targetLabel` 四项，以及「只记一个单元」那个参数（当时叫 `only`，后来改名 `noAncestors`），49 项 |
| `scanargs.mjs` | 真项目根下每个 `source-*.js` 收什么参数（读脚本源码得出的对照表） |
| `envdump.mjs` | 真 `.env` 逐行带行号打印，凭据只报长度（看排版用） |
| `envparse.mjs` | `parseEnvText` / `splitHost` / `isRemoteUrl` / `labelOfUrl` 四个纯函数 + 真 `.env` 的解析结果（带 `.env` 路径跑 81 项，不带给 65 项） |
| `envload.mjs` | 把工作区四个脚本里的 `loadEnv` 原文抠进 `vm`，带假系统环境跑，看 `.env` 有没有赢过 `USERNAME`（22 项） |
| `loginlive.mjs` | 真机跑一次 curl 登录（只登录不推送），验证 `--data-binary @-` + `execSync` 的 `input` 真能送进 body，并带一个空 body 的对照 |

---

## 徽章上的校验计数：扫描带校验，但快了十倍

树的徽章要能一眼看出「哪个单元推上去会挂」，所以 `projectPushStatus` 顺手把每个
单元的校验结果一起返回（`lintCached`，带 mtime 缓存）。

第一版这么干的时候**慢到不能用**，一度把校验从扫描里摘了出去（只留「保存」和右键
手动两条路）。后来把开销真正压下来，校验又放回了扫描里 —— 结论是**能带着跑，但必须
按下面这三条改写，否则就是八秒**。

### 一、慢在哪：分阶段量出来的数字

真项目（`<真实低代码工程>`，2190 个节点 / 2179 个单元 / 12193 个文件）
一开始的分阶段开销：

| 阶段 | 耗时 | 量 |
| --- | --- | --- |
| 找 `pages`/`apis`/`databases` 区 | 35 ms | 12 个区 |
| 递归 `readdir` | 221 ms | 2212 个目录 |
| `pushKeyOf`（每目录最多 2 次读+parse） | 651 ms | 2179 个带键目录 |
| `snapshotDir`（每个单元递归 stat） | 1411 ms | 12193 个文件 |
| **lint 读文件 + 跑规则** | **3033 ms** | 每单元最多 6 个候选文件 |

关键发现：**mtime 缓存救不了它**。打点确认第二轮 `lintDir` 调用数已经是 0（缓存全中），
但耗时几乎没降 —— 因为省掉的只是「跑规则」，**读文件本身每次都得重来**。所以问题不在
缓存做得够不够好，在于这些 fs 调用**全是串行 await**。

### 二、三个改动

1. **并发闸门 `limiter(max)` / `scanSlot`（`SCAN_LIMIT = 16`）。**
   串行 await 一次只放一个请求进 libuv 线程池（默认 4 个工作线程），线程池大半时间
   是闲的。包一层就能喂饱它。

   **踩点：绝不能拿它包住整个递归调用。** 父调用握着名额等子调用，名额一耗尽就
   死锁 —— 递归本身用 `Promise.all` 铺开，名额只发给真正做 I/O 的那几小段
   （`readdir` / `stat` / `pushKeyOf` / `hasManifest` / `lintDir`）。
   `snapshotOf` 内部也一样：先收集，`Promise.all` 并发 stat，再并发下钻子目录。

2. **`snapshotOf` 顺手把「这一层有哪些文件」捞出来（`names`）。**
   这次 `readdir` 本来就要做，把直接子项的名字留下来，交给 `lintDir(resolved, soft, names)`
   —— 它就不再盲读「page.css 在不在」这种问题。每个单元最多 6 个候选文件、大半不存在，
   那些 ENOENT 是校验里最贵的一项（Windows 上还叠加杀软）。`names === null` 时退回盲读，
   语义不变，所以探针里单独调 `lintDir` 照样能用。

3. **lint 结果照旧按 `stampKey(snapshot.files)` 缓存**，没被碰过的单元不重算。

### 三、改完的数字

| 轮次 | 改前 | 改后 |
| --- | --- | --- |
| 第 1 次（冷缓存，真算 2179 个单元） | 7710 ms | **1354 ms** |
| 第 2 次（全部命中缓存） | 5363 ms | **498 ms** |
| 第 3 次 | 5286 ms | **490 ms** |

带着全量校验也比以前纯扫描快。所以**校验留在了扫描里**：打开面板、换工作区、写回之后
重扫，徽章都是齐的，不需要用户先点一次什么。

写回那一步另外还走 `lintUnitOf(file, root)`：从被写的文件往上找所属单元单独重算
（写回只可能影响那一个）。这是锦上添花，不是主路径了。

### 四、徽章只标错误，不标警告

同一轮量出来的规则命中（2179 个单元）：

| 命中数 | 规则 | 说明 |
| --- | --- | --- |
| **1236** | `warn no-return` | 平台容忍 `return '成功'` 这种非对象返回；本项目 57% 的 API 脚本中招 |
| 17 | `error js-syntax` | 真语法错误 |
| 5 | `warn bare-mustache` | 其中 `{{ parseIntNum(scope.row.stockNum) }}` 是漏报：根标识符是全局帮助函数 |
| 3 | `warn api-url` | |
| 3 | `error css-brace` | 真错误 |

1236 / 1264 条警告来自一条规则，**把警告标到徽章上等于给 1253 个目录挂黄标**，
比不标还糟。所以徽章只数 `error`：这个项目里正好亮 **20 个红徽章**（17 个
`js-syntax` + 3 个 `css-brace`），每一个都值得看。警告留在「校验」页签。

判断依据是**「这个数字能不能让人采取行动」**，不是「规则对不对」：`no-return` 作为
一句提示没错，但它不适合当徽章信号。真项目上一量就知道该不该上徽章 —— 这也是
`sweep.mjs` / `tally.mjs` 存在的理由。

## 徽章上的 ✗N 点得动了：从「有个错误」到「哪个文件」

徽章只报数量是不够的。用户截图 `…/apis ✔ ✗1` 的反馈是「这样子一个X我也不知道你哪个
文件有问题」—— 数字本身不构成可行动的信息，**必须能一路点到那一行**。

### 一、host 侧：把错误明细挂在树上（`lib/index.js`）

- `MAX_NODE_ISSUES = 20`、`MAX_TOTAL_ISSUES = 800`：单节点最多带 20 条、整个响应最多
  800 条。真项目现在只有 20 条，但烂工程不能让它把响应吹爆。
- `errorIssuesOf(lint)`：只筛 `level === "error"`，**不带警告**。理由见上一节 ——
  1236 条 `no-return` 会把真问题埋掉，也会让响应多出几百 KB。空数组返回 `null`。
- `projectPushStatus` 里按请求建一个 `issueBudget`，`attachIssues(node, lint)` 从预算里
  取 `Math.min(MAX_NODE_ISSUES, issueBudget)` 条挂到 `node.issues`。
- **聚合节点刻意不挂明细**：它的 `errors` 是子孙之和，每个子孙已经各带一份，再抄一遍
  就是重复计数。client 侧自己去子孙里收（见下）。

### 二、client 侧：悬停看清单，点击跳校验（`lib/client.js`）

| 函数 | 干什么 |
| --- | --- |
| `badIssuesOf(node)` | 单元节点直接读 `node.issues`；聚合节点遍历 `pushMap.values()`，用 `isUnder(item.dir, node.dir)` 收子孙的明细 |
| `badIssuesTitle(node, issues)` | 悬停 tooltip：首行报总数，随后最多 10 行 `相对路径:行号 规则名`，超出补「…还有 K 条」，末尾「点一下看明细」 |
| `openBadIssues(node)` | 有明细就 `setLint({ …, from: "badge" })` 并切到「校验」页签；没有则退回 `runLint()` 跑一次完整校验 |

`✗N` 现在是个可点的 `span`（`cursor: pointer`），`onClick` 里 `event.stopPropagation()`
—— 否则点徽章会顺带把树行展开/收起。`renderLint` 认 `result.from === "badge"`：
文件那一格显示相对路径（截断 + `title` 给全路径），摘要写「N 个错误 —— 只列错误，
点一行打开出问题的文件」，并且 `lintTabTitle()` 改用 `lint.errors` / `lint.warns`
而不是现数 `issues`，否则警告数会被算成 0。

### 三、验证（`_dbg/lintprobe/`）

- `probe.mjs` 规则回归、`status.mjs` 缓存回归：与基线逐条一致。
- `realscan.mjs` 新增统计：真项目 **冷 1491 ms、热 575 / 554 ms**，2190 节点、
  2179 已校验、**20 个节点带明细、合计 20 条**（17 `js-syntax` + 3 `css-brace`）、
  响应 1021 KB。
- **新增 `badge.mjs`**：把 client 的 `badIssuesOf` 在真项目上重放。缺 `path`/`rule`
  的明细 = 0；**聚合节点「徽章上的数字 vs 点开能看到的条数」全部相等**：
  `4ac34c…/apis 1=1`、`db18c4…/apis 16=16`、`db18c4…/pages 3=3`。
- 用户截图里那个 ✗1 = `4ac34caae0da4844ac5ecf716ba9d15f/apis/ANDON/ANDON移动端/ANDON待处理/取消报警/script.js`。

### 四、遗留：语法错误没有行号

`js-syntax` / `css-brace` 的 `line` 一直是 0，点进去只能从文件头看。原因：
`syntaxErrorOf` 用 `new Function(text)` 只问「能不能编译」，而 V8 对 `new Function`
的编译错误**完全不给行号**（`e.stack` 只有 `at new Function (<anonymous>)`）。

试过换 `new vm.Script("function __l() {\n" + text + "\n}")`：`e.stack` 首行
`evalmachine.<anonymous>:N` 里的 N 对**中间行**的硬错确实等于源文本行号（钉死案例：
文本第 2 行少分号 → N=2），但对「缺右花括号」「多一个右花括号」这类会指到 EOF 或
包装行的位置（多出 2 行），得 `clamp` 到文本行数才勉强可用。

**没做**：要新增 `node:vm` import、要处理上述偏移、还得保证包装语义与 `new Function`
一致（平台脚本惯例是顶层 `return { ... }`，必须包在函数体里才不会误报
Illegal return statement）。收益（20 条里 17 条能定位到行）不抵这份耦合，
先记在这里。

---

## 点开 ✗N 之后：路径看不懂、源码页签还白屏

用户报的两个问题，其实是同一次操作的两步：先在「校验」页签看到一行
`4ac34c…/apis/ANDON/A… | js-syntax | JS 语法错误：missing ) after argument list`，
点它跳到「源码」页签之后**整片空白** —— 没有代码、没有报错、也没有退回文本框。

### 一、路径的基准取错了

`renderLint` 里那一行写的是 `relativeUnder(dir, entry.path)`，而 `dir` 是**工作区根**
的 state。四个 L1 项目目录前面全是同一串 32 位 uuid，于是每条明细都从 uuid 开始，
前端再截到 300px，剩下的信息量恰好是零。

基准该是**这次校验的那个目录**（`result.dir`；从徽章点进来时它就是那个节点自己的
目录）。换过之后：单元节点的明细显示成 `script.js`，聚合节点（`apis` / `pages`）
显示成 `ANDON/ANDON移动端/ANDON待处理/取消报警/script.js`。悬停提示
`badIssuesTitle` 里同一个错一并改了（那里用 `node.dir`）。

单元格顺带放宽：`maxWidth` 300 → 420，并改成 `flex: 0 1 auto` + `minWidth: 0`，
挤的时候才收缩，不再一上来就硬截。

### 二、白屏：编辑器实例的生命周期挂错了地方

CodeMirror 是命令式的。原来的做法是 `useRef` 存容器 + `useEffect`（依赖
`[snippet, editorMod, setSnippet]`）去建实例，**漏了一整个场景**：

- 面板正文是 `view === "code" ? renderDetail() : null`，切走页签时容器**整个从 DOM 上卸掉**；
- 可那个 effect 的依赖（`snippet` / `editorMod`）一个都没变，它**一次都不跑** ——
  旧实例既没销毁，`editorViewRef.current` 也仍然指着它；
- 切回来时 React 挂上一个**全新的空容器**，而 effect 就算跑了也会被
  `editorViewRef.current !== null` 挡回去，于是一个 `createEditor` 都不会发，
  容器就永远空着。

用户的路径正好踩满：先开过 `script.js`（实例已建）→ 切到「校验」→ 点那一行
（`openLocal` 看到标签已经是 `ready`，不再重读，只切视图）→ 白屏。

改成**回调 ref**：实例的生死跟着容器的挂载/卸载走，不存在「DOM 没了实例还在」的空档。
配套两点：

- 容器 `key` 用 `snippet.path` —— 换文件时让 React 换整个节点，回调 ref 自己会先
  销毁旧的、再按新文件建一个，不必再手写「路径变了要重建」；
- 回调 ref 的身份必须稳定（`useCallback(…, [])`），否则每渲染一次就 ref(null) →
  ref(节点)，等于每帧重建编辑器，撤销栈和滚动位置全丢。最新的 `snippet` /
  `editorMod` 经 `snippetRef` / `editorModRef` 转发进去。

原来的大 effect 缩成只干一件事：**同一个文件里又点了一条命中行**，不重建
（那会丢滚动位置和撤销栈），只 `revealLine` 把光标挪过去。

React 在同一个 commit 里换 keyed 节点时是**先 detach 旧 ref、再 attach 新 ref**
（mutation 阶段处理删除，layout 阶段挂新的），所以回调 ref 开头那句无条件的
「有旧实例就先销毁」是安全的。

### 三、验证

- `node --check lib/index.js` / `lib/client.js` 通过。
- **新增 `editorref.mjs`**：把 `lib/client.js` 里那段回调 ref **原文抠出来**
  （正则取 `const editorHostRef = useCallback(…` 整条语句、剥掉 `useCallback` 外壳），
  喂上假的 React 依赖跑 15 项断言 —— 测的是**发出去的那段代码**，不是照抄一份实现。
  第 3 项就是白屏那个场景：卸载后重新挂载**必须**再调一次 `createEditor`；
  另覆盖直接换文件（`destroy` 一次 + 按新文件建）、没有标签 / 分片没就绪 /「选行」
  视图都不该建、`onChange` 仍把内容写回标签。全部通过。
- `badge.mjs` 加了新旧基准的对比打印：真项目上逐条核过，**新基准下最长一条 42 字符、
  全部落在基准之下**；旧基准下每条都 60–80 字符，全从 uuid 开头。
- 规则回归（`probe.mjs`）与缓存回归（`status.mjs`）未受影响。

---

## 「脚本」页签：在面板里跑推送 / 拉取脚本

低代码工程的推送、拉取、克隆全靠工程**根目录**下那几个 `source-*.js`，
原来只能自己开个终端敲 `node source-push.js`。这一节把它搬进面板。

### 一、四个 RPC（host）

| RPC | 干什么 |
| --- | --- |
| `projectListScripts` | 列工作区根下的 `source-*.js`，顺带把 `.env` 的 `SERVER_URL` 读出来 |
| `projectRunScript` | 起一个脚本，**立刻**返回 `runId`（不等它跑完） |
| `projectRunScriptPoll` | 取 `since` 之后的新输出，外加 `running` / `code` |
| `projectRunScriptStop` | 停掉，win32 上连子孙进程一起杀 |

**为什么拆成「起 + 轮询」**：推送整个项目要好几分钟，同步等就意味着那个 HTTP
请求一路被占着，中间什么也做不了、断了还看不出来。拆开之后面板能一边跑一边把
输出流出来，还能刷出一个「停止」。

**`killTree`**：`source-push.js` 自己是用 `execSync` 去调 `source-api-push.js` /
`source-page-push.js` 的，真正干活的是**孙子进程**。Windows 上只 `child.kill()`
会留下一个还在推的孤儿，所以走 `taskkill /pid <pid> /T /F`（`/T` = 连子孙）。
其它平台仍旧 `child.kill()`。

**`.temp_*_push_*` 要先清掉**：那批脚本在根目录下用临时目录拼请求体，上一次失败
留下的残骸会让这一次读错。这点和原版一致。

**白名单 + 必须在根目录**：`/^source-[a-z0-9-]+\.js$/`，而且
`dirname(resolve(root, script)) === root` —— 不允许 `../`、不允许塞进子目录、
也不允许 `utils.js`（它虽然是根下的 .js，但不是入口）。`cwd` 本身还得在注册工作区内。

### 二、外网地址挡一道（`needs-confirm`）

> 判据改过两次：第一版看 `.env` 的 `ENV === "server"`；第二版换成「真实地址是不是外网」，
> 但只拦 push 类；第三版（现在）**推和拉一视同仁** —— 见下面「拉取为什么也要拦」。

这一关真正的风险是 **stdin**：面板里没有交互终端，脚本若在等输入就会永远挂住。
（`source-push.js` 早先 `ENV=server` 时会 readline 问一句「确认发布?」，那一整段现在
已删 —— 确认交给面板做，理由见后文。）所以：

- `projectListScripts` 把 `.env` 读一遍，算出 `serverUrl` / `remote` / `targetLabel`，
  以及每个脚本的 `needsConfirm`（**就是 `remote`**，不分推拉）；
- 目标地址是外网 → `projectRunScript` 不带 `confirm: true` 一律用
  `PanelError("needs-confirm", …)` 拒掉；
- 带 `confirm: true` 时，host 起完进程仍会**主动 `child.stdin.write("yes\n")` 再
  `end()`** —— 现在没有任何脚本会问，这一手留着是给**平台将来下发的新版脚本**兜底：
  只要它敢在等输入，面板就会替用户答一句然后把 stdin 关掉，绝不挂死。

界面上对应「两次点击」：目标不是本机时**每张卡的按钮**都先变成「确认运行 / 取消」，
点确认才带着 `confirm` 重来一次。**两边都拦**是有意的 —— 「连到外面」不该是一次误点
就能发生的事。本机地址下一个都不问，一次点击就跑（本地反复调试不该被拦）。

#### 拉取为什么也要拦

用户一句话点破：「拉取和推送一样需要二次确认」。原来的判据是
`remote && mode === "push"`，等于放过了更该问一声的那一半 —— 拉取看着「只是把东西
取回来」，实际是**拿服务器上的状态覆盖本地文件**（`source-page-pull.js` /
`source-api-pull.js` / `source-db-pull.js` 都会写盘，`source-clone.js` 更是一路建目录）。
破坏性和推送一个级别，而且它读的是别的机器，本地有什么它不管。

改动只有把那个 `&& mode === "push"` 删掉，三处一起：

| 位置 | 改动 |
| --- | --- |
| `lib/index.js` `projectListScripts` | `needsConfirm: remote && mode === "push"` → `needsConfirm: remote` |
| `lib/index.js` `projectRunScript` | `const needsConfirm = remote && preset !== undefined && preset.mode === "push";` → `const needsConfirm = remote;`（`preset` 随之没了别的用途，删掉） |
| `lib/client.js` `card()` | `const danger = remote === true && item.mode === "push";` → `const danger = remote === true;` |

`mode` 字段**保留**：它不再参与「要不要确认」，但 client 仍拿它认「这次跑的是不是推送」，
好在跑完之后决定要不要重扫推送状态（`startRun` 里的 `push: item.mode === "push"`）。

`danger` 是「这次点下去会弹确认」的唯一开关，所以**配色必须跟着它一起变**：外网地址下
7 张卡的「运行」按钮全部套红。要确认的按钮和不确认的长得一样，用户只会被突然冒出来的
确认框绊一下。

### 三、客户端

第 4 个页签，取值 `view === "run"`。清单**进了页签才去读**（不进就不麻烦 host），
换工作区时清空，由页签里那个 effect 重新拉。

轮询：`setInterval` 每 500ms 调一次 `projectRunScriptPoll`，**只取增量**拼到 `log`
上（整份重传的话，日志几万字会越传越大）。运行中给「停止」，跑完换成「清空」并显示
退出码；输出超 400000 字符被截断时写「输出超限，已终止」。

**推送跑完会自动重扫一次推送状态**：推送会动到本地文件，树里那些 ✔ 已经不作数了。
只对这一次 `runId` 做一遍（`runPushDoneRef`），否则每轮轮询都会重扫。

### 四、验证

`_dbg/lintprobe/runscript.mjs` —— fixture 里现搭几个脚本（`source-hello.js` 同时打
stdout 和 stderr、`source-slow.js` 每 120ms 打一行、`source-noisy.js` 打 80 万字符、
`source-push.js` 用 readline 问确认并只在 `yes` 时 exit 0），43 项全过。最要紧的那条是
**`confirm: true` 时脚本真的读到 `answer=yes` 并且 exit 0** —— 这条要是不对，
「确认过」的线上发布会静悄悄什么都没干。

`_dbg/lintprobe/scriptsui.mjs` —— 从 `lib/client.js` 里把 `renderScripts` **原文抠出来**
（按大括号配平），喂一个最小版 `h`（`{ type, props, children }`），按状态断言：
没清单 / 读失败 / 空目录 / 本地七个脚本 / 外网地址 / 两次点击确认（点「确认运行」
必须传 `confirmed: true`、点「取消」传 `null`）/ 运行中禁掉别的卡 / 七种收尾文案 /
刷新按钮；后面又长出连接配置那一整片（档案表单、`.env` 现状、脚手架确认框、
忙时禁用、手动维护项目）。测的是要发出去的那段代码，不是照抄一份实现。

`_dbg/lintprobe/clientcss.mjs` —— `lib/client.js` 是手写的、不过打包器，`CSS.xxx`
写错一个字母不会报错，只会把 style 传成 `undefined`：页面照常渲染，那处样式静悄悄
没了。这个探针把 `const CSS = { … }` 抠出来配平，查悬空引用 / 重复键 / 死键。
（顺手量出 `code` / `menuRow` / `toolHint` / `tools` 四个键早就没人用了，没动它们。）

`_dbg/lintprobe/runcallbacks.mjs` —— `scriptsui.mjs` 只覆盖「画出来什么样」，
真正的动作在那些 `useCallback` 里（现在是十一个：`loadScripts` / `startRun` / `pollRun` /
`stopRun` / `loadConfig` / `saveServer` / `deleteServer` / `bindWorkspace` / `applyConfig` /
`scaffoldWorkspace` / `resetPushState`），参数写错一个只会在用户点下去那一刻炸。
所以把它们的**原文抠出来**，喂一个记账版 `call`
（记下每次 RPC 的方法名与实参）和 `setState`（支持函数式更新）跑 132 项断言：参数顺序、
`needs-confirm` 分支、增量拼接、`code: null` 不许覆盖已有退出码、推送跑完只重扫一次、
被停掉的不重扫、轮询失败收摊但日志不丢……

这个「抠原文」的手法自己踩了两个坑，都记在这儿免得下次重踩：

1. **扫描器要认识正则字面量。** 跳过字符串 / 注释还不够 —— `lib/client.js` 里有
   `if (/[\u0000-\u001f\u007f-\u009f"]/u.test(text))`，字符类里那个 `"` 会被当成字符串
   开头，从那儿起**把后面 6 万个字符全吃掉**（实测只认到 121264 里的 6950 个），
   `pickArrow` 于是报「括号没配平」——看着像源码结构问题，其实是扫描器的锅。
   判断 `/` 是除号还是正则用标准启发式：前一个有效字符是标识符字符 / `)` / `]` / `}` /
   引号就是除号，否则是正则；正则体里 `[...]` 中的 `/` 不算结束。
   现在扫描器**返回 `{ code, unclosed }`**，探针开头先把这两个数打出来 ——
   错位的头一个迹象就是「未闭合」不为 0 或代码占比掉到个位数百分比。
2. **切箭头函数要用第一个深度 0 的逗号，不是最后一个。** 竖排的长参数带尾随逗号
   （`},` 后面还有 `[dir, loadScripts],`），取最后一个会把依赖数组也切进箭头里。
   另外抠完必须 `new Function("return (" + arrow + ");")` 解析一遍 —— 括号「配平」
   和「是合法表达式」是两回事，只有解析器不撒谎。
3. **「外来名字」必须逐个体检，否则探针会侥幸通过。** `startRun` 后来多引用了一个
   `runProject`（项目下拉选中的 uuid），而 `PARAMS` 没跟着加 —— 测试用的 `item` 恰好
   都不是 `project: true`，三元短路，这个自由变量一次都没被求值，59 项照样全绿。
   `new Function(...PARAMS, body)` 建的函数里，漏掉的自由变量只在**求值到那一行**时才
   ReferenceError。所以现在多一项静态体检：把箭头里所有标识符扫出来，减掉形参、
   局部 `const/let/var`、关键字、内置对象，剩下的必须全在 `PARAMS` 里；
   反向再查一遍 `PARAMS` 里有没有谁都不用的死参数。

---

## 判据是 `SERVER_URL` 的真实主机名，「环境」这个概念已经删掉

`.env` 里那个 `ENV` **只决定脚本打印什么文案，不决定请求打到哪里**：所有
`source-*.js` 一律读 `SERVER_URL`。于是 `ENV=local` + 一个外网 `SERVER_URL` 会
变成最坏的一种组合 —— 面板写着「本地环境」、实际直接推线上、**而且还不用二次确认**
（旧判据是 `ENV === "server"`）。`LOCAL_URL` 更彻底：一个脚本都没读它。

改法是把判据换成「目标地址是不是本机」，两边都不动脚本行为：

- host 新增四个纯函数：`parseEnvText(text)`（顺带把注释里的「项目名 + uuid」收成候选
  清单）、`splitHost(url)`、`isRemoteUrl(url)`、`labelOfUrl(url)`。
  `projectListScripts` 现在返回 `serverUrl` / `remote` / `targetLabel`
  / `projects` / `servers`，`needsConfirm` 就是 `remote`（后来连拉取一起拦，见上一节）；
  `projectRunScript` 同一套判据，错误文案直接写出真实地址。
- client 标题栏的徽章从 `envLabel`（「本地环境」这种会骗人的标签）换成 `targetLabel`。

**`labelOfUrl` 后来也把前缀去掉了。** 先是有「线上 xxx」/「本地 xxx」两种前缀，用户
看着截图说「标题栏那个把『线上』二字去掉只留地址」—— 于是它只返回 `host:port`
（`remote` 参数一并删掉，签名从两个参数变成一个；IPv6 会套回方括号，否则 `::1:18080`
分不清哪段是端口）。理由和删 ENV 是一路的：**标签本身没信息量**。地址已经写在脸上，
是内是外看 `remote`、要拦就在动作上拦，不必再给同一个事实起个名字。红色 / 绿色底留着
（那是个不用读字的提示），徽章文字只有地址。

### 再往前一步：ENV 也删了

上一版还留着「`envMismatch` —— `.env` 写着 `ENV=local` 但地址是外网」那条红字。
用户看截图时直接问「本地环境和那条红字提醒是什么东西，没用的话可以删掉，**因为没有
本地环境和线上环境的区分**」。这话是对的：ENV 只改文案，那面板上让人选 local /
server、选完再回头指责他选错了，纯属自找麻烦。于是整条链一起撤掉：

- **client**：编辑档案的表单里没有 `ENV` 这一项了，`setConfigEdit` 的两个初始值里
  也不带 `env`；标题栏下面那条「ENV 与真实地址不一致」的红字删掉。**恒写 `local`
  这件事落在 `saveServer` 这个 `useCallback` 里**（`call("projectSaveServer", …,
  "local")`），而不是让调用方带 —— 哪天有人从别处调它忘了带，档案就存成空串，
  而 host 那边空串 = 不写 ENV 行。
- **host**：`projectListScripts` 不再回 `envMismatch` 字段，`lib/index.js` 里那段
  「看 ENV 判断环境」的注释改成「本插件没有本地 / 线上的环境之分」。
- **脚本**：`scaffold/source-push.js` 里 `ENV` / `TARGET_NAME` / 那段 readline 确认
  整个删掉，`readline` 的 require 也删了；表头那行 `目标环境: 本地环境` 换成
  `服务器: <SERVER_URL>` —— **不再打印一个可能撒谎的标签，直接打它真正要连的地址**。
  工作区（`localdev`）里那份同步替换，旧版备份到
  `_dbg/scriptbak/20261010-201305/source-push.js`。

`ENV=local` 仍旧写进 `.env`（`applyConfigToEnv` 照旧），一来没有理由改成别的，
二来万一平台下发的旧版脚本还读它，也不至于空着。
- 「克隆整个项目 / 推送整个项目 / 拉取数据库」三张卡多了项目下拉 —— 这几个脚本第一个
  位置参数就是项目 uuid（`process.argv[2] || process.env.PROJECT_UUID`），候选清单从
  `.env` 里那些被注释掉的行捡（注释本身就是项目名）。不选就传空、让脚本回落到
  `.env` 的 `PROJECT_UUID`。

### 工作区脚本那边的四处（改了 `localdev` 根下的文件）

这三处不在插件里，在**被面板管理的低代码工程**里。`project-rules.md` 只禁止改
`localdev/magicalcoder`（系统核心）与 `pages/*/page.js` 的预置区，根下的
`source-*.js` / `utils.js` / `.env` 没有禁令 —— 但它们是平台下发的脚手架，
**下次平台重新拉取有被覆盖的风险**。改之前已备份到 `_dbg/scriptbak/<时间戳>/`。

1. `source-push.js` 与 `source-clone.js` 各自抄了一份 `loadEnv`，抄成了
   `if (!process.env[key]) process.env[key] = value`（**不覆盖**），和
   `utils.loadEnv()` 注释里写的「强制覆盖」正好相反。Windows 自带一个 `USERNAME`
   环境变量（当前登录账户名），于是单独跑这两个脚本会拿系统账户名去登录。
   两处都改成强制覆盖，并写明为什么不能写成 `if (!…)`。
   `source-db-pull.js` 那份本来就是对的，没动。
2. `source-api-push.js` 的登录把密码拼进 `execSync` 的 curl 命令行 —— 密码会出现在
   进程列表里，含 `"` 或 `$` 时还会把命令拼坏。改成 `--data-binary @-` 从 stdin 读
   body（`execSync(cmd, { input: JSON.stringify({ userName, password }) })`）。
   这条用 `loginlive.mjs` 对着真服务器验过：能拿到 `code:0`，而**不给 body 时登不上**
   （有对照才说明断言有分辨力）。
3. `source-clone.js` 把 `PULL_FILE` 原样打印（`page, api, component, database`），
   可 `component` 在下面三个 `includes(...)` 里全被静默跳过 —— 看着像拉了，其实没有。
   现在只打印真会拉的，被忽略的单独一行写「⚠ 忽略: component（这个脚本只拉
   page / api / database）」。
4. `source-push.js` 的 `ENV` / `TARGET_NAME` / readline 确认段整个删掉（表头改为直接
   打印 `${SERVER_URL}`）。这是**第二轮**改它，备份在
   `_dbg/scriptbak/20261010-201305/`；理由见上面「再往前一步：ENV 也删了」。


## 空目录也能拉项目：配置搬进插件，脚本自带

### 一、起因：`.env` 是脚本的，不是用户的

面板对「配置」一直没有任何主张 —— 它只是**读**工作区根下的 `.env`，把
`SERVER_URL` 摊到「脚本」页签上，再决定要不要弹二次确认。凭据全在脚本
手里，脚本自己 `loadEnv()`。这对已有工程是好事（零侵入），但空文件夹就死了：

> 我要是打开一个空白的文件夹想用这个插件拉服务器上的项目的话是拉不了的，
> 因为这时候是没有 `.env` 的 —— 所以这个配置信息你不能从 `.env` 上获取，
> 得弄成插件可维护的模式。

而且空文件夹连 `source-*.js` 都没有，光有配置也拉不动。所以这一轮是**两件事**：
配置搬到插件自己的存储里，脚本模板随插件走。

### 二、配置存哪

```
<DSH_HOME>/project-config.json
{
  "servers":    [ { "id": "srv-…", "label": "智家排程", "serverUrl": "http://…",
                    "username": "…", "password": "…", "env": "local" } ],
  "workspaces": { "<归一化后的绝对路径>": { "serverId": "srv-…", "projectUuid": "…" } }
}
```

- 路径键走 `workspaceKey(root) = normalizeForCompare(resolve(root))`，和推送账本
  同一套归一化，避免大小写 / 分隔符差异把同一目录认成两个。
- `id` 是 `"srv-" + Date.now().toString(36) + "-" + 随机`，不依赖顺序。
- **`publicServer(server)` 是唯一的出口**，它吐的字段是
  `{ id, label, serverUrl, username, hasPassword, env, remote, targetLabel }` ——
  没有 `password`。所有 RPC 返回值都必须过它（`configstore.mjs` 里有一条静态
  断言，专门查「有没有人手滑写 `password: server.password`」）。
- `.env` 是脚本唯一的输入通道，改不动，所以插件写完配置后**把它合并进工作区的
  `.env`**（`applyConfigToEnv`）。脚本那边一个字节没改。

### 三、`.env` 合并的三条规矩（`mergeEnvText` + `applyConfigToEnv`）

1. **注释行一行不动。** 平台的 `.env` 里堆着十个被注释掉的备选项目、四个备选
   地址，注释本身就是项目名 —— 那是用户唯一的人肉清单。生效行就地替换（不挪
   位置、不重复追加），缺的键追加到末尾（追加前先 pop 掉尾部空行）。
2. **幂等：内容一样就一个字节都不碰。** 判据是**整份文本**的比较，不是「有没有
   键被写过」。这有两个后果：跑脚本时那次自动同步不会每次留一份备份（备份只留
   最近 10 份，被一模一样的副本挤满就等于把有用的顶掉了）；返回值里
   `unchanged: true` 让界面能说「已经是当前配置，没动它」而不是谎报「已写入」。
   顺带把 `mergeEnvText` 的 `written` 语义收紧成「真改了什么」—— 值相同的行完全
   不碰，也不计进 `written`。
3. **写前备份，只留 10 份。** `backupEnvFile` 拷到 `<DSH_HOME>/project-env-backups/`，
   文件名 `<工作区名>-<ISO 时间戳>.env`，按 mtime 删旧的。备份失败不抛错（返回
   空串），不能因为备份不了就不让用户写配置。

`applyConfigToEnv(root, serverId, projectUuid)`：后两个参数给空串就用该工作区
**已绑定的**值；完全没绑定 → 返回 `null` **且不碰磁盘**（`projectApplyConfig`
据此抛 `no-server`）。这条是「别把没配置过的工程写坏」的保险。

**接线点在 `projectRunScript` 里，而且必须在读 `.env` 之前**：

```js
const confirm = …;                        /* 先算 needsConfirm */
await applyConfigToEnv(root, "", "");     /* 再同步 .env —— 顺序反了就会拿旧地址判确认 */
const parsed = await readProjectEnv(root);
```

### 四、脚手架：脚本从哪来、依赖装哪

- 模板随插件走：`dsh-project-panel/scaffold/` 下 9 个文件（七个 `source-*.js` +
  `utils.js` + `package.json`）。`projectScaffold` 只铺 `RUN_SCRIPT_RE` 匹配的
  `source-*.js` 与 `SCAFFOLD_FILES`，**已存在的一律不动**，进 `skipped` —— 用户
  手改过的脚本不能被模板覆盖掉。
- 依赖**不往每个新目录里各装一遍**：插件的 `package.json` 里声明
  `axios / archiver / form-data / unzipper`，装一份，跑脚本时由 host 给子进程塞
  `NODE_PATH`：

  ```js
  const spawnEnv = Object.assign({}, process.env);
  if ((await statOrNull(join(root, "node_modules"))) === null && modules !== "") {
      spawnEnv.NODE_PATH = modules;   /* 目标目录自带 node_modules 时那边优先 */
  }
  ```

- **「装一份」是哪一份，要看装法**（2026-10 踩到）。`link:` 装法下就是
  `<插件根>/node_modules`（开发目录里 `npm install` 出来的那份）。但改成从仓库装
  （`github:lzqzm/dsh-project-panel`）之后，pnpm 把依赖提到了 **profile 的**
  `node_modules`，插件目录里一个都没有 —— 旧的 `scaffoldModules()` 只 stat 了
  `<插件根>/node_modules`，于是恒回空串：客户端显示「装依赖」，点下去会在
  `profiles/web/node_modules/dsh-project-panel/` 里 `npm install`（污染 profile，
  下次市场更新还会被清掉）。
  现在按四个包**齐不齐**判断，找不到就往上走四层找就近的那份：

  ```js
  if (await hasScaffoldDeps(SCAFFOLD_MODULES)) return SCAFFOLD_MODULES;
  let dir = PANEL_ROOT;
  for (let depth = 0; depth < 4; depth += 1) {
      const parent = dirname(dir); if (parent === dir) break;
      dir = parent;
      const candidate = join(dir, "node_modules");
      if (await hasScaffoldDeps(candidate)) return candidate;
  }
  return "";
  ```

  实测（装好的 profile）：`scaffoldModules()` →
  `C:\Users\18013\.dsh\profiles\web\node_modules`，`NODE_PATH` 指过去四个包全部
  `require` 得到。

- `npm install` 不能用 `shell: true` 的 `.cmd`：node 20.12+ 在 Windows 上禁掉了
  `shell: false` 跑 `.cmd`（CVE-2024-27980）。所以 `npmCli()` 自己找
  `<node 安装目录>/node_modules/npm/bin/npm-cli.js`，用 `spawn(process.execPath,
  [npmCliPath, "install", "--no-audit", "--no-fund"])` 跑 —— 绕开 `.cmd` 这层壳。
- 安装是**长任务**（一分钟级），没走 `runs` 那套控制台，而是记在模块级
  `scaffoldInstall = { busy, doneAt, code, log, error }` 里，客户端进「脚本」页签
  后每秒轮询 `projectGetConfig` 的 `scaffold` 字段。日志 stdout + stderr 合成
  一条，截 8000 字符。

### 五、八个 RPC（host）

| RPC | 干什么 |
| --- | --- |
| `projectGetConfig({path?})` | 档案清单（已过 `publicServer`）+ 该工作区绑定 + `.env` 概览（只报 `hasUsername` / `hasPassword`，**不报值**）+ 脚手架状态 |
| `projectSaveServer({id?,label,serverUrl,username,password?,env?})` | `id` 空即新建。`password` **不是字符串就原样保留**（界面「留空即不改」靠这个），空串才是清空。**不动 `projects`** |
| `projectSetProjects({serverId,projects})` | 手动维护的项目清单，**全量替换**（同 uuid 再存一次 = 改名）。见下节 |
| `projectDeleteServer({id})` | 顺带把引用它的绑定清空 |
| `projectBindWorkspace({path,serverId,projectUuid})` | 只改配置里的绑定，**不碰 `.env`**（落盘是另一个动作） |
| `projectApplyConfig({path,serverId?,projectUuid?})` | 走 `applyConfigToEnv`；没绑定抛 `no-server` |
| `projectScaffold({path})` | 铺模板，回 `{copied, skipped, modules, needDeps}` |
| `projectScaffoldDeps()` | 装依赖；已在装 → `{busy:true}`，已装好 → `{reused:true}`，找不到 npm → `no-npm` |

### 五之二、项目清单必须能手动维护

`<DSH_HOME>/project-config.json` 里每个 server 多一个字段：

```json
"projects": [ { "uuid": "…", "name": "智家排程" } ]
```

**为什么非要有它**：候选项目原先只从 `.env` 的注释里捡 —— 而**新铺出来的 `.env`
一条注释都没有**（注释是平台下发那份才带的）。于是「空目录要去服务器上拉项目」
这件事卡在第一步：下拉里空着，脚本就没得拉。用户原话：「初始化没有项目的话不能
手动维护项目，需要手动维护这样子才好去服务器上拉数据下来」。

几个决定：

- **挂在档案上，不挂在文件树上**。项目是服务器上的资源，同一台服务器下的工作区
  看到的是同一份清单。
- **全量替换**（`projectSetProjects` 收整个数组）。改名 = 同一个 uuid 再存一次，
  增删改三条路走同一个 RPC，host 只负责清洗：`cleanProjects()` 干掉空 uuid、
  按 uuid 去重（先到的赢）、跳过非对象条目、名字里的换行抹成空格。
- **两个来源合并**（`projectList`）：手动那份排前面，`.env` 注释里捡的那批排后面；
  按 uuid 去重。合并是 **client 侧**做的 —— host 的 `projectListScripts` 只认 `.env`，
  不必知道面板里存了什么。
  - **不标「（手动）」**：来源对「这次跑哪个项目」没有指导意义。用户看到「基础建档
    （手动）」只会问「为什么要给我加上这两个字」。
  - **`.env` 里生效的那条已经在清单里时，不再单摆一个「不指定」占位项**。两者
    指向同一个 uuid，是同一个项目的两个化身 —— 两个选项一个效果，用户会问
    「只有一个项目为什么能选两个」。这种情况直接选中真身（选中它和「不指定」对
    脚本是一回事：`process.argv[2] || process.env.PROJECT_UUID`）。占位项只在
    `.env` 里根本没有项目时才出现，文案就是「（不指定）」。
  - **「`.env` 里生效的是哪条」必须从原始 `projects` 里取，不能在合并后的
    `projectList` 里 `find(item => item.active)`** —— 手动那份排前面，同一个 uuid 时
    它会把 host 标的 `active` 顶掉，`fallback` 就会显示成「绑定的那条」而实际生效的
    是另一条。现在合并后的条目干脆不带 `active`。
- **保存后顺手绑定**：原来没绑项目的话，加完就把它绑上、少一步点击；删掉的正是
  当前绑定的那个时，绑定一起清空（否则下拉的 value 指向一个列表里没有的 uuid）。
- **没选服务器时「＋ 项目」禁用** —— 项目挂在档案名下，没档案就没处放。

### 六、client 那一片

「脚本」页签顶部多了一块「连接配置」（`configPanel()`，可收起）：

- 服务器下拉 + 项目下拉（**两个来源合并**，见上节）+「＋ 项目」；**下拉显示的选中项**
  是「绑定那条，没绑过就退回 `.env` 里生效那条」，显示的哪条是手动项目，就给
  「改名 / 删除」和一张 `uuid + 名字` 的小表单；
- 四个动作，**按要操作的顺序排**：**新建档案** → **铺脚手架** → **写入 .env**（`.env`
  里的地址和选中档案对不上时套红）→ **刷新**。顺序本身就是说明书 —— 空目录开张那
  四步里前三步正是这三个按钮；摆成「写入 .env / 铺脚手架 / 新建档案」那种顺序，等于
  让人自己去找该先点哪个。
- `.env` 现状行（地址 ｜ 账号 有/无 ｜ 密码 有/无 ｜ 项目）；
- 档案清单：每行一个「编辑 / 删除」+「没密码」徽章。**不再标「外网 / 本机」** ——
  地址就跟它同一行摆着，用户自己的服务器是内是外他比面板清楚，多一个标签只是噪音
  （推送前的二次确认照旧按真实主机名判，判据在 host，跟这行显示无关）；
- 编辑表单：名称 / 地址 / 账号 / 密码（`type=password`，已有档案时 placeholder 写
  「留空即不改」并给「清空」按钮）。**没有 `ENV` 这一项** —— 它恒写 `local`，见上文
  「再往前一步：ENV 也删了」；
- 脚手架没装好时直接说「铺好脚手架也跑不起来」，并给「装依赖」。
- 推送卡右上角**不再挂「线上」角标**。三张 push 卡都顶同一个标签，看久了就是背景
  噪音；「这一下会发到外面」由点「运行」时的二次确认说，配色照旧偏红。
- 标题栏那个徽章**也只有地址**（`123.45.67.89:18080`，没有「线上」二字）。整页
  一处「线上」都不剩 —— 详见上文「`labelOfUrl` 后来也把前缀去掉了」。

另有几条行为约定：

- `config === null` 时**不摆空表单**，只写「读取配置…」—— 免得刚进页签看见一个
  空白表单以为配置丢了。
- **进页签才读配置**（`view === "run" && config.path !== dir`），页签外不麻烦 host。
- 写 `.env` / 铺脚手架之后都要 `loadLevel(root)` 重扫文件树 —— 否则用户点完
  「铺脚手架」，左边树里一个文件都没多，会以为没生效。
- **一个服务器档案都没有时「写入 .env」直接禁用**（`disabled`，原因写进 `title`）。
  不禁的话点下去必然吃一个 `no-server` 报错 —— 明知会失败还让人点，只是在教用户
  忽略红字。同时这种情况不套红：红是「催你去点」，禁用是「现在点不了」。
- 编辑表单的**地址占位符写通用格式**（`http://主机:端口`），不拿某个真实服务器
  当例子 —— 那看着像已经填好的值。
- 编辑表单的**输入框关掉浏览器自动填充**（`autoComplete`：明文 `off`、密码
  `new-password`）。这是「某台开发服务器的登录凭据」，不是网站登录；让密码管理器
  插一手，它会连着账号一起顶掉，存进去的还是个不相干的密码。
- **动作按钮的先后 = 操作先后**，而且和空目录那段 ①②③④ 的点名顺序**必须一致**
  —— 两处都按「档案 → 脚手架 → 写盘 → 装依赖」排，探针两边都盯着（`acts` 那排的
  文字串、以及开张指引里四个名字的下标递增）。
- **「铺脚手架」点下去先弹 `window.confirm`，文案里必须带出目标路径**。在任意目录
  点一下就会倒进 9 个文件（其中 `package.json` 会改变那个目录的 Node 模块解析边界），
  而面板标题上那行工作区路径离按钮太远，点下去之前不会去看 —— 真出过一次事故：
  用户在自己的插件开发目录（就是**装了本插件的那个目录**）上误点，多出 9 个文件。
  （事后靠 **`CreationTime`** 才认出来：`copyFile` 在 Windows 上走 `CopyFileExW`，
  **会保留源文件的 LastWriteTime**，所以新铺进来的文件在资源管理器里显示的是模板的
  06-05 / 06-17 那些日期，只看 mtime 会当成老文件。）
- **忙的时候（`configBusy === true`）这排四个按钮全部 `disabled`**：写盘、铺脚手架、
  刷新，外加下面那个「装依赖」。同一帧里连点两下是并发 RPC 的唯一入口。

### 反复点会不会重复生成

不会。三道锁，从外到内：

1. **按钮 `disabled`** —— 点一下 `configBusy` 就翻 true，这排全部点不动。
2. **host 侧 `projectScaffold` 绝不覆盖**：`if ((await statOrNull(target)) !== null)`
   → 进 `skipped` 然后 `continue`。所以第 N 次点永远是 `{ copied: [], skipped: [9 个] }`，
   一个字节都不写。用户手改过的文件也因此不会被模板盖回去。
3. **`scaffoldInto` 把同一个根上的并发调用合流成一次**（`const scaffoldRuns = new Map()`
   按 `normalizeForCompare(root)` 做键）。第 1 条是渲染之后才生效的，同一帧连点两下
   仍可能并发进来；两个 `copyFile` 抢同一个目标时，输的那个在 Windows 上会 EBUSY /
   EPERM，用户只会看到一句莫名其妙的「铺脚手架失败」，而文件其实已经铺好了。
   第二个调用直接拿到**同一个结果对象**（探针就是拿 `raceA === raceB` 当证据的）。

`projectScaffoldDeps` 同理：`scaffoldModules()` 非空立刻回 `{reused: true}`；
正在装则回 `{busy: true}`，不会起第二个 `npm install`。依赖装在**插件根**，
不往工作区里写，所以「重复点会不会在工作区里多出 node_modules」这个担心也不成立。

### 七、验证（`_dbg/lintprobe/`）

⚠ **`_dbg/` 整个已删**（见开头「仓库里没有的东西」）。下表是它还在时的成绩单，
数字对不上是正常的 —— 现在的回归只能靠一次性脚本，套路见本节末尾。

| 探针 | 管什么 | 结果 |
| --- | --- | --- |
| `configstore.mjs` | 配置存储全链路 + `.env` 合并 + 幂等 + 脚手架（含反复点 / 并发合流）+ 项目清单清洗 + 密码不外泄的静态断言 | ✓107 |
| `runcallbacks.mjs` | 十二个 `useCallback` 的**原文抠取** + 自由变量体检 + 逐个行为 | ✓147 |
| `scriptsui.mjs` | `renderScripts` 原文渲染，含连接配置的全部状态分支 + 确认框 + 忙时禁用 + 手动项目 + 项目下拉去重 + 外网下 7 个按钮全红 | ✓166 |
| `runscript.mjs` | 四个脚本 RPC：白名单、二次确认（外网推拉都拦、本机全放行）、增量轮询、停止、输出截断 | 60 项 |
| `pushbadge.mjs` | 文件树里推送徽章的渲染：三种状态各显示哪几个字、底色、提示，以及并排的校验计数 | ✓25 |
| `treemenu.mjs` | 文件树右键菜单：四种场景各有哪些项，「引用 / 查看源码」与行尾按钮同判据，外加单单元推拉的入口与菜单内确认 | ✓51 |
| `pushscope.mjs` | 推送账本按工作区隔离：同一 uuid 在两个工作区互不串味、markPushed 的祖先/子孙键、只清本工作区；外加 `zone` / `scripts` / `remote` / `targetLabel` 与「只记一个单元」（参数当时叫 `only`，后来改名 `noAncestors`） | ✓49 |
| `clientcss.mjs` | CSS 键完整性 | 54 键 / 50 引用 / 死键 4（都是老的） |
| `gate.mjs` | 扫描带/不带校验的耗时对照 | 已修 |

**`_dbg/` 删掉之后怎么回归**：写一份一次性脚本放 `%TEMP%`，跑完连同 sandbox 一起删
（2026-10 那次改 `noAncestors` + `projectResyncPush` 就是这么验的，33 项全过）。
要点：

- 复制真 `lib/index.js` 一份，把 `const HANDLERS = {` 换成 `export const HANDLERS = {`
  再 `import`；**`DSH_HOME` 必须在 import 之前设**（`PUSH_STATE_FILE` / `CONFIG_FILE` /
  `ENV_BACKUP_DIR` 都是模块加载时算的）。
- 副本**可以**放临时目录，**前提是被测的 handler 不碰 `SCAFFOLD_SRC`** ——
  那是 `import.meta.url` 算出来的，放临时目录会指到 `Temp\scaffold\`。
  测 `projectMarkPushed` / `projectResyncPush` 这类安全；测 `projectScaffold` 系列
  就必须放回 `dsh-project-panel/lib/` 并跑完删掉。
- 假 ctx：`{ get: (k) => k === "workspaceRegistry" ? { list: () => [{ path: wsA }, { path: wsB }] } : undefined }`。
- 造「脏」要动 mtime，且**别依赖写入时刻**：同一毫秒内连写两次，`mtimeMs` 可能一样，
  检测不到变化。用 `fs.utimes(file, t, t)` 显式设成固定基准 + 递增秒数最稳。
- 找节点**按 `key` 找**（`key` 形如 `<归一化根>|page:<uuid>`）而不是按 `relPath` ——
  同一 `relPath` 上可能同时挂着聚合节点和单位节点。顶层回值里**没有 `anyDirty`**
  （那只是递归中间值）。

三个手法上的坑（都记在这里，别再走一遍）：

1. **`SCAFFOLD_SRC` 是 `fileURLToPath(new URL("../", import.meta.url))` 算的**，
   所以探针把 `index.js` 复制到临时目录再 import 时，`../scaffold/` 会指到
   `Temp\scaffold\` 去。补丁副本**必须落在 `dsh-project-panel/lib/` 里**
   （当时叫 `index.cfgprobe.mjs`，跑完删）。
2. **`npm install` 装哪儿要定死。** 一开始让 `scaffoldModules()` 找
   `scaffold/node_modules`，可 `npm install` 是在插件根跑的 —— 找的地方和装的
   地方不是一个。统一成 `<插件根>/node_modules`，`cwd: PANEL_ROOT`。
3. **`JSON.stringify` 会把数组里的 `undefined` 变成 `null`**，所以「传了
   `undefined`（不改密码）」和「传了 `""`（清空密码）」在 `same()` 眼里长得一样。
   这两条得用 `args[i] === undefined` 直接比，另外补一条「`undefined` 后面的实参
   位置没塌掉」。
4. `gate.mjs` 早先钉死 `"async function lintCached(dir, stamp) {"` 当锚点，后来参数
   改名成 `snapshot` 就静默失效（报「没找到 lintCached」）。锚点改成按形状匹配
   `/async function lintCached\([^)]*\) \{/`。
5. **别拿 `anyDirty` 当断言**（顶层回值里根本没这个字段，写了就是一条永远失败的
   假断言）；也**别用 `api()` 去造页面目录**（那会写成 `meta.json`，之后 `touch(.../page.css)`
   直接 ENOENT）。这两条都是写一次性脚本时踩的。


