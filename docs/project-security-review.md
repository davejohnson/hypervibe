# Project dependency and runtime security review

Contract review date: 2026-10-21 (2026-10-22 UTC). This is source inspection
and public advisory lookup. It does not change a repository, install its
dependencies, run its scripts, rotate credentials, or deploy an update.

`reviewProjectSecurity` is shared by the command application and the standalone
managed-CI helper in `templates/security/security-review.mjs`. The latter is
published as reviewed repository content rather than downloading an unpublished
Hypervibe release. Read-only local review accepts dirty and uncommitted sources;
the result records available Git commit/dirty evidence and the SHA-256, size and
relative path of each inspected source file. A source hash identifies the exact
bytes inspected, not a successful build or running deployment.

## Reviewed native contracts

| Source | Native evidence | Implemented boundary | Explicit limits |
| --- | --- | --- | --- |
| [npm lockfiles](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/) | Versions 2/3 describe installed package locations; version 1 nests dependencies. Root shrinkwrap takes precedence over package-lock. Resolved registry URLs may stand for the currently configured registry. | Walk every recorded dependency entry, including nested, development and optional dependencies; deduplicate exact name/version pairs. Read selected lockfiles without installation. | Only root lockfiles are selected by default. Independent nested projects require explicit paths. Local links, custom sources, missing provenance and unapproved scoped packages make coverage incomplete. Lockfiles do not establish the installed or deployed tree. |
| [OSV querybatch](https://google.github.io/osv.dev/post-v1-querybatch/) | Result ordering matches query ordering. Each result carries advisory IDs and modification times. Pagination belongs to individual queries. | Fixed `https://api.osv.dev/v1/querybatch`; send only npm package names and exact versions, plus response pagination tokens. Validate cardinality and follow each query's token. | This is advisory matching, not exploitability or a severity assessment. Full advisory details and automatic fixed-version selection are not implemented. Unknown ID families or malformed evidence remain incomplete. |
| [Node distribution index](https://nodejs.org/dist/index.json) | The official distribution index carries version, date and a security-release flag. | Compare an exact, published Node version against newer security releases in its major line. Return the official release page and recommended security release. | A newer security release is an upgrade signal, not a claim that every intervening version is affected by every CVE. Major/range selectors remain unknown. No inference from the scanner's own Node process. |
| [Node release schedule](https://github.com/nodejs/Release#release-schedule) | The release working group's [machine-readable schedule](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json) gives support end dates. | Flag end-of-life declared release lines independently of patch availability. | Missing support or exact release evidence remains unknown. No automatic major upgrade. |
| [GitHub advisory database](https://docs.github.com/en/code-security/concepts/vulnerability-reporting-and-management/github-advisory-database) | Reviewed advisories support Dependabot alerts and security updates. | Existing Hypervibe GitHub policy controls Dependabot settings; this scanner uses OSV public lookup separately. | Enabling Dependabot is not a completed inventory scan. GitHub alert ingestion, dismissal state and private advisories are not implemented here. |

No new infrastructure provider mutation capability is declared. The public
advisory API is an inspection input. Managed scheduling belongs to the existing
GitHub desired-state workflow lifecycle; generating a workflow does not prove
that it has been applied, run, or delivered a notification.

## Query privacy and bounds

The scanner never reads registry authentication configuration or forwards
registry credentials, repository URLs, file paths, package scripts, environment
variables, lockfile URLs or manifests to OSV. It requires a canonical,
credential-free npm-registry tarball URL matching the admitted package name.
Scoped names require an explicit `publicPackageNames` allowlist; local, git,
custom-registry and missing-source entries are skipped and counted without
printing their names or URLs.

An npm-registry URL is declared provenance, not independent proof of public
ownership: npm documents registry substitution. A project using private
registry overrides must review its source policy before making public queries.
The current admission rule does not inspect npm configuration or certify that
every admitted unscoped package is public. This remains an explicit limitation,
not a claim that all private package metadata is discoverable safely.

The only advisory destinations are the three fixed URLs in the first four rows
above. Fetches omit credentials, reject redirects, bound the full body deadline
and byte count, and never return upstream error text. Every accepted response
records its URL, byte count and SHA-256 alongside the review timestamp. These
hashes identify the observed feed snapshot; upstream URLs remain mutable.

Limits are twenty selected lockfiles, eight MiB per source, 10,000 recorded
dependency entries, 2,000 distinct queries, 100 queries per batch, ten pagination
rounds per batch, forty public requests, two MiB per response, ten seconds per
request and ninety seconds for the request budget. Results retain at most 500
advisory matches. Reaching a limit means incomplete coverage, never a clean scan.
Source reads reject traversal, symlinks and special files, with bounded reads
and nonblocking open flags. Git evidence uses read-only commands with optional
locks and filesystem-monitor execution disabled.

## Outcome meaning

`status: findings` means at least one advisory match, newer Node security
release, or end-of-life line was found. `complete: false` may coexist with
findings. `status: incomplete` means there were no confirmed findings but some
required evidence could not be checked. `status: clear` applies only to the
admitted packages and exact Node declarations in this review; it is not a claim
that the application is secure. CI exits 1 for findings and 2 for incomplete.

Runtime sources are `.node-version`, `.nvmrc`, package.json engines/Volta and
explicit desired-runtime inputs. Dockerfiles, provider-observed runtime/image
identity, Python, pnpm, Yarn, operating-system packages and container advisories
are unimplemented and stated in every result. Major versions and ranges do not
prove the patch actually deployed. The review does not fetch application secrets
or try executing application code to resolve this uncertainty.
An unambiguous major selector also reports that release line's
`latestSecurityRelease` as information while remaining `unknown`; it never
claims that the running patch is older or sets a recommended upgrade from a
major selector alone.

The [October 2026 Node bulletin](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
and [Node 24.22.1 release page](https://nodejs.org/en/blog/release/v24.22.1)
were checked during implementation. The bulletin reports available releases
22.23.4, 24.22.1 and 26.12.1; its highest stated severity is **high**. These
versions are not hardcoded scanner policy. The implementation reads the current
official distribution index and release schedule.

## Regression evidence

The challenged assumption was that an enabled dependency-update setting or a
major Node selector establishes current dependency/runtime security. The native
contracts above require exact dependency versions and distinguish update
availability from runtime and vulnerability proof.

Tests exercise the real scanner and serialized HTTP boundary, mocking only
public fetch transport. Feed fixtures are reconstructed from the documented
OSV response shape and official Node fields; baseline versions and malformed
cases are synthetic. They are not recorded successful customer scans. The
emitted standalone file is executed as a separate Node process with an injected
public-feed transport, including its actual exit codes.

Initial feature tests failed because the scanner did not exist. Additional
regressions were observed failing before fixes: a malformed Node release URL,
workspace links incorrectly becoming checked-empty, a symlinked executable path
suppressing the standalone runner, echoed invalid runtime/advisory identifiers,
and a FIFO source file hanging before the bounded reader could reject it.
Invalid support dates were also reproduced as a false current result before
strict calendar-date and duplicate-release validation were added. The focused
scanner suite then passed 19 tests, including a major-selector regression that
requires the latest security-release information without claiming a vulnerable
installed patch. It is under `src/**/*.test.ts`
and therefore included by ordinary `npm test`; no live branch-protection or
scheduled-run enforcement is claimed.

A bounded live read-only scan of Hypervibe completed at
`2026-10-22T05:10:19.622Z`, against dirty commit
`40e1cee10867642b43674954879abc52d242b3d9`. The inspected package-lock SHA-256
was `50dac064dd68797ed5678c7a12c4b81b86dba69a92f247b0fb6e9669722b093c`.
It queried 227 unique admitted package versions from 336 recorded entries,
skipped 108 entries, and returned six advisory IDs for Vite 8.2.2. An explicitly
labelled local scanner process running Node 22.17.1 had newer security release
22.23.4 available; the project's major/range declarations remained unknown.
This verifies a successful partial live OSV/Node transport observation, not
complete package coverage, customer compatibility, exploitability, a scheduled
workflow run, or the deployed application's runtime. No installation or
repository/provider mutation was performed by the scan.

The six matched OSV records were then individually checked. All identified
Vite 8.2.4 as the first patched version in the installed 8.2 line, compatible
with Vitest 4.1.11's existing Vite range. The reviewed remediation changed only
Vite's version, tarball URL and integrity in package-lock.json. Its dependency,
peer-dependency, engine and bin metadata were compared with the official npm
record; the downloaded tarball's SHA-512 matched the new integrity.
`npm install --ignore-scripts --no-audit --no-fund` then changed one installed
package, preserving both reviewed manifests. A live rescan at
`2026-10-22T05:12:33.471Z` found zero OSV matches among the same 227 queried
versions, with the same 108 skips and local-Node update finding. The lockfile's
new SHA-256 is
`703b84638f3e9bc058b34b4c71aff25daae0858e0b54954782015a53159c82c9`.
The scanner, workflow and schema suites passed 40 tests using installed Vite
8.2.4. No local Node installation or project runtime policy was changed.

| Observed advisory | Published severity | Affected installed line / patch |
| --- | --- | --- |
| [GHSA-587h-7wmj-h5pm](https://api.osv.dev/v1/vulns/GHSA-587h-7wmj-h5pm) | High | 8.2.0 through 8.2.3 / 8.2.4 |
| [GHSA-698v-4r3x-3vcv](https://api.osv.dev/v1/vulns/GHSA-698v-4r3x-3vcv) | Moderate | 8.2.0 through 8.2.3 / 8.2.4 |
| [GHSA-9jrq-w75r-8gcw](https://github.com/vitejs/vite/security/advisories/GHSA-9jrq-w75r-8gcw) | Low | 8.2.0 through 8.2.3 / 8.2.4 |
| [GHSA-r825-w8mm-5pxw](https://api.osv.dev/v1/vulns/GHSA-r825-w8mm-5pxw) | Moderate | 8.2.0 through 8.2.3 / 8.2.4 |
| [GHSA-rq7h-c2jc-7f22](https://api.osv.dev/v1/vulns/GHSA-rq7h-c2jc-7f22) | Moderate | 8.2.0 through 8.2.3 / 8.2.4 |
| [GHSA-vfpm-58rq-9qcg](https://github.com/vitejs/vite/security/advisories/GHSA-vfpm-58rq-9qcg) | Moderate | 8.2.0 through 8.2.3 / 8.2.4 |

These advisory metadata severities were checked for this remediation; they are
not severity fields fetched by the generic batch scanner. Deployment and
configuration conditions in each advisory still determine actual exposure.
