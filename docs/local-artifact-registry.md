# Local operator image repository prerequisite

This extends the existing shared [cloud installation contract](connect-cloud-deployment-contract.md),
using its durable intents, exact action confirmation, attempts and nonsecret native
evidence. It does not introduce a second registry API or allow CI to create resources.

The challenged assumption is that an allocated project with APIs and CI federation
is ready for first deployment. Counterexample: the exact Artifact Registry repository
is absent; the emitted CI correctly refuses to create it. The local continuation
must prepare and bind it before handing hosting to normal plan/apply.

| Named hosting provider | Existing native installation boundary | This local continuation |
| --- | --- | --- |
| cloudrun | Artifact Registry repository name + native createTime; asynchronous regional Operation | Explicit reviewed create and lifetime binding |
| ecs | Reviewed CloudFormation creates ECR with the customer installation | No new local allocation claim |
| azure-container-apps | Reviewed ARM deployment creates ACR with the customer installation | No new local allocation claim |
| railway | Provider source-build pipeline owns its image store | No separate managed registry claim |
| fly | Existing release/registry path belongs to the app | No new registry lifecycle claim |
| digitalocean | Existing App Platform source/image path | No new registry lifecycle claim |
| vercel | Managed deployment artifacts, not this container repository model | Not applicable |

Native sources reviewed before implementation:
[repository create](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories/create),
[repository identity and configuration](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories),
[regional operation polling](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.operations/get),
and the unchanged official [pinned protobuf files](../test/provider-contracts/gcp/artifact-registry/source.json).
The pin independently establishes the package, output-only creation timestamp and
CreateRepository response message; it is not a full REST/protobuf validator.
Create accepts repositoryId and returns an Operation whose successful result is a
Repository. There is no documented create request-id parameter or conditional create
header. Native name uniqueness prevents overwriting an existing repository; only 404
proves absence. Preserve an uncertain attempt rather than issue another POST.

The existing `hypervibe` image repository name is retained within the new isolated
project and selected region. A fresh project lifetime and billing association are
verified before each action. The new repository receives the exact installation and
attempt ownership marker. Only matching native identity, configuration, owner marker
and createTime can complete the record; a retained operation must also converge.
Unknown reads, name collisions, replaced lifetimes and failed operations block.
No IAM policy, public-access grant, image upload or deletion is part of this action.
Later publication and exact registry permissions remain separately reviewed work.

Observed offline evidence: initial missing-capability tests failed. The real shared
installation/serialized-client tests then caught a mismatched operation being accepted;
the retained closed failure category now blocks recovery. Three further counterexamples
failed before their fixes: conflicting operation/read lifetimes, supplied creation-time
claims in a new create intent, and ordinary Cloud Run project convergence discarding
retained registry identity. All three passed afterward, alongside 117 native/shared
and adapter checks. The application continuation separately observed three failing
missing-stage regressions before its corrected 25-case suite passed. These checks run
under ordinary `npm test`. Fixtures reconstruct official API contracts with synthetic
identities; no native live registry creation, image publication or first deployment
has been verified by these tests.

## Ownership projection and historical binding repair

The next publication boundary also needs the private registry's installation ID
and creation-attempt ID to verify its native ownership description. A name and
creation timestamp alone cannot reconstruct that marker. The final local binding
previously discarded these two fields even though the accepted creation journal
retained them. Real serialized-provider and SQLite lifecycle regressions reproduced
the missing projection before correction.

The final handoff now carries both IDs. Public helper preparation already retains
the separate private proof; historical private-to-CI intents remain byte-for-byte
unchanged. Their final binding follows exact predecessor IDs and plan digests to
the original private registry record. Missing, ambiguous or mismatched ancestry
blocks proof; no ID is inferred from a resource name or a new publication attempt.
Native predecessor reconciliation still verifies the owned description and lifetime.

An existing binding may need the confirmed `cloud-scope:normalize` metadata action.
The provider declares exactly which absent nonsecret fields are repairable; this
GCP capability declares only the two creation IDs and the exact approved billing
account name. The shared action requires all
other scope fields and saved connections to match, re-observes the accepted native
lineage, adds only absent fields and preserves unrelated environment bindings.
Conflicting metadata, unknown reads and replaced native resources block repair.
The action creates no resource, changes no IAM policy and saves no credential.
It does not rewrite historical intents, plans or source digests. Later source edits
and removal of the old setup declaration do not erase valid original ownership.

The named provider matrix above is unchanged: this repair applies only to Cloud
Run's existing local allocation capability; ECS and Azure hosted installations
retain their separate authority and no local continuation is claimed for them or
the other four hosting providers. Normal `npm test` includes projection, legacy
repair, exact confirmation, source edits, stale local state, unknown/replaced
native identity, private CI ancestry and unchanged historical scopes. Four initial
repair cases failed before implementation. Four additional re-entry cases exposed
completed setup incorrectly rejecting ordinary deployment inputs; they pass after
fresh native/binding verification returns control to ordinary planning. These
are offline contracts, not live registry creation or image publication evidence.

A completed CI disconnection keeps its immutable creation ancestry, even though
the CI grants are intentionally absent. Metadata repair re-observes the exact
private registry ancestor rather than demanding restoration of revoked CI trust.
The actual SQLite counterexample initially resumed ordinary deployment with the
missing proof; it now offers the isolated repair. A same-name/time registry with
a foreign ownership marker blocks that repair. The saved approved billing account
also survives the handoff; two serialized binding regressions failed before that
projection was restored. This enables later publication/hosting actions to compare
the fresh billing association with the reviewed account rather than treating any
enabled account as equivalent. Historical cloud intents remain unchanged.

Final focused verification passed 98 tests across the ordinary application and
serialized-provider suites. A further suspected public-registry recovery gap was
falsified: a changed native ownership marker already produces read-only recovery
and keeps narrow deployment planning blocked, even with complete cached bindings.
The added regression checks that behavior; it required no runtime change.
Billing continuity uses the independent
[ProjectBillingInfo read contract](https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/getBillingInfo);
these offline results do not establish live publication or deployment.
