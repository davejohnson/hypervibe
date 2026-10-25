# GCP prepared deployment evidence

The native browser-authorized installer, scoped session issuer and release-target
observer are implemented with offline transport evidence. No live cloud mutation,
operator image publication, billing attachment or deployment was performed.

## Independent contracts

- [Run service creation](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/create) is a parent-authorized POST, returning an operation. [Service metadata](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services) defines UID lifetime, generation, terminal reconciliation and etag. Empty traffic defaults to the latest ready revision; false protobuf flags are not missing identity.
- [Artifact Registry creation](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories/create) returns an operation. Its repository createTime is retained separately from its reusable name.
- [Run IAM](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/setIamPolicy) and [repository IAM](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories/setIamPolicy) support resource policy etags. Full existing policies, conditions and audit configuration are preserved.
- [Runtime identity](https://docs.cloud.google.com/run/docs/configuring/services/service-identity) separates deployment actAs from application permissions. Holding accounts receive no application secret access; final readers receive exact container access, while workload references pin versions.
- [Public registry access](https://docs.cloud.google.com/artifact-registry/docs/access-control#public) is an explicit operator prerequisite. The driver verifies anonymous native metadata for the exact configured digest; there is no mutable image default or customer Cloud Build fallback.
- [IAM inheritance](https://docs.cloud.google.com/iam/docs/resource-hierarchy-access-control) combines ancestor grants. [Cloud Asset effective policy scope](https://docs.cloud.google.com/asset-inventory/docs/reference/rpc/google.cloud.asset.v1#batchgeteffectiveiampoliciesrequest) does not prove policies above the requested scope absent. Initial support therefore requires a project with no native parent and rejects unresolved potentially matching group/principal-set grants. This is exact customer-scope evidence, not a claim about grants elsewhere.
- [Registry audit permissions](https://docs.cloud.google.com/artifact-registry/docs/audit-logging) document Docker upload/download permissions; [role definitions](https://docs.cloud.google.com/iam/docs/roles-permissions/artifactregistry) document the metadata permissions. Their actual deployed custom-role acceptance remains a live gate.

## Challenged assumptions and observed regressions

| Assumption | Concrete counterexample and observed RED | Implemented correction / GREEN |
| --- | --- | --- |
| A transient authentication callback implies complete installation. | Actual shared install plan had no holding resource actions; native prepare was unsupported. | Native reviewed create/grant DAG, separate identities, exact evidence and prepared receipt. |
| Administrator readback proves ongoing hosted access. | Successful installation made no hosted-principal Run request. | Final proof uses the hosted identity; no customer impersonation token is minted by observation. |
| Replaying every action is a practical final proof. | One two-workload fixture made 432 hosted requests through nested prerequisite reads. | One grouped native proof pass, guarded at no more than 60 hosted requests for that fixture. This bounds amplification, not live latency. |
| The original holding shape must persist forever. | Historical installation reconciliation became blocked after a legitimate application identity/image rollout. | Retain original creation proof; accept exact native lifetime and final identity for historical observation. Original holding revision/generation prevents rearming the initial transition. |
| Omitted and explicit protobuf defaults differ. | Native traffic `[]` and false revision flags were rejected. | Normalize documented empty/false defaults, retaining strict UID/readiness and rejecting enabled flags. |
| Immutable version text pins the secret container lifetime. | Same-name container recreated between review and apply reached ready and obtained runtime grants. | Review-time secret metadata noop actions pin createTime before any mutation; later grants, receipts and session proof retain that lifetime. |
| A resource read before retrieving its IAM policy is sufficient. | Replacing a service during the final policy GET still received a setIamPolicy write. | Read policy etag before the final lifetime check. Service-account policies use immutable numeric account IDs, with a separate observed failing assertion for email-addressed writes. |
| Another valid collection verifier grant is an authorization conflict. | A native read-only custom project role for the same hosted identity blocked deployment issuance. | Independently inspect its actual permissions consistently; preserve existing narrow read authority and reject broad grants. |
| Final SA/image alone proves the first release completed. | Native prepared observer retained pending even with independently verified release provenance. | Match exact native UID/image/readiness/config against the previous reviewed digest and verified managed release; missing or changed proof retains pending. |

`test/provider-contracts/gcp-cloud-deployment.test.ts` runs the actual installer,
shared CAS journal, issuer and native observer against reconstructed serialized HTTP.
It covers lost service-create acknowledgments without replay, replaced native lifetimes,
broadened permissions, removed trust, unrelated IAM preservation, historical reconciliation,
read-only prepared binding and disconnection preserving resources/runtime readers.
`gcp-prepared-hosting.test.ts` exercises the shared native holding interpretation.
Shared SQLite and executed generated-CI first-release tests are maintained by the
prepared-hosting lifecycle and Cloud Run suites. These are ordinary `npm test` tests;
repository workflow configuration is not proof of live branch protection.

The first application release uses the previously reviewed configuration hash and
original holding revision/generation. Both the direct adapter and executed emitted
CI replace the candidate image, final runtime identity and immutable references in
one conditional revision update. Deferred plan/apply leaves the holding image and
configuration unchanged. The local metadata handoff remains separate from native
runtime mutation and managed-release verification.

Observed failing serialized-transport tests exposed recreated same-name secret
containers, rearmed holding workloads, lost revision labels, missing generation or
terminal readiness, traffic still pinned to holding code, and rejected documented
false defaults. Those cases now pass through the actual adapter; the emitted CI
regression independently reproduces and rejects holding-revision rearming. Rejected
and lost write acknowledgments issue only one PATCH, retain uncertainty and expose
no raw provider diagnostics. Native HTTP root defaults remain HTTP probes, never
normalized into TCP probes. Legacy generated workflow bytes remain unchanged.
These tests establish the implementation boundary, not successful live first release.

## Remaining release prerequisites

Configure an owner-approved public immutable holding image in Hypercloud and publish
the matching Hypervibe library before updating the pinned consumer dependency. Run
the approved separate developer/admin/contributor walkthrough, including first image
release, native custom-role acceptance, IAM propagation, retries and cleanup.
Organization/folder policy analysis, unknown group authority,
cron/release commands and broader datastore/storage topology are explicit unsupported
cases. No passing fixture or prepared resource proves application health or live support.
New-project billing has separate [versioned assignment evidence](connect-cloud-gcp-billing-assignment.md)
and an explicit concurrent-change limitation; old unversioned billing plans remain blocked.
