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
