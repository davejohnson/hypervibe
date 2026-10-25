# Azure Identity dependency repair, 2026-10-25

Hypervibe ships an explicitly versioned metadata patch of Azure Identity 4.13.2,
`4.13.2-hypervibe.1`, declaring the reviewed official MSAL Node 7.1.1 dependency.
Its complete dependency closure is included using npm `bundleDependencies`, so
consumers need neither an override nor a separate unpublished dependency. All
1,143 upstream non-manifest files remain byte-for-byte identical, including SDK
code, declarations, source maps, documentation and license. The manifest changes
are the distribution version, the MSAL dependency and explicit patch provenance.

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
credential fixes. The chosen repair retains the 4.13.2 SDK and explicitly tests
the major MSAL dependency change instead of presenting it as upstream-certified
compatibility.

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

The first repair passed a fresh development `npm ci` and downstream `npm install`,
but those checks did not establish that a downstream lock could subsequently
complete `npm ci`. Hypercloud's final clean acceptance exposed that distinction:
Identity still declared MSAL `^5.1.5`, so npm rejected the bundled 7.1.1 edge and
reported missing 5.6.0 and 16.13.0 lock entries. Both an empty consumer and an
ordinary-install-then-clean-install consumer reproduced it. The failure was not
caused by Hypercloud's old lock. A plain published shrinkwrap did not repair the
actual file-tarball consumer either.

The metadata patch makes the tested dependency explicit and removes the root
override. Normal CI now extracts the actual package, installs its Azure closure
against an empty local registry, generates a fresh lock, runs `npm ci`, and asks
`npm ls` to verify the dependency graph before repeating the adversarial probe.
The original exact archive fails with `ELSPROBLEMS`; the repaired archive passes
with no registry requests. Separately, the complete repaired tarball passed
fresh lock generation and ordinary `npm ci` with native install scripts enabled,
both in an empty consumer and with Hypercloud's previously failing lock. The
three private Hypercloud package version/resolved/integrity triples were preserved.
The fresh Hypervibe consumer audit reported zero findings. Hypercloud passed its
high threshold with five moderate findings outside Azure/MSAL; that is not a
zero-finding audit.

The focused package, real SDK and operator-lock tests passed 10 checks, and
TypeScript checking passed. Operator-lock tests reject modified local archive
bytes and unrelated local dependencies. The source backup image and macOS
installer stage the same archive before their clean installs; the packaged image
already receives it inside the reviewed Hypervibe tarball. Full helper-image,
macOS distribution and live-provider gates remain separate evidence.

Both regressions are discovered by ordinary `npm test`, which the committed
`Hypervibe / acceptance` workflow and desired required-check configuration run.
That source configuration does not establish live branch-protection enforcement.
Hypercloud also tests the actual installed engine's bundled MSAL routing in its
ordinary Jest path; its old installed package fails that check, and the fresh
consumer installation passes it.

## Maintenance and release boundary

MSAL 7 remains outside unmodified upstream Identity's declared range. The local
distribution deliberately changes that declaration and identifies itself as
`4.13.2-hypervibe.1`; it is not an upstream release or support guarantee. Azure
live sign-in, Windows CLI execution, certificate,
username/password, broker and every optional credential mode are not established
by these offline checks. No native Azure authentication support was removed.

Hypervibe owns this maintained dependency patch. Before changing either version,
review upstream migration contracts and run SDK, packaged-consumer, clean-install
and current audit checks. Remove the local patch and bundle when an official
Identity release declares patched MSAL and passes those checks. Never suppress an
advisory or reuse an old audit as release evidence.

`scripts/prepare-azure-identity-package.mjs` accepts only the official 4.13.2
archive matching the pinned registry SHA-512. It changes only the reviewed
metadata, repacks it, and verifies every non-manifest file against the original.
`vendor/azure-identity.provenance.json` records both archive integrities and the
preserved content digest. Reproduce it by fetching
`npm pack @azure/identity@4.13.2 --ignore-scripts`, then running
`node scripts/prepare-azure-identity-package.mjs <official.tgz> vendor`.

Version 0.1.44 is prepared but unpublished. A coordinated release must run final
release gates, obtain owner publication approval, update Hypercloud's exact
published pin and lock, and complete its clean `verify:ci` acceptance. Candidate
dependency checks do not establish a published release or live-cloud support.
