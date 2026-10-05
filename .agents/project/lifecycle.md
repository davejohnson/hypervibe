# Provider architecture and lifecycle safety

Paths are relative to the repository root. Read when the matching task in `AGENTS.md` applies.

- Keep known public endpoints separate from desired DNS management. Hosted monitoring may use exact committed public-service bindings and scoped provider observations; never infer a domain or DNS provider from a project name, discard known URLs because DNS is unmanaged, or turn read-only discovery into adoption or mutation. Preserve endpoint source, environment, public-service defaults, and safe URL filtering across import and refresh.
- Keep the desired-state loop central: `hv_spec` defines intent, `hv_plan` computes drift and blocked work, `hv_apply` converges a specific plan, and `hv_status` verifies convergence.
- Lifecycle infrastructure changes belong in spec/plan/apply. Do not hide creates, attaches, purchases, migrations, deploy-source changes, DNS changes, schedules, or destroys inside CI, diagnostics, or helper tools.
- Treat the persisted plan as an authorization boundary. An apply handler may mutate only the resource and operation named by its current non-noop action; dependencies must be explicit plan edges. Never let a service, environment-variable, secret, deploy, or diagnostic action implicitly create, repair, attach, or destroy a database or another unrelated resource.
- A noop action must cause zero provider mutations. When a live resource exists but its local binding is missing, plan explicit adoption/binding reconciliation or block with guidance; do not silently adopt it and do not create a replacement from a shared bootstrap path.
- Treat observation as present/absent/unknown. Only a provider-confirmed not-found response proves absence. Permission errors, unsupported observation, partial reads, timeouts, rate limits, and provider failures must block or preserve affected state; never turn them into an empty list/null/false that can plan a create or destroy. A response that omits a selected field is incomplete evidence, even when its HTTP status succeeds; distinguish omission from a contract-permitted null or false value before comparing desired state.
- Hosted observation must verify exact source provenance and independently authorized provider scope. Never repair a stale binding by choosing a same-named resource. Bound work before per-resource reads and retain explicit unknown/unsupported field coverage; the existence of a recent report does not establish convergence. Redact exact supplied credentials even when a provider echoes them in ordinary labels.
- Test first deployment with no local environment row as well as existing and partially bound environments. When generated-secret observation depends on an absent hosting identity, isolate the reviewed project bootstrap and re-plan before authorizing workloads or secret writes; never mark unknown destinations absent to break the dependency cycle.
- Resolve resource identity by durable provider id first. Name matches are adoption candidates only; detect and block multiple matching services, databases, buckets, queues, projects, apps, or domains instead of choosing the first.
- Keep resource naming in the shared deterministic naming policy. Provider adapters supply only documented namespace, length, alphabet, and reserved-name constraints; generic orchestration must not branch on provider names or duplicate naming formulas. Use plain logical names inside native environment namespaces, and one short scope discriminator where the namespace is shared. Do not concatenate the parent hierarchy into child names.
- Treat naming changes as lifecycle changes, not cosmetic string edits. Audit spec, plan, apply, observation/status, import, uncertain-write recovery, runtime wiring, generated CI, and teardown together. Existing provider IDs, recorded physical names, explicit names, and recovery markers outrank new defaults; never automatically rename or replace them. Legacy-name discovery is read-only and must block unknown or ambiguous ownership before a new create.
- A cross-provider naming change is incomplete until tests cover the affected native namespaces, two environments with the same logical names, normalization/truncation collisions, preserved legacy bindings, and mutation-free noop. Exercise real adapters and shared plan/apply paths with independently sourced provider contracts where available; a formatter snapshot, source-string assertion, or matching mock alone is not lifecycle or live API evidence. Extend these cases when adding a provider instead of copying its predecessor's naming code.
- When a provider resource id is scoped by project, account, region, or environment, preserve the provider-native id and present its scope beside it in bindings, observations, and human output. Matching unscoped ids alone must never imply that two environments share the same data instance.
- When a new prerequisite rejects legacy metadata, provide a reviewed, preservation-safe normalization path where independent observation can prove the missing identity. Do not recommend re-import as a narrow repair when it replaces accepted state. Test repair followed by ordinary observation and noop reconciliation; the repair and every existing reader must agree on the complete scope. Also exercise re-entry into full planning with deferred secret inputs and runtime overrides; a correct isolated prerequisite plan does not prove that ordinary work resumes.
- On request-scaled platforms, background workers must explicitly receive continuous/instance CPU and a nonzero runtime floor; web services must explicitly preserve request-based CPU when the provider requires a value. Provider contract tests must cover both shapes and ensure one-off jobs do not inherit service-only CPU settings.
- Treat health probes as per-service runtime configuration. Apply and verify a declared probe for web or worker services across direct and generated-CI paths; only one-off jobs categorically omit HTTP probes.
- Preserve a live workload's provider-observed runtime identity on updates. When a provider distinguishes control-plane and workload identities, a deploy/admin connection must never seed or become the runtime principal, even for a new resource; use a deterministic least-privilege runtime identity and fail closed when it is unavailable.
- Make creates and destroys retry-safe and honest. Billable or data-bearing actions require exact action-id confirmation; deletes must treat already-absent as success, wait for realistic provider completion, verify terminal absence, and only then remove local bindings. A helper resource created before its durable parent binding must be exact-identity compensated on later failure or retained as explicit recovery state; a retry must never silently adopt it. A successful provider mutation is acknowledgment, not convergence: boundedly re-observe the exact identity, revision and changed fields before issuing dependent mutations or storing convergence. A successful skipped receipt cannot prove an update or authorize clearing its binding.
- Order multi-resource destroys by dependency and stop on unknown or failed deletion. Never delete a datastore volume, bucket contents, security group, credential, or other dependent resource after deletion of its owning resource failed or could not be verified.
- Require lifecycle contract tests for noop mutation freedom, action-scoped mutation authority, observation errors, duplicate identities, import round trips, billable/data-bearing confirmation, and idempotent deletion. Database lifecycle changes must run the same contract against Railway, Supabase, Cloud SQL, and RDS.
- A storage provider id is supported only with a registered adapter covering private creation, ownership-safe observation, runtime wiring, streaming list/get/put, and confirmed teardown. Schema acceptance or an S3-shaped example alone is not provider support.
- Storage placement belongs in desired state, not connection credentials. Reuse an explicitly compatible primary cloud connection for storage and derive provider runtime credentials during apply; never require operators to fetch a second bucket/account/HMAC key when the connected cloud identity can create it safely.
- Cloud storage must accept the provider-native local credential path (AWS default profile/SSO chain, Google Application Default Credentials, and the Azure default credential chain) as well as explicit automation credentials. A temporary local session may manage or migrate data but must never be copied into a deployed workload as durable authentication; use workload identity or fail with targeted guidance.
- Keep provider behavior behind the provider boundary. Generic plan/apply/services/tools code should route through adapter capabilities and provider registry metadata, not provider-name branches or direct provider adapter imports.
- Generic commands such as `hv_inspect` and `hv_import` must not default to, narrow their schema to, expose identifier fields for, or dispatch directly to one provider. Accept registered provider names, route through declared capabilities/provider-owned drivers, and return explicit `UNSUPPORTED` for a missing capability. Keep provider names, API shapes, and provider-specific mapping logic out of `src/tools`; contract tests must scan the full registered tool surface for regressions.
- Read-only inspection must not adopt repository edits, bootstrap legacy desired state, or write local environment files. Exercise changed and absent spec journals through the real command boundary; a helper named `get` may still write.
- Treat provider support as an evidence ladder. Schema or registry presence, adapter code, documentation, and mocked tests may establish `ready-for-live`, but they never substitute for a successful recent live lifecycle contract. Keep public docs, provider metadata, capability matrices, and live-evidence status aligned; when they disagree, preserve the lower proven status and report the gap rather than describing the feature as supported.
- Carry every declarative provider field through validation, observation, fingerprints, drift, action stale checks, create/update requests, receipts, and durable state; partial field support is not reconciliation.
- Deployment declarations describe managed resources, not every service an application uses. Discover configuration only from bounded, exact-scope observation; return requested key presence without values, and never equate presence with credential validity, active usage, monitoring access or health. Duplicate resource identities and malformed provider responses must remain unknown, never complete or checked-empty.
- Consequential confirmation is part of mutation authority, not a caller-only flag. At apply time, recompute the transition from fresh provider and binding evidence, then require both the persisted `requiresConfirm` marker and the exact caller-confirmed action id before any write.
## Architecture

