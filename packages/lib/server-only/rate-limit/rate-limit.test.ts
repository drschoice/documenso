import { describe, expect, it } from 'vitest';

import { rateLimitEnvPrefix, resolveRateLimitConfig } from './rate-limit';

const apiConfig = { action: 'api.v2', max: 100, window: '1m' } as const;
const loginConfig = { action: 'auth.login', max: 10, globalMax: 50, window: '15m' } as const;

describe('rateLimitEnvPrefix', () => {
  it('derives an env prefix from the action', () => {
    expect(rateLimitEnvPrefix('api.v2')).toBe('NEXT_PRIVATE_RATE_LIMIT_API_V2');
    expect(rateLimitEnvPrefix('auth.forgot-password')).toBe(
      'NEXT_PRIVATE_RATE_LIMIT_AUTH_FORGOT_PASSWORD',
    );
  });
});

describe('resolveRateLimitConfig', () => {
  it('falls back to the built-in defaults', () => {
    expect(resolveRateLimitConfig(apiConfig, {})).toEqual({
      max: 100,
      globalMax: undefined,
      window: '1m',
    });

    expect(resolveRateLimitConfig(loginConfig, {})).toEqual({
      max: 10,
      globalMax: 50,
      window: '15m',
    });
  });

  it('applies a per-action max override', () => {
    const resolved = resolveRateLimitConfig(apiConfig, {
      NEXT_PRIVATE_RATE_LIMIT_API_V2_MAX: '10000',
    });

    expect(resolved.max).toBe(10000);
  });

  it('applies a per-action globalMax and window override', () => {
    const resolved = resolveRateLimitConfig(loginConfig, {
      NEXT_PRIVATE_RATE_LIMIT_AUTH_LOGIN_GLOBAL_MAX: '500',
      NEXT_PRIVATE_RATE_LIMIT_AUTH_LOGIN_WINDOW: '1h',
    });

    expect(resolved).toEqual({ max: 10, globalMax: 500, window: '1h' });
  });

  it('scales every limit with the multiplier', () => {
    const resolved = resolveRateLimitConfig(loginConfig, {
      NEXT_PRIVATE_RATE_LIMIT_MULTIPLIER: '10',
    });

    expect(resolved).toEqual({ max: 100, globalMax: 500, window: '15m' });
  });

  it('prefers an explicit override over the multiplier', () => {
    const resolved = resolveRateLimitConfig(apiConfig, {
      NEXT_PRIVATE_RATE_LIMIT_MULTIPLIER: '10',
      NEXT_PRIVATE_RATE_LIMIT_API_V2_MAX: '250',
    });

    expect(resolved.max).toBe(250);
  });

  it('ignores values that would weaken or break the limit', () => {
    // A typo must never silently disable rate limiting.
    for (const bad of ['0', '-5', 'lots', '', ' ']) {
      expect(
        resolveRateLimitConfig(apiConfig, { NEXT_PRIVATE_RATE_LIMIT_API_V2_MAX: bad }).max,
      ).toBe(100);

      expect(
        resolveRateLimitConfig(apiConfig, { NEXT_PRIVATE_RATE_LIMIT_MULTIPLIER: bad }).max,
      ).toBe(100);
    }
  });

  it('ignores a malformed window', () => {
    for (const bad of ['1x', 'm', '1 m', 'abc']) {
      expect(
        resolveRateLimitConfig(apiConfig, { NEXT_PRIVATE_RATE_LIMIT_API_V2_WINDOW: bad }).window,
      ).toBe('1m');
    }
  });

  it('rounds fractional results down but never below 1', () => {
    const resolved = resolveRateLimitConfig(
      { action: 'api.ai', max: 3, window: '1m' },
      { NEXT_PRIVATE_RATE_LIMIT_MULTIPLIER: '0.5' },
    );

    expect(resolved.max).toBe(1);
  });

  it('keeps each action independent', () => {
    const env = { NEXT_PRIVATE_RATE_LIMIT_API_V2_MAX: '9999' };

    expect(resolveRateLimitConfig(apiConfig, env).max).toBe(9999);
    expect(resolveRateLimitConfig(loginConfig, env).max).toBe(10);
  });
});
