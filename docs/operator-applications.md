# Operator application registration

This is the reviewed design for bootstrapping the operator's browser sign-in
applications. It is separate from customer cloud installation, customer runtime
reading, device pairing, repository installation and deployment. The initial
implementation is in progress; no registration or browser exchange has been
verified live.

## Assumption and counterexample

Cloud API access does not imply authority to register an OAuth application, and
application sign-in does not imply authority to install cloud resources. An ARM
token can read an Azure subscription while Graph denies application creation.
An application can also be created successfully while its one-time credential
response is lost. Retrying creation must not silently create another application
or credential.

The intended outcome is one reviewed operator application/environment/source and
verified HTTPS origin, with provider-native application identities and immutable
runtime credential references. The agent receives no client secret, PEM, code,
assertion or provider response body.

## Provider matrix

| Registration provider | Installation and identity | Runtime client authentication | Recovery and limits |
| --- | --- | --- | --- |
| `microsoft-entra` | Graph creates an application; record tenant, object ID, client ID, created time, exact callback/audience and ownership correlation. A separate action creates a federated identity credential for the verified Google service account. | Google-issued assertion with exact issuer, service-account unique subject and `api://AzureADTokenExchange`; browser authorization code and PKCE remain separate. | Native reads correlate the exact attempt and immutable object. No automatic POST replay after an uncertain response. FIC removal is a separately reviewed exact-ID action. Other host identity strategies are explicitly unsupported initially. |
| `github-app` | Owner approves an exact GitHub App manifest in GitHub. A private local callback receives the one-hour code; a separate approved conversion returns the native app ID, owner, client ID and credentials. App JWT readback verifies the returned identity/configuration. | The App's returned PEM/client secret/webhook secret, delivered only to reviewed native secret destinations. Repository installation remains a distinct browser approval and verified native installation. | Persist consumption before conversion and encrypt the complete returned set before acknowledging it. Lost conversion response never authorizes another conversion. Browser cleanup may be required when no credential was retained; no invented App deletion API. |
| `google-oauth` | Google requires Console terms acknowledgement and manual standard OAuth client creation. Prepare exact nonsecret fields and accept an owner-selected private configuration reference. | Existing Google confidential web client secret, delivered privately to the reviewed native destination. | A downloaded client JSON is owner-supplied configuration, not native ownership or redirect proof. Mark imported configuration unverified until the real browser callback succeeds. No IAP-client API substitution. |
| AWS Connect Cloud | No operator OAuth application is needed for the reviewed CloudFormation browser installation. | Existing hosted federation is separate. | No registration action is offered. |

The named registration roster is explicit. Every registered identity provider
must declare its supported operation and unsupported behavior in normal CI.
Existing deployment/CI provider registrations do not acquire registration power.

## Shared declaration and execution

Add `environments.<environment>.operatorApplications.<name>` with a registered
provider, an origin service, exact provider-owner selectors, a fixed callback and
permission profile, and output-to-declared-secret-key mappings. Entra also selects
the verified runtime service whose immutable Google identity becomes its client
authentication. Google accepts only a safe private credential reference. Specs
contain no generated native IDs, credential values or callback codes.

Planning resolves the origin and runtime principal from the existing prepared
hosting receipt and fresh native inspection. It binds the canonical repository,
app/environment IDs, source revision/digest, origin, native owner scope, targets,
permissions and predecessor evidence. Unsupported or uncertain authority stops
that stage. Changing a source declaration cannot hide an already attempted
operation; historical recovery remains read-only and does not grant fresh writes.

Use the existing provider registry, normal plan/apply/status dispatch, existing
CAS operation journal in `runs`, and existing encrypted secret store. Introduce a
separately admitted local `operator-application` actor. The hosted cloud roster
remains AWS/Azure/GCP; only the executable journal's provider type gains the
registration identifiers. Hosted factories reject the new actor before any
credential, provider or journal access. There is no new deployment engine,
parallel connection store or provider-name branching in generic tool handlers.

Each provider action is explicit and confirmed: registration, federated trust or
one-time conversion, delivery, and final nonsecret binding. Provider-confirmed
noops perform zero writes. Ordinary deployment cannot proceed until all required
outputs are bound. Completed matching registrations allow ordinary deployment
inputs again; they do not claim that application release or customer authorization
has succeeded.

