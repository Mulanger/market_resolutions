/**
 * resolution_scanner — periodic market scan loop
 *
 * Heart of the trade-resolver. Implements spec §6.1:
 *   1. Discover new conditionIds in `trades` that we haven't tracked yet → seed.
 *   2. Pick the batch of markets whose `nextCheckAt <= now` (capped at PER_RUN_BATCH).
 *   3. Chunk into Gamma /markets calls of ≤ 50 IDs each (150ms inter-call delay).
 *   4. For each market:
 *        - Run classifyResolution(live, prior, now)
 *        - If prior was 'resolved' but new winningOutcome differs → mark 'invalid'
 *          (disagreement detector, never silently overwrite an outcome)
 *        - Upsert into market_resolutions with the new view + nextCheckAt
 *        - On 'tracking|closed → resolved' transition: enqueueMaterialization()
 *          and publishResolutionEvent() (broadcast is feature-flag-gated)
 *        - On 'invalid' (disagreement): enqueue rematerialization, log loudly
 *   5. Returns a ScanReport for the health endpoint.
 *
 * Invariants:
 *   - Idempotent: rerunning over the same markets is a no-op once frozen.
 *   - Self-healing: if Gamma returns garbage, we never downgrade the stored status.
 *   - Bounded fan-out: only the materializer queue touches per-trade data.
 */
