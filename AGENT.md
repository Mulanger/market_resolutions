# Resolution Tracker Agent Handoff

This repo is the future home of the **trade resolution tracker**: a new always-on Node.js worker that watches Polymarket markets for resolution, classifies every whale trade as `open` / `resolved_win` / `resolved_loss` / `invalid`, and writes the result back to the shared MongoDB so the website, Flutter app, and API server can render an `Open / Closed / Win / Loss` pill on every trade card and surface resolved win-rate stats on trader profiles.

It is **not yet implemented**. This folder currently contains only the architecture spec. The implementation is the work to be done. A new agent picking up this project should read `04_TRADE_RESOLUTION_TRACKER.md` (in this folder) front-to-back before writing any code.

## Current Status

- Architecture spec: `D:\Resolution-tracker\04_TRADE_RESOLUTION_TRACKER.md` — complete, approved direction.
- Source code: not started. No `src/`, `package.json`, `Dockerfile`, or `railway.json` yet.
- Production host: Railway (planned). This will run as a fourth Railway service alongside the existing watcher, API server, and website.
- Singleton: exactly one instance. Two would double-fetch Gamma and race the materialization queue.

## Polywatch System Map

The Polywatch product is split across four project folders on this PC. Three are deployed to Railway today; this one (`D:\Resolution-tracker`) is the fourth and is not yet deployed.

```
                  Polymarket
                  ┌─────────────────────────────────────┐
                  │  Data API   /trades  /positions     │
                  │  Gamma API  /markets /events        │
                  └────┬───────────────────────┬────────┘
                       │ poll                  │ poll
                       ▼                       ▼
   ┌────────────────────────────┐   ┌──────────────────────────────┐
   │   D:\whalebackend          │   │   D:\Resolution-tracker      │
   │   whale-watcher (worker)   │   │   trade-resolver (this repo) │
   │   • polls /trades          │   │   • polls /markets           │
   │   • detects whales         │   │   • classifies resolution    │
   │   • writes trades, markets,│   │   • materializes outcomes    │
   │     traders, trade_events, │   │   • writes:                  │
   │     trader_daily_stats     │   │     market_resolutions       │
   │   • publishes 'whales' on  │   │     trade_outcomes           │
   │     Redis                  │   │     traders.resolved* fields │
   └────────────┬───────────────┘   │   • publishes                │
                │                   │     'market_resolutions'     │
                │                   │     on Redis                 │
                │                   └────────────┬─────────────────┘
                │                                │
                ▼                                ▼
            ┌────────────────────────────────────────┐
            │            MongoDB (shared)            │
            │            DB: polywatch               │
            └─────────────┬──────────────────────────┘
                          │ reads everything
                          ▼
            ┌────────────────────────────────────────┐
            │          D:\whaleserver                │
            │          api-server (Fastify)          │
            │   • REST /v1/whales, /v1/leaderboard,  │
            │     /v1/traders, /v1/markets, /v1/auth │
            │   • WS /v1/whales/stream               │
            │   • subscribes to 'whales' Redis chan  │
            │   • will subscribe to                  │
            │     'market_resolutions' (new)         │
            │   • dispatches FCM push notifications  │
            └────────────┬───────────────────────────┘
                         │
              ┌──────────┼──────────────┐
              ▼          ▼              ▼
      D:\polywatch-   Flutter app    Web/mobile
      website        (separate repo) clients
      (React/Vite)
```

### Folders on disk

| Path | Role | Language | Deployed |
|---|---|---|---|
| `D:\polywatch-website` | Public website (React/Vite SPA + tiny Express proxy) | TS/JSX | Railway |
| `D:\whaleserver` (`api-server/`) | REST + WebSocket API for mobile + web clients | Node 22 / TS / Fastify | Railway |
| `D:\whalebackend` (`whale-watcher/`) | Polymarket polling worker; writes trades to Mongo | Node 22 / TS | Railway |
| `D:\Resolution-tracker` | **(this repo)** Resolution tracker worker | Node 22 / TS *(planned)* | not yet |

The Flutter mobile app lives elsewhere on disk and is out of scope for this folder, but it consumes the same API server.

## Required reading before coding

Read these in order. Don't skip any.

