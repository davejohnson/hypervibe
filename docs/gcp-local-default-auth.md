# Local Google authentication for Cloud Run and Cloud SQL

This repair adds an explicit `{ "authMode": "default", "projectId": "…" }`
connection. GoogleAuth reads the current machine's user Application Default Credentials
(ADC); Hypervibe saves the selected project and mode, not a copied refresh token
or generated service-account key. ADC's quota project never selects resource scope.
Existing service-account connections remain explicit and are not silently replaced.
The SDK-selected quota project is retained in the
[`x-goog-user-project` header](https://cloud.google.com/docs/quotas/set-quota-project),
including dependent IAM, queue, volume and SQL Connector calls; it does not replace
the connection's selected resource project.

## Provider contract review

| Provider paths | Native authentication contract | This change and remaining limits |
| --- | --- | --- |
| GCP Cloud Run, Cloud SQL | GoogleAuth supports multiple ADC types; the SQL Connector accepts a GoogleAuth instance. API authorization remains separately verified. | Add only local user ADC to the real adapters and temporary SQL connections, retaining exact project/region/resource checks. Other ADC types fail before token/native requests. Existing explicit JSON-key and hosted impersonation paths remain separate. No key-generation bootstrap changes. |
| GCP GCS | The existing adapter already declares explicit default authentication and separate workload identity. | Preserve existing behavior; no credentials are copied into an app. |
| AWS ECS Express, RDS | AWS SDK default chains and temporary federation are native mechanisms, with distinct task/execution identities. | The separate [AWS/Azure native authentication reconciliation](cloud-native-authentication-evidence.md) adds explicit local profile authentication. Hosted ECS federation remains distinct; this GCP repair provides no AWS live evidence. |
| Azure Container Apps, Azure PostgreSQL | Azure Identity supports a default chain; workload federation and managed identities are separate from local sign-in. | The separate [AWS/Azure native authentication reconciliation](cloud-native-authentication-evidence.md) adds explicit local authentication with pinned subscription/tenant. Hosted ACA federation remains distinct; local runtime-identity limitations remain explicit. |
| Railway, Fly, Vercel, Netlify and Supabase | Existing provider-specific token authentication. | No Google ADC fallback or changes. |

Google documents [local user and service-account impersonation ADC](https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment)
and the [SQL Connector authentication input](https://github.com/GoogleCloudPlatform/cloud-sql-nodejs-connector/blob/v1.10.0/src/connector.ts).
AWS documents [Node.js credential chains](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html);
Microsoft documents [DefaultAzureCredential](https://learn.microsoft.com/en-us/javascript/api/@azure/identity/defaultazurecredential).
Native mechanisms do not imply that every Hypervibe adapter has implemented them.

## Runtime and automation boundary

A local user is never represented as `serviceAccount:<user email>`. This new mode
requires GoogleAuth's `UserRefreshClient`; impersonated ADC and other client kinds
are explicitly rejected because the installed SDK does not propagate the protected
transport into every credential implementation. The app still receives
its separately owned runtime service account. For ADC, the runtime lifecycle uses
the exact account's [testIamPermissions](https://cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/testIamPermissions)
to check `iam.serviceAccounts.actAs`, and does not install a guessed caller grant.
Missing permission or unknown observation blocks that stage. This check is a
preflight; Google's mutation authorization remains authoritative and can change.
Cleanup reads the exact owned account and policies without requiring deployment
`actAs` access: Google's [service-account deletion contract](https://cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/delete)
requires `iam.serviceAccounts.delete`, a separate permission. Runtime grants and
unrelated policy entries remain subject to the existing scoped cleanup checks.

Local ADC is not a durable GitHub/GitLab credential or a runtime environment value.
Legacy managed CI and restore-drill credential requirements remain blocked when
they require a key that this connection does not contain. Use separately reviewed
hosted deployment federation where implemented. The older GCP project bootstrap
still creates a deployment key and is outside this repair; accepting ADC does not
make that bootstrap keyless.

## Evidence

The challenged assumption is that a valid GCP management connection must contain
service-account JSON and have a service-account email. A synthetic `authorized_user`
ADC file with an exact selected project is a counterexample. Before runtime changes,
the normal-CI test `gcp-local-default-auth.test.ts` observed seven failures: both schemas
rejected ADC, Cloud SQL tried to parse a missing key, and its schema accepted mixed
default/key authority; runtime preparation also rejected the user caller. Two further
failures demonstrated dropped ADC quota headers. The corrected suite executes
the actual GoogleAuth loader and OAuth refresh serialization, adapter API probes,
SQL Connector and shared runtime observation; only HTTP is replaced. It verifies
denied access and token echoes, preserved resource scope, native `actAs` preflight,
and no fabricated user IAM binding. The separate CI projection regression confirms
that local ADC cannot satisfy a service-account-key workflow.

The real SQL Connector 1.10.0 negative case also exposed its `close()` continuation
on a rejected initial instance promise. For the exact instance-name path, the adapter
now establishes connector initialization before opening the local proxy and closes
only an initialized connector; failed initial metadata lookup creates no proxy or
refresh timer. Native denial remains an error, with fixed value-free diagnostics.
See the pinned [connector cleanup](https://github.com/GoogleCloudPlatform/cloud-sql-nodejs-connector/blob/v1.10.0/src/connector.ts)
and [initial instance refresh](https://github.com/GoogleCloudPlatform/cloud-sql-nodejs-connector/blob/v1.10.0/src/cloud-sql-instance.ts)
sources. No dependency patch or global rejection handler is installed.

Review added a short-lived token regression: refreshing again inside the SQL SDK
transport discarded its already attached token and prevented the native request.
The internal authenticated transport now registers that exact issued token, after
checking the destination origin, without a second refresh. Four further failures
proved that cleanup incorrectly required revoked `actAs`, both adapters accepted
an impersonated ADC file with unprotected SDK transport, and a nondefault native
API port reached HTTP. Those regressions now enforce separate cleanup permissions,
explicit unsupported-client rejection, and exact HTTPS origins. Unsupported-client
cases use real serialized impersonated ADC files and observe zero HTTP requests.

The final focused gate passed 654 tests in 31 files, including every GCP adapter
suite, CI secret projection, connection guidance and connection tools; TypeScript
validation passed. The new transport
tests use synthetic user ADC and never access the user's login.
Offline evidence does not establish a live deployment, database connection, or IAM
propagation result.

## Operator origin and CAPTCHA quota propagation

A 2026-10-29 diagnostic challenged the assumption that obtaining a token from
`GcpLocalDefaultAuthentication` also preserves its request configuration. The
actual packaged origin verifier used raw `fetch` after token acquisition. Its
first Resource Manager GET omitted `x-goog-user-project` despite an explicitly
selected SDK quota project; the diagnostic guard stopped that read before
network dispatch. This explains that guarded prerequisite failure, not a new
native quota rejection. The earlier helper-publication HTTP 429 remains separate
observed evidence.

Google's [quota selection contract](https://docs.cloud.google.com/docs/quotas/set-quota-project)
requires the REST header and distinguishes Node SDK environment selection from
bearer-token authorization. Two real-GoogleAuth transport regressions failed
before correction, covering ADC-file selection and an explicit environment
override. The holding driver's existing authenticated transport now also performs
operator-origin verification. Prepared runtime/first-release readers already
receive the adapter's authenticated request function and retain that behavior.

Review of the other local-authentication callers found the same missing transport
in CAPTCHA's capability. Two additional regressions failed before correction;
planning, inspection and recovery now share its authenticated request function,
including the explicitly allowed reCAPTCHA Enterprise endpoint. All four new
regressions pass. They use isolated synthetic ADC, reconstructed HTTP responses
and real clients; they verify resource/quota separation, mutation-free reads,
permission denial, no fallback and value-free failure. No hosted credentials,
AWS/Azure mechanisms, public capability flags or shared lifecycle contracts
change. The named provider review above still applies.

The combined focused group passed 75 tests across six files. Native operator
readback and the complete customer walkthroughs remain separate acceptance gates;
these tests do not establish successful live registration, deployment or recovery.
