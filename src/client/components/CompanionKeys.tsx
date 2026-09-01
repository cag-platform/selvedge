import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { btnPrimary, EmptyState } from './ui.js';

/**
 * YOUR MACHINES — where the loop is switched on.
 *
 * A key per machine, shown exactly once. The copy has one job beyond the
 * mechanics: to be precise about what the companion sends, because "a daemon
 * that watches your coding sessions" is a sentence that deserves suspicion and
 * the honest answer is the reason it's safe to say yes to.
 */

type Key = { id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null };
type AppleRuntime = { id: string; name: string; xcodeVersion: string; macosVersion: string; lastSeenAt: string; online: boolean };
type AgentRuntime = { id: string; name: string; capabilities: { codex: boolean; claudeCode: boolean }; lastSeenAt: string; online: boolean };

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2 rounded-inset border border-hairline bg-panel-soft px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-tech text-ink">{command}</code>
      <button
        type="button"
        onClick={() => void navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        })}
        className="shrink-0 text-meta text-action hover:text-action-bright"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function SetupStep({ number, title, complete, children }: { number: number; title: string; complete: boolean; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 border-t border-hairline py-4 first:border-t-0 first:pt-0 last:pb-0">
      <span className={`flex h-7 w-7 items-center justify-center rounded-full border text-meta ${complete ? 'border-action bg-action text-white' : 'border-hairline bg-panel-soft text-ink-dim'}`} aria-label={complete ? 'Complete' : `Step ${number}`}>
        {complete ? '✓' : number}
      </span>
      <div>
        <h4 className="text-body font-medium text-ink">{title}</h4>
        <div className="mt-1 text-meta text-ink-dim">{children}</div>
      </div>
    </li>
  );
}

function AppleRuntimeGuide({ keys, runtimes }: { keys: Key[]; runtimes: AppleRuntime[] }) {
  const activeKeys = keys.filter((key) => !key.revoked_at);
  const onlineRuntime = runtimes.find((runtime) => runtime.online);
  const companionSeen = activeKeys.some((key) => key.last_used_at) || Boolean(onlineRuntime);
  const [test, setTest] = useState<{ id?: string; state: string; message?: string } | null>(null);

  async function testConnection() {
    setTest({ state: 'queued', message: 'Waiting for your Mac…' });
    try {
      const started = await api.post<{ job_id: string; state: string }>('/api/apple-runtime/test', {});
      setTest({ id: started.job_id, state: started.state, message: 'Waiting for your Mac…' });
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const status = await api.get<{ state: string; result?: { xcodeVersion?: string; simulatorName?: string }; error?: string }>('/api/apple-runtime/test/' + started.job_id);
        if (status.state === 'succeeded') {
          setTest({ id: started.job_id, state: status.state, message: `${status.result?.xcodeVersion?.split('\n')[0] ?? 'Xcode'} · ${status.result?.simulatorName ?? 'iPhone Simulator'} ready` });
          return;
        }
        if (status.state === 'failed') {
          setTest({ id: started.job_id, state: status.state, message: status.error ?? 'The Mac could not complete the test.' });
          return;
        }
        setTest({ id: started.job_id, state: status.state, message: status.state === 'running' ? 'Xcode is checking the Simulator…' : 'Waiting for your Mac…' });
      }
      setTest({ id: started.job_id, state: 'waiting', message: 'The Mac did not answer. Make sure the runtime Terminal window is still open.' });
    } catch (error) {
      setTest({ state: 'failed', message: error instanceof Error ? error.message : 'The connection test did not start.' });
    }
  }

  return (
    <section className={`overflow-hidden rounded-card border ${onlineRuntime ? 'border-action/40 bg-action-soft/40' : 'border-hairline bg-panel'}`}>
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
        <div className="max-w-2xl">
          <p className="text-label font-body uppercase tracking-widest text-ink-quiet">Apple apps</p>
          <h3 className="mt-1 text-headline font-medium text-ink">Connect your Mac</h3>
          <p className="mt-1 text-body text-ink-dim">Build and test Apple apps on this Mac.</p>
        </div>
        <span className={`rounded-full px-3 py-1.5 text-meta font-medium ${onlineRuntime ? 'bg-action text-white' : 'bg-panel-soft text-ink-quiet'}`}>
          {onlineRuntime ? 'Mac connected' : 'Not connected yet'}
        </span>
      </div>

      {onlineRuntime ? (
        <div className="border-t border-hairline px-5 py-4">
          <p className="text-body text-ink"><strong>{onlineRuntime.name}</strong> is ready for Apple work.</p>
          <p className="mt-1 text-meta text-ink-dim">{onlineRuntime.xcodeVersion.split('\n')[0]} ready · Keep Selvedge for Mac open.</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void testConnection()} disabled={test?.state === 'queued' || test?.state === 'running'} className={btnPrimary}>
              {test?.state === 'queued' || test?.state === 'running' ? 'Testing…' : 'Test connection'}
            </button>
            {test?.message && <span className={`text-meta ${test.state === 'failed' || test.state === 'waiting' ? 'text-thread' : test.state === 'succeeded' ? 'text-action' : 'text-ink-dim'}`}>{test.message}</span>}
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-meta text-action">Show setup and troubleshooting</summary>
            <div className="mt-3"><AppleSetupSteps activeKey={true} companionSeen={true} connected={true} /></div>
          </details>
        </div>
      ) : (
        <div className="border-t border-hairline px-5 py-4">
          <AppleSetupSteps activeKey={activeKeys.length > 0} companionSeen={companionSeen} connected={false} />
        </div>
      )}

      <div className="border-t border-hairline bg-panel-soft px-5 py-3 text-meta text-ink-dim">Signing credentials stay on your Mac.</div>
    </section>
  );
}