1. **`D:\Resolution-tracker\04_TRADE_RESOLUTION_TRACKER.md`** — the architecture spec for what we're building here. State machines, schema, pipeline shapes, edge cases, rollout phases.
2. **`D:\whalebackend\whale-watcher\02_WHALE_WATCHER_BACKEND.md`** — how the watcher works. Match its conventions for project layout, config, logging, retries, graceful shutdown.
3. **`D:\whaleserver\03_API_SERVER.md`** — how the API server works. We'll be writing data it consumes; the contract in §14 of `04_*.md` must line up with its DTOs.
4. **`D:\polywatch-website\AGENT.md`** — the website's handoff doc. Useful for understanding the web product surface and how outcomes will eventually be rendered.
5. **Watcher source under `D:\whalebackend\whale-watcher\src\`** — copy idioms verbatim where the spec says to. Especially:
   - `src/polymarket/client.ts` — `undici` + `p-retry` Gamma client. Reuse the pattern.
   - `src/polymarket/schemas.ts` — zod schemas for Gamma. The `parseOutcomePrice` helper is needed in this service.
   - `src/db/mongo.ts` — Mongo connection pattern.
   - `src/db/indexes.ts` — idempotent index ensure pattern.
   - `src/redis/publisher.ts` — Redis pub/sub wrapper.
   - `src/jobs/refresh_markets.ts` — closest analog to our resolution scanner.
   - `src/http/health.ts` and `src/index.ts` — health endpoint and graceful shutdown shape.
6. **API server source under `D:\whaleserver\api-server\src\`** for the consumer side:
   - `src/db/repos/whales_repo.ts` — where the new `outcome` block will be joined into `WhaleDto`.
   - `src/db/repos/traders_repo.ts` — where `traders.resolved*` will be exposed on `TraderDto`.
   - `src/shared/types.ts` — DTO shapes; do not break existing fields.

## What this service does (one-paragraph version)

A periodic scanner polls Polymarket Gamma `/markets?condition_ids=...` for every market a whale has traded on in the last 90 days, classifies each as `tracking | closed | resolved | invalid`, and writes a frozen view to the new `market_resolutions` collection. When a market transitions to `resolved`, its conditionId is pushed to a Redis list; a separate materializer drains the queue, iterates every trade on that market, and writes a frozen `trade_outcomes` row with status `resolved_win | resolved_loss | invalid`. A trader-stats aggregator runs every 5 minutes and rolls the resolved trades up into additive `resolved*` fields on the existing `traders` collection. A Redis pub/sub channel `market_resolutions` lets the API server broadcast resolution events to connected WebSocket clients so trade-card pills update in place.

Full detail, including state machines, edge cases (UMA disputes, negRisk, multi-outcome, trade TTL), and rollout phases, is in `04_TRADE_RESOLUTION_TRACKER.md`.

## Shared infrastructure (also used by watcher and API)

| Resource | Purpose | Notes |
|---|---|---|
| MongoDB Atlas, db `polywatch` | Durable storage | Same connection string as the other two services. Env: `MONGO_URI`, `MONGO_DB`. |
| Redis (Upstash on Railway) | Pub/sub + work queue | Channel `whales` is owned by the watcher. We'll add channel `market_resolutions` and list `queue:trade_resolution:materialize`. Env: `REDIS_URL`. |
| Polymarket Gamma | Read-only HTTPS, no auth | `https://gamma-api.polymarket.com`. Rate-limit observations: 50 condition IDs per `/markets` call, 100–150 ms inter-call delay, 5 RPS burst max. Same etiquette as the watcher. |

## MongoDB collections — who writes what

Single-writer rules. Don't break them.

| Collection | Owner (writer) | Read by |
|---|---|---|
| `trades` | whale-watcher | api-server, this service |
| `markets` | whale-watcher | api-server, this service (read only) |
| `traders` (legacy fields: `vol30d`, `winRate`, `tradeCount`, `totalPnl`, `pseudonym`, `displayName`, `profileImage`, `refreshedAt`) | whale-watcher | api-server |
| `traders` (new fields: `resolvedBuyCount`, `resolvedWinCount`, `resolvedLossCount`, `resolvedWinRate`, `resolvedRealizedPnlUsd`, `resolvedVolumeUsd`, `resolvedLastUpdatedAt`, `resolvedLastResolvedAt`) | **this service** (additive `$set` only) | api-server |
| `intent_discards` | whale-watcher | — |
| `trade_events` | whale-watcher | api-server |
| `trader_daily_stats` | whale-watcher | api-server |
| `users` | api-server | api-server |
| `alert_subscriptions` | api-server | api-server |
| `notification_log` | api-server | api-server |
| `follows` | api-server | api-server |
| `market_resolutions` | **this service** | api-server |
| `trade_outcomes` | **this service** | api-server |

