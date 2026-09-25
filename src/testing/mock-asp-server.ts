/**
 * A mock Accredited Service Provider for tests and demos. It is not a real ASP: it runs a
 * few structural checks instead of full validation, keeps everything in memory, and can
 * inject failures (error statuses, dropped connections, slow responses) so that clients
 * can be tested against them.
 *
 *   POST /v1/submissions       submit UBL XML (Idempotency-Key and X-Document-SHA256 required)
 *   GET  /v1/submissions/{id}  status report
 *   GET  /health               liveness
 */
import { createHash, randomUUID } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PINT_AE } from '../constants.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signCallback } from '../provider/callback.js';
import type { ProviderError, StatusReport, SubmissionStatus } from '../provider/types.js';

/** A failure to inject into the next matching request. */
export type Fault =
  /** Answer with this status without processing the request. */
  | { kind: 'status'; status: number; retryAfterSeconds?: number }
  /** Close the connection without answering, before processing. */
  | { kind: 'reset' }
  /** Wait before answering (after processing), for example longer than the client timeout. */
  | { kind: 'delay'; ms: number }
  /** Process and store the submission, then answer with this status (a lost response). */
  | { kind: 'error-after-processing'; status: number };

export type Decision = { status: 'accepted' } | { status: 'rejected'; errors: ProviderError[] };

export interface MockAspOptions {
  apiKey: string;
  /** Shared secret for signing status callbacks. */
  callbackSecret: string;
  /** Time between receipt and the final status. Defaults to 20 ms. */
  processingDelayMs?: number;
  /** Decides the final status. Defaults to structural checks of the document. */
  decide?: (xml: string) => Decision;
  maxBodyBytes?: number;
}

export interface StoredSubmission {
  readonly submissionId: string;
  readonly invoiceId: string;
  readonly documentType: string;
  readonly sha256: string;
  readonly xml: string;
  readonly receivedAt: string;
  status: SubmissionStatus;
  updatedAt: string;
  errors: ProviderError[];
  readonly callbackUrl: string | undefined;
}

export interface CallbackDelivery {
  readonly submissionId: string;
  readonly url: string;
  readonly attempt: number;
  readonly status: number | 'network-error';
}

interface FaultEntry {
  fault: Fault;
  method?: string;
}

