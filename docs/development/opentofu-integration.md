# GCP OpenTofu integration boundary

This is the GCP implementation boundary. The [common cloud user journey](user-journey.md)
defines the shared product target and acceptance for GCP, AWS and Azure; this
reference does not claim that its GCP routing is implemented on the other clouds.

GCP has one infrastructure path. `hosting.provider: "cloudrun"` selects the
managed OpenTofu engine automatically. An explicit `hosting.engine: "opentofu"`
remains readable, but is not an opt-in switch. Unsupported capabilities stop with
an explicit blocker; they never select the removed handwritten lifecycle.

## Ownership

- Environment state owns the app's Cloud Run, database, cache, storage, queue,
  domain-mapping and secret-container resources.
- Project-shared state owns setup prerequisites: project/billing, APIs,
  service accounts, IAM, private build storage, image repositories and CI trust.
  Named contributions retain previously approved setup when another environment
  adds access. One environment's teardown cannot remove shared resources.
- Hypervibe owns sign-in, short-lived tokens and credential values, image builds
  and releases, logs, health, SQL and object transfers. These operations verify
  existing infrastructure; they cannot create missing prerequisites.
- Existing Railway lifecycle remains available.

## Authorization and routing

`hv_spec` validates the selected engine's actual capabilities. Default `hv_plan`
uses that engine; `hv_apply` applies the exact reviewed artifact. Launch combines
these shared steps and preserves their approval and result-stage boundaries.
Old GCP lifecycle plans are rejected; no provider maturity flag restores them.

Setup discovery is read-only. Choosing billing selects who pays. The following
preview contains exact infrastructure and permission changes; confirmation
applies that saved plan without silently planning again. Changed intent, provider
versions, engine state, or dependencies require a new preview.

Unknown reads, identity collisions and missing ownership evidence block. An
existing same-named resource is not permission to adopt or recreate it. Preserve
established data, credentials and state when reporting these blockers.

## Verification

Keep command routing, setup approval, helper mutation-freedom and generated
configuration checks in normal acceptance. Run configuration against the pinned
engine/provider. Installed CLI/MCP reachability and a live app remain separate
verification steps; report which were completed. Historical live results do not
prove a later revision.

See [architecture](../../ARCHITECTURE.md) and
[engine implementation and evidence](../opentofu-engine.md).
