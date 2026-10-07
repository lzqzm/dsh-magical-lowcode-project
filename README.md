# dsh-magical-lowcode-project

> A DeepSeek Harness plugin: **low-code project mode** — manage a MagicalCoder-style low-code project right inside your DSH workspace.

Project file tree, push status, project scripts, page preview assembly, pre-push lint, and Agent preset (`.dshpreset`) import/export — all in a panel that ships with the plugin.

This is a **host + client** plugin: the host half exposes 12 RPCs and 2 HTTP endpoints, and the client half renders its own panel in the DSH Web UI. It **patches no `@deepseek-ai/*` core package**.

---

## What it solves

A MagicalCoder-style low-code project follows a set of conventions: pages are a `page.json` + `index.html` + `page.js` trio, APIs live in `meta.json`, project scripts are named `source-*.js`, a page must contain a `magicalDragScene` container, and platform calls should go through the `/magical_lowcode/openapi/` prefix.

In a plain editor these conventions live in your head. This plugin turns them into:

- a **visible project tree** (one directory level + files, with push-status marks)
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

Package limits: ≤16 MB compressed, ≤32 MB uncompressed, ≤12 MB per file, ≤512 files. Absolute paths, `..` traversal, backslash paths, and symlinks are rejected. Only `trust === "user"` custom presets can be exported.

### Web panel (client half)

A panel inside the DSH Web UI with five tabs:

- **Project tree** — browse the project, rename/delete entries, read files and edit them in place
- **Push status** — see at a glance what changed but has not been pushed; mark pushed, reset, set a display project name
- **Preview & checkup** — assemble a sandbox preview (opens in a new tab), run the lint and list problems
- **Project scripts** — run a `source-*.js` from the workspace root with arguments, echoing exit code, command and output
- **Preset packages** — export/import `.dshpreset`

Plus a sidebar shortcut (a floating copy of the same panel).

## Install

Search for `dsh-magical-lowcode-project` in DSH's **Settings → Plugin Market**, or install manually:

```bash
dsh plugin --profile web add dsh-magical-lowcode-project
```

## Compatibility

- Host: `engines.dsh = ">=0.1.0-rc.5 <0.2.0-0"` (developed against `@deepseek-ai/dsh-*` `0.1.5-rc.2`, verified on a `0.1.5-rc.1` host)
- Node.js: `^22.19.0 || >=24.0.0`
- Platforms: Windows / macOS / Linux

The `<0.2.0-0` upper bound is deliberate: 0.2.x is unverified. The plugin market reads `engines.dsh` before installing and refuses an out-of-range host instead of installing a broken plugin.

Core packages (`@deepseek-ai/dsh-agent-presets`, `@deepseek-ai/dsh-typert-protocol`) are declared as `peerDependencies`, so the plugin reuses the host's copy instead of installing a second instance.

## Permissions and safety boundaries

- File access is **limited to registered workspaces**; paths are normalized before the prefix comparison and anything outside is refused
- Script execution is whitelisted to `source-*.js` directly under the workspace root, run with the host's own node (`shell: false`); stdout is aborted past 400 000 characters and output is truncated to 20 000
- Push state is written to `$DSH_HOME/project-push-state.json` (read migrates from the legacy path once)
- **The host half makes no outbound network requests**; the HTTP endpoints ride DSH's own authenticated connection channel
- ⚠️ **The preview page does reach out**: the HTML assembled by `projectAssemblePreview` contains
  `<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>`, so opening that
  preview in a browser requests jsdelivr. This is inherited verbatim from upstream DSH Desktop and is disclosed here.

## Development

There is no build step: both halves are authored artifacts, so edit `lib/index.js` / `lib/client.js` directly.

```bash
# npm test chains two checks (zero dependencies; CI and prepublishOnly run the same command)
npm test
#  1) test/verify.mjs            static self-check: manifest / compatibility literals / both halves'
#                                export contracts / slot registration discipline / specifier allow-list /
#                                12-RPC declare-define-reach consistency / locales
#  2) test/client-stub-check.mjs client logic stub check: really EXECUTES the bundle's factory and
#                                apply() with a stub require + stub ctx, asserting the $mount
#                                contribution and both slot registrations
```

The stub check closes a gap: `verify.mjs` only reads bytes, and the browser check cannot run where a
browser cannot launch — while the stub check needs neither a browser nor a network, and also covers
`apply`'s degradation branches (does it exit cleanly when `remote` / `slots` are missing).

`prepublishOnly` runs the same two steps, so a publish cannot skip them.

Check the installed copy (does it still import once inside a profile?):

```bash
node test/installed-check.mjs <profile>/node_modules/dsh-magical-lowcode-project
node test/installed-check.mjs --from-profile <profileDir>
```

Browser check for the client half (the only check that proves `apply()` really ran in a browser):

```bash
node test/browser-check.mjs "http://127.0.0.1:<port>/?token=<token>"
```

It drives a headless Chromium against a live UI and asserts that `__DSH_BOOT__` carries this
plugin's boot row, that the sidebar shows the button this plugin registers
(`title="低代码工程模式"`), and that no runtime error mentions the plugin.
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