Never `$unset` fields owned by another service. Never `$set` legacy `traders.winRate` from this service — keep our resolved-stats in the `resolved*` namespace.

## Redis topology

| Key | Type | Owner (writer) | Subscriber |
|---|---|---|---|
| `whales` | pub/sub channel | whale-watcher | api-server (WS hub, FCM dispatcher) |
| `market_resolutions` | pub/sub channel | **this service** | api-server (WS hub) |
| `queue:trade_resolution:materialize` | list (LPUSH/BRPOP) | **this service** scanner | **this service** materializer |
| `intent:*` | various | whale-watcher (intent classifier) | whale-watcher |

## Tech stack conventions (match across the system)

- **Node 22 LTS**, ESM, TypeScript 5.6+ with strict mode.
- **`mongodb` v6** native driver. No Mongoose.
- **`undici`** for HTTP. **`p-retry`** for backoff. **`ioredis`** for Redis. **`zod`** for input validation. **`pino`** for logs.
- **`vitest`** for tests, target >85% coverage on pure pipeline modules.
- Health server on port `HEALTH_PORT` (default `8080`). Endpoint `/health` returns 200/503 with a structured status object.
- Graceful shutdown on SIGTERM and SIGINT — stop loops, drain in-flight work, close Mongo + Redis, exit 0. Watcher's `src/index.ts` is the reference.
- Config loaded via zod-validated `loadConfig()` and **fail fast** on missing env. Same pattern as `whale-watcher/src/config.ts`.
- Logs are structured JSON. Wallet addresses are public and fine to log. Don't log API keys or full env.

## Project layout (to be created)

The architecture spec proposes this layout (`04_TRADE_RESOLUTION_TRACKER.md` §3):

```
D:\Resolution-tracker
├── 04_TRADE_RESOLUTION_TRACKER.md   # architecture spec (already here)
├── AGENT.md                          # this file
├── src/
│   ├── index.ts                      # boot, signals, loops
│   ├── config.ts                     # env loading + zod
│   ├── logger.ts                     # pino
│   ├── db/
│   │   ├── mongo.ts
│   │   ├── indexes.ts
│   │   ├── outcomes.ts               # types for trade_outcomes + market_resolutions
│   │   └── repos/
│   │       ├── resolutions_repo.ts
│   │       ├── outcomes_repo.ts
│   │       └── traders_repo.ts       # only writes resolved* fields
│   ├── redis/
│   │   ├── publisher.ts
│   │   └── queue.ts
│   ├── polymarket/
│   │   ├── client.ts                 # mirror watcher's idiom
│   │   └── schemas.ts                # reuse parseOutcomePrice
│   ├── pipeline/
│   │   ├── classify_resolution.ts    # pure
│   │   ├── classify_outcome.ts       # pure
│   │   ├── resolution_scanner.ts
│   │   ├── outcome_materializer.ts
│   │   └── trader_aggregator.ts
│   ├── jobs/
│   │   ├── seed_backfill.ts
│   │   └── reaper.ts
│   └── http/
│       └── health.ts
├── test/
├── Dockerfile
├── package.json
├── tsconfig.json
├── railway.json
└── .env.example
```

## Implementation order (recommended)

This is a phased plan so the system is never half-broken. Full detail in spec §18.

1. Scaffold `package.json`, `tsconfig.json`, `src/index.ts` skeleton, `src/config.ts`, `src/logger.ts`. Wire health endpoint. Verify it boots and exits cleanly.
2. Add `src/db/mongo.ts` and `src/db/indexes.ts`. Connect, ensure indexes for both new collections, exit cleanly.
3. Implement `pipeline/classify_resolution.ts` and `pipeline/classify_outcome.ts` as **pure** functions with comprehensive unit tests. Truth tables in spec §5.
4. Implement `polymarket/client.ts` and schemas — copy the watcher's pattern.
5. Implement `pipeline/resolution_scanner.ts`. Run against staging Mongo with `MATERIALIZER_ENABLED=false`. Verify `market_resolutions` populates plausibly.
6. Implement `pipeline/outcome_materializer.ts` + `redis/queue.ts`. Wire BRPOP loop. Verify idempotency: re-running on a frozen trade is a no-op.
7. Implement `pipeline/trader_aggregator.ts`. Verify `traders.resolved*` populates and the watcher's legacy fields are unchanged.
8. Implement `jobs/seed_backfill.ts`. Run once against staging.
9. Add Redis publish on transitions. Wire the API server's WS hub to subscribe (separate repo work in `D:\whaleserver`).
10. Deploy to Railway with feature flags (`MATERIALIZER_ENABLED`, `TRADER_AGG_ENABLED`, `RESOLUTION_BROADCAST`) all off, then flip them on one at a time.

