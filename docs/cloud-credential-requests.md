# Collect credentials from their owner

Hypervibe can send the credential owner a secure form, track their response,
and deliver values directly to a reviewed AWS Secrets Manager, Google Secret
Manager or Azure Key Vault destination. Direct delivery returns immutable version
references; values are not imported into local files or retained in plans.
Keys without a declared destination retain the separately approved private-import
workflow. Values never belong in chat. Neither workflow deploys automatically.

Declare responsibility in the value-free spec, for example:

```json
{
  "secrets": {
    "CLIENT_ID": {
      "ownership": "delegated",
      "principal": "email:alice@example.com",
      "environments": ["staging"]
    },
    "CLIENT_SECRET": {
      "ownership": "delegated",
      "principal": "email:alice@example.com",
      "environments": ["staging"]
    }
  }
}
```

Use `hv_spec` to update the existing spec, then review, commit and push it on
the intended branch. This fragment is not a replacement for the full spec.

For direct delivery, declare each key's exact destination under
`environments.<environment>.secretDestinations` using `hv_spec`. Review the native
account/project/vault and secret identity for each environment. Existing version
pins are preserved and excluded from collection; collection does not rotate
them. The hosted account owner authorizes a writer connection for that exact
destination. A reporting or read-only monitoring connection is not a write grant.
See [destination contracts and prerequisites](secret-destination-delivery.md)
for the supported provider matrix, existing-container requirements and runtime
identity permissions.

## Inventory every environment

Start with:

```sh
hypervibe cloud requests --action environments
```

MCP uses `hv_cloud_requests({ action: "environments" })`. The command reads the
committed spec and returns every environment's pinned keys, unpinned generated
keys, and delegated keys grouped by owner and delivery method. Large groups are
split into requests of at most 16 fields. It returns separate authorization,
invitation-review and resume calls; it does not contact the hosted service,
create grants, send invitations or infer collection readiness.

Approve access for each environment separately, then review each proposed
invitation before confirming it. A staging grant never authorizes production,
and an all-environment inventory does not approve invitations in bulk. Generated
keys with direct destinations use owner-reviewed browser actions supplied by
that environment's `resume` response. The CLI never generates their values.

## Start from the deployment plan

Run `hv_plan` for the intended environment. If delegated runtime inputs need
explicit input, its `credentialRequest` result contains an `hv_cloud_requests`
call with the environment and persisted `planId`. The agent uses that call;
you do not need to copy request IDs, session cookies or tokens.

1. Hypervibe selects only that plan's eligible input requirements, excluding
   already supplied inputs, generated secrets, CI-only keys and other
   environments. These requirements are not proof that live credentials
   are absent or invalid; accepted-but-unobservable values are preserved.
2. If needed, it returns a browser approval link and comparison code for
   request-management access to this repository and environment. Approve it,
   then the agent repeats the call. This is not invitation approval.
3. Hypervibe checks the current committed source against the hosted branch and
   looks for existing requests. It shows the recipient, fields, environment and
   exact source, plus any direct destinations, for confirmation before queuing
   a new invitation. The hosted service resolves targets from that source;
   request input cannot override them.
4. The recipient verifies their email and enters values in the secure form.
   Queued delivery is not confirmed delivery. Supplied values are not provider
   validation or deployment approval.

A new plan-bound invitation requires a successful plan no older than 24 hours,
the same repository/environment and current spec revision, and the same source
commit if the plan pinned one. Manual plans may omit an application commit;
the invitation still independently pins current HEAD and the raw spec digest.
Create a fresh plan if those checks fail.

Interactive CLI confirmation and MCP `confirm: true` use the same saved review.
A changed proposal requires a new review. Browser access approval never doubles
as invitation, import or apply consent.

## Track and resume without copying IDs

Ask the agent to resume the credential handoff, or run:

```sh
hypervibe cloud requests --action resume --env staging
```

