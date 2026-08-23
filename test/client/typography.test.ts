import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'glob';

/**
 * THE DIFFERENCE BETWEEN FRAUNCES SET WELL AND FRAUNCES SET CARELESSLY.
 *
 * Nobody reads a page and thinks "that apostrophe is straight". They think the
 * product feels a bit cheap and cannot say why, which is worse, because there
 * is nothing for them to tell you.
 *
 * WHAT IS CHECKED, AND WHY IT IS THIS AND NOT MORE. The rule is applied to JSX
 * TEXT NODES — the words between one tag and the next, which is what a person
 * actually reads. Not string literals in general: half of those are CSS class
 * names, API paths, and shell commands, where a straight quote is correct and
 * a curly one is a bug.
 *
 * The apostrophe test is the letter-quote-letter case (`don't`, `it's`,
 * `project's`). That pattern cannot occur in a CSS custom property, a shell
 * flag, or a path, so it needs no exemption list and produces no false
 * positives — which is what makes it a rule that will still be enforced in a
 * year rather than one somebody switches off.
 *
 * Mono and code are exempt by the same logic: `--dry-run` and `--thread` have
 * no letter before the dashes, and `claude mcp add x -- selvedge context` is a
 * real command whose double dash is real.
 */

function tsxFiles(): string[] {
  return globSync('src/client/**/*.tsx');
}

/** The words between one tag and the next — what a person actually reads. */
function copyIn(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const node = /(?<=>)([^<>{}]*[A-Za-z][^<>{}]*)(?=<)/g;
  let m: RegExpExecArray | null;
  while ((m = node.exec(source)) !== null) {
    const text = m[1]!;
    // A comment caught between two tags is not copy.
    if (/^\s*(\/\/|\*)/m.test(text)) continue;
    out.push({ line: source.slice(0, m.index).split('\n').length, text });
  }
  return out;
}

describe('the copy is set, not just typed', () => {
  it("uses a real apostrophe, never a straight quote", () => {
    const found: string[] = [];
    for (const file of tsxFiles()) {
      for (const { line, text } of copyIn(readFileSync(file, 'utf8'))) {
        // Letter-quote-letter. Unambiguous: no CSS token, flag, or path looks
        // like this.
        if (/[A-Za-z]'[a-z]/.test(text)) found.push(`${file}:${line} — ${text.trim().slice(0, 70)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('uses a real dash, never two hyphens standing in for one', () => {
    const found: string[] = [];
    for (const file of tsxFiles()) {
      for (const { line, text } of copyIn(readFileSync(file, 'utf8'))) {
        // Spaces on both sides is what makes it prose rather than a flag:
        // `--dry-run` and `--thread` are attached to their word.
        if (/\s--\s/.test(text) && !/selvedge context/.test(text)) {
          found.push(`${file}:${line} — ${text.trim().slice(0, 70)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('uses one ellipsis character, not three full stops', () => {
    const found: string[] = [];
    for (const file of tsxFiles()) {
      for (const { line, text } of copyIn(readFileSync(file, 'utf8'))) {
        if (text.includes('...')) found.push(`${file}:${line} — ${text.trim().slice(0, 70)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('sets numbers so a column of them lines up', () => {
    // Inter Tight's default figures are proportional, so a cost ticking from
    // $0.41 to $0.42 changes width and a ledger column doesn't align. Every
    // technical register in the product is numbers, so it is the default there
    // rather than something each site has to remember.
    const css = readFileSync('src/client/index.css', 'utf8');
    expect(css).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(css).toMatch(/\.text-tech/);
  });

  it('will not let a headline end on one orphaned word', () => {
    const css = readFileSync('src/client/index.css', 'utf8');
    expect(css).toMatch(/text-wrap:\s*balance/);
  });
});
