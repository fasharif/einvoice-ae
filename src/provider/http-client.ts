/**
 * HTTP client for an Accredited Service Provider API shaped like the mock server in
 * einvoice-ae/testing:
 *
 *   POST /v1/submissions      body: UBL XML; headers: Idempotency-Key, X-Document-SHA256
 *   GET  /v1/submissions/{id} status report
 *
 * Every attempt has its own timeout. Network errors, timeouts, 408, 425, 429 and 5xx are
 * retried with exponential backoff and full jitter. A Retry-After header is honoured: the
 * client waits that long, or, when the provider asks for longer than retry.maxDelayMs,
 * gives up at once with an AspUnavailableError that carries retryAfterMs, so the caller
 * can schedule the retry. Retrying a POST is safe because the document number is sent as
 * the idempotency key, so the provider returns the original submission instead of
 * creating a second one.
 */
import { EInvoiceError } from '../errors.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy, anySignal, backoffDelay, isRetryableStatus, parseRetryAfter, sleep as defaultSleep } from './retry.js';
import type {
  AccreditedServiceProvider,
  ProviderError,
  RequestOptions,
  StatusReport,
  SubmissionReceipt,
  SubmissionRequest,
  SubmissionStatus,
} from './types.js';

export class AspError extends EInvoiceError {
  constructor(
    message: string,
    readonly status?: number,
    readonly errors: readonly ProviderError[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** The provider refused the request (4xx other than the retryable ones). Not retried. */
export class AspRequestError extends AspError {}

/** The idempotency key was already used for a different document (HTTP 409). */
export class AspConflictError extends AspRequestError {}

/**
 * Every attempt failed with a retryable error, or the provider asked (with Retry-After)
 * for a longer wait than the retry policy allows.
 */
export class AspUnavailableError extends AspError {
  constructor(
    message: string,
    readonly attempts: number,
    options?: ErrorOptions,
    /** The wait the provider asked for, when it asked for longer than retry.maxDelayMs. */
    readonly retryAfterMs?: number,
  ) {
    super(message, undefined, [], options);
  }
}

export interface RetryEvent {
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: string;
}

export interface HttpAspClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Timeout of each attempt. Defaults to 10 seconds. */
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  /** Sent with each submission so the provider can report the final status. */
  callbackUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  onRetry?: (event: RetryEvent) => void;
}

interface AttemptResult {
  body: Record<string, unknown>;
  headers: Headers;
  attempts: number;
}

const STATUSES: readonly SubmissionStatus[] = ['received', 'accepted', 'rejected'];

function asErrors(value: unknown): ProviderError[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e: unknown) => {
    if (typeof e !== 'object' || e === null) return [];
    const record = e as Record<string, unknown>;
    return typeof record['code'] === 'string' && typeof record['message'] === 'string'
      ? [{ code: record['code'], message: record['message'] }]
      : [];
  });
}

function readStatus(value: unknown): SubmissionStatus {
  if (typeof value === 'string' && (STATUSES as readonly string[]).includes(value)) return value as SubmissionStatus;
  throw new AspError(`Provider returned an unknown status: ${JSON.stringify(value)}`);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new AspError(`Provider response has no ${key}`);
  return value;
}

export class HttpAspClient implements AccreditedServiceProvider {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #policy: RetryPolicy;
  readonly #callbackUrl: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #onRetry: ((event: RetryEvent) => void) | undefined;

