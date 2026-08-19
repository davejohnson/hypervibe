# General DevOps architecture and GitLab parity proposal

**Status:** Accepted architecture; the expanded mocked GitLab lifecycle is
`ready-for-live`, not yet `supported`
**Goal:** Establish provider-neutral code-hosting and CI/CD interfaces, migrate
GitHub onto them, and add GitLab as the second implementation without copying
the orchestration stack or pretending platforms have identical features.

The provider-neutral decisions in this document are incorporated into
`ARCHITECTURE.md`, which remains the source of truth. The first implementation
slice includes canonical `devops` selection, separate code-host/CI registries,
GitHub compatibility adapters, explicit GitLab project lifecycle, reviewed
whole-root GitLab configuration and teardown, environment-scoped physical
variables, exact-evidence rollback, trusted-runner selection, and portable
deploy recipes for every current non-native hosting adapter. Mocked lifecycle
contracts are green.

This is deliberately a lower evidence state than public support. No recent
live project create/delete, deploy, rollback, teardown, or self-managed runner
lifecycle is recorded yet. GitLab.com 18.1+ can use the exact hosted-runner
tag. Self-managed deploys require one exact locked project runner, one exact
online linux/amd64 manager, a dedicated uncontested tag, protected-ref-only
execution, and an explicit maintenance-note capability attestation. Repository
collaboration settings, Pages, security products, iOS release, database
seed/release jobs, and database restore drills remain outside this slice.

## Product decision

"GitLab support" means that a GitLab project can use the normal Hypervibe
loop:

1. `hv_spec` declares repository and deploy intent.
2. `hv_plan` observes the exact GitLab project, repository files, CI config,
   variables, pipelines, and relevant settings.
3. `hv_apply` changes only the explicit GitLab action in the persisted plan.
4. A person reviews and merges Hypervibe's infrastructure merge request.
5. Hypervibe verifies the merged CI config before syncing variables or
   dispatching dependent work.
6. `hv_ci_status`, `hv_ci_trigger`, `hv_rollback`, and `hv_status` use the same
   safe command contracts for GitHub and GitLab.

Parity means equivalent outcomes and safety, not identical provider features
or terminology. GitHub workflows map to GitLab pipeline configuration,
workflow runs map to pipelines, pull requests map to merge requests, and
GitHub environment secrets map to environment-scoped GitLab CI/CD variables.
Where GitLab has no safe equivalent, Hypervibe reports `UNSUPPORTED` or a
tier-specific block instead of silently weakening the requested policy.

GitHub and GitLab are implementations, not the abstraction. The interfaces
must also be able to admit another code host or CI system without editing every
hosting provider or duplicating lifecycle services.

## Keep the shape simple

There will be one DevOps application layer composed from separate code-host and
CI-provider capabilities:

```text
CLI ─┐
     ├─ command registry ─ DevOps application services
MCP ─┘                         │             │
                              │             └─ CI provider
                              │                ├─ GitHub Actions
                              │                ├─ GitLab CI
                              │                └─ future provider
                              │                       │
                              └─ code host            ├─ render config
                                 ├─ GitHub             └─ operate runs
                                 ├─ GitLab
                                 └─ future provider

hosting provider ─ neutral deploy recipe ─ CI program ─ CI provider renderer
```

Code hosting and CI execution are not assumed to be the same provider. GitHub
plus GitHub Actions and GitLab plus GitLab CI are the default bundles for the
first implementations. A future GitHub plus CircleCI or GitLab plus Buildkite
combination can be registered through compatibility metadata and capabilities,
without changing the desired-state loop.

The GitLab code-host and CI adapters own GitLab URLs, API payloads,
pagination, statuses, project-path encoding, tier detection, config syntax,
predefined variables, and response mapping. Generic tools, plan/apply code,
hosting services, and neutral deploy recipes do not import them or branch on
provider names.

The adapter uses GitLab's HTTPS API directly. Hypervibe does not invoke or
depend on `glab`, Git provider CLIs, browser automation, or GitLab connectors
for repository or infrastructure operations.

The current GitHub implementation is not wrapped in a second GitLab-shaped
service. Its portable behavior is extracted behind the shared ports, while
GitHub-specific behavior remains in the GitHub code-host and Actions adapters.

## Canonical desired state

A provider-neutral `devops` block becomes the canonical shape:

```json
{
  "version": 1,
  "project": "storefront",
  "gitRemoteUrl": "git@gitlab.com:acme/apps/storefront.git",
  "devops": {
    "code": {
      "provider": "gitlab",
      "scope": "https://gitlab.com/acme/apps/storefront"
    },
    "ci": {
      "provider": "gitlab-ci"
    },
    "canonicalEnvironment": "production",
    "projectFeatures": {
      "management": "managed",
      "collaboration": {
        "changeRequests": {
          "targetRef": "main",
          "required": true,
          "requiredReviews": 1
        }
      },
      "automations": {},
      "externalDefinitions": {},
      "dependencies": {},
      "security": {}
    }
  },
  "environments": {}
}
```

Provider ids are registry values, not a closed TypeScript union. The registry
defines provider capabilities, compatibility, suggested scaffold pairings,
and required connections. A schema enum must not need a release merely to admit
another code host or CI provider. The schema still enforces a bounded lowercase
provider slug; semantic validation requires a registered provider and requested
capabilities before planning can call it.

The existing top-level `github` block remains accepted during a compatibility
period and normalizes to `devops.code.provider: "github"`. It selects
`devops.ci.provider: "github-actions"` only when the pinned legacy spec actually
uses an application deploy, shared managed automation, restore drill, delegated
Actions secret, or another current application-CI capability. A Pages
publication workflow is a feature-scoped executor and does not select the
application CI provider by itself. A repository-only GitHub spec does not gain
a new CI connection requirement or
deployment authority merely by being normalized. Hypervibe must not add a
parallel top-level `gitlab` block: that would preserve GitHub coupling and
double every generic code path. This is a semantic migration, not a
property-spread or field rename. The canonical block must represent every
current GitHub capability:

| Legacy field | Canonical meaning |
| --- | --- |
| `github.enabled` | `devops.projectFeatures.management` (`managed` or `unmanaged`) |
| `github.repository` | the exact verified `devops.code.scope` |
| `github.canonicalEnvironment` | `devops.canonicalEnvironment` |
| `github.collaboration.issues` | `devops.projectFeatures.collaboration.issues` |
| `github.collaboration.pullRequests` | `devops.projectFeatures.collaboration.changeRequests`, with every review, status, admin, and target-ref policy preserved |
| `github.pages` | optional `devops.projectFeatures.pages` static-hosting outcome with explicit source/target bindings, its own optional publication executor, and DNS capabilities; it does not select the application CI provider |
| `github.actions` | `devops.projectFeatures.automations`, after mapping provider-neutral kinds and fields |
| `github.externalWorkflows` | read-only `devops.projectFeatures.externalDefinitions` bound to the same exact CI identity |
| `github.dependencies` | `devops.projectFeatures.dependencies` desired outcomes |
| `github.security` | `devops.projectFeatures.security` desired outcomes |

`projectFeatures.management` gates the repository-wide collaboration,
automation, Pages, dependency, and security bundle only. It never disables an
environment's selected CI deploy path, erases code/CI identity, or changes
`environments.*.deploy`. This distinction preserves the current meaning of
`github.enabled: false`. `unmanaged` means observe/preserve without adoption or
cleanup; removing previously owned project features requires explicit desired
removals and plan actions rather than flipping this compatibility switch.

Canonical automation terminology uses `change-request-review` and
`draftChangeRequest`; the legacy `pull-request-review` and `draftPullRequest`
spellings normalize to those meanings. Checks, autofix, audit, dependency,
security, and Pages fields are carried field-for-field through fingerprints and
round trips, but only execute when the selected providers advertise the exact
required capabilities. They are never assumed equivalent by matching a feature
name. The word "actions" is not retained as the generic name for CI jobs or
repository automation.

The older deprecated top-level `collaboration` shape is part of the same
compatibility chain: when it is the only legacy DevOps block, its existing
canonicalization runs first and the resulting GitHub semantics then normalize
to `devops`. If top-level `collaboration` coexists with `github` or `devops`,
Hypervibe keeps the stored document readable under pinned legacy behavior but
does not guess precedence or write a canonical merge. The next spec update
blocks with an explicit patch asking the user to resolve the overlapping
authority.

A stored spec cannot contain both legacy `github` and canonical `devops`
blocks. That is a validation error rather than a field-by-field merge with
unclear precedence. Reading a legacy spec produces one explicit canonical
in-memory model; the next intentional spec write upgrades it atomically while
preserving its revision/hash history and round-trip semantics. A legacy field
with no canonical representation blocks the write; it is never dropped into an
opaque provider-extension bag or silently reset to a default.

`gitRemoteUrl` remains the source used for cloning and deploy source metadata.
`devops.code` explicitly selects the code-host provider and repository scope.
They must resolve to the same host and repository or planning blocks.
`devops.ci`, when present, independently selects the CI provider, which must
declare compatibility with that code-host identity. It is optional for a
code-host-only project and required before any primary managed CI definition,
variable, run, application deploy, shared CI-backed automation, or
release-evidence operation.