MCP uses `hv_cloud_requests({ action: "resume", env: "staging" })`. This discovers
requests within the approved environment and returns pending, ready, stale or
terminal status with safe next calls. The original plan need not remain fresh
for tracking. Direct requests include validated immutable version receipts and
`destinationTargets: [{key, destination}]` metadata. Review the delivered version
pins through `hv_spec`, then prepare a fresh plan. Legacy ready, source-compatible
requests without direct destinations include `hv_cloud_secrets` arguments.
No values are returned and no import is started. Unpinned generated destination
keys include same-origin browser review links bound to the project, environment,
key and source branch; opening that review is separate from approving generation.
For web-created requests without an explicit branch, resume independently
verifies the repository's current default source. Creation reuse deliberately
requires an exact explicit branch match; use resume for existing web requests
instead of sending another invitation.

The report includes active requests and recent terminal history with total/shown
counts. Unknown or incomplete reads fail closed. Large histories are bounded;
`action: "list"` provides individual pages:

```sh
hypervibe cloud requests --action list --env staging --page 2 --sort oldest
```

Resuming is on demand. This release does not wake a closed coding session or
automatically poll, import, validate Google/Flow credentials, or deploy. The
existing hosted ready notification is separate from agent resumption.

## Direct delivery and uncertain outcomes

The secure form sends a transient value through hosted Hypervibe to its reviewed
secret manager. Durable attempts and receipts contain scope and version metadata,
not values, value hashes or encrypted application-secret copies. A successful
receipt is not validation that an OAuth/Flow key works or that a workload can
read the native secret; runtime access and rollout remain separate.

For an uncertain direct delivery, use the returned `reconcile` call, or
`hv_cloud_requests({ action: "reconcile", env: "staging", requestId: "…" })`.
It rechecks current scope/source and asks the host to observe native metadata.
It never submits a value again. AWS can correlate its explicit version token;
Azure can correlate exact attempt tags. Google Secret Manager has no equivalent
reliable attempt marker, so a lost write receipt remains blocked pending
operator resolution. Another visible version or an empty read is not permission
to repeat an uncertain write. See the [provider evidence and recovery limits](secret-destination-delivery.md).

Direct requests never offer private import. The importer independently rejects
destination-backed keys before consuming a legacy retrieval or writing an env
file, including local recovery paths.

## Private import and recovery

For legacy keys without direct destinations, the agent uses the returned
`hv_cloud_secrets` call. You separately approve its
browser device/comparison code and the one-time import. Values enter only the
existing encrypted/local-file importer. Its value-free `secretRefs` feed a
fresh reviewed plan; invitation or import approval never authorizes apply.
See [private import and recovery](cloud-secret-import.md).

If an import response was lost, first check the importer's local encrypted
recovery. A consumed request cannot be fetched again. If its values are truly
unrecoverable, `resume` supplies a replacement call. Replacing a consumed,
expired or revoked request sends a new invitation, after a separate review
and confirmation; it does not replay the one-time retrieval. An active request
must be revoked separately before its fields can be reassigned.

Creation and revocation intent is persisted encrypted before sending. A lost
creation receipt can be reconciled against a unique newly observed exact
request, including one that has since expired or been revoked. A pre-existing
lookalike cannot prove a new write completed. Missing, ambiguous or unknown
evidence preserves the uncertain-write marker and blocks another mutation.
Changing the source or obtaining a new plan cannot clear that marker.

Revocation reviews the exact request and requires confirmation. Consumed and
revoked requests are terminal no-ops. Revocation removes access to unconsumed
legacy values and cancels further submission. It does not delete delivered
native versions or rotate credentials already delivered or imported elsewhere.

## Deliberate overrides

Calling `hv_cloud_requests` without a `planId` explicitly prepares a request
from required delegated runtime keys declared in the spec, not live absence.
Prefer the plan's handoff when collecting only unresolved deployment inputs.

Fields default to readable labels and hidden inputs. `fields` can select an
eligible subset and provide labels or `password`, `text`, or `textarea` formats.
A plan-bound request cannot expand beyond that plan's eligible requirements.
Without a plan, optional delegated runtime keys may be selected explicitly.
Pinned keys cannot be selected again. Direct and local-import fields require
separate requests; use the inventory's groups instead of silently changing the
delivery method.

