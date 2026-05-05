import { describe, expect, it } from 'vitest';
import {
  classifyOutcome,
  computePnl,
  normalizeOutcome,
} from '../src/pipeline/classify_outcome.js';

describe('classifyOutcome', () => {
  // ---- Pre-resolution / invalid passthrough ----
  it('returns "open" while resolutionStatus is tracking', () => {
    expect(
      classifyOutcome({
        side: 'BUY',
        outcome: 'YES',
        winningOutcome: null,
        resolutionStatus: 'tracking',
      }),
    ).toBe('open');
  });

  it('returns "open" while resolutionStatus is closed (no outcome yet)', () => {
    expect(
      classifyOutcome({
        side: 'BUY',
        outcome: 'YES',
        winningOutcome: null,
        resolutionStatus: 'closed',
      }),
    ).toBe('open');
  });

  it('returns "invalid" when resolutionStatus is invalid (regardless of side/outcome)', () => {
    for (const side of ['BUY', 'SELL'] as const) {
      for (const outcome of ['YES', 'NO'] as const) {
        expect(
          classifyOutcome({
            side,
            outcome,
            winningOutcome: 'YES',
            resolutionStatus: 'invalid',
          }),
        ).toBe('invalid');
      }
    }
  });

  it('returns "open" if resolutionStatus is resolved but winningOutcome is null', () => {
    // Defensive: should not happen in normal flow, but the classifier must not
    // misclassify trades when the resolver's view is half-baked.
    expect(
      classifyOutcome({
        side: 'BUY',
        outcome: 'YES',
        winningOutcome: null,
        resolutionStatus: 'resolved',
      }),
    ).toBe('open');
  });

  // ---- BUY truth table ----
  describe('BUY full truth table', () => {
    const cases: Array<{
      outcome: 'YES' | 'NO';
      winning: 'YES' | 'NO';
      expected: 'resolved_win' | 'resolved_loss';
    }> = [
      { outcome: 'YES', winning: 'YES', expected: 'resolved_win' },
      { outcome: 'YES', winning: 'NO', expected: 'resolved_loss' },
      { outcome: 'NO', winning: 'YES', expected: 'resolved_loss' },
      { outcome: 'NO', winning: 'NO', expected: 'resolved_win' },
    ];

    for (const c of cases) {
      it(`BUY ${c.outcome} when winning=${c.winning} → ${c.expected}`, () => {
        expect(
          classifyOutcome({
            side: 'BUY',
            outcome: c.outcome,
            winningOutcome: c.winning,
            resolutionStatus: 'resolved',
          }),
        ).toBe(c.expected);
      });
    }
  });

  // ---- SELL truth table (inverse of BUY per spec §5.3) ----
  describe('SELL full truth table', () => {
    const cases: Array<{
      outcome: 'YES' | 'NO';
      winning: 'YES' | 'NO';
      expected: 'resolved_win' | 'resolved_loss';
    }> = [
      { outcome: 'YES', winning: 'YES', expected: 'resolved_loss' }, // sold the winner — missed the hold
      { outcome: 'YES', winning: 'NO', expected: 'resolved_win' },   // sold the loser — saved
      { outcome: 'NO', winning: 'YES', expected: 'resolved_win' },
      { outcome: 'NO', winning: 'NO', expected: 'resolved_loss' },
    ];

    for (const c of cases) {
      it(`SELL ${c.outcome} when winning=${c.winning} → ${c.expected}`, () => {
        expect(
          classifyOutcome({
            side: 'SELL',
            outcome: c.outcome,
            winningOutcome: c.winning,
            resolutionStatus: 'resolved',
          }),
        ).toBe(c.expected);
      });
    }
  });
});

describe('computePnl', () => {
  it('open trade: payout & pnl are both null', () => {
    expect(
      computePnl({ status: 'open', side: 'BUY', shares: 100, usdSize: 50 }),
    ).toEqual({ payoutUsd: null, pnlUsd: null });
  });

  it('invalid trade: payout & pnl are both null', () => {
    expect(
      computePnl({ status: 'invalid', side: 'BUY', shares: 100, usdSize: 50 }),
    ).toEqual({ payoutUsd: null, pnlUsd: null });
  });

  it('BUY win: payoutUsd = shares, pnl = shares - usdSize', () => {
    expect(
      computePnl({
        status: 'resolved_win',
        side: 'BUY',
        shares: 100,
        usdSize: 70,
      }),
    ).toEqual({ payoutUsd: 100, pnlUsd: 30 });
  });

  it('BUY loss: payoutUsd = 0, pnl = -usdSize', () => {
    expect(
      computePnl({
        status: 'resolved_loss',
        side: 'BUY',
        shares: 100,
        usdSize: 70,
      }),
    ).toEqual({ payoutUsd: 0, pnlUsd: -70 });
  });

  it('SELL (any resolved status): payoutUsd = usdSize, pnl = null (no FIFO basis)', () => {
    for (const status of ['resolved_win', 'resolved_loss'] as const) {
      expect(
        computePnl({ status, side: 'SELL', shares: 100, usdSize: 65 }),
      ).toEqual({ payoutUsd: 65, pnlUsd: null });
    }
  });
});

describe('normalizeOutcome', () => {
  it('lowercase yes → YES', () => {
    expect(normalizeOutcome('yes')).toBe('YES');
  });
  it('mixed-case Yes → YES', () => {
    expect(normalizeOutcome('Yes')).toBe('YES');
  });
  it('uppercase NO → NO', () => {
    expect(normalizeOutcome('NO')).toBe('NO');
  });
  it('unknown string → NO (fallback per spec)', () => {
    expect(normalizeOutcome('Maybe')).toBe('NO');
  });
});
