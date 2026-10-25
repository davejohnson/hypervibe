# Azure Identity dependency repair, 2026-10-25

Hypervibe pins Azure Identity 4.13.2 and overrides only that package's MSAL Node
dependency to the official 7.1.1 release. Its reviewed Identity dependency closure
is included using npm `bundleDependencies`, so the fix reaches installed consumers
without requiring their own overrides. No vendor source or manifest is modified.

## Evidence and compatibility decision

Microsoft's [GHSA-xcx6-jx8p-x3h5 advisory](https://github.com/AzureAD/microsoft-authentication-library-for-js/security/advisories/GHSA-xcx6-jx8p-x3h5)
marks MSAL Node versions from 5.0.0-beta.0 through those before 7.1.0 as affected.
The [official fix](https://github.com/AzureAD/microsoft-authentication-library-for-js/pull/8901)
prevents callback metadata from changing confidential-client redemption authority.
Microsoft rates it Moderate; npm's advisory feed rates it High. The same affected
range and patched floor apply regardless of that difference.

The assumption challenged was that a compatible Identity update could deliver
patched MSAL. A fresh public-registry review at 2026-10-25 19:54 UTC inspected 810
Identity versions: none declared a range accepting 7.1.1. Latest Identity 4.14.0
still required MSAL 6, and the [SDK upgrade issue](https://github.com/Azure/azure-sdk-for-js/issues/40441)
remained open. Downgrading Identity would discard its later structured process
credential fixes. The chosen repair retains 4.13.2 and explicitly tests the major
MSAL override instead of presenting it as upstream-certified compatibility.

The official [v6](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/v6-migration.md)
and [v7](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/v7-migration.md)
migration guides locate breaking changes in interactive browser-loopback behavior.
Hypervibe's Azure Resource Manager client uses `DefaultAzureCredential`; its
[native chain](https://github.com/Azure/azure-sdk-for-js/blob/%40azure%2Fidentity_4.13.2/sdk/identity/identity/src/credentials/defaultAzureCredential.ts)
does not use the ordinary browser-loopback credential. Hosted Entra authorization
is separately implemented. This source review limits the affected application
surface; it does not prove that every SDK credential mode is compatible.

## Observed regression and delivery checks

The reconstructed upstream counterexample exercises actual MSAL endpoint selection
and form encoding, replacing only HTTP transport. On installed 5.5.0 it routed a
synthetic client secret from the configured `login.microsoftonline.com` authority
to response-controlled `login.microsoftonline.us`. The regression failed before
the dependency change and passed on 7.1.1. This demonstrates dependency behavior,
not a customer incident or a reachable Hypervibe authorization-code endpoint.

Eight real-SDK checks cover authority/state validation, explicit and environment
client-secret authentication, cached token reuse, terminal configured-credential
failures, workload assertion exchange, App Service managed identity and structured
Azure CLI execution. The focused run with existing Resource Manager tests and the
new tarball test passed all 18 checks; TypeScript checking also passed.

[npm applies overrides only at the consuming root](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides).
The package regression initially failed because the archive did not carry the
reviewed Identity closure. It also detected an intermediate stale install that
bundled MSAL 5.5.0 despite the new override. Resolving the patched dependency before
marking the closure bundled corrected this. The regression extracts the actual
`npm pack` archive, resolves MSAL from the packaged Identity, checks that its real
path stays inside the package, and repeats the adversarial routing probe.

A separate fresh `npm ci --ignore-scripts` from the final lock selected Identity
4.13.2 and MSAL 7.1.1. A fresh downstream npm installation of the actual tarball,
with no consumer overrides, preserved the bundled version and passed both the
adversarial routing probe and real `DefaultAzureCredential` token/cache checks.
Fresh audits of the development tree and this consumer each reported zero findings.
These dependency checks intentionally skipped native install scripts and do not
replace the full application build or native SQLite acceptance.

Both regressions are discovered by ordinary `npm test`, which the committed
`Hypervibe / acceptance` workflow and desired required-check configuration run.
That source configuration does not establish live branch-protection enforcement.
Hypercloud also tests the actual installed engine's bundled MSAL routing in its
ordinary Jest path; its old installed package fails that check, and the fresh
consumer installation passes it.

## Maintenance and release boundary

MSAL 7 remains outside Identity's declared `^5.1.5` dependency range. Consequently
consumer `npm ls --all` can report an invalid edge even though installation and
the tested paths work. This is a narrow, reviewed compatibility override, not an
upstream support guarantee. Azure live sign-in, Windows CLI execution, certificate,
username/password, broker and every optional credential mode are not established
by these offline checks. No native Azure authentication support was removed.

Hypervibe owns this pinned dependency exception. Before changing either version,
review upstream migration contracts and run the SDK, packaged-consumer and audit
checks. Remove the override and bundle when an Identity release declares patched
MSAL and passes those checks. Do not alter vendor manifests to conceal the range
warning, suppress the advisory, or reuse old audit output as a release receipt.

The source still carries version 0.1.43, already occupied by different published
bytes. A coordinated release must choose a free new version, run normal release
checks, obtain owner publication approval, then update Hypercloud's exact published
pin and lock and run its clean `verify:ci` acceptance. A candidate tarball is not a
published release, and dependency verification is not live-cloud acceptance.
