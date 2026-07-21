# Hypervibe macOS Companion

**Status:** Rev 5, v0 status, self-contained onboarding, and provider connection management implemented
**Shape:** A menu bar app in `apps/macos/`. Chat remains the control plane. The app provides ambient status, resource topology, notifications, and plan review.

Rev 4 deliberately removes the companion read-model database. Hypervibe already has authoritative repo specs, local history, bindings, and live provider observation. The app should ask Hypervibe for those views through its existing local MCP process, retain only a small disposable cache, and never become another infrastructure state owner.

## Product boundary

The companion answers:

- Which projects on this Mac should I watch?
- What services and resources does each environment intend to have?
- Which provider is each resource on?
- Which external apps and providers are connected locally?
- Is the last live observation current, in sync, drifted, blocked, partial, or failed?
- What recent plan or apply needs attention?
- How do I make this project's Hypervibe MCP available to Claude or Codex
  without separately installing Node.js or editing configuration files?

It does not:

- edit desired state;
- mutate provider resources directly;
- read Hypervibe's SQLite schema;
- store infrastructure bindings, specs, credentials, or secret material as authoritative state;
- replace chat for lifecycle decisions;
- invent progress that Hypervibe has not reported.

## State ownership

| State | Owner | Companion behavior |
|---|---|---|
| Desired infrastructure | `.hypervibe/spec.json`, with SQLite as local cache/history | Read through Hypervibe |
| Provider identity bindings | `.hypervibe/bindings.json` and current local state | Read through Hypervibe |
| Live infrastructure | Provider APIs observed by `hv_status` / `hv_plan` | Display the latest response with freshness |
| Plans, runs, receipts | Hypervibe SQLite | Read through `hv_runs` |
| Credentials and encrypted plan inputs | Hypervibe secret/plan storage | Accept only in an in-memory form, send once to `hv_connect`, then discard |
| Repositories watched on this Mac | Companion app | Store repo bookmarks/paths |
| UI preferences and acknowledgements | Companion app | Store locally |
| Last sanitized UI snapshot | Companion app | Disposable cache only |

The companion cache can always be deleted and rebuilt. Losing it must not change infrastructure or prevent Hypervibe from operating.

## Architecture

```text
┌───────────────────────────────────────┐
│ Hypervibe Companion (SwiftUI)         │
│                                       │
│ ProjectRegistry                       │
│ - repo path                           │
│ - Hypervibe executable                │
│ - optional HYPERVIBE_DATA_DIR         │
│ - refresh preferences                 │
│                                       │
│ SnapshotCache                         │
│ - strict, sanitized app models        │
│ - timestamps / errors                 │
│ - notification acknowledgements       │
│                                       │
│ McpClient                             │
│ McpHostConfigurator                   │
└──────────────────┬────────────────────┘
                   │ bundled launcher, stdio
                   │ cwd = configured repo
                   ▼
┌───────────────────────────────────────┐
│ Existing Hypervibe MCP + Node runtime │
│ bundled inside the app                │
│ hv_upgrade / hv_spec_get / hv_status  │
│ hv_runs / hv_connections_list         │
│ hv_connect (connection management)    │
└───────────────┬───────────────┬───────┘
                │               │
                ▼               ▼
      repo spec/bindings   local DB + provider APIs
```

There is no companion server, listening port, shared companion database, projection, trigger, or startup rebuild.

The distributed app launches its bundled Hypervibe executable over stdio using
a bundled, pinned Node.js runtime. Each project session uses that project's
repository as `cwd` and its configured `HYPERVIBE_DATA_DIR`, if any. The
launcher and repo arguments are absolute paths; nothing is resolved through a
GUI process's assumed shell `PATH`, and the app never runs `@latest`.

Source-tree development builds retain the explicit executable and argument
fields for local testing. A distributed build automatically migrates existing
companion project entries to its bundled launcher.

## Distribution and MCP-host onboarding

The shipping artifact is a conventional drag-to-Applications DMG. The app
bundle contains:

- the SwiftUI companion;
- a small native `hypervibe-mcp` stdio launcher;
- the built, existing Hypervibe TypeScript server and production dependencies;
- a pinned Node.js runtime and its license;
- Hypervibe and included dependency licenses.

