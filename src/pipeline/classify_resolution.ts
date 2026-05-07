/**
 * classify_resolution — pure function: GammaMarket → ResolutionView
 *
 * Implements the market resolution state machine from spec §5.1.
 * This is a pure function with no side effects — safe to unit-test
 * without any DB or network setup.
 *
 * State transitions (only ever advance, never downgrade):
 *   tracking → closed → resolved
 *   any state → invalid  (only via the disagreement detector in the scanner)
 *
 * The `invalid` state is NOT reachable from this function alone.
 * It is applied by the scanner when it detects a winningOutcome flip on a
 * previously-resolved market. See pipeline/resolution_scanner.ts.
 */
import type { GammaMarket } from '../polymarket/schemas.js';
import {
  parseOutcomePrice,
  parseOutcomePriceCents,
} from '../polymarket/schemas.js';
import type { MarketResolutionStatus } from '../db/outcomes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { MarketResolutionStatus };

export interface ResolutionView {
  status: MarketResolutionStatus;
  /** Unix seconds; first observation of closed=true */
  closedAt: number | null;
  /** Unix seconds; first observation of authoritative outcome */
  resolvedAt: number | null;
  winningOutcome: 'YES' | 'NO' | null;
  /** 0 = YES, 1 = NO (binary markets) */
  winningOutcomeIndex: number | null;
  /** 0–100 integer cents */
  finalYesPriceCents: number | null;
  finalNoPriceCents: number | null;
  umaResolutionStatus: string | null;
}

function emptyOutcome(): Omit<ResolutionView, 'status'> {
  return {
    closedAt: null,
    resolvedAt: null,
    winningOutcome: null,
    winningOutcomeIndex: null,
    finalYesPriceCents: null,
    finalNoPriceCents: null,
    umaResolutionStatus: null,
  };
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a market's resolution status based on the latest Gamma snapshot.
 *
 * @param market  - Fresh data from Gamma API
 * @param previous - Our current stored view (null if first observation)
 * @param nowUnix  - Current unix timestamp in seconds
 * @returns A new ResolutionView (may be identical to previous if nothing changed)
 */
export function classifyResolution(
  market: GammaMarket,
  previous: ResolutionView | null,
  nowUnix: number,
): ResolutionView {
  const yes = parseOutcomePriceCents(market, 0);
  const no = parseOutcomePriceCents(market, 1);
  const yesRaw = parseOutcomePrice(market.outcomePrices, 0);
  const noRaw = parseOutcomePrice(market.outcomePrices, 1);

  // Market is "done" when closed=true OR active=false (belt-and-braces)
  const isClosed =
    market.closed === true ||
    market.active === false ||
    market.acceptingOrders === false;

  // Authoritative outcome: exactly one price at 100¢ and the other at 0¢
  const hasAuthoritative =
    (isFinalPrice(yesRaw, 1) && isFinalPrice(noRaw, 0)) ||
    (isFinalPrice(yesRaw, 0) && isFinalPrice(noRaw, 1));

  // UMA pipeline: treat absent umaResolutionStatus as "no objection"
  const umaOk =
    market.umaResolutionStatus == null ||
    market.umaResolutionStatus === 'resolved';

  // UMA disputed — do NOT advance to resolved. Log loudly upstream.
  const umaDisputed = market.umaResolutionStatus === 'disputed';

  // Multi-outcome markets (outcomes.length > 2) are not supported in v1.
  // Downgrade to invalid immediately (scanner will apply; we return as such here
  // but the scanner's disagreement detector is the authoritative invalid gate).
  const outcomesArr = parseOutcomesArray(market.outcomes);
  if (outcomesArr !== null && outcomesArr.length > 2) {
    return {
      ...emptyOutcome(),
      status: 'invalid',
      umaResolutionStatus: market.umaResolutionStatus ?? null,
    };
  }

  // --- resolved ---
  if (isClosed && hasAuthoritative && umaOk && !umaDisputed) {
    return {
      status: 'resolved',
      closedAt: previous?.closedAt ?? nowUnix,
      resolvedAt: previous?.resolvedAt ?? nowUnix,
      winningOutcome: yes === 100 ? 'YES' : 'NO',
      winningOutcomeIndex: yes === 100 ? 0 : 1,
      finalYesPriceCents: yes,
      finalNoPriceCents: no,
      umaResolutionStatus: market.umaResolutionStatus ?? null,
    };
  }

  // --- closed (trading stopped, outcome not yet authoritative) ---
  if (isClosed) {
    return {
      ...emptyOutcome(),
      status: 'closed',
      closedAt: previous?.closedAt ?? nowUnix,
      umaResolutionStatus: market.umaResolutionStatus ?? null,
    };
  }

  // --- tracking (still open) ---
  return { ...emptyOutcome(), status: 'tracking' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseOutcomesArray(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isFinalPrice(value: number | null, expected: 0 | 1): boolean {
  return value !== null && Math.abs(value - expected) < 1e-9;
}
