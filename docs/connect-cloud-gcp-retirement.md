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
