/**
 * QA FIXTURES — a fake Repl, a fake Cursor store, fake chat exports.
 *
 * `npm run fixtures` writes four files into fixtures/ (gitignored):
 *
 *   fake-repl.zip            → the Replit import (Projects ▸ Import from Replit)
 *   state.vscdb              → the Cursor import (`selvedge import cursor --db fixtures/state.vscdb`)
 *   fake-chatgpt-export.zip  → the history import (Admin ▸ Context ▸ Bring a history in)
 *   fake-claude-export.zip   → same door, Claude shape
 *
 * The point is to walk the real onboarding without touching a real account's
 * repos or history: fresh org, run this, drag the files in. Every fixture is
 * built to exercise the honest paths too, on purpose — the Repl zip carries
 * junk so "left behind by name" shows; the Cursor store carries one missing
 * message row so the unreadable count shows; re-running any import shows the
 * dedupe holding. None of the imports ever talk to the vendor, so a forged
 * artifact is a complete test of the real code path.
 *
 * These are self-declared fakes for testing our own product — every title and
 * message says QA FIXTURE, so nothing generated here could pass as a real
 * person's history.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';

const OUT = path.join(process.cwd(), 'fixtures');
const enc = (s: string) => new TextEncoder().encode(s);

mkdirSync(OUT, { recursive: true });
const written: string[] = [];
function write(name: string, bytes: Uint8Array | Buffer): void {
  writeFileSync(path.join(OUT, name), bytes);
  written.push(name);
}

// ---------------------------------------------------------------------------
// 1. The fake Repl: a real (tiny) static app under Replit's wrapper folder,
//    with planted workspace junk so the import's "left behind: node_modules,
//    .cache" naming shows up in the UI, not just in unit tests.
// ---------------------------------------------------------------------------
{
  const app = {
    'river-tracker/index.html': `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>River Tracker (QA fixture)</title><link rel="stylesheet" href="style.css"></head>
  <body>
    <h1>River Tracker</h1>
    <p>A QA fixture app imported from a fake Replit zip. If you can read this in a preview, the import worked end to end.</p>
    <script src="app.js"></script>
  </body>
</html>
`,
    'river-tracker/style.css': `body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 40rem; }
h1 { letter-spacing: -0.02em; }
`,
    'river-tracker/app.js': `document.querySelector('h1').title = 'QA fixture — imported from a fake Repl';
`,
    'river-tracker/package.json': `${JSON.stringify({ name: 'river-tracker', private: true, description: 'QA fixture' }, null, 2)}
`,
    'river-tracker/README.md': `# River Tracker

A QA fixture used to test the Import-from-Replit door. Safe to delete.
`,
    // The junk that makes the test honest: it must be LEFT BEHIND, by name.
    'river-tracker/node_modules/left-pad/index.js': `module.exports = (s, n) => String(s).padStart(n);
`,
    'river-tracker/node_modules/left-pad/package.json': `{"name":"left-pad"}
`,
    'river-tracker/.cache/replit/nix-env.txt': `not part of the app
`,
    'river-tracker/__pycache__/stale.pyc': 'not python either',
  };
  write('fake-repl.zip', Buffer.from(zipSync(Object.fromEntries(Object.entries(app).map(([k, v]) => [k, enc(v)])))));
}

// ---------------------------------------------------------------------------
// 2. The fake Cursor store: both layouts the reader handles — a bubble-row
//    composer, an inline-array composer, an abandoned empty composer (must be
//    silent), a composer with one message row missing (must be counted as
//    unreadable, not skipped quietly), and a legacy chat-panel tab.
// ---------------------------------------------------------------------------
async function makeCursorDb(): Promise<void> {
  const specifier = 'node:sqlite';
  let DatabaseSync: new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): unknown };
    close(): void;
  };
  try {
    ({ DatabaseSync } = (await import(specifier)) as unknown as { DatabaseSync: typeof DatabaseSync });
  } catch {
    console.error('skipping state.vscdb — writing it needs Node 22.5+ (node:sqlite)');
    return;
  }

  const dbPath = path.join(OUT, 'state.vscdb');
  writeFileSync(dbPath, ''); // start empty so re-runs rebuild rather than append
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    const put = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');

    // Modern layout: headers on the composer, one row per message.
    const composerA = 'qa-composer-aaaa1111';
    put.run(
      `composerData:${composerA}`,
      JSON.stringify({
        name: 'QA fixture — fix the login redirect',
        createdAt: 1755600000000,
        fullConversationHeadersOnly: [{ bubbleId: 'b1' }, { bubbleId: 'b2' }, { bubbleId: 'b3' }],
      }),
    );
    put.run(
      `bubbleId:${composerA}:b1`,
      JSON.stringify({ type: 1, text: 'QA fixture: after sign-in the app redirects to /undefined. Where is that coming from?', createdAt: 1755600060000 }),
    );
    put.run(
      `bubbleId:${composerA}:b2`,
      JSON.stringify({ type: 2, text: 'The redirect target is read from a query param that is never set on the sign-in link — falling back to `undefined`. Defaulting it to `/` fixes it.', createdAt: 1755600120000 }),
    );
    // b3 is deliberately MISSING from the store: the import must report one
    // unreadable entry, not quietly pretend the conversation is complete.

    // Older layout: the whole conversation inline on the composer row.
    put.run(
      `composerData:qa-composer-bbbb2222`,
      JSON.stringify({
        name: 'QA fixture — rename the project',
        createdAt: 1755690000000,
        conversation: [
          { type: 1, text: 'QA fixture: rename river-tracker to creek-tracker everywhere.', createdAt: 1755690060000 },
          { type: 2, text: 'Renamed in package.json, the README and the page title — three files.', createdAt: 1755690120000 },
        ],
      }),
    );

    // Opened and abandoned: no headers, no messages. Must import as nothing —
    // not a conversation, not an unreadable.
    put.run(`composerData:qa-composer-cccc3333`, JSON.stringify({ createdAt: 1755700000000 }));

    // The pre-composer chat panel.
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'workbench.panel.aichat.view.aichat.chatdata',
      JSON.stringify({
        tabs: [
          {
            tabId: 'qa-legacy-tab-1',
            chatTitle: 'QA fixture — legacy panel chat',
            lastSendTime: 1755000000000,
            bubbles: [
              { type: 'user', text: 'QA fixture: what does this repo do?' },
              { type: 'ai', text: 'It tracks rivers. It is also a QA fixture, so mostly it tracks whether imports work.' },
            ],
          },
        ],
      }),
    );
  } finally {
    db.close();
  }
  written.push('state.vscdb');
}

// ---------------------------------------------------------------------------
// 3. Fake history exports — ChatGPT's mapping shape and Claude's flat shape,
//    each zipped the way the vendor ships them.
// ---------------------------------------------------------------------------
{
  const chatgpt = [
    {
      conversation_id: 'qa-chatgpt-1',
      title: 'QA fixture — plan the river tracker',
      create_time: 1754000000,
      current_node: 'n2',
      mapping: {
        n0: { id: 'n0', parent: null, message: null },
        n1: {
          id: 'n1',
          parent: 'n0',
          message: {
            author: { role: 'user' },
            create_time: 1754000000,
            content: { content_type: 'text', parts: ['QA fixture: sketch a tiny app that tracks river levels.'] },
          },
        },
        n2: {
          id: 'n2',
          parent: 'n1',
          message: {
            author: { role: 'assistant' },
            create_time: 1754000060,
            content: { content_type: 'text', parts: ['One page, one chart, one fetch of the gauge feed. Start static, add the feed second.'] },
          },
        },
      },
    },
    {
      conversation_id: 'qa-chatgpt-2',
      title: 'QA fixture — name ideas',
      create_time: 1754100000,
      current_node: 'm2',
      mapping: {
        m1: {
          id: 'm1',
          parent: null,
          message: { author: { role: 'user' }, create_time: 1754100000, content: { content_type: 'text', parts: ['QA fixture: better name than river-tracker?'] } },
        },
        m2: {
          id: 'm2',
          parent: 'm1',
          message: { author: { role: 'assistant' }, create_time: 1754100060, content: { content_type: 'text', parts: ['creek-tracker, gauge, watershed. Keep river-tracker — it says what it does.'] } },
        },
      },
    },
  ];
  write('fake-chatgpt-export.zip', Buffer.from(zipSync({ 'conversations.json': enc(JSON.stringify(chatgpt)) })));

  const claude = [
    {
      uuid: 'qa-claude-1',
      name: 'QA fixture — gauge feed formats',
      created_at: '2026-08-02T10:00:00Z',
      chat_messages: [
        { uuid: 'c1', sender: 'human', created_at: '2026-08-02T10:00:00Z', text: 'QA fixture: what format do river gauge feeds usually come in?' },
        {
          uuid: 'c2',
          sender: 'assistant',
          created_at: '2026-08-02T10:01:00Z',
          content: [{ type: 'text', text: 'Mostly JSON time series from the public hydrology APIs; a few older stations still publish CSV.' }],
        },
      ],
    },
  ];
  write('fake-claude-export.zip', Buffer.from(zipSync({ 'conversations.json': enc(JSON.stringify(claude)) })));
}

await makeCursorDb();

console.log(`fixtures/ now holds: ${written.join(', ')}`);
console.log('');
console.log('The QA run, on a fresh org:');
console.log('  1. Projects ▸ Import from Replit → fixtures/fake-repl.zip (watch node_modules and .cache get named)');
console.log('  2. npm run companion -- import cursor --db fixtures/state.vscdb --dry-run   (then without --dry-run;');
console.log('     expect 3 conversations and 1 unreadable — the missing message row is planted)');
console.log('  3. Admin ▸ Context ▸ Bring a history in → fake-chatgpt-export.zip, then fake-claude-export.zip');
console.log('  4. Run any of them twice — the second pass must say "already had", never duplicate.');
