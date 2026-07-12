# Food Hall Order Synchronization — Project Context

## ⚡ CURRENT STATE — read this first (updated 2026-07-07)

**The product's core mechanic is built, integrated, and measured working
against real GoTab.** On 2026-07-07 the app ran its first end-to-end group
order through the real UI: two vendors, prep-staggered fire times held on our
own durable timers, two real GoTab orders — and the kitchens experienced the
300-second stagger with **46ms of error** (0.04% of the 120s sync window).
Everything upstream of that number — group lifecycle, payment gating,
scheduling math, firing, reconciliation, failure sweeps — is verified by
`npm run check` (typecheck + 23 unit + 9 integration tests) and, where it
touches GoTab, by live conformance probes.

What exists and works: the full group-ordering web MVP (create/join by code,
lock, pay, fire, ready board, admin); two hardening tiers (reliability
sweeps, worker liveness, prediction-vs-actual telemetry, abuse limits;
response allowlists, integration suite, audit-safe drops, estimator seam, DB
invariants); GoTab OAuth + menu import with empirically-verified availability
sync; and the real GoTab adapter — `submitTicket` live in we-hold-timers
mode, status polling on proven queries, rate-limit pacing, idempotency.
Designed-but-not-built on purpose: the prep-time estimation system (full
implementation spec ready for a lesser-model build) and webhook ingestion.

**Where the risk has moved:** the open questions are no longer "can this
work" — they are operational and business questions. Four precise items ride
the GoTab support thread (scheduling config, sandbox KDS, shared-tab shape,
pay-before-fire sequencing); the operator unknowns (kitchen bump discipline,
parallel-vs-sequential cooking, 86 habits, pickup UX, pilot design) are
packaged as `jon-questionnaire.md` for the upcoming meeting. The remaining
pre-POC engineering is finite and listed in the roadmap's ranked next steps.

### Document map
- **This file**: current state + decision register up top; below, an
  APPEND-ONLY chronological evidence log (dated sections). Later entries
  supersede earlier ones where they conflict; the original June context
  sections immediately below this block are historical — the register and
  the log are authoritative.
- **`roadmap.md`**: phases 2–5 with exit criteria + ranked next steps.
- **`prep-estimation-design.md`**: the estimation subsystem — design
  rationale + implementer-grade spec (build gated, not blocked).
- **`jon-questionnaire.md`**: the operator meeting instrument (⭐ =
  design-blocking questions).

## DECISION REGISTER — what we chose, why, and when to revisit

1. **Monolith + worker; no microservices/K8s/event bus.** One venue peaks at
   hundreds of concurrent users and there is no ops team; two processes with
   platform restarts cover the failure modes that matter. *Revisit:* multiple
   simultaneous high-volume venues (telemetry will announce it).
2. **Vendor-adapter seam (`VendorAdapter`) isolating all GoTab specifics.**
   Platform uncertainty was the project's dominant risk; the seam let the
   holdsSchedule question ride a one-line flag instead of an architecture.
   *Evidence:* the 2026-07-07 adapter build touched nothing outside the
   adapter layer + two call-site lines. *Revisit:* never — this one paid for
   itself.
3. **`holdsSchedule = false` (we hold durable BullMQ timers; submit ASAP
   orders at fire time) — now PERMANENT, not provisional.** Originally chosen
   by measurement (46ms stagger error end-to-end; absolute latency is
   common-mode and cancels — only inter-order jitter matters). Then made
   structural by GoTab (2026-07-08): open tabs and scheduled orders are
   mutually exclusive in their code, and scheduled⇒closed⇒settlement⇒
   processor is unreachable under Client Credentials. GoTab-held scheduling
   is EXCLUDED for this integration, not merely unconfigured. The code seam
   in `gotab.ts` remains as documentation of the exclusion. *Revisit:* only
   if GoTab ships scheduled-open-tabs or our access model changes.
4. **The mock adapter is PERMANENT; capabilities migrate to real
   individually.** The sandbox has no kitchen (nothing bumps `prepared`) and
   no API settlement; the mock is the only place the full loop runs, and it
   is the hermetic test double CI requires. Catalog reads already use real
   GoTab whenever creds exist; firing uses real GoTab when
   `VENDOR_ADAPTER=gotab`. *Revisit:* never delete; individual capabilities
   migrate as the sandbox earns them.
5. **Open tabs, no `payments[]`, settlement deferred.** Cash processors are
   architecturally unreachable under Client Credentials (server-session
   access model — support-confirmed, permanent); open tabs reach the KDS
   without touching a processor. Staff can settle any tab in one click
   ("Pay with Tender Types" → Cash — verified), so the worst-case
   operational fallback at a venue is the food-hall status quo. *Revisit:*
   at the 2.3 payment-ownership gate.
6. **Payment ownership (roadmap 2.3) is OPEN, leaning Branch A (GoTab owns
   payment).** Evidence so far: the consumer tab surface is real and
   anonymous-reachable with native per-item payment (href test) — but it is
   OTP-gated per diner, tabs are location-scoped (one tab PER VENDOR per
   group, not one shared tab — original assumption superseded), and
   pay-before-fire needs either GoTab-held scheduling or a
   create-without-firing shape. Decision waits on the support thread + Jon's
   Q20–21. *Revisit:* the gate itself; do not build payment code before it.
7. **Honest prep times: store real values, never fabricate; `prepConfirmed`
   gates trust.** A plausible-looking invented number is worse than an
   honest zero — the scheduler's output is only as real as its inputs.
   Finding-#7 enforcement (unconfirmed ⇒ not orderable) is specced as prep
   Phase A and is REQUIRED before seeding any real menu. *Revisit:* n/a —
   principle.
8. **Availability: GoTab is the source of truth for GoTab-linked items.**
   The dashboard tri-state was decoded empirically (lockstep booleans +
   `enableTimestamp` discriminator; "Unavailable" is an auto-expiring 86);
   re-import syncs both directions and deactivates vanished items; hand-added
   items are never touched. *Revisit:* if Jon's Q13 says operators don't
   actually use the 86 toggle, demote the sync to best-effort in the docs.
9. **Prep estimation = per-item cook (robust stats, shrinkage) + live vendor
   wait (queue depth ÷ bump rate), folded into item estimates so the S8 seam
   holds; shadow mode before any flip; humans confirm orderability, data only
   suggests.** Designed 2026-07-02, deliberately NOT built: it cannot learn
   anything true until a real kitchen feeds it. *Revisit:* build any time
   (spec is implementer-ready); calibrate only with DSC data.
10. **Empiricism discipline: probe before build; record findings as dated
    evidence; timing math on GoTab's clock only.** Every schema assumption
    that was probed survived; every one taken from correspondence alone
    needed correction. ~1s clock skew vs GoTab observed — never mix clocks.
    *Revisit:* never.
11. **Adapter law (all encoded in code + tests):** targeted lookups only
    (bare `ordersList` times out server-side); ≤4rps GraphQL (client paces
    at 280ms spacing, 429 retried once); mixed/tz-less-UTC timestamps
    (Z-appending parser); tildes appear in location/order/tab/zone uuids
    (encode REST paths); order creation is REST-only; create returns numeric
    orderId only. *Revisit:* per-finding, with probes.
12. **Failure posture: "a table silently not getting fed" is the kill-shot,
    so every transition is a conditional update, every submission idempotent,
    every primary mechanism backed by a sweep that logs at error level, and
    telemetry is best-effort (never blocks food).** *Evidence:* the M1 dedupe
    race and M4 expiry both observed working unprompted in the first
    end-to-end run. *Revisit:* n/a — principle.
13. **The HTML frontends are a disposable MVP; the real diner app is a
    post-POC project.** Full-file rewrites only (line-edits corrupted them
    twice); XSS-escape discipline everywhere. The schema-pinned API is the
    future frontend's spec. *Revisit:* Phase 5.
14. **Monetization: flat monthly fee per venue** (not per-order — aligns
    incentives with the operator, trivial to reason about at POC scale).
    *Revisit:* Jon Q34 sense-check, then post-POC.

---

## Problem
At a multi-vendor food hall, a group seated together orders from several different
vendors. Because each vendor has different prep times, food arrives at different
times — some people are eating while others are still waiting. The goal is to
**stagger when each vendor's order fires to its kitchen so all dishes finish within
the same window.**

- **Venue (proof of concept):** Detroit Shipping Co. (operator contact: Jon)
- **POS / payment platform:** GoTab (all vendors + bar)
- **Scope:** DSC-first as a proof of concept. Broader multi-operator rollout
  considered only if the POC succeeds (would loop in GoTab partnerships at that point).

## Why this isn't solved natively
- GoTab's **auto-timed coursing** synchronizes *sequential courses within a single
  location* (apps → entrées → dessert). It does **not** coordinate fire timing across
  separate vendors.
- A food hall is a **parent location with separate child vendor entities**, each with
  its own menu, catalog, KDS, and merchant account. The **shared tab** is the only
  layer spanning vendors — kitchens are siloed.
- So cross-vendor synchronization is a real gap GoTab does not close. That gap is the
  product.

## GoTab API capabilities (confirmed with GoTab API support)

### Scheduling — CONFIRMED, this is the core enabler
- The `scheduled` field is **per-order, not per-tab.**
- A single shared tab can hold **multiple orders, each with its own `scheduled`
  timestamp and its own vendor/location.**
- This natively supports the stagger use case: submit one order per vendor on the same
  tab, each with a different fire time (e.g. burger stall at T+0, ramen at T+12 min).
- **Architectural consequence:** we do NOT need to hold orders in our own backend and
  fire them via timed API calls. We compute offsets, set `scheduled` timestamps at
  submission, and GoTab handles timed release inside its own tab/payment flow.

> ⚠️ **CONTESTED BY THE REST DOCS — READ BEFORE BUILDING THE ADAPTER (2026-06-26).**
> The four "CONFIRMED" bullets above came from GoTab *support correspondence*, not the
> live API. Reading the actual REST reference (create-a-new-tab, add-items-to-tab,
> reservation-integration) surfaced THREE problems that, together, put the entire
> core assumption in doubt. This is now the make-or-break risk of Phase 2.
>
> **The order-submission path itself is confirmed and is REST, not GraphQL** (the
> GraphQL Mutation root has only 16 read-style `goGet…`/`goFilter…` helpers — no
> create/order/tab mutations at all). The real endpoints:
> - `POST /api/loc/{locationUuid}/tabs` — create a tab. Body: `items[]`
>   (`productUuid`, `quantity`, `modifiers[]`), `spotUuid`, guest id (`phoneNumber`
>   OR `customerId`), `payments[]`, `scheduled`, optional `notes`, `externalId`.
> - "Add items to tab" (POST) — only usable when `openTab: true`.
> - Same Bearer token as the GraphQL calls. Price-check route recommended to make
>   `payments[]` cover the balance.
>
> **Problem 1 — OPEN TABS ARE NOT SUPPORTED VIA THE API.** The create-tab doc states
> verbatim: *"Currently, the API only supports CLOSED tabs. The openTab must be set to
> FALSE."* A closed tab requires `payments[]` zeroing the balance AND a `spotUuid` at
> creation. The natural design — open ONE shared tab, then add each vendor's order to
> it as it's scheduled — depends on `openTab: true`, which is exactly what's disabled.
>
> **Problem 2 — `scheduled` LOOKS LIKE A CALENDAR DATE, NOT A MINUTE-LEVEL FIRE TIME.**
> Every doc example shows `"scheduled": "2022-01-31"` (a date), and the help docs frame
> "scheduled orders" as future-DAY takeout/catering pickup. Our architecture needs
> `scheduled` to mean "fire to the kitchen at 7:42:30 PM" with ~30s precision. There is
> NO doc evidence it supports intra-service minute-level timing, and some evidence it's
> a coarser day-grain feature. If `scheduled` can't express a near-future fire time that
> actually releases to the KDS at that moment, the "GoTab holds the timer"
> (`holdsSchedule = true`) design does not work.
>
> **Problem 3 — TABS ARE LOCATION-SCOPED; A "SHARED TAB SPANNING VENDORS" MAY NOT BE
> EXPRESSIBLE.** The route is `/api/loc/{locationUuid}/tabs`, and Konjo/Motor are
> DIFFERENT child locations. The terminology doc says a tab belongs to a location. So a
> single tab holding both a Konjo order and a Motor order may require the PARENT
> location's tab carrying child products, or may not be possible at all. This is the
> architectural crux and is completely unverified.
>
> **What this changes:** if any of the three doesn't resolve favorably in the sandbox,
> the design pivots from "GoTab holds per-vendor scheduled fires on one shared tab" to
> **"we hold the timers"** (`holdsSchedule = false`, already supported in the adapter
> contract — this is precisely why that flag exists). In that mode the app fires each
> vendor's CLOSED tab/order at the computed moment via its own durable BullMQ jobs, and
> `scheduled` is unused or set to ASAP. The codebase already supports this with zero
> structural change — only the `gotab.ts` adapter differs.
>
> **DO NOT build `gotab.ts` until the make-or-break test (below) resolves these.** The
> outcome determines which adapter mode to write. Prerequisite for any test: a
> `spotUuid` for Konjo and one for Motor (query `spotsList` via GraphQL — never fetched
> yet; every tab needs one).

> ✅ **RESOLVED 2026-07-06/07 — all three problems have verdicts; the adapter is
> built.** (1) *Open tabs ARE supported via the API* — the doc's "closed only"
> statement is stale/wrong for our integration: `openTab: true` with no
> `payments[]` works (support-suggested, live-verified; it is the shipped
> submit path). (2) *`scheduled` accepts full ISO timestamps* (schema-real,
> top-level) BUT is coerced to ASAP absent zone order-interval config —
> escalated to support; MOOT for the chosen mode, because (3) drove the
> decision: *tabs ARE location-scoped* — confirmed — so the implementation is
> one tab per vendor per group, we hold the timers (`holdsSchedule=false`),
> and the measured end-to-end stagger fidelity is 46ms on 300s. The shared-
> tab/payment-UX consequence moved into the 2.3 gate. Full evidence: the
> dated log ("Open-tab probe session", "GoTab adapter BUILT", "THE NUMBER").

### Order timestamps & status — CONFIRMED, good coverage
Per-order timestamps available via `ordersList`:
- `placed`, `scheduled`, `sent` (fired to KDS), `prepared` (kitchen bumped),
  `fulfilled`, `status_changed`
- Status enum: `PENDING → SCHEDULED → SENT → IN_TRANSIT → DELIVERED`
- Data is **live (no batch lag).**
- `sent` = fire event; `prepared` = completion event. Gap between them = real cook time.
- Querying orders with `status = SENT` scoped to a vendor location ≈ real-time queue depth.
- **No mid-ticket "cooking" state** beyond SENT. Best finish-time estimate is a rolling
  average of `prepared - sent` per vendor.

### Known limitations / open items
- **No dedicated KDS queue/load endpoint.** Queue depth must be *inferred* from
  `ordersList` (count of SENT orders + rolling avg cook time). This is a directional
  signal, not precise.
