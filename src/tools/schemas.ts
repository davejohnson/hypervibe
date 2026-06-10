import { z } from 'zod';

/**
 * Shared zod fragments used across tool input schemas, so common fields
 * carry identical names and LLM-facing descriptions everywhere.
 */

export const projectField = z
  .string()
  .optional()
  .describe('Project name or id. Omit to auto-detect from the git remote of the working directory (or the only project).');

export const envField = z
  .string()
  .optional()
  .describe('Environment name (e.g. "staging", "production"). Defaults to "staging".');

export const confirmField = z
  .boolean()
  .optional()
  .describe('Set true to confirm a protected or destructive action. Without it the tool returns CONFIRM_REQUIRED.');