Read `ARCHITECTURE.md` before changing lifecycle, provider, plan/apply, deploy, database migration, DNS/domain, CI, connection, or secret-handling code. That file is the source of truth for Hypervibe's infrastructure model.

- **Tools** (`src/tools/`): the pinned `hv_*` MCP tool surface (registered in `src/server.ts` via `ToolContext`); all responses use the `toolSuccess`/`toolError` envelope from `src/tools/respond.ts`
- **Spec** (`src/domain/spec/`): the desired-state document (`ProjectSpec`, revisioned in the `project_specs` table via `SpecStore`)
- **Plan** (`src/domain/plan/`): the reconciliation engine — observe live state, pure `diffEnvironment`, `ConvergeExecutor` with the planId handshake
- **Adapters** (`src/adapters/`): Provider, secret, database, and external-service integrations
- **Domain services** (`src/domain/services/`): orchestrators (deploy, bootstrap, import, rollback, domain)
- **Repositories** (`src/adapters/db/repositories/`): SQLite data access (JSON columns validated via `parseJsonColumn`)

Legacy `*.tools.ts` files that still exist but are not registered in `server.ts` are internal helper libraries pending extraction — do not register them or add new tools there.

Provider-specific lifecycle behavior belongs behind the provider boundary. Do not add provider-name branches or direct adapter imports in generic plan/apply/services/tools code to express hosting behavior. Add provider-owned code under `src/adapters/providers/<provider>/...` and expose it through adapter capabilities or `providerRegistry` metadata. Opinionated product surfaces such as SendGrid email or Stripe payments can stay provider-specific when they are not part of generic infrastructure reconciliation.

