# Claude Code installer

```sh
npx -y @hypervibe/hypervibe@latest install claude
```

The command installs Hypervibe's skill for your user and registers the MCP
server through `claude mcp add --scope user --transport stdio`. Node.js/npm and
Claude Code must already be available; a global Hypervibe installation is not
required. Restart Claude Code afterward to load the skill and connect MCP.

For an existing companion-managed MCP connection, install only the skill:

```sh
npx -y @hypervibe/hypervibe@latest install claude --skill-only
```

The default skill path is `~/.claude/skills/hypervibe/`. When
`CLAUDE_CONFIG_DIR` is set, it becomes `<CLAUDE_CONFIG_DIR>/skills/hypervibe/`.
Claude owns first-time registration; the installer reads the exact user MCP
entry to preserve conflicts and verify the native write. An identical install
succeeds without another registration or rewriting the skill. Rerun the same
command to upgrade an unchanged installer-owned release: receipt checks bind
the skill and exact MCP launch, then a preserving edit updates only the pinned
package argument. User environment and client options remain intact. It never edits
`CLAUDE.md`, changes tool permissions, starts the server, or restarts Claude.

See the [cross-client installation guide](agent-installation.md) for Codex and
OpenCode support, package-version pinning, preservation rules, verification
evidence, and remaining compatibility limits. These changes become available
through the npm `latest` tag only when a release includes them.
