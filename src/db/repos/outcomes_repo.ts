/**
 * outcomes_repo — CRUD helpers for the trade_outcomes collection.
 *
 * Single-writer: only trade-resolver writes to this collection.
 * The key invariant: frozenAt: { $exists: false } in the upsert filter
 * guarantees idempotency — once frozen we never overwrite.
 */
import type {
  Collection,
  AnyBulkWriteOperation,
  Filter,
} from 'mongodb';
import type { TradeOutcomeDoc } from '../outcomes.js';

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function findOutcomeById(
  col: Collection<TradeOutcomeDoc>,
  tradeId: string,
): Promise<TradeOutcomeDoc | null> {
  return col.findOne({ _id: tradeId });
}

export async function findOutcomesByTradeIds(
  col: Collection<TradeOutcomeDoc>,
  ids: string[],
): Promise<Map<string, TradeOutcomeDoc>> {
  const docs = await col.find({ _id: { $in: ids } }).toArray();
  return new Map(docs.map((d) => [d._id, d]));
}

export async function findOutcomesByConditionId(
  col: Collection<TradeOutcomeDoc>,
  conditionId: string,
): Promise<TradeOutcomeDoc[]> {
  return col.find({ conditionId }).toArray();
}

export async function countOutcomes(
  col: Collection<TradeOutcomeDoc>,
): Promise<number> {
  return col.estimatedDocumentCount();
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Bulk-upsert a batch of outcome docs.
 *
 * Idempotency guard: filter is `frozenAt: { $exists: false }` so once a trade
 * outcome is frozen we never overwrite it.
 *
 * `firstMaterializedAt` is split out so it appears only in `$setOnInsert`
 * (MongoDB rejects updates that mention the same field in both `$set` and
 * `$setOnInsert`).
 */
export async function bulkUpsertOutcomes(
  col: Collection<TradeOutcomeDoc>,
  docs: TradeOutcomeDoc[],
): Promise<number> {
  if (docs.length === 0) return 0;

  const ops: AnyBulkWriteOperation<TradeOutcomeDoc>[] = docs.map((doc) => {
    // Strip firstMaterializedAt from the $set payload — it is owned by
    // $setOnInsert. We use the value already on `doc` if provided, otherwise now.
    const { firstMaterializedAt, ...rest } = doc;
    const insertedAt = firstMaterializedAt ?? new Date();
    return {
      updateOne: {
        filter: {
          _id: doc._id,
          frozenAt: { $exists: false },
        } as Filter<TradeOutcomeDoc>,
        update: {
          $set: rest as Partial<TradeOutcomeDoc>,
          $setOnInsert: {
            firstMaterializedAt: insertedAt,
          } as Partial<TradeOutcomeDoc>,
        },
        upsert: true,
      },
    };
  });

  const result = await col.bulkWrite(ops, { ordered: false });
  return result.upsertedCount + result.modifiedCount;
}

