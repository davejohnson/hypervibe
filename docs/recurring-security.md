# Recurring security reviews

Hypervibe separates the intended cadence, an installed automation, a completed
review, and a completed repair. None proves the next. A policy can request daily
advisory checks, weekly code reviews, and monthly credential rotation without
claiming that any schedule is deployed or any key has changed.

## Desired policy

Declare this optional project-level block through `hv_spec`:

```json
{
  "securityPolicy": {
    "advisoryReview": { "intervalDays": 1 },
    "codeReview": { "intervalDays": 7 },
    "credentialRotation": { "intervalMonths": 1 }
  }
}
```

An explicitly supplied empty block selects those defaults. Omitting the block
preserves existing desired state and hashes. The pure due assessment may suggest
the same cadence, but does not persist it. Missing completion evidence means work
is due; invalid or future timestamps cannot postpone it. Calendar-month rotation
uses UTC and clamps the day at the end of short months. A January 31 completion
therefore becomes due on February 28, or February 29 in a leap year.

Ordinary `hv_spec` reads also surface this cadence and a `hv_security` suggestion,
including before a project is initialized. The reminder does not save a policy,
run a scan, enable a schedule, or replace the fresh-project setup steps. Use the
selected project's own checkout when following the review suggestion.

Only independently verified, complete results qualify as completion evidence.
A prepared rotation, accepted provider write, scheduled job, partial scan, or
unverified workflow report is insufficient. The due assessment does not establish
that automation is active and never increments a credential generation.

## Daily dependency and runtime advisory checks

`hv_security` performs a read-only local review. Its optional `paths` list selects
up to 20 local project checkouts; omission selects the command's repository
context. `lockfilePaths`, `publicPackageNames`, and `nodeVersions` bound the
selected scan. Each repository produces its own report and due-policy assessment.
These results are not persisted completion attestations, and they do not install
the recurring workflow. A missing or invalid spec cannot be treated as accepted
policy or runtime intent.

The managed `security-review` action runs the packaged read-only scanner. This
desired-state fragment installs a daily review through the existing GitHub
infrastructure plan/apply path:

```json
{
  "github": {
    "actions": {
      "security": {
        "kind": "security-review",
        "schedule": { "cron": "17 5 * * *", "timezone": "UTC" },
        "lockfilePaths": ["package-lock.json"],
        "publicPackageNames": [],
        "nodeVersions": []
      }
    }
  }
}
```

The action also permits manual dispatch. For a monorepo, list each selected npm
lockfile explicitly, such as `apps/web/package-lock.json`. Review public scoped
package names before adding them to `publicPackageNames`; a private package name
must not be submitted to a public advisory service. Additional Node selectors can
be declared with `nodeVersions`. The project Node runtime, when declared, is also
checked; a broad selector cannot prove which patch is installed in production.

The compiler publishes both the workflow and the exact scanner source in one
reviewable managed-file proposal. It does not install an unpublished Hypervibe
package or depend on application package scripts. The workflow checks out the
event's exact commit with read-only repository permission and without retained
checkout credentials. It installs only the managed Node execution runtime,
runs the scanner, preserves its failure status, and retains the JSON report for
30 days. It does not receive provider credentials or change application code.

