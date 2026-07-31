import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { SelvedgeEdge } from '../components/SelvedgeEdge.js';
import { Pane, btnPrimary, inputCls, eyebrowCls } from '../components/ui.js';

type TrayItem = { id: string; source: string; source_account_id: string; event_type: string; occurred_at: string };
type ProjectOption = { project_id: string; name: string };

/**
 * The unsorted tray — calm, not an error ("The Look", Prompt 5). These are
 * things Selvedge noticed but can't place yet: the dashed unknown edge,
 * plain words, one tap to teach it. It never asks twice.
 */
export function Tray() {
  const [items, setItems] = useState<TrayItem[] | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});

  function refresh() {
    api.get<TrayItem[]>('/api/tray').then(setItems);
  }

  useEffect(() => {
    refresh();
    api.get<ProjectOption[]>('/api/projects').then(setProjects);
  }, []);

  async function assign(item: TrayItem) {
    const projectId = choice[item.id];
    if (!projectId) return;
    await api.post('/api/tray/assign', { connector: item.source, resource_id: item.source_account_id, project_id: projectId });
    refresh();
  }

  if (!items) return <p className="text-body text-ink-quiet">Loading…</p>;
  if (items.length === 0) {
    return (
      <Pane className="p-6">
        <p className="text-body-lg text-ink">Nothing unsorted — every event has a home.</p>
        <p className="mt-1 text-body text-ink-dim">
          When something arrives that I can't place, it waits here quietly. Telling me once is enough.
        </p>
      </Pane>
    );
  }

  // One row per (source, source_account_id) rather than per event — a
  // single tap assigns everything from that source at once.
  const bySource = new Map<string, TrayItem[]>();
  for (const item of items) {
    const key = `${item.source}:${item.source_account_id}`;
    bySource.set(key, [...(bySource.get(key) ?? []), item]);
  }

  return (
    <div className="animate-settle space-y-4">
      <p className={eyebrowCls}>Unsorted · tell me once where these belong</p>
      <div className="space-y-3">
        {[...bySource.entries()].map(([key, group]) => {
          const first = group[0]!;
          return (
            <Pane key={key} className="flex flex-wrap items-center justify-between gap-3 pl-5">
              <SelvedgeEdge status="unknown" />
              <div>
                <p className="text-body font-medium text-ink">{first.source_account_id}</p>
                <p className="text-meta text-ink-dim">
                  {group.length} thing{group.length === 1 ? '' : 's'} I noticed but can't place yet
                </p>
              </div>
              <div className="flex items-center gap-2">
                <label className="sr-only" htmlFor={`assign-${first.id}`}>
                  Which project does {first.source_account_id} belong to?
                </label>
                <select
                  id={`assign-${first.id}`}
                  className={`${inputCls} mt-0 w-48`}
                  value={choice[first.id] ?? ''}
                  onChange={(e) => setChoice((c) => ({ ...c, [first.id]: e.target.value }))}
                >
                  <option value="">This belongs to…</option>
                  {projects.map((p) => (
                    <option key={p.project_id} value={p.project_id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button className={btnPrimary} disabled={!choice[first.id]} onClick={() => assign(first)}>
                  That's settled
                </button>
              </div>
            </Pane>
          );
        })}
      </div>
    </div>
  );
}
