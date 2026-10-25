# Deployment source authorization

Moving a deployment from a feature branch to the repository default branch is a
separately reviewed source-authority transition. GitHub requires the workflow on
the [default branch for workflow_dispatch](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
Re-pairing a device does not authorize that transition.

The original `CloudDeploymentConnectionV1` and its installation source, plan,
native principals, runtime identities and prepared resources remain unchanged.
Prepared-resource markers continue hashing that exact original receipt. The
separate `CloudDeploymentSourceAuthorizationV1` stores its own UUID, original
connection digest, predecessor authority digest, previous source, newly reviewed
source and canonical digest. Its initial predecessor hashes the original source
and connection digest. Later transitions name the previous approved digest.

The shared parser validates shape, connection correlation and digest; it is not
evidence of approval. Hypercloud must obtain current owner approval, independently
verify native repository/default-branch/source evidence, and compare-and-swap the
active predecessor. The pure proposal helper verifies the existing provider-owned
placement contract. A transferred branch receives the same fixed native scope;
source authorization cannot create principals, broaden IAM or adopt resources.

The effective-source helper is used separately from native identity. It governs
the local adapter's current branch, hosted release-target source checks, generated
CI access and Cloud Run pending-release provenance. Native session and target
verification still receive the original connection and retain their independent
identity, permission and completion checks.

| Provider | Preserved evidence | Source transition boundary |
| --- | --- | --- |
| AWS ECS | Original CloudFormation installation, role ARNs/RoleIds/audiences, task/execution/infrastructure identities | Shared validator and source authority; normal native session and ECS/ECR target proof remain required |
| Azure Container Apps | Original ARM provenance, UAMI principal/client/resource IDs, exact grants and prepared-resource digest | Shared validator and source authority; normal native session and app/registry target proof remain required |
| GCP Cloud Run | Original project lifetime, SA UIDs, workload/registry/secret lifetimes and holding revision | Shared validator and source authority; prepared observer uses effective source while retaining original receipt digest |

The existing deployment-provider roster requires explicit review for new hosting
providers. Shared source tests exercise AWS, Azure and GCP separately. Other
hosting providers gain no hosted deployment authority from this contract.

The expected application workflow is: retain the old connection/device association,
propose the exact default-branch source from a clean checkout, obtain owner
approval, pair a new device capability for the approved branch, then use ordinary
plan/apply to publish the managed program and request its separate CI approval.
The old branch may be deleted. Historical proposal/status recovery must use the
durable association without depending on that deleted branch. An old device is
never silently granted authority over the new branch. Its already issued native credentials
retain their native expiry; approval does not promise instant revocation.

The host must reject old-branch issuance after the transition, supersede old CI
policies, and recheck the active authority before and after minting. A proposal
UUID and predecessor stay fixed through lost-response recovery. The local client
must retain its old encrypted grant until a verified replacement exchange is
durably stored. No second consuming exchange may be inferred from a lost response.

The challenged assumption was that all current source checks could continue using
the immutable installation branch. The counterexample is a separately approved
default-branch release using the same native identities: the old shared verifier
rejected it, accepted old-branch proof despite the supplied new authority, and all
three adapter validators discarded the separate authority. Eight shared tests
failed before implementation and pass afterward. A reconstructed native GCP
transport test additionally failed to retire a verified first release from the
new branch; it now retires only that approved branch and preserves the receipt
digest. The unchanged branch case still passes.

These are offline boundary and reconstructed-transport results, not live cloud or
GitHub compatibility. Hypercloud owner-review/CAS, device exchange recovery and
generated-program acceptance are separate integration gates against the actual
packaged library. The provider disposable-account walkthroughs remain required.
