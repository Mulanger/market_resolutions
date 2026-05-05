/**
 * traders_repo — additive upsert of traders.resolved* fields.
 *
 * SINGLE-WRITER CONTRACT:
 * This service only writes the `resolved*` namespace of the traders collection.
 * It must NEVER $unset, $set, or otherwise touch the watcher-owned fields:
 *   vol30d, winRate, tradeCount, totalPnl, pseudonym, displayName,
 *   profileImage, refreshedAt
 *
 * Uses $set keyed exclusively on resolved* fields + { upsert: true } so a
 * trader doc that doesn't exist yet gets created with only our fields.
 */
import type { Collection } from 'mongodb';
import type { TraderDoc } from '../mongo.js';
import type { TraderResolvedFields } from '../outcomes.js';

export interface TraderAggRow {
  proxyWallet: string;
  resolvedBuyCount: number;
  resolvedWinCount: number;
  resolvedLossCount: number;
  resolvedRealizedPnlUsd: number;
  resolvedVolumeUsd: number;
  lastResolvedAt: Date | null;
}

/**
 * Upsert resolved stats for a batch of traders.
 * Only touches the resolved* namespace — watcher fields are untouched.
 */
export async function upsertTraderResolvedStats(
  col: Collection<TraderDoc>,
  rows: TraderAggRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const now = new Date();
  let updated = 0;

  await Promise.all(
    rows.map(async (r) => {
      const winRate =
        r.resolvedBuyCount > 0 ? r.resolvedWinCount / r.resolvedBuyCount : null;

      const fields: TraderResolvedFields = {
        resolvedBuyCount: r.resolvedBuyCount,
        resolvedWinCount: r.resolvedWinCount,
        resolvedLossCount: r.resolvedLossCount,
        resolvedWinRate: winRate,
        resolvedRealizedPnlUsd: r.resolvedRealizedPnlUsd,
        resolvedVolumeUsd: r.resolvedVolumeUsd,
        resolvedLastUpdatedAt: now,
        resolvedLastResolvedAt: r.lastResolvedAt,
      };

      const result = await col.updateOne(
        { _id: r.proxyWallet.toLowerCase() },
        { $set: fields },
        { upsert: true },
      );

      updated += result.modifiedCount + result.upsertedCount;
    }),
  );

  return updated;
}
