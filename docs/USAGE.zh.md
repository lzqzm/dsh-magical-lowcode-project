# dsh-magical-lowcode-project 使用手册（逐区域 / 逐按钮）

> 这份文档讲的是**装上之后每一步点哪里、会发生什么、对应哪个 host RPC**，并给每个功能配一个可以直接照着敲的案例。
> 面板本身是插件的客户端半边（`lib/client.js`），所有实际动作都通过 host 半边的 RPC 完成（`lib/index.js`），文档里两条线都标出来，方便排错时对照。

---

## 0. 打开面板与三个前提

### 0.1 三个入口（同一个面板）

| 入口 | 位置 | 形态 |
| --- | --- | --- |
| 设置页 | **设置 → 低代码工程模式** | 设置面板里的一个分节（`slot: settings.section`，`id: magical-lowcode-project`，`order: 100`，`label: 低代码工程模式`） |
| 侧边栏按钮 | **侧边栏最底部**的 `▤` 按钮（`title="低代码工程模式"`） | 弹出浮层（`slot: sidebar.footer.action`，同一个 `id`）；浮层宽 `min(900px, 88vw)` |
| 会话页签 | 会话区域顶部的**「低代码工程」页签** | 会话视图（`slot: conversation.view`，`order: 20`）；受面板顶部的**工程模式开关**控制（见 0.5） |

三者是**同一个工程浏览器**，只是承载容器不同：**左侧常驻项目树 + 右侧详情区**。侧边栏那个关掉不影响设置页那个。

### 0.2 界面布局：左树 + 右栏

面板从 0.2.5 起不再是一个「弹窗 + 整页页签」：

- **左栏是常驻项目树**：目录名点一下展开/收起，文件名点一下在右栏打开；**每一行右键**有完整操作菜单
  （见第 1 节的右键菜单表），菜单项按条目类型给。
- **行内按钮只在鼠标悬停到该行、或该行被选中时才出现**（`↑` 推送 / `↓` 下拉 / `✏` 项目命名 / `查看` / `📋` 复制路径）。
  平铺状态下每行只留文件名与推送状态标签，不再一行挤一排按钮。
- **右栏是详情区**，顶部一排子页签：**文件内容 / 体检与预览 / 推送状态 / 工程脚本 / 预设包**。
  打开文件后右栏自动切到「文件内容」；右键「🔍 推送前校验」会自动切到「体检与预览」。

### 0.3 路径输入框在顶部（左树与五个页签共用）

浏览器顶部的路径输入框由**左树与右栏五个页签共用**，记忆键是浏览器 `localStorage` 的 `dsh-magical-lowcode-project:dir`。所以：

- 在顶部填了路径，切到「推送状态」它还在——**但这不代表填对了**；
- 每个页签对路径的**要求不一样**（见下表），切页签后要确认一下这个路径在当前页签是不是合法的那一层。

| 页签 | 路径要的是哪一层 | 例 |
| --- | --- | --- |
| 项目树（左栏） | **工程目录**（任意一层都行，列它的一层子项） | `...\proj` 或 `...\proj\pages` |
| 推送状态 | **工作区根**（下面要能扫到 `pages/` `apis/` `databases/`，并从此层 `.env` 读 `PROJECT_UUID`） | `...\proj` |
| 预览与体检 | **页面目录**（该层必须有 `page.json`） | `...\proj\pages\home` |
| 工程脚本 | **工作区根**（脚本躺这一层；也可以传它下面的工程子目录 —— 0.2.12 起会自动逐级向上找到工作区根） | `...\proj` 或 `...\proj\<projectUuid>` |
| 预设包 | 不是路径，是**预设标识符** | `my-agent` |

### 0.4 前提：目录必须已注册为 DSH 工作区

host 半边**所有带路径的 RPC** 都会先做一次归属校验：路径必须落在 `ctx.workspaceRegistry.list()` 返回的某个工作区**之内**（相等或前缀 + 路径分隔符），否则一律抛 `path-outside-workspace`。

- 登记入口：DSH 侧边栏「工作区」区域的 **「添加工作区」**（客户端文案就是这四个字）。
- 登记的是**根**：把根登记进去之后，它下面**所有子目录**都可访问。所以想让 `...\localdev\<uuid>\pages\xxx` 能用，登记 `...\localdev` 就行，不用逐个登记项目目录。
- 注意「之内」是**前缀比较**：登记 `D:\a\b` 之后 `D:\a\bc` 不算在内（比较时带分隔符），这是对的。

### 0.5 工程模式开关与界面语言

- **工程模式开关**在面板顶部第一行（默认**打开**）：关掉即把会话页签从会话里摘掉，设置页与侧栏两个
  入口照旧；再打开就回来。状态存 `localStorage` 的 `dsh-magical-lowcode-project:project-mode`，
  同一页面的多个面板实例与其它标签页都会同步。
