# OpenTofu engine on Azure

The Azure backend for the [OpenTofu engine](opentofu-engine.md). It follows the
same lifecycle as GCP and [AWS](opentofu-engine-aws.md) (`hv_spec` → `hv_plan` →
approved `hv_apply`), with the same local encrypted state, saved plans, approvals
and receipts. This page records the Azure-specific decisions and why they were made.

## Status (2026-11-12)

Nothing below has run against Azure yet. "Built" means implemented, unit-tested with
mocked HTTP and, for configuration, passing `tofu validate`.

| Piece | State |
| --- | --- |
| Sign-in without the Azure CLI | Built; not yet run live |
| One-time setup (resource group, project Key Vault, deploy identity, roles, GitHub OIDC, client secret) | Built; not yet run live |
| OpenTofu authenticates as the deploy identity (read-only probe) | Built; not yet run live |
| Outside keys, `needs_secrets` and `hv_secrets action="collect"` (Key Vault store) | Built; not yet run live |
| Testing environments: `hv_plan scope="infrastructure"` → `hv_apply` → `hv_deploy` for web, on-demand worker, cron, database, storage and secrets | Built; `tofu validate` passes with `azurerm` 5.11.0; never planned or applied |
| Shared server and registry for testing environments (one database and login each) | Built; not yet run live |
| First image built inside the infrastructure apply (no second plan round) | Built; not yet run live |
| Environment teardown (`hv_plan scope="teardown"`) | Built; not yet run live |
| Production profile (staging, production), `hv_launch`, `hv_migrate`, CI releases, custom domains | Not built |

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
  - `hv-<project>-<suffix>` (Key Vault): every environment's secrets, named
    `<environment>--<key>`. It exists before any plan, so outside keys can be
    collected first, as Parameter Store allows on AWS.
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
    - Key Vault Secrets Officer: write, delete and purge the app's secrets.
    - Storage Blob Data Contributor: empty storage before teardown (accounts have no
      shared keys).
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
- **The Azure CLI's public client (kept, decided 2026-11-12).** It is preauthorized
  for Resource Manager and Graph in every tenant, so there is no consent screen or app
  to publish. Microsoft does not document its use by other tools; Conditional Access
  policies that target "Microsoft Azure CLI" apply, and the consent page names it. A
  Hypervibe-owned multi-tenant app would need publisher verification and admin consent
  in each tenant.

## Runtime choices (testing profile)

Profiles come from the environment name, as on every cloud: names matching
`/prod|stag/i` use the production shape; everything else is testing. A project's
testing environments share **one PostgreSQL server and one registry** (decided
2026-11-12); staging and production will each get their own.

| Piece | Choice | Idle cost (eastus2) |
| --- | --- | --- |
| Web | Container Apps, consumption plan, `min_replicas = 0`, 0.25 vCPU / 0.5 GiB | $0 |
| On-demand worker | Container App at zero replicas, KEDA PostgreSQL scale rule | $0 |
| Cron | Container Apps Job, schedule trigger (UTC) | $0 between runs |
| Container Apps environment | Consumption only, per environment: no workload profile, private endpoint or maintenance window | $0 |
| Database | Shared Flexible Server, Burstable B1ms, 32 GiB; one database and login per environment | about $16.10/mo per project |
| Images | Shared Container Registry Basic, built with ACR Tasks | about $5.00/mo per project |
| Secrets | Project Key Vault (Standard, RBAC), referenced by the Container Apps | about $0 |
| Files | Storage account per environment (Standard LRS), private containers, no shared keys | $0.0184/GB-mo |
| Logs | Log Analytics per environment, 30-day retention, 0.15 GB/day cap | $0 (inside the 5 GB/mo free allowance) |

The first testing environment costs about **$21/month idle**; each additional one
adds almost nothing.

### Two states per environment

- The **shared** state (`project-shared` partition, `shared-testing`) holds the
  server and registry. Every testing environment's plan includes it, so the first one
  creates them and later ones see no changes.
- The **environment** state holds the Container Apps environment, logs, the runtime
  identity and its roles, storage and the workloads.
- One `hv_plan` reviews both as two engine segments, plus Hypervibe's own actions,
  in dependency order: shared resources → generated secrets → image build →
  database login → environment resources.

