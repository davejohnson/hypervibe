# Managed iOS build-number allocation

## What changed

The managed iOS workflow now has a checkout-free `prepare` job that validates
server-release evidence and asks the managed App Store Connect runtime for the
next build number. The credential-free project build job receives that value as
`HYPERVIBE_BUILD_NUMBER`; the IPA validator and isolated release job use the
immutable preparation output rather than a build-script-mutated value.

The runtime lists every page of builds for the app, chooses one greater than the
largest numeric major component, and emits only `1..9999`. Unknown or malformed
responses, unsafe pagination, repeated cursors, and exhaustion fail closed.
This is selection rather than an Apple reservation: a collision during upload
still fails, and retries must rebuild with a fresh number.

## Ownership

- `templates/ios/hypervibe-ios-release.mjs` owns App Store listing, allocation,
  and collision rejection.
- `templates/ios/github-release-workflow.yml` owns preparation/build/release
  isolation and exact IPA-number validation.
- `ios-release-workflow.service.ts`'s renderer revision forces a reviewed
  workflow update for this changed embedded contract.
- Projects consume `HYPERVIBE_BUILD_NUMBER` without App Store credentials.

## Safeguards and verification

The release runtime never resumes an existing build, because a build number
cannot prove IPA/Git provenance. The managed runtime is kept as step-local
Base64 data so generated `run` scripts stay below GitHub's 21,000-character
limit. Source and emitted-runtime HTTP-boundary tests cover allocation,
pagination, collisions, CLI execution, a real IPA plist mismatch, environment
override attempts, and the generated workflow size limit.

Focused verification passed: 186 tests, TypeScript typecheck, runtime syntax,
and whitespace validation. No Apple upload, deployment, or managed workflow
publication was performed.