- **界面语言**：设置页导航名、会话页签名、侧栏按钮标题与浮层标题、五个页签名、开关行会跟随宿主语言
  （宿主提供 `locale` 服务时）；面板内部的说明性长文案暂时保持中文。

### 0.6 切走再回来：数据与位置都会留着（0.2.15）

设置页、侧栏浮层、会话页签是**三套独立挂载**的面板：切走再回来，React 会把旧的卸载、重新挂一套。0.2.15 之前
那意味着「列过的树、展开的层级、选中的文件、右栏页签全没了」，得从头再点一遍。现在：

- **项目树 / 已展开的每一层 / 推送状态**放在模块级缓存里：重新挂载**立刻显示**上次的数据，随后**后台重扫一遍**
  （所以看到的是旧数据不假，但一两秒内会被刷新，不会停在旧快照上）。
- **记忆键**（都在浏览器 `localStorage`，换浏览器或清缓存就没了）：
  `dsh-magical-lowcode-project:dir`（工程目录）、`:expanded`（展开到哪几层）、`:selected`（上次打开哪个文件）、
  `:detail`（右栏停在哪个页签）、`:project-mode`（工程模式开关）。
- **回到面板会自动列一次**：目录已记忆时不用再点「列出」；上次打开的文件也会自动读回来。
- 换一个工程目录后，记忆里的展开项仍按路径前缀生效，不在新目录下的会被忽略。

这三处都属于**客户端半边**（`lib/client.js`），但不建议只刷新页面：插件文件改动后**重启 DSH** 最稳。

---

## 1. 左栏：项目树（`TreeTab`）

用途：**看和改**。它替代的是「在编辑器里翻目录」这件事，但限死在已注册工作区内。

这一栏是**常驻**的：切到右栏任何页签，左树都还在。下表里标 **工具栏** 的按钮在工程浏览器顶部那一行（与右栏共享同一个路径输入框），标 **行内** 的按钮只在鼠标悬停该行或该行被选中时出现，标 **右键** 的只在右键菜单里。

### 1.1 控件

| 控件 | 调用的 RPC | 行为 |
| --- | --- | --- |
| 路径输入框（**工具栏**） | — | placeholder：`工程目录绝对路径（须落在已注册工作区内）` |
| **列出**（**工具栏**） | `listProjectEntries(path)` | 列**树的第一层**；隐藏项（`.` 开头）灰显；超过 1000 项会截断并提示；符号链接被跳过 |
| **模糊查找框**（树栏顶部） | `projectSearchEntries(dir, query)` | 0.2.15 新增：输入停 250ms 后**递归搜整棵工程目录**（`node_modules`、`.git` 等跳过），按子序列模糊匹配 —— 「备管」命中「备件管理」、`spp` 命中 `source-page-push.js`；命中名字加分、名字短的优先；上限 4000 个目录 / 200 条结果 / 16 层，超出提示已截断。点一条结果会逐级展开定位过去（文件顺手打开） |
| **目录名**（点名字） | `listProjectEntries(path)` | 展开/收起该目录；**第一次展开时**才拉那一层（之后走已加载的缓存）；非目录行点名字改为在右栏打开文件 |
| **刷新**（**工具栏**） | `listProjectEntries(path)` ×N + `projectPushStatus(dir)` | 重载根与**所有已展开**的子目录，然后重扫推送状态 |
| **重扫推送状态**（**工具栏**） | `projectPushStatus(dir)` | 只重扫状态，不动已展开的目录内容 |
| 条目左侧图标 | — | 目录行 `▸ 📁` / `▾ 📁`（展开态），文件行 `📄` |
| 行内状态标签 | `projectPushStatus(dir)` | `✔ 已推送` / `● 待推送`；按**规范化**（去尾斜杠、统一反斜杠、忽略大小写）后的绝对路径与推送账本匹配 |
| **↑**（**行内**，只对 `● 待推送` 的行） | `projectRunScript` → `projectMarkPushed` | 弹命令确认 → 跑 `source-page-push.js <target>`（api 行是 `source-api-push.js`）→ 成功后**自动**把同一目标标记为已推送 |
| **↓**（**行内**，只对目录） | `projectRunScript` → `projectResetPushState` | 按目录语义挑脚本（见 1.5）；确认后执行，成功后**清空全部推送状态记录**（本地文件已被线上覆盖） |
| **✏**（**行内**，只对 32 位 UUID 目录） | `projectSetProjectName(workspacePath, uuid, name)` | 弹 `prompt` 要显示名（清空则删掉映射）；只改 `.dsh-project-names.json`，**不动物理目录名** |
| **📋**（**行内**） | — | 写进剪贴板；剪贴板不可用时把路径显示在提示行里 |
| **查看**（**行内**，只对文件） | `projectReadFile(path)` | 读 UTF-8，单文件上限 2MB；内容出现在**右栏「文件内容」**页签，是**可编辑**的文本域 |
| **保存**（右栏） | `projectWriteFile(path, content)` | 直接写回（UTF-8，**无备份、无二次确认**）；成功后原地出现「已保存」 |
| **关闭**（右栏） | — | 只收起右栏的编辑区，不写盘 |
| **改名**（**右键**） | `projectRenameEntry(path, newName)` | 弹 `prompt` 要新名字；会同步改写该目录下 `page.json` / `meta.json` 里的 `name` 字段；Windows 上遇到 `EPERM`/`EBUSY` 会退避重试 |
| **删除**（**右键**） | `projectDeleteEntry(path)` | 弹 `confirm`；目录会连内容一起删（提示里写明「目录（含其中全部内容）」）；**禁止删除工作区根** |
| **环境配置**（**工具栏**） | `projectReadFile(path)` → `projectWriteFile(path, content)` | 读写**工作区根** `.env` 的 `SERVER_URL` / `PROJECT_UUID`（见 1.6） |

