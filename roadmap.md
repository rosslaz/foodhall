# Roadmap — Food Hall Orchestrator

This roadmap starts at Phase 2 (GoTab sandbox) and runs through production at
DSC and the post-POC decision point. It assumes the current state of the
codebase: MVP built; review fixes, must-have tier (reliability, liveness,
telemetry, abuse limits), and should-have tier (output allowlists, integration
suite, audit-safe drops, estimator seam, DB invariants) all implemented and
verified (`npm run check` green: typecheck, 5 unit, 10 integration).

Each phase has a trigger, the work, and exit criteria. A phase does not start
until the previous one's exit criteria are met — the exit criteria ARE the
plan.

---

## Phase 2 — GoTab Sandbox Integration

**Trigger:** GoTab provisions sandbox access (parent + child locations).
**Status:** sandbox PROVISIONED 2026-06-25, auth + location access VERIFIED
2026-06-26 — parent *Detroit Shipping Sandbox* + two children *Konjo Me
Sandbox* and *Motor Burger Sandbox*; **OAuth** integration "Food Hall Sync -
DSC". 2.1 below is done; the adapter build (2.4) is the next real work.

### 2.1 Environment & auth — DONE (2026-06-26)

- Sandbox locations confirmed live via GraphQL `locationsList`:
  parent **Detroit Shipping Sandbox** (`EL7tpX4xTFNCq~SnMrY_0EcZ`), children
  **Konjo Me Sandbox** (`ZQFbjpg06x4rf1w08RTuOhGa`) and **Motor Burger
  Sandbox** (`oSVMdw0wbSMqE~pOv7cUdkMd`). UUIDs also in `.env`; two contain a
  literal `~`, so URL-encode path segments in `/api/loc/{locationUuid}/...`.
- **Auth is OAuth, confirmed working** — and it is NOT the OAuth-standard
  `grant_type=client_credentials` form body that the earlier draft of this
  roadmap assumed. The real shape: JSON POST to
  `https://gotab.io/api/oauth/token` with `api_access_id` + `api_access_secret`
  (optional `response_type`). Returns a Bearer token (24h TTL) + refreshToken +
  `user_id`. Token in the `Authorization` header on every call; 401 =
  expired/revoked (retry after refresh), 403 = invalid (don't retry blindly).
  The adapter must cache the token and refresh before the 24h expiry.
- Credentials live in `.env` only. Config-name cleanup owed during the adapter
  build: schema currently reads `GOTAB_API_KEY`/`GOTAB_API_SECRET`; rename to
  `GOTAB_API_ACCESS_ID`/`GOTAB_API_ACCESS_SECRET` to match GoTab's fields.
- Two distinct GoTab logins: the **API/OAuth client** (what the adapter uses)
  and the **dashboard UI user** (for visually watching orders fire). Don't
  conflate them when debugging auth.

**Next concrete step (2.2 onward):** make the first authenticated REST call
against a child location — e.g. read Konjo's or Motor's catalog/menu via
`/api/loc/{locationUuid}/...` — to start verifying the live schema and confirm
the Bearer token works on resource routes, not just GraphQL. Then begin the
empirical test plan below.

### 2.2 Empirical test plan (the four open questions, from the project doc)

1. **`scheduled` firing tolerance.** Submit N orders with staggered
   `scheduled` timestamps (e.g. T+1, 2, 5, 10 min); record GoTab's `sent`
   timestamps; compute the distribution of `sent − scheduled`. The product's
   sync window budget must absorb this tolerance — if it's ±90s, that's a
   design input, not a bug.
2. **Shared-tab integrity.** One tab, 3+ vendors, staggered per-vendor orders;
   verify every order fires, the tab stays coherent, and payment settles
   across all of them. This is the single assumption the whole architecture
   leans on.
3. **Live schema verification.** Confirm actual field names/types for
   `scheduled` on order submission and for `ordersList` timestamps
   (`placed/scheduled/sent/prepared`) — support correspondence is not the
   schema.
4. **Status latency.** Verify `sent`/`prepared` appear live (no batch lag) and
   measure poll-observed latency vs the 10s reconcile interval.

Record all four answers in `foodhall-sync-project.md` — they are decision
inputs, not trivia.

### 2.3 DECISION GATE — payment ownership (the documented divergence)

The codebase currently takes payment itself (mock, Stripe-shaped seam) and
then schedules; GoTab's model puts payment on the shared tab. Decide in the
sandbox, with evidence:

- **Branch A (preferred going in): GoTab owns payment.** Diners pay the shared
  tab; our app observes tab payment status (poll or webhook) and `markPaid()`
  is driven by GoTab events instead of our mock route. PCI and payout
  complexity stay entirely with GoTab — the right shape for a POC and probably
  forever.
- **Branch B: we own payment** (Stripe via the existing seam) and submit
  pre-paid orders to GoTab. Only viable if GoTab cleanly supports
  externally-settled orders on a tab — a sandbox question, and likely the
  messier branch.

Questions to answer before deciding: can we read per-tab payment state with
low latency? Can a tab be configured so orders only release after payment?
What does a partial payment / walkaway look like on GoTab's side (this
replaces or interacts with our payment-timeout flow)?

