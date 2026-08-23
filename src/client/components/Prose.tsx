import type { ReactNode } from 'react';

/**
 * MARKDOWN, RENDERED, WITHOUT A MARKDOWN LIBRARY.
 *
 * The docs, the security page and the changelog are prose that belongs in
 * files a person can edit and diff — not in JSX, where a typo is a build
 * failure and a paragraph is a component. So they are markdown, imported at
 * build time with Vite's `?raw`, and rendered here.
 *
 * WHY NOT `marked` OR `react-markdown`. The house rule is no new dependency
 * without a reason written down, and the reason would have to survive this
 * question: what does the library do that these pages need? They need
 * headings, paragraphs, lists, links, inline code, code blocks, bold, and a
 * rule. That is eighty lines. What a library adds beyond it is HTML passthrough
 * — which on pages rendered from files in this repo is not a feature, it is a
 * way for a stray `<script>` in a document to become a script tag — plus
 * tables, footnotes, and a parser to keep updated.
 *
 * So: a small renderer that handles what the pages use and IGNORES what they
 * don't, which is also the safe direction to fail. Nothing here interprets raw
 * HTML; anything that isn't one of the shapes below is text.
 *
 * TOKENS ONLY, READING REGISTER. These are pages to be read rather than worked
 * in, so they use --space-read and the Fraunces headings, exactly like the
 * project timeline does inside the workbench.
 */

/** Inline: `code`, **bold**, [text](href). Applied in that order, once. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // One pass, one regex, three shapes — so a link inside bold and bold inside
  // a link both come out as text rather than as a half-parsed tag.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith('`')) {
      out.push(
        <code key={key} className="rounded-inset bg-panel-soft px-1 py-0.5 font-mono text-tech text-ink-dim">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      out.push(
        <strong key={key} className="font-medium text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      const split = token.indexOf('](');
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      // External links open away; internal ones are ordinary navigations.
      const external = /^https?:/.test(href);
      out.push(
        <a
          key={key}
          href={href}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          className="text-action-bright hover:underline"
        >
          {label}
        </a>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Prose({ markdown }: { markdown: string }) {
  const blocks: ReactNode[] = [];
  const lines = markdown.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code. Taken verbatim, never parsed — a shell command with a `*`
    // in it is a shell command.
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i]!), i++;
      i++;
      blocks.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-inset border border-hairline bg-panel-soft px-3 py-2 font-mono text-tech text-ink-dim"
        >
          {body.join('\n')}
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length;
      const text = heading[2]!;
      // An id per heading, so in-page navigation is a link rather than a
      // scroll position somebody has to find again.
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (depth === 1) {
        blocks.push(
          <h1 key={key++} id={id} className="mt-read font-display text-section text-ink first:mt-0">
            {inline(text, `h${key}`)}
          </h1>,
        );
      } else if (depth === 2) {
        blocks.push(
          <h2 key={key++} id={id} className="mt-8 font-display text-headline font-medium text-ink">
            {inline(text, `h${key}`)}
          </h2>,
        );
      } else {
        blocks.push(
          <h3 key={key++} id={id} className="mt-6 text-body-lg font-medium text-ink">
            {inline(text, `h${key}`)}
          </h3>,
        );
      }
      i++;
      continue;
    }

    if (/^(---|\*\*\*)\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="mt-8 border-hairline" />);
      i++;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++} className="mt-3 list-disc space-y-1 pl-5 text-body text-ink-dim">
          {items.map((item, n) => (
            <li key={n}>{inline(item, `li${key}-${n}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    // A paragraph runs until the next blank line, so markdown can be wrapped
    // at a sane width in the file without wrapping on the page.
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !/^(#{1,3}\s|```|[-*]\s|---)/.test(lines[i]!)) {
      paragraph.push(lines[i]!.trim());
      i++;
    }
    blocks.push(
      <p key={key++} className="mt-3 text-body text-ink-dim">
        {inline(paragraph.join(' '), `p${key}`)}
      </p>,
    );
  }

  return <div className="max-w-prose">{blocks}</div>;
}
