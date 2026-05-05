import { describe, expect, it } from 'vitest';
import { classifyResolution, type ResolutionView } from '../src/pipeline/classify_resolution.js';
import type { GammaMarket } from '../src/polymarket/schemas.js';

const NOW = 1_700_000_000; // arbitrary fixed unix-seconds for stable tests

/**
 * Build a minimal GammaMarket-like object for tests. The classifier reads only
 * a small set of fields, so we don't need the full transform output.
 */
function fakeMarket(over: Partial<GammaMarket> = {}): GammaMarket {
  return {
    conditionId: '0xabc',
    slug: 'test-market',
    title: 'Test market',
    endDate: null,
    active: true,
    closed: false,
    acceptingOrders: true,
    umaResolutionStatus: null,
    outcomePrices: ['0.5', '0.5'],
    outcomes: ['Yes', 'No'],
    negRisk: false,
    clobTokenIds: null,
    resolutionSource: null,
    category: null,
    eventSlug: null,
    yesPriceCents: 50,
    noPriceCents: 50,
    ...over,
  };
}

describe('classifyResolution', () => {
  // ---------- tracking ----------
  it('open active market → tracking', () => {
    const v = classifyResolution(fakeMarket(), null, NOW);
    expect(v.status).toBe('tracking');
    expect(v.closedAt).toBeNull();
    expect(v.resolvedAt).toBeNull();
    expect(v.winningOutcome).toBeNull();
  });

  // ---------- tracking → closed (no outcome yet) ----------
  it('closed=true with no authoritative price → closed', () => {
    const v = classifyResolution(
      fakeMarket({ closed: true, outcomePrices: ['0.7', '0.3'] }),
      null,
      NOW,
    );
    expect(v.status).toBe('closed');
    expect(v.closedAt).toBe(NOW);
    expect(v.resolvedAt).toBeNull();
    expect(v.winningOutcome).toBeNull();
  });

  it('active=false counts as closed', () => {
    const v = classifyResolution(
      fakeMarket({ active: false, outcomePrices: ['0.7', '0.3'] }),
      null,
      NOW,
    );
    expect(v.status).toBe('closed');
  });

  // ---------- closed → resolved ----------
  it('closed + YES authoritative + UMA absent → resolved YES', () => {
    const previous: ResolutionView = {
      status: 'closed',
      closedAt: NOW - 1000,
      resolvedAt: null,
      winningOutcome: null,
      winningOutcomeIndex: null,
      finalYesPriceCents: null,
      finalNoPriceCents: null,
      umaResolutionStatus: null,
    };
    const v = classifyResolution(
      fakeMarket({
        closed: true,
        outcomePrices: ['1', '0'],
      }),
      previous,
      NOW,
    );
    expect(v.status).toBe('resolved');
    expect(v.winningOutcome).toBe('YES');
    expect(v.winningOutcomeIndex).toBe(0);
    expect(v.finalYesPriceCents).toBe(100);
    expect(v.finalNoPriceCents).toBe(0);
    expect(v.closedAt).toBe(NOW - 1000); // preserved from prior
    expect(v.resolvedAt).toBe(NOW);      // first observation now
  });

  it('closed + NO authoritative + UMA resolved → resolved NO', () => {
    const v = classifyResolution(
      fakeMarket({
        closed: true,
        outcomePrices: ['0', '1'],
        umaResolutionStatus: 'resolved',
      }),
      null,
      NOW,
    );
    expect(v.status).toBe('resolved');
    expect(v.winningOutcome).toBe('NO');
    expect(v.winningOutcomeIndex).toBe(1);
  });

  // ---------- straight to resolved (skipping closed) ----------
  it('first observation already shows resolved → resolved with closedAt = nowUnix', () => {
    const v = classifyResolution(
      fakeMarket({ closed: true, outcomePrices: ['1', '0'] }),
      null,
      NOW,
    );
    expect(v.status).toBe('resolved');
    expect(v.closedAt).toBe(NOW);
    expect(v.resolvedAt).toBe(NOW);
  });

  // ---------- UMA dispute blocks resolved ----------
  it('UMA disputed: do NOT advance to resolved even with authoritative prices', () => {
    const v = classifyResolution(
      fakeMarket({
        closed: true,
        outcomePrices: ['1', '0'],
        umaResolutionStatus: 'disputed',
      }),
      null,
      NOW,
    );
    expect(v.status).toBe('closed');
    expect(v.winningOutcome).toBeNull();
  });

  // ---------- idempotent: resolved input → resolved output ----------
  it('reclassifying an already-resolved market is idempotent', () => {
    const previous: ResolutionView = {
      status: 'resolved',
      closedAt: NOW - 5000,
      resolvedAt: NOW - 4000,
      winningOutcome: 'YES',
      winningOutcomeIndex: 0,
      finalYesPriceCents: 100,
      finalNoPriceCents: 0,
      umaResolutionStatus: 'resolved',
    };
    const v = classifyResolution(
      fakeMarket({
        closed: true,
        outcomePrices: ['1', '0'],
        umaResolutionStatus: 'resolved',
      }),
      previous,
      NOW,
    );
    expect(v.status).toBe('resolved');
    expect(v.winningOutcome).toBe('YES');
    // closedAt and resolvedAt preserved
    expect(v.closedAt).toBe(NOW - 5000);
    expect(v.resolvedAt).toBe(NOW - 4000);
  });

  // ---------- multi-outcome markets → invalid ----------
  it('multi-outcome market (>2 outcomes) → invalid', () => {
    const v = classifyResolution(
      fakeMarket({
        outcomes: ['Trump', 'Biden', 'Other'],
        outcomePrices: ['0.4', '0.3', '0.3'],
      }),
      null,
      NOW,
    );
    expect(v.status).toBe('invalid');
  });

  it('handles outcomes as a JSON-encoded string (Polymarket Gamma quirk)', () => {
    const v = classifyResolution(
      fakeMarket({ outcomes: '["Yes","No","Maybe"]' }),
      null,
      NOW,
    );
    expect(v.status).toBe('invalid');
  });

  // ---------- handles outcomePrices as JSON-encoded string ----------
  it('handles outcomePrices as a JSON-encoded string', () => {
    const v = classifyResolution(
      fakeMarket({ closed: true, outcomePrices: '["1","0"]' }),
      null,
      NOW,
    );
    expect(v.status).toBe('resolved');
    expect(v.winningOutcome).toBe('YES');
  });
});
