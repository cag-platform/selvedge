import { Link, useParams } from 'react-router-dom';
import { SelvedgeLockup } from '../components/Logo.js';
import { Prose } from '../components/Prose.js';
import { eyebrowCls } from '../components/ui.js';

import startHere from '../../../docs/site/start-here.md?raw';
import companion from '../../../docs/site/companion.md?raw';
import importing from '../../../docs/site/import.md?raw';
import keys from '../../../docs/site/keys.md?raw';
import limits from '../../../docs/site/limits.md?raw';
import security from '../../../docs/site/security.md?raw';
import changelog from '../../../docs/site/changelog.md?raw';

/**
 * THE PUBLIC PAGES — docs, security, changelog.
 *
 * All three are prose, and prose belongs in files a person can edit and diff
 * rather than in JSX, where a typo is a build failure and a paragraph is a
 * component. They live in `docs/site/*.md` and are imported at build time with
 * Vite's `?raw`, so there is no runtime fetch, no loading state, and no way for
 * a docs page to 404 in production while building fine locally.
 *
 * NO NEW FRAMEWORK AND NO NEW DEPENDENCY. Public route in the same shape as
 * the styleguide's, our own small renderer (components/Prose.tsx), same design
 * tokens as the app. The reading register throughout — these are pages to read
 * rather than surfaces to work in.
 *
 * WHY THE SECURITY PAGE IS HERE RATHER THAN SOMEWHERE MORE OFFICIAL-LOOKING.
 * It is documentation of how the thing works, written by the person who built
 * it, and putting it behind different chrome would suggest it is a different
 * kind of claim. It isn't.
 */

type Page = { slug: string; title: string; blurb: string; markdown: string; updated: string };

/**
 * `updated` is a real date, typed by hand when the page's content actually
 * changes. Deriving it from the file's mtime or the build date would produce a
 * page that claims to have been reviewed every time anything else was
 * deployed, which is exactly the false freshness a docs site should not have.
 */
const DOCS: Page[] = [
  { slug: '', title: 'Start here', blurb: 'What it is, what you need, and the first ten minutes.', markdown: startHere, updated: '22 August 2026' },
  { slug: 'companion', title: 'The companion', blurb: 'Your terminal sessions, and exactly what leaves your machine.', markdown: companion, updated: '22 August 2026' },
  { slug: 'import', title: 'Import your history', blurb: 'The chats you have already had, brought in.', markdown: importing, updated: '22 August 2026' },
  { slug: 'keys', title: 'Keys and spending', blurb: 'What runs on what, what it costs, and how ceilings work.', markdown: keys, updated: '22 August 2026' },
  { slug: 'limits', title: "What Selvedge can't see", blurb: 'The honest page.', markdown: limits, updated: '22 August 2026' },
];

const SECURITY: Page = { slug: 'security', title: 'Security', blurb: 'Where your data is, and what can reach it.', markdown: security, updated: '22 August 2026' };
const CHANGELOG: Page = { slug: 'changelog', title: 'Changelog', blurb: 'What changed, in the words the commits use.', markdown: changelog, updated: '23 August 2026' };

/** The shell all three share: the lockup, the nav, the page, the footer. */
function Shell({ page }: { page: Page }) {
  return (
    <div>
      <header className="sticky top-0 z-10 border-b border-hairline" style={{ background: 'var(--glass-fill)', backdropFilter: 'var(--glass-blur)' }}>
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <Link to="/">
            <SelvedgeLockup tone="chalk" className="h-7 w-auto" />
          </Link>
          <Link to="/request-invite" className="text-meta text-action-bright hover:underline">
            Request an invite
          </Link>
        </div>
      </header>

      <div className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-10 md:flex-row">
        <nav aria-label="Documentation" className="w-full shrink-0 md:w-52">
          <p className={eyebrowCls}>Docs</p>
          <ul className="mt-3 space-y-1">
            {DOCS.map((d) => (
              <li key={d.slug || 'index'}>
                <Link
                  to={`/docs${d.slug ? `/${d.slug}` : ''}`}
                  aria-current={d.slug === page.slug ? 'page' : undefined}
                  className={`block rounded-inset px-2 py-1 text-body ${d.slug === page.slug ? 'bg-panel-soft text-ink' : 'text-ink-dim hover:text-ink'}`}
                >
                  {d.title}
                </Link>
              </li>
            ))}
          </ul>
          <p className={`${eyebrowCls} mt-6`}>Also</p>
          <ul className="mt-3 space-y-1">
            {[SECURITY, CHANGELOG].map((p) => (
              <li key={p.slug}>
                <Link
                  to={`/${p.slug}`}
                  aria-current={p.slug === page.slug ? 'page' : undefined}
                  className={`block rounded-inset px-2 py-1 text-body ${p.slug === page.slug ? 'bg-panel-soft text-ink' : 'text-ink-dim hover:text-ink'}`}
                >
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 flex-1">
          <Prose markdown={page.markdown} />
          {/* A real date, typed when the content changed. A build-stamped one
              would claim every page was reviewed on every deploy. */}
          <p className="mt-10 border-t border-hairline pt-4 text-meta text-ink-quiet">Last updated: {page.updated}</p>
        </main>
      </div>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-4 px-4 py-8 text-meta text-ink-quiet">
          <Link to="/" className="hover:text-ink-dim">
            Selvedge
          </Link>
          <Link to="/docs" className="hover:text-ink-dim">
            Docs
          </Link>
          <Link to="/security" className="hover:text-ink-dim">
            Security
          </Link>
          <Link to="/changelog" className="hover:text-ink-dim">
            Changelog
          </Link>
        </div>
      </footer>
    </div>
  );
}

export function Docs() {
  const { page } = useParams();
  // An unknown slug lands on Start here rather than on a 404: somebody
  // following a link from an old post should get the docs, not a dead end.
  const found = DOCS.find((d) => d.slug === (page ?? '')) ?? DOCS[0]!;
  return <Shell page={found} />;
}

export function Security() {
  return <Shell page={SECURITY} />;
}

export function Changelog() {
  return <Shell page={CHANGELOG} />;
}
