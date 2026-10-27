# Reviewed operator artifact publication

Connect Cloud consumes immutable operator assets and separately reviewed private application candidates. Verifying an already
published URL does not prepare a new operator's target or publish the exact
packaged templates and images. A new operator with no templates or holding image
is the concrete counterexample to treating verify-only paths as onboarding.

The shared desired declaration is
`environments.<environment>.operatorArtifacts.<name>` with a registered `provider`,
provider-validated `nativeScope`, and exact supported `artifacts`. It runs in the
ordinary spec/plan/apply loop. Target preparation, content upload and anonymous
read permission are separately confirmed actions with durable native attempts.
The new local artifact publisher actor has transient AWS session or Google user
ADC callbacks. It has no hosted identity and cannot enter hosted factories.

## Named provider review before adapters

| Publication provider | Artifacts and target | Native authority and recovery |
| --- | --- | --- |
| S3 | Exact packaged AWS collection/deployment JSON templates; operator-owned versioned bucket | Explicit CloudFormation target stack, retained StackId/request token/resources; conditional object creation; exact non-null VersionId plus SHA-256; separate anonymous GetObjectVersion policy for exact keys and versions, no bucket listing |
| Cloud Run / Artifact Registry | Packaged public holding/backup helpers, or an explicitly selected private application candidate in the already prepared `hypervibe` repository | Exact project/repository lifetime; transient user ADC; immutable registry digest verified against the reviewed local configuration; anonymous reads only for public helpers |
| Azure Container Apps / ACR | Unsupported publisher here | Consumes the reviewed public operator image; no implicit ACR setup |
| ECS / ECR | Unsupported publisher here | Uses S3 templates; no implicit ECR setup |
| Railway, Fly, DigitalOcean, Vercel | Unsupported publisher here | No emulation or inherited publication capability |

The two packaged AWS templates and holding/backup helpers retain their existing
publication contract. The optional private candidate extension below publishes
one clean committed application snapshot; it does not create a registry, grant
IAM access, replace managed CI or perform a deployment. Image preparation reuses the
packaged helper's restore smoke and source/image identity checks. A publication
receipt must distinguish local preparation, provider acknowledgment and verified
anonymous immutable content. Unknown outcomes require readback; no blind replay.

All targets and public permissions require a concrete review. Nothing in this
implementation authorizes live resource creation or publication. Existing secret
collection, runtime readers and unrelated grants remain separately authorized.

## Exact desired selection and upgrade behavior

```json
{
  "operatorArtifacts": {
    "templates": {
      "provider": "s3",
      "nativeScope": {
        "scopeKind": "s3-cloudformation-publication-v1",
        "accountId": "123456789012",
        "region": "us-west-2"
      },
      "artifacts": ["aws-collection-template-v1", "aws-deployment-template-v1"]
    },
    "images": {
      "provider": "cloudrun",
      "nativeScope": {
        "scopeKind": "gar-image-publication-v1",
        "projectId": "operator-project",
        "region": "us-central1",
        "packageVersion": "0.1.44"
      },
      "artifacts": ["holding-v1", "backup-runner-v1"]
    }
  }
}
```

The image declaration selects the installed package version explicitly. Changing
that version requires a spec edit and a fresh publication review. Native project
and public repository lifetime/ownership proof comes from the environment's
verified local connection binding, never from user-supplied createTime fields.
The operator must first complete the separately reviewed public repository setup.

For S3 the installed template generators select exact SHA-256 digests. A package
upgrade that changes template bytes proposes a new reviewed publication plan;
it does not upload anything automatically. Previous immutable versions and target
ownership receipts remain retained. Unchanged selected versions become noops.

Image preparation performs a local `npm pack --ignore-scripts` into a private
cache, checks the shipped dependency lock, builds linux/amd64 images from that
exact archive, and executes the packaged PostgreSQL 16 restore smoke and holding
server smoke with no network. The package lock is copied at build time only after
checking package identity, versions, dependency agreement, public npm archive URLs
and integrity hashes. The image Dockerfile uses `npm ci --omit=dev --ignore-scripts`
against that shipped lock; it does not resolve an unpinned dependency tree or need
the source checkout. Review records package version, archive SHA-256, lock SHA-256
and tested immutable local Docker configuration ID. Registry manifest digests are
separate identities and are recorded only after native readback and an anonymous
pull match that exact configuration and its provenance labels.

A transient Google access token is passed to Docker login through standard input.
Its isolated private Docker configuration is removed after each attempt. Pushes
use unique per-attempt tags, and a pre-existing tag is a conflict. GAR has no
conditional Docker tag-create operation: a racing overwrite cannot establish a
receipt unless the resulting immutable image matches the exact reviewed content.
After an uncertain push, recovery only reads the retained tag/digest and pulls the
immutable image; it never repeats the push. Public target grants and runtime
reader access are not modified by publication.

## Contract evidence

Official sources reviewed for native behavior:

