# Retained service filesystems across hosting providers

PR: https://github.com/davejohnson/hypervibe/pull/218

User scope: persistent mounts for every currently registered capable hosting
product; explicitly reject DigitalOcean App Platform and Vercel Functions.
No replacement hosting products, bucket substitution, automatic adoption,
filesystem deletion, resizing, or live infrastructure creation.

## Implementation

- Railway retains its native single-web-service volume contract.
- Fly stages app identity → encrypted 1 GiB volume → first mounted Machine.
  Existing diskless Machines are blocked, not replaced implicitly.
- ECS Express uses encrypted EFS/access point/network/IAM prerequisites and a
  custom task definition. Non-idempotent registration gets one SDK attempt.
- Azure Container Apps uses classic SMB Azure Files with separate account,
  share, environment registration and app attachment actions.
- Cloud Run stages API enablement, dedicated VPC/subnet, 1 TiB BASIC_HDD
  Filestore and GEN2 NFS attachment. The capacity/cost and no-locking limitation
  are explicit; incompatible existing networking blocks the change.

The shared staged driver declares a dependency graph. Only the ready frontier
is reviewed/applied; each write persists intent before mutation and acknowledges
its native scoped ID before dependent work. Unknown/unbound resources never
become absent or automatically adopted. Bindings merge monotonically and reject
secret-bearing or conflicting scope. Retained storage blocks unsafe enclosing
teardown and replacement. Whole-volume ready:false matches staged readiness.

Direct env/deploy paths and executed generated GitHub/portable scripts preserve
and verify mount configuration. GitHub renderer revision changes 3 → 4;
portable CI already fingerprints generated runtime bytes. Cloud Run uses etag
and verifies UID, ECS blocks a stale prepared task attachment, and Azure refreshes
its template but does not claim atomic concurrency.

## Evidence and limits

Observed counterexamples before fixes included missing mount propagation,
confirmation stripping for first Machine creation, lost mount after a nominally
ready deployment, overwritten newer runtime snapshots, ambiguous task-definition
registration retried three times, and ready:false incorrectly converging.
Targeted regressions passed after fixes. Official source links and contract
boundaries are in docs/service-volumes-design.md and test/provider-contracts/README.md.

Final local acceptance: 3,665 tests passed; 5 skipped and 1 todo, 264 passing
files and 3 skipped files. Typecheck and git diff --check passed. Normal npm test
and the checked-in acceptance workflow include regressions; live branch
protection is not asserted. Tests use real clients/serialized synthetic
transport and SQLite; only Railway's volume transport executes a pinned schema.
No provider live acceptance, mounted I/O, durability, permissions, regional
availability or billing is certified. No release/version bump is part of this
record. Local MCP activation and live staging remain separate steps.
