# Hypercloud credential-request API v1

Pinned official merged server source:

- PR #84, commit `8272cd5284aaae010b88d7c09b46feca74334be1`: original
  email request, source-branch, form, delivery and request lifecycle snapshots.
- PR #85, commit `18aabb8ad82d4d9cd235d79ac33c490c7717ef25`: environment-scoped
  credential-request device access, source preconditions and updated lifecycle
  excerpts in the `pr85_` snapshots. The PR #84 snapshots remain unchanged.

`source.json` records each file's exact revision, immutable source URL, full
source hash and snapshot hash. Large files contain only the verbatim line ranges
named in the manifest (plus source-line comments). Corrected PR #84 controller
and route ranges in the manifest include their final source line; the original
snapshot comments and bytes are preserved. Form and branch validators
are complete. No tests fetch or depend on the neighboring checkout. Merged
source does not establish that the live service runs this revision.

`src/application/__tests__/cloud-requests.test.ts` reconstructs synthetic owner
responses from `requestView`, `createEmailRequest`, `prepare`, `list`, and
`revoke`. It intercepts only HTTP transport while exercising the real command,
request serialization, response projection and CLI/MCP adapters. This is not an
OpenAPI schema validation, live recording, or execution of the whole server.
The PR #85 source adds a separately approved `credential-requests` pairing
purpose for one environment. Approval requires the owner's existing project
enrollment and credential-management permissions. Its credential-management
grant lasts 30 days and is rechecked against the approving membership and role;
it does not authorize reporting, credential-value retrieval or deployment.
Management routes accept that scoped bearer grant or an owner session. Cookie
and bearer authentication cannot be mixed, and session writes retain CSRF.
The pinned browser retrieval-approval route remains session-only.

Device-authenticated creation requires `expectedSourceRevision` and
`expectedSourceDigest` to match freshly inspected committed source. Preparation
returns those values, and list/show/revoke remain project/environment scoped.
Request creation queues an invitation; it does not prove email delivery.

The pinned lifecycle distinguishes request expiry from the access grant's
expiry: requests last 24 hours. List/show project an expired pending/ready row
as `expired`, while duplicate-key creation conflicts only with unexpired
pending/ready requests. A consumed, revoked or expired request therefore does
not block a newly confirmed creation; there is no dedicated server replacement
endpoint. Revoke returns a verified no-op for consumed/revoked rows. Consumption
requires a ready, active request and atomically marks it consumed while erasing
its server envelope. Neither expiry nor consumption authorizes an automatic
second invitation or retrieval by the client.

See `docs/cloud-credential-requests.md` for the assumption/counterexample record,
verification scope and remaining live checks. The normal `npm test` gate includes
these tests. Existing private-import tests cover the separate value boundary.