### Pieces

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
- **Secrets as Key Vault references.** Each workload reads its secrets from the project
  vault with the environment's runtime identity, and values never enter
  configuration or state. The identity gets Key Vault Secrets User on each of its own
  secrets (secret-level scope), not on the vault, so environments cannot read each
  other's. Every referenced secret exists before the workloads are created:
  - generated secrets are written by plan actions
  - outside keys are collected first (`missingOutsideKeysMessage`)
  - `DATABASE_URL` is written by the login action

  Teardown deletes and purges the environment's secrets, so a recreated environment
  can reuse the names. `engineSecretStore()` (#608) returns this store for Azure
  environments. Key Vault Standard charges $0.03 per 10,000 operations and nothing
  per secret.
- **Runtime identity.** A user-assigned managed identity per environment. New role
  assignments take a minute or two to apply, so a 90-second `time_sleep` sits between
  them and the first revision. The configuration sets `AZURE_CLIENT_ID` so
  `DefaultAzureCredential` uses the identity. Storage accounts have shared keys
  turned off, so apps use the Azure SDK with that identity, not connection strings.
  Blob Storage has no S3-compatible API, so `access: "s3"` is refused.
- **Database: one shared Flexible Server B1ms.** $0.017/hour ($12.41/month) plus
  32 GiB at $0.115/GiB-month ($3.68). There is no scale-to-zero option:
  - Stopping a server bills only storage
    ([pricing](https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/)),
    but Azure starts it again after 7 days
    ([docs](https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/how-to-stop-server)).
  - Azure SQL Database serverless pauses, but it is not PostgreSQL.
  - Azure HorizonDB is in preview and is not serverless
    ([InfoWorld](https://www.infoworld.com/article/4207403/microsofts-postgresql-alternative-horizondb-worth-the-wait.html)).

  Sharing the server makes each further testing environment nearly free. Testing
  environments must therefore use one PostgreSQL version.
- **The app's database login.** Flexible Server has no SQL-over-HTTPS API like
  Aurora's Data API or Cloud SQL's, so there is no Azure-native way to create a login
  without connecting to the server.
  - Hypervibe connects as the deploy identity, which is the server's Entra
    administrator. It uses a short-lived Entra token as the password, so no password
    is stored, and TLS with the certificate verified against the host name (Node's CA
    store includes Azure's roots).
  - It creates `app_<env>` (login and database owner) and, for on-demand workers, a
    read-only `waker_<env>`. Only those logins may connect to the environment's
    database. Passwords travel only as SCRAM verifiers.
  - `DATABASE_URL` (`sslmode=require`) goes to Key Vault.
  - The administrator password comes from an ephemeral `random_password`, sent as
    the write-only `administrator_password_wo`. Nobody holds it.
- **Database network: public endpoint, TLS required.** Consumption-plan Container Apps
  have no fixed outbound address, so the firewall allows all addresses; Flexible Server
  requires TLS by default and every password is generated. This is the same tradeoff
  as Aurora on AWS, and it is also what lets Hypervibe create the login from this
  computer.
- **On-demand worker.** KEDA's PostgreSQL scaler counts `onDemand.pendingWorkQuery`
  once a minute with the read-only login and starts one replica while the count is
  above zero; it scales back to zero after 5 idle minutes.
  - Every count is a connection, but the server never pauses on Azure, so counting
    keeps nothing awake that would otherwise sleep.
  - `nextWorkAtQuery` is not needed: work due later is counted on the first poll
    after it becomes due.
  - Workers without `onDemand` keep one replica.
- **Cron.** Container Apps Jobs with a schedule trigger. Schedules run in UTC; a
  `timeZone` other than UTC is refused.
- **Images: ACR Tasks from the exact local commit.** Hypervibe makes a `git archive`
  (tar.gz) of `HEAD` with the repository's Dockerfile or the generated one, uploads it
  to the registry's build-source blob, schedules a Docker build and records the
  digest from the run output (it refuses a tag without a digest).
  - Basic is $0.1666/day (about $5/month, 10 GB included).
  - ACR Tasks bills $0.0001 per vCPU-second, so a three-minute build costs about
    2 cents. A commit is rebuilt each time it is released.
  - Microsoft pauses ACR Tasks on free-credit (trial and student) subscriptions;
    Hypervibe says to upgrade to pay-as-you-go
    ([Q&A](https://learn.microsoft.com/en-us/answers/questions/2140587/tasksoperationsnotallowed-error-using-free-azure-a)).
- **No second plan round.** When an environment has no image and Hypervibe finds the
  project's local repository, the infrastructure plan includes a `build:image` action:
  the apply builds `HEAD`, then creates the workloads from it.
  - The workloads are configured with the commit's tag and released by digest
    afterwards.
  - Without a local repository, it falls back to AWS's flow (`hv_deploy` builds, then
    plan again).
- **Releases (`hv_deploy`).** Builds the commit, then PATCHes each Container App and
  job template with the digest. Only the image changes, and the configuration
  ignores `template[0].container[0].image`, so releases are not drift.
- **Health checks that platform pages cannot fool.** After a web release, Hypervibe
  waits for a new ready revision, then requests the health path (a scaled-to-zero app
  starts on that request).
  - The gateway's 502/503/504 and the "Container App is stopped or does not exist"
    page count as not started, never as healthy.
  - Azure must also report the revision healthy.
- **Names.** The server, registry, storage account and Key Vault names are global, so
  each gets a 6-character suffix from the subscription and project or environment.
  Plain environment values are written as literals (`${` and `%{` escaped).

Prices are list prices for `eastus2` from the
[Azure Retail Prices API](https://prices.azure.com/api/retail/prices), read 2026-11-12.

## Teardown

`hv_plan scope="teardown"` removes a testing environment as one reviewed plan, with
every destructive action confirmed separately:

1. Hypervibe empties each storage container.
2. OpenTofu destroys the environment's resources.
3. Hypervibe drops the environment's database and logins from the shared server.
   Other environments' databases are untouched.
4. When no other testing environment remains in the spec, OpenTofu also destroys
   the shared server and registry.
5. Hypervibe deletes and purges the environment's Key Vault secrets, confirms nothing
   tagged for the environment (or the shared group, if removed) remains, clears the
   bindings and removes the environment from the spec.

**No final snapshot.** Flexible Server has no manual snapshot of one database: a
dropped database is gone, and the server's automatic backups (7 days) cover it only
while the server exists. `deleteFinalSnapshot` is therefore refused on Azure, and the
plan warns to export data first. The resource group, Key Vault and deploy identity
stay for the project's other environments.

## Provider pins

- `hashicorp/azurerm` 5.11.0 (released 2026-10-23), `hashicorp/random` 3.9.1 and
  `hashicorp/time` 0.14.2 (both released 2026-09-11), each with 15 `h1:` lock hashes
  from `tofu providers lock` for darwin and linux (amd64 and arm64) and windows amd64.
- OpenTofu 1.13.9 supports the ephemeral resources and write-only attributes the
  database uses.

## Next

1. Live: sign in and run setup once; plan, apply and deploy the demo app to a testing
   environment; tear it down.
2. The production profile (own server and registry, web always on), `hv_launch` and
   `hv_migrate` for Azure, CI releases with the GitHub federated credentials.
