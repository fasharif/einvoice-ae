import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { standardInvoiceInput } from '../../corpus/scenarios.js';
import { buildInvoice, issueDocument } from '../../src/index.js';
import {
  AspConflictError,
  AspRequestError,
  AspUnavailableError,
  HttpAspClient,
  type HttpAspClientOptions,
  type RetryEvent,
  type StatusReport,
  createCallbackHandler,
  toSubmission,
} from '../../src/provider/index.js';
import { MockAspServer } from '../../src/testing/index.js';
import { type RunningServer, listenInRange, startHttpServer } from '../support/ports.js';

const API_KEY = 'test-key';
const SECRET = 'test-callback-secret';
const issued = issueDocument(buildInvoice(standardInvoiceInput()));
const submission = toSubmission(issued);

let server: MockAspServer;
let url: string;
let delays: number[];
let retries: RetryEvent[];

function client(overrides: Partial<HttpAspClientOptions> = {}): HttpAspClient {
  return new HttpAspClient({
    baseUrl: url,
    apiKey: API_KEY,
    timeoutMs: 2_000,
    retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 5_000 },
    random: () => 0.5,
    // Record delays instead of waiting, to keep the suite fast.
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    onRetry: (event) => retries.push(event),
    ...overrides,
  });
}

beforeEach(async () => {
  delays = [];
  retries = [];
  server = new MockAspServer({ apiKey: API_KEY, callbackSecret: SECRET, processingDelayMs: 10 });
  await listenInRange((port) => server.listen(port));
  url = server.url;
});

afterEach(async () => {
  await server.close();
});