#### 右键菜单（0.2.2）

在任意行上**点右键**，会就地弹出菜单（上游 DSH Desktop `ProjectContextMenu` 的等价物）。
它是上表动作的第二入口，**不适用的项灰显禁用而不是隐藏**，所以菜单位置固定、不会点错：

| 菜单项 | 可用条件 | 行为 |
| --- | --- | --- |
| 👁 查看内容 | 文件行 | 同**查看** |
| 🤖 复制内容（发给 AI） | 文件行 | `projectReadFile` 读内容 + 绝对路径一起写进剪贴板（上游是把文本直接注进对话输入框，那依赖它补丁内的私有函数，插件版拿不到，所以退化成「复制上下文，粘进对话即可」） |
| ↑ 推送 | 该行 `● 待推送` | 同上表 **↑ 推送**（`source-page-push.js` / `source-api-push.js` → 成功后 `projectMarkPushed`） |
| ↓ 下拉 | 目录行 | 同上表 **↓ 下拉**（按 1.5 的语义挑脚本） |
| ✏ 项目命名 | 32 位 UUID 目录 | 同上表 **项目命名** |
| 🔍 推送前校验 | 目录行 | `projectLint(path)`，**自动切到右栏「体检与预览」页签**并把命中的问题（等级 / 文件:行 / 说明）列在那儿；没问题就提示「可以推送」 |
| ⟳ 刷新 | 已填工程目录 | 同上表 **刷新** |
| ⟳ 重扫推送状态 | 已填工程目录 | 同上表 **重扫推送状态** |
| ⚙ 修改环境配置 | 已填工程目录 | 打开 `.env` 配置对话框（同工具栏 **环境配置**，见 1.6） |
| 📋 复制绝对路径 | 任意行 | 写进剪贴板 |
| 📋 复制相对路径 | 该行在当前工程目录之下 | 相对当前工程目录的 `/` 分隔路径；不在其下则灰显 |
| ✏ 改名 | 任意行 | 同上表 **改名** |
| 🗑 删除 | 任意行 | 同上表 **删除**（红字） |

关闭方式：点菜单外任何地方、按 `Escape`、窗口失焦或改变窗口尺寸。

### 1.2 案例 A：看清一个工程的结构

1. 路径填 `D:\project\PythonWorkSpace\AI学习\MagicalCoder平台插件话\.dsh-verify\proj`，点**列出**。
2. 预期看到 7 项：`.env`（灰显）、`apis`、`index.html`、`meta.json`、`pages`、`source-hello.js`、`sub`。

### 1.3 案例 B：改一个页面的 `page.json`

1. 接着在路径框尾部补 `\pages\home`，点**列出**。
2. 对 `page.json` 点**查看**，详情区显示 `{"uuid":"mc-test-page-0001","name":"首页","components":[]}`。
3. 把 `"name":"首页"` 改成 `"name":"首页（改过）"`，点**保存** → 出现「已保存」。
4. 再点一次**列出**并**查看** `page.json`，确认改回来了。**记得改回去**，否则后面案例的预期值会变。

### 1.4 案例 C：改名会连带改 JSON

对 `pages` 下的 `home` 目录点**改名**，输入 `home2`。改名后进 `home2` 看 `page.json`，`name` 字段会被同步改成 `home2`（这是 `projectRenameEntry` 的行为，不是笔误）。再用**改名**改回 `home`。

### 1.5 案例 F：↓ 下拉会跑哪个脚本

↓ 下拉按**目录名/路径语义**挑脚本（与上游 DSH Desktop 的「下拉项目 / 下拉全部页面 / 下拉全部 API」等价）：

