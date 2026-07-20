# Hypervibe Companion

This package is the macOS companion described in
`docs/macos-companion-design.md`.

The current v0 slice contains:

- a SwiftUI menu bar app with project setup and removal;
- per-project MCP sessions over stdio using the official Swift SDK;
- desired resource topology from `hv_spec_get`;
- live environment health and drift counts from `hv_status`;
- recent plan/apply activity from `hv_runs`;
- memory-only connected-app summaries from `hv_connections_list`;
- an app-owned project registry and disposable, strictly typed snapshot cache.

It does not read Hypervibe's SQLite database, run a local HTTP server, or
change the Hypervibe MCP.

Connected-app summaries include only provider, scope, status, and verification
time. They are held in memory for the current app session and are not written
to the snapshot cache.

Run the tests:

```sh
swift test --package-path apps/macos
```

Build the menu bar executable:

```sh
swift build -c release --package-path apps/macos
```

Run it during development:

```sh
swift run --package-path apps/macos HypervibeCompanion
```

When adding a project, configure:

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
