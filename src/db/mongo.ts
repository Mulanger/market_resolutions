import { MongoClient, Collection, Db as Database } from 'mongodb';
import { loadConfig } from '../config.js';
import { getLogger } from '../logger.js';
import type { MarketResolutionDoc, TradeOutcomeDoc, TraderResolvedFields } from './outcomes.js';

let _client: MongoClient | null = null;
let _db: Database | null = null;

// ---------------------------------------------------------------------------
// Minimal read-only types for collections owned by the whale-watcher.
// We NEVER write to these — single-writer rules are load-bearing.
// ---------------------------------------------------------------------------

/** Minimal projection of trades we need for resolution + materialisation. */
export interface EnrichedWhaleMinimal {
  _id: string;
  side: 'BUY' | 'SELL';
  outcome: string;
  usdSize: number;
  shares: number;
  priceCents: number;
  timestamp: number;
  ingestedAt: Date;
  market: {
    conditionId: string;
    slug: string;
    title: string;
  };
  trader: {
    proxyWallet: string;
  };
}

/** Minimal trader doc — we only write resolved* fields, never the watcher's fields. */
export interface TraderDoc extends TraderResolvedFields {
  _id: string;
  pseudonym?: string | null;
  displayName?: string | null;
  profileImage?: string | null;
  vol30d?: number | null;
  winRate?: number | null;
  tradeCount?: number | null;
  totalPnl?: number | null;
  refreshedAt?: Date;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export interface ResolverCollections {
  client: MongoClient;
  db: Database;
  /** trade-resolver owns this collection */
  marketResolutions: Collection<MarketResolutionDoc>;
  /** trade-resolver owns this collection */
  tradeOutcomes: Collection<TradeOutcomeDoc>;
  /** Watcher-owned: read-only for us */
  trades: Collection<EnrichedWhaleMinimal>;
  /** Watcher-owned: we write resolved* fields only via additive $set */
  traders: Collection<TraderDoc>;
}

export async function connectMongo(): Promise<ResolverCollections> {
  const config = loadConfig();
  const log = getLogger();

  if (_client && _db) {
    return buildCollections(_client, _db);
  }

  log.info('Connecting to MongoDB...');
  _client = new MongoClient(config.mongoUri);
  await _client.connect();
  _db = _client.db(config.mongoDb);
  log.info({ db: config.mongoDb }, 'MongoDB connected');

  return buildCollections(_client, _db);
}

function buildCollections(client: MongoClient, db: Database): ResolverCollections {
  return {
    client,
    db,
    marketResolutions: db.collection<MarketResolutionDoc>('market_resolutions'),
    tradeOutcomes: db.collection<TradeOutcomeDoc>('trade_outcomes'),
    trades: db.collection<EnrichedWhaleMinimal>('trades'),
    traders: db.collection<TraderDoc>('traders'),
  };
}

export async function closeMongo(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
    getLogger().info('MongoDB connection closed');
  }
}

export function isMongoConnected(): boolean {
  return _client !== null;
}
