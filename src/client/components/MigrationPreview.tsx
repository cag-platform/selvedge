import { useEffect, useMemo, useState } from 'react';

type Device = 'desktop' | 'tablet' | 'mobile';

const devices: Record<Device, { label: string; width: number }> = {
  desktop: { label: 'Desktop', width: 1440 },
  tablet: { label: 'Tablet', width: 820 },
  mobile: { label: 'Mobile', width: 390 },
};

export function MigrationPreview({ url }: { url: string }) {
  const [open, setOpen] = useState(true);
  const [device, setDevice] = useState<Device>('desktop');
  const [reload, setReload] = useState(0);
  const displayUrl = useMemo(() => {
    try { const parsed = new URL(url); return `${parsed.host}${parsed.pathname}`; }
    catch { return 'Selvedge development preview'; }
  }, [url]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  return <>
    <div className="mt-3 overflow-hidden rounded-card border border-hairline bg-panel">
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-3 py-2"><span className="text-meta font-medium text-ink">Migrated app · live development preview</span><button type="button" onClick={() => setOpen(true)} className="text-meta text-action-bright hover:underline">Open workspace preview →</button></div>
      <button type="button" onClick={() => setOpen(true)} className="group relative block h-52 w-full overflow-hidden bg-white text-left" aria-label="Open the live migration preview">
        <iframe src={url} title="Migrated app preview thumbnail" className="pointer-events-none h-[420px] w-[200%] origin-top-left scale-50 bg-white" />
        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent px-4 pb-3 pt-10 text-body font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">Open and interact with the running app</span>
      </button>
    </div>

    {open && <div className="fixed inset-0 z-[80] bg-black/30 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-label="Live migration workspace preview" className="absolute inset-y-0 right-0 flex w-full flex-col border-l border-hairline bg-canvas shadow-2xl md:w-[min(72vw,980px)]">
        <header className="border-b border-hairline bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-inset border border-hairline px-2.5 py-1.5 text-meta text-ink-dim hover:text-ink" aria-label="Close preview">Close</button>
            <div className="min-w-0 flex-1 rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 font-mono text-tech text-ink-dim"><span className="mr-2 text-healthy">●</span><span className="truncate">{displayUrl}</span></div>
            <button type="button" onClick={() => setReload((value) => value + 1)} className="rounded-inset border border-hairline px-2.5 py-1.5 text-meta text-ink-dim hover:text-ink">Reload</button>
            <a href={url} target="_blank" rel="noreferrer" className="rounded-inset border border-hairline px-2.5 py-1.5 text-meta text-action-bright">New tab ↗</a>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex rounded-inset border border-hairline bg-panel-soft p-0.5">{(Object.keys(devices) as Device[]).map((id) => <button key={id} type="button" onClick={() => setDevice(id)} aria-pressed={device === id} className={`rounded px-2.5 py-1 text-meta ${device === id ? 'bg-action text-ink' : 'text-ink-dim hover:text-ink'}`}>{devices[id].label}</button>)}</div>
            <p className="font-mono text-tech text-ink-quiet">{devices[device].width}px · isolated development copy · production untouched</p>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto bg-[#dfe3df] p-3 md:p-5">
          <div className="mx-auto h-full min-h-[520px] overflow-hidden rounded-inset border border-black/15 bg-white shadow-lg transition-[max-width] duration-200" style={{ maxWidth: `${devices[device].width}px` }}>
            <iframe key={`${url}:${reload}`} src={url} title="Migrated app live interactive preview" className="h-full min-h-[520px] w-full bg-white" />
          </div>
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-hairline bg-panel px-4 py-2 text-meta text-ink-dim"><span>Interact here while the Selvedge conversation remains open behind this panel.</span><span className="font-mono text-tech text-ink-quiet">Esc to close</span></footer>
      </section>
    </div>}
  </>;
}
