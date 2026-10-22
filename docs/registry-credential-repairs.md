# Registry credential repairs

`hv_plan scope="registry-credentials" services=["cron"]` reviews one existing
service's image-pull credentials independently of backup provisioning. The
current image, schedule, runtime configuration and applied deployment contract
must remain unchanged. Credentials come from the selected repository's verified
code-host connection and are frozen encrypted in the plan. No application env
file is read or written. Ordinary deployment backup gates remain in force.

The shared provider contract observes an exact bound target, including native
scope and instance identity, and validates the unchanged target immediately
before a credential-only write. Missing, ambiguous or unknown targets cannot be
adopted or recreated. Registry validation proves access to the exact image
manifest; it does not prove that the provider can start it. An acknowledged
write with non-retrievable credentials remains pending runtime verification.
Uncertain writes are retained and never automatically repeated.

Both MCP and CLI expose the same operation:

```sh
hypervibe plan --project my-app --env production --scope registry-credentials --services cron
```

Review and apply the returned plan ID. An accepted write is reported as pending,
because Railway does not expose stored registry credentials for readback. Use
`hv_inspect` and `hv_logs` for the next scheduled execution. Do not infer that a
credential update restarted or fixed the cron. Reapplying the same plan only
reports its recorded attempt. A separately reviewed plan requires exact action
confirmation before submitting credentials again, even after acknowledgment.

## Provider review (2026-10-22)

This review precedes implementation. Unsupported describes Hypervibe admission,
not absence of a native feature. No row establishes a successful live repair.

| Hosting provider | Native identity, update and recovery contract | Admission |
| --- | --- | --- |
| Railway | Project/environment/service/instance; `ServiceInstanceUpdateInput.registryCredentials` is separate from source and deploy. [Service API](https://docs.railway.com/integrations/api/manage-services), [private registries](https://docs.railway.com/guides/private-container-registry). Requires existing private-registry entitlement. Credentials cannot be read back through the pinned service-instance schema; explicit true acknowledgment and unchanged target still leave runtime verification pending. | Ready for live validation; pending does not certify cron success. |
| Cloud Run | Service or job in project/location; image authorization uses IAM or an Artifact Registry remote repository. [Deployment](https://docs.cloud.google.com/run/docs/deploying). IAM/remote-repository edits have a different authority boundary. | Unsupported. |
| ECS Express | Account/region/service ARN; registry credentials reference a Secrets Manager secret; service updates roll a revision. [Update API](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateExpressGatewayService.html). Secret ownership and revision recovery need independent validation. | Unsupported. |
| Azure Container Apps | Subscription/resource group/app; registry entries reference application secrets or managed identity. [Containers](https://learn.microsoft.com/en-us/azure/container-apps/containers), [secrets](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets). App secrets and revision configuration have different completion boundaries. | Unsupported. |
| Fly.io | App/Machine identity and version; [Machines API](https://docs.fly.io/api/machines) controls Machine configuration. A standalone durable credential-only update and readback have not been established here. | Unsupported; native semantics unverified. |
| DigitalOcean App Platform | App/component image spec, encrypted `registry_credentials`; [image deployment](https://docs.digitalocean.com/products/app-platform/how-to/deploy-from-container-images/). Requires preserving the full app and other components; completion/recovery needs separate implementation. | Unsupported. |
| Vercel | Project/deployment; [container deployments](https://vercel.com/kb/guide/does-vercel-support-docker-deployments). An existing deployment's external pull-credential repair has not been established here. | Unsupported; native semantics unverified. |

| Code host | Credential and validation contract | Admission |
| --- | --- | --- |
| GitHub | Exact repository-scoped verified connection (organization wildcard/global fallback permitted); `packageReadToken` and login. [GHCR authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) requires package read access. Validation uses the registry token/manifest protocol with fixed HTTPS destinations and no redirects. | Ready for live validation. |
| GitLab | [Registry authentication](https://docs.gitlab.com/user/packages/container_registry/authenticate_with_container_registry/) uses read_registry credentials and registry-specific scope. Self-hosted destinations need an independently approved origin. | Unsupported. |

Evidence: the counterexample is a bound cron and database with omitted backup
policy. The real planner previously routed the request into unrelated full-plan
prerequisites. Synthetic serialized transport tests use the pinned Railway
schema; they do not establish production token validity or a successful cron run.

The regression was observed failing with `A service-filtered plan cannot skip
pending daily backup policy configuration` before the implementation. It now
passes through the real planner, apply and serialized transport, including only
the selected service's credential update, unchanged images/other environments,
lost acknowledgments, post-write persistence failures and confirmed retries.
Ordinary deployment still fails the independent backup gate. The GHCR token
contract also exercises either documented `token`/`access_token` field, missing
or conflicting grants, denied manifest reads, redirects and response limits.

These tests run in ordinary `npm test`. The committed acceptance workflow and
desired required-check configuration both retain that suite and type checking;
live branch-protection enforcement was not inspected. No customer incident cause,
production image access, provider activation timing or successful scheduled run
is certified by these offline results.

Final local validation: 369 test files and 5,527 tests passed (three files/five
tests skipped and one todo); type checking and the build passed. The full suite
used system Python because the installed Homebrew Python could not import
`plistlib`, and ran outside the filesystem sandbox so its temporary PostgreSQL
instances and localhost HTTP servers could start. No live hosting repair ran.
