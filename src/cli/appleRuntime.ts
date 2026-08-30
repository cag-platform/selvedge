import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CompanionApi } from './api.js';

const runFile = promisify(execFile);
const MAX_OUTPUT = 4 * 1024 * 1024;

type ChatJob = {
  id: string;
  kind: 'chat_turn';
  request: {
    version: 1; runId: string; threadId: string; repoFullName: string; branch: string; emptyRepo: boolean;
    agent: 'codex' | 'claude-code'; model: string; prompt: string;
  };
};

function isChatJob(value: { id: string; kind: string; request: Record<string, unknown> }): value is ChatJob {
  const request = value.request;
  return value.kind === 'chat_turn' && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value.id)
    && request.version === 1 && typeof request.runId === 'string' && typeof request.threadId === 'string'
    && typeof request.repoFullName === 'string' && typeof request.branch === 'string'
    && typeof request.emptyRepo === 'boolean' && (request.agent === 'codex' || request.agent === 'claude-code')
    && typeof request.model === 'string' && typeof request.prompt === 'string';
}

async function files(root: string, current = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'DerivedData', '.build'].includes(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) found.push(...await files(root, absolute));
    else if (entry.isFile()) found.push(path.relative(root, absolute));
  }
  return found;
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const relative of await files(root)) {
    const bytes = await fs.readFile(path.join(root, relative));
    result.set(relative, createHash('sha256').update(bytes).digest('hex'));
  }
  return result;
}

async function capture(command: string, args: string[], cwd: string, input: string, timeoutMs: number) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let output = '';
    const append = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output }); });
    child.stdin.end(input);
  });
}

