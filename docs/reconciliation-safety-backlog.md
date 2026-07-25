# Reconciliation Safety Backlog

This backlog records the July 2026 review prompted by Invoice Perfect's
Railway import/apply incident. The incident exposed a system-level mismatch:
planning reasons about individual observed resources, while parts of apply
still run a coarse bootstrap that can mutate the full environment.

The target invariant is:

> A reviewed non-noop plan action is the sole authority for its provider
> mutation. Unknown live state is not absence, and a noop action causes no
> provider mutation.

## P0 — Stop Unreviewed Or Unsafe Mutations

- [x] Replace the shared `ensureBootstrap()` fallback with action-scoped
      handlers for project, environment, service, runtime-secret, email, and
      domain convergence.
  - A service or delegated-secret action must not create or repair a database,
    attach a domain, configure email, or deploy an unrelated service.
  - A database create action must be the only path allowed to call
    `IDatabaseAdapter.provision`.
  - Plan dependencies must order database creation before database env wiring
    and dependent service configuration.
  - Each receipt must be backed by evidence for that exact action instead of a
    memoized whole-environment bootstrap result.
- [x] Introduce capability-scoped observation completeness with explicit
      `present`, `absent`, and `unknown` outcomes.
  - Only a provider-confirmed not-found result may plan a create from observed
    state.
  - Unsupported observation, permission failures, timeouts, rate limits, and
    partial reads must preserve known state and block affected mutations.
  - Hosting observation success must not imply database, storage, queue, iOS,
    or repository-setting observation success.
- [x] Enforce confirmation centrally for every action marked `billable` or
      `dataBearing`, rather than relying on each planner to also set
      `requiresConfirm`.
  - Mark database and storage creation costs honestly.
  - Keep destructive service actions confirmation-gated whenever provider
    classification cannot prove the service is non-data-bearing.
- [x] Remove Cloud SQL's `0.0.0.0/0` authorized network from instance
      provisioning. Runtime access should use the Cloud SQL connector/socket;
      any public network path must be explicit desired state with narrow scope.
- [x] Make nested deploy stages fail fast on failed prerequisites. Do not keep
      running provider mutations after `ensureProject`, secret resolution, env
      sync, or another required stage fails.

## P1 — Database Provider Correctness

### Railway

- [x] Extend Railway inspection/import to expose service-backed datastore
      candidates and require an explicit datastore mapping during adoption.
- [x] Adopt a selected service-backed Postgres instance as a database component
      per environment, with provider, project, environment, service, resource
      kind, and variable-reference bindings. Do not also bind it as an
      application service.
- [x] Populate complete provider bindings when importing legacy Railway plugin
      databases; an external id with empty bindings is not an adopted component.
- [x] Match managed databases by external id first. If several Postgres
      candidates exist and no unique binding selects one, block rather than
      choosing the first name match.
- [x] Propagate Railway project, service-instance, and environment-variable
      read failures. Only a confirmed not-found response may become absence;
      an unreadable matching service must not trigger duplicate creation.
- [x] Report every additional PostgreSQL datastore in `hv_status` and
      `hv_plan`, including provider id and display name without secret values.
- [x] Make Railway service/project deletion verification use a realistic
      bounded timeout with backoff. Treat an already-absent resource as success
      and allow a retry to clear stale local state.
- [x] Preserve a Railway datastore volume unless deletion of its owning service
      is confirmed. An unknown/failed service delete must stop database cleanup.

### Supabase

- [x] Implement `observeDatabase` and distinguish not-found from failed or
      unsupported observation. Until then, use a matching local component as
      unverified state instead of planning a create.
- [x] Stop using the logical `databaseName` option as the Supabase project name.
      Current apply passes `app`, causing staging and production to contend for
      the same Supabase project name. Project identity must include the
      Hypervibe project/environment; logical database naming is separate.
- [x] Verify deletion to terminal absence and make repeated deletion
      idempotent. A successful HTTP DELETE response alone is not convergence.

### Cloud SQL

- [x] Make instance lookup return not-found only for an actual 404. Propagate
      authorization, timeout, quota, and server failures as unknown observation.
