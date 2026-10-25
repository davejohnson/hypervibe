# Credential lifecycle

Credential tracking extends `spec.secrets`, encrypted plans, accepted secret
bindings and managed runtime rollout requirements. Inventory remains read-only.
It is not a second credential store or an imperative sync command.

The [three-phase review map](credential-lifecycle-review.md) identifies the
inventory, adoption/provenance, and rotation acceptance surfaces.

## Review sequence

1. Inspect `hv_secrets project="app" env="production" view="inventory"`.
2. Patch `hv_spec` with `secrets.<ALIAS>.credential`. Give every alias of one
   role the same descriptor. Existing `environments` and `githubActions`
   declarations remain the consumer mapping. Optional `runtimeConsumers` selects
   exact `{environment, service, variable}` coordinates; every runtime alias must
   be covered. Without that selection, runtime slots apply to the environment's
   declared services. The plan reviews their exact bound service IDs.
3. Use `hv_plan project="app" env="production" scope="credentials"
   credential="application-api" intent="adopt"`. Adoption only accepts matching
   existing runtime values; it never writes provider values. Write-only values
   cannot satisfy value-preserving adoption proof.
4. To rotate, replace the value at the declared source, then use the same plan
   call with `intent="rotate"`. The plan freezes one encrypted replacement for
   all aliases and environments. Confirm the returned exact action IDs through
   `hv_apply`. A subsequent file edit remains a candidate, even during retries.
5. Select the managed definition with `hv_ci_status`, dispatch with
   `hv_ci_trigger`, and inspect `hv_status`, `hv_health`, and inventory. Partial
   credential synchronization blocks lifecycle mutations and CI dispatch.
   Verify a declared business operation with `hv_health credential="application-api"`;
   see [application operation verification](credential-operation-verification.md)
   for HTTP receipts and existing approved environment tasks.

For example, a partial `hv_spec` patch can contain:

```json
{
  "secrets": {
    "ANTHROPIC_API_KEY": {
      "ownership": "delegated",
      "principal": "user:application-owner",
      "environments": ["production"],
      "credential": {
        "role": "application-api",
        "label": "Document processing API",
        "purpose": "Authenticate document-processing requests",
        "kind": "anthropic",
        "source": "dotenv:/absolute/project/.env.production#ANTHROPIC_API_KEY"
      }
    }
  }
}
```

For package downloads, declare `kind="github-package-read"` and the same role
and source on aliases such as `NODE_AUTH_TOKEN` and `IMAGE_REGISTRY_TOKEN`.
Their individual `githubActions.repository` and `githubActions.environments`
select exact secret scopes. Add `containerPull: [{environment: "production",
service: "web", username: "package-reader"}]` to the shared descriptor when a
provider stores a separate pull copy. This is explicit mapping, never inference
from names or matching token contents. API-management roles cannot supply
container-pull credentials. Keep the intended existing account and username.

Generated session/JWT roles use `ownership="hypervibe"`, the existing
`generator="random-base64url-32-v1"`, and `generation`, with
`credential.kind="session-signing"` and no source. A role shares one stable
generation across aliases/environments. Incrementing generation requests a
reviewed replacement; it can sign users out. Existing immutable policies and
legacy-key conflicts remain enforced.

Source descriptors and optional `identity` / `userReportedCreatedAt` /
`userReportedRotatedAt` are non-secret spec data. Stripe requires an intended
`identity.accountId` and `identity.mode`; use the exact sandbox account ID for a
sandbox, optionally supplied as `sandboxId`. A test-key prefix is insufficient.
Provider creation/expiry evidence stays unknown when unavailable. File mtime,
source pickup, accepted update, validation, destination update and activation
timestamps never become an inferred rotation date. Source reads and credential
validation use the existing audit log; acceptance/progress use existing
environment bindings and action receipts.
Inventory exposes the latest source pickup and recorded update receipts. A
validation identifies its accepted or candidate input; it does not validate a
different intended account or mode after the declaration changes.
Connection imports retain their non-secret reference and selected key mapping in
the existing audit history. The same credential read records each resolved
reference and actual source key separately from the requested reference, including
provider-declared compatibility aliases. Inventory shows that evidence per role;
it never infers another role's source from matching credential values. Malformed
private JSON produces a fixed diagnostic, and source metadata passes through
exact-value redaction before audit persistence.
Completed private owner-request imports retain the
request ID, exact local destination, receipt time and import time in their existing
encrypted recovery state. Inventory reads that provenance without importing or
fetching anything. Older records with no provenance remain unknown; neither
receipt nor import time establishes when the credential was created or rotated.
Local dotenv, raw-file and process-environment sources remain candidates until
reviewed. GitHub-only roles compare local candidates to their recorded accepted
input without claiming the current write-only destination matches. Pending
recovery takes precedence over guidance to plan a newer local candidate.

