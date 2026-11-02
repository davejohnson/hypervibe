# Private runtime email validation

Use the existing `hv_connections` command with `action: "verify"`, an email
provider, a private `credentialsRef`, and `runtimeMail: { sender, recipient }`.
Select the app's declared sender and a consenting test recipient. This branch
never reads or replaces a saved management connection and accepts no raw
credential, saved scope, or setup parameters. MCP and CLI execute the same
application command.

The SendGrid adapter sends one fixed Mail Send request with
`mail_settings.sandbox_mode.enable: true`. The caller cannot disable sandbox mode
or add arbitrary mail fields. SendGrid documents no delivery, activity events, or
credit consumption for sandbox requests. Only HTTP 200 is success; ordinary
Mail Send's HTTP 202 is not sandbox proof. Provider bodies are discarded rather
than parsed because even an error can echo supplied values. Redirects, timeouts,
transport failures and unexpected statuses stay unknown. HTTP 401 and 403 report
separate closed rejection categories and do not replace credentials.

A successful response proves acceptance of this sandbox request from the local
machine. It does not prove exact effective scopes, sender authorization, running
workload configuration or real delivery. In particular, a sending key's failed
management reads are not evidence that the key cannot send mail. Sender readiness
continues to preserve unknown identity reads without requesting broader runtime
permissions. Management access never authorizes copying its token into runtime.

The challenged assumption was that management connection verification suffices
for a restricted runtime sending key. The counterexample is a private key accepted
by sandbox Mail Send while management reads are unavailable. Before implementation,
the actual application boundary rejected `runtimeMail` and its CLI option: eight
expected boundary checks failed. After implementation, the same command, HTTP
serialization, CLI and MCP checks pass. The exact pinned official Mail Send schema
validates the request; the separate official sandbox guide establishes HTTP 200
because that success code is omitted from the generic OpenAPI response list.

Tests run under ordinary `npm test`. The email provider roster currently contains
only SendGrid and is checked explicitly. Reconstructed responses validate bounded,
value-free behavior; they do not establish live provider acceptance. API-key
issuance, secret delivery and real invitation delivery are separate lifecycle
operations, not effects of this probe.

Sources: [sandbox guide](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/sandbox-mode)
and [pinned transport evidence](../test/provider-contracts/sendgrid/mail.source.json).
