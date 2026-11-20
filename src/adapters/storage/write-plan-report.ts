import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PlanReport } from '../../domain/plan/plan-report.js';
import { renderPlanReportHtml } from '../../presentation/plan-report-html.js';
import { ensurePrivateDirectory, hardenPrivateFile, PRIVATE_FILE_MODE } from './paths.js';

export function planReportPath(directory: string, planId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(planId)) throw new Error('Invalid saved plan ID.');
  return path.resolve(directory, `${planId}.html`);
}

export function writePlanReport(directory: string, report: PlanReport): { htmlPath: string } {
  const htmlPath = planReportPath(directory, report.planId);
  const html = renderPlanReportHtml(report);
  ensurePrivateDirectory(directory);
  hardenPrivateFile(htmlPath);
  const temporary = `${htmlPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, html, { flag: 'wx', mode: PRIVATE_FILE_MODE });
    fs.renameSync(temporary, htmlPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { htmlPath };
}