## Recovery and evidence

Apply records intent before each write. On retry it reads exact scope and
configuration, skips completed destinations, and preserves the same encrypted
replacement. A pending role blocks a new credential plan. Resume the original
plan, including after its normal age limit if it has durable pending progress;
the spec and frozen action authority must still match.
If a process stops after the provider write, readback restores missing rollout
requirements without resending a matching value. If the successful apply receipt
is durable but final acceptance metadata was interrupted, recovery completes only
that local metadata. Mixed repairs retain previously acknowledged noop aliases.

A lost acknowledgement is not proof of rejection. When readback cannot settle
the outcome (including write-only destinations), the receipt identifies an exact
`<action-id>:retry-uncertain` confirmation. Only after explicit review may that
confirmation accompany the original action IDs to replay the frozen write.
An actively running apply retains its normal lock; another process must not
override it. A changed target or source declaration requires resolving that
identity/declaration before recovery, never silently replacing the destination.

Ordinary managed CI uses the accepted encrypted input for explicitly declared
environment-secret destinations. It cannot undo a rotation using an older
connection value or silently consume the next local edit. Repository-scoped
aliases remain distinct from environment-scoped copies. If the role is pending
or unaccepted, dependent CI synchronization remains blocked.

Deployment evidence retains the exact pre-update baseline where available,
including overlapping old deployments. Native rollout receipts bind the reviewed
configuration to their returned deployment IDs. Deferred updates use verified
managed release artifacts containing the accepted operation and exact native
deployment IDs. GitHub and GitLab verify the producer program, repository,
source commit, run and target scope before accepting this evidence. Old active
deployments keep rollout pending. Provider traffic coverage proves routing; only
instance coverage can establish retirement of old processes. Application
operations use separately declared checks through health verification.
Existing generated CI definitions must be reconciled through the ordinary
reviewed plan/apply workflow when their producer revision changes. An older
producer that lacks operation-bound activation evidence cannot certify a new
rotation merely by reporting deployment success.

The inventory, tracking schema/adoption, and rotation/provider capabilities are
separate review surfaces. Regression tests remain under ordinary `npm test`.
Observed failing counterexamples included unsupported tracking, ordinary plans
accepting unreviewed values, missing alias grouping, repeated CI writes, immutable
replacement, CI dispatch during partial synchronization, and new deployments
masking active old deployments or unrelated service IDs. The corresponding
focused checks pass after correction. The multi-environment fixture was extended
explicitly: its prior staging-only mutation guard was not a provider restriction.
The CI source regression additionally ran with the accepted-input override
disabled as a negative control, then passed with that boundary restored. That
check demonstrates reconciliation of accepted role input, not a diagnosis of
the motivating production incident.
Additional failing counterexamples covered repository-only apply/inventory,
accepted noop aliases lost during a one-destination repair, interruption after
provider writes or successful apply receipts, changed Stripe identity, and older
overlapping deployments surviving the latest baseline. These now pass through
the real application lifecycle and the existing persistence boundaries.

The committed acceptance workflow executes `npm test` and `npm run typecheck`;
the desired branch-protection configuration requires `Hypervibe / acceptance`.
Live branch-protection enforcement has not been verified.

## Provider boundary review

The credential lifecycle has registered selected-key writers for Railway,
Cloud Run, ECS Express, Azure Container Apps, Fly.io, DigitalOcean App Platform
and Vercel. It supports both staged updates and providers that start a revision
as part of a configuration write. The plan discloses that activation effect.
The older `scope=secrets` deferred-only contract remains distinct; see
[runtime credential providers](runtime-credential-providers.md) for the native
contracts and executed adapter tests. Readback and acknowledged write-only
updates remain separate evidence types.

The separate container-pull contract inspects an exact bound workload, freezes
its native scope, instance and image, and changes only its registry credential.
It neither creates a service nor changes its source/image. The plan discloses
native activation effects: DigitalOcean starts an app deployment; Azure
versionless Key Vault references can refresh active revisions automatically.
Acknowledgement records synchronization, not proof of a current write-only value.
Uncertain writes use native readback or idempotency to reconcile the frozen
input where available. Write-only destinations remain pending for review.