## Environment variables (planned)

Mirror the watcher's shape. From spec §11:

```
NODE_ENV=production
LOG_LEVEL=info

# Polymarket
POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com

# Mongo (shared with watcher + api)
MONGO_URI=mongodb+srv://...
MONGO_DB=polywatch

# Redis (shared with watcher + api)
REDIS_URL=redis://...
RESOLUTION_CHANNEL=market_resolutions
MATERIALIZE_QUEUE=queue:trade_resolution:materialize

# Loops
SCAN_INTERVAL_MS=30000
SCAN_PER_RUN_BATCH=200
HOT_RECHECK_SEC=60
WARM_RECHECK_SEC=300
COLD_RECHECK_SEC=1800
TRADER_AGG_INTERVAL_MS=300000

# Health
HEALTH_PORT=8080

# Feature flags
SCANNER_ENABLED=true
MATERIALIZER_ENABLED=false
TRADER_AGG_ENABLED=false
ON_DEMAND_HOOK_ENABLED=false
RESOLUTION_BROADCAST=false
```

## Important spec sections to revisit while coding

- **§5 — State machines.** Get the transitions right. `resolved → invalid` is the disagreement detector; never silently overwrite a `winningOutcome`.
- **§5.3 — SELL-side nuance.** Don't render SELLs as red/green; map them to neutral pills. Win/loss on SELLs is for trader scoring only.
- **§5.4 — PnL semantics.** BUY: `pnlUsd = payout − cost`. SELL: `pnlUsd = null`. We are not doing FIFO position matching in v1.
- **§7 — Schema and indexes.** `frozenAt: { $exists: false }` on the materializer's filter is what makes it idempotent. Don't drop that guard.
- **§10 — Edge cases.** UMA disputes, negRisk, multi-outcome (downgrade to invalid in v1), trade TTL, intent-discarded whales (already filtered out upstream).
- **§14 — API server changes.** Optional `outcome` block on `WhaleDto`, `resolved` block on `TraderDto`, new `resolution_update` WebSocket message type. Don't break existing fields.

## Cross-repo gotchas

- The `trades` collection has a 90-day TTL via `ingestedAt`. Trades older than that disappear, but we keep `trade_outcomes` indefinitely so trader stats survive.
- The watcher's intent classifier filters DECREASE/CLOSE trades into `intent_discards` so they never reach `trades`. That means our pipeline naturally only sees OPEN/INCREASE trades — no need to filter intents here.
- Polymarket Gamma sometimes returns `outcomePrices` as an array, sometimes as a JSON-encoded string. The watcher's `parseOutcomePrice` helper in `D:\whalebackend\whale-watcher\src\polymarket\schemas.ts` handles both — copy it verbatim.
- Polymarket `umaResolutionStatus` is sometimes absent. Treat absent as "fine, accept the outcome" but treat `disputed` as a hard stop on writing `resolved`.
- The website (`D:\polywatch-website\src\App.jsx`) renders `WhaleDto` directly. Adding the optional `outcome` block to that DTO is harmless to old clients but the website will need a real change to render the pill. That work happens in the website repo, not here.

## Caution For Future Agents

- **Don't start coding before reading the spec.** The state machines and edge cases are non-obvious. Skipping §5 and §10 will produce a service that looks right and fails on UMA disputes.
- **Single-writer rules are load-bearing.** Don't write to `trades`, `markets`, the watcher's fields on `traders`, or the API server's `users`/`alerts`/`follows` collections from this service.
- **Idempotency is non-negotiable.** Both the scanner (advances state, never downgrades) and the materializer (`frozenAt: { $exists: false }` filter) must be safe to rerun on a restart or a backfill.
- **Don't skip the queue.** The Redis list between scanner and materializer keeps the scanner cheap and bounds the materializer's blast radius. Don't fan out per-trade writes inside the scanner loop.
- **Match the watcher's conventions.** New services should feel like the existing ones in style and shape so the team stays sane. Logging format, config validation, graceful shutdown, project layout, retry patterns — copy them.
- **Run the spec's v1 checklist (§19) before declaring done.** Health probe under forced Mongo disconnect, idempotency test, disagreement detector exercised in staging, Sentry capturing a test exception.
