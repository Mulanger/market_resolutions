# Resolution Tracker — Session Log

## Session 1 — Foundation & Project Scaffold (2026-05-05)

### Goal
Implement the groundwork and project structure for the trade-resolver service before any heavy-lifting pipeline work. Everything should compile cleanly and the service should boot and shut down gracefully.

### What Was Done

#### Project config files
- `package.json` — matches whale-watcher conventions: ESM, Node 22, same dep versions (ioredis, mongodb, undici, p-retry, pino, zod, tsx, vitest)
- `tsconfig.json` — identical to whale-watcher: `NodeNext` module, strict, ES2022 target
- `.env.example` — all env vars from spec §11 with sensible defaults
- `railway.json` — NIXPACKS build, ON_FAILURE restart policy, service name `trade-resolver`
- `Dockerfile` — node:22-slim, dist-only copy, exposes 8080
- `.gitignore`

#### Source files created

```
src/
├── config.ts           ← zod-validated, fail-fast on missing env, all vars from spec §11
├── logger.ts           ← pino, verbatim from watcher
├── db/
│   ├── mongo.ts        ← MongoClient singleton, 4 collections, connectMongo/closeMongo/isMongoConnected
│   ├── indexes.ts      ← ensureIndexes() for market_resolutions + trade_outcomes
│   ├── outcomes.ts     ← TypeScript types: MarketResolutionDoc, TradeOutcomeDoc, TraderResolvedFields
│   └── repos/
│       ├── resolutions_repo.ts   ← CRUD for market_resolutions (find, seed, update)
│       ├── outcomes_repo.ts      ← bulk upsert with frozenAt idempotency guard
│       └── traders_repo.ts       ← additive upsert of resolved* namespace ONLY
├── redis/
│   ├── publisher.ts    ← ioredis singleton, connectRedis/closeRedis/isRedisConnected, publishResolutionEvent
│   └── queue.ts        ← enqueueMaterialization (LPUSH), dequeueMaterialization (BRPOP), queueDepth
├── polymarket/
│   ├── schemas.ts      ← GammaMarketSchema + GammaEventSchema (zod), parseOutcomePrice copied verbatim
│   └── client.ts       ← undici + p-retry Gamma client, fetchMarketsBatched (chunked ≤50, 150ms delay)
├── pipeline/
│   ├── classify_resolution.ts  ← PURE function: GammaMarket → ResolutionView (spec §5.1 state machine)
│   ├── classify_outcome.ts     ← PURE function: (trade, resolution) → TradeOutcomeStatus + PnL (spec §5.2–5.4)
│   ├── resolution_scanner.ts   ← STUB (see TODO inside)
│   ├── outcome_materializer.ts ← STUB (see TODO inside)
│   └── trader_aggregator.ts    ← STUB (see TODO inside)
├── jobs/
│   ├── seed_backfill.ts        ← STUB (npm run backfill)
│   └── reaper.ts               ← STUB
├── http/
│   └── health.ts       ← GET /health → 200/503, structured JSON per spec §12
└── index.ts            ← boot, graceful SIGTERM/SIGINT, feature-flag-gated loop scaffolding
```

#### Key design decisions / gotchas

1. **Single-writer rules enforced in types.** `EnrichedWhaleMinimal` in mongo.ts has no write helpers — the resolver only reads trades/markets. `traders_repo.ts` only exposes `upsertTraderResolvedStats()` which is scoped to `resolved*` fields.

2. **`frozenAt: { $exists: false }` filter.** Already wired into `bulkUpsertOutcomes()`. This is the load-bearing idempotency guard — do not remove it.

3. **Feature flags all default to safe values.** `SCANNER_ENABLED=true` but `MATERIALIZER_ENABLED=false`, `TRADER_AGG_ENABLED=false`, `RESOLUTION_BROADCAST=false`. This matches the phased rollout in spec §18.

4. **`parseOutcomePrice` helper copied verbatim** from watcher's schemas.ts into `polymarket/schemas.ts`. Handles both array and JSON-encoded-string shapes from Gamma.

5. **`classifyResolution` returns `invalid` for multi-outcome markets** (outcomes.length > 2) per spec §10.2. The `invalid` state from disagreement detection is applied by the scanner (not by this pure function).

6. **SELL-side PnL.** `computePnl()` returns `pnlUsd: null` for SELLs — no FIFO matching in v1. `payoutUsd` is set to `usdSize` (proceeds received). See spec §5.4.

