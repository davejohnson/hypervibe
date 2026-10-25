# Delivering Hypervibe guidance to coding agents

Hypervibe users do not inherit this repository's `AGENTS.md`. Product behavior
therefore travels through four independent surfaces: the packaged consumer
skill, MCP startup instructions, tool descriptions, and contextual tool results.
The application constructs supported prefilled URLs; the agent presents those
URLs intact. See [form contracts and evidence](connection-form-links.md).

`skills/hypervibe/` is the canonical consumer workflow. It contains no dependency
on Hypervibe's development checkout. The [npx installer](agent-installation.md)
copies it to each client's supported skill directory and registers the matching
MCP release. Skill availability alone does not prove the model will select it.
Existing MCP-only clients retain their tools and receive product guidance even
without installing a skill.

## Startup profiles retain capabilities

| Client | Initialize instructions | Additional guidance |
| --- | --- | --- |
| Codex | Complete instructions; no artificial 2,048/4,096 limit | Native skill, tool results, full resource |
| Claude Code 2.1.296 and later | Authored summary within 4,096 characters | Native skill, tool results, full resource |
| Older Claude Code or an unknown Claude version | Authored summary within 2,048 characters | Native skill, tool results, full resource |
| OpenCode and other clients | Complete instructions | Installed skill where supported, tool results, full resource |

[Claude documents the version-dependent truncation limits](https://code.claude.com/docs/en/mcp#tool-search-for-mcp-server-authors).
The server selects the summary using MCP `clientInfo`, and changes only the
initialize receipt's instructions. It does not remove tools, alter permissions,
truncate sentences, or limit the application's features. Every profile exposes
`hypervibe://guidance`, containing the complete instructions.

No small Codex limit was established by the reviewed official contract; sending
the full text is not a claim of unlimited model context. [OpenCode V2 documents
server-instruction injection](https://opencode.ai/v2/docs/mcp-servers#server-instructions);
that behavior must not be assumed for every OpenCode V1 build. The installed
skill and contextual results provide additional delivery paths.

## Native packages

`npm run build` generates version-matched packages under `dist/agent-plugins/`:

- Codex: `plugin.json`, `mcp.json`, `skills/`, and a `${PLUGIN_ROOT}` launcher.
- Claude Code: `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`, and a
  `${CLAUDE_PLUGIN_ROOT}` launcher.

These follow the distinct [Codex plugin contract](https://developers.openai.com/plugins/build/plugins)
and [Claude plugin contract](https://code.claude.com/docs/en/plugins/components).
Both launch the exact matching npm release through `npx`, retaining the client's
working directory. The generated packages are bundled with npm; generating them
does not publish a marketplace listing. The direct npx installer is the default
path and also serves clients without native plugin support. OpenCode receives
its supported skill/configuration layout, not a fictitious shared plugin format.

The macOS build bundles the canonical skill with its server. Codex Connect
installs missing or owned outdated guidance through the bundled launcher's
skill-only mode, with separate read-only status and an explicit update control.
Custom guidance is preserved. For other existing companion-managed connections,
`install <client> --skill-only` adds the skill without registering a second
server. Claude Desktop receives MCP guidance and has no invented skill path.

## Evidence and acceptance boundaries

The challenged assumption was that one long MCP startup message reaches every
agent intact. The concrete counterexample was a startup message exceeding Claude's
documented 2,048/4,096-character limits. Four initialize
regressions failed before the profile implementation; afterward all seven
profile cases passed, retaining the complete tool surface and full resource.

The package regressions first failed because the native package generator and
published skill were missing. The passing tests execute generated launchers,
verify version matching and inherited working directory, and inspect npm's
payload. `src/__tests__/packaged-mcp.test.ts` separately compiles current sources,
packs/extracts them, and launches the real stdio server from an unrelated
repository with isolated Hypervibe state. It verifies client profiles, metadata,
tool parity, fresh-repository bootstrap, and contextual links in both output
representations. Its SDK clients simulate identities; they are not real model
evaluations. The reusable check is:

```sh
node scripts/smoke-mcp-package.mjs /absolute/path/to/installed/package
```

These regressions run in ordinary `npm test`. The committed acceptance workflow
and desired acceptance commands both include `npm test`; this is not proof of
live branch-protection enforcement. Authenticated provider form behavior,
Windows execution, and universal model adherence remain separate evidence.

The isolated PR was checked separately from concurrent provider work. Its
connection regressions produced 30 failures against the baseline before the
runtime port, then 161 passing tests across four focused files. Installer and
native package generation checks passed 60 tests; server and extracted-package
checks passed 27 tests. The macOS Swift suite passed 66 tests in 12 suites.
These are focused receipts, not a clean full-suite or publication claim.

Earlier broader testing of the shared development checkout included a local
Python/Expat loading error in iOS tests and Railway/GCP failures in concurrent
work. Those observations are not evidence that this isolated change causes or
fixes those failures. Publication still requires the ordinary clean release gate.

On 2026-10-24, real Claude Code 2.1.296 reported `clientInfo.name=claude-code`;
real Codex 0.164.0 reported `clientInfo.name=codex-mcp-client`. Claude's native
plugin loader discovered the generated Hypervibe manifest and
`hypervibe:hypervibe` skill in an isolated configuration. These observations
validate client identity and discovery, not automatic skill selection for every
request.

Real OpenCode V1 1.19.4, acquired via temporary `npm exec`, also loaded the
canonical skill with `debug skill` and connected to a diagnostic MCP server
using the installer's documented V1 configuration. Its actual initialize name
was `opencode`. All XDG paths and the application directory were temporary; no
model or provider access occurred. OpenCode V2 native loading remains untested.

The same Claude version also loaded the pristine generated launcher under an
isolated restricted startup: its plugin MCP connected, `${CLAUDE_PLUGIN_ROOT}`
resolved correctly, the launcher called `npx -y @hypervibe/hypervibe@0.1.43 mcp`,
and the unrelated application's working directory was retained. A fake `npx`
served a diagnostic MCP endpoint, with loopback-only model configuration, so
this validates native package wiring without claiming a live model or provider
run. Native strict manifest validation passed.

A real Codex 0.164.0 model run used only the local Hypervibe connection tool and
empty temporary state, with the prompt: “Use Hypervibe to help me connect GitHub
access for acme/storefront. I have no credential available yet. What do I need
to do next?” Initially it fetched generic discovery twice and rewrote token
labels itself. That counterexample led to explicit contextual-call guidance in
startup text, the skill, the tool description, and discovery results. Two new
MCP regressions failed before the description/result correction.

Repeating the same prompt after rebuilding called
`hv_connections({provider:"github",scope:"acme/storefront"})` directly. The
response led with the exact prepared token link and preserved all four emitted
GitHub links, including descriptions identifying `acme/storefront` and the
fine-grained owner. No credential or connection was created. The evaluation
used automatic approval review because the first noninteractive session's
never-approve policy prevented the tool call. This is one successful model run,
not a guarantee that every model/client will always preserve a URL. Claude and
OpenCode model-response adherence have not been established by these checks.

Development instructions remain separate: the shortened root `AGENTS.md` links
to mandatory topic guidance, `CLAUDE.md` imports it, and the
[migration audit](development-guidance-migration.json) maps all 129 baseline rules
to preserved text and records two form-guidance additions separately. Consumer installers never copy or rewrite those files in a
user's application repository.
