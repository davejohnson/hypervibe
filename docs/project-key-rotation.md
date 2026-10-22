# Project credential rotation

Scope: project-wide workflow preparation, scoped database execution, and a design
for broader campaign execution,
reviewed against current code and official guidance on 2026-10-21
(America/Vancouver). The initial `hv_rotation` workflow prepares and preserves scope;
it **does not rotate credentials**. Supabase database password replacement is
implemented separately through reviewed spec/plan/apply; the full campaign
execution stages below remain proposals. This document does not
authorize provider writes, revoke credentials, or certify that a project was
affected. Fields explicitly documented under scoped database execution are
accepted inputs; proposed campaign fields and stage names remain design vocabulary.

The intended outcome is a recoverable process that accounts for every selected
credential, replaces it in every authorized consumer, verifies recovery, and
proves the old credential can no longer grant the access being retired. Updating
an environment variable alone cannot establish that outcome.

## Incident context and evidence

Railway's October 21 disclosure reports possible access to customer environment
variables, including some decrypted contents. It recommends replacing stored
secrets and private registry credentials and reviewing service activity. It does
not establish that a particular project or credential was accessed.
[Railway disclosure](https://blog.railway.com/p/security-disclosure-wednesday-october-21st)

The incident page separately recommended revocation at 21:59 UTC, reported
provider-driven bucket credential rotation at 22:10 UTC and revocation at 22:45
UTC, and still described build recovery as ongoing at 00:22 UTC on October 22.
These are a dated snapshot, not a current availability check. A later execution
must refresh the evidence. Provider-driven rotation also means old bindings may
already be stale before Hypervibe starts.
[Railway incident QH8L8B3E](https://status.railway.com/incident/QH8L8B3E)

OWASP treats exposure response as containment followed by replacement and
cleanup, with observable revocation and secret-safe records. This supports an
emergency path that can retire compromised access before application recovery.
[OWASP Secrets Management: incident response](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html#9-incident-response)

AWS documents a different sequence for updates without interruption: create a
second access key, update consumers, deactivate the old key, verify applications,
then delete it. That sequence assumes overlap is acceptable. AWS also states that
the secret portion is available only at creation; a lost secret requires a new
key. These native differences must survive the shared contract.
[AWS IAM: update access keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/id-credentials-access-keys-update.html)

The following architecture is a Hypervibe proposal. The sources above establish
the need and examples of native behavior; they do not prove adapter support,
project compromise, or successful rotation.

## Initial executable workflow

`hv_rotation` provides three preparation modes: `preview` (the default), `start`
and `status`. Preview assembles a value-free inventory and a staged workflow with
explicit blockers. Start saves that workflow snapshot locally so an operator can
resume the process. Status reports the recorded workflow and outstanding work.
The snapshot is not a continuously verified inventory; later live evidence must
be distinguished from the evidence captured during preparation.

This command never issues or revokes a provider credential, distributes secret
values, changes infrastructure, or deploys an application. Existing infrastructure
changes continue through `hv_spec`, `hv_plan` and `hv_apply`. Missing issuer
automation, external replacements, ambiguous ownership, unavailable consumers and
unresolved destination trust remain visible blockers with concrete next steps.

A successful start means that a workflow record exists. It must not mean that
credentials changed or that an incident is contained. Merely recording an
operator's completed checklist cannot establish provider revocation or application
recovery. Any later plan/run links must preserve their exact action identity and
evidence boundaries instead of advancing the workflow from a generic successful
apply. The local snapshot stores metadata and an internal scope fingerprint;
it contains no plaintext credentials or per-secret value verifiers. The
fingerprint never appears in command results.

```json
{"project":"my-app","mode":"incident"}
{"project":"my-app","action":"start","mode":"incident"}
{"project":"my-app","action":"status"}
```

These are `hv_rotation` inputs. The matching CLI is:

```sh
hypervibe rotation --project my-app --mode incident
hypervibe rotation --project my-app --action start --mode incident
hypervibe rotation --project my-app --action status --json
```

`mode` defaults to `routine` for preview/start; status uses the saved mode and
rejects a supplied mode. `workflowId` optionally selects an exact saved workflow
for status; otherwise status selects the most recently prepared one for the
project. Repeating start with the same recorded revision, local bindings and
selected credentials reuses the original ID. A changed scope creates a new
preparation record and preserves the previous one.

Status always distinguishes local snapshot compatibility from live coverage.
Changed recorded state yields `stale`; unreadable current repository state yields
`scopeCheck="unknown"` while an explicitly selected project's original inventory
remains inspectable. Preview/start refuse to adopt repository edits, bootstrap
legacy state, or invent missing environments. No workflow ID is an `hv_apply`
plan ID. There is no execution or manual completion-attestation input.
The `scopedExecution` pointer identifies the separate database planning path;
`prerequisites="unchecked"` and `progress="not-inspected"` are deliberate. This
command preserves its no-decryption boundary and does not inspect private
component recovery records or report an issuer operation as completed.

## What Hypervibe can do today

| Existing primitive | Proven code responsibility | Missing campaign responsibility |
| --- | --- | --- |
| Generated application secrets | A spec generation change derives a new value separately for each project/environment/key; replacement is confirmation-gated and verified. | Coordinate all consumers and invalidate sessions or other artifacts accepted under an older value. |
| Delegated runtime and GitHub secrets | Explicit references become encrypted plan input; accepted destinations retain local hashes and provenance. | Issue replacement credentials and revoke old ones at their external issuer. |
| `hv_plan scope="secrets"` | Update selected delegated runtime keys in one bound managed-CI environment without rollout, where explicitly supported. | Include generated keys, issuer operations, project-wide progress or activation. |
| `hv_plan scope="database-rotation"` | Replace the exact supported database login, prove new/old fresh authentication, then install its variables on exact stopped consumers. Supabase currently has the native issuer adapter. | Broader issuers, unsupported consumer scopes, workload rollout, application use and existing-session containment. |
| Managed CI credential synchronization | Publish selected credentials to reviewed CI destinations through lifecycle actions. | Track an old/new credential pair and prove every external consumer changed. |
| Verified connections | Encrypt a current provider credential and track its provider, scope and verification state. | Preserve issuer identity, candidate custody, consumer links and retirement evidence. |
| Runtime rollout tracking | Keep provider configuration writes separate from workloads adopting them. | Prove successful use of the replacement credential by every relevant consumer. |
| Apply receipts and environment locks | Limit writes to reviewed actions and stop after a failed, pending or blocked stage. | Recover issuance whose response was lost; serialize shared credentials across projects. |
| Initial `hv_rotation` workflow | Prepare an inventory/workflow, save a value-free snapshot and report blockers. | Execute and independently verify the proposed campaign stages. |

See [runtime secret architecture](../ARCHITECTURE.md#runtime-secrets),
[scoped secret updates](scoped-secret-updates.md),
[generated/delegated planning](../src/domain/services/delegated-secret.service.ts),
[connection storage](../src/adapters/db/repositories/connection.repository.ts), and
[rollout tracking](../src/domain/services/runtime-rollout.service.ts).
The scoped-secret provider review currently admits Railway as ready for live
validation; the other named hosting implementations remain unsupported for that
narrow no-rollout operation. Native database password replacement has its own
contract and prerequisites below. Neither offline suite establishes live support.

## Scoped database execution

For an existing supported database, record this intent under its environment:

```json
{
  "maintenance": { "enabled": true },
  "database": {
    "provider": "supabase",
    "engine": "postgres",
    "credentialRotation": {
      "generation": 1,
      "consumers": "environment-only",
      "destinations": "trusted"
    }
  }
}
```

These scope and trust declarations are owner assertions. Planning also requires
exact live database identity, verified suspended workloads, disconnected automatic
deploy sources and a host capable of updating secrets without rollout. Known
unsupported CI, backup or replica consumers and ambiguous shared database bindings
block before issuance. Preserve all other environment fields when recording intent.

Apply and verify the maintenance plan first. Then use `hv_plan` with
`scope="database-rotation"`, review the password-change and consumer-installation
actions, and authorize their exact action IDs through `hv_apply`. Supabase is the
implemented native issuer; other registered database providers remain blocked.
The same workflow is exposed by `hypervibe plan --scope database-rotation`.

Hypervibe generates a replacement and retains both versions encrypted before
the request. Fresh old/candidate login checks establish password-based
authentication; subsequent new acceptance and old rejection must cover the direct
endpoint and every bound pooler. An ambiguous request is reconciled using that
same candidate, without automatically issuing another reset. Explicit dependent
actions update `DATABASE_PASSWORD`, connection URLs and declared aliases on each
stopped service. Changing these variables alone is never issuer evidence.

An `installed` local phase means the reviewed runtime configuration was delivered.
It does not mean workloads restarted, applications successfully used the new
password, established sessions ended, or the full project was rotated. Keep these
remaining checks separate when resuming the normal deployment lifecycle. Monthly
policy records when credential work is due; it does not increment this generation,
start a scheduler, or waive maintenance and apply confirmation. See the
[database provider contract and verification limits](database-password-rotation.md).

## Choose the response mode explicitly

The campaign records a reviewed mode and its consequences before mutation.

| Mode | Ordering | Decision needed |
| --- | --- | --- |
| Emergency containment | Verify exact identity and authority, restrict/revoke exposed access, then restore consumers with replacements on trusted destinations. | Accept the specific outage, session invalidation or access loss caused by containment. |
| Controlled overlap | Prepare replacement, install and activate consumers, verify them, then retire the old credential. | Accept a bounded overlap period and its exposure risk; issuer must support it. |

A credible exposure report must not silently choose overlap to preserve uptime.
Conversely, a request to design or inventory rotation is not permission to revoke
access. Present affected applications, shared consumers, cost and data effects,
then require the exact consequential action confirmation. A confirmed containment
action need not wait for replacement deployment to become possible. Missing
issuer identity or authority still blocks targeted revocation.

Existing compromised credentials must never be automatically re-enabled as a
rollback. Recovery uses a newly verified credential or an explicitly reviewed
break-glass path. Application recovery and containment have separate statuses.

## Inventory the credential and its consumers

Inventory starts read-only and covers every declared environment, plus unresolved
scope discovered along the way. It must retain source coverage and observation
time rather than presenting a successful empty list as complete discovery.

| Inventory source | What it contributes | What it cannot establish alone |
| --- | --- | --- |
| Committed spec and exact bindings | Generated/delegated slots, destinations, databases, storage, integrations, CI and managed identities. | Undeclared secrets, actual credential use or live access. |
| Bounded provider observation | Exact environment/service key presence, provider resource scope and readable credential metadata. | That a key is valid, unused elsewhere or safe to retire. |
| CI repository/environment configuration | Declared secret names and provider-owned projections into accepted workflows. | Secret values, their issuer identity or consumers outside those workflows. |
| Selected local connections | Connection ID, provider, exact/wildcard/global scope and verification history. | Project ownership of an account-wide credential or permission to affect other projects. |
| Secret-manager references and local input metadata | Explicit source locations and the roles supplied through them. | Permission to enumerate unrelated stores or overwrite owner-managed files. |
| Issuer inventories and audit evidence | Credential IDs, principal/account, privileges, status, creation/expiry and usage where available. | Complete consumer discovery from absent or delayed activity. |
| Owner-declared external consumers | Other repositories, cron jobs, developer machines, vendors, mobile clients and recovery systems. | Independent proof that those consumers switched successfully. |

Include runtime application keys, database passwords, bucket/HMAC credentials,
registry pull credentials, CI deploy credentials, webhook signing secrets,
application signing/session keys and control-plane access. Investigate retained
resources and old environments that still hold access. Inventory ordinary
configuration separately: a URL or variable name is not inherently a secret.
Unknown classification remains visible instead of being guessed from a prefix.

Represent an issuer credential by provider-native ID together with its account,
project, principal, region or other required scope. Represent each destination
by its exact bound resource identity and key alias. `OPENAI_API_KEY` in two
services is two destinations; it is not proof of one issuer key. An AWS key pair
or database connection string may span several fields but is one coordinated
credential. Hash equality can privately suggest reuse; it cannot prove authority
or substitute for issuer identity. Never expose value hashes in repository files
or ordinary results.

The reviewed inventory needs explicit coverage states: complete for the declared
scope, partial, unknown or unsupported. Shared/global connections require a
review of all known consumers and unresolved external scope. Do not revoke them
under a project-only claim. Splitting a shared credential into project-specific
replacements is a separate reviewed change with its own permissions and costs.

## Trust the recovery destination before sending replacements

A host reporting healthy or accepting deployments does not prove that it is safe
to receive new credentials. The campaign records which issuer, operator machine,
secret store, CI runner and hosting destinations are accepted for recovery, the
evidence used, its date and the operator decision where evidence is incomplete.
This decision is separate from acknowledging a deployment outage.

Until that boundary is resolved, do not publish replacement material to the
potentially compromised provider, its build system, hosted automation or logs.
Prepare it only in an independently trusted encrypted store when issuance is
appropriate. Read-only observation must not become credential delivery. Pause
automated synchronization that would otherwise republish new connection values.

Two recovery paths may follow containment:

- Restore on the original destination after its trust decision and deployment
  prerequisites are resolved; re-observe exact identities before installation.
- Migrate to independently trusted infrastructure through ordinary reviewed
  spec/plan/apply. Account for database and file movement, backups, DNS, runtime
  identities, isolation and cost. Migration readiness does not waive rotation
  or authorize sending replacement keys to the old host.

A provider-created replacement already stored on an unresolved host is not an
independently trusted candidate merely because it is new. Record its provenance
and require an appropriate recovery decision. Never claim that rotating secrets
removes attacker-created accounts, malicious workloads or unauthorized data
changes; investigation and remediation remain separate evidence.

## Proposed desired intent and durable recovery state

Propose one project-level campaign declaration with a stable ID, reason, selected
credential references/environments, response mode, explicit exclusions, destination
trust decisions and any approved overlap deadline. Resolve broad selection into
an exact reviewed inventory; newly discovered consumers invalidate dependent
actions. Changes to scope or mode require a new plan. The declaration contains
no secret values, private verifiers or provider responses.

The initial preparation snapshot is value-free. Before automated execution,
store operational state locally under one versioned runtime schema. It must bind
campaign ID and revision, issuer and consumer identities, independent evidence,
old/new versions, encrypted candidate handles, operation IDs, plan/action IDs,
attempt status, activation evidence, retirement evidence and residual blockers.
Use encrypted custody separate from the currently selected connection so a
candidate cannot replace functioning control-plane access before verification.

Persist intent before issuing, importing a one-time value, disabling or deleting.
Persist received material encrypted before its first distribution. Resume with
the exact retained candidate after a process restart or partial install. A lost
response is an uncertain outcome: reconcile the original operation and native
identity, never create a second credential or retrieve a consumed value again
automatically. If the issuer cannot prove the outcome, retain a blocker and the
minimum recovery evidence needed for a reviewed next step.

AWS Secrets Manager provides a useful native example: a pending version tied to
an operation token survives separate create/set/test/finish invocations; its
rotation function also verifies that old/new credentials target the intended
resource. Hypervibe should preserve those properties without assuming every
issuer exposes AWS-style stages or idempotency.
[AWS Secrets Manager rotation functions](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_lambda-functions.html)

Keep candidate and any necessary old material out of specs, bindings exports,
dotenv files, logs and receipts. Retention and encrypted backup policy must be
explicit; preserve evidence needed for uncertain recovery, then retire sensitive
material when safe. Losing the local root key is a recovery blocker, not an
instruction to regenerate all secrets. Removing a declaration cannot erase an
unfinished campaign or its recovery state.

## Proposed execution stages and authority

The initial workflow can describe these stages and their blockers; it does not
execute them. All proposed mutations belong in the desired-state lifecycle.
`hv_spec` records
reviewed intent; `hv_plan` observes and produces the next permitted stage;
`hv_apply` executes exact confirmed actions; `hv_status` reports evidence and
remaining work. Do not add a generic imperative tool that loops over providers.
The identifiers below are proposed operations, not existing command arguments.

| Stage | Planned authority | Evidence required to advance |
| --- | --- | --- |
| Inventory and review | Observe only; resolve exact selection, shared scope, mode and recovery destinations. | Dated coverage, ownership/scope, known consumers and explicit unresolved rows. |
| Contain, emergency mode | Disable/revoke exact old credential or restrict a reviewed principal/session scope. | Issuer-confirmed result plus bounded observation; outage and residual session exposure recorded. |
| Prepare | Derive an approved generated version, accept an external replacement or issue one exact native credential. | Validated candidate identity/scope and encrypted durable custody; no distribution yet. |
| Install | Write only named keys/credential bundles to exact approved destinations. | Per-destination convergence or explicit unknown/failed outcome; masked CI presence alone is insufficient. |
| Activate | Roll out reviewed workloads/workflows or coordinate external consumer changes. | Exact candidate release/deployment identity, preserved environment isolation and completed existing gates. |
| Verify consumers | Run bounded, safe authentication checks from the intended consumer context. | Candidate-specific evidence for required access; healthy HTTP alone cannot prove credential adoption. |
| Retire, overlap mode | Disable/revoke exact old issuer identity after reviewed prerequisites. | Fresh scope/consumer check and terminal issuer status; no automatic inference from a write attempt. |
| Verify retirement and close | Observe continued operation, session expiry/revocation and cleanup; remove only explicitly owned retired material. | Completed credential and consumer evidence, accounted exclusions, no unresolved selected operations. |

Each action needs one operation, target, current non-secret fingerprint and
explicit dependency edges. Recompute authority immediately before writes,
including confirmation markers, current provider scope and destination trust.
Noops perform zero provider mutations. A pending/failed/blocked result stops the
stage; later actions are unattempted, not failed. Re-plan after the prerequisite
is resolved without discarding the campaign candidate.

Plan or per-item actions may advance independent rows separately, but a global
success flag must not hide incomplete ones. Serialize overlapping campaigns by
issuer credential identity, including shared connections across projects, and
retain existing environment deployment locks. Identity replacement, external
rotation, candidate expiry or a newly discovered consumer makes stale actions
ineligible.

Session retirement is its own capability when applicable. Revoking a long-term
key does not prove all derived access ended. AWS explicitly supports denying
older role sessions, with effects on all affected users and documented exceptions;
that is distinct from replacing an access key.
[AWS IAM: revoke role sessions](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html)

## Blockers and completion claims

Immutable encryption keys cannot enter ordinary generated-secret rotation.
They require a separate reviewed rewrap/re-encryption design, retained decrypt
capability, data verification and recovery proof. Session-signing changes may
invalidate users; webhook keys may require issuer/receiver overlap; database
password changes may break pooled connections. Record these application-specific
consequences rather than treating every slot as a random replaceable string.

Keep these results distinct: inventoried, candidate secured, installed, activated,
consumer verified, old access retired, and recovery complete. For generated
application secrets, retirement evidence must come from application acceptance
behavior; there may be no external issuer API to query. Unsupported verification
or revocation remains a blocker or a separately labeled external attestation,
never an inferred success. Ordinary key presence, an accepted write, elapsed
time, absence of logs or a green deployment cannot fill that gap.

A campaign may be closed with explicit exclusions, but its result must list
them and say that coverage is limited to the reviewed selection. It must not say
all project credentials were rotated while external consumers, unknown issuer
identities, compromised destinations or uncertain writes remain unaccounted for.
Containment can be verified while recovery is still blocked by an outage.

## Engineering slices and acceptance gates

Implement the shared contract before issuer adapters. Each slice must be useful
and honest independently. The initial workflow preparation release must describe
itself that way, even when it lists every future stage.

1. **Inventory and coverage.** Add a transport-neutral, value-free inventory model
   reused by planning/status and existing inspection capabilities. Test every
   environment, retained resources, CI projections, wildcard/global connections,
   external consumers, pagination and ambiguous duplicate identities. Unknown
   reads must survive as unknown; inventory must perform zero writes.
2. **Campaign schema and recovery repository.** Introduce reviewed intent plus a
   single validator for persisted campaign state. Add encrypted candidate custody,
   operation intents and identity locks. Test corrupt state, changed specs, root-key
   loss, concurrent projects, crashes at every persistence boundary and removal of
   unfinished intent. No new database row may imply verified provider success.
3. **Existing destination paths.** Reuse generated/delegated secret planning,
   CI synchronization and rollout tracking without changing the meaning of
   `scope="secrets"`. Test both environment orders, exact aliases, multi-field
   credentials, immutable refusal, confirmation removal, destination replacement,
   partial writes and retries with the same retained candidate. Gate every path
   against unresolved destination trust, including automatic CI credential sync.
4. **Issuer capability and evidence matrix.** Define observe/issue/verify/
   disable/revoke and session semantics behind provider capabilities. Review every
   named provider in each affected registry category against official contracts
   before adapter admission. Record exact identity, overlap limits, privilege
   prerequisites, one-time responses, idempotency, completion and recovery behavior.
   Missing capabilities must remain unsupported, with a concrete external handoff.
5. **First complete admitted workflow.** Integrate one explicitly supported
   issuer/consumer combination through the shared campaign. Exercise real clients
   over serialized transport with independently sourced fixtures: lost creation
   response, conflicting issuer identity, delayed reads, provider-driven rotation,
   rejected revocation, and failed cleanup. Verify confirmed containment can stop
   before deployment while controlled overlap cannot retire an unverified consumer.
6. **Activation and closure.** Execute emitted CI programs and their consumers.
   Reject success based on matching mocks, key presence or generic health. Test
   blocked builds, migration to a trusted destination, no distribution to the old
   host, external consumer gaps, derived sessions and post-retirement checks.
   Keep recovery, coverage exclusions and incident investigation separately visible.

Place regression tests in ordinary `npm test`, including registry completeness,
CLI/MCP parity, action-scoped authority, noop freedom and exact-value redaction.
Before runtime changes, reproduce the concrete failure through the relevant real
boundary. Record independent evidence and observed failing/passing results.
Offline contracts establish their tested boundaries only; publish live support
claims only after a recent successful lifecycle exercise for the named combination.

No live rotation is part of the initial workflow preparation change. Subsequent
execution needs an admitted issuer/consumer combination and its operational
contract, without bypassing campaign ownership, exact plan authority or recovery.
