# Food Hall Order Synchronization — Project Context

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
- [ ] Run sandbox test plan (scheduling behavior, tab integrity, load calibration) — full Phase 2–5 plan in `roadmap.md`
- [ ] Build MVP scheduler
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

Full design in **`prep-estimation-design.md`**. This is the system that
answers both flavors of prep-time uncertainty — unknown (blank/wrong values)
and non-stationary (rush-hour drift) — and it is the direct answer to this
doc's load-modeling caveat. The one-paragraph version:

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




