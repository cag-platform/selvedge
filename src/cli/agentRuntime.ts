import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CompanionApi } from './api.js';

const runFile = promisify(execFile); const MAX_OUTPUT = 4 * 1024 * 1024;
type Job = { id: string; kind: 'chat_turn'; request: { version: 1; runId: string; threadId: string; repoFullName: string; branch: string; emptyRepo: boolean; agent: 'codex' | 'claude-code'; model: string; prompt: string } };
function valid(raw: { id: string; kind: string; request: Record<string, unknown> }): raw is Job { const r = raw.request; return raw.kind === 'chat_turn' && r.version === 1 && (r.agent === 'codex' || r.agent === 'claude-code') && typeof r.prompt === 'string'; }
async function walk(root: string, current = root): Promise<string[]> { const out: string[] = []; for (const e of await fs.readdir(current, { withFileTypes: true })) { if (['.git','node_modules','.build','dist'].includes(e.name)) continue; const a = path.join(current,e.name); if (e.isDirectory()) out.push(...await walk(root,a)); else if (e.isFile()) out.push(path.relative(root,a)); } return out; }
async function snap(root: string) { const out = new Map<string,string>(); for (const f of await walk(root)) out.set(f,createHash('sha256').update(await fs.readFile(path.join(root,f))).digest('hex')); return out; }
function run(command: string, args: string[], cwd: string, input: string) { return new Promise<{code:number;output:string}>((resolve,reject) => { const child=spawn(command,args,{cwd,stdio:['pipe','pipe','pipe'],env:process.env}); let output=''; const add=(b:Buffer)=>{output=(output+b.toString()).slice(-MAX_OUTPUT)}; child.stdout.on('data',add); child.stderr.on('data',add); child.on('error',reject); const timer=setTimeout(()=>child.kill('SIGTERM'),25*60_000); child.on('close',(code)=>{clearTimeout(timer);resolve({code:code??1,output})}); child.stdin.end(input); }); }
function narrative(output:string){return output.split('\n').map(x=>x.trim()).filter(Boolean).slice(-30).join('\n').slice(-12000)||'The coding agent finished.'}
export async function detectLocalAgents() { const exists=async(command:string,args:string[])=>runFile(command,args,{timeout:15000,maxBuffer:MAX_OUTPUT}).then(()=>true).catch(()=>false); return { codex: await exists('codex',['login','status']), claudeCode: await exists('claude',['auth','status']) }; }
export async function executeAgentJob(api: CompanionApi, raw:{id:string;kind:string;request:Record<string,unknown>}) {
  if(!valid(raw)){await api.finishAgentRuntimeJob(raw.id,{ok:false,detail:'Unsupported local agent job.'});return;}
  const root=path.join(homedir(),'.selvedge','agent-workspaces',raw.id), archive=`${root}.tgz`; await fs.rm(root,{recursive:true,force:true}); await fs.mkdir(root,{recursive:true,mode:0o700});
  try { const source=await api.downloadAgentRuntimeSource(raw.id); if(!source.ok)throw new Error(source.error); if(source.value.bytes.length){await fs.writeFile(archive,source.value.bytes,{mode:0o600});await runFile('tar',['-xzf',archive,'-C',root,...(source.value.layout==='github'?['--strip-components=1']:[])],{timeout:120000,maxBuffer:MAX_OUTPUT});}
    const before=await snap(root); const rules=['Work only in this private Selvedge workspace.','Make the requested change. Do not commit, push, deploy, publish, or access files outside this directory.','Finish with a short plain-English summary.','',raw.request.prompt].join('\n');
    const result=raw.request.agent==='claude-code'?await run('claude',['-p',rules,'--output-format','text','--permission-mode','acceptEdits','--model',raw.request.model],root,''):await run('codex',['exec','--json','--full-auto','--model',raw.request.model,'-'],root,rules);
    if(result.code!==0)throw new Error(`${raw.request.agent} stopped: ${narrative(result.output)}`); const after=await snap(root); const changed=[...new Set([...before.keys(),...after.keys()])].filter(f=>before.get(f)!==after.get(f)).sort();
    await fs.rm(archive,{force:true}); await runFile('tar',['-czf',archive,'--exclude=.git','--exclude=node_modules','--exclude=.build','-C',root,'.'],{timeout:180000,maxBuffer:MAX_OUTPUT}); const bytes=await fs.readFile(archive); if(bytes.length>25*1024*1024)throw new Error('Workspace exceeds the 25 MB return limit.'); const uploaded=await api.uploadAgentRuntimeArchive(raw.id,bytes); if(!uploaded.ok)throw new Error(uploaded.error); await api.finishAgentRuntimeJob(raw.id,{ok:true,narrative:narrative(result.output),changedPaths:changed});
  } catch(error){await api.finishAgentRuntimeJob(raw.id,{ok:false,detail:error instanceof Error?error.message:String(error)});} finally {await fs.rm(archive,{force:true}).catch(()=>undefined);}
}
