import { useEffect, useRef, useState } from 'react';
import { AgentChip, agentChoices } from './AgentChip.js';

/**
 * THE SWITCHER — the interaction the Inbox is built around, and the one the
 * brief calls tantamount: tap the chip, pick, keep typing.
 *
 * So: no modal, no page change, no confirmation, and focus goes straight back
 * to the input on pick. It lives in the composer because that is where your
 * hands already are, and it opens on Cmd+J for the same reason.
 *
 * Every entry says what it costs in one honest line before you choose it, and
 * an agent this deployment can't run says so instead of being hidden — a
 * picker that quietly omits things teaches people the product is smaller than
 * it is, and one that offers what fails teaches them not to trust it.
 */
export function AgentSwitcher({
  kind,
  agent,
  open,
  onOpenChange,
  onPick,
  disabled = false,
}: {
  kind: 'workshop' | 'general';
  agent: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (agent: string) => void;
  disabled?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    const onClick = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open, onOpenChange]);

  const choices = agentChoices(kind);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch agent (Cmd+J)"
        className="rounded-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-50"
      >
        <AgentChip agent={agent} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-20 mb-work w-80 animate-settle rounded-card border border-hairline bg-panel p-work-tight shadow-lg"
        >
          {choices.map((choice) => (
            <button
              key={choice.id}
              role="option"
              aria-selected={choice.id === agent}
              onClick={() => {
                if (!choice.live) {
                  setNote(`${choice.name} isn't switched on yet — it's declared here so you can see it coming, not offered.`);
                  return;
                }
                onPick(choice.id);
              }}
              className={`flex w-full items-start gap-work rounded-inset px-work-tight py-work-tight text-left hover:bg-panel-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright ${
                choice.live ? '' : 'opacity-60'
              }`}
            >
              <span className="mt-0.5">
                <AgentChip agent={choice.id} />
              </span>
              <span className="min-w-0">
                <span className="block text-body text-ink">
                  {choice.name}
                  {choice.id === agent && <span className="ml-work text-meta text-ink-quiet">answering now</span>}
                  {!choice.live && <span className="ml-work text-meta text-ink-quiet">not yet</span>}
                </span>
                <span className="block text-meta text-ink-quiet">{choice.costNote}</span>
              </span>
            </button>
          ))}
          {note && <p className="px-work-tight py-work-tight text-meta text-ink-dim">{note}</p>}
        </div>
      )}
    </div>
  );
}
