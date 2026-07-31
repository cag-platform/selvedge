# OPERATIONS BRIEF — security and customer service

**31 July 2026.** Companion to `BUILD-BRIEF.md`. What must be true operationally, and
what transfers from SILD. Phase numbers refer to the build brief's sequence.

---

## 1. THE THREAT MODEL IS NOT THE ONE EITHER CODEBASE WAS BUILT FOR

SILD defends user-generated content, uploads, and business PII. Toile defends one person's
own tools. Selvedge is a different animal:

> **Selvedge holds repository write access, production deploy rights, database access and
> secrets custody for every customer — and it runs AI agents over text that attackers can
> influence.** Compromising Selvedge means compromising every customer's production app at
> once.

That makes it a supply-chain target, and it sets a materially higher bar than either
source project cleared. Three consequences worth stating plainly: the blast radius of a
single mistake is all customers, not one; the agent reads attacker-writable text (logs,
error strings, README files, dependency names) as part of normal operation; and the
product's entire market position is honesty, so a mishandled incident costs more here
than the same incident would cost a competitor.

---

## 2. WHAT TRANSFERS FROM SILD

SILD's security engineering is the strongest of the three codebases. These are the parts
that apply. **Patterns, not files** — the code is written against SILD's schema.

| From SILD | Where to look | Why it matters here | Phase |
|---|---|---|---|
| **Append-only audit via database trigger** | `server/auditIntegrity.ts`, `migrations/0004_audit_append_only.sql` — triggers installed at boot | The intent→outcome ledger is the entire trust mechanism. "We publish our own misses" is worthless if rows can be edited afterwards. Enforce immutability at the database layer, never by convention | 5 (design in 0) |
| **Fail-closed boot validation** | `validateEnvironment()` + `validateAiGovernance()` run *before* the app is constructed | Toile's `validateEnv` covers env presence. SILD adds the important half: **the model endpoint is https-only and host-allowlisted**. An agent pointable at an arbitrary "AI endpoint" is a code-exfiltration channel | 0 |
| **Metadata-only logging** | Request logging never serializes bodies; `translation_failures` stores no source or target text | Selvedge's equivalent: task records store classifications, file paths and outcomes — **never source code, secrets, or log contents**. This is the single discipline most likely to be eroded by a debugging session at 2am | 0 |
| **Notification redaction** | `redactNotificationBody` in push notifications | An incident alert on a lock screen must not carry code, credentials, or customer data | 2 |
| **Atomic cross-replica rate limiting** | `server/rateLimitStore.ts` — Postgres upsert, correct across instances | In-memory limiters lie the moment there are two processes | 1 |
| **Auth rate limiting + security headers + CORS allowlist** | `server/index.ts` ordering, `server/securityHeaders.ts` | Standard, and the ordering is load-bearing — raw-body routes must mount before the JSON parser | 1 |
| **Session store degradation** | Falls back to a short in-memory cache on transient DB errors instead of 500ing | Availability without dropping authentication | 1 |
| **Upload validation** | `validateFileMagicBytes` — verifies content, not extension; throws and unlinks | Applies to any attachment path (screenshots on a change request) | 3 |
| **HTML sanitisation** | DOMPurify allowlist at every `dangerouslySetInnerHTML` | Agent output is rendered in the UI. Treat it as untrusted | 2 |
| **MFA + SSO** | `server/lib/mfa.ts`, `@node-saml/node-saml`, `openid-client` | An account takeover here means arbitrary code deployed to the customer's production. **MFA should be strongly encouraged at signup and required before write access is granted** | 3 |
| **Retention and data-residency machinery** | `server/lib/retention.ts`, `retention-cron.yml`, `docs/COMPLIANCE.md`, `docs/AI_DATA_FLOW.md` | Templates for the compliance ladder in §6 | 4+ |
| **TLS enforcement to Postgres** | `PG_TLS_ENFORCE` | Turn it **on**, unlike SILD | 0 |

### The lesson that matters more than any of the code

SILD's security features are largely well-built and largely **switched off**: six
`*_ENFORCE` flags — request validation, bot check, CSP, AI budget, database TLS, retention
attestation — all default to monitor mode, and nothing in the repository ever turns them
on. Login and registration requests are validated, the failures logged as "would reject,"
and then allowed through.

Monitor-mode-first is a sound rollout strategy. It becomes theatre when nothing ever
completes the rollout. **Every enforcement flag Selvedge ships must have a dated owner and
a graduation criterion recorded at the moment it is written**, and a test that fails when
a guard stops guarding. This is the same defect as the inert governance gate, the ghost
spend cap, and the flag-only budget — four instances across three codebases, which makes
it a house pattern rather than an accident.

---

## 3. NET-NEW SECURITY — neither codebase has faced these