describe('submitting to the mock ASP', () => {
  it('submits once and reaches the accepted status', async () => {
    const asp = client();
    const receipt = await asp.submit(submission);
    expect(receipt).toMatchObject({ invoiceId: issued.id, status: 'received', replayed: false, attempts: 1 });
    const final = await asp.waitForFinalStatus(receipt.submissionId, { intervalMs: 10 });
    expect(final).toMatchObject({ submissionId: receipt.submissionId, status: 'accepted', errors: [] });
    expect(server.submissions).toHaveLength(1);
  });

  it('retries temporary failures with exponential backoff and full jitter', async () => {
    server.injectFaults({ kind: 'status', status: 503 }, { kind: 'status', status: 502 });
    const receipt = await client().submit(submission);
    expect(receipt.attempts).toBe(3);
    // random() = 0.5: half of 100 ms, then half of 200 ms.
    expect(delays).toEqual([50, 100]);
    expect(retries.map((r) => r.reason)).toEqual(['HTTP 503', 'HTTP 502']);
    expect(server.submissions).toHaveLength(1);
  });

  it('honours Retry-After on HTTP 429, capped by the maximum delay', async () => {
    server.injectFaults({ kind: 'status', status: 429, retryAfterSeconds: 2 }, { kind: 'status', status: 429, retryAfterSeconds: 60 });
    await client().submit(submission);
    expect(delays).toEqual([2_000, 5_000]);
  });

  it('retries after the connection is dropped', async () => {
    server.injectFaults({ kind: 'reset' });
    const receipt = await client().submit(submission);
    expect(receipt.attempts).toBe(2);
    expect(retries[0]?.reason).toMatch(/^network error/);
  });

  it('retries after a timeout and receives the original submission, not a duplicate', async () => {
    server.injectFaults({ kind: 'delay', ms: 1_000 });
    const receipt = await client({ timeoutMs: 150 }).submit(submission);
    expect(retries[0]?.reason).toBe('timeout after 150 ms');
    expect(receipt.replayed).toBe(true);
    expect(server.submissions).toHaveLength(1);
    expect(receipt.submissionId).toBe(server.submissions[0]?.submissionId);
  });

  it('recovers from a lost response without creating a second submission', async () => {
    server.injectFaults({ kind: 'error-after-processing', status: 500 });
    const receipt = await client().submit(submission);
    expect(receipt).toMatchObject({ replayed: true, attempts: 2 });
    expect(server.submissions).toHaveLength(1);
  });

  it('is idempotent across calls: the same document twice gives one submission', async () => {
    const asp = client();
    const first = await asp.submit(submission);
    const second = await asp.submit(submission);
    expect(second.submissionId).toBe(first.submissionId);
    expect(second.replayed).toBe(true);
    expect(server.submissions).toHaveLength(1);
  });

  it('refuses a different document under an existing number (HTTP 409)', async () => {
    await client().submit(submission);
    const other = issueDocument(buildInvoice({ ...standardInvoiceInput(), buyerReference: 'CHANGED' }));
    await expect(client().submit(toSubmission(other))).rejects.toBeInstanceOf(AspConflictError);
  });

  it('does not retry requests the provider refuses', async () => {
    const error = await client()
      .submit({ ...submission, sha256: '0'.repeat(64) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AspRequestError);
    expect((error as AspRequestError).status).toBe(400);
    expect((error as AspRequestError).errors[0]?.code).toBe('DIGEST_MISMATCH');
    expect(server.requestCount).toBe(1);
  });

  it('reports a wrong API key as a refused request', async () => {
    await expect(client({ apiKey: 'wrong' }).submit(submission)).rejects.toMatchObject({ status: 401 });
  });

  it('gives up after the maximum number of attempts', async () => {
    server.injectFaults(...Array.from({ length: 5 }, () => ({ kind: 'status' as const, status: 503 })));
    const error = await client({ retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5_000 } })
      .submit(submission)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AspUnavailableError);
    expect((error as AspUnavailableError).attempts).toBe(3);
    expect(server.requestCount).toBe(3);
    expect(server.submissions).toHaveLength(0);
  });

  it('stops retrying when the caller aborts', async () => {
    server.injectFaults({ kind: 'status', status: 503 }, { kind: 'status', status: 503 });
    const controller = new AbortController();
    const asp = client({
      sleep: () => {
        controller.abort(new Error('caller gave up'));
        return Promise.reject(new Error('caller gave up'));
      },
    });
    await expect(asp.submit(submission, { signal: controller.signal })).rejects.toThrow('caller gave up');
    expect(server.requestCount).toBe(1);
  });

  it('reports a rejection with the provider errors', async () => {
    const notPintAe = { ...submission, invoiceId: 'X-1', xml: submission.xml.replace('billing-1@ae-1', 'billing-1@sg-1') };
    const { createHash } = await import('node:crypto');
    const asp = client();
    const receipt = await asp.submit({ ...notPintAe, sha256: createHash('sha256').update(notPintAe.xml).digest('hex') });
    const final = await asp.waitForFinalStatus(receipt.submissionId, { intervalMs: 10 });
    expect(final.status).toBe('rejected');
    expect(final.errors.map((e) => e.code)).toContain('NOT_PINT_AE');
  });

  it('retries status reads and reports unknown submissions', async () => {
    server.injectFaultsFor('GET', { kind: 'status', status: 503 });
    const asp = client();
    const receipt = await asp.submit(submission);
    await expect(asp.getStatus(receipt.submissionId)).resolves.toMatchObject({ submissionId: receipt.submissionId });
    expect(delays).toHaveLength(1);
    await expect(asp.getStatus('does-not-exist')).rejects.toMatchObject({ status: 404 });
  });

  it('validates its options', () => {
    expect(() => new HttpAspClient({ baseUrl: 'ftp://x', apiKey: 'k' })).toThrow(/http/);
    expect(() => new HttpAspClient({ baseUrl: 'http://x', apiKey: '' })).toThrow(/apiKey/);
    expect(() => new HttpAspClient({ baseUrl: 'http://x', apiKey: 'k', retry: { maxAttempts: 0 } })).toThrow(/maxAttempts/);
  });
});

describe('status callbacks', () => {
  let receiver: RunningServer;
  let receiverUrl: string;
  let reports: StatusReport[];

  beforeEach(async () => {
    reports = [];
    receiver = await startHttpServer(createCallbackHandler({ secret: SECRET, onReport: (report) => void reports.push(report) }));
    receiverUrl = `${receiver.url}/einvoice/callbacks`;
  });

  afterEach(async () => {
    await receiver.close();
  });

  const waitFor = async (condition: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(condition()).toBe(true);
  };

  it('delivers the final status to the callback URL with a valid signature', async () => {
    const receipt = await client({ callbackUrl: receiverUrl }).submit(submission);
    await waitFor(() => reports.length === 1);
    expect(reports[0]).toMatchObject({ submissionId: receipt.submissionId, status: 'accepted' });
    expect(server.callbackDeliveries).toEqual([{ submissionId: receipt.submissionId, url: receiverUrl, attempt: 1, status: 204 }]);
  });

  it('rejects callbacks signed with another secret; the provider retries', async () => {
    await server.close();
    server = new MockAspServer({ apiKey: API_KEY, callbackSecret: 'other-secret', processingDelayMs: 10 });
    await listenInRange((port) => server.listen(port));
    url = server.url;
    await client({ callbackUrl: receiverUrl }).submit(submission);
    await waitFor(() => server.callbackDeliveries.length === 3);
    expect(server.callbackDeliveries.map((d) => d.status)).toEqual([401, 401, 401]);
    expect(reports).toEqual([]);
  });
});