Generic command names imply generic provider routing. `hv_inspect`, `hv_import`, and future provider-selecting commands must accept registered provider names instead of a one-provider enum/default, use flat provider-neutral selectors (`scope`, `resource`, `id`, `name`), and dispatch through capabilities or provider-owned application drivers. Never expose fields such as `railwayProjectId` or put provider API/mapping logic in `src/tools`. When only one provider implements a capability, keep the command generic and return explicit `UNSUPPORTED` for the others; add a command-surface contract test so a provider-specific shortcut cannot return.

Whenever a GitHub PAT is required, provide a role-specific pre-filled creation URL with its name/description and required scopes or fine-grained permissions already selected. Never send users only to a generic GitHub token settings page; keep every PAT role covered by regression tests.

Whenever a provider officially documents credential-template URLs, use them with the known required name and least-privilege permissions pre-filled. Do not reverse-engineer undocumented dashboard parameters; call out any optional permissions the official template cannot represent.

## The spec → plan → apply loop

The core workflow is terraform-style:
1. `hv_spec` — write the desired state (single source of truth, revisioned)
2. `hv_plan` — observe live infrastructure through provider capabilities (unsupported observation falls back to local state marked `verified: false`), diff, persist the plan as a run → `planId`
3. `hv_apply planId=...` — rejects stale plans (spec revision advanced, live state changed, plan expired/already applied); data-bearing destroys run only with exact action ids in `confirmActions`
4. `hv_status` — read-only drift view

There is no approval workflow: the human gate is MCP client tool-call approval plus explicit `confirm` flags.

### Reconciliation safety

The persisted plan is an authorization boundary:

- An apply handler may mutate only the resource and operation named by its
  current non-noop action. A service/env/secret action must not implicitly
  provision a database, attach a domain, configure email, or deploy unrelated
  services through a shared bootstrap.
- A noop action must perform zero provider mutations. Missing local bookkeeping
  for an observed live resource requires explicit adoption/binding
  reconciliation or a blocked result, never replacement creation.
- Observation is present, absent, or unknown. Only provider-confirmed not-found
  proves absence; permission errors, unsupported reads, partial results,
  timeouts, rate limits, and 5xx responses must not become executable creates or
  destroys.
- Match durable provider ids before names, and block multiple matches instead of
  selecting the first.
- Billable and data-bearing actions require exact action-id confirmation.
  Deletes must be idempotent, wait for provider completion, verify absence, and
  remove local bindings only afterward.
- Multi-resource destroys stop at the first failed or unknown deletion. Preserve
  dependent data and network/credential resources until the owning resource's
  terminal absence is confirmed.
- Lifecycle work must add contract tests for noop mutation freedom,
  action-scoped mutation authority, observation errors, duplicate identities,
  import round trips, confirmation gates, and delete retry. Run database
  lifecycle contracts across Railway, Supabase, Cloud SQL, and RDS.

See `ARCHITECTURE.md` for the normative invariants and
`docs/reconciliation-safety-backlog.md` for the current repair queue.

## Platform Bindings

Environments store provider bindings in `platformBindings` using generic keys only (legacy `railwayProjectId`/`railwayEnvironmentId` were migrated away in sqlite migration 7):
```typescript
{
  provider: "<registered-hosting-provider>",
  projectId: "...",       // external project/app id on the provider
  environmentId: "...",   // external environment id (if supported)
  services: {
    "api": { serviceId: "...", url: "...", customDomains: [...] }
  }
}
```
