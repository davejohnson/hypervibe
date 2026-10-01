# SendGrid Inbound Parse signing

Hypervibe can adopt an already attached, positively observed signed Inbound
Parse security policy and reconcile its public verification key on the receiving
service. Policy creation, rotation, disabling, detachment and deletion are not
implemented: SendGrid's published contract leaves required observation and
removal semantics unspecified. This is a provider capability gap, not a complete
setup path for an unsigned route.

Declare verification on the existing inbound target:

```json
{
  "domain": "example.com",
  "email": {
    "enabled": true,
    "inbound": {
      "hostname": "inbound.example.com",
      "service": "api",
      "path": "/webhooks/sendgrid/inbound",
      "signatureVerification": true
    }
  }
}
```

Use `hv_spec`, `hv_plan`, `hv_apply`, and `hv_status` through either MCP or CLI.
The inbound route must first converge through its existing lifecycle. Planning
then reads the exact hostname, its attached policy ID, that policy's signature
public key, and the exact receiving service's configuration through the project's
verified connections. Missing or incomplete evidence blocks key publication;
it never authorizes replacement of an unknown policy.
If verification is requested for a route that does not exist, planning blocks
before creating an unsigned route: automatic signing setup is outside this scope.

The plan offers a confirmation-required key action. Confirm that exact action
to adopt the observed signing configuration and publish
`SENDGRID_INBOUND_WEBHOOK_PUBLIC_KEY` only to its receiving service. Adoption
records the hostname, policy ID, hosting identity and key hash. Subsequent plans
detect missing or changed runtime keys and require review before repairing them.
Fresh observations must still match the reviewed provider and hosting identities.
An ordinary deployment can change the image and release metadata without changing
that identity; the inbound binding pins the durable hosting scope, service IDs
and callback base URL instead.

Hypervibe obtains the public key itself. Do not paste it into chat or put it in
ordinary env configuration. Plans, receipts and bindings contain identities and
hashes, never the key value. Ordinary email runtime actions do not write or remove
this key. Noop actions make no provider mutations. Pending ownership is persisted
before a hosting write, so a lost receipt cannot release the target or allow
managed intent to disappear. If that journal cannot be saved, no write occurs.

Acknowledged restart requirements and deployment baselines are journaled before
verification and replayed through the shared `runtimeRollouts` lifecycle. This
also covers an outer apply losing a successful action receipt. A stored key is
not sufficient when the hosting acknowledgement itself is unknown: recovery
stays pending until observation proves a distinct running deployment after the
saved, known baseline. An unknown baseline cannot recover automatically. Re-plan
after the existing deployment lifecycle verifies activation; Hypervibe does not
repeat a committed key write merely to obtain another receipt.

Omitting `signatureVerification` leaves previously unmanaged signing alone.
Once managed, `false`, removal of the setting, and changes to the receiving
hostname or hosting identity block while preserving the route and key. Unlike
delivery-event signing, there is no verified disable-and-cleanup transition in
this slice. Hypervibe does not guess a null/empty detach payload or delete a
possibly shared account-level policy to satisfy the requested state.

Changes to the existing signed route's settings require confirmation and use an
exact-hostname PATCH carrying the complete reviewed route settings and the same
positively observed policy ID. They do not delete and recreate the route. An
unknown attachment blocks a route change, so an ordinary URL or spam-check edit
cannot silently strip security configuration.
Alias-only changes update the local binding without a provider mutation.

Plan/status readiness reports provider signing separately from runtime key
wiring. `configured` means that the observed policy and receiving-service key
match. It does not prove a deployed application has consumed the key or validates
signatures. Hosting rollout evidence continues through the shared lifecycle.
The application must validate the signature against the original multipart
request bytes before parsing them and handle timestamps and replay appropriately.
Application middleware, delivery tests, invalid-signature rejection and replay
tests remain outside this configuration check.

## Connection access

Reuse the verified **SendGrid API key** for the account owning the route. Alias-only
adoption needs `user.webhooks.parse.settings.read`; route PATCH additionally needs
`user.webhooks.parse.settings.update`. These are account permissions, not grants
limited to one hostname. Policy reads must also succeed; the published security
policy contract does not specify their scope mapping, so these route scopes alone
do not prove complete access. Read failures remain unknown.

