# OpenTofu engine on AWS

The AWS backend for the [OpenTofu engine](opentofu-engine.md). It follows the
same lifecycle as GCP (`hv_spec` → `hv_plan` → approved `hv_apply`), with the
same local encrypted state, saved plans, approvals and receipts. This page
records the AWS-specific decisions and why they were made.

## Status (2026-11-10)

| Piece | State |
| --- | --- |
| Sign-in without the AWS CLI | Built; verified live |
| One-time setup (deploy role, boundary, GitHub OIDC, local key) | Built; verified live |
| OpenTofu runs as the deploy role | Built; read-only probe verified live |
| Registry, runtime role, storage, database configuration | Built; passes `tofu validate` |
| Web, worker, cron, image builds, secrets wiring | Not built |
| CI releases, data migration, teardown | Not built |

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
  - `hypervibe-deploy-<project>` (role): what OpenTofu runs as, from this computer
    and from the repository's GitHub Actions (keyless OIDC).
  - `hypervibe-deploy` (policy): workloads, database, storage, schedules,
    parameters under `/hypervibe/*`. IAM writes are limited to roles under
    `/hypervibe/app/` that carry the boundary.
  - `hypervibe-app-boundary` (policy): the most any app role can do. It has no
    IAM writes, and the deploy role is denied changing it or removing it from a role.
  - `hypervibe-local` (user): can only assume deploy roles. Its key is stored
    encrypted on the computer; the engine gets one-hour role credentials.
- **Trust uses the account principal plus `aws:PrincipalArn`.** A user created
  seconds earlier is rejected as an "invalid principal"; the account never is.
- **Region** follows the app's other environments, otherwise `us-east-1`.
  Hypervibe states the choice; it does not ask.

## Runtime choices

- **Web: Lambda by default, Fargate when needed.** Lambda (Web Adapter in a
  container image, or Lambda Web Functions for Node where available) scales to
  zero. Fargate is chosen for WebSockets, long requests, steady traffic or
  cold-start-sensitive apps; it needs a load balancer (about $16+/mo).
- **No App Runner.** It closed to new customers on 2026-04-30.
- **No Elastic Beanstalk for workers.** It runs always-on EC2 instances.
- **Worker: on demand.** A Fargate service at zero tasks, woken by an
  EventBridge Scheduler check, like the GCP worker pool and Workflows waker.
- **Cron:** EventBridge Scheduler running Lambda or a Fargate task.
- **Database: Aurora Serverless v2 at 0 ACU for staging.** It pauses when idle,
  so only storage is billed; waking takes about 15 s. Small production uses RDS
  `db.t4g.micro` (about $12/mo), since a minimum of 0.5 ACU costs about $44/mo.
- **Database network: public endpoint, TLS required (decided 2026-11-10).**
  Lambda runs outside a VPC, so it needs no NAT gateway, which costs about
  $32/mo and would be more than the rest of a staging environment. The database
  accepts only TLS and a generated 32-character password, similar to Cloud SQL's
  public IP. Private networking (NAT gateway, or a NAT instance at about $3/mo
  that Hypervibe would have to patch) stays an option for production.
- **Secrets: SSM Parameter Store `SecureString`**, which is free. Secrets Manager
  costs $0.40 per secret per month.
- **Lambda secrets are read at start, not stored in Lambda.** Lambda has no
  native Parameter Store references, and putting values in its environment
  would copy them into function configuration and engine state. The image
  Hypervibe builds reads `/hypervibe/<environment>/` at start; only the runtime
  role can read that path.
- **The database master password is managed by RDS**
  (`manage_master_user_password`, one Secrets Manager secret), so it never enters
  engine state. Hypervibe creates the app login through the RDS Data API, the
  way GCP uses the Cloud SQL Data API.
- **Aurora version: the newest minor of the spec's major**, read from AWS at plan
  time. Aurora PostgreSQL 18 is available (18.6 in us-west-2 on 2026-11-10), so
  apps on Postgres 18 elsewhere move without a downgrade.
- **Image builds: AWS CodeBuild**, like Cloud Build on GCP, so no local Docker.
  This needs CodeBuild access added to the deploy role (a setup update).

## Provider pin

`hashicorp/aws` 6.70.0 (released 2026-10-22), with `h1:` lock hashes from
`tofu providers lock` for darwin and linux (amd64 and arm64) and windows amd64.
