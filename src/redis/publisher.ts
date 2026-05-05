/**
 * Redis connection + pub/sub publisher for the market_resolutions channel.
 *
 * Pattern: identical to whale-watcher/src/redis/publisher.ts — one shared
 * ioredis instance, lazy-connected, reconnects on error.
 */
import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { getLogger } from '../logger.js';

let _redis: Redis | null = null;

export async function connectRedis(): Promise<Redis> {
  if (_redis) return _redis;

  const config = loadConfig();
  const log = getLogger();

  log.info('Connecting to Redis...');
  _redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    reconnectOnError: () => true,
  });

  await _redis.connect();
  log.info('Redis connected');

  return _redis;
}

export async function getRedis(): Promise<Redis> {
  return connectRedis();
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
    getLogger().info('Redis connection closed');
  }
}

export function isRedisConnected(): boolean {
  return _redis !== null && _redis.status === 'ready';
}

// ---------------------------------------------------------------------------
// Resolution event publisher
// ---------------------------------------------------------------------------

export interface ResolutionEvent {
  type: 'resolved' | 'invalid';
  conditionId: string;
  slug: string;
  winningOutcome: 'YES' | 'NO' | null;
  resolvedAt: number | null; // unix seconds
  finalYesPriceCents: number | null;
  finalNoPriceCents: number | null;
}

/**
 * Publish a market resolution event to the market_resolutions Redis channel.
 * The API server subscribes and broadcasts a resolution_update WS frame.
 */
export async function publishResolutionEvent(event: ResolutionEvent): Promise<void> {
  const config = loadConfig();
  if (!config.resolutionBroadcast) return; // feature-flagged

  const redis = await connectRedis();
  await redis.publish(config.resolutionChannel, JSON.stringify(event));
}
