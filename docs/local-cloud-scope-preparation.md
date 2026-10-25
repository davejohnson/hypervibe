# Local empty-project preparation

This is an isolated prerequisite for a local operator preparing the Connect Cloud
test host. It is not the customer browser connection flow, a hosting deployment,
or a workaround for an unavailable hosted identity. The owner approved this
create-only **implementation** on 2026-10-25; actual creation still requires the
exact saved action confirmation.

`environments.<name>.hosting.scopePreparation` declares version 1,
`authentication: "local-default"`, and a provider-validated `nativeScope`.
Cloud Run currently admits only `scopeKind: "project-allocation"`,
`allocationMode: "create-exclusive-v1"`, the exact project ID/display name, and
an optional parent. It does not accept a billing account. The ordinary
`hv_spec` → `hv_plan` → `hv_apply` path isolates this work before deployment
connection lookup. No local environment row or cloud connection is required.
An explicitly narrower plan request (such as secrets-only or destination setup)
stays narrow: if this prerequisite is outstanding, it stops with guidance to
review the full plan instead of silently offering project creation.

The shared contract is capability-driven. The named hosting-provider review is:

| Hosting provider | Local scope prerequisite in this version |
| --- | --- |
| GCP Cloud Run | One native Resource Manager project-create attempt, using transient Google user ADC; terminal operation and fresh native lifetime proof required. |
| AWS ECS | Unavailable here. Its hosted CloudFormation/federation installation remains a distinct contract. |
| Azure Container Apps | Unavailable here. Its hosted resource/identity/RBAC installation remains a distinct contract. |
| Railway | Unavailable; no emulated cloud project allocation. |
| Fly | Unavailable; no emulated cloud project allocation. |
| DigitalOcean App Platform | Unavailable; no emulated cloud project allocation. |
| Vercel | Unavailable; no emulated cloud project allocation. |

This matrix is an implementation boundary, not a claim that other providers lack
native provisioning APIs. Their broader contracts and live gaps remain in
[Connect Cloud scope preparation](connect-cloud-scope-preparation.md).

## Authority and recovery

A GCP project lookup returning403 remains unknown. It never establishes absence
or ownership. The separately reviewed action authorizes one exclusive native
creation request; an existing project, a conflict, or an uncertain outcome cannot
authorize adoption, replacement, another ID, or another POST. The saved intent
binds the exact local application/environment and reviewed spec revision/digest.
No host identity or source commit is fabricated for this local stage.

Google's [project-create contract](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/create)
returns a long-running operation, which Google removes after a few hours.
Recovery retains its exact identity and independently verified terminal response.
Current readiness also requires a fresh project read matching the native project
number, creation time, parent, ownership marker and attempt. A later permission
failure or replacement invalidates readiness while retaining historical proof.
An operation acknowledgment alone does not prove creation; losing the
acknowledgment does not permit another create request.

Nonsecret history uses the existing SQLite `runs` store and a transactional
revision comparison. A persisted attempt fences sibling proposals, including
after source/target edits and restarts. Invalid history blocks new work. At the
100-record inspection limit, new proposals are refused while recovery of the
existing records remains available. Acknowledged operation identities cannot be
erased or substituted; terminal native proof remains immutable on its attempt.
The current readiness map may be cleared without destroying that history.

This first slice is stricter than the provider's definite-failure semantics:
any recorded attempt, including a definite rejection before dispatch or a native
conflict, permits only recovery. A fresh reviewed allocation after such rejection
is not implemented. There is no automatic reset or rename escape.

User ADC is accepted only through the explicit local capability and typed Google
user credential path. Tokens remain transient. No refresh token, private key,
runtime credential, or CI credential is written by this stage. Hosted factories
continue to require their separately authorized hosted identity and browser flow.

Success means **the exact empty project allocation is verified**. Billing, APIs,
runtime identities, secret-manager setup, cloud connections, application hosting,
backups and a tested restore require subsequent reviewed lifecycle work. This
stage does not advance deployment markers or imply environment convergence.
Removal of the declaration does not delete the project or erase its journal.
A completed allocation with no hosting bindings remains in this isolated stage,
even after declaration removal. An explicit later billing/connection/binding
handoff is still required; that handoff is not implemented by this capability.

## Acceptance evidence

### GCP operation type regression

The approved empty-project test exposed an incorrect assumption: the Resource
Manager hostname spelling was also the protobuf package spelling. Google's
[pinned official proto](https://github.com/googleapis/googleapis/blob/9415ba048aa587b1b2df2b96fc00aa009c831597/google/cloud/resourcemanager/v3/projects.proto)
declares `google.cloud.resourcemanager.v3` and `CreateProject` returns `Project`.
[ProtoJSON Any](https://protobuf.dev/programming-guides/json/#any) supplies that
message's type URL. The independently observed operation on 2026-10-25 at
19:12:27Z was terminal without error and carried
`type.googleapis.com/google.cloud.resourcemanager.v3.Project`. Only the sanitized
type and field shapes are retained in `test/provider-contracts/gcp/source.json`;
test resource identities are reconstructed synthetic data.

The real-client serialized transport regression rejected that valid response
with `wrong resource type` and accepted the old misspelled package. Correcting
the positive hosted/local/application fixtures also reproduced pending recovery
instead of successful allocation. Before runtime changes, the five affected
suites reported **15 failed, 44 passed**. The fix changes only the exact expected
type string; it does not accept an alias or relax ownership or operation proof.
Afterward, nine focused suites covering the real client, hosted/local lifecycle,
SQLite journal, application plan/apply/status and billing continuation reported
**156 passed**. The malformed, omitted, wrong-resource/version and misspelled
type cases remain negative checks.

All checks are discovered by ordinary `npm test`. The committed acceptance
workflow and desired `.hypervibe/spec.json` both run that command and typecheck;
live branch-protection enforcement was not inspected. These offline results do
not prove the original journal has recovered in GCP, authorize another create,
or establish complete cloud onboarding. Recovery must use the retained original
operation, fresh native ownership/lifetime evidence and read-only requests.

The regression assumption was that retaining the completed-resource map forever
was sufficient recovery protection. The counterexamples were a completed native
project becoming unreadable or having a different lifetime: the real shared
engine attempted to invalidate readiness, but the SQLite store refused the
transition. Both tests failed with `store_unavailable` before the fix. Two further
native-client tests proved saved acknowledged/succeeded evidence could be erased;
one journal test admitted a 101st row and stranded future recovery. All five were
observed failing before the repository changes and passing afterward.

`gcp-local-project-journal.test.ts` composes the actual native client, shared
engine and SQLite store. Its REST payloads reconstruct the official contracts;
they are not captured live responses. It covers restart, permission/lifetime
drift, evidence preservation and one-POST recovery. Separate local lifecycle,
native transport, provider-roster and ordinary-command tests cover authorization,
first environment creation, source changes and isolated action authority.

The full gate also caught a validation-order regression: ordinary unsupported
DigitalOcean/Vercel volume intents reached plan loading before spec rejection.
Those two cases and three real-SQLite ownership/type negatives failed before the
correction. Ordinary invalid specs now reject first; only an exact owned saved
cloud-scope plan may proceed to strict parsing for historical recovery. The
48-case affected group passes, including recovery after current-provider edits.

These tests run in normal `npm test` discovery. The committed
`Hypervibe / acceptance` workflow and desired required-check configuration both
run `npm test` and type checking. Repository files do not establish live branch
protection. Passing these offline checks does not establish live GCP allocation,
customer onboarding, AWS/Azure parity, billing authority, or hosting readiness.
