/**
 * classify_outcome — pure function: (trade fields, resolution) → TradeOutcomeStatus
 *
 * Implements the trade outcome state machine from spec §5.2 and §5.3.
 * This is a pure function with no side effects — fully unit-testable.
 *
 * Full truth table (BUY side):
 *   resolutionStatus=invalid                 → invalid
 *   resolutionStatus≠resolved OR no outcome  → open
 *   BUY YES + winningOutcome=YES             → resolved_win
 *   BUY YES + winningOutcome=NO              → resolved_loss
 *   BUY NO  + winningOutcome=NO              → resolved_win
 *   BUY NO  + winningOutcome=YES             → resolved_loss
 *
 * SELL side (spec §5.3):
 *   SELL YES + winningOutcome=YES → resolved_loss (missed the hold; market won)
 *   SELL YES + winningOutcome=NO  → resolved_win  (good exit; market lost)
 *   SELL NO  + winningOutcome=NO  → resolved_loss
 *   SELL NO  + winningOutcome=YES → resolved_win
 *
 * IMPORTANT: The UI should NOT render a red/green pill for SELL trades.
 * resolved_win/resolved_loss on SELLs is for trader-score math only.
 * See spec §5.3 for the recommended UI mapping.
 *
 * PnL semantics (spec §5.4):
 *   BUY: payoutUsd = won ? shares : 0 ; pnlUsd = payoutUsd - usdSize
 *   SELL: payoutUsd = usdSize (proceeds) ; pnlUsd = null (no FIFO basis)
 */
import type { MarketResolutionStatus, TradeOutcomeStatus } from '../db/outcomes.js';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface ClassifyOutcomeInput {
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  winningOutcome: 'YES' | 'NO' | null;
  resolutionStatus: MarketResolutionStatus;
}

export interface OutcomeClassification {
  status: TradeOutcomeStatus;
  /** BUY: shares if win, 0 if loss; SELL: usdSize (proceeds) */
  payoutUsd: number | null;
  /** BUY: payoutUsd - usdSize; SELL: null */
  pnlUsd: number | null;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a single trade's outcome given the market's resolution status.
 *
 * @param args.side            BUY or SELL
 * @param args.outcome         The outcome token the trader bought/sold: YES or NO
 * @param args.winningOutcome  From market_resolutions.winningOutcome (null if not resolved)
 * @param args.resolutionStatus From market_resolutions.status
 */
export function classifyOutcome(args: ClassifyOutcomeInput): TradeOutcomeStatus {
  if (args.resolutionStatus === 'invalid') return 'invalid';
  if (args.resolutionStatus !== 'resolved' || args.winningOutcome === null) {
    return 'open';
  }

  // outcome matches the winning outcome?
  const won = args.outcome === args.winningOutcome;

  if (args.side === 'BUY') {
    return won ? 'resolved_win' : 'resolved_loss';
  }

  // SELL: inverse of the BUY logic (selling the winner = missing the hold)
  return won ? 'resolved_loss' : 'resolved_win';
}

// ---------------------------------------------------------------------------
// PnL helpers
// ---------------------------------------------------------------------------

/**
 * Compute payoutUsd and pnlUsd for a resolved trade.
 *
 * @param status    The trade's outcome status (from classifyOutcome)
 * @param side      BUY or SELL
 * @param shares    Number of shares (used for BUY payout)
 * @param usdSize   Trade size in USD (used for SELL payout)
 */
export function computePnl(args: {
  status: TradeOutcomeStatus;
  side: 'BUY' | 'SELL';
  shares: number;
  usdSize: number;
}): Pick<OutcomeClassification, 'payoutUsd' | 'pnlUsd'> {
  if (args.status === 'open' || args.status === 'invalid') {
    return { payoutUsd: null, pnlUsd: null };
  }

  if (args.side === 'SELL') {
    // Proceeds are the usdSize received; no entry basis without FIFO matching
    return { payoutUsd: args.usdSize, pnlUsd: null };
  }

  // BUY: each winning share pays $1; losing shares pay $0
  const payoutUsd = args.status === 'resolved_win' ? args.shares : 0;
  const pnlUsd = payoutUsd - args.usdSize;
  return { payoutUsd, pnlUsd };
}

/**
 * Normalise an outcome string from the trades collection to 'YES' | 'NO'.
 * Polymarket stores outcome as "Yes" / "No" (capitalised first letter).
 */
export function normalizeOutcome(outcome: string): 'YES' | 'NO' {
  const upper = outcome.toUpperCase();
  if (upper === 'YES') return 'YES';
  if (upper === 'NO') return 'NO';
  // Fallback — treat anything else as 'NO' and let the classifier produce invalid
  return 'NO';
}
