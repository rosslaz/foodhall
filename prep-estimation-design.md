# Dynamic Prep-Time Estimation — Design

**Status: DESIGNED 2026-07-02, deliberately NOT built.** Build trigger: the
finding-#7 enforcement work (its prerequisite), then per the build split at the
bottom — pipeline pieces any time, calibration only with real DSC data.
Related: S8 `PrepEstimator` seam, M3 `ScheduleOutcome` telemetry, roadmap 2.8 /
4.3, review finding #7 (2026-07-02).

## Problem

Prep time is the number the entire product stands on, and it is uncertain in
two distinct ways:

1. **Unknown** — imported items where GoTab had no prep time (stored honestly
   as 0 + `prepConfirmed=false`), or admin guesses that are simply wrong.
2. **Non-stationary** — the true time varies through the business day: a
   ticket fired into a dead kitchen and the same ticket fired into a Friday
   7pm queue have very different completion times.

The project doc's load-modeling caveat already names the trap: a rolling
average of `prepared − sent` is a lagging indicator that runs optimistic
exactly when load is highest. This design is the answer to that caveat.

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
measurement (queue depth rises the moment a rush builds — no lag). This is the
structural fix for the documented optimistic-under-rush failure.

## Signals

- **Our own tickets:** `firedAt → readyAt` (semantically GoTab `sent →
  prepared`), already captured by the reconcile loop / `markTicketReady()`.
  Sparse at POC start — a few groups a night.
- **Location-wide GoTab orders (the data multiplier):** the same kitchens
  serve walk-up customers through GoTab's own QR flow. `ordersList` scoped to
  the vendor location yields `sent`/`prepared` for EVERY order at that
  kitchen, not just ours — Konjo teaches us its real cook times and load curve
  even if two groups a night use our app. The same poll yields live queue
  depth (count of SENT orders) and bump rate. This is a READ — unblocked by
  the settlement fork — but needs (a) live `ordersList` schema verification
  (Phase-2 open item) and (b) orders actually existing in the sandbox
  (dashboard-created orders work as a stopgap until API creation unblocks).
- **Context at fire:** every observation is recorded WITH its context (queue
  depth at fire, hour, item mix). Without context you can never decompose
  wait from cook later; with it, the raw table supports any future model.

## The model — three layers with a fallback chain

**Layer 1 — per-item base cook time.** p50 (never mean — kitchens produce
forgotten-ticket outliers) of durations from *uncontended* observations
(queue depth ≤ 1 at fire, so wait ≈ 0), Bayesian-shrunk toward the admin
value: `base = (K·prior + n·p50) / (K + n)`, K ≈ 5. Attribution rule:
single-item orders attribute cleanly to their item; multi-item observations
are stored but feed only vendor-level stats in v1 (per-item attribution of a
3-item order is a research project, not an MVP feature). Thin-sample fallback:
a **per-vendor calibration multiplier** (observed order p50 ÷ expected from
admin values) applied to admin priors — captures "this vendor's numbers all
run 30% long" from far fewer samples. Item stat used when n ≥ 8; else
multiplier × prior; else prior.

**Layer 2 — live congestion.** `wait = clamp(depth ÷ rate, 0, WAIT_MAX≈20min)`
with `rate` = bumps/min over the last ~15 min; require ≥ 3 bumps in the window
to trust the rate, else fall to Layer 3, else 0. Inputs come from a Redis key
the worker refreshes each poll tick (`vendor:{id}:load = {sentCount,
bumpRatePerMin, at}`, short TTL) — a dead poller degrades to fallback instead
of serving stale congestion.

**Layer 3 — time-of-day prior.** Learned table keyed `(vendorId, dayOfWeek,
hourBucket)` holding EWMA of observed wait. In v1 it is a *fallback and a
dashboard* ("Konjo's Friday 7pm queue averages 9 min"), NOT a forecaster.
Forecasting queue growth during the ticket's own wait is a v2 refinement —
build it only if peak-hour `targetErrorMs` skews late after v1 (the doc's
SENT-count-padding instinct, now data-gated).

**Guardrails (non-negotiable):**
- Final estimate clamped to `[0.5×, 3×]` of the admin prior (configurable).
- Observation hygiene: discard durations < 30s (pre-made / instant-bump) or
  > 45 min (forgotten ticket).
- Everything behind `PREP_ESTIMATOR=static|live`; **static stays the default**
  until shadow data justifies the flip (roadmap 2.8 / 4.3).
- Per-item fallback chain: learned stat → vendor-multiplier × admin prior →
  admin prior (only if `prepConfirmed`) → **item not orderable** (see
  enforcement below).

## Integration — the S8 seam holds, nothing else changes

The estimator interface returns per-ITEM seconds; queue wait is per-VENDOR.
The move that keeps the seam intact: **fold the vendor's wait into every one
of its items' estimates inside the estimator.** The scheduler takes `max()`
per vendor, so adding constant W to all of vendor V's items yields ticket
prep = `max(cook_i) + W` — exactly correct, and `scheduler.ts`,
`maybeSchedule`, the seam signature, and every existing test remain untouched.
A congested vendor's ticket prep grows → it fires earlier and/or raises
`targetReadyAt` → more lead time, falling out of existing math.

(Note: the scheduler's documented max-vs-sum combiner assumption is unchanged
by this design; if a vendor turns out to cook sequentially, that's the same
one-line scheduler swap it always was, and this model's `cook(I)` combiner
must change with it.)

## Data model (all additive migrations)