import type { Collection } from 'mongodb';
import { getLogger } from '../logger.js';
import type {
  MarketResolutionDoc,
  MarketResolutionStatus,
} from '../db/outcomes.js';
import type { EnrichedWhaleMinimal } from '../db/mongo.js';
import {
  findDueMarkets,
  findAllTrackedIds,
  seedMarketResolution,
  updateMarketResolution,
} from '../db/repos/resolutions_repo.js';
import { fetchMarketsBatched } from '../polymarket/client.js';
import type { GammaMarket } from '../polymarket/schemas.js';
import {
  classifyResolution,
  type ResolutionView,
} from './classify_resolution.js';
import { enqueueMaterialization } from '../redis/queue.js';
import {
  publishResolutionEvent,
  type ResolutionEvent,
} from '../redis/publisher.js';
import { loadConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanReport {
  checked: number;
  transitions: number;
  seeded: number;
  errors: number;
  resolvedThisRun: number;
  invalidThisRun: number;
}

export interface RunResolutionScanDeps {
  marketResolutions: Collection<MarketResolutionDoc>;
  trades: Collection<EnrichedWhaleMinimal>;
}

// ---------------------------------------------------------------------------
// Tier intervals
// ---------------------------------------------------------------------------

/** Sentinel for "do not re-check"; ~10 years. */
const FROZEN_INTERVAL_SEC = 365 * 86_400 * 10;

/** Subset of the runtime config needed to pick a recheck interval. */
export interface TierConfig {
  hotRecheckSec: number;
  warmRecheckSec: number;
  coldRecheckSec: number;
}

/**
 * Decide how many seconds to wait before re-checking this market.
 * Frozen states (resolved/invalid) get a near-infinite interval so they
 * effectively drop off the scanner's radar (admin force-rebuild bypasses this).
 *
 * Heuristic (matches spec §6.1 with a small simplification —
 *   trade-recency tiers fall out of endDate proximity in practice):
 *   - status frozen           → never
 *   - status closed           → hot (every HOT_RECHECK_SEC)
 *   - endDate within ±48h     → hot
 *   - endDate within ±7 days  → warm
 *   - else (tracking, far end) → cold
 */
export function tierIntervalSec(
  view: ResolutionView,
  market: GammaMarket | null,
  nowUnix: number,
  config: TierConfig = loadConfig(),
): number {
  if (view.status === 'resolved' || view.status === 'invalid') {
    return FROZEN_INTERVAL_SEC;
  }
  if (view.status === 'closed') {
    return config.hotRecheckSec;
  }

  // tracking
  const endDateIso = market?.endDate ?? null;
  if (endDateIso) {
    const endUnix = Math.floor(new Date(endDateIso).getTime() / 1000);
    if (Number.isFinite(endUnix)) {
      const distance = Math.abs(endUnix - nowUnix);
      const TWO_DAYS = 2 * 86_400;
      const SEVEN_DAYS = 7 * 86_400;
      if (distance <= TWO_DAYS) return config.hotRecheckSec;
      if (distance <= SEVEN_DAYS) return config.warmRecheckSec;
    }
  }
  return config.coldRecheckSec;
}

// ---------------------------------------------------------------------------
// Seed: discover new markets from the trades collection
// ---------------------------------------------------------------------------

/**
 * Scan `trades` for conditionIds we haven't started tracking yet, and insert
 * a `tracking` doc with a near-immediate nextCheckAt so the scanner picks
 * them up on its next tick.
 *
 * Returns the count of newly-seeded markets.
 */
export async function seedNewMarketsFromTrades(
  trades: Collection<EnrichedWhaleMinimal>,
  marketResolutions: Collection<MarketResolutionDoc>,
  nowUnix: number,
): Promise<number> {
  const log = getLogger();

  // Pull every conditionId we already track, to compute the diff in memory.
  // This collection is small (thousands at most), so this is cheap.
  const tracked = await findAllTrackedIds(marketResolutions);

  // Aggregate distinct conditionIds (with metadata) from trades.
  // Use $first so we don't need to scan every trade — Mongo can use the index
  // on `market.conditionId` (assumed to exist on the watcher side).
  const distinct = await trades
    .aggregate<{
      _id: string;
      slug: string;
      title: string;
    }>([
      {
        $group: {
          _id: '$market.conditionId',
          slug: { $first: '$market.slug' },
          title: { $first: '$market.title' },
        },
      },
    ])
    .toArray();

  const nowDate = new Date(nowUnix * 1000);
  let seeded = 0;

  for (const d of distinct) {
    const id = d._id?.toLowerCase();
    if (!id) continue;
    if (tracked.has(id)) continue;

    const doc: MarketResolutionDoc = {
      _id: id,
      slug: d.slug ?? id,
      title: d.title ?? d.slug ?? id,
      status: 'tracking',

      endDate: null,
      closedAt: null,
      resolvedAt: null,

      winningOutcome: null,
      winningOutcomeIndex: null,
      finalYesPriceCents: null,
      finalNoPriceCents: null,
      umaResolutionStatus: null,

      negRisk: false,
      clobTokenIds: null,

      lastCheckedAt: nowDate,
      checkCount: 0,
      // Schedule for "right now" so the scanner picks it up on its next tick.
      nextCheckAt: nowDate,
      lastError: null,

      createdAt: nowDate,
      updatedAt: nowDate,
    };

    try {
      await seedMarketResolution(marketResolutions, doc);
      seeded++;
    } catch (err) {
      log.warn(
        { conditionId: id, err: String(err) },
        'failed to seed market_resolutions row',
      );
    }
  }

  if (seeded > 0) {
    log.info({ seeded, totalDistinct: distinct.length }, 'seeded new markets');
  }
  return seeded;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function viewFromDoc(doc: MarketResolutionDoc): ResolutionView {
  return {
    status: doc.status,
    closedAt: doc.closedAt ? Math.floor(doc.closedAt.getTime() / 1000) : null,
    resolvedAt: doc.resolvedAt
      ? Math.floor(doc.resolvedAt.getTime() / 1000)
      : null,
    winningOutcome: doc.winningOutcome,
    winningOutcomeIndex: doc.winningOutcomeIndex,
    finalYesPriceCents: doc.finalYesPriceCents,
    finalNoPriceCents: doc.finalNoPriceCents,
    umaResolutionStatus: doc.umaResolutionStatus,
  };
}

function projectViewToDoc(view: ResolutionView): Partial<MarketResolutionDoc> {
  return {
    status: view.status,
    closedAt: view.closedAt ? new Date(view.closedAt * 1000) : null,
    resolvedAt: view.resolvedAt ? new Date(view.resolvedAt * 1000) : null,
    winningOutcome: view.winningOutcome,
    winningOutcomeIndex: view.winningOutcomeIndex,
    finalYesPriceCents: view.finalYesPriceCents,
    finalNoPriceCents: view.finalNoPriceCents,
    umaResolutionStatus: view.umaResolutionStatus,
  };
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

/**
 * Run one pass of the resolution scanner.
 *
 * @param deps  Mongo collections owned/read by this service
 * @param now   Optional unix-seconds override (for tests)
 */
export async function runResolutionScan(
  deps: RunResolutionScanDeps,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ScanReport> {
  const log = getLogger();
  const config = loadConfig();
  const nowDate = new Date(now * 1000);

  const report: ScanReport = {
    checked: 0,
    transitions: 0,
    seeded: 0,
    errors: 0,
    resolvedThisRun: 0,
    invalidThisRun: 0,
  };

  // 1) Discover any new markets we haven't tracked yet.
  try {
    report.seeded = await seedNewMarketsFromTrades(
      deps.trades,
      deps.marketResolutions,
      now,
    );
  } catch (err) {
    log.error({ err }, 'seedNewMarketsFromTrades failed');
    report.errors++;
  }

  // 2) Pull due markets, capped at PER_RUN_BATCH.
  const due = await findDueMarkets(
    deps.marketResolutions,
    nowDate,
    config.scanPerRunBatch,
  );

  if (due.length === 0) {
    return report;
  }

  // 3) Chunk into Gamma calls.
  const conditionIds = due.map((d) => d._id);
  let fetched: GammaMarket[] = [];
  try {
    fetched = await fetchMarketsBatched(conditionIds, 50);
  } catch (err) {
    log.error({ err, count: conditionIds.length }, 'Gamma fetch failed');
    report.errors++;
    return report;
  }

  // Index the fetched markets by lowercase conditionId for O(1) lookup.
  const byId = new Map<string, GammaMarket>();
  for (const m of fetched) {
    byId.set(m.conditionId.toLowerCase(), m);
  }

  // 4) Per-market classification, upsert, and (on transition) enqueue.
  for (const prior of due) {
    const live = byId.get(prior._id);
    if (!live) {
      // Gamma returned nothing for this conditionId. Push the next check out
      // by the cold interval and move on (do NOT downgrade).
      try {
        await updateMarketResolution(deps.marketResolutions, prior._id, {
          lastCheckedAt: nowDate,
          checkCount: (prior.checkCount ?? 0) + 1,
          nextCheckAt: new Date((now + config.coldRecheckSec) * 1000),
          lastError: 'gamma: no result',
        });
      } catch (err) {
        log.warn({ err, conditionId: prior._id }, 'failed to bump nextCheckAt');
      }
      continue;
    }

    let next: ResolutionView;
    try {
      next = classifyResolution(live, viewFromDoc(prior), now);
    } catch (err) {
      log.error({ err, conditionId: prior._id }, 'classifier crashed');
      report.errors++;
      continue;
    }

    const transitioned = prior.status !== next.status;
    const dispute =
      prior.status === 'resolved' &&
      next.status === 'resolved' &&
      prior.winningOutcome !== null &&
      next.winningOutcome !== null &&
      prior.winningOutcome !== next.winningOutcome;

    const finalNext: ResolutionView = dispute
      ? {
          ...next,
          status: 'invalid' satisfies MarketResolutionStatus,
        }
      : next;

    try {
      await updateMarketResolution(deps.marketResolutions, prior._id, {
        ...projectViewToDoc(finalNext),
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
    } catch (err) {
      log.error(
        { err, conditionId: prior._id },
        'failed to update market_resolutions',
      );
      report.errors++;
      continue;
    }

    report.checked++;
    if (transitioned) report.transitions++;

    // Side effects on transitions
    if (dispute) {
      log.error(
        {
          conditionId: prior._id,
          priorOutcome: prior.winningOutcome,
          liveOutcome: next.winningOutcome,
        },
        'market resolution disagreement; marked invalid',
      );
      report.invalidThisRun++;
      try {
        await enqueueMaterialization(prior._id);
      } catch (err) {
        log.error(
          { err, conditionId: prior._id },
          'failed to enqueue rematerialization after dispute',
        );
        report.errors++;
      }
      try {
        const event: ResolutionEvent = {
          type: 'invalid',
          conditionId: prior._id,
          slug: live.slug ?? prior.slug,
          winningOutcome: null,
          resolvedAt: finalNext.resolvedAt,
          finalYesPriceCents: finalNext.finalYesPriceCents,
          finalNoPriceCents: finalNext.finalNoPriceCents,
        };
        await publishResolutionEvent(event);
      } catch (err) {
        log.warn({ err, conditionId: prior._id }, 'publish invalid event failed');
      }
    } else if (transitioned && finalNext.status === 'resolved') {
      report.resolvedThisRun++;
      try {
        await enqueueMaterialization(prior._id);
      } catch (err) {
        log.error(
          { err, conditionId: prior._id },
          'failed to enqueue materialization on resolve',
        );
        report.errors++;
      }
      try {
        const event: ResolutionEvent = {
          type: 'resolved',
          conditionId: prior._id,
          slug: live.slug ?? prior.slug,
          winningOutcome: finalNext.winningOutcome,
          resolvedAt: finalNext.resolvedAt,
          finalYesPriceCents: finalNext.finalYesPriceCents,
          finalNoPriceCents: finalNext.finalNoPriceCents,
        };
        await publishResolutionEvent(event);
      } catch (err) {
        log.warn(
          { err, conditionId: prior._id },
          'publish resolved event failed',
        );
      }
    } else if (
      transitioned &&
      finalNext.status === 'invalid' &&
      prior.status !== 'invalid'
    ) {
      // Reaching invalid via classifier (multi-outcome markets etc.) — also
      // worth a re-materialize so any prior outcomes flip to invalid.
      report.invalidThisRun++;
      try {
        await enqueueMaterialization(prior._id);
      } catch (err) {
        log.error(
          { err, conditionId: prior._id },
          'failed to enqueue rematerialization for invalid',
        );
        report.errors++;
      }
    }
  }

  log.info(
    {
      checked: report.checked,
      transitions: report.transitions,
      resolved: report.resolvedThisRun,
      invalid: report.invalidThisRun,
      seeded: report.seeded,
      errors: report.errors,
    },
    'resolution scan complete',
  );

  return report;
}
