# Onboarding and connections

## Prepare the application

Infer the application's name, runtime, build, start command, and required
datastores from the repository and its existing configuration. Reuse explicit
desired state and verified connections only when their resource scope belongs
to this application. A connection to another application's cloud project does
not authorize reuse; a Hypervibe environment is not a cloud project.

For a new web application with no environment policy, prepare production and
isolated staging together. Use simple logical names such as `web` and
`documents`; let Hypervibe's naming policy produce required physical names.
Keep staging data, secrets, and resource identities separate from production.
Choose supported economical capacity and add only services the application
needs. Preserve existing names and durable bindings. Explain differences in
workloads, integrations, storage, and capacity before treating staging as
evidence about production.

Prefer HTTPS, private datastores, least-privilege workload identities, generated
application secrets, and managed CI releases where supported. Initial owner or
contact values may come from repository git identity when the application
declares those settings; persist reviewed non-secret intent without treating
git identity as ownership proof. Preserve an existing owner's choices.

Code safeguards may protect against accidental overwrites and run automated
checks. Mandatory approval by another person is opt-in: enable it only when
the user explicitly requests it and explain that it prevents merging without
another person's approval. Preserve existing owner-chosen review policies.

Backup intent should cover persistent databases, retained service mounts, and
object buckets. Preserve stronger existing protection and explicit exclusions;
exclusion does not authorize deleting protection. Report policy configuration,
available recovery points, and tested restores separately. Unsupported or
unknown coverage remains explicit.

Use `hv_spec` and `hv_plan` to discover current prerequisites. A missing
capability is a Hypervibe product gap, not an instruction to construct resources
manually in a dashboard. A prerequisite failure is not necessarily a missing
credential; follow the result's actual category.

## Connect only the required access

Use the selected project's `hv_connections` results and the current plan's
`connectionSetup` requirements. Existing unverified access needs verification;
failed or unknown access does not prove a resource is absent. Do not replace a
connection or restart setup merely because a credential expires locally.

When Hypervibe returns `connectionSetup.agentSetup`, execute only that exact
unconfirmed preview. It may prepare account/project creation or a deployment
identity. Present the concrete proposed resource scope, permission grants,
billing choice, and cost implications before obtaining the required approval.
Only the confirmed continuation may perform the corresponding changes.

For new AWS, Azure or GCP access, start `hv_cloud_connections` with
`purpose="connect-cloud"` for the exact app and environment. Follow `nextStep`
through device approval, browser provider selection and administrator installation.
The developer may invite the cloud administrator; sign-in alone does not establish
cloud authority. Review account/project/subscription, resources, permissions and
cost before installation. No local cloud credentials or manually prepared writer
identities are required. Report missing hosted prerequisites without substituting
key uploads or key generation.

Preserve existing connections. GCP `hv_connections action="bootstrap"` creates a
legacy deployment service-account key and requires explicit user intent. Local
setup and existing credential references remain available for separately chosen
local or legacy paths; they are not new Connect Cloud prerequisites.

If the current tool schema and result explicitly offer a local authentication
recipe, follow its bounded continuation. Reuse valid login, verify the shell
shares the credential reader's machine and user context, and preserve existing
profiles. Use the vendor's documented installation and browser login methods;
the user handles consent, MFA and account/payment choices. Guidance is not a
receipt that installation or login happened. Never export temporary sessions
into CI/runtime or replay an earlier infrastructure confirmation after login.
Unknown credential-chain errors do not establish missing authentication.

## Externally issued credentials

Use the exact credential kind, role, scope, required permissions, setup links,
and credential reference returned by Hypervibe. Distinguish repository-management
credentials from package-pull credentials and control-plane access from runtime
secrets. Request optional capabilities only for the corresponding task.

Lead with `recommendedSetupUrl` when supplied. Preserve every query parameter
in its direct form URL, especially the name and description. Provider templates
may leave some fields manual; report those honestly. The application should
construct contextual links rather than requiring the agent to recreate a
provider's permission or URL contract.

Explain where the user should save the credential privately and use the returned
`credentialExample` with its real local path. Prefer `credentialsRef` or the
declared mapping to local environment variables, a private dotenv/JSON file, or
a verified secret manager. Never ask for a token pasted into chat. Once the
reference is available, call `hv_connections` yourself. Presence of a value
does not establish credential validity or authorization.

If the current user does not control the missing access, offer a value-free
handoff naming the provider, application/environment scope, and blocked task.
Do not assume they should be invited to the provider or granted wider access.

## Application configuration

For credential adoption or rotation, first inspect `hv_secrets` with an explicit
environment and `view="inventory"`. Declare a non-secret `credential` descriptor
on each related `spec.secrets` alias: role, label, purpose, kind, one safe source
reference, and intended account/sandbox when applicable. Every alias of a role
must share that descriptor; its environments/GitHub scopes remain explicit.
Use `hv_plan scope="credentials" credential=<role> intent="adopt"` to review
value-preserving adoption, or `intent="rotate"` to freeze one replacement.
Never put values in the spec, URLs, command arguments or conversation.

Apply only the reviewed action IDs, then use managed CI rollout and status/health.
For pending or uncertain writes, inspect receipts and resume the same plan;
do not regenerate or replace the input. An uncertainty-specific retry confirmation
is a separate review decision. Keep configuration, new deployment, authentication,
business operation and old-instance retirement distinct. Use returned creation
URLs without changing their supported prefills. The plan states whether each
cloud stages the value or immediately starts a new revision. Database-password
roles change native authentication and then synchronize exact issuer/reference
consumers; never substitute an environment-only edit. For Stripe webhook roles,
use the returned same-endpoint Dashboard roll instructions and a private source
for the replacement, preserving account/sandbox and endpoint identity. Leave
old-key revocation pending until all consumers and application operations have
evidence. Exact runtime service selections use `credential.runtimeConsumers`.

For credential provenance, drift, or rotation requests, start with
`hv_secrets project="..." env="..." view="inventory"`. Explain each role's local
candidates, exact consumers, recorded synchronization, deployment identity and
missing evidence. The inventory does not adopt or update values. Keep unknown
rotation dates unknown; a successful deployment or homepage is not proof of
credential authentication, application operation, or retirement of old instances.
Use existing `hv_spec` → `hv_plan` → `hv_apply` for reviewed changes, then managed
rollout and verification. Do not revoke an old credential on one consumer's success.

Declare application-owned opaque secrets with Hypervibe's supported versioned
generator; users should not invent session keys or copy generated values.
Externally owned secrets use eligible input requirements from the current plan.
Unknown live state is not absence, and replacing accepted secrets can require
specific confirmation because of session, encryption, or data consequences.

Document managed runtime keys without values. Do not copy provider setup
credentials into application configuration or local deployment files. Keep
environment-owned CI credentials and database URLs in their exact environment
scope. Shared storage connections may reuse compatible cloud authority through
Hypervibe, but control-plane access never authorizes copying that credential
into a workload. Let the lifecycle establish supported workload identities and
explicit grants.
