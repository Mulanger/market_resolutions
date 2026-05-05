import { describe, expect, it } from 'vitest';
import { tierIntervalSec, type TierConfig } from '../src/pipeline/resolution_scanner.js';
import type { ResolutionView } from '../src/pipeline/classify_resolution.js';
import type { GammaMarket } from '../src/polymarket/schemas.js';

const NOW = 1_700_000_000;

const baseConfig: TierConfig = {
  hotRecheckSec: 60,
  warmRecheckSec: 300,
  coldRecheckSec: 1800,
};

function view(over: Partial<ResolutionView> = {}): ResolutionView {
  return {
    status: 'tracking',
    closedAt: null,
    resolvedAt: null,
    winningOutcome: null,
    winningOutcomeIndex: null,
    finalYesPriceCents: null,
    finalNoPriceCents: null,
    umaResolutionStatus: null,
    ...over,
  };
}

function market(over: Partial<GammaMarket> = {}): GammaMarket {
  return {
    conditionId: '0xabc',
    slug: 's',
    title: 't',
    endDate: null,
    active: true,
    closed: false,
    acceptingOrders: true,
    umaResolutionStatus: null,
    outcomePrices: null,
    outcomes: null,
    negRisk: false,
    clobTokenIds: null,
    resolutionSource: null,
    category: null,
    eventSlug: null,
    yesPriceCents: null,
    noPriceCents: null,
    ...over,
  };
}

describe('tierIntervalSec', () => {
  it('frozen statuses (resolved/invalid) get a near-infinite interval', () => {
    expect(
      tierIntervalSec(view({ status: 'resolved' }), market(), NOW, baseConfig),
    ).toBeGreaterThan(60 * 86_400); // > 60 days
    expect(
      tierIntervalSec(view({ status: 'invalid' }), market(), NOW, baseConfig),
    ).toBeGreaterThan(60 * 86_400);
  });

  it('closed markets are hot (waiting on outcome)', () => {
    expect(
      tierIntervalSec(view({ status: 'closed' }), market(), NOW, baseConfig),
    ).toBe(60);
  });

  it('tracking + endDate within ±48h is hot', () => {
    const oneDayFromNow = new Date((NOW + 86_400) * 1000).toISOString();
    expect(
      tierIntervalSec(
        view({ status: 'tracking' }),
        market({ endDate: oneDayFromNow }),
        NOW,
        baseConfig,
      ),
    ).toBe(60);
  });

  it('tracking + endDate within ±7d is warm', () => {
    const fiveDaysFromNow = new Date((NOW + 5 * 86_400) * 1000).toISOString();
    expect(
      tierIntervalSec(
        view({ status: 'tracking' }),
        market({ endDate: fiveDaysFromNow }),
        NOW,
        baseConfig,
      ),
    ).toBe(300);
  });

  it('tracking + endDate far away is cold', () => {
    const oneYearFromNow = new Date((NOW + 365 * 86_400) * 1000).toISOString();
    expect(
      tierIntervalSec(
        view({ status: 'tracking' }),
        market({ endDate: oneYearFromNow }),
        NOW,
        baseConfig,
      ),
    ).toBe(1800);
  });

  it('tracking + no endDate is cold', () => {
    expect(
      tierIntervalSec(
        view({ status: 'tracking' }),
        market({ endDate: null }),
        NOW,
        baseConfig,
      ),
    ).toBe(1800);
  });

  it('tracking + null market is cold', () => {
    expect(
      tierIntervalSec(view({ status: 'tracking' }), null, NOW, baseConfig),
    ).toBe(1800);
  });
});