describe('mock ASP protocol checks', () => {
  const post = (body: string, headers: Record<string, string>) =>
    fetch(`${url}/v1/submissions`, { method: 'POST', body, headers: { authorization: `Bearer ${API_KEY}`, ...headers } });

  it('answers the health check without authentication', async () => {
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
  });

  it('refuses unknown routes, other media types, missing keys and oversized bodies', async () => {
    expect((await fetch(`${url}/v2/other`, { headers: { authorization: `Bearer ${API_KEY}` } })).status).toBe(404);
    expect((await post('{}', { 'content-type': 'application/json', 'idempotency-key': 'A' })).status).toBe(415);
    expect((await post('<x/>', { 'content-type': 'application/xml' })).status).toBe(400);

    await server.close();
    server = new MockAspServer({ apiKey: API_KEY, callbackSecret: SECRET, maxBodyBytes: 10 });
    await listenInRange((port) => server.listen(port));
    url = server.url;
    expect((await post('<Invoice>too large</Invoice>', { 'content-type': 'application/xml', 'idempotency-key': 'A' })).status).toBe(413);
  });

  it('lets tests decide the outcome', async () => {
    await server.close();
    server = new MockAspServer({
      apiKey: API_KEY,
      callbackSecret: SECRET,
      processingDelayMs: 5,
      decide: () => ({ status: 'rejected', errors: [{ code: 'ASP-001', message: 'Rejected by test' }] }),
    });
    await listenInRange((port) => server.listen(port));
    url = server.url;
    const asp = client();
    const receipt = await asp.submit(submission);
    const final = await asp.waitForFinalStatus(receipt.submissionId, { intervalMs: 5 });
    expect(final.errors).toEqual([{ code: 'ASP-001', message: 'Rejected by test' }]);
  });

  it('gives up polling after the time limit', async () => {
    await server.close();
    server = new MockAspServer({ apiKey: API_KEY, callbackSecret: SECRET, processingDelayMs: 60_000 });
    await listenInRange((port) => server.listen(port));
    url = server.url;
    const asp = client({ sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
    const receipt = await asp.submit(submission);
    await expect(asp.waitForFinalStatus(receipt.submissionId, { intervalMs: 5, timeoutMs: 30 })).rejects.toThrow(/still being processed/);
  });
});

describe('callback handler', () => {
  let receiver: RunningServer | undefined;
  let receiverUrl: string;

  const start = async (onReport: (report: StatusReport) => void | Promise<void>, maxBodyBytes?: number): Promise<void> => {
    receiver = await startHttpServer(createCallbackHandler({ secret: SECRET, onReport, ...(maxBodyBytes ? { maxBodyBytes } : {}) }));
    receiverUrl = `${receiver.url}/`;
  };

  afterEach(async () => {
    await receiver?.close();
  });

  it('allows POST only and limits the body size', async () => {
    await start(() => undefined, 16);
    expect((await fetch(receiverUrl)).status).toBe(405);
    expect((await fetch(receiverUrl, { method: 'POST', body: 'x'.repeat(100) })).status).toBe(413);
    expect((await fetch(receiverUrl, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('answers 500 when the application fails to handle a valid report', async () => {
    await start(() => Promise.reject(new Error('database down')));
    const { signCallback } = await import('../../src/provider/index.js');
    const body = JSON.stringify({ submissionId: 's', invoiceId: 'i', status: 'accepted', updatedAt: 'now', errors: [] });
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(receiverUrl, {
      method: 'POST',
      body,
      headers: { 'x-asp-signature': signCallback(body, SECRET, timestamp), 'x-asp-timestamp': String(timestamp) },
    });
    expect(response.status).toBe(500);
  });
});