function AppleSetupSteps({ activeKey, companionSeen, connected }: { activeKey: boolean; companionSeen: boolean; connected: boolean }) {
  return (
    <>
      <ol>
        <SetupStep number={1} title="Prepare Xcode" complete={connected}>
          <p>Open Xcode once and install an iOS Simulator.</p>
        </SetupStep>
        <SetupStep number={2} title="Install the Selvedge companion" complete={companionSeen}>
          <p>Open Terminal on the Mac and install the small connection program.</p>
          <CopyCommand command="curl -fsSL https://tryselvedge.com/install-companion | sh" />
        </SetupStep>
        <SetupStep number={3} title="Connect this Mac to your Selvedge account" complete={activeKey}>
          {activeKey
            ? <p>This Mac needs its own connection.</p>
            : <p>Use <strong>Make a key</strong> below. Name it something recognizable, such as “Greg’s MacBook,” then copy the login command shown once.</p>}
        </SetupStep>
        <SetupStep number={4} title="Turn on the Apple runtime" complete={connected}>
          <p>Open Selvedge for Mac and keep it running.</p>
          <CopyCommand command="$HOME/.local/bin/selvedge runtime apple" />
          {!connected && <p className="mt-2">This page will change to <strong>Mac connected</strong> automatically when Xcode and Simulator are ready.</p>}
        </SetupStep>
      </ol>
      <details className="mt-4 rounded-inset border border-hairline bg-panel-soft px-3 py-2">
        <summary className="cursor-pointer text-meta text-ink">Something not working?</summary>
        <div className="mt-2 space-y-2 text-meta text-ink-dim">
          <p><strong className="text-ink">“xcodebuild not found”</strong> — install Xcode, open it once, then run <code className="font-mono text-tech">sudo xcode-select -s /Applications/Xcode.app</code>.</p>
          <p><strong className="text-ink">No iPhone Simulator</strong> — open Xcode → Settings → Components and install an iOS runtime.</p>
          <p><strong className="text-ink">License not accepted</strong> — open Xcode and accept it, or run <code className="font-mono text-tech">sudo xcodebuild -license accept</code>.</p>
          <p><strong className="text-ink">It was connected and went offline</strong> — return to the Terminal window and run <code className="font-mono text-tech">$HOME/.local/bin/selvedge runtime apple</code> again.</p>
        </div>
      </details>
    </>
  );
}

