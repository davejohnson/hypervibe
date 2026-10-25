# GCP Connect Cloud evidence

This is offline contract and lifecycle evidence for the draft, not live Google
compatibility or proof of the cause of a customer incident. Fixtures are
reconstructed from the cited official REST contracts; only HTTP transport is
replaced. Shared tests use the real installation engine or runtime plan/apply
service and retain its durable journal.

| Challenged assumption | Independent contract / counterexample | Observed regression |
| --- | --- | --- |
| A full SHA256 hex string fits a native ownership label | Secret Manager `Secret.labels` permits at most 63 characters; the proposed value had 64 | Three existing create/lifecycle cases failed after the transport enforced the published limit, then passed after creation and recovery used the same bounded native marker. Durable evidence retains the full digest. |
| Service Usage operation IDs contain no dots | Google's project setup example returns `operations/acf.601db672-88e6-4f98-8ceb-aa3b5725533c` | Disabled-API enable returned uncertain instead of retaining the acknowledged operation; the same case passed after strict bounded parsing admitted the documented form. |
| An existing secret name proves the same resource lifetime | Secret Manager exposes immutable `createTime`; deletion and recreation reuse the name | Migration initially planned a new container and accepted the wrong lifetime; the shared engine rejected it. Both migration cases passed after read-only review pinned the existing lifetime. Existing values, names, versions and labels are preserved. |
| Matching IAM membership is enough to adopt its ownership | The user requires exact historical ownership, not a pre-existing lookalike | A present grant without this installation's attempt/completion was accepted; its regression now returns conflict. Forged unrelated disconnection evidence is also rejected. |
| Native reader-driver success proves shared lifecycle admission | Shared runtime records must remain value-free and accepted by the normal planner | The real shared frontier rejected secret-prefixed metadata. Truthful reader coordinates now pass identity creation, actAs, exact secret reader grant and mutation-free re-entry. A missing desired-state snapshot preserves retained grants. |
| Desired configuration no longer mentioning a secret means it is unused | Cloud Run revisions are immutable; services, volumes, retained revisions and release jobs may still consume it | Four cases initially proposed revocation while a consumer remained. They now wait; removing the observed references permits the exact grant removal. Unknown, duplicated or over-bound inventories do not prove absence. |
| Aborting fetch alone bounds its response body | A transport/stream need not cooperate with AbortSignal; this task requires bounded delivery and recovery | A stalled body remained pending after deadline, and an already cancelled parent still sent a request. Both now fail with closed value-free diagnostics using the existing bounded HTTP boundary. |

Official evidence reviewed:

- [Secret resource, labels and creation time](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets).
- [Service enable operation example](https://docs.cloud.google.com/service-mesh/docs/tutorials/project-cluster-setup).
- [IAM policy etags and replacement semantics](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/setIamPolicy).
- [Immutable secret version metadata](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets.versions/get).
- [Immutable Cloud Run revision configuration](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services.revisions) and [bounded revision listing](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services.revisions/list).
- [Short-lived impersonation](https://docs.cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken).

Normal `npm test` includes the GCP installation, native runtime, shared lifecycle
and command regressions. The committed acceptance workflow and desired
required-check configuration both run `npm test` and type checking. Live branch
protection was not inspected and is not claimed from those files.

Remaining gates include live host identity/federation, online OAuth registration,
real permission propagation and billing, live project creation for a customer without
an existing project, separately authorized keyless deployment, and the approved
multi-person disposable-account walkthrough. Offline tests do not establish any
of those. Collection disconnect preserves runtime readers; runtime grant removal
is a separate desired-state action and can remain waiting on retained consumers.

The [scope-preparation stage](connect-cloud-scope-preparation.md) now covers
project-only creation, a separate actual-parent/billing review, existing-billing
verification and explicit historical temporary-grant cleanup in reconstructed
transport tests. Missing billing stays blocked before any temporary writes.
Selected-account negative permission checks do not prove absence of inherited
unlink authority on another account; the concrete race was observed failing
before the blocker. This remains an incomplete fresh-customer path, not a claim
that Google cannot attach billing or that manual dashboard work meets acceptance.
