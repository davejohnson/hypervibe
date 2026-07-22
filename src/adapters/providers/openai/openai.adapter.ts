import { z } from 'zod';
import { createHash } from 'crypto';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';

const OPENAI_API_URL = 'https://api.openai.com/v1';
export const HYPERVIBE_CODE_MODEL = 'gpt-5.6-sol';

export const OpenAICredentialsSchema = z.object({
  apiKey: z.string().min(1, 'OpenAI API key is required'),
}).strict();

export type OpenAICredentials = z.infer<typeof OpenAICredentialsSchema>;

/** Credential boundary for OpenAI-backed GitHub Actions. */
export class OpenAIAdapter {
  readonly name = 'openai';
  private credentials: OpenAICredentials | null = null;

  connect(credentials: unknown): void {
    this.credentials = OpenAICredentialsSchema.parse(credentials);
  }

  async verify(): Promise<{ success: boolean; error?: string; model?: string; warning?: string }> {
    try {
      if (!this.credentials) throw new Error('Not connected. Call connect() first.');
      const response = await fetch(`${OPENAI_API_URL}/models/${HYPERVIBE_CODE_MODEL}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.credentials.apiKey}` },
      });
      if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;
        try {
          const body = await response.json() as { error?: { message?: string } };
          detail = body.error?.message ?? detail;
        } catch {
          // Preserve the status when the provider does not return JSON.
        }
        return { success: false, error: `OpenAI API key verification failed: ${detail}` };
      }
      const model = await response.json() as { id?: string };
      if (model.id !== HYPERVIBE_CODE_MODEL) {
        return { success: false, error: `OpenAI returned an unexpected model while verifying ${HYPERVIBE_CODE_MODEL}.` };
      }
      return {
        success: true,
        model: model.id,
        warning: 'Model visibility is verified. The key must also allow Responses API writes when Codex Action runs.',
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Secret material stays inside the provider/apply boundary. */
  actionsApiKey(): string {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    return this.credentials.apiKey;
  }

  actionsApiKeyHash(): string {
    return createHash('sha256').update(this.actionsApiKey(), 'utf8').digest('hex');
  }
}

providerRegistry.register({
  metadata: {
    name: 'openai',
    displayName: 'OpenAI API',
    category: 'ai',
    credentialsSchema: OpenAICredentialsSchema,
    setupHelpUrl: 'https://platform.openai.com/api-keys',
    credentials: { defaultScalarKey: 'apiKey' },
    orchestration: { connections: { missingConnectionPolicy: 'action-scoped-if-independent-actions' } },
  },
  factory: (credentials) => {
    const adapter = new OpenAIAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
