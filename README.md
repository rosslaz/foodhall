# Food Hall Orchestrator

Group ordering for a multi-vendor food hall, with cook-time synchronization: a
group orders from any vendor, and the system fires each vendor's ticket at a
computed time so all the food finishes within one window.

## Why it's built this way

**A monolith, not microservices.** A food hall peaks at hundreds of concurrent
users, not millions. One well-structured Node process on managed Postgres handles
this for years. The scheduling logic is cleanly separable (one pure function) so
it can be extracted later if you ever genuinely outgrow a single box. Building
distributed infra now would buy operational pain, not customers.

**Static prep times for now.** Real cook times depend on how slammed a kitchen is,
which static estimates can't capture. The MVP uses static `prepSeconds` per menu
item. When you get GoTab sandbox access, only the *numbers* feeding the scheduler
change — the scheduling math and every other layer stay identical.

## Architecture

```
Clients (customer web / ready board / admin)
        |  REST + WebSocket
   API layer (Fastify, Zod, JWT)
        |
   Backend monolith
     - order service     (carts, groups, lock)
     - scheduler         (pure fn: computes fire times)
     - vendor adapter    (swappable: mock now, GoTab later)
     - payment service   (per-member, Stripe-ready seam)
        |
   Job worker (BullMQ)   -> schedules groups once fully paid
                         -> fires tickets at scheduled time
                         -> reconciles READY status
                         -> drops unpaid items on timeout
                         -> sweeps stuck state, expires idle groups
                         -> beats a liveness heartbeat (see /api/health)
        |
   PostgreSQL (truth)  +  Redis (queue + pub/sub)
        |
   GoTab adapter (mock | real)
```

## The scheduling model

When the group becomes fully paid (the anchor — kitchens can't start before
payment, so anchoring at lock would let a slow payer push every fire time into
the past and collapse the stagger):

```
target_ready = all_paid_time + max(prep_time across all items)
ticket.fire_at = target_ready - ticket.prep_time   (per vendor)
```

A provisional schedule anchored at lock time is shown while the group pays;
the real fire times are re-anchored at the all-paid moment. The slowest vendor
fires immediately; faster vendors wait so everything finishes together. See
`src/modules/scheduler/scheduler.ts` and its tests.

## Group order lifecycle

`OPEN` (members join + add items) -> host locks -> `LOCKED` (each member pays
their own items) -> all paid -> `SCHEDULED` (via a durable worker job; in mock
mode delayed fire jobs are enqueued, in GoTab mode orders are submitted with
future `scheduled` timestamps) ->
`FIRED` (sent to vendors) -> `COMPLETED` (all tickets ready). A payment timeout
drops unpaid items so a stalled payer can't block the group forever; idle
`OPEN` groups are expired after `GROUP_OPEN_EXPIRY_HOURS`.

## Running locally (Windows / PowerShell)

```powershell
docker compose up -d                 # Postgres + Redis
Copy-Item .env.example .env          # then set JWT_SECRET to a long random string
npm install
npm run prisma:migrate               # create tables
npm run seed                         # 1 hall, 4 vendors, admin@foodhall.test / admin1234
npm run dev                          # API + UIs on http://localhost:3000
```

In a second terminal:

```powershell
npm run worker                       # fires tickets, reconciles status, handles timeouts
```

Then open `http://localhost:3000/`:
- `/customer/` — order on your phone (create or join a group)
- `/board/` — big-screen readiness board
- `/admin/` — manage vendors/menus, monitor activity (sign in with seeded admin)

Run the scheduler tests with `npm test`. Run the integration suite (the
lock/pay/timeout/schedule state machine against real Postgres + Redis) with
`npm run test:int` — requires `docker compose up -d`; it uses a separate
`foodhall_test` database and Redis db 1, so dev data and the dev worker's
queues are untouched.

`npm run check` chains all three (typecheck → unit → integration) and stops
at the first failure — the pre-demo / pre-commit ritual until there's CI.

## Operating it

- **Health:** `GET /api/health` covers both processes — the API by responding,
  the worker via a Redis heartbeat. `status: "degraded"` means the worker has
  not beaten in 60s (nothing is firing or reconciling); point any uptime
  monitor at this and alert on the status field. The endpoint stays HTTP 200
  when degraded so an API supervisor doesn't restart the wrong process.
- **Sweeps:** the worker re-drives lost work every 60s (stuck tickets, lost
  payment timeouts) and logs each detection at **error** level — a sweep
  firing means a primary mechanism failed and is worth investigating.
- **Telemetry:** every scheduled group gets a `ScheduleOutcome` row —
  prediction at schedule time, actuals at completion. `readySpreadMs` (first
  dish to last dish) is the product KPI; `targetErrorMs` is prediction error.
- **Rate limits:** only on unauthenticated mutating routes (group create 30/min,
  join 60/min, login 20/min, bootstrap-admin 5/min, per IP). Reads are
  uncapped on purpose — a venue's diners share one NAT IP.

## Demo flow

1. Admin signs in, confirms the seeded vendors/menu (or adds more).
2. On the customer app, create a group — you get a 6-letter code.
3. Join from another browser/phone with that code; everyone adds items.
4. Host taps "Lock order & pay". Each member pays their share (mock).
5. Once all paid, the board shows a countdown; the worker fires each vendor's
   ticket at its scheduled time and advances tickets to READY.

To watch firing happen fast, lower prep times in the seed or set
`GROUP_READY_WINDOW_SECONDS` low.

## Swapping in real GoTab

1. Implement the three methods in `src/vendor-adapter/gotab.ts` (the interface in
   `types.ts` is the only contract the app depends on). The scaffold sets
   `holdsSchedule = true`: GoTab holds per-order `scheduled` timestamps on a
   shared tab, so the app submits every ticket the moment the group is fully
   paid and runs no fire timers of its own — the BullMQ fire queue sits idle
   and the reconcile poll observes GoTab firing each order.
2. Set each vendor's `gotabLocationId` in the admin UI.
3. Set `VENDOR_ADAPTER=gotab` and the `GOTAB_API_*` env vars.

Nothing else changes. If GoTab offers status webhooks, add a route that calls
`markTicketReady()` in `status.service.ts` and you can drop the polling loop.

## Known limitations (MVP)

- Mock adapter readiness is time-based simulation (tickets finish exactly at
  the scheduler's `targetReadyAt`, so demos show the synchronization working);
  the worker polls it every 10s. Mock state is in-memory — restart the worker
  mid-cook and unknown orders are reported READY with a warning.
- WebSocket events trigger a full group re-fetch on the client — fine at food-hall
  scale, worth optimizing to incremental updates if traffic grows.
- Payments are mocked. The seam for Stripe/GoTab payments is documented in
  `payments.routes.ts`.
- Single food hall assumed (the UIs resolve a default hall). The schema already
  supports many halls; the frontends would need a hall selector.

## Project layout

```
prisma/          schema + seed
src/
  config/        env validation
  db/            Prisma client
  lib/           redis, logger, errors
  vendor-adapter/ interface + mock + GoTab scaffold + factory
  modules/
    auth/        login, JWT, role guards
    vendors/     vendor + menu CRUD, public menu
    groups/      create/join/add/lock, board feed
    orders/      lock, schedule, fire, status reconcile, timeout
    payments/    per-member pay, totals
    scheduler/   pure scheduling fn + tests
    realtime/    Redis pub/sub broker + WebSocket route
  jobs/          BullMQ queues + worker
  server.ts      Fastify wiring
public/          customer / board / admin (static single-file clients)
```
