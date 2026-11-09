import { createHash } from 'node:crypto';

/**
 * One access line per request, in the format every drschoice service prints
 * (drschoice/devops README, "Every new service needs"):
 *
 *   [req] <METHOD> <path> <status> <ms>ms ip=<client ip>
 *
 * Behind the ALB, stdout is the only record of requests: the ALB and CloudFront
 * access logs are off. The path never carries the query string, and the secret
 * segment of a signing, sharing or verification link is printed as a short hash.
 */

// Paths whose next segment is a secret token (a signing link, a share link, a
// password-reset or email-verification token, an invitation).
const SECRET_PREFIXES = [
  '/sign/',
  '/d/',
  '/embed/sign/',
  '/embed/direct/',
  '/share/',
  '/reset-password/',
  '/verify-email/',
  '/team/verify/email/',
  '/organisation/invite/',
  '/organisation/decline/',
  '/organisation/sso/confirmation/',
];

const hashed = (secret: string) =>
  `[sha256:${createHash('sha256').update(secret).digest('hex').slice(0, 12)}]`;

export const redactPath = (path: string): string => {
  for (const prefix of SECRET_PREFIXES) {
    if (!path.startsWith(prefix)) {
      continue;
    }

    const rest = path.slice(prefix.length);
    const end = rest.indexOf('/');
    const secret = end === -1 ? rest : rest.slice(0, end);

    if (!secret) {
      return path;
    }

    return `${prefix}${hashed(secret)}${end === -1 ? '' : rest.slice(end)}`;
  }

  return path;
};

/**
 * The client IP `hops` entries from the right of X-Forwarded-For: each proxy
 * appends the address it received the request from, so the left end is
 * whatever the caller wrote. 1 behind the ALB alone, 2 behind CloudFront and
 * the ALB (TRUSTED_PROXY_HOPS, set by the ECS stack).
 */
export const clientIp = (forwardedFor: string | undefined | null, hops: number): string => {
  const parts = (forwardedFor ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return '-';
  }

  return parts[Math.max(parts.length - Math.max(hops, 1), 0)];
};

export const trustedProxyHops = (value: string | undefined): number => {
  const hops = Number.parseInt(value ?? '', 10);

  return Number.isFinite(hops) && hops > 0 ? hops : 1;
};

export const accessLine = (
  method: string,
  path: string,
  status: number,
  ms: number,
  ip: string,
): string => `[req] ${method} ${redactPath(path)} ${status} ${Math.round(ms)}ms ip=${ip}`;

// The ALB's own health checks would be most of the lines.
export const isHealthCheck = (userAgent: string | undefined | null): boolean =>
  (userAgent ?? '').startsWith('ELB-HealthChecker');
