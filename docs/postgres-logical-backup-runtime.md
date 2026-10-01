# Retained PostgreSQL backup runtime

`backupAndVerifyPostgres` implements a portable logical archive and an isolated
restore of the retained bytes. It is separate from native volume snapshots,
backup schedules, PITR and application rollback. The caller supplies an exact
database recovery identity, exact object-store identity and durably reserved run
ID. The caller also owns private routing, the archive client, retention and the
hosting workload lifecycle.

The runtime holds a read-only repeatable-read snapshot while collecting the
database manifest and running `pg_dump --snapshot` in custom format. It uploads
under the reserved run prefix with conditional creation, downloads the stored
archive and checks both its byte length and SHA256. It restores those downloaded
bytes into a fresh local PostgreSQL cluster. There is no supplied restore URL
and no production-volume restore path. Completion is recorded only after the
restore, row-count and extension checks, optional read-only verification, local
server stop and temporary-file cleanup. The private completion manifest is
conditionally written and read back before a successful receipt is returned.
Format-2 evidence records the native archive revision from that SHA256-verified
download. After the isolated restore, the runtime rechecks the retained revision
before writing completion. Later health checks compare it again; byte length
alone cannot transfer successful restore evidence to an overwritten archive.

The SQL manifest identifies the snapshot's transaction time as `dataTime`.
Upload/restore completion time does not substitute for data coverage. A failed
or uncertain upload is never retried internally. A partial archive without
verified completion is not a usable recovery point; a repeated reserved run
cannot overwrite existing objects.

PostgreSQL documents that a dump can execute source-selected code during a
restore. The local server therefore receives a clean environment without source
or storage credentials, listens only on its private Unix socket and restores as
a fresh non-superuser role. There are no preload libraries. The current helper
admits only `plpgsql`, `pgcrypto`, `uuid-ossp`, `citext`, `hstore`, `btree_gin`,
`btree_gist`, `pg_trgm` and `unaccent`. Other extensions, foreign servers and
subscriptions fail preflight. This is deliberately narrower than every managed
provider's extension catalogue; a missing extension is not silently dropped.
These restrictions reduce restore side effects; this is not a general sandbox
for a malicious database owner.

The archive covers one database's schema and data. It does not preserve cluster
roles, passwords, ownership, grants, tablespace placement, server configuration,
native recovery timelines or an application's running image. The optional
verification query must return one boolean `ok` from a read-only transaction.
A successful query is database evidence; application and migration compatibility
remain unverified.

Reviewed `fileReferenceQueries` run against the restored SQL snapshot and must
return exactly one text `key` column. They are limited to 100,000 rows per
projection, 4,096 bytes per key and 16 MiB total key bytes. The keys are returned
separately from the safe evidence and stored only in the private manifest. The
joint recovery coordinator must verify those referenced objects in retained
file manifests before declaring a compatible database/files set. No projection
means no reference-compatibility evidence. This does not create a transaction
across a database and an object store or prove the history of overwritten keys.

`templates/backup-runner/Dockerfile` packages Hypervibe's own runtime with Node 24
and PostgreSQL 16. It runs as the `postgres` user with a fixed entrypoint; it does
not run application code or inherit an application image. The resulting image
must be published and its actual immutable digest reviewed before live use.
The Dockerfile alone is not a published image or live compatibility proof.
The tools must support the source server's major version; this image is not a
database upgrade and does not support dumping a newer server.

## Release publication

The tag-triggered [release workflow](../.github/workflows/release.yml) publishes
the helper alongside npm, including `--npm-only` releases. That option still
omits the macOS installers and GitHub Release; it does not omit the helper.
The helper job starts after package validation. It builds one `linux/amd64`
image from the checked-out release commit, checks its packaged version and runs
the SQL/files smoke with networking disabled, a read-only root filesystem and
temporary writable storage. It pushes that tested image without rebuilding.

After pushing, the publisher pulls the registry manifest digest anonymously and
checks the image identity, source revision, package version, platform and runtime
user. A local Docker image/config ID is not the registry manifest digest. Only
after these checks pass does it write `build/backup-runner-release.json`, expose
the immutable image reference in the job summary and upload the
`Hypervibe-backup-runner` Actions artifact. Open the release workflow run,
download that artifact and read the receipt's `image` field. Full GitHub Releases
also attach the receipt. The workflow requests 90-day artifact retention; commit
the selected digest in the application's reviewed backup spec when activating it.

The receipt identifies the release source, workflow run, tested package and
`image` reference to use as `backups.runnerImage`. It records
`providerLiveVerified: false`: a packaged restore with synthetic data and an
injected object transport does not verify production routing or provider access.
Npm publication requires the helper job to succeed. The helper can have been
pushed even if a later check or another release job fails; a failed job must not
be interpreted as proof that nothing was published.

