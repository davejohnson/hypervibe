# Hypervibe Companion

This package is the macOS companion described in
`docs/macos-companion-design.md`.

The current v0 slice contains:

- a SwiftUI menu bar app with project setup and removal;
- a self-contained distribution with a pinned Node.js runtime and the built
  Hypervibe server;
- a user-scoped process lock that keeps packaged and development copies from
  running simultaneously;
- per-project MCP sessions over stdio using the official Swift SDK;
- safe one-click registration of every configured project with Claude Desktop
  and Codex / ChatGPT desktop clients;
- desired resource topology from `hv_spec_get`;
- live environment health, drift identity, and service endpoints from
  `hv_status`;
- recent plan/apply activity from `hv_runs`;
- memory-only connected-app summaries and provider form metadata from
  `hv_connections_list`;
- project-scoped provider add, verify, and remove through the existing
  `hv_connect` MCP tool;
- masked runtime-variable inventory plus add and replace for deployable
  services through `hv_secrets_get` and `hv_secrets_set`;
- an app-owned project registry and disposable, strictly typed snapshot cache.

The person installing the app does not need Node.js, npm, or a separate
Hypervibe installation. The app does not read Hypervibe's SQLite database,
run a local HTTP server, or replace the Hypervibe MCP with a second server.

Connected-app summaries include only provider, scope, status, and verification
time. They are held in memory for the current app session and are not written
to the snapshot cache. Credentials entered in the connection window remain in
form memory only, are passed once to `hv_connect`, and are cleared when the
form succeeds or closes. Hypervibe performs validation, verification,
encryption, storage, and auditing.

Runtime-variable values returned to the companion are always masked and are
not written to its snapshot cache. A value pasted into the add-variable form
is held only in SwiftUI form state, passed once over the project's local MCP
session, and cleared when the form succeeds or closes. The form also supports
local `env:`, `dotenv:`, and `file:` references and server-generated values.
Removing a desired variable remains a spec/plan/apply operation so durable
configuration is not silently deleted outside Hypervibe's reconciliation loop.

## Install and connect

1. Open the architecture-specific Hypervibe DMG.
2. Drag `Hypervibe.app` to Applications and launch it.
3. Add the repository that contains the project's `.hypervibe/spec.json`.
4. Open Hypervibe Settings and select **Connect** for Claude Desktop and/or
   Codex / ChatGPT.
5. Fully quit and restart the desktop client.

Hypervibe adds one stdio MCP server entry per project. Each entry invokes the
bundled launcher with an absolute repository path, so the server resolves that
project's repo-backed spec and bindings. Existing unrelated MCP entries and
other host settings are preserved.

The host configuration files are:

- Claude Desktop:
  `~/Library/Application Support/Claude/claude_desktop_config.json`
- Codex and ChatGPT desktop clients: `~/.codex/config.toml`

Before its first edit of an existing file, Hypervibe creates a sibling file
whose name ends in `.hypervibe-backup`. Removing a project from the companion
also removes that project's Hypervibe-managed entries.

## Develop

Run the tests:

```sh
swift test --package-path apps/macos
```

Build the menu bar executable and launcher:

```sh
swift build -c release --package-path apps/macos
```

Run it during development:

```sh
swift run --package-path apps/macos HypervibeCompanion
```

Development builds do not contain the server bundle. When adding a project to
a development build, configure:

- the repository that contains its `.hypervibe/spec.json`;
- an absolute Hypervibe executable path;
- one process argument per line when the executable is a runtime such as
  `node` (for example, the absolute path to this repo's `dist/index.js`);
- `HYPERVIBE_DATA_DIR` only when that project does not use the default.

An opt-in live integration test can verify a local project without putting
machine-specific paths into the test suite:

```sh
HYPERVIBE_COMPANION_TEST_REPO=/absolute/project/path \
HYPERVIBE_COMPANION_TEST_EXECUTABLE=/absolute/node/path \
HYPERVIBE_COMPANION_TEST_ARGUMENTS=/absolute/hypervibe/dist/index.js \
swift test --package-path apps/macos --filter HypervibeMCPClientLiveTests
```

## Build the installer

Build an ad-hoc-signed DMG for the current Mac architecture:

```sh
./scripts/build-macos-installer.sh
```

The artifact is written to `build/macos/`. The build downloads a pinned
Node.js 22.17.1 archive from nodejs.org, verifies its SHA-256 checksum, installs
production dependencies with that runtime, builds the Swift executables, and
signs the complete bundle. Build Apple Silicon and Intel artifacts on matching
Mac architectures; cross-architecture packaging is intentionally rejected.

For a public artifact, provide a Developer ID identity and a `notarytool`
keychain profile:

```sh
CODESIGN_IDENTITY="Developer ID Application: Example (TEAMID)" \
NOTARY_PROFILE="hypervibe-notary" \
./scripts/build-macos-installer.sh
```

The script uses hardened runtime signing, submits the DMG for notarization,
and staples the result. Signing and notarization credentials stay in the
developer's keychain and are never stored in the repository.
