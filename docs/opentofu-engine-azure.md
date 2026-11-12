# OpenTofu engine on Azure

The Azure backend for the [OpenTofu engine](opentofu-engine.md). It follows the
same lifecycle as GCP and [AWS](opentofu-engine-aws.md) (`hv_spec` → `hv_plan` →
approved `hv_apply`), with the same local encrypted state, saved plans, approvals
and receipts. This page records the Azure-specific decisions and why they were made.

## Status (2026-11-12)

| Piece | State |
| --- | --- |
| Sign-in without the Azure CLI | Built; unit-tested with mocked HTTP; not yet run live |
| One-time setup (resource group, deploy identity, roles, GitHub OIDC, client secret) | Built; unit-tested with mocked HTTP; not yet run live |
| OpenTofu authenticates as the deploy identity (read-only probe) | Built; `tofu validate` passes; not yet run live |
| Testing-profile configuration: web, database, storage, secrets | Built; `tofu validate` passes with `azurerm` 5.11.0; never planned or applied |
| `hv_plan` for Azure environments | Blocked with a clear message (see below) |
| Writing secrets to Key Vault, the app's database login, image builds, releases | Not built |
| Workers (KEDA), cron (Container Apps Jobs), production profile, teardown, CI | Not built |

Plans stay blocked until Hypervibe can also write the environment's secrets, create
the app's database login and build an image. Without those, an apply would create
Container Apps that cannot start.

## Access

- **Sign-in.** Hypervibe runs the OAuth 2.0 authorization-code flow with PKCE
  against Microsoft Entra ID, with the Azure CLI's public client
  (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) and a loopback redirect, the way `az login`
  does. Nothing to install. That client's registered redirect is `http://localhost`,
  and Entra ignores the port for localhost redirects
  ([redirect URI rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)),
  so the callback is `http://localhost:<port>/`. Tokens stay in memory.
- **Directories.** The sign-in uses the `organizations` authority. Hypervibe lists
  the person's directories and redeems the refresh token in each one to find
  subscriptions, the way the Azure CLI does. A directory that needs another MFA
  prompt is reported, not skipped silently.
- **Subscription.** One enabled subscription is used without asking. With several,
  Hypervibe asks which one pays: that is a billing decision, not a routine choice.
- **One sign-in, one click.** After signing in, the local page lists the exact
  changes and the person approves them there (or in chat, with
  `azureSubscriptionId` and `azureApproved=true`).
