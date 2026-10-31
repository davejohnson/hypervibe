# Direct credential delivery contracts

Reviewed 2026-10-24. The intended outcome is an owner submitting an application
credential through hosted Hypervibe directly to an approved cloud secret
destination. The local CLI, committed files, plans, receipts and queues retain
references, never submitted values. Delivery and workload rollout are separate.

The existing secret-source port resolves values for local deployment. It cannot
provide this contract: resolving a manager reference would put its value back
into the encrypted plan. A destination driver instead accepts a transient value
and returns a validated native immutable version reference. The host must
authorize the account/repository/environment/key/source and exact destination,
persist an attempt, and atomically claim it before calling `deliver` once.
Hosted callers also pass `deliver(attempt, value, {beforeWrite})`; that callback
revalidates current source and authority after the driver's final native
metadata read, immediately before mutation. It receives the operation's abort
signal and shares its deadline. A rejected, cancelled or stalled check prevents
dispatch and returns a bounded failure code without the underlying error text.
Retries call `reconcile`; the driver is not a durable lock or an authorization
service. A receipt is provider evidence, not proof that an external API key works.

## Named provider matrix

The existing secret-source registry has `vault`, `aws-secrets`, `doppler`,
`1password`, `bitwarden`, and `stripe-projects`. They remain source capabilities;
none acquires destination mutation authority from its source registration.
This delivery capability names three destinations explicitly:

| Destination | Write and identity | Ambiguous outcome |
| --- | --- | --- |
| AWS Secrets Manager | Exact full secret ARN, independently checked AWS account and region; existing empty secret only. `PutSecretValue` uses an explicit UUID `ClientRequestToken`, which becomes `VersionId`, and an attempt-specific staging label, without moving `AWSCURRENT`. | Read complete version metadata for that exact token and label. Never read payloads or automatically write again. Metadata delay remains unknown. |
| Google Secret Manager | Independently bind the approved project ID and number through Resource Manager and require an active project before accessing the exact existing empty secret. `addVersion` accepts only a payload; validate the returned exact canonical version name and `ENABLED` state. | No native request token or version metadata marker exists. A lost write receipt stays uncertain; another version or timestamp is not correlation. No automatic replay. |
| Azure Key Vault | Independently verify ARM vault ID, tenant and canonical data endpoint; SET only the approved secret name in that existing vault. The initial named secret is created by SET because Azure has no empty named-secret resource. Supply an attempt ID and scope digest as version tags. | Complete metadata pagination must show exactly one enabled version with both tags. Duplicate, foreign or malformed metadata stays unknown. No second SET after an uncertain response. |
| Vault, Doppler, 1Password, Bitwarden, Stripe Projects | Destination delivery unsupported in this change. Existing read support is unchanged. | No fallback to local plaintext or raw hosting variables. |

Cloud platforms need explicit write credentials in the trusted host. Monitoring
or inspection credentials do not become a write grant. The library has no ambient
credential fallback. A metadata read does not prove write permission. No delivery
driver creates a project, vault, IAM binding or AWS/GCP secret container.

## Empty container setup

Container setup uses a separate lifecycle port and exact reviewed
`hv_plan {project, env, scope: "secret-destinations"}` / `hv_apply` operation.
It accepts no deploy inputs or secret values and can run before the first
workload exists. Missing required versions still block ordinary deployment.
Read-only discovery can suggest destination declarations from the connected
provider's verified scope; proposals are not creation authority.

| Hosting provider | Empty destination setup |
| --- | --- |
| Cloud Run | Google Secret Manager only: verify connected project ID and number; create an absent secret with automatic replication and scoped ownership labels; read back exact native name, `createTime`, labels and empty version metadata. |
| ECS Express | AWS runtime references and direct delivery are supported separately; automatic empty-container setup is unsupported. |
| Azure Container Apps | Key Vault runtime references and direct delivery are supported separately; automatic vault/container setup is unsupported. |
| Railway, Fly.io, DigitalOcean App Platform, Vercel | Setup unsupported; no fallback to provider variables or local values. |

The creation intent binds canonical repository identity, environment, key,
destination and random attempt. It is durable before POST and exported through
strict value-free repository bindings, so another machine can reconcile it.
Ready bindings additionally pin the server's creation timestamp. A preexisting
unowned or populated lookalike blocks automatic adoption; pinned destinations
are preserved without setup writes. Existing ready owned containers may later
contain delivered versions without losing their ownership record.

