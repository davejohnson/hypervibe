# Infra Chat Control Plane — Product Spec (Railway + Cloudflare + Stripe + SendGrid + Local-First)
**Project codename:** Infra Chat  
**Primary use case:** Operate *Invoice Perfect* (api + web + cron; Sequelize migrations) via chat commands like “deploy staging” / “deploy production”, with automatic environment creation, canary, rollback, migrations, backfills, observability, alerting, and auditability—without GitOps.

---

## 1) Product vision
A chat-driven **infrastructure control plane** that:
- Owns the *desired state* of environments (local/staging/production) in its own database (not Git).
- Reconciles that desired state onto real providers (initially Railway + Cloudflare).
- Handles deploy/migrate/backfill/canary/rollback as **typed runs** with strong audit trails.
- Makes local development first-class (compose + webhook tunneling + mocks).
- Monitors canaries/logs/health and can **auto-rollback** and **notify** (SMS/text) when anomalies appear.
- Can propose fixes and (within strict boundaries) apply safe remediation actions.

---

## 2) Goals and non-goals

### Goals
1. **Chat-first operations**: Setup, deploy, migrate, canary, rollback, add/remove components.
2. **Auto-create environments**: If `staging`/`production` doesn’t exist, create from templates or by cloning the closest env.
3. **Similarity by default**: `production` mirrors `staging` shape, with explicit overrides (domains, scaling, policies).
4. **Local-first parity**: Local is a real environment with same service graph (api/web/cron) and components (DB/storage, etc.) mapped to local equivalents.
5. **Canary + rollback**: Canary rollouts with automated checks; rollback on failure.
6. **Migrations + data backfills**: Sequelize migrations + managed backfill jobs (resumable, rate-limited, verified).
7. **Observability + alerting**: Monitor logs/health; send notifications on anomalies; attach incident bundles to audit.
8. **Audit + compliance**: Every chat action becomes an immutable run with receipts and diffs.

### Non-goals (MVP)
- Full multi-cloud / multi-platform support (start with Railway + Cloudflare).
- Arbitrary “agent changes code in prod” (remediation is bounded and reversible).
- Full GUI console (optional later; focus on chat + API).

---

## 3) User stories (Invoice Perfect-focused)
1. **Setup**
   - “Set up local, staging, production for Invoice Perfect on Railway. Use Cloudflare for DNS and canary. Connect Stripe + SendGrid.”
2. **Deploy**
   - “Deploy staging.”
   - “Deploy production with canary 10/50/100.”
3. **Migrate**
   - “Run migrations on staging.”
   - “Deploy production and run migrations first.”
4. **Backfill**
   - “Add timezone column and backfill timezone from address in staging; then do production at 500 users/min.”
5. **Rollback**
   - “Rollback production to the previous release.”
6. **Infra edit**
   - “Add Redis to staging and production.” / “Remove Redis from staging.”
7. **Alerting**
   - “Text me if the canary looks weird or if a rollback triggers.”
8. **Remediation**
   - “If we see repeated 500s after deploy, rollback and open an incident bundle with logs and diffs.”

---

## 4) Core concepts and data model

### 4.1 Entities
**Project**
- name (e.g., Invoice Perfect)
- default platform target (railway)
- service catalog (api/web/cron)
- default policies (prod gates, canary strategy)

**Environment**
- name: `local`, `staging`, `production`, etc.
- template / base_env reference
- platform bindings (railway project/service ids, cloudflare zone ids)
- domain bindings
- components (postgres, redis, storage, queues, cron)
- provider connections required (stripe, sendgrid, etc.)
- policies/overrides

**Service**
- name: `api`, `web`, `cron`
- source: repo ref + path + build strategy (dockerfile/buildpack)
- runtime config (ports, health endpoint, start command)
- env var spec (keys + refs)
- dependencies on components (db/storage/etc)

**Component**
- type: postgres, redis, storage, queue, cron scheduler
- size/class configuration (small/med/large)
- binding outputs (componentref URLs) to env vars

**Connection**
- provider: railway/cloudflare/stripe/sendgrid
- status: unconfigured → pending-auth → configured → verified
- metadata (account id, zone id, etc.)
- secrets (stored separately)

