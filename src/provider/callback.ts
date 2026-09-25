/**
 * Status callbacks. The provider POSTs a JSON status report to the seller's callback URL
 * and signs it with HMAC-SHA256 over "<timestamp>.<body>" using a shared secret. The
 * receiver checks the signature in constant time and rejects old timestamps (replays).
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
  /** Oldest accepted callback, in seconds. Defaults to 300. */
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
 * has been handed to `onReport`, 401 for a bad signature and 413 for oversized bodies.
 */
export function createCallbackHandler(options: {
  secret: string;
  onReport: (report: StatusReport) => void | Promise<void>;
  maxBodyBytes?: number;
}): (request: IncomingMessage, response: ServerResponse) => void {
  const limit = options.maxBodyBytes ?? 64 * 1024;
  return (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        response.writeHead(413).end();
        return;
      }
      const header = (name: string): string | undefined => {
        const value = request.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      let report: StatusReport;
      try {
        report = verifyCallback({
          body: Buffer.concat(chunks).toString('utf8'),
          signature: header(SIGNATURE_HEADER),
          timestamp: header(TIMESTAMP_HEADER),
          secret: options.secret,
        });
      } catch {
        response.writeHead(401).end();
        return;
      }
      Promise.resolve(options.onReport(report)).then(
        () => response.writeHead(204).end(),
        () => response.writeHead(500).end(),
      );
    });
  };
}
