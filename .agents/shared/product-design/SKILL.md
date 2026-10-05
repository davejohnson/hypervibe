---
name: product-design
description: Design or revise human-facing product flows, screens, navigation, onboarding, forms and consequential UI copy. Establish user intent and information hierarchy, implement within the local design system, then separately check clarity and behavior. Not for unrelated backend or library changes.
---

# Design the task, then the screen

Use the project's actual style guide, components and domain rules. This skill
does not prescribe a visual theme, framework or a new design system. Read the
local adapter's relevant references before design and implementation.

## Establish the user's situation

For a new or materially changed flow, write a short design brief before runtime
code. Use what is already known; ask only about uncertainty that would change
the outcome. State:

- The user's goal and what brought them here.
- What they already know, what the product knows, and the decision still needed.
- The next action, what it immediately changes, and how completion is recognized.
- Constraints: real permissions, service behavior, failure/recovery and devices.

For a tiny cosmetic adjustment, use proportionate judgment; do not manufacture
a multi-step design exercise. A comprehension complaint needs a workflow and
hierarchy review, not just shorter wording.

## Sketch the hierarchy

Before building a substantive screen or flow, show a compact text sketch or
wireframe: purpose, visible context, necessary choices, primary action and result.
Describe it in the user's vocabulary. Confirm behavior from the service contract
without exposing internal state-machine names as instructions to the user.

- Make the actor, action and object concrete. “Review setup” or “read this” is
  not useful when the object, destination or responsible actor is invisible.
- Show known repository, branch, account, environment or document context where
  it affects a decision. Prefill known non-secret values and allow correction
  when appropriate; a prefill is not authorization.
- Name buttons for their immediate effect. If an action only previews, don't
  call it “Connect”. If more steps are required, make the next step apparent.
- Put essential context beside the choice it explains. Prefer hierarchy,
  labels and sensible defaults over paragraphs of caveats. Keep consequential
  warnings, consent and limits where they affect the action.
- Do not invent clicks, success states or automatic behavior the backend cannot
  deliver. Fix the interaction within scope, or identify the missing behavior.

Read [examples](references/examples.md) when designing onboarding, handoffs or
repairing confusing instructional copy. They illustrate reasoning, not wording
to copy into unrelated products.

## Build and inspect the actual experience

Use established components and visual language. Check the relevant initial,
loading, empty, success, permission and recoverable-error states. Make keyboard
navigation, focus, labels, errors and small-screen layout part of the feature.
Choose readable density for the task, not a universal sparse-card or dashboard
style. Do not weaken security or skip a real permission check for a cleaner demo.

For substantial new/changed flows, inspect the rendered UI at representative
desktop and mobile sizes, including the state a first-time user actually sees.
Do not claim screenshots were reviewed when only markup or string tests ran.

## Separate clarity review from implementation verification

For consequential or substantially changed flows, give an independent reviewer
the screenshot(s), user goal and minimum prior context, without an implementation
explanation or proposed answer. Ask them to identify where they are, what they
need to decide, what to do next, what that action does and how to recover.
Unclear or wrong answers are design findings, not an invitation to add a paragraph
explaining the implementation. Address the hierarchy/interaction first.

Use an available independent agent or human. If neither is available, perform
an explicit cold-read and report the limitation. Agent review is a heuristic,
not evidence that real users can complete the task.

Test actual navigation, prefilled context, state changes, permissions and recovery
separately. Avoid tests whose only proof of “good UX” is that the proposed sentence
exists. At handoff show UI evidence, behavior checked, clarity-review findings
and anything not verified. Don't claim the experience is intuitive from passing
tests alone.
