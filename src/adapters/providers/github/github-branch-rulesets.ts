/**
 * Branch rules that live in GitHub rulesets rather than classic branch
 * protection. GitHub enforces both, so reads combine them and writes change a
 * rule where it already lives instead of adding a second copy elsewhere.
 */

export interface BranchRule {
  type: string;
  parameters?: Record<string, unknown>;
  ruleset_source_type?: string;
  ruleset_source?: string;
  ruleset_id?: number;
}

export interface RulesetBypassActor {
  actor_id?: number | null;
  actor_type: string;
  bypass_mode?: string;
}

export interface Ruleset {
  id: number;
  name: string;
  target?: string;
  source_type?: string;
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: Array<{ type: string; parameters?: Record<string, unknown> }>;
  bypass_actors?: RulesetBypassActor[];
}

export interface ClassicBranchProtection {
  required_status_checks: {
    strict: boolean;
    contexts: string[];
    checks: Array<{ context: string; app_id: number | null }>;
  } | null;
  required_pull_request_reviews: {
    required_approving_review_count: number;
    dismiss_stale_reviews: boolean;
    require_code_owner_reviews: boolean;
  } | null;
  enforce_admins: { enabled: boolean } | null;
  required_linear_history: { enabled: boolean } | null;
  allow_force_pushes: { enabled: boolean } | null;
  allow_deletions: { enabled: boolean } | null;
}

export interface DesiredBranchRules {
  requireReviews?: boolean;
  requiredReviewers?: number;
  dismissStaleReviews?: boolean;
  requireCodeOwnerReviews?: boolean;
  requireStatusChecks?: boolean;
  statusChecks?: string[];
  strictStatusChecks?: boolean;
  enforceAdmins?: boolean;
}

export interface RulesetWrite {
  /** Present when an existing ruleset is changed; absent for a new one. */
  id?: number;
  body: Record<string, unknown>;
}

// The built-in repository admin role, as GitHub returned it for a ruleset that
// lets admins bypass. Organization admins are a separate actor type.
const ADMIN_ROLE_ID = 5;
const ADMIN_BYPASS: RulesetBypassActor = { actor_id: ADMIN_ROLE_ID, actor_type: 'RepositoryRole', bypass_mode: 'always' };

type StatusCheck = { context: string; integration_id?: number };

function isAdmin(actor: RulesetBypassActor): boolean {
  return actor.actor_type === 'OrganizationAdmin'
    || (actor.actor_type === 'RepositoryRole' && actor.actor_id === ADMIN_ROLE_ID);
}

function adminCanBypass(ruleset: Ruleset | undefined): boolean {
  return Boolean(ruleset?.bypass_actors?.some(isAdmin));
}

function statusChecksOf(rule: { parameters?: Record<string, unknown> }): StatusCheck[] {
  const checks = rule.parameters?.required_status_checks;
  return Array.isArray(checks)
    ? checks.filter((check): check is StatusCheck => typeof (check as StatusCheck)?.context === 'string')
    : [];
}

function isStrict(rule: { parameters?: Record<string, unknown> }): boolean {
  return rule.parameters?.strict_required_status_checks_policy === true;
}

function reviewsOf(rule: { parameters?: Record<string, unknown> }) {
  const parameters = rule.parameters ?? {};
  return {
    count: typeof parameters.required_approving_review_count === 'number' ? parameters.required_approving_review_count : 0,
    dismissStale: parameters.dismiss_stale_reviews_on_push === true,
    codeOwners: parameters.require_code_owner_review === true,
  };
}

/** A pull request rule with no approvals only requires a pull request. */
function requiresReview(rule: { parameters?: Record<string, unknown> }): boolean {
  const reviews = reviewsOf(rule);
  return reviews.count > 0 || reviews.codeOwners;
}

function guards(rule: { type: string; parameters?: Record<string, unknown> }): boolean {
  return rule.type === 'required_status_checks' || (rule.type === 'pull_request' && requiresReview(rule));
}

/**
 * What GitHub enforces on the branch, in the shape of classic branch
 * protection. Null only when neither classic protection nor any rule applies.
 */
