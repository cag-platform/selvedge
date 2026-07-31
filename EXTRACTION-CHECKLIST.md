# EXTRACTION CHECKLIST

**31 July 2026.** Every asset in the three codebases, with a decision and a phase.
Companion to `BUILD-BRIEF.md`. Phase numbers refer to its build order (0–5).

Legend — **Keep** (already in the base, preserve) · **Port** (move from Toile, adapt) ·
**Fix** (exists but defective) · **Drop** (do not carry) · **Pattern** (copy the design,
not the code) · **New** (exists nowhere; build it).

---

## A. SELVEDGE — the base. Keep, and fix what's broken.

### A1. Contracts and data model — keep intact

| Asset | What it does | Phase |
|---|---|---|
| `src/shared/types/event.ts` | The event envelope. The most important contract in the system — `raw` is stored and never read downstream | 0 |
| `src/shared/types/pack.ts` + `docs/context-pack.schema.json` | The context pack: identity, stakes, topology, baselines, state, trust, voice | 0 |
| `src/server/packs/ownership.ts` | Human-owned vs machine-owned section enforcement | 0 |
| `src/server/packs/validate.ts` | ajv schema validation on every pack write | 0 |
| `src/server/packs/store.ts` | Pack CRUD, archive/mute that survives GitHub resync | 0 |
| `src/server/packs/healthLine.ts` | `deriveProjectStatus` — false-calm-first priority ordering | 0 |
| `src/server/db/schema/*` (11 files) | Org-scoped tables, ULID keys | 0 |
| `src/server/db/migrations/0000–0008` + `partitions.ts` | Versioned migrations; monthly partitioning of `events` | 0 |

### A2. The pipeline — keep

| Asset | What it does | Phase |
|---|---|---|
| `src/server/resolution/ingest.ts` | The central runtime path: normalize → resolve → route → narrate | 0 |
| `resolution/resolveProject.ts`, `refineEventType.ts`, `updatePackState.ts` | Project resolution, pack-aware event refinement, machine-section writes | 0 |
| `resolution/stallSweep.ts`, `knownFlaky.ts` | Stalled-work detection; known-flaky downgrade | 0 |
| `src/server/routing/` + `config/routing-table.json` | Deterministic routing. Rules are **data, not code**; 100% test coverage enforced | 0 |
| `src/server/narration/` (dispatch, llmFragment, library, fingerprint, verdictText, types) | Verdict-enforced narration with template fallback on any LLM failure | 0 |
| `src/server/digest/` | Gather → order → render → compose → validate → schedule | 0 |
| `src/server/llm/` (types, anthropic, fake, factory, config, metering, pricing) | Provider seam + usage row on **every** call + round-up pricing | 0 |
| `config/prompts/*.md` | Versioned prompts as files, not strings | 0 |
| `src/server/jobs/cron.ts` | Scheduled work | 0 |

### A3. Trust, memory, connectors — keep

| Asset | What it does | Phase |
|---|---|---|
| `src/server/trust/tripwire.ts` | False all-clear detection within 24h — the honesty tripwire | 0 |
| `src/server/trust/trackRecord.ts` | Published calibration (needs the fix in A6) | 0 |
| `src/server/memory/learned.ts`, `revalidate.ts`, `portability.ts` | Learned patterns, anti-rot, export/import | 0 |
| `src/server/connectors/github/` (app, webhook, hmac, normalizer, install, backfill, health) | GitHub App: per-org installs, HMAC verification, PEM normalization, 3-tier org resolution | 1 |
| `src/server/web/app.ts` + `middleware/ensureOrg.ts` | Load-bearing middleware order; blanket org guard on `/api` | 0 |
| `src/server/ask/answer.ts` | Free-text Ask with bounded context | 2 |

### A4. Interface and design system — keep

| Asset | What it does | Phase |
|---|---|---|
| `src/client/styles/tokens.css` | The single source of truth for the whole visual language | 0 |
| `src/client/components/SelvedgeEdge.tsx` | The signature seam; four-state vocabulary incl. dashed unknown | 0 |
| `tailwind.config.js` | References custom properties only — no raw values anywhere | 0 |
| Pages: Today, Projects, PackEditor, Tray, Admin, Styleguide | Existing surfaces; `/styleguide` is public and session-free by design | 0 |
| `docs/ui/DESIGN-NOTES.md` | Color rationing, type registers, accessibility floor | 0 |

### A5. Testing and CI — keep, and extend to everything ported