Project features can declare a feature-scoped executor when their lifecycle
requires one. In particular, `devops.projectFeatures.pages` selects a static
hosting outcome independently from `devops.ci`; GitHub Pages remains a hosting
option whether the application deploys through GitHub Actions, another CI
provider, or no application CI at all. A GitHub Pages publication may use a
bound GitHub Actions executor, but that executor owns only the Pages
publication definition and credentials. It cannot own application deploy
variables, release evidence, promotion, or rollback. The same separation
allows a future Bitbucket-hosted static site or another code-host publication
mechanism without pretending it is the project's primary CI.

The Pages feature records three identities independently: the content source
repository/ref, the provider-native static-hosting target, and an optional
publication executor. The hosting target may be the application repository,
another bound repository, or a provider-managed site identity. It is never
inferred from a matching slug or workspace. Creating, writing, or deleting a
separate publication repository remains explicit desired-state lifecycle work
with its own ownership, confirmation, and plan actions; a Pages renderer cannot
bootstrap it as a helper side effect.

When present, `devops.ci` is intentionally one primary managed release
authority, not an array. Other CI systems may be declared as read-only external
evidence sources, but two providers cannot both own deploy configuration,
variables, release evidence, or rollback for the same environment. Any future
per-environment CI selection must be explicit and prove non-overlapping
ownership; Hypervibe does not fan out a deploy to every connected CI provider.
Feature-scoped executors are likewise explicit, have disjoint managed-file and
secret bindings, and are not alternate release authorities.

Changing `devops.code.provider`, code scope, or `devops.ci.provider` is a
migration, not an in-place string update. A CI cutover first removes/inerts and
drains the old managed definitions, verifies no active runs, deletes only old
owned variables, and proves old authority absent before the new provider can
receive config or secrets. A code-host change requires an explicit repository
migration/import contract. A changed remote URL never silently rebinds code or
CI identities or leaves two systems able to deploy the same environment.
Historical old-provider release metadata may remain read-only, but rollback
authority does not cross CI providers and the new provider starts with no
verified release history until its first successful exact-SHA release.

Each cutover operation is a separate persisted plan action with explicit
dependency edges and its own stale observation. A blocked, failed, pending, or
unknown removal stops the cutover before the next mutation. Apply never treats
"switch provider" as blanket authority to clean up everything on the old
provider or bootstrap everything on the new one.

Code/CI provider ids, scopes, compatibility identity, program version, and all
declarative fields participate in desired fingerprints, persisted action stale
checks, receipts, and durable bindings.

Existing deploy-only GitHub specs without `devops` retain one fixed
compatibility mapping to GitHub plus GitHub Actions. That mapping is versioned
legacy behavior, not a mutable registry default. New GitLab and future-provider
specs must persist `devops.code` before a repository mutation and both
`devops.code` and `devops.ci` before any CI, variable, deploy, or release
mutation. A recognized remote may let `hv_spec` suggest/populate that patch,
but `hv_plan` never infers new deployment authority from a URL or local binding.

`suggestedCiProvider` is therefore scaffolding metadata, not apply-time intent.
Changing a registry default affects future suggestions only and cannot migrate
an existing project. Non-default combinations and repository collaboration,
automation, security, or Pages features likewise require the explicit
`devops` block.

Delegated secret targets become provider-neutral, for example
`ci.repository` and `ci.environments`. The legacy `githubActions` target is
accepted and normalized for existing GitHub specs. New GitLab behavior is not
added under a second secret target with different semantics.

## Code-repository identity and connections

GitLab projects can live in nested groups, so `group/subgroup/project` is a
single path, not an `owner/repo` pair. The canonical GitLab connection scope is
the project web URL without a trailing `.git`:

```text
https://gitlab.com/acme/apps/storefront
```

For a self-managed instance, the instance host is part of the scope:

```text
https://gitlab.example.com/acme/apps/storefront
```

Self-managed connections also require an explicit non-secret `instanceUrl` in
their credential document. This supports GitLab mounted under a relative path,
custom ports, and web/SSH hosts that differ. The adapter never derives an API
base by stripping segments from the project URL or probing parent paths. It
uses the declared instance URL, resolves the project through the API, and
matches `gitRemoteUrl` against the provider-returned HTTP/SSH clone URLs.

Connection verification resolves that selector to provider-owned identity:

```ts
{
  provider: "gitlab";
  instanceUrl: "https://gitlab.com";
  projectId: 12345678;
  pathWithNamespace: "acme/apps/storefront";
  defaultBranch: "main";
  webUrl: "https://gitlab.com/acme/apps/storefront";
  httpCloneUrl: "https://gitlab.com/acme/apps/storefront.git";
  sshCloneUrl: "git@gitlab.com:acme/apps/storefront.git";
}
```