### 2.4 Build: the real adapter

**PARTIALLY BUILT (2026-06-27) — auth + read path done; `submitTicket` blocked.**
The scaffold no longer says `holdsSchedule = true`; it now defaults to **`false`**
(safe default — see the ⚠️ fork note in the project doc and in `gotab.ts`). What
exists now, typecheck-clean and unit-tested (12 unit tests green incl. 7 for the
status mapping):

- `gotab-auth.ts` — real OAuth token manager: JSON-body mint, in-memory cache,
  refresh-before-expiry (5-min skew on the 24h TTL), concurrent-caller de-dupe,
  `invalidate()` for the 401 path. Reads `GOTAB_API_ACCESS_ID/SECRET` (falls back
  to the legacy `KEY/SECRET`). **Config-name cleanup DONE.**
- `gotab-client.ts` — authenticated HTTP/GraphQL client: 401→refresh→retry-once
  contract, GraphQL error surfacing, and the tilde-UUID path-encoding helper.
- `gotab-status.ts` — pure `mapGoTabStatus()` (own module, no config import so it
  unit-tests without booting the app). PENDING/SCHEDULED→SCHEDULED, SENT/IN_TRANSIT
  →IN_PROGRESS, `prepared` set OR DELIVERED→READY, CANCELLED→CANCELLED.
