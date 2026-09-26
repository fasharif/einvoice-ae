/**
 * Status callbacks. The provider POSTs a JSON status report to the seller's callback URL
 * and signs it with HMAC-SHA256 over "<timestamp>.<body>" using a shared secret. The
 * receiver checks the signature in constant time and rejects timestamps outside a
 * tolerance window, so a captured callback cannot be replayed later. Within the window,
 * createCallbackHandler drops an exact repeat of a callback it has already handled.
 * A provider may still deliver the same report twice with new signatures (for example
 * after a timeout), so `onReport` must be idempotent.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EInvoiceError } from '../errors.js';
import type { StatusReport } from './types.js';

export const SIGNATURE_HEADER = 'x-asp-signature';
export const TIMESTAMP_HEADER = 'x-asp-timestamp';
const STATUSES = new Set(['received', 'accepted', 'rejected']);

export class CallbackVerificationError extends EInvoiceError {}

export function signCallback(body: string, secret: string, timestampSeconds: number): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')}`;
}

export interface VerifyCallbackInput {
  body: string;
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string;
  /** Largest accepted difference between the timestamp and now, in seconds. Defaults to 300. */
  toleranceSeconds?: number;
  now?: number;
}

function isStatusReport(value: unknown): value is StatusReport {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['submissionId'] === 'string' &&
    typeof v['invoiceId'] === 'string' &&
    typeof v['status'] === 'string' &&
    STATUSES.has(v['status']) &&
    typeof v['updatedAt'] === 'string' &&
    Array.isArray(v['errors'])
  );
}

/** Verifies a callback and returns the status report it carries. Throws when anything is wrong. */
export function verifyCallback(input: VerifyCallbackInput): StatusReport {
  const { body, signature, timestamp, secret } = input;
  if (!signature || !timestamp) throw new CallbackVerificationError('Callback is missing the signature or timestamp header');
  if (!/^\d+$/.test(timestamp)) throw new CallbackVerificationError('Callback timestamp is not a number of seconds');
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > (input.toleranceSeconds ?? 300)) {
    throw new CallbackVerificationError('Callback timestamp is outside the accepted window');
  }
  const expected = Buffer.from(signCallback(body, secret, Number(timestamp)));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new CallbackVerificationError('Callback signature does not match');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new CallbackVerificationError('Callback body is not JSON');
  }
  if (!isStatusReport(parsed)) throw new CallbackVerificationError('Callback body is not a status report');
  return parsed;
}

/**
 * A node:http request handler for status callbacks. It answers 204 after a valid callback
 * has been handed to `onReport` (and, without calling `onReport` again, to an exact repeat
 * of a callback already handled within the tolerance window), 401 for a bad signature,
 * 405 for other methods and 413 for oversized bodies. After a 413 it closes the
 * connection instead of reading the rest of the body.
 *
 * Seen signatures are kept in memory for the tolerance window, per handler. Several
 * processes behind a load balancer each keep their own; `onReport` must be idempotent.
 */
export function createCallbackHandler(options: {
  secret: string;
  onReport: (report: StatusReport) => void | Promise<void>;
  maxBodyBytes?: number;
  /** Largest accepted clock difference, in seconds. Defaults to 300. */
  toleranceSeconds?: number;
  now?: () => number;
}): (request: IncomingMessage, response: ServerResponse) => void {
  const limit = options.maxBodyBytes ?? 64 * 1024;
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  const now = options.now ?? Date.now;
  /** Signature -> time (ms) after which a repeat would fail the timestamp check anyway. */
  const seen = new Map<string, number>();
  const forgetExpired = (at: number): void => {
    for (const [signature, expires] of seen) if (expires < at) seen.delete(signature);
  };

  return (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      // Answer at once and close the connection rather than reading the rest of the body.
      request.off('data', onData);
      request.off('end', onEnd);
      response.writeHead(413, { connection: 'close' }).end(() => request.destroy());
    };
    const onEnd = (): void => {
      const header = (name: string): string | undefined => {
        const value = request.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      const signature = header(SIGNATURE_HEADER);
      const at = now();
      let report: StatusReport;
      try {
        report = verifyCallback({
          body: Buffer.concat(chunks).toString('utf8'),
          signature,
          timestamp: header(TIMESTAMP_HEADER),
          secret: options.secret,
          toleranceSeconds,
          now: at,
        });
      } catch {
        response.writeHead(401).end();
        return;
      }
      // verifyCallback succeeded, so both headers are present.
      const key = signature as string;
      forgetExpired(at);
      if (seen.has(key)) {
        response.writeHead(204).end();
        return;
      }
      seen.set(key, (Number(header(TIMESTAMP_HEADER)) + toleranceSeconds + 1) * 1000);
      Promise.resolve()
        .then(() => options.onReport(report))
        .then(
          () => response.writeHead(204).end(),
          () => {
            // Let the provider deliver the same callback again.
            seen.delete(key);
            response.writeHead(500).end();
          },
        );
    };
    request.on('data', onData);
    request.on('end', onEnd);
  };
}
