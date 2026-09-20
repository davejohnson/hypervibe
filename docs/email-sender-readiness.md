# SendGrid sender readiness

Plan and status report `emailSenderReadiness` whenever SendGrid is declared under
`email`, or `SENDGRID_API_KEY` is present in resolved deploy inputs or observed
runtime key names. Both From and Reply-To must be verified for the report to say
`verified`. Requiring Reply-To verification is Hypervibe policy.

Prefer declarative `email.sender.address` and `email.sender.replyTo`. Existing
apps can retain environment variables ending in `FROM_EMAIL`, `FROM_ADDRESS`,
`EMAIL_FROM`, `MAIL_FROM`, `SENDER_EMAIL`, `SENDER_ADDRESS`, `REPLY_TO`,
`REPLY_TO_EMAIL`, or `REPLY_TO_ADDRESS`, including prefixed names such as
`TRANSACTIONAL_EMAIL_FROM`. Display-name mailbox syntax is accepted.

Checks use the private application credential. A connected account is used for
managed email, or when its credential hash matches every observed sending
service. A different connected SendGrid account cannot certify an existing app.
Values and provider error bodies are excluded from the readiness report.

Each address needs its exact domain authenticated or its own verified single
sender identity. A parent domain does not authorize a subdomain. A Reply-To
field on a verified From record does not independently verify that destination.
Reads include subsequent domain and sender pages. Insufficient permission,
incomplete responses, ambiguous identities, missing values, and read limits
produce `unknown` unless another complete authorization path proves verification.

This checks configured addresses, not application source or every message the
app may construct dynamically. Status cannot recover masked runtime values;
private deploy inputs available during plan can provide more evidence. Custom
unrecognized variable names require declaring sender intent. No inferred From
address means `unknown`, not readiness.

This is a read-only readiness check, not a deployment gate or send-time filter.
Infrastructure `inSync` is separate from email readiness; human plan/status output
highlights `EMAIL NOT READY`. Checks do not send invitations, create identities,
or change DNS. Configuration changes remain in reviewed spec/plan/apply actions.

## Evidence

Official Twilio documentation reviewed 2026-09-18:

- [Sender identity](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/sender-identity): domain or individual identity authorization, including exact-domain semantics.
- [List domains](https://www.twilio.com/docs/sendgrid/api-reference/domain-authentication/list-all-authenticated-domains): domain validity and offset pagination.
- [List verified senders](https://www.twilio.com/docs/sendgrid/api-reference/sender-verification/get-all-verified-senders): includes unverified identities; `verified` supplies evidence, with `lastSeenID` pagination.

Regression fixtures reconstruct those documented shapes and intercept only
HTTP transport; they are not recorded responses or schema certification.
The challenged assumption was that `email.enabled: false` meant no sender
check was needed. An env-configured SendGrid app with an unverified From address
falsified it: the test failed with no readiness result before implementation,
then passed. Presentation tests also failed before correcting an `IN SYNC`
headline that hid unverified email.

Tests run under the ordinary Vitest include pattern used by `npm test`.
The committed acceptance workflow and desired required-check configuration both
include that gate. Live branch protection and live SendGrid compatibility have
not been verified.
