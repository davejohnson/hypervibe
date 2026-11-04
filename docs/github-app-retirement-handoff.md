# GitHub App registration retirement handoff

This bounded implementation opens GitHub's owner settings from the existing
`hv_spec` → `hv_plan` → `hv_apply` retirement path. It does not delete the App
through an undocumented API or claim that native deletion has been verified.
There were no live GitHub deletion calls in this work.

## Evidence and challenged assumptions

[GitHub's deletion guide](https://docs.github.com/en/apps/maintaining-github-apps/deleting-a-github-app)
requires the owner or an App manager to select the registration in settings,
choose Advanced, and confirm deletion. Deleting a registration uninstalls it from
all accounts; a Marketplace listing must be removed first. Accounts and source
repositories are not deleted. The [Apps REST API](https://docs.github.com/en/rest/apps/apps)
documents installation/token removal but not App registration deletion.

The initial real setup/callback → SQLite → retirement test failed because the
capability did not exist. After implementing the handoff, a real saved `hv_plan`
regression independently exposed a second assumption: the original declaration
uses `user`/`organization`, while GitHub's accepted identity uses
`User`/`Organization`. Literal subset comparison rejected the unchanged selection.
The optional provider-owned matcher normalizes only that documented owner type
and case-insensitive login. The shared path still requires the exact original
spec, declaration digest, repository, environment and retained creation records;
other providers keep the existing exact subset comparison. A final saved-record
counterexample showed that a different valid GitHub organization settings URL was
only rejected during pending observation. The parser now also binds that URL to
the exact retirement intent; the regression failed before this correction.

## Authority and recovery

The driver requires the original registration plan and historical evidence digest,
its exact successful capture attempt and evidence, customer/app/environment/source
scope, App/client/owner IDs and creation time. Before the first handoff it reuses
the original signed App inspection and webhook configuration read. It does not
substitute a public slug lookup after an authenticated read fails. App JWT
inspection establishes App identity, not the current person's owner permission;
GitHub's authenticated settings page enforces the latter.

Apply requires the exact destructive action confirmation, saves the attempt before
returning the provider-owned settings URL, and preserves original history and
encrypted custody. Personal and organization settings links are distinguished.
The management link has no invented expiry. Existing creation callbacks retain
their real expiry and are not reopened by retirement.

Any retained retirement attempt stays pending. Restart/status return the same
handoff without replaying creation, credential exchange or deletion. There is no
accepted retirement-completion evidence shape for this driver. Lost access,
401/403/404, changed permissions, a public page disappearing, an uploaded export or
an owner checkbox cannot unlock output-secret cleanup. [GitHub documents that 404
can conceal an authentication failure](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource).
A supported authenticated proof-ingestion path remains a release limitation.

## Executed offline boundaries

The normal Vitest suite exercises actual command planning/apply/status, signed
serialized GitHub reads, the loopback creation callback, encrypted SQLite custody,
confirmation, restart, organization/personal selection, identity/lifetime drift,
authentication failure without public fallback, changed source/evidence selection,
unsafe or cross-owner handoff URLs and forged completion rejection. Provider
responses are synthetic, derived from the documented contract. Passing these
checks does not establish live deletion or complete test-environment teardown.
