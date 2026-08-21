#!/usr/bin/env node
import { CompanionApi } from './api.js';
import { loadConfig, saveConfig, CONFIG_PATH, DEFAULT_API } from './config.js';
import { dryRun, watchOnce } from './watch.js';
import { runContextServer } from './mcp.js';
import { findSessionFiles, looksFinished } from './sessions/discover.js';

/**
 * `selvedge` — the companion. Two jobs, one binary:
 *
 *   selvedge watch      reads the coding sessions on this machine and sends
 *                       Selvedge a SUMMARY of each finished one
 *   selvedge context    serves this account's project context to any agent
 *                       that mounts it as an MCP server
 *
 * Plus the small things that make those usable: login, status, and a dry run
 * that prints exactly what would be sent so the privacy claim can be checked
 * rather than believed.
 *
 * Nothing here talks to anything except the Selvedge origin in the config.
 */

const HELP = `selvedge — the local companion for Selvedge

  selvedge login --token slv_… [--api URL]   save this machine's key
  selvedge status                            what it can see, and whether the key works
  selvedge watch [--once] [--interval 60]    report finished coding sessions
  selvedge watch --dry-run                   print what WOULD be sent, send nothing
  selvedge context                           run the MCP server (stdio) for agents

What leaves this machine: for each finished session, its tool and id, when it
ran, the directory and repo, the first thing you asked for (bounded), the file
paths it touched, the tool names it ran and how often, how it ended, the commit
that landed while it was open, and what the tool said it cost.

What never leaves: the conversation, the code, the diffs. \`--dry-run\` prints
the payloads so you can check that for yourself.`;

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

async function main(): Promise<number> {
  const [command = 'help', ...argv] = process.argv.slice(2);
  const config = loadConfig();

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }

  if (command === 'login') {
    const token = flag(argv, 'token');
    if (!token) {
      console.error('Give me the key: selvedge login --token slv_…  (make one in Selvedge under Connections)');
      return 1;
    }
    const api = flag(argv, 'api') ?? config.api ?? DEFAULT_API;
    const check = await new CompanionApi({ api, token }).hello();
    if (!check.ok) {
      console.error(`That key didn't work against ${api}: ${check.error}`);
      return 1;
    }
    saveConfig({ api, token });
    console.log(`Saved to ${CONFIG_PATH}. This key can see ${check.value.projects.length} project(s).`);
    return 0;
  }

  if (command === 'status') {
    const api = new CompanionApi(config);
    const files = findSessionFiles();
    const finished = files.filter((f) => looksFinished(f)).length;
    console.log(`Selvedge: ${config.api}`);
    console.log(`Key: ${config.token ? 'saved' : 'none — run `selvedge login --token slv_…`'}`);
    console.log(`Session logs found on this machine: ${files.length} (${finished} finished)`);
    if (!config.token) return 1;
    const hello = await api.hello();
    if (!hello.ok) {
      console.error(`The key did not work: ${hello.error}`);
      return 1;
    }
    console.log(`Projects it can see: ${hello.value.projects.map((p) => p.id).join(', ') || 'none yet'}`);
    return 0;
  }

  if (command === 'watch') {
    const api = new CompanionApi(config);
    if (has(argv, 'dry-run')) {
      const summaries = await dryRun({ api });
      console.log(JSON.stringify(summaries, null, 2));
      console.log(`\n${summaries.length} finished session(s). Nothing was sent.`);
      return 0;
    }
    if (!config.token) {
      console.error('No key yet — run `selvedge login --token slv_…` first.');
      return 1;
    }
    const log = (line: string) => console.log(line);
    const once = has(argv, 'once');
    const interval = Math.max(15, Number(flag(argv, 'interval') ?? 60)) * 1000;

    const pass = async () => {
      const result = await watchOnce({ api, log });
      log(
        `looked at ${result.considered} log(s): sent ${result.sent}` +
          `${result.unreadable ? `, ${result.unreadable} unreadable (reported)` : ''}` +
          `${result.failed ? `, ${result.failed} failed` : ''}`,
      );
    };

    await pass();
    if (once) return 0;
    log(`watching — every ${interval / 1000}s. Ctrl-C to stop.`);
    // A plain interval rather than a file watcher: sessions end by going quiet,
    // so there is no event to wait for, and a poll every minute costs nothing.
    setInterval(() => void pass().catch((err) => console.error(err)), interval);
    return new Promise<number>(() => undefined); // runs until interrupted
  }

  if (command === 'context') {
    if (!config.token) {
      // stdout belongs to the protocol on this path — never print to it.
      console.error('No key yet — run `selvedge login --token slv_…` first.');
      return 1;
    }
    await runContextServer(new CompanionApi(config));
    return new Promise<number>(() => undefined); // the transport owns the process now
  }

  console.error(`I don't know the command "${command}".\n\n${HELP}`);
  return 1;
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
