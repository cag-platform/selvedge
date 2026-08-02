import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { stageUpload, getStagedUpload, consumeStagedUpload, discardStagedUpload, sweepStagedUploads } from '../../src/server/build/uploads.js';

/**
 * The staged-upload registry: the disk-backed half of "attach way more than
 * a JSON body can hold" (see routes/workshop.ts's /uploads endpoint and
 * build/agent.ts's localPath file-writing path). No HTTP or Daytona here —
 * just the registry's own scoping, consume-once, and cleanup behavior.
 */

async function tempFileWith(content: string): Promise<string> {
  const p = path.join(os.tmpdir(), `uploads-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.writeFile(p, content);
  return p;
}

describe('build/uploads — staged file registry', () => {
  const staged: string[] = [];
  afterEach(async () => {
    // Belt-and-braces: unlink anything a test didn't already clean up.
    await Promise.all(staged.splice(0).map((p) => fs.unlink(p).catch(() => undefined)));
  });

  it('stages a file, moving it under the registry-owned path, and returns it for its own org/project', async () => {
    const tmp = await tempFileWith('hello');
    const s = await stageUpload('org_1', 'loom', 'notes.txt', 'text/plain', tmp, 5);
    staged.push(s.path);

    expect(getStagedUpload('org_1', 'loom', s.id)).toMatchObject({ name: 'notes.txt', size: 5 });
    expect(await fs.readFile(s.path, 'utf8')).toBe('hello');
    // multer's original temp path was consumed by the rename — nothing left behind there.
    await expect(fs.access(tmp)).rejects.toThrow();
  });

  it('never resolves across org or project — the scoping is structural, not a filter someone can forget', async () => {
    const tmp = await tempFileWith('x');
    const s = await stageUpload('org_1', 'loom', 'x.txt', 'text/plain', tmp, 1);
    staged.push(s.path);

    expect(getStagedUpload('org_2', 'loom', s.id)).toBeNull();
    expect(getStagedUpload('org_1', 'patina', s.id)).toBeNull();
    expect(getStagedUpload('org_1', 'loom', s.id)).not.toBeNull();
  });

  it('consume removes it from the registry — a second reference to the same id misses', async () => {
    const tmp = await tempFileWith('x');
    const s = await stageUpload('org_1', 'loom', 'x.txt', 'text/plain', tmp, 1);
    staged.push(s.path);

    const first = consumeStagedUpload('org_1', 'loom', s.id);
    expect(first?.id).toBe(s.id);
    expect(consumeStagedUpload('org_1', 'loom', s.id)).toBeNull();
    expect(getStagedUpload('org_1', 'loom', s.id)).toBeNull();
    await fs.unlink(s.path).catch(() => undefined); // this test consumed it itself; agent.ts would have
  });

  it('discard deletes the bytes and drops the registry entry, for a validation failure before the turn fires', async () => {
    const tmp = await tempFileWith('x');
    const s = await stageUpload('org_1', 'loom', 'x.txt', 'text/plain', tmp, 1);
    await discardStagedUpload(s.id);
    expect(getStagedUpload('org_1', 'loom', s.id)).toBeNull();
    await expect(fs.access(s.path)).rejects.toThrow();
  });

  it('sweep deletes only uploads older than the abandon window, leaving fresh ones alone', async () => {
    const tmp = await tempFileWith('x');
    const s = await stageUpload('org_1', 'loom', 'x.txt', 'text/plain', tmp, 1);

    // "now" 31 minutes later sweeps it; the registry and the file both go.
    await sweepStagedUploads(Date.now() + 31 * 60 * 1000);
    expect(getStagedUpload('org_1', 'loom', s.id)).toBeNull();
    await expect(fs.access(s.path)).rejects.toThrow();

    const tmp2 = await tempFileWith('y');
    const s2 = await stageUpload('org_1', 'loom', 'y.txt', 'text/plain', tmp2, 1);
    staged.push(s2.path);
    await sweepStagedUploads(Date.now()); // no time has passed for this one
    expect(getStagedUpload('org_1', 'loom', s2.id)).not.toBeNull();
  });
});