export function CompanionKeys() {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [appleRuntimes, setAppleRuntimes] = useState<AppleRuntime[]>([]);
  const [agentRuntimes, setAgentRuntimes] = useState<AgentRuntime[]>([]);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairCode] = useState(() => new URLSearchParams(window.location.search).get('pair'));
  const [pairState, setPairState] = useState<'idle' | 'approving' | 'approved' | 'failed'>('idle');

  const load = useCallback(() => {
    api
      .get<{ keys: Key[]; apple_runtimes: AppleRuntime[]; agent_runtimes: AgentRuntime[] }>('/api/companion-keys')
      .then((r) => { setKeys(r.keys); setAppleRuntimes(r.apple_runtimes ?? []); setAgentRuntimes(r.agent_runtimes ?? []); })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const made = await api.post<{ token: string }>('/api/companion-keys', { name: name.trim() || 'a machine' });
      setIssued(made.token);
      setName('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "that didn't go through");
    }
  }

  async function revoke(id: string) {
    await api.del(`/api/companion-keys/${id}`).catch(() => undefined);
    load();
  }

  async function approveMac() {
    if (!pairCode) return;
    setPairState('approving');
    setError(null);
    try {
      await api.post(`/api/companion-pairings/${encodeURIComponent(pairCode)}/approve`, {});
      setPairState('approved');
      window.history.replaceState({}, '', window.location.pathname);
      load();
    } catch (err) {
      setPairState('failed');
      setError(err instanceof Error ? err.message : 'That Mac could not be approved.');
    }
  }

  return (
    <section className="space-y-3">
      {pairCode && pairState !== 'approved' && (
        <div className="rounded-card border border-action/40 bg-action-soft px-5 py-4">
          <p className="text-label font-body uppercase tracking-widest text-ink-quiet">Selvedge for Mac</p>
          <h2 className="mt-1 text-headline font-medium text-ink">Allow this Mac?</h2>
          <p className="mt-1 text-body text-ink-dim">Approve only if you started this on your Mac.</p>
          <button type="button" onClick={() => void approveMac()} disabled={pairState === 'approving'} className={`${btnPrimary} mt-3`}>
            {pairState === 'approving' ? 'Connecting…' : 'Allow this Mac'}
          </button>
        </div>
      )}
      {pairState === 'approved' && (
        <div className="rounded-card border border-action/40 bg-action-soft px-5 py-4 text-body text-ink">
          <strong>Mac connected.</strong>
        </div>
      )}
      <div>
        <h2 className="text-headline font-medium text-ink">Your machines</h2>
        <p className="mt-1 max-w-xl text-body text-ink-dim">Connect this computer to Selvedge.</p>
      </div>

      <details className="rounded-card border border-hairline bg-panel-soft px-4 py-3">
        <summary className="cursor-pointer text-body text-ink">What actually leaves your machine</summary>
        <div className="mt-2 space-y-2 text-body text-ink-dim">
          <p>Shared:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Tool and session ID</li>
            <li>Time and project</li>
            <li>Changed file paths</li>
            <li>Result, commit, and cost</li>
          </ul>
          <p className="text-ink">Session watching never shares conversations, code, or diffs.</p>
          <p>When you ask a local agent to build, Selvedge privately sends that project workspace to this computer and receives the changed workspace back.</p>
          <p className="text-ink">Provider logins and subscription credentials never leave this computer.</p>
        </div>
      </details>

      {keys && <AppleRuntimeGuide keys={keys} runtimes={appleRuntimes} />}

      {keys && (() => {
        const runtime = agentRuntimes.find((row) => row.online);
        return (
          <section className={`rounded-card border px-5 py-4 ${runtime ? 'border-action/40 bg-action-soft/40' : 'border-hairline bg-panel'}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-label uppercase tracking-widest text-ink-quiet">Your coding subscriptions</p>
                <h3 className="mt-1 text-headline font-medium text-ink">Codex and Claude Code</h3>
                <p className="mt-1 text-body text-ink-dim">Selvedge uses the accounts already signed in on your computer.</p>
              </div>
              <span className={`rounded-full px-3 py-1.5 text-meta font-medium ${runtime ? 'bg-action text-white' : 'bg-panel-soft text-ink-quiet'}`}>{runtime ? 'Connected' : 'Not connected'}</span>
            </div>
            {runtime ? (
              <div className="mt-4 border-t border-hairline pt-3 text-body text-ink">
                <strong>{runtime.name}</strong> · {[runtime.capabilities.codex ? 'Codex' : '', runtime.capabilities.claudeCode ? 'Claude Code' : ''].filter(Boolean).join(' + ')}
                <p className="mt-1 text-meta text-ink-dim">Usage is charged to your subscriptions. Login credentials stay on this computer.</p>
              </div>
            ) : (
              <ol className="mt-4 border-t border-hairline pt-3">
                <SetupStep number={1} title="Sign in to your agents" complete={false}><p>Run <code className="font-mono text-tech">codex login</code> and open <code className="font-mono text-tech">claude</code> once to sign in.</p></SetupStep>
                <SetupStep number={2} title="Connect them to Selvedge" complete={false}><CopyCommand command="$HOME/.local/bin/selvedge runtime agents" /><p className="mt-2">Keep that window open while Selvedge works.</p></SetupStep>
              </ol>
            )}
            <div className="mt-4 border-t border-hairline pt-3 text-meta text-ink-dim">No automatic API fallback. If this computer is offline, Selvedge stops and tells you.</div>
          </section>
        );
      })()}

      {issued && (
        <div className="space-y-2 rounded-card border border-hairline border-l-2 border-l-action-bright bg-panel px-4 py-3">
          <p className="text-body text-ink">Copy this now; it’s shown only once.</p>
          <p className="select-all break-all font-mono text-tech text-ink">{issued}</p>
          <div className="space-y-1 font-mono text-tech text-ink-quiet">
            <p>curl -fsSL https://tryselvedge.com/install-companion | sh</p>
            <p>$HOME/.local/bin/selvedge login --token {issued.slice(0, 8)}…</p>
            <p>$HOME/.local/bin/selvedge watch</p>
            <p>$HOME/.local/bin/selvedge runtime apple</p>
            <p>$HOME/.local/bin/selvedge runtime agents</p>
          </div>
          <details className="text-meta text-ink-quiet">
            <summary className="cursor-pointer">Advanced setup</summary>
            <p className="mt-2 font-mono text-tech">claude mcp add selvedge-context -- selvedge context</p>
          </details>
        </div>
      )}

      <form onSubmit={mint} className="flex flex-wrap items-center gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="what to call this machine"
          className="min-w-[14rem] flex-1 rounded-inset border border-hairline bg-panel-soft px-3 py-1.5 text-body text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright"
        />
        <button type="submit" className={btnPrimary}>
          Make a key
        </button>
        {error && <span className="text-meta text-thread">{error}</span>}
      </form>

      {keys && keys.length === 0 && (
        <EmptyState>
          The companion hasn&rsquo;t seen a session yet. Install with{' '}
          <span className="font-mono text-tech">$HOME/.local/bin/selvedge</span> &mdash; summaries appear here, code never leaves
          your machine.
        </EmptyState>
      )}

      {keys && keys.length > 0 && (
        <ul className="divide-y divide-hairline rounded-card border border-hairline bg-panel">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
              <div className="min-w-0">
                <p className="truncate text-body text-ink">
                  {key.name}
                  {key.revoked_at && <span className="ml-2 text-meta text-ink-quiet">stopped working</span>}
                </p>
                <p className="text-meta text-ink-quiet">
                  {key.last_used_at ? `last used ${new Date(key.last_used_at).toLocaleString()}` : 'never used'}
                </p>
              </div>
              {!key.revoked_at && (
                <button onClick={() => void revoke(key.id)} className="text-meta text-ink-quiet hover:text-thread">
                  Stop this key
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
