/**
 * outcome_materializer — Redis-queued per-trade fan-out
 *
 * Drains conditionIds from queue:trade_resolution:materialize. For each one:
 *   1. Look up the market_resolutions doc.
 *   2. Stream every trade in the trades collection for that conditionId.
 *   3. classifyOutcome() → computePnl() → build TradeOutcomeDoc.
 *   4. Bulk-upsert via bulkUpsertOutcomes(); the frozenAt $exists:false filter
 *      provides the load-bearing idempotency guarantee.
 *
 * Spec §6.2 invariants:
 *   - frozenAt: { $exists: false } in the upsert filter. Once a trade outcome
 *     is frozen we never overwrite it. Reprocessing on restart is safe.
 *   - The trades collection has a 90-day TTL. If a trade is gone before its
 *     market resolves, no outcome row is written. That's acceptable — the
 *     trade row is also gone from the feed.
 *   - Batch writes in chunks of 500 to bound memory.
 */
import type { Collection } from 'mongodb';
import { getLogger } from '../logger.js';
import type {
  MarketResolutionDoc,
  TradeOutcomeDoc,
  TradeOutcomeStatus,
} from '../db/outcomes.js';
import type { EnrichedWhaleMinimal } from '../db/mongo.js';
import {
  classifyOutcome,
  computePnl,
  normalizeOutcome,
} from './classify_outcome.js';
import { findResolutionById } from '../db/repos/resolutions_repo.js';
import { bulkUpsertOutcomes } from '../db/repos/outcomes_repo.js';
import { dequeueMaterialization } from '../redis/queue.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaterializerDeps {
  tradeOutcomes: Collection<TradeOutcomeDoc>;
  marketResolutions: Collection<MarketResolutionDoc>;
  trades: Collection<EnrichedWhaleMinimal>;
}

export interface MaterializerCallbacks {
  onJobComplete?(args: {
    conditionId: string;
    outcomesWritten: number;
    durationMs: number;
  }): void;
  onError?(err: unknown): void;
  /** Polled to gracefully stop the loop. */
  isShuttingDown?(): boolean;
}

const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Build a TradeOutcomeDoc from a trade + resolution
// ---------------------------------------------------------------------------

export function projectTradeToOutcome(
  trade: EnrichedWhaleMinimal,
  resolution: MarketResolutionDoc,
): TradeOutcomeDoc {
  const outcome = normalizeOutcome(trade.outcome);
  const status: TradeOutcomeStatus = classifyOutcome({
    side: trade.side,
    outcome,
    winningOutcome: resolution.winningOutcome,
    resolutionStatus: resolution.status,
  });

  const { payoutUsd, pnlUsd } = computePnl({
    status,
    side: trade.side,
    shares: trade.shares,
    usdSize: trade.usdSize,
  });

  // outcomeIndex: 0 = YES, 1 = NO (binary v1).
  const outcomeIndex = outcome === 'YES' ? 0 : 1;

  // frozenAt is set whenever status leaves 'open'. Once set, the bulk-upsert
  // filter `frozenAt: { $exists: false }` makes the write a no-op forever.
  const frozenAt: Date | null =
    status === 'open' ? null : new Date();

  return {
    _id: trade._id,
    conditionId: resolution._id,
    proxyWallet: trade.trader.proxyWallet.toLowerCase(),
    side: trade.side,
    outcome,
    outcomeIndex,
    shares: trade.shares,
    usdSize: trade.usdSize,
    entryPriceCents: trade.priceCents,
    timestamp: trade.timestamp,

    status,

    winningOutcome: resolution.winningOutcome,
    winningOutcomeIndex: resolution.winningOutcomeIndex,
    payoutUsd,
    pnlUsd,

    resolvedAt: resolution.resolvedAt,
    // firstMaterializedAt is set via $setOnInsert in the repo; reads from a
    // freshly-built doc will see this placeholder, but it's never persisted
    // because we don't $set it (the repo only $setOnInserts it).
    firstMaterializedAt: new Date(),
    frozenAt,
  };
}

// ---------------------------------------------------------------------------
// Materialize a single market
// ---------------------------------------------------------------------------

