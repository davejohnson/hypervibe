# The common cloud user journey

This is the acceptance target for new Google Cloud, AWS and Azure work. It defines
what we are building toward, not what is supported today. The same user outcomes
must work on each cloud before we call the three-cloud milestone complete.
[Architecture](../../ARCHITECTURE.md) defines the implementation and safety
boundaries; [product guidance](product.md) defines how we explain the work.

## The user's task

> Deploy this repository to my chosen cloud. Work out what it needs, show me the
> cost and changes, and get it running. Let me release updates, diagnose problems,
> recover my data, and eventually remove it through the same workflow.

The user brings a repository, access to a chosen cloud and any outside services
the app uses. They choose the destination, resolve ambiguous account or billing
choices, supply outside keys privately, and approve consequential changes.
Hypervibe does the routine setup and explains each remaining action. It does not
ask the user to choose an engine, design cloud resources, install cloud CLIs or
Docker, or manually repeat a sequence of infrastructure rounds.

The current npm installation requires Node.js and npm. Removing those prerequisites
is separate work. Hypervibe must manage its pinned, private OpenTofu dependencies.
No part of this target authorizes live spending, data copies or deletion without
the existing exact approval boundary.

## One reference app, three destinations

Use one maintained repository and the same observable checks on all three clouds.
The app has a public web service, PostgreSQL, private file storage, generated and
externally supplied secrets, a database-backed on-demand worker, and a scheduled
job. A request creates a durable record, uploads a file and queues work; the worker
processes it, and the scheduled job records a result. A later release changes a
visible version without losing those records or files.

Start with the existing supported Node.js app/build path. Exercise both a generated
build and a repository Dockerfile with declared build requirements. Other runtimes
and build features need their own evidence before they are advertised. A managed
build service must handle the supported build; local Docker is not a prerequisite.
Extend the existing [conformance fixtures](../provider-conformance.md) where they
fit. A smaller web-only fixture remains useful but cannot stand in for this app.

Run the journey with a testing environment and an isolated production environment.
Also verify that staging can use the production profile when requested. Creating
all three environments is an acceptance exercise, not a default chore or cost for
every customer. Never share production data or credentials with testing to make
the exercise pass.

## Steps and observable completion

| Step | User experience | Evidence required |
| --- | --- | --- |
| 1. Inspect and propose | In the app repository, ask to deploy to the chosen cloud. Hypervibe infers the runtime and required services, and identifies unsupported needs before cloud changes. | Repository, source revision, destination and intended resources are explicit. Inspection makes no infrastructure changes. Unsupported input has a useful blocker, never a fallback to another cloud. |
| 2. Install and connect | Install Hypervibe, sign in through the supported browser flow, and choose an account or billing destination only when needed. | The installed package can reach the selected account with appropriately scoped access. Setup changes have their own reviewed approval; sign-in alone authorizes none. No separately installed engine or cloud tooling is needed. |
| 3. Review and launch | Review the proposed resources, costs, permissions and data consequences. Approve the exact plan; Hypervibe handles dependent stages and resumes after necessary decisions. | Every mutation belongs to the approved current plan or an explicitly authorized operation. Changed plans require new review. Repeated calls neither duplicate resources nor reuse approval for different actions. |
| 4. Use the app | Open the supplied HTTPS URL and perform the reference app's actions. | Web, database read/write, file round trip, both secret types, worker wake/processing and cron all work through the running app. Runtime identities are scoped; secrets are absent from output. A submitted build or healthy infrastructure resource alone is insufficient. |
| 5. Release updates | Ask to deploy a committed change locally, then enable releases from a chosen GitHub branch through reviewed setup and push another change. | Both release paths serve the expected immutable revision. CI verifies rollout and application behavior, reports failures, and uses scoped workload identity. A subsequent infrastructure plan preserves the release and converges to noop. |
| 6. Prepare production | Ask for an isolated production environment, with staging when useful. Review its cost, availability and recovery differences from testing. | The same app checks pass on the production profile. Data, credentials and identities are isolated. An economical testing deployment is never presented as production validation. |
| 7. Attach a domain | Use a domain and existing DNS zone the user controls. Hypervibe reviews the exact DNS and hosting changes. | The intended app serves at the custom hostname with a valid certificate. Pending certificate issuance is reported as pending; hosting never silently chooses or changes DNS ownership. |
| 8. Bring existing data | When requested, copy PostgreSQL data and files from an explicitly selected supported source into the new environment. Review source, destination, overwrite scope and cutover consequences. | Source remains usable; verified rows/content and file hashes match the approved copy. Secrets have separate import authorization. Re-running does not overwrite data again without approval. Writes during copy require an explicit consistency/cutover plan. |
| 9. Diagnose and roll back | Inspect status and redacted logs, then return a failed release to a known working revision. | A deliberately failing release remains failed. Rollback selects the immutable prior artifact, checks schema/configuration compatibility and verifies the restored app with its data. Incompatible data changes block rather than promise automatic recovery. |
| 10. Back up and recover | Review the recovery policy and costs; use Hypervibe to back up and restore the app's persistent data. | The agreed schedule/retention works and a restore into an isolated destination passes content and app checks. PostgreSQL and required files are covered. A successful backup request alone is insufficient. Recovering Hypervibe's encrypted state and access is also demonstrated so loss of a local checkout does not strand the app. |
| 11. Remove the environment | Review what will be deleted, what backups or shared resources remain, and their ongoing costs. Confirm exact destructive actions. | Teardown follows dependencies. Independent read-only checks confirm absence of every targeted native resource, including resources created during partial failure. Failed/unknown cleanup preserves recovery state. Other environments and retained shared resources remain usable. |

