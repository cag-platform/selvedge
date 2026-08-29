# Selvedge product audit — 2026-08-28

## Product truth

Selvedge is the neutral home a project moves to when a hosted AI builder becomes expensive, limiting, or unreliable. Infrastructure remains in accounts the owner controls. Selvedge holds the project context and operating workflow; Claude, GPT, Codex, and other agents are replaceable workers.

The primary loop is:

`migrate → ask → work in a temporary workspace → preview → verify → approve → ship → destroy workspace`

## What exists now

| Journey | Current code | Status |
| --- | --- | --- |
| Project conversation | `src/client/pages/Inbox.tsx`, `src/client/components/ThreadPane.tsx` | Strong: one persistent conversation per project, polling/SSE wakeups, optimistic sends |
| Neutral worker registry | `src/shared/agents.ts`, `src/client/components/AgentMenu.tsx`, thread agent routes | Strong seam: provider, capability, model, readiness, cost, and handoff are separate |
| Temporary workspace | `src/server/build/sandbox.ts`, OpenAI container client, workshop routes | Native runtime is active; Daytona is no longer the runtime provider |
| Preview | `src/server/build/preview.ts`, preview relay, `ContextPanel.tsx` | Live embedded preview exists; now opens automatically for completed staged work |
| Context and checkpoints | packs, decisions, work cards, runs, consultations | Strong underlying model; UI still exposes more machinery than an ordinary owner needs |
| Verification | run evidence, changed paths, preview, health | Evidence exists but needs one concise owner-facing review summary |
| Ship | `ThreadPane.tsx` ship controls and authenticated GitHub push | Approval gated and working; language and hierarchy need simplification |
| Cleanup | workspace destroy after successful ship | Implemented |

## Main gaps

1. The interface still presents the machinery. The default experience must read as ask, watch, review, approve.
2. Agent selection was discoverable mainly through `@`. It now has a visible selector, but true policy-based automatic routing remains a separate backend capability and must not be implied until implemented.
3. Preview required an extra click. Completed visual work now opens the workspace automatically and starts its preview.
4. Verification is distributed across runs, evidence, preview, and ship controls. It should become a single review sheet with changed files, checks run, known limitations, destination, and one Ship action.
5. Migration onboarding is not yet the front door. Source detection, project mapping, destination selection, and original-versus-migrated verification need a dedicated flow.
6. Historic Daytona names remain in billing schema and migration history. Those must remain until a safe database migration is designed; production-facing language must be provider neutral.

## Target interfaces

```ts
interface WorkspaceRuntime {
  create(input: CreateWorkspaceInput): Promise<Workspace>;
  exec(id: string, command: Command, policy: ExecutionPolicy): Promise<ExecutionResult>;
  preview(id: string, port: number): Promise<PreviewHandle>;
  screenshot(id: string, request: ScreenshotRequest): Promise<Artifact>;
  checkpoint(id: string, label: string): Promise<Checkpoint>;
  destroy(id: string): Promise<void>;
}

interface Worker {
  id: string;
  capabilities: Array<'reason' | 'code' | 'browse' | 'visual'>;
  execute(task: WorkerTask, workspace: WorkspaceHandle): AsyncIterable<WorkerEvent>;
}

interface VerificationReport {
  changedPaths: string[];
  checks: Array<{ name: string; status: 'passed' | 'failed' | 'not_run'; detail?: string }>;
  screenshots: Artifact[];
  risks: string[];
  destination: { repository: string; branch: string; deployment?: string };
}
```

Workspace credentials must be scoped, short-lived, redacted from output, and injected only for the command that needs them. Network policy belongs to the workspace/task, not to an agent provider. Verification must be produced independently of the worker's prose and persisted as observable evidence.

## Migration sequence

1. Finish the simple conversation shell: visible neutral agent choice, automatic workspace reveal, human status language.
2. Consolidate review and ship into one approval surface backed only by observed evidence.
3. Build migration onboarding and a durable project map for repositories, databases, auth, storage, jobs, domains, secrets, and hosting.
4. Extract the runtime behind `WorkspaceRuntime`; keep OpenAI Containers as the first adapter without making it a product concept.
5. Add worker routing policy and preferences, then make “Auto” a truthful default.
6. Add independent browser verification, screenshot comparison, network policy, and short-lived secret grants.
7. Migrate historic provider-specific database names after compatibility reads and rollback paths exist.

## Execution prompts

### Stage 1 — owner workflow

> Make the project inbox feel like one ordinary AI conversation. Preserve the existing thread and agent APIs. Automatically reveal the workspace only when a completed run has staged visual work. Use human states: understanding, working, checking, ready. Keep explicit agent choice visible and neutral. Do not claim automatic routing unless a routing policy actually selected the worker.

### Stage 2 — review and ship

> Replace distributed ship controls with one evidence-backed review sheet. Show changed files, checks observed, preview/screenshot links, known limitations, repository and branch. Require an explicit Ship approval. Never infer a passed check or healthy deployment from agent text.

### Stage 3 — migration front door

> Build onboarding around “Where is your app today?” Connect a source, inspect it, produce a plain-language project map, let the owner choose neutral destinations, create a temporary development copy, compare it with the original, and request production cutover approval. Do not mutate the original environment before approval.

### Stage 4 — runtime boundary

> Introduce `WorkspaceRuntime` around the current OpenAI Container implementation. Move create, exec, preview, checkpoint, artifact, policy, and destroy operations behind it. Remove provider names from product and domain layers. Preserve behavior with contract tests.

### Stage 5 — neutral routing and verification

> Add an explicit Auto routing policy based on task capability, connected credentials, owner preference, availability, cost ceiling, and recent failures. Record why a worker was selected. Run verification through an independent verifier, persist observed evidence, and destroy the temporary workspace after successful ship or expiry.

## Risks

- “Auto” without a real routing policy would disguise provider bias.
- Preview auto-start can consume runtime; start only for staged work and retain idle teardown.
- A worker cannot be its own source of truth for verification.
- Migration needs source-specific adapters but must produce one provider-neutral project map.
- Schema renaming is operational work, not copy cleanup; historic columns require a compatible migration.
- Embedded previews need strict origin, token, iframe, secret-redaction, and network controls.
