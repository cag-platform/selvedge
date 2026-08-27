import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import type { TechnicalDetail } from '../../shared/technicalDetail.js';

type OrgSettings = {
  timezone: string;
  timezone_source: string;
  technical_detail: TechnicalDetail;
};

const choices: Array<{
  value: TechnicalDetail;
  title: string;
  description: string;
  example: string;
  detail: string;
}> = [
  {
    value: 'simple',
    title: 'Simple',
    description: 'Lead with the outcome in plain English. Nothing technical is deleted or rewritten.',
    example: 'I updated 3 files and checked the work.',
    detail: 'Technical details',
  },
  {
    value: 'full',
    title: 'Full',
    description: 'Technical summaries stay visible. Exact commands, paths, and logs are one step deeper.',
    example: '8 steps · 3 files changed · succeeded',
    detail: 'Show technical record',
  },
];

export function TechnicalDetailChoices({
  value,
  disabled,
  onChoose,
}: {
  value: TechnicalDetail;
  disabled: boolean;
  onChoose: (value: TechnicalDetail) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2" role="radiogroup" aria-label="Account technical detail">
      {choices.map((choice) => {
        const selected = value === choice.value;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChoose(choice.value)}
            className={`group rounded-pane border-2 p-5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-bright disabled:opacity-60 ${
              selected ? 'border-action-bright bg-panel' : 'border-hairline bg-panel hover:border-ink-faint'
            }`}
          >
            <span className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-headline font-semibold text-ink">{choice.title}</span>
                <span className="mt-1 block text-body text-ink-dim">{choice.description}</span>
              </span>
              <span
                aria-hidden
                className={`mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full border ${selected ? 'border-action-bright bg-action-bright' : 'border-ink-faint'}`}
              >
                {selected && <span className="h-1.5 w-1.5 rounded-full bg-panel" />}
              </span>
            </span>
            <span className="mt-5 block rounded-inset border border-hairline bg-panel-soft px-3 py-3">
              <span className={`block ${choice.value === 'full' ? 'font-mono text-tech' : 'text-body'} text-ink`}>{choice.example}</span>
              <span className="mt-2 block text-meta text-ink-quiet">⌄ {choice.detail}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Account presentation preferences. This is intentionally separate from a
 * project's voice.detail_level: that setting shapes generated narration;
 * this one only changes how the same durable activity record is displayed.
 */
export function Preferences() {
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [saving, setSaving] = useState<TechnicalDetail | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    api.get<OrgSettings>('/api/org').then(setSettings).catch((error: Error) => setStatus(error.message));
  }, []);

  async function choose(value: TechnicalDetail) {
    if (!settings || settings.technical_detail === value || saving) return;
    const before = settings;
    setSettings({ ...settings, technical_detail: value });
    setSaving(value);
    setStatus(null);
    try {
      const updated = await api.patch<OrgSettings>('/api/org/technical-detail', { technical_detail: value });
      setSettings(updated);
      setStatus(`Saved. New and existing conversations now use ${value === 'full' ? 'Full detail' : 'Simple language'} unless you override one.`);
    } catch (error) {
      setSettings(before);
      setStatus(error instanceof Error ? error.message : "That setting didn't save.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-8">
      <header className="max-w-2xl">
        <p className="section-label mb-2">Preferences</p>
        <h1 className="font-display text-display text-ink">How much of the machinery should you see?</h1>
        <p className="mt-2 text-body-lg text-ink-dim">
          Selvedge keeps the same complete project record in either mode. This only changes how work is presented on web and mobile.
        </p>
      </header>

      <section aria-labelledby="technical-detail-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="technical-detail-heading" className="text-headline font-semibold text-ink">Technical detail</h2>
            <p className="text-body text-ink-dim">Simple is the default. Switch to Full—or override one conversation—when you want the complete builder surface.</p>
          </div>
          {saving && <span className="font-mono text-tech text-ink-quiet">Saving…</span>}
        </div>

        {settings === null && !status ? (
          <div className="h-52 animate-pulse rounded-pane border border-hairline bg-panel" aria-label="Loading technical detail preference" />
        ) : settings ? (
          <TechnicalDetailChoices
            value={settings.technical_detail}
            disabled={saving !== null}
            onChoose={(value) => void choose(value)}
          />
        ) : null}
        <p className="mt-3 text-meta text-ink-quiet">
          Agent answers remain exactly as written. This preference only organizes build activity, handoffs, commands, paths, and run metadata.
        </p>
        {status && <p className="mt-3 text-body text-ink-dim" role="status" aria-live="polite">{status}</p>}
      </section>
    </div>
  );
}