**Secret**
- stored in control plane secret store (encrypted)
- referenced via `secretref://...`

**Run**
- types: `setup`, `deploy`, `migrate`, `backfill`, `rollback`, `reconcile`, `remediate`
- status: planned, awaiting-approval, running, succeeded, failed, rolled-back
- plan steps + receipts + diffs + metrics snapshot
- notification destinations

**AuditEvent (append-only)**
- timestamp, actor (user/agent), intent, plan_id, run_id
- provider receipts hashes, diff summary
- links to incident bundle artifacts

### 4.2 Storage requirements
- Postgres for control plane state
- Append-only audit table (plus immutable object storage for run artifacts)
- Secret encryption at rest (KMS-backed later; start with libsodium + master key)

---

## 5) System architecture

### 5.1 Components
1. **Chat Orchestrator**
   - Interprets user intent.
   - Collects missing info via minimal question tree.
   - Produces *Plan* (read-only) and *Run* (apply).
2. **Control Plane API**
   - CRUD for projects/envs/services/components/connections
   - Plan/Apply endpoints
   - Run status + logs + artifacts
3. **Policy Engine**
   - Validates “can this action happen now?”
   - Enforces prod approvals, allowed refs, rate limits, budgets
4. **Provider Adapters**
   - Railway adapter
   - Cloudflare adapter (DNS + canary routing)
   - Stripe adapter (optional automation: webhooks)
   - SendGrid adapter (domain/sender setup + verification where possible)
5. **Observability + Monitor**
   - Health checks, error-rate tracking, log pattern detection
   - Canary scoring; triggers rollback proposals/actions
6. **Notification Service**
   - SMS/text (e.g., Twilio) and/or email/push
   - Escalation rules
7. **Job Runner (Backfills/Migrations)**
   - Runs migration and backfill steps as jobs via Railway one-off job or service command
   - Tracks progress via ops tables / run telemetry

### 5.2 Control plane “two-phase” operation
- **Plan**: produce step list + diffs + risk summary. No external writes.
- **Apply**: execute steps; record receipts; monitor; rollback if needed.

---

## 6) Provider integration specs

### 6.1 Railway adapter (MVP)
**Capabilities**
- `railway.ensure_project(env)`
- `railway.ensure_service(env, service)`
- `railway.ensure_postgres(env)`
- `railway.ensure_redis(env)` (optional)
- `railway.set_env_vars(env, service, resolved_vars)`
- `railway.deploy(env, service, ref)`
- `railway.run_job(env, service, command, ref)` (migrate/backfill)
- `railway.fetch_logs(env, service, since)`
- `railway.release_list(env, service)`
- `railway.rollback(env, service, release_id)`
- `railway.status(env, service)`

**Notes**
- No manual secret copying: env vars are reconciled by control plane.
- Deploy ordering: migrate job → api/web → cron.

### 6.2 Cloudflare adapter (MVP)
**Capabilities**
- `cf.ensure_zone(project)`
- `cf.dns.ensure_record(zone, name, target)`
- `cf.tunnel.ensure(local_webhook)` (optional for local)
- `cf.canary.route_weights(zone, hostname, backends, weights)`
- `cf.healthcheck.configure(hostname, endpoints)`
- `cf.rollback.route_previous(hostname)`

**Canary strategy**
- Preferred: Cloudflare traffic splitting between `api-stable` and `api-canary` origins.
- Origins can be separate Railway services or separate Railway deployments behind distinct hostnames.
- Weight steps: e.g., 10% → 50% → 100% with soak windows.

### 6.3 Stripe connection (MVP)
- Store test key now; live key later.
- Optionally automate webhook creation + secret storage.
- Track `mode: test|live` per environment.

### 6.4 SendGrid connection (MVP)
- Store API key + sender identity metadata.
- Optional automation: domain authentication steps where possible; otherwise track checklist state.

### 6.5 Text/SMS notifications (MVP)
- Twilio (or equivalent) connection.
- Destinations set per environment (prod escalations).
- Messages include: run id, diff summary, canary score, rollback decision, links to logs/artifacts.

---

## 7) Local-first development