  constructor(options: HttpAspClientOptions) {
    if (!/^https?:\/\//.test(options.baseUrl)) throw new TypeError('baseUrl must be an http(s) URL');
    if (!options.apiKey) throw new TypeError('apiKey is required');
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#policy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    if (this.#policy.maxAttempts < 1) throw new RangeError('retry.maxAttempts must be at least 1');
    this.#callbackUrl = options.callbackUrl;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#onRetry = options.onRetry;
  }

  async submit(request: SubmissionRequest, options: RequestOptions = {}): Promise<SubmissionReceipt> {
    if (!request.invoiceId) throw new TypeError('invoiceId is required');
    const headers: Record<string, string> = {
      'content-type': 'application/xml; charset=utf-8',
      'idempotency-key': request.invoiceId,
      'x-document-sha256': request.sha256,
      'x-document-type': request.documentType,
    };
    if (this.#callbackUrl) headers['x-callback-url'] = this.#callbackUrl;
    const result = await this.#send('POST', '/v1/submissions', headers, request.xml, options.signal);
    return {
      submissionId: requireString(result.body, 'submissionId'),
      invoiceId: requireString(result.body, 'invoiceId'),
      status: readStatus(result.body['status']),
      receivedAt: requireString(result.body, 'receivedAt'),
      replayed: result.headers.get('idempotent-replayed') === 'true',
      attempts: result.attempts,
    };
  }

  async getStatus(submissionId: string, options: RequestOptions = {}): Promise<StatusReport> {
    const { body } = await this.#send('GET', `/v1/submissions/${encodeURIComponent(submissionId)}`, {}, undefined, options.signal);
    return {
      submissionId: requireString(body, 'submissionId'),
      invoiceId: requireString(body, 'invoiceId'),
      status: readStatus(body['status']),
      updatedAt: requireString(body, 'updatedAt'),
      errors: asErrors(body['errors']),
    };
  }

  /** Polls until the provider has accepted or rejected the submission. */
  async waitForFinalStatus(
    submissionId: string,
    options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<StatusReport> {
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    for (;;) {
      const report = await this.getStatus(submissionId, options.signal ? { signal: options.signal } : {});
      if (report.status !== 'received') return report;
      if (Date.now() >= deadline) throw new AspError(`Submission ${submissionId} is still being processed`);
      await this.#sleep(options.intervalMs ?? 1000, options.signal);
    }
  }

  /**
   * Sends one request with retries. The response body is read inside each attempt, so the
   * attempt timeout also covers a provider that stops sending half way through the body.
   */
  async #send(
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AttemptResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#policy.maxAttempts; attempt += 1) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const combined = signal ? anySignal([signal, timeout]) : { signal: timeout, dispose: (): void => undefined };
      let retryAfterMs: number | undefined;
      let reason: string;
      try {
        const init: RequestInit = {
          method,
          headers: { authorization: `Bearer ${this.#apiKey}`, accept: 'application/json', ...headers },
          signal: combined.signal,
        };
        if (body !== undefined) init.body = body;
        const response = await this.#fetch(`${this.#baseUrl}${path}`, init);
        const text = await response.text();
        if (response.ok) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            throw new AspRequestError(`Provider returned a response that is not JSON (HTTP ${response.status})`, response.status, [], { cause: error });
          }
          if (typeof parsed !== 'object' || parsed === null) {
            throw new AspRequestError(`Provider returned an unexpected response (HTTP ${response.status})`, response.status);
          }
          return { body: parsed as Record<string, unknown>, headers: response.headers, attempts: attempt };
        }
        let details: Record<string, unknown> | undefined;
        try {
          details = JSON.parse(text) as Record<string, unknown>;
        } catch {
          details = undefined;
        }
        const errors = asErrors(details?.['errors']);
        const message = errors.map((e) => `${e.code}: ${e.message}`).join('; ') || response.statusText;
        if (!isRetryableStatus(response.status)) {
          const ErrorType = response.status === 409 ? AspConflictError : AspRequestError;
          throw new ErrorType(`${method} ${path} was refused with HTTP ${response.status}: ${message}`, response.status, errors);
        }
        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        reason = `HTTP ${response.status}`;
        lastError = new AspError(`${method} ${path} failed with HTTP ${response.status}: ${message}`, response.status, errors);
      } catch (error) {
        if (error instanceof AspRequestError) throw error;
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
        reason = timeout.aborted ? `timeout after ${this.#timeoutMs} ms` : `network error: ${(error as Error).message}`;
        lastError = error;
      } finally {
        combined.dispose();
      }
      if (attempt === this.#policy.maxAttempts) break;
      if (retryAfterMs !== undefined && retryAfterMs > this.#policy.maxDelayMs) {
        throw new AspUnavailableError(
          `${method} ${path}: the provider asked to retry after ${Math.ceil(retryAfterMs / 1000)} s, longer than ` +
            `retry.maxDelayMs (${this.#policy.maxDelayMs} ms); retry later`,
          attempt,
          { cause: lastError },
          retryAfterMs,
        );
      }
      const delayMs = retryAfterMs ?? backoffDelay(attempt, this.#policy, this.#random);
      this.#onRetry?.({ attempt, delayMs, reason });
      await this.#sleep(delayMs, signal);
    }
    throw new AspUnavailableError(
      `${method} ${path} failed after ${this.#policy.maxAttempts} attempts: ${(lastError as Error | undefined)?.message ?? 'unknown error'}`,
      this.#policy.maxAttempts,
      { cause: lastError },
    );
  }
}