`ownerEmail` supplies a missing email or selects one of several declared owners;
it cannot silently replace an explicitly declared email owner. Persisting
`principal: "email:…"` through `hv_spec` avoids asking again. Other principal
forms remain valid in the existing delegated-secret lifecycle.

The default environment is staging, or the only declared environment. Use
`env`, `sourceBranch` or `title` when defaults are unsuitable. A detached checkout
needs an explicit branch. The server must observe the same revision and raw
spec digest, including when processing the confirmed creation request.

`baseUrl` defaults to `https://hypervibe.dev`, or the origin from verified local
cloud-reporting metadata. A reporting token never authorizes request management.
Custom installations require the same HTTPS and origin checks.

### First-time app setup

Browser approval sends the checked-out branch as an optional app-setup hint.
Use `action="authorize", sourceBranch="integration/security"` when the intended
setup branch differs from the checkout. Authorization does not require that
branch to match local HEAD; preparing an invitation or importing credentials
still requires the existing exact committed-source checks.

The hint only prefills the browser's review form. It does not connect the app,
approve agent access, send an invitation, or deploy. Detached checkouts omit
the hint unless an explicit branch is supplied; they never guess `main` or send
`HEAD` as a branch. An existing pending approval retains its original hint
when retried without `sourceBranch`, even if the checkout changes. An explicit
different branch is rejected before exchange; finish that approval or let its
code expire before starting another. Legacy pending codes have no hint and are
not silently rewritten. A branchless retry after code expiry also preserves
the previous hint (including no hint); supply an explicit branch to change it.

## Server compatibility and evidence

The legacy workflow requires [Hypercloud PR #85](https://github.com/davejohnson/hypercloud/pull/85)
and its migration, following PR #84. Older servers that ignore the new pairing
purpose are rejected. There is no cookie-copy fallback. The separate
`credential-requests` grant lasts 30 days, is bound to one environment, and
rechecks current owner permissions, membership, expiry and revocation. It can
manage requests, not read values, approve retrievals, report activity or deploy.
Normal reporting and provider-connection pairing retain their existing contract.
Direct delivery additionally requires the matching hosted destination connection,
durable attempt/receipt and owner-generation migrations/routes, plus a compatible
Hypervibe package. The historical PRs alone do not establish direct-delivery
support. Missing or inconsistent discovery/receipt data fails closed; there is
no fallback to local plaintext for a destination-backed key.

Branch-prefill rollout is **server first, client second**: Hypercloud must first
accept and persist optional `sourceBranch` on pairing creation and use it in
the browser setup form, including its database migration. The public pairing
create/exchange responses remain unchanged, and approval URLs remain exactly
`/pair?code=...`. No response echoes the hint, so a successful pairing response
alone does not prove that the deployed server supports prefilling. The local
`sourceBranch` receipt reports the hint sent, not remote branch validation.
Client tests use synthetic unchanged responses under this user-approved
request-only extension; deployed browser interoperability remains separately
unverified until the matching server release is checked.

Independent server source is pinned in `test/provider-contracts/hypercloud` at
PR #84 (`8272cd5284aaae010b88d7c09b46feca74334be1`) and PR #85
(`18aabb8ad82d4d9cd235d79ac33c490c7717ef25`). Fixtures are reconstructed from
that source, not live recordings. Regression tests exercise serialized client
requests, real local Git/SQLite state, MCP/CLI routing, plan-required subsets,
historical recovery, isolation and separate import approval. New counterexamples
were observed failing before their corresponding runtime fixes.
New direct-delivery tests additionally reproduced local-import suggestions for
direct receipts, a destination-backed key being consumed into an env file,
missing generated review actions, and default-source recovery inconsistencies.
They now cover mode/source/target binding, immutable receipts, per-environment
inventory, pinned preservation, separate reviews, safe generation links and
uncertain creation/delivery recovery. The paired hosted implementation is
checked separately; these additions do not claim the historical snapshots
already contained the new routes.

These tests do not establish deployed interoperability, email delivery or
Google/Flow validity. The ordinary `npm test` suite includes them; committed
acceptance CI and desired acceptance policy run that suite and typechecking.
Live branch-protection enforcement has not been inspected. Service-specific
setup instructions inside the form remain follow-up work.