### 7.1 Local environment model
Local env is stored like others, but reconciled to:
- Docker compose components: Postgres, Redis(optional), MinIO(optional), Mailhog
- `api` and `web` run locally (or in compose) with mirrored env vars
- Webhook ingress via tunnel (Cloudflare Tunnel or ngrok), configured by bot
- Stripe uses test mode; SendGrid goes to sink

### 7.2 “bootstrap local” output artifacts
- `compose.yaml`
- `.env.local` (non-secret config + `secretref://` placeholders)
- `dev-tunnel` setup (webhooks)
- seed scripts + health dashboard URL

---

## 8) Deployment pipeline spec

### 8.1 Deploy plan steps
For `deploy <env>`:
1. Resolve release ref (latest successful / specified)
2. Preflight checks
3. Reconcile env shape (create missing services/components)
4. Reconcile config (vars, domains, bindings)
5. Run migrations (schema)
6. Deploy `api` + `web`
7. Deploy `cron`
8. Canary rollout (if env policy enables)
9. Post-deploy verification (health + key metrics)
10. Finalize release record

### 8.2 Post-deploy verification signals
- HTTP health endpoint checks (api/web)
- Error rate (5xx) over rolling window
- Latency p95 threshold
- Log anomaly patterns (panic, “SequelizeDatabaseError”, “Out of memory”, etc.)
- Optional business checks (Invoice Perfect): login, Lightspeed OAuth callback reachable, daily cron dry run

### 8.3 Canary scoring and rollback
**Canary Score** computed from:
- delta 5xx rate vs baseline
- latency regression
- critical log patterns frequency
- failed synthetic checks

**Rollback trigger rules**
- Hard trigger: critical health check fails N times
- Soft trigger: canary score below threshold for soak window → propose rollback; auto-rollback in prod if policy allows

**Notification**
- On trigger: send SMS with summary + action taken (or approval needed)

---

## 9) Migrations + data backfills (Sequelize)

### 9.1 Sequelize schema migrations
- Migrations are run as a dedicated job step:
  - `sequelize db:migrate` (or your wrapper)
- Run ordering:
  1) schema migrate
  2) deploy app
  3) (optional) contract migrations after soak

### 9.2 Expand/Backfill/Contract model (recommended)
1. **Expand**
   - Add new nullable column(s), indexes, tables
   - Deploy code compatible with both old/new
2. **Backfill**
   - Run controlled backfill jobs (below)
3. **Contract**
   - Add NOT NULL, drop old fields, tighten constraints

### 9.3 Backfill job framework
**Requirements**
- Idempotent
- Resumable (cursor/checkpoint)
- Rate-limited
- Verified (coverage + invariants)
- Observable (progress + error samples)

**Standard interface**
- App exposes a job runner (choose one):
  - CLI: `node ops/runJob.js --job backfillTimezone --cursor ...`
  - HTTP: `POST /ops/jobs/run {job, params}`
- Each job writes to `ops_job_runs` and `ops_job_events` tables.

**Example: timezone backfill**
- Expand: add `timezone` nullable
- Backfill job:
  - Select users missing timezone in batches
  - Derive timezone from address (geocode or rule-based)
  - Write timezone; record failures with reason codes
- Verify:
  - % filled target
  - timezone string validity (IANA)
  - sample checks

### 9.4 Data fix runs as first-class “BackfillRun”
- Parameters: env, job_name, batch_size, rate_limit, max_runtime, dry_run
- Stop/resume supported
- Backfill runs can be scheduled (e.g., overnight)

---

## 10) Monitoring, remediation, and “make fixes for me”

### 10.1 Monitoring scope (MVP)
- Deploy-time monitoring (canary windows)
- Continuous monitoring (prod):
  - health endpoints
  - error-rate spikes
  - log pattern alerts
  - queue depth (if applicable later)

### 10.2 Safe remediation actions (bounded)
Allowed auto-actions (configurable):
- Rollback to previous release
- Scale service up/down within limits
- Restart service
- Disable cron temporarily
- Toggle feature flags (if wired)
- Reduce canary weight / halt promotion

Not allowed automatically (MVP):
- Modify application code
- Run destructive migrations
- Purge data

