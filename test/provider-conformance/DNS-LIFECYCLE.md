# Disposable DNS lifecycle fixture

The `dns-cloudflare`, `dns-gcp`, `dns-aws` and `dns-azure` profiles exercise the
same DNS lifecycle through Hypervibe's CLI. A profile's existence is not live
support evidence. No profile has been run as part of adding this harness.

Prepare an existing dedicated fixture app and environment through Hypervibe
before running it. The app must serve the conformance fixture JSON, including
its fixed `revision`, at `/`. The DNS hostname must be a fresh subdomain with no
records, in an existing publicly delegated zone that also contains the
registrable base domain used for ownership verification. For
`disposable.fixture.example.com`, select the `example.com` zone, not a delegated
`fixture.example.com` zone: Google verifies ownership at `example.com`. At least one existing record
at another name in that zone is required as a preservation sentinel. The
fixture leaves the hosting app and zone intact. It creates only the custom
domain attachment/verification and DNS records, changes traffic TTL from 300
to 600, verifies a noop, removes its contributed values and attachment, and
checks native absence for newly created records plus unchanged sentinels.
An explicitly adopted base-domain TXT RRset remains present with exactly its
original values; the journal records that as retained, never as absent.

The current domain-operation allowlist covers the GCP custom-domain workflow;
the four DNS accounts are selected independently of that prepared hosting app.
It does not authorize new projects, new apps, cloud access setup, billing,
zone creation, delegation changes, DNSSEC changes or provider API writes outside
the approved Hypervibe engine workflow. Setup is a separate approval.

Use a verified saved connection at the marker's exact `connectionScope`.
Existing compatible Cloudflare, Cloud Run/GCS, ECS/S3 or Azure connections may
be reused when their native target matches. Native GCP ADC and AWS credential
chains are resolved privately. Azure DNS currently requires a saved service
principal connection for the engine. Do not export credentials into JSON files
or copy credentials into the fixture or application runtime.

Create an operator-owned marker outside the fixture directory. This example
shows Cloudflare; select the desired provider and its exact zone scope for the
other profiles:

```json
{
  "version": 1,
  "purpose": "disposable-dns-conformance",
  "profile": "dns-cloudflare",
  "project": "dedicated-fixture-app",
  "internalProjectId": "EXISTING_HYPERVIBE_PROJECT_ID",
  "environment": "fixture",
  "internalEnvironmentId": "EXISTING_HYPERVIBE_ENVIRONMENT_ID",
  "repository": "owner/dedicated-fixture-app",
  "hostname": "disposable.fixture.example.com",
  "expectedRevision": "prepared-v1",
  "dns": {
    "provider": "cloudflare",
    "zone": { "id": "EXACT_ZONE_ID", "name": "example.com", "accountId": "EXACT_ACCOUNT_ID" },
    "connectionScope": "owner/dedicated-fixture-app",
    "policy": { "exposure": "public", "proxy": "off", "dnssec": "preserve", "caa": "preserve" }
  },
  "preserved": [
    { "name": "sentinel.fixture.example.com", "type": "TXT", "nativeIds": ["EXACT_ZONE_ID/EXISTING_RECORD_ID"] }
  ]
}
```

Google uses `provider: "gcp"`, zone `id` equal to the managed-zone API resource
name, and `projectId`. Its numeric provider ID is independently captured and
compared. AWS uses `provider: "aws"`, the hosted-zone ID without `/hostedzone/`,
and the 12-digit `accountId`. Azure uses `provider: "azure"`, the full zone ARM
ID, `subscriptionId` and `resourceGroup`. All include the DNS zone `name`.
Sentinel IDs are the provider-native import identities returned by the scoped
DNS observer; names alone do not establish ownership.

If the authoritative base-domain TXT RRset already exists, add its exact native
ID and every current value to `dns.adoptRecords` before previewing. Only
base-domain TXT adoption is permitted; traffic records at the dedicated
hostname must start absent. For example, a Google marker can include:

```json
"adoptRecords": [{
  "id": "projects/DNS_PROJECT/managedZones/ZONE_NAME/rrsets/example.com./TXT",
  "name": "example.com",
  "type": "TXT",
  "values": ["EXACT_CURRENT_EXISTING_VALUE"]
}]
```

Supply every actual current value privately in the local marker. Neither these
values nor the new verification token appear in fixture output or journals.
Cloudflare's separate record identities permit unrelated base-domain TXT
records to remain without adoption; selecting an existing Cloudflare record
still requires its exact identity and current values. Keep sentinels at a
separate name: base-domain TXT preservation has its own encrypted baseline.

During the run, an adopted TXT RRset may contain the reviewed fixture proof in
addition to its original values. Cleanup must remove that contribution and
recover exactly the original value set. The explicitly approved TTL update can
leave the adopted set at its latest reviewed TTL; it does not restore the
original TTL. Unrelated sentinel TTL and proxy settings must remain unchanged.
Any unexpected sibling value or unknown read leaves cleanup unverified and
preserves the recovery journal.

First prepare a reviewable plan. The fixture directory must be new, separate
from the existing state directory and user checkouts:

```sh
HYPERVIBE_LIVE_DNS_PROFILE=dns-cloudflare \
HYPERVIBE_LIVE_DATA_DIR=/absolute/existing-dedicated-state \
HYPERVIBE_LIVE_DNS_FIXTURE_DIR=/absolute/new-dns-fixture \
HYPERVIBE_LIVE_DNS_FIXTURE_MARKER=/absolute/dns-marker.json \
HYPERVIBE_LIVE_MODE=preview npm run test:providers:dns-live
```

Preview changes only local desired state and saves a plan; it does not apply
provider changes. Review `dns-fixture-plan.json` and the exact plan through
Hypervibe. Once the user has authorized that saved plan and the bounded full
lifecycle, use the same variables with `HYPERVIBE_LIVE_MODE=run`,
`HYPERVIBE_LIVE_APPROVED_PLAN_ID` set to the reviewed plan ID, and
`HYPERVIBE_LIVE_AUTHORIZE_LIFECYCLE=1`. Every subsequent plan is checked against
the exact hostname, DNS provider and allowed domain operations before apply.
Service, project, secret, unrelated domain, replacement or TTL-stage creation
actions stop the run. Setting environment variables does not itself establish
user authorization.

The private baseline is encrypted in `dns-fixture-baseline.encrypted`. The
safe journal records exact native IDs before cleanup; raw DNS values, plans,
provider errors and credentials are not printed. Live verification compares
provider-native records with public DNS and the app's exact HTTPS response.
It does not count passing mocks, an empty plan or missing bindings as absence.

On failure or unknown cleanup, preserve the entire fixture directory and
encrypted Hypervibe state. Continue only with the same marker, reviewed plan ID,
lifecycle authorization and `HYPERVIBE_LIVE_CLEANUP_ONLY=1`. Cleanup-only proves
cleanup, never the skipped create/update/application checks. A full support
claim requires a successful run, exact source revision, provider and engine
versions, native absence evidence for created records, explicit retention
evidence for adopted record sets, and preserved shared-zone records.