- [x] Wait for the delete operation and verify terminal absence before removing
      the local component. Treat 404/already absent as successful convergence.
- [x] Match observation to an adopted component's external id when one exists;
      deterministic environment naming is only a fallback.

### Amazon RDS

- [x] Stop converting all `DescribeDBInstances` errors into absence during
      observation. Only `DBInstanceNotFound` proves absence.
- [x] Make destroy idempotent when the DB instance is already absent, while
      still cleaning up a Hypervibe-managed security group when appropriate.
- [x] Add lifecycle tests for provision, observation failure, duplicate-name
      behavior, terminal deletion, and delete retry. Existing tests cover only
      temporary ingress behavior.

## P1 — Other Resource Reconciliation

- [x] Detect duplicate logical service identities before constructing a
      `Map<string, ObservedService>`. Never silently overwrite one observed
      service with another after provider-name normalization.
- [x] Block storage creates when the relevant storage observation failed.
      `observed.partial` plus an empty storage list is not proof that a bucket
      is absent.
- [x] Block Pub/Sub mutations when queue observation fails instead of returning
      executable unverified create actions.
- [x] Block App Store Connect creates and updates when observation fails.
      Bundle ids, app records, capabilities, groups, and tester membership must
      not be inferred absent from a read error.
- [x] Block GitHub repository-setting mutations when the corresponding setting
      read fails; do not default an unread boolean setting to `false`.
- [x] Model SendGrid email setup as first-class plan actions. It must not be a
      hidden side effect of service bootstrap, and partial email setup must not
      be reported as a successful unrelated service action.
- [x] Ensure domain attachment and DNS are executed only by their planned
      domain actions, not once during service bootstrap and again in the domain
      handler.
- [x] Make partial secret resolution a failed/blocked receipt unless every
      failed mapping is explicitly optional.
- [x] Treat failed Cloud Run service/job existence reads as unknown during
      deletion. Only 404 proves absence; 403/5xx responses fail the action.

## P2 — Architecture Cleanup

- [x] Move Railway database/storage adapter construction behind provider
      registry capabilities. `AdapterFactory` should not contain Railway name
      branches or direct Railway adapter imports.
- [x] Replace coarse `ObservedState.partial` with per-capability completeness so
      a failed env-var read does not unnecessarily block service identity checks
      while a failed resource listing does block creates and destroys.
- [x] Define an explicit adoption action/binding reconciliation path for a
      desired resource that exists live but lacks local identity. Do not label
      that state `noop`, and do not silently adopt during ordinary apply.

## Required Contract Tests

- [x] Noop contract: applying a plan made entirely of noop actions produces
      zero provider mutation calls.
- [ ] Action-authority contract: each non-noop action may call only the
      mutation capability and resource identity declared by that action.
- [x] Observation-failure contract: permission, timeout, rate-limit, and 5xx
      reads never produce executable create/destroy actions for the affected
      capability.
- [x] Duplicate-identity contract: multiple resources of the same managed type
      are all reported and ambiguous selection blocks apply.
- [ ] Import round-trip contract: provider inspection → explicit import →
      status produces no create/destroy action for every currently supported
      provider resource shape.
- [x] Delete-retry contract: acknowledged asynchronous deletion, delayed
      absence, already-absent resources, and interrupted local cleanup all
      converge successfully without leaking stale state.
- [x] Confirmation contract: every billable or data-bearing action is skipped
      unless its exact action id is confirmed.
- [ ] Provider parity matrix: run the database lifecycle contract against
      Railway, Supabase, Cloud SQL, and RDS adapters.

## Exit Criteria

- A service/env/secret-only plan cannot call any database provision or destroy
  method.
- A provider read failure cannot result in an executable create, update, or
  destroy for the unread capability.
- `hv_status` cannot report `inSync: true` while a managed resource identity is
  ambiguous.
- Apply receipts identify exactly which reviewed action produced each provider
  mutation and verification result.
- Every supported database provider passes the same import/observe/plan/apply/
  status/destroy/retry contract suite.