| Asset | What it does | Phase |
|---|---|---|
| `test/helpers/testDb.ts` | PGlite — real Postgres in WASM, same migrations as production | 0 |
| 49 test files / 387 tests | The safety net Toile arrives without (the ~238 figure quoted in `MERGE-REVIEW.md` was read from the stale default branch) | 0 |
| `evals/` (harness, run, fixtures, mockLlm, styleGrade) + golden set | Verdict preservation, thread closure, invented facts, word budget | 0 |
| `.github/workflows/test.yml`, `evals.yml` | Evals **block merge, no override flag** | 0 |

### A6. FIX before building on top — every one is a known defect

| Defect | Where | Phase |
|---|---|---|
| `DAILY_BUDGET_USD` flags but never blocks | `web/routes/admin.ts` | 0 |
| "quiet and healthy" printed without checking health | `digest/standing.ts` `quietLine` | 0 |
| Unconditional "is healthy —" in the standing line | `narration/standing.ts` `capabilityGapLine` | 0 |
| Template-fallback path omits fingerprint → "didn't help" retires nothing | `narration/dispatch.ts` | 0 |
| Phrasings graduate on silence (emission count + no complaint) | `narration/library.ts` `maybeGraduate` | 0 |
| Track record ignores collected feedback; prints "No false all-clears" from absence of detection | `trust/trackRecord.ts` `buildSummary` | 0 |
| `--ink-faint` fails AA for body text | `styles/tokens.css` + usage | 0 |
| ~~Package and central event type still named `silta` / `SiltaEvent`~~ | **DONE 31 Jul** — `package.json` → `selvedge`, `SiltaEvent`/`NewSiltaEvent` → `SelvedgeEvent`/`NewSelvedgeEvent` across 8 files; typecheck and 387 tests green | 0 |
| APNs sender never run against a real device | `push/apns.ts` | 2 |
| Stall-sweep path can't push (no sender threaded through) | `resolution/ingest.ts` | 2 |
| Four finished systems with **no user-facing surface**: trust track record, per-project memory, import, Ask | routes exist, pages don't | 2 / 5 |
| Default branch is a stale branch, not `main` | GitHub settings | 0 |

---

## B. TOILE — port these

### B1. The monitor (highest-value transfer in the merge)

| Asset | Adaptation needed | Phase |
|---|---|---|
| `server/monitor/probe.ts` | `runCheck`: HTTP + expected status, TCP connect, keyword-in-body. Add org scoping | 2 |
| `server/monitor/poller.ts` | 15s tick, per-check interval gating, in-flight dedupe, **2-failure debounce**. Emit into Selvedge's `ingest()` instead of writing status directly | 2 |
| `server/monitor/alerts.ts` | Keep the fan-out shape; route through Selvedge's routing table rather than alerting on everything | 2 |
| `app_health_checks`, `app_health_events` tables | Add `org_id`; fold into the migration chain | 2 |
| `client/src/components/UptimeBar.tsx`, `HealthCheckSection.tsx` | Restyle onto tokens | 2 |

*Why first: Selvedge's runtime event types (`runtime.health_failing`, `runtime.recovered`,
`runtime.error_rate_spike`) are already defined, routed, and narrated — with no source
producing them. This is the missing organ.*

### B2. Providers and deploy

| Asset | Adaptation needed | Phase |
|---|---|---|
| `server/providers/types.ts` | The `AppProvider` interface (getStatus, getLogs, restart, getDomains, setEnv, deploy, healthProbe) — Selvedge has no host seam at all | 1 |
| `server/providers/railway.ts`, `external.ts`, `http-probe.ts` | Port as Selvedge's first host connector; emit deploy events | 1–2 |
| `server/lib/railway.ts` (498 lines) | GraphQL: createService, resolveShipTarget, ensureServiceDomain, setServiceVariables, waitForDeploymentSuccess, triggerRedeploy. Remove the `TOILE_PROJECT_NAME` fallback; decide platform-owned vs customer-connected accounts | 1 |
| `server/routes/ship.ts` | 4-step idempotent ship; each step persists partial success | 3 |
| `server/routes/deploy.ts` | Imported-project deploy path; concurrency guards | 3 |
| `server/lib/neon.ts` | DB provisioning (42 lines) | 3 |
| `server/routes/publish.ts` | Deployment history + restart. **Read-only today — real rollback is New (E)** | 4 |

### B3. The agent engine