The launcher changes to the configured project root, applies an explicit
`HYPERVIBE_DATA_DIR` when present, and then replaces itself with the bundled
Node/server process. It does not proxy MCP messages, listen on a port, add
lifecycle behavior, or write to stdout before the MCP handshake.

The companion holds a user-scoped advisory process lock for its lifetime.
Launching another packaged or development copy activates the existing process
and exits before showing a second menu bar item.

From Settings, a user can connect all registered projects to:

- Claude Desktop via
  `~/Library/Application Support/Claude/claude_desktop_config.json`;
- Codex and ChatGPT desktop surfaces via `~/.codex/config.toml`.

The configurator merges Claude's JSON and uses UUID-scoped marked blocks in
Codex's TOML. It preserves unrelated settings, writes atomically, retains
existing file permissions (or uses `0600` for a new file), and creates a
one-time sibling backup before editing an existing configuration. Malformed
or structurally ambiguous host configuration is reported and left untouched.
Each project receives a distinct server name and explicit project-root
argument. Removing a project removes its managed entries. Desktop clients must
be fully restarted after changes.

This is onboarding around the current MCP, not a second server implementation.

## Why not read SQLite directly?

The database is an internal implementation detail. Reading it from Swift would couple releases to table and JSON layouts, expose encrypted or provider-specific payloads unnecessarily, and encourage a second interpretation of lifecycle state.

Materializing `companion_*` tables avoids some read coupling but creates a worse problem: every relevant Hypervibe write must also maintain the projection correctly. That adds migration, trigger, transaction, repair, compatibility, and failure behavior to a working MCP merely to reproduce data it already owns.

The MCP process is already the local authority and compatibility boundary. Use it.

## Companion-owned storage

The app stores only machine- and UI-specific state under its Application Support container.

### Project registry

Each entry contains:

- stable companion UUID;
- display name;
- repository root path or security-scoped bookmark;
- bundled Hypervibe launcher path (or an explicit executable in development);
- optional Hypervibe data directory;
- enabled environments, if the user narrows the default;
- refresh interval and scheduling opt-out;
- last selected environment.

The repository path is necessary because repo-backed specs and bindings are resolved relative to `cwd`. The data directory is explicit because a GUI app does not reliably inherit shell environment variables.

Adding a project validates:

1. the directory exists;
2. it is a git worktree root or can resolve to one;
3. `.hypervibe/spec.json` is present and valid, or Hypervibe can resolve the named local project;
4. the configured executable completes the compatibility handshake.

### Snapshot cache

The cache contains strict app models only:

- project and environment names;
- resource kind, name, desired provider, and relationship labels;
- observation result, drift count, blockers, warnings, and timestamps;
- recent run identifiers, kinds, terminal states, and safe error summaries;
- sanitized plan-review fields when available.

It never stores:

- specs wholesale;
- environment variable values;
- encrypted plan fields;
- connection records or credential references;
- raw provider payloads;
- database connection details;
- arbitrary run metadata or receipts.

The app may also show the provider, scope, status, and last-verification time
returned by `hv_connections_list`. Those connection summaries and the safe
provider form catalog are session-only and are not written to the snapshot
cache.

Preferences can use `UserDefaults`; repository bookmarks, registry entries, acknowledgements, and cached snapshots can use a small app-owned JSON or SwiftData store. Keychain is reserved for app secrets if the app ever acquires any; v1 should not.

## Building the UI view

The app derives its view from current Hypervibe responses rather than mirroring server state.

### Session handshake

On launch and after executable changes:

1. Start Hypervibe in the configured repo and data-directory context.
2. Complete the MCP initialize handshake.
3. Call `hv_upgrade action="status"` to confirm package/schema readiness and project resolution.
4. Call `hv_connections_list` and retain its safe connection summaries in memory only.
5. Disable refresh actions if the executable or local schema is incompatible.

### Provider connection management

Connections are explicitly project-scoped because each configured project can
use a different `HYPERVIBE_DATA_DIR` and therefore a different Hypervibe
connection store. The companion opens a short MCP stdio session in that exact
project context for each list, add, verify, or remove operation.

`hv_connections_list` returns provider guidance plus a provider-neutral
credential-field description derived from each adapter's Zod schema. The app
uses that description to render forms without provider-name branches. Older
executables that do not return field descriptions fall back to
`credentialsRef` entry.

All mutations call the existing `hv_connect` tool:

- add passes either an in-memory credentials object or a `credentialsRef`;
- verify rechecks the stored provider connection;
- remove deletes the selected provider and scope after confirmation.

Credential values exist only in SwiftUI form state and the one MCP tool call.
They are cleared on success or dismissal, never logged, cached, added to the
project registry, or written to app preferences. Hypervibe remains responsible
for validation, encryption, verification, audit history, and storage. If add
saves credentials but verification fails, the app refreshes the list, shows the
failed stored connection, and presents Hypervibe's remediation hint so the user
can replace, verify, or delete it.

### Topology

Call `hv_spec_get` and map only its summary fields:

- environment;
- hosting provider;
- services;
- database provider;
- storage names;
- domain;
- delegated-secret key names.

This is enough to render relationships such as:

```text
staging
├── api            Railway
├── worker         Railway
├── primary-db     Supabase
│   ├── used by api
│   └── used by worker
└── documents      Railway
    └── injected into api
```

The first version may infer conventional relationships from the desired spec summary. If users need exact dependency edges, Hypervibe can later expose additional sanitized summary fields from `hv_spec_get`; that is preferable to reading internal bindings.

### Live status

Call `hv_status` once per configured environment. Its response is the source for:

- verified versus unverified;
- in-sync versus drifted;
- drift actions and unmanaged resources;
- blocked connections and input requirements;
- deploy-source state;
- provider warnings.

The app records both the last attempt and the last successful response locally. A failed refresh does not make an old successful result fresh.

The UI shows **In sync** only when:

- the latest refresh succeeded;
- Hypervibe reports a verified observation;
- Hypervibe reports no drift or blockers;
- the snapshot is within the configured freshness window.

Partial, unverified, failed, blocked, and stale states are visibly non-green.

### Runs and plans

Use `hv_runs action="list"` for recent run status. Use `hv_runs action="get"` only through a strict decoding allowlist; unknown fields are discarded rather than cached.

Before chat-created plans are rendered in detail, harden the existing `hv_runs get` review response so it returns a purpose-built sanitized plan preview and omits all encrypted inputs and arbitrary provider metadata. This is the one likely MCP refinement for plan review. It should be:

- read-only;
- additive or output-hardening only;
- independent of `hv_plan` persistence and `hv_apply`;
- backed by secret-sentinel contract tests.

Do not add a companion projection to `hv_plan`. If composing the existing calls proves too slow or chat-oriented, a single read-only snapshot operation can be considered later. Its implementation must derive data on demand and must not create new state.

## Resource provider changes

The companion should show both the desired provider and any safe observed/bound identity Hypervibe returns. A resource move is not a dropdown update.

Changing a database from one service/provider to another can involve:

- a spec change;
- a new plan;
- billable resource creation;
- data migration;
- connection rewiring;
- health verification;
- destructive cleanup.

That belongs in the existing desired-state loop:

```text
chat intent → hv_spec_set → hv_plan → review → hv_apply → hv_status
```

The companion may offer **Change provider…**, but the action should copy or hand off a structured request to chat, for example:

> Move `primary-db` in `staging` from Supabase to Cloud SQL. Preserve data and show me the plan before applying.

The app never edits the database row or calls a provider directly.

## Refresh and scheduling

v0 refreshes on launch, foreground activation, and manual request.

Scheduled status in v1:

- is disclosed during onboarding and can be disabled per project;
- calls only the existing read-only `hv_status` path;
- is single-flight per environment;
- has global concurrency and timeout limits;
- uses jitter and exponential backoff;
- pauses in Low Power Mode and below a configurable battery threshold;
- refreshes stale projects after wake.

Notifications are based on stable app-side fingerprints of sanitized results. Notify only for:

- a new or changed drift set;
- a new failed/blocked run;
- completion of a run previously observed as active.

Acknowledgements are UI state, not infrastructure state.

## Plan review

Plans open in a detachable window.

```text
┌─────────────────────────────────────────────────────┐
│ invoice-perfect / staging · plan a1b2c3…            │
│ spec rev 14 · observed 2m ago                       │
├─────────────────────────────────────────────────────┤
│ + 2 create   ~ 3 update   – 1 destroy   ⚠ 1 gated  │
├─────────────────────────────────────────────────────┤
│ ⚠ DESTRUCTIVE — always expanded                    │
│  – database:redis · DATA-BEARING                    │
│                                                     │
│ Changes (execution order)                           │
│  1 + storage:documents                   railway    │
│  2 ~ service:api                         railway    │
│      healthcheckPath /health → /healthz             │
│      depends on: storage:documents                  │
├─────────────────────────────────────────────────────┤
│ [ Copy apply request ] [ Re-observe ]               │
└─────────────────────────────────────────────────────┘
```

