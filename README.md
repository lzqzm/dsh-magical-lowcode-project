# dsh-magical-lowcode-project

> A DeepSeek Harness plugin: **low-code project mode** — manage a MagicalCoder-style low-code project right inside your DSH workspace.

Project file tree, push status, project scripts, page preview assembly, pre-push lint, and Agent preset (`.dshpreset`) import/export — all in a panel that ships with the plugin.

This is a **host + client** plugin: the host half exposes 12 RPCs and 2 HTTP endpoints, and the client half renders its own panel in the DSH Web UI. It **patches no `@deepseek-ai/*` core package**.

---

## What it solves

A MagicalCoder-style low-code project follows a set of conventions: pages are a `page.json` + `index.html` + `page.js` trio, APIs live in `meta.json`, project scripts are named `source-*.js`, a page must contain a `magicalDragScene` container, and platform calls should go through the `/magical_lowcode/openapi/` prefix.

In a plain editor these conventions live in your head. This plugin turns them into:

- a **visible project tree** (multi-level, expanded on demand, with inline push-status marks)
- **executable checks** (pre-push lint, encoding the mistakes we kept making as rules V1.01–V1.06)
- a **preview you can actually look at** (assemble a page in a sandbox without pushing it to the platform)
- a **push-status ledger** (which pages/APIs are in sync with the platform and which are dirty)

## Features

### Project-mode RPCs (host half, `desktopProject/*`)

| RPC | Purpose |
| --- | --- |
| `listProjectEntries` | One directory level of the project tree, restricted to a registered workspace |
| `projectPushStatus` | Scan push status (`page.json` uuid / `meta.json` id, compared against mtime snapshots) |
| `projectRunScript` | Run a project script (whitelisted to `source-*.js`) |
| `projectMarkPushed` | Mark an entry as pushed (recursively updates ancestor/descendant snapshots) |
| `projectResetPushState` | Reset all push state |
| `projectRenameEntry` | Rename an entry (retries with backoff on Windows EPERM/EBUSY, rewrites `page.json` / `meta.json`) |
| `projectSetProjectName` | Set a display-only project name (stored in `.dsh-project-names.json`) |
| `projectDeleteEntry` | Delete an entry (refuses to delete the workspace root) |
| `projectReadFile` | Read a file as UTF-8 (2 MB per file) |
| `projectWriteFile` | Write a file as UTF-8 |
| `projectAssemblePreview` | Assemble a page preview sandbox (inlines the trio + platform runtime) |
| `projectLint` | Pre-push static lint (rules V1.01–V1.06) |

Every RPC that takes a path verifies it resolves **inside a registered workspace**; otherwise it fails with `path-outside-workspace`.

### Agent preset endpoints (host half, connection-authenticated fetch routes)

| Endpoint | Purpose |
| --- | --- |
| `GET /api/agent-preset.export?agentPreset=<id>` | Export a `.dshpreset` package (ZIP with `manifest.json` + `preset/`) |
| `POST /api/agent-preset.import` | Import **preview**: validate the package and return a dry-run report |
| `POST /api/agent-preset.import?agentPreset=<id>&install=1` | Validate then **atomically install** (409 on name conflict, never overwrites) |

Package limits: ≤16 MB compressed, ≤32 MB uncompressed, ≤12 MB per file, ≤512 files. Absolute paths, `..` traversal, backslash paths, and symlinks are rejected. Since 0.2.0 both built-in and custom presets are just a declaration line in the profile patch — there is no `trust` distinction, so built-in presets can be exported too.

### Web panel (client half)

The DSH Web UI gets a **project browser**: a **persistent multi-level tree on the left**, a **detail area on
the right** (five tabs: file content / preview & checkup / push status / project scripts / preset packages),
and a shared path box plus toolbar on top. All **three entries** (settings section, sidebar overlay, session
tab) share this one browser.