- **What setup creates** (all free):
  - The resource providers the engine uses (`Microsoft.App`, `.ContainerRegistry`,
    `.DBforPostgreSQL`, `.KeyVault`, `.ManagedIdentity`, `.OperationalInsights`,
    `.Storage`). Registering needs subscription rights, so the deploy identity cannot
    do it; the engine runs with `resource_provider_registrations = "none"`.
  - `hv-<project>` (resource group): everything Hypervibe builds for the project.
    An existing group without the `managed-by=hypervibe` tag stops setup.
  - `hypervibe-deploy-<project>` (app registration and service principal), created
    idempotently with Graph's `uniqueName` upsert
    ([docs](https://learn.microsoft.com/en-us/graph/api/application-upsert?view=graph-rest-1.0)).
    GitHub Actions signs in with federated credentials, one per Azure environment
    (`repo:<owner>/<repo>:environment:<env>`); Entra matches subjects exactly.
  - A client secret, valid one year, stored encrypted as the `azure` connection and
    never shown. Running connect again before expiry reuses it; within 30 days of
    expiry it creates a new one.
  - Roles **on `hv-<project>` only**, never on the subscription:
    - Contributor: create and change the app's resources.
    - Key Vault Secrets Officer: write the app's secrets.
    - Role Based Access Control Administrator, with an ABAC condition that allows
      assigning only AcrPull, Key Vault Secrets User and Storage Blob Data
      Contributor, only to service principals
      ([condition format](https://learn.microsoft.com/en-us/azure/role-based-access-control/delegate-role-assignments-examples)).
      This is Azure's equivalent of the AWS permissions boundary: the deploy
      identity cannot give itself or anyone Owner, Contributor or role administration.
- **Who can run setup:** an Owner (or Contributor plus User Access Administrator) of
  the subscription, in a directory where they may register apps (the default).
- **Region** follows the app's other environments, otherwise `eastus2`. Hypervibe
  states the choice; it does not ask.

### Why these choices

- **An app registration, not a managed identity, for the deploy identity.** A
  user-assigned managed identity has no credential this computer can hold; it signs
  in only on Azure or through federation. A federated issuer for this computer would
  need a public OIDC endpoint. The app registration takes both a secret (this computer)
  and federated credentials (GitHub). The cost is a Microsoft Graph call at setup.
- **A client secret, not a certificate.** `azurerm` accepts a secret or a PKCS#12
  bundle; Node has no built-in PKCS#12 or certificate writer. The secret goes only
  to the engine process and is redacted from all output. `azurerm` cannot take a
  pre-issued access token, so unlike AWS there is no one-hour credential to hand over.
- **One resource group per project, not per environment.** The deploy identity cannot
  create resource groups and then grant itself access without subscription-wide role
  administration. One group per project means a new environment needs no new sign-in.
  Environments are separated by name and the `hv-environment` tag.
- **The Azure CLI's public client.** It is preauthorized for Resource Manager and
  Graph in every tenant, so there is no consent screen or app to publish. Microsoft
  does not document its use by other tools; Conditional Access policies that target
  "Microsoft Azure CLI" apply, and the consent page names it. The alternative is a
  Hypervibe-owned multi-tenant app: it needs publisher verification and admin consent
  in each tenant (see Open questions).

## Runtime choices (testing profile)

Profiles come from the environment name, as on every cloud: `production` and
`staging` share the production profile; everything else is testing. Only the testing
profile is configured so far.

| Piece | Choice | Idle cost (eastus2) |
| --- | --- | --- |
| Web | Container Apps, consumption plan, `min_replicas = 0`, 0.25 vCPU / 0.5 GiB | $0 |
| Container Apps environment | Consumption only: no workload profile, private endpoint or maintenance window | $0 |
| Database | PostgreSQL Flexible Server, Burstable B1ms, 32 GiB | about $16.10/mo |
| Images | Container Registry Basic | about $5.00/mo |
| Secrets | Key Vault Standard, RBAC mode, referenced by Container Apps | about $0 |
| Files | Storage account (Standard LRS), private containers, no shared keys | $0.0184/GB-mo |
| Logs | Log Analytics, 30-day retention, 0.15 GB/day cap | $0 (inside the 5 GB/mo free allowance) |

A testing environment costs about **$21/month idle**, almost all of it the database.

- **Container Apps.** Billed per second; the first 180,000 vCPU-seconds, 360,000
  GiB-seconds and 2 million requests per subscription each month are free
  ([pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/)).
  After that: $0.000024/vCPU-s and $0.000003/GiB-s active, $0.000003 idle, $0.40 per
  million requests. A consumption-only environment has no environment charge, but
  configuring a planned-maintenance window bills the "Environment Management Hour"
  meter at $0.10/hour (about $73/month)
  ([report](https://learn.microsoft.com/en-us/answers/questions/6066720/is-a-planned-maintenance-window-honored-and-billed),
  [meter names](https://github.com/microsoft/azure-container-apps/issues/1886)).
  Hypervibe never sets one.
- **Secrets as Key Vault references.** Each Container App reads its secrets from Key
  Vault with the runtime identity; values never enter configuration or state.
  Container Apps' own secrets would put values in engine state. Key Vault Standard
  charges $0.03 per 10,000 operations and nothing per secret. Vaults are soft-deleted
  for 7 days; purging needs subscription-level access, so vault names carry a stable
  per-environment suffix and a deleted vault is left to expire.
- **Runtime identity.** A user-assigned managed identity per environment, created
  before the app so its pull and secret roles exist when the first revision starts.
  The configuration sets `AZURE_CLIENT_ID` so `DefaultAzureCredential` uses it. Storage
  accounts have shared keys turned off: apps use the Azure SDK with that identity, not
  connection strings. Blob Storage has no S3-compatible API, so `access: "s3"` is refused.
- **Database: Flexible Server B1ms (decided 2026-11-12).** $0.017/hour ($12.41/month)
  plus 32 GiB at $0.115/GiB-month ($3.68). There is no scale-to-zero option:
  - Stopping a server bills only storage
    ([pricing](https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/)),
    but Azure starts it again after 7 days
    ([docs](https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/how-to-stop-server)),
    so an idle-stopper would need to stop it again weekly. Possible later; not built.
  - Azure SQL Database serverless pauses, but it is not PostgreSQL.
  - Azure HorizonDB is in preview and is not serverless
    ([InfoWorld](https://www.infoworld.com/article/4207403/microsofts-postgresql-alternative-horizondb-worth-the-wait.html)).
  - Burstable is "not recommended for production" by Microsoft
    ([compute tiers](https://learn.microsoft.com/en-us/azure/postgresql/compute-storage/concepts-compute)),
    but it matches the cost of AWS's `db.t4g.micro` production choice.
- **Database secrets.** The administrator password comes from an ephemeral
  `random_password` and is sent as the write-only `administrator_password_wo`, so it
  never appears in configuration, plan or state; nobody holds it. The deploy identity
  is the server's Entra administrator, and Hypervibe will create the app's own login
  with an Entra token and write `DATABASE_URL` to Key Vault (not built yet).
- **Database network: public endpoint, TLS required.** Consumption-plan Container Apps
  have no fixed outbound address, so the firewall allows all addresses; Flexible Server
  requires TLS by default, and every password is generated (the administrator's is 40
  characters). The same tradeoff as Aurora on AWS. Private networking would need a
  VNet-integrated environment.
- **Images: ACR Basic, built with ACR Tasks (not built yet).** Basic is $0.1666/day
  (about $5/month, 10 GB included). ACR Tasks bills $0.0001 per vCPU-second, so a
  three-minute build costs about 2 cents and needs no local Docker. Microsoft pauses
  ACR Tasks on free-credit (trial and student) subscriptions; those need
  pay-as-you-go
  ([Q&A](https://learn.microsoft.com/en-us/answers/questions/2140587/tasksoperationsnotallowed-error-using-free-azure-a)).
  The registry is per environment for now; sharing one per project would save $5 per
  additional environment.
- **Names.** Storage account, Key Vault, registry and database server names are
  global, so each gets a 6-character suffix from the subscription and environment id.
  Plain environment values are written as literals (`${` and `%{` escaped).

Prices are list prices for `eastus2` from the
[Azure Retail Prices API](https://prices.azure.com/api/retail/prices), read 2026-11-12.

## Provider pins

- `hashicorp/azurerm` 5.11.0 (released 2026-10-23) and `hashicorp/random` 3.9.1
  (released 2026-09-11), each with 15 `h1:` lock hashes from `tofu providers lock`
  for darwin and linux (amd64 and arm64) and windows amd64.
- OpenTofu 1.13.9 supports the ephemeral resources and write-only attributes the
  database uses.

## Next

1. Live: sign in and run setup once; run the read-only engine probe.
2. Key Vault secret writes, the app's database login (Entra token), ACR Tasks builds
   and releases; then unblock `hv_plan` for testing environments.
3. Workers (Container Apps with KEDA scale rules, scaled to zero), cron (Container
   Apps Jobs), teardown, the production profile, CI.

## Open questions

- Keep the Azure CLI's public client, or publish a Hypervibe multi-tenant app
  (publisher verification, admin consent per tenant)?
- Share one Flexible Server per project across testing environments (one database
  each), so each additional preview environment adds about $0 instead of $16/month?
