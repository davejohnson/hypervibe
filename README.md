# Hypervibe

**Build your app. Let Hypervibe handle the cloud.**

Hypervibe helps vibe coders turn a repository into a working app on Google Cloud,
AWS or Azure. Tell your coding agent what you want to run; Hypervibe should take
care of the DevOps work and ask you only for access, meaningful choices and
approval of consequential changes.

## What we are building

The goal is one straightforward journey from code to a running, recoverable app:

1. Understand the app and choose sensible infrastructure for it.
2. Connect your cloud account and prepare the infrastructure, permissions and
   private configuration the app needs.
3. Show the proposed changes, destination and cost implications for approval.
4. Deploy, verify the app works, and explain any remaining action.
5. Keep deployment, rollback, recovery, observability, secrets and third-party
   integrations in the same managed workflow as the app grows.

OpenTofu is the chosen underlying infrastructure lifecycle engine. Hypervibe owns
that integration so users do not need to write OpenTofu configuration or operate
it themselves. The target installation automatically provisions pinned, private
engine dependencies; users should not have to separately install OpenTofu,
Terraform, cloud CLIs or Docker to deploy an app.

### Current status

The [common cloud user journey](docs/development/user-journey.md) is the target
for Google Cloud, AWS and Azure. The complete journey is not yet established by
the recorded evidence. Current implementations and verification have different
limits:

- [Google Cloud](docs/opentofu-engine.md) automatically uses managed OpenTofu.
  Guided launch and CI release code exist; the dated live evidence predates the
  current infrastructure cutover and does not prove the complete journey.
- [AWS](docs/opentofu-engine-aws.md) records live testing-environment deployments
  and teardown. Guided launch, production-profile databases, CI releases, data
  copy and custom domains remain gaps.
- [Azure](docs/opentofu-engine-azure.md) records live testing-environment deployments
  and teardown. Production, guided launch, CI releases, migration and custom
  domains remain gaps; repository Dockerfiles requiring BuildKit are unsupported.

Local and provider-contract checks do not establish a live deployment. The linked
provider notes distinguish implementation from recorded live evidence. Railway
keeps its existing workflow. Use the [documentation map](docs/README.md) to find
the current requirements and implementation evidence.

New cloud development focuses on **Google Cloud, AWS and Azure**. **Railway stays
available for existing apps**; the new cloud journey does not require moving them.

The npm installation below currently requires Node.js and npm. A packaged
installation that removes those prerequisites is a target, not a verified promise.

## Install for your coding agent

With Node.js 22 or newer, npm and your coding agent installed, run the command for
your agent:

```sh
npx -y @hypervibe/hypervibe@latest install codex
npx -y @hypervibe/hypervibe@latest install claude
npx -y @hypervibe/hypervibe@latest install opencode
```

This installs the shared Hypervibe skill and registers its MCP server for your
user across projects. Restart your agent after setup. Installing Hypervibe does
not require a global CLI installation, a hosted account or a cloud login;
connecting a cloud account is a separate step.

These commands install the latest published release. Changes in this repository
become available through them only after release. See
[agent installation and updates](docs/agent-installation.md) for configuration
preservation, client details and verification limits.

If the macOS companion or another installation already manages your MCP
connection, add `--skill-only` to install the skill without registering a second
server. The macOS companion is available from
[GitHub Releases](https://github.com/davejohnson/hypervibe/releases/latest).
Choose `arm64` for Apple Silicon or `x86_64` for Intel; each DMG has an adjacent
`.sha256` checksum file.

## Work with your agent

Start in your app repository and describe the outcome, for example:

> Help me deploy this app to Google Cloud. Work out what it needs and show me
> the setup and cost implications before creating anything.

The agent should inspect the app, use verified connections where appropriate,
and explain unsupported work honestly. Sign-in or a successful infrastructure
command alone does not mean the app is deployed.

Hypervibe's workflow is `hv_spec` → `hv_plan` → approved `hv_apply` → verification:

- The spec records what the app needs.
- The plan describes the exact changes and dependencies.
- Apply executes only the approved, current plan.
- Verification checks the resulting infrastructure and app; incomplete work stays
  visible with its next supported action.

You can also use the same application commands through the optional CLI:

```sh
npm install -g @hypervibe/hypervibe@latest
hypervibe --help
```

For an existing project with a prepared spec:

```sh
hypervibe spec --file .hypervibe/spec.json
hypervibe plan --env staging
hypervibe apply --plan-id <plan-id>
hypervibe status --env staging
```

Use an environment declared in your project. Human-readable output is the default;
add `--json` for automation. See the [command reference](docs/TOOLS.md) for the
current interface and confirmation requirements.

## Develop Hypervibe

Start with the [common cloud journey](docs/development/user-journey.md),
[development instructions](AGENTS.md) and [architecture](ARCHITECTURE.md).
Build and verify its steps incrementally across the three clouds while preserving
existing Railway applications. The [GCP integration boundary](docs/development/opentofu-integration.md)
describes current ownership and routing; provider notes record implementation
and verification limits.

```sh
npm ci
npm run build
```

Use the repository's declared Node.js version for development. Follow the
[development workflow](docs/development/workflow.md) for focused verification,
PR handoff and releases. The [installed skill](skills/hypervibe/SKILL.md) is the
workflow users and coding agents receive; keep it aligned with capabilities that
are actually available.

## License

[Apache 2.0](LICENSE).
