/**
 * Health server for the trade-resolver service.
 *
 * Pattern copied from whale-watcher/src/http/health.ts.
 * GET /health → 200 (ok) or 503 (degraded) with a structured JSON body.
 *
 * The spec (§12) defines the expected response shape — it must slot into the
 * same Railway observability dashboards as the watcher and API server.
 */
import { createServer } from 'node:http';

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

export interface ScannerHealthStatus {
  lastScanAt: number | null;
  lastScanAge: number;
  marketsCheckedTotal: number;
  statusTransitionsTotal: number;
  lastError: string | null;
}

export interface MaterializerHealthStatus {
  queueDepth: number;
  lastJobAt: number | null;
  outcomesWrittenTotal: number;
  lastError: string | null;
}

export interface TraderAggHealthStatus {
  lastRunAt: number | null;
  rowsUpdated: number;
  lastError: string | null;
}

export interface ResolverHealthStatus {
  mongoConnected: boolean;
  redisConnected: boolean;
  scanner: ScannerHealthStatus;
  materializer: MaterializerHealthStatus;
  trader: TraderAggHealthStatus;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startHealthServer(
  port: number,
  getStatus: () => ResolverHealthStatus,
): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      const h = getStatus();
      const now = Date.now();
      const scanAge = h.scanner.lastScanAt
        ? now - h.scanner.lastScanAt
        : Infinity;

      // Service is "ok" if Mongo + Redis are up.
      // Scanner staleness (>5min) is reported but not used to 503 on its own —
      // it may legitimately have nothing to scan.
      const ok = h.mongoConnected && h.redisConnected;

      res.statusCode = ok ? 200 : 503;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ok,
          mongoConnected: h.mongoConnected,
          redisConnected: h.redisConnected,
          scanner: {
            ...h.scanner,
            lastScanAge: scanAge,
          },
          materializer: h.materializer,
          trader: h.trader,
        }),
      );
    } else {
      res.statusCode = 404;
      res.end();
    }
  });

  server.listen(port);
  return server;
}
