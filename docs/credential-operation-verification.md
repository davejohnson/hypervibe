# Verify the application operation after credential rotation

`hv_health project="app" credential="document-extraction"` reads the declared
operation receipts, checks their accepted rotation UUID and exact active provider
deployments, and records non-secret evidence. `hv_secrets view="inventory"` then
shows that evidence without fetching the application endpoint or executing a task.

Inventory's next action finishes the current accepted update before suggesting
another replacement: pending writes resume their exact saved `hv_apply` plan;
accepted configuration with pending deployment goes to `hv_status`,
`hv_ci_status`, and the existing managed rollout. A newer local candidate remains
visible without displacing that accepted input. Once every runtime consumer is
deployed, inventory directs the role to `hv_health credential="..."`, or to
declaring a meaningful check through `hv_spec`. One successful consumer or
traffic-only coverage never clears pending revocation or proves old instances
have retired.

Application checks are declared on the credential role through `hv_spec`. One
check must cover each runtime consumer; native database consumers are taken from
their accepted exact issuer/consumer mapping. A successful homepage response,
provider authentication request or deployment cannot satisfy a business assertion.

## Read an application receipt on any hosting provider

The HTTP path is provider-neutral and works with all registered hosting providers
when the exact bound workload and active deployment can be observed. It reads an
existing receipt from the application's bound HTTPS origin. It does not perform
invoice extraction, send email or invoke another business operation.
Workers and completed cron executions can expose their receipts through another
declared bound web service using `receiptService`; the receipt still names the
worker's deployment or exact completed execution, never the web relay deployment.

```json
{
  "verification": [{
    "kind": "http-receipt",
    "environment": "production",
    "service": "web",
    "path": "/operations/credential-receipt",
    "requiredCounts": { "invoiceExtracted": 1 },
    "maxAgeSeconds": 900
  }]
}
```

Run the application's actual operation through its normal authorized workflow.
Associate its receipt with the accepted credential plan UUID. The app exposes:

```json
{
  "version": 1,
  "role": "document-extraction",
  "operationId": "22222222-2222-4222-8222-222222222222",
  "deploymentId": "the-exact-native-deployment-identity",
  "completedAt": "2026-10-25T20:00:00Z",
  "status": "passed",
  "counts": { "invoiceExtracted": 1 }
}
```

The request supplies `X-Hypervibe-Credential-Operation` with the non-secret plan
UUID to select an existing receipt. The application must return the identity
captured by the actual operation, rather than treating a request header as proof
that an operation occurred. `hv_health` reports the expected operation and native
deployment identities when a receipt is missing, so the existing check can be
configured explicitly. Counts must represent the claimed business outcome: an
Anthropic models request is not `invoiceExtracted`, and SendGrid's accepted-send
response is not `emailDelivered`. Use a delivery event or the application's own
receipt when asserting delivery.

Redirects are not followed. Responses are bounded to 16 KiB. Only declared
numeric counts and matched identities/timestamps are retained; raw application
payloads, headers, logs and secret fields are discarded. Mismatched, expired or
future receipts remain unverified. A later failed assertion supersedes an older
successful receipt for the same accepted update and deployment.
Six inventory regressions also failed when the previous next-action selection
suggested another replacement before completing rollout or application checks,
or omitted incomplete consumer and old-instance coverage. They now follow the
existing update to its next unresolved step.

## Reuse a declared environment task

Where a declared `environment-task` is available, reference that existing task:

```json
{
  "verification": [{
    "kind": "environment-task",
    "environment": "production",
    "service": "web",
    "task": "verify-extraction",
    "operationIdInput": "credential_operation",
    "requiredCounts": { "invoiceExtracted": 1 },
    "maxAgeSeconds": 900
  }]
}
```

The task must declare the matching environment/service, a reviewed string input
named `credential_operation`, a bounded receipt prefix, and `invoiceExtracted`
among its allowed count keys. Dispatch the existing approved task with the
accepted plan UUID; `hv_health` does not dispatch it. Preview mode produces no
successful credential-operation evidence. The runner retains the immutable
managed release/image checks and observes exact native deployment identities
before and after execution. The task artifact contains only safe counts and
matched operation/deployment identities.

`hv_health` validates the exact managed workflow, successful original dispatch,
repository, branch, SHA, unique unexpired artifact, and its declared task identity
before accepting the artifact. Existing workflows must be reconciled through
`hv_spec` → `hv_plan` → `hv_apply` when upgrading. The generated helper is pinned
to the installed Hypervibe release so receipt producer and validator stay aligned.
The HTTP receipt path remains available when a cloud's declared private-task
execution capability is absent.

## Evidence boundaries and regression checks

The challenged assumption was that application operations must remain permanently
unknown because provider authentication and homepage health are insufficient.
The counterexample is a declared business receipt for the accepted rotation UUID
and exact native deployment, with bounded numeric assertions and complete consumer
coverage. The initial 13 regressions failed before the verification schema and
application path existed. The task regression failed because the prior artifact
contained no credential-operation identity. A later regression exposed stale
success hiding a newly failed assertion; it now rejects that stale evidence.

Tests exercise shared MCP/CLI handling, HTTP receipt parsing, exact identity and
time checks, all seven hosting names, native database consumer coverage, task
artifact selection, and the existing safe artifact transport. They are in ordinary
`npm test`. These are offline application/contract checks; no real invoice or email
was processed. Operation evidence does not revoke an old credential or turn
traffic-only coverage into proof that old processes have stopped.