- **Prep-time metadata is at the ORDER level, not product/catalog level.** GoTab is
  *looking into* exposing it on `productsList` but made **no timeline commitment.**
  → For now we maintain our **own per-item prep-time table.** Do not depend on
  product-level prep times existing.
  → **CONFIRMED by GoTab (Zach, 2026-06-26):** even where a product-level `prepTime`
    field exists, it is **optional, nullable, no default** — unset comes back `null`.
    Zach also stated that passing `0` is stored as `null` on GoTab's end; **NOTE a
    discrepancy** — our live Konjo three-way test (blank / explicit 0 / 5 min) returned
    blank → `null` but explicit `0` → **`0`** (a real zero, not null), with 5 → `5`.
    Where Zach's description and the wire disagree, trust the wire: the API can and did
    return a literal `0`, so the adapter must handle it. (This doesn't change the rule
    below — we treat BOTH `null` and `0` as "no usable value" anyway.) More importantly,
    **live operators commonly leave it blank** (GoTab treats it as a KDS *display* field,
    not a required operational input). So the field is not just architecturally
    inconvenient, it is *empirically empty in practice.* This **vindicates the own-table
    decision** above.
  → **Stance (do not relitigate):** the scheduler reads prep time ONLY from our
    `PrepEstimator` (S8). GoTab's `prepTime` may be read **once at onboarding as a seed**
    (coerce null/0 → "no seed"), but is **NEVER a runtime dependency** at schedule time.
    Zach framed the fix as "make `prepTime` an onboarding/location requirement so it
    utilizes your integration correctly" — **resist that framing.** Coupling our fire-
    timing correctness to an unenforced field in GoTab's system that operators habitually
    ignore is exactly the kind of "works because someone filled in the spreadsheet"
    dependency that rots. The correctness boundary stays inside our system, where we can
    enforce and improve it from observed `prepared − sent` data.
- `createTab`/order submission fires immediately if not scheduled — there is no separate
  "send" call; scheduling is via the `scheduled` timestamp.

## Load-modeling caveat (important for product expectations)
The rolling average of `prepared - sent` is a **lagging indicator**:
- SENT count treats simple and complex orders identically — directional, not exact.
- During a building rush, the recent rolling average reflects kitchen state from a few
  minutes ago, so predictions run **optimistic exactly when load is highest.**
- **Therefore:** frame the product to Jon as **strong best-effort synchronization that
  works well in normal conditions and degrades gracefully under peak load** — NOT a
  hard guarantee that all food lands in an exact window. Pitch is "meaningfully better
  synchronization," not "perfect."

## Proposed MVP architecture / scheduling logic
1. Maintain our own **per-item prep-time estimates** (seeded with reasonable defaults,
   refined from observed `prepared - sent` data over time).
2. On a group order, for each vendor compute:
   `fire_offset(vendor) = max_total_prep_across_group − (vendor_prep + queue_adjustment)`
   so all orders target the same finish time.
3. Submit **one order per vendor on the shared tab**, each with
   `scheduled = now + fire_offset`.
4. Continuously update `queue_adjustment` per vendor from live `sent`/`prepared` data
   (rolling average, optionally weighted toward most recent orders; consider padding
   when SENT count spikes).

## Environment / stack notes
- Developer runs **Windows + PowerShell** (account for this in any setup/run commands).
- GoTab API: REST reference + GraphQL (`ordersList`, `productsList` queries; `createTab`,
  `addTabItems` mutations).
- API support contact: api.support@gotab.io (rep: Zach)

### GoTab sandbox — PROVISIONED (2026-06-25); auth + location access VERIFIED (2026-06-26)
- **Locations (confirmed live via GraphQL `locationsList` — these are the real
  `locationUuid` values the adapter scopes every REST call by):**
  - parent **Detroit Shipping Sandbox** — `EL7tpX4xTFNCq~SnMrY_0EcZ`
  - child **Konjo Me Sandbox** — `ZQFbjpg06x4rf1w08RTuOhGa`
  - child **Motor Burger Sandbox** — `oSVMdw0wbSMqE~pOv7cUdkMd`
  - These are account identifiers (not secrets), so they live here for convenience.
    Two children is enough to validate cross-vendor sync on a shared tab; more are
    available on request (deferred until the larger 6–8 person / many-vendor case).
  - **CAUTION:** the parent and Motor UUIDs contain a literal `~`. URL-encode path
    segments when building `/api/loc/{locationUuid}/...` routes — do not assume the id
    is URL-clean.
- **Auth — OAuth, CONFIRMED working (2026-06-26).** Integration "Food Hall Sync - DSC".
  - **Flow: GoTab's Client Credentials flow** (server-to-server) — confirmed against
    the OAuth Flows doc (concepts/oauth-flows). GoTab has TWO flows; Client Credentials
    is the one to use, and the docs explicitly state it is the CORRECT flow for
    action/write operations (creating tabs, processing orders). The other flow
    (Authorization Code) scopes the token to a single user's permissions and **may lack
    the access needed for programmatic writes** — the docs warn that a permission error
    on a write endpoint usually means you're accidentally on Authorization Code. We are
    on Client Credentials, so we're set up correctly; if the real adapter ever hits a
    403 on a write, check this first. Implication for Zach's processor-ownership ask:
    access attaches to the **integration + `api_access_id`** (a user grants the
    *integration* access to specific `locationUuids`), not a personal user account.
  - Mechanically it is **NOT** the OAuth-standard form-encoded `grant_type=client_credentials`
    body — GoTab takes a **JSON body** POST to `https://gotab.io/api/oauth/token` with
    fields **`api_access_id`** + **`api_access_secret`** (optional `response_type` =
    `token` or omitted). (Same Client Credentials *grant*, non-standard *encoding*.)
    Response: `{ tokenType: "Bearer", token, refreshToken, initiated, expires,
    expiresIn: 86400, user_id }`. Refresh via a JSON POST with
    `grant_type: "refresh_token"` + `refresh_token`; the refresh token doesn't expire
    but is invalidated if access is revoked.
  - Token is a **Bearer** token in the `Authorization` header on every request; not
    base64-encoded. **24h TTL** — the adapter must cache and refresh before expiry.
    Error contract: **401** = expired/revoked (retry after refresh); **403** = invalid
    (do NOT retry without changing the request).
  - Credentials (`api_access_id` + `api_access_secret`) live ONLY in `.env` / secret
    store — never in this file, git, code, or chat. Read from env at runtime.
  - NOTE the config-name mismatch to fix when building the adapter: `.env` /
    `src/config/index.ts` currently use the placeholder names `GOTAB_API_KEY` /
    `GOTAB_API_SECRET`; rename to `GOTAB_API_ACCESS_ID` / `GOTAB_API_ACCESS_SECRET`
    (or similar) to match GoTab's actual field names.
- **Listing accessible locations is GraphQL, not REST.** There is no top-level
  `/api/locations` REST route (REST is location-scoped: `/api/loc/{location}/...`).
  POST to `https://gotab.io/api/v2/graph` with
  `query ($userId: BigInt) { user: userByUserId(userId: $userId) { locationsList { name locationUuid } } }`
  and `variables: { userId }` (the `user_id` from the token response). This is the
  query that returned the three UUIDs above.
- **Dashboard:** a separate UI login user exists — useful for visually watching orders
  fire during testing. Distinct from the API/OAuth path; don't conflate the two when
  debugging auth failures.

## Open empirical questions (to validate in sandbox, not by email)

**PRIORITY — the make-or-break test (resolves the ⚠️ block under "Scheduling" above).**
This gates the adapter build; do it FIRST, in this order. Endpoint confirmed:
`POST /api/loc/{locationUuid}/tabs` (closed tabs only). All of this is a REST path —
you have NOT made a successful REST call yet, only GraphQL.
1. **Get spots.** Query `spotsList` for Konjo and Motor via GraphQL
   (`location(locationUuid:){ spotsList { name spotUuid urlName zoneId } }`). Every tab
   needs a `spotUuid`. Nothing below works without this.
2. **First REST write — one closed tab on Konjo.** `POST /api/loc/{konjo}/tabs` with
   `openTab: false`, one of the seeded Konjo test items, a `spotUuid`, a `phoneNumber`,
   and `payments[]` that zero the balance (use the price-check route). Confirms the
   Bearer token works on REST resource routes and that you can place an order at all.
3. **Does `scheduled` accept a near-future TIME and fire then?** Submit with
   `scheduled` set ~3–5 min out (try a full timestamp, not just a date). Watch the
   dashboard / poll `ordersList`: does it sit SCHEDULED and release to the KDS at that
   moment, or get filed as a future-day pickup / rejected? **This is the single most
   important question in the whole integration.**
4. **Can two child-vendor orders share one tab?** Try to get a Konjo order and a Motor
   order onto the same tab. Since tabs are location-scoped, test whether the PARENT
   (`Detroit Shipping Sandbox`) tab can carry child-vendor products, or whether each
   vendor inherently needs its own tab. Determines if "shared tab" is real or a fiction.
5. **Record all four answers here**, then choose the adapter mode (`holdsSchedule`
   true vs false) BEFORE writing `gotab.ts`.

**Progress (2026-06-27):** Steps 1–2 partially cleared, then re-blocked on payment config.
- Spots: each child has ONE spot, type **"E-Commerce"** (takeout/online — the
  scheduling-capable kind). Konjo `spt_Fo3Not1quvTWJobPfptx7H_A` (zone 48710); Motor
  `spt_uChCvHTiaOBJ3N89zqFZNkog` (zone 48712). Different zones confirm Konjo/Motor are
  genuinely separate location contexts (relevant to Problem 3).
