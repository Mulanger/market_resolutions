import { describe, expect, it } from 'vitest';
import { buildUrl } from '../src/polymarket/client.js';

describe('Gamma client URL builder', () => {
  it('encodes array query params as repeated keys', () => {
    const url = buildUrl('https://gamma-api.polymarket.com', '/markets', {
      condition_ids: ['0xaaa', '0xbbb'],
      closed: true,
      limit: 100,
    });

    expect(url.searchParams.getAll('condition_ids')).toEqual(['0xaaa', '0xbbb']);
    expect(url.searchParams.get('closed')).toBe('true');
    expect(url.searchParams.get('limit')).toBe('100');
  });
});
