# AWS engine implementation notes

The AWS backend for the [OpenTofu engine](opentofu-engine.md). It follows the
same lifecycle as GCP (`hv_spec` → `hv_plan` → approved `hv_apply`), with the
same local encrypted state, saved plans, approvals and receipts. This page
records AWS implementation decisions and dated evidence. Product scope and future
priorities belong to the [common user journey](development/user-journey.md). This
page does not establish a complete supported AWS journey.

## Recorded evidence

The earlier deployment and teardown results were recorded on 2026-11-12; the
guided launch was recorded on 2026-11-14. These results describe the named apps
and runs. They do not verify other profiles, workloads or subsequent revisions.

| Piece | State |
| --- | --- |
| Runtime logs and deployment health (`hv_logs`, `hv_health`) | Built; offline transport and command tests only, no live validation. See [diagnostics scope](engine-diagnostics.md). |
| Sign-in without the AWS CLI | Built; verified live |
| One-time setup (deploy role, boundary, GitHub OIDC, local key) | Built; verified live |
| OpenTofu runs as the deploy role | Built; read-only probe verified live |
| Registry, runtime role, storage, database, app login | Built; applied live (billforge `aws`) |
| Image builds and releases (`hv_deploy`) | Built; verified live (demo app) |
| Private package tokens in CodeBuild / BuildKit | Built; offline request, generated command and runtime-isolation regressions; not live verified |
| Web services as containers (Fargate, ECS Express Mode) with a database that has no public address | Built 2026-11-17; the generated configuration passes `tofu validate` against the pinned provider and offline request tests. **Verified live 2026-11-19 (us-east-1)** by one passing run of the `aws-engine` [live profile](provider-conformance.md) on a new environment: one apply creates the cluster, database, storage, web service, workers and scheduled job; the web service answers over HTTPS and uses the database, which has no public address and does not answer a connection from outside; a release, an update and a teardown. Three faults were found and fixed on the way: a zero build limit on a new account, the database login created after the services that read it, and a release reported unfinished while AWS still listed the old configuration. **Not yet run live**: rollback and the move of an existing Lambda environment are unverified |
| On-demand worker and cron (Fargate) | Built; verified live (demo app) while web ran on Lambda: generated secret, storage with the runtime role, worker woken by the next-due timer while Aurora was paused, no drift after releases. The waker's web-request check now reads load balancer metrics and is not yet run live |
| Environment teardown (`hv_plan scope="teardown"`) | Built; verified live (demo and billforge `aws`): a read-only sweep found nothing left |
| `hv_launch` for testing environments (one reviewed plan: registry and build project in their own state, the first image built inside the apply, then everything else) | Built; verified live (demo app, 2026-11-14): one round, no sign-in (account access reused), web health-checked, database, secret, storage and cron working, worker jobs done 87 s (cold start) and 0.7 s after due, empty plan after |
| Runtime settings copy (`hv_migrate`) | Built; not yet run live |
| Production-profile database (RDS `db.t4g.micro`) | Not built; planning blocks it |
| CI releases | Implemented; offline verification, live unverified; see [branch releases](engine-ci-releases.md) |
| Data copy, `hv_launch` for staging and production | Not built |
| Live worker state in `hv_status` | Not built; use `hv_health` and `hv_plan` |

Current planner limits (code reviewed 2026-11-13):
[`awsEngineProblems`](../src/application/infrastructure-engine-aws.ts) blocks a
database in an environment whose name matches `/prod|stag/i`, as well as Redis,
queues and custom hosting domains. The production database design below is not
implemented. These guards and the recorded testing runs do not prove production
readiness for an environment without a database either.

## Access

- **Sign-in.** Hypervibe implements AWS Sign-In OAuth, the documented flow behind
  `aws login` (same-device client, PKCE, DPoP). The admin session stays in memory
  and is used once for setup. Nothing to install.
- **One sign-in, one click.** After signing in, the local page lists the exact
  setup changes and the person approves them there.
