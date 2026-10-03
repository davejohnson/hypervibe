/** A hard prerequisite is not repaired by supplying provider credentials. */
export interface PlanBlock {
  /** New non-connection blockers must declare prerequisite explicitly.
   * Omission preserves the historical connection-only producer contract. */
  category?: 'connection' | 'prerequisite';
  provider: string;
  reason?: string;
  scope?: string;
  policy?: 'hard' | 'action-scoped-if-independent-actions';
  actionIds?: string[];
  requiredCredentialKeys?: string[];
}

export function classifyPlanBlocks(blocks: PlanBlock[]) {
  return {
    prerequisites: blocks.filter(block => block.category === 'prerequisite'),
    connections: blocks.filter(block => block.category !== 'prerequisite'),
  };
}
