import { describe, it, expect } from 'vitest';
import { diagnoseStartFailure, previewFailureMessage } from '../../src/server/build/previewDiagnosis.js';
import { parseEnvText, toEnvFile } from '../../src/server/build/previewEnv.js';

/**
 * WHY THE APP DIDN'T START, IN A SENTENCE.
 *
 * The two properties worth holding are opposites, and both matter. It has to
 * recognise the failures that actually happen — and it has to say NOTHING when
 * it recognises nothing, because a confident wrong diagnosis is worse than an
 * honest "I couldn't tell" and this is exactly the kind of code that grows into
 * guessing if nobody holds the line.
 */
describe('reading a failed start', () => {
  /**
   * THE ONE THAT WAS ON SCREEN. Verbatim from the preview panel of an imported
   * project — a thousand characters of Node stack trace, whose entire content
   * was "it wants a database and there isn't one".
   */
  const theRealOne = `did not answer on :3000 rt: 5432 }]}> canvas-apparel-group@1.0.0 dev > NODE_ENV=development node server/index.js
AggregateError [ECONNREFUSED]: at /workspace/app/node_modules/pg-pool/index.js:45:11
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async migrate (file:///workspace/app/server/migrate.js:11:18)
    at async createServer (file:///workspace/app/server/index.js:31:3) {
  code: 'ECONNREFUSED', [errors]: [ Error: connect ECONNREFUSED ::1:5432
    at createConnectionError (node:net:1746:14) { errno: -111, code: 'ECONNREFUSED', syscall: 'connect', address: '::1', port: 5432 } ] }`;

  it('turns the screenful of stack trace into one sentence about a database', () => {
    const found = diagnoseStartFailure(theRealOne);
    expect(found.kind).toBe('database');
    expect(found.line).toContain('PostgreSQL database');

    const message = previewFailureMessage(theRealOne);
    // The whole point: none of the machinery reaches a person.
    for (const noise of ['processTicksAndRejections', 'pg-pool', 'ECONNREFUSED', 'node_modules', 'errno']) {
      expect(message).not.toContain(noise);
    }
    expect(message.length).toBeLessThan(300);
  });

  it('names the other services by what they are, not by their port number', () => {
    expect(diagnoseStartFailure('Error: connect ECONNREFUSED 127.0.0.1:3306').line).toContain('MySQL');
    expect(diagnoseStartFailure('connect ECONNREFUSED 127.0.0.1:6379').line).toContain('Redis');
    expect(diagnoseStartFailure('ECONNREFUSED ::1:27017 mongo').line).toContain('MongoDB');
  });

  /** A commit sha or a byte count that happens to contain 5432 is not a database. */
  it('does not read a port out of any number that looks like one', () => {
    expect(diagnoseStartFailure('built 5432 modules in 4s').kind).toBe('unknown');
    expect(diagnoseStartFailure('ECONNREFUSED at commit a5432bd').kind).not.toBe('database');
  });

  it('names the environment variable a program said it was missing', () => {
    expect(diagnoseStartFailure('Error: Missing required environment variable: STRIPE_SECRET_KEY').line).toContain('STRIPE_SECRET_KEY');
    expect(diagnoseStartFailure('SESSION_SECRET is not set').line).toContain('SESSION_SECRET');
    expect(diagnoseStartFailure('process.env.API_URL is not defined').line).toContain('API_URL');
  });

  it('recognises the ordinary start-up failures', () => {
    expect(diagnoseStartFailure('Error: listen EADDRINUSE: address already in use :::3000').kind).toBe('port_in_use');
    expect(diagnoseStartFailure('npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve').kind).toBe('install_failed');
    expect(diagnoseStartFailure("sh: 1: vite: command not found").kind).toBe('no_start');
    expect(diagnoseStartFailure('FATAL ERROR: Reached heap limit Allocation failed').kind).toBe('crashed');
    expect(diagnoseStartFailure('did not answer on :3000').kind).toBe('timeout');
  });

  /**
   * A database is worth naming over a generic crash, and a crash log usually
   * contains both.
   */
  it('picks the specific cause over the general one', () => {
    const both = 'ELIFECYCLE dev exited with 1\nError: connect ECONNREFUSED 127.0.0.1:5432';
    expect(diagnoseStartFailure(both).kind).toBe('database');
  });

  /**
   * THE LINE THIS FILE EXISTS TO HOLD. Nothing recognised means nothing
   * claimed — and the message says it could not tell, which is a real answer.
   */
  it('says nothing rather than guessing', () => {
    for (const nothing of ['', '   ', 'Compiled successfully in 812ms\nwatching for changes']) {
      expect(diagnoseStartFailure(nothing).kind).toBe('unknown');
      expect(diagnoseStartFailure(nothing).line).toBe('');
    }
    expect(previewFailureMessage('')).toMatch(/couldn’t tell|couldn't tell/);
  });

  it('never puts a stack trace in front of a person, whatever it was handed', () => {
    const traces = [
      theRealOne,
      'at Object.<anonymous> (/workspace/app/index.js:1:1)\n    at Module._compile (node:internal/modules/cjs/loader:1105:14)',
      'Error: something\n'.repeat(200),
    ];
    for (const trace of traces) {
      const message = previewFailureMessage(trace);
      expect(message).not.toContain('    at ');
      expect(message).not.toContain('node:internal');
      expect(message.length).toBeLessThan(400);
    }
  });
});

/**
 * THE PREVIEW'S ENVIRONMENT. People paste a `.env` file, which means the parser
 * meets every way one has ever been written.
 */
describe('the preview environment', () => {
  it('reads a .env the way a shell would', () => {
    const parsed = parseEnvText(`
      # the database
      DATABASE_URL=postgres://localhost/app
      export STRIPE_SECRET_KEY="sk_test_abc"
      QUOTED='a value with spaces'

      EMPTY=
    `);
    expect(parsed).toEqual([
      { key: 'DATABASE_URL', value: 'postgres://localhost/app' },
      { key: 'STRIPE_SECRET_KEY', value: 'sk_test_abc' },
      { key: 'QUOTED', value: 'a value with spaces' },
      { key: 'EMPTY', value: '' },
    ]);
  });

  it('drops what is not a variable rather than guessing at it', () => {
    expect(parseEnvText('just a sentence')).toEqual([]);
    expect(parseEnvText('=novalue')).toEqual([]);
    expect(parseEnvText('9LIVES=cat')).toEqual([]);
    expect(parseEnvText('has spaces=nope')).toEqual([]);
  });

  it('keeps the last value for a repeated key, in its first position', () => {
    expect(parseEnvText('A=1\nB=2\nA=3')).toEqual([
      { key: 'A', value: '3' },
      { key: 'B', value: '2' },
    ]);
  });

  /** A value with a quote in it must survive being written to a file a shell sources. */
  it('writes a file a shell can read back, quotes and all', () => {
    const nasty = [{ key: 'MSG', value: "it's a $VALUE `now`" }];
    const file = toEnvFile(nasty);
    expect(file).toContain("MSG='it'\\''s a $VALUE `now`'");
    // And no interpolation happened on the way out.
    expect(file).toContain('$VALUE');
  });
});