export function effectiveBranchProtection(
  classic: ClassicBranchProtection | null,
  rules: BranchRule[],
  rulesets: Map<number, Ruleset>,
): ClassicBranchProtection | null {
  if (rules.length === 0) return classic;
  const has = (type: string) => rules.some((rule) => rule.type === type);
  const statusRules = rules.filter((rule) => rule.type === 'required_status_checks');
  const reviewRules = rules.filter((rule) => rule.type === 'pull_request' && requiresReview(rule));

  const classicStatus = classic?.required_status_checks ?? null;
  const classicContexts = classicStatus?.contexts?.length
    ? classicStatus.contexts
    : classicStatus?.checks?.map((check) => check.context) ?? [];
  const ruleChecks = statusRules.flatMap(statusChecksOf);
  const contexts = [...new Set([...classicContexts, ...ruleChecks.map((check) => check.context)])];

  const classicReviews = classic?.required_pull_request_reviews ?? null;
  const reviews = reviewRules.map(reviewsOf);

  // Admins are held to the rules unless every ruleset carrying them lets admins bypass.
  const rulesetsEnforceAdmins = [...statusRules, ...reviewRules].some((rule) => {
    const ruleset = rule.ruleset_id === undefined ? undefined : rulesets.get(rule.ruleset_id);
    return ruleset !== undefined && !adminCanBypass(ruleset);
  });

  return {
    required_status_checks: classicStatus || statusRules.length > 0
      ? {
          strict: Boolean(classicStatus?.strict) || statusRules.some(isStrict),
          contexts,
          checks: contexts.map((context) => ({
            context,
            app_id: classicStatus?.checks?.find((check) => check.context === context)?.app_id
              ?? ruleChecks.find((check) => check.context === context)?.integration_id
              ?? null,
          })),
        }
      : null,
    required_pull_request_reviews: classicReviews || reviews.length > 0
      ? {
          required_approving_review_count: Math.max(
            classicReviews?.required_approving_review_count ?? 0,
            ...reviews.map((review) => review.count),
          ),
          dismiss_stale_reviews: Boolean(classicReviews?.dismiss_stale_reviews) || reviews.some((review) => review.dismissStale),
          require_code_owner_reviews: Boolean(classicReviews?.require_code_owner_reviews) || reviews.some((review) => review.codeOwners),
        }
      : null,
    enforce_admins: { enabled: Boolean(classic?.enforce_admins?.enabled) || rulesetsEnforceAdmins },
    required_linear_history: {
      enabled: Boolean(classic?.required_linear_history?.enabled) || has('required_linear_history'),
    },
    allow_force_pushes: { enabled: (classic?.allow_force_pushes?.enabled ?? true) && !has('non_fast_forward') },
    allow_deletions: { enabled: (classic?.allow_deletions?.enabled ?? true) && !has('deletion') },
  };
}

function coversOnlyBranch(ruleset: Ruleset, branch: string, isDefaultBranch: boolean): boolean {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  const exclude = ruleset.conditions?.ref_name?.exclude ?? [];
  return ruleset.source_type === 'Repository'
    && ruleset.target === 'branch'
    && ruleset.enforcement === 'active'
    && exclude.length === 0
    && include.length === 1
    && (include[0] === `refs/heads/${branch}` || (isDefaultBranch && include[0] === '~DEFAULT_BRANCH'));
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().join('\n') === [...right].sort().join('\n');
}

/**
 * The ruleset writes that bring the branch to the desired rules. Rulesets that
 * cover only this branch are edited in place. A ruleset that also covers other
 * branches, or belongs to an organization, is never edited: if it is stricter
 * than desired this throws, before anything is written.
 */
