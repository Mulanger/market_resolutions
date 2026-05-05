# Polymarket Whale Watcher — Trade Resolution Tracker

This document specifies the **trade resolution tracker**: a new always-on Node.js worker that watches Polymarket markets for resolution, classifies each whale trade as `open` / `resolved_win` / `resolved_loss` / `invalid`, and writes the result back to the shared MongoDB so the website, Flutter app, and API server can render an `Open / Closed / Win / Loss` pill on every trade card and compute resolved win-rate stats on trader profiles.

It is the **fourth process** in the Polywatch system. It does **not** replace the existing whale-watcher (doc 02) or the API server (doc 03), and it does **not** mutate `trades`, `markets`, or any field that the other services own. Its writes are confined to two new collections (`market_resolutions`, `trade_outcomes`) and a small additive write into `traders`.

This is a build spec for a coding agent. Follow the steps in order.

---

## 1. What this service does

The trade resolver is a **stateful, long-running Node.js process** that:

1. Periodically scans Polymarket Gamma for the resolution status of every market our whales have traded on, from a 90-day window backward.
2. Detects when a market closes and when its winning outcome is published.
3. Materializes a per-trade outcome row for every whale trade on that market — `resolved_win`, `resolved_loss`, or `invalid` — at the moment resolution is observed and never recomputes after that.
4. Maintains a single source of truth in `market_resolutions` and `trade_outcomes` that the API server can join into existing endpoints with no extra HTTP hop.
5. Periodically rolls up resolved outcomes per wallet into `traders.resolved*` fields so the API can serve `winRate` / realized PnL on trader profiles.
6. Publishes a `market_resolutions` Redis event whenever a market's status changes so the API server can push live "this trade just closed" updates over the existing WebSocket.

It does **not**:

- Watch Polymarket trades — that's the whale-watcher's job.
- Serve any public HTTP — it only exposes `/health` for orchestration.
- Hold private keys, custody funds, or place trades.
- Touch the `trades` collection directly. Outcomes live in a sibling collection so a TTL'd trade can still have a preserved outcome.
- Recompute outcomes after they're frozen. Once a trade is `resolved_win|resolved_loss|invalid`, it stays that way unless an admin force-rebuilds.

Statefulness is fine: this is a singleton like the whale-watcher. Two instances would just double the Polymarket load and potentially race on the materialization queue. Run exactly one.

---

## 2. How it fits with the rest of the system

```
                ┌──────────────────────────┐
                │ Polymarket Gamma API     │
                │ /markets, /events        │
                └────────────┬─────────────┘
                             │ poll (priority-tiered)
                             ▼
   ┌─────────────────────────────────────────────────┐
   │           Trade Resolution Tracker              │
   │                                                 │
   │  ┌──────────────────┐   ┌─────────────────────┐ │
   │  │ resolution-scan  │──▶│ outcome-materialize │ │
   │  │ (per-market)     │   │ (per-trade fan-out) │ │
   │  └──────────┬───────┘   └──────────┬──────────┘ │
   │             │                      │             │
   │             ▼                      ▼             │
   │     market_resolutions      trade_outcomes      │
   │                                                 │
   │  ┌──────────────────────────────────────────┐   │
   │  │  trader-outcome-aggregator (every 5min)  │   │
   │  │  upserts traders.resolved* fields        │   │
   │  └──────────────────────────────────────────┘   │
   └────────────┬────────────────────┬───────────────┘
                │ writes              │ publish
                ▼                     ▼
       ┌──────────────────┐    ┌──────────────────┐
       │     MongoDB      │    │ Redis pub/sub    │
       │ (shared with     │    │ chan:            │
       │  watcher + API)  │    │ market_resolutio…│
       └────────┬─────────┘    └────────┬─────────┘
                │ reads                  │ subscribes
                ▼                        ▼
       ┌────────────────────────────────────────────┐
       │             API Server (doc 03)            │
       │  • joins outcome into WhaleDto             │
       │  • exposes resolved* on TraderDto          │
       │  • broadcasts WS:resolution_update events  │
       └────────────────────┬───────────────────────┘
                            │
                            ▼
               website (D:\polywatch-website)
               flutter app
```

Key boundaries:

- **Watcher** owns: `trades`, `markets`, `traders.{vol30d,winRate,tradeCount,…}` (legacy stats from Polymarket positions). Continues unchanged.
- **API server** owns: `users`, `alert_subscriptions`, `notification_log`, `follows`. Continues unchanged. Gains read-side joins into the new collections.
- **Resolver** (this doc) owns: `market_resolutions`, `trade_outcomes`, `traders.resolved*` (only its own additive fields, namespace-prefixed to avoid collision with the watcher's fields).

The watcher's existing `markets` collection already has `endDate`, `isActive`, and YES/NO prices, but it's tuned for "is this market currently tradeable" — not for "is this market officially resolved with an authoritative winning outcome". Trying to overload it would entangle two pipelines. The new `market_resolutions` collection is small (≤1 doc per resolved market, plus open ones we're tracking) and has clear ownership.

---

## 3. Tech stack

| Choice | Version | Why |
|---|---|---|
| Node.js | 22 LTS | Same as watcher and API server, share types |
| TypeScript | 5.6+ | Type safety on Gamma + Mongo shapes |
| `mongodb` (official) | 6+ | Same driver as watcher; raw driver, no ORM |
| `undici` | latest | Fastest HTTP client, used by watcher already |
| `ioredis` | 5+ | Same Redis client as watcher |
| `zod` | 3+ | Validate Polymarket Gamma responses |
| `pino` | 9+ | Structured logging, matches house style |
| `p-retry` | 6+ | Retry/backoff on Polymarket transient errors |
| Scheduling | `setInterval` + a tiny priority queue | No cron complexity needed |

We deliberately do not pull in BullMQ, Temporal, or any other workflow engine. The work is small and the dedup primitives (Mongo unique index + atomic upsert) are sufficient.

### Project layout (sibling to the other two repos)

```
D:\whaleresolver
└── trade-resolver/
    ├── 04_TRADE_RESOLUTION_TRACKER.md   # this file (committed at repo root or here)
    ├── src/
    │   ├── index.ts                     # boot, signals, loops
    │   ├── config.ts                    # env loading + zod
    │   ├── logger.ts                    # pino instance
    │   ├── db/
    │   │   ├── mongo.ts                 # shared Mongo connection
    │   │   ├── indexes.ts               # idempotent index ensure
    │   │   ├── outcomes.ts              # types for trade_outcomes + market_resolutions
    │   │   └── repos/
    │   │       ├── resolutions_repo.ts  # CRUD for market_resolutions
    │   │       ├── outcomes_repo.ts     # CRUD for trade_outcomes
    │   │       └── traders_repo.ts      # additive upsert of traders.resolved*
    │   ├── redis/
    │   │   ├── publisher.ts             # publish 'market_resolutions' events
    │   │   └── queue.ts                 # tiny work queue (LPUSH/BRPOP)
    │   ├── polymarket/
    │   │   ├── client.ts                # Gamma /markets, /events
    │   │   └── schemas.ts               # zod schemas for resolution-relevant fields
    │   ├── pipeline/
    │   │   ├── classify_resolution.ts   # pure: GammaMarket → ResolutionStatus
    │   │   ├── classify_outcome.ts      # pure: (trade, resolution) → TradeOutcome
    │   │   ├── resolution_scanner.ts    # the periodic market scan loop
    │   │   ├── outcome_materializer.ts  # consumes the queue, writes trade_outcomes
    │   │   └── trader_aggregator.ts     # rollup into traders.resolved*
    │   ├── jobs/
    │   │   ├── seed_backfill.ts         # one-shot backfill against existing trades
    │   │   └── reaper.ts                # vacuum/QA stats
    │   └── http/
    │       └── health.ts                # tiny /health server
    ├── test/
    │   ├── classify_resolution.test.ts
    │   ├── classify_outcome.test.ts
    │   └── pipeline.integration.test.ts
    ├── Dockerfile
    ├── package.json
    ├── tsconfig.json
    ├── railway.json
    └── .env.example
```

---

## 4. Polymarket data sources we use

We use **Gamma only** in the hot path. The Data API is only used by the seed backfill (and only optionally — historical resolution status is already on Gamma).

### 4.1 Gamma API — `https://gamma-api.polymarket.com`

#### `GET /markets?condition_ids=<csv>`

Already used by the watcher. Returns a list of market objects, one per `conditionId`. We fetch in batches of up to 50 condition IDs per call to stay polite. The fields we care about for resolution:

| Gamma field | Type | Used for |
|---|---|---|
| `conditionId` | string | Primary key, joins with `trades.market.conditionId` |
| `slug` | string | Display, fallback identifier |
| `endDate` | ISO string | Did the market reach its scheduled end? |
| `closed` | bool | Is the market no longer tradeable? |
| `active` | bool | Inverse signal; `!active && closed` is the strongest "done" signal |
| `acceptingOrders` | bool | Belt-and-braces signal that trading has stopped |
| `umaResolutionStatus` | string | UMA pipeline state — `"resolved"`, `"posted"`, `"disputed"`, or absent |
| `outcomePrices` | string-of-array `'["1","0"]'` | When resolved, [1,0] = YES wins, [0,1] = NO wins |
| `outcomes` | string-of-array `'["Yes","No"]'` | Display names of outcomes |
| `negRisk` | bool | Multi-outcome event (e.g. presidential primary). See §10 |
| `clobTokenIds` | string-of-array | Per-outcome ERC-1155 token IDs; used to align with trade.asset |
| `resolutionSource` | string | Free-text source (e.g. CoinGecko URL); audit only |
| `marketMakerAddress` | string | Audit only |

Polymarket has historically returned `outcomePrices` as a JSON-encoded string rather than an array. The watcher's `GammaMarketSchema` already handles both shapes via `parseOutcomePrice` — reuse that utility verbatim in this service to stay consistent.

#### `GET /events/:eventId`

Only used as a fallback when `/markets` returns nothing for a `conditionId` (rare but happens for very old markets). The watcher already uses this and works around the same edge cases.

### 4.2 What we deliberately don't use

- **CLOB API resolution events** — would require auth and adds a second consumer of Polymarket's WS. Gamma polling is enough.
- **UMA OptimisticOracle on-chain events on Polygon** — authoritative, but requires an RPC provider, contract ABIs, and a significant amount of decoding. Defer to a v2 if Gamma ever goes down for resolution data.
- **Polymarket Subgraph** — fine but a different mental model from the rest of our stack. Not worth the inconsistency.

---

## 5. Resolution status, outcome status, and the state machine

Two state machines, one per market, one per trade. Both are append-only after they reach a terminal state.

### 5.1 Market resolution states

```
                   ┌────────────┐
            (default)            │
                                 ▼
   first observed       ┌────────────────┐
   (any whale ever) ───▶│   tracking     │
                        └────────┬───────┘
                                 │ closed=true on Gamma
                                 ▼
                        ┌────────────────┐
                        │    closed      │   ← market stopped trading,
                        └────────┬───────┘     winning outcome not yet authoritative
                                 │ outcomePrices ∈ {[1,0],[0,1]}
                                 │ AND umaResolutionStatus='resolved' (when present)
                                 ▼
                        ┌────────────────┐
                        │   resolved     │   ← terminal: winning outcome locked
                        └────────────────┘

   any state ──(detected dispute / outcome flipped)──▶ ┌──────────┐
                                                       │ invalid  │ ← terminal
                                                       └──────────┘
```

The pure classifier:

```typescript
// pipeline/classify_resolution.ts
export type MarketResolutionStatus = 'tracking' | 'closed' | 'resolved' | 'invalid';

export interface ResolutionView {
  status: MarketResolutionStatus;
  closedAt: number | null;             // unix seconds; first observation of closed=true
  resolvedAt: number | null;           // unix seconds; first observation of authoritative outcome
  winningOutcome: 'YES' | 'NO' | null;
  winningOutcomeIndex: number | null;  // 0 or 1 for binary; richer index for negRisk
  finalYesPriceCents: number | null;
  finalNoPriceCents: number | null;
  umaResolutionStatus: string | null;
}

export function classifyResolution(
  market: GammaMarket,
  previous: ResolutionView | null,
  nowUnix: number,
): ResolutionView {
  const yes = parseOutcomePriceCents(market, 0);
  const no = parseOutcomePriceCents(market, 1);

  const isClosed = market.closed === true || market.active === false;
  const hasAuthoritative =
    (yes === 100 && no === 0) ||
    (yes === 0 && no === 100);
  const umaOk =
    market.umaResolutionStatus == null ||
    market.umaResolutionStatus === 'resolved';

  if (isClosed && hasAuthoritative && umaOk) {
    return {
      status: 'resolved',
      closedAt: previous?.closedAt ?? nowUnix,
      resolvedAt: previous?.resolvedAt ?? nowUnix,
      winningOutcome: yes === 100 ? 'YES' : 'NO',
      winningOutcomeIndex: yes === 100 ? 0 : 1,
      finalYesPriceCents: yes,
      finalNoPriceCents: no,
      umaResolutionStatus: market.umaResolutionStatus ?? null,
    };
  }

  if (isClosed) {
    return {
      ...emptyOutcome(),
      status: 'closed',
      closedAt: previous?.closedAt ?? nowUnix,
      umaResolutionStatus: market.umaResolutionStatus ?? null,
    };
  }

  return { ...emptyOutcome(), status: 'tracking' };
}
```

`invalid` is only ever reached by the **disagreement detector** in the resolution scanner: if a market we previously stored as `resolved` now reports a different `winningOutcome`, we don't silently flip the truth — we mark it `invalid` and log loudly. This protects us from the (rare) UMA dispute that flips an outcome days after first resolution. Operators can then run the targeted re-materializer once they're confident.

### 5.2 Trade outcome states

```
   ┌──────┐
   │ open │ ─── market resolved with winning outcome ──┐
   └──────┘                                            │
                                                       ▼
                           winning outcome matches the trade's outcome and side?
                                                       │
                              ┌────────────────────────┼────────────────────────┐
                              ▼                        ▼                        ▼
                       resolved_win            resolved_loss               invalid
                       (terminal)              (terminal)                  (terminal)
```

Win/loss is computed from `(side, outcome, winningOutcome)`:

```typescript
// pipeline/classify_outcome.ts
export type TradeOutcomeStatus = 'open' | 'resolved_win' | 'resolved_loss' | 'invalid';

export function classifyOutcome(args: {
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  winningOutcome: 'YES' | 'NO' | null;
  resolutionStatus: MarketResolutionStatus;
}): TradeOutcomeStatus {
  if (args.resolutionStatus === 'invalid') return 'invalid';
  if (args.resolutionStatus !== 'resolved' || !args.winningOutcome) return 'open';

  const won = args.outcome === args.winningOutcome;

  // BUY: classic — bought YES, YES wins → win. Bought NO, YES wins → loss.
  // SELL: a sell of YES shares is effectively a closing/reducing trade against
  // the YES position. Win/loss for the SELL itself is the inverse of holding it
  // through resolution: selling YES before YES wins is a "miss" (would have done
  // better holding); selling YES before NO wins is a "save". This is the spec
  // contract for v1 — see §5.3 for SELL nuance.
  if (args.side === 'BUY') return won ? 'resolved_win' : 'resolved_loss';
  return won ? 'resolved_loss' : 'resolved_win';
}
```

### 5.3 SELL-side nuance

The user-facing pill on a SELL trade card should read `Closed` plus a `Sold` chip rather than `Win` or `Loss`. The `resolved_win|resolved_loss` value above is still useful for **trader-level scoring** (was selling at this price a good decision in hindsight?) but should not be projected as a green/red pill on the trade row itself.

The recommended UI mapping:

| trade.side | trade_outcome.status | UI badge |
|---|---|---|
| BUY | open | grey "Open" |
| BUY | resolved_win | green "Win" |
| BUY | resolved_loss | red "Loss" |
| BUY | invalid | grey "Invalid" |
| SELL | open | grey "Open · Sold" |
| SELL | resolved_win | grey "Closed · Good sell" *(optional, low-key)* |
| SELL | resolved_loss | grey "Closed · Early sell" *(optional, low-key)* |
| SELL | invalid | grey "Closed" |

This keeps the resolver's data model strict and lets the renderer decide how loud to be.

### 5.4 PnL semantics (per trade)

Per-trade realized PnL is meaningful for BUYs and approximated for SELLs:

```typescript
// BUY trade:
//   payoutUsd     = won ? shares : 0    // each winning share pays $1
//   pnlUsd        = payoutUsd - usdSize
//
// SELL trade:
//   payoutUsd     = usdSize             // proceeds; no further payout
//   pnlUsd        = null                // not computable without entry basis
```

We store `payoutUsd` and `pnlUsd` (nullable) on `trade_outcomes` so the API can render them. We do **not** attempt FIFO position matching across BUY+SELL pairs in this service — that was the explicit non-goal. Future work could layer a position-level PnL service on top of this same data.

---

## 6. The pipelines

Three loops, one queue. Each can be enabled/disabled independently via env flags.

### 6.1 Resolution scanner — every 60s base, priority-tiered

The scanner is the heart of the service. It picks a batch of `conditionId`s to check, calls `GET /markets?condition_ids=...` in chunks of ≤50, and upserts each result through `classifyResolution()`.

The batch is **priority-tiered** by what we know about each market:

| Tier | Selection criteria | Recheck cadence |
|---|---|---|
| **hot** | `endDate` within ±48h of now, OR last status='closed' (waiting on outcome) | every 60s |
| **warm** | a whale traded on this market in the last 24h | every 5min |
| **cold** | a whale traded on this market in the last 90d, market still `tracking` | every 30min |
| **frozen** | status='resolved' or 'invalid' | never (unless admin force-rebuild) |

The selection uses a `next_check_at` field on `market_resolutions`. The scanner pulls "the N markets where `next_check_at <= now`, sorted ascending", checks them, and bumps `next_check_at` based on the new tier classification.

```typescript
// pipeline/resolution_scanner.ts (sketch)
export async function runResolutionScan(deps: {
  resolutions: Collection<MarketResolutionDoc>;
  trades: Collection<EnrichedWhale>;
  redis: Redis;
}, now: number): Promise<ScanReport> {
  // 1. Discover any new markets we haven't tracked yet.
  await seedNewMarketsFromTrades(deps.trades, deps.resolutions, now);

  // 2. Pick batch of due markets, capped at PER_RUN_BATCH (e.g. 200).
  const due = await deps.resolutions.find(
    { nextCheckAt: { $lte: new Date(now * 1000) }, status: { $in: ['tracking','closed'] } },
    { sort: { nextCheckAt: 1 }, limit: PER_RUN_BATCH },
  ).toArray();

  // 3. Chunk into Gamma calls of <= 50 condition IDs.
  for (const chunk of chunked(due, 50)) {
    const fetched = await getMarketsByConditionIds(chunk.map(d => d._id));

    for (const prior of chunk) {
      const live = fetched.find(m => m.conditionId.toLowerCase() === prior._id.toLowerCase());
      if (!live) continue;  // Polymarket returned nothing for it; leave alone

      const next = classifyResolution(live, viewFromDoc(prior), now);
      const transitioned = prior.status !== next.status;
      const dispute = prior.status === 'resolved'
        && next.status === 'resolved'
        && prior.winningOutcome !== next.winningOutcome;

      const finalNext = dispute ? { ...next, status: 'invalid' as const } : next;

      await deps.resolutions.updateOne(
        { _id: prior._id },
        { $set: {
            ...projectViewToDoc(finalNext),
            slug: live.slug,
            title: live.title ?? prior.title,
            endDate: live.endDate ? new Date(live.endDate) : prior.endDate ?? null,
            negRisk: !!live.negRisk,
            clobTokenIds: live.clobTokenIds ?? prior.clobTokenIds ?? null,
            lastCheckedAt: new Date(now * 1000),
            checkCount: (prior.checkCount ?? 0) + 1,
            nextCheckAt: new Date((now + tierIntervalSec(finalNext, live, now)) * 1000),
        } },
      );

      if (transitioned && finalNext.status === 'resolved') {
        await deps.redis.publish(
          'market_resolutions',
          JSON.stringify({ type: 'resolved', conditionId: prior._id, ...finalNext }),
        );
        await enqueueMaterialization(deps.redis, prior._id);
      } else if (dispute) {
        log.error({ conditionId: prior._id, prior: prior.winningOutcome, live: next.winningOutcome },
          'market resolution disagreement; marked invalid');
        await enqueueMaterialization(deps.redis, prior._id);
      }
    }
    await sleep(150);  // be polite to Gamma
  }

  return { /* metrics */ };
}
```

Key invariants:

- **Idempotent**: rerunning the scan over the same markets is a no-op once they're frozen.
- **Self-healing**: if Gamma temporarily returns garbage for a market, we don't downgrade its status. We only ever advance.
- **Bounded fan-out**: the materialization queue is the only place that touches per-trade data, so the scanner can't melt Mongo.

### 6.2 Outcome materializer — Redis-queued, batched

When the scanner advances a market to `resolved` (or marks it `invalid`), it pushes the `conditionId` onto a Redis list `queue:trade_resolution:materialize`. A separate worker drains the queue:

```typescript
// pipeline/outcome_materializer.ts (sketch)
async function runMaterializer(deps: {
  trades: Collection<EnrichedWhale>;
  outcomes: Collection<TradeOutcomeDoc>;
  resolutions: Collection<MarketResolutionDoc>;
  redis: Redis;
}): Promise<void> {
  while (!shuttingDown) {
    const popped = await deps.redis.brpop('queue:trade_resolution:materialize', 5);
    if (!popped) continue;
    const conditionId = popped[1];

    const resolution = await deps.resolutions.findOne({ _id: conditionId });
    if (!resolution || resolution.status === 'tracking') continue;

    // Stream every trade on this market and write a frozen outcome row each.
    const cursor = deps.trades.find({ 'market.conditionId': conditionId });
    let batch: AnyBulkWriteOperation<TradeOutcomeDoc>[] = [];
    for await (const trade of cursor) {
      const status = classifyOutcome({
        side: trade.side,
        outcome: normalizeOutcome(trade.outcome),
        winningOutcome: resolution.winningOutcome,
        resolutionStatus: resolution.status,
      });
      const doc = projectTradeToOutcome(trade, resolution, status);
      batch.push({
        updateOne: {
          filter: { _id: trade._id, frozenAt: { $exists: false } },
          update: { $set: doc, $setOnInsert: { firstMaterializedAt: new Date() } },
          upsert: true,
        },
      });
      if (batch.length >= 500) {
        await deps.outcomes.bulkWrite(batch, { ordered: false });
        batch = [];
      }
    }
    if (batch.length) await deps.outcomes.bulkWrite(batch, { ordered: false });
  }
}
```

Two important details:

1. The filter `frozenAt: { $exists: false }` is what guarantees idempotency — once a trade outcome is frozen we never overwrite it. Reprocessing a queued conditionId after a restart is safe.
2. The `trades` collection has a 90-day TTL. If a trade has already TTL'd out, we miss its outcome forever (acceptable — that trade row is gone from the feed anyway). The seed backfill (§6.5) is what catches the existing 90-day window once at install time.

### 6.3 Trader outcome aggregator — every 5 min

The aggregator rolls resolved outcomes up to per-wallet stats:

```typescript
const cutoff = new Date(Date.now() - 365 * 86400 * 1000);  // last 365 days for win rate
const rows = await outcomes.aggregate([
  { $match: {
      side: 'BUY',
      status: { $in: ['resolved_win','resolved_loss'] },
      resolvedAt: { $gte: cutoff },
  } },
  { $group: {
      _id: '$proxyWallet',
      resolvedBuyCount: { $sum: 1 },
      resolvedWinCount: { $sum: { $cond: [{ $eq: ['$status','resolved_win'] }, 1, 0] } },
      resolvedLossCount: { $sum: { $cond: [{ $eq: ['$status','resolved_loss'] }, 1, 0] } },
      resolvedRealizedPnlUsd: { $sum: { $ifNull: ['$pnlUsd', 0] } },
      resolvedVolumeUsd: { $sum: '$usdSize' },
      lastResolvedAt: { $max: '$resolvedAt' },
  } },
]).toArray();

// Upsert each row, but only into the resolved* namespace — leave watcher's fields alone.
await Promise.all(rows.map(r => traders.updateOne(
  { _id: r._id },
  { $set: {
      resolvedBuyCount: r.resolvedBuyCount,
      resolvedWinCount: r.resolvedWinCount,
      resolvedLossCount: r.resolvedLossCount,
      resolvedWinRate: r.resolvedBuyCount > 0 ? r.resolvedWinCount / r.resolvedBuyCount : null,
      resolvedRealizedPnlUsd: r.resolvedRealizedPnlUsd,
      resolvedVolumeUsd: r.resolvedVolumeUsd,
      resolvedLastUpdatedAt: new Date(),
      resolvedLastResolvedAt: r.lastResolvedAt,
  } },
  { upsert: true },
)));
```

Why a separate namespace from the watcher's `winRate`: the watcher's `winRate` is computed from the live Polymarket positions endpoint and counts open + recently-closed positions where `pnl > 0`. Our `resolvedWinRate` is an apples-to-apples count of authoritatively-resolved BUY trades. Both numbers are useful but they're different statistics. Don't conflate them.

### 6.4 On-demand resolver hook (optional, recommended)

The API server's existing `GET /v1/whales/:id/detail` can call into a tiny Redis pubsub or HTTP hook on this service when a user requests a trade whose underlying market is `closed` or `tracking` near `endDate`. The hook just bumps that market's `nextCheckAt` to "now" so it gets picked up on the next scan tick.

Implement as an internal HTTP endpoint (no auth, only reachable from within Railway's private network):

```
POST /internal/poke
{ "conditionId": "0x..." }
→ 204 (next scan will pick it up)
```

Use the API server's existing rate-limiter to cap pokes at e.g. 30/min per IP so user traffic can't DoS this service.

### 6.5 One-shot seed backfill

A standalone script (`npm run backfill`) that runs once at deploy time and again on demand. It:

1. Aggregates `trades.market.conditionId` distinct over the entire collection.
2. Fetches each via Gamma in chunks.
3. Upserts `market_resolutions` with the current view.
4. For every market that classifies as `resolved`, enqueues materialization.
5. Drains the queue inline (synchronously, with the same materializer logic).
6. Exits 0 on completion.

Idempotent — running it twice is a no-op. Useful when re-pointing at a fresh DB or after a logic change.

---

## 7. MongoDB schema and indexes

Database: `polywatch` (same as watcher and API). Two new collections, plus additive fields on `traders`.

### 7.1 `market_resolutions` — 1 doc per market we've ever seen a whale on

```typescript
export interface MarketResolutionDoc {
  _id: string;                          // conditionId, lowercase
  slug: string;                         // mirrored from markets/trades for joins
  title: string;
  status: 'tracking' | 'closed' | 'resolved' | 'invalid';

  endDate: Date | null;                 // from Gamma
  closedAt: Date | null;                // first observation of closed=true
  resolvedAt: Date | null;              // first observation of authoritative outcome

  winningOutcome: 'YES' | 'NO' | null;
  winningOutcomeIndex: number | null;
  finalYesPriceCents: number | null;
  finalNoPriceCents: number | null;
  umaResolutionStatus: string | null;

  negRisk: boolean;                     // multi-outcome event flag
  clobTokenIds: string[] | null;        // per-outcome token IDs

  // operational
  lastCheckedAt: Date;
  checkCount: number;
  nextCheckAt: Date;
  lastError: string | null;

  createdAt: Date;
  updatedAt: Date;
}
```

Indexes:

```typescript
await marketResolutions.createIndexes([
  { key: { nextCheckAt: 1 } },                                  // scanner pull
  { key: { status: 1, nextCheckAt: 1 } },                       // tier-bounded pull
  { key: { status: 1, resolvedAt: -1 } },                       // recently-resolved feed
  { key: { slug: 1 } },                                         // diagnostic lookup
]);
```

No TTL. The whole collection bounded by "markets a whale has ever traded on", which is small (thousands at most over a year).

### 7.2 `trade_outcomes` — 1 doc per trade we've ever materialized

Same `_id` as `trades._id` so a single `findOne(_id)` joins them.

```typescript
export interface TradeOutcomeDoc {
  _id: string;                          // matches trades._id
  conditionId: string;
  proxyWallet: string;                  // lowercase
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  outcomeIndex: number;
  shares: number;
  usdSize: number;
  entryPriceCents: number;
  timestamp: number;                    // unix seconds, mirrored from trade

  status: 'open' | 'resolved_win' | 'resolved_loss' | 'invalid';

  winningOutcome: 'YES' | 'NO' | null;
  winningOutcomeIndex: number | null;
  payoutUsd: number | null;             // BUY: shares if win, 0 if loss; SELL: usdSize
  pnlUsd: number | null;                // BUY: payoutUsd - usdSize; SELL: null

  resolvedAt: Date | null;              // copy of market resolvedAt
  firstMaterializedAt: Date;
  frozenAt: Date | null;                // set when status leaves 'open'
}
```

Indexes:

```typescript
await tradeOutcomes.createIndexes([
  { key: { proxyWallet: 1, status: 1, resolvedAt: -1 } },       // trader profile rollup
  { key: { conditionId: 1 } },                                  // market re-materialize
  { key: { status: 1, resolvedAt: -1 } },                       // "recently resolved" feed
  { key: { timestamp: -1 } },                                   // generic time scan
  // No TTL: outcomes are valuable beyond the 90-day trade TTL.
]);
```

If size becomes a concern: a TTL of 2 years on `firstMaterializedAt` is reasonable, but stats degrade past that point so don't shorten further.

### 7.3 Additive fields on `traders` (owned by this service)

Only writes — never reads — these fields. Watcher-owned fields (`vol30d`, `winRate`, `tradeCount`, `totalPnl`, `pseudonym`, `displayName`, `profileImage`, `refreshedAt`) are untouched.

```typescript
{
  // ...existing watcher-owned fields...
  resolvedBuyCount?: number;
  resolvedWinCount?: number;
  resolvedLossCount?: number;
  resolvedWinRate?: number | null;        // 0..1
  resolvedRealizedPnlUsd?: number;
  resolvedVolumeUsd?: number;
  resolvedLastUpdatedAt?: Date;
  resolvedLastResolvedAt?: Date | null;
}
```

The aggregator does an `updateOne(..., { $set }, { upsert: true })` keyed on `_id = proxyWallet.toLowerCase()`. The traders repo in this service only sets these fields, never `$unset`s the watcher's.

### 7.4 Index ensuring

Mirror the watcher's pattern: `db/indexes.ts` has a single `ensureIndexes()` call at boot. Idempotent — Mongo treats createIndex on existing index as a no-op.

---

## 8. Redis pub/sub channel for live UI

Channel: `market_resolutions`. Payload (one per status transition):

```json
{
  "type": "resolved",
  "conditionId": "0x...",
  "slug": "will-bitcoin-hit-200k-by-end-of-2026",
  "winningOutcome": "YES",
  "resolvedAt": 1735689600,
  "finalYesPriceCents": 100,
  "finalNoPriceCents": 0
}
```

The API server subscribes alongside its existing `whales` subscription and broadcasts a `{type:"resolution_update", data:{...}}` frame to any connected WebSocket client. The website's existing reducer can update the open/closed pill on visible trade rows without a refetch.

Add a second channel `trade_outcomes` (optional, v2): once materialization completes for a market, publish a single batched event with the count of newly-frozen outcomes. The website can use this to re-fetch its visible feed if any of those rows are on screen.

---

## 9. Worker scheduling and Polymarket politeness

Default cadences (all configurable via env):

| Loop | Default | Notes |
|---|---|---|
| resolution scanner | every 30s, up to 200 markets per tick | the 30s wakeup is a no-op if no markets are due |
| materializer | continuous (BRPOP with 5s timeout) | drains queue as fast as Mongo will accept |
| trader aggregator | every 5min | reads outcomes only, very cheap |
| seed backfill | one-shot or `npm run backfill` | manual |

Polymarket Gamma rate-limit observations from the watcher:

- 50 condition IDs per `/markets` call is well within their tolerance.
- 100–150ms inter-call delay is what the watcher uses; we match that.
- Burst over 5 RPS → expect 429s. Use `p-retry` with exponential backoff (factor 2, max 60s) — same as `polymarket/client.ts` in the watcher.

Reuse the watcher's `polymarket/client.ts` patterns verbatim, ideally by copy with comment noting where it came from. (A shared `@polywatch/polymarket` workspace package would be cleaner long-term but is out of scope for v1.)

---

## 10. Edge cases to handle correctly

### 10.1 negRisk multi-outcome events

Events like "Who will win the 2028 Democratic primary?" have N candidate sub-markets, each binary. Polymarket marks the parent event with `negRisk: true` and resolves only one sub-market to YES while the rest resolve NO. The classifier already handles this correctly because each sub-market is a separate `conditionId` with its own binary outcome — we don't need any negRisk-specific logic, just to record the flag for diagnostics.

### 10.2 Multi-outcome single-market resolutions (very rare on Polymarket)

If `outcomes` has more than 2 entries, the resolver downgrades to:

```
status: 'invalid'
note: 'multi-outcome market not supported'
```

…and logs a warning. We're explicit about not supporting these in v1 because the win/loss collapse to a single bit doesn't apply.

### 10.3 UMA dispute

If `umaResolutionStatus === 'disputed'` and the market was previously `resolved`, we don't overwrite the existing `winningOutcome`. Instead we log loudly and emit a `dispute_observed` metric. Operators decide whether to mark it `invalid` manually.

### 10.4 Outcome flip after resolution

The disagreement detector in §6.1 transitions any flipped-outcome market to `invalid`. Trades on that market are re-materialized as `invalid`. We never overwrite a frozen `resolved_win` with `resolved_loss` silently.

### 10.5 Trade missing from `trades` (TTL'd out before resolution)

By design. The materializer iterates `trades` directly; if it's gone, no row is written. Trader stats remain correct because the outcome was never counted.

### 10.6 Whale flagged as discarded by intent classifier

The watcher's intent classifier already filters DECREASE/CLOSE intents into `intent_discards` rather than `trades`. Those trades never enter our pipeline. That's intentional — DECREASE/CLOSE trades are by definition not "open positions" and have no resolvable outcome.

### 10.7 Side-effects on watcher's `markets` collection

None. We don't touch it. Watcher continues to refresh its view of `markets` for "is this currently active and what are the current prices" — that's orthogonal to "is this market authoritatively resolved".

---

## 11. Configuration

`.env.example`:

```
NODE_ENV=production
LOG_LEVEL=info

# Polymarket — same shape as the watcher
POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com

# Mongo — same DB as watcher and API server
MONGO_URI=mongodb+srv://...
MONGO_DB=polywatch

# Redis — same broker as watcher and API server
REDIS_URL=redis://localhost:6379
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

# Feature flags (lets us roll out staged)
SCANNER_ENABLED=true
MATERIALIZER_ENABLED=true
TRADER_AGG_ENABLED=true
ON_DEMAND_HOOK_ENABLED=true
```

Validate at boot with zod and **fail fast** on missing/invalid values, exactly as the watcher does.

---

## 12. Health endpoint

Match the watcher's shape so it slots into the same observability dashboards:

```typescript
GET /health → 200/503
{
  ok: boolean,
  mongoConnected: boolean,
  redisConnected: boolean,
  scanner: {
    lastScanAt: number | null,
    lastScanAge: number,
    marketsCheckedTotal: number,
    statusTransitionsTotal: number,
    lastError: string | null,
  },
  materializer: {
    queueDepth: number,
    lastJobAt: number | null,
    outcomesWrittenTotal: number,
    lastError: string | null,
  },
  trader: {
    lastRunAt: number | null,
    rowsUpdated: number,
    lastError: string | null,
  }
}
```

Use the same `startHealthServer(port, getStatus)` pattern from `whale-watcher/src/http/health.ts`.

---

## 13. Observability

Same standards as the watcher and API server.

- **Pino** structured logs.
- **Sentry** for exceptions (`@sentry/node`).
- **Prometheus** metrics endpoint at `/metrics`:
  - `resolution_scans_total{result}` (counter)
  - `resolution_status_transitions_total{from,to}` (counter)
  - `outcomes_materialized_total{status}` (counter)
  - `materialize_queue_depth` (gauge)
  - `gamma_request_duration_ms` (histogram)
  - `gamma_request_errors_total{code}` (counter)
- **Alerts**:
  - Health endpoint failing for 2min → page.
  - Scanner has not advanced in 5min during US market hours → warn.
  - Materializer queue depth > 1000 → warn (suggests a stuck consumer).
  - Any `dispute_observed` log → notify on slack/email.

---

## 14. API server changes (separate work item, summarized here)

These belong in the `whaleserver` repo, not this one. They're the consumer side of the data we produce.

### 14.1 New repo: `outcomes_repo.ts`

Helpers:

```typescript
export async function getOutcomesByTradeIds(ids: string[]): Promise<Map<string, TradeOutcomeDoc>>;
export async function getResolutionByConditionId(id: string): Promise<MarketResolutionDoc | null>;
export async function getRecentResolved(limit: number): Promise<MarketResolutionDoc[]>;
```

### 14.2 Whale DTO extension

Add an optional `outcome` block to `WhaleDto`:

```typescript
interface WhaleDto {
  // ...existing fields...
  outcome?: {
    status: 'open' | 'resolved_win' | 'resolved_loss' | 'invalid';
    winningOutcome: 'YES' | 'NO' | null;
    payoutUsd: number | null;
    pnlUsd: number | null;
    resolvedAt: number | null;       // unix seconds for client friendliness
    closed: boolean;                 // convenience: status !== 'open'
  };
}
```

The feed endpoint should batch-fetch outcomes for the page (50 trades → 1 Mongo `find({_id:{$in:[...]}})`) and merge into the DTOs. Same on the trade detail and trader profile endpoints.

### 14.3 Trader DTO extension

```typescript
interface TraderDto {
  // ...existing fields (vol30d, winRate, tradeCount, lastActiveAt)...
  resolved?: {
    buyCount: number;
    winCount: number;
    lossCount: number;
    winRate: number | null;
    realizedPnlUsd: number;
    volumeUsd: number;
    lastUpdatedAt: Date;
    lastResolvedAt: Date | null;
  };
}
```

The two `winRate`s on the same DTO need clear labeling in the UI. Label the existing `winRate` as "Polymarket positions (live)" and the new `resolved.winRate` as "Resolved markets (locked)".

### 14.4 WebSocket extension

The WS hub in `api-server/src/ws/hub.ts` already broadcasts `whale` events. Add a second message type:

```json
{ "type": "resolution_update", "data": { /* ResolutionEvent payload from §8 */ } }
```

Broadcast to all connected clients (no per-filter matching needed — the website decides whether the conditionId is on a row it's currently rendering).

---

## 15. Frontend changes (separate work, summarized here)

These belong in `D:\polywatch-website` and the Flutter app.

### 15.1 Website (`src/App.jsx`)

- `TradeRow`: render an `OutcomePill` reading from `trade.outcome.status`. Map per the table in §5.3.
- `TradeDetailPage`: show resolution date, winning outcome, payoutUsd, and pnlUsd in the existing `scenario` card area when `trade.outcome.status !== 'open'`.
- `TraderProfilePage`: under the existing "Daily Volume" card, add a "Resolved performance" block using `trader.resolved.{winRate,winCount,lossCount,realizedPnlUsd}`.
- `WhaleFeedPage`: subscribe to the new `resolution_update` WS event and update the visible row's pill in place, no refetch.

### 15.2 Flutter app

Same UI primitives, mapped to its existing widgets. Implementation belongs in the app repo, but the DTO contract from §14 should not change between platforms.

---

## 16. Deployment

### 16.1 Dockerfile

```dockerfile
FROM node:22-slim AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

### 16.2 Railway

`railway.json`:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "NIXPACKS", "buildCommand": "npm ci && npm run build" },
  "deploy": { "startCommand": "npm start", "restartPolicyType": "ON_FAILURE" }
}
```

Service name: `trade-resolver`. Singleton (`replicas: 1`). 512 MB memory, 0.5 vCPU. Bind to the same MongoDB and Redis services as the watcher and API server.

### 16.3 Graceful shutdown

```typescript
process.on('SIGTERM', async () => {
  if (shuttingDown) return; shuttingDown = true;
  await scanner.stop({ timeout: 10_000 });
  await materializer.stop({ timeout: 10_000 });
  await Promise.all([closeMongo(), closeRedis()]);
  healthServer?.close();
  process.exit(0);
});
```

Mirror the watcher's shutdown pattern verbatim.

---

## 17. Testing

- **Unit tests** (vitest, target >85% coverage on `pipeline/`):
  - `classifyResolution()` — every state transition: tracking → closed → resolved, tracking → resolved (skipped closed), resolved → resolved (idempotent), resolved → invalid (disagreement).
  - `classifyOutcome()` — full truth table over (BUY/SELL × YES/NO × YES_WIN/NO_WIN/null/invalid).
  - `tierIntervalSec()` — hot/warm/cold selection.

- **Integration tests** with a real local Mongo + Redis:
  - Insert fixture trades + a fixture Gamma response → run scanner once → assert `market_resolutions` and `trade_outcomes` both have correct rows.
  - Simulate a resolution flip → assert the disagreement detector marks it `invalid` and re-materializes.
  - Verify `frozenAt` guard: re-running materializer on an already-frozen trade is a no-op.

- **End-to-end smoke test** in a staging DB:
  - Take a known historical market (e.g. one BTC price market that has resolved) and verify status='resolved', winningOutcome correct, and a sample of its trades all have correct status.

---

## 18. Rollout phases

Treat this as a phased deploy so we never serve a half-baked outcome on the website.

**Phase 0 — schema and seed**

1. Deploy the resolver service with `MATERIALIZER_ENABLED=false` and `TRADER_AGG_ENABLED=false`.
2. Run `npm run backfill` against staging then production.
3. Verify `market_resolutions` has plausible counts (most old markets resolved, recent ones tracking/closed).

**Phase 1 — materialize, no UI**

1. Flip `MATERIALIZER_ENABLED=true`.
2. Verify `trade_outcomes` populates and `frozenAt` is being set.
3. Phase 2 doesn't begin until `trade_outcomes` count is within 5% of `trades` count for resolved markets.

**Phase 2 — API joins, no broadcast**

1. Deploy API server changes from §14 with a feature flag (`OUTCOMES_IN_DTO=true`).
2. Verify whale endpoints include `outcome` for resolved trades.

**Phase 3 — frontend**

1. Ship the `OutcomePill` and trader profile resolved block on the website.
2. Smoke test: open a recently resolved market's trade detail and confirm pill shows correct color.

**Phase 4 — live broadcast**

1. Flip `RESOLUTION_BROADCAST=true`.
2. Verify the website updates pills in place when a market resolves while the page is open.

**Phase 5 — Flutter**

1. Ship the pill in the Flutter app once the contract has been stable on the web for ~1 week.

---

## 19. v1 launch checklist

- [ ] Resolver runs for 24 hours with no crashes.
- [ ] `market_resolutions` count matches distinct `trades.market.conditionId` count within 1%.
- [ ] At least one observed `tracking → closed → resolved` transition end-to-end.
- [ ] Disagreement detector exercised in staging (force a flip) and produced `invalid`.
- [ ] Materializer queue stays below 100 deep under steady-state load.
- [ ] Trader aggregator runs in <30s end-to-end.
- [ ] Health endpoint correctly reports 503 during a forced Mongo disconnect.
- [ ] Website shows correct pill on a known resolved trade.
- [ ] Sentry has captured at least one test exception.
- [ ] Graceful shutdown drains the queue and exits cleanly.

When all boxes are ticked, the resolver is production-ready.

---

## 20. Open questions / future work

- **Position-level realized PnL via FIFO matching.** This v1 does market-level only. A v2 service could read `trades` chronologically per `(proxyWallet, conditionId, outcome)`, match BUYs to SELLs FIFO, and produce per-lot realized PnL. That's strictly more accurate for trader stats but a much larger engineering project. Build only if the simple win-rate ends up materially misleading users.
- **On-chain UMA OptimisticOracle confirmation.** Highest-trust source for resolution outcomes. Worth adding as a parallel signal once we have RPC budget. Cross-check against Gamma; if they disagree, prefer on-chain and flag the discrepancy.
- **Public API endpoints.** Right now this service is internal-only. If a partner needs raw resolution data, exposing `GET /v1/resolutions` from the API server (not from this service directly) is the right shape.
- **Multi-outcome market support.** The `outcomeIndex` field in `trade_outcomes` is already general enough to extend to 3+ outcomes. The classifier just needs to drop the YES/NO assumption when `outcomes.length > 2`.
- **Outcome history per market.** If we ever want a "this market flipped twice" timeline visible to users, we'd need to log every state transition (small append-only `market_resolution_events` collection) instead of just storing the latest view. Defer until we see it happen more than once.

---

## 21. Caution for future agents

- Preserve the watcher's existing fields on `traders`. Only `$set` keys that start with `resolved` (or, if you must, namespace under a sub-document `traders.resolved`).
- Never `$unset` or recompute a frozen `trade_outcomes` row. The whole point is preserving the outcome at the moment of resolution.
- Don't bypass the materialization queue with synchronous fan-out from the scanner. The queue is what keeps the scanner cheap and the materializer's blast radius bounded.
- Keep this service as the **single writer** to `market_resolutions` and `trade_outcomes`. If you ever want the API server to write to these (e.g. for a manual override), put it behind a `POST /internal/...` call into this service, not a direct DB write — single-writer rules make rollback cleaner.
- Don't reshape the API server's existing `WhaleDto` — only add the optional `outcome` block. Old clients should tolerate missing fields.
