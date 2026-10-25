# Install Hypervibe for your coding agent

Run one command for your agent. You need Node.js/npm and the selected agent;
you do not need to install the Hypervibe CLI globally.

```sh
npx -y @hypervibe/hypervibe@latest install codex
npx -y @hypervibe/hypervibe@latest install claude
npx -y @hypervibe/hypervibe@latest install opencode
```

Each command installs the same packaged Hypervibe skill for your user and
registers the MCP server. The registered command pins `@hypervibe/hypervibe` to
the installer's exact package version, so the skill and server start from the
same release. Restart your agent after installation. Setup does not start a
server, restart your agent, approve tools, or authenticate cloud providers.
Project and managed settings can override user settings.

If the Hypervibe companion app or another installation already manages your
MCP connection, add only the skill:

```sh
npx -y @hypervibe/hypervibe@latest install codex --skill-only
```

Replace `codex` with `claude` or `opencode` as appropriate. `--skill-only` does
not invoke the client, inspect its MCP configuration, or register another
server. It does not require the client executable on PATH.

For a read-only check, append `--check` to `--skill-only`. The command returns
versioned JSON with `current`, `missing`, `updateAvailable`, `modified`, or
`unavailable` status; it does not create directories, invoke the client, or
change MCP configuration. The macOS companion uses this same installer through
its bundled launcher to install/check Codex guidance, without an npm download.

## Client contracts

| Client | Skill installed for this user | MCP registration |
| --- | --- | --- |
| Codex CLI | `~/.agents/skills/hypervibe/` | Native `codex mcp list --json` preflight, then `codex mcp add`; honors `CODEX_HOME` through the client |
| Claude Code | `~/.claude/skills/hypervibe/` | Native `claude mcp add --scope user --transport stdio`; honors `CLAUDE_CONFIG_DIR` |
| OpenCode V1 | `~/.config/opencode/skills/hypervibe/` | Preserving JSON/JSONC edit of user configuration at `mcp.hypervibe` |
| OpenCode V2 | `~/.config/opencode/skills/hypervibe/` | Preserving JSON/JSONC edit of user configuration at `mcp.servers.hypervibe` |

Claude's custom config directory also becomes its skill root. OpenCode honors
`XDG_CONFIG_HOME` for both paths. Its `OPENCODE_CONFIG`, project configuration,
inline configuration and managed policies can override this global setup; the
installer does not edit those higher-precedence sources. OpenCode's major
version is read from `opencode --version`; unrecognized versions stop without
writing configuration. Claude Desktop and other MCP clients are not installer
targets.

The skill files come from `skills/hypervibe/` in the installed package, resolved
relative to the installer rather than the current repository. No consumer
`AGENTS.md`, `CLAUDE.md`, project files, or tool-approval settings are rewritten.
Installing a skill makes it discoverable; whether an agent selects it remains
a client/model behavior. MCP instructions and tool results also carry the
relevant product guidance.

## Preservation and retries

An identical installation succeeds without rewriting the existing server or
skill. To upgrade, rerun the same `npx ...@latest install <client>` command and
restart the agent. The installer replaces a previous release only when its
receipt still matches the installed skill hash and binds the MCP client,
configuration path and exact pinned launch command. The skill is staged before
replacement; the MCP upgrade changes only the package-version argument. User
environment variables, extra client options, comments and unrelated settings
remain intact. Skills installed with `--skill-only` can be upgraded the same
way without touching MCP.

Foreign servers, changed launch commands, disabled entries, edited skills,
symbolic-link skill targets, malformed configuration and duplicate JSON keys
stop setup. A matching command without an ownership receipt does not authorize
an upgrade. To retain a companion-managed runtime, use `--skill-only`. To
replace an older manual installation deliberately, preserve its settings and
move the old skill outside the client's skill directories first; remove only
its `hypervibe` MCP entry through the client before running this installer.

Claude owns first-time JSON registration and refuses duplicate user entries.
The installer reads only the exact user configuration for preflight and
persistence checks; it does not run Claude's server health probes. Codex owns
first-time TOML registration; the installer checks the native JSON listing
before and after adding or upgrading the server. Owned upgrades use JSONC and
TOML parsers to change the one package argument in place, without removing the
entry or passing environment secrets through subprocess arguments.
For OpenCode, Microsoft's pinned `jsonc-parser` edits only the missing entry,
preserving comments, trailing commas, unrelated servers and permissions. It
stops when both global `opencode.json` and `opencode.jsonc` exist rather than
choosing an owner for the new entry. An existing file is rechecked before an
atomic replacement; concurrent external edits are not a supported workflow.

