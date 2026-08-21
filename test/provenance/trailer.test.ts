import { describe, it, expect } from 'vitest';
import {
  SESSION_TRAILER_KEY,
  isStampableSessionId,
  parseSessionTrailer,
  sessionTrailer,
  stampedCommitMessage,
} from '../../src/server/provenance/trailer.js';

/**
 * The stamp is the join Phase 4 reads: break -> the change before it -> the
 * session that made the change -> one plain sentence. Everything here guards
 * the two ways that join can go wrong — a stamp that isn't written, and a stamp
 * that is read back as something other than what was written.
 */
describe('the commit stamp', () => {
  it('writes the trailer in its own paragraph, which is what makes it a trailer', () => {
    const message = stampedCommitMessage('Selvedge: dark header', '01J8Z5M9QK7T2R4N6P0V3W1XYZ');
    expect(message).toBe('Selvedge: dark header\n\nSelvedge-Session: 01J8Z5M9QK7T2R4N6P0V3W1XYZ');
    // The subject line survives untouched — people read it, tools parse it.
    expect(message.split('\n')[0]).toBe('Selvedge: dark header');
  });

  it('round-trips: what ship writes is what correlation reads', () => {
    const id = '01J8Z5M9QK7T2R4N6P0V3W1XYZ';
    expect(parseSessionTrailer(stampedCommitMessage('Selvedge: anything', id))).toBe(id);
  });

  it('a ship with no resolvable session still ships — unstamped, never blocked', () => {
    expect(stampedCommitMessage('Selvedge: dark header', null)).toBe('Selvedge: dark header');
    expect(stampedCommitMessage('Selvedge: dark header', undefined)).toBe('Selvedge: dark header');
  });

  it('refuses an id that has no business in a shell command or a permanent record', () => {
    expect(isStampableSessionId("01J8Z'; rm -rf /")).toBe(false);
    expect(isStampableSessionId('has space')).toBe(false);
    expect(isStampableSessionId('line\nbreak')).toBe(false);
    expect(isStampableSessionId('')).toBe(false);
    expect(sessionTrailer('bad id')).toBeNull();
    // ...and an unstampable id degrades to no stamp rather than a mangled one.
    expect(stampedCommitMessage('Selvedge: x', 'bad id')).toBe('Selvedge: x');
  });

  it('accepts the id shapes that actually occur: ulids and the derived legacy ids', () => {
    expect(isStampableSessionId('01J8Z5M9QK7T2R4N6P0V3W1XYZ')).toBe(true);
    expect(isStampableSessionId('thread_9f8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d')).toBe(true);
    // An external agent's session id, which the daemon will stamp with later.
    expect(isStampableSessionId('rollout-2026-08-19T10-22-04-abc123')).toBe(true);
  });

  it('an unstamped commit reads as unstamped, not as a guess', () => {
    expect(parseSessionTrailer('fix the header')).toBeNull();
    expect(parseSessionTrailer('')).toBeNull();
    expect(parseSessionTrailer('Selvedge-Session:')).toBeNull();
  });

  it('the last stamp wins, the way git reads a repeated trailer', () => {
    // A revert carries the original message forward and adds its own stamp; the
    // ship in hand must out-vote the ship it reverses.
    const message = ['Revert "Selvedge: dark header"', '', 'Selvedge-Session: OLD1', 'Selvedge-Session: NEW2'].join('\n');
    expect(parseSessionTrailer(message)).toBe('NEW2');
  });

  it('reads the key case-insensitively, since git does', () => {
    expect(parseSessionTrailer('subject\n\nselvedge-session: ABC')).toBe('ABC');
  });

  it('the key is a constant nobody may quietly rename', () => {
    // Renaming it silently orphans every commit stamped before the rename.
    expect(SESSION_TRAILER_KEY).toBe('Selvedge-Session');
  });
});