/** Default decision: structural checks only. Real providers run the full PINT AE validation. */
export function defaultDecision(xml: string): Decision {
  const errors: ProviderError[] = [];
  if (!/<(Invoice|CreditNote)\s[^>]*xmlns="urn:oasis:names:specification:ubl:schema:xsd:(Invoice|CreditNote)-2"/.test(xml)) {
    errors.push({ code: 'NOT_UBL', message: 'The document is not a UBL 2.1 Invoice or CreditNote' });
  }
  if (!xml.includes(`<cbc:CustomizationID>${PINT_AE.customizationId}</cbc:CustomizationID>`)) {
    errors.push({ code: 'NOT_PINT_AE', message: `CustomizationID must be ${PINT_AE.customizationId}` });
  }
  if (!/<cbc:UUID>[^<]+<\/cbc:UUID>/.test(xml)) errors.push({ code: 'NO_UUID', message: 'The unique identifier (BTAE-07) is missing' });
  return errors.length > 0 ? { status: 'rejected', errors } : { status: 'accepted' };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export class MockAspServer {
  readonly #options: Required<Omit<MockAspOptions, 'decide'>> & { decide: (xml: string) => Decision };
  readonly #server: Server;
  readonly #byId = new Map<string, StoredSubmission>();
  readonly #byKey = new Map<string, StoredSubmission>();
  readonly #faults: FaultEntry[] = [];
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly callbackDeliveries: CallbackDelivery[] = [];
  requestCount = 0;

  constructor(options: MockAspOptions) {
    this.#options = {
      processingDelayMs: 20,
      maxBodyBytes: 5 * 1024 * 1024,
      decide: defaultDecision,
      ...options,
    };
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
    });
  }

  /** Starts listening. Use port 0 for any free port; the URL is returned. */
  async listen(port: number, host = '127.0.0.1'): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    return this.url;
  }

  get url(): string {
    const address = this.#server.address() as AddressInfo | null;
    if (!address) throw new Error('The mock ASP is not listening');
    return `http://${address.address}:${address.port}`;
  }

  async close(): Promise<void> {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** Queues failures; each applies to one upcoming request (optionally only to one method). */
  injectFaults(...faults: Fault[]): void {
    for (const fault of faults) this.#faults.push({ fault });
  }

  injectFaultsFor(method: 'GET' | 'POST', ...faults: Fault[]): void {
    for (const fault of faults) this.#faults.push({ fault, method });
  }

  get submissions(): readonly StoredSubmission[] {
    return [...this.#byId.values()];
  }

  #takeFault(method: string): Fault | undefined {
    const index = this.#faults.findIndex((f) => f.method === undefined || f.method === method);
    if (index === -1) return undefined;
    const [entry] = this.#faults.splice(index, 1);
    return entry?.fault;
  }

  #json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    // Connection: close keeps each request independent, so a pooled socket from an earlier
    // test run can never turn into an unexpected network error (and an extra retry).
    response.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...headers }).end(JSON.stringify(body));
  }

  #error(response: ServerResponse, status: number, code: string, message: string): void {
    this.#json(response, status, { errors: [{ code, message }] });
  }

  #receipt(s: StoredSubmission): Record<string, string> {
    return { submissionId: s.submissionId, invoiceId: s.invoiceId, status: s.status, receivedAt: s.receivedAt };
  }

  #report(s: StoredSubmission): StatusReport {
    return { submissionId: s.submissionId, invoiceId: s.invoiceId, status: s.status, updatedAt: s.updatedAt, errors: s.errors };
  }

  async #readBody(request: IncomingMessage): Promise<string | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > this.#options.maxBodyBytes) return undefined;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.requestCount += 1;
    const url = new URL(request.url ?? '/', 'http://mock');
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      this.#json(response, 200, { status: 'ok' });
      return;
    }

    const fault = this.#takeFault(method);
    if (fault?.kind === 'reset') {
      request.socket.destroy();
      return;
    }
    if (fault?.kind === 'status') {
      const headers: Record<string, string> = fault.retryAfterSeconds !== undefined ? { 'retry-after': String(fault.retryAfterSeconds) } : {};
      this.#json(response, fault.status, { errors: [{ code: 'INJECTED_FAULT', message: `Injected HTTP ${fault.status}` }] }, headers);
      return;
    }

    if (header(request, 'authorization') !== `Bearer ${this.#options.apiKey}`) {
      this.#error(response, 401, 'UNAUTHORISED', 'Missing or wrong API key');
      return;
    }

    const answer = async (send: () => void): Promise<void> => {
      if (fault?.kind === 'delay') await new Promise<void>((resolve) => this.#schedule(() => resolve(), fault.ms));
      if (fault?.kind === 'error-after-processing') {
        this.#error(response, fault.status, 'INJECTED_FAULT', `Injected HTTP ${fault.status} after processing`);
        return;
      }
      if (!response.destroyed) send();
    };

    const match = /^\/v1\/submissions\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && match) {
      const stored = this.#byId.get(decodeURIComponent(match[1] ?? ''));
      await answer(() => (stored ? this.#json(response, 200, this.#report(stored)) : this.#error(response, 404, 'NOT_FOUND', 'Unknown submission')));
      return;
    }
    if (method !== 'POST' || url.pathname !== '/v1/submissions') {
      this.#error(response, 404, 'NOT_FOUND', `${method} ${url.pathname} does not exist`);
      return;
    }

    if (!(header(request, 'content-type') ?? '').startsWith('application/xml')) {
      this.#error(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the document as application/xml');
      return;
    }
    const key = header(request, 'idempotency-key');
    if (!key) {
      this.#error(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
      return;
    }
    const body = await this.#readBody(request);
    if (body === undefined) {
      this.#error(response, 413, 'TOO_LARGE', 'The document is too large');
      return;
    }
    const digest = sha256(body);
    if (header(request, 'x-document-sha256') !== digest) {
      this.#error(response, 400, 'DIGEST_MISMATCH', 'X-Document-SHA256 does not match the body');
      return;
    }

    const existing = this.#byKey.get(key);
    if (existing) {
      if (existing.sha256 !== digest) {
        this.#error(response, 409, 'IDEMPOTENCY_CONFLICT', `Document ${key} was already submitted with different content`);
        return;
      }
      await answer(() => this.#json(response, 200, this.#receipt(existing), { 'idempotent-replayed': 'true' }));
      return;
    }

    const now = new Date().toISOString();
    const stored: StoredSubmission = {
      submissionId: randomUUID(),
      invoiceId: key,
      documentType: header(request, 'x-document-type') ?? 'Invoice',
      sha256: digest,
      xml: body,
      receivedAt: now,
      status: 'received',
      updatedAt: now,
      errors: [],
      callbackUrl: header(request, 'x-callback-url'),
    };
    this.#byKey.set(key, stored);
    this.#byId.set(stored.submissionId, stored);
    this.#schedule(() => this.#finish(stored), this.#options.processingDelayMs);
    await answer(() => this.#json(response, 202, this.#receipt(stored)));
  }

  #schedule(callback: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      callback();
    }, ms);
    this.#timers.add(timer);
  }

  #finish(stored: StoredSubmission): void {
    const decision = this.#options.decide(stored.xml);
    stored.status = decision.status;
    stored.errors = decision.status === 'rejected' ? decision.errors : [];
    stored.updatedAt = new Date().toISOString();
    if (stored.callbackUrl) void this.#deliver(stored, stored.callbackUrl, 1);
  }

  async #deliver(stored: StoredSubmission, url: string, attempt: number): Promise<void> {
    const body = JSON.stringify(this.#report(stored));
    const timestamp = Math.floor(Date.now() / 1000);
    let status: number | 'network-error';
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signCallback(body, this.#options.callbackSecret, timestamp),
          [TIMESTAMP_HEADER]: String(timestamp),
        },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      status = response.status;
    } catch {
      status = 'network-error';
    }
    this.callbackDeliveries.push({ submissionId: stored.submissionId, url, attempt, status });
    const delivered = typeof status === 'number' && status >= 200 && status < 300;
    if (!delivered && attempt < 3) this.#schedule(() => void this.#deliver(stored, url, attempt + 1), 50 * attempt);
  }
}
