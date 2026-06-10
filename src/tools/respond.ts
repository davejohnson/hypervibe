/**
 * Single response envelope for all MCP tools.
 *
 * Every tool returns JSON with this shape so the calling agent can rely on
 * one contract: `ok` to branch on, `error.code` to classify failures,
 * `hint`/`next` to self-recover.
 */

export type ErrorCode =
  | 'NOT_FOUND'
  | 'AMBIGUOUS_PROJECT'
  | 'VALIDATION'
  | 'CONFIRM_REQUIRED'
  | 'MISSING_CONNECTION'
  | 'PROVIDER_ERROR'
  | 'UNSUPPORTED'
  | 'INTERNAL';

export interface ToolEnvelope {
  ok: boolean;
  data?: unknown;
  error?: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
  /** What the agent should do next to make progress. */
  hint?: string;
  warnings?: string[];
  /** Suggested follow-up tool calls, e.g. ["hv_plan"]. */
  next?: string[];
}

export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  [key: string]: unknown;
}

export interface ResponseExtras {
  hint?: string;
  warnings?: string[];
  next?: string[];
}

function envelope(payload: ToolEnvelope): ToolResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  };
}

export function toolSuccess(data?: unknown, extras?: ResponseExtras): ToolResponse {
  return envelope({
    ok: true,
    ...(data !== undefined ? { data } : {}),
    ...(extras?.hint ? { hint: extras.hint } : {}),
    ...(extras?.warnings?.length ? { warnings: extras.warnings } : {}),
    ...(extras?.next?.length ? { next: extras.next } : {}),
  });
}

export function toolError(
  code: ErrorCode,
  message: string,
  extras?: ResponseExtras & { details?: unknown }
): ToolResponse {
  return envelope({
    ok: false,
    error: {
      code,
      message,
      ...(extras?.details !== undefined ? { details: extras.details } : {}),
    },
    ...(extras?.hint ? { hint: extras.hint } : {}),
    ...(extras?.warnings?.length ? { warnings: extras.warnings } : {}),
    ...(extras?.next?.length ? { next: extras.next } : {}),
  });
}

/**
 * Typed error a handler can throw to short-circuit into a structured
 * toolError response (caught by wrapHandler).
 */
export class HvError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly extras?: ResponseExtras & { details?: unknown }
  ) {
    super(message);
    this.name = 'HvError';
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wrap a tool handler so thrown errors become structured envelopes instead
 * of MCP protocol errors. HvError keeps its code; anything else is INTERNAL.
 */
export function wrapHandler<Args>(
  fn: (args: Args) => Promise<ToolResponse> | ToolResponse
): (args: Args) => Promise<ToolResponse> {
  return async (args: Args) => {
    try {
      return await fn(args);
    } catch (error) {
      if (error instanceof HvError) {
        return toolError(error.code, error.message, error.extras);
      }
      return toolError('INTERNAL', describeError(error));
    }
  };
}