### 10.3 “Fix proposal” loop
When anomalies occur:
1. Bot creates incident bundle (logs/diffs/metrics)
2. Proposes remediation steps (with risk)
3. If policy allows: auto-apply (e.g., rollback); otherwise request approval

### 10.4 Notifications
- SMS for: canary anomalies, rollback executed, deploy failed, repeated 500s
- Include: env, run id, release ids, canary score, next steps, links

---

## 11) Conversation design (question tree)

### 11.1 Setup (minimal questions)
Only ask when unknown:
- Project name
- Repo/build strategy for api/web/cron
- Domain names for staging/prod
- Components toggles (Postgres required; others optional)
- Connections:
  - Railway account connect
  - Cloudflare zone/domain connect
  - Stripe test/live keys
  - SendGrid key + sender domain
  - SMS destination(s)

### 11.2 Deploy prompts (when needed)
- “Which ref?” (default: latest successful)
- “Canary policy?” (default: staging soak; prod 10/50/100)
- “Approve prod deploy?” (if required)

### 11.3 Backfill prompts (when needed)
- “Batch size / rate limit?”
- “Dry run first in staging?”
- “Schedule window?”

---

## 12) API surface (control plane)

### 12.1 Core endpoints (illustrative)
- `POST /projects`
- `POST /projects/:id/envs`
- `GET /envs/:id`
- `POST /envs/:id/plan` (create plan for action: setup/deploy/migrate/backfill/rollback)
- `POST /plans/:id/apply`
- `GET /runs/:id` (status + artifacts)
- `POST /runs/:id/approve`
- `POST /runs/:id/stop` (for backfills)
- `GET /audit?env=production&since=...`

### 12.2 Provider operations (internal)
Adapters are invoked from the orchestrator, not directly by end-users.

---

## 13) Security and permissions

### 13.1 AuthN/AuthZ
- Users and roles (admin, deployer, viewer)
- Production actions gated (approval)
- Sensitive actions require MFA (later) or explicit confirmation step

### 13.2 Secret handling
- Secrets never shown in chat after entry
- Encrypted at rest
- Access logged
- Rotation supported as a run type

---

## 14) MVP build plan (ASAP path)

### Phase 0 (2–3 days scope if focused)
- Control plane DB schema + API for projects/envs/services
- Railway connection + deploy (api/web/cron)
- Local bootstrap artifact generation (compose + env)
- Basic runs + audit log

### Phase 1
- Cloudflare DNS + canary routing (weighted)
- Deploy pipeline with canary scoring + rollback
- SMS notifications on canary/rollback

### Phase 2
- Sequelize migration job integration
- Backfill run framework (ops tables + run/stop/resume)
- Incident bundles (logs + diffs + metrics snapshot)

### Phase 3
- Continuous monitoring loop
- Safe remediation actions + proposal/apply gates

---

## 15) Invoice Perfect defaults (initial config)
**Services**
- `api`: HTTP API + webhook receivers
- `web`: UI
- `cron`: scheduled tasks (daily summaries, sync jobs)

**Components**
- Postgres: required
- Storage: required if storing PDFs/images (recommend)
- Redis: optional (future queues/caching)

**Providers**
- Railway: deploy target
- Cloudflare: DNS + canary routing
- Stripe: billing (test in staging/local)
- SendGrid: outbound email

**Policies**
- Staging: soak canary + auto-apply
- Production: requires approval + weighted canary + auto-rollback enabled

---

## 16) Acceptance criteria
1. “deploy staging” works end-to-end (plan → apply), including migrations.
2. “deploy production” does weighted canary and auto-rollbacks on failing signals, and sends SMS.
3. “create production” from staging works (shape parity, domains, overrides).
4. Local bootstrap produces a working local stack with webhook ingress.
5. A backfill run can be started/stopped/resumed with audit + progress.

---

## Appendix A — Run artifact format (suggested)
Each run stores:
- `run.json`: intent, actor, timestamps, status
- `plan.json`: ordered steps + preconditions
- `diff.json`: env desired-state diff
- `receipts/`: per provider call (request metadata, response metadata, ids)
- `metrics.json`: canary score inputs + results
- `logs/`: selected log excerpts + pointers
- `incident.md`: human summary when failure/rollback occurs