All skill validation and staging happen before MCP writes. If a later failure
prevents the skill commit, a file-based MCP change is rolled back only while
its current contents still match this installation's write. The command
reports incomplete setup if rollback fails or native first-time registration
already succeeded. It never claims that a configuration write
proves a successful MCP connection or deployment. Child process output and
configuration contents are not printed, because they may contain credentials.

## Evidence and limits

The challenged assumption was that registering a server alone distributes
Hypervibe's workflow, and that one client's registration command applies to
other clients. A successful Claude-only registration with no installed
`SKILL.md`, and OpenCode V2's different MCP nesting, are concrete
counterexamples.

Before runtime changes, the subprocess/configuration regressions failed for
all three default installs: Claude reported success but no skill existed;
Codex and OpenCode returned unsupported-argument errors. The three skill-only
regressions also failed. Six managed-upgrade regressions subsequently failed
before receipt-based upgrade support was added. After implementation all 50
installer regressions passed (65 with neighboring entrypoint/CLI tests). They
exercise actual spawned executable fixtures, temporary user
configuration, preserving JSONC edits, repeat/conflict behavior, missing
clients, output safety, skill-only behavior, owned upgrades preserving options,
modified/foreign installation refusal, guarded rollback after a concurrent
skill edit, and a compiled package layout run
from an unrelated directory without infrastructure state. These are synthetic
client fixtures in the ordinary `npm test` gate, not live agent compliance
claims.

On 2026-10-24, the candidate installer was also run against actual Claude Code
2.1.296 and Codex CLI 0.164.0 on macOS, with isolated temporary user/config
homes. First and repeated installs succeeded, retained an unrelated MCP
entry, preserved configuration bytes on repetition, installed the skill,
pinned the server version, and did not create Hypervibe state. No server was
started and no real user configuration was changed. A separate real Codex
probe inside a trusted temporary project confirmed that `mcp list --json`
reported the user-level servers rather than that project's MCP entries.

Both real clients also completed an owned upgrade from a temporary candidate
package labeled `0.0.1` with an older skill to the current candidate. The only
configuration change was the package argument; an added user environment
setting and unrelated entries remained intact, the skill updated, repetition
changed no configuration bytes, and no Hypervibe state was created. This is a
simulated prior installer release, not a claim about upgrading every previously
published manual installation.

OpenCode V1 1.19.4 was additionally acquired through `npm exec` in a temporary
cache, with isolated XDG configuration/data/state and an unrelated working
directory. Native `debug skill` discovered the full canonical Hypervibe skill;
`mcp list` connected to a diagnostic MCP endpoint using the installer's V1
configuration shape. Its initialize identity was `opencode` version `1.19.4`.
No real user configuration, provider credentials or model requests were used.
OpenCode V2 compatibility remains checked against documented schemas and
synthetic subprocess fixtures, rather than a V2 runtime. Native
Windows/Linux execution, client skill selection, model instruction adherence,
MCP connectivity and provider lifecycle behavior remain unverified by this
installer suite. Native Windows MCP launch commands use `cmd /c npx`; this
launcher shape alone is not Windows compatibility evidence. The npm `latest`
tag includes these changes only after a package release.

Official contracts:

- [Codex MCP configuration](https://developers.openai.com/codex/mcp) and
  [skill locations](https://developers.openai.com/codex/skills).
- [Claude user-scope MCP registration](https://code.claude.com/docs/en/mcp),
  [configuration locations](https://code.claude.com/docs/en/settings), and
  [personal skills](https://code.claude.com/docs/en/skills).
- [OpenCode V1 MCP](https://opencode.ai/docs/mcp-servers/),
  [V1 configuration precedence](https://opencode.ai/docs/config/), and
  [skill directories](https://opencode.ai/docs/skills/).
- [OpenCode V2 MCP nesting and defaults](https://opencode.ai/v2/docs/mcp-servers/)
  and [V2 global JSON/JSONC configuration](https://opencode.ai/v2/docs/config/).
- [Microsoft JSONC parser and edit API](https://github.com/microsoft/node-jsonc-parser)
  and [TOML parser AST/range API](https://github.com/ota-meshi/toml-eslint-parser).
- [Node Windows command launching](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).
