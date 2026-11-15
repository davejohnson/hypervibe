# SendGrid delivery diagnostics

Reviewed 2026-10-14 against official Twilio documentation:

- [Email Logs overview](https://www.twilio.com/docs/sendgrid/api-reference/email-logs)
- [Search messages](https://www.twilio.com/docs/sendgrid/api-reference/email-logs/filter-all-messages)
- [Read a message timeline](https://www.twilio.com/docs/sendgrid/api-reference/email-logs/filter-messages-by-id)
- [Find a message ID](https://www.twilio.com/docs/sendgrid/glossary/x-message-id)
- [RFC 3463 status-code grammar](https://www.rfc-editor.org/rfc/rfc3463.html#section-2)
- [Twilio's documented 5.7.26 rejection](https://help.twilio.com/articles/47454601923483)
- [Published Email Logs OpenAPI source at fb95a935](https://github.com/twilio/sendgrid-oai/blob/fb95a935c87b79f7f982ac34bd37adab1f697dbc/spec/json/tsg_logs_v3.json)

Tests use synthetic HTTP responses, the documented endpoint semantics, and the
exact published OpenAPI document pinned in `sendgrid/email-logs.openapi.json`.
Its source revision and SHA-256 are in `sendgrid/email-logs.source.json`. The
schema is unchanged; tests verify its hash and every event discriminator value
through the real adapter. They do not claim full-response-schema validation,
recorded provider traffic, or complete live acceptance.

## Existing mechanism and provider coverage

`hv_logs` already owns runtime/build logs and Stripe delivery inspection through
the shared CLI/MCP command registry. `source=sendgrid` extends that mechanism and
the existing SendGrid connection service/adapter. It does not create a second
collector, persistence path, provider-API escape hatch, or infrastructure action.
SendGrid is the only registered `email` provider in this baseline. Other email
providers have no implemented email-log capability. Hosting log capabilities and
Stripe webhook inspection remain separate and unchanged.

| Provider scope | Implemented read | Evidence limits |
| --- | --- | --- |
| SendGrid global account or directly authenticated global subuser | `POST /v3/logs` search and `GET /v3/logs/{sg_message_id}` | One bounded account search and same-ID detail read succeeded; detail observed at 2026-10-15T04:46:59.262Z. Other accounts, credentials, scopes and permissions remain unverified |
| Parent account searching a delegated subuser | Unsupported | Official API requires an explicit numeric subuser selector; no identity is guessed |
| EU regional subuser | Unsupported | Existing connection uses the global API host; no silent regional fallback |

## Input and output

Both interfaces require explicit project and environment. Those selectors choose
the existing connection context, not the origin of every message in that account.
The result identifies `scope.kind=provider-account`, unverified environment
attribution, the source API, completion time, and `persisted=false`.

Search accepts optional exact `recipient`, `errorsOnly`, `since`, `until`, and
`limit`. Default window is the prior 24 hours; timestamps filter **message creation
time**, not the time of its latest event. The maximum lookback is 30 days. Results
default to 50, with a maximum of 500. Arbitrary query syntax is not accepted.
Recipient inputs containing quotes, backslashes, or whitespace are unsupported
because their query escaping is not established by the reviewed documentation.
Recipient inputs are sent only to the selected provider and are never echoed,
persisted, or included in an error. A recipient may still exist in the calling
client's own transcript or CLI history.

For a timeline, pass `messageId` returned by a log search, optionally with `limit`.
Search filters cannot be combined with this exact-ID read. Mail Send's
`X-Message-ID` receipt and the full event/log `sg_message_id` can differ; do not
assume interchangeability. Use recipient and time to locate the full ID rather
than inventing a suffix.

Output contains only message IDs, documented status, creation/event times,
allowlisted event names, SMTP status codes, and bounce classifications. No subject,
recipient/sender address, raw reason, message body, custom arguments, IP, teammate,
or API-key ID crosses the adapter boundary. Existing command secret patterns are
also applied before accepting IDs. A delivered status is provider delivery
evidence; it does not certify inbox placement or human receipt.

The API documents no pagination and caps exact-message history at its newest 100
events. Reaching the requested list limit or event ceiling marks the result
possibly truncated. Missing optional status/time fields remain unknown; missing
message identity, omitted list envelope, malformed values, and contradictory
filter results fail as unknown evidence. A detail response must match the exact
requested message and any supplied event message identity.

The Email Logs page's SMTP status regex is narrower than RFC 3463 and Twilio's
own documented `5.7.26` rejection. Numeric enhanced status codes therefore use
the RFC's one-to-three-digit subject/detail grammar without leading zeroes;
ordinary three-digit SMTP codes remain accepted. This does not parse free-text
SMTP reasons or assign an incident cause from a code we have not observed.
Invalid-response errors retain a bounded, allowlisted validation stage, reason,
and field paths. They never expose the rejected values or raw Zod error messages.

Email Logs defines its own 13-value event union. It includes `received`, which
the earlier webhook-derived allowlist omitted. The raw `drop` spelling appears
in message-status summary prose, but the published event union uses `dropped`
and `cancel_drop`; output follows that union. An undocumented event remains an
explicit unknown read with `events.*.event` validation metadata, without exposing
the raw name. `received` only reports provider receipt, never delivery.

One request is allowed per command. The adapter bounds streaming responses to
1 MiB and the combined request/body duration to 15 seconds, rejects redirects,
and performs no automatic retries. HTTP 401/403 means access unavailable, without
guessing a billing requirement; 429 tells the caller to wait. Detail 404 preserves
the distinction between missing/expired provider history and a send never being
attempted. Raw provider errors are discarded. No fallback to the legacy paid
Email Activity API occurs.

## Regression evidence

Assumption challenged: existing log commands could diagnose SendGrid delivery.
Counterexample: the published command rejected `source=sendgrid`, and the real
adapter had no log operation. Before runtime changes, 22 adapter cases failed on
the missing method and 3 real MCP cases failed on the unsupported source. A second
review produced two observed failures: secret-shaped IDs escaped the adapter,
and an errors-only receipt accepted a contradictory delivered row. Both now fail
closed. A later input review reproduced dot-segment IDs reaching the transport;
`.` and `..` are now rejected before any fetch.

A live bounded account search then returned one blocked message; the exact-ID
detail read returned `invalid_response`, without retaining its raw payload. An
offline contract review found the independently reproducible multi-digit SMTP
code defect above. Its positive regression and two missing-safe-metadata
regressions were observed failing before correction. This does not establish
which field caused that live rejection. No additional live request is made by
the tests or to obtain a raw payload.

A subsequent authorized same-ID live read identified `events.*.event` as the
rejected field, without exposing its value. The complete published event union
then supplied an independent counterexample: `received` failed the real adapter.
All 13 documented event cases now pass; unknown event names remain safely rejected.
The successful bounded read below subsequently confirmed `received` in the live
response. This establishes that event's compatibility, not the cause of the
original delivery failure.

## Bounded live evidence

At `2026-10-15T04:46:59.262Z`, the corrected source command successfully read one
exact message previously returned by the bounded account search. It reused the
existing global SendGrid connection selected with project `hypercloud` and
environment `staging`; the result retained `environmentAttribution=unverified`.
The sanitized response reported status `blocked` and these events (all UTC on
2026-10-14):

- `received` and `processed` at 14:32:19.
- `deferred` at 14:32:21, 14:32:52, 14:33:55, and 14:35:35.
- `bounce` at 14:37:39, with classification `Unclassified`.

No SMTP status was returned in the normalized result. No recipient match was
performed, so this message is not attributed to the reported missing recipient,
the credential invitation, or staging. These observations verify one account
search and one exact-message timeline through the source command. They do not
prove other accounts, permissions, EU/subuser support, every event shape, actual
retention, inbox placement, or the delivery failure's underlying cause. The
diagnostic read made no provider mutation or email send.

## Verification limits

`src/adapters/providers/sendgrid/__tests__/sendgrid.logs-contract.test.ts` uses the
real adapter, serialized requests and streamed `Response` bodies, with only
`fetch` substituted. It covers safe fields, exact filters and IDs, malformed and
omitted evidence, denied/missing/rate-limited reads, response budgets, completion
time, event ceilings and secret/error leakage. The observability tool suite uses
temporary SQLite fixtures, encrypted scoped connections, the real MCP transport
and CLI command runner, and verifies shared envelopes and unrelated-project
credential exclusion. These run under the normal `npm test` discovery patterns;
no live branch-protection enforcement was checked.

The initial customer delivery failure is not reproduced by these tests or
identified by the bounded live observation. No test sends email or changes
SendGrid state.
