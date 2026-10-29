# Separate backup setup from ordinary deployment

The user rejected a proposed `hypervibe-backups` bucket and the requirement to
finish backup setup before deploying Invoice Perfect. The challenged assumption
was that daily coverage intent authorizes a deployment prerequisite, including
an inferred archive and a successful retained recovery set. It does not.

The reported live counterexample was staging repository publication blocked by
production's incomplete backup configuration. Native production daily snapshots
already existed. No new bucket was created. The implementation regressions also
exercise ordinary direct apply and all-noop bootstrap with missing recovery
evidence, evidence expiring immediately before the write, generated GitHub/GitLab
deployment programs, and application storage without an archive declaration.

`PlanService` now selects backup lifecycle stages only through explicit
`hv_plan scope="backups"`. Only that scope with explicit daily intent may propose
a derived archive; it still needs exact billable-action confirmation. Ordinary
apply and generated deployment programs do not enforce recovery health. Omitted
intent means unmanaged, not that existing provider snapshots are disabled.
Native schedules, stronger protection, explicit
destructive-operation checkpoint confirmation, and recovery evidence validation
remain independent safeguards. Coverage and readiness stay visible in status
without making them deployment drift. Backup setup that did not run is never
reported as completed protection.

Ordinary repository publication preserves every accepted backup program and
does not publish even a ready new program. Explicit backup-scoped publication
selects the requested environment independently of the canonical GitHub
environment. It cannot carry unrelated repository policy or another
environment's files. An explicit disabled declaration and backup-scoped review
can retire only that managed program; this does not authorize deleting native
snapshots, storage or recovery history.

Normative rules DG-011, DG-107 and DG-111, their migration-audit hashes,
architecture, backup documentation and distributed workflow references record
this deliberate policy correction. The architecture regression rejects
deliberately introduced backup-admission imports in ordinary apply and CI
renderers. Runtime boundary regressions remain in ordinary `npm test`.

Observed before runtime changes: `optional-backup-apply.test.ts` had four
failing normal-deployment cases and one passing explicit-checkpoint denial.
The failing cases stopped at backup readiness rather than reaching bootstrap.
After the fix, all five pass. The architecture check and its deliberately
violating samples pass. Other focused planner, repository and generated-shell
results are recorded with the change's validation evidence.

A second persisted-authority counterexample accepted backup publication with
missing or wrong environment metadata, unrelated or another environment's files,
an incomplete program pair, or ordinary full scope. All six denial regressions
failed before changing the shared persisted-plan predicate. Further RED checks
showed that malformed file content/hash and publication inconsistent with current
daily/disabled intent were accepted, while a valid nonbillable retirement was
rejected. The final prerequisite/publication suite passes all 24 cases, and the
architecture suite passes all 11, including deliberately unscoped backup
compilation. The canonical-environment integration regression uses production
backups with backup-disabled staging owning ordinary GitHub policy.

Full acceptance exposed an identity-ordering dependency previously hidden in
the backup provisioning stage. For providers with separate native environments,
ordinary plans now use the existing binding stages to establish the namespace
before reviewing child resources. Five namespace cases failed before this repair;
the planner suite passes 75 cases and related binding/deployment suites pass 50.
This enforces Hypervibe's scoped action authority, not a claim that every provider
API requires an environment identifier. Secret inputs and runtime overrides stay
deferred until the namespace has converged.

Historical renderer-5 and renderer-7 gate artifacts verify that normal workflow
publication removes the old deployment gate. The removed backup-policy input
already changes affected workflow contracts, so no global renderer revision bump
is needed. Unaffected workflow hashes remain stable. Previously disabled backup
metadata can be reconciled without publishing a workflow when its accepted bytes
already match. These migration checks and the existing iOS/promotion contract
checks pass together; their historical expected hashes were not rewritten.

These tests run actual planning/application/compiler boundaries with synthetic
provider observations and test transports. They do not certify live provider
compatibility, a successful application release, a completed backup, or a tested
restore. Regenerated workflows must be reviewed and accepted before changed
deployment behavior reaches existing projects.
