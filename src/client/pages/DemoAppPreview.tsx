/**
 * A real, reproducible app surface for the isolated Northstar marketing seed.
 *
 * This is deliberately a public, static page rather than a fake repository or
 * a paid development workspace. The seeded Relay project points at it as its
 * live URL, so the ordinary workspace can demonstrate an active embedded app
 * without claiming that invented code was cloned, built, or verified.
 */
export function DemoAppPreview() {
  return (
    <main className="min-h-screen bg-[#f4efe4] p-5 font-body text-[#173428] sm:p-8" data-theme="light">
      <div className="mx-auto max-w-3xl overflow-hidden rounded-[1.5rem] border border-[#173428]/10 bg-[#fffdf8] shadow-[0_24px_80px_rgba(23,52,40,0.12)]">
        <header className="flex items-center justify-between border-b border-[#173428]/10 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#508060]">Relay</p>
            <h1 className="mt-1 text-xl font-semibold">Today’s shift handoff</h1>
          </div>
          <span className="rounded-full bg-[#dcebdc] px-3 py-1 text-xs font-semibold text-[#285f3d]">All systems normal</span>
        </header>

        <section className="grid gap-4 p-6 sm:grid-cols-[1.45fr_0.8fr]">
          <article className="rounded-2xl bg-[#173428] p-6 text-[#fffdf8]">
            <p className="text-xs uppercase tracking-[0.18em] text-[#b8d0bd]">North region · Crew 3</p>
            <h2 className="mt-3 text-2xl font-semibold">Ridgeway service complete</h2>
            <p className="mt-3 max-w-lg leading-relaxed text-[#dce8df]">Gate code confirmed. Replacement valve is holding pressure. The afternoon crew only needs to collect the temporary barriers.</p>
            <div className="mt-6 flex items-center gap-3 text-sm">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-[#6ba67a] font-semibold">AN</span>
              <span><strong className="block">Avery Northstar</strong><small className="text-[#b8d0bd]">Updated 8 minutes ago</small></span>
            </div>
          </article>

          <aside className="space-y-4">
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