- **Expired-session 400.** AWS returns `400 Bad Request` with no redirect when
  the browser holds cookies from an expired AWS session
  ([aws/aws-cli#10186](https://github.com/aws/aws-cli/issues/10186)). The page
  explains this and links to sign out of AWS. A private window also works.
- **What setup creates** (all free):
  - `hypervibe-deploy` (role, one per account): what OpenTofu runs as for every
    project, from this computer and from GitHub Actions in each trusted owner's
    repositories (`repo:<owner>/*`, keyless OIDC). Earlier versions created one
    role per project; the next setup run moves their saved access to this role
    and removes them.
  - `hypervibe-deploy` (policy): workloads, database, storage, schedules,
    parameters under `/hypervibe/*`. IAM writes are limited to roles under
    `/hypervibe/app/` that carry the boundary.
  - `hypervibe-app-boundary` (policy): the most any app role can do. It has no
    IAM writes, and the deploy role is denied changing it or removing it from a role.
  - `hypervibe-local` (user): can only assume deploy roles. Its key is stored
    encrypted on the computer; the engine gets one-hour role credentials.
- **Trust uses the account principal plus `aws:PrincipalArn`.** A user created
  seconds earlier is rejected as an "invalid principal"; the account never is.
- **One sign-in per account.** Access is saved per GitHub owner (`<owner>/*`), so
  a new repository of the same owner needs nothing. A project of another owner
  (or with no remote) reuses the account's access without signing in when exactly
  one account is connected and its access is current; otherwise setup signs in.
  A new owner's GitHub Actions need one setup run to be trusted.
- **Region** follows the app's other environments, otherwise `us-east-1`.
  Hypervibe states the choice; it does not ask.

## Runtime choices

Cost figures below are estimates recorded during the November 2026 design work,
not current quotes.

- **Web: containers on Fargate through ECS Express Mode (decided 2026-11-17).**
  One container is always running, so there are no cold starts, one container
  serves many requests on a shared database connection pool, and WebSockets and
  long requests work. AWS gives each public service an HTTPS address
  (`<service>.ecs.<region>.on.aws`), shares one load balancer between up to 25
  services in the account's network, replaces containers gradually on release
  and rolls a failed release back. A web service that is not public is an
  ordinary ECS service with no route to it. Each service scales from one to
  three containers on CPU. Lambda was the earlier path: it cost nothing while
  idle, but it sits outside the network, so it could reach the database only
  through a public database address or a NAT gateway (about $33/mo, estimated).
  Lambda as an opt-in for apps without a database is not built.
- **Why not a plain load balancer behind CloudFront.** A load balancer without
  a certificate needs CloudFront for HTTPS, and then reports every request to
  the app as plain HTTP (`X-Forwarded-Proto: http`), which breaks secure cookies
  and HTTPS redirects. Express Mode terminates HTTPS on the load balancer.
- **No App Runner.** It closed to new customers on 2026-04-30.
- **No Elastic Beanstalk for workers.** It runs always-on EC2 instances.
- **Worker: on demand.** A Fargate service at zero tasks, woken by an
  EventBridge Scheduler check, like the GCP worker pool and Workflows waker.
- **Cron:** EventBridge Scheduler running a Fargate task.
- **Database profiles (design recorded 2026-11-10).** Names matching
  `/prod|stag/i` select the production profile, but its proposed always-on RDS
  `db.t4g.micro` Postgres (estimated about $12/mo at the time) is not built and
  planning blocks it. Other names (`test`, `preview`, `pr-*`, `dev`, pilots) use
  the implemented testing profile: Aurora Serverless v2 at 0 ACU, which pauses
  when idle so only storage is billed. The recorded wake time was about 15 s.
  Aurora kept awake (minimum 0.5 ACU, estimated about $44/mo at the time) was
  rejected as the default. This is an AWS implementation decision, not a
  cross-cloud support guarantee.
- **Testing environments share one cluster (decided 2026-11-14).** Creating an
  Aurora cluster and its instance takes about 10 minutes, most of a first
  launch. So a project's testing environments share one cluster
  (`hv-<project>-shared-postgres`, in its own OpenTofu state), as they share one
  Postgres server on Azure. Each environment gets its own database
  (`app_<env>`), owner login and worker-waker login. `CONNECT` is revoked from
  `PUBLIC`, so no environment's logins can reach another's database. A new testing
  environment adds only a database and logins, which takes seconds. Testing
  environments must use the same Postgres major. Staging and production will
  get their own databases. An environment created with its own cluster before
  this change is blocked from planning until it is torn down and launched again.
  Verified live 2026-11-15 in us-west-2: the first launch created the cluster;
  a second testing environment launched in 3m12s with no cluster change. Its
  waker login was refused on the other environment's database
  (`permission denied for database`). Tearing it down dropped only its database,
  and tearing down the last environment removed the cluster.
- **Database network: no public address (decided 2026-11-17, replacing the
  2026-11-10 public endpoint).** The cluster is not publicly accessible and its
  security group admits port 5432 only from the account's default network
  range, so nothing on the internet can connect. Web services, workers and
  jobs run in that network's public subnets (a public address for outbound
  calls, no NAT gateway) and reach the database on its private address over
  TLS. Hypervibe's own SQL goes through the RDS Data API and needs no network
  path. Other workloads the account owner runs in the same default network
  can reach the port and still need the generated password.
- **Secrets: SSM Parameter Store `SecureString`**, which is free. Secrets Manager
  costs $0.40 per secret per month.
- **Secrets reach containers by reference.** ECS reads each declared secret
  from Parameter Store when a container starts; values never enter the service
  configuration or engine state, and only the runtime role can read them.
- **The database master password is managed by RDS**
  (`manage_master_user_password`, one Secrets Manager secret), so it never enters
  engine state. Hypervibe creates the app login through the RDS Data API, the
  way GCP uses the Cloud SQL Data API.
- **Aurora version: the newest minor of the spec's major**, read from AWS at plan
  time. Aurora PostgreSQL 18 is available (18.6 in us-west-2 on 2026-11-10), so
  apps on Postgres 18 elsewhere move without a downgrade.
- **Image builds: AWS CodeBuild**, like Cloud Build on GCP, so no local Docker.
  Hypervibe uploads the exact local commit (`git archive`) and adds the RDS
  certificate authorities to the repository's or the generated Dockerfile. Generated images pull their base from
  ECR Public, which avoids Docker Hub's pull limits on shared build hosts. Tags
  are immutable commit SHAs, and an already-built commit reuses its image.
- **One image for every workload.** The first release only builds it, because
  workloads are created from an existing image; the next infrastructure plan
  creates them. Later releases update the web service's image and register a
  new task revision for workers and jobs. Task definitions use `track_latest`, so released revisions are not
  drift, and scheduled jobs reference the family, so they run the latest.

## Teardown

`hv_plan scope="teardown"` removes a whole AWS environment as one reviewed
plan; every action needs its own confirmation:

1. Hypervibe empties each storage bucket. Buckets are created without
   `force_destroy`, so deleting files is never a side effect of another change.
2. OpenTofu destroys everything it created (`tofu plan -destroy`).
3. Hypervibe removes what it created outside OpenTofu: the environment's
   Parameter Store settings, task revisions registered by releases (deregistered,
   then deleted) and the CodeBuild log group.
4. The environment's bindings are cleared and it is removed from the spec, so the
   next plan does not recreate it.

While other testing environments use the shared cluster, teardown drops only
the environment's database and logins (no snapshot; the cluster's one-day
backups can restore the whole cluster). The last testing environment's teardown
removes the cluster too, which keeps a final snapshot
(`hv-<project>-shared-postgres-final`) unless the plan
uses `deleteFinalSnapshot=true`, which adds its deletion as its own confirmed
action; for an environment already torn down, it plans just that deletion.
Cleanup confirms the environment's roles are gone (`iam:ListRoles` on
`/hypervibe/app/`). Hypervibe's
account access (deploy role, boundary, local key) stays, for the project's other
environments.