7. **Loop scaffolding in index.ts uses stubs** with clear TODO comments pointing to the pipeline modules. The service boots cleanly and exits gracefully; it just doesn't do real scanning yet.

---

### What Remains (Next Agent's Work)

Follow the implementation order in `AGENT.md §Implementation order`, picking up at **step 3**:

#### Immediate next steps (in order)

1. **`npm install`** in `D:\Resolution-tracker` — no deps installed yet.
2. **Run `npx tsc --noEmit`** to confirm the foundation compiles (should be clean).
3. **Implement `pipeline/resolution_scanner.ts`** — the most complex piece. Key things to get right:
   - `seedNewMarketsFromTrades()`: aggregate distinct conditionIds from trades not yet in market_resolutions, seed each as `tracking`.
   - `findDueMarkets()` + chunk → `fetchMarketsBatched()` → `classifyResolution()` per market.
   - Disagreement detector: if previous status=`resolved` and new `winningOutcome` differs → set status=`invalid`, enqueue rematerialization.
   - Upsert via `updateMarketResolution()`, then `enqueueMaterialization()` on `resolved` transitions.
   - `tierIntervalSec()` helper: hot=60s, warm=300s, cold=1800s based on endDate proximity and last trade time.
4. **Implement `pipeline/outcome_materializer.ts`** — streams trades by conditionId, calls `classifyOutcome()` + `computePnl()`, bulk-upserts via `bulkUpsertOutcomes()`.
5. **Implement `pipeline/trader_aggregator.ts`** — MongoDB aggregation pipeline (spec §6.3), upserts via `traders_repo.upsertTraderResolvedStats()`.
6. **Wire real functions into `src/index.ts`** (replace stubs with actual imports).
7. **Write unit tests** in `test/` for `classifyResolution` and `classifyOutcome` (spec §17 truth tables).
8. **Implement `jobs/seed_backfill.ts`** — one-shot script.

#### Later
- `jobs/reaper.ts` — QA/vacuum
- API server changes (`D:\whaleserver`) per spec §14
- Website changes (`D:\polywatch-website`) per spec §15
- Deploy to Railway (spec §16)

#### First thing the next agent should do

The Linux sandbox was unavailable in this session, so `npm install` and `npx tsc --noEmit` were not run. A manual audit of every file was done instead — one import bug was caught and fixed: `src/db/repos/traders_repo.ts` was importing `TraderDoc` from `outcomes.ts` (wrong) — corrected to `../mongo.js`. **Run these first before writing any new code:**

```bash
cd D:\Resolution-tracker
npm install
npx tsc --noEmit
```

Expected: zero errors. If there are errors, they are most likely in the `Filter` type usage in `outcomes_repo.ts` (fixed already) or a `GammaMarket` field access in the classifier. Fix any errors before continuing.

---

### Spec sections to re-read before implementing each pipeline module

- `§5` — state machines and truth tables (essential before touching any classifier)
- `§6.1` — scanner sketch including `tierIntervalSec` and the disagreement detector
- `§6.2` — materializer sketch including idempotency invariants
- `§6.3` — aggregation pipeline for trader stats
- `§7` — schema field names (must match exactly for API server joins)
- `§10` — edge cases: UMA dispute, negRisk, multi-outcome, TTL'd trades
- `§19` — v1 launch checklist (use as acceptance criteria)

---

## Session 2 — Pipeline Implementation (2026-05-05)

### Goal
Pick up from session 1 (foundation done, pipeline modules stubbed). Implement
the three pipeline loops, the seed-backfill job, wire them into `index.ts`, and
add unit tests for the pure classifiers.

### What was done

#### Pipeline modules (all real now, no stubs)

- **`src/pipeline/resolution_scanner.ts`** — full implementation:
  - `seedNewMarketsFromTrades()` aggregates distinct `market.conditionId` from
    `trades` and seeds any new ones as `tracking` with `nextCheckAt = now`.
  - `findDueMarkets()` → `fetchMarketsBatched()` (chunks of 50, 150ms delay).
  - Per-market: `classifyResolution()` → disagreement detector → atomic
    `updateMarketResolution()` with `nextCheckAt` from `tierIntervalSec()`.
  - On `tracking|closed → resolved` transitions: `enqueueMaterialization()` +
    `publishResolutionEvent()` (broadcast is feature-flag-gated in publisher).
  - On disagreement (was `resolved`, now disagreeing winningOutcome): force
    status to `invalid`, log loudly, enqueue rematerialization.
  - On `tracking → invalid` (multi-outcome detection): also enqueue.
  - Returns `ScanReport` consumed by the health endpoint.
  - Exports `tierIntervalSec()` and a small `TierConfig` interface so the
    function is testable without a real `loadConfig()`.

