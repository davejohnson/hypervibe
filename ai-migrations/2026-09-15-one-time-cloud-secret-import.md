# One-time hosted secret import

User requirement: retrieve contributed credentials once into the user's project,
without involving the model in values or retaining repeatable server access.

The application-owned importer reuses encrypted connections, Git/spec identity,
env-file ignore checks and dotenv parsing. CLI and MCP share one write command,
`hv_cloud_secrets`. Reporting enrollment remains separate. See
`docs/cloud-secret-import.md` and the delegated-secret architecture section.

Assumptions challenged: receiving HTTP success does not prove a durable local
write, and a failed completion receipt does not mean no file was written.
Counterexample: inject SQLite receipt failure after rename; retry initially
failed on the newly populated key. Persisting a planned file digest alongside
encrypted recovery values makes that retry finish without fetching or replacing
values. The regression was observed failing, then passing. Initial new-module
failures were scaffolding red tests, not reproduced pre-existing product bugs.

Verification covers actual local persistence and command boundaries with
synthetic network fixtures. Companion hosted tests cover the server. Neither
establishes live provider validity or a deployed end-to-end handoff. No release,
MCP runtime change, production mutation, or secret invitation was performed.
