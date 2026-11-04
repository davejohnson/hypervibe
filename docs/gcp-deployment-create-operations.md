# Google deployment creation acknowledgments

The challenged assumption was that an accepted registry or Cloud Run service
creation would be visible in the immediately following resource GET. Both APIs
return a long-running Operation, not a guarantee of immediate resource visibility:

- [Artifact Registry create](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories/create)
  and [operation GET](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.operations/get).
- [Cloud Run service create](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/create)
  and [operation GET](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.operations/get).

The operation paths are respectively `artifactregistry.googleapis.com/v1/` and
`run.googleapis.com/v2/`, followed by the returned
`projects/{project}/locations/{location}/operations/{operation}` name. Reads use
GET with an empty body. The original project/location is required; no URL or
credential from an arbitrary response becomes authority.

## Independent observation and regression

On 2026-11-04 an actual hosted deployment attempt was recorded uncertain at
05:53:16.571Z. A later authenticated, read-only repository GET confirmed the exact
original owner, installation and attempt marker, with native creation time
05:53:16.909797Z. The earlier roles/accounts had completed; subsequent workloads
and grants had not started. The original POST response was not retained, so its
particular Operation body and intermediate resource response remain unknown.
This observation supports the delayed-visibility counterexample, without
claiming an unobserved native response.

Two reconstructed serialized transport/real SQLite regressions failed before
the runtime change: an unfinished Operation followed by resource GET404 lost its
acknowledgment and became uncertain. They now retain that operation before any
poll, close/reopen SQLite, and recover without repeating creation. Additional
cases cover a lost creation response, finite polling, wrong operation or target,
malformed/contradictory results, changed native lifetime, denied/missing operation,
terminal error, and historical full proof after operation expiry. The existing
deployment provider suite remains in ordinary `npm test`.

## Behavior and limits

Only registry and service creation change. Their acknowledgment is saved by the
existing installation kernel before recovery. Recovery reads the exact operation
with 250ms, 500ms, 1s, then 2s capped backoff until completion or the
existing caller deadline. The hosted installation kernel currently allows 15
seconds per authorized action; the provider also retains its 30-second maximum.
No deadline or request authority is extended. Pending/unknown results retain evidence and stop dependent work. No
automatic create retry is introduced. Exact terminal resource proof still needs
fresh ownership, lifetime and configuration observation. A retained full result
survives expiry of the historical operation. A lost acknowledgment keeps the
existing exact owner/attempt resource-read recovery; absence is never permission
to repeat an uncertain creation.

No shared provider contract, IAM grant or confirmation scope changes. AWS retains
its reviewed CloudFormation handoff/stack observation, and Azure retains its own
operation and native-resource checks. Neither is routed through the Google
operation parser. These offline regressions do not establish live compatibility
of the new package or complete the customer's remaining installation actions.

The optional persisted `native.operationName` is an added evidence field. Older
strict hosted readers reject new records containing it. Upgrade the hosted
reader/writer together; this change does not claim rollback compatibility with
an older package after new operation evidence has been recorded. Exact `.` and
`..` final path segments are rejected before URL normalization or a native GET;
serialized regressions first demonstrated both escapes.

The follow-up waiting regression first failed for an operation completing after
five seconds and for one still unfinished at the deadline. Fake clocks exercise
the actual serialized driver, not a substituted polling implementation. SQLite
restart tests use the existing one-second test action deadline and retain the
acknowledgment before read-only recovery. A slower real Cloud Run operation can
still return pending; automatic browser observation is not added by this change.
