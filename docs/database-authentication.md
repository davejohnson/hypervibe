# Database authentication evidence

Database authentication is an internal verification step of the reviewed
credential lifecycle: `hv_spec` → `hv_plan scope="credentials"` → `hv_apply`.
The retained plan owns the database identity, intended replacement and affected
consumers. Authentication does not need a separate public command.

The native credential probe checks the intended replacement against the bound
role and database. Provider configuration, deployment activation and drainage,
application connection compatibility, and application operation are independent
evidence. Passing an administrative connection check never clears those gaps.
See the [rotation lifecycle](database-password-rotation.md) and
[provider matrix](../test/provider-contracts/database-password-provider-matrix.json)
for the registered capabilities, recovery behavior and remaining limitations.

For separately authorized administrative diagnostics, the existing `hv_db_query`
can execute a bounded read-only identity query. Its managed connection path may
create temporary provider access, so obtain the required access authorization
first and observe cleanup. Its result proves only the selected connection; it
does not establish the running application's configuration or SQL compatibility.
Database names and schemas are distinct; `public` is not a database name.

PostgreSQL's [SQLSTATE table](https://www.postgresql.org/docs/current/errcodes-appendix.html)
defines `28P01` as invalid password. Its
[session identity functions](https://www.postgresql.org/docs/current/functions-info.html)
distinguish the login, active role and selected database. Connection failures
such as routing, TLS and timeouts remain unknown rather than proving a bad
password. Existing authenticated sessions are distinct from fresh connections.

## Regression evidence

`database-credential.postgres.test.ts` preserves the real PostgreSQL lifecycle
test independently of the removed command. Against a disposable local server
using SCRAM, changing configured metadata leaves authentication unchanged.
An actual role password update admits the replacement, rejects the previous
password on new connections and leaves an existing session usable.

The consumer-readiness and rollout regressions separately exercise stale
deployment configuration despite matching provider values, partial activation,
retries and missing drainage. Their synthetic provider observations establish
orchestration behavior, not live workload authentication compatibility.

The public-interface cleanup first failed seven checks against the actual MCP
tool list, shared CLI registry and presentation coverage. They pass after removal
of the standalone command, its unused helper and port. Ordinary `npm test`
includes both the retained PostgreSQL test and these interface checks. The
committed acceptance workflow and desired required check invoke that suite and
type checking; live branch-protection enforcement is unverified.

These checks do not prove any provider's live network, TLS, application operation,
or the cause of the Invoice Perfect incident.
