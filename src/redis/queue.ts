/**
 * Work queue for the trade resolution materializer.
 *
 * The scanner pushes conditionIds onto a Redis list (LPUSH).
 * The materializer drains it with BRPOP (blocking pop, 5s timeout).
 *
 * This decouples the scanner (cheap, market-level) from the materializer
 * (per-trade fan-out) and bounds blast radius on restarts.
 */
import { getLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { getRedis } from './publisher.js';

/**
 * Push a conditionId onto the materialisation queue.
 * Called by the scanner when a market transitions to resolved or invalid.
 */
export async function enqueueMaterialization(conditionId: string): Promise<void> {
  const config = loadConfig();
  const redis = await getRedis();
  await redis.lpush(config.materializeQueue, conditionId.toLowerCase());
  getLogger().debug({ conditionId }, 'enqueued for materialisation');
}

/**
 * Blocking pop — waits up to timeoutSec seconds for a conditionId.
 * Returns null on timeout (normal steady-state with empty queue).
 */
export async function dequeueMaterialization(
  timeoutSec = 5,
): Promise<string | null> {
  const config = loadConfig();
  const redis = await getRedis();
  const result = await redis.brpop(config.materializeQueue, timeoutSec);
  return result ? result[1] : null;
}

/**
 * Current queue depth — used by the health endpoint.
 */
export async function queueDepth(): Promise<number> {
  const config = loadConfig();
  const redis = await getRedis();
  return redis.llen(config.materializeQueue);
}
