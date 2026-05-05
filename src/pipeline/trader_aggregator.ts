/**
 * trader_aggregator — roll up resolved outcomes into traders.resolved* fields
 *
 * Implements spec §6.3:
 *   1. Aggregate trade_outcomes per proxyWallet for BUY trades whose status is
 *      resolved_win or resolved_loss within the last 365 days.
 *   2. Compute counts, realized PnL sum, volume sum, and lastResolvedAt.
 *   3. Upsert into the `traders` collection via traders_repo, which only
 *      $sets the resolved* namespace (single-writer rules — see §7.3).
 *
 * Critical:
 *   - Only writes to the resolved* fields on traders. Watcher-owned fields
 *     (vol30d, winRate, tradeCount, totalPnl, pseudonym, displayName,
 *      profileImage, refreshedAt) are NEVER touched.
 *   - resolvedWinRate is computed as winCount / buyCount (NOT volume-weighted).
 */
import type { Collection } from 'mongodb';
import { getLogger } from '../logger.js';
import type { TradeOutcomeDoc } from '../db/outcomes.js';
import type { TraderDoc } from '../db/mongo.js';
import {
  upsertTraderResolvedStats,
  type TraderAggRow,
} from '../db/repos/traders_repo.js';

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const LOOKBACK_DAYS = 365;

interface AggGroupRow {
  _id: string;
  resolvedBuyCount: number;
  resolvedWinCount: number;
  resolvedLossCount: number;
  resolvedRealizedPnlUsd: number;
  resolvedVolumeUsd: number;
  lastResolvedAt: Date | null;
}

export interface TraderAggregatorDeps {
  tradeOutcomes: Collection<TradeOutcomeDoc>;
  traders: Collection<TraderDoc>;
}

/**
 * One pass of the trader aggregator. Returns the number of trader rows updated.
 */
export async function runTraderAggregator(
  deps: TraderAggregatorDeps,
): Promise<number> {
  const log = getLogger();
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400 * 1000);

  const rows = await deps.tradeOutcomes
    .aggregate<AggGroupRow>([
      {
        $match: {
          side: 'BUY',
          status: { $in: ['resolved_win', 'resolved_loss'] },
          resolvedAt: { $gte: cutoff },
        },
      },
      {
        $group: {
          _id: '$proxyWallet',
          resolvedBuyCount: { $sum: 1 },
          resolvedWinCount: {
            $sum: { $cond: [{ $eq: ['$status', 'resolved_win'] }, 1, 0] },
          },
          resolvedLossCount: {
            $sum: { $cond: [{ $eq: ['$status', 'resolved_loss'] }, 1, 0] },
          },
          resolvedRealizedPnlUsd: {
            $sum: { $ifNull: ['$pnlUsd', 0] },
          },
          resolvedVolumeUsd: { $sum: '$usdSize' },
          lastResolvedAt: { $max: '$resolvedAt' },
        },
      },
    ])
    .toArray();

  if (rows.length === 0) {
    log.debug('trader aggregator: no resolved BUY trades in lookback');
    return 0;
  }

  const aggRows: TraderAggRow[] = rows.map((r) => ({
    proxyWallet: r._id,
    resolvedBuyCount: r.resolvedBuyCount,
    resolvedWinCount: r.resolvedWinCount,
    resolvedLossCount: r.resolvedLossCount,
    resolvedRealizedPnlUsd: r.resolvedRealizedPnlUsd,
    resolvedVolumeUsd: r.resolvedVolumeUsd,
    lastResolvedAt: r.lastResolvedAt ?? null,
  }));

  const updated = await upsertTraderResolvedStats(deps.traders, aggRows);

  log.info(
    { wallets: rows.length, updated, lookbackDays: LOOKBACK_DAYS },
    'trader aggregator complete',
  );
  return updated;
}
