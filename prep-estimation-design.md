# Dynamic Prep-Time Estimation — Design & Implementation Specification

**Status: DESIGNED 2026-07-02, expanded to full implementation spec same day.
NOT built.** Build trigger: Phase A below (finding-#7 enforcement) any time;
Phases B–F any time after A; Phase G is POC-gated.
Related: S8 `PrepEstimator` seam, M3 `ScheduleOutcome` telemetry, roadmap 2.8 /
4.3, review finding #7 (2026-07-02).

**Audience note:** Part II of this document is written as instructions for an
implementer (human or model) who has NOT read the rest of this repo's history.
Follow it literally. Where it says "do not," there is a recorded incident
behind the rule.

---

# PART I — DESIGN (the why)

## Problem

Prep time is the number the entire product stands on, and it is uncertain in
two distinct ways:

1. **Unknown** — imported items where GoTab had no prep time (stored honestly
   as 0 + `prepConfirmed=false`), or admin guesses that are simply wrong.
2. **Non-stationary** — the true time varies through the business day: a
   ticket fired into a dead kitchen and the same ticket fired into a Friday
   7pm queue have very different completion times.

The project doc's load-modeling caveat names the trap: a rolling average of
`prepared − sent` is a lagging indicator that runs optimistic exactly when
load is highest. This design is the answer to that caveat.

## Core decomposition: one number is two numbers

```
estimate(vendor V, items I, now) = cook(I) + wait(V, now)

cook(I)     = max over items of base_i        — item-intrinsic, stable,
                                                learned slowly from robust stats
wait(V,now) = queue_depth(V) ÷ bump_rate(V)   — vendor-state, volatile,
                                                measured LIVE (Little's law)
```

A blended `prepared − sent` average confuses "the gyro takes 6 minutes" with
"the line is deep right now." Splitting them means the slow-moving statistic
only ever models the stable part, and the volatile part comes from a *current*
measurement (queue depth rises the moment a rush builds — no lag).

## Signals

- **Our own tickets:** `firedAt → readyAt` (semantically GoTab `sent →
  prepared`). Already captured by the reconcile loop / `markTicketReady()`.
- **Location-wide GoTab orders (the data multiplier, Phase G):** the same
  kitchens serve walk-up customers through GoTab's own QR flow. `ordersList`
  scoped to the vendor location yields `sent`/`prepared` for EVERY order at
  that kitchen. Konjo teaches us its real cook times and load curve even if
  two groups a night use our app. Blocked on: live `ordersList` schema
  verification + orders existing in the sandbox.
- **Context at fire:** every observation is recorded WITH its context (queue
  depth at fire, item mix). Without context, wait can never be decomposed
  from cook later.

## The model — three layers with a fallback chain

**Layer 1 — per-item base cook time.** p50 (never mean — kitchens produce
forgotten-ticket outliers) of durations from *uncontended* observations
(queue depth ≤ 1 at fire), Bayesian-shrunk toward the admin value. Thin-sample
fallback: a per-vendor calibration multiplier. Chain per item:
item stat (n ≥ 8) → vendor multiplier × admin prior → admin prior.

**Layer 2 — live congestion.** `wait = clamp(depth ÷ rate, 0, WAIT_MAX)` from
a Redis key the worker refreshes; requires ≥ 3 bumps in the rate window to
trust the rate, else fall to Layer 3, else 0.

**Layer 3 — time-of-day prior.** Learned table `(vendorId, dow, hourBucket) →
EWMA wait`. In v1 a *fallback and a dashboard*, NOT a forecaster. Forecasting
queue growth during the ticket's own wait is v2, gated on peak-hour
`targetErrorMs` data implicating it.

**Guardrails:** final estimate clamped to `[0.5×, 3×]` admin prior;
observation hygiene (drop <30s and >45min); `PREP_ESTIMATOR=static|live` flag
with static the default; shadow-mode evaluation before any flip.

## Integration — the S8 seam holds, nothing else changes

The estimator returns per-ITEM seconds; queue wait is per-VENDOR. The move
that keeps the seam intact: **fold the vendor's wait into every one of its
items' estimates inside the estimator.** The scheduler takes `max()` per
vendor, so adding constant W to all of vendor V's items yields ticket prep =
`max(cook_i) + W` — exactly correct. `scheduler.ts`, the seam signature,
`maybeSchedule`'s call site, and every existing test remain untouched.

## Orderability vs. estimation (v1 simplification — supersedes earlier draft)

Earlier draft allowed observation data to make an unconfirmed item orderable
automatically (n ≥ 8 bootstrap). **Dropped for v1**: data *suggests*, a human
*confirms*. `prepConfirmed` alone gates orderability (Phase A); observed
stats improve estimates for orderable items and can be surfaced to the admin
as a suggested value later. One decision surface fewer, no auto-enabled food.

## Deliberately out of scope

- **Mid-flight rescheduling** of already-scheduled fire times. GoTab-held
  orders may not be movable (cancellation semantics unverified); in self-held
  mode the all-paid→fire window is minutes, diners watch a countdown, and
  oscillating re-shuffles are worse than the residual error. "Real-time"
  means fresh estimates AT the all-paid re-anchor (why S8 exists), not
  schedules chasing conditions afterward.
- ML, external forecasting, new infrastructure, new dependencies. EWMAs,
  medians, one division, inside the existing monolith + worker.

## Evaluation — shadow mode, then a data-gated flip

From POC day one the live estimator runs in shadow: static drives real
scheduling; live's would-have-been `targetReadyAt` is logged alongside in
`ScheduleOutcome`. After 2–3 weeks, one SQL query compares `targetErrorMs`
distributions. Flip `PREP_ESTIMATOR=live` only if live measurably wins; flip
back instantly if production degrades.

## Recorded assumptions / open questions

1. **Vendor-multiplier proportionality:** assumes a vendor's admin prep times
   are proportionally wrong (all ~30% long), not randomly wrong per item.
   Validate against DSC data before trusting at low item-sample counts.
2. **Queue depth at estimate time ≈ at fire time:** faster vendors fire
   minutes after scheduling. v1 accepts this; revisit only if targetErrorMs
   implicates it.
3. **`ordersList` live schema** unverified (same family as the
   `orderByOrderUuid` guess; both resolve with sandbox order access).
4. **Multi-item order completion semantics** (bumped when last item done?) —
   observe at DSC.

---

# PART II — IMPLEMENTATION SPECIFICATION

## II.0 Codebase conventions the implementer MUST follow

These are project law. Each has a recorded incident or review finding behind
it.

1. **ESM with `.js` suffixes.** This is TypeScript compiled as NodeNext ESM.
   Every relative import MUST end in `.js` even though the source file is
   `.ts`: `import { x } from './prep-math.js'` (file: `prep-math.ts`).
   Omitting the suffix breaks the build.
2. **Pure-math modules must not import `config` or `prisma`.**
   `src/config/index.ts` calls `process.exit(1)` at import time if
   `JWT_SECRET`/`DATABASE_URL`/`REDIS_URL` are unset — and the UNIT test
   runner does not load `.env`. Any module a unit test imports must therefore
   be dependency-free (precedent: `src/vendor-adapter/gotab-status.ts`, which
   exists as its own file for exactly this reason). All tunables enter pure
   functions as PARAMETERS.
3. **BullMQ custom job IDs must not contain `:` (colon).** BullMQ rejects
   them (Redis key delimiter) — this once broke lock/pay in production code.
   Use underscores: `load_tracker_tick`, never `load:tracker:tick`. (Plain
   Redis KEYS may contain colons; the restriction is job IDs only.)
4. **Every state transition is a conditional `updateMany` whose count is
   checked** — never read-then-write. Copy the style in
   `src/modules/orders/status.service.ts`.
5. **Telemetry/observation writes are best-effort.** Wrap in try/catch, log
   with `logger.error`, never throw into the caller. A telemetry failure must
   never block a diner's food (precedent: `finalizeScheduleOutcome`).
6. **Config pattern:** new env vars go in the Zod schema in
   `src/config/index.ts`. Strings/URLs that may be blank use the existing
   `blankToUndef` preprocess helpers (`optionalString`, `optionalUrl`);
   numbers use `z.coerce.number().default(N)`; enums use
   `z.enum([...]).default(...)`. A blank line in `.env` must behave as unset.
   Also add every new var to `.env.example` with a comment.
7. **Windows Prisma dance:** the dev server AND worker hold
   `query_engine-windows.dll.node`. Before `npx prisma migrate dev` or
   `npx prisma generate`, STOP BOTH processes or the generate step fails with
   EPERM and leaves a stale client. Sequence: stop both → migrate → restart.
8. **Migrations are additive only.** No column drops/renames of existing
   fields. One migration per phase below, named as specified.
9. **Integration tests** (`npm run test:int`) truncate shared tables in their
   setup. If a new table is written during lifecycle flows, ADD IT to the
   truncation list in `src/test/integration/` setup — otherwise tests leak
   state across runs. New tables here: `PrepObservation`,
   `PrepObservationItem`, `ItemPrepStat`, `VendorTimeOfDayStat`,
   `VendorLoadSnapshot`.
10. **Do not modify:** `src/modules/scheduler/scheduler.ts`, the
    `PrepEstimator` interface in `prep-estimates.ts` (the seam signature),
    any existing test, or the frontends except where Phase A says so.
    Frontend edits: **full-file rewrite only** (line-based edits have
    corrupted `public/*.html` twice; never patch them).
11. **Verification gate after every phase (PowerShell):**
    `npm run typecheck; npm run test` — and before calling a phase done,
    `docker compose up -d` then `npm run check` (typecheck + unit +
    integration). All green or the phase isn't done.
12. **No new npm dependencies.** Everything below is arithmetic and Prisma.

## II.1 Existing touchpoints (read these files before writing anything)

| File | What it is | What you'll do to it |
| --- | --- | --- |
| `src/modules/scheduler/prep-estimates.ts` | S8 seam: `PrepEstimator` interface + `StaticMenuEstimator` + `getPrepEstimator()` factory | Add `LiveEstimator`; make factory read `config.PREP_ESTIMATOR`. Interface unchanged. |
| `src/modules/scheduler/scheduler.ts` | Pure schedule math; ticket prep = MAX of item preps per vendor | READ ONLY. The fold-W-into-items trick depends on max(). |
| `src/modules/orders/orders.service.ts` | `maybeSchedule()` — the all-paid re-anchor; creates `ScheduleOutcome` inside the scheduling transaction | Add shadow logging (Phase E) + read where the estimator is called. |
| `src/modules/orders/status.service.ts` | Reconcile poll; `markTicketReady()`; PENDING→FIRED branch sets `firedAt` | Capture observations (Phase C); stamp `queueDepthAtFire` at the FIRED transition. |
| `src/jobs/worker.ts` | Worker process: reconcile tick, sweeps, heartbeat | Add the load-tracker tick (Phase C). |
| `src/modules/groups/groups.routes.ts` | `POST /groups/:id/items` add-item route | Phase A guard. |
| `src/vendor-adapter/mock-gotab.ts` | Mock kitchen; currently finishes exactly at `targetReadyAt` | Phase F realism mode. |
| `src/config/index.ts` | Zod env schema (note `blankToUndef` helpers) | Add knobs (Phase B). |
| `prisma/schema.prisma` | Schema | Phases A(–)/B additions. |

The estimator seam contract (verbatim obligations):

```ts
export interface PrepEstimateInput {
  menuItemId: string;
  vendorId: string;
  snapshotPrepSeconds: number;
}
export interface PrepEstimator {
  readonly name: string;
  // MUST return an entry for EVERY distinct input menuItemId (fall back to
  // the snapshot). Values are integer seconds.
  estimate(items: PrepEstimateInput[]): Promise<Map<string, number>>;
}
```

## II.2 Phase A — Orderability enforcement (finding #7) — PREREQUISITE

**Goal:** an item with `prepConfirmed=false` cannot enter an order. Its
`prepSeconds` is an honest 0 and must never reach the scheduler.

**Scope — read carefully to avoid over- or under-building.** The gate is
STATE-based, not age-based. Exactly one population is affected: items
imported from GoTab whose prepTime was null/0 and that no admin has corrected
yet (the only path into `prepConfirmed=false`). Manually added items, seeded
items, and anything an admin ever set a prep on are ALWAYS confirmed — do not
add logic for them. Paths OUT of the state: `PATCH /items/:id` with
`prepSeconds` (confirms), or re-import where GoTab now supplies a real
prepTime for a still-unconfirmed item (fills + confirms — deliberate: GoTab
prepTime is human-entered vendor config plus an admin-initiated import, NOT
statistical inference). Nothing moves confirmed → unconfirmed. Do NOT gate on
sample counts, item age, or observation data. The gate does not protect
against wrong-but-confirmed values — that is the estimator's job, not this
guard's.

**A1. Server guard (the real enforcement).** In
`src/modules/groups/groups.routes.ts`, `POST /groups/:id/items`: after the
existing menu-item lookup/hall check, reject when the item's
`prepConfirmed === false` with the codebase's 400-error helper and message
`"This item is not orderable yet (prep time not set)"`. Same guard on any
other route that creates OrderItems (search for `orderItem.create` /
`createMany` — the join/add paths).

**A2. Defense-in-depth in the estimator layer** (lands with Phase D, listed
here for completeness): if any input item resolves to a 0-second estimate,
log at error level with menuItemId — a 0 reaching scheduling means the guard
was bypassed; never silently schedule a 0.

**A3. Customer UI.** In `public/customer/index.html` `loadMenu()`: when
`it.prepConfirmed === false`, render the row without an Add button, with a
muted "not yet orderable" label, and show `—` instead of `~0 min`. The public
menu response schema already includes `prepConfirmed`. **Do NOT filter
unconfirmed items out of the menu response** — the admin page reads the SAME
endpoint (review finding #5); filtering would blind the admin to the items it
must fix. Rewrite the file whole (convention 10); keep the `esc()` XSS
discipline on every interpolated string.

**A4. Tests.** Integration: adding an unconfirmed item → 400; confirming via
`PATCH /items/:id` (sets `prepConfirmed=true`) then adding → 200. HTTP test
style: `fastify.inject` as in the existing allowlist test.

**Acceptance:** guard test green; a group containing only confirmed items
schedules exactly as before (no existing test regresses).

## II.3 Phase B — Schema + config

**Migration name:** `prep-observations` (one migration for all of the below).
Follow convention 7 (stop server+worker first).

Add to `prisma/schema.prisma` (copy verbatim; adjust nothing but formatting):

```prisma
enum PrepObsSource {
  APP
  GOTAB
}

model PrepObservation {
  id               String        @id @default(uuid())
  vendorId         String
  vendor           Vendor        @relation(fields: [vendorId], references: [id])
  source           PrepObsSource
  // APP: our ticketId. GOTAB: the GoTab order uuid. Always set.
  externalOrderId  String
  sentAt           DateTime
  preparedAt       DateTime
  durationMs       Int
  // Count of other in-flight (SENT/FIRED) orders at this vendor when this
  // one fired. -1 = unknown (load tracker had no data).
  queueDepthAtFire Int
  itemCount        Int
  createdAt        DateTime      @default(now())
  items            PrepObservationItem[]

  @@unique([source, externalOrderId])   // idempotent ingestion
  @@index([vendorId, preparedAt])
}

model PrepObservationItem {
  id            String          @id @default(uuid())
  observationId String
  observation   PrepObservation @relation(fields: [observationId], references: [id], onDelete: Cascade)
  menuItemId    String
  qty           Int

  @@index([menuItemId])
  @@index([observationId])
}

model ItemPrepStat {
  menuItemId  String   @id
  sampleCount Int
  p50Ms       Int
  updatedAt   DateTime @updatedAt
}

model VendorTimeOfDayStat {
  vendorId   String
  dow        Int      // 0=Sunday … 6=Saturday (JS Date.getDay())
  hourBucket Int      // 0–23 local venue time
  ewmaWaitMs Int
  sampleCount Int
  updatedAt  DateTime @updatedAt

  @@id([vendorId, dow, hourBucket])
}

model VendorLoadSnapshot {
  id             String   @id @default(uuid())
  vendorId       String
  at             DateTime @default(now())
  sentCount      Int
  bumpRatePerMin Float

  @@index([vendorId, at])
}
```

Also: add `queueDepthAtFire Int?` to the existing `Ticket` model, and
`shadowTargetReadyAt DateTime?` + `shadowEstimator String?` to the existing
`ScheduleOutcome` model. Add `PrepObservation PrepObservation[]` relation
field to `Vendor`.

**Config additions** (`src/config/index.ts` schema, then `.env.example` with
comments; use the existing helper patterns):

```
PREP_ESTIMATOR:        z.enum(['static', 'live']).default('static')
PREP_SHRINKAGE_K:      z.coerce.number().default(5)
PREP_MIN_ITEM_SAMPLES: z.coerce.number().default(8)
PREP_CLAMP_LOW:        z.coerce.number().default(0.5)
PREP_CLAMP_HIGH:       z.coerce.number().default(3.0)
PREP_WAIT_MAX_SECONDS: z.coerce.number().default(1200)
PREP_RATE_WINDOW_MIN:  z.coerce.number().default(15)
PREP_RATE_MIN_BUMPS:   z.coerce.number().default(3)
PREP_OBS_MIN_SECONDS:  z.coerce.number().default(30)
PREP_OBS_MAX_SECONDS:  z.coerce.number().default(2700)
MOCK_KITCHEN_REALISM:  z.enum(['off', 'on']).default('off')
```

**Acceptance:** migration applies clean; `npm run typecheck` green (regenerated
client knows every new field); existing 12 unit + 9 integration tests green.

## II.4 Phase C — Observation capture, load tracker, rollups

New files: `src/modules/scheduler/prep-observations.ts` (ingestion + rollups)
and `src/modules/scheduler/vendor-load.ts` (live load tracker).

**C1. Capture from our tickets.** In `status.service.ts`:

- In the PENDING→FIRED transition (reconcile branch) AND wherever the
  self-held fire path marks a ticket FIRED (find the `status: 'FIRED'` write
  in the fire-job path), also set `queueDepthAtFire` on the Ticket, read from
  the load tracker (C2); `-1` if unavailable.
- In `markTicketReady()`, after the conditional update succeeds, call
  `recordAppObservation(ticket)` (new, in `prep-observations.ts`),
  best-effort (convention 5). It writes a `PrepObservation`
  (`source: APP`, `externalOrderId: ticket.id`, `sentAt: firedAt`,
  `preparedAt: readyAt`, duration, `queueDepthAtFire` from the Ticket column,
  itemCount + `PrepObservationItem` rows from the ticket's order items) —
  **skipping** it entirely if duration is outside
  `[PREP_OBS_MIN_SECONDS, PREP_OBS_MAX_SECONDS]` or firedAt is null. Use
  `create` in try/catch; a unique-violation (P2002) is a benign duplicate —
  log at debug, swallow.

**C2. Load tracker** (`vendor-load.ts`) — worker-side, wired into
`worker.ts`'s existing ~10s tick (reuse the reconcile interval; do NOT create
a new BullMQ repeatable unless the existing tick pattern demands it — match
whatever pattern `reconcileSubmittedTickets` uses; any jobId uses
underscores):

- Per vendor with any non-terminal tickets: `sentCount` = count of our
  Tickets `status = 'FIRED'` for that vendor; `bumpRatePerMin` = count of
  `PrepObservation` rows with `preparedAt` in the last
  `PREP_RATE_WINDOW_MIN` minutes ÷ window. Write Redis key
  `vendor_load:{vendorId}` = JSON `{ sentCount, bumpRatePerMin, at }`,
  TTL 90s. Export `getVendorLoad(vendorId)` returning the parsed value or
  null (missing/expired ⇒ null — the estimator's fallback trigger).
- Every 60s (guard with a `vendor_load_snapshot_at` Redis key), also write a
  `VendorLoadSnapshot` row per vendor with activity, and update
  `VendorTimeOfDayStat` for (vendor, current dow, current hour):
  `waitMs = sentCount > 0 && rate ≥ minBumps/window ? (sentCount / bumpRatePerMin) * 60000 : 0`;
  `ewma = round(0.2 * waitMs + 0.8 * previous)` (seed = waitMs when no row);
  increment sampleCount. Hourly (another guard key), prune
  `VendorLoadSnapshot` older than 30 days.
- **Phase-G forward-compatibility (do not build, do not break):** the GoTab
  location poller will later overwrite the SAME `vendor_load:{vendorId}` keys
  and insert `source: GOTAB` observations with the same shapes. Nothing in
  the estimator may assume APP-only data.

**C3. Item stat rollup.** In `prep-observations.ts`, after each successful
APP/GOTAB observation insert: for each menuItemId in a **single-item,
uncontended** observation (`itemCount === 1 && queueDepthAtFire >= 0 &&
queueDepthAtFire <= 1`), recompute `ItemPrepStat` from the most recent 50
qualifying observations for that item (`p50Ms` = median, see II.6;
`sampleCount` = qualifying count, capped at 50). Upsert. Multi-item and
contended observations are stored but do NOT feed item stats in v1.

**Acceptance:** run the demo flow in mock mode; after a group completes,
`PrepObservation` rows exist with correct durations and item children;
`vendor_load:*` keys visible in Redis while tickets are in flight;
`npm run check` green (remember convention 9 — truncation list).

## II.5 Phase D — The live estimator

Two new files:

**D1. `src/modules/scheduler/prep-math.ts` — PURE. No imports from config,
prisma, or redis (convention 2). Unit tests target this file only.**

```ts
// All functions integer-ms/seconds in, integer out (Math.round at the edges).

export function percentile(sortedAsc: number[], p: number): number
// p in [0,1]. Empty array -> throws. p50 of [300,420,480,510,900] = 480.
// Use nearest-rank on the sorted copy; do not interpolate.

export function shrunkEstimate(args: {
  priorSeconds: number;   // admin value
  observedP50Seconds: number;
  sampleCount: number;
  k: number;              // PREP_SHRINKAGE_K
}): number
// (k*prior + n*p50) / (k + n), rounded.
// WORKED EXAMPLE (write this as a unit test):
//   prior=360, p50=480, n=12, k=5 -> (1800+5760)/17 = 444.7 -> 445.

export function clampToPrior(args: {
  estimateSeconds: number;
  priorSeconds: number;
  low: number;            // PREP_CLAMP_LOW  (0.5)
  high: number;           // PREP_CLAMP_HIGH (3.0)
}): number
// clamp(estimate, low*prior, high*prior). prior<=0 -> return estimate
// unclamped (unconfirmed items never reach here; Phase A guards).

export function queueWaitSeconds(args: {
  sentCount: number;
  bumpRatePerMin: number;
  minBumpsInWindow: number;   // PREP_RATE_MIN_BUMPS
  windowMin: number;          // PREP_RATE_WINDOW_MIN
  waitMaxSeconds: number;     // PREP_WAIT_MAX_SECONDS
}): number | null
// Bumps observed = bumpRatePerMin * windowMin. If bumps < minBumpsInWindow
// -> null (signal insufficient; caller falls back). Else
// round(clamp(sentCount / bumpRatePerMin * 60, 0, waitMaxSeconds)).
// WORKED EXAMPLES (unit tests):
//   depth=6, rate=0.8 (12 bumps/15min), min=3 -> 450.
//   depth=6, rate=0.133 (2 bumps/15min), min=3 -> null.
//   depth=40, rate=0.5 -> 4800 -> clamped to 1200.

export function vendorMultiplier(ratios: number[]): number
// median of observed/expected duration ratios, clamped to [0.5, 2.0];
// empty -> 1.0. Example: [1.4, 1.278, 1.267] -> 1.278.
```

**D2. `LiveEstimator` in `prep-estimates.ts`** (same file as the static one,
same style), `name = 'live-v1'`:

Per `estimate(items)` call:
1. Load current `MenuItem` rows for all ids (`prepSeconds`, `prepConfirmed`,
   `vendorId`) — one `findMany`. Fallback prior per item: current
   `prepSeconds` if the row exists, else `snapshotPrepSeconds`.
2. Load `ItemPrepStat` for all ids — one `findMany`.
3. Cook per item: stat with `sampleCount >= PREP_MIN_ITEM_SAMPLES` →
   `shrunkEstimate` → `clampToPrior`. Else vendor multiplier × prior (v1: the
   multiplier may be computed lazily per vendor from the last 30 uncontended
   observations vs the expectations of their items, or hardcoded 1.0 with a
   TODO if that query proves awkward — 1.0 simply means "prior", which is
   never wrong, only less informed). Else prior.
4. Wait per distinct vendor: `getVendorLoad(vendorId)` → `queueWaitSeconds`;
   on null, `VendorTimeOfDayStat` lookup for (vendor, now.dow, now.hour) →
   `ewmaWaitMs/1000` if `sampleCount >= 3`; else 0.
5. Result per item = cook_i + wait(vendor of i) — **the fold**. Integer
   seconds. An entry for EVERY input id (seam contract). If any value is 0,
   log error per A2 and substitute the snapshot.
6. Whole method wrapped so ANY thrown error degrades to the static behavior
   (return current-or-snapshot values) with one error log — the live
   estimator must never be able to break scheduling.

**D3. Factory:** `getPrepEstimator()` returns `LiveEstimator` when
`config.PREP_ESTIMATOR === 'live'`, else static. Keep the singleton pattern.
Add `getShadowEstimator()`: returns the OTHER one (used by Phase E), or null
when both would be the same.

**D4. Unit tests:** `prep-math.test.ts` next to the module, covering every
worked example above plus: percentile on even-length arrays, shrink with n=0
(= prior), clamp both bounds, fold arithmetic (items [300, 480] + W=200 →
scheduler max = 680 = max(cook)+W — assert via `computeSchedule` import,
which is pure and safe to import).

**Acceptance:** `npm run test` green with the new suite; with
`PREP_ESTIMATOR=live` and an empty database, a demo group schedules
IDENTICALLY to static (no stats ⇒ priors, no load ⇒ 0 wait) — this
equivalence is the safety proof and should be asserted in an integration
test.

## II.6 Phase E — Shadow logging

In `orders.service.ts` `maybeSchedule()`, where the `ScheduleOutcome` row is
created inside the scheduling transaction: BEFORE the transaction, compute
the shadow prediction — `getShadowEstimator()`; if non-null, run it on the
same inputs, feed `computeSchedule` with the same anchor, and capture its
`targetReadyAt`. Write `shadowTargetReadyAt` + `shadowEstimator` (the shadow
estimator's `name`) on the `ScheduleOutcome` create. Entire shadow
computation in try/catch → nulls on failure (convention 5). It must add no
failure mode and no meaningful latency (two findMany + one Redis GET).

The comparison query (documentation, run at POC — also add to roadmap 4.3
notes if not already there):

```sql
SELECT
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ABS("targetErrorMs")) AS static_med_abs_err,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY
    ABS(EXTRACT(EPOCH FROM ("lastReadyAt" - "shadowTargetReadyAt")) * 1000)) AS shadow_med_abs_err
FROM "ScheduleOutcome"
WHERE "completedAt" IS NOT NULL AND "shadowTargetReadyAt" IS NOT NULL;
```

**Acceptance:** integration test — complete a lifecycle with
`PREP_ESTIMATOR=static`; the outcome row has `shadowEstimator = 'live-v1'`
and a non-null `shadowTargetReadyAt`.

## II.7 Phase F — Mock kitchen realism mode

In `mock-gotab.ts`: when `config.MOCK_KITCHEN_REALISM === 'on'`, the mock no
longer finishes exactly at `targetReadyAt`. Instead, per ticket at fire time:
`simulatedCookMs = plannedCookMs * uniform(0.85, 1.3) + concurrentInFlight * 45000`,
where `plannedCookMs` = (targetReadyAt − fire time) from the request and
`concurrentInFlight` = the mock's own count of currently cooking tickets.
Default `off` preserves today's deterministic demo (and every existing test —
run the suite to prove it). Purpose: makes the estimator's adaptation
*visible* in dev (fire many groups → queue builds → estimates grow) and
demoable to Jon; learning from the deterministic mock is circular by design,
and realism mode only makes the pipeline observable, not the statistics
meaningful.

**Acceptance:** with realism on + `PREP_ESTIMATOR=live`, firing several
overlapping groups produces observations with varying durations and visibly
growing wait estimates in later groups' schedules (manual dev check; no
automated test of randomness).

## II.8 Phase G — GoTab location poller (POC-GATED: do not build yet)

Blocked on: `ordersList` live-schema verification + orders existing in the
sandbox (settlement blocker; dashboard-created orders are a stopgap). When
unblocked: a worker job per active GoTab-linked vendor polling `ordersList`
scoped to the vendor's `gotabLocationId` on the reconcile cadence; new
prepared orders → `PrepObservation` (`source: GOTAB`, `externalOrderId` =
order uuid, idempotent via the unique constraint, same hygiene filters,
`queueDepthAtFire` = SENT count observed at ingestion − 1, floor 0 — poll-
resolution approximation, documented); SENT counts + bump timestamps
overwrite the same `vendor_load:{id}` Redis keys (location-wide truth
replaces our-tickets-only counts). Item attribution: map GoTab product uuids
→ `MenuItem.gotabProductUuid`; orders containing unmapped products still
count for vendor load/time-of-day but produce no `PrepObservationItem` rows.
Everything downstream (estimator, rollups, shadow) works unchanged — that is
the point of the shared shapes.

## II.9 Build order and gates (summary)

| Phase | Depends on | Gate |
| --- | --- | --- |
| A enforcement | — | guard int-test green; no regressions |
| B schema+config | A (logically; technically independent) | migrate clean; `npm run check` green |
| C capture+load | B | observations + Redis keys visible in demo; check green |
| D estimator | B, C | unit suite green; static-equivalence-on-empty-data int test |
| E shadow | D | shadow fields populated in lifecycle int test |
| F mock realism | D | default-off preserves all tests; manual dev check |
| G poller | POC unblock | conformance vs live sandbox |

Commit per phase. Do not start a phase with the previous phase's gate red.
