/**
 * trade-resolver — main entry point
 *
 * Boot order (mirrors whale-watcher/src/index.ts):
 *   1. Load + validate config (fail fast on missing env)
 *   2. Connect Mongo → ensure indexes
 *   3. Connect Redis
 *   4. Start loops (gated by feature flags)
 *   5. Start health server
 *
 * Graceful shutdown on SIGTERM/SIGINT:
 *   - Set shuttingDown flag (loops check it)
 *   - Stop all loops
 *   - Close Mongo + Redis
 *   - Close health server
 *   - Exit 0
 */
import { loadConfig } from './config.js';
import { getLogger } from './logger.js';
import { connectMongo, closeMongo, isMongoConnected } from './db/mongo.js';
import { ensureIndexes } from './db/indexes.js';
import { connectRedis, closeRedis, isRedisConnected } from './redis/publisher.js';
import { queueDepth } from './redis/queue.js';
import { startHealthServer } from './http/health.js';
import type {
  ScannerHealthStatus,
  MaterializerHealthStatus,
  TraderAggHealthStatus,
} from './http/health.js';
import { runResolutionScan } from './pipeline/resolution_scanner.js';
import { runMaterializerLoop } from './pipeline/outcome_materializer.js';
import { runTraderAggregator } from './pipeline/trader_aggregator.js';

// ---------------------------------------------------------------------------
// Module-level state (mirrors watcher's pattern)
// ---------------------------------------------------------------------------

let shuttingDown = false;
let healthServer: ReturnType<typeof startHealthServer> | null = null;

// Loop handles
let scannerInterval: ReturnType<typeof setInterval> | null = null;
let traderAggInterval: ReturnType<typeof setInterval> | null = null;
let materializerLoop: Promise<void> | null = null;

// In-memory stats fed into the health endpoint
const scannerStats: ScannerHealthStatus = {
  lastScanAt: null,
  lastScanAge: Infinity,
  marketsCheckedTotal: 0,
  statusTransitionsTotal: 0,
  lastError: null,
};

const materializerStats: MaterializerHealthStatus = {
  queueDepth: 0,
  lastJobAt: null,
  outcomesWrittenTotal: 0,
  lastError: null,
};

const traderAggStats: TraderAggHealthStatus = {
  lastRunAt: null,
  rowsUpdated: 0,
  lastError: null,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const log = getLogger();

  log.info({ nodeEnv: config.nodeEnv }, 'Starting trade-resolver...');

  // --- Database ---
  const { marketResolutions, tradeOutcomes, trades, traders } =
    await connectMongo();
  await ensureIndexes(marketResolutions, tradeOutcomes);

  // --- Redis ---
  await connectRedis();

  // --- Scanner loop (feature-flagged) ---
  if (config.scannerEnabled) {
    log.info(
      { intervalMs: config.scanIntervalMs, batch: config.scanPerRunBatch },
      'Scanner enabled — starting loop',
    );

    const tick = async (): Promise<void> => {
      if (shuttingDown) return;
      try {
        const report = await runResolutionScan({
          marketResolutions,
          trades,
        });
        scannerStats.lastScanAt = Date.now();
        scannerStats.marketsCheckedTotal += report.checked;
        scannerStats.statusTransitionsTotal += report.transitions;
        scannerStats.lastError = report.errors > 0 ? `${report.errors} error(s) this tick` : null;
      } catch (err) {
        log.error({ err }, 'scanner tick failed');
        scannerStats.lastError = err instanceof Error ? err.message : String(err);
      }
    };

    // Run once at startup so we don't wait the full interval before the first scan.
    void tick();
    scannerInterval = setInterval(() => void tick(), config.scanIntervalMs);
  } else {
    log.info('Scanner disabled (SCANNER_ENABLED=false)');
  }

  // --- Materializer loop (feature-flagged, runs as an async background task) ---
  if (config.materializerEnabled) {
    log.info('Materializer enabled — starting BRPOP loop');

    materializerLoop = runMaterializerLoop(
      { tradeOutcomes, marketResolutions, trades },
      {
        isShuttingDown: () => shuttingDown,
        onJobComplete: ({ outcomesWritten }) => {
          materializerStats.outcomesWrittenTotal += outcomesWritten;
          materializerStats.lastJobAt = Date.now();
          materializerStats.lastError = null;
        },
        onError: (err) => {
          materializerStats.lastError =
            err instanceof Error ? err.message : String(err);
        },
      },
    );
  } else {
    log.info('Materializer disabled (MATERIALIZER_ENABLED=false)');
  }

  // --- Trader aggregator loop (feature-flagged) ---
  if (config.traderAggEnabled) {
    log.info(
      { intervalMs: config.traderAggIntervalMs },
      'Trader aggregator enabled — starting loop',
    );

    const tick = async (): Promise<void> => {
      if (shuttingDown) return;
      try {
        const updated = await runTraderAggregator({ tradeOutcomes, traders });
        traderAggStats.rowsUpdated = updated;
        traderAggStats.lastRunAt = Date.now();
        traderAggStats.lastError = null;
      } catch (err) {
        log.error({ err }, 'trader aggregator tick failed');
        traderAggStats.lastError = err instanceof Error ? err.message : String(err);
      }
    };

    // First run immediately, then on interval.
    void tick();
    traderAggInterval = setInterval(() => void tick(), config.traderAggIntervalMs);
  } else {
    log.info('Trader aggregator disabled (TRADER_AGG_ENABLED=false)');
  }

  // --- Health server ---
  healthServer = startHealthServer(config.healthPort, () => {
    // Update queue depth snapshot on each health check (best-effort)
    void queueDepth()
      .then((d) => {
        materializerStats.queueDepth = d;
      })
      .catch(() => {
        // Swallow — Redis may be momentarily unavailable; status reflects that.
      });

    return {
      mongoConnected: isMongoConnected(),
      redisConnected: isRedisConnected(),
      scanner: scannerStats,
      materializer: materializerStats,
      trader: traderAggStats,
    };
  });

  log.info({ port: config.healthPort }, 'trade-resolver started successfully');
}

// ---------------------------------------------------------------------------
// Graceful shutdown (mirrors whale-watcher pattern)
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const log = getLogger();
  log.info({ signal }, 'Shutting down...');

  if (scannerInterval) clearInterval(scannerInterval);
  if (traderAggInterval) clearInterval(traderAggInterval);

  // Materializer loop checks isShuttingDown() once per BRPOP timeout (5s).
  // Wait up to 10s for it to drain its current job and exit cleanly.
  if (materializerLoop) {
    await Promise.race([
      materializerLoop,
      new Promise<void>((r) => setTimeout(r, 10_000)),
    ]);
  }

  await Promise.all([closeMongo(), closeRedis()]);

  if (healthServer) healthServer.close();

  log.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
