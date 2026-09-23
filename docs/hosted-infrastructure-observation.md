# Hosted infrastructure observation

`@hypervibe/hypervibe/hosted` exports `inspectHostedEnvironmentV1` and
`inspectCommittedBindingsV1`. Importing the subpath performs no local state,
network, credential-store or CLI work. Calling environment inspection performs
only bounded provider reads. It never constructs command context, stores plans,
invokes apply, adopts resources, or opens SQLite.

The trusted host owns tenancy, connection authorization, credential custody,
exact-revision repository reads, scheduling, report persistence and freshness
policy. The shared engine owns schema/source validation, scoped observation,
comparison and safe projection. The host must never accept connection scope
directly from a browser or treat repository binding content as provider access
authorization.

## Inputs

```ts
const report = await inspectHostedEnvironmentV1({
  schemaVersion: 1,
  source: verifiedSpecSource,
  environment: 'staging',
  bindings: verifiedBindingSource,
  connection: {
    provider: 'railway',
    scope: authorizedScope, // { projectId, environmentId }
    credentials: decryptedConnection, // { projectToken } or { apiToken, workspaceId?, teamId? }
  },
  limits: { maxRequests: 80, maxResources: 100, timeoutMs: 10000 },
}, { signal: requestSignal, now: () => new Date() });
```

Both source inputs use `CommittedSpecInspectionInputV1`: schemaVersion,
provider, verified repository `{id,path,remoteIdentity}`, exact full revision,
`Uint8Array` content and its SHA-256. Bindings content comes from
`.hypervibe/bindings.json`; spec content comes from `.hypervibe/spec.json`.
Repository identity, revision and project name must agree. Missing binding bytes
produce unknown coverage and no provider calls. Invalid or mismatched source
fails validation instead of silently using older local state.

`inspectCommittedBindingsV1` validates the shared repository binding envelope
in memory and projects only provider/project/environment/service identities.
It discards other binding values. Its receipt includes exact source provenance
and `environments[name].services[logicalName].serviceId`. It does not verify
live existence or authorize access. Environment observation consumes the source
bytes itself, so callers need not persist a second parsed binding record.

## Report semantics

Each resource contains stable identity, desired/current existence, a status,
and the fields actually compared. `matching` means those managed fields agree;
it does not claim the whole environment is converged. `missing` requires a
complete exact-scope inventory. Missing ownership bindings, ambiguous identity,
failed reads and exhausted budgets remain `unknown`. A bound service removed
from desired state remains visible as drift while it still exists. Unbound
provider services are inventory (`unmanaged`), never silently adopted.

The first capability compares Railway service presence, start/release commands,
health-check path, cron schedule, declared public exposure, and declared
non-secret environment variables and explicitly retired variable presence using
the existing pure diff engine. Command,
path, schedule and variable values are replaced with `configured` / `not
configured` markers. Booleans may be shown directly. Different hidden values
can therefore both show `configured` while field status is `drifted`.
Credential values, variable values/hashes, provider warnings and executable
action metadata never enter the report.

Database/cache/storage declarations, domains, email and other infrastructure
slices remain explicit unsupported rows. Observed datastore inventory is not
promoted to configuration equivalence. Workload-kind distinctions, managed
secret values, provider runtime version, deploy source, exact release revision,
and application health are outside this first comparison scope. In particular,
the adapter may reconstruct source branches from bindings; this report never
calls that fresh provider evidence. Region, runtime/build configuration, deploy
policy, active local env-file and migration policies, volume, timezone and
database-alias declarations expose unsupported field coverage when applicable.

`attemptedAt` and `completedAt` use the host clock. `observedAt` is the time an
exact-scope observation completed successfully; it stays null when no usable
observation succeeded. Partial evidence can have an observation time while
individual resources remain unknown. The host chooses when a retained report
becomes stale; a recent timestamp alone never establishes matching state.

Limits apply before comparison and per-resource reads. The initial Railway
resource budget conservatively includes project service/bucket/plugin inventory,
including adjacent environments, because the shared adapter reads that inventory
to determine membership. Over-budget inventory is unknown; details never fall
back to another environment. The response body has a 2 MiB cap; timeout and
cancellation remain effective while streaming it. The public wrapper caps
maxRequests/maxResources at 200 and timeoutMs at 30 seconds. Reports cap variable
fields (configured and retired combined) per service at 100 and explicitly mark
excess coverage unknown. Output
omissions are counted; omitted scope cannot make coverage complete.

## Evidence and verification

The Railway HTTP fixture executes real `graphql-request` serialization against
the pinned [official Railway CLI schema](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/gql/schema.json).
Project tokens use the documented
[`Project-Access-Token` authentication](https://docs.railway.com/integrations/api);
their `projectToken` query must identify the exact trusted project/environment.
Account tokens verify those same identities through exact project/environment
queries. The transport rejects all mutations and cross-origin redirects.

Regression counterexamples include a stale environment ID with a same-named
replacement, a removed but still live bound service, failed variable reads,
and an upstream inventory label echoing a credential. The tests assert unknown
scope or the precise desired/current difference, zero mutations, and value-free
output. They also cover project-token reads, request/resource/body limits and
streaming timeout/cancellation. These tests run in ordinary `npm test`, which
the committed acceptance workflow executes. They are synthetic offline contract
evidence, not live credential/permission compatibility or branch-protection
verification.

CLI/MCP keep their existing `hv_status` workflow. Hosted inspection is a library
interface with explicit trusted inputs, rather than a new command requiring a
local checkout or database. The hosted web/API/chat consumer can share this one
report without implementing another provider engine.
