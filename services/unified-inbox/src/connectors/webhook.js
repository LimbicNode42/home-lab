// Inbound webhook ingestion connector.
//
// Receives signed, allowlisted webhook payloads and normalizes them to the
// locked envelope. This is an *ingestion* path (read-only with respect to any
// upstream system): it never sends responses upstream beyond an HTTP status,
// and it never mutates any external service.
//
// Signature verification uses an HMAC shared secret materialized by the
// operator from Vaultwarden (folder `homelab`, item `unified-inbox/webhook/<source>`,
// field `webhook_signing_secret`). The secret is never logged, emitted, or
// persisted; only the reference/field names appear in repo and docs.

import { ReadOnlyMessageStream } from './stream.js';
import { assertConfigShape } from './config.js';
import { resolveLimits } from './limits.js';
import { fallbackConversationId, makeSender, plainTextProjection, toUtcIsoTimestamp } from './normalize-helpers.js';

import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_CONFIG = {
  source_label: { type: 'nonSecret' },          // human-facing source label (non-secret)
  webhook_signing_secret: { type: 'secret' },   // Vaultwarden materialized, never emitted
  require_signature: { type: 'optionalNonSecret' }
};

function safeCompare(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function signatureFor(secret, rawBody, header = 'sha256') {
  const algo = String(header).includes('sha1') ? 'sha1' : 'sha256';
  return createHmac(algo, secret).update(Buffer.from(rawBody, 'utf8')).digest('hex');
}

export function verifyWebhookSignature({ secret, rawBody, signatureHeader, headerName = 'x-webhook-signature' }) {
  if (!secret) return false;
  const expected = String(signatureHeader ?? '');
  // Accept both "<sig>" and "sha256=<sig>" forms.
  const received = expected.startsWith('sha256=') || expected.startsWith('sha1=') ? expected.split('=', 2)[1] : expected;
  if (!received) return false;
  const alg = expected.startsWith('sha1=') ? 'sha1' : 'sha256';
  const computed = signatureFor(secret, rawBody, alg);
  return safeCompare(computed, received);
}

export class WebhookMessageStream extends ReadOnlyMessageStream {
  constructor({ accountRef = 'default', source, config, now = () => new Date().toISOString() }) {
    super({ source: source || 'webhook', accountRef });
    assertConfigShape(WEBHOOK_CONFIG, config);
    this.config = config;
    this.sourceLabel = config.source_label;
    this.now = now;
    this.requireSignature = config.require_signature !== false;
    this._lastSuccessAt = null;
    this._lastErrorCode = null;
  }

  async health() {
    return {
      state: 'ok',
      checked_at: this.now(),
      last_success_at: this._lastSuccessAt,
      last_error_code: this._lastErrorCode,
      detail: `webhook listener ready (signature ${this.requireSignature ? 'required' : 'optional'})`
    };
  }

  // Webhooks are push-based: sync yields nothing. The ingestion path is
  // `receive()`, called by the API handler. Kept in the contract for uniformity.
  async *sync(_cursor, _limits) {
    // no-op: webhooks arrive via receive(), not polling.
  }

  // Accept a raw webhook payload, verify signature, and return a normalized
  // envelope (or throw with a structured, secret-free error).
  async receive({ rawBody, headers = {} }) {
    if (this.requireSignature) {
      const ok = verifyWebhookSignature({
        secret: this.config.webhook_signing_secret,
        rawBody,
        signatureHeader: headers['x-webhook-signature'] ?? headers['X-Webhook-Signature']
      });
      if (!ok) {
        this._lastErrorCode = 'invalid_signature';
        const err = new Error('webhook signature verification failed');
        err.status = 401;
        throw err;
      }
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      this._lastErrorCode = 'invalid_payload';
      const err = new Error('webhook payload is not valid JSON');
      err.status = 400;
      throw err;
    }

    const ingestBatchId = `webhook:${this.accountRef}:${Date.now()}`;
    const ref = this.toRawRef(payload, ingestBatchId);
    this._lastSuccessAt = this.now();
    this._lastErrorCode = null;
    return this.normalize(ref);
  }

  toRawRef(payload, ingestBatchId) {
    return {
      event_id: payload.id ?? payload.event_id ?? payload.message_id ?? null,
      event_type: payload.type ?? payload.event ?? payload.event_type ?? null,
      timestamp: payload.timestamp ?? payload.created_at ?? payload.time ?? null,
      payload,
      ingest_batch_id: ingestBatchId
    };
  }

  async normalize(rawRef) {
    const payload = rawRef.payload ?? {};
    const eventId = rawRef.event_id ?? `${this.sourceLabel ?? 'webhook'}-${Date.now()}`;
    const receivedAt = this.now();
    const sentAt = toUtcIsoTimestamp(rawRef.timestamp ?? payload.timestamp) ?? receivedAt;

    return {
      source: this.source,
      account_ref: this.accountRef,
      conversation_id: fallbackConversationId(this.source, this.accountRef, this.sourceLabel ?? 'inbound'),
      conversation_title: this.sourceLabel ?? payload.source ?? null,
      thread_id: payload.thread_id ?? payload.parent_id ?? null,
      message_id: String(eventId),
      sender: makeSender({ id: payload.sender_id ?? null, display_name: payload.sender ?? null, handle: payload.sender_handle ?? null }),
      sent_at: sentAt,
      received_at: receivedAt,
      body_text: plainTextProjection(payload.text ?? payload.body ?? payload.content),
      attachment_refs: (payload.attachments ?? []).map((a) => ({
        id: a.id ?? null,
        name: a.name ?? null,
        content_type: a.content_type ?? a.contentType ?? null,
        size: a.size ?? null,
        upstream_url_ref: a.url ?? a.upstream_url_ref ?? null
      })),
      read_state: 'unread',
      permalink: payload.permalink ?? payload.url ?? null,
      raw_ref: { event_id: String(eventId), event_type: rawRef.event_type ?? null, source_label: this.sourceLabel ?? null },
      ingest_batch_id: rawRef.ingest_batch_id ?? null
    };
  }
}