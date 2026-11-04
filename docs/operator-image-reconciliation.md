# Recovering an acknowledged existing image update

On 2026-11-04 the test host's ordinary Cloud Run web update timed out locally.
Independent native reads subsequently showed the same web UID Ready on the
approved image and the exact migration execution succeeded. The worker remained
on its previous image. The failed deployment retained the previous web image in
local bindings; it did not retain the ordinary update's operation or execution
identity. This is distinct from the durable first-release protocol.

Two assumptions failed at real boundaries. First, a selected immutable-image
update could need no prepared-binding reconciliation. The supported filtered
plan instead discovered the changed native image and rejected its own service
filter. Removing the filter reached an earlier operator-artifact verification
failure; its precise native cause was not established. Second, the image selector
could be compared as an ordinary environment variable. Cloud Run deliberately
does not inject `IMAGE_URI` into the container, so even the acknowledged image
was repeatedly planned as an update.

The existing isolated binding step now accepts the already verified operator
image selection only when its entire binding change is the selected services'
image URIs, each matching the approved immutable image. Existing IDs and UIDs,
all other bindings, and an empty pending-first-release set are required. General
service filters and runtime inputs remain forbidden. Applying that explicit
metadata action reobserves the exact proof and uses the existing complete-map
compare-and-swap; it does not deploy, rerun migrations or rewrite the failed run.
The subsequent plan must use the native image observation to skip the completed
web update and authorize only the remaining worker update.

The normal acceptance tests retain both observed regressions. The application
test uses actual commands, publication journals and SQLite with a reconstructed
provider-port proof. The local prepared-release test additionally executes the
actual Cloud Run adapter and private publisher against serialized synthetic
Google responses: a successful web update loses its acknowledgment, metadata
reconciliation sends zero provider mutations, and the final worker-only apply
must leave web and migration counters unchanged. The adapter image tests cover
the native image/selector interpretation independently. Synthetic transport is
not proof of a new live deployment or general uncertain-update recovery.

This repair does not create a general ordinary-update recovery journal. A new
plan still stops on unknown native state, different lifetime, unapproved image,
other binding changes, or unfinished first releases. The historical failed run
remains failed. Live recovery requires a separately verified package, supported
local schema migration when applicable, the exact metadata plan and a fresh
worker-only plan; no test or source change authorizes another provider write.
