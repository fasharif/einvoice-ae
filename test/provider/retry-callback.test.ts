import { describe, expect, it } from 'vitest';
import {
  CallbackVerificationError,
  DEFAULT_RETRY_POLICY,
  HttpAspClient,
  backoffDelay,
  isRetryableStatus,
  parseRetryAfter,
  signCallback,
  verifyCallback,
} from '../../src/provider/index.js';
import { anySignal, sleep } from '../../src/provider/retry.js';

describe('backoff', () => {
  const policy = { maxAttempts: 6, baseDelayMs: 100, maxDelayMs: 1_000 };

  it('doubles the ceiling each attempt and caps it', () => {
    expect([1, 2, 3, 4, 5].map((a) => backoffDelay(a, policy, () => 0.999999))).toEqual([99, 199, 399, 799, 999]);
  });

  it('draws from the full range [0, ceiling) (full jitter)', () => {
    expect(backoffDelay(3, policy, () => 0)).toBe(0);
    for (let i = 0; i < 200; i += 1) {
      const delay = backoffDelay(3, policy);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(400);
    }
  });

  it('refuses a non-positive attempt number', () => {
    expect(() => backoffDelay(0, DEFAULT_RETRY_POLICY)).toThrow(RangeError);
  });

  it('retries timeouts, rate limits and temporary server errors only', () => {
    expect([408, 425, 429, 500, 502, 503, 504].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 409, 413, 415, 422, 501].some(isRetryableStatus)).toBe(false);
  });

  it('parses Retry-After in seconds and as an HTTP date', () => {
    const now = Date.parse('2026-09-26T10:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3_000);
    expect(parseRetryAfter('Sat, 26 Sep 2026 10:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('Sat, 26 Sep 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('combines abort signals and detaches its listeners', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = anySignal([a.signal, b.signal]);
    expect(combined.signal.aborted).toBe(false);
    b.abort(new Error('second'));
    expect(combined.signal.aborted).toBe(true);
    expect((combined.signal.reason as Error).message).toBe('second');
    a.abort();
    expect((combined.signal.reason as Error).message).toBe('second');

    const already = new AbortController();
    already.abort(new Error('early'));
    expect(anySignal([already.signal, new AbortController().signal]).signal.aborted).toBe(true);

    const longLived = new AbortController();
    const once = anySignal([longLived.signal]);
    once.dispose();
    longLived.abort();
    expect(once.signal.aborted).toBe(false);
  });

  it('sleeps and can be aborted', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
    await expect(sleep(1, controller.signal)).rejects.toThrow('stop');
  });
});

describe('callback signatures', () => {
  const secret = 'shared-secret';
  const body = JSON.stringify({ submissionId: 's-1', invoiceId: 'INV-1', status: 'accepted', updatedAt: '2026-09-26T10:00:00Z', errors: [] });
  const now = Date.parse('2026-09-26T10:00:10Z');
  const timestamp = String(Math.floor(now / 1000) - 10);
  const signature = signCallback(body, secret, Number(timestamp));

  it('accepts a correctly signed, recent callback', () => {
    expect(verifyCallback({ body, signature, timestamp, secret, now })).toMatchObject({ invoiceId: 'INV-1', status: 'accepted' });
  });

  it.each([
    ['a changed body', { body: body.replace('accepted', 'rejected') }],
    ['another secret', { secret: 'other' }],
    ['a missing signature', { signature: undefined }],
    ['an old timestamp (replay)', { now: now + 3_600_000 }],
    ['a malformed timestamp', { timestamp: '10:00' }],
  ])('rejects %s', (_why, change) => {
    expect(() => verifyCallback({ body, signature, timestamp, secret, now, ...change })).toThrow(CallbackVerificationError);
  });

  it('rejects a signed body that is not a status report', () => {
    const other = '{"hello":"world"}';
    expect(() => verifyCallback({ body: other, signature: signCallback(other, secret, Number(timestamp)), timestamp, secret, now })).toThrow(/not a status report/);
    expect(() => verifyCallback({ body: 'x', signature: signCallback('x', secret, Number(timestamp)), timestamp, secret, now })).toThrow(/not JSON/);
  });
});

describe('HttpAspClient response handling', () => {
  const submission = { invoiceId: 'INV-1', documentType: 'Invoice' as const, xml: '<Invoice/>', sha256: '0'.repeat(64) };

  it('refuses a successful response that is not JSON, without retrying', async () => {
    let calls = 0;
    const client = new HttpAspClient({
      baseUrl: 'http://provider.test',
      apiKey: 'k',
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response('<html>maintenance</html>', { status: 200 }));
      },
    });
    await expect(client.submit(submission)).rejects.toThrow(/not JSON/);
    expect(calls).toBe(1);
  });

  it('refuses a receipt without the fields it needs', async () => {
    const client = new HttpAspClient({
      baseUrl: 'http://provider.test',
      apiKey: 'k',
      fetch: () => Promise.resolve(Response.json({ status: 'received' }, { status: 202 })),
    });
    await expect(client.submit(submission)).rejects.toThrow(/no submissionId/);
  });

  it('refuses an unknown status value', async () => {
    const client = new HttpAspClient({
      baseUrl: 'http://provider.test',
      apiKey: 'k',
      fetch: () => Promise.resolve(Response.json({ submissionId: 's', invoiceId: 'i', status: 'lost', receivedAt: 'now' })),
    });
    await expect(client.submit(submission)).rejects.toThrow(/unknown status/);
  });

  it('sends the idempotency key, digest, document type and bearer token', async () => {
    let seen: Headers | undefined;
    const client = new HttpAspClient({
      baseUrl: 'http://provider.test/',
      apiKey: 'secret-key',
      callbackUrl: 'https://seller.test/callbacks',
      fetch: (_url, init) => {
        seen = new Headers(init?.headers);
        return Promise.resolve(Response.json({ submissionId: 's', invoiceId: 'INV-1', status: 'received', receivedAt: 'now' }, { status: 202 }));
      },
    });
    await client.submit(submission);
    expect(seen?.get('idempotency-key')).toBe('INV-1');
    expect(seen?.get('x-document-sha256')).toBe('0'.repeat(64));
    expect(seen?.get('x-document-type')).toBe('Invoice');
    expect(seen?.get('authorization')).toBe('Bearer secret-key');
    expect(seen?.get('x-callback-url')).toBe('https://seller.test/callbacks');
  });
});
