# SendGrid delivery-event signing

Declare signing on the existing delivery-event target:

```json
{
  "email": {
    "enabled": true,
    "deliveryEvents": {
      "service": "api",
      "path": "/webhooks/sendgrid/events",
      "events": ["delivered", "bounce"],
      "signatureVerification": true
    }
  }
}
```

Use `hv_spec`, `hv_plan`, and `hv_apply` through either MCP or CLI. Hypervibe
first converges the delivery endpoint. A fresh plan then offers an exact,
confirmation-required signing action. After provider read-back verifies signing,
re-plan to review publication of `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` to the
receiving service. Hypervibe obtains this public verification key itself; do not
paste it into chat or put it in ordinary env configuration. Plans and receipts
contain identity and hashes, never key values. The provider keeps the private key.

`signatureVerification: false` explicitly disables signing, which deletes the
provider key pair. This also requires confirmation. A fresh plan can then remove
only the runtime key proven owned by this binding. Omission leaves previously
unmanaged signing alone; remove managed intent only after applying false and
completing key cleanup. Changing the receiving service or its hosting identity
while managed signing is active blocks until the old binding is cleaned up.

A durable endpoint ID wins over URL discovery. Without one, exactly one matching
URL is required; unknown, incomplete, or duplicate observations block. Each
mutation rechecks identity and desired state. A lost receipt does not justify
another signing toggle: re-plan and reconcile the observed result. Key writes
also re-observe hosting before committing ownership. Noop actions make no writes.

Plan/status readiness distinguishes provider signing and runtime key wiring.
Disabled signing, missing keys, changed keys, and masked/unknown reads remain
visible. `configured` means provider settings and hosting configuration were
observed; it does not prove an application deployment has consumed the key or
that the application validates signatures. Hosting rollout evidence is retained
for the existing lifecycle.

The app must verify SendGrid's signature over the original request bytes and
apply suitable timestamp/replay handling before trusting an event. Hypervibe does
not install application middleware or send test events. Inbound Parse has a
separate security-policy API; its [limited declarative support](sendgrid-inbound-signing.md)
adopts an already attached signed policy and reconciles its receiving-service
public key, while policy creation and removal remain blocked. The existing
restriction of one declarative delivery-event target per project remains.

## Connection access

Reuse the verified SendGrid connection for this project. If access is missing,
use a **SendGrid API key** created in [API Keys](https://app.sendgrid.com/settings/api_keys)
for the account owning the endpoint. The documented event-settings permissions
are `user.webhooks.event.settings.read` and `user.webhooks.event.settings.update`;
keep the other permissions needed by your declared email features, including
`mail.send` for sending. See [SendGrid’s permission list](https://www.twilio.com/docs/sendgrid/api-reference/api-key-permissions).
These scopes are account permissions, not endpoint-specific grants. Hypervibe
restricts its writes to the reviewed endpoint; a project-scoped connection does
not narrow the provider credential itself. EU regional subuser endpoints are
not implemented by the existing adapter’s global API base URL.

With the key already exported locally, connect without putting it in chat:

```text
hv_connections provider="sendgrid" scope="OWNER/REPOSITORY" credentialsRef="env:SENDGRID_API_KEY"
```

No documented pre-filled API-key creation template is used. Read/permission
failures remain unknown, and write failures require re-observation before retry.

## Evidence and regression coverage

Official contracts consulted 2026-09-24:

- [Get an Event Webhook](https://www.twilio.com/docs/sendgrid/api-reference/webhooks/get-an-event-webhook): omitting the ID selects the oldest webhook; public-key presence describes enabled signing.
- [Get All Event Webhooks](https://www.twilio.com/docs/sendgrid/api-reference/webhooks/get-all-event-webhooks): a `webhooks` array contains endpoint IDs and URLs; this operation documents no pagination parameters.
- [Toggle signing](https://www.twilio.com/docs/sendgrid/api-reference/webhooks/toggle-signature-verification-for-an-event-webhook): exact-ID PATCH with an `enabled` boolean; disabling returns an empty public key.
- [Event webhook security](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features): ECDSA verification and key-pair deletion when signing is disabled.
- [Inbound Parse security](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks): separate policies, not interchangeable delivery-event settings.

Tests reconstruct documented HTTP shapes at the real SendGrid client's fetch
boundary. Response fields documented as optional are not silently assumed:
missing signing key means disabled on an otherwise identifiable settings response;
missing operational identity/URL/enabled evidence remains unknown. Malformed keys,
wrong IDs, null keys, HTTP errors, and duplicate candidates are negative cases.
The exact operations and their referenced schemas are pinned from official
`twilio/sendgrid-oai` revision `fb95a935c87b79f7f982ac34bd37adab1f697dbc` in
`test/provider-contracts/sendgrid`, with source and extracted-content hashes.
Transport tests validate selected payload shapes, requiredness, types and
references offline. Formats and cryptographic validity are separate semantic
checks. The fixtures are reconstructed/synthetic, not recordings or evidence of
live account compatibility.

The challenged assumptions were that a default settings read identifies the
intended webhook, that a matching URL suffices after the hosting identity changes,
and that a successful key write needs no rollout evidence. Counterexamples are
duplicate URL endpoints, replacement services retaining a URL, and a hosting
receipt requiring rollout. Exact-ID/discovery tests failed before the adapter
methods existed; lifecycle tests then reproduced the identity and dropped-receipt
failures before fixes. A later real-client regression reproduced a legacy
binding’s default-endpoint fallback during an ordinary delivery-settings update;
plan and apply now retain the same exact ID, even when the response omits it.
Tests cover confirmed transitions, staged key publication,
unknown reads, ownership-safe removal, lost receipts, persistence failures,
environment isolation, value-free output, and mutation-free noops.

These suites run in ordinary `npm test`; the committed acceptance workflow runs
that command and typechecking, and desired repository policy requires acceptance.
Live branch protection and live SendGrid delivery/signature verification have not
been checked for this change.

Local acceptance on 2026-09-24: `npm test` passed 3,945 tests across 277 files
(5 skipped tests, 3 skipped files, 1 todo); `npm run typecheck` passed. No live
provider calls, application signature tests, build, release, or deployment were
performed for this change.