- `gotab.ts` — adapter wired to auth+client; `getTicketStatus` implemented via a
  GraphQL `orderByOrderUuid` read. **CAVEAT:** that query field name is a GUESS from
  GoTab's `userByUserId` naming pattern — it typechecks but is unverified against the
  live schema (can't query a real order until one can be created; see blocker).

Still to build (BLOCKED on the make-or-break test / holdsSchedule fork):

- `submitTicket`: **stubbed on purpose.** Its shape depends on the fork — submit a
  scheduled order to GoTab (`holdsSchedule=true`) vs fire at our own timer
  (`false`) — AND on a tab-creation path our integration can actually settle
  (currently `PROCESSOR_INVALID`: Cash is POS-only/server-assigned). Do NOT
  implement until GoTab support answers whether an order can be created without a
  settling payment.
- `getTicketStatus`: verify the real query field name + `ordersList` timestamp
  fields against the live schema once an order exists to read.
- `cancelTicket`: stubbed; document what's cancellable after `scheduled` is set.
- Map menu items: our catalog ↔ GoTab product ids (**DONE for the import
  direction** — see 2.4a below; a `gotabProductUuid` now exists on MenuItem).
- **GoTab `prepTime` is seed-only, never a runtime dependency** (confirmed by
  Zach 2026-06-26: optional/nullable, `0`→`null`, operators usually leave it
  blank; unit is MINUTES so ×60 to the scheduler's seconds). During location
  onboarding, optionally read it per product as a seed for our own prep-time table
  (null/0 → no seed); the scheduler reads prep time ONLY from the `PrepEstimator`
  (S8). Do not wire fire-timing to GoTab's field even though Zach suggested making
  it an onboarding requirement — keep the correctness boundary inside our system.

### 2.4a Menu import from GoTab — SHIPPED (2026-07-01)

Admin can onboard a vendor by pulling its live catalog from GoTab, instead of
hand-typing the menu. This is a pure catalog READ, so it is UNBLOCKED by the
submit/settlement fork — and it's the first time the *app itself* (not curl in
PowerShell) calls GoTab. Verified end-to-end against the real Konjo sandbox
(4 items pulled, priced, flagged), not just the mock.

- `VendorAdapter.listProducts(locationUuid)` — on the interface, mock, and real
  `gotab.ts`. Returns `{ locationName, products }`. Real impl: one GraphQL query
  fetching the location `name` + `productsList`, filters `productType == CUSTOM`
  (back-office payment instruments like "Cash Payment") and non-orderable items,
  maps `basePrice`→cents and `prepTime` (minutes) → seconds.
- **Vendor name auto-populates from GoTab.** The import reads the location's own
  name and uses it as the vendor name by default; the admin's name field is an
  optional OVERRIDE (blank = GoTab's name). Matters because GoTab location names
  carry the parent hierarchy (Konjo imports as "Konjo Me Sandbox - Detroit
  Shipping Sandbox"), which an operator will usually want to shorten for the
  customer-facing menu ("Konjo Me"). Both paths verified against live Konjo.
- **Import always talks to REAL GoTab even in mock fire-mode.** New
  `getImportAdapter()` factory returns the real adapter whenever GoTab creds
  exist, regardless of `VENDOR_ADAPTER` — because importing (read) is unblocked
  while firing (write) is not. Falls back to mock only when no creds are set.
- **Route:** `POST /api/halls/:hallId/vendors/import-gotab` (ADMIN). Upserts the
  vendor by (hall, gotabLocationId) and its items in one transaction. Idempotent:
  re-import matches existing items by `gotabProductUuid` (new `MenuItem` field,
  `@@unique([vendorId, gotabProductUuid])` — NULLs distinct so hand-added items
  coexist) and updates in place instead of duplicating. Never clobbers an
  admin-corrected prep on re-import.
- **Prep-time HONESTY (this is the important design call):** items GoTab has no
  prep for are stored with their ACTUAL value (0), NOT a fabricated placeholder,
  and marked `prepConfirmed = false` (new `MenuItem` boolean, default true so
  manual + pre-existing items are confirmed). An invented number that looks real
  is worse than an honest zero. The admin UI flags unconfirmed items (red "needs
  prep", blank prep input) and lets the admin set a real prep inline
  (`PATCH /items/:id` sets `prepConfirmed = true`). Full loop verified: import →
  flagged → corrected → confirmed.
- **DEFERRED (option 1 follow-up, NOT built):** enforcement. An unconfirmed item
  is still technically orderable — the scheduler will use its 0 prep and
  mis-stagger if ordered before an admin fixes it. Making `prepConfirmed = false`
  items non-orderable (likely `prepSeconds Int?` + a menu/scheduler guard) is the
  correct end state but touches the tested scheduler, so it was deliberately not
  rushed. `prepConfirmed` is the breadcrumb for adding it.
- **Migrations:** `gotab_product_uuid`, `menu_item_prep_confirmed` (both additive).
- Unit tests still 12/12; typecheck clean.

### 2.5 Build: recovery sweep for failed platform submissions

The deliberately-deferred item: if `submitTicket` fails at the all-paid moment
in GoTab mode, the ticket stays PENDING with no external id. The sweep already
detects this; Phase 2 adds informed retry policy now that real failure modes
(auth expiry, rate limits, validation rejects) are observable. Distinguish
retryable (5xx, auth-refresh) from terminal (validation) failures.

### 2.6 Build: webhooks, if GoTab offers them

Implement the S10 contract (already designed): `POST /api/webhooks/gotab`,
raw-body HMAC verification before parsing, map to the existing conditional
transitions, keep the 10s poll as fallback. If GoTab has no webhooks, the poll
remains primary — it's already production-shaped.

### 2.7 Adapter conformance tests

Add `npm run test:gotab` — an integration-style suite (same pattern as
`test:int`) that runs only when sandbox creds are present: submit → observe
SCHEDULED → observe fire → observe prepared → cancel path → idempotent
resubmit. This becomes the regression net for every future GoTab change.

### 2.8 Estimator groundwork

Sandbox has no real kitchen load, so `queue_adjustment` can't be calibrated
here — but wire the live `PrepEstimator` implementation (rolling
`prepared − sent` per vendor, SENT-count padding) behind a flag so DSC data
flows into it from day one of the POC. The static estimator remains the
default until real data justifies the switch. Our own per-item table is the
source of truth for prep time at schedule time — GoTab's `prepTime` is, at
most, an onboarding seed (see 2.4), confirmed empty-in-practice by GoTab.

### Phase 2 exit criteria

- All four empirical questions answered and recorded.
- Payment ownership decided and implemented (one branch, not both).
- `gotab.ts` complete; conformance suite green against sandbox.
- Recovery sweep handles observed failure modes.
- `npm run check` still green (the existing suites must not regress).

---

## Phase 3 — Production Readiness & Deployment (pre-POC)

**Trigger:** Phase 2 exit. Target: a boring, monitored deployment a solo
operator can run.

### 3.1 Hosting — recommended path

**Primary recommendation: a PaaS with first-class background workers — Render
or Railway.** Deploy as: one web service (API), one background worker (the
BullMQ worker), managed Postgres, managed Redis. Reasoning: solo founder, no
ops team, two-process topology already cleanly separated, and the failure
modes that matter (process death) are handled by platform restarts. Verify
current pricing/feature fit at decision time — both platforms change.

**Alternative (cost-optimized):** one small VPS (Hetzner/DigitalOcean) running
the existing docker-compose with restart policies, plus managed Postgres
anyway (don't self-host the database that holds the telemetry asset).
More ops burden; only worth it if PaaS pricing offends.

**Explicitly not recommended at this scale:** Kubernetes, microservices,
self-managed queues/brokers, AWS-from-primitives. One venue peaks at hundreds
of concurrent users; the monolith + worker is the right shape.

Redis note: it carries queues, realtime pub/sub, and the heartbeat — a single
point of failure by design. Use a managed Redis with persistence (AOF) so
durable BullMQ jobs survive provider restarts.

### 3.2 Production configuration

- CORS: lock `origin` to the deployed domain (currently `origin: true`).
- **`trustProxy`: REQUIRED behind any PaaS/load balancer** (review finding
  2026-07-02). Without it `req.ip` is the proxy's address, so M4's per-IP rate
  limits collapse into ONE shared bucket for the whole venue — Friday night
  collectively hits the 30/min group-create cap, the exact failure M4 was
  designed to avoid. Set `Fastify({ trustProxy: true })` (or the platform's
  documented hop count) in production; verify `req.ip` shows real client IPs
  in staging before launch.
- Add `@fastify/helmet` for security headers.
- Secrets: strong `JWT_SECRET`, GoTab production credentials, all via the
  platform's secret store — nothing in the repo.
- `NODE_ENV=production`; pino at info level; confirm logger redaction covers
  member tokens (nice-to-have item — do it here, it's two lines of pino
  `redact` config).
- Domain + TLS via the platform; QR codes point at the production domain.

### 3.3 Data

- Managed Postgres with automated daily backups; verify a restore once before
  the POC, not during it.
- Release flow: `prisma migrate deploy` runs as the release step (script
  already exists: `npm run prisma:deploy`). Never `migrate dev` against
  production. Manual `pg_dump` before any migration in week one.

### 3.4 CI (GitHub Actions or equivalent)

One workflow, on every push: `npm ci` → `prisma generate` → `npm run
typecheck` → `npm test` → `npm run test:int` with `postgres:16` and `redis:7`
service containers (`TEST_DATABASE_URL`/`TEST_REDIS_URL` env overrides exist
for exactly this). The integration suite was built env-portable so CI is
wiring, not work. Deploy only on green.

### 3.5 Monitoring & alerting — the utilities

| Concern | Utility | Configuration that matters |
| --- | --- | --- |
| Uptime + worker liveness | UptimeRobot / Better Stack | **Keyword monitor** on `GET /api/health` alerting when `"status":"ok"` is absent — NOT a status-code monitor, because the endpoint deliberately returns HTTP 200 when degraded (worker dead). 1-min interval; phone push during service hours. |
| Crash/error tracking | Sentry (free tier), both processes | Init in `server.ts` and `worker.ts`; tag events with `groupId`/`ticketId` where available. |
| Log-based alerts | Platform logs + (if needed) Axiom / Better Stack Logs | Alert rule on error-level lines containing `SWEEP:` — the sweeps log at error level *by design* as the "a primary mechanism failed" signal. Also alert on `failed to submit scheduled ticket`. |
| Product metrics | The `ScheduleOutcome` table itself | No Prometheus/Grafana yet — a weekly SQL query (median/p90 `readySpreadMs`, `targetErrorMs`, completion rate, timeout-drop rate) is the dashboard. Automate later only if the manual query becomes a chore. |
| Backups | Managed PG automated + pre-migration dumps | Tested restore = the only backup that counts. |

### 3.6 Runbook (one page, written before launch)

- `status: degraded` → worker is down → platform restart of the worker
  service; verify heartbeat recovers in /api/health.
- `SWEEP:` alerts firing → a lost job or failed GoTab submission was
  auto-recovered → investigate the underlying cause same-day; the diner was
  already protected.
- GoTab outage → tickets stick PENDING with loud logs; sweep retries; staff
  fallback is ordering at the counter (the system degrades to the status quo,
  which is the correct failure posture).
- Kill switch → worst case, take the QR signage down; the system has no
  hold on normal venue operation.

### 3.7 Pre-POC checklist with Jon

- Seed real DSC vendors, menus, prices, and honest prep-time estimates
  **into our own prep-time table** (these seed the scheduler — garbage in,
  desynchronized food out). This is the real onboarding requirement, not
  populating GoTab's `prepTime` field, which operators leave blank anyway and
  which the scheduler never reads at runtime (confirmed by GoTab 2026-06-26).
- Frame expectations per the project doc: strong best-effort sync that
  degrades gracefully under peak load — not a guarantee.
- Agree the success metrics and thresholds (see 4.2) BEFORE launch.
- Staff briefing: what the board shows, what "degraded" means, who to text.

### Phase 3 exit criteria

- Deployed; CI green and gating deploys.
- Alert path verified end to end: kill the worker on purpose, receive the
  phone alert, restart, watch recovery.
- Restore-from-backup performed once.
- Runbook written; DSC data seeded; thresholds agreed with Jon.

---

## Phase 4 — POC at Detroit Shipping Co.

**Trigger:** Phase 3 exit + Jon's go.

### 4.1 Pilot design

Start narrow: 2–3 vendors, weeknight soft launch, QR codes on a subset of
tables. Expand to full vendor set and weekend service only after a clean week.
Run a manual baseline first: time 5–10 normal (non-app) group orders for
first-dish-to-last-dish spread — that number is what "meaningfully better"
is measured against.

### 4.2 Success metrics (all already captured by `ScheduleOutcome` + tickets)

Suggested thresholds — finalize with Jon in 3.7:

- Median `readySpreadMs` ≤ `GROUP_READY_WINDOW_SECONDS` (120s); p90 ≤ 2×.
- Median spread beats the manual baseline by a margin Jon considers real.
- ≥ 95% of scheduled groups reach COMPLETED; zero "table never fed" incidents
  (the sweep + runbook exist to make this structurally true).
- Payment-timeout drop rate low enough not to annoy staff.
- Adoption: groups/night trending up across the pilot.

### 4.3 Calibration loop

Weekly: review `prepared − sent` per vendor vs configured prep times; correct
estimates in the admin UI (takes effect immediately via the S8 estimator).
Once 2–3 weeks of data exist, enable the live estimator (2.8) and compare its
prediction error against the static one using `targetErrorMs` — switch only if
it measurably wins. Watch the documented load-model caveat: predictions run
optimistic during rushes; if peak-hour `targetErrorMs` skews late, add the
SENT-count padding before blaming prep times.

### 4.4 Cadence and go/no-go

Weekly review with Jon against the agreed thresholds. POC runs 4–8 weeks.
Exit with a written one-pager: metrics vs thresholds, vendor/staff sentiment,
and a recommendation.

### Phase 4 exit criteria

- Thresholds met (or a documented, understood miss).
- Jon's verdict and willingness to reference/host the next step.
- Go/no-go decision for Phase 5 recorded.

---

## Phase 5 — Post-POC

**Trigger:** Phase 4 go decision.

1. **Fastify 5 migration** — the committed window (post-POC, pre-rollout; see
   the Known Issue section in the project doc). Clears the npm-audit
   critical/high chain; `loggerInstance` flips back; one contained changeset
   gated by `npm run check`.
2. **Frontend rebuild decision.** The HTML MVP was never the product. Rollout
   needs a real mobile web app (brand, UX, error states, accessibility) — a
   scoped project of its own; the API contract (now schema-pinned) is its
   spec.
3. **Multi-hall rollout prep.** Schema is multi-tenant from day one; the work
   is hall onboarding (slug routing replaces `/halls/default`), per-hall
   config, and operational playbooks — plus opening the GoTab partnerships
   conversation the project doc earmarked for exactly this moment.
4. **Engineering leftovers** (do opportunistically, never as a blocker):
   targeted WebSocket payloads, resolve the half-alive `IN_PROGRESS` ticket
   enum, Zod-validate route params, response schemas on authenticated routes.

---

## Deliberately out of scope — all phases

No microservices, no Kafka/event bus, no Kubernetes, no event sourcing, no
self-hosted observability stack, no multi-region anything. Every phase above
hardens or extends the monolith + worker. The first justified revisit of that
shape is multiple simultaneous high-volume venues — a Phase 5+ problem that
the telemetry will announce long before it arrives.
