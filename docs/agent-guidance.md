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

## Verification and limits

Package regressions execute generated launchers, check version matching and the
inherited working directory, and inspect the npm payload.
`src/__tests__/packaged-mcp.test.ts` compiles and extracts the package, then
launches its stdio server from an unrelated repository with isolated state. It
checks startup profiles, metadata, tool parity, fresh-repository bootstrap and
contextual links. Its SDK clients simulate identities; they do not establish
model instruction adherence or authenticated provider behavior.

The reusable installed-package check is:

```sh
node scripts/smoke-mcp-package.mjs /absolute/path/to/installed/package
```

These checks run in ordinary `npm test`. Publication still requires the
[release gate](development/workflow.md#dg-116). Client discovery, installation,
model adherence and successful cloud deployment are separate evidence. See
[installation limits](agent-installation.md#evidence-and-limits) for recorded
native-client coverage; a passing package check does not extend that coverage.

Development instructions remain separate: root `AGENTS.md` links to current
topic guidance and `CLAUDE.md` imports it. Policy changes update those contracts;
their pull requests and Git history record prior decisions. Consumer installers
never copy or rewrite those files in a user's application repository.
