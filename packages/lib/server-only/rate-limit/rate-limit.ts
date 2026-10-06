import { prisma } from '@documenso/prisma';

import { logger } from '../../utils/logger';

type WindowUnit = 's' | 'm' | 'h' | 'd';
type WindowStr = `${number}${WindowUnit}`;

type RateLimitConfig = {
  action: string;
  max: number;
  globalMax?: number;
  window: WindowStr;
};

type CheckParams = {
  ip: string;
  identifier?: string;
  /** Number of units to consume in this check. Defaults to 1. */
  count?: number;
};

export type RateLimitCheckResult = {
  isLimited: boolean;
  remaining: number;
  limit: number;
  reset: Date;
};

export type ResolvedRateLimitConfig = {
  max: number;
  globalMax?: number;
  window: WindowStr;
};

const WINDOW_PATTERN = /^\d+[smhd]$/;

const isWindowStr = (value: string | undefined): value is WindowStr =>
  typeof value === 'string' && WINDOW_PATTERN.test(value);

const readPositiveNumber = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

/**
 * Environment variable prefix for a given action, e.g. `api.v2` becomes
 * `NEXT_PRIVATE_RATE_LIMIT_API_V2`.
 */
export const rateLimitEnvPrefix = (action: string): string =>
  `NEXT_PRIVATE_RATE_LIMIT_${action.toUpperCase().replace(/[.-]/g, '_')}`;

/**
 * Resolve a limiter's effective configuration from the environment.
 *
 * Deployments differ in what counts as abuse: a scripted integration hitting the
 * API on behalf of one account looks nothing like a login endpoint facing the
 * internet. Rather than forcing the all-or-nothing `DANGEROUS_BYPASS_RATE_LIMITS`
 * escape hatch, every limiter can be tuned:
 *
 * - `NEXT_PRIVATE_RATE_LIMIT_<ACTION>_MAX` - per-identifier (or per-IP when the
 *   route has no identifier) ceiling, e.g. `NEXT_PRIVATE_RATE_LIMIT_API_V2_MAX=10000`
 * - `NEXT_PRIVATE_RATE_LIMIT_<ACTION>_GLOBAL_MAX` - per-IP ceiling for routes
 *   that set one
 * - `NEXT_PRIVATE_RATE_LIMIT_<ACTION>_WINDOW` - bucket size, e.g. `1m`, `15m`, `1h`
 * - `NEXT_PRIVATE_RATE_LIMIT_MULTIPLIER` - scales every limit that has no
 *   explicit override, so a script-heavy environment can raise all of them at
 *   once without enumerating each action
 *
 * An explicit per-action override always wins over the multiplier. Invalid or
 * non-positive values are ignored in favour of the built-in default, so a
 * typo weakens nothing.
 */
export const resolveRateLimitConfig = (
  config: RateLimitConfig,
  // `Partial` rather than `NodeJS.ProcessEnv`: this repo augments ProcessEnv with
  // the variables the app requires, and the resolver only ever reads four of
  // them, so demanding the full shape would force every caller - the tests in
  // particular - to invent values it never looks at.
  env: Partial<NodeJS.ProcessEnv> = process.env,
): ResolvedRateLimitConfig => {
  const prefix = rateLimitEnvPrefix(config.action);

  const multiplier = readPositiveNumber(env.NEXT_PRIVATE_RATE_LIMIT_MULTIPLIER) ?? 1;

  const maxOverride = readPositiveNumber(env[`${prefix}_MAX`]);
  const globalMaxOverride = readPositiveNumber(env[`${prefix}_GLOBAL_MAX`]);
  const windowOverride = env[`${prefix}_WINDOW`];

  const max = maxOverride ?? config.max * multiplier;

  const globalMax =
    globalMaxOverride ??
    (config.globalMax === undefined ? undefined : config.globalMax * multiplier);

  return {
    max: Math.max(1, Math.floor(max)),
    globalMax: globalMax === undefined ? undefined : Math.max(1, Math.floor(globalMax)),
    window: isWindowStr(windowOverride) ? windowOverride : config.window,
  };
};

