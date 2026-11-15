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