| 你点的目录 | 跑的脚本 | 参数 |
| --- | --- | --- |
| 名为 `pages` 的目录 | `source-page-pull.js` | 无（拉全部页面） |
| 名为 `apis` 的目录 | `source-api-pull.js` | 无（拉全部 API） |
| 名为 `databases` 的目录 | `source-db-pull.js` | 无 |
| 32 位十六进制 UUID 的项目目录 | `source-clone.js` | 该 UUID（克隆整个项目） |
| `pages` / `apis` 区里的其它目录 | 对应的 pull 脚本 | 先弹 `prompt` 问页面/接口 ID |
| 其它目录 | — | 提示「该目录不在 pages/apis 区里…」，不跑脚本 |

每次都会先弹「操作确认」把命令亮出来（例如 `$ node source-page-pull.js 1234`），确认后才跑；跑完在同一个弹窗里显示 exit code 与输出。

**下拉成功后推送账本会被清空**（host 的 `projectResetPushState`）：本地文件刚被线上覆盖，旧的「已推送」记录不再成立。所以拉完记得点一次**重扫推送状态**再继续改。

### 1.6 案例 G：改 `.env`（`SERVER_URL` / `PROJECT_UUID`）

工具栏的**环境配置**按钮、右键菜单的 **⚙ 修改环境配置**，打开的是同一个对话框：

1. 路径填**工作区根**（例如 `D:\project\PythonWorkSpace\AI学习\MagicalCoder平台插件话\.dsh-verify\proj`），点**环境配置**。
2. 对话框先调 `projectReadFile(<根>\.env)`：
   - 读到就解析出 `SERVER_URL` 与 `PROJECT_UUID` 填进两个输入框（`export KEY=` 前缀、单/双引号都认）；
   - 读不到（文件不存在，或目录不在已注册工作区内）就按「空 `.env`」打开，并提示**保存会新建一个**。
3. 改完点**保存** → 把两个键写回原文后整体 `projectWriteFile` 落盘；成功显示「已保存」。
4. 想看结果，回项目树对同目录的 `.env` 点**查看**。

写回是**行级替换**，不是重写整个文件：

- 命中同名行（含 `export KEY=`）只替换那一行，保留原来的缩进与 `export ` 前缀；
- 没命中就追加到文件末尾（先清掉尾部空行，不会夹出一排空行）；
- 注释、账号密码等其它行原样保留；
- 值里有空白或 `#` 时自动加双引号（`SERVER_URL="https://a b"`），避免被当成行尾注释。

`SERVER_URL` 是各个 `source-*.js` 脚本读的平台地址，`PROJECT_UUID` 是「推送状态」页签
判定项目归属用的那个键。这份纯逻辑由 `node test/env-check.mjs`（21 项）守着。

---

## 2. 右栏：推送状态（`PushTab`）

用途：**记账**。回答「哪些页面/接口已经同步到平台、哪些改过还没同步」。
判断依据是**文件 mtime 快照**，不是 git、也不是平台回执。

### 2.1 控件

| 控件 | 调用的 RPC | 行为 |
| --- | --- | --- |
| 路径输入框 | — | placeholder：`工作区绝对路径` |
| **扫描** | `projectPushStatus(dir)` | 扫描 `pages/` `apis/` `databases/` 三区；以 `page.json` 的 `uuid` / `meta.json` 的 `id` 作为节点键；与上次记录的快照比对得出 `pushed` / `dirty`；同时从工作区根的 `.env` 读 `PROJECT_UUID`，并把 `.dsh-project-names.json` 里的显示名映射一并返回 |
| 节点上的 `scope` 标签 | — | `page` / `api` / `aggregate`（目录聚合节点） |
| 节点上的状态标签 | — | `✔ 已推送` / `● 待推送` |
| **标记已推送**（只对待推送节点出现） | `projectMarkPushed(workspacePath, relPath, scope, target)` | 把该节点当前所有文件的 mtime 记成新快照；会**连带更新祖先与子孙**节点的快照 |
| **设置项目名** | `projectSetProjectName(workspacePath, uuid, name)` | 连弹两个 `prompt`：先「项目 UUID（32 位十六进制；默认取工作区 .env 的 PROJECT_UUID）」，再「显示用的项目名（清空则删除该条映射）」；只改 `.dsh-project-names.json`，**只影响显示** |
| **重置记录** | `projectResetPushState()` | 清空**全部**推送状态（弹 `confirm`）；下次扫描所有节点都会变成待推送 |

### 2.2 案例 D：制造一次「待推送」再消掉

1. 路径填 `D:\project\PythonWorkSpace\AI学习\MagicalCoder平台插件话\.dsh-verify\proj`，点**扫描**。
2. 预期：`共 4 项，待推送 0 项 · PROJECT_UUID 0123456789abcdef0123456789abcdef`，节点大致是 `测试接口 → apis → 首页 → pages`（扁平列表，靠相对路径缩进体现层级）。
3. 去「项目树」把 `pages\home\page.js` 末尾加一个空格并**保存**（改了 mtime）。
4. 回「推送状态」再点**扫描** → `首页` 那一项变成 `● 待推送`。
5. 对它点**标记已推送** → 再**扫描**一次，又回到 `✔ 已推送`。

