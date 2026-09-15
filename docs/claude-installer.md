# Claude Code installer

The client setup command is:

```sh
npx -y @hypervibe/hypervibe@latest install claude
```

It is intended for Claude Code with Node.js and npm already available. It
delegates user-scope registration to `claude mcp add`, then exits. Restart
Claude Code and use `/mcp` to check the connection. The homepage's existing
“Get the MCP” links lead to the README quick start containing this command.

Until a package release includes the installer, users can use the equivalent
Claude command already supported by published Hypervibe releases:

```sh
claude mcp add --scope user --transport stdio hypervibe -- npx -y @hypervibe/hypervibe@latest mcp
```

## Ownership and compatibility

- Claude owns the config path, write format, and duplicate protection. The
  installer never edits a Claude JSON file directly.
- The entry is user-scoped and uses the existing published package's explicit
  `mcp` entrypoint. Project/local entries can override it according to Claude's
  scope precedence.
- A duplicate user entry exits nonzero with inspection and intentional-removal
  guidance. It does not imply that the old entry is compatible or connected.
- Missing Claude, invalid arguments, and unknown child failures exit nonzero.
  Raw child output is not printed because it can contain private configuration.
- Setup is an explicit CLI-only bootstrap exception. It does not import the
  infrastructure runtime or initialize Hypervibe state. Existing no-argument
  MCP startup and ordinary CLI commands retain their routing.
- Claude Desktop and installing Claude Code itself are outside this command.

## Evidence

The owner requested one npx command instead of manually editing MCP config.
The former setup documentation assumed a manually copied JSON block was the
installation path. [Claude's official MCP documentation](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server)
provides a supported registration command and
[user scope](https://code.claude.com/docs/en/mcp#user-scope) for cross-project use.
The Windows launcher wraps `npx.cmd` in a command interpreter according to
[Node's process documentation](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).

Before the implementation, entrypoint regression coverage observed the new
command fall into ordinary CLI parsing (1 failed, 3 passed). Afterward, 27
focused installer, entrypoint, and CLI tests passed, along with typechecking.
The subprocess tests use an explicitly synthetic Claude executable to check
arguments, exit status, no-overwrite guidance, output safety, and the absence
of eager infrastructure imports. They are included in the ordinary `npm test`
acceptance workflow; no live branch-protection claim is made.

On 2026-09-15, the actual packed candidate was installed through `npx --package`
and run against Claude Code 2.1.170 on macOS. An isolated `CLAUDE_CONFIG_DIR`
contained an unrelated MCP entry before setup. The real CLI wrote a user-level
Hypervibe entry using `npx -y @hypervibe/hypervibe@latest mcp`, preserved the
unrelated entry, and left both unchanged on a repeated installation. No
Hypervibe data directory was created. The user's real Claude configuration was
not modified.

This validates installation and preservation on that real client version. It
does not establish Windows/Linux client execution, Claude Desktop support,
provider credentials, cloud deployment success, or tool permission decisions.
The npm registry's `latest` tag will gain the installer only after a release.
