# Google operator OAuth configuration import

The `google-oauth` operator capability imports an owner-selected confidential web
client through the existing spec, plan, confirmation and apply lifecycle. Google
[requires Console creation and configuration of standard OAuth clients](https://developers.google.com/identity/protocols/oauth2/resources/best-practices#manual-creation-and-configuration-of-oauth-clients).
This capability prepares the exact callback and reads a private configuration
reference; it does not use an IAP API or claim programmatic client creation.

This is the hosting operator's browser sign-in application. Customer cloud
installation, customer runtime identities and contributed customer secrets remain
separate. Customers do not import this operator configuration or need local cloud
credentials to use Connect Cloud.

## Declaration and review

For the already prepared operator application's environment, declare:

```json
{
  "operatorApplications": {
    "google": {
      "provider": "google-oauth",
      "profile": "hypercloud-connect-v1",
      "originService": "web",
      "runtimeService": "web",
      "nativeScope": {
        "projectId": "owner-selected-project",
        "credentialsRef": "file:/absolute/private/client_secret.json"
      },
      "outputs": {
        "client-secret": "CLOUD_CONNECT_GOOGLE_CLIENT_SECRET"
      }
    }
  }
}
```

The output key must have a separately declared native secret destination. Normal
planning first prepares the selected empty container, then reviews the public
client ID, selected Google project and exact callback. The callback is the fresh,
verified HTTPS hosting origin plus `/cloud-authorizations/gcp`, matching
Hypercloud's `lib/cloudAdminAuthorization.js` handler. The public client ID receipt
can be used in the separately reviewed `CLOUD_CONNECT_GOOGLE_CLIENT_ID` runtime
configuration. Import and native delivery require their own exact action
confirmations; sign-in, cloud authority and deployment remain separate.

The private reference uses the existing safe reference resolver. File references
must be absolute; inline JSON and arbitrary HTTP URLs are rejected. The imported
JSON must be a confidential `web` client, with the selected `project_id`, known
Google authorization/token endpoints and exactly the reviewed callback. Optional
JavaScript origins must be empty or the verified origin. Requiring a project ID,
one callback and no extra configuration fields is Hypervibe's isolation policy,
not a claim that Google's general client-secrets format requires those fields.
Both documented numeric client IDs and modern hyphenated IDs are supported, as
are the documented current and older Google token endpoints. The selected public
client identity and complete canonical configuration cannot change between review
and capture. A domain-separated commitment keyed by the existing local secret
store binds the canonical JSON and exact intent. Only the opaque commitment is
public; the private input and its unkeyed hash are never persisted in the plan.
The intent itself does not contain this action-level commitment. It can therefore
be recomputed after restart without circular hashing; JSON formatting alone does
not invalidate the review.

The owner keeps the original JSON private and outside source control, as
[Google's web-server guide requires](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred).
Hypervibe does not delete or encrypt that owner-supplied source file. It stores its
own recovery copy only in the existing encrypted local custody store, scoped to
the app, environment, installation and intent. No client secret is placed in a
public plan, journal, receipt or diagnostic. This import does not retain a Google
administrator refresh token or service-account key.

## Delivery, recovery and proof limits

The shared output driver delivers the secret directly to the reviewed native
destination and retains the immutable version reference. Its currently registered
operator output host is Cloud Run with Google Secret Manager. This is distinct
from Hypercloud's customer secret delivery drivers for AWS, Azure and GCP.

A lost local capture acknowledgement recovers the encrypted result without
rereading the JSON. A lost Secret Manager write acknowledgement leaves the
delivery uncertain and retains encrypted custody; another plan/apply never
blindly submits the value again. Successful delivery erases the managed private
copy only after durable output receipts exist. Existing cloud clients and stored
credentials are not overwritten or revoked by this create-only import path.

The receipt explicitly reports `configuration: imported-unverified` and
`browserExchange: unverified`. Owner-supplied JSON is not native ownership proof,
proof of administrator authority, or proof Google currently accepts the callback.
Completing the import does not claim that Hypercloud was deployed or a browser
authorization exchange succeeded. Those require separate release and live browser
evidence; this change does not manufacture or update that evidence.

## Regression evidence

The challenged assumption was that missing programmatic client creation required
passing the client secret through an agent, or that importing the JSON established
native authority. The documented private JSON format and Google's manual-client
requirement instead support a reviewed private import with explicit proof limits.
The initial registry/lifecycle tests failed before this capability existed (nine
observed failures). Additional observed RED cases demonstrated capture under the
wrong environment context, acceptance of changed private configuration under an
unchanged public client ID, and rejection of Google's numeric-only client-ID
example. The driver now rejects the wrong context or changed private input and
accepts the documented ID. Recomputed commitments survive SQLite restart.

Normal tests exercise the actual registry, encrypted SQLite custody and persisted
installation lifecycle. The application tests compose actual holding preparation,
PlanService/apply, empty-container setup, import and native delivery, restarting
SQLite between phases. Native transport responses and access tokens are synthetic;
the real provider serialization and delivery programs execute. Checks cover stale
public identity, missing confirmation, mismatched project/endpoints/callback,
unsafe references, local lost acknowledgements, uncertain native writes without
replay, durable immutable receipts and plaintext absence in the public journal
and database. These are offline contract checks, not live Google compatibility.

The committed `Hypervibe / acceptance` workflow runs `npm test` and typecheck; its
desired required-check configuration names the same check. These tests are in the
ordinary test discovery path. Repository files do not establish actual branch
protection. No native OAuth client creation, owner browser exchange or live
Secret Manager write was performed for this slice. Documentation source identities
and limitations are in
[`google-owner-import-source.json`](../test/provider-contracts/operator-applications/google-owner-import-source.json).
