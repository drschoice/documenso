import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENVELOPE_EXPIRATION_PERIOD,
  isEnvelopeExpirationDatePeriod,
  isEnvelopeExpirationInPast,
  resolveExpiresAt,
} from './envelope-expiration';

describe('resolveExpiresAt', () => {
  it('falls back to the default period when nothing is configured', () => {
    expect(DEFAULT_ENVELOPE_EXPIRATION_PERIOD).toEqual({ unit: 'day', amount: 60 });

    const resolved = resolveExpiresAt(null);
    const daysOut = (resolved!.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

    // Allow for the clock ticking during the assertion.
    expect(daysOut).toBeGreaterThan(59.99);
    expect(daysOut).toBeLessThan(60.01);
  });

  it('never expires when explicitly disabled', () => {
    expect(resolveExpiresAt({ disabled: true })).toBeNull();
  });

  it('counts a duration from now', () => {
    const resolved = resolveExpiresAt({ unit: 'day', amount: 7 });
    const daysOut = (resolved!.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

    expect(daysOut).toBeGreaterThan(6.99);
    expect(daysOut).toBeLessThan(7.01);
  });

  it('reads a fixed deadline in the envelope timezone', () => {
    expect(resolveExpiresAt({ expiresAt: '2027-01-15T20:00' }, 'Etc/UTC')?.toISOString()).toBe(
      '2027-01-15T20:00:00.000Z',
    );

    // EST is UTC-5.
    expect(
      resolveExpiresAt({ expiresAt: '2027-01-15T20:00' }, 'America/New_York')?.toISOString(),
    ).toBe('2027-01-16T01:00:00.000Z');
  });

  it('follows daylight saving rather than a fixed offset', () => {
    // EDT is UTC-4, so the same wall clock is an hour earlier in UTC than in January.
    expect(
      resolveExpiresAt({ expiresAt: '2027-07-15T20:00' }, 'America/New_York')?.toISOString(),
    ).toBe('2027-07-16T00:00:00.000Z');
  });

  it('falls back to UTC when the timezone is missing or unusable', () => {
    expect(resolveExpiresAt({ expiresAt: '2027-01-15T20:00' })?.toISOString()).toBe(
      '2027-01-15T20:00:00.000Z',
    );

    expect(
      resolveExpiresAt({ expiresAt: '2027-01-15T20:00' }, 'Not/AZone')?.toISOString(),
    ).toBe('2027-01-15T20:00:00.000Z');
  });

  it('rejects a deadline that is not a bare wall clock', () => {
    // An instant would silently ignore the envelope timezone, so the offset form is not accepted.
    expect(() => resolveExpiresAt({ expiresAt: '2027-01-15T20:00:00Z' })).toThrow();
    expect(() => resolveExpiresAt({ expiresAt: '2027-01-15' })).toThrow();
  });
});

describe('isEnvelopeExpirationDatePeriod', () => {
  it('only narrows the fixed date arm', () => {
    expect(isEnvelopeExpirationDatePeriod({ expiresAt: '2027-01-15T20:00' })).toBe(true);
    expect(isEnvelopeExpirationDatePeriod({ unit: 'month', amount: 1 })).toBe(false);
    expect(isEnvelopeExpirationDatePeriod({ disabled: true })).toBe(false);
    expect(isEnvelopeExpirationDatePeriod(null)).toBe(false);
  });
});

describe('isEnvelopeExpirationInPast', () => {
  it('is never true for a relative or disabled period', () => {
    expect(isEnvelopeExpirationInPast(null)).toBe(false);
    expect(isEnvelopeExpirationInPast({ disabled: true })).toBe(false);
    expect(isEnvelopeExpirationInPast({ unit: 'day', amount: 1 })).toBe(false);
  });

  it('detects a lapsed fixed deadline', () => {
    expect(isEnvelopeExpirationInPast({ expiresAt: '2020-01-15T20:00' }, 'Etc/UTC')).toBe(true);
    expect(isEnvelopeExpirationInPast({ expiresAt: '2099-01-15T20:00' }, 'Etc/UTC')).toBe(false);
  });
});
