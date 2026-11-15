# Storage runtime identity

Storage management authentication and workload authentication have different
roles. Resolving a compatible connection alias does not authorize copying its
management key into an application. The shared runtime target carries the
actual selected connection provider and, when the storage capability needs it,
provider-owned workload identity evidence for each consuming service.

| Named storage provider | Runtime authentication after this change | Scope and limitations |
| --- | --- | --- |
| Google Cloud Storage on Cloud Run | Assigned workload identity through ADC; reused deploy key is excluded and its legacy runtime slot cleared | Exact observed workload principal and GCP project must match. Confirmed-absent unbound resources return configured identity, not live proof. |
| Google Cloud Storage on another host | Existing explicitly selected standalone GCS service-account JSON | A Cloud Run connection alias cannot supply it. The separate credential's permissions remain caller-owned; this change does not attest least privilege for that key. |
| Amazon S3 | Existing S3 runtime access-key contract | Unchanged. Temporary SDK/CLI sessions remain rejected for runtime projection; this change does not implement ECS workload identity. |
| Azure Blob Storage | Existing connection string for the resource's dedicated storage account | Unchanged. This change does not implement Azure managed identity. |
| Railway Buckets | Existing provider bucket credentials and native reference wiring | Unchanged. No GCP identity logic enters this adapter. |

The registry matrix in `test/provider-conformance/provider-matrix.test.ts`
requires every named storage provider to remain represented. Existing S3,
Azure, Railway and GCS lifecycle/runtime tests remain in ordinary acceptance.
The new composed GCS test executes shared runtime resolution and storage apply
through real adapters and a synthetic HTTP transport, including clearing the
legacy key in the serialized Cloud Run update. It does not prove live IAM.

GCS declares a versioned runtime projection in the provider registry. An
existing binding without that version plans reviewed wiring for each consumer,
even when every environment variable name is already present. Apply checks the
planned version and records it for that consumer only after the provider's
verified environment update succeeds. All wiring actions become no-ops once every consumer has converged. This records applied configuration; it is not continuous proof
that a credential has never been reintroduced outside Hypervibe.

Cloud Run identity reads validate the bound project and canonical region before
querying the exact service or job. A missing bound resource, a same-named unbound
resource, an unknown read, or a different principal cannot authorize ADC wiring.

## Reviewed GCP preparation

`hv_connections` with `provider="cloudrun"`, `action="prepare"`, and
`gcsAccess="lifecycle"` first previews the exact principals and roles, including
the runtime principal when a distinct runtime identity is configured.
The deployer receives `roles/storage.admin`; a configured distinct runtime
account receives `roles/storage.objectUser`. The latter can create, read,
update and delete objects, without administering buckets. Actual grants remain
behind the existing explicit confirmation boundary.

**Both grants use the existing project IAM lifecycle. Runtime object access
therefore spans all buckets in that GCP project.** It is not bucket-scoped or
isolation between environments in one project. Bucket-specific runtime grants
would require separately observed and reconciled bucket IAM desired state;
that lifecycle is not implemented here. Inspection-only preparation does not
grant runtime object access.

Independent contracts:

- [Cloud Run service identity and ADC](https://cloud.google.com/run/docs/securing/service-identity)
- [Cloud Storage IAM roles and resource scope](https://cloud.google.com/storage/docs/access-control/iam-roles)
- [Service-account key handling](https://cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys)
- [AWS SDK credential providers](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
- [Azure Storage connection strings](https://learn.microsoft.com/azure/storage/common/storage-configure-connection-string)
- [Railway bucket access](https://docs.railway.com/guides/storage-buckets)
