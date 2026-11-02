# Isolated operator CAPTCHA

The operator host can prepare a dedicated Google reCAPTCHA SCORE key for its
freshly verified HTTPS origin through `operatorApplications`. This is operator
bootstrap, not a requirement for a new customer or contributor to have local
credentials. The provider is `google-recaptcha`, the fixed profile remains
`hypercloud-connect-v1`, and its native selectors are `projectId` and
`projectNumber`. They must match the verified runtime identity. The caller cannot
override the origin with a URL.

Three separate confirmed native-stage actions enable only the CAPTCHA API,
allocate a new key, and privately retrieve its legacy credential. They use the
existing shared installation journal and transient local Google authorization.
The API action may cause Google to create service identities; it does not grant
application runtime access. The provider checks actual project identity and
permissions separately from obtaining an access token.

The key allows only the verified origin hostname (and Google's documented
subdomain inheritance). It uses SCORE with domain checking enabled, AMP disabled,
and no testing-score override. Existing production keys and their allowed domains
are preserved, including a pre-existing key with the same display name. Browser
acceptance is still required; successful allocation is not proof that a user can
complete a form.

## Native identity and recovery

Google's CreateKey request has a parent and Key body. It documents no request ID
or caller-selected key-ID field. The client submits no `name`; Google assigns a
new identity. Persist the attempt before dispatch, then retain the exact native
name, project scope, creation time, origin and installation/attempt labels.
Display names alone never establish ownership. A complete bounded inventory can
recover one exactly correlated key after a lost acknowledgement; no match,
duplicates, permission errors, changed settings or partial pagination cannot
authorize another POST. Accepted native IDs take precedence over inventory names.
An external administrator can still change a key between reads.

The shared journal serializes attempts and exact confirmation. Definite rejection
requires a new retry review. Unknown writes remain pending until independent
read-only evidence resolves them. Recovery never retrieves the private credential.
Private capture is a separately approved, retrievable read of the exact accepted
key, immediately stored with compare-and-swap in encrypted custody. If persistence
acknowledgement is lost after commit, custody readback recovers it without fetching
again. Failures before custody commit do not authorize an unreviewed retrieval.

Native secret delivery remains a separate shared action and must bind the
declared output role `secret-key` to its exact reviewed secret-manager destination.
Declare `outputs: { "secret-key": "RECAPTCHA_V3_SECRET_KEY" }` together with that
environment's delegated secret slot and native destination. The ordinary planner
prepares its empty container first. Registration remains incomplete until the
separately confirmed delivery has an immutable reference; native capture alone
cannot produce a delivered receipt.
The public site-key ID can appear in a receipt; the legacy secret cannot. Hypervibe
temporarily decrypts it only for its reviewed delivery. Do not use an operator
management token in application runtime.

## Scope, cost and evidence

The dedicated key avoids adding Google base-domain verification, public DNS and
a Cloud Run Preview domain mapping solely for a disposable test origin. It does
not alter a production CAPTCHA key or disable CAPTCHA. Google recommends separate
production and staging keys. Every created web key has a legacy secret compatible
with an existing `api.js`/`SiteVerify` integration; new integrations should follow
Google's CreateAssessment recommendation.

Assessments are metered. The first 10,000 monthly assessments share the
organization's allowance, then 10,001–100,000 is US$8 per month and additional
assessments cost US$1 per 1,000. This is not a hard spend cap. Key creation itself
does not establish unused free allowance or authorize a live browser walkthrough.

The challenged assumption was that existing CAPTCHA configuration or a manual
console task could complete an isolated operator host. Actual read-only evidence
showed the existing key excluded the verified `run.app` host, Google had not
authorized the custom base domain for the current identity, and the test project
had the needed IAM permissions but its CAPTCHA API was disabled. The initial
actual SpecStore test failed because `google-recaptcha` was not admitted. A second
RED through the installation kernel rejected the explicit API prerequisite.
The declaration and scope action now pass in the ordinary application boundary.
Additional observed RED/GREEN cases removed an undocumented alphabet restriction
from the opaque legacy-secret string and rejected execution without exact private
custody context before reading local credentials. A further RED/GREEN case blocks
a delivered claim when only native capture completed and no immutable reference
exists.

Reconstructed serialized native responses exercise strict key configuration,
ProtoJSON omitted false defaults, existing-key preservation, denied reads,
partial inventory, lost acknowledgements, no replay, changed identities and
private error handling. Actual SQLite tests cover the application plan/apply/status
boundary, empty-container prerequisite, private native delivery, reference readback
and erasure after delivery. These are documentation-based contract
checks, not a full provider schema validator or successful native creation,
delivery, browser scoring, or cleanup evidence. All tests run under ordinary
`npm test`; committed acceptance runs that command and typecheck and desired
required checks name `Hypervibe / acceptance`. Live branch enforcement is not
proven by repository files.

Official contracts are recorded in
[`operator-applications/source.json`](../test/provider-contracts/operator-applications/source.json).
