import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Watch configuration for a service.
 */
export interface Watch {
  projectId: string;
  environmentId: string;
  serviceName: string;
  enabled: boolean;
}

/**
 * Status of a tracked error.
 */
export type ErrorStatus =
  | 'new'           // Just detected
  | 'analyzing'     // Being analyzed by Claude
  | 'fixing'        // Fix is being prepared
  | 'pr_created'    // PR has been created
  | 'ignored'       // User marked as ignored
  | 'resolved';     // Error stopped occurring after fix

/**
 * Tracked error with deduplication and status info.
 */
export interface TrackedError {
  /** First time this error was seen */
  firstSeen: string;
  /** Last time this error was seen */
  lastSeen: string;
  /** Number of occurrences */
  occurrenceCount: number;
  /** Current status */
  status: ErrorStatus;
  /** GitHub PR URL if created */
  prUrl?: string;
  /** Branch name if created */
  branchName?: string;
  /** Service where the error occurred */
  serviceName: string;
  /** Error message (truncated for storage) */
  message: string;
}

/**
 * Persisted state for the auto-fix agent.
 * Stored as JSON in the repo for transparency.
 */
export interface AutoFixState {
  /** Active watches */
  watches: Watch[];
  /** Tracked errors by fingerprint */
  errors: Record<string, TrackedError>;
  /** Last successful poll timestamp */
  lastPollAt: string | null;
  /** PRs created in the current hour (for rate limiting) */
  prsCreatedThisHour: number;
  /** Hour when prsCreatedThisHour was last reset */
  lastPRCountResetHour: string | null;
}

/**
 * Create a fresh default state (avoids shared references).
 */
function createDefaultState(): AutoFixState {
  return {
    watches: [],
    errors: {},
    lastPollAt: null,
    prsCreatedThisHour: 0,
    lastPRCountResetHour: null,
  };
}

const STATE_FILE = 'autofix-state.json';

/**
 * Manages the persistent state for the auto-fix agent.
 */
export class StateManager {
  private state: AutoFixState;
  private readonly filePath: string;

  constructor(workingDirectory: string = process.cwd()) {
    this.filePath = join(workingDirectory, STATE_FILE);
    this.state = this.load();
  }

  /**
   * Load state from disk, or create default state.
   */
  private load(): AutoFixState {
    if (!existsSync(this.filePath)) {
      return createDefaultState();
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(content) as AutoFixState;
      // Merge with defaults to handle schema evolution
      return { ...createDefaultState(), ...parsed };
    } catch {
      console.error('Failed to load autofix state, using defaults');
      return createDefaultState();
    }
  }

  /**
   * Save current state to disk.
   */
  save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2) + '\n');
  }

  /**
   * Get all watches.
   */
  getWatches(): Watch[] {
    return this.state.watches;
  }

  /**
   * Get enabled watches only.
   */
  getEnabledWatches(): Watch[] {
    return this.state.watches.filter((w) => w.enabled);
  }

  /**
   * Add or update a watch.
   */
  addWatch(watch: Watch): void {
    const existing = this.state.watches.findIndex(
      (w) => w.projectId === watch.projectId &&
             w.environmentId === watch.environmentId &&
             w.serviceName === watch.serviceName
    );

    if (existing >= 0) {
      this.state.watches[existing] = watch;
    } else {
      this.state.watches.push(watch);
    }
  }

  /**
   * Remove a watch.
   */
  removeWatch(projectId: string, environmentId: string, serviceName: string): boolean {
    const initialLength = this.state.watches.length;
    this.state.watches = this.state.watches.filter(
      (w) => !(w.projectId === projectId &&
               w.environmentId === environmentId &&
               w.serviceName === serviceName)
    );
    return this.state.watches.length < initialLength;
  }

  /**
   * Get a tracked error by fingerprint.
   */
  getError(fingerprint: string): TrackedError | undefined {
    return this.state.errors[fingerprint];
  }

  /**
   * Get all tracked errors.
   */
  getAllErrors(): Record<string, TrackedError> {
    return this.state.errors;
  }

  /**
   * Track a new error or update an existing one.
   */
  trackError(fingerprint: string, update: Partial<TrackedError> & { serviceName: string; message: string }): TrackedError {
    const now = new Date().toISOString();
    const existing = this.state.errors[fingerprint];

    if (existing) {
      this.state.errors[fingerprint] = {
        ...existing,
        ...update,
        lastSeen: now,
        occurrenceCount: existing.occurrenceCount + 1,
      };
    } else {
      const { serviceName, message, ...rest } = update;
      this.state.errors[fingerprint] = {
        firstSeen: now,
        lastSeen: now,
        occurrenceCount: 1,
        status: 'new',
        serviceName,
        message: message.substring(0, 500),
        ...rest,
      };
    }

    return this.state.errors[fingerprint];
  }

  /**
   * Update error status.
   */
  updateErrorStatus(fingerprint: string, status: ErrorStatus, extra?: { prUrl?: string; branchName?: string }): void {
    const error = this.state.errors[fingerprint];
    if (error) {
      error.status = status;
      if (extra?.prUrl) error.prUrl = extra.prUrl;
      if (extra?.branchName) error.branchName = extra.branchName;
    }
  }

  /**
   * Update last poll timestamp.
   */
  updateLastPoll(): void {
    this.state.lastPollAt = new Date().toISOString();
  }

  /**
   * Get last poll timestamp.
   */
  getLastPollAt(): Date | null {
    return this.state.lastPollAt ? new Date(this.state.lastPollAt) : null;
  }

  /**
   * Check if we can create more PRs this hour.
   */
  canCreatePR(maxPRsPerHour: number): boolean {
    this.resetPRCountIfNewHour();
    return this.state.prsCreatedThisHour < maxPRsPerHour;
  }

  /**
   * Increment PR count for rate limiting.
   */
  incrementPRCount(): void {
    this.resetPRCountIfNewHour();
    this.state.prsCreatedThisHour++;
  }

  /**
   * Reset PR count if we're in a new hour.
   */
  private resetPRCountIfNewHour(): void {
    const currentHour = new Date().toISOString().substring(0, 13); // YYYY-MM-DDTHH
    if (this.state.lastPRCountResetHour !== currentHour) {
      this.state.prsCreatedThisHour = 0;
      this.state.lastPRCountResetHour = currentHour;
    }
  }

  /**
   * Check if an error is in cooldown (recently had a PR created).
   */
  isInCooldown(fingerprint: string, cooldownSeconds: number): boolean {
    const error = this.state.errors[fingerprint];
    if (!error || error.status !== 'pr_created') {
      return false;
    }

    const lastSeen = new Date(error.lastSeen);
    const cooldownEnd = new Date(lastSeen.getTime() + cooldownSeconds * 1000);
    return new Date() < cooldownEnd;
  }

  /**
   * Clean up old resolved/ignored errors (older than 7 days).
   */
  cleanup(): void {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    for (const [fingerprint, error] of Object.entries(this.state.errors)) {
      if (
        (error.status === 'resolved' || error.status === 'ignored') &&
        new Date(error.lastSeen) < cutoff
      ) {
        delete this.state.errors[fingerprint];
      }
    }
  }
}