export function planRulesetWrites(params: {
  branch: string;
  isDefaultBranch: boolean;
  /** Classic protection also exists and will carry any rule no ruleset holds. */
  classicExists: boolean;
  rules: BranchRule[];
  rulesets: Map<number, Ruleset>;
  desired: DesiredBranchRules;
}): RulesetWrite[] {
  const { branch, desired } = params;
  const editable = new Map<number, Ruleset>();
  for (const [id, ruleset] of params.rulesets) {
    if (coversOnlyBranch(ruleset, branch, params.isDefaultBranch)) editable.set(id, structuredClone(ruleset));
  }
  const changed = new Set<number>();
  const added: Array<{ type: string; parameters?: Record<string, unknown> }> = [];
  const outside = params.rules.filter((rule) => rule.ruleset_id === undefined || !editable.has(rule.ruleset_id));
  const describe = (rule: BranchRule) => {
    const name = rule.ruleset_id === undefined ? undefined : params.rulesets.get(rule.ruleset_id)?.name;
    return name ? `"${name}"` : `${rule.ruleset_id ?? 'unknown'} from ${rule.ruleset_source ?? 'another owner'}`;
  };
  const refuse = (rule: BranchRule, what: string): never => {
    throw new Error(
      `GitHub ruleset ${describe(rule)} ${what} on ${branch}, and Hypervibe only edits rulesets that cover ${branch} alone. `
      + 'Change that ruleset in GitHub, or change the project settings to match it.',
    );
  };
  const holders = (type: string) => [...editable.values()].flatMap((ruleset) =>
    (ruleset.rules ?? []).filter((rule) => rule.type === type).map((rule) => ({ ruleset, rule })));

  if (desired.requireStatusChecks && desired.statusChecks && desired.statusChecks.length > 0) {
    const wanted = desired.statusChecks;
    const strict = desired.strictStatusChecks ?? true;
    const outsideStatus = outside.filter((rule) => rule.type === 'required_status_checks');
    for (const rule of outsideStatus) {
      if (isStrict(rule) && !strict) refuse(rule, 'requires branches to be up to date');
      const extra = statusChecksOf(rule).find((check) => !wanted.includes(check.context));
      if (extra) refuse(rule, `requires the check "${extra.context}"`);
    }
    const held = holders('required_status_checks');
    for (const { ruleset, rule } of held) {
      const current = statusChecksOf(rule);
      if (isStrict(rule) === strict && sameSet(current.map((check) => check.context), wanted)) continue;
      rule.parameters = {
        ...rule.parameters,
        strict_required_status_checks_policy: strict,
        required_status_checks: wanted.map((context) => current.find((check) => check.context === context) ?? { context }),
      };
      changed.add(ruleset.id);
    }
    const covered = new Set(outsideStatus.flatMap(statusChecksOf).map((check) => check.context));
    const satisfied = wanted.every((context) => covered.has(context)) && (!strict || outsideStatus.some(isStrict));
    if (held.length === 0 && !satisfied && !params.classicExists) {
      added.push({
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: strict,
          required_status_checks: wanted.map((context) => ({ context })),
        },
      });
    }
  }

  const wantReview = {
    count: desired.requireReviews ? desired.requiredReviewers ?? 1 : 0,
    dismissStale: Boolean(desired.requireReviews && desired.dismissStaleReviews),
    codeOwners: Boolean(desired.requireReviews && desired.requireCodeOwnerReviews),
  };
  const outsideReviews = outside.filter((rule) => rule.type === 'pull_request').map((rule) => ({ rule, ...reviewsOf(rule) }));
  for (const review of outsideReviews) {
    if (review.count > wantReview.count) refuse(review.rule, `requires ${review.count} approving review(s)`);
    if (review.codeOwners && !wantReview.codeOwners) refuse(review.rule, 'requires code owner review');
    if (review.dismissStale && !wantReview.dismissStale && desired.requireReviews) refuse(review.rule, 'dismisses stale reviews');
  }
  const heldReviews = holders('pull_request');
  for (const { ruleset, rule } of heldReviews) {
    const current = reviewsOf(rule);
    if (!desired.requireReviews && !requiresReview(rule)) continue;
    if (current.count === wantReview.count && current.dismissStale === wantReview.dismissStale && current.codeOwners === wantReview.codeOwners) continue;
    rule.parameters = {
      ...rule.parameters,
      required_approving_review_count: wantReview.count,
      dismiss_stale_reviews_on_push: wantReview.dismissStale,
      require_code_owner_review: wantReview.codeOwners,
    };
    changed.add(ruleset.id);
  }
  if (desired.requireReviews && heldReviews.length === 0 && !params.classicExists) {
    const satisfied = outsideReviews.some((review) => review.count === wantReview.count)
      && (!wantReview.codeOwners || outsideReviews.some((review) => review.codeOwners))
      && (!wantReview.dismissStale || outsideReviews.some((review) => review.dismissStale));
    if (!satisfied) {
      added.push({
        type: 'pull_request',
        parameters: {
          required_approving_review_count: wantReview.count,
          dismiss_stale_reviews_on_push: wantReview.dismissStale,
          require_code_owner_review: wantReview.codeOwners,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      });
    }
  }

  if (!params.classicExists) {
    for (const type of ['deletion', 'non_fast_forward']) {
      if (!params.rules.some((rule) => rule.type === type)) added.push({ type });
    }
  }

  const enforceAdmins = desired.enforceAdmins ?? false;
  if (!enforceAdmins) {
    const blocking = outside.find((rule) => {
      const ruleset = rule.ruleset_id === undefined ? undefined : params.rulesets.get(rule.ruleset_id);
      return guards(rule) && ruleset !== undefined && !adminCanBypass(ruleset);
    });
    if (blocking) refuse(blocking, 'holds admins to its rules');
  }
  for (const ruleset of editable.values()) {
    if (!ruleset.bypass_actors || !(ruleset.rules ?? []).some(guards)) continue;
    if (enforceAdmins && adminCanBypass(ruleset)) {
      ruleset.bypass_actors = ruleset.bypass_actors.filter((actor) => !isAdmin(actor));
      changed.add(ruleset.id);
    } else if (!enforceAdmins && !adminCanBypass(ruleset)) {
      ruleset.bypass_actors = [...ruleset.bypass_actors, ADMIN_BYPASS];
      changed.add(ruleset.id);
    }
  }

  const writes: RulesetWrite[] = [...changed].map((id) => {
    const ruleset = editable.get(id)!;
    return {
      id,
      body: {
        name: ruleset.name,
        target: ruleset.target,
        enforcement: ruleset.enforcement,
        conditions: ruleset.conditions,
        rules: ruleset.rules,
        ...(ruleset.bypass_actors ? { bypass_actors: ruleset.bypass_actors } : {}),
      },
    };
  });
  if (added.length > 0) {
    writes.push({
      body: {
        name: `Hypervibe rules for ${branch}`,
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
        rules: added,
        bypass_actors: !enforceAdmins && added.some(guards) ? [ADMIN_BYPASS] : [],
      },
    });
  }
  return writes;
}
