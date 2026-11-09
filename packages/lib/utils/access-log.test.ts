import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { accessLine, clientIp, isHealthCheck, redactPath, trustedProxyHops } from './access-log';

const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

describe('redactPath', () => {
  it('hashes the token of a signing link and keeps the rest of the path', () => {
    expect(redactPath('/sign/abc123')).toBe(`/sign/[sha256:${short('abc123')}]`);
    expect(redactPath('/sign/abc123/complete')).toBe(`/sign/[sha256:${short('abc123')}]/complete`);
  });

  it('hashes every secret-bearing prefix', () => {
    for (const prefix of [
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
    ]) {
      expect(redactPath(`${prefix}tok`)).toBe(`${prefix}[sha256:${short('tok')}]`);
    }
  });

  it('leaves other paths, and a prefix with no token, alone', () => {
    expect(redactPath('/api/health')).toBe('/api/health');
    expect(redactPath('/documents/12')).toBe('/documents/12');
    expect(redactPath('/sign/')).toBe('/sign/');
    expect(redactPath('/signin')).toBe('/signin');
  });
});

describe('clientIp', () => {
  it('takes the entry `hops` from the right', () => {
    expect(clientIp('203.0.113.9, 130.176.1.2', 2)).toBe('203.0.113.9');
    expect(clientIp('203.0.113.9, 130.176.1.2', 1)).toBe('130.176.1.2');
  });

  it('ignores what the caller wrote on the left', () => {
    expect(clientIp('6.6.6.6, 203.0.113.9, 130.176.1.2', 2)).toBe('203.0.113.9');
  });

  it('falls back to the leftmost entry when there are fewer entries than hops', () => {
    expect(clientIp('203.0.113.9', 2)).toBe('203.0.113.9');
  });

  it('prints - without the header', () => {
    expect(clientIp(undefined, 2)).toBe('-');
    expect(clientIp('', 2)).toBe('-');
  });
});

describe('trustedProxyHops', () => {
  it('defaults to 1 for a missing or invalid value', () => {
    expect(trustedProxyHops(undefined)).toBe(1);
    expect(trustedProxyHops('x')).toBe(1);
    expect(trustedProxyHops('0')).toBe(1);
    expect(trustedProxyHops('2')).toBe(2);
  });
});

describe('accessLine', () => {
  it('prints the README format with a redacted path and whole milliseconds', () => {
    expect(accessLine('GET', '/sign/abc', 200, 12.6, '203.0.113.9')).toBe(
      `[req] GET /sign/[sha256:${short('abc')}] 200 13ms ip=203.0.113.9`,
    );
  });
});

describe('isHealthCheck', () => {
  it('matches only the ALB health checker', () => {
    expect(isHealthCheck('ELB-HealthChecker/2.0')).toBe(true);
    expect(isHealthCheck('Mozilla/5.0')).toBe(false);
    expect(isHealthCheck(undefined)).toBe(false);
  });
});