| Asset | Adaptation needed | Phase |
|---|---|---|
| `server/sandbox/index.ts` | `ensureSandbox`: create/resume/recreate, self-healing on dead states, in-flight dedupe, secrets via env only. Add per-org quotas; keep Daytona platform-owned | 3 |
| `server/sandbox/app-server.ts` | One dev server per sandbox; restart after successful turns | 3 |
| `server/sandbox/preview.ts` | Signed preview tokens, allowlisted hosts | 3 |
| `server/sandbox/files.ts` | Path-traversal guarding (`resolveWorkspacePath`) | 3 |
| `server/sandbox/checkpoint.ts` | Commit per turn, restore, `diffCheckpoints`. **Store diff text** so history survives sandbox death | 3 |
| `server/agent/runner.ts` (849 lines) | The heart: startRun, runClaudeTurn, planWrap, finalize-once, turn timeout with PID kill, `reconcileOrphanedRuns`. Rework `claudeCommand` for the fuel connector; **remove the skip-permissions default** in favor of risk tiers | 3 |
| `server/agent/stream-parser.ts` | stream-json → typed events | 3 |
| `server/agent/events.ts` | SSE pub/sub with seq-based replay and `Last-Event-ID` resume | 3 |
| `server/agent/workspace.ts` + `templates/claude-*.md` | Platform-owned agent contract, rewritten per turn, git-excluded | 3 |
| `reflectAndRepair` (in runner.ts) | The seed of the verification loop — extend per E | 4 |
| `server/sandbox/terminal.ts` | Keep behind an "advanced" door, not on the main surface | 3 |

### B4. Libraries and patterns

| Asset | Adaptation needed | Phase |
|---|---|---|
| `server/lib/github.ts` | `createOrgRepo`, `createPullRequest`, `branchExists` → rebase onto installation-scoped Octokit. Delete `GITHUB_ORG` and `FALLBACK_REPOS`. **Design the expiring-token handoff into long-lived sandboxes** | 1 |
| `server/lib/shell.ts` | `shellQuote` — the centralized injection boundary. Port as-is | 3 |
| `server/lib/secrets.ts` | AES-256-GCM project secrets. Derive keys per-org; do not reuse one root secret for sessions + secrets + tokens | 1 |
| `server/lib/email.ts`, `push.ts` | Email and web-push channels behind Selvedge's notifier seam (its only channel, APNs, is unverified) | 2 |
| `server/lib/costs.ts` | Daily/weekly/monthly aggregation, per-project and per-model. Merge into `llm_usage` so there is **one** spend surface | 5 |
| `server/lib/env.ts` | `validateEnv` fail-fast at boot | 0 |
| `server/routes/mcp.ts` | The machine-authed endpoint pattern (HMAC-derived bearer, timing-safe compare) — the shape for any agent-facing API | 3 |
| `businesses` table + `starred` | Grouping and pinning — Selvedge can do neither | 1 |
| `client/src/lib/useBuildStream.ts` | SSE consumer with reconnect/replay | 3 |
| `client/src/components/` Composer, Thread, BuildStrip, RunsList, DiffView | The build experience. **Restyle onto tokens; demote from home screen to a room** | 3 |

---

## C. TOILE — drop

| Asset | Why |
|---|---|
| `server/auth/*` (session, middleware, routes) | Single shared passkey; Selvedge has Clerk orgs |
| `server/providers/render.ts`, `fly.ts` | Every method throws — placeholder stubs |
| `GITHUB_ORG = 'cag-platform'`, `FALLBACK_REPOS` | Hardcoded single-org assumptions |
| `server/lib/memory.ts` + `memory_entries` | Global-across-projects substring scratchpad; a cross-tenant leak by design. Selvedge's memory is better in every dimension |
| `app_ops_events` | Subsumed by Selvedge's `events` (keep the `actor` concept as a column) |
| `settings` singleton table | "Exactly one row" — incompatible with tenancy |
| `client/src/components/CostDashboard.tsx` | Rebuild. It displays a budget, a "then stops" promise, and an 80% warning for a cap that no longer exists |
| `CodeEditor.tsx`, `FileTree.tsx`, `FileTabs.tsx`, `useFileBuffers.ts` | The editor as a primary surface belongs to a different product thesis |
| Chat-as-home layout (`ProjectView` shell) | Keep the machinery, drop the information architecture |
| `drizzle-kit push` workflow | Replaced by Selvedge's versioned migration chain |
| iOS/Capacitor shell | Selvedge has its own native track |

---

## D. SILD — patterns only. No code moves.

