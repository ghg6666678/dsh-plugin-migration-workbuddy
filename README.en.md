# dsh-plugin-migration-workbuddy

Migrate WorkBuddy sessions, memories, MCP drafts, and automation tasks into DSH.

The plugin works out of the box and splits the settings page into two boards:

- **Import data** (WorkBuddy → DSH): **scan → preview → explicit confirmation → import → auditable
  manifest**. Opening the page performs only a local **read-only** scan; it never copies, moves, or
  modifies WorkBuddy data.
- **Export data** (DSH → WorkBuddy): appends only what is new since a per-session watermark, offers the
  matching memories / MCP / scheduled-task boards, and refuses to write until WorkBuddy has fully
  exited.

## Compatibility

This branch targets DSH **0.2.x** (verified against `0.2.2-rc.1`). The minimum is declared in
`package.json` as `engines.dsh` (`>=0.1.2-rc.1 <0.3.0`) so DSH can validate the plugin at load time
without a per-version exemption.

Compared with v0.1.0, v0.1.1 fixes four incompatibilities with the current client:

- Converted messages are normalized for **session format v4** (assistant message sources, the
  `kind` of context snapshots); otherwise every append is rejected.
- Imported sessions are written through the **0.2 persistence handle** (`create()` returns a write
  handle and the seed prefix is declared via `inheritedEventCount`); the removed
  `sessionPersistence.append()` is no longer called.
- Write routes accept requests from the **Electron desktop shell** (`Origin: null` or absent):
  loopback peer + exact loopback Host + a bundled-client marker header, which a cross-site page
  cannot forge.
- The settings UI uses DSH **design tokens**, so it no longer renders as a bright white card in
  dark mode.

It also recognizes newer WorkBuddy session events (`session-meta`, `resend-fork-notice`,
`credit-usage`) and fixes checkbox/select-all interaction on the session and automation cards.

**v0.4.3** splits the settings page into "Import data" and "Export data" boards and adds the
DSH → WorkBuddy export direction (see the export section below).

**v0.4.4** fixes "the export board says there is nothing to export although the session clearly has new turns": the DSH 0.2.x session backends no longer expose `inspect()`, and `list()` now returns snapshots that nest the header. The export side therefore failed to read any events and every session id stringified to `"undefined"`, so all sessions rendered as empty. Reads now probe capabilities (`inspect` → `open/read` → `load`) and accept either `list()` shape.

