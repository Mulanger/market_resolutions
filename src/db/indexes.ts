import type { Collection } from 'mongodb';
import type { MarketResolutionDoc, TradeOutcomeDoc } from './outcomes.js';
import { getLogger } from '../logger.js';

/**
 * Idempotent index creation for the two collections owned by trade-resolver.
 * MongoDB treats createIndex on an existing identical index as a no-op.
 * Called once at boot before the loops start.
 */
export async function ensureIndexes(
  marketResolutions: Collection<MarketResolutionDoc>,
  tradeOutcomes: Collection<TradeOutcomeDoc>,
): Promise<void> {
  const log = getLogger();
  log.info('Ensuring indexes...');

  // market_resolutions — scanner pull and diagnostic lookups
  await marketResolutions.createIndexes([
    { key: { nextCheckAt: 1 } },                   // scanner: due markets
    { key: { status: 1, nextCheckAt: 1 } },         // tier-bounded scanner pull
    { key: { status: 1, resolvedAt: -1 } },         // recently-resolved feed
    { key: { slug: 1 } },                           // diagnostic lookup by slug
  ]);

  // trade_outcomes — trader aggregation, re-materialisation, and feeds
  await tradeOutcomes.createIndexes([
    { key: { proxyWallet: 1, status: 1, resolvedAt: -1 } }, // trader profile rollup
    { key: { conditionId: 1 } },                             // re-materialise by market
    { key: { status: 1, resolvedAt: -1 } },                  // recently-resolved feed
    { key: { timestamp: -1 } },                              // generic time scan
  ]);

  log.info('Indexes ensured');
}