The numeric project id is the durable binding. The instance URL and current
path are stored beside it because ids are instance-scoped and paths can be
renamed. Observation resolves a binding by instance plus project id first. A path
match is only an adoption candidate; ambiguous or mismatched identity blocks
rather than choosing a project or silently rebinding it. GitLab's [Projects
API](https://docs.gitlab.com/api/projects/) exposes the numeric id,
`path_with_namespace`, default branch, and CI config path needed for this
contract.

The GitHub migration follows the same rule: bind the provider-native repository
id plus owner/name scope and use owner/name only as the mutable selector shown
to users. The general code-host interface does not preserve GitHub's current
path-only identity shortcut.

The Git remote parser is provider-neutral and returns normalized transport,
host, optional port, and repository path for HTTPS and SSH/scp-style remotes.
Provider resolution is a registry/verified-connection concern, not a list of
`if github.com` branches inside the parser. Nested groups, custom SSH hosts,
ports, and self-managed clone URLs are matched against provider-observed
identity. Unknown hosts stay unknown; they never default to either provider.

### Credential contract

The operational credential is an API token supplied through
`credentialsRef`. Full repository management requires the `api` scope and a
Maintainer-equivalent role on the exact project. GitLab documents that `api`
grants read/write API access within the token's own scope.

On GitLab.com Premium or Ultimate, a project access token is preferred because
it is project-scoped. GitLab.com Free does not offer project access tokens, so
the fallback is a personal access token. Self-managed and Dedicated instances
offer project access tokens on all licenses, subject to instance policy. These
edition differences come from GitLab's [project access token
documentation](https://docs.gitlab.com/user/project/settings/project_access_tokens/).

GitLab officially supports pre-filled personal-token URLs. Hypervibe guidance
uses:

```text
https://gitlab.com/-/user_settings/personal_access_tokens?name=Hypervibe&description=Manage+GitLab+repository+and+CI+with+Hypervibe&scopes=api
```

The user must choose an expiry and ensure the token's user has access only to
the intended resources. The prefill contract is documented in GitLab's
[personal access token guide](https://docs.gitlab.com/user/profile/personal_access_tokens/).
Project-token guidance links to the exact project's
`/-/settings/access_tokens` page, names the Maintainer role and `api` scope,
and calls out the GitLab.com tier requirement.

For self-managed GitLab, guidance builds the same officially documented PAT
template path from the verified `instanceUrl`, preserving any relative base
path, and builds the project-token link from the provider-returned project web
URL. It does not send a self-managed user to GitLab.com or invent undocumented
dashboard parameters.

The safe connection examples are:

```text
hv_connections provider="gitlab" scope="https://gitlab.com/acme/apps/storefront" credentialsRef="env:HYPERVIBE_GITLAB_TOKEN"
```

```text
hv_connections provider="gitlab" scope="https://gitlab.example.com/gitlab/acme/apps/storefront" credentialsRef="file:/absolute/path/gitlab-connection.json"
```

For that self-managed example, the local JSON document contains `apiToken` and
`instanceUrl: "https://gitlab.example.com/gitlab"`. It is never committed or
returned. GitLab.com uses the fixed official instance URL and can use the
single-token environment reference shown above. A self-managed private CA is
supplied through an explicit local CA-certificate reference; Hypervibe never
implements support by disabling TLS verification.

The adapter verifies the token with bounded user and project requests. It
returns safe principal, project, role, instance origin, and capabilities that
were actually observed. Tokens and raw credential-bearing responses never reach
receipts, errors, logs, MCP structured content, or CLI JSON.

## DevOps provider capabilities

There is deliberately no large `IDevOpsProvider` or "source control provider"
interface. That would bind code hosting to CI execution and make partial
support look complete. The provider registry exposes small capability facets:

```ts
type CodeHostProviderId = string;
type CiProviderId = string;

interface CodeHostCapabilities {
  identity: CodeRepositoryIdentityPort;
  repositories?: CodeRepositoryLifecyclePort;
  files?: CodeRepositoryFilesPort;
  refs?: CodeRepositoryRefsPort;
  changeRequests?: ChangeRequestPort;
  issues?: IssueTrackerPort;
  commitStatuses?: CommitStatusPort;
  containerRegistry?: ContainerRegistryPort;
  collaboration?: RepositoryCollaborationPort;
  pages?: RepositoryPagesPort;
  security?: RepositorySecurityPort;
}

interface CiProviderCapabilities {
  identity: CiExecutionIdentityPort;
  render?: CiConfigurationRendererPort;
  configuration?: CiConfigurationObservationPort;
  variables?: CiVariablePort;
  runs?: CiRunPort;
  jobs?: CiJobPort;
  logs?: CiLogPort;
  artifacts?: CiArtifactPort;
  releaseEvidence?: CiReleaseEvidencePort;
  dispatch?: CiDispatchPort;
  deploymentAuthorization?: CiDeploymentAuthorizationPort;
  schedules?: CiSchedulePort;
}
```

Only identity is universal. Every other facet is optional and independently
registered, tested, and reported. A read-only CI integration is not forced to
pretend it can render configuration or mutate variables, and a code host is
not treated as writable merely because its repository can be observed.
Repository create/settings/delete is its own lifecycle facet; file or ref
capabilities cannot create a missing project as a bootstrap side effect.
Repository deletion is data-bearing, exact-action-id confirmed, retry-safe,
terminally observed, and removes bindings only after proven absence. The local
deletion-attempt marker is written before the provider call, so a scheduled
self-managed deletion followed by a failed permanent-removal request retains
its durable identity and can only continue through another confirmed exact-id
destroy action.

A provider registration may contribute code-host capabilities, CI
capabilities, or both. GitHub and GitHub Actions can share an HTTP client and a
connection; GitLab and GitLab CI can do the same. Shared authentication is an
implementation detail declared by registry metadata, not a reason to collapse
the ports. Connection requirements are a list because a provider may reuse the
code-host connection, require its own scoped connection, require an additional
registry credential, or require none. Generic services resolve those declared
requirements and do not special-case one connection provider.

Default pairing and compatibility are registry contracts, not conditionals:

```ts
interface CodeHostRegistration {
  id: string;
  suggestedCiProvider?: string;
  capabilities: CodeHostCapabilities;
}

interface CiProviderRegistration {
  id: string;
  connectionRequirements(
    repository: CodeRepositoryIdentity
  ): CiConnectionRequirement[];
  observeCompatibility(
    repository: CodeRepositoryIdentity
  ): Promise<Observation<CiRepositoryCompatibility>>;
  capabilities: CiProviderCapabilities;
}
```

The CI provider must prove its exact external execution-scope/definition
identity and binding for the selected code repository. A compatible host name
or matching repository path is not enough to authorize CI mutations.

Bindings persist code-repository identity and CI execution identity separately,
including each provider id, native durable id, and provider scope. Bound CI
configuration locations are recorded separately and point to one of those
durable code identities or to a provider-managed definition identity. Even when
GitHub or GitLab uses the same numeric/string project for several facets,
Hypervibe does not infer that the capability identities are interchangeable.

The CI registry also declares compatibility and feature capabilities such as
repository-file configuration, manual inputs, schedules, artifacts,
environment-scoped variables, concurrency, runner requirements, and workload
identity. Runner operating systems, architectures, and execution capabilities
are registered values rather than a closed GitHub/GitLab union. The application
compares a requested CI program with those observed capabilities before it
plans files or variables. Missing support returns `UNSUPPORTED`; no renderer
silently drops a requirement.

The generic configuration capability does not assume that every provider has
independent workflow files or a safe include mechanism. It observes an ordered
configuration-authority graph: the bound root or provider-managed definition,
imports/includes, provider settings, and any repository-, workspace-, or
organization-level transformation layers that can change the effective
pipeline. Supported ownership modes include whole-root ownership, a
provider-proven composable include, and provider-managed definitions. Those
modes are capabilities, not fallback strategies. Unknown authority or an
unobserved transformation layer blocks privileged config, secrets, dispatch,
and release evidence even when the repository file itself has the expected
hash.

The variable and dispatch capabilities similarly expose provider semantics,
not just CRUD endpoints. Variable observation includes every relevant
precedence layer, scope matching behavior, and whether a returned value is
plaintext, redacted, omitted, or unknown. Dispatch observation declares the
bound reviewed definition source, exact-revision/ref support, accepted input
types, precedence of trigger-time values, and whether control values can be
shadowed. Hypervibe never uses an API mode that supplies raw CI configuration
at dispatch time because that bypasses the reviewed configuration boundary.

Every observation returns `present`, `absent`, or `unknown`. Only a
provider-confirmed not-found response proves absence. Permission errors,
unsupported licensed features, incomplete pagination, timeouts, and GitLab
failures remain unknown or unsupported and block affected mutations.
Hypervibe does not infer a GitLab edition or missing capability from an
ambiguous `403` or `404`; when entitlement cannot be proven, the requested
feature remains unknown and planning blocks.

"Self-managed GitLab" is not one timeless target. Public support metadata names
the tested GitLab version floor/range and required observed capabilities.
Unknown or older instances can still connect for the facets they prove, but do
not inherit a blanket managed-deploy support claim from GitLab.com evidence.

Normalized identities retain provider-native ids: GitLab project id, merge
request IID plus project id, pipeline id, job id and execution attempt, variable
key plus environment scope, and Pages/domain ids where available.

Run and job observations preserve `nativeStatus` beside a small normalized
phase (`queued`, `running`, `succeeded`, `failed`, `canceled`, `skipped`, or
`unknown`). Only explicitly mapped provider terminal states can become
`succeeded`; new, unrecognized, partial, canceling, manual, or blocked states
remain non-successful and cannot establish release evidence.

## Reviewed code-repository changes

Hypervibe continues to publish repository infrastructure through one ordinary,
human-reviewed change request. For GitLab this is a merge request from a
deterministic `hypervibe/gitlab-infrastructure` branch.

The adapter uses GitLab's [Commits
API](https://docs.gitlab.com/api/commits/) to create one atomic commit with
explicit create, update, and delete file actions, then uses the [Merge Requests
API](https://docs.gitlab.com/api/merge_requests/) to create or reuse the exact
canonical merge request. It never merges it.

Branch reuse follows the same safety rules as GitHub: fast-forward ordinary
merged work, accept squash/rebase only when GitLab proves the branch head came
from the exact merged canonical merge request, and block extra commits,
duplicate open merge requests, closed-unmerged work, partial observation, or
an unexpected target branch.

Hypervibe owns only files listed in a provider-neutral manifest such as
`.hypervibe/repository-manifest.json`. A legacy GitHub manifest remains
readable during migration. Cleanup is limited to previously owned files.

The persisted repository-change action records the exact code-host identity,
base ref/SHA, deterministic branch, change-request identity when reused, and
every file operation with its content hash. Apply re-observes those identities
and may commit only that recorded file set. A renderer change, base-branch
advance that invalidates the planned patch, new commit on the managed branch,
or different merge request makes the action stale; apply does not re-render a
new patch under old authorization.

## GitLab CI configuration ownership

GitHub supports many independent workflow files. GitLab compiles one active
root CI configuration. Its observed project `ci_config_path` may be customized;
`.gitlab-ci.yml` is only the provider default. GitLab supports local includes
that are merged with the active root. The official [include
contract](https://docs.gitlab.com/ci/yaml/includes/) also allows the root file
to override included keys, so file presence alone is not enough to prove the
managed jobs are active.

Hypervibe owns generated files under:

```text
.gitlab/hypervibe/manifest.yml
.gitlab/hypervibe/deploy-<provider>-<environment>.yml
.gitlab/hypervibe/check-<id>.yml
```

The root contract is deliberately narrow:

- Hypervibe first observes the exact active root path. Unknown or unsupported
  `ci_config_path` observation blocks; it never assumes `.gitlab-ci.yml`.
- The MVP supports a root file in the bound code repository. An external
  project/ref CI config is a different code-host identity and returns
  `UNSUPPORTED`; Hypervibe does not write its managed include into the wrong
  repository or follow an unbound config project.
- If the active root file is provider-confirmed absent, the reviewed
  infrastructure merge request may create a Hypervibe-owned file at that exact
  path containing the local include.
- If Hypervibe already owns the root file, it reconciles it normally.
- If an unmanaged root file exists, Hypervibe does not parse and rewrite it.
  Planning blocks with the required local include and explains that the user
  must append it to an existing `include` collection rather than create a
  duplicate top-level YAML key:

  ```yaml
  include:
    - local: '/.gitlab/hypervibe/manifest.yml'
  ```

- Hypervibe never changes the project's `ci_config_path` to bypass or replace
  an existing pipeline.
- Teardown removes an owned root and its managed files through the reviewed
  merge request. With an unmanaged root, Hypervibe first leaves a minimal,
  inert, valid managed manifest containing one namespaced visible job whose
  only rule is `when: never`, a fixed no-op script, and no variables, secrets,
  image, services, hooks, tags, environment, artifacts, or dependencies. It then
  blocks with exact include-removal guidance. A hidden-job-only config is not
  considered valid. Hypervibe deletes the manifest only after observation
  proves the include is gone. It never strands an include that points at a
  missing or invalid file.

CI teardown is dependency ordered: first remove or inert the managed jobs and
verify their effective absence, then verify that no managed run/job is active,
then delete exact owned CI variables, then remove local bindings. Failure or
unknown observation at any stage stops the later stages; Hypervibe does not
delete credentials while an unverified managed job may still reference them.
Variable deletion is not presented as revocation of a value already delivered
to a runner; exposed or suspect credentials require provider-side rotation.

Generated job ids are namespaced, such as
`hypervibe:deploy:railway:production`, to avoid accidental collisions. After
merge, Hypervibe calls GitLab's [CI Lint
API](https://docs.gitlab.com/api/lint/) at the exact default-branch commit.
Managed GitLab jobs disable inheritance of root defaults and global YAML
variables where GitLab supports it, then explicitly declare their image,
services, hooks, before/after scripts, runner tags, permissions/identity,
environment, cache, and failure behavior. The renderer does not let an
unmanaged root silently prepend code or widen credentials through defaults.
Managed jobs are self-contained: they do not use YAML anchors, `extends`, or a
root-defined template whose resolution Hypervibe would have to reproduce.

Activation observation also records the complete include graph. Local includes
must resolve at the exact pipeline commit; cross-project includes must use an
immutable full revision; remote/component includes must provide a
provider-supported integrity or immutable-version guarantee. An unresolved or
mutable external include can change effective privileged jobs without a code
commit, so it blocks managed deploy secrets and release evidence even when a
one-time lint currently looks correct.

The merged configuration must be valid. Hypervibe asks GitLab CI Lint for the
most authoritative simulation the observed instance supports, setting
`content_ref` to the immutable full commit SHA, `dry_run_ref` to the declared
canonical branch context, and `include_jobs` to true. It rejects a response
whose resolved content or simulated pipeline does not correspond to the
planned SHA and re-observes that SHA before dependent actions. GitLab, not
Hypervibe, is the authority that resolves includes and job inheritance. The
adapter compares the returned effective job fields with the neutral program,
and performs a bounded strict parse of merged YAML only to verify the final
self-contained managed job, include graph, global pipeline gates, and absence
of unexpected keys. It does not implement a second GitLab merge/rules
evaluator.

Size, depth, alias, and custom-tag limits apply to that parse. Security-relevant
fields include rules, inheritance, defaults, image, services, hooks,
before/after scripts, needs, runner selection, permissions, identity tokens,
logical variable references, environment, cache, artifacts, timeouts, and
failure behavior. If GitLab's dry-run response and strict final-job definition
cannot prove one of them, activation is `unknown` and blocks. Hypervibe compares
the proven semantics with its locally rendered program fingerprint; it never
trusts a marker or hash embedded in repository YAML by itself. Raw merged YAML
is never returned or logged. A file merge is therefore an input to
verification, not proof that the pipeline is active.

If required typed inputs prevent CI Lint from simulating a dispatch path, the
adapter does not invent defaults or skip activation proof. It may plan one
explicit post-merge validation-pipeline action whose typed `validate` mode
disables every provider mutation and receives no deploy, registry, database, or
code-host credential. That canary is allowed only when Hypervibe owns the
entire active root or the CI provider proves it can isolate the validation
definition; Hypervibe never triggers every job in an unmanaged root as a
"test." Only provider-observed validation jobs may then complete activation. If
neither dry-run nor that credential-free isolated canary proves the required
semantics, the program remains unsupported.

## Deploy pipeline contract

Hosting providers own deploy behavior, but they do not own CI-platform syntax.
Each hosting adapter emits a versioned, provider-neutral deploy recipe. The
shared CI compiler adds triggers, promotion rules, applied-spec gating,
concurrency, and release evidence to produce a neutral CI program. The selected
CI adapter renders that program and operates its runs:

```ts
interface ProviderDeployRecipe {
  version: 1;
  provider: string;
  target: BoundDeployTarget;
  assets: Array<{ path: string; content: string; executable?: boolean }>;
  jobs: ProviderDeployJobRecipe[];
  diagnostics?: CiDiagnosticRule[];
}

interface ProviderDeployJobRecipe {
  id: string;
  purpose: "build" | "deploy" | "verify";
  needs: string[];
  runner: {
    os: string;
    architecture?: string;
    capabilities: string[];
    trust: "provider-hosted" | "bound-self-hosted";
  };
  secretRefs: LogicalCiValueRef[];
  variableRefs: LogicalCiValueRef[];
  steps: CiStep[];
  timeoutMinutes: number;
}

interface CiProgram {
  version: 1;
  id: string;
  triggers: CiTrigger[];
  concurrency?: CiConcurrency;
  inputs: CiInput[];
  jobs: CiJob[];
  evidence: CiReleaseEvidenceContract & { retentionDays: number };
}

interface CiConfigurationRendererPort {
  provider: string;
  observeCapabilities(): Promise<Observation<CiRendererCapabilities>>;
  render(
    program: CiProgram,
    target: CiRenderTarget
  ): CiRenderedConfiguration;
}
```

`BoundDeployTarget` contains only non-secret, already-observed provider ids,
scope, service names/ids, desired revision fields, and environment metadata.
It never carries a provider client, API token, connection object, generated
credential, or runtime secret into the recipe/compiler boundary.

Rendering is pure and side-effect-free. `CiRenderTarget` is the non-secret,
planned snapshot of the exact CI identity, version/features, configuration
mode, and capability fingerprint produced by observation. Apply re-observes
that snapshot for staleness; the renderer never performs network discovery or
chooses a different syntax/capability while applying an authorized plan.

`CiStep` is a small semantic instruction set for checkout, runtime setup,
container build/push, cache use, artifact publication, an unprivileged
repository command, and invocation of a fingerprinted provider-owned asset. It
has no free-form privileged shell-text variant. Repository commands are allowed
only in build/test jobs with no deploy credentials. A deploy step names an
owned asset plus typed argument and environment references; dynamic values are
passed as data/argv entries rather than concatenated into a command.
Environment inputs reference logical secret or variable names; they never
contain GitHub expressions, GitLab predefined variables, or raw provider YAML.
Provider-owned executable assets may contain provider API logic, but receive
only explicitly mapped inputs and must obey the same action scope.
Recipes, programs, assets, fingerprints, and rendered repository files are
deterministic and secret-free; secret values enter only through encrypted plan
inputs or verified CI-variable connections during the exact apply action.
Asset paths are normalized relative paths inside the Hypervibe-owned prefix;
absolute paths, traversal, symlinks, duplicate paths, and writes over user-owned
files are rejected. Per-file and total generated byte counts are bounded before
the content enters a plan or provider request.

Program and recipe versions are explicit compatibility boundaries. A renderer
must reject an unknown version, step kind, field, or required semantic; it
cannot ignore it and render a partial pipeline.

Runtime and tool requirements are typed semantic setup steps with pinned
versions, not arbitrary package names that a renderer installs. Jobs and steps
have explicit bounded timeouts and fail closed by default; retry and
allow-failure behavior must be declared by the program rather than inherited
from a CI platform default.

The CI adapter maps semantic triggers, inputs, runners, variables, artifacts,
and steps to its platform. GitHub Actions maps the exact source revision to
`github.sha`; GitLab CI maps it to `CI_COMMIT_SHA`. Those names never appear in
a hosting provider recipe or generic deploy service.

Renderers build configuration from a structured model and an audited YAML
serializer, not string interpolation. Job ids, branches, environment names,
paths, inputs, and values are validated before serialization; duplicate keys,
name collisions, YAML tags/anchors from user input, and expression injection
are rejected. Any renderer-owned action, image, or reusable component is pinned
to an immutable digest or full revision where the platform supports it, and
its update changes the reviewed configuration fingerprint.

Rendered configuration is also provider-neutral at the service boundary:

```ts
interface CiRenderedConfiguration {
  provider: string;
  managedFiles: Array<{
    configurationLocationBinding: string;
    path: string;
    content: string;
  }>;
  configurationIntents: CiConfigurationIntent[];
  activation: CiConfigurationActivationContract;
  requiredCapabilities: string[];
  fingerprint: string;
}
```

For a file-backed CI provider, compatibility observation resolves each
non-secret configuration-location binding before render. The location normally
points at the selected source repository, as it does for the GitHub and GitLab
MVPs, but a future explicitly declared config repository can be a different
durable code-host identity with its own connection and ownership. The renderer
may reference only those planned bindings; it cannot select or discover a
repository. The DevOps application service sends each file through that bound
code host's files/change-request ports, and the CI adapter then observes its own
activation contract at the exact merged commit. A future provider-managed CI
definition can implement configuration actions through `configurationIntents`
behind the same CI capability without pretending those actions are repository
files. Each provider setting becomes its own observed plan action with safe
normalized metadata; the intent is not a bag of raw provider API fields or an
authorization to mutate unrelated project settings.

`activation` is an effective-configuration contract, not an "included file"
contract. It names the required whole-root/include/provider-managed ownership
mode, exact definition revision, ordered imports and transformation layers,
provider validation evidence, and the final privileged-job semantics that must
be proven. A provider-specific validator or isolated credential-free canary may
establish that evidence; the application never assumes a universal YAML lint
endpoint. An adapter that can observe the source file but not a later
configuration transformer may still support unprivileged status inspection,
but not managed deployment authority.

The non-secret CI binding records the exact CI identity, code commit, program
version/fingerprint, rendered configuration fingerprint, activation evidence,
and managed definition ids/paths. It does not store YAML bodies, tokens,
variable values, or artifact contents. Missing binding with live config is an
explicit adoption/collision case, never silent ownership.

There is no raw-platform escape hatch in `ProviderDeployRecipe`. If the
neutral program cannot represent a required behavior, planning returns
`UNSUPPORTED` until a reviewed semantic capability is added. This keeps a new
CI provider from requiring changes to every hosting adapter and keeps a new
hosting provider from implementing one workflow generator per CI platform.
The program is not an attempt to model every vendor YAML keyword or force a
lowest common denominator; it models Hypervibe's declared CI semantics, and
capability negotiation makes richer or missing provider support explicit.

### Privilege separation

Secret grants are job-scoped. Build and test jobs execute repository code but
receive no production hosting, database, code-host mutation, or CI-management
credential. A deploy job receives only the exact environment-scoped provider
credentials it needs, consumes an immutable image digest or bounded build
artifact, and does not run package scripts or other repository-controlled
application code. Hypervibe-owned deploy assets are fingerprinted and executed
without importing repository modules.

The CI adapter must prove that its variable/environment model enforces those
grants. GitHub environment secrets and GitLab environment-scoped variables are
mapped only to the declared deploy job. If a CI provider cannot prevent a
privileged secret from reaching a repository-code job, that deploy program is
`UNSUPPORTED` on that provider.

Privileged deploy jobs run only for the exact canonical repository on an
observed protected canonical ref, never for forks or merge-request pipelines.
Protected GitLab variables additionally require that protected-ref condition
in the rendered job rules. Unknown ref protection blocks privileged variable
sync and dispatch. Full branch-protection management can be a later capability,
but the production safety precondition is part of the deploy MVP.

For the MVP, that ref observation must prove force-push is disabled and direct
push is denied to every user, group, deploy key, and role. For GitLab, every
exact and wildcard protection rule matching the canonical branch must
effectively set **Allowed to push and merge** to **No one**; an unset field is
not proof. Merge permission is observed separately. GitLab combines overlapping
rules permissively, so checking only the exact-name rule is unsafe. A provider's
boolean "protected" flag without its complete effective access rules is
insufficient evidence. See GitLab's [protected branch
contract](https://docs.gitlab.com/user/project/repository/branches/protected/).

Ref protection and deployment authorization are separate capabilities. A
production program also requires provider-observed proof of who may execute the
deployment job. On GitLab Premium/Ultimate this is a protected environment with
the intended allowed-to-deploy policy. GitLab Free does not provide protected
environments, so branch protection alone is not presented as production
authorization; production promotion is `UNSUPPORTED` there unless a later
provider adapter implements and proves another non-bypassable trigger identity.
See GitLab's [protected environment
contract](https://docs.gitlab.com/ci/environments/protected_environments/).

The MVP uses one fixed portable production policy: only the provider's
Maintainer-or-higher equivalent may deploy. If effective project/group rules
also allow Developers or an unrecognized principal, observation blocks.
Configurable release-manager users/groups require later explicit desired state;
the adapter does not guess intent from whichever access entries already exist.

Security gates cannot rely on any runtime, parent-scope, or trigger-time value
that can shadow the provider-proven control value. Each CI adapter must observe
the complete applicable variable/input precedence graph and prove isolation of
commit identity, applied-spec fingerprint, promotion evidence, and renderer
control values. A convenient typed input is not sufficient if another accepted
input or higher-precedence variable can replace a gate. Unsupported or unknown
isolation blocks secret sync and privileged dispatch.

The GitLab CI adapter uses typed CI/CD inputs for declared
non-secret dispatch parameters and observes the project's pipeline-variable
override restriction before relying on project variables such as
`HYPERVIBE_APPLIED_SPEC_HASH`. If untrusted callers can shadow a gate variable,
the program is `UNSUPPORTED` until the project setting is safely reconciled or
the adapter has another provider-proven non-overridable mechanism. It never
passes promotion SHA, rollback evidence, or gate values as ad hoc pipeline
variables. See GitLab's [CI/CD inputs](https://docs.gitlab.com/ci/inputs/) and
[variable security guidance](https://docs.gitlab.com/ci/variables/).

The code-host management token and CI-management connection are never injected
into generated jobs. Platform-provided job tokens receive the minimum declared
permission budget; a renderer must not rely on broad platform defaults. Build
registry credentials use short-lived job identity where supported, while
long-lived pull credentials are projected only to the external runtime that
needs them.

Runner capability and trust are observed inputs. A program that needs Linux,
macOS, container builds, privileged execution, or specific architecture cannot
be rendered onto an arbitrary tag and hoped to work. Provider-hosted runners
must advertise the required capability; self-managed runners require an exact
approved binding. GitLab exposes runner/manager identity, tags, protection,
platform, and architecture, but not executor type or privileged-Docker mode
through these APIs. Hypervibe therefore requires the operator's exact
`hypervibe-capabilities:` maintenance-note attestation and reports it as an
attestation, never provider proof. Hypervibe never enables privileged Docker
execution or broad runner access as a hidden bootstrap step.

`CiConcurrency` describes the required safety outcome, not a vendor keyword.
Adapters may implement it with a queue, paused deployment, cancellation group,
or another observed primitive, but must report the native behavior. Platform
serialization is never sufficient by itself: every privileged job re-observes
the environment authority immediately before its first mutation and rejects a
stale or superseded run. Canceling or pausing another run is not convergence.

The current GitHub-only `buildGitHubActionsSteps` metadata is replaced, not
extended with `buildGitLabCiSteps`. Existing hosting modules are migrated one
at a time to neutral recipes. Once migrated, the same recipe must compile for
every compatible CI provider whose declared capabilities satisfy it.

Every rendered program must implement the same release contract:

- build and deploy the exact checked-out full Git SHA;
- gate before provider mutation on the environment-scoped
  `HYPERVIBE_APPLIED_SPEC_HASH` matching the desired environment fingerprint;
- serialize mutations per bound environment and reject an outdated run before
  its first provider mutation, without treating cancellation as convergence;
- mutate only already-bound hosting resources named by the plan/spec;
- never create, attach, or repair lifecycle infrastructure from CI;
- wait for and re-observe the exact provider revision;
- emit the same versioned, secret-free Hypervibe release evidence document;
- upload it as a bounded artifact associated with the exact run and job; and
- fail the job instead of publishing evidence when convergence is unproved.

Release evidence is untrusted input until Hypervibe cross-checks the exact code
repository, CI execution scope, pipeline/run, source event, ref, full SHA, job
id, execution attempt/rerun identity, structurally verified program fingerprint
at that SHA, artifact schema/size, and live hosting-provider revision. Fork,
merge-request, unknown-config, and unmanaged jobs are never eligible production
release evidence. An artifact's embedded fingerprint cannot establish its own
trust. A rerun or provider-native redeploy is a new execution identity; it never
inherits success or authority merely because it reused an older job or
artifact.

The release-evidence port fetches only the exact declared entry. It never
extracts an artifact archive into the repository or trusts archive paths;
compressed and expanded byte counts, entry count, path normalization, and JSON
depth are bounded to prevent traversal and decompression bombs. Missing,
duplicate, malformed, partial, or expired evidence blocks rather than falling
back to pipeline success alone.

Evidence retention is an explicit bounded program requirement. The CI adapter
maps and observes the effective provider retention policy; a provider/account
cap that is shorter than requested is reported and cannot promise rollback
beyond the proven window. Hypervibe does not describe an expired artifact as a
durable release record.

Existing branch and promotion semantics do not change: accepted code comes
from the declared canonical branch (default `main`), staging may deploy it
automatically, and production remains a manual promotion of an explicit
already-reviewed SHA. GitLab support does not introduce a long-lived staging
branch or make production push-triggered by default.

Promotion and rollback revisions are validated as full provider-observed commit
ids in the bound canonical repository, checked against the required prior
release evidence/reachability contract, and passed as data rather than
interpolated shell. The job checks out that detached exact revision and rejects
short SHAs, ref names, foreign commits, and a revision that changed after
planning.

GitLab's CI adapter maps the exact source to `CI_COMMIT_SHA`. The Pipelines,
Jobs, log-trace, and artifact APIs expose the run evidence needed by Hypervibe:
[Pipelines API](https://docs.gitlab.com/api/pipelines/), [Jobs
API](https://docs.gitlab.com/api/jobs/), and [job artifact
documentation](https://docs.gitlab.com/ci/jobs/job_artifacts/).

Provider log diagnostics move from GitHub-named types to CI-neutral types.
Hosting diagnostics are attached to neutral recipe steps. Platform-specific
warnings remain in the relevant CI adapter; shared deployment failure patterns
remain provider-neutral. Log inspection runs only the diagnostics named by the
bound program and selected CI adapter; it does not execute every registered
hosting provider's diagnostic rules against every log.

### Container images

The CI provider never chooses the image registry. The deploy planner resolves
an explicit, already-bound `ContainerImageTarget` through provider
capabilities. It may be a hosting-provider registry such as ECR/Artifact
Registry/ACR/DOCR, a code-host project registry such as GHCR or GitLab
Container Registry, or a separately declared registry. The target preserves
provider id, native registry/repository scope, image name, and supported auth
mode; credentials are not part of that object.

A code host may expose a project container-registry capability, but registry
create/settings/delete and runtime pull credentials remain separate lifecycle
and connection concerns. CI rendering only maps the neutral build/login/push
steps for the selected target. It never creates a registry, chooses the first
matching repository, or substitutes a GitHub/GitLab registry based on the CI
provider. Multiple or unbound candidates block.

GitLab jobs can push to the project registry with predefined short-lived job
credentials. An external hosting provider cannot rely on that job token for
durable pulls. When a provider such as Railway must pull a private GitLab
image, the GitLab connection additionally requires a project deploy-token
username and token with `read_registry` only. GitLab documents this exact use
in its [deploy token guide](https://docs.gitlab.com/user/project/deploy_tokens/).

The registry credential is supplied through a credential reference and
redacted like the GitHub package-read token. Guidance requires a project-scoped
`read_registry` token with an explicit expiry and explains rotation before that
date; the provider default of no expiry is not recommended. The MVP does not
create deploy tokens implicitly. Automated deploy-token lifecycle would require
its own explicit desired-state actions, durable token id, rotation contract,
and one-time-secret handling.

When that pull credential is required, connection guidance identifies the
credential as a GitLab **project deploy token**, links to the verified project's
Settings > Repository page and GitLab's official deploy-token documentation,
requires only `read_registry`, names the exact project scope and expiry caveat,
and uses a multi-field local reference such as:

```text
hv_connections provider="gitlab" scope="https://gitlab.com/acme/apps/storefront" credentialsRef="dotenv:/absolute/path/.env.gitlab" credentialsMap={"apiToken":"HYPERVIBE_GITLAB_TOKEN","registryUsername":"HYPERVIBE_GITLAB_REGISTRY_USERNAME","registryReadToken":"HYPERVIBE_GITLAB_REGISTRY_READ_TOKEN"}
```

The username and token are never placed in the spec, plan preview, binding,
receipt, or command result.

## CI variables and the secret boundary

`CiVariablePort` returns a normalized, secret-safe observation rather than a
provider response object. Each entry carries its durable provider scope,
precedence layer, matching rule, protection metadata, and
`valueVisibility: "plaintext" | "redacted" | "omitted" | "unknown"`. A
plaintext value is fingerprinted and erased inside the provider's sensitive
HTTP boundary; redacted or omitted data produces an unknown fingerprint, never
an empty or matching value. Generic application code never knows which vendor
normally reveals a stored value.

Effective-value observation covers every provider layer that can supply the
same mapped key, including organization/workspace/group, repository/project,
environment/deployment, definition, and dispatch-time inputs where applicable.
The adapter owns the provider's matching and combination rules. Any unowned or
unknown higher-precedence value that could shadow a Hypervibe control or secret
blocks reconciliation; the core never assumes that an exact environment write
wins on every CI platform.

GitLab CI/CD variables map cleanly to repository-wide (`*`) or
environment-scoped variables. Secret values are masked and hidden when the
connected GitLab version supports those settings; protected variables are used
only after the relevant protected-ref contract is verified.

Logical CI value names are validated before provider mapping. Hypervibe,
GitHub, GitLab, runner, and provider-reserved prefixes/names cannot be declared
as delegated secrets, and case-folded or mapped-name collisions block. A user
secret can never shadow a commit identity, applied-spec gate, evidence path,
registry endpoint, or renderer control variable.

Provider storage keys are deterministic but project/environment-specific
physical names, not public logical names such as `RAILWAY_TOKEN`. The
self-contained authorized job maps a physical key directly into the invoked
owned process environment only for its declared consumer; it does not define a
lower-precedence logical YAML variable that a group/project variable can
replace. This avoids accidental collisions
with ordinary project/group variables; pipeline-variable overrides are still
disabled as described above. Instance and parent-group administrators are an
explicit provider trust root—Hypervibe reports that caveat and does not claim a
project-scoped token can defend against a higher-scope administrator who
deliberately replaces policy or variables.

Unlike GitHub's secret-list API, GitLab's variable-list API returns the secret
`value`. Inside the sensitive HTTP-response mapper, the GitLab adapter computes
the existing one-way secret fingerprint and immediately drops the raw value and
response body. Raw variable objects are prohibited outside that boundary.
Secret reconciliation may receive the fingerprint for drift/retry checks;
general inspection and command results receive only key, scope, variable type,
protected/masked/hidden flags, and safe timestamps/ids. See GitLab's [project variables
API](https://docs.gitlab.com/api/project_level_variables/) and [CI/CD variable
security guidance](https://docs.gitlab.com/ci/variables/).
If an instance omits or redacts the value, fingerprint observation is `unknown`;
it is not converted to an empty value or matching hash.

Secret drift is reconciled from the desired secret reference and the existing
Hypervibe applied fingerprint; Hypervibe never persists or returns a
provider-returned value. Every variable create, update, or delete is its own
planned action keyed by project id, variable key, and environment scope. A noop
performs zero GitLab mutations. If GitLab cannot apply the required masked or
hidden protection for a secret, the action blocks rather than creating a
plain-text-visible variable.

An existing variable with the same key and scope but no matching Hypervibe
ownership binding is an unowned collision, not a noop or adoption. Planning
preserves it and blocks until the user explicitly imports it as preserve-only
or supplies a secret reference for a visible replacement action. Teardown
deletes only exact owned key/scope bindings. Losing local bindings never turns
provider-listed variables into Hypervibe-owned secrets.

For an environment-scoped value, observation considers every same-key scope
that can match that environment. An overlapping wildcard or more-specific
unowned scope that could change GitLab's effective value blocks reconciliation;
Hypervibe never assumes that writing one exact scope makes the job consume it.

## Shared command behavior

`hv_ci_status` and `hv_ci_trigger` remain one command each in the application
registry and therefore retain MCP/CLI parity. Their public language becomes
CI-neutral while old GitHub input aliases remain accepted:

- code repository and CI provider selection come from the verified `devops`
  binding or the fixed legacy GitHub/Actions compatibility mapping;
- `definition` is the provider-neutral managed CI definition selector, while
  `workflow` remains a deprecated GitHub-compatible alias;
- command inputs treat `runId`, `jobId`, and optional execution-attempt ids as
  bounded opaque strings; existing numeric inputs are accepted and normalized,
  while each adapter validates its native id format;
- canonical sections are definitions, runs, jobs, logs, artifacts, and release
  evidence;
- every result includes `codeProvider`, `ciProvider`, canonical repository
  identity, and native ids/URLs.

The legacy GitHub `repo` override remains readable only as a selector that must
resolve to the same durable bound code/CI identities. It cannot retarget an
operational command to an unrelated repository outside desired state; generic
cross-provider forensics uses `hv_inspect` with an explicit provider scope.

Normalized result ids preserve the provider-native value and scope rather than
coercing every provider to GitHub's numeric model. A run or job id is never
matched outside its bound CI execution scope and provider instance.

The existing GitHub-only `pages` and `branch-protection` sections remain
deprecated compatibility routes during migration. Branch protection resolves
through code-host capabilities. Pages resolves through the static-hosting
feature plus its own optional publication executor; it is neither part of the
general application CI port nor a reason to select GitHub Actions as the
primary CI provider. Desired Pages and collaboration state belongs in
`hv_status`; provider forensics remains in generic `hv_inspect`.

`hv_ci_status` becomes the authoritative inspection path for both managed
GitHub and GitLab CI. Agents use it before `gh`, `glab`, provider connectors,
browser inspection, or direct provider API calls, and stop with its connection
or error guidance when observation is blocked. After a successful managed run,
`hv_health` remains the live application verification step.

CI logs and artifact payloads are untrusted, potentially secret-bearing data.
Adapters retrieve them through bounded byte/line limits; the shared redaction
boundary first canonicalizes line endings and strips/neutralizes terminal
escapes, control characters, and active markup so they cannot split a token and
evade matching. It then removes all resolved credential values and
credential-shaped content before diagnostics, audit records, MCP structured
content, CLI JSON, or human output. Release artifacts are decoded only through
their strict allowlisted schema; raw payload bytes and unknown fields are
dropped rather than returned. Provider error handling never attaches raw HTTP
bodies from variable, log, artifact, or lint endpoints.

GitLab does not expose GitHub-style per-step job records or a separate workflow
object. GitLab job steps are therefore absent rather than fabricated, and
managed CI definitions are observed from owned repository config plus the
linted merged configuration. Artifact lookup is pipeline/job-scoped because
that is GitLab's native model.

`hv_ci_trigger` uses the provider dispatch capability. For GitLab, it creates a
pipeline for an exact ref through the Pipelines API. Only declared, typed,
non-secret inputs may be supplied in command/audit output; secret values remain
protected project variables referenced by the job. A GitLab version without
the required typed-input and override-safety capabilities can still dispatch a
program with no inputs, but cannot dispatch promotion/rollback inputs through a
pipeline-variable fallback.

Dispatch acknowledgement produces a pending receipt, not deployment success.
The adapter boundedly re-observes the exact new pipeline identity before
returning it; `hv_ci_status` and then `hv_health` establish terminal CI and live
application outcomes.

`hv_rollback` uses a provider-neutral release-evidence port. It verifies the
target artifact, exact SHA, successful pipeline/job, current managed config,
and absence of a newer/in-progress conflicting deploy, then creates a
deterministic protected tag and dispatches a new typed-input pipeline. The
rollback wildcard must grant creation only to the exact authenticated GitLab
user. `resource_group`, forward-deployment protection, disabled rollback
retries, and apply-time re-observation close races. The existing warning remains
unchanged: application rollback does not reverse database migrations or
provider-side manual changes.

## Capability parity

| Outcome | GitLab implementation | Phase |
| --- | --- | --- |
| Exact project identity | Project API plus durable numeric project id | MVP |
| Managed repository files | atomic commit on reviewed branch and merge request | MVP |
| Managed deploy CI | neutral Railway, Vercel, DigitalOcean, Cloud Run, Azure Container Apps, and ECS Express recipes rendered by GitLab CI | MVP |
| CI variables/secrets | scoped variables; raw values erased after internal fingerprinting | MVP |
| Pipeline status, jobs, logs, artifacts | normalized GitLab APIs | MVP |
| Manual deploy and exact-SHA release evidence | pipeline dispatch and job artifact | MVP |
| Managed deploy rollback | shared verified release evidence, deterministic protected tag, typed-input pipeline | MVP |
| CI teardown | reviewed file removal, active-job gate, exact owned-variable deletion, binding removal | MVP |
| Repository create/destroy | separate isolated lifecycle with namespace/project authority, durable id, destructive confirmation, and terminal absence | MVP |
| Repository collaboration settings | separately registered code-host capabilities | Later |
| Branch protection management | protected branches capability; observed protection is already an MVP deploy precondition | Next |
| Production deploy authorization | observed protected environment on Premium/Ultimate; Free blocks without another proven mechanism | MVP precondition |
| Required reviews | merge request approval rules; Premium/Ultimate only | Next |
| Labels and issue/MR templates | project labels and owned repository templates | Next |
| Checks and schedules | generated jobs and pipeline schedules | Next |
| Autofix, MR review, and code audit | code-host write capability plus CI program | Later |
| Pages | separate static-hosting feature with an optional feature-scoped publication executor and live verification | Later |
| Dependency updates | separate design; no false Dependabot equivalence | Later |
| Security scanners and policies | capability/tier-specific GitLab templates and APIs | Later |
| iOS/TestFlight release | neutral macOS CI program and artifact contract | Later |
| Database restore drills | neutral scheduled CI program and live lifecycle contract | Later |

Merge request approval rules are limited to GitLab Premium and Ultimate, so a
Free project that requests `requiredReviews` must block with exact upgrade or
configuration guidance; branch protection alone is not treated as equivalent.
GitLab documents the limitation in its [merge request approvals
API](https://docs.gitlab.com/api/merge_request_approvals/).

GitLab Pages itself is available across tiers and has a project settings API,
but publication is coupled to CI configuration and custom-domain behavior
differs from GitHub. It remains a separate lifecycle slice rather than being
smuggled into the deploy MVP. See GitLab's [Pages
API](https://docs.gitlab.com/api/pages/).

Security features are registered independently because scanning engines,
reports, enforcement, and tiers differ. GitLab's basic SAST analyzer and
Ultimate vulnerability-management experience, for example, are not one
capability. Hypervibe preserves the lower proven support status and never maps
GitHub security booleans by name alone.

## Bitbucket pressure test (architecture only)

Bitbucket is not part of this implementation or support claim. It is a third
provider shape used to reject accidental GitHub/GitLab assumptions before the
ports are built. The audit produces the following requirements:

| Bitbucket Cloud behavior | Requirement on the shared architecture |
| --- | --- |
| Repositories, workspaces, pipelines, steps, deployments, and variables expose opaque UUID identities while slugs and names may change. | Persist provider-native durable ids plus their workspace/repository scope and current display paths. Keep all public run/job ids as bounded opaque strings. |
| Pipelines uses one root `bitbucket-pipelines.yml`; shared configuration imports are Premium and external imports select a branch or tag rather than a provider-proven immutable full SHA. | Configuration ownership is negotiated as whole-root, proven composable include, or provider-managed. A Bitbucket adapter cannot inherit GitLab's include strategy; it must own the whole root or block with a reviewed human-owned-root contract until effective activation can be proven. |
| Dynamic Pipelines can transform the YAML at repository and workspace levels at runtime. | Activation observes the full ordered authority/transformation graph and final effective semantics. Static YAML equality alone can never authorize privileged variables, dispatch, or evidence when a transformation is present or unknown. |
| The Pipelines API can dispatch a reviewed custom definition for an exact commit/ref and can also accept trigger variables; a separate on-demand mode accepts replacement YAML in the request body. | Dispatch capability records exact-revision/ref support and input precedence. Hypervibe permits only the bound reviewed definition path and permanently rejects raw request-supplied configuration. |
| Variable precedence is Pipeline > Deployment > Repository > Workspace > Default. | The normalized variable port observes all applicable layers and must prove Hypervibe control values cannot be shadowed. If trigger-time values can replace the applied-spec or commit gate, privileged dispatch is `UNSUPPORTED` until the adapter has a provider-proven isolated mechanism. |
| Branch restrictions may overlap with provider-specific combination behavior. | The code-host adapter computes effective direct-push/force-push and review policy from every matching native rule. The core consumes the proven outcome and never embeds GitLab's combination algorithm. |
| Deployment authorization and some configuration features are tier-dependent. | Each facet carries observed entitlement and exact authorization evidence. A UI-visible setting or ambiguous `403` is not proof; production remains unsupported until the API/live contract proves the policy. |
| Deployment environments and concurrency may pause or queue work rather than cancel it. | Concurrency is a semantic capability with normalized native behavior, plus a mandatory stale-run check immediately before provider mutation. The core never assumes that a provider keyword means "latest run wins." |
| Pipeline artifacts expire after 14 days and have a 1 GB limit; reruns have distinct execution identity. | Retention and size are negotiated capabilities. Longer rollback evidence requires a separately declared external evidence store, never a silent fallback, and normalized evidence includes the execution attempt/rerun identity. |
| Bitbucket's static-site feature publishes a special `<workspace>.bitbucket.io` repository directly from its main branch. | Static hosting keeps separate content-source, hosting-target, and optional executor bindings. A distinct site repository is explicit lifecycle work; it does not become the application CI provider or acquire application release authority. |

These constraints are based on Atlassian's current [repository REST
model](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-repositories/),
[Pipelines API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/),
[shared configuration](https://support.atlassian.com/bitbucket-cloud/docs/share-pipelines-configurations/),
[Dynamic Pipelines](https://support.atlassian.com/bitbucket-cloud/docs/dynamic-pipelines/),
[variable precedence](https://support.atlassian.com/bitbucket-cloud/docs/variables-and-secrets/),
[branch restrictions](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-branch-restrictions/),
[deployment concurrency](https://support.atlassian.com/bitbucket-cloud/docs/deployment-concurrency-control/),
[artifact limits](https://support.atlassian.com/bitbucket-cloud/docs/use-artifacts-in-steps/),
and [static website](https://support.atlassian.com/bitbucket-cloud/docs/publishing-a-website-on-bitbucket-cloud/)
contracts. They must be re-observed when Bitbucket work begins; documentation
today is not future live-support evidence.

Provider identity also stays explicit. A future registration would use
separate ids such as `bitbucket-cloud` for code hosting and
`bitbucket-pipelines` for Cloud CI. `bitbucket-data-center` is a different code
host registration with an explicit instance URL/version range; it does not
inherit Cloud API or Pipelines behavior. Atlassian documents Data Center CI as
integration with systems such as Bamboo or Jenkins, so each of those remains a
separate CI provider and compatibility binding rather than a hidden
"self-managed Bitbucket Pipelines" mode. See Atlassian's [Bitbucket Data Center
CI/CD model](https://confluence.atlassian.com/bitbucketserver/integrated-ci-cd-1032257989.html).

Credential modeling must likewise be capability- and offering-specific. As of
this proposal, Bitbucket Cloud app passwords have been removed in favor of
scoped API tokens, OAuth, or repository/project/workspace access tokens.
Repository access tokens are repository-bound; project/workspace access tokens
have different entitlement and scope. Future connection guidance must select
the least-privilege credential that satisfies the exact requested facets and
must never revive app-password instructions. See Atlassian's [API token
creation](https://support.atlassian.com/bitbucket-cloud/docs/create-an-api-token/)
and [access token](https://support.atlassian.com/bitbucket-cloud/docs/access-tokens/)
contracts.

The result is deliberately not a speculative Bitbucket adapter. It is a set of
provider-neutral invariants that GitHub Actions and GitLab CI must implement
without depending on two-provider coincidences.

## MVP boundary

The smallest useful end-to-end MVP is:

1. GitLab.com and self-managed project connection/verification.
2. GitLab remote parsing and durable project binding for an existing initialized
   repository, plus explicit managed creation/deletion. Creation verifies the
   exact parent namespace, initializes the declared default branch, and records
   the numeric project id. It never pushes or rewrites local Git history.
   Deletion requires explicit absent state, exact action confirmation, prior CI
   teardown, and terminal provider absence before binding removal.
3. Provider-neutral code-host and CI ports with GitHub and GitHub Actions
   migrated behind them without changing existing outcomes.
4. The neutral CI program, a GitHub Actions renderer, and a GitLab CI renderer.
5. Railway, Vercel, DigitalOcean, Cloud Run, Azure Container Apps, and ECS
   Express expose provider-neutral deploy recipes; the GitLab renderer has no
   hosting-provider switch and CI never creates missing hosting infrastructure.
6. Reviewed GitLab merge request for managed deploy configuration, including
   root include ownership/blocking and exact-commit CI Lint verification.
7. GitLab CI variables with transport-level value erasure.
8. `hv_ci_status`, `hv_ci_trigger`, exact-SHA release evidence, and
   `hv_rollback` through shared provider-neutral services.
9. Protected-ref, production deployment authorization, and
   pipeline-variable-override observation as required preconditions for
   privileged deploy jobs; management of those settings remains the next
   slice.
10. Mocked lifecycle contracts plus separate opt-in live project-lifecycle and
   managed-config/variable/deploy/noop/update/rollback/teardown runs. A live run
   promotes only the exact GitLab offering/version, runner mode, and hosting
   recipe exercised; GitLab.com evidence never promotes self-managed support or
   another host. It is not a claim of full GitLab parity.

The MVP excludes repository collaboration settings, GitLab Pages, dependency
updates, GitLab security products, agent-authored merge requests, iOS release,
and database restore drills. Those are valuable, but none is required to prove
the central push-deploy and operational-inspection path.

## Implementation sequence

### 1. Pin current behavior and introduce the canonical model

- Add the `devops` spec model, legacy normalization, and open registry ids.
- Add code-host/CI capability ports and normalized identities/results.
- Generalize git remote parsing.
- Keep current GitHub action ids and legacy spec aliases readable.
- Pin existing GitHub behavior with characterization and adapter contracts.

This stage must produce no GitHub provider mutations for unchanged specs.

### 2. Extract GitHub and the neutral CI program

- Move GitHub-only imports out of generic plan/apply/tools code.
- Split GitHub code-host behavior from GitHub Actions behavior behind the two
  capability sets, while allowing them to share the verified connection.
- Add the versioned neutral deploy recipe and CI program.
- Implement the GitHub Actions renderer/operator adapter.
- Migrate Railway to the neutral recipe and prove its rendered GitHub behavior
  retains the current release and secret contracts.

Other hosting providers may remain on the pinned legacy GitHub path only while
they are migrated. New features cannot be added to that legacy path, and it is
removed after the last provider moves to neutral recipes.

### 3. Add the GitLab code-host and CI adapters

- Register `gitlab` as a code-host provider and `gitlab-ci` as a CI provider
  with honest individual capabilities and an observed compatibility contract.
- Implement connection verification, project/files/branches/commits/MRs,
  config linting, variables, pipelines, jobs, trace tails, artifacts, and
  dispatch.
- Implement one GitLab CI renderer for the neutral CI program. It contains no
  Railway, Cloud Run, Vercel, or other hosting-provider branches.
- Add complete pagination, retry classification, redaction, and tri-state
  observation tests.
- Add provider-owned inspection drivers; generic `hv_inspect` remains generic.

### 4. Prove one vertical deploy path

- Compile the same neutral Railway recipe through both CI renderers.
- Generate reviewed GitLab config through the GitLab code-host adapter.
- Verify root inclusion and merged job fingerprint.
- Sync scoped variables only after merge verification.
- Prove exact-SHA provider convergence, release artifact, status/log inspection,
  manual dispatch, rollback, noop, and teardown.

The first vertical provider should be Railway because it exercises the hardest
registry-pull credential boundary. Passing it makes the remaining recipe
migrations less likely to hide a GitHub registry assumption.

### 5. Complete neutral deploy-recipe parity

- Migrate Cloud Run, ECS Express, Azure Container Apps, DigitalOcean App
  Platform, and Vercel once each from GitHub-specific workflow generation to a
  neutral deploy recipe.
- Compile every migrated recipe through both compatible CI renderers without
  adding hosting-provider cases to either renderer.
- Keep each provider at `planned` or `ready-for-live` until its own mocked and
  live evidence exists.
- Promote the GitLab capability only after the full advertised matrix has
  recent live evidence.

### 6. Add DevOps features by capability

Branch protection and approvals come first, then labels/templates/checks,
followed by Pages and automation. Each slice gets its own schema mapping,
observation, plan/apply actions, tier behavior, and live evidence.

## Required contracts

The implementation is incomplete without tests for:

- MCP registry and CLI routing parity for every shared CI command;
- lossless legacy `collaboration`, `github`, and `githubActions` normalization
  round trips covering enabled state, repository selection, collaboration,
  automations, external definitions, Pages, dependencies, and security, plus
  explicit blocking for overlapping legacy/canonical authority;
- open provider ids and registry-driven code-host/CI compatibility, with no
  GitHub/GitLab schema enum or generic default-to-GitHub path outside the
  pinned legacy normalizer;
- GitHub no-regression and noop mutation freedom;
- GitLab SSH/HTTPS remotes, nested groups, ports, and self-managed hosts;
- explicit self-managed instance URLs, relative-path installations, custom
  clone hosts, private-CA verification, and rejection of guessed API bases;
- durable project-id-first observation and path rename handling;
- not-found versus permission, timeout, rate-limit, and partial-read behavior;
- deterministic reviewed branch/MR reuse, duplicate MR detection, and safe
  squash/rebase handling;
- default and custom `ci_config_path`, unmanaged-root blocking, existing include
  collections, inert teardown manifests, and no stranded include;
- CI Lint with immutable-SHA `content_ref`, declared-branch `dry_run_ref`, and
  stale-SHA rejection before dependent actions;
- immutable include-graph observation plus effective-config checks for defaults,
  hooks, scripts, identities, variables, and job overrides;
- whole-root, composable-include, and provider-managed configuration modes,
  including unknown repository/workspace/organization transformation layers
  blocking privileged use;
- structured-renderer injection tests for ids, refs, paths, YAML values,
  duplicate keys, asset traversal, size bounds, and immutable dependencies;
- typed step privilege checks rejecting free-form privileged shell, repository
  commands in credentialed jobs, and string-interpolated dynamic arguments;
- CI variable response fingerprinting and raw-value erasure before
  service/log/result boundaries;
- provider-neutral variable visibility and precedence graphs, including
  higher-scope and trigger-time shadowing of reserved control values;
- protected-ref checks across every matching exact/wildcard rule, direct-push
  denial, job-scoped secret isolation, typed-input, pipeline-variable override,
  runner trust, and least-privilege token contracts;
- variable action authority by exact key and environment scope;
- unowned and overlapping variable-scope collision behavior;
- exact pipeline SHA, job success, provider convergence, and artifact
  provenance;
- bounded log/artifact handling, exact-entry archive safety, and redaction;
- opaque string/numeric run, job, and execution-attempt ids scoped by CI
  instance/project;
- explicit bound container-registry selection with no CI-provider default;
- explicit bound CI configuration locations, including rejection of an
  unbound or silently substituted source/config repository;
- exact-revision reviewed-definition dispatch with raw request-supplied CI
  configuration permanently rejected;
- stale plans, concurrent/newer pipelines, expired artifacts, and rollback
  conflicts;
- provider-native queue/pause/cancel concurrency behavior plus the mandatory
  pre-mutation stale-run rejection;
- fail-closed CI-provider cutover ordering, old-authority absence, separate
  action scope, and release-history isolation;
- one neutral Railway recipe compiling through both CI adapters with equivalent
  logical triggers, inputs, secrets, applied-spec gate, and evidence contract;
- neutral recipe and generic-service scans rejecting GitHub/GitLab expressions,
  config paths, API fields, and provider-name dispatch;
- Pages/static-hosting source, hosting-target, and optional executor bindings
  remaining distinct from each other and from the primary application CI
  authority, including no implicit publication-repository creation and no
  access to application variables, evidence, promotion, or rollback;
- CI capability incompatibility returning `UNSUPPORTED` before files,
  variables, or provider mutations;
- secret-free receipts, errors, diagnostics, structured content, CLI JSON, and
  audit history; and
- opt-in live GitLab lifecycle evidence recorded separately from mocked support.

Architecture boundary tests should scan generic application, tool, and domain
service files and neutral hosting recipes for direct GitHub/GitLab adapter
imports, config expressions, provider API field names, and provider-name
dispatch branches. A small contract-only Bitbucket-shaped CI adapter should be
registerable without implementing or claiming Bitbucket support. It uses opaque
UUIDs, whole-root configuration, an optional unknown workspace transformer,
high-precedence trigger variables, fixed artifact retention, and distinct rerun
attempts. It must be able to accept or reject a minimal `CiProgram` without
editing a hosting adapter or the command/application layer.

## Acceptance criteria

GitLab managed deploy support can be called `supported` only when all of the
following are true:

- an unchanged GitHub project still plans and applies exactly as before;
- a GitLab project completes connection, reviewed config, variable sync,
  exact-SHA deploy, inspection, noop, update, rollback, and teardown through
  the shared commands;
- an unmanaged or overridden GitLab root config blocks before variable or
  deploy mutation;
- mutable includes, unprotected refs, overrideable security gates, untrusted
  runners, or inability to isolate deploy secrets block before secret sync;
- direct push or force push through any exact, wildcard, role, group, user, or
  deploy-key rule blocks privileged deployment;
- each advertised neutral hosting recipe renders through GitLab CI without a
  hosting-provider case in the CI adapter, and Railway retains its unchanged
  GitHub Actions outcome;
- unknown observation never authorizes create, overwrite, dispatch, or delete;
- every provider mutation is named by the current non-noop persisted action;
- GitLab variable values and all credentials are absent from every output
  boundary; and
- recent live evidence exists for each hosting provider advertised as GitLab
  managed-CI capable and for the GitLab offering/version range carrying that
  status.

That gives GitLab users the part of GitHub parity that matters most first: the
same desired-state authority, reviewed infrastructure changes, exact deploy
evidence, operational visibility, and safe rollback. The rest can then be
added as honest provider capabilities instead of another parallel system.
