import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ProjectCard, type ProjectCardData } from '../components/ProjectRail.js';
import { ImportReplit } from '../components/ImportReplit.js';
import { Pane, btnPrimary, inputCls, labelCls, eyebrowCls } from '../components/ui.js';
import { SituationCard, type SituationEvent } from '../components/SituationCard.js';
import { walkthroughDone, walkthroughSteps } from '../lib/walkthrough.js';
import { UpgradeNote, limitCodeOf } from '../components/UpgradeNote.js';

type Correction = { id: string; project_id: string | null; line: string };
type StatusResponse = { corrections: Correction[]; live: SituationEvent[] };

/**
 * STATUS — what has happened, above the projects it happened to.
 *
 * This is what is left of the daily brief. The brief was a composed note you
 * had to go and read every morning, on a page of its own, ahead of the work;
 * status is a fact about your projects, so it sits with them and stays out of
 * the way when there is nothing to say.
 *
 * Corrections lead, and are never collapsed or styled down. When Selvedge said
 * something was fine and it wasn't, owning it out loud is the whole basis for
 * believing it the rest of the time.
 */
function Status({ status }: { status: StatusResponse }) {
  const live = status.live.filter((n) => n.projectId !== null || n.eventType === 'connector.auth_failed');
  if (status.corrections.length === 0 && live.length === 0) return null;

  return (
    <section aria-label="Status" className="mb-6 space-y-3">
      {status.corrections.length > 0 && (
        <div className="rounded-card border border-hairline border-l-2 border-l-thread bg-panel-soft px-4 py-3">
          <p className="text-label font-body uppercase tracking-widest text-thread">Correcting myself</p>
          {status.corrections.map((c) => (
            <p key={c.id} className="mt-1 text-body text-ink">
              {c.line}
            </p>
          ))}
        </div>
      )}
      {/* WHAT HAPPENED, FOLDED. This was an open list above the projects, and
          on a real account it is the whole screen: eleven narration cards
          between you and the thing you came for. That layout belonged to the
          question "what needs me this morning?", which this product no longer
          asks — so it is one line you can open, and the count is on it, because
          a fold you cannot see the size of is a fold that hides.

          CORRECTIONS ARE NOT IN HERE, and never will be. Reading one is how it
          gets acknowledged; putting it behind a click is how it goes unread. */}
      {live.length > 0 && (
        <details className="rounded-card border border-hairline bg-panel-soft px-4 py-3">
          <summary className={`cursor-pointer ${eyebrowCls}`}>
            Since yesterday · {live.length}
          </summary>
          <div className="mt-3 space-y-3">
            {live.map((n) => (
              <SituationCard key={n.id} event={n} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

/**
 * The getting-started checklist, rehomed from the retired brief page. It
 * carries the one safety rule it always had: nothing here claims the watching
 * has begun before a project exists, because an all-clear about nothing is
 * still a false all-clear.
 */
function Walkthrough({ projects }: { projects: ProjectCardData[] }) {
  const [fuelConnected, setFuelConnected] = useState(false);
  useEffect(() => {
    api
      .get<{ connected: unknown[] }>('/api/fuel')
      .then((r) => setFuelConnected(r.connected.length > 0))
      .catch(() => setFuelConnected(false));
  }, []);

  const input = {
    hasProject: projects.length > 0,
    ...(projects[0]?.name ? { firstProjectName: projects[0].name } : {}),
    fuelConnected,
  };
  if (walkthroughDone(input)) return null;
  const steps = walkthroughSteps(input);

  return (
    <Pane className="mb-6 p-6">
      <p className="text-body-lg text-ink">
        {projects.length === 0 ? 'Nothing to watch yet — three steps and the watching begins.' : 'Almost there.'}
      </p>
      <ol className="mt-4 space-y-4">
        {steps.map((step) => (
          <li key={step.key} className="flex gap-3">
            <span
              aria-hidden
              className="mt-0.5 w-4 shrink-0 text-center text-body font-medium"
              style={{ color: step.done ? 'var(--healthy)' : 'var(--ink-quiet)' }}
            >
              {step.done ? '✓' : '·'}
            </span>
            <div>
              <p className={`text-body font-medium ${step.done ? 'text-ink-quiet' : 'text-ink'}`}>{step.title}</p>
              <p className="text-body text-ink-dim">{step.detail}</p>
              {!step.done && step.to && (
                <Link to={step.to} className="mt-1 inline-block text-body text-action-bright hover:underline">
                  {step.key === 'project' ? 'Add an app →' : step.key === 'fuel' ? 'Connect a key →' : 'Open the workbench →'}
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Pane>
  );
}

function NewProjectForm({ onCreated }: { onCreated: (newProjectId?: string) => void }) {
  const [repos, setRepos] = useState<Array<{ full_name: string }>>([]);
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('__create__');
  const [manualRepo, setManualRepo] = useState('');
  // New things start as experiments — raise the stakes later, when it's real.
  const [tier, setTier] = useState('sandbox');
  const [touchesMoney, setTouchesMoney] = useState(false);
  const [downtime, setDowntime] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<Array<{ full_name: string }>>('/api/connectors/github/repos').then(setRepos).catch(() => setRepos([]));
  }, []);

  // A brand-new repo means a brand-new thing: no users yet, nothing depends
  // on it, no money through it. Skip the stakes questions entirely — it
  // starts as a sandbox and the owner raises the stakes when it's real.
  const brandNew = repo === '__create__';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const pack = await api.post<{ identity: { project_id: string } }>('/api/packs', {
        name,
        ...(brandNew
          ? { create_repo: true, tier: 'sandbox', touches_money: false }
          : {
              repo: repo === '__manual__' ? manualRepo : repo,
              tier,
              touches_money: touchesMoney,
              downtime_translation: downtime || undefined,
            }),
      });
      onCreated(brandNew ? pack.identity.project_id : undefined);
    } catch (err) {
      // The ERROR OBJECT is kept, not just its sentence: a plan limit answers
      // 402 with a typed code, and flattening it to a string here would leave
      // the owner reading "that is more than this plan allows" with no way to
      // do anything about it.
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const isLive = !brandNew && (tier === 'live_small' || tier === 'live_critical');

  return (
    <Pane className="mb-6 p-5">
      <form onSubmit={submit}>
        <h2 className="mb-3 text-headline font-display text-ink">New project</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={labelCls}>
            Name
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Loom" required />
          </label>
          <label className={labelCls}>
            GitHub repo
            <select className={inputCls} value={repo} onChange={(e) => setRepo(e.target.value)} required>
              <option value="__create__">＋ Create a new private repo for it</option>
              {repos.map((r) => (
                <option key={r.full_name} value={r.full_name}>
                  {r.full_name}
                </option>
              ))}
              <option value="__manual__">Type a repo by name…</option>
            </select>
            {repos.length === 0 && (
              // The picker is empty until the GitHub App is installed — say
              // so, and say the good part: installing IS the bulk import.
              <span className="mt-1 block text-meta text-ink-quiet">
                Already have apps on GitHub?{' '}
                <a href="/api/connectors/github/install" className="text-action-bright hover:underline">
                  Install the Selvedge GitHub App
                </a>{' '}
                and your repos appear here — each one becomes a project automatically.
              </span>
            )}
            {brandNew && (
              <span className="mt-1 block text-body text-ink-quiet">
                A private repo named after the project, made for you on GitHub. It starts as a
                sandbox — you land in the Workshop and just start building.
              </span>
            )}
            {repo === '__manual__' && (
              <input
                className={`${inputCls} mt-2`}
                value={manualRepo}
                onChange={(e) => setManualRepo(e.target.value)}
                placeholder="owner/repo"
                required
              />
            )}
          </label>
          {!brandNew && (
            <label className={labelCls}>
              What is it?
              <select className={inputCls} value={tier} onChange={(e) => setTier(e.target.value)}>
                <option value="sandbox">Sandbox — an experiment</option>
                <option value="personal">Personal — just for me</option>
                <option value="live_small">Live — real people use it</option>
                <option value="live_critical">Live · critical — people depend on it</option>
              </select>
            </label>
          )}
          {isLive && (
            <label className={labelCls}>
              If it goes down, what does that mean? <span className="text-ink-quiet">(optional)</span>
              <input
                className={inputCls}
                value={downtime}
                onChange={(e) => setDowntime(e.target.value)}
                placeholder="customers can't check out"
              />
            </label>
          )}
        </div>
        <div className="mt-4 flex items-center justify-between">
          {brandNew ? (
            <span />
          ) : (
            <label className="flex items-center gap-2 text-body text-ink-dim">
              <input type="checkbox" checked={touchesMoney} onChange={(e) => setTouchesMoney(e.target.checked)} />
              Money moves through it
            </label>
          )}
          <button type="submit" disabled={saving} className={btnPrimary}>
            {saving ? (brandNew ? 'Making the repo…' : 'Creating…') : brandNew ? 'Create & start building' : 'Create project'}
          </button>
        </div>
        {/*
          A plan limit is not a failure and must not be dressed as one: rust is
          "this needs you", and spending it on a sales moment is how a colour
          system stops meaning anything. A limit gets a plain line with a way
          out; everything else is still an error.
        */}
        {limitCodeOf(error) ? (
          <UpgradeNote error={error} />
        ) : (
          error != null && <p className="mt-2 text-body text-thread">{error instanceof Error ? error.message : 'something went wrong'}</p>
        )}
      </form>
    </Pane>
  );
}

export function Projects() {
  const [projects, setProjects] = useState<ProjectCardData[] | null>(null);
  const [status, setStatus] = useState<StatusResponse>({ corrections: [], live: [] });
  const [showForm, setShowForm] = useState(false);
  // The migration door, openable by link (?import=replit) so onboarding and
  // Home can point straight at it rather than at a page it might be on.
  const [searchParams] = useSearchParams();
  const [showImport, setShowImport] = useState(searchParams.get('import') === 'replit');
  const navigate = useNavigate();

  const load = useCallback(
    () =>
      api.get<ProjectCardData[]>('/api/projects').then((rows) => {
        setProjects(rows);
        // Status must not be able to blank the page: a project list that
        // renders without its status is degraded, one that doesn't render at
        // all is broken.
        api
          .get<StatusResponse>('/api/status')
          .then(setStatus)
          .catch(() => undefined);
      }),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (!projects) return <p className="text-body text-ink-quiet">Loading…</p>;

  return (
    <div className="animate-settle">
      <Status status={status} />
      <Walkthrough projects={projects} />
      {/* The memory summary, the context export, bringing a history in and
          filing what came in are all things you set up or do once. They lived
          here, above the projects, and pushed the actual work down the page.
          They are Admin ▸ Context now. */}
      <div className="mb-4 flex items-center justify-between">
        <p className={eyebrowCls}>
          {projects.length === 0 ? 'No projects yet — connect GitHub, or create one' : 'Your stack · read the edges'}
        </p>
        <div className="flex items-center gap-3">
          {/* The migration door lives beside the blank-page door: arriving with
              an app is as normal a way in as starting one. */}
          <button
            onClick={() => setShowImport((v) => !v)}
            className="text-body text-action-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
          >
            {showImport ? 'Close import' : 'Import from Replit'}
          </button>
          <button onClick={() => setShowForm((v) => !v)} className={btnPrimary}>
            {showForm ? 'Close' : 'New project'}
          </button>
        </div>
      </div>
      {showImport && (
        <div className="mb-6">
          <ImportReplit />
        </div>
      )}
      {(showForm || projects.length === 0) && (
        <NewProjectForm
          onCreated={(newProjectId) => {
            setShowForm(false);
            // A brand-new project goes straight to the Workshop — the point of
            // starting from nothing is to start building, not to file paperwork.
            if (newProjectId) {
              navigate(`/projects/${newProjectId}/workshop`);
              return;
            }
            void load();
          }}
        />
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {projects.filter((p) => !p.muted).map((p) => (
          <ProjectCard key={p.project_id} project={p} />
        ))}
      </div>
      {projects.some((p) => p.muted) && (
        <details className="mt-6">
          <summary className="cursor-pointer text-label font-body uppercase tracking-widest text-ink-quiet">
            Muted · {projects.filter((p) => p.muted).length}
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {projects.filter((p) => p.muted).map((p) => (
              <ProjectCard key={p.project_id} project={p} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