## Waking on-demand workers

Aurora pauses only after ten minutes with no connections, and every pending-work
count is a connection. So the waker never counts just because the database is
awake. It counts when the app could have queued work: the worker is running,
the web service had requests in the last five minutes (the load balancer's
`RequestCountPerTarget` metric for the service's target group), a scheduled job just finished (an ECS event), or the next-due timer
fired. With nothing pending, it moves a one-time EventBridge Scheduler wake to
`onDemand.nextWorkAtQuery`'s time. Failures keep one worker running.

A web container is always running. If the app keeps idle database connections
open in its pool, Aurora never pauses and bills its minimum capacity around the
clock; an app that closes idle connections lets it pause. This is unmeasured on
the container path. An uptime monitor that calls the app also keeps it awake.

## Provider pin

`hashicorp/aws` 6.70.0 (released 2026-10-22), with `h1:` lock hashes from
`tofu providers lock` for darwin and linux (amd64 and arm64) and windows amd64.


## Private package builds

Declared outside `NODE_AUTH_TOKEN` or `NPM_TOKEN` secrets are resolved by
CodeBuild from this environment's Parameter Store path and supplied as the
BuildKit secret `npm_token`. The build role can read only the selected token.
Neither token key is wired into web, worker or scheduled-job settings; ordinary
runtime secrets use an explicit name list and exact parameter permissions.
Optional absent tokens are omitted, and an unknown observation blocks the build.
Repository Dockerfiles can use `RUN --mount=type=secret,id=npm_token`.

## Moving an environment off Lambda

An environment created while web services ran on Lambda moves in one reviewed
plan: each web service shows as a replacement (the function, its URL and log
group are removed and the container service is created), the service gets a new
address, and the shared database loses its public address. The plan is blocked
until the account's Hypervibe access is updated once (`hv_connections
provider="aws" action="connect"`), because AWS needs a new role to manage web
service load balancers. This path has offline evidence only.