**First GHCR publication requires an owner visibility change.** GitHub
[creates container packages as private by default](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
including packages published from public repositories. Successful authenticated
push does not establish anonymous pull access. If the first helper job fails its
anonymous pull, an owner must make the new
`ghcr.io/<owner>/<repository>/backup-runner` package public in its package
settings before rerunning the failed release jobs. Until that verification
succeeds, there is no successful helper receipt and npm publication stays
blocked. Each attempt uses a separate tag; the script does not retry an uncertain
push or overwrite a `latest`/version tag. Activate only the digest from a
successful receipt.

The normal test suite executes the publisher with synthetic Docker command
responses and checks release admission in both modes. The release job runs the
real packaged smoke and registry checks. Offline tests do not establish that
the package has been published or that GHCR access is configured correctly.

## Provider review

The common data-plane contract is PostgreSQL, not a provider's snapshot API.
The following review covers all eight registered database providers. Official
documentation is design evidence; no live provider certification is claimed.
Private execution and exact provider-reference wiring must be admitted by the
hosting adapter independently. A public proxy is not an acceptable substitute.

| Database provider | Applicable contract and remaining constraints |
| --- | --- |
| Railway | [Official backup guide](https://docs.railway.com/guides/postgres-backups-restores) documents private `DATABASE_URL` references from a scheduled helper and logical dumps. Native source-volume snapshots and their unobservable completion remain separate. The runtime does not enable PITR or change the database image. |
| Cloud SQL | [Official pg_dump/pg_restore guide](https://docs.cloud.google.com/sql/docs/postgres/import-export/import-export-dmp) supports logical export. Private execution needs a VPC-reachable runner/connector and appropriate SQL rights. The existing native clone drill's public connector setting does not prove private execution for this helper. |
| RDS | [Official PostgreSQL import guidance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Procedural.Importing.html) describes native dump/restore tooling and managed-superuser limits. The helper needs reviewed VPC routing, credentials and compatible extensions; this change does not implement an RDS private runner. |
| Azure PostgreSQL | [Official dump/restore guide](https://learn.microsoft.com/en-us/azure/postgresql/migrate/how-to-migrate-using-dump-and-restore) distinguishes single-database export, roles and tool-version requirements. A private network path and supported extension set are prerequisites; this change does not implement an Azure private runner. |
| Supabase | [Official logical restore guide](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) identifies separate role, managed-schema, encryption-key and platform configuration work. A generic PostgreSQL restore cannot certify a whole Supabase project or its Storage object bytes. Its platform extensions can make this narrow helper unsupported. |
| Neon | [Official dump/restore workflow](https://neon.com/blog/optimizing-dev-environments-in-aws-rds-with-neon-postgres-part-ii-using-github-actions-to-mirror-rds-in-neon) demonstrates native logical tooling. This does not prove a private route, session-safe snapshot export, compatible extension set or the provider's native recovery-point availability. Those remain prerequisites. |
| Fly Managed Postgres | [Official MPG documentation](https://docs.fly.io/postgres) identifies the private organization network and provider extension catalogue. [Official staff guidance](https://community.fly.io/t/you-asked-and-we-shipped-postgres-17-on-mpg/26430) recommends pg_dump/pg_restore between major versions. A provider runner must use the exact MPG source, not an unrelated Fly volume snapshot. |
| DigitalOcean | [Official PostgreSQL migration guide](https://docs.digitalocean.com/products/databases/postgresql/how-to/migrate/) documents custom-format pg_dump/pg_restore. A reviewed private/VPC path and supported SQL privileges/extensions are still required; this change does not implement a DigitalOcean private runner. |

The [PostgreSQL pg_dump contract](https://www.postgresql.org/docs/current/app-pgdump.html)
defines custom archives, synchronized snapshots, single-database scope and the
restore-code warning. The [pg_restore contract](https://www.postgresql.org/docs/current/app-pgrestore.html)
defines error-stop and single-transaction restoration. These contracts inform
the runtime tests; passing an in-memory archive store is not S3/provider wire
compatibility evidence.

## Verification evidence

The normal Vitest path runs the real local `initdb`, `pg_dump`, `pg_restore` and
`pg_ctl` boundary using synthetic data. It checks restored rows, enum, index,
identity sequence and `pgcrypto`, source writes after the snapshot, same-size
archive corruption, late verification failure, forbidden verification writes,
unsupported foreign servers, private file references and run collisions. The
tests require installed PostgreSQL tools and fail rather than silently skipping
when those tools are absent. Local execution used PostgreSQL 14.20. Before the
format-2 audit, the locally built helper passed `test/backup-runner-smoke.mjs` with PostgreSQL 16.15 and
Docker networking disabled: retained SQL and file bytes restored together,
schema and row checks passed, and a late SQL verification failure left no joint
completion. That smoke uses an injected object transport. These development
checks do not publish an image or verify the packaged format-2 changes;
publication requires a new verified release receipt.
Production routing and provider transports still require live acceptance.

The challenged assumptions were that successful upload proves retained bytes,
that verification SQL stays read-only without database enforcement, and that any
projection row describes one file key. Deliberately removing the checksum,
read-only transaction and one-column guards produced three observed failing
tests. Restoring the guards makes those counterexamples fail safely without a
completed recovery receipt.
