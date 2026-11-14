# Hypervibe development

Hypervibe makes it easy for vibe coders to deploy and operate apps on Google
Cloud, AWS and Azure. The user describes the app; Hypervibe handles infrastructure,
authentication, deployment, rollback, recovery, observability, secrets and
third-party integrations. Use the
[audience guide](docs/development/product.md#who-we-build-and-write-for) when
changing customer-facing pages, emails, prompts or errors.

<a id="working-method"></a>

## Design for the complete journey

- Build toward the [common cloud user journey](docs/development/user-journey.md).
  It is the acceptance target for GCP, AWS and Azure, not a claim of current
  support. Provider notes and historical checklists do not define extra scope.
- Optimize for a working app with the fewest user chores and installed tools.
  Infer routine choices from the repository; ask for missing access, consequential
  decisions and approvals, not an infrastructure design exercise.
- OpenTofu is the chosen infrastructure lifecycle engine. Hypervibe must manage
  pinned, private engine dependencies automatically. Do not make users separately
  install or operate OpenTofu, Terraform, cloud CLIs or Docker for deployment.
  The current npm path still requires Node.js/npm; distinguish targets from
  implemented and verified installation paths.
- Focus new cloud work on GCP, AWS and Azure. Preserve Railway for existing apps.
  The unused GCP prototype may be replaced; do not turn that replacement into a
  compatibility or import-migration project. This is not permission to discard
  existing Railway state, user data or working workflows.
- Prove the smallest complete path from installation and cloud access to a running
  app before expanding providers or features. An engine wrapper or passing unit
  tests alone do not establish a supported deployment. Say what is implemented,
  what is verified and what remains unavailable.
- Keep changes scoped and preserve unrelated work. Read relevant sections, batch
  independent checks, and show useful results instead of verbose logs. Use agents
  for bounded independent work when useful; one owner verifies integration.
- If two attempts leave the same user-visible step blocked, reassess the diagnosis
  and explain what the next attempt will establish. Fix missing Hypervibe
  capabilities in the shared workflow instead of handing users recurring manual
  provider setup.

<a id="non-negotiable-boundaries"></a>

## Boundaries that survive the engine change

- Use `hv_spec` → `hv_plan` → approved `hv_apply` → verification for managed
  infrastructure. A plan authorizes only its exact current actions and dependencies;
  noop means zero mutations. OpenTofu runs inside this boundary, not alongside it
  as a second user-operated workflow.
- Keep present, absent and unknown distinct. Only provider-confirmed absence proves
  absence. Verify native IDs, scope and ownership; names are search hints. Errors,
  incomplete reads and ambiguity must not become permission to create or destroy.
- Billable/data-bearing actions require exact action confirmation. Account,
  billing, invitation, secret import and apply authorizations remain distinct.
  Reuse approval for unchanged work within its scope. Verify convergence before
  dependent effects; deletion follows dependencies and stops on failed or unknown
  results.
- Secret values never cross output boundaries. Use safe references, encrypted
  plans or verified connections; redact supplied values from every output and
  diagnostic. Treat engine plans and state as potentially secret-bearing.
  Control-plane access does not authorize copying credentials into runtime.
  Preserve repository/environment scope and supported workload identities.
- MCP and CLI are thin adapters over `src/application`, with shared commands,
  validation, redaction and results. Keep both reachable unless architecture
  records an exception. Provider behavior belongs behind registered capabilities;
  cloud lifecycle operations belong in the chosen engine integration.
- Use Hypervibe for infrastructure it manages. Do not bypass plans, state or
  blockers with direct provider writes, one-off scripts, credential edits or
  resource recreation. Read-only diagnostics are allowed. A workaround needs the
  user's explicit exception after explaining the missing capability and tradeoff.
- Honor result stages and continuation contracts. Failed, blocked, pending or
  confirmation-required work stops dependent effects unless an explicit bounded
  continuation applies. An attempted action is not proof of success.

<a id="read-the-relevant-contracts"></a>

## Read only what the change touches

[ARCHITECTURE.md](ARCHITECTURE.md) defines the infrastructure model. Consult the
relevant sections and topic rules, not the entire linked document tree. Previously
read, unchanged guidance need not be loaded again. The [documentation map](docs/README.md)
distinguishes current requirements, implementation evidence and historical context.

| Change | Relevant rules |
| --- | --- |
| Cloud journey, feature scope or completion claims | [Common cloud journey](docs/development/user-journey.md) |
| Onboarding and customer experience | [Product](docs/development/product.md) |
| Provider APIs or shared capabilities | [Provider evidence](docs/development/provider-evidence.md) |
| Spec, plan, apply, observation, import or teardown | [Lifecycle](docs/development/lifecycle.md) |
| Authentication, secrets or IAM | [Connections](docs/development/connections.md) |
| Workflows, deployment or promotion | [CI](docs/development/ci.md) |
| Backup, restore or persistent storage | [Recovery](docs/development/recovery.md) |
| Interfaces, PRs, releases or macOS | [Workflow](docs/development/workflow.md) |

The installed customer workflow is [skills/hypervibe/SKILL.md](skills/hypervibe/SKILL.md);
customers do not inherit this file. Keep its instructions honest about current
capabilities. Document deliberate policy changes in the
[migration audit](docs/development/guidance-migration.json), a historical record
rather than a reading checklist.

<a id="verification-and-delivery"></a>
<a id="merge-handoff"></a>

## Verification and handoff

Match verification to the affected behavior. Documentation changes need content
and link review; runtime changes need focused behavioral checks and required CI.
For bugs, follow the [evidence method](docs/development/workflow.md#dg-135), including
a failing boundary regression before the fix. Preserve required independent reviews
without inventing new gates or repeating settled checks.

Before recommending chat closure, commit and push task changes, include them in a
PR, and verify every task worktree is clean. Preserve unrelated edits; report any
remaining blocker and who acts next. Never restart or kill the user's MCP/client
processes to activate a build; explain any needed restart.

Accept the user's report that a PR merged. After a successful authorized merge,
report the result/link and stop: no fetch/pull, branch comparison, repeated tests,
CI/deployment polling or browser checks unless requested. If the outcome is
ambiguous, make one bounded status lookup; report queued auto-merge as queued.
Preserve required pre-merge checks, explicitly requested release validation and
independently scheduled reviewers. See the
[workflow](docs/development/workflow.md) for detailed verification, release and
merge rules.
