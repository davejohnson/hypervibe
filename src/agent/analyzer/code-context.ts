import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Extract relevant source code for an error.
 * Uses stack trace to find files and extract context.
 */
export async function extractCodeContext(
  workingDirectory: string,
  errorMessage: string,
  stackTrace?: string
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();

  // Extract file paths from stack trace
  const filePaths = extractFilePaths(stackTrace || errorMessage);

  for (const filePath of filePaths.slice(0, 5)) { // Limit to 5 files
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    const resolved = resolveFilePath(workingDirectory, filePath);
    if (!resolved) continue;

    try {
      const content = readFileSync(resolved.path, 'utf-8');
      // Limit file size
      const truncated = content.length > 10000
        ? content.substring(0, 10000) + '\n... (truncated)'
        : content;

      files.push({
        path: resolved.relative,
        content: truncated,
      });
    } catch {
      // Skip files we can't read
    }
  }

  return files;
}

/**
 * Extract file paths from a stack trace.
 */
function extractFilePaths(text: string): string[] {
  const paths: string[] = [];

  // Common stack trace patterns
  const patterns = [
    // Node.js: at functionName (/path/to/file.js:10:20) - absolute or relative paths
    /at\s+(?:\S+\s+)?\(?((?:\/|\.{1,2}\/)[^:)]+):\d+:\d+\)?/g,
    // Node.js: at /path/to/file.js:10:20
    /at\s+((?:\/|\.{1,2}\/)[^:]+):\d+:\d+/g,
    // TypeScript/JavaScript: at functionName (file.ts:10:20) or (dist/file.js:10:20)
    /at\s+(?:\S+\s+)?\(?([^:()\s]+\.[jt]sx?):\d+:\d+\)?/g,
    // Python: File "/path/to/file.py", line 10
    /File\s+"([^"]+)",\s+line\s+\d+/g,
    // Ruby: /path/to/file.rb:10:in
    /(\/[^:]+\.rb):\d+:in/g,
    // Go: /path/to/file.go:10
    /(\/[^:]+\.go):\d+/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const path = match[1];
      // Filter out node_modules and system paths
      if (!path.includes('node_modules') &&
          !path.includes('/usr/') &&
          !path.includes('internal/')) {
        paths.push(normalizeFilePath(path));
      }
    }
  }

  return [...new Set(paths)];
}

/**
 * Normalize a file path.
 */
function normalizeFilePath(path: string): string {
  // Remove leading ./
  let normalized = path.replace(/^\.\//, '');

  // Convert absolute paths to relative (if they're in the project)
  if (normalized.startsWith('/')) {
    // Try common src directories
    const srcMatch = normalized.match(/\/(src|lib|app|packages)\/.+/);
    if (srcMatch) {
      normalized = srcMatch[0].substring(1);
    }
  }

  return normalized;
}

interface ResolvedPath {
  path: string;      // Full absolute path
  relative: string;  // Relative path from working directory
}

/**
 * Resolve a file path relative to the working directory.
 * Returns the resolved path and its relative form.
 */
function resolveFilePath(workingDirectory: string, filePath: string): ResolvedPath | null {
  // Try as-is
  let fullPath = join(workingDirectory, filePath);
  if (existsSync(fullPath)) {
    return { path: fullPath, relative: filePath };
  }

  // Try common path transformations for TypeScript projects
  // These are applied in combination to handle dist/file.js -> src/file.ts
  const dirAliases = [
    { from: /^dist\//, to: 'src/' },
    { from: /^build\//, to: 'src/' },
  ];

  const extAliases = [
    { from: /\.js$/, to: '.ts' },
    { from: /\.js$/, to: '.tsx' },
  ];

  // Try directory aliases alone
  for (const alias of dirAliases) {
    const aliasedPath = filePath.replace(alias.from, alias.to);
    fullPath = join(workingDirectory, aliasedPath);
    if (existsSync(fullPath)) {
      return { path: fullPath, relative: aliasedPath };
    }
  }

  // Try extension aliases alone
  for (const alias of extAliases) {
    const aliasedPath = filePath.replace(alias.from, alias.to);
    fullPath = join(workingDirectory, aliasedPath);
    if (existsSync(fullPath)) {
      return { path: fullPath, relative: aliasedPath };
    }
  }

  // Try combinations (dist/file.js -> src/file.ts)
  for (const dirAlias of dirAliases) {
    for (const extAlias of extAliases) {
      const aliasedPath = filePath.replace(dirAlias.from, dirAlias.to).replace(extAlias.from, extAlias.to);
      fullPath = join(workingDirectory, aliasedPath);
      if (existsSync(fullPath)) {
        return { path: fullPath, relative: aliasedPath };
      }
    }
  }

  return null;
}

/**
 * Find related files (tests, types, etc.) for a given source file.
 */
export function findRelatedFiles(
  workingDirectory: string,
  filePath: string
): string[] {
  const related: string[] = [];
  const dir = dirname(filePath);
  const baseName = filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || '';

  // Look for test files
  const testPatterns = [
    join(dir, `${baseName}.test.ts`),
    join(dir, `${baseName}.spec.ts`),
    join(dir, '__tests__', `${baseName}.test.ts`),
    join('test', filePath.replace(/^src\//, '').replace(/\.ts$/, '.test.ts')),
  ];

  for (const pattern of testPatterns) {
    const fullPath = join(workingDirectory, pattern);
    if (existsSync(fullPath)) {
      related.push(pattern);
    }
  }

  // Look for type definitions
  const typePatterns = [
    join(dir, `${baseName}.types.ts`),
    join(dir, 'types.ts'),
    join(dir, 'index.d.ts'),
  ];

  for (const pattern of typePatterns) {
    const fullPath = join(workingDirectory, pattern);
    if (existsSync(fullPath)) {
      related.push(pattern);
    }
  }

  return related;
}
