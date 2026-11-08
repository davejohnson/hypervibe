# OpenTofu integration handoff

This foundation removes the unused handwritten cloud resource lifecycle while
the engine branch is developed separately. It is preparation for that merge,
not a release with working OpenTofu deployment support.

## What remains

- Railway keeps its existing lifecycle for existing applications.
- Cloud connections, authentication, bootstrap, image builds, inspection, logs,
  database access and recovery, object transfers, and scoped credential operations
  remain where implemented. These are operational capabilities, not permission to
  create infrastructure.
- `IProviderAdapter`, `IDatabaseOperations` and `IStorageOperations` expose those
  operations without requiring resource creation or destruction methods.
  Lifecycle callers still require a registered, enabled lifecycle capability.
- Shared plan authorization, exact identity, redaction, partial-outcome recovery,
  CLI/MCP commands and third-party integrations remain. Tests of these contracts
  use synthetic lifecycle providers when the old cloud implementation is gone.

Cloud hosting, database and storage lifecycle metadata is marked planned. The
old cloud cache adapters, Cloud Run cron/queue/volume provisioning and custom
cloud resource CRUD are removed. Do not re-enable them to satisfy engine tests.

## Integrating the engine branch

1. Keep the incoming Cloud Run engine helpers, including archive builds, alongside
   the retained operations. A merge rehearsal found an insertion conflict around
   these helpers; resolve it by keeping the helpers without restoring the removed
   resource lifecycle. Keep only one `buildReleaseImage` wrapper.
2. Make spec validation recognize an installed engine and its supported targets.
   The old hosting/database capability declarations no longer authorize cloud
   mutations. `hv_spec` and engine planning must validate the actual engine path;
   simply changing cloud maturity back to ready would reintroduce false authority.
3. Dispatch saved engine plans before the legacy desired-state lifecycle gate.
   The application apply route now loads plans before checking their scope, and
   `hv_apply` delegates validation to that shared route. Existing credential-only
   plans retain their own exact target, scope, confirmation and recovery checks.
4. Keep engine state/configuration ownership separate from operational bindings.
   Translate verified outputs into exact identities needed by health, credentials
   and data operations. Never infer deployment health from engine exit status.
5. Prove one GCP journey through both command adapters: setup without extra user
   tools, app inspection, account connection, reviewed plan, apply, release and
   live app verification. Exercise interruption/retry and teardown before calling
   the path supported. Then extend the same model to AWS and Azure.

The engine branch remains responsible for its runtime installation, provider
plugins, configuration generation, state and saved-plan execution. This reset
does not copy an unfinished engine implementation onto main or deploy resources.

The authoritative design is [ARCHITECTURE.md](../../ARCHITECTURE.md). Earlier
Railway and operational details are retained in
[operational contracts](operational-contracts.md); superseded cloud CRUD rules in
that historical document do not override the engine architecture.
