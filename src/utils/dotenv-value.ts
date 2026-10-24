import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseEnvContent } from './env-parser.js';
import { splitFragment } from './split-fragment.js';

const MAX_REFERENCE_DEPTH = 16;
const validKey = (key: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);

/** Read values without following a symlink or reading a device, directory, or pipe. */
export function readDotenvValues(filePath: string): Record<string, string> {
  let descriptor: number | undefined;
  try {
    if (!lstatSync(filePath).isFile()) throw new Error('Not a regular file');
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(descriptor).isFile()) throw new Error('Not a regular file');
    return parseEnvContent(readFileSync(descriptor, 'utf8'));
  } catch {
    // A referenced path is itself an input value. Do not echo it or OS errors.
    throw new Error('Dotenv file is missing, unreadable, or not a regular file.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Resolve only whole-value dotenv references, relative to their containing file. */
export function resolveDotenvValue(
  filePath: string,
  key: string,
  options: {
    values?: Record<string, string>;
    validateSourceKey?: (key: string) => void;
  } = {}
): string {
  const visited = new Set<string>();
  let selectedPath = path.resolve(filePath);
  let selectedKey = key;
  let values = options.values;
  for (let depth = 0; depth <= MAX_REFERENCE_DEPTH; depth++) {
    if (!validKey(selectedKey)) throw new Error('Dotenv reference requires a valid environment variable name.');
    options.validateSourceKey?.(selectedKey);
    const current = values ?? readDotenvValues(selectedPath);
    values = undefined;
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(selectedPath);
    } catch {
      throw new Error('Dotenv file is missing or unreadable.');
    }
    const identity = `${canonicalPath}#${selectedKey}`;
    if (visited.has(identity)) throw new Error('Dotenv reference cycle detected.');
    visited.add(identity);
    if (!Object.prototype.hasOwnProperty.call(current, selectedKey)) {
      throw new Error('Referenced dotenv variable was not found.');
    }
    const value = current[selectedKey];
    if (value.trim() === '') throw new Error('Referenced dotenv variable is empty.');
    if (!value.startsWith('dotenv:')) return value;
    const { target, fragment } = splitFragment(value.slice('dotenv:'.length));
    if (!target.trim() || !fragment || !validKey(fragment) || /[\r\n\0]/.test(target)) {
      throw new Error('Invalid dotenv reference; use dotenv:./.env#KEY.');
    }
    selectedPath = path.resolve(path.dirname(selectedPath), target);
    selectedKey = fragment;
  }
  throw new Error('Dotenv reference depth exceeds the supported limit.');
}
