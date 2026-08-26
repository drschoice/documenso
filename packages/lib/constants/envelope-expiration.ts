import type { DurationLikeObject } from 'luxon';
import { DateTime, Duration, Info } from 'luxon';
import { z } from 'zod';

export const ZEnvelopeExpirationDurationPeriod = z.object({
  unit: z.enum(['day', 'week', 'month', 'year']),
  amount: z.number().int().min(1),
});

export const ZEnvelopeExpirationDisabledPeriod = z.object({
  disabled: z.literal(true),
});

/**
 * A fixed deadline, stored as a zone-less wall clock (`YYYY-MM-DDTHH:mm`) rather than an instant.
 *
 * The envelope timezone stays editable while the document is a draft, so "the 15th at 8pm" has to
 * keep meaning that after the timezone changes. The concrete instant is resolved at send time by
 * `resolveExpiresAt`.
 */
export const ZEnvelopeExpirationDatePeriod = z.object({
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
});

export const ZEnvelopeExpirationPeriod = z.union([
  ZEnvelopeExpirationDurationPeriod,
  ZEnvelopeExpirationDisabledPeriod,
  ZEnvelopeExpirationDatePeriod,
]);

export type TEnvelopeExpirationPeriod = z.infer<typeof ZEnvelopeExpirationPeriod>;
export type TEnvelopeExpirationDurationPeriod = z.infer<typeof ZEnvelopeExpirationDurationPeriod>;
export type TEnvelopeExpirationDatePeriod = z.infer<typeof ZEnvelopeExpirationDatePeriod>;

const UNIT_TO_LUXON_KEY: Record<
  TEnvelopeExpirationDurationPeriod['unit'],
  keyof DurationLikeObject
> = {
  day: 'days',
  week: 'weeks',
  month: 'months',
  year: 'years',
};

export const DEFAULT_ENVELOPE_EXPIRATION_PERIOD: TEnvelopeExpirationDurationPeriod = {
  unit: 'day',
  amount: 60,
};

/**
 * Time of day seeded when the author first switches to a fixed expiration date.
 */
export const DEFAULT_ENVELOPE_EXPIRATION_TIME = '20:00';

/**
 * Mirrors `DEFAULT_DOCUMENT_TIME_ZONE`, inlined so this module (which the generated Zod schemas
 * import) does not pull the `@vvo/tzdb` dataset into every bundle that touches `DocumentMeta`.
 */
const FALLBACK_TIME_ZONE = 'Etc/UTC';

export const getEnvelopeExpirationDuration = (
  period: TEnvelopeExpirationDurationPeriod,
): Duration => {
  return Duration.fromObject({ [UNIT_TO_LUXON_KEY[period.unit]]: period.amount });
};

export const isEnvelopeExpirationDatePeriod = (
  rawPeriod: unknown,
): rawPeriod is TEnvelopeExpirationDatePeriod => {
  return ZEnvelopeExpirationDatePeriod.safeParse(rawPeriod).success;
};

/**
 * Resolve the concrete expiresAt timestamp from a raw expiration period (from JSON column).
 *
 * - `null` means use the default period (60 days).
 * - `{ disabled: true }` means never expires (returns null).
 * - `{ unit, amount }` means compute the timestamp from now + duration.
 * - `{ expiresAt }` means a fixed deadline, read in the envelope's timezone.
 */
export const resolveExpiresAt = (rawPeriod: unknown, timezone?: string | null): Date | null => {
  if (rawPeriod === null || rawPeriod === undefined) {
    const duration = getEnvelopeExpirationDuration(DEFAULT_ENVELOPE_EXPIRATION_PERIOD);

    return new Date(Date.now() + duration.toMillis());
  }

  const parsed = ZEnvelopeExpirationPeriod.parse(rawPeriod);

  if ('disabled' in parsed) {
    return null;
  }

  if ('expiresAt' in parsed) {
    const zone = timezone && Info.isValidIANAZone(timezone) ? timezone : FALLBACK_TIME_ZONE;

    const deadline = DateTime.fromISO(parsed.expiresAt, { zone });

    return deadline.isValid ? deadline.toJSDate() : null;
  }

  const duration = getEnvelopeExpirationDuration(parsed);

  return new Date(Date.now() + duration.toMillis());
};

/**
 * Whether a fixed expiration date has already lapsed. Duration periods are relative to send time so
 * they can never be in the past.
 */
export const isEnvelopeExpirationInPast = (
  rawPeriod: unknown,
  timezone?: string | null,
): boolean => {
  if (!isEnvelopeExpirationDatePeriod(rawPeriod)) {
    return false;
  }

  const resolved = resolveExpiresAt(rawPeriod, timezone);

  return resolved !== null && resolved.getTime() <= Date.now();
};
