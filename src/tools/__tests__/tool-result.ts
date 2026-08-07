import type { ToolEnvelope } from '../respond.js';

export function parseToolEnvelope(result: unknown): ToolEnvelope {
  const record = result && typeof result === 'object'
    ? result as { structuredContent?: unknown; content?: unknown }
    : {};
  if (record.structuredContent && typeof record.structuredContent === 'object') {
    return record.structuredContent as ToolEnvelope;
  }
  const content = Array.isArray(record.content) ? record.content : [];
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
