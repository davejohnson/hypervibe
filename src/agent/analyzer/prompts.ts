/**
 * System prompt for error analysis.
 */
export const ANALYSIS_SYSTEM_PROMPT = `You are an expert software engineer analyzing production errors. Your task is to:

1. Understand the root cause of the error
2. Determine if it can be automatically fixed
3. If fixable, provide specific file edits to resolve it

## Analysis Guidelines

- Focus on the actual error, not symptoms
- Consider the full stack trace and context
- Look for common patterns (null references, missing imports, type errors)
- Be conservative - only suggest fixes you're confident about

## When to Mark as NOT Fixable

- The error requires configuration changes (env vars, secrets)
- The error is in a third-party library
- The fix requires architectural changes
- The error is intermittent/environmental (network, memory)
- You don't have enough context to be confident

## Response Format

You must respond with valid JSON matching this schema:

\`\`\`json
{
  "canFix": boolean,
  "reason": "string explaining why it can or cannot be fixed",
  "rootCause": "string explaining the root cause",
  "suggestedFix": {
    "description": "human-readable description of the fix",
    "files": [
      {
        "path": "relative file path",
        "changes": [
          {
            "type": "replace",
            "search": "exact text to find",
            "replace": "replacement text"
          }
        ]
      }
    ]
  },
  "confidence": "low" | "medium" | "high",
  "testSuggestion": "how to verify the fix works"
}
\`\`\`

If canFix is false, omit suggestedFix.`;

/**
 * User prompt template for error analysis.
 */
export function createAnalysisPrompt(params: {
  errorMessage: string;
  stackTrace?: string;
  serviceName: string;
  environmentName: string;
  relevantCode: Array<{ path: string; content: string }>;
}): string {
  let prompt = `## Production Error

**Service:** ${params.serviceName}
**Environment:** ${params.environmentName}

### Error Message
\`\`\`
${params.errorMessage}
\`\`\`
`;

  if (params.stackTrace) {
    prompt += `
### Stack Trace
\`\`\`
${params.stackTrace}
\`\`\`
`;
  }

  if (params.relevantCode.length > 0) {
    prompt += `
### Relevant Source Code

`;
    for (const file of params.relevantCode) {
      prompt += `**${file.path}:**
\`\`\`
${file.content}
\`\`\`

`;
    }
  }

  prompt += `
Analyze this error and determine if it can be automatically fixed. If so, provide the specific changes needed.`;

  return prompt;
}

/**
 * Schema for the analysis response.
 */
export interface AnalysisResponse {
  canFix: boolean;
  reason: string;
  rootCause: string;
  suggestedFix?: SuggestedFix;
  confidence: 'low' | 'medium' | 'high';
  testSuggestion?: string;
}

export interface SuggestedFix {
  description: string;
  files: FileChange[];
}

export interface FileChange {
  path: string;
  changes: Array<{
    type: 'replace' | 'insert' | 'delete';
    search?: string;
    replace?: string;
    after?: string;
    content?: string;
  }>;
}
