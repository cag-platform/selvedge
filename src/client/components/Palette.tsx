import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentChip } from './AgentChip.js';
import { allThreads, matches, type InboxData } from '../lib/inbox.js';

/**
 * ONE PALETTE — jump to any thread or project, and read the shortcuts.
 *
 * It exists because a workbench with thirty threads needs a way through that
 * isn't scrolling, and it doubles as the discoverability requirement: every
 * shortcut in the app is listed here in plain words, and none of them is the
 * only way to do anything.
 */
export function Palette({
  data,
  open,
  onClose,
  onOpenThread,
}: {
  data: InboxData | null;
  open: boolean;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      input.current?.focus();
    }
  }, [open]);

  const results = useMemo(
    () => allThreads(data).filter((t) => matches(query, t.title, t.projectName)).slice(0, 12),
    [data, query],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-paper/70 p-8" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Jump to"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-xl animate-settle rounded-card border border-hairline bg-panel p-work"
      >
        <input
          ref={input}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            }
            if (e.key === 'Enter' && results[cursor]) {
              onOpenThread(results[cursor]!.id);
              onClose();
            }
          }}
          placeholder="Jump to a thread or project"
          className="w-full rounded-inset border border-hairline bg-panel-soft px-3 py-2 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        />

        <ul className="mt-work max-h-80 overflow-y-auto">
          {results.map((thread, i) => (
            <li key={thread.id}>
              <button
                onMouseEnter={() => setCursor(i)}
                onClick={() => {
                  onOpenThread(thread.id);
                  onClose();
                }}
                className={`flex w-full items-center gap-work rounded-inset px-work py-work-tight text-left ${i === cursor ? 'bg-panel-soft' : ''}`}
              >
                <AgentChip agent={thread.agent} />
                <span className="min-w-0 flex-1 truncate text-body text-ink">{thread.title}</span>
                <span className="shrink-0 text-meta text-ink-quiet">{thread.projectName}</span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="px-work py-work-tight text-body text-ink-quiet">Nothing by that name.</li>}
        </ul>

        <div className="mt-work border-t border-hairline pt-work font-mono text-tech text-ink-quiet">
          <p>⌘K jump · ⌘J switch agent · ⌘N new thread · j / k move in the rail · Esc close</p>
        </div>
      </div>
    </div>
  );
}
