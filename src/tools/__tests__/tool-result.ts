import type { ToolEnvelope } from '../respond.js';

export function parseToolEnvelope(result: {
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
  content?: unknown;
}): ToolEnvelope {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as ToolEnvelope;
  }
  const metaEnvelope = result._meta?.hypervibeEnvelope;
  if (metaEnvelope && typeof metaEnvelope === 'object') {
    return metaEnvelope as ToolEnvelope;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const jsonEntry = content.find((entry) =>
    Boolean(entry)
    && typeof entry === 'object'
    && 'text' in entry
    && typeof (entry as { text?: unknown }).text === 'string'
    && (entry as { text: string }).text.trim().startsWith('{')
  ) as { text: string } | undefined;
  const jsonText = jsonEntry?.text;
  if (!jsonText) {
    throw new Error('Tool result did not include a structured Hypervibe envelope.');
  }
  return JSON.parse(jsonText) as ToolEnvelope;
}
