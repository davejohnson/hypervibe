# Cloud Run native cron maintenance evidence

The source files in `maintenance/` are complete official Google API definitions
at the immutable revision recorded in `maintenance/source.json`. They establish
the scheduler pause/resume wire endpoints, independent Cloud Run execution
completion timestamp, execution identity, pagination, and protobuf scalar/repeated
field defaults. Tests reconstruct HTTP responses from those contracts; they do
not compile the protobuf files into a response validator or fetch upstream at
test time.

The assumption challenged was that a paused Cloud Scheduler job proves its
Cloud Run executions have stopped. A paused scheduler with an unfinished native
execution is the counterexample. The old adapter reported suspension immediately
on observation/retry and sent cancellation requests during the initial pause.
The transport regression failed before the fix. The adapter now pauses future
triggers, waits for unfinished executions to complete, and returns an incomplete
result on its bounded deadline. It leaves the trigger paused and retains the
snapshot for retry; it never cancels active executions as part of this drain.

Every observation reads a fresh, bounded, paginated inventory. Missing
`completionTime`, reconciliation in progress, or positive running task counts
prevent suspension. Missing false/zero scalar values and omitted empty repeated
fields follow protobuf defaults. Invalid collections, foreign or missing
execution names, duplicate identities, failed reads and malformed/repeated page
tokens remain unknown. Completion need not mean task success; a failed or
cancelled execution that has finished is no longer doing work.

The saved native scheduler identity, job identity, schedule, time zone and HTTP
target must still match before pause/resume and on convergence reads. The
adapter admits only explicit native bindings whose scheduler targets that exact
Cloud Run job. A missing binding, guessed scheduler name, changed target or
changed schedule blocks the action. Resume reenables the saved schedule; it does
not explicitly launch another execution.

`cloudrun.maintenance.api-contract.test.ts` exercises the real adapter and HTTP
serialization with transport-only fixtures. It is discovered by ordinary
`npm test`; the committed acceptance workflow and desired acceptance commands
run that suite. Live branch-protection settings were not inspected.

No live provider pause, permission, execution completion or resume is certified.
This observes native executions; it cannot drain application timers or jobs
inside persistent workers, prove application-level DB work committed, or prevent
other callers from manually starting a job. Additional schedulers/triggers are
outside this exact bound trigger contract. Railway's separate native cron
effective schedule and delayed run visibility remain unverified for graceful
drain; this change does not extend Railway semantics.
