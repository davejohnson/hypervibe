import type Database from 'better-sqlite3';
import { redactSensitiveString } from '../../utils/redact-sensitive-string.js';
import { nativeId, reviewRecord, type ReviewArtifact } from './local-review-files.js';

export function migrationResults(db: Database.Database, wanted?: string): ReviewArtifact[] {
  const rows = db.prepare(`SELECT r.id,r.plan,r.created_at,p.name FROM runs r JOIN projects p ON p.id=r.project_id
    WHERE r.type='migration-verification' AND json_valid(r.plan)`+(wanted ? ' AND r.id=?' : ''))
    .all(...(wanted ? [wanted] : [])) as {id:string; plan:string; created_at:string; name:string}[];
  const items: ReviewArtifact[] = [];
  const statuses: Record<string,string> = {verified:'Verified',differs:'Differences found',blocked:'Verification incomplete'};
  for (const row of rows) {
    const data = reviewRecord(JSON.parse(row.plan));
    if (!nativeId.test(row.id) || data.kind !== 'migration-verification' || typeof data.outcome !== 'string'
      || !Object.hasOwn(statuses,data.outcome) || typeof data.sourceEnvironment !== 'string' || typeof data.targetEnvironment !== 'string') continue;
    const details = ['Compared '+redactSensitiveString(data.sourceEnvironment)+' with '+redactSensitiveString(data.targetEnvironment)+'.'];
    for (const [key,label] of [['tables','Tables checked'],['checkedBuckets','Buckets checked'],['matchedBuckets','Buckets matched']]) {
      const count = data[key];
      if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) details.push(label+' · '+count);
    }
    if (typeof data.rows === 'string' && /^\d{1,24}$/.test(data.rows)) details.push('Rows checked · '+data.rows);
    if (typeof data.databaseMatched === 'boolean') details.push(data.databaseMatched ? 'The checked database contents matched.' : 'The checked database contents differed.');
    items.push({id:row.id,kind:'result',title:'Migration verification result',status:statuses[data.outcome],
      createdAt:row.created_at,project:redactSensitiveString(row.name),aliases:[],details});
  }
  return items;
}
