import type { AutoFixConfig } from './config.js';
import { StateManager, type TrackedError } from './state.js';
import { LogWatcher, type NormalizedError } from './watchers/log-watcher.js';
import { RailwayLogWatcher } from './watchers/railway.watcher.js';
import { ErrorAnalyzer, type AnalysisResult } from './analyzer/error-analyzer.js';
import { CodeFixer, type FixResult } from './fixer/code-fixer.js';
import { PRCreator, type PRResult } from './github/pr-creator.js';
import { createFingerprint } from './watchers/types.js';

/**
 * Main orchestrator for the auto-fix agent.
 * Coordinates log watching, error analysis, code fixing, and PR creation.
 */
export class AutoFixAgent {
  private readonly config: AutoFixConfig;
  private readonly state: StateManager;
  private readonly watchers: Map<string, LogWatcher>;
  private readonly analyzer: ErrorAnalyzer;
  private readonly fixer: CodeFixer;
  private readonly prCreator: PRCreator;

  constructor(config: AutoFixConfig) {
    this.config = config;
    this.state = new StateManager(config.workingDirectory);
    this.watchers = new Map();
    this.analyzer = new ErrorAnalyzer(config);
    this.fixer = new CodeFixer(config);
    this.prCreator = new PRCreator(config);
  }

  /**
   * Run a single poll cycle.
   * This is called by the GitHub Actions cron job.
   */
  async run(): Promise<RunResult> {
    console.log('Auto-Fix Agent starting...');

    const result: RunResult = {
      errorsFound: 0,
      errorsAnalyzed: 0,
      fixesAttempted: 0,
      prsCreated: 0,
      errors: [],
    };

    try {
      // 1. Get enabled watches
      const watches = this.state.getEnabledWatches();
      if (watches.length === 0) {
        console.log('No enabled watches configured');
        return result;
      }

      console.log(`Processing ${watches.length} watches...`);

      // 2. Poll logs for each watch
      const allErrors: NormalizedError[] = [];
      for (const watch of watches) {
        const watcher = await this.getWatcher(watch.projectId);
        if (!watcher) {
          console.warn(`No watcher available for project ${watch.projectId}`);
          continue;
        }

        const lastPoll = this.state.getLastPollAt();
        const errors = await watcher.fetchErrors(
          watch.environmentId,
          watch.serviceName,
          { since: lastPoll ?? undefined, limit: this.config.maxErrorsPerPoll }
        );

        console.log(`Found ${errors.length} errors in ${watch.serviceName}`);
        allErrors.push(...errors);
      }

      result.errorsFound = allErrors.length;

      // 3. Deduplicate and filter errors
      const newErrors = this.filterNewErrors(allErrors);
      console.log(`${newErrors.length} new/actionable errors after filtering`);

      // 4. Process each error
      for (const error of newErrors) {
        // Check rate limits
        if (!this.state.canCreatePR(this.config.maxPRsPerHour)) {
          console.log('PR rate limit reached, stopping for this run');
          break;
        }

        // Check cooldown
        const fingerprint = createFingerprint(error);
        if (this.state.isInCooldown(fingerprint, this.config.cooldownSeconds)) {
          console.log(`Error ${fingerprint} is in cooldown, skipping`);
          continue;
        }

        // Track the error
        const tracked = this.state.trackError(fingerprint, {
          serviceName: error.serviceName,
          message: error.message,
          status: 'analyzing',
        });

        try {
          // 5. Analyze with Claude
          console.log(`Analyzing error: ${error.message.substring(0, 100)}...`);
          this.state.updateErrorStatus(fingerprint, 'analyzing');
          this.state.save();

          const analysis = await this.analyzer.analyze(error);
          result.errorsAnalyzed++;

          if (!analysis.canFix) {
            console.log(`Error cannot be auto-fixed: ${analysis.reason}`);
            this.state.updateErrorStatus(fingerprint, 'ignored');
            continue;
          }

          // 6. Apply fix
          console.log('Applying fix...');
          this.state.updateErrorStatus(fingerprint, 'fixing');
          this.state.save();

          if (this.config.dryRun) {
            console.log('[DRY RUN] Would apply fix:', JSON.stringify(analysis.suggestedFix, null, 2));
            result.fixesAttempted++;
            continue;
          }

          const fix = await this.fixer.applyFix(analysis.suggestedFix!, fingerprint);
          result.fixesAttempted++;

          if (!fix.success) {
            console.error('Failed to apply fix:', fix.error);
            this.state.updateErrorStatus(fingerprint, 'new'); // Retry next time
            continue;
          }

          // 7. Create PR
          console.log('Creating PR...');
          const pr = await this.prCreator.createPR({
            branchName: fix.branchName!,
            error,
            analysis,
            fix,
          });

          if (pr.success) {
            console.log(`PR created: ${pr.prUrl}`);
            result.prsCreated++;
            this.state.incrementPRCount();
            this.state.updateErrorStatus(fingerprint, 'pr_created', {
              prUrl: pr.prUrl,
              branchName: fix.branchName,
            });
          } else {
            console.error('Failed to create PR:', pr.error);
            this.state.updateErrorStatus(fingerprint, 'new');
          }

        } catch (err) {
          console.error(`Error processing ${fingerprint}:`, err);
          result.errors.push({
            fingerprint,
            error: err instanceof Error ? err.message : String(err),
          });
          // Reset to new so we can retry
          this.state.updateErrorStatus(fingerprint, 'new');
        }
      }

      // Update poll timestamp
      this.state.updateLastPoll();
      this.state.cleanup();
      this.state.save();

      console.log(`Run complete: ${result.errorsFound} found, ${result.errorsAnalyzed} analyzed, ${result.prsCreated} PRs created`);
      return result;

    } catch (err) {
      console.error('Agent run failed:', err);
      this.state.save();
      throw err;
    }
  }

  /**
   * Get or create a log watcher for a project.
   */
  private async getWatcher(projectId: string): Promise<LogWatcher | null> {
    // For now, only Railway is supported
    // In the future, detect provider from project bindings
    if (!this.watchers.has(projectId)) {
      const watcher = await RailwayLogWatcher.create();
      if (watcher) {
        this.watchers.set(projectId, watcher);
      }
    }
    return this.watchers.get(projectId) ?? null;
  }

  /**
   * Filter errors to only those we should process.
   */
  private filterNewErrors(errors: NormalizedError[]): NormalizedError[] {
    const seen = new Set<string>();
    const result: NormalizedError[] = [];

    for (const error of errors) {
      const fingerprint = createFingerprint(error);

      // Dedupe within this batch
      if (seen.has(fingerprint)) {
        continue;
      }
      seen.add(fingerprint);

      // Check if we've already created a PR for this
      const tracked = this.state.getError(fingerprint);
      if (tracked) {
        if (tracked.status === 'pr_created' || tracked.status === 'ignored' || tracked.status === 'resolved') {
          continue;
        }
        // If analyzing or fixing, skip (in progress)
        if (tracked.status === 'analyzing' || tracked.status === 'fixing') {
          continue;
        }
      }

      result.push(error);
    }

    return result;
  }
}

export interface RunResult {
  errorsFound: number;
  errorsAnalyzed: number;
  fixesAttempted: number;
  prsCreated: number;
  errors: Array<{ fingerprint: string; error: string }>;
}
