/**
 * Zod schemas for Polymarket Gamma resolution-relevant fields.
 *
 * Adapted from whale-watcher/src/polymarket/schemas.ts — the parseOutcomePrice
 * helper is copied verbatim (handles both array and JSON-encoded-string shapes).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Helpers (verbatim from whale-watcher)
// ---------------------------------------------------------------------------

function nullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parse outcomePrices[index] safely.
 * Polymarket returns this field as either an array or a JSON-encoded string.
 * This helper handles both shapes — copy it verbatim as the spec requires.
 */
export function parseOutcomePrice(value: unknown, index: number): number | null {
  if (Array.isArray(value)) return nullableNumber(value[index]);
  if (typeof value !== 'string') return null;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? nullableNumber(parsed[index]) : null;
  } catch {
    return null;
  }
}

/**
 * Parse outcomePrices[index] and convert to cents (0–100 integer).
 * Returns null if the price is not available or not parseable.
 */
export function parseOutcomePriceCents(
  market: { outcomePrices?: unknown; outcomes?: unknown },
  index: number,
): number | null {
  const raw = parseOutcomePrice(market.outcomePrices, index);
  if (raw === null) return null;
  // Gamma prices are in 0..1 range; convert to cents (0..100)
  return Math.round(raw * 100);
}

// ---------------------------------------------------------------------------
// GammaMarket schema — resolution-focused (superset of what watcher uses)
// ---------------------------------------------------------------------------

export const GammaMarketSchema = z
  .object({
    conditionId: z.string(),
    slug: z.string(),
    title: z.string().optional(),
    question: z.string().optional(),
    endDate: z.string().nullable().optional(),
    active: z.boolean().optional(),
    closed: z.boolean().optional(),
    acceptingOrders: z.boolean().optional(),
    umaResolutionStatus: z.string().nullable().optional(),
    outcomePrices: z.unknown().optional(),
    outcomes: z.unknown().optional(),
    negRisk: z.boolean().optional(),
    clobTokenIds: z.unknown().optional(),
    resolutionSource: z.string().nullable().optional(),
    marketMakerAddress: z.string().nullable().optional(),
    // kept for backward-compat with watcher schemas
    category: z.string().nullable().optional(),
    eventSlug: z.string().nullable().optional(),
    events: z
      .array(
        z
          .object({
            slug: z.string().optional(),
            category: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()
  .transform((m) => ({
    conditionId: m.conditionId,
    slug: m.slug,
    title: m.title ?? m.question ?? m.slug,
    endDate: m.endDate ?? null,
    active: m.active,
    closed: m.closed,
    acceptingOrders: m.acceptingOrders,
    umaResolutionStatus: m.umaResolutionStatus ?? null,
    outcomePrices: m.outcomePrices,
    outcomes: m.outcomes,
    negRisk: m.negRisk ?? false,
    clobTokenIds: parseClobTokenIds(m.clobTokenIds),
    resolutionSource: m.resolutionSource ?? null,
    // pass-through for backward-compat
    category: m.category ?? m.events?.[0]?.category ?? null,
    eventSlug: m.eventSlug ?? m.events?.[0]?.slug ?? null,
    yesPriceCents: parseOutcomePriceCents(m, 0),
    noPriceCents: parseOutcomePriceCents(m, 1),
  }));

export type GammaMarket = z.infer<typeof GammaMarketSchema>;

function parseClobTokenIds(value: unknown): string[] | null {
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

// ---------------------------------------------------------------------------
// GammaEvent schema (fallback for very old markets not found by conditionId)
// ---------------------------------------------------------------------------

export const GammaEventSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    eventId: z.union([z.string(), z.number()]).optional(),
    slug: z.string().optional(),
    title: z.string(),
    markets: z.array(GammaMarketSchema).optional(),
  })
  .passthrough()
  .transform((e) => ({
    eventId: String(e.eventId ?? e.id ?? ''),
    slug: e.slug ?? null,
    title: e.title,
    markets: e.markets ?? [],
  }));

export type GammaEvent = z.infer<typeof GammaEventSchema>;
