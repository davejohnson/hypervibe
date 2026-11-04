# Retire retained operator outputs

This slice adds local GCP Secret Manager container cleanup after the operator
registration's separate native retirement has completed with `data: "retain"`.
It does not clean customer-collected secrets. It does not read secret values.
Native deletion has not been tested; the evidence is offline serialized REST,
actual SQLite journals, and the ordinary application plan/apply path.

## Separate review and immutable history

The challenged assumption was that a completed retain disposition could never
be followed by an explicit review of the retained output data. That prevented
complete temporary-test cleanup. The new declaration uses the same
`operatorApplications.<name>.retirement` field with:

```json
{
  "from": { "installationId": "<original registration>", "planDigest": "<digest>" },
  "resources": "delete-owned",
  "data": "delete-owned",
  "continueFrom": { "installationId": "<completed retain retirement>", "planDigest": "<digest>" },
  "outputTargets": [{
    "from": { "installationId": "<original registration>", "planDigest": "<digest>" },
    "role": "api-key", "key": "SENDGRID_API_KEY", "version": "1"
  }]
}
```

Use `hv_spec` → `hv_plan` → confirm the exact container-delete action in
`hv_apply`. Keep the original declaration fields. `targets`, when present,
selects exact original creation ancestors; every output reference must belong to
that selected set. The continuation has a new installation and plan digest. It
cannot alter the completed retain receipt or replay key/application retirement.
Registration and output cleanup are separate reviews; first-stage combined
output `delete-owned` and individual-version-only deletion remain unsupported.

The original container binding, delivery reference and attempt evidence establish
ownership. Missing proof, uncertain delivery, a foreign journal, a changed native
lifetime, or a changed active successor blocks. Native key/trust retirement is
freshly inspected before output operations. Desired/current workloads, retained
runtime identities/grants and pending recovery work must already be removed.

GCP checks current project identity and project-scoped metadata read authority,
then the exact container's create time, owner/attempt labels, automatic
replication, complete version inventory, retention settings and IAM policy.
Unrecorded versions, managed readers/writers, changed replication or delayed
version destruction block; the driver does not revoke them or purge retention.
Human and inherited external administrators are not claimed to be quiesced.

Each action deletes the **entire container and all its versions**. Its current
version inventory is included in the review. Google documents that changing a
version does not change its parent secret ETag. Therefore the ETag does not lock
version membership: an external administrator can add a version after the final
check, and that version would also be deleted. This limitation is explicitly
included in the saved plan review; prevent external changes during cleanup.

The existing durable action journal is saved before DELETE. Lost acknowledgments
remain pending and recovery only reads the exact resource. A still-present or
unknown resource never causes automatic DELETE replay. Only verified absence
allows removal of the exact local binding by a full-binding compare-and-swap.
If that local update conflicts, a fresh read-only recovery plan finishes it;
prior registration, delivery and retirement receipts remain unchanged.

## Named provider matrix

| Hosting / secret provider | Operator-owned output cleanup | Native semantics and limits |
| --- | --- | --- |
| Cloud Run / GCP Secret Manager | Implemented offline; ready for native testing | Entire owned container, exact current recorded versions; ETag and readback; no value access. Changed replication, delayed destruction and extra versions block. |
| ECS / AWS Secrets Manager | Unsupported: no registered operator-output ownership/setup capability | DeleteSecret schedules whole-secret recovery (7–30 days); replicas differ; individual version deletion is not the same operation. No force-delete implementation. |
| Azure Container Apps / Key Vault | Unsupported: no registered operator-output ownership/setup capability | Whole-secret deletion enters soft-delete retention; purge is separate and can be prohibited by purge protection. |
| Railway | Unsupported: no registered operator-output capability | No inherited deletion authority from hosting or customer secret delivery. |

AWS and Azure customer secret delivery does not establish operator-container
ownership or authorize cleanup. Google OAuth/GitHub registrations without native
retirement remain blocked prerequisites, even if their output is in GCP.

## Independent contracts and regression evidence

Official contracts checked 2026-11-03:

- [Secret Manager DELETE and ETag](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/delete).
- [Project read authority](https://docs.cloud.google.com/resource-manager/reference/rest/v1/projects/testIamPermissions)
  and [secret IAM policy](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/getIamPolicy).
- [Secret Manager version inventory](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets.versions/list).
- [Independent secret/version ETags](https://docs.cloud.google.com/secret-manager/docs/etags).
- [Delayed version destruction](https://docs.cloud.google.com/secret-manager/docs/destroy-secret-version).
- [AWS DeleteSecret](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DeleteSecret.html).
- [Azure Delete Secret](https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/delete-secret/delete-secret?view=rest-keyvault-secrets-2025-07-01)
  and [soft-delete retention](https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview).

The real SQLite/kernel test first rejected the separate continuation. A second
counterexample admitted a foreign output source; it now rejects that source
before the provider plan is called. The application test creates an actual
SendGrid registration and delivers its output through reconstructed transports,
retires the dedicated native key, then separately deletes the owned GCP output.
It covers lost DELETE acknowledgement, denied readback, binding/consumer drift,
and a concurrent unrelated binding update. The last three recovery variants
first exposed skipped local binding cleanup after the native terminal receipt;
they now require a read-only finalization action instead of silently reporting a
noop. All these tests remain in the ordinary `npm test` path. Offline success
establishes the modeled contracts, not live provider compatibility or branch
protection enforcement.