| Table | Purpose | Key fields |
| --- | --- | --- |
| `PrepObservation` | Append-only raw observations | vendorId, source (APP\|GOTAB), externalOrderId, sentAt, preparedAt, durationMs, queueDepthAtFire, itemCount |
| `PrepObservationItem` | Attribution child | observationId, menuItemId, qty |
| `ItemPrepStat` | Materialized per-item rollup (estimates never scan raw) | menuItemId, sampleCount, p50Ms, updatedAt |
| `VendorTimeOfDayStat` | Layer-3 table | vendorId, dow, hourBucket, ewmaWaitMs, sampleCount |
| `VendorLoadSnapshot` | 60s depth/rate history feeding time-of-day rollup; pruned > 30d | vendorId, at, sentCount, bumpRatePerMin |

Live state in Redis only (`vendor:{id}:load`, TTL). Shadow evaluation: two
nullable columns on `ScheduleOutcome` — `shadowTargetReadyAt`,
`shadowEstimator`.

## Ingestion

- **Our tickets:** one call inside `markTicketReady()` writes the observation
  (duration from firedAt→readyAt, depth from the Redis load key at fire).
- **GoTab location poller (POC-gated):** worker job polling `ordersList` per
  active vendor location on the existing ~10s cadence; new prepared orders
  become observations; SENT count + bump timestamps refresh the Redis load
  key and the 60s snapshots. Blocked on live-schema verification + existing
  orders (see Signals).
- **Mock jitter mode (dev/demo):** today's mock finishes exactly at
  `targetReadyAt` by construction, so learning from it is circular. A
  `MOCK_KITCHEN_REALISM` flag makes the mock simulate load-dependent cook
  times (base per item + growth with concurrent tickets + noise) so the
  estimator's adaptation is visible in dev — and demoable to Jon.

## Evaluation — shadow mode, then a data-gated flip

From POC day one, the live estimator runs in shadow: static drives real
scheduling; live's would-have-been `targetReadyAt` is logged alongside in
`ScheduleOutcome`. After 2–3 weeks one SQL query compares `targetErrorMs`
distributions. The flag flips to live **only if it measurably wins** — and
flips back instantly if production behavior degrades. This is roadmap 4.3's
compare-then-switch made concrete, and it means the model can never make
scheduling worse while unproven.

## Blank prep times and the finding-#7 prerequisite

The estimator gives blank (`prepConfirmed=false`) items a bootstrap path:
location-wide observations can teach an item's cook time from walk-up orders
before any admin touches it (usable at n ≥ 8 uncontended samples). But the
bottom of the fallback chain must be **not orderable** — an item with no data
and no confirmed admin value has no honest estimate, and today it schedules
with a dishonest 0. Therefore the finding-#7 enforcement (likely
`prepSeconds Int?` + menu/scheduler guard, per the review) is a
**prerequisite of this system**, not a separate chore. Do it first.

## Deliberately out of scope

- **Mid-flight rescheduling of already-scheduled fire times.** In GoTab-held
  mode we may not even be able to move a `scheduled` order (cancellation
  semantics = unverified Phase-2 question); in self-held mode the all-paid →
  fire window is minutes, diners are watching a countdown, and oscillating
  re-shuffles are worse than the residual error. "Real-time" means estimates
  reflect current conditions AT scheduling (the all-paid re-anchor — the
  freshest possible moment, which is why S8 exists), not schedules chasing
  conditions afterward. Residual error is covered by the doc's
  "strong best-effort, degrades gracefully" framing.
- ML / external forecasting / new infra. This is EWMAs, medians, and one
  division inside the existing monolith + worker. At DSC volumes anything
  fancier overfits noise.

## Config knobs (env, all with defaults)

`PREP_ESTIMATOR` (static|live, default static), `PREP_SHRINKAGE_K` (5),
`PREP_MIN_ITEM_SAMPLES` (8), `PREP_CLAMP_LOW/HIGH` (0.5/3.0),
`PREP_WAIT_MAX_SECONDS` (1200), `PREP_RATE_WINDOW_MIN` (15),
`PREP_RATE_MIN_BUMPS` (3), `PREP_OBS_MIN/MAX_SECONDS` (30/2700),
`MOCK_KITCHEN_REALISM` (off).

## Build split

**Buildable now (unblocked):** finding-#7 enforcement (prerequisite); schema;
observation capture from our tickets; the live estimator with full fallback
chain behind the flag; shadow logging; unit tests for the pure math
(shrinkage, clamps, Little's-law wait); mock jitter mode.

**POC-gated:** the GoTab location poller (schema verification + orders
existing); all calibration; the static→live flip (needs weeks of real DSC
data). The machine can be built now; **it cannot learn anything true until
real kitchens feed it** — sandbox has no load, and the deterministic mock is
circular by design.

## Open questions / recorded assumptions

1. **Vendor-multiplier proportionality:** assumes a vendor's admin prep times
   are proportionally wrong (all ~30% long), not randomly wrong per item.
   Usually true (people underestimate systematically); validate against DSC
   data before trusting the multiplier at low item-sample counts.
2. **Queue depth at estimate time ≈ at fire time:** faster vendors fire
   minutes after scheduling, when the queue may have moved. v1 accepts this
   (windows are minutes); revisit only if targetErrorMs data implicates it.
3. **`ordersList` live schema** (field names/types for sent/prepared,
   location scoping) — same verification family as the `orderByOrderUuid`
   guess; both resolve with sandbox order access.
4. **Multi-item order completion semantics** (bumped when last item done?) —
   affects how multi-item observations bias vendor stats; observe at DSC.
