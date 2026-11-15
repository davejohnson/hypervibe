# Recover a retained database provision or select a current candidate

When Railway acknowledged a PostgreSQL template request but verification did
not finish, Hypervibe can inspect the retained attempt and existing resources.
If the attempt already saved a service ID, recovery verifies that exact ID.
If no service ID was saved, inspection can only offer a current candidate for
explicit selection: its relationship to the original workflow is unproven.
Both paths update metadata without creating, restarting, initializing, deleting,
or deploying anything on Railway.

## Required evidence

The selected environment must still declare the same database provider and
engine, with exactly one retained `provisioningIncomplete` component. Railway
inspection requires all of the following:

- Exact provider project and environment IDs matching the retained component.
- The original `databaseTemplate` attempt: `templateId`, `templateServiceId`,
  acknowledged `workflowId`, and complete `priorServiceIds` inventory.
- For an attempt without a service ID, a valid unresolved-create marker in that
  same scope. If an ID was already recorded, recovery must verify that exact ID.
- A completed workflow and exactly one new matching template service, followed
  by verification of its exact environment instance and expected image.
- One verified persistent mount containing the effective `PGDATA` path. Any
  previously recorded volume ID must still match. Both volume and volume-instance
  IDs become part of the reviewed identity.
- Independently read raw variable references and rendered values that agree
  with the expected PostgreSQL template, with no pending reference repairs.

A display name such as `Postgres-GgfJ` is not ownership evidence. Workflow
completion and a unique new matching service do not prove that the workflow
created that service: the original resource may have disappeared and a separate
deployment may have created a replacement. An attempt without a saved ID always
returns `candidate` with `lineage: "unproven"`, never `ready`. The current
verifier also requires the service's native template identifiers to match the
retained template ID and serialized service key. The pinned schema establishes
the field types. A read-only live observation on 2026-11-02 found a complete
service inventory and confirmed this exact identifier match for one retained
attempt, together with a completed workflow and the expected source image.
That redacted observation establishes the observed fields for this attempt. It
does not prove workflow lineage or a general `templateServiceId`-to-slot-key
guarantee. Missing or different identifiers block inspection from offering the
resource.

## Review and apply

1. Run normal `hv_plan` for the project and affected environment. Eligible work
   appears in an isolated `database-bindings` plan with one action. A previously
   retained ID uses `database-recovery:<provider>:<component-id>`; an attempt
   without a saved ID uses the separate
   `database-candidate:<provider>:<component-id>:<service-id>` action.
2. Review the exact service ID, native project/environment scope, and volume
   identity. **Before confirming a candidate action, the caller must ask the
   user to select that specific current database.** Explain that its lineage
   from the original workflow is unproven. Earlier approval to create a database
   does not authorize selecting a different existing resource. The candidate
   action and its receipt record operator-confirmed selection, not proven
   workflow recovery.
3. Run `hv_apply` with that `planId` and the exact approved action ID in
   `confirmActions`. Apply repeats the provider reads and checks the spec,
   component, environment, and evidence against the reviewed plan before
   recording metadata. A changed candidate requires a new review and selection.
4. After success, run `hv_plan` again to review remaining work. Application
   deployment and its missing runtime inputs remain separate actions.

Unknown reads, pending or failed workflows, ambiguous services, changed scope,
unverified storage, and broken references retain the existing attempt and block
recovery or candidate selection. A running database alone is insufficient.
Hypervibe must not retry the
create, select a resource by name, or use force import to work around this check.
Force import reconstructs project desired state; it is not a narrow recovery.

Successful apply preserves the original template attempt, desired state, other
environments (including production), and unrelated recovery metadata. It records
the verified retained ID or explicitly selected candidate and primary topology,
then clears only the
incomplete-create markers. Existing backup, initialization, bootstrap, and
credential-rotation safeguards remain in force. Concurrent metadata changes
block the write. A failed repository binding export can be retried without
repeating the metadata commit or any provider mutation.

## Provider capability

| Database provider | Retained provision verification |
| --- | --- |
| Railway | Exact retained-ID recovery and explicit current-candidate selection implemented for these acknowledged PostgreSQL template attempts; live application of either path unverified. |
| Google Cloud SQL | Unsupported capability. |
| Amazon RDS | Unsupported capability. |
| Azure PostgreSQL | Unsupported capability. |

An unsupported capability preserves the blocker. It does not authorize generic
adoption, another create, or a provider-specific workaround.

## Evidence and remaining checks

The original failure challenges the assumption that a successful provider create
must finish verification within the initiating call. Regressions exercise a
retained acknowledged attempt whose workflow later completes, plus a correlated
service whose reference verification initially failed. Another counterexample
removes original service A, introduces matching service B, and completes A's
workflow. The verifier initially mislabeled B as ready; its regression now
requires an explicitly unproven candidate. These cases were observed
failing before recovery support and passing afterward through the actual
planner/apply boundary and Railway client serialization.

The normal test suite includes
[`database-provision-recovery.contract.test.ts`](../src/application/__tests__/database-provision-recovery.contract.test.ts)
and
[`railway.database-provision-recovery.api-contract.test.ts`](../src/adapters/providers/railway/__tests__/railway.database-provision-recovery.api-contract.test.ts).
These use synthetic provider state. No live recovery or candidate-selection
apply has been run for this
change. The separate read-only live observation above does not establish why
the original verification failed; delayed instance convergence after workflow
completion remains a hypothesis. Configuration checks do not establish SQL
authentication, application access, migrations, runtime health, disk I/O or
durability, successful backups, or tested restores. SQL authentication remains
unchecked.

Independent sources and pins:

- [Official Railway template deployment source](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/commands/deploy.rs)
  and [workflow polling source](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/controllers/workflow.rs),
  with excerpts and limits in
  [`database-template-source.json`](../test/provider-contracts/railway/database-template-source.json).
- [Railway volume documentation](https://docs.railway.com/volumes),
  [variable API documentation](https://docs.railway.com/integrations/api/manage-variables),
  and the recorded public PostgreSQL template with provenance in
  [`postgres-template.source.json`](../test/provider-contracts/railway/postgres-template.source.json).
- Pinned official GraphQL
  [`schema.graphql`](../test/provider-contracts/railway/schema.graphql) and
  [`source.json`](../test/provider-contracts/railway/source.json). The opaque
  serialized template scalar does not validate nested template semantics.
