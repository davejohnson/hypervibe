# Connect Cloud saved-state compatibility

The draft now recognizes the historical additive SQLite migration 12,
`provider_login_sessions`. It creates the same empty table on schema 11 and
preserves existing ciphertext, active lease ownership/expiry, connections and
recovery runs when reopening schema 12. It does not copy credentials into a
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

After the fix, the focused preservation, prior-version upgrade and apply
reservation group passes 14 tests. It covers repeated open, unchanged encrypted
session/connection bytes and active leases, retained recovery plans, additive
upgrade, incompatible migration name/table/column/index, and rejection of future
schema versions before missing migrations run. These tests run through ordinary
`npm test`; no live cloud compatibility follows from these local checks.

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