- [GAR access-token Docker authentication](https://docs.cloud.google.com/artifact-registry/docs/docker/authentication#token)
- [GAR tags.get](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.packages.tags/get)
- [GAR dockerImages.get](https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories.dockerImages/get)
- [Docker image push](https://docs.docker.com/reference/cli/docker/image/push/)

The new GAR boundary suite initially failed because the publisher was absent;
seven serialized native/command cases now exercise immutable readback, lost
acknowledgment, unknown absence, replaced repository lifetime, permission removal,
public-reader removal and changed local image identity. These are reconstructed
responses, not live GAR certification. The actual npm-pack/tar boundary test also
exposed reliance on the user's global npm cache; it failed under the normal
sandbox and passed after preparation gained its own private cache. That suite
checks exact packaged inputs and runs an actual failing child process to prove
credential echoes do not escape command errors. All are ordinary `npm test`
files; live branch-protection enforcement and cloud publication are separate
acceptance evidence.

Application acceptance challenges the assumption that current declarations are
enough to discover unfinished publication. With the actual AWS SDK transport,
SQLite journal and ordinary spec/plan/apply boundary, a lost CreateStack response
followed by declaration removal and restart incorrectly fell through to hosting
inspection (one failing regression, seven passing neighboring cases). Planning
now discovers retained artifact journals before parsing desired declarations and
offers only original attempted actions for read-only recovery. Removed,
reassigned and malformed native declarations cannot authorize unstarted uploads
or public grants; narrower scopes cannot bypass an unresolved operation.

Two further boundary regressions failed before correction: an unrelated service
edit stranded unchanged artifact actions even after a fresh review, and current
hosting-provider validation in the command adapter hid retained artifact
recovery that the application accepted. Resumption now compares the exact
repository, artifact selection and native-scope digests while the fresh outer
plan still validates the current full spec revision. An old saved plan is
rejected. Commands admit retained recovery without resolving unrelated hosting
or materializing local secret files; unattempted proposals retain normal
provider validation.

The application suite also checks every missing action confirmation,
stale/cross-environment plans, authority changes at the final mutation boundary,
hosted-authentication denial, immutable receipt output, and lost stack/object/
policy responses without replay. These ordinary `npm test` checks validate
application authorization, durable recovery and serialized provider contracts;
live account authority and actual publication remain separate evidence.

The real application/SQLite suite exposed two additional counterexamples before
runtime fixes: deleting an artifact declaration after a lost CloudFormation
acknowledgment hid retained recovery, and editing an unrelated service prevented
resumption despite an unchanged artifact selection. Recovery now discovers
namespaced durable history before interpreting the current spec, prioritizes
accepted unfinished operations, and offers only original attempted actions when
the declaration is missing, malformed or changed. Narrow plan scopes cannot
bypass that history. A freshly reviewed outer plan can resume unstarted actions
when canonical repository, artifact declaration, native proof and kinds remain
exact; the original source revision stays immutable audit evidence. An old saved
outer plan still fails current-spec admission. Already attempted writes remain
readback-only in all cases.

A preliminary actual packaged-image run on 2026-10-25 passed both local image
smokes, including the PostgreSQL 16 schema/rows/index/identity/retained-file restore
and late-failure checks. Its archive SHA-256 was
`34025b7793994104a72c859e0baa52760dc72cb356fee26a576a76bbd246d5e8` and lock SHA-256
`7d429544a0d953c3b6859db5e95cbed1748de172688c1ddb6b8bc6c4fbfc7267`. This proves
that packaged dependency installation and helper execution work for those bytes;
a final changed package requires its own build/smoke receipt. It is not evidence
of a live GAR push, cloud download or publication approval.


## Private application candidates

The original app can publish its reviewed candidate through the same
`hv_spec` → `hv_plan` → `hv_apply` lifecycle without changing its repository binding,
merging an unfinished feature or replacing the remote default branch. The local
candidate checkout must be clean, have the exact canonical origin of the app,
and have the selected full commit checked out. A local commit is not evidence
that this candidate was pushed to the code host.

```json
{
  "operatorArtifacts": {
    "candidate": {
      "provider": "cloudrun",
      "artifacts": ["application-candidate-v1"],
      "nativeScope": {
        "scopeKind": "gar-private-candidate-publication-v1",
        "projectId": "operator-project",
        "region": "us-central1",
        "imageName": "operator-candidate",
        "sourceDirectory": "/absolute/path/to/clean-candidate",
        "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
        "packageReadAuthentication": "github-package-read"
      }
    }
  }
}
```

This initial private publisher supports an owned Google project with no parent.
It verifies the original project lifetime and creation markers, the private
repository lifetime and original installation/attempt ownership, and both project
and repository IAM reads. Public principals or unknown policy reads block
publication. Organization/folder ancestors are explicitly unsupported here until
their inherited authority can be verified. All other named hosting publishers
(ECS/ECR, Azure Container Apps/ACR, Railway, Fly, DigitalOcean and Vercel) reject
this candidate kind; existing deployment and public helper capabilities are
unchanged. Historical bindings without the private repository ownership proof
must complete a separately reviewed binding repair from their retained journals.
The publisher cannot infer ownership from a repository name.

Preparation archives only the selected Git commit. It verifies every archived
blob against Git, rejects symlinks/submodules and private dotenv/config files,
and hashes sorted file bytes/modes, the root Dockerfile and package lock. Ignored
local secrets and Git metadata never enter the build context. The package token
comes only from an exact verified repository connection's `packageReadToken`
role; management tokens and owner/global fallback are not accepted for this build.

The BuildKit secret is a private temporary file outside that context. A unique
owned `docker-container` builder has bounded CPU/memory and no shared-cache
fallback. The final image must be linux/amd64 and nonroot. All exported image
entries (including gzip layers), image configuration and exported final filesystem
are scanned for the exact credential before publication becomes reviewable.
Zstd layers, including leading skippable frames, are explicitly unsupported and
reject preparation; scanning their compressed bytes cannot establish that the
decoded layer is free of the credential.
Failed/uncertain builds clean their exact owned image and builder/cache; a cleanup
failure preserves a value-free recovery record and blocks publication. Successful
images remain available for the later confirmed push after their builder is
removed. These checks do not claim protection against malicious source making
network requests or transforming a token: selecting the source commit is code
execution authority.

A single confirmed push targets a new per-attempt tag in the existing private
repository. It creates no registry, IAM binding or workload. Recovery performs
readback only, including after restart or removal of the declaration. The final
receipt records the registry manifest digest separately from the local Docker
configuration ID and compares exact source/image provenance using authenticated
pull. Deploying that immutable image is another separately reviewed lifecycle
step; successful publication is not application readiness.

Independent evidence includes [Docker secret mounts](https://docs.docker.com/build/building/secrets/),
[Docker's dedicated container builder and cache semantics](https://docs.docker.com/build/builders/drivers/docker-container/),
[builder removal options](https://docs.docker.com/reference/cli/docker/buildx/rm/),
and [GAR authentication and push/pull contracts](https://docs.cloud.google.com/artifact-registry/docs/docker/pushing-and-pulling).
Docker's CLI plugin discovery source also explains why an isolated Docker config
must explicitly retain the standard plugin location without copying registry
credentials: the first actual local smoke failed at `docker buildx` when that
location was omitted.

Observed regressions before implementation: seven new candidate publication
cases rejected the unknown actor kind; four builder cases rejected preparation
before they could exercise exact source/secret custody; the exact-repository
credential test incorrectly selected an owner wildcard token; and five cache
cleanup cases exposed the absence of an isolated owned builder. These normal
`npm test` cases now exercise real SQLite, Git archive/blob checks, tar/gzip
scanning, serialized native transport and Docker command boundaries. Additional
opt-in local Docker smoke exercises actual BuildKit and export/cleanup behavior.
The committed acceptance workflow and desired required-check spec invoke
`npm test` and `npm run typecheck`; this file does not establish live branch
protection, GAR compatibility or provider publication approval.


The local synthetic Docker boundary passed both actual cases: a clean BuildKit
secret-mount build with full image/final-filesystem scanning, and a deliberately
copied synthetic credential rejected before publication with the exact resulting
image, builder container and cache volume verified absent. No GAR or other cloud
calls were made. Two additional failing boundary cases showed that a numeric
root-equivalent `USER 00` and a five-GiB image were initially accepted; the builder
now requires a valid nonroot user and a bounded native image size before export.

The assumption that gzip decoding plus raw scanning covers all OCI layers was
falsified by two real tar fixtures: a zstd-compressed layer containing the exact
synthetic credential, with or without an RFC 8878 skippable frame, followed by a
whiteout that leaves the final filesystem clean. Both initially returned a
verified scan. The [OCI layer contract](https://github.com/opencontainers/image-spec/blob/main/layer.md)
explicitly permits zstd and whiteouts; [RFC 8878](https://www.rfc-editor.org/rfc/rfc8878.html)
defines both frame signatures. Normal acceptance now checks explicit rejection
and owned image/cache cleanup through the actual tar boundary. This closes the
unsupported-compression gap; it does not establish detection of transformed
credentials or prevent malicious source from exfiltrating a build secret.

Both public helper and private candidate publication also retain the approved
billing account from the verified project binding. Before new plan/mutation
authority, the native billing read must report enabled billing on that exact
account. A live association is mutable even when the project and registry remain
owned: Google's [ProjectBillingInfo contract](https://docs.cloud.google.com/billing/docs/reference/rest/v1/ProjectBillingInfo)
reports account identity separately from enabled status. Four serialized
boundary cases initially allowed publication after account replacement or
disabled billing; they now block both publishers before a push. Historical
scopes and immutable receipts remain readable, but missing billing proof cannot
authorize a fresh plan or mutation. These reads are not an atomic billing lock
against changes by another independently authorized administrator.

The AWS federation transport fixture separately reproduces a clock-boundary
assertion failure: regenerating the expected synthetic JWT changed its expiry
claim after the actual token was sent. Advancing the clock on each read produced
RED; capturing the supplied token once produced GREEN while preserving exact
serialized STS token, role, session-duration and native expiry validation. This
is a test timing defect, not evidence of an AWS interoperability failure.