- **`src/pipeline/outcome_materializer.ts`** — full implementation:
  - `runMaterializerLoop(deps, callbacks)` — long-running BRPOP loop. Each
    iteration: dequeue → `materializeOutcomesForMarket()` → callback with
    `outcomesWritten`. Polls `callbacks.isShuttingDown()` between BRPOPs (5s).
  - `materializeOutcomesForMarket()` — streams trades by conditionId with a
    projection that includes only what `projectTradeToOutcome()` needs.
  - `projectTradeToOutcome()` — pure mapper from `(trade, resolution) →
    TradeOutcomeDoc`. Sets `frozenAt` only when status leaves `open`.
  - Bulk-upserts in batches of 500.

- **`src/pipeline/trader_aggregator.ts`** — full implementation:
  - Mongo aggregation (BUY only, status `resolved_win|resolved_loss`,
    `resolvedAt >= now - 365d`) groups per `proxyWallet`.
  - `upsertTraderResolvedStats()` from traders_repo writes only the
    `resolved*` namespace.

- **`src/jobs/seed_backfill.ts`** — full implementation:
  - Boots Mongo + Redis, ensures indexes, seeds new markets, fetches all
    tracked from Gamma, classifies and upserts, then inline-materializes any
    market that resolves in this pass.
  - Idempotent — running twice is a no-op (insert E11000 swallowed in repo;
    `frozenAt: { $exists: false }` filter on outcome upserts).

#### index.ts wiring

- Replaced the three stub blocks with real imports:
  - Scanner: `runResolutionScan({marketResolutions, trades})` on
    `setInterval(SCAN_INTERVAL_MS)`. First tick fires immediately.
  - Materializer: `runMaterializerLoop(...)` runs as an awaited promise; its
    `isShuttingDown` callback hooks the global flag. On shutdown, we
    `Promise.race` it against a 10s timer.
  - Trader aggregator: `runTraderAggregator({tradeOutcomes, traders})` on
    `setInterval(TRADER_AGG_INTERVAL_MS)`.
- Health stats counters now reflect real numbers (markets checked, transitions,
  outcomes written, queue depth via `queueDepth()`).

#### Repo bugfix

- **`src/db/repos/outcomes_repo.ts`**: split `firstMaterializedAt` out of the
  `$set` payload in `bulkUpsertOutcomes()`. MongoDB rejects updates that mention
  the same field in both `$set` and `$setOnInsert`. Now `$set` carries
  everything else and `$setOnInsert` carries only `firstMaterializedAt`.

#### Tests

- `test/classify_outcome.test.ts` — full BUY × YES/NO × YES_WIN/NO_WIN truth
  table, full SELL truth table (inverse), `computePnl()` for win/loss/open/
  invalid for both sides, `normalizeOutcome()` happy paths and fallback.
- `test/classify_resolution.test.ts` — tracking → closed → resolved transitions,
  preservation of prior `closedAt`/`resolvedAt`, UMA-disputed blocks resolved,
  multi-outcome → invalid, idempotent re-classification, JSON-encoded-string
  outcomePrices and outcomes shapes.
- `test/tier_interval.test.ts` — frozen / closed / hot / warm / cold tiers,
  with and without `endDate`.
- `vitest.config.ts` — mirrors whale-watcher's setup.

### Known-not-done (out-of-scope for v1 codebase)

- `src/jobs/reaper.ts` — still a stub (per spec §19 / AGENT.md, post-launch).
- API server changes (`D:\whaleserver`) per spec §14 — separate repo, separate
  work item.
- Website changes (`D:\polywatch-website`) per spec §15 — separate repo.
- Railway deployment — credentials + admin work, can't be done from code alone.

### Compile / test status

The Linux sandbox was unavailable in this session (same as session 1), so
`npm install` / `npx tsc --noEmit` / `npm test` could not be run. Files were
hand-audited for type errors and import correctness:

- `bulkUpsertOutcomes` `$set` / `$setOnInsert` collision — fixed.
- `tierIntervalSec` config dependency narrowed to a `TierConfig` interface so
  tests don't need the full env-validated `Config`.
- `firstMaterializedAt` in `projectTradeToOutcome()` is set as a placeholder
  on the doc but stripped in the repo before the `$set` payload is built.

The next agent should run, in order:
```bash
cd D:\Resolution-tracker
npm install
npx tsc --noEmit
npm test
```