async function firstSimulator(): Promise<string> {
  const raw = (await runFile('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { timeout: 20_000, maxBuffer: MAX_OUTPUT })).stdout;
  const data = JSON.parse(raw) as { devices?: Record<string, Array<{ name?: string; isAvailable?: boolean }>> };
  const device = Object.values(data.devices ?? {}).flat().find((item) => item.isAvailable !== false && /iPhone/i.test(item.name ?? ''));
  if (!device?.name) throw new Error('no available iPhone Simulator');
  return device.name;
}

async function xcodeTarget(root: string): Promise<{ flag: '-workspace' | '-project'; relative: string; scheme: string }> {
  // `files` lists the contents of Xcode bundles, so recover each bundle path
  // from entries such as App.xcodeproj/project.pbxproj.
  const bundles = [...new Set((await files(root)).map((name) => {
    const match = /^(.*?\.(?:xcworkspace|xcodeproj))(?:\/|$)/.exec(name);
    return match?.[1];
  }).filter((name): name is string => Boolean(name)))];
  const relative = bundles.find((name) => name.endsWith('.xcworkspace')) ?? bundles.find((name) => name.endsWith('.xcodeproj'));
  if (!relative) throw new Error('the agent did not leave an Xcode project or workspace to build');
  const flag = relative.endsWith('.xcworkspace') ? '-workspace' : '-project';
  const listed = (await runFile('xcodebuild', ['-list', '-json', flag, relative], { cwd: root, timeout: 60_000, maxBuffer: MAX_OUTPUT })).stdout;
  const parsed = JSON.parse(listed) as { project?: { schemes?: string[] }; workspace?: { schemes?: string[] } };
  const scheme = parsed.workspace?.schemes?.[0] ?? parsed.project?.schemes?.[0];
  if (!scheme) throw new Error('Xcode found no shared scheme to build');
  return { flag, relative, scheme };
}

function ownerNarrative(output: string): string {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.slice(-30).join('\n').slice(-12_000) || 'The coding agent finished the Apple turn.';
}

export async function executeAppleChatJob(api: CompanionApi, rawJob: { id: string; kind: string; request: Record<string, unknown> }): Promise<void> {
  if (!isChatJob(rawJob)) {
    await api.finishAppleRuntimeJob(rawJob.id, { ok: false, detail: 'The Apple chat job was malformed or unsupported.' });
    return;
  }
  const job = rawJob;
  const root = path.join(homedir(), '.selvedge', 'apple-workspaces', job.id);
  const archivePath = path.join(homedir(), '.selvedge', 'apple-workspaces', `${job.id}.tgz`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const source = await api.downloadAppleRuntimeSource(job.id);
    if (!source.ok) throw new Error(source.error);
    if (source.value.bytes.byteLength) {
      await fs.writeFile(archivePath, source.value.bytes, { mode: 0o600 });
      const args = ['-xzf', archivePath, '-C', root, ...(source.value.layout === 'github' ? ['--strip-components=1'] : [])];
      await runFile('tar', args, { timeout: 120_000, maxBuffer: MAX_OUTPUT });
    }
    const before = await snapshot(root);
    const rules = [
      'You are working in a private Selvedge Apple workspace on the owner’s Mac.',
      'Make the requested change in this directory. Do not commit, push, publish, deploy, or change signing credentials.',
      'Use SwiftUI/Xcode tools as needed. Leave the project buildable with a shared scheme.',
      'The owner does not use a terminal; finish with a short plain-English account of what you built and checked.',
      '', job.request.prompt,
    ].join('\n');
    const agentRun = job.request.agent === 'claude-code'
      ? await capture('claude', ['-p', rules, '--output-format', 'text', '--dangerously-skip-permissions', '--model', job.request.model], root, '', 25 * 60_000)
      : await capture('codex', ['exec', '--json', '--model', job.request.model, '--dangerously-bypass-approvals-and-sandbox', '-'], root, rules, 25 * 60_000);
    if (agentRun.code !== 0) throw new Error(`${job.request.agent} stopped without finishing: ${ownerNarrative(agentRun.output)}`);

    const simulatorName = await firstSimulator();
    const target = await xcodeTarget(root);
    const derived = path.join(root, '.selvedge-derived-data');
    const built = await runFile('xcodebuild', [target.flag, target.relative, '-scheme', target.scheme, '-destination', `platform=iOS Simulator,name=${simulatorName}`, '-derivedDataPath', derived, 'CODE_SIGNING_ALLOWED=NO', 'build'], {
      cwd: root, timeout: 12 * 60_000, maxBuffer: MAX_OUTPUT,
    }).then((value) => ({ ok: true, output: `${value.stdout}\n${value.stderr}` })).catch((error: unknown) => ({ ok: false, output: error instanceof Error ? error.message : String(error) }));

    const after = await snapshot(root);
    const changedPaths = [...new Set([...before.keys(), ...after.keys()])].filter((name) => before.get(name) !== after.get(name)).sort();
    await fs.rm(derived, { recursive: true, force: true });
    await fs.rm(archivePath, { force: true });
    await runFile('tar', ['-czf', archivePath, '--exclude=.git', '--exclude=node_modules', '--exclude=.build', '--exclude=.selvedge-derived-data', '-C', root, '.'], { timeout: 180_000, maxBuffer: MAX_OUTPUT });
    const archive = await fs.readFile(archivePath);
    if (archive.byteLength > 25 * 1024 * 1024) throw new Error('the Apple workspace is larger than the 25 MB recovery limit');
    const uploaded = await api.uploadAppleRuntimeArchive(job.id, archive);
    if (!uploaded.ok) throw new Error(uploaded.error);
    await api.finishAppleRuntimeJob(job.id, {
      ok: built.ok, narrative: ownerNarrative(agentRun.output), changedPaths, simulatorName,
      buildOutput: built.output.slice(-12_000), detail: built.ok ? 'Xcode Simulator build passed.' : `Xcode build failed: ${built.output.slice(-1_500)}`,
    });
  } catch (error) {
    await api.finishAppleRuntimeJob(job.id, { ok: false, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
  }
}
