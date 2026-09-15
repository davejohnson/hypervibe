# One-time hosted credential import

Use this when another person supplied delegated runtime credentials through a
Hypervibe hosted request. It does not create their Google or Autodesk account,
check provider validity, grant repository access, or deploy infrastructure.

## Workflow

1. The owner creates a hosted credential request from the committed spec; the
   named contributor supplies the values through the invitation page.
2. In the matching GitHub checkout, use `hypervibe cloud secrets --request-id
   <uuid> --env staging` (MCP: `hv_cloud_secrets`, action `start`). Obtain the safe
   request ID from the hosted Credentials list or its status API/chat response.
3. Offer to open `verificationUrl`. The account owner signs in and compares the
   displayed code, repository, environment, keys, and source before approving.
   Only approve an import started on a trusted machine. Never paste values or
   the raw device proof into chat.
4. Within ten minutes, run the same command with `--action receive --confirm`
   (MCP: `action: "receive", confirm: true`). The source must still match the
   hosted request's exact default-branch commit and spec bytes.
5. Successful output contains `secretRefs: [{key, ref}]`. Convert those entries
   into the key-to-reference object accepted by `hv_plan`, then review the fresh
   plan before applying. Existing populated keys are never overwritten.

Use a separate request and sandbox credentials for staging. The command writes
only that environment's private env file with owner-only POSIX permissions. It
may add exact ignore rules for the destination and temporary path. It never
copies values to `.env.example`, production, command output, or provider APIs.
Windows permission behavior is unverified; POSIX modes are not a Windows ACL.

## Failure and recovery

- Before consumption: fix the reported checkout, permission, tracking, approval,
  or populated-key conflict, then repeat receive. No values were fetched by the
  metadata GET. Only blank single-line assignments can be filled.
- Unknown consuming outcome: the server may already have erased its copy.
  Automatic retry is forbidden; ask the owner to inspect safe status and issue
  a new request. Metadata/status is never proof that a value reached this disk.
- Values received but file write failed: they remain encrypted in the local
  connection store. Resolve the local conflict, then repeat receive on the same
  checkout and revision. Recovery does not contact the server again. Do not
  delete the local state database or encryption key during recovery.
- An interrupted process may leave `.env.<env>_hypervibe_import`. Inspect it
  privately before moving/removing it; it may contain a recovery copy. Never
  print or attach it to logs. Ordinary handled errors remove only their own
  temporary file.
- Values that cannot round-trip through the existing dotenv parser are retained
  encrypted and blocked, not silently escaped into a different credential.
  Multiline existing assignments must be resolved before import.
- Completed imports keep only a receipt/digest in encrypted local state. If the
  env file later changes or disappears, the command reports that fact and never
  fetches another copy. Deleting/recreating local state cannot reset the server's
  one-use lock.

No distributed system can guarantee delivery after a consuming response is
lost. A crash before the received payload reaches durable local storage still
requires a new request. Backup copies follow each operator's retention policy;
revocation does not delete a copy already handed off or rotate its provider key.

## Rollout and verification

Deploy Hypercloud's retrieval-approval migration/routes first; release the engine
command separately. Existing hosted spec inspection requires no package bump.
Neither change should auto-deploy an application or expand reporting scopes.

Focused tests use real temporary Git repositories, SQLite encryption, filesystem
writes, CLI routing and the MCP registry. HTTP responses in client tests are
synthetic API-v1 contract fixtures, not proof of compatibility with a live server.
The companion server tests exercise actual PostgreSQL and Express boundaries.
Normal `npm test` includes these tests; checked-in acceptance CI runs it. Live
branch protection, deployed endpoints, real OAuth and provider acceptance remain
unchecked. No full release gate or publication is implied by these checks.

Local verification: 59 tests across five focused suites passed, along with
TypeScript checking and diff checks. The command catalog was regenerated from
the source registry using the existing renderer, without building or changing
the installed MCP runtime. Recovery-after-rename and ambiguous multiline-input
counterexamples were observed failing before their fixes, then passing.