**v0.4.5** adds the three boards the export direction was missing (memories / MCP / scheduled tasks), so the export side mirrors import one for one, and fixes the "select sessions precisely" dialog whose left workspace column was so wide the right pane was squeezed out of sight (the split now adapts to the panel's own width via a container query).

## Install

The package ships a `cordis.patch.yml` and declares itself a profile bundle through
`dsh.bundle.patch`, so `dsh plugin add` mounts it as a dependency **and** as a profile layer — no
hand-written composition row needed.

### Recommended: the Release tarball (one command, no build permission)

```bash
dsh plugin --profile <name> add \
  https://github.com/ghg6666678/dsh-plugin-migration-workbuddy/releases/download/v0.4.5/dsh-plugin-migration-workbuddy-0.4.5.tgz
```

The tarball already contains a built `lib/`: measured at **one command, ~3 seconds, exit 0**, with no
`allowBuilds` involvement, and the URL pins the version.

### From GitHub by tag (needs a build permission)

```bash
dsh plugin --profile <name> add github:ghg6666678/dsh-plugin-migration-workbuddy#v0.4.5
```

A git install fetches **sources, not built artifacts**, so this package ships a `prepare` script that
pnpm runs after install to build `lib/` from `src/`. pnpm ≥10 refuses to run it: **the first `add`
always fails** and prints a ready-to-copy allowlist key in the error. Put `allowBuilds:` plus that
exact key into the profile's `pnpm-workspace.yaml` and re-run the same `add`:

```yaml
# $DSH_HOME/profiles/<name>/pnpm-workspace.yaml
allowBuilds:
  dsh-plugin-migration-workbuddy@https://codeload.github.com/ghg6666678/dsh-plugin-migration-workbuddy/tar.gz/<commit-sha>: true
```

Two things we measured, both easy to get wrong:

- **Use the full key pnpm printed.** The bare package name
  (`dsh-plugin-migration-workbuddy: true`) does **not** work — the same error comes back.
- The key embeds the resolved tarball URL and commit SHA, so it pins the version as a side effect. If
  a later attempt prints a different key (git resolution changed), use the newest one.
- pnpm ≥10 also runs a nested `pnpm install` for a git dependency. If `pnpm` is not on PATH — the
  usual case when DSH's bundled runtime is all you have — that step fails with
  `ERR_PNPM_PREPARE_PACKAGE` and `'pnpm' is not recognized`. Run `npm i -g pnpm` (or
  `corepack enable`) and retry, or just use the Release tarball above.

That allowance is **permission to execute the package's code on your machine at install time**,
outside any sandbox. Only allow packages whose source you trust, and pin a tag or commit.

### From a local checkout

```bash
dsh plugin --profile <name> add /absolute/path/to/dsh-plugin-migration-workbuddy
```

### Packing your own tarball / publishing to a registry

```bash
pnpm pack     # produces dsh-plugin-migration-workbuddy-0.4.5.tgz (runs prepare, so it includes lib/)
dsh plugin --profile <name> add ./dsh-plugin-migration-workbuddy-0.4.5.tgz

# once published to a registry (flip package.json private to false and pick a license first)
dsh plugin --profile <name> add dsh-plugin-migration-workbuddy
```

Both forms build `lib/` at publish time, so users never need to grant a build permission.

### Turning it off

Override the row by id in your own `$DSH_HOME/profiles/<name>/cordis.patch.yml`:

```yaml
- id: migration-workbuddy
  disabled: true
```

Restart DSH and the settings page shows “Migration & backup”.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | When false the plugin never touches the disk |
| `maxFileBytes` | `0` | Per-source-file cap in bytes; `0` means unlimited. Transcripts are streamed, never buffered whole |
| `maxFiles` | `5000` | Files scanned in one pass |
| `toolMode` | `transcript` | `transcript` keeps the full tool protocol: one user request is one turn, each assistant round is one step, and a call plus its result share that step, so DSH recognizes the input/output pairing; `narrative` flattens calls/results into text |
| `maxContextTokens` | `500000` | Estimated context-token budget per imported session; older turns are dropped when exceeded (`0` = keep everything) |
| `automationModelId` | `''` | Model id written into every migrated automation rule; empty uses the deployment default |
| `automationModelAllowlist` | `[]` | Model ids carried over verbatim; everything else is rewritten to `automationModelId` with an `automation-model-remapped` loss |
| `workbuddyRoot` | `''` | Export destination root; empty = `$WORKBUDDY_HOME`, else `~/.workbuddy` |

The source root is `$WORKBUDDY_HOME` or `~/.workbuddy`; the target root is `$DSH_HOME` or `~/.dsh`.

## What moves

- **Sessions**: JSONL messages, reasoning, and tool calls/results become DSH `SessionEvent` records,
  idempotent by source SHA-256. Repeats are skipped; only changed content or metadata is replaced.
  Tool calls write both the model-facing assistant `tool-call` block and the audit event; orphan
  calls/results receive synthetic pairs that keep later turns valid and are recorded as losses. When
  the source repeats a row for the same `callId`, the converter deduplicates by call id (at most one
  `tool-call` block and one `tool/result` per call), avoiding `Duplicate tool output`. Imported
  sessions persist as a seed prefix (`isSeeded` plus an exact `inheritedEventCount`), so the runtime
  never replays imported history as live.
  The read-only `workbuddy.db` catalog separates workspace mode from session mode: workspace-mode
  sessions use their authoritative `cwd`, while session-mode sessions share
  `$DSH_HOME/workspaces/session-mode` (titled “Session mode”). Official titles prefer
  `custom_title`/`title` and are persisted as a valid `session/title` event, so the first user
  message never becomes the displayed name.
  Source deletions are respected: a session whose `sessions.deleted_at` is set is skipped entirely
  instead of being resurrected from a leftover `.jsonl`, and a session whose workspace directory is
  gone is skipped too, so deleted workspaces are never recreated. The preview status line reports the
  excluded count; the filesystem scan itself has no delete flag — the truth comes from `workbuddy.db`.
- **On-demand import**: single-click the sessions card to select/clear all importable items,
  double-click for precise selection. The picker is a workspace × session two-level drill-in — the
  left column lists workspaces (group checkboxes, per-status counts), the right column lists that
  workspace's sessions (status filter, title/path search, per-session checkboxes, loss tooltips);
  ungrouped sessions are selectable one by one. Server-side `sessionKeys`/`workspaceIds` filters run
  before conversion, and unknown selection entries become an `unknown-selection-key` audit loss
  without affecting other imports.
- **Memories**: Markdown/JSON candidates are parsed, deduplicated, and stored under
  `$DSH_HOME/migration/memory/`; `AGENTS.md` is never written and nothing is injected into the
  system prompt.
- **MCP**: only names, URLs, transports, commands, and safe args. Tokens, cookies, API keys, OAuth
  values, and credential files are never migrated; credentials must be re-established on the
  deployment side.
- **Automation tasks**: the `automations` table is read, the supported RRULE subset converts to
  cron, and rules support per-rule selection and manifest idempotency; run history and runtime state
  do not move. Model remapping follows the table above — the source model vocabulary
  (`auto`/`fast-model`/`glm-*`/`kimi-*`, …) usually does not exist on another deployment, and passing
  it through makes every rule fail at run time with an unknown model. The rule shape is the contract
  form `target: { mode: 'new-session', workspaceId }`.

### The automation channel is optional

Rules are persisted through whichever channel the deployment registers (the service name
`automationImport`; some deployments also register a compatibility alias). **The plugin is fully
usable without one**: the preview still lists automation drafts but marks them ineligible, and an
explicit automation import skips them with an `automation-channel-unavailable` loss instead of
failing the batch. Sessions, memories, and MCP are unaffected.

## Export data (DSH → WorkBuddy)

The second board writes DSH sessions back into WorkBuddy — the exact opposite direction. It is built
around one rule: **neither side's history may be lost**, so the default is append-only.

- **Watermark**: every session records a `lastSyncedEventSeq` in
  `$DSH_HOME/migration/export.json`. Only events after that seq become new JSONL rows; what was
  already exported is never rewritten.
- **Status** (recomputed from the transcript tail every time the board opens):

  | Status | Meaning | Default action |
  | --- | --- | --- |
  | `new` | never exported, or the WorkBuddy transcript is gone | create a WorkBuddy session |
  | `ahead` | DSH moved on, WorkBuddy did not | append to the original |
  | `synced` | watermark caught up | skip |
  | `workbuddy-ahead` | only WorkBuddy moved on | **write nothing**; point at "Import data" |
  | `conflict` | both sides moved on | create a new WorkBuddy session, keeping both |

  `workbuddy-ahead` is a separate state on purpose: appending there would misplace WorkBuddy's own
  continuation, while creating a session would fork the history on the WorkBuddy side. Pulling the
  new part back through the import board is the only lossless option.
- **WorkBuddy must be fully quit**: before writing, the plugin enumerates `\\.\pipe\*` for
  `workbuddy|codebuddy` named pipes (the only reliable liveness signal on this machine — `-wal` mtime
  and `CreateFileW` share probes both produced false results in testing) and requires the user to
  tick "all conversations finished, WorkBuddy fully quit". If the probe itself cannot run, export
  **fails closed**; there is no "skip the check" escape hatch.
- **Writes**: `workbuddy.db` is backed up first, then files go through temp-file + atomic replace.
  JSONL rows are chained by `parentId` with strictly increasing timestamps, so a session that sat
  idle never emits a row that sorts before its parent. Session-mode exports also upsert
  `workspaces.path`, without which the new transcript never appears in WorkBuddy's sidebar.
- **Undo**: each export records a batch (row offsets, DB effects, created session ids). "Undo the last
  export" truncates the appended rows and reclaims created sessions. Truncation keeps the watermark,
  so the next export appends that stretch again.

### Memories, MCP and scheduled tasks (export side)

Everything "Import data" can carry has a counterpart on the export board, each selected independently:

| Board | Destination | Conflict policy |
| --- | --- | --- |
| Memories | A block delimited by `<!-- dsh-migration:begin/end -->` inside `~/.workbuddy/MEMORY.md` | Only that block is replaced; your own sections are never touched |
| MCP | `mcpServers` in `~/.workbuddy/mcp.json` | An existing name is left exactly as it is and reported as a conflict |
| Scheduled tasks | The `automations` table in `workbuddy.db` | An automation with the same name counts as present and is skipped |

Each target is backed up before it is written (`MEMORY.md.dsh-backup-<batch>`,
`mcp.json.dsh-backup-<batch>`, `workbuddy.db`), and "Undo the last export" restores them together with
the sessions.

Three boundaries are worth knowing up front:

- **Credentials are never copied.** For MCP only the `env` / `headers` **key names** are kept; the
  values are dropped during parsing. A server that needs them is written `"disabled": true`, and you
  re-enter the token in WorkBuddy before enabling it — a server that is enabled but missing its
  credentials would just fail on every call.
- **Memories are filtered first.** The records the import wrote include many lines that are nothing but
  structural markers (`---`, `<!-- RAW_JSON_START -->`, `"memoryBlock": ""`, `> Version: 0`). Those are
  not exported, and the panel says how many were skipped. On this machine all 30 are of that kind —
  WorkBuddy's own `memoryBlock` is empty — so **0 pending memories is the correct answer**, not a
  read failure.
- **Scheduled tasks only translate to RRULE.** `daily` / `weekly` / `rrule` / `at` map exactly; `cron`
  has no equivalent, and `every` / `after` (fixed interval, delayed) do not exist in WorkBuddy at all.
  Those are marked "cannot convert" and skipped, so create them by hand.
- **DSH has no enumerable MCP or schedule registry.** Both boards therefore read what DSH really
  persists: the `cordis.patch.yml` files in profiles and bundles that mount
  `@deepseek-ai/dsh-mcp-client` (`serverName` / `transport` / `command` / `url`, with commented-out
  entries ignored), plus the `list()` surface of the `schedule` service. When neither exists the board
  says there is nothing to export instead of inventing data.

## Security boundaries

- Every scan is read-only, and routes require a **loopback peer with an exact loopback Host**; writes
  additionally require the bundled client's marker header. The Electron desktop shell has no normal
  http Origin, and a cross-site page cannot forge either condition.
- Preview paths pass through `sanitizePathForPreview`, and credential-shaped fields are dropped
  during parsing.
- Attachments, branches, original system prompts, and full legacy SQLite restoration are not
  supported yet. DSH has no generic physical session-delete API, so rollback is archive-and-audit.

## Development

```bash
pnpm install
pnpm run build       # tsdown (Host ESM + Client CJS) + tsc declarations
pnpm run typecheck
pnpm run test
pnpm run check       # all three in sequence
```

Artifacts land in `lib/`: `lib/index.js` for the Host half and `lib/client.js` for the Client half
(self-registering into `window.__ModuleLoader__` under the package name).

`prepare` is the install-time entry point (pnpm runs it after a git install). It is the same chain as
`build` without the directory clean, uses only this package's own devDependencies, and assumes no
monorepo context — which is what lets a git install build successfully.

## Notes

This package was put together from an earlier WorkBuddy migration implementation and re-cut as an
independent plugin: the plugin id, settings id, copy, and CSS prefixes all live in this package's own
namespace; routes are `/api/migration/workbuddy/*`; the target home follows DSH's `$DSH_HOME`
(`~/.dsh` by default); and automation rule persistence went from a required dependency to an
optional channel (see above).

The license is not decided yet (`package.json` is `UNLICENSED` with `private: true`); publishing
requires choosing a license and flipping `private` to `false`.
