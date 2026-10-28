# Reviewed AWS operator template publication

The `s3` operator-artifact capability publishes the packaged
`aws-collection-template-v1` and `aws-deployment-template-v1` templates through
ordinary spec, plan, apply and verification. Its declaration selects
`scopeKind: s3-cloudformation-publication-v1`, an exact AWS account and region.
The declaration parser pins the current package's template SHA-256 digests;
changing package bytes requires a new review. Historical receipt parsing does
not silently replace an accepted digest with the current package's digest.

This actor is the operator preparing Hypercloud's public installation assets.
It is separate from customer cloud installation, collection, deployment and
runtime authority. Authentication uses the local AWS credential chain but
requires a temporary session token and expiry. Each native phase verifies the
actual caller account. Credentials remain in memory and never enter plans,
receipts, browser links or environment bindings.

The local session can identify an IAM user, root, an assumed role or a federated
user. An `arn:aws:iam` caller ARN does not imply a long-lived access key:
[`aws login`](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html)
explicitly issues temporary credentials for console root and IAM-user sessions.
The publisher checks the session token and future expiry separately from the
same-account caller ARN and nonempty native user ID. This permission is only for
reviewed operator publication; hosted collection and deployment still require
their exact installed roles, and runtime identities remain separate.

A first publication has one CloudFormation target action, one conditional upload
per selected template, and a separate public-read action. The target is a new
owned stack containing a dedicated versioned bucket with SSE-S3 and bucket-owner
enforced ownership. It retains the bucket on stack deletion. The reviewed bucket
configuration permits scoped public policy while blocking public ACLs. The
operator reads account-wide Block Public Access and stops if public policy is
blocked; it never changes account-wide settings.

Every upload uses `If-None-Match: *`, a digest-named key and a server-validated
SHA-256 checksum. The returned nonnull `VersionId`, ownership metadata and
checksum are re-read through the real S3 client. Publication grants only
`s3:GetObjectVersion` on each exact object ARN with an exact `s3:VersionId`
condition. It grants no bucket listing, unversioned read or write. Final
verification performs the same anonymous, bounded, redirect-rejecting download
used by customer CloudFormation installation and checks both bytes and the
server's `x-amz-version-id` header.

The target is bound to its native CloudFormation ARN, creation timestamp,
creation request token, exact template, physical bucket reference and current
owner-checked S3 configuration. S3 exposes no immutable bucket UID; copied names
and tags are not described as a new native lifetime identifier. Accepted object
references are pinned to the actual immutable object version. Unrelated existing
stacks or objects are never adopted or overwritten. A later release can retain
the verified target and reuse unchanged prior versions as noops while uploading
new selected bytes.

S3 `PutBucketPolicy` has no native etag/compare-and-swap precondition. The saved
plan contains the exact prior policy digest; immediately before writing, the
driver re-reads that policy, refuses drift and preserves its unrelated
statements. A concurrent external writer between that read and PUT cannot be
excluded atomically. The review and receipts say `no-native-cas`; this is not a
race-free merge guarantee. An uncertain policy write is observed, never blindly
replayed. SDK automatic retries are disabled. Definitively rejected writes need
a separately confirmed retry.

Independent evidence:

- [CreateStack](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_CreateStack.html)
  defines the native stack handoff and client request token.
- [PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
  defines conditional creation, conflicts, checksums and version IDs.
- [Version-specific S3 policy](https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazon-s3-policy-keys.html)
  documents `GetObjectVersion` and `s3:VersionId`.
- [PutBucketPolicy](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketPolicy.html)
  specifies the full-policy replacement request and lacks a conditional policy
  revision parameter.

The reconstructed transport fixtures run the actual AWS SDK serialization and
shared lifecycle. They cover all three lost-acknowledgment boundaries, wrong
account, account public-access restrictions, policy drift, conditional conflict,
native stack/object replacement, preserved unrelated policy, and reuse of an
existing immutable template version. The immutable journal guard challenged an
incorrect assumption that a CreateStack acknowledgment could contain a resource
whose creation timestamp would later change its proof. Six cases failed before
moving the acknowledged ARN into durable native operation evidence; all nine
then passed. The final focused suite additionally includes two replacement
cases. These are ordinary `npm test` regressions, not live AWS compatibility
claims. CloudFormation convergence, S3 account policy, public reachability and
charges still require the approved disposable-account walkthrough.

On 2026-10-28 the packaged AWS SDK resolved an existing browser-login profile to
expiring credentials with a session token. Its read-only STS response identified
the expected account with an IAM root ARN. The publisher incorrectly required an
STS ARN, disproving the assumption that every temporary session represents an
assumed or federated role. The official
[GetCallerIdentity contract](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html)
and console-login documentation independently establish these principal forms.
Three reconstructed real-client regressions failed before the fix: root login,
IAM-user login and the initial plan used by an account-change check. They pass
after correction, together with lost-acknowledgment recovery, account isolation,
missing/expired-session denial and explicit hosted-deployment rejection of root
and IAM-user principals. The focused five-file suite passes 55 tests. These tests
run in ordinary `npm test`; the native observation proves profile resolution and
STS identity only, not publication authority or the cause of the earlier browser
HTTP 400 error.
