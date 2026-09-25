# Webhook readiness

Ordinary `hv_plan` and `hv_status` return `webhookReadiness` for declared Stripe
webhooks, Twilio messaging callbacks, and SendGrid inbound/delivery callbacks.
They also recognize `STRIPE_WEBHOOK_URL` or `STRIPE_WEBHOOK_SECRET` on application
web services. An API key alone does not imply an inbound webhook. Custom env
names and other integrations are not inferred. Bootstrap/cleanup plans returning
before integration planning omit this report.

The report checks URL configuration and verification-material wiring without
probing application endpoints. Managed SendGrid signing additionally uses the
email lifecycle’s read-only provider observations. It never returns URLs, secret values, or their hashes. There
are no endpoint probes, test events, credential rotations, or provider writes.
Infrastructure changes still use reviewed spec/plan/apply actions.

- HTTPS configuration is assessed from the declared Stripe URL or the durable
  hosting URL used by the existing Twilio/SendGrid callback lifecycle. Invalid
  URLs, HTTP, embedded credentials, and fragments need attention. This does not
  test TLS certificates, network reachability, or provider-side registration.
- Signing-material evidence is either desired configuration or observed hosting
  key/hash presence on the exact receiving service. Desired values do not prove
  deployment; presence does not prove that a value matches the provider endpoint.
  Blank desired values and observed empty-value hashes count as missing.
- Masked hashes, incomplete observation, duplicate service observations, and
  missing service observations remain unknown. Another service's credentials
  cannot satisfy this check, and each environment uses only its own inputs.
- Stripe uses the declared endpoint secret key, or `STRIPE_WEBHOOK_SECRET` for
  conventional env configuration. Its API key is not a webhook signing secret.
  Existing Stripe lifecycle drift and confirmation requirements remain authoritative
  for endpoint ownership, binding hashes, installation, and rotation.
- Twilio's existing messaging contract projects `TWILIO_AUTH_TOKEN`; its API-key
  secret is not interchangeable. Alternative Twilio signing schemes are not assessed.
- SendGrid uses public-key signature verification. Delivery events can opt into
  [managed signing](sendgrid-webhook-signing.md), which compares provider signing
  and the exact receiving service’s public-key hash. [Inbound Parse signing](sendgrid-inbound-signing.md)
  can adopt an already attached, positively observed signed policy and compare
  its public key with the exact receiving service. Missing association or
  signature evidence remains unknown; the official contract does not establish
  that an omitted field means unsigned. Policy creation and removal remain
  unsupported. Without explicit signing intent, material remains `not_managed`
  and readiness unknown. SendGrid API-key presence cannot certify signing.

`needs_attention` means an insecure URL or known missing input. `unknown` means
incomplete evidence or unmanaged verification setup. `configured` only means the
configuration checks passed. `applicationVerification` always remains
`not_verified`: inspecting env inputs cannot prove that the app rejects invalid
signatures, preserves required raw request bytes, or handles replay safely.
Unknown/attention results appear as `WEBHOOKS NEED REVIEW` unless another readiness
issue, restart, or blocker already takes precedence. Infrastructure convergence
and mutation authority remain separate.

## Evidence

The user requested HTTPS and signing-secret readiness checks. Independent provider
contracts, consulted 2026-09-23:

- [Stripe webhooks](https://docs.stripe.com/webhooks) require publicly accessible
  HTTPS endpoints; [signature verification](https://docs.stripe.com/webhooks/signature)
  uses an endpoint-specific secret and the request payload/header.
- [Twilio webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
  describes account-auth-token signature validation.
- [SendGrid event webhook security](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features)
  describes public-key verification; the existing email lifecycle documents its
  application-owned verification boundary.
- [SendGrid Inbound Parse security](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks),
  additionally consulted 2026-09-24, documents attached policy IDs, public keys,
  and validation over the original multipart request body. The
  [Inbound Parse evidence record](sendgrid-inbound-signing.md#evidence-and-regression-coverage)
  describes the separate gaps in unsigned observation and detach semantics.

The challenged assumption was that infrastructure convergence suffices for an
unqualified readiness headline. An env-configured HTTP Stripe webhook falsifies
it. Before implementation, the real plan regression failed because the report
was absent and both presentation regressions still showed `IN SYNC`; they pass
with this change. Shared plan/status command tests also check value-free output.
A further regression failed when a managed endpoint hid a separate env-configured
endpoint on the same service; both are now assessed. Configuration tests cover
provider-specific roles, masked/partial reads, service
and environment isolation, blank inputs, and unsafe URLs. These are synthetic
local configuration observations, not provider transport contract or live
signature/delivery evidence.

All regression suites run in ordinary `npm test`. The committed acceptance
workflow runs that command and typechecking; desired repository policy requires
its acceptance check. Live branch-protection enforcement was not inspected.
