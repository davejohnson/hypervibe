# Completed operator application retirement

Explicit `operatorApplications.<name>.retirement` now reaches the existing
`hv_spec → hv_plan → hv_apply` path for Microsoft Entra, SendGrid and reCAPTCHA.
The registration and its encrypted output custody remain historical. Omission
still deletes nothing. Unsupported browser registration/artifact providers fail
before setup instead of pretending deletion is available.

The prior assumption was that a completed application's setup stage could serve
as cleanup: it only re-observed or prepared the registration and required the
original running origin/output containers. The real command/SQLite/serialized
Graph regression failed before runtime edits. It now retires the exact FIC,
then application, without calling the setup factory or changing the predecessor.
Each DELETE is an ordinary confirmed action with the existing write-ahead
attempt, dependency and CAS rules. Retained uncertain writes recover by reads;
definite rejection uses the existing explicit retry review. Terminal retirement
cannot satisfy provisioning readiness or select an older ready ancestor.

The shared selection verifies the exact original saved spec/declaration, native
scope, source repository, same-journal ancestry and completion-evidence digest.
That prevents changing service selectors to bypass cleanup. This initial path
requires the host's desired/current workload bindings, runtime identities and
storage-reader grants to be removed: shared operator outputs can be used by more
than the named origin service. Previous hosting, unfinished prepared releases,
backup executions and pending backup identity work block retirement. It does not
implicitly destroy any of them. Completed historical release/backup receipts
remain. Multiple declarations progress beyond each completed retirement; an
all-completed review produces mutation-free terminal actions and never setup.

## Microsoft Entra boundary

The application object ID, client ID, creation lifetime and ownership/attempt tags
come from validated original setup receipts. The owned FIC ID, issuer, subject,
audience and description must match. Current directory owner IDs are read with
complete bounded pagination, shown in the review and required to stay unchanged.
No assumption is made that Graph-created apps have zero owners; owner directory
objects are never deleted. Extra credentials, API permissions, FICs or incomplete
inventories block this narrow path.

Official [Graph application deletion](https://learn.microsoft.com/en-us/graph/api/application-delete?view=graph-rest-1.0)
and [FIC deletion](https://learn.microsoft.com/en-us/graph/api/federatedidentitycredential-delete?view=graph-rest-1.0)
use exact object IDs, no request body and HTTP 204. Neither reviewed method offers
an ETag delete precondition. The review states that an external concurrent edit
can race the final fresh read; tests do not claim atomic exclusion.

Application deletion can also delete a home-tenant service principal. Microsoft
[documents](https://learn.microsoft.com/en-us/entra/identity-platform/app-objects-and-service-principals)
that Graph application creation does not itself create that principal. This
initial path therefore inventories exact-appId principals and blocks when one
exists without a separately accepted cleanup lifecycle. It does not instruct the
user to delete it manually. Foreign-tenant principals remain a separate cleanup
gap and are not claimed absent or removed.

An active application 404 is insufficient. The exact
[deleted object](https://learn.microsoft.com/en-us/graph/api/directory-deleteditems-get?view=graph-rest-1.0)
must still match ID/client ID/creation lifetime/tags; its native `deletedDateTime`
is retained with the documented normal 30-day recovery window. No exact
`retentionUntil`, permanent purge or tenant/subscription deletion is inferred.
If both active and deleted observations are absent/unknown, the operation stays
unresolved. Prior completed retirement remains immutable after retention expires.

## Verification and remaining work

Normal CI includes real command/SQLite/Graph cases for lost responses, denied
post-ack reads, definite rejection/review, changed owners/lifetime/credentials,
foreign trust, unavailable authority, token echoes, original setup readiness
expiry, retained consumers and repeated terminal inspection. Review regressions
observed RED before correcting multi-declaration starvation and an unreviewed
service-principal cascade; four additional consumer cases also observed RED
before expanding the shared consumer guard. Existing setup paths are included in
adjacent checks. Two final actual-command counterexamples also failed before
correction: restoring an older unaccepted disposition while another retirement
was uncertain, and a denied provider read misleadingly blamed on consumers.
Planning now keeps the accepted successor authoritative before any provider read,
and returns only closed provider reasons with read/reauthorization guidance.
The repository's independent accepted-lineage CAS guard remains unchanged.
SendGrid and reCAPTCHA also execute the registered command loop
against their independently reconstructed official transports.

These are offline contract and application-boundary results, not evidence that
native cleanup ran. Browser-only Google/GitHub registration retirement, artifact
and parent-scope retirement, output secret-container/version deletion, Entra
service-principal cleanup and hosted test-data retirement remain unfinished.
The shared email account/sender, tenant/subscription, repositories and unrelated
keys are preserved. Output-secret destruction and local credential-custody
retention require their own explicit lifecycle and review.
