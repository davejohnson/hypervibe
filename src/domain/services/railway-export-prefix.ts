/** Shared by the permission review and the Railway dump writer. Keep the environment in one object-name segment. */
export function railwayExportPrefix(environmentName: string): string {
  // Preserve user-facing names verbatim, including spaces and Unicode. The same string
  // must identify one segment in the signed URL and a literal in OpenTofu configuration.
  const unsafe = /[\/\\\p{Cc}]|%[0-9a-f]{2}|[$%]\{/iu;
  if (!environmentName.trim() || unsafe.test(environmentName) || environmentName === '.' || environmentName === '..') {
    throw new Error('The destination environment name must be a single safe path segment for a Railway database export.');
  }
  return `migrations/${environmentName}/`;
}