## Authority and private handoff

Entra registration requests a transient Graph token for the selected tenant using
the supported local credential reader. ARM sign-in is not sufficient. The current
Graph contracts distinguish application creation from FIC management. Verify
read/recovery and management authority separately; missing tenant consent yields
the prescribed browser-login/administrator continuation, never retained keys or
an invented public OAuth client. This is operator bootstrap, not a requirement
for each customer to install local credentials.

GitHub needs no existing operator GitHub App to start the manifest protocol.
Reusing `hv_cloud_requests` would be circular because that hosted service already
depends on the App being configured. Add a small private callback adapter over
the shared application service: explicit loopback binding, exact Host/path,
unguessable state, bounded lifetime/body, no CORS, no browser storage, no request
logging, no third-party assets and immediate removal of the callback query from
the visible URL. A callback only stages the code encrypted. It does not call a
conversion endpoint from status or authorize an unreviewed mutation. The ordinary
apply continuation consumes it once after rechecking the exact saved review.
Official GitHub documentation describes a full redirect URL; actual loopback
manifest acceptance remains a live test requirement.

Native delivery reuses the existing `SecretDestinationDriver` attempt/reconcile
contract. GCP/AWS can prepare empty containers; Azure prepares only the reviewed
vault/names. Container creation, writer authority and runtime-reader grants remain
their own reviewed prerequisites. Values remain encrypted during local recovery
and transient during delivery, then are erased only after immutable native
references and the complete output binding are durable. An uncertain native
write is reconciled without resubmission. The legacy dotenv import is not
relabeled as native-secret delivery.

For write-only issuance, validate the complete returned identity and all intended
consumers before committing the credential set. Preserve encrypted received data
on a later delivery failure. On an unrecoverable custody failure, attempt only
provider-supported exact-credential cleanup covered by the review and report
incomplete cleanup honestly. Do not overwrite or revoke existing credentials.

## Entra keyless browser integration

Microsoft's maintained MSAL documentation explicitly supports federated client
assertions with authorization-code acquisition. Its Google federation guide
defines the exact issuer, subject and audience. These are independent design
evidence, not a successful multitenant browser exchange.

Hypercloud adds an explicit client-authentication alternative while preserving
legacy client-secret configuration. The federated mode obtains a fresh assertion
from the existing verified native Google metadata identity reader; it never uses
local ADC, an arbitrary URL, a stored assertion or a fallback secret. The token
POST replaces `client_secret` with `client_assertion` and its standard type while
retaining code, PKCE, redirect, state/nonce and identity validation. Failed token
redemption requires fresh browser authorization; it does not replay a code.

The current Graph create documentation also describes creating an application
and password together, but its success example differs from the general status
and the password resource documentation. This design avoids that ambiguity by
creating no Entra password. Graph upsert is also unsuitable: it updates an
existing application and does not establish create-only authority.

## Required evidence

Keep RED/GREEN tests in ordinary acceptance: real serialized Graph/GitHub
transports, actual SQLite journal and encrypted custody, native private callback
HTTP, stale source/origin/owner, denied scopes, partial installation, lost
acknowledgements, restart, concurrent callback/consumption, expired code, exact
cleanup and immutable delivery references. Exercise MCP and CLI through their
shared handler and reject local actors through the actual packaged hosted API.

Hypercloud's actual authorization-code POST must prove absence of client_secret
in federated mode, exact assertion audience, unchanged nonce/PKCE validation,
failure redaction, no fallback and preservation of legacy clients. Complete an
approved native multitenant browser exchange before claiming live support.

Pinned source identities and documented uncertainties are recorded in
[`operator-applications/source.json`](../test/provider-contracts/operator-applications/source.json).

## Implemented Entra slice and evidence

`operatorApplications.<name>` now accepts the fixed `hypercloud-connect-v1`
profile, `originService`, `runtimeService`, and provider-owned `nativeScope`.
For `microsoft-entra`, the declaration's only native selector is `tenantId`.
The normal plan shows the exact verified callback, tenant and immutable Google
service-account subject. Two confirmed native actions create the application
and its FIC; neither creates a password. The resulting nonsecret receipt exposes
the client ID and `google-workload-identity` authentication selection. Configuring
these application environment fields remains a separate desired-state edit.

