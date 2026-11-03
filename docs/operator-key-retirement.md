# Dedicated email and CAPTCHA key retirement

This slice extends the existing operator-application retirement capability for
`sendgrid` and `google-recaptcha`. It does not retire Google OAuth clients,
GitHub Apps, Entra apps, cloud scopes, output secret containers, or stored values.
Those named providers/resources remain governed by the shared
[retirement matrix](operator-retirement-proposal.md#named-provider-decisions).
The shared application planner owns consumer/dependency checks and exact saved
plan/apply reachability; a provider driver alone is not full teardown acceptance.

The challenged assumption was that completed registration or failure compensation
already provided normal teardown. The counterexample is a successfully captured,
retained key: the existing driver rejects an explicit retirement intent and emits
no destroy. The user explicitly requires temporary test resources to have a
supported cleanup path. Eight real creation → SQLite journal → retirement checks
failed before the provider implementation, while the old setup itself succeeded.

## Native contracts and evidence

| Provider | Identity and operation | Completion and limits |
| --- | --- | --- |
| SendGrid | Exact retained account ID and opaque API-key ID from acknowledged successful creation, correlated to original attempt/name and send-only scopes. `DELETE /v3/api_keys/{api_key_id}`, empty body, HTTP204. Current account and `api_keys.read` authority are verified before absence. | Exact metadata GET404 proves active absence in that authenticated account; denied or malformed reads stay unknown. No etag/atomic lifetime condition exists. Revocation has a documented propagation delay. The shared account, sender/domain, management key and other API keys remain unchanged. Only the existing global-account connection model is implemented; no new on-behalf-of/EU subuser flow. |
| Google reCAPTCHA | Exact retained project number/ID, key resource, creation time and ownership/attempt labels. `DELETE /v1/projects/{project}/keys/{key}`, empty request body, HTTP200 with empty JSON. Current numeric project and held key-get permission are verified before absence. | Exact key GET404 after those checks proves active absence. Permission failures, malformed metadata, changed lifetime or owner labels remain unknown. No etag/delete precondition is documented. Existing API enablement and unrelated keys remain unchanged. |

Official sources, reviewed 2026-11-03:

- [SendGrid delete](https://www.twilio.com/docs/sendgrid/api-reference/api-keys/delete-api-keys)
  and [key metadata](https://www.twilio.com/docs/sendgrid/api-reference/api-keys/retrieve-an-existing-api-key).
  Existing pinned `test/provider-contracts/sendgrid/api-keys.openapi.json` and
  its source hash remain unchanged. The prior redacted direct-object GET evidence
  remains distinct from the optional envelope described by that schema.
- Google [delete](https://docs.cloud.google.com/recaptcha/docs/reference/rest/v1/projects.keys/delete),
  [get](https://docs.cloud.google.com/recaptcha/docs/reference/rest/v1/projects.keys/get),
  [Key identity fields](https://docs.cloud.google.com/recaptcha/docs/reference/rest/v1/projects.keys#Key),
  and [project permission check](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/testIamPermissions).
  Permission checks are read-only POSTs. The reconstructed concealed-404 negative
  initially passed without current key-read authority; the corrected driver blocks
  it. This is a safety regression, not evidence Google returned such a response live.

An allowlisted read-only projection of the original test journals confirms they
contain the required exact key IDs, account/project scope, creation attempt and
(for CAPTCHA) creation time/owner labels. It is historical creation evidence,
not fresh native presence or a deletion test. No credentials/custody or submitted
values were read. No provider mutations were performed during development.

## State, data and recovery

The provider compiles each selected parsed completed ancestor into one immutable
destroy action. Every action/evidence target is compared to its retained creation
record before native calls; mutable names never select a replacement. The normal
kernel records a write-ahead attempt, requires exact confirmation, reauthorizes,
and persists `retired` only after scoped absence. An uncertain DELETE is observed
by reads only after restart; still-present or denied observations remain pending.
A definitely rejected DELETE can use the existing separately reviewed retry.
The predecessor and all existing encrypted output custody remain unchanged.

This capability supports the explicit `data: retain` disposition. Key revocation
or deletion does not authorize destroying copies in independently managed secret
containers. Their versions and any costs remain a separate explicit lifecycle.
Neither API supports an atomic conditional DELETE tied to the preceding metadata
read. External concurrent changes cannot be excluded; the plan discloses that
limit. No API disablement, test email, CAPTCHA assessment, secret-value retrieval,
or recreate/adopt fallback is part of retirement.

`test/provider-contracts/operator-key-retirement.test.ts` uses the real serialized
creation/deletion clients and actual SQLite journal restart, with reconstructed
native transport. It covers confirmation, account/project drift, replacements,
unrelated-key preservation, absence authority, exact scope/evidence, custody
preservation, malformed secret-echo acknowledgments, rejected retry and lost-ack
read-only recovery. Existing setup suites and TypeScript remain required checks.
Vitest's ordinary `test/**/*.test.ts` discovery includes this file; the committed
acceptance workflow and desired check run `npm test`. This establishes offline
behavior, not live cleanup or live branch-protection enforcement. A disposable,
owner-reviewed native teardown remains outstanding.