The data-copy baseline uses a declared PostgreSQL/files source, including an
existing Railway app where that source workflow is supported. This is not a
commitment to import arbitrary infrastructure or every database/storage product.
Never move or retire an existing Railway app as a side effect of cloud parity.

## Consistency and failure behavior

The shared application workflow owns the journey; CLI and MCP expose the same
capabilities and results. `hv_launch` is the intended guided entry point, over
`hv_spec` → `hv_plan` → approved `hv_apply` → verification. Explicit operations for
releases, data copies and recovery keep their own authorization and result rules.
Users can inspect individual steps without having to orchestrate them themselves.

Same experience means the same required outcomes, approval rules and honest
completion states. Cloud-native resources, prices, startup latency and database
availability can differ; explain consequential differences. Do not force all
providers into the first provider's API shape. One guided command does not promise
one approval: newly discovered costs, permissions or data effects need review.

For each destination, exercise an interrupted apply and an interrupted release;
resume using saved operation identity and current observation. Also cover expired
access, stale plans, missing outside keys, unsupported features, failed app checks
and unknown cleanup results. No failed, blocked or pending result may trigger
dependent effects or become a claim of success. The same spec never reaches
another cloud's setup because its selected capability is unavailable.

## Build order and scope

1. **Make boundaries honest.** Correct wrong-provider routing, unsupported-feature
   checks and contradictory support claims. Make engine and planning choices
   routine application behavior. Preserve existing resources and useful clients.
2. **Prove first launch.** Integrate installation, connection, exact approvals and
   a web app with PostgreSQL and secrets on one cloud. Extend that same scenario
   to the other two. Keep partial milestones explicitly partial.
3. **Complete the app and operations.** Add the reference app's remaining work,
   production, local/CI updates, domain, data copy, diagnosis, rollback, backup,
   restore and removal. Carry each shared behavior across all three clouds using
   the same acceptance steps; close gaps before expanding the feature list.
4. **Remove replaced code.** Trace actual callers and retain authentication,
   builds, releases, inspection, data operations and existing-resource management
   before deleting obsolete lifecycle writers. Deletion does not establish parity.

Redis, dedicated queue services, email, webhooks, mobile releases, registrar/zone
creation and additional runtime/provider support are outside this milestone.
The reference worker uses PostgreSQL rather than requiring a dedicated queue.
Existing supported features and their safeguards remain supported within their
declared scope; this list does not authorize removing them or their data.
Backup/restore is part of the production target, not an optional parity casualty.

Deliver a proven increment without waiting for unrelated cloud work, but name the
cloud and steps it covers. Reserve “three-cloud journey complete” for all steps
passing on all three destinations. An unsupported path stays unavailable on that
destination; another cloud's missing feature is not evidence a working path is broken.

## Evidence and maintenance

The [GCP](../opentofu-engine.md), [AWS](../opentofu-engine-aws.md) and
[Azure](../opentofu-engine-azure.md) notes record partial implementations and dated
observations. They do not certify this complete journey. This documentation change
adds no live verification or runtime capability.

For each delivered step, record the tested package/source revision, cloud/profile,
fixture revision, approved scope, observed app result, failure/resumption results,
and cleanup or intentionally retained resources. Link the evidence from the
provider notes; distinguish implemented, checked offline, observed live, blocked,
and unverified. Never infer current support from an old date, a provider registry
entry, a successful component test, or a different cloud's pass.

Tests of approval, identities, secrets, failure/resumption and cleanup protect
user outcomes even when provider transport is simulated. Keep those boundaries
and real-engine checks. Replace source-string and documentation-wording checks
with executed behavior where they claim behavioral protection. Remove an obsolete
test only after identifying its lost protection and any necessary replacement;
provider names and test age alone do not establish that coverage is useless.

Keep regression coverage in ordinary CI and live evidence in the supported
[conformance workflow](../provider-conformance.md), with exact approval for live
work. Review changed behavior and invalidate only evidence its dependencies affect.
Changes to milestone scope belong here, with their decision explained in the
pull request. Delete superseded backlogs and design notes; Git history preserves
the prior decisions. Backend notes cannot create a competing roadmap. Use the [documentation map](../README.md)
to find the relevant contract rather than loading the entire docs directory.