- **Left · Project tree** — browse the project **multi-level** (click a directory to expand it; that level is
  fetched only then); every row carries an inline `● dirty` / `✔ pushed` mark; the row action buttons
  (**↑ push** / **↓ pull** / **✏ project name** / **view** / **📋 copy path**) appear only while that row is
  **hovered or selected**, so a resting row shows just the name and its status tag; **right-clicking** any row
  opens the full action menu (view content, copy content for the AI, pre-push lint, refresh, re-scan push
  status, edit environment config, copy absolute/relative path, rename, delete — inapplicable entries are
  greyed out instead of hidden). Clicking a file name opens it in **the right pane's “File content” tab** for
  editing and saving; a 32-char UUID project directory can be given a display name; the toolbar's
  **environment config** edits the workspace root `.env` (`SERVER_URL` / `PROJECT_UUID`)
- **Right · File content** — the editor for the selected file (save / saved / close); a browsing hint while nothing is selected
- **Right · Preview & checkup** — the “in-tree lint” results land here (right-click a row and lint switches to this tab), followed by the sandbox preview (opens in a new tab) and the lint issue list
- **Right · Push status** — see at a glance what changed but has not been pushed; mark pushed, reset, set a display project name
- **Right · Project scripts** — run a `source-*.js` from the workspace root (six ready-made shortcuts) with arguments, echoing exit code, command and output;
  before running, the host locates the script and pre-checks the four keys (`SERVER_URL` / `USERNAME` / `PASSWORD` / `PROJECT_UUID`)
  in **that script folder's** `.env` — if any is missing the tab only shows a “environment variables not configured” notice plus
  an inline editor, and the execution confirmation never appears
- **Right · Preset packages** — export/import `.dshpreset`

Both pull and push go through a **command-preview confirmation**: the exact `node source-*.js …` command is
shown first (pull carries an overwrite warning), and only then does it run. A successful pull clears the push
ledger (the local files were just overwritten from the platform); a successful push marks that target as pushed.

The **environment config** dialog reads and writes `SERVER_URL` / `PROJECT_UUID` in the workspace root `.env`:
a matching line is replaced in place (keeping its indent and `export ` prefix), otherwise the key is appended,
while comments and every other line stay untouched; values containing whitespace or `#` are quoted. When the
file does not exist yet, the dialog says that saving will create it. The script pre-check in the **Project scripts** tab
edits the `.env` of the **script folder** instead (four keys, adding `USERNAME` / `PASSWORD`) — a different file from the
workspace root `.env` (in the localdev layout the scripts sit one level above the project folder).

Three entries share the same project browser: **Settings → Low-code project mode**, the **`▤` button at the
bottom of the sidebar** (a floating copy), and a **“Low-code project” tab inside a session**
(`slot: conversation.view`, `order: 20`). The session tab is controlled by the **project-mode switch**
at the top of the panel: it is on by default, turning it off removes the tab from sessions
immediately, while the settings and sidebar entries stay put. The state lives in `localStorage`
under `dsh-magical-lowcode-project:project-mode` and syncs across panel instances and browser tabs.

UI labels follow the host language: the settings navigation name, the session tab, the sidebar
button title, the five tab names and the switch row all ship zh/en dictionaries (via
`locale.register` + `locale.bind` when the `locale` service is available, falling back to the
built-in Chinese otherwise). Long explanatory copy inside the panel is still Chinese-only.


## Install

Search for `dsh-magical-lowcode-project` in DSH's **Settings → Plugin Market**, or install manually:

```bash
dsh plugin --profile web add dsh-magical-lowcode-project
```

## Compatibility

- Host: `engines.dsh = ">=0.2.0-0"` (developed and verified against `@deepseek-ai/dsh-*` `0.2.0-rc.2`)
- Node.js: `^22.19.0 || >=24.0.0`
- Platforms: Windows / macOS / Linux

The `0.2.0` floor is deliberate: 0.2.0 changed the agent-preset model (presets are profile-patch declarations served by `@deepseek-ai/dsh-agent-preset-registry`; the old `@deepseek-ai/dsh-agent-presets` package, with its on-disk preset roots, is gone), and this release targets that model. The plugin market reads `engines.dsh` before installing and refuses an out-of-range host instead of installing a broken plugin.

Core packages (`@deepseek-ai/dsh-agent-preset-registry`, `@deepseek-ai/dsh-typert-protocol`) are declared as `peerDependencies`, so the plugin reuses the host's copy instead of installing a second instance.

## Permissions and safety boundaries

