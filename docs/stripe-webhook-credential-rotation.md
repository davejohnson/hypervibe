# Stripe webhook signing-secret rotation

An existing Stripe webhook keeps its endpoint ID, URL, subscriptions, account and
mode during signing-secret rotation. Hypervibe reads the exact endpoint and actual
account through the selected verified connection. It does not infer sandbox identity
from a test-key prefix or delete an endpoint because its hosting value drifted.

Stripe's [official rotation procedure](https://docs.stripe.com/webhooks#roll-endpoint-secrets)
uses Workbench's **Roll secret** operation, with optional overlap of up to 24 hours.
The public [endpoint update contract](https://docs.stripe.com/api/webhook_endpoints/update)
changes URL/events/status; it does not expose an in-place secret-roll operation.
The [endpoint secret field](https://docs.stripe.com/api/webhook_endpoints/object)
is returned only when creating an endpoint. A metadata GET therefore cannot
authenticate a supplied signing value.

Declare a delegated credential role using the same environment variable as the
existing `payments.stripe.webhooks.<name>` declaration:

```json
{
  "role": "stripe-events",
  "label": "Stripe event verification",
  "purpose": "Verify signed billing events",
  "kind": "stripe-webhook",
  "source": "dotenv:/absolute/project/.env.production#STRIPE_WEBHOOK_SECRET",
  "identity": {
    "accountId": "acct_expected",
    "mode": "test",
    "endpointId": "we_existing"
  },
  "stripeWebhook": {
    "environment": "production",
    "webhook": "billing"
  }
}
```

Use the exact sandbox account ID when a sandbox is intended. The named webhook
must already have a matching durable binding, and runtime consumers must refer
to its exact service and variable. Explicit CI aliases can share that role.

Open [Workbench webhooks](https://dashboard.stripe.com/webhooks), select the
reviewed account/sandbox, mode and endpoint, and roll with sufficient overlap.
Put the replacement into the declared private source. Then review and apply the
ordinary credential plan. The lifecycle rechecks endpoint identity before writes
and updates the existing Stripe binding only after all selected consumers are
synchronized. A retry retains that endpoint and the same frozen replacement.
The public API has no documented endpoint/account deep-link prefill contract, so
guidance presents exact selection fields alongside the supported management URL.

For an actual captured delivery, optionally add:

```json
{
  "delivery": {
    "payloadFile": "/absolute/private/stripe-raw-body.json",
    "signatureRef": "file:/absolute/private/stripe-signature-header"
  }
}
```

These fields belong inside `stripeWebhook`. The payload must contain the exact
raw received bytes; whitespace changes invalidate signatures. Verification uses
Stripe's documented HMAC-SHA256 construction, constant-time comparisons, multiple
`v1` signatures during overlap, and a five-minute timestamp tolerance. It checks
the event's mode and an included account identity. Files and signature contents
stay local; only the check's outcome is retained. Endpoint attribution for this
captured artifact is user supplied. A valid signature proves the selected key
validates that supplied delivery, not that the application processed its business
operation or that every serving instance uses the replacement.

An optional `userReportedPreviousSecretExpiresAt` records the operator's reported
overlap deadline separately from provider-confirmed expiry. Verify the exact new
deployments, drain old instances, and check application event processing before
revoking the old signing secret. Hypervibe never automatically ends the overlap.

Regression evidence is in `stripe-webhook-credential.contract.test.ts`. Eight
checks initially failed on the missing tracked-endpoint path and on the old
assumption that hosting signature drift authorizes endpoint replacement. The
counterexample is a valid existing endpoint with a different locally configured
value: deleting it loses identity and revokes delivery before consumer coverage.
The tests now exercise the real Stripe HTTP client, local SQLite/files, exact
account/mode/endpoint checks, signature verification, secret-safe output, binding
acceptance and stale replacement-plan refusal. Fixtures are synthetic observations
from the official contracts above, not live endpoint verification. These checks
remain in the normal `npm test` acceptance path.