### 2.3 案例 E：`PROJECT_UUID` 从哪来

`proj\.env` 里写着：

```
PROJECT_UUID=0123456789abcdef0123456789abcdef
PROJECT_NAME=功能验证项目
```

扫描结果里的 `PROJECT_UUID` 就是它。把 `.env` 里的值改掉再扫描，显示会跟着变——这条可以用来确认你扫的确实是那个工作区。

---

## 3. 右栏：体检与预览（`PreviewTab`）

用途：**推平台之前的两道保险**。一个静态查问题，一个动态看效果。

页签顶部还有一块**「树内校验」**：在左树某一行右键点「🔍 推送前校验」后，问题列表就出现在这里
（等级 / 文件:行 / 说明），列表为空即「没有发现问题，可以推送」。这一块是只读的，看的是你刚校验的那一层。

### 3.1 两个按钮的分工

| — | **推送前体检** | **装配预览** |
| --- | --- | --- |
| 调用的 RPC | `projectLint(dir)` | `projectAssemblePreview(dir)` |
| 本质 | **静态分析**：读 4 个文件跑规则（正则匹配 + `new Function` 做 JS 语法解析） | **产物生成**：把 `index.html` + `page.js` + `page.css` 内联成一张独立沙箱页，并注入平台 runtime |
| 你拿到什么 | 问题清单：`level`（error/warn）+ `文件:行号` + `规则名` + `说明` | 一份完整 HTML（`{html, serverUrl, pageUuid}`），面板上多出**在新标签打开预览** |
| 会执行 JS 吗 | **不会**，只解析语法 | **会**，生成页在浏览器里真跑 |
| 最适合发现 | 约定/结构类问题 | 运行时问题（白屏、控制台报错、样式没生效） |
| 对什么目录有效 | 页面目录（有 `page.json`）或接口目录（有 `meta.json`） | 实质只对页面目录有意义 |
| 副作用 | 不改文件、不推平台 | 不改文件、不推平台 |

一句话：**体检是审稿，预览是试映**。两个按钮独立，共用同一个输入框，可以只点其中一个。

### 3.2 体检的完整规则表

| 规则名 | 级别 | 检查对象 | 触发条件 |
| --- | --- | --- | --- |
| `json-invalid` | error | `page.json` | 不是合法 JSON |
| `uuid-missing` | error | `page.json` | 缺少 `uuid` 字段 |
| `no-scene` | warn | `index.html` | 不含 `magicalDragScene` 容器 |
| `bare-mustache` | error | `index.html` | 文本节点里出现裸 `{{ }}`（会被 Vue 当插值解析，应加 `v-pre`） |
| `attr-mustache` | error | `index.html` | 属性值里出现裸 `{{ }}`（会编译错误，应写 `:prop="'...'"`） |
| `js-syntax` | error | `page.js` | `new Function(js)` 解析失败 |
| `no-myMethod` | warn | `page.js` | 没有 `var myMethod =` |
| `no-merge-loop` | warn | `page.js` | 有 `myMethod` 但缺 `for (var key in myMethod)` 合并循环（V1.01） |
| `sys-zone-modified` | error | `page.js` | 在 `myMethod` 字面量**之外**直接给 `vueMethod.x` 赋值（运行时 `is not a function`） |
| `api-url` | warn | `page.js` | 调了 `magicaltool.request` 但 url 没用 `/magical_lowcode/openapi/` 前缀 |
| `css-brace` | error | `page.css` | `{` 与 `}` 数量不相等 |

另外：目录**既没有 `page.json` 也没有 `meta.json`** 时，体检直接抛 `not-a-page-or-api`「该目录既不是页面目录（无 page.json）也不是 API 目录（无 meta.json）」。

### 3.3 案例 F：故障样本 vs 干净样本

先看**故意做坏**的样本：

- 路径：`D:\project\PythonWorkSpace\AI学习\MagicalCoder平台插件话\.dsh-verify\proj\pages\lint-demo`
- 点**推送前体检** → 预期 `静态规则命中 8 条`：
  `uuid-missing`(error)、`no-scene`(warn)、`attr-mustache`(error)、`bare-mustache`(error)、`js-syntax`(error)、`sys-zone-modified`(error)、`no-myMethod`(warn)、`css-brace`(error)。
- 再点**装配预览** → `预览就绪`，点**在新标签打开预览** → 因为 `page.js` 有语法错误，页面上基本是白的（打开开发者工具会看到语法错误）。这说明**同一份文件，两种视角**。

再换成干净对照：