Persist intent, review the concrete `hv_plan`, and apply that plan. The existing
GitHub infrastructure path prepares a pull request for the managed files. The
schedule is not installed until the reviewed files reach the repository's default
branch. GitHub may delay or drop scheduled runs and disables schedules in inactive
public repositories after 60 days. File presence is therefore not proof that the
latest review ran. [GitHub schedule contract](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

The scanner queries OSV with admitted public npm package names and exact locked
versions. It also reads Node's official release and support feeds. It does not
send lockfile contents, registry credentials, or source code. Public requests go
to `api.osv.dev`, `nodejs.org`, and
`raw.githubusercontent.com/nodejs/Release/main/schedule.json`. Reports retain
source file hashes, Git attribution where available, advisory source hashes,
findings, and explicit coverage gaps.

The exit status is `0` for a complete clear review, `1` for findings, and `2` for
incomplete coverage without findings. Findings may coexist with incomplete
coverage; inspect the separate `complete` field. Advisory severity is unknown
unless independently established; the scanner does not label every finding
critical. Unknown registry provenance, unapproved scoped packages, unreadable
sources, unsupported lockfile types, uncertain runtime versions, and failed
advisory requests cannot produce a clean result.

This initial review covers selected npm locks and declared Node versions. It does
not inventory the deployed package tree, running containers, operating-system
packages, Python, Yarn, pnpm, or provider-managed runtimes. A clean result is
bounded advisory evidence, not proof that an application is secure.

## Weekly code reviews and update proposals

Use the existing `github.actions` `code-audit` capability for a scheduled source
review with reviewed instructions, optional bounded shards, and an appropriate
OpenAI connection. It reports issues through the existing lifecycle. It is
separate from the deterministic public-advisory scanner and does not establish
deployment health or successful remediation.

For example, the following action requests a Monday source review after it is
accepted through the GitHub infrastructure lifecycle:

```json
{
  "github": {
    "actions": {
      "security-code-review": {
        "kind": "code-audit",
        "schedule": { "cron": "29 4 * * 1", "timezone": "UTC" },
        "instructions": "Review authentication, authorization, input handling, secret custody, and dependency trust. Require concrete code evidence for each finding and state unverified coverage."
      }
    }
  }
}
```

Existing `github.dependencies` settings can enable alerts, security-update pull
requests, and daily version-update checks. For example:

```json
{
  "github": {
    "dependencies": {
      "alerts": true,
      "securityUpdates": true,
      "versionUpdates": [
        { "ecosystem": "npm", "directory": "/", "interval": "daily" }
      ]
    }
  }
}
```

Dependabot configuration requests update pull requests; it does not prove that a
fix was tested, merged, or deployed. GitHub's daily version-update schedule runs
on weekdays. Security-update availability also depends on repository and package
support. [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)

For a critical finding, establish the affected version and supported remediation,
prepare a focused patch, run the repository's required checks, and deploy through
the reviewed lifecycle. Runtime changes must reach the actual Dockerfile or
declared project runtime used by the build. Re-run the advisory review against
the changed source, and verify the deployed release separately. The security
review workflow does not automatically patch, merge, or deploy those changes.

## Monthly credential work

The monthly policy is a due signal. Use the
[project credential rotation workflow](project-key-rotation.md) to inventory
every environment, shared connection, issuer identity, and external consumer.
Each supported replacement still needs exact mutation authority and recovery
evidence. Shared scope, unknown consumers, unresolved destination trust,
unsupported issuer capabilities, and immutable encryption keys remain blockers.
Emergency revocation follows incident containment requirements and must not wait
for the monthly cadence.

A database replacement declaration, when applicable, includes an explicit
generation and owner assertions:

```json
{
  "credentialRotation": {
    "generation": 1,
    "consumers": "environment-only",
    "destinations": "trusted"
  }
}
```

This belongs under the selected environment's `database` block. These assertions
do not independently prove consumer scope or host trust. Planning must still
establish provider capability, maintenance prerequisites, exact database identity,
required confirmation, and a safe recovery path. Declaring the policy or this
generation does not complete a rotation or authorize a background scheduler to
replace credentials.

## Verification boundaries

Ordinary acceptance tests cover policy defaults and legacy absence, invalid and
future evidence, calendar-month boundaries, managed-file publication, read-only
workflow permissions, immutable checkout selection, and execution of the emitted
launcher with success/failure/incomplete statuses. Scanner tests exercise its
actual network boundary with controlled public responses. Those offline checks
do not prove that GitHub has installed a schedule, that a live provider accepted
a credential replacement, or that application consumers have recovered.
