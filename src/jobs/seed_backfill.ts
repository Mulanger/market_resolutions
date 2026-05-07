/**
 * seed_backfill — one-shot backfill of all historical trades
 *
 * Run via:  npm run backfill
 *
 * Implements spec §6.5:
 *   1. Aggregate distinct trades.market.conditionId over the full collection.
 *   2. Fetch each from Gamma in chunks of ≤ 50 (fetchMarketsBatched).
 *   3. Upsert market_resolutions with the current view for every market.
 *   4. For markets that classify as 'resolved' or 'invalid', enqueue + drain
 *      materialization inline (no async worker, no broadcast — backfill mode).
 *   5. Exit 0 on completion.
 *
 * Idempotent — running twice is a no-op:
 *   - market_resolutions: insertOne with E11000 catch on the seed step,
 *     then updateOne advances state monotonically.
 *   - trade_outcomes: bulk-upsert filter `frozenAt: { $exists: false }`
 *     means already-frozen rows are not overwritten.
 */
import { loadConfig } from '../config.js';
import { getLogger } from '../logger.js';
import { connectMongo, closeMongo } from '../db/mongo.js';
import { ensureIndexes } from '../db/indexes.js';
import { fetchMarketsBatched } from '../polymarket/client.js';
import { classifyResolution, type ResolutionView } from '../pipeline/classify_resolution.js';
import {
  seedNewMarketsFromTrades,
  tierIntervalSec,
} from '../pipeline/resolution_scanner.js';
import { materializeOutcomesForMarket } from '../pipeline/outcome_materializer.js';
import {
  findResolutionById,
  updateMarketResolution,
} from '../db/repos/resolutions_repo.js';
import type { MarketResolutionDoc } from '../db/outcomes.js';

function viewFromDoc(doc: MarketResolutionDoc): ResolutionView {
  return {
    status: doc.status,
    closedAt: doc.closedAt ? Math.floor(doc.closedAt.getTime() / 1000) : null,
    resolvedAt: doc.resolvedAt ? Math.floor(doc.resolvedAt.getTime() / 1000) : null,
    winningOutcome: doc.winningOutcome,
    winningOutcomeIndex: doc.winningOutcomeIndex,
    finalYesPriceCents: doc.finalYesPriceCents,
    finalNoPriceCents: doc.finalNoPriceCents,
    umaResolutionStatus: doc.umaResolutionStatus,
  };
}

async function main(): Promise<void> {
  const log = getLogger();
  const config = loadConfig();

  log.info({ env: config.nodeEnv }, 'Starting seed_backfill...');

  const { marketResolutions, tradeOutcomes, trades } = await connectMongo();
  await ensureIndexes(marketResolutions, tradeOutcomes);

  const now = Math.floor(Date.now() / 1000);
  const nowDate = new Date(now * 1000);

  // ---- 1. Seed new tracking docs from trades ----------------------------
  const seeded = await seedNewMarketsFromTrades(
    trades,
    marketResolutions,
    now,
  );
  log.info({ seeded }, 'seed step complete');

  // ---- 2. Pull every market we know about and refresh from Gamma --------
  const allTracked = await marketResolutions.find({}).toArray();
  log.info({ count: allTracked.length }, 'fetching Gamma for all tracked markets');

  const conditionIds = allTracked.map((d) => d._id);
  const fetched = await fetchMarketsBatched(conditionIds, 50);
  const byId = new Map(
    fetched.map((m) => [m.conditionId.toLowerCase(), m] as const),
  );

  let resolved = 0;
  let invalid = 0;
  let stillTracking = 0;
  let stillClosed = 0;
  let materializedTotal = 0;

  // ---- 3. Classify every one and upsert ---------------------------------
  for (const prior of allTracked) {
    const live = byId.get(prior._id);
    if (!live) {
      log.debug({ conditionId: prior._id }, 'no Gamma result; skipping');
      continue;
    }

    const next = classifyResolution(live, viewFromDoc(prior), now);
    const dispute =
      prior.status === 'resolved' &&
      next.status === 'resolved' &&
      prior.winningOutcome !== null &&
      next.winningOutcome !== null &&
      prior.winningOutcome !== next.winningOutcome;

    const finalNext: ResolutionView = dispute
      ? { ...next, status: 'invalid' }
      : next;

    await updateMarketResolution(marketResolutions, prior._id, {
      status: finalNext.status,
      closedAt: finalNext.closedAt ? new Date(finalNext.closedAt * 1000) : null,
      resolvedAt: finalNext.resolvedAt ? new Date(finalNext.resolvedAt * 1000) : null,
      winningOutcome: finalNext.winningOutcome,
      winningOutcomeIndex: finalNext.winningOutcomeIndex,
      finalYesPriceCents: finalNext.finalYesPriceCents,
      finalNoPriceCents: finalNext.finalNoPriceCents,
      umaResolutionStatus: finalNext.umaResolutionStatus,
      slug: live.slug ?? prior.slug,
      title: live.title ?? prior.title,
      endDate: live.endDate ? new Date(live.endDate) : prior.endDate,
      negRisk: !!live.negRisk,
      clobTokenIds: live.clobTokenIds ?? prior.clobTokenIds,
      lastCheckedAt: nowDate,
      checkCount: (prior.checkCount ?? 0) + 1,
      nextCheckAt: new Date(
        (now + tierIntervalSec(finalNext, live, now, config)) * 1000,
      ),
      lastError: null,
    });

    if (finalNext.status === 'resolved') resolved++;
    else if (finalNext.status === 'invalid') invalid++;
    else if (finalNext.status === 'closed') stillClosed++;
    else stillTracking++;

    // ---- 4. Materialize inline if frozen ------------------------------
    if (finalNext.status === 'resolved' || finalNext.status === 'invalid') {
      try {
        // Re-read the doc so the materializer sees the freshly-written state.
        const updated = await findResolutionById(marketResolutions, prior._id);
        if (!updated) continue;
        const written = await materializeOutcomesForMarket(
          { tradeOutcomes, marketResolutions, trades },
          updated._id,
        );
        materializedTotal += written;
      } catch (err) {
        log.error(
          { err, conditionId: prior._id },
          'inline materialization failed during backfill',
        );
      }
    }
  }

  log.info(
    {
      total: allTracked.length,
      seeded,
      resolved,
      invalid,
      stillClosed,
      stillTracking,
      materialized: materializedTotal,
    },
    'seed_backfill complete',
  );

  await closeMongo();
  process.exit(0);
}

main().catch((err) => {
  console.error('seed_backfill failed:', err);
  process.exit(1);
});