| Hosting provider | Native model and official evidence | Admission |
| --- | --- | --- |
| Railway | [Service instance configuration](https://docs.railway.com/integrations/api/manage-services), [private registries](https://docs.railway.com/builds/private-registries); pinned `ServiceInstanceUpdateInput.registryCredentials` and `RegistryCredentialsInput`. Scope includes project, environment, service, instance and image. | Ready for live validation; exact existing instance only. |
| Cloud Run | [Remote upstream authentication](https://docs.cloud.google.com/artifact-registry/docs/repositories/configure-remote-authentication); exact Artifact Registry repository and existing Secret Manager reference. | Ready for live validation; update the existing remote repository's credential version, retaining workload identity, image and upstream. Standard repositories use native workload identity. |
| ECS Express | [Repository credentials](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ExpressGatewayRepositoryCredentials.html), [idempotent secret versions](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html); exact existing Secrets Manager ARN. | Ready for live validation; update existing JSON username/password, preserving other fields and task definitions. Native ECR access remains workload identity. |
| Azure Container Apps | [Registry references](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity-image-pull), [secret and Key Vault references](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets); exact app passwordSecretRef. | Ready for live validation; preserve direct app secrets or exact Key Vault identity/reference mode while updating the selected backing secret. |
| Fly.io | [Private Fly registry images](https://fly.io/docs/blueprints/using-the-fly-docker-registry/); organization-scoped native registry access. | Native registry/build input; external package-read credentials synchronize to reviewed managed CI/build consumers, with no runtime password copy. |
| DigitalOcean App Platform | [App image spec](https://docs.digitalocean.com/products/app-platform/reference/app-spec/); GHCR/Docker Hub registry_credentials and full app-spec update. | Ready for live validation; preserve unrelated encrypted values, image and app configuration. Native update deploys; acknowledgement does not reveal current plaintext. |
| Vercel | [Docker on Vercel](https://vercel.com/kb/guide/docker), [scoped build variables](https://vercel.com/docs/environment-variables); native Vercel container registry or source builds. | Native registry/build input; package credentials belong to exact reviewed build/CI destinations. |

Provider validation uses fixed official GET endpoints, never an application
operation or a billable request. Reconstructed synthetic observations cover the
documented transport/shape; no live credentials were used:

- [Anthropic models](https://platform.claude.com/docs/en/api/models/list): authentication, not invoice extraction.
- [SendGrid scopes](https://www.twilio.com/docs/sendgrid/api-reference/api-key-permissions/retrieve-a-list-of-scopes-for-which-this-user-has-access): authentication and reported mail.send permission, not email delivery.
- [Stripe current-account contract](https://github.com/stripe/stripe-node/blob/master/src/resources/Accounts.ts) and [balance](https://docs.stripe.com/api/balance/balance_retrieve): exact authenticated account and response livemode, not key-prefix inference. A sandbox is a separate intended account; [sandbox isolation](https://docs.stripe.com/sandboxes) does not imply matching test prefixes identify it.
- [GitHub authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user) and [OAuth scope headers](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps): authentication and reported package scope, not successful package download or management authority. API-management and package-read roles stay separate.

Database-password roles use the native two-action lifecycle: change actual
authentication, then install the reviewed issuer/reference and consumer values.
It supports the eight registered PostgreSQL providers, including provider-owned
generation and interrupted-reset recovery. URL consumers retain their endpoint,
user, database and query options; raw references remain references. See
[database password rotation](database-password-rotation.md).

Stripe webhook roles retain their exact account, mode and endpoint. Stripe's
public API does not roll an existing endpoint's signing secret, so the guided
flow opens the official Dashboard action, accepts its replacement through a
private source and synchronizes that exact endpoint's consumers. A supplied
signed delivery can validate the signature; application processing is a separate
check. See [webhook rotation](stripe-webhook-credential-rotation.md).

Old credential revocation is never automatic: complete consumer coverage, exact
new deployments, retirement of old instances and the declared application
operation must have supporting evidence before revocation can be reviewed.

Creation URLs reuse the existing [form-link evidence](connection-form-links.md), including the supported GitHub classic token description/scopes fields. Other credential kinds expose their direct management page when no supported prefill contract is available.