| Threat | Control | Phase |
|---|---|---|
| **Prompt injection from repo content, logs and error strings** | The agent reads attacker-writable text as routine input. Treat all ingested text as hostile: never let it authorise an action. The gate is structural — **risk tier and approval are computed from the diff and the file paths, never from anything the model was told** | 3 |
| **Agent runs with permission checks disabled** | Toile ships `--dangerously-skip-permissions`. Defensible for one person in their own sandbox; unacceptable multi-tenant. Risk tiering replaces it | 3 |
| **Malicious dependencies** | The agent runs installs. Lockfile-only installs where possible, no post-install scripts on untrusted additions, and dependency changes classified money-critical (they are a known attack path) | 3 |
| **Credential exfiltration from sandboxes** | Short-lived, narrowly-scoped, per-task tokens. Never a long-lived org-wide credential. GitHub App tokens expire hourly and sandboxes outlive them — design the refresh, don't extend the token | 1 |
| **Sandbox egress** | Restrict outbound network from sandboxes to what a build needs. A compromised sandbox must not be able to post customer source anywhere it likes | 3 |
| **Cross-tenant leakage** | Sandboxes are platform-owned and pooled. One tenant per sandbox, destroyed after use, never reused across orgs | 3 |
| **Deploy blast radius** | The agent can push to production. Hard gates on money/auth/data paths, verified backup before schema changes, and **no autonomous data-destructive operation, ever** — the Replit database deletion is the category's permanent lesson | 3–4 |
| **Account takeover** | See MFA above. Also: approval actions should be re-authenticated when the risk tier is high, and every approval recorded with actor and timestamp in the append-only ledger | 3 |
| **Secrets key separation** | Toile derives session signing, secret encryption and machine tokens from one `SESSION_SECRET`. Rotating it invalidates sessions *and* makes stored secrets undecryptable. Separate the roots | 1 |
| **The customer's own model credential** | Under BYO, Selvedge holds a token that can spend the customer's money. Encrypt at rest with a distinct key, scope it, make revocation one click, and never log it | 1 |

---

## 4. CUSTOMER SERVICE — the product is the first line

The brief, the honest verdict and the ledger *are* the support surface. Most of what a
competitor answers in a ticket, this product should answer before the customer asks. That
is the design goal, and it is also the economic one: a solo operator cannot staff a
support desk for a $99 product.

What remains for humans, and what has to be built to keep it small:

| Need | The answer | Build or policy | Phase |
|---|---|---|---|
| **1am coverage** | The *product* covers 1am; humans cover business hours. Say this explicitly on the pricing page rather than implying always-on humans | Policy | pre-launch |
| **"It couldn't fix it" — the stranded customer** | A **handoff dossier**: what was tried, each attempt's verdict, the diff, relevant logs, what's known about the app. The customer hands it to a freelancer. This is productised escalation *without* becoming an agency (§7 of the review) | Build | 4 |
| **Selvedge broke my app** | The highest-stakes scenario. Defined path: detect → revert → notify the owner in plain language → Class-1 entry in the ledger → follow up with what changed. Never quiet, never spun | Build + policy | 4 |
| **Is Selvedge itself down?** | A public status page. If the caretaker is unreachable the customer must be able to find out without asking. Neither codebase has one | Build | 2 |
| **Onboarding / migration** | Concierge is correct for the first cohort and must be productised before scale — migration friction is the real acquisition cost | Build | 1 |
| **"I paid and it didn't work"** | A written **no-fix-no-fee policy**: what counts as not working, who decides, how quickly the credit appears. Ambiguity here destroys more trust than the failure did | Policy | pre-launch |
| **"Why is it slow / erroring?" under BYO** | Provider rate limits and outages become *your* support queue (§25). The product must diagnose and say so plainly: *"your Claude account hit its limit at 2pm — this isn't your app"* | Build | 3 |
| **Billing, plan changes, fuel disconnects** | An expired or revoked model credential silently stops the product working. Detect it, surface it in the brief, and email before the customer notices | Build | 1 |
| **Leaving** | Export already exists. Make offboarding easy and dignified — the anti-lock-in posture is a trust play, not a leak | Build (exists) | — |
| **"What can it actually do?"** | Published scope: supported stacks, supported change classes, what gets refused and why, and what things cost. Most pre-sales questions are scope questions | Content | pre-launch |
| **Complaints reaching the product** | The two negative feedback taps are collected today and never reach the track record (§6b). Wire them into the ledger and into a queue a human reads weekly | Build | 5 |

### The distinctive burden

A product whose position is honesty is judged on every support interaction. One deflecting
reply does more damage here than at a competitor, because the brand claim is precisely
that you will not spin. Practically: publish the misses, answer in the same plain register
the product uses, and never let a support reply be less honest than a narration would have
been.

---

## 5. POLICIES TO WRITE BEFORE THE FIRST PAYING CUSTOMER

Short documents, but they must exist in writing:

1. **No-fix-no-fee** — definition, adjudication, timeline.
2. **Incident response** — for Selvedge-caused breakage *and* for a Selvedge breach,
   including customer notification timelines.
3. **Data handling** — what is stored, for how long, what leaves the system, which model
   providers see what, and under whose account. Under BYO this is genuinely different from
   managed, and customers will ask.
4. **Permission scope** — what write access is used for, what will never be done without
   approval, how to revoke.
5. **Support expectations** — hours, response targets by tier, what is escalated.
6. **Terms** — liability for agent-caused damage. Non-trivial and worth real legal advice:
   the product deliberately takes actions that can destroy data.

---

## 6. THE COMPLIANCE LADDER

Not day one, but the order is worth knowing, because the refusal exercise (§14) showed the
security-conscious buyer is a year-three customer and the reason is procurement.

1. **Now** — the controls in §2–3, honest public documentation of data handling, MFA
   available.
2. **First teams/agencies** — SSO, audit-log export, role separation, a real DPA.
3. **First security-conscious buyer** — SOC 2 Type II, penetration test with the report
   available under NDA, data-residency options.
4. **Enterprise** — BYO model keys as a control (not just as pricing), on-premise or
   customer-account sandboxes, contractual liability terms.

SILD's `docs/COMPLIANCE.md`, `docs/AI_DATA_FLOW.md` and `docs/ENTERPRISE_SSO.md` are usable
templates for steps 2–4 and should be adapted rather than rewritten.

---

*The security section exists because Selvedge is a higher-value target than anything the
founder has built before. The customer-service section exists because the cheapest support
ticket is the one the brief already answered.*