| Pattern | Where to look | Applied as |
|---|---|---|
| **Risk tiering** | `translationRuleClassification.ts` (repo root, unwired): `PROTECTED_PATTERNS`, `detectProtectedFamilies`, `classifyGlossaryCandidate` | Code-change risk classes: payments/auth/user-data → hard gate + verified backup; ordinary logic → normal approval; copy/styling → near-frictionless. **Phase 3** |
| **Shadow → enforce ladder** | `server/lib/translationRuleLifecycle.ts`: mode resolution, `organizationReadiness` (≥20 samples, ≥95% pass, 30-day window) | New autonomy rules run silently and log what they *would* have done before they gate anything. **Phase 3** |
| **Auto-graduation policy** | `decideAutoGraduation` (unwired): allowlist + confidence + evidence + conflict thresholds | Earned autonomy per risk class, one bad outcome demotes instantly. **Phase 5** |
| **Canonical dedupe signature** | `server/kpack-signature.ts` | **Failure fingerprinting** for convergence detection — the same trick applied to repeated agent failures. **Phase 3** |
| **Append-only audit via DB trigger** | `server/auditIntegrity.ts`, `migrations/0004_audit_append_only.sql` | The intent→outcome ledger must be tamper-evident at the database layer, not by convention. **Phase 5** |
| **Atomic cross-replica claims** | `server/rateLimitStore.ts`; conditional `UPDATE ... WHERE status='pending' RETURNING id` | Concurrency for task claiming and approval races. **Phase 3** |
| **Privacy discipline** | Governance rows carry family names and reason codes, never content | Ledger and telemetry carry classifications, not customer code. **Phase 5** |

**The four lessons (why SILD's version failed — do not repeat):**
1. Compute the risk **at the decision point**; never accept it as an optional input a
   caller can forget to pass. That single omission made every downstream guard inert.
2. Sample **rejections and failures**, not just approvals, or the pass rate is
   survivorship bias by construction.
3. No global environment override that skips a per-tenant readiness gate.
4. Keep dead-code detection and the test glob pointed at the whole repo — SILD's CI
   structurally could not see the orphaned modules.

---

## E. NEW — exists in none of the three codebases

| Capability | Notes | Phase |
|---|---|---|
| **Fuel connector (BYO)** | Per-org model credentials, revocable, provider-agnostic seam; ship one provider | 1 |
| **Supabase connector** | Read-only posture first | 1 |
| **Migration/onboarding flow** | Moving an app in is the real acquisition cost; productize or it becomes services | 1 |
| **Cost estimator** | Quote from per-failure-class historical distributions (p50 estimate, p90 cap). Both repos know cost only *after* | 3 |
| **A spend cap that blocks** | Neither repo has one. Pre-flight check + hard stop, tested to fail if it goes inert | 3 |
| **Staged budget checkpoints** | "40% in, $58 of $150, continue?" — prevents burn-with-nothing-delivered | 3 |
| **Owner-initiated change intake** | The second trigger into the same card grammar | 3 |
| **Risk classifier for code changes** | Per D | 3 |
| **Convergence detection** | Fingerprint failures; stop on the same signature twice. Both repos have flat retry caps only | 3 |
| **The card grammar UI** | Propose → estimate → stop-point → approve, at three registers | 3 |
| **Five-value repair verdict** | verified / probably / inconclusive / didn't work / stopped. Toile's is binary; Selvedge's verdicts describe apps, not repairs | 4 |
| **Generated smoke checks** | Most of these apps have no test suite — the harness must create one | 4 |
| **Regression harness** | Everything that worked before still works | 4 |
| **Acceptance check from request** | The only way to verify net-new work | 4 |
| **Authoring/evaluating separation** | Different models, enforced | 4 |
| **Deploy rollback** | Toile has *checkpoint* restore (sandbox-local) and read-only deploy history. Redeploying a previous version does not exist | 4 |
| **Intent→outcome ledger** | Append-only; powers estimates, memory, and the track record | 5 |
| **Per-class cost distributions** | The moat metric: cost per success falling with tenure | 5 |

---

## F. ORDER OF OPERATIONS

1. **Phase 0** — A6 fixes, tenancy, migrations, default branch, `env.ts`, tests for everything inbound.
2. **Phase 1** — B2 providers + B4 github/secrets + E connectors → the protection brief.
3. **Phase 2** — B1 monitor → the watched app. *Highest value per week of work.*
4. **Phase 3** — B3 engine + D risk tiering + E estimator/caps/cards → the worked app.
5. **Phase 4** — E verification set + rollback → trustworthy verdicts.
6. **Phase 5** — E ledger + B4 costs + A6 dark surfaces → memory that pays.

Nothing in Phase 3 starts before A6's inert-guard fixes land. That is the one ordering
rule with a reason behind it rather than a preference: three separate guards in these
repositories were shipped dead, and Phase 3 is where a dead guard costs real money.
