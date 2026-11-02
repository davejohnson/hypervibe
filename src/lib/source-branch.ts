import { z } from 'zod';

export const sourceBranchSchema = z.string().trim().min(1).max(255).refine(value => (
  !/[\uD800-\uDFFF]/u.test(value) && !['@', 'HEAD'].includes(value)
  && !value.startsWith('refs/') && !value.startsWith('-')
  && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..')
  && !value.includes('@{') && !value.endsWith('.')
  && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'))
), 'Use a plain branch name.');
