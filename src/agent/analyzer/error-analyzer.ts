import type { AutoFixConfig } from '../config.js';
import type { NormalizedError } from '../watchers/types.js';
import { ANALYSIS_SYSTEM_PROMPT, createAnalysisPrompt, type AnalysisResponse, type SuggestedFix } from './prompts.js';
import { extractCodeContext } from './code-context.js';

/**
 * Result of error analysis.
 */
export interface AnalysisResult {
  canFix: boolean;
  reason: string;
  rootCause: string;
  suggestedFix?: SuggestedFix;
  confidence: 'low' | 'medium' | 'high';
  testSuggestion?: string;
}

/**
 * Analyzes production errors using Claude API.
 */
export class ErrorAnalyzer {
  private readonly config: AutoFixConfig;

  constructor(config: AutoFixConfig) {
    this.config = config;
  }

  /**
   * Analyze an error and determine if it can be fixed.
   */
  async analyze(error: NormalizedError): Promise<AnalysisResult> {
    // Extract relevant source code
    const relevantCode = await extractCodeContext(
      this.config.workingDirectory,
      error.message,
      error.stackTrace
    );

    // Create the prompt
    const userPrompt = createAnalysisPrompt({
      errorMessage: error.message,
      stackTrace: error.stackTrace,
      serviceName: error.serviceName,
      environmentName: error.environmentName,
      relevantCode,
    });

    // Call Claude API
    const response = await this.callClaude(userPrompt);

    return response;
  }

  /**
   * Call the Claude API for error analysis.
   */
  private async callClaude(userPrompt: string): Promise<AnalysisResult> {
    // Dynamic import to avoid requiring @anthropic-ai/sdk at module load
    const Anthropic = await import('@anthropic-ai/sdk').then((m) => m.default);

    const client = new Anthropic({
      apiKey: this.config.anthropicApiKey,
    });

    const message = await client.messages.create({
      model: this.config.claudeModel,
      max_tokens: 4096,
      system: ANALYSIS_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userPrompt },
      ],
    });

    // Extract text content
    const textContent = message.content.find((block) => block.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    // Parse JSON response
    const responseText = textContent.text;

    // Try to extract JSON from the response
    const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) ||
                      responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('No JSON found in Claude response');
    }

    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const parsed = JSON.parse(jsonStr) as AnalysisResponse;

    // Validate response structure
    if (typeof parsed.canFix !== 'boolean') {
      throw new Error('Invalid response: missing canFix');
    }

    return {
      canFix: parsed.canFix,
      reason: parsed.reason || 'No reason provided',
      rootCause: parsed.rootCause || 'Unknown',
      suggestedFix: parsed.suggestedFix,
      confidence: parsed.confidence || 'low',
      testSuggestion: parsed.testSuggestion,
    };
  }
}
