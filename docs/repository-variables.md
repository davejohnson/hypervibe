# Selected repository configuration variables

`devops.ci.repositoryVariables` manages ordinary non-secret repository flags on
an existing, externally managed GitHub.com repository. It uses the shared
`hv_spec` → `hv_plan` → `hv_apply` workflow in both MCP and CLI. It does not
require Hypervibe to own templates, branches, workflows, repository settings,
deployment secrets or hosting resources.

```json
{
  "version": 1,
  "project": "review-policy",
  "gitRemoteUrl": "https://github.com/OWNER/REPOSITORY.git",
  "devops": {
    "code": {
      "provider": "github",
      "scope": "OWNER/REPOSITORY",
      "repository": { "state": "present", "management": "external" }
    },
    "ci": {
      "provider": "github-actions",
      "repositoryVariables": {
        "PROJECT_HEALTH_ENABLED": { "value": "true", "adoptExisting": false }
      }
    },
    "canonicalEnvironment": "repository"
  },
  "environments": {}
}
```

Use a verified GitHub connection scoped to the selected repository. The native
repository Variables permission is read for observation and read/write for
creation or update; repository metadata must also be readable. These operations
do not need Actions workflow dispatch, workflow-file write, environment write or
repository administration permissions. An existing broader connection does not
authorize any additional operation in this plan. GitLab CI is explicitly
unsupported by this facet because its project variables have separate scope,
type, masking and protection semantics.

Run `hv_plan project="review-policy" env="repository"` and inspect its exact
variable actions before applying that persisted plan. Names are case-insensitive
on GitHub; canonical collisions are rejected. Nonempty values are limited to
48 KiB each. These are plain configuration strings stored in the spec, so keys
and credentials must use a secret workflow instead. Command results, plans,
receipts, ownership records and inspection expose hashes rather than values.

An existing variable requires `adoptExisting: true`, even if it already equals
the desired value. Adoption records local ownership with zero provider writes.
When the value differs, run another plan after adoption to review its update.
After creation/adoption, an unchanged value produces a noop. Removing a variable
from the map, emptying the map, or omitting the map preserves both provider values
and accepted local ownership. There is no implicit deletion or rename.

This initial ownership journal admits at most 500 distinct names, including
previously managed names omitted from the current spec. Reaching that bound
blocks new ownership before a write; it never discards an accepted identity.

The canonical environment owns this isolated configuration stage. Pending writes
must converge there before further configuration changes. Ownership and the
write journal are local state, excluded from `.hypervibe/bindings.json` and
rejected on import. Another workspace must explicitly adopt its existing values;
copying a repository binding file cannot acquire that authority.

## Identity, readback and recovery

The plan binds the numeric repository ID, GitHub instance and canonical scope,
variable name, desired hash, observed previous hash and timestamps, local
ownership, and spec revision. Apply observes those identities and the complete
bounded variable inventory again. Denied, malformed or incomplete reads remain
unknown; they never prove absence. Each write rechecks numeric identity through
the provider adapter, and acceptance requires exact post-write readback.

The local journal is persisted before a provider write. If its response or
readback is uncertain, a subsequent plan contains only a readback reconciliation
of that exact intent. It does not issue another write. This remains true when the
desired value changes or its declaration is omitted. Once the retained value is
observed and accepted, a new plan may review the newly desired value. Unknown or
conflicting readback remains pending; do not clear bindings or bypass recovery
with direct provider commands. A failed local acceptance also retains the
journal so it can recover without repeating the write.

A documented client rejection or a local preflight failure before dispatch
proves that this request did not mutate the provider. It releases only the
pending attempt, preserving prior ownership. Resolve the connection or input
problem and review a new plan; an explicit retry of a still-current earlier plan
also retains its original stale-state checks. No automatic write retry is added.
Transport failures, server errors and unexpected acknowledgements remain uncertain.

GitHub documents no atomic compare-and-swap for this endpoint. Pre-write stale
checks and readback cannot exclude an administrator racing between them. The
bounded inventory is not an atomic snapshot, and repository values do not prove
organization/environment precedence or workflow variable availability.

For independent read-only verification use
`hv_inspect provider="github" project="review-policy" resource="repository-variable" name="PROJECT_HEALTH_ENABLED"`.
Omit `name` for a bounded list. Inspection exposes presence, canonical name,
repository ID, hashes and timestamps. It cannot adopt a variable or change
configuration. Neither apply nor inspection dispatches workflows or attests a
daily review, publication, backup, rotation or deployed runtime state. Verify the
appropriate scheduled execution and its evidence separately.

## Verification evidence

The official pinned provider contract and named GitHub/GitLab comparison are in
[the contract fixture](../test/provider-contracts/github/repository-variables/README.md).
The existing client assumed a successful create returned JSON; its real request
serializer failed on the documented empty 201 response before the narrow fix.
The persisted lifecycle failed because the strict spec rejected this declaration.
Shared-command tests separately reproduced missing inspection and unredacted
configuration values before adding those boundaries.

Independent lifecycle regressions also reproduced a pending-write bypass: a
changed spec could authorize a managed repository create, and an older persisted
create plan could dispatch it while a variable write remained uncertain. Shared
early guards now stop unrelated planning and apply before either mutation path.

The same guard precedes the cloud and operator stages at the shared apply entry.
An integration regression reproduced a saved operator-registration action reaching
its mutation handler while a repository-variable write was still pending (RED).
Moving the retained guard ahead of those early returns blocks dispatch and keeps
the ownership journal unchanged (GREEN). This exercises the actual saved-plan
loader, executor and SQLite with a synthetic operator handler, not a native write.

Normal `npm test` executes the real request serializer against independently
pinned schemas and synthetic HTTP fixtures, and exercises SpecStore, PlanService,
ConvergeExecutor, encrypted connection selection, SQLite journals and shared
command responses. The checked-in acceptance workflow and declared required
check both run `npm test` and `npm run typecheck`. These offline tests do not
establish live GitHub permissions, live branch protection, successful activation
or scheduled execution. No provider write or release was performed to implement
this capability.