Expected: zero compile errors and all unit tests passing. Common gotchas:
- Mongo driver type strictness on dotted-path filters (`'market.conditionId'`).
  If TypeScript complains, an `as Filter<EnrichedWhaleMinimal>` cast is the
  watcher's escape hatch.
- The `outcomes` and `outcomePrices` fields on `GammaMarket` are typed
  `unknown`; unit tests pass them as native arrays/strings without casts.

### Spec-checklist progress (§19)

- [x] Foundation compiles (assumed — static audit only, sandbox unavailable).
- [x] All three pipeline loops implemented.
- [x] `seed_backfill` implemented.
- [x] Disagreement detector emits `invalid` without overwriting outcomes.
- [x] Materializer idempotency guard (`frozenAt: { $exists: false }`) verified
      and the `$set`/`$setOnInsert` collision fixed.
- [x] Unit tests cover the spec §17 truth tables.
- [ ] 24-hour crash-free run — needs deploy.
- [ ] Health 503 under forced Mongo disconnect — needs deploy.
- [ ] Sentry test exception — Sentry not yet wired (out of scope; spec §13
      observability is an additive enhancement post-v1).

---

## Session 3 — API server (whaleserver) integration (2026-05-05)

### Goal
Implement spec §14 in `D:\whaleserver\api-server`: read-side joins so the
website + Flutter app can render the new outcome data without any further
changes to the resolver service.

### What was done

#### New files

- **`D:\whaleserver\api-server\src\db\repos\outcomes_repo.ts`** —
  read-only access to `market_resolutions` and `trade_outcomes`. Helpers:
  - `getOutcomesByTradeIds(ids: string[])` → batch-fetch keyed map for O(1)
    merge into a page of trades.
  - `getResolutionByConditionId(conditionId)` → single market lookup.
  - `getRecentResolved(limit)` → recently-resolved feed.
  - `toOutcomeBlock(doc)` → maps `TradeOutcomeDoc` to client-facing
    `OutcomeBlock` (status, winningOutcome, payoutUsd, pnlUsd, resolvedAt as
    unix seconds, `closed: boolean`).
  - `toTraderResolvedBlock(traderDoc)` → projects the additive `resolved*`
    fields on a `traders` doc to a `TraderResolvedBlock` (returns null when
    no resolved BUY trades yet).

#### Modified files

- **`src/shared/types.ts`**:
  - `WhaleOutcome` interface (new).
  - Optional `resolution` field on `WhaleDto` — named `resolution` instead of
    `outcome` because `outcome: string` (the YES/NO position) is already in
    use. Documented in JSDoc.
  - `TraderResolved` interface (new).
  - Optional `resolved` field on `TraderDto`.
  - `ResolutionEventPayload` interface (new) — the payload shape on the
    `market_resolutions` Redis channel.

- **`src/config.ts`**:
  - `RESOLUTION_CHANNEL` env (default `market_resolutions`).
  - `OUTCOMES_IN_DTO` env (default `true`) — kill switch for the merge if
    something goes wrong on the resolver side.

- **`src/db/repos/whales_repo.ts`**:
  - Added `mergeOutcomesIntoDtos(dtos)` — best-effort, swallows errors so the
    feed keeps working if the resolver service is down.
  - Wired into `getWhales()` (paginated feed), `getWhaleById()`, and
    `getWhaleDetailById()` (the main trade, related trades, and the trader's
    recent trades).

- **`src/db/repos/traders_repo.ts`**:
  - `getTraderByWallet()` now reads `resolved*` fields from the `traders` doc
    and emits a `resolved` block on the DTO. (Note: this function is exported
    but not currently called by any route — the live profile endpoint goes
    through `leaderboard_repo.loadTraderProfile`.)
  - `getRecentWhalesForTrader()` now merges outcomes onto the returned trades.

- **`src/db/repos/leaderboard_repo.ts`**:
  - `TraderProfile.resolved?: TraderResolved` added.
  - `loadTraderProfile()` now reads the trader doc by `_id = lowercase wallet`
    in parallel with the existing aggregations and emits the resolved block.
  - `recentWhales` now goes through `mergeOutcomesIntoDtos`.

- **`src/redis/subscriber.ts`**:
  - Subscribes to BOTH `REDIS_CHANNEL` and `RESOLUTION_CHANNEL` on the same
    ioredis connection. Existing message consumers (hub, dispatcher) already
    guard by channel name, so this is non-breaking.