- 路径：`...\.dsh-verify\proj\pages\home`
- 点**推送前体检** → `静态规则命中 0 条`。

> 这个 `lint-demo` 目录是**专门造出来的故障样本**（只有 4 个小文件），不属于任何真实工程，用完可以直接删。

### 3.4 案例 G：给接口目录做体检

- 路径：`...\.dsh-verify\proj\apis\getList`（该层有 `meta.json`，没有 `page.json`）
- 点**推送前体检** → 走的是**接口分支**，不会去查 `index.html`/`page.js`/`page.css`。
- 同一个路径点**装配预览**没有实际意义（装配是给页面用的）。

### 3.5 案例 H：看一张真实的装配产物

- 路径：`...\.dsh-verify\proj\pages\home`，点**装配预览**。
- 预期：`预览就绪 · page uuid mc-test-page-0001`，下面显示「装配产物 N 字节（预览页会从 cdn.jsdelivr.net 取 echarts）」。
- 点**在新标签打开预览** → 新标签页打开一份 `blob:` URL。⚠️ 这份页面会去 `cdn.jsdelivr.net` 取 `echarts@5.5.1`，**断网时图表区会是空的**，那是环境问题不是页面问题。

---

## 4. 右栏：工程脚本（`ScriptTab`）

用途：**真正把内容同步到平台的那一步**。插件自己不做推送，推送是低代码工程自带的 `source-*.js` 脚本干的，这个页签只是给它一个执行入口。

### 4.1 控件

| 控件 | 调用的 RPC | 行为 |
| --- | --- | --- |
| 路径输入框 | — | placeholder：`工作区绝对路径（脚本可在这一层，也可在工作区根）` |
| 脚本名输入框 | — | **默认值是 `source-page-push.js`**，placeholder `source-xxx.js`。⚠️ 想跑别的脚本必须手动改这一格 |
| 参数输入框 | — | placeholder：`参数（空格分隔，可留空）`；按空白拆成数组传给脚本 |
| **运行** | `projectRunScript(script, args, cwd)` | 见下 |
| **运行前预检**（自动） | `projectResolveScript(script, cwd)` | 点运行前先由 host 定位脚本目录并检查那层 `.env` 的四个键；缺键就只显示提示、**不弹执行确认**（0.2.14 起，见 4.2） |

执行的硬边界（host 侧）：

- 脚本名必须匹配白名单 `/^source-[a-z0-9-]+\.js$/`；脚本要**直接躺在某一层目录里**（放子目录里不会被找到）。查找从传入的 `cwd` 开始**逐级向上**，最远到最外层的**已注册工作区**为止（每一级都必须还在某个已注册工作区内）—— MagicalCoder 的 localdev 布局把 `source-*.js` 放在工作区根（`localdev\source-page-push.js`），而面板里的「工程目录」只是它下面的工程子目录（`localdev\<projectUuid>`），所以这种布局下脚本会被自动找到；从 `cwd` 一路找到边界都没有时，报 `script-not-found` 并提示应放的位置；
- 用**宿主自带的 node** 执行（`process.execPath`），`shell: false`，所以不依赖系统 PATH；
- `stdout` 累计超过 400000 字符会被中止，最终输出截断到 20000 字符；
- 每次运行前会自动清理上次异常退出遗留的 `.temp_page_push_*` / `.temp_api_push_*` 目录；
- 返回 `{ok, code, cmd, output}`。面板显示成 `成功（exit code 0）· <实际命令行>` 或 `失败（exit code N）· <实际命令行>`，下面用等宽区显示合并后的输出。

### 4.2 运行前会先检查环境变量

`source-*.js` 脚本靠 `utils.loadEnv()` 读**脚本所在那一层**的 `.env`。如果那层的 `.env` 没维护
（本地新建的工作区尤其常见），脚本会一路跑到登录失败或找不到工程才报错，白等一趟。0.2.14 起，
点「运行…」之前插了一步预检：

1. 面板先调 `projectResolveScript(script, cwd)`，由 host 按 4.1 的规则找出脚本真正所在的那一层；
2. host 读那层的 `.env`，看 `SERVER_URL` / `USERNAME` / `PASSWORD` / `PROJECT_UUID` 是否都非空；
3. 有缺失 → 页签里显示「⚠ 环境变量未维护：`<脚本目录>\.env` 缺少 …」加一个**去维护环境变量**按钮，
   **这一步不会弹执行确认、脚本也不会跑**；点按钮就地编辑这层 `.env`（只改这四个键，注释与其它键原样保留），
   保存后再点运行即可；
4. 四个键都在 → 照旧弹执行确认，然后执行。