/**
 * Stream all trades for a conditionId and write a frozen outcome row each.
 *
 * Returns the number of outcome rows attempted (not all may have been
 * inserted, e.g. due to existing frozenAt — the repo handles that).
 */
export async function materializeOutcomesForMarket(
  deps: MaterializerDeps,
  conditionId: string,
): Promise<number> {
  const log = getLogger();
  const id = conditionId.toLowerCase();

  const resolution = await findResolutionById(deps.marketResolutions, id);
  if (!resolution) {
    log.warn({ conditionId: id }, 'no market_resolutions row; skipping');
    return 0;
  }

  if (resolution.status === 'tracking') {
    // Nothing to materialize yet — we only enqueue on resolved/invalid.
    log.debug(
      { conditionId: id },
      'market still tracking; skipping materialization',
    );
    return 0;
  }

  let attempted = 0;
  let batch: TradeOutcomeDoc[] = [];

  // Project only the fields we need for outcome creation.
  const cursor = deps.trades.find(
    { 'market.conditionId': id },
    {
      projection: {
        _id: 1,
        side: 1,
        outcome: 1,
        usdSize: 1,
        shares: 1,
        priceCents: 1,
        timestamp: 1,
        ingestedAt: 1,
        'market.conditionId': 1,
        'market.slug': 1,
        'market.title': 1,
        'trader.proxyWallet': 1,
      },
    },
  );

  for await (const trade of cursor) {
    let doc: TradeOutcomeDoc;
    try {
      doc = projectTradeToOutcome(trade, resolution);
    } catch (err) {
      log.warn(
        { err, tradeId: trade._id, conditionId: id },
        'projectTradeToOutcome failed',
      );
      continue;
    }
    batch.push(doc);
    attempted++;

    if (batch.length >= BATCH_SIZE) {
      try {
        await bulkUpsertOutcomes(deps.tradeOutcomes, batch);
      } catch (err) {
        log.error({ err, conditionId: id, batch: batch.length }, 'bulk upsert failed');
      }
      batch = [];
    }
  }

  if (batch.length > 0) {
    try {
      await bulkUpsertOutcomes(deps.tradeOutcomes, batch);
    } catch (err) {
      log.error(
        { err, conditionId: id, batch: batch.length },
        'final bulk upsert failed',
      );
    }
  }

  log.info(
    {
      conditionId: id,
      status: resolution.status,
      winningOutcome: resolution.winningOutcome,
      attempted,
    },
    'materialization complete',
  );
  return attempted;
}

// ---------------------------------------------------------------------------
// BRPOP loop
// ---------------------------------------------------------------------------

/**
 * Long-running loop. Drains the materialize queue with BRPOP and processes
 * one conditionId at a time. Calls callbacks on completion or error.
 *
 * Returns when isShuttingDown() returns true and the in-flight job (if any)
 * has finished.
 */
export async function runMaterializerLoop(
  deps: MaterializerDeps,
  callbacks: MaterializerCallbacks = {},
): Promise<void> {
  const log = getLogger();
  const isShuttingDown = callbacks.isShuttingDown ?? (() => false);

  while (!isShuttingDown()) {
    let conditionId: string | null = null;
    try {
      conditionId = await dequeueMaterialization(5);
    } catch (err) {
      log.error({ err }, 'dequeueMaterialization failed');
      callbacks.onError?.(err);
      // Avoid hot-spinning on a broken Redis
      await sleep(1_000);
      continue;
    }

    if (!conditionId) continue;

    const start = Date.now();
    try {
      const written = await materializeOutcomesForMarket(deps, conditionId);
      callbacks.onJobComplete?.({
        conditionId,
        outcomesWritten: written,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      log.error(
        { err, conditionId },
        'materializeOutcomesForMarket threw; will be retried on next enqueue',
      );
      callbacks.onError?.(err);
      // Brief backoff to avoid hammering on a persistent failure mode.
      await sleep(500);
    }
  }
  log.info('materializer loop exiting');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-export for the caller (index.ts) to read defaults if needed.
export const MATERIALIZER_BATCH_SIZE = BATCH_SIZE;
