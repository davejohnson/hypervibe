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
Host/state checks, once-only form delivery and retained-port restart. Actual
SQLite tests verify encryption, concurrent consumption, source separation,
delivery acknowledgement retention and final credential erasure. Cloud APIs
are not called by these checks; they are in ordinary `npm test` acceptance.
