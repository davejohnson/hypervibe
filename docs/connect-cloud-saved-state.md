# Connect Cloud saved-state compatibility

The draft recognizes the historical additive SQLite migration 12,
`provider_login_sessions`, through the shared historical-migration validator.
The monotonic migration 13 preserves existing ciphertext, active lease
ownership/expiry, connections and recovery runs when opening schema 12. New
profiles and canonical schema-11 profiles receive migration 13 without inventing
a version-12 login table or marker. It does not copy credentials into a
different store, decrypt login sessions, discard migration history or reset
outstanding operations.

## Evidence and counterexample

The challenged assumption was that every version-12 database required a wholly
newer infrastructure state model. Independent inspection found an additive table:

- Historical source: `6f536cf`, `src/adapters/db/sqlite.adapter.ts`, migration 12.
- Read-only inspection of the existing disposable Azure login store on
  2026-10-25 matched the migration name, seven columns and three-column index.
  Only schema metadata and a row count were read for this check. No live store
  was migrated or copied.
- The pinned SQL fixture is reconstructed from that historical source, with no
  customer rows. Test ciphertext and identities are synthetic.

A real SQLite database with that schema could not open under the schema-11
draft, even to inspect unrelated retained state. The new preservation and
upgrade cases both failed before the change. Four incompatible-schema cases
also exercised the old rejection; their expected diagnostic changed with the
new distinction between recognized and incompatible version 12.

Integration with main's historical reconciliation challenged a second assumption:
that the draft's canonical version-12 creation could coexist with main's monotonic
version-13 bridge. An actual SQLite boundary run of the partially merged code
failed 12 cases: fresh profiles installed 13 and then 12, alternative historical
objects lost their recognized identity, and treating login migration 12 as
canonical bypassed its exact historical schema validation. The fix removes the
version-12 creation and duplicate login-only validator, retaining main's shared
identity/fingerprint checks and migration 13.

The retained schema-12 fixture still exercises encrypted sessions, active leases,
connections and saved recovery runs. Their bytes and original migration rows must
remain unchanged across initial upgrade and repeated opens; the only new history
entry is the version-13 bridge. Canonical schema-11 profiles must not acquire a
login table or version-12 marker. Corrupt historical name/table/column/index and
future schema versions remain blocked before missing migrations execute. The
shared historical suite also preserves both known historical version-12
identities and companion version-11 history. These tests use the real SQLite
engine in ordinary `npm test`; no live cloud compatibility follows from them.

## Authentication boundary

Preserving a login session is not implementing or renewing its authentication
driver. Historical local Azure browser sessions use an older implementation
that is not included in this draft. Their records remain intact, but this draft
does not claim they are usable for authentication. Continue using their original
compatible runtime until that driver is integrated and tested, or establish a
separately authorized connection through Connect Cloud. Do not reinterpret a
retained browser session as default credentials or static keys.

The disposable Azure probe used a separate compatible historical login reader;
it did not establish a production authentication migration. New Connect Cloud
customers use the hosted browser installation and do not need these local
sessions. An isolated operator test store can use explicitly selected native
authentication where the relevant provider adapter supports it.

## Merge validation

The focused preservation/history/reservation group passed all 26 checks against
the resolved SQLite adapter. A separate 2026-10-25 copy-only check used the frozen
actual operator test profile created by the prior schema-12 candidate. Its closed
database had no nonempty WAL. A disposable byte copy opened through the resolved
adapter, gained only migration 13, passed `integrity_check`, and reopened without
another migration. All original schema objects, table rows, encrypted bytes and
migration timestamps remained unchanged. The source database hash stayed exact;
no original state, key or provider was written, and the disposable copy was
removed. This establishes compatibility with that retained profile, not every
unrecorded historical schema.