A lost creation response is never permission to POST again. A matching empty
container can be accepted through a newly reviewed metadata-only reconciliation
plan; absence, unknown metadata, mismatched labels or lifetime remain blocked.
There is no automatic reset, deletion, replacement or adoption workflow in this
increment. Writer IAM preparation must freshly verify this owned lifetime at
its final mutation boundary. Container verification alone says nothing about
writer permissions, runtime access or external credential validity.

Independent contracts:
[CRM v1 project ID lookup](https://docs.cloud.google.com/resource-manager/reference/rest/v1/projects/get),
[CRM v3 numeric identity lookup](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/get),
[Secret creation](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/create),
and [Secret identity and labels](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets).
The provider has no create request-token field; correlation is explicit labels
plus retained intent, and native lifetime is verified on readback. Synthetic
REST tests cover serialized methods, names, metadata and denied/unknown states;
real persisted command tests cover confirmation, no-value/no-deploy isolation,
scope changes, lifecycle recovery and cross-device exports. They do not establish
live API enablement, IAM grants, billing availability or deployment success.

## Hosting reference matrix

All seven registered hosting providers are accounted for. Native support does
not imply that Hypervibe's existing deployment implementation preserves it.

| Hosting provider | Native reference contract |
| --- | --- |
| Cloud Run | `env.valueSource.secretKeyRef` with an exact numeric version; runtime service identity needs secret access. The same reference must survive services, jobs, release commands and CI. |
| ECS Express | `primaryContainer.secrets[].valueFrom` (the native API names the field `primaryContainer`, not an app-owned abstraction) accepts a Secrets Manager ARN with a pinned version suffix; task execution identity needs access. |
| Azure Container Apps | App configuration secret uses a versioned `keyVaultUrl` and explicit managed identity; container env uses `secretRef`. |
| Railway | External-manager reference delivery unsupported. Ordinary provider variables do not establish this contract. |
| Fly.io | External-manager reference delivery unsupported. |
| DigitalOcean App Platform | External-manager reference delivery unsupported. |
| Vercel | External-manager reference delivery unsupported. |

For a first Cloud Run or ECS Express workload, a complete observation and no
local workload binding permit a conditional creation intent, not an assertion
that the native workload is absent. Apply requires the exact reviewed service
creation action. References travel only in the guarded creation payload; an
existing same-name workload or stale binding fails closed. Apply then verifies
the new bound workload's pinned references. Cloud Run holding-image creation
also retains the existing exact-source-commit prerequisite. Initial unbound
Azure Container Apps deployment with references is blocked because its PUT
path has no verified creation-only condition; existing bound apps are supported.

An accepted reference receipt verifies provider configuration, not the runtime
identity's permission to read the secret or the external credential's validity.
Cloud Run independently verifies the numeric parent against its connected
project ID through Resource Manager before deployment or environment-reference
updates, including manually pinned versions. Missing, inactive or mismatched
project metadata blocks workload access; runtime deployment credentials need
`resourcemanager.projects.get` for this check as well as their ordinary permissions.
When a provider explicitly reports activation pending, Hypervibe retains its
deployment baseline immediately, including after a later readback failure.
A matching-reference retry preserves that rollout requirement until a newer
running deployment is observed. Missing or partial observations cannot establish
matching configuration. Immutable slots also retain legacy acceptance conflicts;
removing a live variable does not authorize silently initializing it again.

## Independent contracts and limits

- [AWS PutSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html)
  defines token idempotency and immutable versions. [ListSecretVersionIds](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_ListSecretVersionIds.html)
  provides metadata and pagination; [ListSecrets](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_ListSecrets.html)
  documents eventual consistency. [GetCallerIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html)
  establishes the authenticated account. A failed/missing observation cannot
  authorize replacement, replay, or adoption.
- [GCP addVersion](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/addVersion)
  has no idempotency field. [SecretVersion](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets.versions)
  has no caller attempt label. [Consistency](https://docs.cloud.google.com/secret-manager/docs/reference/consistency)
  distinguishes numeric-version access from eventually consistent metadata/IAM.
  [IAM](https://docs.cloud.google.com/secret-manager/docs/access-control) separates
  version creation, metadata read and runtime secret access.
  [Resource Manager projects.get](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/get)
  requires `resourcemanager.projects.get`; its
  [Project response](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects#Project)
  binds the numeric `name` to `projectId` and lifecycle `state`. The shared driver
  requires that metadata permission as well as Secret Manager metadata/write
  permissions. A service-account email alone does not establish target scope.
- [Azure SetSecret](https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/set-secret/set-secret?view=rest-keyvault-secrets-2025-07-01)
  creates a version and returns a body containing the value. Parse only validated
  metadata and discard the body; never pass it into errors or receipts.
  [GetSecretVersions](https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/get-secret-versions/get-secret-versions?view=rest-keyvault-secrets-2025-07-01)
  returns version tags without values. List permissions and SET permissions are
  separate. [Object identifiers](https://learn.microsoft.com/en-us/azure/key-vault/general/about-keys-secrets-certificates)
  are case-insensitive; collision detection normalizes native base identifiers.
  Soft-deleted names can block a SET and are not implicitly recovered.
- [Cloud Run reference schema](https://docs.cloud.google.com/run/docs/reference/rest/v2/Container),
  [ECS Express container](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ExpressGatewayContainer.html),
  [ECS secret version syntax](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html),
  and [Container Apps Key Vault references](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets)
  establish native serialization and runtime identity requirements. Floating
  versions (`latest`, current labels, unversioned URLs) are not accepted.

Metadata preflight cannot atomically exclude an unrelated privileged writer
between observation and SET/addVersion. The host's attempt claim serializes
Hypervibe writes; native version identity and reference pinning preserve exact
accepted versions. This is not a cross-provider atomic transaction, exactly-once
execution guarantee, or proof of global sole-writer control. Without retaining
input values, a crash before provider acceptance may require resubmission under
a new reviewed attempt; an uncertain write is never treated as definitely absent.
The final host authority check is also not atomic with a subsequent remote
permission change; a revocation after dispatch cannot cancel an already accepted
provider mutation. Retain the resulting provider receipt without reviving a
revoked request.

## Desired state and collection

Declare each environment separately, including staging and production. The
same native secret cannot be shared by two slots or environments. For example:

```json
{
  "secrets": {
    "FLOW_KEY": {
      "ownership": "delegated",
      "principal": "email:owner@example.test",
      "environments": ["staging"]
    }
  },
  "environments": {
    "staging": {
      "hosting": { "provider": "cloudrun" },
      "services": { "web": {} },
      "secretDestinations": {
        "FLOW_KEY": {
          "destination": {
            "provider": "gcp-secret-manager",
            "projectId": "synthetic-project",
            "projectNumber": "123456789012",
            "secretId": "staging-flow-key"
          }
        }
      }
    }
  }
}
```

This is a partial spec example. Commit the reviewed target before collection.
Run `hv_cloud_requests action="environments"` for all-environment inventory and
the separate child commands. Each environment needs its own browser-approved
request access and exact writer authorization. Review recipient invitations
before confirming them. Hypervibe-generated slots use the owner generation
action, rather than asking a person to choose random bytes.

After delivery, `resume` returns only validated `{key, reference}` receipts.
Commit the returned immutable `version` beside its unchanged `destination`
through `hv_spec`, then prepare a fresh plan and follow ordinary apply approval.
A ready direct-delivery request never offers local import. A version already
pinned in desired state is preserved and excluded from initial collection.
This first version supports initial delivery only; rotation of a populated
destination needs a separate explicit lifecycle workflow.

AWS/GCP named secret containers and the Azure vault must already exist, and
runtime identities need independently configured secret-read permission. The
collection form does not create containers or grant IAM roles. Writer metadata
observation is not a successful permission test for a future write. Azure
Container Apps refuses a reference update that would require reading or
silently discarding unrelated opaque inline secrets; migrate that configuration
through a separately reviewed operation first.

The local CLI stores request-management grants under its existing encrypted
connection policy, but never submitted application values in this mode. The
host may retain explicitly authorized provider writer credentials in its
existing encrypted credential vault. This is not a claim that all credentials
throughout the product have zero retention.

## Regression evidence

The challenged assumption is that all cloud secret writes can be retried like
idempotent replacements and their responses contain only safe metadata. Official
contracts provide counterexamples: GCP creates another version on a replay,
Azure returns the submitted value, and AWS requires an explicit stable token.
The serialized-boundary suite uses the real AWS SDK and real REST clients with
controlled transports; evidence is reconstructed from the sources above, not
recorded production traffic. Its tests run in ordinary `npm test` discovery.
They do not prove live IAM, provider availability, or runtime deployment.

Observed RED first: the new transport suite could not import the missing
adapters. After implementation its eight initial cases passed. Additional
boundary regressions then reproduced missing input reaching provider work and
an oversized AWS response being accepted; both failed before their fixes and
passed afterward. The suite now also checks bounded response-body time and
bytes, scope failures before provider effects, omitted GCP repeated fields,
uncertain AWS/GCP/Azure writes, metadata-only recovery and Azure value echoes.
An additional RED showed an already-aborted call still entering token
acquisition; the shared operation boundary now stops before that work.
Scope review also reproduced a cross-project-capable token reading and writing a
numeric project under a different approved project ID. Five transport cases
failed before adding the Resource Manager gate, then passed: mismatched identity,
missing metadata and inactive projects all stop before secret reads or writes.
Ten additional serialized cases first showed that a host check before the
driver's own preflight was too early: all three providers still wrote when
authority was revoked during that inner read. The final callback now enforces
read → current authorization → write order, stops cancellation or rejection,
and bounds a stalled authorization check under the same deadline.

Application-boundary RED cases also showed local generation for a native slot,
dotenv resolution before native-input rejection, unchanged fingerprints after
a version change, and `hv_status.inSync=true` despite required undelivered
native input. These now pass through isolated SQLite and the real MCP command
envelope. Persisted apply tests cover reference-only writes, changed owner or
destination denial, replacement confirmation before service rollout, and
failed post-write version verification. Provider-port fixtures in those tests
prove orchestration policy; the separate transport suites prove serialization,
not live IAM, external-key validity, or a successful deployed workload.

Native hosting regressions first reproduced ignored reference-only updates,
reference loss on partial environment updates, and unsupported references
reaching provider calls. They now cover Cloud Run REST, ECS SDK and Azure ARM
serialization, exact readback, cron/release paths and generated CI preservation.
Initial planning/apply regressions reject unknown reads and stale bindings;
native creation tests refuse unbound lookalikes. Further RED/GREEN cases preserve
pending rollout evidence across readback failure and retry, reject immutable
legacy-binding resets, and stop service-only deployment from bypassing an
immutable conflict just because the desired reference already matches.
Seven additional REST regressions failed before the runtime project-identity
gate: cross-project-capable authentication could write a manually pinned foreign
numeric parent, and missing/inactive/mismatched project evidence was ignored.
The shared delivery/runtime provider helper now enforces the same CRM contract;
correct project ID/number pairs retain successful service and job updates.
The shared creation-only admission matrix now covers Railway, Fly, Cloud Run
and ECS, with Azure Container Apps, DigitalOcean and Vercel still rejected.
GCP/ECS positive controls require references in the guarded creation payload
and prohibit an environment pre-sync. All supported adapters retain negative
controls for missing capability, missing provisioning intent and non-deferred
deployment; native transport tests separately reject existing workloads.

## Collection across environments

Start with `hv_cloud_requests({action:"environments"})`. This reads the committed
checkout and lists every environment, existing version pins, unpinned generated
keys, and delegated keys grouped by owner and delivery method. It returns
separate environment authorization and invitation-review commands. It neither
creates grants nor sends invitations, and it does not claim that the listed
credentials have already been collected. An environment-scoped grant is never
reused for another environment.

For a reviewed invitation, the committed `secretDestinations` binding determines
`deliveryMode:"secret-manager"`. The request API receives no native target
override; hosted Hypervibe resolves the same immutable source and requires a
unique approved writer connection. Mixed direct/local fields require separate
requests. Already pinned versions are excluded and cannot be explicitly
reselected through collection.

`resume` returns validated immutable delivery receipts and source-scoped browser
review links for generated keys. Public target metadata uses
`destinationTargets:[{key,destination}]`, preserving names such as `CLIENT_SECRET`
without weakening the shared sensitive-key redactor. No direct request offers
`hv_cloud_secrets`; that legacy importer independently rejects destination-backed
keys before consuming a retrieval or creating an env file. Review delivered
versions through `hv_spec`, then make a fresh plan. A delivery receipt does not
authorize rollout or prove that the application credential works.

`reconcile` sends an empty metadata-only request for an exact request/source/
environment. The host rechecks current authority and uses provider metadata;
it never accepts another value or automatically repeats a provider write.
GCP uncertain writes can remain blocked because there is no reliable native
attempt marker. Generated values are created only through the owner-reviewed
browser action, never by the CLI coordinator.

The orchestration regressions exercise real temporary Git checkouts, migrated
SQLite state, the command envelope and serialized controlled HTTP responses.
Independent evidence is the approved no-local-plaintext requirement and the
hosted request service's source-bound delivery, discovery and reconciliation
routes. Initial RED reproduced a direct ready receipt becoming a local import
and a manually invoked importer consuming/writing a destination-backed value.
Additional coverage preserves legacy controls, invitation review/recovery,
exact environment/source/target validation, generation-link origin checks and
the ordinary response redaction boundary. These are offline contract checks;
they do not establish deployed frontend, writer IAM or cloud compatibility.
