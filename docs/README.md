# Documentation map

Start with the [common cloud user journey](development/user-journey.md) when
planning new GCP, AWS or Azure work. It defines the next product milestone and
the evidence needed to complete it. It is a target, not a support announcement.

## Current requirements

| Question | Read |
| --- | --- |
| What user outcome are we building, and in what order? | [Common cloud journey](development/user-journey.md) |
| What owns infrastructure, state, approvals and secrets? | [Architecture](../ARCHITECTURE.md) |
| How should the user experience work? | [Product and audience](development/product.md) |
| Which instructions apply to this change? | [Maintainer task routing](../AGENTS.md#read-the-relevant-contracts) |
| How do we verify cloud behavior? | [Provider evidence rules](development/provider-evidence.md) and [conformance harness](provider-conformance.md) |
| What can an installed customer use? | [Installed skill](../skills/hypervibe/SKILL.md) and [installation limits](agent-installation.md); check the installed release's schemas and results |

The journey defines scope and acceptance; architecture defines technical and
safety boundaries. The topic rules linked from `AGENTS.md` preserve their
applicable safeguards. Neither a milestone nor a backend note relaxes those
boundaries. These documents describe requirements separately from availability.

## Implementation notes and evidence

The [GCP](opentofu-engine.md), [AWS](opentofu-engine-aws.md) and
[Azure](opentofu-engine-azure.md) pages describe backend choices, limitations and
dated live observations. Read only the selected cloud's relevant section. A live
result applies to its recorded revision and scope; it does not certify every
feature, a later cutover, or the complete common journey.

The [GCP integration boundary](development/opentofu-integration.md) describes the
current GCP ownership split. The [conformance guide](provider-conformance.md)
describes available test profiles, which may cover less than a backend's manual
live evidence or the target journey. Neither is a second product roadmap.

Other topic documents are references for the named feature. Consult them when a
task touches that feature, together with the current architecture and applicable
topic rules. They do not require adding every described feature to all clouds.
Descriptions of old adapters are not evidence those adapters remain reachable.
Unverified instructions must not be used to bypass an unsupported managed path.

## Keeping direction clear

- Change product scope in the common journey, and technical boundaries in
  architecture. Link to them rather than duplicating a roadmap in provider notes.
- Label new documents as requirements, current usage, implementation notes,
  or evidence. Evidence needs a revision, scope, observed outcome and gaps.
- Keep current usage aligned with reachable behavior and the installed release.
  Distinguish implementation from offline checks and live verification.
- Delete superseded designs, old backlogs and one-off audit records. Preserve
  unique current safeguards in the relevant contract and update inbound links.
  Git history holds past material; do not keep a second roadmap in an archive.
- Record policy decisions in the changed contract and its pull request. Dated
  evidence needed to explain current capability limits belongs in the relevant
  implementation note, with its scope explicit.
- Read only what the task touches. No change requires loading this whole folder
  or reviving a checklist from an old revision.
