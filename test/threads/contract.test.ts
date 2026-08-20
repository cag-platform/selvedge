import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * EVERY WRITER NAMES ITS THREAD.
 *
 * `agent_messages.thread_id` is deliberately nullable: a message that lands
 * without a thread is still readable, while a NOT NULL would let a background
 * writer (the post-ship watch, go-live's narration) throw away a line the owner
 * needed to see. The cost of that choice is that a forgetful writer fails
 * SILENTLY — the message is written, and simply never appears in the
 * conversation it belongs to.
 *
 * So the contract is enforced here instead, structurally, the way the tenancy
 * contract is: walk the source, find every insert into the two threaded tables,
 * and require that the values it writes name a thread. A new writer that
 * forgets is a failing build, not a message nobody can find.
 */
const SRC = path.resolve(process.cwd(), 'src/server');
const THREADED_TABLES = ['agentMessages', 'agentRuns'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** The text of the `.values(...)` call that follows an insert, paren-matched. */
function valuesCall(source: string, fromIndex: number): string | null {
  const start = source.indexOf('.values(', fromIndex);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + '.values'.length; i < source.length; i++) {
    const char = source[i];
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

describe('the thread contract', () => {
  it('finds the writers at all (a test that silently checks nothing is worse than none)', () => {
    const found = sourceFiles(SRC).filter((f) => THREADED_TABLES.some((t) => readFileSync(f, 'utf-8').includes(`insert(${t})`)));
    expect(found.length).toBeGreaterThanOrEqual(3);
  });

  it('every insert into a threaded table names the thread it belongs to', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf-8');
      for (const table of THREADED_TABLES) {
        const needle = `insert(${table})`;
        let at = source.indexOf(needle);
        while (at >= 0) {
          const values = valuesCall(source, at);
          const line = source.slice(0, at).split('\n').length;
          if (!values) {
            offenders.push(`  ${path.relative(process.cwd(), file)}:${line} — insert into ${table} with no .values() this test could read.`);
          } else if (!values.includes('threadId')) {
            offenders.push(
              `  ${path.relative(process.cwd(), file)}:${line} — writes ${table} without a threadId, so the row lands where nobody will find it.`,
            );
          }
          at = source.indexOf(needle, at + needle.length);
        }
      }
    }

    expect(offenders.join('\n'), `Messages written outside any conversation:\n${offenders.join('\n')}`).toBe('');
  });
});