- **First successful REST write-path call** — `POST /api/loc/{konjo}/price-check`
  returned clean data (Konjo Test Item 3: `balanceDue 750`, no tax/fees). Confirms the
  Bearer token works on `/api/loc/...` REST routes, not just GraphQL. (Every earlier
  REST attempt 404'd from wrong paths; this is the first real one.)
- **Tab body shape VALIDATED.** `POST /api/loc/{konjo}/tabs` with `openTab:false`, the
  item, spot, `phoneNumber`, and `payments[]` parsed all the way through — GoTab
  accepted everything up to the payment method.
- **NEW BLOCKER — no payment processor on the sandbox vendors.** Closing the tab fails:
  `PROCESSOR_INVALID: "The processor CASH is not accessible at this location or does
  not exist"` (same for DOORDASH). `CASH` IS a real GoTab processor (help docs:
  "Processors: Cash, Gift Cards & House Accounts"), so the message is literal — the
  LOCATION has no processor configured. Normally self-served via the dashboard
  Processors page (+Add Processor → Cash), but that page is NOT exposed in this sandbox
  dashboard. **Emailed Zach 2026-06-27** to enable a Cash/test processor on Konjo +
  Motor. This is the documented "notify api.support to test payments" case — a config
  toggle on GoTab's side, not an architecture problem.
- **Once a processor exists:** retry the same tab call with `processor:"CASH"` → should
  close. Then immediately do step 3 (add `scheduled` ~3–5 min out, watch whether it
  fires to the KDS at that time) — the actual make-or-break question.
- **Processor follow-up (2026-06-27):** Zach replied asking which way to configure it,
  framed as the payment-ownership decision itself: (a) payment always flows through DSC
  → **Cash processor tied to my user** (his recommendation, unblocks testing; Cash
  accounts are server-assigned, closing simulates end-of-shift reconciliation), or (b)
  the integration captures payment via API → associate the integration credentials
  directly with a processor. **Chose (a) / Branch A** (see decision below). **Replied
  2026-06-27** confirming payment flows through DSC and asking him to set up Cash on
  Konjo + Motor. **One open question still out to Zach:** Cash is described as
  "server-assigned, closed via the POS" — asked whether a Cash tab can be zeroed and
  CLOSED through the API (`payments[]` with `processor:"CASH"`), not only in the POS UI,
  and if it's POS-only, what the right programmatic settle path is. If it's POS-only,
  that does NOT unblock the API-driven scheduled-fire test. Awaiting his answer.
- **Processor set up, but CASH STILL FAILS (2026-06-27).** Zach created Cash processors
  for the user on both Konjo + Motor and confirmed **closing a Cash tab is POS-only**
  (Cash accounts are server-assigned; settlement happens when a server pins in at the
  POS). He offered two programmatic-settle alternatives — (1) OAuth **Authorization
  Code** flow authenticating AS a server, so the integration inherits that server's
  Cash account, or (2) the Payment SDK/Wallet for an online-ordering user — both
  meaningful changes from the current Client Credentials setup. Retried the tab-create
  with `processor:"CASH"` on a fresh token → STILL
  `PROCESSOR_INVALID: "not accessible at this location or does not exist."` So the
  Client Credentials integration cannot see/use the server-assigned Cash processor —
  consistent with Zach's POS-only description. **Replied 2026-06-27** asking (a) the
  exact processor name/id to pass, and (b) the real question he himself raised ("do you
  even need to close the tab?"): since the goal is only to validate scheduled-order
  firing, is there an API path to submit a scheduled order WITHOUT a settling payment?
  - **KEY CONSEQUENCE — the blocker moved from SETTLEMENT to CREATION.** `openTab:false`
    (the only mode the API supports) requires `payments[]` to zero the balance, and that
    payment is exactly what fails — so right now NO order can be created via API at all,
    scheduled or otherwise. This directly stresses the `holdsSchedule = true` design,
    which depends on submitting scheduled orders through the API. If Zach confirms there
    is no API path to create an order without POS settlement, that is a strong push
    toward **`holdsSchedule = false`** (we hold the timers, fire via our own durable
    BullMQ jobs at the computed moment). NOT decided — his reply, or a working
    order-without-settlement path, resolves it. This is the live fork gating `gotab.ts`.
  - Self-serve lead to try while waiting: pass the **`productUuid` of Konjo's "Cash
    Payment" CUSTOM product** (`prd_oXKaTwifPXnH8N45L8mhcq3p`) in the payment method
    instead of the literal string `"CASH"` — some POS APIs reference the processor by
    its product id, and PROCESSOR_INVALID fires identically for "wrong name" and
    "doesn't exist," so the name theory is still open.
    → **TRIED (2026-06-27): FAILED, same `PROCESSOR_INVALID`** — error echoed the
    product UUID back ("The processor prd_oXKa... is not accessible at this location").
    So the field accepted the value as a processor candidate and still couldn't resolve
    it. Two different values (`"CASH"` and the product UUID), identical "not accessible"
    result → this is NOT a naming issue. **Conclusion: the Client Credentials
    integration genuinely cannot see any usable processor on these locations**, exactly
    the access boundary Zach's POS-only / server-assigned explanation predicted. Name-
    guessing is closed; the resolution is Zach's answer on the create-without-settlement
    path (or the `holdsSchedule = false` pivot).
- **Encouraging side-find:** the Loyalty-API docs show a real CLOSED tab whose order is
  still `status: SCHEDULED` with a full microsecond `scheduled` timestamp on a DINE-IN
  spot. So (a) `scheduled` CAN hold a precise time, not just a date, and (b) paid-and-
  closed does NOT force immediate firing — an order can be paid up front yet held
  SCHEDULED. That's the shape `holdsSchedule = true` wants. Still unproven that GoTab
  RELEASES it to the KDS at that exact moment — that's what step 3 tests — but Problem 2
  from the ⚠️ block now looks survivable.

**Other open questions (lower priority):**
- How accurate is the rolling-average queue adjustment against real DSC order data?
  (needs real kitchen load — a DSC-POC question, not a sandbox one.)
- ~~Payment ownership decision (roadmap 2.3)~~ **DECIDED 2026-06-27 → Branch A (GoTab/DSC
  owns payment).** Forced by Zach's processor-config question. Rationale: the
  integration handles order *timing*, not payment capture; closed-tabs-only already
  forces payment at tab creation; keeping PCI + payout + reconciliation entirely on
  GoTab's side is the right shape for the POC and very likely permanently. Also
  consistent with the intended monetization (flat per-venue subscription + onboarding
  fee, NOT a cut of sales — a sales cut would have pushed toward owning the payment
  layer). Implementation: `markPaid()` is driven by GoTab tab-payment events (poll or
  webhook), not our own Stripe-shaped mock route. Revisit ONLY if the product later
  needs to take a per-transaction fee at the payment layer. The Stripe seam stays in
  the code but dormant for the POC.

### Answered (recorded here as decision inputs)
- **Product-level `prepTime` semantics — ANSWERED (Zach + live test, 2026-06-26), no
  further sandbox test needed.** Optional, nullable, no default; unset → `null`. Zach
  said `0` coerces to `null`, but the live Konjo test showed explicit `0` → **`0`**
  (blank → `null`, 5 → `5`) — trust the wire; the adapter must handle a literal `0`.
  Unit is **minutes** (adapter ×60 to the scheduler's seconds). Operators commonly
  leave it blank (KDS display field, not a required input).
  **Decision input:** does not change architecture — confirms the own prep-time table /
  `PrepEstimator` ownership. Use GoTab `prepTime` as an onboarding seed only (treat both
  null and 0 as "no seed"), never a runtime scheduling dependency. See the expanded note
  in "Known limitations / open items" above.

## Status
- [x] Validated problem is real and not natively solved
- [x] Confirmed GoTab API supports per-order scheduling on a shared tab
- [x] Confirmed order timestamp/status granularity
- [x] Sandbox access provisioned (parent + 2 children; OAuth credentials issued) — 2026-06-25
- [x] Confirm OAuth mechanics + make first authenticated call (Phase 2.1) — 2026-06-26 (token + GraphQL locationsList both verified)
- [x] Build MVP scheduler (MVP + review fixes + must-have and should-have hardening tiers all verified — see dated sections below)
- [x] Run sandbox test plan — SUBSTANTIALLY DONE 2026-07-07 for we-hold-timers mode: submission schema verified, stagger fidelity measured (46ms error on 300s — see "THE NUMBER"), status latency ~0.2s. Remaining: GoTab-held scheduling (Zach), `prepared` (KDS ask), shared-tab/payment questions (2.3), load calibration (POC-era by design)
- [ ] POC at DSC
- [ ] Fastify 5 migration (clears npm audit criticals — see "Known issue" section; post-POC, pre-rollout)
- [ ] Consider broader rollout (loop in GoTab partnerships)

---

## Code review fixes — 2026-06-11

Full review of the MVP codebase found 7 issues; all are now fixed. What was wrong, what changed, and why, in priority order.

### 1. SECURITY: member session tokens leaked through public endpoints

**Wrong:** `GET /groups/:id` and the public board feed (`GET /halls/:hallId/active-groups`) serialized full `Member` rows via Prisma `include`, and `Member` carries `sessionToken` — the bearer credential the client uses to act as that member. Both endpoints are unauthenticated, so anyone could harvest every member's token (including the host's) and impersonate them: add items, pay, lock the group.

**Fixed:** `groups.routes.ts` now projects members through an explicit `memberPublicSelect` (`id`, `displayName`, `isHost`, `payStatus`, `createdAt`) everywhere members are serialized. A token is returned exactly once — to its owner, in the create/join response.

**Why this way:** an explicit allowlist `select` fails safe; future schema fields stay private unless deliberately exposed, unlike an `omit`-style denylist.

### 2. Payment timeout deadlocked the group

**Wrong:** `handlePaymentTimeout` deleted unpaid members' *items* but left the members in the group as `UNPAID`. `maybeSchedule` required *every member* to be `PAID`, so a timed-out group sat in `LOCKED` forever — the paid members' food never fired. Two secondary bugs in the same path: a vendor whose items were all dropped kept a live ticket (an empty ticket would have been fired to a kitchen), and the schedule wasn't recomputed after drops (if the slowest item was dropped, everyone's fire times were wrong).

**Fixed:** `maybeSchedule` now requires payment only from members who actually hold items, so zero-item members (dropped, or joined-but-never-ordered — the same logic also fixes that pre-existing hostage case) never block the group. After drops, empty tickets are `CANCELLED` inside the scheduling transaction and the schedule is recomputed from the surviving items. The delete itself re-checks `payStatus != PAID` and `group.status = LOCKED` inside the SQL predicate, so a member who pays in the race window between read and delete can't lose their items. If nothing remains, the group and its pending tickets are cancelled conditionally.

### 3. Schedule was anchored at lock time but firing was gated on payment

**Wrong:** `fireAt` offsets were computed from `lockedAt`, yet fire jobs only enqueued once everyone paid. A table that took four minutes to pay had fire times already in the past; `Math.max(0, delay)` fired *every* ticket immediately and simultaneously — the stagger (the entire product) collapsed exactly when groups paid slowly.

**Fixed:** the schedule is computed twice. `lockGroup` produces a *provisional* schedule anchored at lock (display estimate while paying). `maybeSchedule` *re-anchors* at the all-paid moment — the first instant cooking is actually allowed to begin — recomputing every `fireAt` and the group's `targetReadyAt` inside the scheduling transaction. `scheduler.ts`'s parameter was renamed `lockTime` → `anchor` to make the contract honest (pure math unchanged; tests pass unmodified since the argument is positional).

### 4. Adapter contract baked in "we own the timers," contradicting the decision gate

**Wrong:** this doc's preferred Phase-2 outcome is that *GoTab holds the timer* via per-order `scheduled` timestamps on a shared tab — and warns against building the job-queue layer speculatively. But `VendorAdapter.fireTicket()` was called *at* fire time by a BullMQ delayed job, with no way to express "submit now, scheduled for T+12min." The abstraction that was supposed to make GoTab a one-file swap couldn't represent GoTab's preferred mode at all.

**Fixed:** the contract is now `submitTicket({ …, scheduledFor, targetReadyAt })` plus a `holdsSchedule: boolean` capability flag, and `VendorTicketStatus` gained `SCHEDULED` (accepted by the platform, not yet released to the kitchen).
- `holdsSchedule = true` (GoTab scaffold): at the all-paid moment the app submits one order per vendor with future `scheduledFor` timestamps and runs **no fire timers** — the fire queue sits idle. The reconcile poll observes the platform firing each order (PENDING → FIRED on our side) and finishing it (→ READY). This is exactly the architecture this doc prefers, expressible without touching anything outside the adapter layer.
- `holdsSchedule = false` (mock): the app holds **durable** BullMQ delayed jobs (per this doc, in-memory setTimeout is unacceptable — a restart would mean a table never gets fed) and calls `submitTicket` at fire time.

**Why now:** doing this before sandbox access means the Phase-2 test plan slots straight into the `gotab.ts` scaffold, whose comments now carry the status mapping (GoTab PENDING/SCHEDULED → SCHEDULED, SENT → IN_PROGRESS, `prepared` set → READY) and the open verification items from this doc.

### 5. Mock adapter undermined demos and dev flows

**Wrong (a):** mock cook time was `30s + 20s × itemCount` — unrelated to the `prepSeconds` the scheduler used — so the customer countdown hit "Ready!" while tickets were still IN_PROGRESS, or finished long after. The demo's whole point (synchronization) looked broken even when the code was right.

**Fixed (a):** the mock kitchen now finishes exactly at the request's `targetReadyAt` (with a 60s fallback if a ticket fired late). The simulation agrees with the prediction by construction; any drift observed in a demo now comes from real code paths. It also honors a future `scheduledFor` (reporting SCHEDULED until then), so the GoTab-held mode can be demoed by flipping `holdsSchedule`.

**Wrong (b):** mock state is in-memory; after a worker restart, `getTicketStatus` returned `CANCELLED` for unknown order ids, and the reconcile loop then erroneously cancelled live tickets.

**Fixed (b):** unknown ids now report `READY` with a loud warning — dev flows complete instead of corrupting state. Real adapters query persistent platform state and never hit this branch.

### 6. Race conditions in state transitions; no fire-job retries

**Wrong:** the lock and schedule transitions were check-then-act (read status, then update unconditionally). A double-tapped lock button could create duplicate ticket sets; concurrent payment callbacks could both run the scheduling block. And fire jobs had no retry config — a transient DB error after the adapter accepted left a ticket PENDING forever.

**Fixed:** every state transition is now a conditional `updateMany({ where: { status: expected } })` whose row count is checked — in `lockGroup` (inside the transaction, so losing the race rolls back the duplicate tickets too), `maybeSchedule` (exactly one of N concurrent callers proceeds), `handlePaymentTimeout`, `markTicketReady`, `markGroupFired`, and the reconcile transitions. Fire jobs got `attempts: 5` with exponential backoff — safe because submission is idempotent on `ticketId` at both our layer (PENDING-only guard) and the adapter's (dedupe map / GoTab client reference).

### 7. Smaller fixes

- **Cross-hall item injection** (`groups.routes.ts`): `POST /groups/:id/items` accepted any valid menu-item id; it now rejects items whose vendor belongs to a different hall than the group. Harmless with one hall, but the schema is multi-tenant from day one and this doc requires hall filtering on every query.
- **Dead `GroupStatus.FIRED`** (`status.service.ts`): the enum value existed and the board filtered on it, but nothing ever set it. New `markGroupFired()` conditionally moves a group SCHEDULED → FIRED when its first ticket hits a kitchen, in both adapter modes.
- **Windows production start** (`server.ts`): the run-directly detection compared `` `file://${argv[1]}` `` to `import.meta.url`, which never matches on Windows (drive letter + backslashes need `pathToFileURL` encoding) — `node dist/server.js` silently exited without listening. Dev via tsx was unaffected. Now uses `pathToFileURL(process.argv[1])`.
- **Renames for honesty:** `reconcileFiredTickets` → `reconcileSubmittedTickets` (it now also watches PENDING tickets the platform is holding); scheduler param `lockTime` → `anchor`.

### 8. Found during verification: `npm run typecheck` was already failing (4 pre-existing type errors)

The fixed codebase was typechecked and unit-tested in a sandbox after the changes above (result: 0 errors, 5/5 scheduler tests pass — including the `anchor` rename). That run surfaced four *pre-existing* compile errors unrelated to the review fixes; all are now fixed too:

- **`Fastify({ loggerInstance })`** (`server.ts`): `loggerInstance` is a Fastify 5 option; this project pins Fastify 4, where a pino instance is passed via `logger`. This one error also cascaded into a confusing `setErrorHandler` overload error (TS fell back to the http2 instance type), which disappeared with the fix.
- **Conflicting `FastifyRequest.user` augmentation** (`auth.routes.ts`): the file re-declared `user?: JwtPayload` on FastifyRequest, but `@fastify/jwt` already declares `user` with a different type — a hard compile conflict. Replaced with the plugin's supported extension point: augment `FastifyJWT { payload; user }`, which also types `app.jwt.sign()` and `req.user` correctly.
- **Duplicate-ioredis type clash at the BullMQ boundary** (`queues.ts`, `worker.ts`): npm nests a second ioredis copy under bullmq, and the two copies' types are structurally incompatible (protected class members) even though the instance works at runtime. Localized, commented `as unknown as ConnectionOptions` casts at the two boundary points keep typecheck green regardless of node_modules layout. (This clash also caused the spurious `queue.add()` name-type errors — they vanished with it.)

**Caveat on verification scope:** the sandbox cannot download Prisma query engines, so `@prisma/client` was stubbed as `any` there — meaning Prisma *model-level* query typing (field names in `where`/`data`/`include`) was NOT machine-verified. Run locally to close that gap:

```powershell
npm run typecheck; npm test
```

### Follow-ups deliberately NOT done

- **No recovery sweep for failed holdsSchedule submissions.** If `submitTicket` fails at the all-paid moment in GoTab mode, the ticket stays PENDING without an external id and the failure is logged loudly; an automatic retry sweep belongs in Phase 2 next to the real adapter, where the actual failure modes (auth, rate limits, validation) are known.
- **`firedAt` is not backfilled** when the reconcile poll sees a platform-held ticket jump straight from SCHEDULED past SENT to prepared between polls (10s window); the ticket goes PENDING → READY and `firedAt` stays null. Cosmetic; revisit if fire-time analytics matter.
- **Payment-model divergence left open.** The codebase takes payment itself (mock, Stripe-shaped seam) and then schedules; GoTab's model puts payment on the shared tab. Which side owns payment is a sandbox-era decision — the adapter seam doesn't prejudge it.

---

## Hardening pass — must-have tier (2026-06-11)

From the architecture review: four items that must land before real diners order at DSC. The bar for "must have" is a single failure mode — **a table silently not getting fed** — because that is what kills the POC socially. Everything here either prevents that, detects it within a minute, or captures the data the product's calibration loop and pitch depend on. Nothing here changes the system's shape (still a monolith + worker).

### M1. Reliable all-paid → submitted transition (job-based orchestration + stuck-state sweep)

**What:** Payment no longer triggers scheduling inline in the HTTP request. `markPaid()` now only records the payment and enqueues a durable `scheduleGroup` job (per-payment jobId, 5 attempts, exponential backoff); a new worker consumer runs `maybeSchedule()`. On top of that, the worker runs a 60-second **sweep** as a backstop: any PENDING ticket with no external order id whose group is SCHEDULED/FIRED (past `fireAt` + 30s grace in we-hold-timers mode; immediately in platform-held mode) is re-driven through `redriveTicket()`, and the detection is logged at error level.

**Why:** This was the highest-consequence gap. The old inline path flipped the group to SCHEDULED and then did queue writes / vendor network calls from inside the payment request — if the process died or a submit failed in that window, the group was SCHEDULED with nothing actually queued, and the only trace was a log line. Now (a) the orchestration runs in the worker with BullMQ retry semantics, (b) vendor I/O is out of the request path (the payer's HTTP response no longer depends on N vendor calls), and (c) even a lost job is found by the sweep within a minute, because every submission path is idempotent on `ticketId`, making re-drives safe. This also supersedes the earlier "no recovery sweep" deliberate omission — with a general mechanism rather than a GoTab-specific patch. The jobId is per payment event (`schedule:{groupId}:{memberId}`), not per group, deliberately: a per-group jobId can dedupe away the *last* payment's job while an earlier, already-running job has read stale not-all-paid state — the classic dedupe race. Multiple jobs are harmless because `maybeSchedule`'s conditional LOCKED→SCHEDULED flip already guarantees exactly-once scheduling.

The sweep also covers two group-level stuck states: LOCKED groups past `PAYMENT_TIMEOUT_SECONDS` + grace (a lost payment-timeout job) get the timeout handler re-run, and idle OPEN groups are expired (see M4).

### M2. Worker liveness (heartbeat + health surfacing)

**What:** The worker writes a heartbeat to Redis every reconcile tick (10s). `GET /api/health` now reads it and reports `status: "ok" | "degraded"` plus `worker: { alive, lastHeartbeatMsAgo }` (alive = beat within 60s). One endpoint now covers both processes.

**Why:** If the worker dies, nothing fires, nothing reconciles, no timeouts run — while the API keeps cheerfully accepting orders. That is the invisible-failure version of "a table doesn't get fed." A heartbeat is one Redis SET; surfacing it through the health endpoint means any uptime monitor pinging `/api/health` (which the venue deployment should have anyway) catches a dead worker in under a minute instead of via an annoyed operator. The API deliberately still returns HTTP 200 when degraded — a supervisor watching the API process must not restart the *API* because the *worker* is down; monitors should alert on the `status` field.

### M3. Prediction-vs-actual telemetry (`ScheduleOutcome`)

**What:** A new append-only table, one row per scheduled group. Written inside the scheduling transaction with the prediction (`scheduledAt` anchor, `targetReadyAt`, vendor/item counts); finalized at group completion with the actuals (`firstReadyAt`, `lastReadyAt`, `readySpreadMs`, `targetErrorMs`). Per-ticket detail (planned fire vs `firedAt` vs `readyAt`) already lives on Ticket rows and joins by `groupId`; `foodHallId` is denormalized for per-hall analysis.

**Why:** The project plan's calibration loop ("refine prep estimates from observed data") and the pitch to Jon ("meaningfully better synchronization") both require evidence that does not exist unless captured from the first real order. `readySpreadMs` — the gap between the first and last dish landing — IS the product KPI; `targetErrorMs` measures prediction honesty. This is not observability garnish, it's the data asset the product is built on, which is why it ships in the must-have tier rather than as a later analytics project. Recording at schedule time + completion time means cancelled-mid-flight groups simply have null actuals, which is itself signal.

### M4. Abuse limits + lifecycle expiry on the public surface

**What:** `@fastify/rate-limit` registered with `global: false`; per-route limits only on the abuse-sensitive mutating endpoints — group create (30/min/IP), join (60/min/IP), login (20/min/IP), bootstrap-admin (5/min/IP). Plus a sweep that cancels OPEN groups older than `GROUP_OPEN_EXPIRY_HOURS` (env, default 6).

**Why:** These endpoints are unauthenticated by design and sit behind a QR code in a public venue; without limits, one script can create unbounded groups/members/tokens forever (rows never expired). The limits are deliberately NOT global and deliberately generous: at a venue, every diner shares the venue NAT's public IP, so an aggressive per-IP global limit would throttle legitimate Friday-night traffic collectively — the limits chosen stop scripted abuse (thousands/min) while being far above what a busy service produces on the create/join endpoints specifically. Read endpoints (menu, board feed) are uncapped for the same reason. Expired groups go to CANCELLED, which also bounds the authority of their members' session tokens: every mutating route gates on group status, so a token from a cancelled group can no longer do anything.

### Required local steps (PowerShell)

```powershell
npm install                                    # picks up @fastify/rate-limit
npx prisma migrate dev --name schedule-outcomes  # creates ScheduleOutcome, regenerates client
npm run typecheck; npm test
```

Note: `npm run typecheck` will fail on the new `prisma.scheduleOutcome` calls until the migrate step regenerates the Prisma client — run them in this order.

### Explicitly deferred (should-have tier, unchanged)

Response-schema allowlists, lifecycle integration tests (testcontainers), soft-delete for timed-out items, the prep-estimate provider seam, DB-level partial-unique constraints, and webhook-shaped status ingestion. None of these block the POC; several (estimate provider, webhooks) are better built with sandbox data in hand.

---

## Known issue — Fastify 5 migration (scheduled, post-POC) — 2026-06-12

`npm audit` reports 12 vulnerabilities (5 moderate, 5 high, 2 critical). Triage against this codebase's actual usage, and the plan:

### Triage

- **Moderate (esbuild / vite / vitest chain):** dev tooling only. The advisory concerns a vite *dev server* accepting cross-origin requests; this project never runs one (vitest uses vite solely for test transforms). No production exposure. Cleared by the vitest 4 bump below.
- **Critical (`fast-jwt` inside `@fastify/jwt` ≤ 9):** this is the real one — it's the auth path for admin/vendor logins. Read against our usage, none of the published exploit paths currently applies: we use a static HS256 shared secret (no RSA → no algorithm confusion), no async key resolver (→ no empty-secret bypass), no token caching (→ no cache-confusion identity mixup), and we don't validate `iss`. Every remaining path still requires knowing `JWT_SECRET` (config enforces ≥16 chars). **Acceptable for a single-venue POC with one seeded admin — but this is "the advisories don't apply to my exact usage" reasoning, which rots as code evolves. It must not survive past the POC.**
- **High (`fast-uri` inside fastify ≤ 5.8.2 validation/serialization internals):** low practical exposure — input validation is Zod, not fastify schemas with URI formats, and fast-json-stringify response schemas aren't used (yet; they're a should-have item, which makes clearing this *before* adopting response schemas mildly load-bearing).

### Why not `npm audit fix --force` now

It would install **fastify 5 + @fastify/jwt 10 + vitest 4 simultaneously** — three major upgrades in one unreviewed shot, guaranteed breakage, zero urgency given the triage above. The fix is a deliberate migration, not an audit autofix.

### The migration (one contained changeset)

- `fastify` 4 → 5, plus plugin majors: `@fastify/jwt` 10 (clears the critical), `@fastify/cors`, `@fastify/static`, `@fastify/websocket`, `@fastify/rate-limit` 10.
- `vitest` 4 (clears the dev-chain moderates).
- Known code touchpoints: `server.ts` logger option flips BACK to `loggerInstance` (the v5 option removed during the 2026-06-11 typecheck fixes because we're on v4 — the original code was accidentally ahead of its time); re-verify the `@fastify/jwt` FastifyJWT augmentation and the websocket route handler signature against the v10/v11 APIs; re-check the per-route `config.rateLimit` shape.
- Acceptance: `npm run typecheck; npm test` green, demo flow + /api/health smoke pass, `npm audit` shows no high/critical.

### Timing

**Not before the DSC POC** (no urgent exposure; don't destabilize the demo). **Before anything beyond it** — broader rollout, real payment integration, or any second venue. Auth-library debt is the kind you pay on your own terms or someone else's.

---

## Hardening pass — should-have tier (2026-06-12)

The six items from the architecture review's second tier. Theme: the must-have tier made failures recoverable and visible; this tier makes regressions **structural** — caught by the serializer, the database, or a test, instead of by careful reading.

### S5. Response schemas as output allowlists

**What:** Fastify `schema.response` (fast-json-stringify) on every public endpoint: group view, board feed, group create/join, hall menu, default hall. The serializer emits ONLY declared fields.

**Why:** Routes were returning Prisma object graphs directly, coupling the DB schema to the client contract — the session-token leak was exactly the failure mode that produces, and the fix relied on remembering to use a careful `select`. A response schema makes the allowlist structural: the next sensitive field added to a model is invisible to clients unless someone deliberately declares it. Field sets were derived by auditing what `public/*.html` actually reads, not by guessing — notably the admin page reads `gotabLocationId` and `available` from the public menu endpoint (so the menu schema keeps them), while group views now structurally strip `gotabLocationId` from the vendor objects diners receive (it previously leaked through `menuItem.vendor`). `/payments/me` is deliberately left unschema'd: owner-scoped via member token, and trimming an owner's view of their own data buys nothing.

### S6. Integration tests for the state machine

**What:** `npm run test:int` — a vitest suite (`src/test/integration/`) running the real services against real Postgres + Redis: full lifecycle to COMPLETED with telemetry finalized, double-lock produces exactly one ticket set, concurrent final payments schedule exactly once, payment timeout drops the slowest item and re-anchors tighter, nobody-pays cancels cleanly, fire is idempotent, redrive works, zero-item members don't block, and one HTTP-level test (`fastify.inject`) asserting the response allowlist (no `sessionToken`, no `gotabLocationId`, no dropped items in group views).

**Why:** All seven bugs from the code review lived in lock/pay/timeout/schedule orchestration; zero lived in the unit-tested pure math. This is where the system's risk concentrates and it was covered only by careful reading.

**Deviation from the original suggestion (testcontainers):** the suite points at the existing docker-compose Postgres/Redis instead — a separate `foodhall_test` database (created/synced by `prisma db push` in global setup) and **Redis db 1** (so queues never collide with the dev worker on db 0). Rationale: zero new dependencies, no dockerode flakiness on Windows, reuses infra that's already running. Testcontainers is the upgrade path if hermetic CI ever needs it. Requirements: `docker compose up -d` first; tests run serially (`fileParallelism: false`) because they truncate shared tables.

### S7. Stop hard-deleting order items on payment timeout

**What:** `OrderItem.status` (`ACTIVE` | `DROPPED`) + `droppedAt`. The timeout path now marks items DROPPED instead of `deleteMany`. Every read that feeds scheduling, kitchens, payments, or client views filters `status: ACTIVE`.

**Why:** Hard delete destroyed the record that someone ordered and bailed — bad for the calibration dataset (S3/M3), bad for disputes ("I paid and my food vanished"), and it made the timeout path the only irreversible operation in the system. Semantics chosen: **group views return only ACTIVE items** (identical client behavior to the old delete, zero frontend change — the audit trail lives in the DB, not the UI), and **pre-lock cart removal stays a hard delete** (editing a cart is not an audit event; the audit value is post-lock, where money and the timeout are involved).

### S8. Split "prep time" from "price"

**What:** A `PrepEstimator` seam (`src/modules/scheduler/prep-estimates.ts`): `estimate(items) -> Map<menuItemId, seconds>`. The re-anchor step in `maybeSchedule` now schedules from estimator output. The static implementation returns the menu item's **current** `prepSeconds`, falling back to the snapshot if the item was deleted.

**Why:** Price and prep were both snapshotted at add-time, but they're different kinds of data: price is contractual and SHOULD be frozen; prep is a prediction and should be the freshest estimate available at the moment fire times are computed (an admin correcting a wrong prep time mid-evening should affect the next group, not the next deploy). This is exactly the seam the doc's Phase-2 `queue_adjustment` logic needs — the rolling `prepared − sent` averages and SENT-count padding plug in as a new estimator implementation, touching one module. The provisional lock-time schedule still uses snapshots (display-only, not worth a query).

### S9. Database-level invariants

**What:** `Ticket.gotabOrderId` becomes `@unique` (Postgres allows multiple NULLs, so unsubmitted tickets are fine); the separate `[status]` and `[fireAt]` indexes are replaced by a composite `[status, fireAt]` (serves the reconcile and sweep query shapes; the leading column still serves status-only filters); and a **partial unique index** `(groupId, vendorId) WHERE status <> 'CANCELLED'` — at most one live ticket per vendor per group, the invariant the double-lock race guard protects.

**Why:** Application-level guards catch the races you thought of; constraints catch the ones you didn't. **Prisma caveat:** partial indexes can't be expressed in `schema.prisma`, so the index is appended to the generated migration (`scripts/append-partial-index.ps1`, Prisma's documented "customize a migration" workflow). If a future `prisma migrate dev` ever proposes dropping `Ticket_groupId_vendorId_live_key`, that's the known limitation — delete the DROP from the generated SQL, don't accept it. `lockGroup` now also maps a P2002 unique violation to the same 409 the in-app guard returns, so a concurrent double-lock caught by the index reads identically to one caught by the guard.

### S10. Webhook-shaped status ingestion — designed now, deliberately NOT built

The contract, so sandbox Phase 2 can test push without redesign if GoTab offers webhooks:

- `POST /api/webhooks/gotab` — raw-body HMAC signature verification (shared secret from env) BEFORE parsing; reject on mismatch, 2xx fast after enqueueing/handling so the platform doesn't retry-storm.
- Payload maps GoTab order status to the same transitions the poll uses: `SENT` → the reconcile's PENDING→FIRED branch; `prepared` set → `markTicketReady()`. **No new state logic** — every transition in `status.service.ts` is already a conditional `updateMany`, so duplicate/out-of-order/replayed webhooks are no-ops by construction. That idempotency was built in the first review pass; this design just cashes it in.
- Lookup by our ticket id passed as GoTab's external reference at submission (already planned in the adapter scaffold), falling back to `gotabOrderId` (now unique, S9 — a safe lookup key).
- The 10s poll REMAINS as fallback (webhooks get dropped; the poll is the sweep-equivalent backstop). Built later because building signature verification against an imagined payload is wasted motion — the real shape arrives with sandbox access.

### Required local steps (PowerShell, in order)

> **CORRECTION (2026-06-12, after first run):** the original sequence ran with
> Docker down. `--create-only` failed (P1001), and the append script then
> targeted "the latest migration" — the **already-applied**
> `schedule_outcomes` migration — corrupting its recorded checksum. The script
> now carries two guards (index-already-exists anywhere → no-op; latest folder
> must be a `should_have_tier` migration → abort otherwise) so that failure
> mode is impossible to repeat. Consequences accepted: the partial index
> permanently lives inside `20260612040407_schedule_outcomes` (cosmetically
> misplaced, functionally identical — Ticket exists at that point in history),
> and the dev database is reset (seed/demo data only). The append script is
> NOT run in the corrected flow — it would no-op anyway via Guard 1.

```powershell
docker compose up -d
npx prisma migrate reset --force   # wipes DEV db, replays history (incl. the index), regenerates client
npx prisma migrate dev --name should-have-tier   # the schema-representable changes; do NOT run the append script
npm run seed
npm run typecheck; npm test
npm run test:int          # uses foodhall_test DB + Redis db 1
```

The 36 typecheck errors from the first run were all one thing: the Prisma
client was never regenerated because no migrate step succeeded — every error
is `OrderItem.status` (or a cascade of it) missing from the stale client.
They disappear after the migrate steps above.

### First integration run: caught a real production bug (2026-06-12)

The suite's first execution failed 8/9 — 7 of them with one root cause:
**BullMQ rejects custom job ids containing `:`** (it's the Redis key
delimiter), and every custom jobId in the codebase used colons
(`timeout:{groupId}`, `fire:{ticketId}`, `schedule:{groupId}:{memberId}`).
Consequence in production code, not just tests: locking a group threw AFTER
committing the lock (group LOCKED, tickets created, timeout job never
enqueued, 500 returned), and marking paid threw at the schedule-job add. The
8th failure (double-lock expecting one winner, got zero) was the same bug —
the winner also threw at the post-commit job add. Never caught earlier
because nothing before this suite actually executed the queue-add paths at
runtime. Fixed: underscores in all custom job ids. This is precisely the bug
class S6 exists for — orchestration code that types fine and reads fine but
fails against real infrastructure.

**Browser smoke follow-up (same day):** the first real browser run surfaced a
second latent original-MVP bug — both frontend `api()` helpers set
`Content-Type: application/json` unconditionally, and `/lock` and `/pay` are
body-less POSTs, which Fastify correctly rejects with "Body cannot be empty
when content-type is set to 'application/json'". Fixed in both helpers
(header only when a body exists) and pinned server-side by an HTTP
regression test: body-less, header-less POST `/lock` must return 200.

Int tests were typechecked but could not be RUN in the sandbox (Prisma engines can't download there) — first local run was the real verification. **Status: after the job-id and body-less-POST fixes, the full suite passes 10/10 locally (2026-06-12)** — lifecycle, races, timeout/DROPPED semantics, idempotency, redrive, the HTTP allowlist, and the body-less `/lock` regression, all against real Postgres + Redis. The should-have tier is complete and verified. `npm run check` chains typecheck → unit → integration as the pre-demo/pre-commit gate.

---

## GoTab menu import — SHIPPED (2026-07-01)

Admin can onboard a vendor by pulling its live catalog from GoTab instead of
hand-typing the menu. **First time the app itself (not manual PowerShell) calls
GoTab, and it's verified end-to-end against the real Konjo sandbox** — 4 items
pulled with real prices, prep-flagged correctly. This is a pure catalog READ, so
it is UNBLOCKED by the settlement fork that still gates order submission.

**What it does:** enter a GoTab `locationUuid` + vendor name in the admin screen
→ the app reads that location's products via GraphQL `productsList`, creates the
vendor and its menu items, and flags items GoTab has no prep time for so the
admin can set a real one inline.

**Pieces built:**
- `VendorAdapter.listProducts(locationUuid)` — on the interface, mock, and real
  `gotab.ts`. Returns `{ locationName, products }` (one GraphQL query fetches the
  location `name` alongside `productsList`). Filters `productType == CUSTOM`
  (back-office payment instruments like "Cash Payment") and non-orderable items,
  maps `basePrice`→cents, `prepTime` (minutes)→seconds.
- **Vendor name auto-populates from GoTab** — the location's own name is the
  default; the admin name field is an optional override (blank = use GoTab's).
  GoTab returns the full hierarchy ("Konjo Me Sandbox - Detroit Shipping
  Sandbox"), so the override exists for a clean customer-facing name ("Konjo
  Me"). Both paths verified live.
- `getImportAdapter()` factory — **import always talks to REAL GoTab when creds
  exist, regardless of `VENDOR_ADAPTER`.** Rationale: importing is a read
  (unblocked); firing is a write (blocked). So the app can run the mock fire path
  while importing real menus. Falls back to mock only when no creds are set.
- `POST /api/halls/:hallId/vendors/import-gotab` (ADMIN) — upserts vendor by
  (hall, gotabLocationId) + items in one transaction. Idempotent: re-import
  matches items by `gotabProductUuid` and updates in place, never duplicating,
  never clobbering an admin-corrected prep.
- Schema: `MenuItem.gotabProductUuid` (`@@unique([vendorId, gotabProductUuid])`;
  Postgres NULLs distinct, so hand-added items coexist) + `MenuItem.prepConfirmed`
  (default true). Migrations `gotab_product_uuid`, `menu_item_prep_confirmed`.
- Admin UI: "Import from GoTab" card; per-item editable prep field + save
  (`PATCH /items/:id`), unconfirmed items shown with a red "needs prep" flag and
  a blank prep input.

**PREP-TIME HONESTY — the important design call (user-driven correction).** The
first cut wrote a fabricated 5-min placeholder for items GoTab had no prep for.
That was wrong: an invented value that looks real is worse than an honest
absence, and it silently violated this doc's own "treat null/0 as unset" stance.
Corrected to: store GoTab's ACTUAL value (0 when absent), mark
`prepConfirmed = false`, and surface it. `PATCH /items/:id` sets
`prepConfirmed = true` when an admin enters a real prep. Manual-add and
pre-existing items are confirmed by the column default. Full loop verified:
import → flagged blank → admin sets real prep → confirmed/available.

**DEFERRED (the correct end state, deliberately NOT rushed):** enforcement. An
unconfirmed item is still technically orderable — the scheduler would use its 0
prep and mis-stagger if someone ordered it before an admin fixed it. Making
`prepConfirmed = false` items non-orderable (likely `prepSeconds Int?` + a
menu/scheduler guard) touches the tested scheduler core, so it was left as a
follow-up. `prepConfirmed` is the breadcrumb. This is the "option 1" in the
roadmap 2.4a note.

**Relationship to the blocker:** none — this is orthogonal to the `submitTicket`
/ settlement fork. It made vendor onboarding real and exercised the auth + read
adapter layers against live GoTab for the first time (previously only
unit-tested), without depending on how the payment question resolves. Unit tests
still 12/12; typecheck clean.

**Env note (new PC, 2026-07-01):** project moved to
`C:\Users\rossl\Projects\foodhall`; full setup re-verified green (`npm run
check`: typecheck + 5 unit + 9 integration — the doc's "10" is a label
discrepancy; the suite is 9 test cases). Windows Prisma gotcha confirmed: the
running dev server + worker lock `query_engine-windows.dll.node`, so
`prisma generate` / `migrate dev` throw EPERM on the engine rename unless BOTH
node processes are stopped first. Stop server + worker → generate/migrate →
restart.

---

## Full-codebase review — 2026-07-02

Complete read of both docs and every file in the repo (all migrations, all src
modules, all adapter files, all frontends, scripts, configs; `.env` excluded on
principle, `package-lock.json` as generated). Docs and code agree almost
everywhere; the conditional-updateMany discipline, S5 allowlists, sweep
branching on `holdsSchedule`, and import re-import semantics all check out as
written. Findings below, worst first.

### Bugs / latent traps

1. **[FIXED 2026-07-02] Empty-string credentials defeat the fallback and the
   import adapter.** `resolveGoTabCredentials()` and `getImportAdapter()` used
   `??` to prefer `GOTAB_API_ACCESS_ID/SECRET` over legacy `GOTAB_API_KEY/
   SECRET` — but `??` only falls through on null/undefined, and a
   present-but-blank line in `.env` (exactly what `.env.example` ships) is
   `''`, not nullish. Consequences: blank ACCESS_* vars shadowed populated
   legacy vars (boot error), and `getImportAdapter()`'s `hasCreds` went falsy
   → **import silently used the mock while looking configured.** Fix: config
   schema now preprocesses blank env values to `undefined` on every optional
   GoTab field (creds + URLs — a blank `GOTAB_API_BASE`/`GOTAB_OAUTH_URL` also
   used to fail `.url()` and kill boot), and the two consumers use `||` as
   belt-and-braces.
2. **[FIXED 2026-07-02] Stored XSS via diner display names.** All
   frontends built DOM by string-concatenated innerHTML. `Member.displayName`
   is unauthenticated diner input rendered into other members' browsers
   (customer `renderSummary`/`renderMyOrder`); a name like
   `<img src=x onerror=…>` ran script as every group member (could lock, pay,
   remove items as the victim). Milder variant: GoTab product/location names
   rendered unescaped in the authenticated admin page. **Fix:** an `esc()`
   helper (entity-escapes `& < > " '`) added to all three UIs and applied
   uniformly to EVERY dynamic string interpolated into innerHTML — user input,
   GoTab-derived names, and our own enums alike (a uniform rule beats
   per-string judgment). Element ids / onclick args deliberately left
   unescaped: our own Prisma UUIDs, hex+dashes only. Smoke-verified in the
   browser: a host named `<b>bold</b>` renders as literal text in the group
   view. Frontends were rewritten whole — edit_file has corrupted this
   concatenated HTML twice; always full-file rewrite for public/*.html.
3. **[OPEN — roadmap 3.2] `trustProxy` never set — rate limiting inverts
   behind a production proxy.** M4's per-IP limits assume `req.ip` is the
   client; behind Render/Railway's LB it's the proxy, so the whole venue
   shares one bucket and Friday night collectively hits the 30/min
   group-create cap — the exact failure M4's design avoided. Production
   config must set `trustProxy` appropriately. Recorded in roadmap 3.2.
4. **[OPEN — fix when it bites] Parent-location import will likely blow the
   transaction timeout.** Import does 2 sequential queries per product inside
   one interactive Prisma transaction (default 5s). Konjo's 4 items are
   trivial; the parent sandbox rolls up ~400 products → ~800 round-trips →
   P2028 on any remote Postgres. Fix: batch (one findMany on all UUIDs +
   createMany / targeted updates) or raise the transaction timeout.

### Design gaps (decide deliberately)

5. **Admin page can't see hidden items or inactive vendors.** It reads the
   PUBLIC menu endpoint (filters `active`/`available`), so the "hidden" pill
   is dead code, `hideItemsMissingPrep` would make items vanish from the
   admin's own view with no way back, and deactivating a vendor removes it
   from management. Latent (nothing sets available=false yet). Needs an
   admin-gated unfiltered menu view before any hide/deactivate feature.
6. **Pay-after-drop leaves a paid member with dropped items and no refund
   path.** Pay route accepts LOCKED *or SCHEDULED*; a timed-out member can pay
   after their items were DROPPED. `PayStatus.REFUNDED` exists but nothing
   sets it. Mock-money harmless; Branch A may make the route dormant — but if
   mock pay survives into the POC, reject SCHEDULED payment from members with
   zero ACTIVE items.
7. **Unconfirmed-prep hazard is customer-visible today** (priority bump on the
   documented deferred item): unconfirmed imported items show "~0 min" on the
   customer menu, are orderable, and the estimator returns their current 0
   prep (overriding even the snapshot) → they fire last with zero cook time
   budgeted. Do the enforcement follow-up BEFORE seeding real DSC menus via
   import.

### Doc drift (batch-fix)

- README: still says the GoTab scaffold sets `holdsSchedule = true` and
  "implement the three methods" (it's four, default false, fork unresolved);
  no mention of the import feature or prepConfirmed.
- `.env.example`: **[FIXED 2026-07-02]** named the OAuth var
  `GOTAB_OAUTH_TOKEN_URL` while config reads `GOTAB_OAUTH_URL` (masked only
  because the default equals the right URL); still called the ACCESS_* rename
  "owed" though done; lacked the `GOTAB_API_ACCESS_ID/SECRET` lines the code
  prefers. Now matches config.
- `scripts/*.ts` sit outside tsconfig `include` — `reset-konjo.ts` is never
  typechecked. `mutations.json` is an unlabeled introspection dump at repo
  root (harmless; label or move to docs/ someday).

### Suggested order

#1 + `.env.example` together (done); #2 XSS escaping (done, smoke-verified);
#3 as a roadmap-3.2 line (done); #4–#6 recorded known-issues; #7 folded into
the existing enforcement follow-up with raised priority.

---

## Dynamic prep-time estimation — DESIGNED (2026-07-02), not built

Full design in **`prep-estimation-design.md`** — expanded same day into a
two-part document: Part I design rationale, **Part II a full implementation
specification written for a lesser-model implementer** (exact schema blocks,
function signatures with worked numeric examples as required unit tests,
per-phase file lists and acceptance gates, and the codebase's recorded
landmines: `.js` ESM suffixes, pure-modules-don't-import-config, BullMQ
job-id colons, Windows EPERM migrate dance, int-test truncation list,
full-file-rewrite-only for frontends). One v1 simplification made during the
spec pass: observation data SUGGESTS prep values but only `prepConfirmed`
gates orderability — no auto-enabling items from data.

The system answers both flavors of prep-time uncertainty — unknown
(blank/wrong values) and non-stationary (rush-hour drift) — and is the direct
answer to this doc's load-modeling caveat. The one-paragraph version:

Decompose every estimate into **per-item cook time** (p50 of uncontended
observations, Bayesian-shrunk toward the admin value, per-vendor calibration
multiplier as the thin-sample fallback) plus **live vendor queue wait**
(current SENT depth ÷ recent bump rate — Little's law on a live signal, which
is the structural fix for "rolling averages run optimistic exactly during
rushes"), with a learned time-of-day table as fallback and hard clamps
(0.5×–3× admin prior) everywhere. Plugs into the S8 seam by folding vendor
wait into each of that vendor's item estimates (scheduler takes max per
vendor, so +W on every item = ticket prep + W) — **scheduler, seam signature,
and all existing tests untouched.** Observations come from our own tickets
AND location-wide GoTab `ordersList` (walk-up orders at the same kitchens —
the data multiplier; a read, unblocked by the settlement fork, but needs live
schema verification + orders existing). Rollout is shadow-mode: static keeps
driving scheduling while live logs would-have-been predictions into
`ScheduleOutcome`; the flag flips only when live measurably wins on
`targetErrorMs` (roadmap 4.3).

Key decisions recorded in the design doc: mid-flight rescheduling of
already-scheduled fire times is explicitly OUT of scope (GoTab cancellation
semantics unverified; oscillating re-shuffles worse than residual error —
"real-time" means fresh estimates AT the all-paid re-anchor, which is why S8
exists); no ML, no new infra — EWMAs, medians, one division, inside the
monolith + worker. **Prerequisite before building any of it: the finding-#7
enforcement** (unconfirmed items must become non-orderable — an honest
estimator can't sit on top of dishonest zeros). Build split: pipeline pieces
(schema, capture, estimator behind flag, shadow logging, mock jitter mode)
are unblocked now; the GoTab poller and all calibration are POC-gated — the
machine can be built any time, but it cannot learn anything true until real
kitchens feed it.

---

## GoTab product availability mapping — VERIFIED empirically (2026-07-02)

Probed live (`scripts/probe-gotab-availability.ts`, kept for reuse) by
toggling a Konjo item through the dashboard's three states and diffing
`productsList`. The dashboard tri-state maps to:

| Dashboard | `orderEnabled` | `available` | `enableTimestamp` |
| --- | --- | --- | --- |
| Available | true | true | null |
| Unavailable | false | false | **set** (auto re-enable time) |
| Hidden | false | false | null |

Key facts:

- **`orderEnabled` and `available` move in LOCKSTEP** under the dashboard
  toggle; neither alone distinguishes Unavailable from Hidden. The
  differentiator is `enableTimestamp`.
- **"Unavailable" is an auto-expiring 86.** Clicking it stamped
  `enableTimestamp` = early the next morning (observed
  `2026-07-03T06:59:59.999`, no tz suffix — end of service day whether read
  as UTC→~3am EDT or as local — exact tz semantics unresolved and not
  load-bearing). GoTab flips the item back to Available on its own.
  Consequence: an 86'd item is RUNTIME state, not catalog membership — it
  belongs in our catalog as `available:false`, not skipped.
- **Current import behavior, precisely:** the `orderEnabled === false` filter
  skips BOTH Unavailable and Hidden at import (lockstep), so no 86'd item
  imports as orderable. The REAL confirmed bug is re-import divergence: an
  item imported while Available and later 86'd/hidden in GoTab is filtered
  out of the fetched list, so re-import never touches it — our copy stays
  orderable indefinitely while GoTab says otherwise. (Same root as the
  earlier-recorded "items dropped from GoTab never deactivated" note; now
  mechanism-verified.)
- **Caveat:** only the dashboard toggle was probed. If another GoTab surface
  can 86 indefinitely (no enableTimestamp), that state is indistinguishable
  from Hidden to us — acceptable: both mean "don't show diners this now."
- CUSTOM back-office products carry the Hidden signature
  (false/false/null) — consistent; the existing CUSTOM filter stands.
- Product type has **74 fields**; future-use candidates spotted: `archived`
  (soft delete, null on live rows), `manualDelayUntil`, `description`,
  `shortName`, `images`, `sku`, `tags`. `basePrice`-is-cents re-confirmed.

**Fix — BUILT + VERIFIED live 2026-07-02:** tri-state
classification lives in the pure, unit-tested `gotab-availability.ts` (6 new
tests lock the verified mapping); `listProducts` drops HIDDEN/CUSTOM and
returns UNAVAILABLE products flagged; the import route creates UNAVAILABLE
items as local `available:false`, syncs `available` both directions on
re-import, and runs a deactivation sweep over GoTab-linked local items
missing from the fetched list; the import response + admin summary NAME
everything unavailable or deactivated (finding-#5 mitigation). GoTab is the
availability source of truth ONLY for GoTab-linked items; hand-added items
(null gotabProductUuid) are never touched by sync; `hideItemsMissingPrep`
applies at creation only. Mock catalog gained a 4th UNAVAILABLE item
("Seasonal Soup") so the 86'd path is demoable offline.

Verified with a full live Konjo round-trip: (1) 86 Item 4 → import → 4
imported, Item 4 named as 86'd and absent from the card; (2) hide Item 3 →
re-import → 3 imported, sweep deactivated Item 3 BY NAME while still
reporting Item 4's 86; (3) restore both → re-import → all 4 back, no
warnings, no duplicates, and Item 3's confirmed 5-min prep SURVIVED the
hidden→deactivated→restored cycle (deactivation touches only `available`).
Unit suite 18/18; typecheck clean. Also noted during testing: the admin UI
auto-enters the dashboard on a stored-but-expired JWT (12h TTL) and only
surfaces "Invalid or missing token" on the first privileged call — cosmetic
backlog item: catch 401s in the admin `api()` helper and bounce to login.
**FIXED 2026-07-07** (after biting two sessions running): two layers —
load-time client-side JWT `exp` check (expired/malformed stored token →
login card immediately, never a fake dashboard) + `api()` bounces on any 401
that had a token attached (clears token, stops the activity poll, shows
"Session expired — sign in again"). The bounce deliberately gates on
a-token-was-attached so the login route's own 401 (wrong password) still
shows the real error. Full-file rewrite per the frontend law.

---

## DECISION: the mock adapter is PERMANENT — do not remove (2026-07-02)

Raised: "do we need the mock path now that we have the sandbox?" Answer: yes,
indefinitely. Do not delete it in any cleanup pass. Reasons, in order:

1. The sandbox cannot run the core loop — order creation is blocked
   (settlement), so lock→fire→ready→COMPLETED works ONLY in mock mode today.
2. The integration suite (and future CI, roadmap 3.4) runs hermetically on
   the mock; live-GoTab verification is the SEPARATE opt-in `test:gotab`
   suite (roadmap 2.7). Not substitutable.
3. The sandbox has NO KITCHEN — nothing bumps tickets — so even after the
   blocker resolves, live orders hang at SENT without a human in the
   dashboard. The mock simulates the kitchen (finishes at targetReadyAt by
   design): the mock DEMOS the product, the sandbox VERIFIES the integration.
4. The prep-estimation spec (Phase F, MOCK_KITCHEN_REALISM) is built on it,
   and it is the reference implementation of the VendorAdapter contract
   (compile-enforced parity — interface changes force the mock to keep up).
5. Cost ≈ zero: one file behind the factory, no runtime footprint in gotab
   mode.

The operative pattern is PER-CAPABILITY migration, already in effect:
catalog reads use real GoTab whenever creds exist (getImportAdapter);
firing stays mock until the sandbox can actually do it. Capabilities move
to real individually as the sandbox earns them — never a global switch,
never a deletion.

---

## Operator questionnaire for Jon — PREPARED (2026-07-02)

`jon-questionnaire.md` — 35 questions for the upcoming meeting, scoped to
operator-answerable unknowns only (API questions stay with Zach). The ⭐
design-blockers it resolves: per-vendor parallel-vs-sequential cooking (the
scheduler's max-vs-sum assumption), which vendors run a KDS and bump honestly
(whether prepared−sent telemetry exists per vendor), whether vendors actually
use the 86 toggle (the availability-sync trust assumption), how shared-tab
payment/settlement really works at DSC (Branch A viability), pickup mechanics
(who moves the food — shapes the entire ready-together UX), the 120s window
and payment-timeout social acceptability, pilot vendor selection + baseline
measurement, and the production-GoTab authorization path. Rule: answers get
transcribed back into this doc as a dated section — decision inputs, same as
sandbox findings.

---

## PROCESSOR BLOCKER RESOLVED — open tabs, no settlement (2026-07-02, Zach)

Zach's reply to the two standing questions, verbatim in substance:

1. **No processor fix exists under Client Credentials — permanently.** The
   PROCESSOR_INVALID error was never a naming/config issue. Cash processors
   are server-assigned and usable only through a SERVER SESSION (POS pin-in,
   or OAuth **Authorization Code** auth that inherits a server's
   permissions). Client Credentials has no server context, so there is NO
   path to a Cash processor via our integration. Access model, not config.
   Stop looking for a processor string/uuid — the search is over by design.
2. **Order creation WITHOUT settlement: `openTab: true`, omit `payments[]`
   entirely.** The order reaches the KDS on its `scheduled` timing without
   touching a processor. The closed-tab-must-settle constraint applied to
   closed tabs only. Settlement can be "circled back" later IF the POC needs
   it — Zach's read (and ours) is that it doesn't, for the timing goal.

### What this unblocks (nearly the whole critical path)

- **Phase 2.2 empirical test plan is RUNNABLE NOW**: scheduled-fire tolerance
  (Q1), live order-submission schema incl. the real `scheduled` field name
  (Q3), status latency (Q4), and shared-tab multi-vendor behavior (Q2 — the
  order/timing side; payment-settlement side deferred with settlement).
- **`getTicketStatus`'s guessed `orderByOrderUuid` query is finally
  verifiable** — a real order will exist to poll.
- **`submitTicket` is buildable** against the open-tab flow (one order per
  vendor on a tab, per-order `scheduled`).
- **The `holdsSchedule` fork resolves empirically**: create a scheduled
  order, observe whether GoTab holds it and fires at the timestamp. If yes
  → `holdsSchedule = true` becomes real; if firing is unreliable → stay
  `false` with our BullMQ timers.
- **Prep-estimation Phase G ingestion feed** (ordersList observations) gets
  its schema verification en route.

### What it does NOT unblock / new questions it creates

- **Settlement stays unsolved, deliberately.** Under Client Credentials it
  is impossible for Cash by design; any our-side settlement would require an
  Authorization Code integration with server context — avoid that
  complexity. This STRENGTHENS Branch A (GoTab owns payment).
- **New Branch-A production question (for sandbox/Zach later):** can diners
  pay an integration-created open tab through GoTab's normal consumer flow?
  That's the production payment shape if yes.
- **Sandbox hygiene:** open tabs with no payment path will accumulate in the
  dashboard. Find the cancel/close-without-settlement semantics early —
  this is the same investigation as 2.4's `cancelTicket` item.
- Open-tab creation schema itself is UNVERIFIED (openTab flag name, spot
  requirement, items array shape, `scheduled` field name/format) — probe
  before building submitTicket, same discipline as the availability mapping.

---

## SESSION INDEX — 2026-07-02 (everything above this date, one glance)

Seven dated sections landed today; this is the index + standing next actions.

1. **Full-codebase review** — 7 findings. #1 (empty-string creds defeat
   fallback + silent-mock import) FIXED same day; #2 (stored XSS via
   displayName) FIXED + smoke-verified; #3 (trustProxy) recorded as required
   roadmap-3.2 production config; #4 (parent-import transaction timeout),
   #5 (admin can't see hidden items), #6 (pay-after-drop), #7 (unconfirmed
   prep customer-visible — priority-bumped) recorded open with fix shapes.
2. **Prep-estimation system** — designed, then expanded into a full
   implementation spec for a lesser-model build (`prep-estimation-design.md`:
   conventions primer, exact schema/signatures/worked examples, phased gates).
   Deliberately NOT built. Entry point when built: Phase A (finding-#7
   enforcement, state-based scope).
3. **GoTab availability mapping** — empirically verified (probe script kept):
   dashboard tri-state = lockstep booleans + `enableTimestamp` discriminator;
   "Unavailable" is an auto-expiring 86.
4. **Availability sync fix** — BUILT + VERIFIED live against Konjo (tri-state
   classifier unit-locked 18/18; import-as-unavailable; both-direction
   re-import sync; deactivation sweep; named transparency in responses).
5. **DECISION: mock adapter is permanent** — per-capability migration
   pattern; never a global switch, never a deletion.
6. **Jon questionnaire prepared** (`jon-questionnaire.md`, 35 questions, ⭐
   design-blockers marked) — run at the upcoming meeting; transcribe answers
   back here.
7. **PROCESSOR BLOCKER RESOLVED (Zach)** — open tabs (`openTab: true`, no
   `payments[]`) reach the KDS on `scheduled` timing; Cash settlement is
   permanently impossible under Client Credentials (access model).
   Strengthens Branch A. Phase 2.2 is runnable NOW.

Backlog additions today: admin UI auto-enters dashboard on expired JWT
(cosmetic; catch 401 → bounce to login).

### Standing next actions (in order)

1. **Commit** the day's uncommitted set: prep-estimation spec + pointers,
   availability probe + classifier + fix (+ admin HTML), mock-permanence
   note, questionnaire + pointers, Zach-resolution sections, this index.
2. **`scripts/probe-open-tab.ts`** — one scheduled open-tab order on Konjo,
   poll to `prepared`: verifies open-tab schema, `scheduled` fire tolerance
   (THE holdsSchedule fork), status latency, and the `orderByOrderUuid`
   guess, in one run. Watch the dashboard KDS in parallel.
3. **Seed 2 orderable items on Motor** (dashboard, ~5 min) → enables the
   cross-vendor staggered shared-tab test (empirical Q2, the architecture's
   load-bearing assumption).
4. **Build `submitTicket`** against the verified schema + investigate
   cancel/close-without-settlement (doubles as sandbox open-tab hygiene).
5. **Jon meeting** with the questionnaire; answers transcribed back here.
6. Prep-estimation build (lesser model) whenever chosen — starts at Phase A,
   gates are not optional.

---

## Open-tab probe session — 2026-07-06 evening (EMPIRICAL FINDINGS)

**Headline: the FIRST API-created order in project history. Full pipeline
verified to SENT. `scheduled` did not take — root cause found in GoTab docs:
THE SPOT GATES SCHEDULING. One dashboard toggle away from the holdsSchedule
answer.**

### Bug found first: stale REST base in `.env`
`GOTAB_API_BASE` in `.env` still held the early-days guess
`https://api-sandbox.gotab.io` (nonexistent host — DNS-level "fetch failed").
Fixed to `https://gotab.io`. The sandbox is LOCATIONS on the production host,
not a separate host. This was the first call ever to exercise the client's
REST path (`locPost`); OAuth/GraphQL have their own URL vars, long verified.

### Create verified (Q3, submission side)
`POST /api/loc/{loc}/tabs` with body `{ openTab: true, spotUuid, name,
scheduled (top-level ISO), items: [{ product: { productUuid }, quantity }] }`
— items use the NESTED product shape (per GoTab's reservation docs, recovered
from the 06-27 transcript). Succeeded in 674ms. Response shape (live-verified):
- Wrapped in `data`. Tab: `tabId` (numeric string) + `tabUuid`, `tabMode:
  "DEFAULT"`, `status: "OPEN"`, totals in CENTS (re-confirmed), `payments: []`,
  `balanceDue`.
- `orders: [{ orderId }]` — numeric orderId ONLY; **no orderUuid in the create
  response** (it exists on the Order type; fetch it via lookup).
- items[]: `quantity` comes back as a STRING (adapter typing note).
- **`href`: consumer-facing tab URL** (`https://gotab.io/.{tabUuid}`) — Branch-A
  lead: if a diner can open + pay that link via GoTab's consumer flow, that IS
  the production payment shape. NOT YET TESTED — morning item.
- Dashboard: tab shows "assigned to Food Hall Sync - DSC" (integration
  provenance + Reassign), channel "E-Commerce", and a **"Pay with Tender
  Types"** button = probable staff-side manual settlement / probe-tab cleanup
  path (untested).

### v1 result: order fired IMMEDIATELY — `scheduled` silently coerced to ASAP
Order `133476673` / orderUuid `or_4C8FRY2vRhfDiG4424rCC~_~` (**tildes appear
in ORDER uuids too** — path-encoding hazard; safe in GraphQL variables):
`created 02:23:11.415`, `placed 02:23:11.556+00:00`, GoTab `scheduled` =
placed (DEFAULTED — not our 02:26 request), `sent 02:23:11.621` (~200ms after
create), **`isAsap: true`**, status stuck at SENT (no KDS to bump; see below).
NOTE: the probe's first printed verdict ("GoTab HELD — holdsSchedule viable")
was WRONG — a verdict-ordering bug (sent−scheduled was tiny because GoTab set
scheduled=placed itself). Corrected in probe v2: **the success test is
`isAsap: false` AND GoTab's `scheduled` echoing ours**; only then does
sent−scheduled measure fire tolerance.
Curiosity: `orderPrepTimeMs: 600000` (10 min) attached despite the product
having no prep configured — source unknown (location default?);
estimation-relevant, investigate later.

### ROOT CAUSE (from docs.gotab.io/docs/create-a-new-tab)
`scheduled` IS the documented top-level createTab field ("By default scheduled
is set to ASAP"), and: **"If the spot allows scheduling, which is typical of
takeout and delivery orders, then the order can be scheduled... Otherwise the
delivery time will be set to ASAP."** Konjo's dine-in spot
(`spt_Fo3Not1quvTWJobPfptx7H_A`) does not allow scheduling → silent ASAP
coercion, exactly as documented. **Fix is dashboard spot/zone config, not
code.** Related: scheduled times likely must fall within the location's
ordering SCHEDULE windows (docs: "allowing orders to be placed within the
available schedules"; the `goGetScheduleIntersectionSpans` mutation is that
machinery).

### Adapter LAW learned tonight (bake into gotab.ts when building submitTicket)
1. **Targeted lookups only.** Bare `location { ordersList }` = server-side
   statement TIMEOUT. Proven fast: `ordersList(condition: { orderId })`.
   Query root also has `order(orderId: BigInt)`, `orderByOrderUuid(orderUuid:
   String)` — the gotab.ts guess EXISTS on the schema (not yet exercised with
   a real uuid — morning item), `orderById(id: ID)`.
2. **GraphQL rate limit: 4 rps** (429: "exceeded the threshold of 4rps").
   Pollers must pace; treat 429 as retryable-with-backoff (client currently
   treats non-401 as terminal — future client tweak).
3. **Mixed timestamp formats WITHIN one row**: placed/scheduled carry +00:00;
   created/sent/statusChanged are tz-less **UTC** (verified: 22:23 EDT
   creation == 02:23 tz-less). Parser must append Z to tz-less strings (JS
   parses tz-less as LOCAL — 4h error otherwise). Retroactively decodes the
   availability probe's enableTimestamp: auto-86 expiry ≈ 3am EDT = end of
   service day, UTC.
4. **Order type (38 fields, introspected):** all support-claimed timestamps
   exist (placed/scheduled/sent/prepared/fulfilled/statusChanged) plus
   `dispatched`, `recalled`, **`isAsap`**, `orderIntervalTypeId`,
   `orderPrepTimeMs`, `orderUuid`, `apiUserUserId`, `orderSequenceNumber`,
   `serverName`, `riskFlag`.
5. **Order creation is REST-only.** Mutation root has 16 fields, all read-ish
   `goGet*` helpers — no createTab/addTabItems in GraphQL; REST bodies are not
   introspectable (that avenue is a confirmed dead end).

### KDS / `prepared` — blocked in sandbox, path known
Bumping `prepared` requires a PROVISIONED KDS Display: Manager Dashboard →
Displays → "+ New Display System" → KDS type → activation code (GoTops app;
success.gotab.io/knowledge/setting-up-kds). The sandbox has NONE → nowhere to
bump → orders park at SENT. GoTab's terminology doc says the KDS (and POS) are
**web-based** — a browser bump may be possible once a display is provisioned.
→ Zach question queued: "provision/enable a KDS display for Konjo Me Sandbox
(or a web way to bump `prepared`)." This sandbox gap is a miniature of
questionnaire Q11–12: KDS-less vendors produce NO prepared data.

### Probe scripts (all in scripts/, all committed-when-you-commit)
- `probe-open-tab.ts` **v2** — spot-aware retry; verdict bug fixed (isAsap +
  scheduled-echo checked FIRST); 4rps-safe polling; SPOT is the knob to edit.
- `probe-order-poll.ts` v2 — targeted-lookup chain; Order-type introspection.
- `probe-schedule-field.ts` — Mutation-root introspection (read-only).
- Stranded sandbox tab from v1: `SikOQWovqVuqx2Iq1fUGXBny` ($10 open, order
  stuck SENT). Cleanup candidate: "Pay with Tender Types" (untested).

### MORNING PICKUP — in order
1. Dashboard: enable scheduling on a Konjo spot OR create a takeout/pickup
   spot (copy its spt_ uuid); check the location's ordering-schedule windows
   cover "now + a few minutes". ~10 min cap → else one-line Zach ask.
2. Set the `SPOT` knob in `scripts/probe-open-tab.ts` if new spot; run
   `npx tsx --env-file=.env scripts/probe-open-tab.ts`. Success = isAsap:false
   + echo; then sent−scheduled = **Q1 fire tolerance = the holdsSchedule
   verdict.**
3. Open the v1 tab `href` in a browser — does it render a payable consumer
   tab? (Branch-A payment shape, zero cost.)
4. Click "Pay with Tender Types" on the stranded tab — cleanup semantics
   data point.
5. Verify `orderByOrderUuid` with the real uuid (fold into next probe run).
6. Zach email (one message): KDS display for sandbox; (settlement circle-back
   stays deferred).
7. Then the standing queue: Motor seeding → cross-vendor stagger (Q2);
   `submitTicket` build against the now-verified schema (pacing, 429 retry,
   targeted lookups, tilde encoding, Z-appending parser, string quantity).
8. **Commit** tonight's set: three probe scripts + this section + roadmap
   status touch (label: `sandbox: first API order; open-tab probes +
   empirical findings`).

---

## Scheduling investigation — 2026-07-07 morning (EMPIRICAL AVENUES EXHAUSTED → Zach)

**Bottom line: every API-created order is silently coerced to ASAP regardless
of zone config. The mechanism is understood down to the zone flags; the
missing config (order intervals) is not reachable from any surface we have.
Escalated to Zach with full evidence. NOT BLOCKING: `holdsSchedule=false`
(we hold BullMQ timers, submit ASAP orders at fire time) needs only what is
NOW VERIFIED — submitTicket is buildable today; GoTab-held scheduling is the
preferred optimization pending Zach.**

### The zone mechanism (from probe-spots.ts, new script)
- Zone scalar fields include the money trio: **`asapOnly`**,
  **`asapOrderingEnabled`**, **`orderIntervalId`** — plus `openTabOnly`,
  `kdsConfigs` (KDS routing is ZONE-level — lead for the prepared question),
  `initialTabDiscoverableMs`, `zoneIframe`, etc. Spot has NO scheduling
  fields — spots inherit their zone.
- Konjo pre-provisioned: zone "Default" (asapOnly:false, asapOrderingEnabled:
  false, no spots) and zone "E-Commerce" (**asapOnly:true**,
  asapOrderingEnabled:true) holding our original probe spot — v1's coercion
  fully mechanized.
- The dashboard's Zone GROUPS (Dine-In/Takeout/Delivery/E-Commerce) are
  containers; zone rows carry `type: null` in the sandbox.

### New sandbox objects (created via dashboard, harvested via probe)
- Zone **"Pickup"** under the Takeout group: zoneId **49184**, uuid
  `zn_9C8ae6Ve2BYz55ky~ye9oW5~` (tildes in ZONE uuids too), asapOnly:false,
  asapOrderingEnabled:true, lead time 0, time step minimum, KDS banner on.
- Spot **"Pickup Counter"**: **`spt_Xfg6nOcE0yL2EmwTDzpRmac6`** (URL-clean).
- Numeric **locationId for Konjo: 21091** (useful constant; goGet* functions
  take _locationId BigInt + _timezone, LOCATION-scoped).

### Second coerced order — zone flags are NOT sufficient
Order **133487706** / `or_qWDHLWNr4f2iQ5UUJn6e8OhC` on the Pickup spot,
requested scheduled=T+3min: came back **isAsap:true**, GoTab scheduled =
placed (16:06:23), sent +230ms. NOT snapping (no lead-time/step rounding —
timestamp is placed-time exactly). Tab `2bZT8Rkhy3LXX9E6zYri2j5~` (tildes in
TAB uuids + hrefs too). Stranded-tab count: 2.

### Ruled out this morning
- Dashboard **Schedules page = availability HOURS grid** (location/zone/menu/
  category open-hours; all green) — a different concept from order intervals;
  nothing there to create for scheduling.
- Zone form's Lead Time / Time Step / Max Advance Days did NOT materialize an
  `orderIntervalId` (still null on all three zones). Interval config surface
  NOT FOUND in the dashboard.
- `goGetScheduleIntersectionSpans` (the windows readout): **"permission
  denied for aggregate go_array_union"** under our Client Credentials role —
  diagnostic inaccessible to our credential class.

### Escalated to Zach (email drafted 2026-07-07)
Questions: (1) what makes an API-created order schedulable — is a zone
order-interval required and where is it configured; (2) does openTab:true /
integration-created (E-Commerce channel) force ASAP; (3) is top-level ISO
`scheduled` the right shape; (+) KDS display for the sandbox so `prepared`
can be exercised. Evidence: both order ids, zone configs, the permission
denial.

### While waiting on Zach (all independently unblocked)
1. **Build `submitTicket` in holdsSchedule=false mode** against the verified
   ASAP open-tab path (adapter law from 2026-07-06 applies: targeted lookups,
   4rps pacing, 429 retryable, tilde encoding, Z-appending timestamp parser,
   string quantity). Flag-flip ready if Zach unblocks GoTab-held.
2. Seed 2 orderable items on Motor (dashboard) → cross-vendor test prep.
3. New probes committed with the rest: `probe-spots.ts`,
   `probe-schedule-spans.ts`.

---

## GoTab adapter BUILT + conformance-verified — 2026-07-07 afternoon (Phase 2.4 core)

**`submitTicket` is LIVE in we-hold-timers mode (`holdsSchedule=false`),
verified against real Konjo. The app can now fire real GoTab orders on our
BullMQ timers. All gates green: typecheck, 23 unit, 9 integration.**

### What was built
- **`gotab.ts` submitTicket**: open-tab create (openTab:true, no payments[]),
  ticketId-keyed in-memory idempotency, tab `externalId` = ticketId
  (provenance/webhook key), tab name `FoodHall {id8}`, item notes folded into
  the documented order-level `notes` string (per-item notes object shape
  unverified — don't guess), items via nested `product.productUuid`, and the
  dormant **`scheduled` flip seam** gated on `holdsSchedule` — flipping the
  flag activates GoTab-held mode with zero other changes once Zach unblocks.
- **`getTicketStatus(externalId, ctx?)`**: external id = GoTab's NUMERIC
  orderId (all the create response gives). ctx carries vendorLocationId → the
  proven `ordersList(condition:{orderId})` lookup; no ctx → top-level
  `order(orderId)` fallback — **now live-verified too (no permission wall);
  zero unverified queries remain in the adapter.** Numeric-id validation
  before inlining.
- **`gotab-client.ts` hardening (adapter law encoded)**: process-wide pacing
  gate, 280ms between request STARTS (≈3.5rps, shared across ALL client
  instances — module-level, synchronous slot reservation), and 429 → one
  1.2s-backoff retry alongside the existing 401 logic.
- **Contract changes (`types.ts`)**: `TicketItem.gotabProductUuid: string |
  null` REQUIRED — compiler forces builders to supply it; GoTab adapter
  rejects unmapped items terminally (GOTAB_UNMAPPED_ITEMS, operator config
  error) while the mock accepts. `TicketStatusContext` optional param — mock
  unchanged (TS accepts fewer params).
- **Spot strategy**: no migration — runtime discovery per location
  (spotsList+zonesList once, cached process-lifetime), pure chooser in
  **`gotab-spot.ts`** (5 unit tests on the real Konjo topology): exclude
  hidden/archived spots + hidden/unavailable zones, prefer zones with
  `asapOnly:false` (future-proofs the flip), ascending-spotId tiebreak.
  Production follow-up: per-vendor override column.
- Exported `parseGoTabTimestamp` (Z-appending) from gotab.ts for reuse.
- Call-site wiring: `orders.service` passes `menuItem.gotabProductUuid`;
  reconcile includes vendor and passes ctx.

### Conformance smoke (scripts/probe-adapter-submit.ts — seed of 2.7 test:gotab)
Run 2026-07-07 16:46Z vs live Konjo: spot discovery chose **Pickup Counter**
exactly as the unit fixture predicted; order **133490055** created (tab
`frVu49J5_a5GixWxZpQS9OWu`); **idempotency PASS** (second submit, same id, no
second tab); status via ctx path AND fallback both functional.

### Finding: the status "mismatch" was a sampling race — PROVEN, not a bug
Smoke read SCHEDULED (ctx path) then IN_PROGRESS (fallback) seconds apart.
GoTab's own timestamps prove the pipeline: created 09.232 → placed 09.360 →
sent 09.425 (~200ms) — the first query sampled pre-SENT, the second post.
Reconcile is immune by design (SCHEDULED → continue → next 10s tick).
Also observed: **~1s clock skew** between local machine and GoTab servers —
LAW: tolerance/timing math compares GoTab timestamps to GoTab timestamps
ONLY; never mix clocks. (probe-order-poll's verdict now guards on isAsap and
says exactly this.)

### Known limits (accepted, recorded)
- Restart in the accept→DB-write window can double-submit one ticket (sweep
  redrive); tab externalId makes duplicates identifiable. Platform-side
  externalId dedupe unverified.
- `cancelTicket` remains 501 — cancellation semantics + open-tab closure =
  the standing 2.4 investigation (3 stranded probe tabs now; "Pay with
  Tender Types" settle still untested).
- `prepared` unobservable until a sandbox KDS exists (Zach ask pending).

### Next milestone (unblocked NOW): first END-TO-END app run vs real GoTab
Set `VENDOR_ADAPTER=gotab`, import Konjo + Motor as vendors (Motor is seeded),
run a real group order through the web UI — two real tabs firing on OUR
staggered timers, reconcile advancing them. That is the Phase-2 integration
moment. (READY requires the KDS bump — groups will park at FIRED until then;
the demo still proves submit + stagger + reconcile.)

---

## FIRST END-TO-END RUN — THE NUMBER — 2026-07-07 ~17:15Z (Phase-2 integration moment)

**The actual app, through the actual UI, staggered real orders onto both real
GoTab kitchens with 46ms of error on a 300-second stagger. We-hold-timers
mode is not a fallback — it measured essentially perfect.**

### The run
Group `b2033d0e` (2 diners, each ordering from both vendors — 2 items per
vendor ticket). Prep: Motor 8min, Konjo 3min → intended offsets 0 / +300s,
targetReadyAt 17:23:37.598Z.
- Motor: ticket `ae32a821`, order **133492158**, tab `vnAcA_cbih_w_1kbOZvhPzw0`,
  spot E-Commerce (sole candidate — chooser per design).
- Konjo: ticket `90af70ab`, order **133492491**, tab `WB2lL2NCSg~NmBjpgNVIyYpN`,
  spot Pickup Counter (asapOnly:false zone preferred — chooser per design).

### THE NUMBER (GoTab's clock only, per the law)
- intended stagger 300.000s → **actual sent-to-sent stagger 300.046s — error
  0.046s** (0.04% of the 120s sync window).
- Per-order create→sent pipeline: 0.22s / 0.21s. **Insight: absolute latency
  is COMMON-MODE and cancels in the delta — synchronization fidelity depends
  only on inter-order jitter, which measured 46ms.**
- BullMQ delivered the +300s delayed job 134ms after target (our-side logs).
- Caveats: n=1, idle sandbox, unloaded worker. Every future group accumulates
  this measurement for free (our scheduledFor + GoTab sent are both durable).

### Hardening observed working in the wild, first minute
- Two `scheduleGroup` jobs for the same group (two payers, per-payment jobIds)
  → conditional flip let exactly ONE through (the M1 dedupe-race design).
- The M4 sweep expired a stale OPEN group unprompted.
- Reconcile polls both FIRED tickets cleanly; group parks at FIRED as expected
  (no KDS to bump — `prepared` pending the Zach ask).

### STRATEGIC CONSEQUENCE — the holdsSchedule stakes just inverted
We-hold-timers was the "safe fallback"; it measured near-perfect. GoTab-held
scheduling (Zach's zone-interval answer) is now OPTIONALITY — a resilience
nicety (platform keeps firing if our worker dies mid-window; the sweep +
durable jobs already cover most of that) — NOT a prerequisite for anything.
The fork that shaped the architecture since June is resolved in practice.

### New architectural observation — record for the 2.3 payment gate
Current implementation = **one tab per vendor per group** (tabs are
location-scoped: `/api/loc/{loc}/tabs`). The original "ONE shared tab
spanning vendors" assumption may not be expressible on this API path at all
— diners would face N tabs, not one. Irrelevant to firing/timing; central to
payment UX + settlement (Branch A). Possible answer: parent-location tabs
with child-routed orders — unverified. Add to the Zach/sandbox queue for 2.3.

### Still pending from this session's checklist
- ~~`href` incognito test~~ **DONE 2026-07-07 — BRANCH A CONSUMER SURFACE
  CONFIRMED.** Anonymous incognito browser (no login, no QR) opened tab
  `SikOQWovqVuqx2Iq1fUGXBny` via its href and got GoTab's FULL consumer
  payment UI: items, balance, and three payment modes — **Pay in Full / Pay
  for Items / Pay an Amount**. "Pay for Items" = native per-item payment on a
  tab — maps directly onto members-pay-their-own-items. Notes: total showed
  $12.00 on $10.00 subtotal (almost certainly a default 20% tip pre-selected
  — zone/location tip config; verify the selector); integration orders render
  as "Ordered by Server" to consumers (cosmetic, diner-facing polish later).
  **SEQUENCING CAVEAT (the sharpened 2.3 question):** this confirms the
  consumer SURFACE, not the flow — we need payment BEFORE firing, but tab
  creation currently IS firing (ASAP mode). Full Branch A needs GoTab-held
  scheduling (+ new sub-question: does GoTab fire a scheduled order that is
  UNPAID?) or a create-without-firing shape. Both ride the Zach thread.
  **FOLLOW-UP finding (same day): consumer payment is OTP-GATED.** Clicking
  "Place Order" opens a contact modal — first/last name, PHONE (required),
  email optional, Cloudflare turnstile — then "Send code via SMS" (or
  WhatsApp). GoTab's guest model ("guest is represented by phoneNumber")
  live: every diner paying via GoTab's surface does a name+phone+OTP dance
  before seeing payment methods. Real UX friction to weigh in the 2.3
  payment-ownership decision — per-member OTP × possibly N vendor tabs.
- ~~"Pay with Tender Types" settle~~ **DONE 2026-07-07 — STRANDED-TAB HYGIENE
  SOLVED (manual).** Manager dashboard → Tabs → open tab card → Pay with
  Tender Types → modal: "charge the remaining balance to the selected account
  and close out the tab." Sandbox tenders offered: **Cash only** — completing
  the settlement-asymmetry picture: Cash is unreachable by our Client-
  Credentials API by design and one-click for staff. Verified: settling the
  smoke tab ($10) closed it. Consequences: (a) probe/demo tabs cleanable at
  leisure (mind the per-location + date filters — 07/06 probes on their own
  date, Motor's tab under the Motor location); (b) 2.3 input — worst-case
  operational fallback at DSC is staff settling at the counter = the food-
  hall status quo; (c) `cancelTicket` investigation narrows to API-only
  questions. Incidental: dashboard renders ASAP orders as "Scheduled for
  {placed}" chips (cosmetic GoTab-ism); closed tabs gain a Refund button
  (noted, unexplored). Optional extra experiment still open: proceed through
  "Place Order" on the consumer page in incognito to see what payment methods
  the sandbox offers (card auth likely unconfigured — the failure mode itself
  is informative).

---

## Zach reply #2 — scheduling fork CLOSED PERMANENTLY; KDS unblocked (2026-07-08)

Three facts, decoded:

1. **Open tabs and scheduled orders are MUTUALLY EXCLUSIVE — hard-coded.**
   A valid schedule + `openTab:true` throws an explicit "Open tabs cannot be
   scheduled" error. Chain to the verdict: scheduled ⇒ closed tab ⇒
   `payments[]` zeroing the balance ⇒ processor ⇒ unreachable under Client
   Credentials (permanent, access-model). **GoTab-held scheduling is
   STRUCTURALLY incompatible with our integration** — not config-blocked,
   excluded. `holdsSchedule=false` goes from chosen-by-measurement to
   only-viable-mode (and it measured 46ms, so: fine). The zone order-interval
   hunt is moot for us. Register entry #3 updated; the code seam is annotated
   so nobody flips into a guaranteed error.
   → 2.3 consequence: "diners pay the GoTab tab BEFORE we fire" has no shape
   on this path — the only pre-fire GoTab object possible is an EMPTY tab
   (items on an open tab fire at add time). Pay-before-fire via GoTab is
   effectively dead; the gate's remaining live options are our-side payment
   (existing seam) or pay-after/at-fire models. Zach is running his own tests
   for "a more solidified answer" — expect a follow-up.
2. **Field-name/format reconciliation — explains every observation.** The
   real field is likely `scheduledDate`, and internal parsing needs **UNIX
   EPOCH SECONDS** (docs say ISO — wrong; he's correcting them). Our ISO
   `scheduled` was never parsed as valid → treated as absent → silent ASAP
   coercion with no error — fully consistent with his hard rule. Confirm-test
   written: `scripts/probe-scheduled-epoch.ts` — the EXPECTED SUCCESS is an
   explicit rejection (strands nothing); silent acceptance on both names
   means neither parses (tell him). **PROBE RESULT (same day): matrix
   complete.** `scheduled` is NOT an input field at all — silently ignored in
   ISO AND epoch formats (the Order row's `scheduled` is output-only).
   `scheduledDate` + epoch + openTab:true → **deterministic HTTP 500**
   (twice: ~16:53:45Z and ~16:55:17Z, epochs 1783529805/1783529896, Konjo) —
   almost certainly the hard rule throwing internally without a mapped
   client error. Mutual exclusivity CONFIRMED in behavior; error-mapping bug
   reported to Zach with timestamps. Stranded tab from the test:
   `KrTD1vf3Gj4olTlvmZCHtMin` (settle pile).
3. **KDS permissions ADDED to the sandbox accounts.** "Displays" should now
   appear in the manager left menu → add a display (activation code; his doc
   link: docs.gotab.io/operator/kds-printers-additional-display-setup/
   displaysetup/). Unblocks `prepared` — and the best possible first test:
   the parked 46ms demo group (`b2033d0e`) still has two live SENT orders;
   provision a Konjo display, BUMP order 133492491, and reconcile should
   march ticket → READY and the group toward COMPLETED with ScheduleOutcome
   finalizing — the full lifecycle against real GoTab, completing days after
   it fired. (Motor order 133492158 needs a Motor-location display for its
   bump.)

**Next actions from this reply, in order:** (1) run the epoch probe → reply
to Zach with the result; (2) check Displays → provision a Konjo KDS;
(3) bump the parked demo order → watch the lifecycle complete (worker must
be running); (4) fold the shared-tab / pay-sequencing answers into 2.3 when
his follow-up lands.

---

## KDS live + FIRST COMPLETE LIVE LIFECYCLE — 2026-07-08 (the crown)

**Group `560ab7cf` lived its entire life against real GoTab in 47 seconds of
wall time: paid → scheduled → fired (order 133581495, ~700ms submit) →
landed on a real KDS with a chime → prepped + expo-fulfilled by hand →
reconcile caught `prepared` within one tick → READY → COMPLETED, with the
first real `ScheduleOutcome` row finalized (targetErrorMs ≈ −133s: predicted
3min cook, bumped in ~47s — the calibration telemetry measuring reality vs
estimate on row one, exactly as designed). Every state transition in the
system is now verified against the live platform. No mocks in the chain.**

### The KDS saga (how `prepared` actually works — all empirically verified)
- **GoTops has a native WINDOWS build** (`gotab.io/windows/gotops`) — the
  activation code from Displays → New Display System is entered IN GoTops on
  the device becoming the screen (the dashboard's own "Activate Display"
  4-box modal is a different pairing direction — not where the code goes).
- **`prepared` is a STATION-CHAIN completion, not one tap.** Prep-station tap
  = stage marker only (touches `statusChanged`, ticket shows "Waiting on
  other stations"). The completing action is the EXPO stage: the in-app
  display setting **"Expo Station" toggle** turns a display into the expo
  view, whose ticket modal offers **Fulfill All Items / Prep All Items /
  Print Chit / Reset Order / Rush**.
- **Expo "Fulfill All Items" sets `prepared` + `dispatched` + status
  `DELIVERED` in the same instant; `fulfilled` stays NULL** despite the
  button's name. `mapGoTabStatus` checks `prepared` first → maps to READY
  with ZERO code changes — the June mapping survived first contact.
- Items with no station assignment route to the phantom "Default (No print)"
  station (per GoTab's KDS doc — the documented cause of stuck "Waiting on
  other stations"); the Expo toggle resolved it here.
- Display settings decoded: **"Hide Overdue Orders After: 2h"** is why
  yesterday's parked orders don't render (NOT fiscal-day filtering — earlier
  hypothesis corrected); Countdown Timer / "late" chip is driven by prep-time
  config (the `orderPrepTimeMs` connection); Auto-Text On Fulfillment exists
  (consumer SMS on bump — Branch-A-relevant); "Show Held Orders" + "Hide
  Scheduled Dine-In Orders" toggles imply scheduled-order KDS behavior for
  venues that have it.
- DSC implication (questionnaire Q11–12 sharpened): per-vendor `prepared`
  semantics depend on each vendor's STATION CONFIG, not just "do they bump" —
  a single-station vendor with expo-off may never produce `prepared` at all.

### Resilience observed + one new backlog item
Yesterday's zombie ticket (`ae32a821`, the parked 46ms-demo group) hit a
transient GoTab 503 (14:27) and a network blip (16:00) during reconcile —
both times the per-ticket catch logged at error level and the loop continued;
next tick is the retry, by design. BUT: **nothing expires perma-FIRED
groups** — they poll GoTab forever (M4 expires idle OPEN only). Backlog:
stale-FIRED expiry in the sweep family. Sandbox cleanup meanwhile: manually
CANCEL group `b2033d0e` + its two tickets in prisma studio if the noise
annoys; its tabs join the settle pile.

### Where this leaves Phase 2
Submission, stagger fidelity (46ms), status polling, `prepared`, full
lifecycle, telemetry finalization: ALL live-verified. Remaining in phase:
Zach's follow-up (scheduling officially dead-or-not, shared-tab/settlement
shape → 2.3), `cancelTicket`, formalizing `test:gotab`, and the operator
questions (Jon). The engineering risk register for the core product is,
as of today, EMPTY.

---

## Zach reply #3 — the 2.3 payment gate OPENS (2026-07-08)

1. **500 diagnosis 100% validated** — he repro'd locally; it IS the "open
   tabs cannot be scheduled" rule throwing unmapped; error-mapping cleanup
   ticketed on their side. (Our bug report style worked — keep it.)
2. **Scheduled OPEN tabs: permanently off** — "quite nestled in… out of my
   reach for a change." Register decision #3 stands verbatim.
3. **THE HINT (new 2.3 path):** scheduling is "deterministic based on the
   payment/settlement question — the two play hand in hand." If diners pay
   "through a payment SDK directly," then **openTab:false + scheduling could
   be a good path** — i.e., diner payments supply the `payments[]` a closed
   tab requires, un-blocking the closed-tab chain WITHOUT our integration
   touching a processor. Potentially resolves settlement + pay-before-fire +
   (bonus) GoTab-held scheduling in one shape. He asked us directly: what's
   the expectation for how diners pay?
4. **Discipline note:** what we NEED is settlement + per-member payment UX;
   held-scheduling is a resilience bonus only (our timers: 46ms, built,
   verified). Evaluate the SDK path on the payment merits; don't re-architect
   for scheduling.
5. **Reply sent (same day):** described our model (groups of 2–8, each member
   pays their own share BEFORE any food fires; all-paid gates firing), stated
   the Branch-A preference (GoTab owns payment end-to-end, we never touch
   card data or move money, funds settle natively per vendor), and asked the
   four shape questions: (i) what payment SDK / docs exist for an integration
   like ours; (ii) can multiple diners each pay their share toward a tab —
   per-member payments before/at closed-tab creation; (iii) tabs are
   location-scoped and a group's food spans N vendor tabs — how does one
   diner pay ONCE across vendors (parent-location construct?); (iv) refund
   story if a scheduled closed tab must be cancelled (group falls apart).
   Plus: scheduling itself is optional for us — payment is the real question.

## CODE REVIEW #3 — 2026-07-08, pre-weekend (everything since the 07-02 review)

Scope: adapter build, client hardening, availability sync, admin fixes,
call-site wiring. Lens: "a table silently not getting fed." Verified clean:
new-code XSS discipline, pacing-gate slot reservation, 429/401 interplay,
conditional transitions, ctx threading, tilde encoding, sweep's hand-added
protection (+ typecheck/23 unit/9 int green).

**HIGH**
- **H1 — Terminal submit misconfig strands a group INVISIBLY.** Unmapped item
  (GOTAB_UNMAPPED_ITEMS), vendor with NULL gotabLocationId under the gotab
  adapter (builder falls back to vendor.id → GoTab 404 — old mock-seeded
  vendors are live landmines), or GOTAB_NO_SPOT ⇒ fire fails terminally,
  BullMQ ×5 then sweep redrives FOREVER, error spam — and diners watch an
  eternal countdown; nothing marks the group failed. FIX (one work item, same
  family as finding #7 / prep Phase A): (a) fail-fast guards at add-item/lock
  — item mapped + vendor has gotabLocationId when adapter is real; (b)
  terminal-error classification in the fire path (4xx AppError → visible
  failed state, not infinite redrive).
- **H2 — Finding #7 stands** (unconfirmed prep orderable at honest 0). Merge
  with H1 into the Monday Phase-A work.

**MEDIUM**
- **M1 — In-process duplicate-submit window**: idempotency map set AFTER
  orderId extraction; any throw between GoTab-accept and map.set (e.g.
  GOTAB_NO_ORDER_ID, response-read failure) ⇒ retry creates a SECOND real
  kitchen order. Fix: classify GOTAB_NO_ORDER_ID terminal-investigate.
- **M2 — Finding #4 grew**: import tx now heavier (availability sync +
  sweep) — parent-location (~400 products) import will blow the 5s
  interactive-tx window. BLOCKS DSC onboarding via parent; chunk before
  seeding real menus. **FIXED 2026-07-12**: reworked to set-based IDEMPOTENT
  CONVERGENCE — no interactive tx at all (~8 round trips for 400 products,
  was ~800): batch read → in-memory diff → one createMany (skipDuplicates)
  → chunked updates for CHANGED rows only → sweep last (structurally cannot
  touch fetched items) → one final read; response shape byte-identical.
  Proof is STRUCTURAL (nothing left to time out — local PG would have
  masked a wall-clock assertion) + `import.int.test.ts` (3 tests, mocked
  import adapter): 400-product import via the real authed HTTP route; full
  re-import sync matrix (price/86/upstream-removal/new-item/admin-prep
  preservation/no duplicates); prep-confirmation flow. Gate now typecheck +
  27 unit + 16 int.
- **M3 — Finding #6 stands** (pay-after-drop never REFUNDED) — real money at
  the 2.3 gate.
- **M4 — Reconcile scaling**: serial polls × 280ms pacing outrun the 10s tick
  around ~30 in-flight tickets; batch-status query is the known fix. Fine at
  POC scale. (Stale-FIRED zombie polling already on backlog.)

**LOW**
- L1 notes `.slice(0,200)` silently truncates — dormant (no notes UI), but
  allergy-adjacent; make explicit when notes ship.
- L2 resolveSpot cache never invalidates (spot reconfig → needs worker
  restart).
- L3 submittedByTicket map unbounded (trivial memory; clears on restart).
- L4 ~~admin 401 fix UNVERIFIED~~ **VERIFIED 2026-07-12**: all three manual
  checks passed (normal login; garbage token → bounce at load, no dashboard
  flash; valid-shaped-but-rejected token → dashboard loads, privileged click
  bounces). Remaining nit stays LOW: enterDash lacks an error path if the
  API is down.
- L5 Finding #5 stands (admin blind to available:false), mitigated by named
  import summaries.
- L6 No unitPrice sent — GoTab prices from ITS catalog; price drift between
  import and order = our-records-vs-tab mismatch → a 2.3 reconciliation
  question.

**Verdict: nothing blocks the weekend. UPDATE (same day): H1+H2 FIX
IMPLEMENTED pre-departure** — changeset: `TicketStatus.FAILED` (migration
`ticket_failed_status`, additive); pure `vendor-errors.ts` classifier
(terminal = 4xx AppError or GOTAB_NO_ORDER_ID, the M1 duplicate-risk case) +
4 unit tests; `submitWithTerminalHandling` wraps BOTH fire + redrive paths
(terminal → ticket FAILED, group CANCELLED, sibling PENDING tickets
CANCELLED, loud log, no retry — sweep excludes FAILED so the redrive loop
dies); add-item guards (prepConfirmed + gotab-mode fireability, diner-
readable messages); lock re-validates everything (backstop for config
changes post-add); customer UI greys unconfirmed items ("not yet
orderable"); worker reconcile overlap guard (fresh-eyes finding). **GATES
GREEN 2026-07-08 pre-departure**: migrate applied (`ticket_failed_status`),
typecheck clean, 27 unit (18+4+5), 9 integration — the int suite runs
fire/redrive THROUGH the new wrapper, proving the happy path undisturbed.
A4-style integration tests: **DONE 2026-07-12** (back from camping early) —
`guards.int.test.ts`, 4 tests in an ISOLATED file (vi.mock on the vendor-
adapter module; vitest per-file registries keep lifecycle.int.test.ts on the
real mock): add-unconfirmed → 400 then 201 after confirmation; lock
re-validates a post-add un-confirmation and rolls back cleanly; the full H1
blast pattern incl. FIRED-sibling preservation and no-second-adapter-call;
PENDING-sibling cancellation with timer no-op. Coverage boundary (deliberate,
noted in-file): the config-gated gotab-mode guard branches await the
test:gotab suite (2.7). Gate is now typecheck + 27 unit + 13 int.

### WEEKEND BREAK — Monday 2026-07-13 pickup list
Ross camping until Monday. State at close: all engineering verified, both
support threads with Zach (SDK/payment questions pending — THE 2.3 evidence),
everything committed. Monday, in order: (1) read Zach's SDK answers → record
as 2.3 evidence; (2) **Motor KDS + the two-vendor showcase run** (two
kitchens chiming 5 min apart, group COMPLETED, real readySpreadMs — this is
the Jon demo artifact, rehearse it); (3) **H1/H2 follow-through**: run the
gates if not done pre-departure — DONE 2026-07-08 — and the A4 integration
tests — DONE 2026-07-12 (13 int total) — and L4 — VERIFIED 2026-07-12 —
item 3 fully closed; (4) ~~book
the Jon meeting~~ **SET: demo at soccer camp with Jon, 2026-07-21** (kids
play together — informal, in person; staging per the DEMO SCRIPT below, with
the field-logistics work noted there). Small queue behind those: test:gotab
formalization, stale-FIRED sweep, tab-settle hygiene, zombie group
`b2033d0e` cancel.

---

## TWO-VENDOR SHOWCASE — 2026-07-12 (the Jon demo artifact, rehearsed)

**Group `32062ff7` — the complete product story on two physical devices:
Motor's kitchen on an iPhone (GoTops iOS), Konjo's on the PC. Motor chimed at
T+0, Konjo at precisely T+5:00, both bumped near T+8, group COMPLETED at
T+7:37.** Pickup list item 2: DONE.

### The numbers (GoTab's clock)
- **Stagger: 300.032s actual vs 300.000s intended — 32ms error** (n=2 with
  the 07-07 run's 46ms; we-hold-timers fidelity is consistently sub-50ms).
  Pipelines 0.18s / 0.19s — common-mode as ever. BullMQ delivered the +300s
  job 59ms late.
- **Kitchen-clock ready spread: 12.9s** (prepared 19:17:46.454 Konjo →
  19:17:59.354 Motor) — **11% of the 120s sync window**, hand-bumped on two
  devices. targetError ≈ −27.5s (landed early). The product KPI, measured on
  the mechanism the product actually uses, in rehearsal conditions.
- Orders: Motor 134206938 (tab `5m3csyhOfl3RG19Yj10T~4kg`), Konjo 134208065
  (tab `2zgDCfoFpGgEAbNHSRoIxbld`) — settle pile +2.

### Operational findings
- **GoTops is single-instance per PC** — a second kitchen needs a second
  device. The phone/PC split is BETTER for the demo anyway: two physically
  separate kitchens read as "real system." Demo staging: Jon's phone as the
  diner, Ross's phone as Motor's kitchen, laptop as Konjo's — the whole
  product in three hands.
- Expo Station toggle required on EVERY display (Konjo's lesson, applied to
  Motor at zero cost).

### DEMO SCRIPT (v1 — refine before the meeting)
One diner (Jon's phone), one item each from two vendors with visibly
different prep times → lock → pay → "watch": near kitchen chimes now, far
kitchen chimes in exactly N minutes → bump both as they'd finish → countdown
hits Ready, group completes → show the telemetry row: "this number — the gap
between your dishes — is what we minimize, and we measure it on every order."




