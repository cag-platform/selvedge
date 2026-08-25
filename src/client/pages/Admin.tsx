import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Tray } from './Tray.js';
import { TrackRecord } from './TrackRecord.js';
import { Connections } from './Connections.js';
import { Billing } from './Billing.js';
import { Context } from './Context.js';
import { Preferences } from './Preferences.js';

/**
 * EVERYTHING YOU SET UP ONCE.
 *
 * The nav used to carry six peers — Inbox, Record, Projects, Connections,
 * Billing, Admin — of which two are where you work and four are things you
 * arrange once and then stop thinking about. Presenting them as equals made
 * the first question on every visit "which of these did I want?" instead of
 * "what needs me?", and it is most of the reason the app felt clunky.
 *
 * So the four became one. What is here is genuinely of a kind: the record of
 * what has been done, the accounts it runs on, the money, and the operator
 * internals underneath. None of it is the work.
 *
 * EACH PANEL KEEPS ITS OWN TITLE and this page has none. The tabs are the
 * navigation; a second heading above them would be a label for a label, and
 * two `h1`s on one screen is the kind of thing that reads fine and tests badly.
 */

const tabClass = ({ isActive }: { isActive: boolean }) =>
  `whitespace-nowrap rounded-inset px-3 py-1.5 text-body font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright ${
    isActive ? 'bg-panel-soft text-ink' : 'text-ink-quiet hover:text-ink-dim'
  }`;

export function Admin() {
  return (
    <div className="space-y-6">
      {/* Scrolls rather than wraps or overflows: four tabs fit a laptop and
          not a phone, and a row that quietly widens the document is exactly
          the bug this consolidation was fixing upstairs. */}
      <nav aria-label="Admin sections" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        <NavLink to="/admin/preferences" className={tabClass}>
          Preferences
        </NavLink>
        <NavLink to="/admin/record" className={tabClass}>
          Record
        </NavLink>
        {/* Reachable for the first time. "Your apps" — what Selvedge has seen
            and where it belongs — was a finished screen with a live API that no
            link in the client pointed at, so the only way to open it was to
            type /tray. Six months of filing work behind an address nobody
            knew. */}
        <NavLink to="/admin/apps" className={tabClass}>
          Your apps
        </NavLink>
        <NavLink to="/admin/connections" className={tabClass}>
          Connections
        </NavLink>
        {/* What Selvedge has learned, the export that lets you take it, and
            bringing a history in. All of it sat above the projects on the
            Projects page — none of it is work, and on an account with a real
            history it pushed the projects below the fold. */}
        <NavLink to="/admin/context" className={tabClass}>
          Context
        </NavLink>
        <NavLink to="/admin/billing" className={tabClass}>
          Billing
        </NavLink>
        <NavLink to="/admin/advanced" className={tabClass}>
          Under the hood
        </NavLink>
      </nav>

      <Routes>
        {/* Connections is the landing because it is the one people come back
            for — a key to add, a key that stopped working. */}
        <Route index element={<Navigate to="/admin/preferences" replace />} />
        <Route path="preferences" element={<Preferences />} />
        <Route path="record" element={<TrackRecord />} />
        <Route path="apps" element={<Tray />} />
        <Route path="connections" element={<Connections />} />
        <Route path="context" element={<Context />} />
        <Route path="billing" element={<Billing />} />
        <Route path="advanced" element={<UnderTheHood />} />
      </Routes>
    </div>
  );
}

type Metrics = {
  attention_usd_per_day: number;
  plan: string;
  enforced_cap_usd_per_day: number;
  cost_by_day: Array<{
    day: string;
    cost_usd: number;
    calls: number;
    failed_calls: number;
    needs_attention: boolean;
    over_enforced_cap: boolean;
  }>;
  lib_hit_rate_by_day: Array<{ day: string; lib_routed: number; lib_hits: number; hit_rate: number }>;
  template_fallbacks_total: number;
  fragments_needing_review: number;
};

type DigestPair = {
  digest_date: string;
  voice: string;
  composed_text: string | null;
  mechanical_text: string | null;
};

function TimezoneSettings() {
  const [org, setOrg] = useState<{ timezone: string; timezone_source: string } | null>(null);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ timezone: string; timezone_source: string }>('/api/org').then((o) => {
      setOrg(o);
      setValue(o.timezone);
    });
  }, []);

  if (!org) return null;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const save = async (tz: string) => {
    setStatus(null);
    try {
      const updated = await api.patch<{ timezone: string; timezone_source: string }>('/api/org/timezone', {
        timezone: tz,
        source: 'user',
      });
      setOrg(updated);
      setValue(updated.timezone);
      setStatus(`Saved — the daily brief now composes at 7:00am ${updated.timezone}.`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'save failed');
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-quiet">Daily brief timezone</h2>
      <div className="rounded-card border border-hairline bg-panel p-4">
        <p className="text-sm text-ink-dim">
          The brief composes at 7:00am in <span className="font-medium text-ink">{org.timezone}</span>
          {org.timezone_source === 'auto' && ' (detected from your browser)'}
          {org.timezone_source === 'default' && ' (default — sign-in auto-detects this)'}.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className="w-64 rounded-inset border border-hairline px-2 py-1.5 text-sm text-ink"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="America/New_York"
          />
          <button
            onClick={() => void save(value)}
            className="rounded-inset bg-ink px-3 py-1.5 text-sm font-medium text-panel transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
          >
            Save
          </button>
          {browserTz && browserTz !== org.timezone && (
            <button onClick={() => void save(browserTz)} className="text-sm text-action-bright hover:underline">
              Use my timezone ({browserTz})
            </button>
          )}
        </div>
        {status && <p className="mt-2 text-sm text-ink-dim">{status}</p>}
      </div>
    </section>
  );
}

