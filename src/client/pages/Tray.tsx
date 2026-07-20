import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

type TrayItem = { id: string; source: string; source_account_id: string; event_type: string; occurred_at: string };
type ProjectOption = { project_id: string; name: string };

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

  if (!items) return <p className="text-slate-400">Loading…</p>;
  if (items.length === 0) return <p className="text-slate-500">Nothing unsorted — every event has a home.</p>;

  // One row per (source, source_account_id) rather than per event — a
  // single tap assigns everything from that source at once.
  const bySource = new Map<string, TrayItem[]>();
  for (const item of items) {
    const key = `${item.source}:${item.source_account_id}`;
    bySource.set(key, [...(bySource.get(key) ?? []), item]);
  }

  return (
    <div className="space-y-3">
      {[...bySource.entries()].map(([key, group]) => {
        const first = group[0]!;
        return (
          <div key={key} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4">
            <div>
              <p className="font-medium text-slate-800">{first.source_account_id}</p>
              <p className="text-sm text-slate-500">
                {group.length} event{group.length === 1 ? '' : 's'} from {first.source}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                value={choice[first.id] ?? ''}
                onChange={(e) => setChoice((c) => ({ ...c, [first.id]: e.target.value }))}
              >
                <option value="">Assign to…</option>
                {projects.map((p) => (
                  <option key={p.project_id} value={p.project_id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-40"
                disabled={!choice[first.id]}
                onClick={() => assign(first)}
              >
                Assign
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
