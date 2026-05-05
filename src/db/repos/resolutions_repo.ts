/**
 * resolutions_repo — CRUD helpers for the market_resolutions collection.
 *
 * Single-writer: only trade-resolver writes to this collection.
 */
import type { Collection, Filter } from 'mongodb';
import type { MarketResolutionDoc, MarketResolutionStatus } from '../outcomes.js';

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function findResolutionById(
  col: Collection<MarketResolutionDoc>,
  conditionId: string,
): Promise<MarketResolutionDoc | null> {
  return col.findOne({ _id: conditionId.toLowerCase() });
}

export async function findDueMarkets(
  col: Collection<MarketResolutionDoc>,
  nowDate: Date,
  limit: number,
): Promise<MarketResolutionDoc[]> {
  const filter: Filter<MarketResolutionDoc> = {
    nextCheckAt: { $lte: nowDate },
    status: { $in: ['tracking', 'closed'] as MarketResolutionStatus[] },
  };
  return col
    .find(filter, { sort: { nextCheckAt: 1 }, limit })
    .toArray();
}

/** Returns condition IDs already tracked so we can skip them during seed. */
export async function findAllTrackedIds(
  col: Collection<MarketResolutionDoc>,
): Promise<Set<string>> {
  const docs = await col.find({}, { projection: { _id: 1 } }).toArray();
  return new Set(docs.map((d) => d._id));
}

export async function countByStatus(
  col: Collection<MarketResolutionDoc>,
): Promise<Record<string, number>> {
  const rows = await col
    .aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])
    .toArray();
  return Object.fromEntries(rows.map((r) => [r._id, r.count]));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Insert a new tracking doc for a market we haven't seen before.
 * Uses insertOne with ignoreDuplicates semantics via try/catch on E11000.
 */
export async function seedMarketResolution(
  col: Collection<MarketResolutionDoc>,
  doc: MarketResolutionDoc,
): Promise<void> {
  try {
    await col.insertOne(doc as MarketResolutionDoc & { _id: string });
  } catch (err: unknown) {
    // Duplicate key — another race won; that's fine
    if ((err as { code?: number }).code === 11000) return;
    throw err;
  }
}

/**
 * Atomically update a market_resolutions doc after classifying its new state.
 */
export async function updateMarketResolution(
  col: Collection<MarketResolutionDoc>,
  conditionId: string,
  update: Partial<MarketResolutionDoc>,
): Promise<void> {
  await col.updateOne(
    { _id: conditionId.toLowerCase() },
    { $set: { ...update, updatedAt: new Date() } },
  );
}
