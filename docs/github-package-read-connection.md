# Add package-read access without replacing GitHub API access

An existing verified GitHub connection can receive a separate classic
package-read PAT through the normal `hv_connections` interface:

```text
hv_connections provider="github" scope="owner/repository" credentialsRef="dotenv:/absolute/path/.env#NODE_AUTH_TOKEN" credentialsKey="packageReadToken"
```

Use the actual private file and key supplied by the owner; no renaming or
exporting the stored API token is required. This is the same command in MCP and
CLI, not a new connection mode. Input containing `apiToken` still replaces the
complete credential object under the existing add-and-verify behavior.

The secondary-only path requires an existing verified connection at that exact
scope. A wildcard/global connection is never silently copied into a requested
repository scope. GitHub verifies both tokens through read-only `GET /user`,
requires matching positive safe native user IDs, and verifies the new token's
`read:packages` or `write:packages` scope. Usernames may change; they do not
establish identity. The latest verified package username is retained for pulls.

Only after those probes succeed does one local transaction compare the original
encrypted connection, replace the package role, retain verified status and write
its field-specific acquisition audit. Concurrent primary rotation blocks the
write. Rejection, malformed/unknown observations and audit failure preserve the
old usable connection. Primary-token provenance stays with its original source;
the new dotenv reference applies only to `packageReadToken`. Credential values
and credential-derived fingerprints are absent from results and audits.

## Evidence and limits

The challenged assumption was that adding one secondary role requires
resupplying every credential. The counterexample is a valid stored API token
whose value is unavailable in the owner's new package-token file. The actual
MCP/reference/encryption/provider-transport regression failed before the update
capability and passed afterward. Independent review also reproduced unstable
username matching and over-redaction of public identity metadata; the native-ID
and exact-source regressions were observed failing before their fixes.

The expected provider responses are reconstructed from official
[authenticated-user documentation](https://docs.github.com/en/rest/users/users),
[scope-header documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps),
[username-change behavior](https://docs.github.com/en/account-and-profile/concepts/username-changes)
and [Container registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
They are not captured successful live updates. These checks prove authentication,
native-account agreement and a declared package scope, not SSO authorization,
access to any particular image, a successful download or a deployed application.

The existing accepted CI-role lifecycle was considered first. It can supply
already-created GitHub environment destinations, but refuses an absent target
environment. Initial managed CI synchronization creates that environment only
after its required image credentials are available. This feature avoids that
initial cycle without creating a GitHub environment, mutating a provider,
copying an API-management token into runtime, or changing deployment strategy.

## Provider review

| Registered deployment provider | Secondary-only credential update |
| --- | --- |
| GitHub | Implemented only for `packageReadToken` on an existing verified exact-scope connection. |
| GitLab | Unsupported by this capability; complete credential input remains required. |
| Railway | Unsupported by this capability; complete credential input remains required. |
| Cloud Run | Unsupported by this capability; existing explicit/native authentication behavior is unchanged. |
| ECS Express | Unsupported by this capability; existing AWS credential selection is unchanged. |
| Azure Container Apps | Unsupported by this capability; complete credential input remains required. |
| DigitalOcean | Unsupported by this capability; complete credential input remains required. |
| Fly | Unsupported by this capability; complete credential input remains required. |
| Vercel | Unsupported by this capability; complete credential input remains required. |

The roster and opt-in check run in ordinary `npm test`, alongside the actual
tool/reference/serialized GitHub regressions and role-provenance tests. The
committed acceptance workflow and desired required check run that suite and
type checking; repository files alone do not prove live branch protection.
