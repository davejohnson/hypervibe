# Browser authorization for existing destinations

`purpose=connect-cloud mode=connect-existing` requests a first hosted writer for
exact native destinations already committed for the selected app and environment.
It does not require local cloud credentials or an existing writer. The app member
starts the request; a cloud administrator separately reviews native resources,
permissions and costs in the browser. Secret collection remains separately
authorized. `mode=connect` prepares new destinations; `mode=migrate` retains its
requirement for an independently authorized previous writer and reviewed switch.

The new mode is part of the immutable installation digest. The existing
`migrationTargets` field carries its exact native target list; the name is retained
for compatibility, not evidence that a previous writer exists. Missing, duplicate,
cross-provider and changed targets fail closed. Shared planning rejects every
non-noop secret-container action. Completed connection projection must preserve
the exact reviewed destinations. Deployment and project-preparation stages reject
this collection-only mode.

Hypercloud must independently establish that no prior writer or unresolved trust
journal needs migration or recovery, then recheck that admission when publishing
the verified connection. It must not manufacture an old writer receipt, retire a
writer that appeared concurrently, or alter committed versions. Existing writer
migration and historical cleanup keep their original evidence and authority.

| Provider | Native preservation and authority | Explicit limits |
| --- | --- | --- |
| AWS | Reviewed CloudFormation creates new scoped identities. Existing targets use complete secret ARNs; the stack creates no corresponding secret containers. Hosted recovery independently verifies the account, stack, roles, exact ARN and native creation date before publishing the writer. | Target presence is unverified before console installation. The template and its publication must pass the normal verification. This authorization does not make an existing secret a stack-owned resource. |
| GCP | Transient browser administration reads each exact project/secret creation time before review. Existing containers are metadata-only actions; new identity and etag-preserving grants are separate actions. Recreated targets block inspection and dependent grants. | Unknown reads never authorize creation or adoption. Neither existing values nor labels are rewritten. |
| Azure | Transient browser administration verifies the exact tenant/subscription/RBAC vault and native creation time. The vault remains a noop; only the new writer, custom role, federation and assignment are installed. | The current data grant is vault-wide. Existing vaults must retain native customer/app/environment markers matching this scope. Unmarked, shared, differently owned or access-policy vaults remain unsupported. Use the fresh isolated-vault browser connection flow for new destinations; do not manually add tags or writer credentials to bypass the check. Existing committed destinations are never silently replaced. |

AWS [DescribeSecret](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DescribeSecret.html)
returns metadata without the value; the complete ARN and creation date are native
identity evidence. Google documents the secret's output-only
[name and creation time](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets).
Azure [RBAC guidance](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide)
separates control and data permissions and recommends one vault per app and
environment. Individual-secret roles are a separate native option, not implemented
by this path. Native markers correlate Azure app scope; they never alone prove
that this installation created a resource or may delete it.

The challenged assumption was that a predeclared target necessarily has a
previously prepared writer. The ordinary destination page violated that assumption:
it offered local-login/manual-writer setup to new customers, while browser connect
rejected their targets and migration required an old writer. Five regressions
failed before the change: AWS/GCP/Azure native installation entry, the shared
immutable contract and the real Git/SQLite command boundary. The tests now cover
the distinct review, exact-target projection, unchanged native containers and
pinned versions, mutation-free container actions, and Azure's retained isolation
veto. Transport fixtures are reconstructed official contracts; the shared fixture
is synthetic. These checks do not establish live compatibility or complete the
required disposable-account walkthroughs.
