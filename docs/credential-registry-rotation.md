# Container registry credential rotation

The same reviewed credential lifecycle now registers password-copy capabilities
for Railway, ECS, Azure Container Apps, DigitalOcean and Cloud Run remote Artifact
Registry repositories. Fly and Vercel declare their native registry/build-input
models and direct external package tokens to their actual CI/build consumers.
No adapter creates a missing service, secret or registry to make inspection work.

The challenged assumption was that a registry credential could only be updated
through Railway, or that deployment credentials and image-pull credentials were
interchangeable. Counterexamples are an ECS task with an existing Secrets Manager
reference, an Azure app with a registry passwordSecretRef, a DigitalOcean image
with its own encrypted credential, and a Cloud Run image backed by a remote
Artifact Registry upstream. Each has a distinct, documented native destination.
The provider/source roster is enforced in
`test/provider-contracts/scoped-secret-provider-contracts.test.ts` and the
[credential lifecycle table](credential-lifecycle.md#provider-boundary-review).

The new serialized HTTP contract tests first failed for all four missing provider
factories. The direct native-copy tests then passed. Two additional pinned and
versionless Azure Key Vault cases failed against the initial direct-secret-only
writer before the Key Vault implementation made them pass. Tests use synthetic
responses shaped from official contracts, not recorded live service observations.

- ECS reads and updates only the existing repositoryCredentials ARN. JSON fields
  other than username/password remain intact. The encrypted plan's stable operation
  ID supplies PutSecretValue's ClientRequestToken. Reconciliation privately reads
  accepted contents and reuses the same native idempotency identity.
- Azure preserves the complete app configuration, unrelated secret values and
  Key Vault references. Direct secrets wait for rollout. Existing Key Vault
  secrets use [Set Secret](https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/set-secret)
  with a vault-scoped token; pinned references advance only to the verified new
  version, while versionless references remain versionless. Tags, content type,
  enabled state and explicit expiry are preserved. Versionless refresh can restart
  active revisions; the plan reports that effect. Uncertain version writes only
  resume when the replacement version can be privately read.
- DigitalOcean replaces only the selected component image's registry_credentials
  in the full observed app spec, retaining opaque encrypted unrelated values and
  image digest/tag. An acknowledged update starts its native deployment. Encrypted
  values remain write-only; an uncertain update cannot be blindly repeated.
- Cloud Run preserves the bound workload and Artifact Registry upstream identity.
  It adds a version to the existing Secret Manager secret and updates only the
  remote repository's credential reference. Its stable reviewed target excludes
  the mutable version number. A lost addVersion response is reconciled by reading
  existing replacement evidence; an inconclusive latest alias never authorizes
  another version on an uncertain retry.

Configuration readback or acknowledgement does not prove a new image was pulled,
that all old instances have stopped, or that an application operation succeeded.
Those remain separate managed-rollout and application-verification outcomes. The
tests run in ordinary `npm test`; `.github/workflows/hypervibe-acceptance.yml` and
the desired `.hypervibe/spec.json` acceptance check both invoke it. Live provider
permissions/convergence and live branch-protection enforcement were not tested.