Graph calls use a transient tenant-selected default credential and the Graph
resource scope, independently of ARM. The fresh organization read verifies the
tenant. The reviewed permissions are Application.ReadWrite.All and
Organization.Read.All. This read is not proof of write permission: tenant policy
can still reject the native create. Native 403 remains a definite rejection;
a fresh exact retry review is required. An uncertain POST is reconciled by
native object ID or its exact retained attempt tag, creation time and complete
configuration, and never blindly resubmitted. The correlated tags are
ownership evidence only with the retained attempt, not a standalone adoption
capability. External administrators can still change the app between reads.

Observed tests include: initial declaration rejection (RED) through actual
SpecStore/PlanService, followed by admitted isolated plans (GREEN); unexpected
200 create responses incorrectly accepted as success (RED), followed by uncertain
outcome and no replay (GREEN); definite 403 incorrectly treated as uncertain and
new actor retry admission rejected (RED), followed by separately reviewed new
attempts retaining the rejected history (GREEN). Serialized Graph tests cover
exact callback/FIC, no password issuance, denied reads, changed callbacks,
restarts, lost acknowledgements and error redaction. Actual SQLite plan/apply
and the shared command registry status path run under ordinary `npm test`.
These reconstructed responses are documentation-based contracts, not a full
Graph schema validator or live tenant evidence. The committed required workflow
runs `npm run typecheck` and `npm test`; its desired required check is
`Hypervibe / acceptance`. Live branch-protection enforcement is not established
by those files.

GitHub manifest custody, Google owner-import/delivery, native registration and
the real browser exchanges remain in progress. This slice does not establish
complete operator onboarding or customer onboarding.

### Observed Entra creation-time precision

