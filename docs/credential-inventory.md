# Credential inventory (phase 1)

```js
hv_secrets({ project: "my-app", env: "production", view: "inventory" })
```

```sh
hypervibe secrets --project my-app --env production --view inventory --json
```

The shared application projection returns value-free `roles`, each with a label,
purpose, ownership, source evidence, local candidates, consumers, validation,
rotation evidence, recent update receipts, and a next action. Existing secret
read modes retain their behavior. Inventory accepts only project, env and view.

This is an inspection, including locally: no spec adoption, binding hydration,
dotenv scaffolding/chmod, credential import, generation, synchronization, provider
mutation, deployment, or audit write. Unrecorded repository edits must first be
reviewed through the existing spec workflow. No credential store is added.

## Evidence semantics

- Local `.env` and `.env.<environment>` assignments are candidates. Ordinary
  runtime inputs are shown even when `spec.secrets` is empty. Values are compared
  privately; a different candidate never replaces an accepted value. Control-plane
  slots without a saved connection remain untracked and have no inferred runtime
  consumers. Undeclared provider-only inputs remain separate by exact service;
  matching names do not establish shared source. Retained bound services using a
  declared key remain visible. Unreadable, special, or oversized files are not read.
- Declared identical secret-manager references group aliases. Provider-owned
  credential-role and CI source mappings group a connection's local slot and its
  managed CI destinations. Names or equal values never merge unrelated roles.
  In particular, GitHub management and package-read credentials remain distinct.
  Historical arbitrary alias mappings cannot be reconstructed from values.
- Runtime acceptance uses existing local managed-secret bindings and their action
  receipt validation. The latest 100 local runs provide bounded update history;
  failed/pending receipts retain unknown write outcomes. No raw receipt error,
  encrypted input, value, or accepted-value fingerprint enters the result.
- GitHub repository and environment destinations remain separate. Bounded,
  complete, validated lists establish presence; a complete environment inventory
  establishes deletion. A 403/404, malformed page, duplicate, count change, limit,
  or environment identity replacement produces unknown evidence, without writes.
  GitHub creation/update timestamps describe the **destination secret record**,
  not issuance or rotation of the underlying credential. Current values are
  write-only. A saved synchronization record is evidence of a past update only.
- Exact bound hosting IDs and provider project/environment scope select runtime
  consumers. Configuration equality is separate from deployment state. Existing
  rollout records identify the baseline and later selected deployment, but cannot
  prove all old instances stopped serving traffic or that the credential is used
  by running processes. `lastConfirmedAt` remains null without that evidence.
- Saved connection verification is reported separately from per-role credential
  validation. Neither authenticating a management connection nor a successful
  homepage response establishes runtime credential validity or an application
  operation. Tracked roles show recorded provider account validation separately; historical identity remains unknown. Prefixes are not proof.
- Credential creation, expiry and rotation remain unknown. Acceptance timestamps,
  connection verification, destination updates and file metadata are not rotation
  dates. Historical delegated sources lack original file/reference provenance;
  inventory explicitly reports that gap instead of inventing it.

The example incident is a regression scenario, not a proven incident diagnosis:
a replacement may exist locally, a CI copy may have only a historical sync
record, a container-pull copy may be unobservable, and production may still use
the old deployment. These outcomes must remain visible independently.

## Provider boundary and verification

| Category | Named providers | Inventory evidence and limits |
| --- | --- | --- |
| Hosting | Railway, Cloud Run, ECS Express, Azure Container Apps, Fly.io, DigitalOcean App Platform, Vercel | Reuses the existing observation capability and exact bindings. Unsupported, incomplete, masked, or mismatched observations remain unknown. No new hosting mutation/activation capability is claimed. See the [existing native-semantics review](scoped-secret-updates.md#provider-review). |
| CI | GitHub Actions | New GET-only scope/metadata reader, using [Actions secrets](https://docs.github.com/en/rest/actions/secrets) and [environment inventory](https://docs.github.com/en/rest/deployments/environments). The four operations are pinned under `test/provider-contracts/github/secret-inventory`. Lists are bounded to 1,000 items per scope; values cannot be read. |
| CI | GitLab CI | CI destination aggregation is not implemented; inventory reports that gap. It does not reinterpret GitLab state as GitHub state. |
| Secret references | Vault, AWS Secrets Manager, Doppler, 1Password, Bitwarden, Stripe Projects | Displays declared provider/path/key/version descriptors without resolving values or asserting validity, expiry, rotation, or account identity. |

Regression evidence is in `src/application/__tests__/credential-inventory.test.ts`
and `src/adapters/providers/github/__tests__/github.secret-inventory.api-contract.test.ts`.
The initial command regressions failed on the unsupported inventory selector;
the initial provider tests failed on the missing inventory method. Subsequent
counterexamples exposed incorrect cross-provider absence, omitted unaccepted
package tokens, missing failure history, and invented CI consumers, each observed
failing before correction. Tests exercise actual MCP/CLI serialization, local
SQLite/files, the real GitHub HTTP client, and a real Railway observer through the
pinned GraphQL transport. Fixtures are reconstructed/synthetic, not live captures.

These tests run in ordinary `npm test`. Both the committed
`Hypervibe / acceptance` workflow and `.hypervibe/spec.json` require `npm test`
and type checking; the spec names that acceptance check as required. Live branch
protection, provider permissions, propagation timing, old-instance retirement,
credential authentication and application operations have not been verified.

## Tracking and guided rotation

The separately reviewable tracking and rotation implementations are described in
[credential lifecycle](credential-lifecycle.md). Explicit roles now retain source
provenance, intended identity, user-reported dates, validation and accepted-update
evidence. Historical records without those declarations remain unknown. Inventory
itself still performs no adoption, validation or writes.