- File access is **limited to registered workspaces**; paths are normalized before the prefix comparison and anything outside is refused
- Script execution is whitelisted to `source-*.js`, resolved by walking **up from the given directory to the workspace root** (keep the scripts at the workspace root or in a project subdirectory), run with the host's own node (`shell: false`); stdout is aborted past 400 000 characters and output is truncated to 20 000
- Push state is written to `$DSH_HOME/project-push-state.json` (read migrates from the legacy path once)
- **The host half makes no outbound network requests**; the HTTP endpoints ride DSH's own authenticated connection channel
- ⚠️ **The preview page does reach out**: the HTML assembled by `projectAssemblePreview` contains
  `<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>`, so opening that
  preview in a browser requests jsdelivr. This is inherited verbatim from upstream DSH Desktop and is disclosed here.

## Development

There is no build step: both halves are authored artifacts, so edit `lib/index.js` / `lib/client.js` directly.

```bash
# npm test chains three checks (zero dependencies; CI and prepublishOnly run the same command)
npm test
#  1) test/verify.mjs            static self-check: manifest / compatibility literals / both halves'
#                                export contracts / slot registration discipline / specifier allow-list /
#                                12-RPC declare-define-reach consistency / locales
#  2) test/client-stub-check.mjs client logic stub check: really EXECUTES the bundle's factory and
#                                apply() with a stub require + stub ctx, asserting every RPC goes
#                                through the same-origin fetch envelope (POST /api/desktopProject/<method>,
#                                12 methods cross-checked verbatim and in order against the host)
#                                and both slot registrations
#  3) test/render-check.mjs      client render stub check: really RENDERS both slot components with
#                                a stub React, flipping each of the five tabs, asserting tab label
#                                order and the sidebar entry structure
```

The two stub checks close a gap: `verify.mjs` only reads bytes, while the stub checks need neither a
browser nor a network. The logic layer also covers `apply`'s degradation branches (does it exit cleanly
when `slots` is missing), and the render layer proves all five tabs actually paint.

What they cannot cover is the real loader and real clicks: the client half once failed to load in a
real browser with `descriptor.parameters is not iterable` while all three stub checks stayed green.
Only the browser check below catches that class of bug, so it is not optional.

`prepublishOnly` runs the same three steps, so a publish cannot skip them.

Check the installed copy (does it still import once inside a profile?):

```bash
node test/installed-check.mjs <profile>/node_modules/dsh-magical-lowcode-project
node test/installed-check.mjs --from-profile <profileDir>
```

Browser check for the client half (the only check that proves `apply()` really ran in a browser):

```bash
node test/browser-check.mjs "http://127.0.0.1:<port>/?token=<token>"
```

It drives a headless Chromium against a live UI, opens the sidebar entry, flips through all five tabs,
and asserts that `__DSH_BOOT__` carries this plugin's boot row, that the sidebar shows the button this
plugin registers (`title="低代码工程模式"`), that all five tabs are present and clickable, that clicking
「重置记录」 produces a real RPC to `/api/desktopProject/projectResetPushState` returning `ok=true`,
and that no runtime error mentions the plugin.
⚠️ It needs an environment that can launch Chromium; in a sandbox that refuses to start a
browser it stops at "cannot reach the debugging port".

One-off real-install verification:

```bash
# use an isolated DSH_HOME so your own live profile is untouched
npm pack
DSH_HOME=<scratch> dsh plugin --profile verify add "$PWD/dsh-magical-lowcode-project-<version>.tgz"
DSH_HOME=<scratch> dsh --profile verify --dump-config | tail -n 3     # the plugin's layer should appear
node test/installed-check.mjs --from-profile <scratch>/profiles/verify
```

> **Do not use `dsh plugin add <directory>` for development.** It goes through pnpm's `link:`, which does
> **not** install transitive dependencies, so `fflate` is missing and the top-level `import "fflate"` in
> `lib/index.js` throws `ERR_MODULE_NOT_FOUND` — and a module-level import failure in a plugin **takes down
> the whole profile**. Install the tarball produced by `npm pack`, or run `npm install` inside the plugin
> directory first.

## License

MIT. This package is a derivative work of `plugins/dsh-desktop-project` in **DSH Desktop** ([dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop), MIT, Copyright (c) 2026 DataElement): the project-mode RPCs and `.dshpreset` endpoints of the host half carry over under that MIT license, while the client half is an entirely new implementation. See `LICENSE`.
