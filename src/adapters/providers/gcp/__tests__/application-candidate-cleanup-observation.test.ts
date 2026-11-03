import { describe, expect, it } from 'vitest';
import { observeApplicationCandidateCleanup } from '../application-candidate-build.js';
import type { OperatorCommand } from '../operator-image-build.js';

// Reconstructed CLI output from the 2026-11-03 owned-build readback. Docker's
// image-ls contract makes an empty successful exact reference list absence;
// --all plus the unique attempt label also covers an unfinished untagged load.
const id='cd33c71d-efef-41f6-8f99-01d20173dad6';
const record={status:'incomplete',builder:`hv-candidate-${id}`,tag:`hypervibe-application-candidate:${id}`,
  buildAttempted:true,succeeded:false,container:null};
const options={env:{DOCKER_CONFIG:'/tmp/hypervibe-candidate-AbCd01/docker'}};
const image='sha256:'+'a'.repeat(64)+'\n';
function fixture(change?: (args:string[])=>string|undefined) {
  const calls:string[][]=[];
  const command:OperatorCommand=async(program,args)=>{
    expect(program).toBe('docker');calls.push(args);
    expect(args[1]).toBe('ls');
    const changed=change?.(args);if(changed!==undefined)return changed;
    if(args[0]==='buildx')return 'default\ndesktop-linux\n';
    return '';
  };
  return {calls,command};
}
describe('read-only retained candidate cleanup observation',()=>{
  it('records current absence without rewriting historical failure or dispatching effects',async()=>{
    const before=JSON.stringify(record),f=fixture();
    expect(await observeApplicationCandidateCleanup(record,f.command,options)).toEqual({cleanup:'verified'});
    expect(JSON.stringify(record)).toBe(before);
    expect(f.calls).toContainEqual(['image','ls','--all','--no-trunc','--format','{{.ID}}',record.tag]);
    expect(f.calls).toContainEqual(['image','ls','--all','--no-trunc','--format','{{.ID}}','--filter',`label=dev.hypervibe.candidate-build=${id}`]);
  });
  it.each(['denied','timeout','malformed','ambiguous','tagged','untagged'] as const)('cannot clear %s image evidence',async state=>{
    const f=fixture(args=>{
      if(args[0]!=='image')return;
      if(state==='denied'||state==='timeout')throw new Error(state);
      if(state==='malformed')return 'not-image-metadata\n';
      if(state==='ambiguous')return image+image;
      if(state==='tagged'&&!args.includes('--filter'))return image;
      if(state==='untagged'&&args.includes('--filter'))return image;
    });
    expect(await observeApplicationCandidateCleanup(record,f.command,options)).toEqual({cleanup:'unverified'});
  });
  it.each(['builder','container','volume','scan-container'] as const)('cannot clear a retained %s',async kind=>{
    const value={...record,container:kind==='scan-container'?'b'.repeat(64):null};
    const f=fixture(args=>{
      if(kind==='builder'&&args[0]==='buildx')return `default\n${record.builder}\n`;
      if(kind==='container'&&args[0]==='container'||kind==='volume'&&args[0]==='volume')return 'retained\n';
      if(kind==='scan-container'&&args.some(arg=>arg.startsWith('id=')))return 'b'.repeat(64)+'\n';
    });
    expect(await observeApplicationCandidateCleanup(value,f.command,options)).toEqual({cleanup:'unverified'});
  });
  it('rejects mismatched or extra record fields and missing original Docker context before any read',async()=>{
    const f=fixture();
    for(const value of [{...record,tag:'unrelated:latest'},{...record,builder:'default'},{...record,extra:'private'}, {...record,succeeded:true,buildAttempted:false}])
      expect(await observeApplicationCandidateCleanup(value,f.command,options)).toEqual({cleanup:'unverified'});
    expect(await observeApplicationCandidateCleanup(record,f.command)).toEqual({cleanup:'unverified'});
    expect(f.calls).toEqual([]);
  });
  it('keeps a successfully scanned image intentionally retained while only checking its builder cleanup',async()=>{
    const f=fixture();
    expect(await observeApplicationCandidateCleanup({...record,succeeded:true},f.command,options)).toEqual({cleanup:'verified'});
    expect(f.calls.some(args=>args[0]==='image')).toBe(false);
  });
});
