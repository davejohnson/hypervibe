# Repository Actions variable contract

`source.json` identifies the immutable official GitHub REST OpenAPI source, its
SHA-256, and the exact extracted operations with transitive references. Tests use
the real `GitHubAdapter` request serializer with only `fetch` replaced. Examples
are reconstructed from the pin, not recorded live responses. The repository
example is completed with `language: null`, required by the source schema but
omitted from its own example. Failure, pagination and credential-echo fixtures
are explicitly synthetic. Tests never fetch schemas or require credentials.

The challenged assumption was that a successful response other than 204/202
always has JSON content. The official variable-create endpoint documents 201
without a structured acknowledgment; its pinned example is null. A native
`Response(null, {status: 201})` through the existing serializer failed with
`Unexpected end of JSON input` before the endpoint-specific empty-201 handling.
PATCH requires 204. Neither acknowledgment proves convergence; the shared
lifecycle must observe the selected key afterward and handle lost responses.

The inventory uses the documented maximum page size of 30 and repository limit
of 500, rejects changed totals, missing pages, duplicates and malformed required
fields, and returns only value hashes. The adapter's 256-character name bound is
a conservative local admission bound, not a claimed GitHub API limit. It verifies
the numeric repository ID, exact case-insensitive path and native scope before
each selected write; HTTP 404 never authorizes creating a repository or environment.
Supplied authority credentials echoed in projected metadata are rejected; plain
variable values are never returned. Writes cannot copy those authority credentials.

Pre-dispatch validation failures prove no mutation was sent. Native HTTP
400/401/403/404/422/429 responses are classified as rejected requests using
[GitHub's troubleshooting contract](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api):
bad input, authentication/permission failure, unavailable resource and rate
limiting. Only a fixed shared rejection error crosses the adapter boundary.
Transport errors, server failures and unexpected success statuses retain an
uncertain outcome and require readback. This avoids both blind retries after a
lost acknowledgment and permanently pending state after a documented rejection.

## Named CI-provider review

| Registered provider | Native contract and identity | Capability status |
| --- | --- | --- |
| `github-actions` | GitHub.com numeric repository ID plus owner/repository; case-insensitive variable name. Repository Variables read/write permission; complete GET inventory, POST 201, PATCH 204. | Implemented with offline transport and shared lifecycle coverage; live permission/convergence qualification remains untested. |
| `gitlab-ci` | Instance URL plus numeric project ID; project variables include key, environment scope, protected/masked/hidden/raw flags and `env_var`/`file` type. Same key may exist at different environment scopes. | Explicitly unsupported by this initial plain repository-variable facet. No inference from the separate GitLab CI variable implementation. |

Official contracts: [GitHub repository variables](https://docs.github.com/en/rest/actions/variables),
[GitHub naming and limits](https://docs.github.com/en/actions/reference/workflows-and-actions/variables),
[GitLab project variables](https://docs.gitlab.com/api/project_level_variables/).
GitHub documents no conditional compare-and-swap for these writes: pre-write
observation and post-write verification reduce drift risk but do not promise an
atomic transaction against concurrent administrators. Repository inventory does
not establish organization/environment precedence, workflow variable availability,
or successful execution. No secret, environment, deletion or workflow-dispatch
capability is introduced. Ordinary `npm test` includes the transport regressions;
checked-in CI does not by itself prove live branch-protection settings.
