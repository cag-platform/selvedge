import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import type { InboxData } from '../lib/inbox.js';

/**
 * The Workshop was a page; it is now a thread in the Inbox. Every old link —
 * from the pack editor, from a just-created project, from a bookmark — lands
 * here and is carried into the conversation it meant, opening the project's
 * workshop thread (or starting its first one).
 *
 * Kept as a real route rather than deleted, because a link that used to work
 * and now 404s is the sort of small betrayal this product is supposed to be
 * incapable of.
 */
export function WorkshopRedirect() {
  const { projectId } = useParams();
  const navigate = useNavigate();

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      try {
        const inbox = await api.get<InboxData>('/api/inbox');
        const project = inbox.projects.find((p) => p.id === projectId);
        const existing = project?.threads.find((t) => t.kind === 'workshop');
        if (existing) {
          if (!cancelled) navigate(`/inbox/${existing.id}`, { replace: true });
          return;
        }
        const created = await api.post<{ thread: { id: string } }>(`/api/projects/${projectId}/threads`, { kind: 'workshop' });
        if (!cancelled) navigate(`/inbox/${created.thread.id}`, { replace: true });
      } catch {
        if (!cancelled) navigate('/inbox', { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, navigate]);

  return <p className="p-work text-body text-ink-quiet">Opening the workshop…</p>;
}
