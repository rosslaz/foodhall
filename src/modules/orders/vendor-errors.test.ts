import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { isTerminalVendorError } from './vendor-errors.js';

// Locks the terminal-vs-retryable contract the fire path depends on
// (review H1/M1, 2026-07-08). If this classification drifts, groups either
// get stranded behind eternal countdowns (false negatives) or transient
// blips kill real orders (false positives).
describe('isTerminalVendorError', () => {
  it('4xx AppErrors are terminal (config/validation — retry cannot fix)', () => {
    expect(isTerminalVendorError(new AppError(400, 'GOTAB_UNMAPPED_ITEMS', 'x'))).toBe(true);
    expect(isTerminalVendorError(new AppError(400, 'GOTAB_NO_SPOT', 'x'))).toBe(true);
    expect(isTerminalVendorError(new AppError(404, 'GOTAB_ORDER_NOT_FOUND', 'x'))).toBe(true);
  });

  it('GOTAB_NO_ORDER_ID is terminal despite its 502 (duplicate-order risk, M1)', () => {
    expect(isTerminalVendorError(new AppError(502, 'GOTAB_NO_ORDER_ID', 'x'))).toBe(true);
  });

  it('5xx / network-shaped AppErrors are retryable', () => {
    expect(isTerminalVendorError(new AppError(502, 'GOTAB_HTTP', 'GoTab 503 ...'))).toBe(false);
    expect(isTerminalVendorError(new AppError(502, 'GOTAB_HTTP', 'fetch failed'))).toBe(false);
  });

  it('non-AppErrors are retryable (unknown = assume transient)', () => {
    expect(isTerminalVendorError(new Error('boom'))).toBe(false);
    expect(isTerminalVendorError('string')).toBe(false);
    expect(isTerminalVendorError(undefined)).toBe(false);
  });
});
