# Hosted GCP cleanup through the desired-state workflow

`hv_spec` accepts `environments.<env>.cloudRetirement`:

```json
{
  "id": "59166ad6-0432-423e-b3b0-f1c3ed1059b0",
  "mode": "delete-owned",
  "connectionIds": [
    "b24a6ef4-9511-4747-bb92-ad5cd847e68e",
    "47516f1e-b59f-4ed2-89c4-7e7e59957e5c"
  ],
  "baseUrl": "https://your-hypervibe-host.example"
}
```

Select the exact original collection and deployment connection IDs. `disconnect`
instead selects one collection connection and preserves the app, secret versions
and runtime reader. These examples contain identifiers only; cloud credentials,
secret values and source approval are never part of the declaration.

`hv_plan` with `scope: "cloud-retirement"`, or a full plan containing that explicit
declaration, proposes only this cleanup. It does not provision the app or prepare
unrelated integrations. Follow the exact returned `cloudRetirement.reviewUrl` for
fresh administrator sign-in or owner review when required. Browser approval and
`hv_apply` action confirmation remain separate. Re-plan after approval, review the
saved action, apply its exact ID and inspect `hv_status`.

The application client uses the saved device grant for the exact repository,
environment and HTTPS origin. Historical cleanup does not depend on the current
branch. Every continuation checks the current declaration, local grant and journal,
remote target and approved plan digest after a fresh status read. Connection order
is canonicalized. Completed and remaining action lists must be complete and
disjoint, and their combined set cannot change under the same plan digest.
Continuations retain the shared four-minute response budget, including streamed
bodies, while observation calls use a shorter deadline. A lost response
remains pending. A fresh confirmed recovery plan can ask the hosted lifecycle to
resolve its exact retained attempt before any remaining approved action. Rejected
native attempts do not become automatic retries. An initial proposal whose response
was never recorded is recovered by GET. An inconclusive 404 permits only a
same-ID metadata proposal replay before any observed plan or execution; the server
rechecks the original device, environment and intent. It never authorizes a cloud
write. Authorization failures, unknown reads and observed cleanup records remain
blocked; a found proposal is recovered without another POST.

A hosted `ready` response after execution can be a saved time-budget checkpoint,
with completed actions and the original approval intact. The apply result reports
that as pending and directs the agent to read status, then prepare a fresh exact
continuation plan. It does not label this normal pause as a permission block or
ask the owner to approve unchanged work again. Rejected or revoked outcomes
remain blocked; uncertain effects still require read-only recovery.

The current hosted path is not a complete MCP-only customer experience: the
device can propose and execute cleanup, but only the website can record owner
approval and attach transient Google administration access. This is Hypervibe's
current authorization boundary, not a Google requirement to visit Hypervibe's
website for each deletion. A future owner-authorized MCP approval must bind the
exact app, environment, plan and device; an ordinary deployment grant cannot
approve its own expansion. Cloud sign-in may still be needed when transient
access expires. App deletion should include its secret and permission cleanup,
without making collection disconnection a separate user step.

Successful cleanup retains local identities and history. Owned deletion latches
the environment once execution begins, including when the declaration is later
removed; app recreation needs an explicit reconnect review. A completed collection
disconnect does not latch the app: removing that declaration permits ordinary
planning using the independently authorized deployment connection.

## Local evidence and limits

The real schema boundary rejected the declaration before the implementation.
Command-registry, SQLite and serialized HTTP regressions exercise both modes,
isolated full planning, exact confirmation, stale targets and grants, concurrent
local changes, secret-bearing responses, pending recovery, reverse connection
selection, delayed continuation bodies, missing or dropped action evidence, and
read-only status.
The recreation regression failed for completed and uncertain owned deletion before
the durable guard; the completed-disconnect counterexample allows app planning.
These tests run through normal Vitest discovery. They establish the public workflow
and response boundary, not live GCP deletion, deployed hosted compatibility or
runtime survival. Those require separate integrated observation.

The 2026-11-05 disposable walkthrough exposed a status error at the real MCP
boundary: a continuation completed 12 actions, retained the same owner approval
and returned hosted `ready`, but `hv_apply` reported it as blocked and told the
agent to ask the owner again. After correcting only that result classification,
a later live continuation of the same plan reported pending after 28 completed
actions and directed read-only status recovery. Actual sign-in, review and
blocked outcomes keep their separate behavior. Type checking and the build
passed; no new automated test was added for this correction, as requested by
the owner. The saved live receipts establish this result, rather than a new mock.

## Disposable GCP walkthrough: 2026-11-05

The hosted app `hypervibe-connect-walkthrough`, environment `gcp-test`, completed
both removal modes through MCP against project `hv-hypercloud-connec-bca4e743`.
Collection disconnection removed its three writer grants while the original
Cloud Run service and secret retained their identities. The native runtime-reader
grant remained, and the app returned HTTP 200 with `secretAvailable: true`.

Owned deletion then completed all 51 recorded actions. Independent, read-only
Google API observations confirmed the service, five service accounts, secret and
image repository absent, all 31 selected grants absent, and 12 custom roles
marked soft-deleted. Soft deletion is not a claim of immediate physical erasure.
The final `hv_status` reported `retired`, verified and in sync; a fresh plan had
zero actions and no blockers. The deleted app endpoint returned HTTP 404.

The shared project, both host services and three shared identities retained their
original identities. The shared host returned HTTP 200; its existing PostgreSQL
instance remained `RUNNABLE`. No app database existed in this customer fixture,
so this does not establish customer-database teardown. Shared hosting, its
database/backups, browser registrations and the fixture repository remain for
later walkthroughs. AWS/Azure, full shared-host teardown and MCP owner approval
without the website remain outside this completed GCP checkpoint.

One service-account deletion was acknowledged before absence could be confirmed.
Exact ID and email reads subsequently returned 404, and supported reconciliation
completed it without another delete. The final apply response was lost; read-only
status recovered the completed record without replay. The deployed host used the
verified unpublished library archive; publishing and pinning that compatible
library remain release prerequisites.
