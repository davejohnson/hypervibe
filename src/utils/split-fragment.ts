/**
 * Split a reference like "1password://vault/item#field" or "/path/.env#KEY"
 * into the target and the optional #fragment.
 */
export function splitFragment(value: string): { target: string; fragment?: string } {
  const hashIndex = value.lastIndexOf('#');
  if (hashIndex === -1) {
    return { target: value };
  }
  return {
    target: value.slice(0, hashIndex),
    fragment: value.slice(hashIndex + 1),
  };
}