Rules:

- color is never the only signal;
- destructive, data-bearing, blocked, confirm-gated, and input-required content is never collapsed;
- environment-variable diffs show key names only;
- `billable` means "may incur charges," not an estimated price;
- receipt counts report completed work only;
- the app does not reproduce apply precondition logic.

v0/v1 use a copy-to-chat handoff for apply. Native Apply is out of scope until there is evidence that the chat boundary is a usability problem. If it is ever added, server-side stale-plan and confirmation checks remain final.

## Failure model

- Hypervibe unavailable: show cached data as stale and identify the executable error.
- Repo moved: keep the registry entry, disable refresh, and prompt to locate it.
- Missing data directory: do not silently fall back to another Hypervibe database.
- MCP/tool incompatibility: keep cached review visible and disable live actions.
- Provider auth failure: show the safe Hypervibe guidance; never request a token in an app text field.
- Refresh timeout: preserve last-known status and show the failed attempt time.
- Cache corruption: delete and rebuild it.

## Security

- Direct distribution uses Developer ID, notarization, and hardened runtime.
- Local development artifacts may use ad-hoc signing, but are not suitable for
  public distribution.
- The Node archive is version-pinned and checksum-verified while packaging.
- The app does not open `hypervibe.db` or `.secret-key`.
- MCP responses are decoded into allowlisted app models; raw responses are not persisted.
- Notifications and pasteboard content contain names, plan IDs, and confirmation IDs only.
- The app never handles provider tokens or delegated-secret values.
- Logs exclude raw MCP payloads by default.
- The spawned process has the same local privileges as the configured Hypervibe command.
- MCP host configuration edits are scoped, backed up once, atomic, and never
  contain provider credentials.

## Implementation plan

| Phase | Work | MCP impact |
|---|---|---|
| **Foundation** | Swift package/app target, project registry, snapshot models/cache, process/MCP session wrapper | None |
| **v0 — Status** | Menu bar project/environment list, topology, connected apps, manual refresh, stale/error states, recent runs | Uses existing tools unchanged |
| **v0 — Distribution** | Bundled runtime/server, native launcher, signed DMG, Claude/Codex registration | Packages the existing MCP unchanged |
| **v1 — Ambient** | Scheduling, notifications, acknowledgements, power/network behavior | Uses existing read-only tools |
| **Plan review** | Detachable review window and copy-to-chat handoff | Narrow `hv_runs get` sanitization/preview only |
| **Later, only if needed** | One derived snapshot operation or native Apply | Separate reviewed decision |

The implemented v0 slice now includes Foundation, Status through manual
refresh and recent runs, and self-contained Distribution/onboarding.
Scheduling, notifications, plan review, and all mutating actions remain out of
scope.

## Acceptance criteria

- Removing the companion's Application Support directory loses no infrastructure state.
- Existing MCP tool names and lifecycle behavior remain unchanged for v0.
- A clean Mac does not require a separate Node.js or Hypervibe installation.
- Claude and Codex configuration preserves unrelated content and can be
  disconnected per managed project.
- No companion database migration or trigger exists in Hypervibe.
- `hv_plan`, `hv_apply`, startup, and provider adapters have no companion-specific code.
- Every subprocess uses an explicit repo root, executable, and data-directory context.
- Cached snapshots contain no sentinel secret, credential reference, encrypted input, or raw provider payload.
- A failed refresh never updates the last-successful freshness time.
- Provider changes hand off to spec/plan/apply instead of mutating directly.
- The existing Hypervibe TypeScript tests pass without companion-specific lifecycle fixtures.

## Settled decisions

- Keep the current MCP architecture intact.
- Bundle that MCP and its Node runtime in the distributable app.
- Configure supported desktop MCP hosts per project through a native launcher.
- No direct SQLite reads and no server-owned companion read model.
- App-owned storage tracks projects and UI state only.
- Resource topology is derived from Hypervibe's existing spec/status views.
- Infrastructure changes remain chat-driven through spec/plan/apply.
- Native Apply remains optional and deferred.
