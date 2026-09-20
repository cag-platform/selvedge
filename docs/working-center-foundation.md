# Working Center foundation

This slice keeps the project as the durable center:

`Project Brain → Context Compiler → TaskContextCapsule → Agents`

The runtime underneath it is:

`Project Workspace → Workspace Coordinator → Agent Runs → provider adapters`

## State and authority

Builder runs use `queued → starting → working`, then `needs_you`, `verifying`,
`ready`, `failed`, or `cancelled`. Only the coordinator accepts lifecycle
transitions. The append-only `agent_run_events` stream is the authoritative
record; `agent_runs` is its transactionally maintained projection.

Visible facts keep their owner: the agent reports activity, Git reports files
and commits, verification reports verification, the preview adapter reports
preview state, release reports push state, and the owner reports decisions.
Consultants have their own runs but never own a writable workspace or affect a
project's builder rollup.

## Idempotency and workspace ownership

Every run has a bounded request key and capsule ID. A database partial unique
index makes retries return the original run. A project row is locked while a
builder run claims its lease. Provisioning has a second durable fence; an
ambiguous provider result keeps that fence until an explicit recovery can
inspect the recorded workspace. Opening a project, reading Home, or asking a
consultant does not provision compute.

There is one builder lease per project. The lease records its owner and expiry.
Files are checkpointed before hibernation; local secrets or unpushed commits
block hibernation because the checkpoint cannot safely preserve them. Provider
shutdown is never reported as complete when the adapter cannot confirm it.

## Polling and recovery

The thread event stream is push-driven with a heartbeat; it no longer polls the
database every 750ms. Builder CLI output uses bounded, per-run fallback polling
with backoff and stops at completion. Idle expiry is scheduled only for known
leases and restored once on startup. The previous minute-by-minute provider
sweep and nightly provider reconciliation are not used for workspace lifecycle.

Recovery is explicit and project-scoped. A recorded native session or detached
process is inspected when possible. Unknown state remains unknown and retains
ownership. A confirmed dead process is marked failed; a successful process exit
still requires owner review because exit code is not verification.

## Context capsules

The compiler creates an immutable capsule before each run. Consultants in a
parallel consultation receive the same capsule ID. A builder continuation can
compile a new capsule after an owner response; the response is stored as a
decision/reference, while the consultant's opinion remains discussion until
later evidence graduates it through Project Brain. Capsule omissions are
recorded instead of being filled with guesses.

## Next slice

The next Working Center UI should consume the existing project rollup and run
event endpoints, then add explicit `Ask`, `Compare`, and `Build` actions. It
should show one current workspace/run, its capsule receipt, changed files,
verification, and the owner actions `Respond`, `Recover`, `Review`, and
`Ship`. None of those views should create a workspace just by opening them.
