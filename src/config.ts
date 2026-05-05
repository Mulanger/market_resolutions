import { z } from 'zod';

const ConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),

  // Polymarket
  polymarketGammaUrl: z.string().url(),

  // MongoDB
  mongoUri: z.string().min(1),
  mongoDb: z.string().min(1),

  // Redis
  redisUrl: z.string().min(1),
  resolutionChannel: z.string().min(1),
  materializeQueue: z.string().min(1),

  // Loop cadences
  scanIntervalMs: z.number().int().positive(),
  scanPerRunBatch: z.number().int().positive(),
  hotRecheckSec: z.number().int().positive(),
  warmRecheckSec: z.number().int().positive(),
  coldRecheckSec: z.number().int().positive(),
  traderAggIntervalMs: z.number().int().positive(),

  // Health
  healthPort: z.number().int().positive(),

  // Feature flags
  scannerEnabled: z.boolean(),
  materializerEnabled: z.boolean(),
  traderAggEnabled: z.boolean(),
  onDemandHookEnabled: z.boolean(),
  resolutionBroadcast: z.boolean(),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const raw = {
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',

    polymarketGammaUrl:
      process.env['POLYMARKET_GAMMA_URL'] ?? 'https://gamma-api.polymarket.com',

    mongoUri: process.env['MONGO_URI'] ?? '',
    mongoDb: process.env['MONGO_DB'] ?? 'polywatch',

    redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    resolutionChannel: process.env['RESOLUTION_CHANNEL'] ?? 'market_resolutions',
    materializeQueue:
      process.env['MATERIALIZE_QUEUE'] ?? 'queue:trade_resolution:materialize',

    scanIntervalMs: parseInt(process.env['SCAN_INTERVAL_MS'] ?? '30000', 10),
    scanPerRunBatch: parseInt(process.env['SCAN_PER_RUN_BATCH'] ?? '200', 10),
    hotRecheckSec: parseInt(process.env['HOT_RECHECK_SEC'] ?? '60', 10),
    warmRecheckSec: parseInt(process.env['WARM_RECHECK_SEC'] ?? '300', 10),
    coldRecheckSec: parseInt(process.env['COLD_RECHECK_SEC'] ?? '1800', 10),
    traderAggIntervalMs: parseInt(process.env['TRADER_AGG_INTERVAL_MS'] ?? '300000', 10),

    healthPort: parseInt(process.env['HEALTH_PORT'] ?? '8080', 10),

    scannerEnabled: (process.env['SCANNER_ENABLED'] ?? 'true') === 'true',
    materializerEnabled: (process.env['MATERIALIZER_ENABLED'] ?? 'false') === 'true',
    traderAggEnabled: (process.env['TRADER_AGG_ENABLED'] ?? 'false') === 'true',
    onDemandHookEnabled: (process.env['ON_DEMAND_HOOK_ENABLED'] ?? 'false') === 'true',
    resolutionBroadcast: (process.env['RESOLUTION_BROADCAST'] ?? 'false') === 'true',
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config: ${result.error.message}`);
  }

  _config = result.data;
  return _config;
}