If a connection is needed, create the API key in [SendGrid API Keys](https://app.sendgrid.com/settings/api_keys)
and keep it in a local environment variable. No documented pre-filled creation
template is available. Connect without putting the value in chat:

```text
hv_connections provider="sendgrid" scope="OWNER/REPOSITORY" credentialsRef="env:SENDGRID_API_KEY"
```

## Evidence and regression coverage

Official sources consulted 2026-09-24:

- [Securing Inbound Parse Webhooks](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks)
  documents `security_policy` as a string ID in attachment PATCH requests and
  their updated responses, a policy's signature public key, and the original
  multipart-body requirement. Its initial example lacks a policy field, but it
  does not define omission as authoritative evidence of no association.
- [Retrieve a specific parse setting](https://www.twilio.com/docs/sendgrid/api-reference/settings-inbound-parse/retrieve-a-specific-parse-setting)
  and [Update a parse setting](https://www.twilio.com/docs/sendgrid/api-reference/settings-inbound-parse/update-a-parse-setting)
  document exact-hostname reads and updates. Their schemas omit the policy field.
- [Retrieve a specific security policy](https://www.twilio.com/docs/sendgrid/api-reference/settings-inbound-parse/retrieve-a-specific-parse-security-policy)
  exposes policy details and signature public material. Missing signature data
  is insufficient evidence that signing is disabled.
- [Delete a security policy](https://www.twilio.com/docs/sendgrid/api-reference/settings-inbound-parse/delete-a-parse-security-policy)
  documents permanent deletion and an optional `force` boolean without its
  semantics. It does not establish a safe route-detachment contract.

Selected operations and their referenced schemas are pinned from official
`twilio/sendgrid-oai` revision `fb95a935c87b79f7f982ac34bd37adab1f697dbc` in
`test/provider-contracts/sendgrid`. The pinned `ParseSetting` schema does not
constrain `security_policy`; attachment semantics come from the separate guide.
Schema acceptance cannot prove unsigned state, field omission behavior, safe
detachment, idempotent policy creation or live permissions. Fixtures reconstruct
documented responses at the real client's HTTP boundary; hosting observations
are synthetic. They are not recorded traffic or live compatibility evidence.

The challenged assumption was that inbound route settings could be reconciled
with delete/create without losing security state. Before runtime changes, the
route-preservation regression failed: changing a signed route's URL issued DELETE
and POST, and the POST omitted its attached policy. The expected boundary is one
confirmed exact-hostname PATCH preserving that policy. A separate cryptographic
validation regression observed acceptance of a public key containing ignored
trailing bytes; the contract's string type alone cannot detect that malformed
key. Missing-method transport regressions also failed before the new adapter
boundary existed.

Further regressions failed before their fixes when the first key write committed
but lost ownership on receipt failure, when acknowledged restart evidence was
dropped during recovery, and when an outer apply lost its successful action
receipt. Persistence-failure cases also reproduced false success or raw error
escape. Recovery checks now retain ownership, replay acknowledged rollout
requirements, and keep unknown acknowledgements pending without another key write.
Route tests separately cover exact action authority, confirmation, read-only
alias adoption, delayed PATCH observation and lost PATCH receipts.
A deployment-recovery regression also failed when a new image was mistaken for
a new hosting identity; it now permits ordinary image updates while still
blocking a different service ID.

Regression coverage includes exact identities, omitted/unknown security evidence,
confirmed key adoption, target isolation, policy-preserving route updates,
value-free results and mutation-free noops. These checks belong to ordinary
`npm test`. The desired acceptance check in `.hypervibe/spec.json` requires
`npm test` and `npm run typecheck`; the committed acceptance workflow runs both.
Live branch protection was not queried. These checks do not establish successful
SendGrid delivery or application signature verification.

Acceptance results (2026-09-24): `npm test` passed with 4,018 passing tests,
5 skipped and 1 todo across 280 passing test files (3 skipped).
`npm run typecheck` and the 101-test provider API contract suite passed.
The unsigned-route creation/recovery checks also failed before their guards
and now pass through the real SendGrid transport boundary. No live SendGrid
resources, production deployments or release builds were exercised.
