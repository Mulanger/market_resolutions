/**
 * Polymarket Gamma API client for the resolution tracker.
 *
 * Pattern copied from whale-watcher/src/polymarket/client.ts:
 *   - undici Agent with keep-alive
 *   - p-retry with exponential backoff (factor 2, max 60s)
 *   - 429 / 5xx → RetriableError, 4xx → AbortError
 *   - Chunk batches at ≤50 conditionIds; sleep 150ms between calls (Gamma etiquette)
 */
import { request, Agent } from 'undici';
import { z } from 'zod';
import pRetry, { AbortError } from 'p-retry';
import { loadConfig } from '../config.js';
import { getLogger } from '../logger.js';
import {
  GammaMarketSchema,
  GammaEventSchema,
  type GammaMarket,
  type GammaEvent,
} from './schemas.js';

const agent = new Agent({ keepAliveTimeout: 30_000, connections: 10 });

class RetriableError extends Error {}

// ---------------------------------------------------------------------------
// Generic GET helper (same shape as whale-watcher)
// ---------------------------------------------------------------------------

async function get<T>(
  baseUrl: string,
  path: string,
  query: Record<string, unknown>,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }

  return pRetry(
    async () => {
      const res = await request(url, { dispatcher: agent, method: 'GET' });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        throw new RetriableError(`status ${res.statusCode}`);
      }
      if (res.statusCode >= 400) {
        throw new AbortError(
          `status ${res.statusCode}: ${await res.body.text()}`,
        );
      }
      const json = await res.body.json();
      return schema.parse(json);
    },
    { retries: 5, factor: 2, minTimeout: 1000, maxTimeout: 60_000 },
  );
}

// ---------------------------------------------------------------------------
// Gamma-specific helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch up to 50 markets by conditionId in a single Gamma call.
 * Caller is responsible for chunking larger batches (see fetchMarketsBatched).
 */
export async function getMarketsByConditionIds(
  conditionIds: string[],
): Promise<GammaMarket[]> {
  const config = loadConfig();
  const csv = conditionIds.join(',');
  return get(
    config.polymarketGammaUrl,
    '/markets',
    { condition_ids: csv },
    GammaMarketSchema.array(),
  );
}

/**
 * Fetch all markets for the given conditionIds, chunked at ≤50 per call
 * with 150ms inter-call delay (Gamma rate-limit etiquette).
 */
export async function fetchMarketsBatched(
  conditionIds: string[],
  chunkSize = 50,
): Promise<GammaMarket[]> {
  const log = getLogger();
  const results: GammaMarket[] = [];

  for (let i = 0; i < conditionIds.length; i += chunkSize) {
    const chunk = conditionIds.slice(i, i + chunkSize);
    log.debug({ count: chunk.length, offset: i }, 'fetching Gamma market chunk');
    const markets = await getMarketsByConditionIds(chunk);
    results.push(...markets);
    if (i + chunkSize < conditionIds.length) {
      await sleep(150); // be polite to Gamma (5 RPS burst max)
    }
  }

  return results;
}

/**
 * Fallback: fetch a Gamma event by eventId (used when /markets returns nothing
 * for a conditionId — rare but happens for very old markets).
 */
export async function getEvent(eventId: string): Promise<GammaEvent> {
  const config = loadConfig();
  return get(
    config.polymarketGammaUrl,
    `/events/${eventId}`,
    {},
    GammaEventSchema,
  );
}
