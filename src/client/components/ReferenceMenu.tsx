import { useEffect } from 'react';
import { candidatesMatching, type ReferenceCandidate } from '../lib/references.js';

/**
 * WHAT WE ARE TALKING ABOUT, chosen over the half-typed `#`.
 *
 * The sibling of AgentMenu, and deliberately the same gesture: `@` picks who
 * answers, `#` picks what they should read first. Picking inserts the name
 * into the sentence rather than setting anything behind your back, so the
 * reference is visible where you wrote it, costs nothing until you send, and
 * comes back with one press of backspace.
 *
 * Imported conversations are listed like everything else and say where they
 * came from. Hiding them would undo the point of the import; unlabelling them
 * would let something you said to ChatGPT read as something decided here.
 */
export function ReferenceMenu({
  items,
  query,
  onPick,
  onDismiss,
}: {
  items: ReferenceCandidate[];
  /** The half-typed name at the caret. Null when the menu should be closed. */
  query: string | null;
  onPick: (name: string) => void;
  onDismiss: () => void;
}) {
  const shown = query === null ? [] : candidatesMatching(items, query).slice(0, 8);

  useEffect(() => {
    if (query === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [query, onDismiss]);

  if (query === null) return null;

  return (
    <div
      role="listbox"
      aria-label="What should I read alongside this"
      className="absolute bottom-full left-0 z-20 mb-work w-[26rem] max-w-[calc(100vw-2rem)] animate-settle rounded-card border border-hairline bg-panel p-work-tight shadow-lg"
    >
      {shown.length === 0 ? (
        // Said rather than shown as an empty box: "nothing here is called that"
        // is an answer, and a menu that silently vanishes reads as a bug.
        <p className="px-work-tight py-work-tight text-meta text-ink-quiet">Nothing here is called that.</p>
      ) : (
        shown.map((item) => (
          <button
            key={`${item.kind}:${item.id}`}
            type="button"
            role="option"
            aria-selected={false}
            onClick={() => onPick(item.name)}
            className="flex w-full items-baseline gap-work rounded-inset px-work-tight py-work-tight text-left hover:bg-panel-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
          >
            <span className="min-w-0 flex-1 truncate text-body text-ink">{item.name}</span>
            <span className="shrink-0 font-mono text-tech text-ink-quiet">
              {item.note ?? (item.kind === 'project' ? 'project' : item.kind === 'subject' ? 'subject' : 'conversation')}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
