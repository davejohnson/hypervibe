# Database checkpoints

A checkpoint requests one provider snapshot before other infrastructure changes.
The Railway adapter implements this capability and is ready for live validation.
It does not require a public database URL or execute SQL against the database.

Declare a named intent on the existing database, preserving its other settings:

```json
{
  "database": {
    "provider": "railway",
    "engine": "postgres",
    "resilience": {
      "checkpoint": { "id": "pre-beta-20260930" }
    }
  }
}
```

Use the ordinary `hv_spec`, `hv_plan`, and `hv_apply` lifecycle. Review the plan's
exact source and confirm its checkpoint action id. The outstanding checkpoint
is its own plan stage, before unrelated provider or deployment changes. Finishing
this stage does not mark other desired-state changes as applied; plan again to
review the remaining work.

Apply first records an operation identity in durable state, then starts exactly
one snapshot. A pending result means the provider has not yet supplied complete
evidence. Replanning and applying the same intent observes the recorded operation;
it never retries an uncertain create. A lost acknowledgement or unknown workflow
requires investigation of the retained operation record, not a new automatic
attempt. Do not discard these bindings or change the intent id to bypass an
uncertain result.

A completed receipt includes the exact database, volume and volume-instance
scope, backup identity, creation time and expiry. It means the provider reported
completion and Hypervibe observed the matching new backup. It explicitly does
**not** mean that a restore has been tested. Keep the exported bindings with the
infrastructure handoff so another checkout retains the same operation evidence.

The same completed intent is a no-op while that exact backup remains available
and unexpired. To request another backup, review a new intent id. Removing the
intent does not delete a backup or reduce retention. No checkpoint action
restores a database, changes its image, enables PITR, exposes an endpoint, or
updates its workload configuration.

Railway bills native snapshots for their incremental storage. Its native restore
stages a replacement volume on the source service; it must not be used to test
recovery against a live database. Native backups are restricted to the same
project and environment, and wiping a volume removes its backups. They do not
provide an independent off-provider copy. See Railway's [backup documentation](https://docs.railway.com/volumes/backups).

The offline contract suite exercises the real GraphQL client against Railway's
pinned official schema with synthetic responses. It covers exact scope, nullable
provider fields, lost acknowledgements, terminal status, and mutation boundaries.
Live permissions, successful snapshot creation and restore usability require
separate provider evidence; passing this suite does not establish them.
