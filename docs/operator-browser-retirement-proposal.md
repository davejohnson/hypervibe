# Operator registration retirement handoffs

Status: bounded handoff implementation, 2026-11-03. No provider writes, browser
deletion, live operator-state changes or native completion claims. Local tests
exercise saved-plan, apply and restart. Provider deletion verification is still
unavailable, so these registrations remain pending and private output cleanup
stays blocked.
Base: eb34b6c2c88461d56f08cb1d598e612cc02fe42d.

The user requires temporary operator setup to be retired through Hypervibe while
preserving shared accounts, projects/subscriptions and unrelated applications.
This operator-host setup is separate from ordinary customers' Connect Cloud flow.

## Independent provider evidence

- Google standard Web OAuth clients use the Google Auth Platform console.
  [Official management guide](https://support.google.com/cloud/answer/15549257)
  documents deletion from Clients and a 30-day recovery window. It also documents
  `deleted_client` after deletion; generic authentication errors do not prove it.
- [Google OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)
  says ordinary clients cannot be created or modified programmatically.
- [IAM workforce OAuth guide](https://docs.cloud.google.com/iam/docs/workforce-manage-oauth-app)
  explicitly restricts `projects.locations.oauthClients` to Workforce Identity
  Federation. Its delete API does not manage these standard Web clients.
- [Google web OAuth errors](https://developers.google.com/identity/protocols/oauth2/web-server)
  distinguishes `deleted_client` from `invalid_client` and `invalid_grant`.
  No automatic token issuance/error-probing procedure is established here.
- [GitHub App deletion guide](https://docs.github.com/en/apps/maintaining-github-apps/deleting-a-github-app)
  requires an owner or App manager to use registration settings and confirms that
  deleting a registration uninstalls it from all accounts. It does not delete code.
  A published Marketplace listing must be removed before the App can be deleted.
- [GitHub Apps REST API](https://docs.github.com/en/rest/apps/apps)
  documents App inspection and installation/token deletion. These do not establish
  an API for deleting an App registration. Unauthenticated/public 404 or an invalid
  App JWT after deletion cannot independently distinguish removal from lost access.
- [GitHub REST troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource)
  explicitly documents that 404 can hide a private resource when authentication
  fails. Missing installation or inaccessible App metadata cannot prove registration
  deletion. App JWT inspection also does not prove the current person's owner or
  App-manager permission; GitHub's authenticated settings page must enforce it.
- [GitHub security events](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/security-log-events)
  documents `integration.destroy`, including `application_client_id`, actor and
  integration/name fields; `integration_installation.destroy` is only uninstall.
- [GitHub security log review](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/reviewing-your-security-log)
  documents owner-browser review and JSON/CSV export. An uploaded export alone is
  not authenticated native proof and must not create a removal receipt.

## Current evidence boundary

Google setup records an exact imported configuration commitment, project/client
ID and callback. It explicitly labels native ownership and browser exchange
unverified. This is not permission to call an unrelated native deletion API.
GitHub setup verifies immutable App/client IDs, owner ID, creation time, retained
attempts and expected permissions via its App JWT before accepting registration.
Retirement must preserve those historical records and encrypted custody.

## Approved implementation shape

Use existing `mode=retire`, exact `retirement.from/targets`, original source/owner
selection, consumer-first gates, persisted attempts and `state=external` URL.
Do not introduce another journal or an owner checkbox that creates native proof.

Provider-owned drivers will produce an exact reviewed browser handoff. GitHub
reuses authenticated App identity/owner/lifetime observation before its settings
link. Google identifies the retained project/client and requires the operator to
verify actual ownership and the exact client in Google's authenticated console.
The provider enforces the operator's delete permission; Hypervibe does not assert
that imported configuration established it.

Apply must persist the external attempt before returning the owner link. Status
and restart expose the same pending handoff and perform only bounded reads, never
repeat deletion or a credential exchange. HTTPS provider management URLs do not
have a manufactured expiry; existing one-time local creation handoffs keep their
real expiry. A minimal optional expiry in the existing browser-handoff return type
is proposed, with exact provider URL validation remaining mandatory.

Show the exact App/client identity and material consequences at this operator
review. GitHub deletion affects all its installations. Google can retain a deleted
client for recovery; never claim permanent erasure. Shared accounts/projects are
preserved. Ordinary customers must not be told to own/create these operator clients.

## Completion is still pending

The supported initial slice must not return `retired`, forge a completed outcome,
remove custody/history or unlock output-container cleanup without independent
provider evidence. 401/403/404, invalid credentials, a checked box and an uploaded
JSON file are insufficient. Google owner verification should show the exact client
in Deleted credentials with retained recovery metadata; GitHub owner verification
should show the matching registration-deletion security event, not uninstall.
There is no authenticated browser evidence-ingestion contract in this proposal.
That concrete gap must remain visible, rather than presenting the handoff as a
complete teardown. Later owned-project deletion may subsume the Google client,
but that is a separate contract and is not assumed or implemented here.

## Required regressions before runtime changes

Exercise real saved-plan/apply/SQLite/restart paths with synthetic serialized native
transport only: exact historical target selection; second-environment and stale
declaration rejection; confirmation before external handoff; zero provider writes;
same pending URL on recovery; unsafe URL rejection; 401/403/404 remain unknown;
native ID/lifetime drift blocks; forged completion rejected; dependent output
deletion remains blocked. Keep these in ordinary `npm test`, run focused suites and
typecheck, and obtain independent source review. Offline checks are not live support.

## Implemented checks and remaining limit

The real Google import → SQLite → command regression first failed because the
retirement capability was absent. A second regression caught a generic failure
message after a valid handoff; pending apply now names the saved browser action
and unverified deletion. Tests cover exact project/reference/environment selection,
confirmation, restart without another attempt, unsafe or foreign links, rejected
fabricated completion, unchanged original custody/history and blocked output
continuation. Existing import behavior stays in the focused checks.

GitHub details and evidence are in [the companion contract](github-app-retirement-handoff.md).
The shared optional handoff expiry reflects provider management pages that do not
expire; existing local one-use registration forms still report and enforce their
real expiry. No provider API authority, hosted protocol or customer task changes.

Google imported configuration is explicitly unverified native ownership. The
operator must compare the exact client in the selected project before acting.
Google documents its Clients overview URL; no undocumented client-detail route is
constructed. A visible Deleted credentials entry is the specific owner observation
needed next, but the present implementation cannot authenticate or ingest that
observation as completion. An owner assertion or uploaded file does not unlock
cleanup. Google offers restoration for 30 days; no local timestamp claims that
permanent erasure occurred.

The tests are included by ordinary `npm test`; committed acceptance and desired
required-check configuration both include that gate. Live branch protection and
live registration deletion have not been verified by these offline checks.
