import fs from 'fs';

/**
 * Parse a .env file and return key-value pairs.
 * Handles:
 * - KEY=value
 * - KEY="quoted value"
 * - KEY='single quoted value'
 * - Comments (lines starting with #)
 * - Empty lines
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  return parseEnvContent(content);
}

export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Find the first = sign
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Handle escape sequences in double-quoted strings
    if (trimmed.substring(eqIndex + 1).trim().startsWith('"')) {
      value = value.replace(/\\n/g, '\n');
      value = value.replace(/\\t/g, '\t');
      value = value.replace(/\\\\/g, '\\');
    }

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Extract specific keys from an env file.
 * Returns only the keys that match the provided key names.
 */
export function extractKeysFromEnvFile(
  filePath: string,
  keyNames: string[]
): Record<string, string> {
  const allVars = parseEnvFile(filePath);
  const result: Record<string, string> = {};

  for (const keyName of keyNames) {
    if (keyName in allVars) {
      result[keyName] = allVars[keyName];
    }
  }

  return result;
}

/**
 * Mask a secret key value for display.
 * Shows first few chars and last few chars, masks the middle.
 */
export function maskSecretValue(value: string, showStart = 7, showEnd = 4): string {
  if (value.length <= showStart + showEnd + 3) {
    return '*'.repeat(value.length);
  }
  return value.substring(0, showStart) + '...' + value.substring(value.length - showEnd);
}
