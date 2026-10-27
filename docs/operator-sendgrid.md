# Reviewed SendGrid runtime credentials

The existing `sendgrid` provider supports the same operator application lifecycle
as other Hypercloud prerequisites. It does not introduce a provider alias or a
second planner. Declare its exact existing verified management `connectionId`,
native `accountId`, configured sender, consenting sandbox recipient and
`outputs: { "api-key": "SENDGRID_API_KEY" }`. The ordinary desired-state planner
requires the verified operator origin and prepares the exact delegated native
secret container before reviewing issuance. No management token becomes a runtime
credential. The selected management connection must match the complete repository
or its exact environment scope. Unscoped, wildcard and unrelated repository
connections are rejected before decrypting them.

One separately reviewed native action allocates a new key with exactly
`scopes: ["mail.send"]`, verifies its native ID, tests its value with a fixed
no-delivery sandbox request, and encrypts the one-time value before acknowledging
completion. The shared output action then delivers it to the reviewed empty
secret-manager container, verifies the immutable reference, and erases private
local values only after durable delivery receipts. Capture alone cannot claim
that a runtime value was delivered or deployed.

Every provider operation verifies the exact native account `user_id`, required
management permissions and configured sender using existing sender observations.
A fresh key read verifies exact ID/name/scopes on apply and recovery. Key names
are not unique and never establish ownership or adoption authority. The key grants
account-wide mail sending; checking the intended sender does not narrow SendGrid's
native permission to that sender. Existing keys and their scopes remain unchanged.

The key-creation response contains the credential only once. An uncertain response
stops: list-by-name cannot retrieve it or authorize another create. Once the
exact returned ID is known and confirmed absent from the complete earlier
inventory, failed sandbox validation or private capture makes a best-effort
cleanup attempt against only that new ID. Definite deletion requires native
absence before another separately reviewed create can proceed. A failed or
uncertain cleanup retains its exact ID and reports incomplete cleanup; subsequent
read-only recovery does not repeat deletion or creation. Loss of a local custody
acknowledgement first checks encrypted capture, preserving a committed key.

The first observed regression was the actual SpecStore rejecting `sendgrid`
operator declarations. Additional observed RED/GREEN checks rejected native
credential echoes used as IDs before cleanup and rejected unrelated/global
management scopes before private token access, and preserved unrelated inventory
entries whose optional name was omitted. These became GREEN through the normal application
boundary. Serialized transport tests cover the exact explicit-scope request,
existing-key preservation, native account/sender changes, one-time lost responses,
private error handling, cleanup failures, separate retry review, restart recovery,
and isolation between apps in the same account. Actual SQLite plan/apply tests run
container preparation, native issuance, immutable GCP delivery and value erasure
through real clients with reconstructed HTTP responses. Normal `npm test` includes
these regressions; typecheck covers the TypeScript additions.

Independent native read-only evidence on 2026-10-27 returned a direct
`{ api_key_id, name, scopes }` object from exact-ID GET. The pinned official
OpenAPI describes an optional `result[]` envelope and permits unknown properties,
so schema validation alone cannot verify those native identity fields. Both
independently evidenced forms require one exact requested ID and exact scopes.
The fixture is reconstructed from safe projected observations; no credential
values or native account details are committed.

The existing application's private runtime key was independently rejected with
HTTP 401 by the supported packaged sandbox probe. No email was sent. That result
justifies reviewing a new restricted key; it does not authorize broad-token reuse
or modifying existing keys. Native issuance and real invitation delivery remain
separate acceptance steps, not claims established by offline tests.

Sources: [pinned key contract and native projection](../test/provider-contracts/sendgrid/api-keys.source.json),
[sandbox validation](runtime-mail-validation.md), and
[shared operator provider review](../test/provider-contracts/operator-applications/source.json).