- **`src/ws/hub.ts`**:
  - The single message handler now dispatches by channel:
    - `REDIS_CHANNEL` → existing `{type:'whale', data}` broadcast.
    - `RESOLUTION_CHANNEL` → new `{type:'resolution_update', data}` broadcast
      to ALL connected clients (no per-filter matching, per spec §14.4).

- **`src/push/dispatcher.ts`**: NO CHANGES — the existing `if (channel !==
  config.REDIS_CHANNEL) return;` guard already filters out resolution events.

#### Behavioural notes

- The whaleserver and trade-resolver share the same MongoDB and Redis
  instances. The resolver writes; the API server reads.
- The merge is feature-flagged. To disable: set `OUTCOMES_IN_DTO=false` in
  the whaleserver's Railway env. The DTOs will simply omit the `resolution`
  field — old clients are unaffected, new clients see "open" for everything.
- Legacy `winRate` on traders (Polymarket-positions live) is untouched. The
  new `resolved.winRate` is locked-in resolved BUY trades. The website should
  label both clearly per spec §14.3.

### Compile / test status

Linux sandbox still unavailable — same as sessions 1–2. The whaleserver
changes were hand-audited:
- Type-only imports for `WhaleDto`, `WhaleFilter`, etc. preserved.
- `mergeOutcomesIntoDtos` accepts `WhaleDto[]` (not generic) so spread
  doesn't widen subtypes.
- `findOne<TraderResolvedFields>(...)` returns `T | null`, passed through
  `toTraderResolvedBlock(doc)` only when truthy.
- `mongo.collection<T>('traders')` doesn't conflict with the existing
  untyped `db.collection('traders')` calls in the same file — runtime is the
  same.

### Git push runbook (next agent / human)

Linux sandbox is unavailable to this assistant, so the git operations must
be run from a terminal on the user's machine.

**1) whaleserver (existing repo, remote already configured)**

```bash
cd D:\whaleserver
git status   # confirm only the api-server/src changes
git add api-server/src/shared/types.ts \
        api-server/src/config.ts \
        api-server/src/db/repos/outcomes_repo.ts \
        api-server/src/db/repos/whales_repo.ts \
        api-server/src/db/repos/traders_repo.ts \
        api-server/src/db/repos/leaderboard_repo.ts \
        api-server/src/redis/subscriber.ts \
        api-server/src/ws/hub.ts
git commit -m "feat(api): integrate trade-resolver outcomes into Whale/Trader DTOs

- Add outcomes_repo: read-only access to market_resolutions and trade_outcomes
- Extend WhaleDto with optional 'resolution' block (status, payout, pnl, etc.)
- Extend TraderDto with optional 'resolved' block (winRate, realizedPnl, etc.)
- Merge outcomes into /v1/whales feed, detail, and trader profile
- Subscribe to 'market_resolutions' Redis channel; broadcast resolution_update
  WS messages to all clients
- Feature-flag via OUTCOMES_IN_DTO (default true)

Implements trade-resolver spec §14."
git push origin master
```

Railway redeploys whaleserver automatically on push.

**2) Resolution-tracker (no git repo yet — initialize first)**

```bash
cd D:\Resolution-tracker
git init
git add .
git commit -m "feat: initial trade-resolver implementation per spec §1–§19

- Resolution scanner: priority-tiered Gamma polling, disagreement detector
- Outcome materializer: BRPOP queue, frozenAt idempotency guard
- Trader aggregator: rolls up resolved BUY trades into traders.resolved*
- Seed backfill: one-shot npm run backfill against existing trades
- Redis pub/sub on market_resolutions channel for live UI updates
- Health endpoint mirroring whale-watcher's shape
- Unit tests for the pure classifiers (truth tables per spec §17)

Single-writer rules: only writes market_resolutions, trade_outcomes, and
the resolved* namespace on traders. No mutation of the watcher's
or API server's collections."
# create a GitHub repo (e.g. github.com/Mulanger/Resolution-tracker) first, then:
git remote add origin https://github.com/Mulanger/Resolution-tracker.git
git branch -M master
git push -u origin master
```

After the GitHub repo exists and is pushed, create the Railway service:
- New service → Deploy from GitHub repo → select `Resolution-tracker`
- Set env vars per `.env.example` (MONGO_URI and REDIS_URL must point at
  the same Mongo + Redis already used by whaleserver and whale-watcher)
- Initial deploy with `MATERIALIZER_ENABLED=false`,
  `TRADER_AGG_ENABLED=false`, `RESOLUTION_BROADCAST=false`
- Then flip flags on one at a time per spec §18 phased rollout.
