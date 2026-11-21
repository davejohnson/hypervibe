import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configurationDigest } from '../engine/opentofu/workspace.js';
import { OPENTOFU_VERSION } from '../engine/opentofu/versions.js';
import type { EngineConfiguration } from '../../domain/ports/infrastructure-engine.port.js';
import { reviewFile, reviewJson, reviewRecord } from './local-review-files.js';

/** Check the same persisted plan and configuration digests the engine will verify again at apply. */
export function matchingReviewEngineFiles(directory: string, planId: string, segment: Record<string,unknown>): boolean {
  if (segment.id !== 'opentofu:'+planId || segment.engine !== 'opentofu' || segment.engineVersion !== OPENTOFU_VERSION) return false;
  const config = reviewJson(path.join(directory,planId+'.config.json'));
  if (!config?.files || configurationDigest(config as unknown as EngineConfiguration) !== segment.configurationDigest) return false;
  const bytes = reviewFile(path.join(directory,planId+'.tfplan'));
  return !!bytes && createHash('sha256').update(bytes).digest('hex') === segment.planDigest;
}

export function matchingRunEngineFiles(root: string, projectId: string, plan: Record<string,unknown>): boolean {
  const engine = reviewRecord(plan.engine);
  const records = [engine,reviewRecord(engine.build),reviewRecord(engine.shared),reviewRecord(engine.imageRepository),
    reviewRecord(reviewRecord(plan.dns).descriptor)];
  const verified = new Map<string, string>();
  for (const action of Array.isArray(plan.actions) ? plan.actions : []) {
    const source = reviewRecord(reviewRecord(action).metadata).engineSegment;
    if (source === undefined || action.type === 'noop') continue;
    const segment = reviewRecord(source);
    if (typeof segment.id !== 'string' || typeof segment.planDigest !== 'string') return false;
    const descriptor = records.find(item => typeof item.planId === 'string' && segment.id === 'opentofu:'+item.planId);
    const state = reviewRecord(descriptor?.state);
    const planId = descriptor?.planId;
    const components = [state.provider, state.projectId, state.environmentId, state.partition, 'plans'];
    if (typeof planId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(planId) || state.projectId !== projectId
      || !['environment','project-shared'].includes(String(state.partition))
      || !components.every((part): part is string => typeof part === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(part))) return false;
    const signature = JSON.stringify([segment.planDigest,segment.configurationDigest,segment.engineVersion]);
    if (verified.has(segment.id)) {
      if (verified.get(segment.id) !== signature) return false;
      continue;
    }
    let directory = root;
    for (const component of ['engine',...components]) {
      directory = path.join(directory,component);
      if (!fs.lstatSync(directory,{throwIfNoEntry:false})?.isDirectory()) return false;
    }
    if (!matchingReviewEngineFiles(directory,planId,segment)) return false;
    verified.set(segment.id,signature);
  }
  return true;
}