function UnderTheHood() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [pairs, setPairs] = useState<DigestPair[] | null>(null);

  useEffect(() => {
    api.get<Metrics>('/api/admin/metrics').then(setMetrics);
    api.get<DigestPair[]>('/api/admin/digests').then(setPairs);
  }, []);

  if (!metrics || !pairs) return <p className="text-ink-quiet">Loading…</p>;

  return (
    <div className="space-y-8">
      {/* Filing what Selvedge has seen is settings work, not a destination in
          the main navigation beside the work itself. */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-quiet">Your apps</h2>
        <Tray />
      </section>
      <TimezoneSettings />
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-quiet">
          Cost per day — cap ${Number(metrics.enforced_cap_usd_per_day ?? 0).toFixed(2)}/day on the {metrics.plan} plan
          {' '}(worth-a-look line ${Number(metrics.attention_usd_per_day ?? 0).toFixed(2)})
        </h2>
        <div className="overflow-hidden rounded-card border border-hairline bg-panel">
          <table className="w-full text-sm">
            <thead className="bg-panel-soft text-left text-ink-dim">
              <tr>
                <th className="px-3 py-2">Day</th>
                <th className="px-3 py-2">Cost</th>
                <th className="px-3 py-2">Calls</th>
                <th className="px-3 py-2">Failed</th>
              </tr>
            </thead>
            <tbody>
              {metrics.cost_by_day.length === 0 && (
                <tr>
                  <td className="px-3 py-2 text-ink-quiet" colSpan={4}>
                    No model calls yet.
                  </td>
                </tr>
              )}
              {metrics.cost_by_day.map((r) => (
                <tr key={r.day} className={r.needs_attention ? 'bg-panel-soft' : ''}>
                  <td className="px-3 py-2">{r.day}</td>
                  <td className={`px-3 py-2 ${r.needs_attention ? 'font-medium text-brass' : ''}`}>
                    ${Number(r.cost_usd ?? 0).toFixed(4)}
                    {r.over_enforced_cap ? ' (hit the cap — voice off for the day)' : r.needs_attention ? ' (worth a look)' : ''}
                  </td>
                  <td className="px-3 py-2">{r.calls}</td>
                  <td className="px-3 py-2">{r.failed_calls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-quiet">Library hit rate</h2>
        <div className="overflow-hidden rounded-card border border-hairline bg-panel">
          <table className="w-full text-sm">
            <thead className="bg-panel-soft text-left text-ink-dim">
              <tr>
                <th className="px-3 py-2">Day</th>
                <th className="px-3 py-2">LIB-routed</th>
                <th className="px-3 py-2">Served from library</th>
                <th className="px-3 py-2">Hit rate</th>
              </tr>
            </thead>
            <tbody>
              {metrics.lib_hit_rate_by_day.length === 0 && (
                <tr>
                  <td className="px-3 py-2 text-ink-quiet" colSpan={4}>
                    No LIB-routed narrations yet.
                  </td>
                </tr>
              )}
              {metrics.lib_hit_rate_by_day.map((r) => (
                <tr key={r.day}>
                  <td className="px-3 py-2">{r.day}</td>
                  <td className="px-3 py-2">{r.lib_routed}</td>
                  <td className="px-3 py-2">{r.lib_hits}</td>
                  <td className="px-3 py-2">{(Number(r.hit_rate ?? 0) * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-ink-quiet">
          Template fallbacks so far: {metrics.template_fallbacks_total} · fragments flagged for review:{' '}
          {metrics.fragments_needing_review}
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-quiet">
          Before / after (mechanical vs composed)
        </h2>
        <div className="space-y-4">
          {pairs.length === 0 && <p className="text-sm text-ink-quiet">No digests yet.</p>}
          {pairs.map((p) => (
            <div key={p.digest_date} className="rounded-card border border-hairline bg-panel p-4">
              <p className="mb-2 text-sm font-medium text-ink">
                {p.digest_date} <span className="ml-2 rounded bg-panel-soft px-1.5 py-0.5 text-xs text-ink-dim">{p.voice}</span>
              </p>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase text-ink-quiet">Phase 1 · mechanical</p>
                  <pre className="whitespace-pre-wrap rounded bg-panel-soft p-3 text-sm text-ink-dim">
                    {p.mechanical_text ?? '—'}
                  </pre>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase text-ink-quiet">Phase 2 · composed</p>
                  <pre className="whitespace-pre-wrap rounded bg-panel-soft p-3 text-sm text-ink">
                    {p.composed_text ?? (p.voice === 'fallback' ? '(fell back to mechanical this day)' : '—')}
                  </pre>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