The adapter previously assumed Graph returned an identical `createdDateTime`
string after creation. A retained native 201 acknowledgment recorded
`2026-10-28T04:04:50.0704782Z`; independent list and exact-object GETs returned
`2026-10-28T04:04:50Z` for the same object, client, tenant, attempt/owner tags and
complete reviewed configuration. Graph documents a read-only UTC
[DateTimeOffset](https://learn.microsoft.com/en-us/graph/api/resources/application?view=graph-rest-1.0),
without promising identical fractional precision across responses. The sanitized
[observation](../test/provider-contracts/operator-applications/entra-application-timestamp-observation.json)
retains the actual timestamp pair; transport tests replace customer identifiers.

Actual PlanService/apply and SQLite restart tests failed before the fix. The
Entra boundary now accepts only an identical timestamp or the observed
whole-second UTC projection of an already verified fractional acknowledgment,
after verifying every other identity and configuration field. It preserves the
acknowledgment verbatim, including when carrying the application identity into
the FIC receipt. It does not round arbitrary fractional timestamps or change
shared journal equality. The existing five-second attempt-age bound uses that
verified retained precision; a synthetic edge case also failed before this
correction. Conflicting fractions (including submillisecond differences), other
seconds, changed authority/configuration and a missing object remain blocked.

The passing normal-CI regressions exercise initial apply, repeated read-only
status after SQLite restart, preserved native plan/attempt identity, no CREATE
replay, and a fresh outer plan for the remaining FIC. After status completes the
application, the previous outer CREATE action remains obsolete and cannot be
reused. Native diagnostics performed no writes; these tests do not establish
successful native FIC creation or browser federation.

## Private operator custody and callback boundary

Operator credentials use encrypted compare-and-swap records in the existing
local connection store, scoped to project, environment, installation and exact
intent digest. These are operator-owned application credentials, not customer
secret submissions. The public installation journal contains no credential or
browser code. Browser codes can be consumed once only after the reviewed form
was issued; the durable conversion-started state is committed before any remote
exchange. A lost exchange response cannot authorize another exchange. Credentials
are erased only after every selected output has an immutable delivery receipt.

The GitHub manifest adapter uses a bounded 127.0.0.1 HTTP listener with an exact
Host check, expiring random launch/state, no-store responses, no external assets
or browser storage, and a manual GitHub POST form. It stages the callback code
only in encrypted custody and immediately redirects away from its query string.
It does not call GitHub or consume the code. An active local MCP process keeps
the callback available; restart can reopen only the retained port before expiry.
Native GitHub acceptance of this loopback redirect remains unverified.

The boundary regression first demonstrated acceptance of a code before form
handoff (RED); the custody state now rejects it (GREEN). Actual HTTP tests verify
Host/state checks, exact unconsumed form redisplay and retained-port restart. A
lost form response previously stranded the handoff with HTTP 409 (observed RED).
Redisplay now uses the retained state, port and manifest digest until a callback
is accepted; changed forms and any redisplay after code staging are rejected
(GREEN). This does not make GitHub's owner-reviewed browser submission idempotent;
an owner must finish an already submitted registration rather than create another.
Actual
SQLite tests verify encryption, concurrent consumption, source separation,
delivery acknowledgement retention and final credential erasure. Cloud APIs
are not called by these checks; they are in ordinary `npm test` acceptance.

## Operator private output delivery

Each credential-producing operator capability declares its exact private roles.
Desired `outputs` maps those roles to declared environment secret keys. The full
planner prepares only those empty containers before registration; an unsupported
role, undeclared target or active uncertain registration blocks that prerequisite.
The accepted intent retains the hosting provider, container owner, attempt and
native creation time. A shared driver adds a separately confirmed, billable
delivery action after the provider's credential capture action. No values enter
the declaration, plan, installation journal or receipt.

Cloud Run currently supplies the local operator output capability using selected
user ADC and GCP Secret Manager. It reuses native project/destination validation,
checks the prepared container lifetime before each write, and returns an enabled
immutable version reference. No payload read is used for verification. AWS and
Azure collaborative customer delivery remain their separate existing mechanisms;
this operator bootstrap does not assume Hypercloud runs inside customer clouds.

| Hosting registry entry | Local operator output capability |
| --- | --- |
| Cloud Run | GCP Secret Manager; prepared owned container and transient local operator authority. |
| ECS | Not implemented for local operator bootstrap; AWS delivery uses its distinct stable ClientRequestToken contract. |
| Azure Container Apps | Not implemented for local operator bootstrap; Key Vault SET creates a value and requires its own vault/name contract. |
| Railway, Fly, Vercel, DigitalOcean | Not implemented; no reviewed immutable native secret-manager output lifecycle in this operator path. |

The provider differences and official native sources are recorded in
[secret destination delivery](secret-destination-delivery.md). Normal CI checks
the complete seven-provider registry against the explicit capability selection.
GCP addVersion has neither a request token nor an empty-container compare-and-set.
Observed existing versions block first delivery, but simultaneous authorized
writers cannot be atomically excluded. A lost acknowledgement remains uncertain
without another POST. A definite rejection requires a new exact reviewed attempt;
the journal retains the previous rejection. Private custody remains encrypted
until every native version receipt verifies, then local erasure can finish after
a crash without another provider write. The local source revision field carries
the accepted spec digest, not an asserted Git commit identity.

Observed RED/GREEN cases: the ordinary planner initially blocked registration
before preparing its selected output container; the shared actor initially
rejected its exact secret-output action; unsupported roles initially requested
container preparation; and a lost local erasure acknowledgement retained private
values indefinitely. The corrected checks exercise actual SQLite, the real
cloud-installation parser/apply loop, and serialized GCP REST delivery/recovery.
Native response fixtures are documentation-based reconstructions. Current native
registration, browser exchange and live output delivery remain separate gates.

## GitHub manifest implementation and remaining native evidence

The `github-app` provider accepts `ownerType` (`user` or `organization`) and
`ownerLogin`. Native public account lookup pins its immutable account ID; it
does not establish administrator authority. The reviewed browser manifest uses
the exact verified origin, a globally unique name within GitHub's 34-character
limit, the Hypercloud user/setup/webhook routes, and read-only actions,
administration, checks, contents and metadata. GitHub's owner approval remains
the authority to register the public App. Repository installation is separate.

The callback listener returns the exact private link through apply/status. Its
form rechecks current source/origin authority before display. The process stays
alive until the callback or original expiry; restarting reopens only the retained
port and manifest. A fresh-process regression demonstrated that an unreferenced
listener exited before the user could open it (RED), and now verifies bounded
process survival and exit after callback (GREEN). HTTP is admitted only for a
registered local actor's strictly parsed 127.0.0.1 handoff, never for hosted cloud
installation links. Callback receipt stages an encrypted code; status cannot
convert it. The separate confirmed conversion consumes its code before one POST,
requires GitHub's documented 201 response and never replays an uncertain result.

Complete returned credentials are encrypted before native App identity,
ownership, creation time, permissions/events and webhook configuration are
verified using a short-lived App JWT. A wrong owner or partial verification
retains private recovery custody and blocks output delivery. No App deletion
or private-key revocation API is invented. An expired or uncertain one-time
conversion can require explicit owner cleanup in GitHub.

GitHub's [manifest contract](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
requires all three steps within one hour. Receiving a callback does not extend
that deadline. The previous provider observation treated any staged code as
ready for conversion. A real local HTTP callback followed by a synthetic clock
advance reproduced incorrect status and a new rejected capture attempt (RED).
The existing custody consumption check already prevented an expired conversion
POST; this was a planning and lifecycle-reporting defect, not a missing dispatch
expiry guard. Observation, retry review and capture now report
`authorization_expired` before adding an attempt when expiry is already known.
An expired pending browser handoff is not reopened. The original completed
browser evidence, attempt IDs and encrypted custody remain unchanged.

Two additional actual PlanService/SQLite cases, with and without restart,
reproduced fresh capture plans after reconciliation had already recorded
`authorization_expired` (RED). Planning now returns that closed, value-free
reason instead of saving another mutation plan. The original native plan,
completed browser evidence, attempt identities and private staged code remain
retained. This check does not infer permission to replace an expired registration.

Normal acceptance exercises staged-code expiry through apply, read-only
recovery and a SQLite restart; expiry during the final authorization check;
and the unchanged no-replay rule after an uncertain conversion. Already captured
credentials remain verifiable after browser expiry. These tests use actual
callback HTTP, SQLite custody and shared lifecycle with synthetic provider
transport and clock transitions; they do not establish native expired-code
behavior. No expired code is sent to GitHub by this verification.

The published [manifest conversion API](https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest)
does not promise renewal, cancellation or a safe replay of an expired code.
The public REST and GraphQL contracts do not expose a pending-manifest inventory.
Whether an unconverted App or name reservation persists, and whether expiry
cleans it up, remain unknown. An expected-slug 404 is not proof of absence: the
owner can change the name during registration. Expiry alone never authorizes
discarding custody, inventing native cleanup or registering another App.

The fixed profile requires these exact outputs:

| Private role | Hypercloud runtime key | Stored bytes |
| --- | --- | --- |
| `private-key` | `GITHUB_APP_PRIVATE_KEY_BASE64` | Base64 of the PEM text |
| `client-secret` | `GITHUB_APP_CLIENT_SECRET` | Opaque returned client credential |
| `webhook-secret` | `GITHUB_APP_WEBHOOK_SECRET` | Opaque returned webhook credential |

The profile fixes encoding in the accepted intent; users cannot choose an
arbitrary transform. A combined real-client regression reproduced raw PEM being
delivered into Hypercloud's base64-only slot (RED), then checked the stored bytes,
RSA decoding and immutable receipt encoding (GREEN). Public App ID, slug and
client ID are separate receipt metadata for an explicit desired-state edit.

After local credential erasure, fresh authenticated GitHub verification reads
only the exact immutable operator signing-key reference, transiently and inside
the provider path. Its review separately lists `secretmanager.versions.access`
for that owned target. It verifies current source authorization, container
ownership/lifetime, enabled native version and CRC32C before decoding the
profile's base64 representation. No command exposes this payload read, and the
client-secret, webhook-secret and customer secret values are not read. Tests
cover source revocation before any payload access, rejected permission drift,
strict response status, wrong owner, restart and lost acknowledgement without
another conversion. The checksum test uses an independent standard known-answer
vector; the combined transport fixture uses the separately maintained AWS SDK
CRC implementation for reconstructed Google responses.

A lost local callback acknowledgement previously returned 403 when the owner
retried the same callback (observed RED). The exact retained state and private
code fingerprint now acknowledge the same receipt without another state write
or code consumption (GREEN); changed codes remain rejected. The fingerprint
stays inside encrypted private custody and is erased with the browser state.

REST App metadata does not expose OAuth callback URLs. Receipts keep callback
verification explicitly unverified until the actual browser exchange. Native
GitHub acceptance of the loopback manifest redirect, real owner approval,
repository installation and webhook delivery are still required walkthroughs.