> 注意这里的 `.env` 是**脚本目录**那一份，和工具栏「环境配置」改的**工作区根** `.env`（只两键）不是同一个文件：
> localdev 布局下脚本在 `localdev\`，工程目录在 `localdev\<projectUuid>\`，两份 `.env` 各管一摊。

### 4.3 案例 I：跑一次工程脚本

1. 路径填 `D:\project\PythonWorkSpace\AI学习\MagicalCoder平台插件话\.dsh-verify\proj`。
2. **把脚本名那一格从默认的 `source-page-push.js` 改成 `source-hello.js`**（这个工程里只有这一个脚本，内容是 `console.log('hello from source script');`）。
3. 参数留空，点**运行** → 预期 `成功（exit code 0）`，输出区出现 `hello from source script`。
4. 反面案例：脚本名填一个**从传入目录一路到工作区根都没有**的名字（例如 `source-nope.js`）→ 报 `script-not-found`，错误里会写明应该把脚本放在哪个工作区根下。
5. 再接一个反面案例：脚本名填 `../../evil.sh` → 被白名单挡下（`script-not-allowed`）。
6. 环境变量反面案例：把脚本所在那层 `.env` 里的 `USERNAME` 删掉再点运行 → 不再弹执行确认，
   页签里显示「⚠ 环境变量未维护」和**去维护环境变量**按钮；点按钮补回 `USERNAME` 保存，再点运行才继续。

---

## 5. 右栏：预设包（`PresetTab`）

> ⚠️ **这一页和低代码工程没有关系。**
> 它管的是 **DSH 自己的 Agent 预设包**：`.dshpreset` 是一个 ZIP，内含 `manifest.json`（`{format:"dsh-preset", version:1, id, name, description, sourceDshVersion, exportedAt}`）+ `preset/` 目录（里面有 `agent.cordis.yml`，以及该预设自带的技能与插件）。这套能力是从上游 DSH Desktop 原样继承过来的。

### 5.1 控件

| 控件 | 走哪条通道 | 行为 |
| --- | --- | --- |
| 标识符输入框 | — | placeholder：`预设标识符（小写字母/数字/连字符，留空则用包内 id）`，规则 `/^[a-z0-9][a-z0-9-]*$/` |
| **导出** | `GET /api/agent-preset.export?agentPreset=<id>`（host 半边注册的 connection fetch 路由） | 下载 `<id>.dshpreset`；成功后提示 `已导出 <id>.dshpreset（N 字节）`。输入框为空时按钮是**禁用**状态 |
| **导入…** | 先 `POST /api/agent-preset.import[?agentPreset=<id>]` 预览，再 `POST …&install=1` 落盘 | 打开系统文件选择器（接受 `.dshpreset` / `application/zip`） |

### 5.2 预设包的两条硬规则

1. **导出的是 DSH 0.2.0 里那套预设的插件清单** —— 写进 `.dshpreset` 的 `preset/agent.cordis.yml` 就是该预设的插件声明（由 `agentPresets.readDocument()` 给出）。0.2.0 起预设不再分内置/自定义：内置预设同样可以导出（旧版那句「内置预设返回 403」已作废）。
2. **导入绝不覆盖** —— 同名冲突返回 **409**，提示换一个标识符。想指定目标 id，就在导入前先把标识符输入框填上。

包体限制：压缩 ≤16MB、解压 ≤32MB、单文件 ≤12MB、≤512 个文件；拒绝绝对路径、父目录穿越、反斜杠路径与符号链接。导入流程是「先预览（插件项数、来源 DSH 版本、冲突、警告）→ 你确认 → 把声明 INSERT 进本机 profile 的 `cordis.patch.yml`（先写临时文件再原子 rename）」，失败不会留下半行。写完后由 DSH 自己的 profile 配置热重载接手，新预设随即出现在预设选择器里。

### 5.3 案例 J：导出再导入一个预设

1. 先在 DSH 的 Agent 预设界面确认要导出的预设 id（内置的 `standard` / `minimal` / `ptc` 也行）。
2. 回到这一页，把 id 填进标识符输入框，点**导出**，得到 `<id>.dshpreset`。
3. 点**导入…**选刚下回来的包，先把标识符改成别的（例如 `<id>-copy`）避免撞 409，看过预览再安装。
4. 装机结果写在 profile 的 `cordis.patch.yml` 里，形如一行
   `- insert: [ {id: preset-<id>-copy, name: "@deepseek-ai/dsh-agent-preset", config: {…}} ]`；想撤销就删掉那一行。

---

## 6. 一条典型工作流（把面板串起来）

1. **定位**（项目树）：填工程目录 → 列出 → 点目录名逐级展开到要改的页面目录。
2. **改**（项目树）：查看 → 编辑 → 保存；或对目录用**改名**。
3. **验**（预览与体检）：填那个**页面目录** → 先**推送前体检**把 error 清掉 → 再**装配预览**看效果。
4. **推**（左树）：鼠标移到那一行，点行尾出现的 **↑** → 在确认弹窗里核对命令 → 执行；成功后该行自动变成 `✔ 已推送`，
   不必再去别的页签记账。也可以到「工程脚本」页签手跑任意 `source-*.js`（6 个常用脚本有快捷入口），
   但那条路不会自动记账 —— 跑完要回树里点一次 ↑。
5. **拉**（项目树）：对 `pages` / `apis` / `databases` 目录点 **↓ 下拉**，或对 32 位 UUID 项目目录点 ↓ 下拉做克隆；
   确认后执行（**会覆盖本地文件**），成功即清空推送账本 —— 接着点**重扫推送状态**看最新账目。

体检 → 预览 → 推送（并自动记账）是一个闭环；跳过第 3 步直接推，出了问题就得回到体检里找。

---

## 7. 可直接拿去试的路径与脚本

都在已注册工作区 `D:\project\PythonWorkSpace\AI学习\MagicalCoder平台插件话` 之内，**现在就能填**：

| 用途 | 路径 | 预期 |
| --- | --- | --- |
| 项目树 / 推送状态 / 工程脚本 | `…\MagicalCoder平台插件话\.dsh-verify\proj` | 7 个条目；推送状态 4 项、`PROJECT_UUID 0123456789abcdef0123456789abcdef` |
| 干净页面 | `…\proj\pages\home` | 体检 0 条；装配预览有产物、page uuid `mc-test-page-0001` |
| 故障样本页面 | `…\proj\pages\lint-demo` | 体检 8 条（6 error + 2 warn）；装配预览后打开是白页 |
| 接口目录 | `…\proj\apis\getList` | 体检走接口分支 |
| 工程脚本 | 路径 `…\proj` + 脚本名 `source-hello.js` | `成功（exit code 0）` + `hello from source script` |
| 运行前预检 | 同上，但把 `…\proj\.env` 里的 `USERNAME` 删掉 | 不弹执行确认，页签里显示「⚠ 环境变量未维护」+ **去维护环境变量**（0.2.14） |

你真正的工程（WMS 那套页面）在 `D:\project\PythonWorkSpace\AI学习\magicalcoder_ai\localdev` 下，但那个根**还没登记成工作区**，填了会报 `path-outside-workspace`；先在侧边栏「工作区」里点**添加工作区**选 `…\magicalcoder_ai\localdev` 即可。

---

## 8. 常见报错对照表

| 面板上看到的 | 含义 | 怎么办 |
| --- | --- | --- |
| `path-outside-workspace` | 该路径不在任何已注册工作区内 | 先在 DSH 里把它的**根**登记为工作区 |
| `not-found` | 路径不存在（例如工作区根已被删除） | 检查路径，或去工作区列表删掉失效的那条 |
| `forbidden` | 没有访问权限（EACCES/EPERM） | 检查目录权限，或换个位置 |
| `not-a-page-or-api` | 体检时该目录既无 `page.json` 也无 `meta.json` | 把路径指到真正的页面目录或接口目录 |
| `script-not-allowed` | 脚本名不在 `source-*.js` 白名单内 | 用工程自己的 `source-xxx.js` |
| `script-not-found` | 从传入目录一路到工作区根都没有这个脚本（0.2.12 起错误里会写明应放的位置） | 把 `source-xxx.js` 放到工作区根，或放到路径框里填的那一层 |
| 「⚠ 环境变量未维护」（不是报错，是**没执行**） | 脚本所在那层 `.env` 缺 `SERVER_URL` / `USERNAME` / `PASSWORD` / `PROJECT_UUID`（0.2.14） | 点提示里的**去维护环境变量**把这几个键补上再运行 |
| 导入预设返回 409 | 已存在同名预设 | 换一个标识符再导 |
| 导出预设返回 404 | 没有这个预设 id（0.2.0 起内置预设也能导出，旧的 403 分支已删除） | 用「设置 → Agent 预设」里看到的那串 id 再试 |
| 「主机侧 RPC 不可用」 | 客户端拿不到 host 的 RPC 句柄 | 多半是 host 半边没加载成功（`dsh --profile <p> --dump-config` 里查有没有 `- id: dsh-magical-lowcode-project`） |

---

## 附：这份文档对应的源码位置

| 内容 | 位置 |
| --- | --- |
| 面板 UI 与按钮文案 | `lib/client.js`（`TreeTab` / `PushTab` / `PreviewTab` / `ScriptTab` / `PresetTab`；左右栏布局与 `BROWSER_CSS`、右栏页签表 `DETAIL_TABS`、面板外壳 `Panel` 都在文件末尾） |
| 12 个 RPC 的实现与白名单/上限 | `lib/index.js`（`class DesktopProjectService`，方法清单见文件末尾的 `markRemote` 循环） |
| 体检规则 | `lib/index.js` 的 `projectLint` |
| 两条预设路由 | `lib/index.js` 的 `apply()` 里 `connection.fetch.register` 那两段 |
