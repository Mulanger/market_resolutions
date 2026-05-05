/**
 * TypeScript types for the two collections owned by trade-resolver:
 *   - market_resolutions  (1 doc per market we track)
 *   - trade_outcomes      (1 doc per materialized trade, _id matches trades._id)
 *
 * Also re-exports the additive traders fields this service writes.
 */

// ---------------------------------------------------------------------------
// market_resolutions
// ---------------------------------------------------------------------------

export type MarketResolutionStatus = 'tracking' | 'closed' | 'resolved' | 'invalid';

export interface MarketResolutionDoc {
  /** conditionId, lowercase — primary key */
  _id: string;

  slug: string;
  title: string;
  status: MarketResolutionStatus;

  endDate: Date | null;
  closedAt: Date | null;   // first observation of closed=true
  resolvedAt: Date | null; // first observation of authoritative outcome

  winningOutcome: 'YES' | 'NO' | null;
  winningOutcomeIndex: number | null;
  finalYesPriceCents: number | null;
  finalNoPriceCents: number | null;
  umaResolutionStatus: string | null;

  negRisk: boolean;               // multi-outcome event flag
  clobTokenIds: string[] | null;  // per-outcome token IDs

  // operational
  lastCheckedAt: Date;
  checkCount: number;
  nextCheckAt: Date;
  lastError: string | null;

  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// trade_outcomes
// ---------------------------------------------------------------------------

export type TradeOutcomeStatus = 'open' | 'resolved_win' | 'resolved_loss' | 'invalid';

export interface TradeOutcomeDoc {
  /** Same _id as trades._id — allows a single findOne(_id) join */
  _id: string;
  conditionId: string;
  proxyWallet: string; // lowercase
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  outcomeIndex: number;
  shares: number;
  usdSize: number;
  entryPriceCents: number;
  timestamp: number; // unix seconds, mirrored from trade

  status: TradeOutcomeStatus;

  winningOutcome: 'YES' | 'NO' | null;
  winningOutcomeIndex: number | null;
  /** BUY: shares if win, 0 if loss; SELL: usdSize (proceeds) */
  payoutUsd: number | null;
  /** BUY: payoutUsd - usdSize; SELL: null (no entry basis without FIFO) */
  pnlUsd: number | null;

  resolvedAt: Date | null; // copy of market_resolutions.resolvedAt
  firstMaterializedAt: Date;
  /** Set when status leaves 'open' — guards idempotency in the materializer */
  frozenAt: Date | null;
}

// ---------------------------------------------------------------------------
// traders — additive resolved* fields (this service only, namespace-prefixed)
// ---------------------------------------------------------------------------

export interface TraderResolvedFields {
  resolvedBuyCount?: number;
  resolvedWinCount?: number;
  resolvedLossCount?: number;
  resolvedWinRate?: number | null; // 0..1
  resolvedRealizedPnlUsd?: number;
  resolvedVolumeUsd?: number;
  resolvedLastUpdatedAt?: Date;
  resolvedLastResolvedAt?: Date | null;
}