/**
 * Parse window string (e.g., '1h', '15m', '30s') to milliseconds.
 */
export const parseWindow = (window: WindowStr): number => {
  const value = parseInt(window.slice(0, -1), 10);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const unit = window.slice(-1) as WindowUnit;

  const multipliers: Record<WindowUnit, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit];
};

/**
 * Compute the current time bucket for the given window size.
 */
export const getBucket = (windowMs: number): Date => {
  const now = Date.now();

  return new Date(now - (now % windowMs));
};

/**
 * Create a rate limiter with the given configuration.
 *
 * Uses bucketed counters in the database for distributed rate limiting
 * across multiple instances. Each check atomically increments the counter
 * and returns the new count.
 */
export const createRateLimit = (config: RateLimitConfig) => {
  return {
    async check(params: CheckParams): Promise<RateLimitCheckResult> {
      // Resolved per check rather than at module load: the limiters are created
      // as module-level constants, which can be evaluated before the process
      // environment has been populated.
      const resolved = resolveRateLimitConfig(config);

      const windowMs = parseWindow(resolved.window);
      const bucket = getBucket(windowMs);
      const reset = new Date(bucket.getTime() + windowMs);
        const ipLimit = resolved.globalMax ?? resolved.max;
        const count = params.count ?? 1;

      if (process.env.DANGEROUS_BYPASS_RATE_LIMITS === 'true') {
        return {
          isLimited: false,
          remaining: ipLimit,
          limit: ipLimit,
          reset,
        };
      }

      try {
        // Always upsert the IP counter.
        const ipResult = await prisma.rateLimit.upsert({
          where: {
            key_action_bucket: {
              key: `ip:${params.ip}`,
              action: config.action,
              bucket,
            },
          },
          create: {
            key: `ip:${params.ip}`,
            action: config.action,
            bucket,
            count,
          },
          update: {
            count: { increment: count },
          },
        });

        // Check IP against globalMax if set, or against max if no identifier is provided.
        let ipCheckLimit = resolved.globalMax;

        if (!params.identifier) {
          ipCheckLimit = resolved.max;
        }

        if (ipCheckLimit && ipResult.count > ipCheckLimit) {
          logger.warn({
            msg: 'Rate limit exceeded',
            action: config.action,
            keyType: 'ip',
            key: params.ip,
            count: ipResult.count,
            limit: ipCheckLimit,
          });

          return {
            isLimited: true,
            remaining: 0,
            limit: ipCheckLimit,
            reset,
          };
        }

        // Upsert the identifier counter if provided.
        if (params.identifier) {
          const identifierResult = await prisma.rateLimit.upsert({
            where: {
              key_action_bucket: {
                key: `id:${params.identifier}`,
                action: config.action,
                bucket,
              },
            },
            create: {
              key: `id:${params.identifier}`,
              action: config.action,
              bucket,
              count,
            },
            update: {
              count: { increment: count },
            },
          });

          if (identifierResult.count > resolved.max) {
            logger.warn({
              msg: 'Rate limit exceeded',
              action: config.action,
              keyType: 'identifier',
              key: params.identifier,
              count: identifierResult.count,
              limit: resolved.max,
            });

            return {
              isLimited: true,
              remaining: 0,
              limit: resolved.max,
              reset,
            };
          }

          return {
            isLimited: false,
            remaining: Math.max(0, resolved.max - identifierResult.count),
            limit: resolved.max,
            reset,
          };
        }

        return {
          isLimited: false,
          remaining: Math.max(0, ipLimit - ipResult.count),
          limit: ipLimit,
          reset,
        };
      } catch (error) {
        // Fail-open: if the rate limit DB query fails, allow the request through.
        logger.error({
          msg: 'Rate limit check failed, failing open',
          action: config.action,
          error,
        });

        const limit = params.identifier ? resolved.max : ipLimit;

        return {
          isLimited: false,
          remaining: limit,
          limit,
          reset,
        };
      }
    },
  };
};
