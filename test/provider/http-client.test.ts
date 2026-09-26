import { connect } from 'node:net';
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
import { sleep } from '../../src/provider/retry.js';
import { type RunningServer, listenInRange, startHttpServer } from '../support/ports.js';

const API_KEY = 'test-key';
const SECRET = 'test-callback-secret';
const issued = issueDocument(buildInvoice(standardInvoiceInput()));
const submission = toSubmission(issued);

let server: MockAspServer;
let url: string;
let retries: RetryEvent[];
const delays = (): number[] => retries.map((r) => r.delayMs);

function client(overrides: Partial<HttpAspClientOptions> = {}): HttpAspClient {
  // Each client reports to the array of the test that created it, so a slow test can never
  // leak retries into the next one.
  const events = retries;
  return new HttpAspClient({
    baseUrl: url,
    apiKey: API_KEY,
    timeoutMs: 2_000,
    retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 5_000 },
    random: () => 0.5,
    // Real timers, capped at 5 ms: retries stay fast and polling never becomes a busy loop.
    sleep: (ms, signal) => sleep(Math.min(ms, 5), signal),
    onRetry: (event) => events.push(event),
    ...overrides,
  });
}

beforeEach(async () => {
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
    expect(delays()).toEqual([50, 100]);
    expect(retries.map((r) => r.reason)).toEqual(['HTTP 503', 'HTTP 502']);
    expect(server.submissions).toHaveLength(1);
  });

  it('waits as long as Retry-After asks on HTTP 429', async () => {
    server.injectFaults({ kind: 'status', status: 429, retryAfterSeconds: 2 }, { kind: 'status', status: 503, retryAfterSeconds: 5 });
    const receipt = await client().submit(submission);
    expect(delays()).toEqual([2_000, 5_000]);
    expect(receipt.attempts).toBe(3);
  });

  it('gives up, reporting the wait, when Retry-After is longer than the maximum delay', async () => {
    server.injectFaults({ kind: 'status', status: 429, retryAfterSeconds: 60 });
    const error = await client()
      .submit(submission)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AspUnavailableError);
    expect(error).toMatchObject({ attempts: 1, retryAfterMs: 60_000 });
    expect((error as Error).message).toMatch(/retry after 60 s, longer than retry.maxDelayMs \(5000 ms\)/);
    expect(retries).toEqual([]);
    expect(server.requestCount).toBe(1);
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
    expect(delays()).toHaveLength(1);
    await expect(asp.getStatus('does-not-exist')).rejects.toMatchObject({ status: 404 });
  });

  it('validates its options', () => {
    expect(() => new HttpAspClient({ baseUrl: 'ftp://x', apiKey: 'k' })).toThrow(/https URL/);
    expect(() => new HttpAspClient({ baseUrl: 'not a url', apiKey: 'k' })).toThrow(/not a valid URL/);
    expect(() => new HttpAspClient({ baseUrl: 'https://x', apiKey: '' })).toThrow(/apiKey/);
    expect(() => new HttpAspClient({ baseUrl: 'https://x', apiKey: 'key-١' })).toThrow(/cannot be sent in an HTTP header/);
    for (const retry of [{ maxAttempts: 0 }, { maxAttempts: Number.NaN }, { maxAttempts: 1.5 }, { baseDelayMs: -1 }, { maxDelayMs: Infinity }]) {
      expect(() => new HttpAspClient({ baseUrl: 'https://x', apiKey: 'k', retry }), JSON.stringify(retry)).toThrow(RangeError);
    }
    expect(() => new HttpAspClient({ baseUrl: 'https://x', apiKey: 'k', timeoutMs: 0 })).toThrow(/timeoutMs must be a whole number/);
  });

  it('requires https for a provider or callback that is not on this machine', () => {
    expect(() => new HttpAspClient({ baseUrl: 'http://asp.example.com', apiKey: 'k' })).toThrow(/baseUrl must use https/);
    expect(() => new HttpAspClient({ baseUrl: 'https://asp.example.com', apiKey: 'k', callbackUrl: 'http://seller.example.com/cb' })).toThrow(
      /callbackUrl must use https/,
    );
    for (const baseUrl of ['http://127.0.0.1:1', 'http://127.1.2.3:1', 'http://localhost:1', 'http://[::1]:1', 'https://asp.example.com']) {
      expect(() => new HttpAspClient({ baseUrl, apiKey: 'k' }), baseUrl).not.toThrow();
    }
    expect(() => new HttpAspClient({ baseUrl: 'http://asp.test', apiKey: 'k', allowInsecureHttp: true })).not.toThrow();
  });

  it('submits a document number that is not ASCII by percent-encoding the idempotency key', async () => {
    const number = 'DEMO-INV-١٢٣';
    const document = toSubmission(issueDocument(buildInvoice({ ...standardInvoiceInput(), id: number })));
    const asp = client();
    const receipt = await asp.submit(document);
    expect(receipt).toMatchObject({ invoiceId: number, attempts: 1, replayed: false });
    expect(server.submissions.map((s) => s.invoiceId)).toEqual([number]);
    await expect(asp.submit(document)).resolves.toMatchObject({ submissionId: receipt.submissionId, replayed: true });
  });

  it('refuses a request that cannot be sent at once, without retrying or reaching the provider', async () => {
    const error = await client()
      .submit({ ...submission, sha256: 'line\nbreak' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AspRequestError);
    expect(error).toMatchObject({ status: undefined });
    expect((error as Error).message).toMatch(/cannot be sent/);
    expect(retries).toEqual([]);
    expect(server.requestCount).toBe(0);
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
    // The receiver stores the report before it answers; the provider records the delivery
    // only after the answer arrives, so wait for both.
    await waitFor(() => reports.length === 1 && server.callbackDeliveries.length === 1);
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

  it('delivers callbacks only to allowed hosts, loopback by default', async () => {
    const withCallback = (callbackUrl: string) => post(submission.xml, {
      'content-type': 'application/xml',
      'idempotency-key': 'A',
      'x-document-sha256': submission.sha256,
      'x-callback-url': callbackUrl,
    });
    for (const target of ['https://metadata.example.com/latest', 'file:///etc/passwd', 'not a url']) {
      const response = await withCallback(target);
      expect(response.status, target).toBe(400);
      expect(((await response.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe('CALLBACK_URL_NOT_ALLOWED');
    }
    expect(server.submissions).toHaveLength(0);
    expect((await withCallback('http://127.0.0.1:9/callbacks')).status).toBe(202);

    await server.close();
    server = new MockAspServer({ apiKey: API_KEY, callbackSecret: SECRET, callbackHosts: ['seller.test'] });
    await listenInRange((port) => server.listen(port));
    url = server.url;
    expect((await withCallback('https://seller.test/callbacks')).status).toBe(202);
    expect((await withCallback('http://127.0.0.1:9/callbacks')).status).toBe(400);
  });

  it('checks the API key before an injected fault, and refuses a malformed idempotency key', async () => {
    server.injectFaults({ kind: 'status', status: 503 });
    expect((await fetch(`${url}/v1/submissions`, { method: 'POST', body: '<x/>' })).status).toBe(401);
    const receipt = await client().submit(submission);
    expect(receipt.attempts).toBe(2);
    const response = await post(submission.xml, { 'content-type': 'application/xml', 'idempotency-key': '%E0%A4%A' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe('IDEMPOTENCY_KEY_INVALID');
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

  it('closes the connection after a 413 instead of reading the rest of the body', async () => {
    await start(() => undefined, 16);
    const { hostname, port } = new URL(receiverUrl);
    const socket = connect(Number(port), hostname);
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    socket.on('error', () => undefined);
    // Announce 1 MB but send only 100 bytes: the handler must not wait for the rest.
    const head = ['POST / HTTP/1.1', `Host: ${hostname}`, 'Content-Type: application/json', 'Content-Length: 1000000', '', ''].join('\r\n');
    socket.write(`${head}${'x'.repeat(100)}`);
    await closed;
    expect(received).toMatch(/^HTTP\/1\.1 413 /);
  });

  it('hands each callback to the application once, even when it is replayed', async () => {
    const handled: StatusReport[] = [];
    await start((report) => void handled.push(report));
    const { signCallback } = await import('../../src/provider/index.js');
    const body = JSON.stringify({ submissionId: 's', invoiceId: 'i', status: 'accepted', updatedAt: 'now', errors: [] });
    const send = (timestamp: number) =>
      fetch(receiverUrl, {
        method: 'POST',
        body,
        headers: { 'x-asp-signature': signCallback(body, SECRET, timestamp), 'x-asp-timestamp': String(timestamp) },
      });
    const timestamp = Math.floor(Date.now() / 1000);
    expect((await send(timestamp)).status).toBe(204);
    expect((await send(timestamp)).status).toBe(204); // an exact replay
    expect(handled).toHaveLength(1);
    // A new delivery of the same report is signed afresh and reaches the application.
    expect((await send(timestamp - 1)).status).toBe(204);
    expect(handled).toHaveLength(2);
  });

  it('accepts a repeat of a callback that the application failed to handle', async () => {
    let calls = 0;
    await start(() => {
      calls += 1;
      if (calls === 1) throw new Error('database down');
    });
    const { signCallback } = await import('../../src/provider/index.js');
    const body = JSON.stringify({ submissionId: 's', invoiceId: 'i', status: 'rejected', updatedAt: 'now', errors: [] });
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = { 'x-asp-signature': signCallback(body, SECRET, timestamp), 'x-asp-timestamp': String(timestamp) };
    expect((await fetch(receiverUrl, { method: 'POST', body, headers })).status).toBe(500);
    expect((await fetch(receiverUrl, { method: 'POST', body, headers })).status).toBe(204);
    expect(calls).toBe(2);
  });

  it('makes a repeat that arrives during the first delivery wait for its outcome', async () => {
    let calls = 0;
    let release: (stored: boolean) => void = () => undefined;
    await start(() => {
      calls += 1;
      return new Promise<void>((resolve, reject) => {
        release = (stored) => (stored ? resolve() : reject(new Error('database down')));
      });
    });
    const { signCallback } = await import('../../src/provider/index.js');
    const body = JSON.stringify({ submissionId: 's', invoiceId: 'i', status: 'accepted', updatedAt: 'now', errors: [] });
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = { 'x-asp-signature': signCallback(body, SECRET, timestamp), 'x-asp-timestamp': String(timestamp) };
    const send = () => fetch(receiverUrl, { method: 'POST', body, headers });
    const until = async (condition: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((r) => setTimeout(r, 5));
    };

    const first = send();
    await until(() => calls === 1);
    const repeat = send();
    const early = await Promise.race([repeat.then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 100))]);
    expect(early).toBe('waiting');
    release(false);
    expect((await first).status).toBe(500);
    expect((await repeat).status).toBe(500);
    expect(calls).toBe(1);

    // The provider delivers the report again; this time the application stores it.
    const again = send();
    await until(() => calls === 2);
    const duplicate = send();
    release(true);
    expect((await again).status).toBe(204);
    expect((await duplicate).status).toBe(204);
    expect(calls).toBe(2);
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
