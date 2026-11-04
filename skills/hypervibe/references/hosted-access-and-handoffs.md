# Hosted access and private handoffs

Use these workflows only when the user requests hosted reporting, sharing
provider access, or a secret handoff. They are separate authorizations and do
not follow automatically from a deployment request.

## Connect hosted reporting

Use `hv_cloud_pair` with `action="start"` for the current repository. Present the
returned direct `verificationUrl` and offer to open it. After the user approves,
check `action="status"`. Follow pending or expired outcomes honestly.

The repository spec and selected code-host installation establish the project
context. Do not ask for a GitHub PAT, repository ID, or environment name when
this pairing flow supplies them. Pairing grants only its stated hosted access;
it does not authorize private secret retrieval, deployment access, or adoption.

## Continue approved cloud setup

For `hv_cloud_connections` purposes `connect-cloud` and `deployment-access`,
after the owner has approved the saved setup, the coding agent calls
`action="continue"` for that same environment. Do not add source, target,
credential or confirmation overrides. This advances only the exact saved
approval; it cannot create a pairing, approve a new scope or adopt resources.
The legacy monitoring and local secret-setup purposes do not support it.

Follow the closed `continuation` and `nextStep` receipt:

- `progressed` or `waiting`: the agent waits at least 10 seconds before another
  explicit continue. Increase the wait after repeated unchanged receipts and
  investigate persistent lack of progress; do not keep sending requests rapidly.
- `ready`: read `action="status"` to validate the final source or permission
  receipt. Setup completion alone grants neither deployment nor secret collection.
- `needs-sign-in` or `needs-review`: give the exact saved browser link for the
  actual identity or owner decision. Resume the same setup after that handoff.
- `blocked`: the agent reads status and diagnoses the reason. When present,
  `continuation.diagnostic` supplies the current setup stage and a closed reason;
  use it to investigate hosted access without blaming the person's account. Preserve uncertain
  attempts; a rejected write requires its separate supported review, not replay.

A failed or lost HTTP response is not permission to retry the POST. First read
status, then use only the explicit continuation supported by the saved record.
GET status is always read-only. Each continuation has a bounded server execution
budget; it does not start an unattended client polling loop. Completion counts
are newly recorded observations, and attempt counts are reservations that might
not have dispatched a write. Neither count proves which writes this call made.

Never make the person click “Check installation” or operate progress, reconcile
or retry controls. The agent handles supported routine work and diagnosis;
human handoffs are for sign-in, real choices and material new consent. Do not
claim that work started or finished without a supporting receipt.

## Share verified local provider connections

Use `hv_cloud_connections` for its separate browser approval. Start/check that
approval, obtain the exact destination preview, then connect only the approved
preview with its required confirmation. Preserve existing hosted connections.
Do not upload deployment credentials under a different role or copy them to
unapproved origins, projects, or destinations.

Only value-free outcomes should reach the user. A lost response or uncertain
handoff must be reconciled through the supported status/recovery path; do not
repeat a consuming exchange or declare success from an attempted request.

## Request or receive an externally owned secret

Use the current plan's eligible delegated input requirements and the available
`hv_cloud_requests` / `hv_cloud_secrets` actions. Request only what the current
task needs. Persist reviewed intent before sending an invitation and keep
invitation approval, private one-time import, and apply approval separate.

Offer the exact approval URL and explain the provider role, destination,
environment, and requested keys without values. The owner supplies the secret
privately; the agent never asks them to put it into the conversation. Existing
access or a lookalike resource is not evidence that this invitation completed.

For one-time import, verify the displayed destination and comparison evidence,
obtain the required receive confirmation, and follow the returned local
reference. Hypervibe must retain received material privately until the local
destination is committed. If a consuming response is lost, use supported
encrypted recovery or a separately approved new invitation; never retrieve a
second copy automatically. Do not replace accepted local values on an ambiguous
result.

A received secret does not deploy the application. Prepare a fresh reviewed plan
for the requested runtime changes, preserving separate environments and accepted
secret consequences. Report blocked, pending, revoked, expired, or unsupported
states explicitly.
