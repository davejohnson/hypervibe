# Credential form links

Reviewed 2026-10-24. This is a browser-form contract review, not evidence of
credential creation, successful provider access, or model instruction following.

The challenged assumption is that a static token template is complete whenever
it contains a name and permissions. Counterexample: connection setup knows the
GitHub scope `acme/storefront`, yet emits neither the supported owner parameter
nor a description identifying that scope. The user requirement is for Hypervibe
to build every supported known non-secret field, leaving only necessary manual
input to the person. Agents should preserve the generated link.

## Reviewed provider matrix

| Existing template provider | Supported fields and source | Remaining human work |
| --- | --- | --- |
| GitHub fine-grained PAT | [GitHub's form documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#pre-filling-fine-grained-personal-access-token-details-using-url-parameters): `name` (40 characters), `description` (1024), `target_name`, `expires_in`, and named permissions. | Select repositories; review permissions and organization policy; create/approve the token. A repository name is not a documented query parameter. |
| GitHub classic PAT | Existing `description` and `scopes` template retained. [VS Code's GitHub authentication implementation](https://github.com/microsoft/vscode/blob/main/extensions/github-authentication/src/flows.ts) independently constructs that exact path and those fields. This is primary integration source, not a published GitHub form schema. | Review expiry and scopes. Naming a repository in the note does not restrict classic token access to it. No new classic-only query fields are claimed. |
| GitLab PAT | [GitLab's form documentation](https://docs.gitlab.com/user/profile/personal_access_tokens/#prefill-personal-access-token-details): `name`, `description`, `scopes`, on the selected HTTPS instance. [Token API documentation](https://docs.gitlab.com/api/user_tokens/) limits the description to 255 characters. | Set expiration manually; review scope and token principal. Project/group/deploy token creation remains separate. |
| Cloudflare user/account token | [Cloudflare's template contract](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/): `name` and `permissionGroupKeys`; user templates also take `accountId` and `zoneId`. Account templates use the documented `to` path and omit those scope parameters. [Token schema](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/) limits names to 120 characters. | Select actual account/zone resources and optional permissions. A DNS domain does not establish native account/zone IDs. Description and expiry query parameters are not documented. |

These are the existing form-template providers affected by the change. Other
provider guidance retains its existing direct URL or provider-owned bootstrap;
this change does not claim query-prefill support for those providers.

Labels identify Hypervibe, the credential role, and known scope; project context
is a fallback label when the provider scope is unavailable. Scope metadata is
not an authorization receipt. Existing permission profiles and the existing
90-day fine-grained GitHub expiry stay unchanged. Only documented template
fields are emitted. Supplied credential values never enter URL construction.
Cloudflare Registrar reconnect guidance can reuse the independently stored
non-secret account ID; a domain alone still cannot supply a zone ID. Account
token templates never receive the user-template-only account/zone parameters.
The classic description and GitLab name caps are conservative product bounds,
not additional claims about their browser-form schemas.

## Validation

`src/tools/__tests__/connection-form-links.test.ts` exercises the real MCP server
and serialized SDK transport for discovery, first setup, and reconnect guidance.
No provider transport is mocked because no provider API is called by these
missing-credential paths. URL fields are derived from the independent sources
above. These tests run in ordinary `npm test`; the committed acceptance workflow
and desired acceptance commands both include that suite. Live branch protection,
authenticated browser forms, and actual agent responses remain separate checks.

Observed regression sequence: the first five MCP cases failed before runtime
changes (GitHub add/reconnect owner, GitLab instance, Cloudflare label, and
project discovery). Two further cases exposed missing project context in hints
and a duplicate GitLab command scope. The direct Railway app-scope, GHCR pull,
and Cloudflare Registrar cases also failed before their fixes. After isolating this PR from concurrent provider work, the baseline reproduced
30 failing connection checks before the runtime port; all 161 tests in four
focused connection/guidance/CI suites then passed. These checks
validate the emitted links and role consistency, not authenticated form loading.

Static GitHub adapter setup metadata and Railway log-only diagnostics retain
their role-specific generic templates: those boundaries do not know a reviewed
repository identity. Known repository context is now carried through connection
discovery/errors/hints, CI missing-credential guidance, apply blockers, and both
Railway repository help outputs. No repository identity is inferred from log
text.

## Local cloud authentication recipes

Reviewed 2026-10-27. Local/operator connection guidance now gives the agent
structured install and browser-login commands for AWS, Azure and Google. The
agent reuses a valid login, installs a missing CLI, starts browser authentication,
and leaves consent/MFA to the user. Existing profiles and account selections are
preserved; native scope verification and infrastructure plan/apply remain separate.
Hosted Connect Cloud customers do not need these local tools.

The challenged assumption was that default-credential support in the adapter
was sufficient while ECS and Azure setup still directed users to create keys.
The actual MCP describe response was the counterexample. Three missing-recipe
cases failed before implementation; an additional Azure case failed because its
primary example still required a client-secret file. The corrected MCP cases,
guidance roster and legacy workflow tests pass (41 tests). A separate full CI
run exposed the missing Entra guidance entry; its operator-only describe path now
explains transient Graph authority without inventing a saved connection.

Independent contracts: [AWS browser login](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html),
[Azure interactive login](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-interactively),
and [Google user ADC](https://docs.cloud.google.com/docs/authentication/set-up-adc-local-dev-environment).
macOS installation commands follow [Homebrew AWS](https://formulae.brew.sh/formula/awscli),
[Microsoft's macOS guide](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-macos),
and [Homebrew Google](https://formulae.brew.sh/cask/gcloud-cli).
AWS browser login requires CLI 2.32.0 or newer and existing
SignInLocalDevelopmentAccess authority; an existing IAM Identity Center profile
uses its own SSO login. No new policy, cloud resource, key, or CI/runtime export is
part of these recipes. Passing tests validates emitted guidance, not browser
consent, native account authority, or every package-manager installation.

## macOS companion setup

The companion now requests `hv_connections action="describe"` before presenting
a provider's setup form, including the current non-secret scope. This shared
read-only action returns the existing contextual `connectionSetup` and provider
metadata; it neither resolves credentials nor verifies access or creates a
bootstrap preview. Both MCP and CLI expose the same action.

Catalog and describe calls may opt into `repositoryContext: true`. Resolution is
bounded to the client's repository and explicitly read-only, with no legacy
fallback to an unrelated sole cached project. Explicit project selectors and
repository context cannot be combined. Unrecorded committed identities and
ambiguous roots block. A fresh repository's exact local Git origin can supply
form labels and owner prefill without initializing Hypervibe: `acme/storefront`
fills the GitHub token name, description, and owner. This inferred URL context
does not set a stored credential scope, create a project, or authorize ownership.
Malformed remote context blocks. Opening a form does not call `hv_spec`, whose
ordinary read can adopt edited desired state.

The challenged assumptions were that generic catalog links carry the selected
repository context, and that reading a spec is harmless identity discovery.
Regression evidence showed generic catalog calls omitted the project, catalog
resolution could initialize an unrecorded repository, and the first context
implementation called the adopting spec-read boundary. A further counterexample
was a fresh Git repository with a known origin but no Hypervibe spec: it still
received generic links. Each correction had an observed failing boundary test
before its runtime change. Focused checks include the real Swift SDK/subprocess
transport, unchanged journal/database writes, absent project records, fresh Git
remote labels, malformed remote rejection, and an unrelated sole cached project.
These checks do not create credentials or prove authenticated browser forms work.

The form preserves server-prepared URL bytes and refreshes after a provider or
scope change, hiding stale links until the current response arrives. Declared
cloud bootstrap/local-login capabilities lead to a coding-agent handoff;
manually supplying credentials remains an explicit option for users who already
have them. Interactive SwiftUI gestures and actual cloud/browser approval flows
are outside the automated boundary checks above.

`src/__tests__/packaged-mcp.test.ts` also emits the current runtime into a temporary
package, runs `npm pack`, and tests the extracted `dist/mcp.js` over real stdio
from an unrelated git repository with isolated state and no instruction files.
`scripts/smoke-mcp-package.mjs <package-directory>` is the reusable check for an
already built or extracted package. Its SDK sessions identify as Codex, current
and older Claude Code, and OpenCode to verify version, initialize profiles, the
complete guidance resource, and the same filled links in structured and human
output. Dependency installation is reused locally; no network install, provider
authentication, actual client program, or language model is exercised.

A separate actual Codex run exposed a further delivery gap: when asked to
connect GitHub for `acme/storefront` without existing credentials, it repeated
generic provider discovery and constructed its own labels. The tool description
and discovery hint now require a provider/scope-specific call before presenting
a human form, preserve provider-owned bootstrap precedence, and require copying
the returned recommended URL verbatim. Two MCP regressions covering those
surfaces failed before this instruction fix. Passing those checks proves the
instructions were delivered; a repeated actual model run is separate evidence
of whether that counterexample is resolved.
