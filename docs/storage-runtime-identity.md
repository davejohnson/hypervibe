# Storage runtime identity

Storage management authentication and workload authentication have different
roles. Resolving a compatible connection alias does not authorize copying its
management key into an application. The shared runtime target carries the
actual selected connection provider and, when the storage capability needs it,
provider-owned workload identity evidence for each consuming service.

| Named storage provider | Runtime authentication | Scope and limitations |
| --- | --- | --- |
| GCS on Cloud Run | Per-service workload ADC; legacy key cleared | Exact observed account lifetime and reviewed bucket IAM grant are required. Broader project access blocks preparation. |
| S3 on ECS | Observed application task role; access-key slots cleared | Exact immutable role, bucket ownership and reviewed inline policy are verified. |
| Azure Blob on Container Apps | Observed managed identity; account-key connection string cleared | Exact container grant and application availability are verified. User-assigned identities retain their native lifetime and explicit client ID. |
| Explicit standalone storage connection on another host | Existing provider-specific runtime credential | Management aliases do not authorize credential copying; caller-owned standalone key permissions are not attested here. |
| Railway Buckets | Existing bucket credentials and native references | Separate native mechanism; no workload IAM grant port. |

The existing runtime-access lifecycle prepares identities and storage grants as
separate reviewed actions. Storage wiring consumes the exact persisted grant and
per-service identity; it performs no permission writes. Removal preserves the
permission binding until the provider confirms it is absent, then clears runtime
configuration. A successful grant read is not proof of application authentication.

Versioned runtime contracts make legacy consumers plan a reviewed configuration
update even when their environment variable names already exist. Only verified
provider environment updates record convergence for that consumer. The GCS contract
is now `gcs-native-adc-v2`; S3 and Azure declare their own native identity contracts.

Older GCP preparation could give a configured shared runtime account project-wide
object access. That permission is preserved for explicit review; the bucket-grant
adapter does not claim isolation while broader or unknown project grants remain.

See [storage workload access evidence](storage-runtime-access-evidence.md) for the
complete provider roster, observed regression failures, native transport coverage
and remaining live and concurrent-writer limitations.

Independent contracts:

- [Cloud Run service identity and ADC](https://cloud.google.com/run/docs/securing/service-identity)
- [Cloud Storage IAM roles and resource scope](https://cloud.google.com/storage/docs/access-control/iam-roles)
- [Service-account key handling](https://cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys)
- [AWS SDK credential providers](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
- [Azure Storage connection strings](https://learn.microsoft.com/azure/storage/common/storage-configure-connection-string)
- [Railway bucket access](https://docs.railway.com/guides/storage-buckets)
