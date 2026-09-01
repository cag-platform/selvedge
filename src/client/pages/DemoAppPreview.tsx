/**
 * A real, reproducible app surface for the isolated Northstar marketing seed.
 *
 * This is deliberately a public, static page rather than a fake repository or
 * a paid development workspace. The seeded Relay project points at it as its
 * live URL, so the ordinary workspace can demonstrate an active embedded app
 * without claiming that invented code was cloned, built, or verified.
 */
export function DemoAppPreview({ embedded = false }: { embedded?: boolean }) {
  return (
    <main className={`${embedded ? 'demo-app-embedded h-full p-3' : 'min-h-screen p-5 sm:p-8'} bg-[#f4efe4] font-body text-[#173428]`} data-theme="light">
      <div className={`${embedded ? 'rounded-xl' : 'mx-auto max-w-3xl rounded-[1.5rem] shadow-[0_24px_80px_rgba(23,52,40,0.12)]'} overflow-hidden border border-[#173428]/10 bg-[#fffdf8]`}>
        <header className={`flex items-center justify-between border-b border-[#173428]/10 ${embedded ? 'px-3 py-3' : 'px-6 py-5'}`}>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#508060]">Relay</p>
            <h1 className={`${embedded ? 'text-sm' : 'text-xl'} mt-1 font-semibold`}>Today’s shift handoff</h1>
          </div>
          <span className="rounded-full bg-[#dcebdc] px-3 py-1 text-xs font-semibold text-[#285f3d]">All systems normal</span>
        </header>

        <section className={`${embedded ? 'p-3' : 'grid gap-4 p-6 sm:grid-cols-[1.45fr_0.8fr]'}`}>
          <article className={`${embedded ? 'rounded-xl p-3' : 'rounded-2xl p-6'} bg-[#173428] text-[#fffdf8]`}>
            <p className="text-xs uppercase tracking-[0.18em] text-[#b8d0bd]">North region · Crew 3</p>
            <h2 className={`${embedded ? 'mt-2 text-base' : 'mt-3 text-2xl'} font-semibold`}>Ridgeway service complete</h2>
            <p className={`${embedded ? 'mt-2 text-xs' : 'mt-3'} max-w-lg leading-relaxed text-[#dce8df]`}>Gate code confirmed. Replacement valve is holding pressure. The afternoon crew only needs to collect the temporary barriers.</p>
            <div className={`${embedded ? 'mt-3' : 'mt-6'} flex items-center gap-3 text-sm`}>
              <span className="grid h-9 w-9 place-items-center rounded-full bg-[#6ba67a] font-semibold">AN</span>
              <span><strong className="block">Avery Northstar</strong><small className="text-[#b8d0bd]">Updated 8 minutes ago</small></span>
            </div>
          </article>

          <aside className={`${embedded ? 'mt-2 grid grid-cols-2 gap-2' : 'space-y-4'}`}>
            <div className="rounded-2xl border border-[#173428]/10 p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-[#6a766e]">Next stop</p>
              <p className="mt-2 font-semibold">Mesa Commons</p>
              <p className="mt-1 text-sm text-[#66736b]">Arrival window · 2:15–2:45 PM</p>
            </div>
            <div className="rounded-2xl bg-[#e9f1e8] p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-[#4f6e58]">Handoff quality</p>
              <p className="mt-2 text-3xl font-semibold">96%</p>
              <p className="mt-1 text-sm text-[#54705c]">Everything the next crew needs is attached.</p>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
